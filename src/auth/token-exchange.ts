import { createHash } from 'node:crypto';

/**
 * RFC 8693 token exchange against Gremlin's authorization server.
 *
 * Two things happen here, and they used to be one.
 *
 * The MCP specification forbids an MCP server passing the token it received from its client through
 * to an upstream API. This server used to do exactly that -- and it was also how it decided whether
 * a token was valid at all: call `/users/self` with the client's token and read a 401 as "invalid".
 * Validation and use were the same action, so there was nothing to patch.
 *
 * Exchange separates them. The client's token travels here as a form parameter -- data, not a
 * credential -- this server authenticates as itself with its own client secret, and the token that
 * comes back is what gets used at the API. A successful exchange is simultaneously the proof that
 * the client's token was valid and was minted for this server, because the authorization server
 * refuses the exchange otherwise.
 */

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * How long before a cached token's own expiry we stop using it.
 *
 * A token that expires mid-flight produces a 401 the user sees as a broken tool call, so the
 * margin has to cover a request's round trip with room to spare.
 */
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
 * Why an exchange failed, in the terms the caller has to act on.
 *
 * The distinction is not cosmetic. `invalid` must become a 401 so Claude runs the OAuth flow again;
 * `forbidden` must become a terminal 403; `unavailable` must become a 503. Claude treats any 403
 * without `insufficient_scope` as terminal, so mapping an expired token to 403 produces a connector
 * that is permanently broken rather than one that reconnects.
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
 * Exchanges client tokens for API tokens, and remembers the answers briefly.
 *
 * The cache exists because every tool call would otherwise be preceded by a round trip to the
 * authorization server. Its lifetime is bounded by the exchanged token's own, which the
 * authorization server caps well below the subject token's -- so this cache is also the
 * worst-case revocation delay: a grant revoked there keeps working here until the entry lapses.
 */
export class TokenExchanger {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: TokenExchangeConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** A stable, non-reversible handle for a client token. Never the token itself. */
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
          // client_secret_basic. This server proves who it is; the subject token in the body
          // proves nothing about the caller and is not presented as a credential anywhere.
          'Authorization': `Basic ${Buffer.from(
            `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch {
      // A transport failure says nothing about the token. Reporting it as invalid would
      // disconnect every working connector during an authorization-server blip.
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

  size(): number {
    return this.cache.size;
  }
}

/**
 * Maps an authorization-server error onto what the MCP client needs to do about it.
 *
 * `access_denied` is the organization's AI switch being off: nothing the user can fix by
 * reconnecting, so it must not trigger a reconnect loop. Everything else at 400 is a statement
 * about the token itself, including `invalid_target`, which means the token was minted for
 * something other than this server.
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
