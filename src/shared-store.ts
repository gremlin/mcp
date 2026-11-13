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
    this.entries.set(key, {
      value: String(count),
      expiresAt: entry?.expiresAt ?? this.now() + ttlMs,
    });
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
 * cache miss, not a slow request. Enforced by {@link RedisStore}: the client's own
 * `commandOptions.timeout` stops counting once a command is written, so a stalled server hangs it.
 */
const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * A timed-out command stays queued until the server answers, so a stalled server would grow the
 * queue by the request rate (~2.6 KB each) for the length of the stall. Past this, commands are
 * refused straight away and served by the fallback. Normal depth is rate × latency, i.e. tens.
 */
const MAX_PENDING_COMMANDS = 1_000;

/** INCR, starting the window on the first one. Atomic, and unlike `PEXPIRE … NX` any Redis runs it. */
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;

function redisClient(url: string) {
  // The default strategy retries forever, so an unreachable server would hang startup silently.
  // Give up until the first connection succeeds; after that, outages are the fallback's problem.
  let connectedOnce = false;
  const client = createClient({
    url,
    // Queued commands would hang requests for the length of an outage; failing lets the fallback
    // answer straight away.
    disableOfflineQueue: true,
    commandsQueueMaxLength: MAX_PENDING_COMMANDS,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => (connectedOnce ? Math.min(2 ** retries * 50, 2_000) : false),
    },
  });
  client.once('ready', () => {
    connectedOnce = true;
  });
  return client;
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

  /**
   * Rejects after COMMAND_TIMEOUT_MS. The command itself stays pending, and its late reply is
   * dropped.
   */
  private async bounded<T>(command: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Redis command timed out after ${COMMAND_TIMEOUT_MS}ms`)),
        COMMAND_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([command, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.bounded(this.client.get(KEY_PREFIX + key))) ?? undefined;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const ms = Math.floor(ttlMs);
    if (ms <= 0) return;
    await this.bounded(
      this.client.set(KEY_PREFIX + key, value, {
        expiration: { type: 'PX', value: ms },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.bounded(this.client.del(KEY_PREFIX + key));
  }

  /**
   * A script rather than MULTI: the client sends MULTI past `disableOfflineQueue`, so during a
   * reconnect it would queue instead of failing over.
   */
  async increment(key: string, ttlMs: number): Promise<number> {
    const count = await this.bounded(
      this.client.eval(INCREMENT_SCRIPT, {
        keys: [KEY_PREFIX + key],
        arguments: [String(Math.max(1, Math.floor(ttlMs)))],
      }),
    );
    return Number(count);
  }

  sweep(): void {}

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}

export type StoreOperation = 'get' | 'set' | 'delete' | 'increment';

/** How long an operation that failed on the primary goes straight to the fallback. */
const PRIMARY_RETRY_AFTER_MS = 5_000;

/**
 * Serves from `primary` and falls back to `fallback` for any call `primary` fails.
 *
 * <p>So a Redis outage degrades to per-instance behaviour: more exchanges, per-instance rate
 * bounds, but every request still answered. Failing the request instead would turn a cache outage
 * into a full one, and reporting it as a bad token would disconnect working clients (AUTH.md
 * invariant 7).
 *
 * <p>Once an operation fails it skips the primary for {@link PRIMARY_RETRY_AFTER_MS}, then lets one
 * call through to probe it. Without that a stalled Redis costs every call the full command
 * timeout, and a request makes several.
 *
 * <pre>
 *   healthy ──fail──▶ skipping ──interval passes──▶ one probe ──ok──▶ healthy
 *                        ▲                              │
 *                        └────────────fail──────────────┘
 * </pre>
 *
 * <p>Logs only when an operation starts and stops degrading; `onError` sees every failed attempt.
 */
export class FallbackStore implements SharedStore {
  /**
   * When each failing operation may next try the primary; absent while it works. Per operation,
   * so one the server refuses (EVAL on a locked-down Redis, say) does not take the rest off it.
   */
  private readonly retryAt = new Map<StoreOperation, number>();

  constructor(
    private readonly primary: SharedStore,
    private readonly fallback: SharedStore,
    private readonly onError: (operation: StoreOperation, error: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  private async attempt<T>(operation: StoreOperation, run: (store: SharedStore) => Promise<T>): Promise<T> {
    const retryAt = this.retryAt.get(operation);
    if (retryAt !== undefined) {
      if (this.now() < retryAt) return run(this.fallback);
      // This call is the probe. Push the next one out first, so concurrent calls do not all wait on
      // a primary that is probably still down.
      this.retryAt.set(operation, this.now() + PRIMARY_RETRY_AFTER_MS);
    }
    try {
      const result = await run(this.primary);
      if (this.retryAt.delete(operation)) {
        process.stderr.write(`Shared store recovered for ${operation}\n`);
      }
      return result;
    } catch (error) {
      this.onError(operation, error);
      if (!this.retryAt.has(operation)) {
        process.stderr.write(
          `Shared store ${operation} unavailable, using per-instance memory: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      this.retryAt.set(operation, this.now() + PRIMARY_RETRY_AFTER_MS);
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
