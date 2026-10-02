import { createHash } from 'node:crypto';

/**
 * RFC 8693 token exchange against Gremlin's authorization server. See the design, §B3.8 and §B4.3.
 *
 * The client's token travels here as a form parameter rather than a credential; this server
 * authenticates as itself, and the token that comes back is what reaches the API. A successful
 * exchange doubles as proof the client's token was valid and minted for this server, because the
 * authorization server refuses it otherwise.
 */

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Margin before a cached token's expiry, sized to cover a request's round trip. */
const EXPIRY_MARGIN_MS = 30_000;

export interface TokenExchangeConfig {
  /** The authorization server's token endpoint. */
  readonly tokenEndpoint: string;
  /** This server's own OAuth client id. */
  readonly clientId: string;
  /** This server's own client secret. Never leaves this module. */
  readonly clientSecret: string;
  /** The audience to request, i.e. the Gremlin API. */
  readonly targetResource: string;
}

/**
 * Why an exchange failed, in the terms the caller has to act on: `invalid` becomes a 401 so Claude
 * reconnects, `forbidden` a terminal 403, `unavailable` a 503. Claude treats any 403 without
 * `insufficient_scope` as terminal, so mapping an expired token to one breaks the connector
 * permanently.
 */
export type ExchangeFailure = 'invalid' | 'forbidden' | 'unavailable';

export type ExchangeResult =
  | { readonly ok: true; readonly accessToken: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: ExchangeFailure };

interface CacheEntry {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/**
 * Exchanges client tokens for API tokens, and remembers the answers for the exchanged token's own
 * lifetime -- which is also the worst-case revocation delay, since a grant revoked at the
 * authorization server keeps working here until the entry lapses.
 */
export class TokenExchanger {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: TokenExchangeConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** A stable, non-reversible handle for a client token, safe to use as a map key. */
  private key(subjectToken: string): string {
    return createHash('sha256').update(subjectToken).digest('hex');
  }

  async exchange(subjectToken: string): Promise<ExchangeResult> {
    const key = this.key(subjectToken);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return { ok: true, accessToken: cached.accessToken, expiresAt: cached.expiresAt };
    }
    this.cache.delete(key);

    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      resource: this.config.targetResource,
    });

    let response: Response;
    try {
      response = await fetch(this.config.tokenEndpoint, {
        method: 'POST',
        headers: {
          // client_secret_basic: this server proves who it is. The subject token stays in the
          // body, where it is data rather than a credential.
          'Authorization': `Basic ${Buffer.from(
            `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch {
      // A transport failure says nothing about the token; reporting it as invalid would
      // disconnect every working connector during a blip.
      return { ok: false, reason: 'unavailable' };
    }

    if (!response.ok) {
      return { ok: false, reason: classify(response.status, await safeJson(response)) };
    }

    const payload = (await safeJson(response)) as
      | { access_token?: string; expires_in?: number }
      | undefined;
    if (!payload?.access_token) {
      return { ok: false, reason: 'unavailable' };
    }

    const expiresAt = this.now() + (payload.expires_in ?? 0) * 1000;
    this.cache.set(key, { accessToken: payload.access_token, expiresAt });
    return { ok: true, accessToken: payload.access_token, expiresAt };
  }

  /** Drops a cached entry. Used when the API rejects a token we believed was good. */
  forget(subjectToken: string): void {
    this.cache.delete(this.key(subjectToken));
  }

  /**
   * Drops entries whose tokens have expired.
   *
   * A cached entry is only replaced when its own key is asked for again, and a client's token
   * changes on every refresh -- so without this the map grows by one entry per rotation per user
   * and nothing ever reclaims the old ones. Called from the same timer that reaps idle sessions.
   */
  reapExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Maps an authorization-server error onto what the MCP client needs to do about it.
 *
 * `access_denied` is the organization's AI switch being off -- nothing reconnecting can fix, so it
 * must not trigger a reconnect loop. Everything else at 400 is a statement about the token itself,
 * `invalid_target` included.
 */
function classify(status: number, payload: unknown): ExchangeFailure {
  const error = (payload as { error?: string } | undefined)?.error;
  if (error === 'access_denied') {
    return 'forbidden';
  }
  if (status === 400 || status === 401) {
    return 'invalid';
  }
  return 'unavailable';
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
