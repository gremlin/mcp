import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FallbackStore, MemoryStore, RedisStore, type SharedStore } from '../../src/shared-store';

const REDIS_URL = process.env.GREMLIN_MCP_TEST_REDIS_URL;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What every store must do, so the app behaves the same whichever one it is given. Redis runs only
 * when GREMLIN_MCP_TEST_REDIS_URL points at one, e.g. `docker run --rm -p 6379:6379 redis:7`.
 */
function contract(name: string, open: () => Promise<SharedStore>, skip = false) {
  describe.skipIf(skip)(`${name} contract`, () => {
    let store: SharedStore;
    // Unique per run, so a shared Redis never sees leftovers from an earlier one.
    const key = (suffix: string) => `test:${randomUUID()}:${suffix}`;

    beforeAll(async () => {
      store = await open();
    });
    afterAll(async () => {
      await store.close();
    });

    it('returns what was set, and nothing for an unknown key', async () => {
      const k = key('get');
      await store.set(k, 'value', 10_000);
      expect(await store.get(k)).toBe('value');
      expect(await store.get(key('missing'))).toBeUndefined();
    });

    it('forgets a value once its TTL passes', async () => {
      const k = key('ttl');
      await store.set(k, 'value', 50);
      await pause(120);
      expect(await store.get(k)).toBeUndefined();
    });

    it('stores nothing for a non-positive TTL', async () => {
      const k = key('zero');
      await store.set(k, 'value', 0);
      await store.set(k, 'value', -5);
      expect(await store.get(k)).toBeUndefined();
    });

    it('deletes', async () => {
      const k = key('delete');
      await store.set(k, 'value', 10_000);
      await store.delete(k);
      expect(await store.get(k)).toBeUndefined();
    });

    it('counts up, and restarts once the first increment has expired', async () => {
      const k = key('counter');
      expect(await store.increment(k, 80)).toBe(1);
      expect(await store.increment(k, 80)).toBe(2);
      // A later increment must not extend the window, or a steady caller would never reset.
      await pause(50);
      expect(await store.increment(k, 80)).toBe(3);
      await pause(60);
      expect(await store.increment(k, 80)).toBe(1);
    });
  });
}

contract('MemoryStore', async () => new MemoryStore());
contract('RedisStore', () => RedisStore.connect(REDIS_URL!), !REDIS_URL);

describe('RedisStore', () => {
  it('fails to connect to an unreachable server instead of retrying forever', async () => {
    // Startup must stop on a bad GREMLIN_MCP_REDIS_URL, not hang before listening.
    await expect(RedisStore.connect('redis://127.0.0.1:1')).rejects.toThrow();
  });
});

describe('MemoryStore', () => {
  it('reclaims expired entries on sweep, keeping live ones', async () => {
    // Keys are rarely read again once they lapse (a rotated client token, a quiet source), so
    // without the sweep they would accumulate forever.
    let now = 0;
    const store = new MemoryStore(() => now);
    await store.set('short', 'v', 1_000);
    await store.set('long', 'v', 10_000);
    await store.increment('counter', 1_000);

    now = 5_000;
    store.sweep();

    expect(store.size()).toBe(1);
    expect(await store.get('long')).toBe('v');
  });
});

describe('FallbackStore', () => {
  function broken(): SharedStore {
    const fail = async () => {
      throw new Error('connection refused');
    };
    return {
      get: fail,
      set: fail,
      delete: fail,
      increment: fail,
      sweep: () => {},
      close: async () => {},
    };
  }

  it('answers from the fallback when the primary fails, and reports each failure', async () => {
    // A Redis outage must degrade to per-instance behaviour, not fail requests: everything stored
    // is a cache or a counter, so losing it costs upstream calls and nothing else.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const failures: string[] = [];
    const store = new FallbackStore(broken(), new MemoryStore(), (operation) => failures.push(operation));

    await store.set('k', 'v', 10_000);
    expect(await store.get('k')).toBe('v');
    expect(await store.increment('c', 10_000)).toBe(1);
    expect(await store.increment('c', 10_000)).toBe(2);
    await store.delete('k');
    expect(await store.get('k')).toBeUndefined();

    expect(failures).toEqual(['set', 'get', 'increment', 'increment', 'delete', 'get']);
    vi.restoreAllMocks();
  });

  it('logs once when one operation keeps failing while the others work', async () => {
    // Otherwise every request would log both "unavailable" and "recovered".
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const primary: SharedStore = { ...broken(), get: async () => 'v' };
    const store = new FallbackStore(primary, new MemoryStore());

    for (let i = 0; i < 3; i++) {
      await store.get('k');
      await store.increment('c', 10_000);
    }

    expect(write).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('prefers the primary while it works', async () => {
    const primary = new MemoryStore();
    const fallback = new MemoryStore();
    const store = new FallbackStore(primary, fallback);

    await store.set('k', 'v', 10_000);

    expect(await primary.get('k')).toBe('v');
    expect(fallback.size()).toBe(0);
  });

  it('deletes from both, so an entry written during an outage cannot outlive a delete', async () => {
    const primary = new MemoryStore();
    const fallback = new MemoryStore();
    await fallback.set('k', 'stale', 10_000);
    const store = new FallbackStore(primary, fallback);

    await store.delete('k');

    expect(await fallback.get('k')).toBeUndefined();
  });
});
