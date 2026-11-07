// Small in-memory LRU cache with in-flight request coalescing.
// Successful results are cached; callers decide what counts as a cacheable value.
export function createCache(ttlMs, maxEntries = 500) {
  const store = new Map();
  const pending = new Map();

  function get(key) {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (Date.now() >= hit.expires) {
      store.delete(key);
      return undefined;
    }
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  }

  function set(key, value, customTtlMs = ttlMs) {
    if (customTtlMs <= 0) return value;
    if (store.has(key)) store.delete(key);
    while (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
    store.set(key, { value, expires: Date.now() + customTtlMs });
    return value;
  }

  async function wrap(key, fn, options = {}) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    if (pending.has(key)) return pending.get(key);

    const shouldCache = options.shouldCache || ((value) => value !== null && value !== undefined);
    const ttl = options.ttlMs ?? ttlMs;
    const task = Promise.resolve()
      .then(fn)
      .then((value) => {
        if (shouldCache(value)) set(key, value, ttl);
        return value;
      })
      .finally(() => pending.delete(key));

    pending.set(key, task);
    return task;
  }

  return { get, set, wrap, size: () => store.size, pendingSize: () => pending.size };
}

export const searchCache = createCache(10 * 60 * 1000);
export const streamCache = createCache(4 * 60 * 1000);
export const probeCache = createCache(4 * 60 * 1000);
