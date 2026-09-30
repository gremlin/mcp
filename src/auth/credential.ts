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

import { AsyncLocalStorage } from 'node:async_hooks';
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

/** The one credential kind that resolves to an exchanged token; see {@link exchangedOnly}. */
type Delegated = Extract<GremlinCredential, { kind: 'delegated' }>;

/**
 * A credential whose underlying delegation can be replaced while its holder keeps using it.
 *
 * A hosted session outlives the access token that opened it: Claude refreshes about hourly, and
 * the session is bound to the user rather than to the token precisely so that rotation does not
 * tear down the server, API client and response cache behind it. But the server is built once,
 * from whatever credential was presented at `initialize`, and holds it for the session's life --
 * so without something like this the session keeps exercising the *first* token's authority
 * forever after. Two consequences, both bad: a reissue that narrows a user's access is not
 * honoured until the session ends, and once the original token can no longer be exchanged every
 * tool call fails while the transport still answers 200, with nothing telling the client to
 * reinitialize.
 *
 * <p>So the server is handed a credential that reads through to a slot, and the request path
 * serves each request with the credential that request authenticated with. The credential the
 * server holds never changes identity; the authority it resolves always belongs to the token on
 * the request being served.
 *
 * <p>Scoped to the request, not assigned to the session, and that distinction is the whole point.
 * A session can have two requests in flight while the client rotates -- one started before the
 * refresh, one after. With a single assignable field, whichever arrived last wins for both, so a
 * request that presented a freshly narrowed token could execute with the older, wider one. Scoping
 * makes each request resolve its own.
 *
 * <p>Swapping the *credential*, not the token inside it, is deliberate: each inner credential is
 * still immutable and still owns its own exchange, so a validation outcome remains safe to cache
 * and to share between sessions.
 */
export interface CredentialSlot {
  /**
   * The credential to hand to anything that authenticates. Stable for the slot's life, and always
   * resolves from the credential of the request currently being served.
   */
  readonly credential: GremlinCredential;
  /**
   * Serves `run` with `next` as the session's credential.
   *
   * <p>Scoped to the call rather than assigned, so that two requests in flight on one session
   * cannot take each other's authority; see {@link credentialSlot}.
   */
  during<T>(next: GremlinCredential, run: () => T): T;
}

export function credentialSlot(initial: GremlinCredential): CredentialSlot {
  // Its own storage per slot, never a module-global one. A single shared context read by every
  // session's credential would mean any handler that ever ran inside another session's scope
  // resolved that session's token -- a cross-user leak, and a far worse defect than the one this
  // exists to fix. Per slot, the worst a mistake can do is fall back to this session's own last
  // credential.
  const active = new AsyncLocalStorage<Delegated>();

  // The fallback, for work with no request scope around it: anything the server initiates itself
  // on a standing stream rather than in reply to a POST. The most recent credential is the best
  // available answer there, and is what the slot alone would have given in every case.
  let latest = exchangedOnly(initial);

  const inScope = (): Delegated => active.getStore() ?? latest;

  return {
    credential: {
      kind: 'delegated',
      // Getters, so this reads the serving request's credential at the moment it is asked rather
      // than whichever one the session was built with.
      get value() {
        return inScope().value;
      },
      resolve: () => inScope().resolve(),
    },
    during<T>(next: GremlinCredential, run: () => T): T {
      const bound = exchangedOnly(next);
      latest = bound;
      return active.run(bound, run);
    },
  };
}

/**
 * Accepts only a credential that resolves to an exchanged token.
 *
 * <p>This is design invariant 13 -- the MCP server never sends a client-supplied token upstream --
 * enforced where the doc says it is enforced: the one API client is constructed only from an
 * exchanged token. The slot is now that construction point, so the check belongs here.
 *
 * <p>It has to be the kind and not merely "not an API key". The wrapper above presents whatever it
 * holds as `Bearer`, and `oauth` is the kind whose `value` *is* the client's own token (D31) --
 * so accepting one would forward it upstream while reporting `kind: 'delegated'` to every later
 * reader, which is worse than forwarding it plainly. An `apiKey` is refused by the same check, and
 * would anyway be wrong twice over: a static key on the hosted transport, under the wrong scheme.
 */
function exchangedOnly(credential: GremlinCredential): Delegated {
  if (credential.kind !== 'delegated') {
    throw new Error(
      `A session credential must be delegated, not ${credential.kind}: the token sent upstream is always an exchanged one`,
    );
  }
  return credential;
}
