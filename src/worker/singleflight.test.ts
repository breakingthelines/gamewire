import { describe, expect, it, vi } from 'vitest';

import { Singleflight } from './singleflight.js';

describe('Singleflight', () => {
  it('coalesces concurrent calls for the same key', async () => {
    const sf = new Singleflight();
    const loader = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'value';
    });

    const [a, b, c] = await Promise.all([
      sf.do('k', loader),
      sf.do('k', loader),
      sf.do('k', loader),
    ]);

    expect(a).toBe('value');
    expect(b).toBe('value');
    expect(c).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sf.inflightCount()).toBe(0);
  });

  it('re-runs the loader after a settled call', async () => {
    const sf = new Singleflight();
    const loader = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    expect(await sf.do('k', loader)).toBe('first');
    expect(await sf.do('k', loader)).toBe('second');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('treats distinct keys independently', async () => {
    const sf = new Singleflight();
    const loader = vi.fn().mockImplementation(async (key: string) => `value:${key}`);

    const [a, b] = await Promise.all([
      sf.do('alpha', () => loader('alpha')),
      sf.do('beta', () => loader('beta')),
    ]);

    expect(a).toBe('value:alpha');
    expect(b).toBe('value:beta');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('clears the inflight entry on rejection', async () => {
    const sf = new Singleflight();
    const fail = vi.fn().mockRejectedValueOnce(new Error('boom'));

    await expect(sf.do('k', fail)).rejects.toThrow('boom');
    expect(sf.inflightCount()).toBe(0);

    const succeed = vi.fn().mockResolvedValue('ok');
    expect(await sf.do('k', succeed)).toBe('ok');
    expect(succeed).toHaveBeenCalledTimes(1);
  });

  it('reports inflight count while a call is in progress', async () => {
    const sf = new Singleflight();
    let release: (() => void) | undefined;
    const pending = sf.do(
      'k',
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('done');
        })
    );

    expect(sf.inflightCount()).toBe(1);
    release?.();
    expect(await pending).toBe('done');
    expect(sf.inflightCount()).toBe(0);
  });
});
