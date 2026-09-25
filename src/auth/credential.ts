/**
 * How a GremlinApi instance authenticates to api.gremlin.com.
 *
 * Two shapes, because there are two deployments. The locally-run server is a single process for a
 * single person holding a static API key. The hosted server handles many people at once, each with
 * their own OAuth access token, and must never let one of them act as another.
 */
export type GremlinCredential =
  | { readonly kind: 'apiKey'; readonly value: string }
  | { readonly kind: 'oauth'; readonly value: string }
  /**
   * A credential obtained by RFC 8693 exchange, for acting on a user's behalf.
   *
   * `value` is the *client's* token, kept only as the identity this delegation belongs to and as
   * the input to the next exchange; it is never sent anywhere as a credential. `resolve` returns a
   * currently-valid API token, exchanging again when the last is close to expiry.
   */
  | {
      readonly kind: 'delegated';
      readonly value: string;
      readonly resolve: () => Promise<string>;
    };

import { createHash } from 'node:crypto';

/**
 * An opaque, stable handle on whose credential this is.
 *
 * Used to key per-user state -- most importantly the response cache, which is keyed on URL alone
 * and would otherwise serve one user's teams and services to another. It is a hash, not the token
 * itself, so it can be logged and used as a Map key without becoming a way to leak a credential.
 *
 * Deliberately not the OAuth `sub` or the Gremlin user id: we do not decode the token (it is opaque
 * to us by design -- only the API can validate it), so the credential value is the only identity
 * signal available here.
 */
export function credentialFingerprint(credential: GremlinCredential): string {
  // SHA-256, because this is an authorization check and not a bucketing key.
  //
  // It was previously a 31x + charCode polynomial masked to 32 bits. That is fine for separating
  // concurrent sessions, which is what the comment here used to claim it was for -- but it is also
  // what `app.ts` compares to decide whether a caller may attach to an existing session. At 32
  // bits, anyone holding a session id needed only a credential whose fingerprint collided, a
  // 1-in-2^32 guess with no rate limit in front of it, and a collision grants the session's own
  // server, which holds the original user's token. Comparing a 32-bit value in constant time
  // guards the wrong property entirely.
  return createHash('sha256')
    .update(`${credential.kind}:${credential.value}`)
    .digest('hex');
}

/**
 * The `Authorization` header value this credential presents.
 *
 * Asynchronous because a delegated credential may have to exchange for a fresh API token first.
 * Resolved per request rather than once per session, so a revoked grant stops working within the
 * exchanged token's lifetime.
 */
export async function authorizationHeader(credential: GremlinCredential): Promise<string> {
  switch (credential.kind) {
    case 'apiKey':
      return `Key ${credential.value}`;
    case 'oauth':
      // RFC 6750. The API distinguishes an OAuth access token from an internal session token by the
      // `gremlin_oat_` prefix on the value, not by the scheme, so this stays a plain Bearer.
      return `Bearer ${credential.value}`;
    case 'delegated':
      // Note what is absent: `credential.value`. The client's token never reaches a header.
      return `Bearer ${await credential.resolve()}`;
  }
}

/**
 * The credential for the locally-run server.
 *
 * Reads the environment exactly once, at the call site that wants it, rather than deep inside the
 * request path. That matters: the hosted server must never fall back to a process-wide key, and the
 * only way to guarantee that structurally is for no code below this function to know the variable
 * exists.
 */
export function apiKeyCredentialFromEnvironment(): GremlinCredential {
  const value = process.env.GREMLIN_API_KEY;
  if (!value) {
    throw new Error('GREMLIN_API_KEY environment variable is required');
  }
  return { kind: 'apiKey', value };
}

/** The credential for one authenticated user of the hosted server. */
export function oauthCredential(accessToken: string): GremlinCredential {
  return { kind: 'oauth', value: accessToken };
}

/** Builds a {@link GremlinCredential} of kind `delegated`; see the type for what `value` holds. */
export function delegatedCredential(
  subjectToken: string,
  resolve: () => Promise<string>,
): GremlinCredential {
  return { kind: 'delegated', value: subjectToken, resolve };
}
