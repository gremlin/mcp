import { randomUUID, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  credentialFingerprint,
  delegatedCredential,
  oauthCredential,
  type GremlinCredential,
} from '../auth/credential';
import { TokenExchanger } from '../auth/token-exchange';
import {
  bearerTokenFrom,
  buildChallenge,
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_PATH,
} from '../auth/protected-resource';
import { GremlinApi, GremlinApiError } from '../client/gremlin';
import { createGremlinMcpServer } from '../server';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MCP_PATH = '/mcp';
const HEALTH_PATH = '/healthz';
const SESSION_HEADER = 'mcp-session-id';

/**
 * One authenticated user's live MCP session.
 *
 * <p>`fingerprint` is what makes the session belong to somebody. A session id alone is a bearer
 * credential of its own: anyone who learns one could otherwise attach to that session and act as
 * its owner, because the server would have no reason to look at the token again after the first
 * request. Binding the session to the credential that created it means a stolen session id is
 * useless without the token that opened it.
 */
interface Session {
  transport: StreamableHTTPServerTransport;
  /**
   * The user this session belongs to, from {@link CredentialIdentity}.
   *
   * <p>Not the credential. A session id alone is a bearer credential once established -- nothing
   * would look at the token again after initialize -- so attaching requires presenting a credential
   * that resolves to this same subject. Binding to the token itself instead meant an hourly refresh
   * looked exactly like a different caller.
   */
  subject: string;
  lastSeen: number;
}


/**
 * How long a session survives without traffic.
 *
 * <p>Shorter than the one-hour access token deliberately: an abandoned session should not pin a
 * server object for longer than the credential that created it is even valid.
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Hard ceiling on concurrent sessions.
 *
 * <p>Each session holds an McpServer, a GremlinApi and that client's own response cache, and is
 * built on the first request rather than on demand -- so without a ceiling, N requests bearing N
 * distinct tokens allocate N of them and nothing is released until the idle reaper runs half an
 * hour later. Refusing at the limit degrades for new connections; not refusing degrades for
 * everyone.
 */
const MAX_SESSIONS = Number(process.env.GREMLIN_MCP_MAX_SESSIONS ?? 2000);

/**
 * Per-source cap on session creation.
 *
 * <p>Session setup is the expensive path here, and it happens before the API has validated
 * anything, so the only identity available is the caller's address. Reusing an established session
 * is deliberately not counted: a legitimate client makes many requests against one session and
 * should never be throttled for it.
 */
const MAX_NEW_SESSIONS_PER_MINUTE_PER_SOURCE = Number(
  process.env.GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE ?? 20,
);

const RATE_WINDOW_MS = 60 * 1000;

/**
 * How long a validation outcome is trusted.
 *
 * <p>Short. This is not an authorization cache -- every tool call is still authorized by the API on
 * its own merits -- it only avoids re-probing on the reconnect storms a client can produce. Long
 * enough to absorb those, short enough that a revoked token stops opening new sessions promptly.
 */
const VALIDATION_TTL_MS = 60 * 1000;

/**
 * Non-globally-routable ranges, which are our own infrastructure rather than a caller.
 *
 * <p>RFC 1918 private space, CGNAT, loopback, link-local, and the IPv6 equivalents.
 */
const NON_ROUTABLE = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
];

function isRoutable(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
  return bare.length > 0 && !NON_ROUTABLE.some((range) => range.test(bare));
}

/**
 * The caller's address: the rightmost globally-routable hop in `X-Forwarded-For`.
 *
 * <p>Rightmost because a caller controls what it prepends and not what the proxy in front of us
 * appends -- reading the leftmost entry would let one attacker mint a fresh identity per request
 * and never reach a limit.
 *
 * <p>Globally-routable because the rightmost hop is not necessarily the caller. Depending on how
 * this server is fronted, a load balancer may append its own private address last, and taking that
 * verbatim would collapse every caller into one bucket -- turning a per-source limit into a global
 * one that throttles all users together. Skipping non-routable hops lands on the real egress
 * address whichever topology we end up deployed behind.
 *
 * <p>Falls back to the socket address, then to a single shared bucket, so unattributable traffic is
 * bounded rather than exempt.
 */
function sourceKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (chain) {
    const hops = chain
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (isRoutable(hops[i])) return hops[i];
    }
  }
  const socketAddress = req.socket?.remoteAddress;
  return socketAddress && isRoutable(socketAddress) ? socketAddress : 'unattributed';
}



/**
 * Rejects a browser-originated request to the MCP endpoint.
 *
 * <p>The MCP HTTP transport spec requires servers to validate `Origin`. In practice this endpoint
 * is already unreachable from a page: it returns no CORS headers, and a browser will not let script
 * set an `Authorization` header cross-origin. So this is defence in depth and a spec conformance
 * item rather than a live hole -- but it is also the kind of thing directory review looks for, and
 * the cost is one header read.
 *
 * <p>Absent `Origin` is allowed: the legitimate caller is Anthropic's server, which is not a
 * browser and sends none. Any present value is refused, because there is no origin that has
 * business driving this endpoint from a page. Configurable for local development against a browser
 * MCP client.
 */
function originIsAcceptable(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = (process.env.GREMLIN_MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const header = req.headers[SESSION_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/** Constant-time compare, so a subject cannot be recovered by timing the mismatch. */
function subjectMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Refuses a request and tells the client where to authenticate.
 *
 * <p>The body is JSON-RPC shaped because the MCP client is speaking JSON-RPC and a bare HTTP error
 * body would reach it as a parse failure rather than as an auth problem.
 */
function sendUnauthorized(
  res: ServerResponse,
  options: { error?: 'invalid_token' | 'insufficient_scope'; description?: string } = {},
): void {
  sendJson(
    res,
    401,
    {
      jsonrpc: '2.0',
      error: { code: -32001, message: options.description ?? 'Authentication required' },
      id: null,
    },
    { 'WWW-Authenticate': buildChallenge(options.error, options.description) },
  );
}

/**
 * A server builder, injectable so tests can observe isolation directly rather than inferring it.
 *
 * <p>Defaults to the real one. Overriding it is how the cross-tenant test asserts that two
 * credentials produce two distinct servers, which is the property that keeps one user's cached
 * responses away from another.
 */
export type ServerFactory = (credential: GremlinCredential) => McpServer;

/**
 * Turns a client's access token into a credential this server may use, or explains why it cannot.
 * Injectable so tests need no network.
 *
 * <p>The outcomes stay distinct because Claude reacts to each differently; see {@link
 * ExchangeFailure}. A transport failure or a 5xx is not evidence about the token, so it must never
 * be reported as `invalid`.
 */
export type CredentialValidator = (accessToken: string) => Promise<ValidationOutcome>;

export type ValidationOutcome =
  | { status: 'ok'; identity: CredentialIdentity; credential: GremlinCredential }
  | { status: 'invalid' }
  | { status: 'forbidden' }
  | { status: 'unavailable' };

/**
 * Who a credential belongs to.
 *
 * <p>`subject` is what a session is bound to. It has to be the *user*, not the credential: Claude
 * refreshes its access token about hourly, so binding to the token meant every legitimate session
 * was rejected an hour after it opened, with `invalid_token`, and a fresh server, API client and
 * cache allocated in its place. The security property is unchanged -- a leaked session id still
 * needs a credential resolving to the same user -- and it now survives rotation, which is the
 * whole point of having refresh tokens.
 *
 */
export interface CredentialIdentity {
  subject: string;
}

/**
 * Exchanges the client's token for one of our own, then asks who it belongs to.
 *
 * <p>The exchange is the validation: the authorization server refuses a token that is expired,
 * revoked, or minted elsewhere, so success is proof of all three without ever *using* the client's
 * credential.
 *
 * <p>`getSelf` runs with the *exchanged* token, only to learn the subject a session binds to.
 */
export function exchangeForApiCredential(exchanger: TokenExchanger): CredentialValidator {
  return async (accessToken) => {
    const exchanged = await exchanger.exchange(accessToken);
    if (!exchanged.ok) {
      return exchanged.reason === 'invalid'
        ? { status: 'invalid' }
        : exchanged.reason === 'forbidden'
          ? { status: 'forbidden' }
          : { status: 'unavailable' };
    }

    const credential = delegatedCredential(accessToken, async () => {
      const current = await exchanger.exchange(accessToken);
      if (!current.ok) {
        throw new GremlinApiError('Token exchange failed', {
          isInputError: false,
          statusCode: current.reason === 'invalid' ? 401 : 503,
          noRetry: current.reason !== 'unavailable',
        });
      }
      return current.accessToken;
    });

    try {
      const self = await new GremlinApi(credential).getSelf();
      return { status: 'ok', identity: { subject: `${self.company_id}:${self.user_id}` }, credential };
    } catch (error) {
      const status = error instanceof GremlinApiError ? error.statusCode : undefined;
      if (status === 401 || status === 403) {
        // The exchange succeeded but the derived token was refused -- an upstream disagreement,
        // not a verdict on the client's token, which the authorization server already accepted.
        exchanger.forget(accessToken);
        return { status: 'unavailable' };
      }
      return {
        status: 'ok',
        // The API could not say who this is, which is not evidence about the token. Binding to
        // the credential's fingerprint costs surviving a refresh, but the alternative is refusing
        // a user whose connector is working.
        identity: { subject: credentialFingerprint(credential) },
        credential,
      };
    }
  };
}

export interface McpHttpApp {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  reapIdleSessions: () => void;
  closeAll: () => Promise<void>;
  sessionCount: () => number;
}

export function createMcpHttpApp(
  {
    createServerForCredential = createGremlinMcpServer,
    validateCredential,
    reapCredentialCaches = () => {},
  }: {
    createServerForCredential?: ServerFactory;
    validateCredential: CredentialValidator;
    /** Swept on the same tick as idle sessions; see {@link TokenExchanger.reapExpired}. */
    reapCredentialCaches?: () => void;
  },
): McpHttpApp {
  const sessions = new Map<string, Session>();

  /**
   * Validation outcomes keyed by credential fingerprint, with the time they were recorded.
   *
   * <p>Per-instance for the same reason the rate counters are.
   */
  const validated = new Map<string, { outcome: ValidationOutcome; at: number }>();

  /**
   * Confirms the credential is real before anything is allocated for it.
   *
   * <p>Previously a well-formed `gremlin_oat_` prefix was enough to get an McpServer with every
   * tool registered, a GremlinApi and a response cache, parked in the session map for thirty idle
   * minutes -- and the token was not checked against the API until the first tool call. So junk
   * tokens could fill the table to MAX_SESSIONS and every subsequent connection got a 503,
   * including ones that would have authenticated. The per-source rate limit bounds the rate, not
   * the total, and a handful of addresses sustains a full table inside the idle window.
   *
   * <p>Caching negatives as well as positives is deliberate: a flood of distinct junk tokens is the
   * case worth cheapening, and each distinct token is one upstream probe rather than one per
   * request. `users/self` is the smallest authenticated call the API offers.
   *
   * <p>See {@link CredentialValidator} for why only a definite rejection counts as a failure.
   */
  async function identify(accessToken: string, fingerprint: string): Promise<ValidationOutcome> {
    const cached = validated.get(fingerprint);
    if (cached && Date.now() - cached.at < VALIDATION_TTL_MS) {
      return cached.outcome;
    }

    const outcome = await validateCredential(accessToken);
    // `unavailable` says nothing about the token, so caching it would extend an
    // authorization-server blip into a longer outage of our own.
    if (outcome.status !== 'unavailable') {
      validated.set(fingerprint, { outcome, at: Date.now() });
    }
    return outcome;
  }

  // Per-instance, deliberately. These counters bound creation of the sessions in the map above, so
  // they belong to the same lifetime: at module scope one app's traffic would throttle another's,
  // and closing an app would leave its counters behind.
  let windowStartedAt = 0;
  let newSessionsThisWindow = new Map<string, number>();

  /** True when this source has already opened its allowance of sessions in the current window. */
  function newSessionRateExceeded(source: string, now: number): boolean {
    if (now - windowStartedAt >= RATE_WINDOW_MS) {
      windowStartedAt = now;
      newSessionsThisWindow = new Map();
    }
    const used = newSessionsThisWindow.get(source) ?? 0;
    if (used >= MAX_NEW_SESSIONS_PER_MINUTE_PER_SOURCE) return true;
    newSessionsThisWindow.set(source, used + 1);
    return false;
  }

  function reapIdleSessions(): void {
    reapCredentialCaches();
    // The validation cache is swept on the same tick, so it cannot grow without bound under a
    // flood of distinct tokens -- which is the very traffic this cache exists to absorb.
    const validationCutoff = Date.now() - VALIDATION_TTL_MS;
    for (const [fingerprint, entry] of validated) {
      if (entry.at < validationCutoff) validated.delete(fingerprint);
    }

    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        void session.transport.close();
      }
    }
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originIsAcceptable(req)) {
      sendJson(res, 403, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Origin not allowed' },
        id: null,
      });
      return;
    }

    const token = bearerTokenFrom(req.headers.authorization);

    // No credential at all. This is the discovery bootstrap: Claude's first request looks exactly
    // like this, and the challenge below is the only thing that tells it an authorization server
    // exists.
    if (!token) {
      sendUnauthorized(res);
      return;
    }

    // Keyed on the client's token, so a flood of distinct junk tokens costs one exchange each
    // rather than one per request. The session binds to the subject that comes back.
    const fingerprint = credentialFingerprint(oauthCredential(token));
    const sessionId = sessionIdFrom(req);

    const outcome = await identify(token, fingerprint);
    if (outcome.status === 'invalid') {
      sendUnauthorized(res, {
        error: 'invalid_token',
        description: 'The access token is expired, revoked, or was not issued for this server',
      });
      return;
    }
    if (outcome.status === 'forbidden') {
      sendJson(res, 403, {
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message:
            'AI and MCP access is disabled for this organization by an administrator',
        },
        id: null,
      });
      return;
    }
    if (outcome.status === 'unavailable') {
      sendJson(res, 503, {
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Authorization server unavailable; retry shortly' },
        id: null,
      });
      return;
    }
    const { identity, credential } = outcome;

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        // Unknown, or reaped. Let the client start a new one rather than failing opaquely.
        sendJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }
      if (!subjectMatches(existing.subject, identity.subject)) {
        // Right session id, different user. Either a stolen id or a credential belonging to
        // somebody else; in both cases continuing would let this caller act as the session's owner.
        //
        // Compared on the subject rather than the credential, so Claude refreshing its access
        // token -- which it does about hourly -- is not mistaken for a different caller.
        sendUnauthorized(res, {
          error: 'invalid_token',
          description: 'Session belongs to a different user',
        });
        return;
      }
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    // No session id: a fresh initialize, which is the expensive path. Both bounds below run before
    // anything is allocated.
    const source = sourceKey(req);
    if (newSessionRateExceeded(source, Date.now())) {
      sendJson(
        res,
        429,
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Too many new sessions, retry shortly' },
          id: null,
        },
        { 'Retry-After': '60' },
      );
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      process.stderr.write(
        `Refusing new MCP session: at capacity (${sessions.size}/${MAX_SESSIONS})\n`,
      );
      sendJson(
        res,
        503,
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Server at capacity, retry shortly' },
          id: null,
        },
        { 'Retry-After': '30' },
      );
      return;
    }

    // Build a server and API client bound to this credential alone -- see createGremlinMcpServer
    // for why sharing either across users cannot be done safely.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, subject: identity.subject, lastSeen: Date.now() });
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createServerForCredential(credential);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Public by definition and fetched cross-origin: this document is how a client finds out how
    // to authenticate, so requiring authentication to read it would be circular.
    if (url.pathname === PROTECTED_RESOURCE_PATH) {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' });
        res.end();
        return;
      }
      sendJson(res, 200, buildProtectedResourceMetadata(), {
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      return;
    }

    if (url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { status: 'ok', sessions: sessions.size });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }

    handleMcpRequest(req, res).catch((error: unknown) => {
      process.stderr.write(
        `MCP request failed: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    });
  }

  async function closeAll(): Promise<void> {
    for (const [id, session] of sessions) {
      sessions.delete(id);
      await session.transport.close();
    }
  }

  return { handle, reapIdleSessions, closeAll, sessionCount: () => sessions.size };
}
