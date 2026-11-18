import { describe, expect, it } from 'vitest';

import {
  capRunResult,
  createRedisRunStore,
  DELETE_IF_OWNER_SCRIPT,
  hashRunInput,
  InMemoryRunStore,
  isValidIdempotencyKey,
  RENEW_IF_OWNER_SCRIPT,
  RUN_LEASE_MS,
  RunRegistry,
  type RunRecord,
  type StartRunRequest,
} from './run-registry.js';

const T0 = Date.parse('2026-11-18T04:20:00Z');

/** A workflow the test finishes by hand. */
const deferredRun = () => {
  let resolve!: (value: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  const promise = new Promise<Record<string, unknown>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const run: StartRunRequest['run'] = async (ctx) => {
    signal = ctx.signal;
    ctx.logger({
      event: 'provider_enrichment.page',
      workflow: 'provider-enrichment',
      status: 'page 1/3',
    });
    return promise;
  };
  return { run, resolve, reject, signal: () => signal };
};

const setup = () => {
  let now = T0;
  const clock = () => now;
  const store = new InMemoryRunStore({ clock });
  let ids = 0;
  const registry = (pod = 'pod-a') =>
    new RunRegistry({
      store,
      clock,
      pod,
      timers: false,
      newRunId: () => `run-${++ids}`,
    });
  return { store, registry, clock, advance: (ms: number) => (now += ms) };
};

const request = (overrides: Partial<StartRunRequest> = {}): StartRunRequest => ({
  workflow: 'provider-enrichment',
  scopeKey: 'provider-enrichment:team-coaches',
  input: { dataset: 'team-coaches', mode: 'nightly' },
  run: async () => ({ status: 'completed', callsUsed: 3 }),
  ...overrides,
});

const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('run registry lifecycle', () => {
  it('starts a run, records progress and stores the result when it completes', async () => {
    const { registry } = setup();
    const reg = registry();
    const work = deferredRun();
    const outcome = await reg.start(request({ run: work.run }));
    expect(outcome.kind).toBe('started');
    const runId = outcome.kind === 'started' ? outcome.run.runId : '';
    await settle();
    expect(await reg.status(runId)).toMatchObject({
      status: 'running',
      events: 1,
      lastEvent: 'provider_enrichment.page',
      lastEventStatus: 'page 1/3',
      pod: 'pod-a',
    });

    work.resolve({ status: 'completed', callsUsed: 502 });
    await settle();
    expect(await reg.status(runId)).toMatchObject({
      status: 'completed',
      result: { status: 'completed', callsUsed: 502 },
    });
    // The lock is released: a different input now starts.
    const next = await reg.start(request({ input: { dataset: 'team-coaches', mode: 'full' } }));
    expect(next.kind).toBe('started');
  });

  it('records a thrown workflow as failed with its message', async () => {
    const { registry } = setup();
    const reg = registry();
    const outcome = await reg.start(
      request({
        run: async () => {
          throw new Error('synthetic failure');
        },
      })
    );
    await settle();
    const runId = outcome.kind === 'started' ? outcome.run.runId : '';
    expect(await reg.status(runId)).toMatchObject({
      status: 'failed',
      reason: 'synthetic failure',
    });
  });
});

describe('idempotency and scope lock', () => {
  it('attaches a retry with the same key to the running run', async () => {
    const { registry } = setup();
    const reg = registry();
    const work = deferredRun();
    const first = await reg.start(request({ run: work.run, idempotencyKey: 'key-0000001' }));
    const retry = await reg.start(request({ idempotencyKey: 'key-0000001' }));
    expect(retry).toMatchObject({ kind: 'attached', observed: false });
    expect(retry.kind === 'attached' && retry.run.runId).toBe(
      first.kind === 'started' && first.run.runId
    );

    work.resolve({ status: 'completed' });
    await settle();
    // After it finishes, the same key still answers with that run and its result.
    const late = await reg.start(request({ idempotencyKey: 'key-0000001' }));
    expect(late).toMatchObject({ kind: 'attached', run: { status: 'completed' } });
  });

  it('starts a fresh run for a key whose run failed', async () => {
    const { registry } = setup();
    const reg = registry();
    await reg.start(
      request({
        idempotencyKey: 'key-0000002',
        run: async () => {
          throw new Error('boom');
        },
      })
    );
    await settle();
    const again = await reg.start(request({ idempotencyKey: 'key-0000002' }));
    expect(again.kind).toBe('started');
  });

  it('attaches an identical request without a key, and refuses a different input as busy', async () => {
    const { registry } = setup();
    const reg = registry();
    const work = deferredRun();
    const first = await reg.start(request({ run: work.run }));
    const same = await reg.start(request());
    expect(same.kind).toBe('attached');
    const other = await reg.start(request({ input: { dataset: 'team-coaches', mode: 'full' } }));
    expect(other).toMatchObject({
      kind: 'busy',
      holderRunId: first.kind === 'started' ? first.run.runId : '',
      retryable: false,
    });
    // A different scope is not affected.
    const otherScope = await reg.start(
      request({ scopeKey: 'provider-enrichment:injuries-league' })
    );
    expect(otherScope.kind).toBe('started');
    work.resolve({});
  });

  it('hashes equal inputs equally whatever the key order', () => {
    expect(hashRunInput('provider-enrichment', { a: 1, b: [1, 2] })).toBe(
      hashRunInput('provider-enrichment', { b: [1, 2], a: 1, c: undefined })
    );
    expect(hashRunInput('provider-enrichment', { a: 1 })).not.toBe(
      hashRunInput('season-backfill', { a: 1 })
    );
  });

  it('accepts hex digests as idempotency keys and rejects odd ones', () => {
    expect(isValidIdempotencyKey('a'.repeat(64))).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('has space in it')).toBe(false);
    expect(isValidIdempotencyKey('x'.repeat(201))).toBe(false);
  });
});

describe('another pod, leases and fencing', () => {
  it('reports a run whose pod stopped renewing as lost, and lets a retry start again', async () => {
    const { registry, advance } = setup();
    const podA = registry('pod-a');
    const podB = registry('pod-b');
    const work = deferredRun();
    const first = await podA.start(request({ run: work.run, idempotencyKey: 'key-0000003' }));
    const runId = first.kind === 'started' ? first.run.runId : '';
    await settle();
    expect((await podB.status(runId))?.status).toBe('running');

    advance(RUN_LEASE_MS + 1);
    expect((await podB.status(runId))?.status).toBe('lost');
    const retry = await podB.start(request({ idempotencyKey: 'key-0000003' }));
    expect(retry).toMatchObject({ kind: 'started', run: { pod: 'pod-b' } });

    // Pod A comes back: its renewal finds pod B owns the scope and stops it.
    await podA.renewAll();
    expect(work.signal()?.aborted).toBe(true);
    expect(work.signal()?.reason).toBe('lease-lost');
    work.resolve({ status: 'incomplete' });
    await settle();
    expect(await podB.status(runId)).toMatchObject({
      status: 'interrupted',
      reason: 'lease lost',
    });
  });

  it('keeps a renewing run alive past the lease', async () => {
    const { registry, advance } = setup();
    const podA = registry('pod-a');
    const podB = registry('pod-b');
    const work = deferredRun();
    const first = await podA.start(request({ run: work.run }));
    const runId = first.kind === 'started' ? first.run.runId : '';
    for (let i = 0; i < 20; i += 1) {
      advance(15_000);
      await podA.renewAll();
    }
    expect((await podB.status(runId))?.status).toBe('running');
    expect((await podB.start(request({ input: { other: true } }))).kind).toBe('busy');
    work.resolve({});
  });
});

describe('stopping runs', () => {
  it('cancels a local run through its signal', async () => {
    const { registry } = setup();
    const reg = registry();
    const work = deferredRun();
    const first = await reg.start(request({ run: work.run }));
    const runId = first.kind === 'started' ? first.run.runId : '';
    await settle();
    await reg.cancel(runId);
    expect(work.signal()?.reason).toBe('cancelled');
    work.resolve({ status: 'incomplete' });
    await settle();
    expect(await reg.status(runId)).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
  });

  it('cancels a run on another pod at its next renewal', async () => {
    const { registry } = setup();
    const podA = registry('pod-a');
    const podB = registry('pod-b');
    const work = deferredRun();
    const first = await podA.start(request({ run: work.run }));
    const runId = first.kind === 'started' ? first.run.runId : '';
    await settle();
    expect((await podB.cancel(runId))?.status).toBe('running');
    expect(work.signal()?.aborted).toBe(false);
    await podA.renewAll();
    expect(work.signal()?.reason).toBe('cancelled');
  });

  it('stops a run at its maximum runtime and keeps its result', async () => {
    const { registry } = setup();
    const reg = registry();
    const work = deferredRun();
    const first = await reg.start(request({ run: work.run }));
    const runId = first.kind === 'started' ? first.run.runId : '';
    await settle();
    expect(reg.expire(runId)).toBe(true);
    expect(work.signal()?.reason).toBe('max-runtime');
    work.resolve({ status: 'incomplete', reason: 'run stopped: max-runtime' });
    await settle();
    expect(await reg.status(runId)).toMatchObject({
      status: 'completed',
      reason: 'max runtime reached',
      stopRequested: 'max-runtime',
      result: { status: 'incomplete' },
    });
  });

  it('marks runs interrupted at shutdown; a retry waits for the lock, then starts', async () => {
    const { registry } = setup();
    const podA = registry('pod-a');
    const podB = registry('pod-b');
    const work = deferredRun();
    const first = await podA.start(request({ run: work.run, idempotencyKey: 'key-0000004' }));
    const runId = first.kind === 'started' ? first.run.runId : '';
    await settle();

    await podA.interruptAll();
    expect(work.signal()?.reason).toBe('interrupted');
    expect((await podB.status(runId))?.status).toBe('interrupted');
    const early = await podB.start(request({ idempotencyKey: 'key-0000004' }));
    expect(early).toMatchObject({ kind: 'busy', retryable: true });

    work.resolve({ status: 'incomplete' });
    expect(await podA.waitForLocalRuns(1_000)).toBe(true);
    const retry = await podB.start(request({ idempotencyKey: 'key-0000004' }));
    expect(retry).toMatchObject({ kind: 'started', run: { pod: 'pod-b' } });
  });
});

describe('observers', () => {
  it('streams events to an observer and reports the final record once', async () => {
    const { registry } = setup();
    const reg = registry();
    const events: string[] = [];
    const done: RunRecord[] = [];
    const work = deferredRun();
    await reg.start(
      request({
        run: work.run,
        observer: { onEvent: (e) => events.push(e.event), onDone: (r) => done.push(r) },
      })
    );
    const late: RunRecord[] = [];
    const attached = await reg.start(request({ observer: { onDone: (r) => late.push(r) } }));
    expect(attached).toMatchObject({ kind: 'attached', observed: true });
    await settle();
    work.resolve({ status: 'completed' });
    await settle();
    expect(events).toEqual(['provider_enrichment.page']);
    expect(done.map((r) => r.status)).toEqual(['completed']);
    expect(late.map((r) => r.status)).toEqual(['completed']);
  });
});

describe('result cap', () => {
  it('keeps a small result whole', () => {
    expect(capRunResult({ a: 1, b: [1] }, 1_000)).toEqual({
      result: { a: 1, b: [1] },
      truncated: false,
    });
  });

  it('keeps only the scalar fields of an oversized result', async () => {
    const { registry } = setup();
    const reg = new RunRegistry({
      store: new InMemoryRunStore(),
      timers: false,
      maxResultBytes: 200,
    });
    void registry;
    const big = {
      status: 'completed',
      callsUsed: 9,
      targets: Array.from({ length: 50 }, (_, i) => ({ i })),
    };
    const outcome = await reg.start(request({ run: async () => big }));
    await settle();
    const runId = outcome.kind === 'started' ? outcome.run.runId : '';
    expect(await reg.status(runId)).toMatchObject({
      status: 'completed',
      resultTruncated: true,
      result: { status: 'completed', callsUsed: 9 },
    });
    expect((await reg.status(runId))?.result).not.toHaveProperty('targets');
  });
});

describe('Redis run store adapter', () => {
  it('sends only short, non-blocking commands', async () => {
    const sent: { command: string; args: string[] }[] = [];
    const replies: unknown[] = ['OK', null, 'OK', 1, 0, 'run-1'];
    const store = createRedisRunStore({
      async send(command, args) {
        sent.push({ command, args });
        return replies.shift();
      },
    });
    await store.set('k', 'v', 1500);
    expect(await store.setIfAbsent('lock', 'run-1', 120_000)).toBe(false);
    expect(await store.setIfAbsent('lock', 'run-1', 120_000)).toBe(true);
    expect(await store.renewIfOwner('lock', 'run-1', 120_000)).toBe(true);
    expect(await store.deleteIfOwner('lock', 'run-2')).toBe(false);
    expect(await store.get('lock')).toBe('run-1');

    expect(sent.map((c) => c.command)).toEqual(['SET', 'SET', 'SET', 'EVAL', 'EVAL', 'GET']);
    expect(sent[0]?.args).toEqual(['k', 'v', 'PX', '1500']);
    expect(sent[1]?.args).toEqual(['lock', 'run-1', 'NX', 'PX', '120000']);
    expect(sent[3]?.args).toEqual([RENEW_IF_OWNER_SCRIPT, '1', 'lock', 'run-1', '120000']);
    expect(sent[4]?.args).toEqual([DELETE_IF_OWNER_SCRIPT, '1', 'lock', 'run-2']);
    for (const script of [RENEW_IF_OWNER_SCRIPT, DELETE_IF_OWNER_SCRIPT]) {
      const calls = [...script.matchAll(/redis\.call\('([A-Z]+)'/g)].map((m) => m[1]);
      expect(calls.every((c) => ['GET', 'PEXPIRE', 'DEL'].includes(c!))).toBe(true);
    }
  });
});
