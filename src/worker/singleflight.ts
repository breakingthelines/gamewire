/**
 * Singleflight: coalesce concurrent calls that share the same key so the
 * underlying loader runs at most once. Inflight callers await the same promise.
 *
 * This is the contract that prevents viewer count from multiplying provider
 * calls: regardless of how many ingestion ticks or HTTP requests demand the
 * same fixture, only one provider call ever leaves the worker.
 */

export class Singleflight {
  readonly #inflight = new Map<string, Promise<unknown>>();

  /**
   * Run `loader` for `key`. If another caller is already running `loader`
   * for the same `key`, the same promise is returned to all callers.
   *
   * The map entry is cleared after the promise settles (success or failure).
   */
  async do<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const pending = loader().finally(() => {
      // Clear on settle so the next call re-runs the loader fresh.
      if (this.#inflight.get(key) === pending) {
        this.#inflight.delete(key);
      }
    });

    this.#inflight.set(key, pending);
    return pending;
  }

  /**
   * Inspector for tests: how many keys are currently inflight.
   */
  inflightCount(): number {
    return this.#inflight.size;
  }
}
