/**
 * A small TTL cache for rows that are read constantly and written almost never.
 *
 * Deliberately in-process and not Redis. This app runs as one Railway service;
 * adding a network hop and another thing to operate to avoid a 1ms Postgres
 * lookup would be slower and worse. If it ever scales to several instances the
 * only consequence is that each keeps its own copy for at most one TTL, which
 * is the same staleness window that already exists here.
 *
 * Entries carry an absolute expiry rather than a timer, so nothing keeps the
 * event loop alive and there is no timer per key. Expired entries are dropped
 * lazily on read, plus a bounded sweep on write so a cache keyed by user id
 * cannot grow forever on an app with many users.
 */
class TtlCache {
  constructor({ ttlMs = 30_000, max = 5_000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value) {
    if (this.map.size >= this.max) this.sweep();
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  /** Explicit invalidation, for when the underlying row is written. */
  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  /* Drop what has expired; if that frees nothing, drop the oldest quarter.
     Map preserves insertion order, so the oldest keys come first. */
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expires <= now) this.map.delete(k);
    }
    if (this.map.size >= this.max) {
      const drop = Math.ceil(this.max / 4);
      let i = 0;
      for (const k of this.map.keys()) {
        if (i++ >= drop) break;
        this.map.delete(k);
      }
    }
  }

  /**
   * Read-through with single-flight. Without the in-flight map, N concurrent
   * requests for a cold key all miss and all hit the database — a stampede
   * exactly when the app is busiest. They share one promise instead.
   */
  async wrap(key, loader) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    this.inflight ||= new Map();
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const value = await loader();
        if (value !== undefined) this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }
}

module.exports = { TtlCache };
