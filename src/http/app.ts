import { randomUUID, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { credentialFingerprint, oauthCredential, type GremlinCredential } from '../auth/credential';
import {
  bearerTokenFrom,
  buildChallenge,
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_PATH,
} from '../auth/protected-resource';
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
  fingerprint: string;
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
 * The caller's address, preferring the rightmost forwarded hop.
 *
 * <p>Rightmost because a caller controls what it prepends to `X-Forwarded-For` and not what the
 * proxy in front of us appends; reading the leftmost entry would let one attacker present a fresh
 * identity per request and never reach a limit. Falls back to the socket address, then to a single
 * shared bucket, so unattributable traffic is bounded rather than exempt.
 */
function sourceKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (chain) {
    const hops = chain
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress ?? 'unattributed';
}



function sessionIdFrom(req: IncomingMessage): string | undefined {
  const header = req.headers[SESSION_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/** Constant-time compare, so a fingerprint cannot be recovered by timing the mismatch. */
function fingerprintMatches(a: string, b: string): boolean {
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

export interface McpHttpApp {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  reapIdleSessions: () => void;
  closeAll: () => Promise<void>;
  sessionCount: () => number;
}

export function createMcpHttpApp(
  { createServerForCredential = createGremlinMcpServer }: { createServerForCredential?: ServerFactory } = {},
): McpHttpApp {
  const sessions = new Map<string, Session>();

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
    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        void session.transport.close();
      }
    }
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearerTokenFrom(req.headers.authorization);

    // No credential at all. This is the discovery bootstrap: Claude's first request looks exactly
    // like this, and the challenge below is the only thing that tells it an authorization server
    // exists.
    if (!token) {
      sendUnauthorized(res);
      return;
    }

    const credential = oauthCredential(token);
    const fingerprint = credentialFingerprint(credential);
    const sessionId = sessionIdFrom(req);

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
      if (!fingerprintMatches(existing.fingerprint, fingerprint)) {
        // Right session id, different credential. Either a stolen id or a client that refreshed
        // into a token belonging to somebody else; in both cases continuing would let this caller
        // act as the session's owner.
        sendUnauthorized(res, {
          error: 'invalid_token',
          description: 'Session belongs to a different credential',
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
        sessions.set(id, { transport, fingerprint, lastSeen: Date.now() });
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
