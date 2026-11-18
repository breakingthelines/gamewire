import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every stream write goes through the protos SDK (`publishFact` in
// `@breakingthelines/protos/sdk/eventbus`), which resolves the shared events
// database. A Redis stream command spelled out in gamewire's own source would
// bypass that, so none may appear as a string literal outside tests. This is
// the TypeScript half of the events-bus rule the Go services enforce with
// forbidigo.
const STREAM_COMMANDS = /\b(XADD|XREADGROUP|XREAD|XGROUP|XAUTOCLAIM|XCLAIM|XACK)\b/i;

const srcRoot = fileURLToPath(new URL('../', import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'fixtures' || entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });

/** String and template literal texts in a file that name a stream command. */
const streamCommandLiterals = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
      STREAM_COMMANDS.test(node.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${file}:${line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('events bus: no direct stream commands in src', () => {
  it('finds a stream command literal when one is present', () => {
    // Proves the scan below would fire.
    const sample =
      "await client.send('XADD', ['btl:facts:x', '*']);\n// XADD in a comment is fine\n";
    expect(streamCommandLiterals('sample.ts', sample)).toEqual(['sample.ts:1: XADD']);
    expect(streamCommandLiterals('t.ts', 'const c = `xreadgroup ${g}`;')).toHaveLength(1);
  });

  it('has none outside tests', () => {
    const files = sourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(20);
    const hits = files.flatMap((file) =>
      streamCommandLiterals(relative(srcRoot, file), readFileSync(file, 'utf8'))
    );
    expect(hits).toEqual([]);
  });
});

// `Bun.redis` is one connection shared by the minute limiters, the workflow
// cursors and the emit-once keys. A blocking command on it holds every other
// command behind it: a 5 s XREADGROUP BLOCK consumer on it once made each
// provider-enrichment page take 50 s. A blocking reader gets its own
// `new Bun.RedisClient(url)`; see the rule at `sharedRedis` in server.ts.
const BLOCKING_COMMANDS =
  /^(BLPOP|BRPOP|BRPOPLPUSH|BLMOVE|BLMPOP|BZPOPMIN|BZPOPMAX|BZMPOP|WAIT|WAITAOF|SUBSCRIBE|PSUBSCRIBE|SSUBSCRIBE|MONITOR|BLOCK)$/i;
const BLOCKING_METHODS =
  /^(blpop|brpop|brpoplpush|blmove|blmpop|bzpopmin|bzpopmax|bzmpop|wait|waitaof|subscribe|psubscribe|ssubscribe|monitor|xread|xreadgroup)$/i;

/**
 * String literals that are exactly a blocking command (or `BLOCK`), so prose
 * such as "wait for the next minute" passes, and calls of a blocking client method.
 */
const blockingCommandUses = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const at = (node: ts.Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
      BLOCKING_COMMANDS.test(node.text.trim())
    ) {
      found.push(`${at(node)}: ${node.text}`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      BLOCKING_METHODS.test(node.expression.name.text)
    ) {
      found.push(`${at(node)}: .${node.expression.name.text}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** `Bun.redis`, `bunGlobal?.redis`, `(globalThis as …).Bun?.redis`: the shared client. */
const isSharedClientRead = (node: ts.Node): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === 'redis' &&
  /(^|\.|\?\.)(Bun|bunGlobal)$/.test(node.expression.getText().replace(/\s+/g, ''));

/** Calls the shared client may be handed to: adapters that send short, non-blocking commands. */
const SHARED_CLIENT_CONSUMERS = new Set([
  'createRedisMinuteCounterClient',
  'createRedisLikeClient',
  'RedisEmittedFixtureStore',
  'createRedisRunStore',
]);

const calleeName = (call: ts.CallExpression | ts.NewExpression): string | undefined => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
};

/** True when `node` is (inside an object literal) an argument of `call`. */
const isArgumentOf = (node: ts.Node, call: ts.CallExpression | ts.NewExpression): boolean =>
  (call.arguments ?? []).some((arg) => arg.pos <= node.pos && node.end <= arg.end);

/**
 * Every place a binding of the shared client is used other than a truthiness
 * check or an argument to an allowed consumer, plus any read of the shared
 * client outside server.ts.
 */
const sharedClientMisuse = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const at = (node: ts.Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const bindings = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (isSharedClientRead(node)) {
      if (!file.endsWith('server.ts')) {
        found.push(`${at(node)}: shared client read outside server.ts`);
      }
      let up: ts.Node = node;
      while (up.parent && !ts.isVariableDeclaration(up) && !ts.isStatement(up)) {
        up = up.parent;
      }
      if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) {
        bindings.add(up.name.text);
      } else {
        found.push(`${at(node)}: shared client used without a named binding`);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const allowed = (ref: ts.Identifier): boolean => {
    const parent = ref.parent;
    if (ts.isVariableDeclaration(parent) && parent.name === ref) {
      return true;
    }
    // Truthiness checks: `if (!x)`, `x ? … : …`, `x && …`.
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
      return true;
    }
    if (ts.isIfStatement(parent) && parent.expression === ref) {
      return true;
    }
    if (ts.isConditionalExpression(parent) && parent.condition === ref) {
      return true;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === ref &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return true;
    }
    for (let up: ts.Node | undefined = parent; up; up = up.parent) {
      if ((ts.isCallExpression(up) || ts.isNewExpression(up)) && isArgumentOf(ref, up)) {
        // The nearest call that takes it decides.
        return SHARED_CLIENT_CONSUMERS.has(calleeName(up) ?? '');
      }
      if (ts.isStatement(up)) {
        return false;
      }
    }
    return false;
  };

  const check = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.has(node.text) && !allowed(node)) {
      found.push(`${at(node)}: shared client ${node.text} used in ${node.parent.getText()}`);
    }
    ts.forEachChild(node, check);
  };
  check(source);
  return found;
};

describe('shared Bun.redis connection: no blocking readers', () => {
  it('finds blocking commands and blocking client methods when present', () => {
    // Proves the scans below would fire.
    const sample = [
      "await client.send('BLPOP', ['q', '0']);",
      "await client.send('XREADGROUP', ['GROUP', g, c, 'BLOCK', '5000']);",
      'await redis.subscribe(channel, onMessage);',
      'const ok = "wait for the next minute";',
    ].join('\n');
    expect(blockingCommandUses('sample.ts', sample)).toEqual([
      'sample.ts:1: BLPOP',
      'sample.ts:2: BLOCK',
      'sample.ts:3: .subscribe()',
    ]);
  });

  it('has no blocking command or blocking client call outside tests', () => {
    const hits = sourceFiles(srcRoot).flatMap((file) =>
      blockingCommandUses(relative(srcRoot, file), readFileSync(file, 'utf8'))
    );
    expect(hits).toEqual([]);
  });

  it('flags the shared client handed to a stream reader', () => {
    const sample = [
      'const bunRedis = (globalThis as any).Bun?.redis;',
      'if (!bunRedis) { throw new Error("no redis"); }',
      'const store = new RedisEmittedFixtureStore({ client: bunRedis });',
      'const minute = bunRedis ? createRedisMinuteCounterClient(bunRedis) : undefined;',
      'const consumer = new RedisStreamConsumer({ client: createBunRedisStreamClient(bunRedis) });',
      'const alias = bunRedis;',
    ].join('\n');
    expect(sharedClientMisuse('worker/server.ts', sample)).toEqual([
      'worker/server.ts:5: shared client bunRedis used in createBunRedisStreamClient(bunRedis)',
      'worker/server.ts:6: shared client bunRedis used in alias = bunRedis',
    ]);
    expect(sharedClientMisuse('worker/other.ts', 'const r = Bun.redis;')).toEqual([
      'worker/other.ts:1: shared client read outside server.ts',
    ]);
  });

  it('the run registry store sends only GET, SET and EVAL of its two lease scripts', () => {
    // The registry renews leases and writes run records every 15 s per run on
    // the shared connection, so it must stay on short commands.
    const text = readFileSync(join(srcRoot, 'worker', 'run-registry.ts'), 'utf8');
    const commands = [...text.matchAll(/\.send\(\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(commands)].sort()).toEqual(['EVAL', 'GET', 'SET']);
    const scriptCalls = [...text.matchAll(/redis\.call\('([A-Za-z]+)'/g)].map((m) => m[1]);
    expect([...new Set(scriptCalls)].sort()).toEqual(['DEL', 'GET', 'PEXPIRE']);
  });

  it('server.ts hands Bun.redis only to non-blocking adapters', () => {
    const files = sourceFiles(srcRoot);
    const hits = files.flatMap((file) =>
      sharedClientMisuse(relative(srcRoot, file), readFileSync(file, 'utf8'))
    );
    expect(hits).toEqual([]);
    // The scan found the real bindings, so an empty result means something.
    const server = readFileSync(join(srcRoot, 'worker', 'server.ts'), 'utf8');
    const reads: string[] = [];
    const visit = (node: ts.Node): void => {
      if (isSharedClientRead(node)) {
        reads.push(node.getText());
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('server.ts', server, ts.ScriptTarget.ES2022, true));
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });
});
