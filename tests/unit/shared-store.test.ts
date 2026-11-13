import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createClient } from '@redis/client';

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

  it.skipIf(!REDIS_URL)('applies commands that timed out in the order they were sent', async () => {
    // A timed-out command still runs once the server catches up. If a stalled set could land after
    // the delete that followed it, a token the API rejected would come back for its full lifetime.
    const store = await RedisStore.connect(REDIS_URL!);
    const admin = createClient({ url: REDIS_URL });
    await admin.connect();
    const kept = `test:${randomUUID()}:kept`;
    const forgotten = `test:${randomUUID()}:forgotten`;
    try {
      await admin.sendCommand(['CLIENT', 'PAUSE', '1000', 'ALL']);
      // Sent together, in this order, all inside the pause.
      const sent = await Promise.allSettled([
        store.set(kept, 'token', 60_000),
        store.set(forgotten, 'rejected-token', 60_000),
        store.delete(forgotten),
      ]);
      expect(sent.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
      await pause(700);

      // The first proves timed-out commands do still run, so the second is not passing vacuously.
      expect(await store.get(kept)).toBe('token');
      expect(await store.get(forgotten)).toBeUndefined();
    } finally {
      await store.close();
      await admin.close();
    }
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

  it('answers from the fallback when the primary fails, and reports each failed attempt', async () => {
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

    // Repeats skip the primary, so they are not attempts.
    expect(failures).toEqual(['set', 'get', 'increment', 'delete']);
    vi.restoreAllMocks();
  });

  it('stops trying a failing primary for a while, then probes it once', async () => {
    // A stalled Redis costs each attempt the full command timeout, and a request makes several, so
    // retrying it on every call would add seconds to every request for the whole stall.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let now = 0;
    let calls = 0;
    const primary: SharedStore = {
      ...broken(),
      get: async () => {
        calls++;
        throw new Error('timed out');
      },
    };
    const store = new FallbackStore(primary, new MemoryStore(), undefined, () => now);

    await store.get('k');
    await store.get('k');
    now += 4_999;
    await store.get('k');
    expect(calls).toBe(1);

    now += 1;
    // Concurrent calls when the interval lapses: one waits on the primary, the rest do not.
    await Promise.all([store.get('k'), store.get('k'), store.get('k')]);
    expect(calls).toBe(2);
    vi.restoreAllMocks();
  });

  it('goes back to the primary once a probe succeeds', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let now = 0;
    let up = false;
    const primary: SharedStore = {
      ...broken(),
      get: async () => {
        if (!up) throw new Error('timed out');
        return 'from primary';
      },
    };
    const store = new FallbackStore(primary, new MemoryStore(), undefined, () => now);

    expect(await store.get('k')).toBeUndefined();
    up = true;
    expect(await store.get('k')).toBeUndefined();
    now += 5_000;
    expect(await store.get('k')).toBe('from primary');
    expect(await store.get('k')).toBe('from primary');
    vi.restoreAllMocks();
  });

  it('keeps using the primary for the operations that still work', async () => {
    // e.g. a Redis that refuses EVAL: counters fall back, the token cache stays shared.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const primary: SharedStore = { ...broken(), get: async () => 'from primary' };
    const store = new FallbackStore(primary, new MemoryStore());

    await store.increment('c', 10_000);

    expect(await store.get('k')).toBe('from primary');
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

  it('deletes from the primary even while skipping it', async () => {
    // A delete is a `forget` of a token the API rejected. Skipping it would leave that token in
    // Redis for every instance until it expires.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let deletes = 0;
    let up = false;
    const primary: SharedStore = {
      ...broken(),
      delete: async () => {
        deletes++;
        if (!up) throw new Error('timed out');
      },
    };
    const store = new FallbackStore(primary, new MemoryStore(), undefined, () => 0);

    await store.delete('k');
    up = true;
    await store.delete('k');

    expect(deletes).toBe(2);
    vi.restoreAllMocks();
  });

  it('stays degraded when a call that started earlier succeeds after a newer failure', async () => {
    // Otherwise one slow success during a stall sends every call back to wait on the timeout.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let now = 0;
    let calls = 0;
    let finishSlow: (value: string) => void = () => {};
    const primary: SharedStore = {
      ...broken(),
      get: async () => {
        calls++;
        if (calls === 1) return new Promise<string>((resolve) => (finishSlow = resolve));
        throw new Error('timed out');
      },
    };
    const store = new FallbackStore(primary, new MemoryStore(), undefined, () => now);

    const slow = store.get('k');
    await store.get('k');
    now += 1;
    finishSlow('late');
    expect(await slow).toBe('late');
    await store.get('k');

    expect(calls).toBe(2);
    vi.restoreAllMocks();
  });
});
