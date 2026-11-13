import { createClient } from '@redis/client';

/**
 * Short-lived state the hosted server's instances can share: the exchanged-token cache, validation
 * outcomes, and the validation rate limiter. See SCALABILITY.md §5.
 *
 * <p>In memory by default, which is per instance. With `GREMLIN_MCP_REDIS_URL` it is Redis, so N
 * instances do one exchange per token and share one rate bound instead of N of each.
 *
 * <p>Everything here is a cache or a counter. Losing it costs upstream calls, never correctness, which
 * is why a Redis outage falls back to memory rather than failing requests; see {@link FallbackStore}.
 */
export interface SharedStore {
  get(key: string): Promise<string | undefined>;
  /** Stores `value` for `ttlMs`. A non-positive TTL stores nothing. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Adds one to a counter that expires `ttlMs` after its first increment. Returns the new count. */
  increment(key: string, ttlMs: number): Promise<number>;
  /** Drops expired entries. Redis expires keys itself, so only memory has work to do. */
  sweep(): void;
  close(): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

export class MemoryStore implements SharedStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(key)?.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    const entry = this.live(key);
    const count = (entry ? Number(entry.value) : 0) + 1;
    this.entries.set(key, { value: String(count), expiresAt: entry?.expiresAt ?? this.now() + ttlMs });
    return count;
  }

  /**
   * Without this, keys that are never read again (a client token rotated away from, a source that
   * stopped calling) would sit here forever.
   */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {}
}

const KEY_PREFIX = 'gremlin-mcp:';

/**
 * A command waits at most this long. Redis is an optimisation here, so a slow one should cost a
 * cache miss, not a slow request.
 */
const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 5_000;

function redisClient(url: string) {
  return createClient({
    url,
    // Queued commands would hang requests for the length of an outage; failing lets the fallback
    // answer straight away.
    disableOfflineQueue: true,
    commandOptions: { timeout: COMMAND_TIMEOUT_MS },
    socket: { connectTimeout: CONNECT_TIMEOUT_MS },
  });
}

export class RedisStore implements SharedStore {
  private constructor(private readonly client: ReturnType<typeof redisClient>) {}

  /**
   * Connects before returning, so a bad URL or unreachable server stops startup instead of quietly
   * running every instance on its own memory.
   */
  static async connect(url: string): Promise<RedisStore> {
    const client = redisClient(url);
    // An unhandled 'error' event would crash the process. Reconnects are automatic, and failed
    // commands are reported by the FallbackStore, so this only needs to exist.
    client.on('error', () => {});
    await client.connect();
    return new RedisStore(client);
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.client.get(KEY_PREFIX + key)) ?? undefined;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const ms = Math.floor(ttlMs);
    if (ms <= 0) return;
    await this.client.set(KEY_PREFIX + key, value, { expiration: { type: 'PX', value: ms } });
  }

  async delete(key: string): Promise<void> {
    await this.client.del(KEY_PREFIX + key);
  }

  /** One round trip, atomic. `PEXPIRE … NX` needs Redis or Valkey 7+. */
  async increment(key: string, ttlMs: number): Promise<number> {
    const prefixed = KEY_PREFIX + key;
    const [count] = await this.client
      .multi()
      .incr(prefixed)
      .pExpire(prefixed, Math.max(1, Math.floor(ttlMs)), 'NX')
      .exec();
    return Number(count);
  }

  sweep(): void {}

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}

export type StoreOperation = 'get' | 'set' | 'delete' | 'increment';

/**
 * Serves from `primary` and falls back to `fallback` for any call `primary` fails.
 *
 * <p>So a Redis outage degrades to per-instance behaviour: more exchanges, per-instance rate
 * bounds, but every request still answered. Failing the request instead would turn a cache outage
 * into a full one, and reporting it as a bad token would disconnect working clients (AUTH.md
 * invariant 7).
 *
 * <p>Logs only when it starts and stops degrading; `onError` sees every failure.
 */
export class FallbackStore implements SharedStore {
  private degraded = false;

  constructor(
    private readonly primary: SharedStore,
    private readonly fallback: SharedStore,
    private readonly onError: (operation: StoreOperation, error: unknown) => void = () => {},
  ) {}

  private async attempt<T>(operation: StoreOperation, run: (store: SharedStore) => Promise<T>): Promise<T> {
    try {
      const result = await run(this.primary);
      if (this.degraded) {
        this.degraded = false;
        process.stderr.write('Shared store recovered\n');
      }
      return result;
    } catch (error) {
      this.onError(operation, error);
      if (!this.degraded) {
        this.degraded = true;
        process.stderr.write(
          `Shared store unavailable, using per-instance memory: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return run(this.fallback);
    }
  }

  get(key: string): Promise<string | undefined> {
    return this.attempt('get', (store) => store.get(key));
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    return this.attempt('set', (store) => store.set(key, value, ttlMs));
  }

  /** From both, so an entry stored in the fallback during an outage cannot outlive a delete. */
  async delete(key: string): Promise<void> {
    await this.fallback.delete(key);
    await this.attempt('delete', (store) => store.delete(key));
  }

  increment(key: string, ttlMs: number): Promise<number> {
    return this.attempt('increment', (store) => store.increment(key, ttlMs));
  }

  sweep(): void {
    this.primary.sweep();
    this.fallback.sweep();
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }
}
