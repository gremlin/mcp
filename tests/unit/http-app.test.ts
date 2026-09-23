import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createMcpHttpApp,
  type CredentialValidator,
  type ServerFactory,
  type ValidationOutcome,
} from '../../src/http/app';
import { PROTECTED_RESOURCE_PATH } from '../../src/auth/protected-resource';

import { credentialFingerprint, oauthCredential } from '../../src/auth/credential';
import type { GremlinCredential } from '../../src/auth/credential';

const RESOURCE = 'https://mcp.gremlin.com';
const TOKEN_A = 'gremlin_oat_user_a';
const TOKEN_B = 'gremlin_oat_user_b';

const INITIALIZE = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

/**
 * A successful validation, in the shape the app expects.
 *
 * The credential handed back is an ordinary oauth one rather than a delegated one: these tests are
 * about session isolation and lifecycle, and no request reaches the Gremlin API.
 */
function ok(subject: string): ValidationOutcome {
  return {
    status: 'ok',
    identity: { subject },
    credential: oauthCredential(`token-for-${subject}`),
  };
}

/** Stands up the app on a real socket, so the assertions cover actual HTTP rather than a mock. */
async function startApp(
  factory?: ServerFactory,
  // Accepts every credential by default. The real validator calls the Gremlin API, which these
  // tests must not do -- and a rejection from it would look exactly like a bug in the code under
  // test. Rejection is exercised explicitly where that is the point.
  // Each distinct token resolves to its own subject by default, which is what the production
  // validator does for distinct users. Tests that care about rotation or sharing override it.
  validateCredential: CredentialValidator = async (accessToken) => ok(`subject-for-${accessToken}`),
) {
  const app = createMcpHttpApp({
    ...(factory ? { createServerForCredential: factory } : {}),
    validateCredential,
  });
  const server: Server = createServer((req, res) => app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    app,
    origin: `http://127.0.0.1:${port}`,
    async stop() {
      await app.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function mcpRequest(
  origin: string,
  { token, sessionId, body = INITIALIZE }: { token?: string; sessionId?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;

  return fetch(`${origin}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('MCP HTTP app', () => {
  const saved = { ...process.env };
  let harness: Awaited<ReturnType<typeof startApp>> | undefined;

  beforeEach(() => {
    process.env.GREMLIN_MCP_RESOURCE_URL = RESOURCE;
  });

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
    process.env = { ...saved };
  });

  describe('discovery bootstrap', () => {
    it('serves the metadata document without authentication', async () => {
      // Requiring a token to read the document that says how to get a token would be circular.
      harness = await startApp();

      const response = await fetch(`${harness.origin}${PROTECTED_RESOURCE_PATH}`);

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      await expect(response.json()).resolves.toMatchObject({
        authorization_servers: ['https://api.gremlin.com'],
        resource: RESOURCE,
      });
    });

    it('challenges an unauthenticated MCP request and says where to authenticate', async () => {
      // This exchange is the entire entry point to the OAuth flow: Claude's first request carries
      // no token, and this header is how it discovers the authorization server.
      harness = await startApp();

      const response = await mcpRequest(harness.origin, {});

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(
        `resource_metadata="${RESOURCE}${PROTECTED_RESOURCE_PATH}"`,
      );
    });

    it('rejects a request carrying a browser Origin', async () => {
      // The MCP transport spec requires Origin validation. Unreachable from a page in practice --
      // no CORS headers are returned and a browser will not set Authorization cross-origin -- but
      // it is a conformance item review may look for.
      harness = await startApp();

      const response = await fetch(`${harness.origin}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
          Origin: 'https://attacker.test',
        },
        body: JSON.stringify(INITIALIZE),
      });

      expect(response.status).toBe(403);
      expect(harness.app.sessionCount()).toBe(0);
    });

    it('accepts a request with no Origin, which is what a server sends', async () => {
      harness = await startApp();

      const response = await mcpRequest(harness.origin, { token: TOKEN_A });

      expect(response.status).toBe(200);
    });

    it('rejects a static API key on the hosted transport', async () => {
      harness = await startApp();

      const response = await fetch(`${harness.origin}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Key some-api-key' },
        body: JSON.stringify(INITIALIZE),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('per-user isolation', () => {
    it('builds a separate server and API client for each credential', async () => {
      // The requirement, asserted directly. Tools and resources close over a GremlinApi that holds
      // both the credential and its own response cache, and that cache is keyed on URL alone -- so
      // one shared instance would answer the second user's request with the first user's teams,
      // services and reports, for the full cache TTL, with every response looking valid.
      const credentials: GremlinCredential[] = [];
      const factory = vi.fn<ServerFactory>((credential) => {
        credentials.push(credential);
        return { connect: vi.fn().mockResolvedValue(undefined) } as never;
      });

      harness = await startApp(factory);

      await mcpRequest(harness.origin, { token: TOKEN_A });
      await mcpRequest(harness.origin, { token: TOKEN_B });

      expect(factory).toHaveBeenCalledTimes(2);
      // Two distinct credentials, which is the property that keeps one user's cached responses
      // away from another. The exact values come from the stub validator.
      expect(credentials).toEqual([
        { kind: 'oauth', value: `token-for-subject-for-${TOKEN_A}` },
        { kind: 'oauth', value: `token-for-subject-for-${TOKEN_B}` },
      ]);
      // Distinct instances, not one memoised server handed to both.
      expect(factory.mock.results[0].value).not.toBe(factory.mock.results[1].value);
    });

    it('refuses a session id presented with a different credential', async () => {
      // A session id is itself a bearer credential once established. Without this check, anyone
      // who learned one could attach to that session and act as its owner, because nothing would
      // look at the token again after initialize.
      harness = await startApp();

      const initialized = await mcpRequest(harness.origin, { token: TOKEN_A });
      const sessionId = initialized.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const hijacked = await mcpRequest(harness.origin, {
        token: TOKEN_B,
        sessionId: sessionId!,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });

      expect(hijacked.status).toBe(401);
      expect(hijacked.headers.get('www-authenticate')).toContain('error="invalid_token"');
    });

    it('lets the owning credential keep using its own session', async () => {
      harness = await startApp();

      const initialized = await mcpRequest(harness.origin, { token: TOKEN_A });
      const sessionId = initialized.headers.get('mcp-session-id')!;

      const followUp = await mcpRequest(harness.origin, {
        token: TOKEN_A,
        sessionId,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });

      expect(followUp.status).toBe(200);
    });
  });

  describe('resource exhaustion bounds', () => {
    it('refuses a session-bearing credential shape it does not issue', async () => {
      // Rejected before any session, server or API client is allocated, which is what stops an
      // attacker spending memory with arbitrary bearer values.
      harness = await startApp();

      const response = await mcpRequest(harness.origin, { token: 'not-a-gremlin-token' });

      expect(response.status).toBe(401);
      expect(harness.app.sessionCount()).toBe(0);
    });

    it('caps new sessions per source and says to retry', async () => {
      // Session setup is the expensive path and happens before the API has validated anything, so
      // the only identity available is the caller's address.
      harness = await startApp();
      const statuses: number[] = [];

      for (let i = 0; i < 25; i++) {
        const response = await mcpRequest(harness.origin, { token: `gremlin_oat_flood_${i}` });
        statuses.push(response.status);
      }

      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      const limited = statuses.indexOf(429);
      // Everything after the first refusal stays refused within the window.
      expect(statuses.slice(limited).every((s) => s === 429)).toBe(true);
    });

    it('allocates nothing for a credential the API rejects', async () => {
      // A gremlin_oat_ prefix used to be enough to get an McpServer with every tool registered, a
      // GremlinApi and a response cache, parked for thirty idle minutes -- with the token unchecked
      // until the first tool call. So junk tokens could fill the table to MAX_SESSIONS and every
      // later connection got a 503, including ones that would have authenticated.
      const factory = vi.fn<ServerFactory>(
        () => ({ connect: vi.fn().mockResolvedValue(undefined) }) as never,
      );
      harness = await startApp(factory, async () => ({ status: 'invalid' }));

      const response = await mcpRequest(harness.origin, { token: TOKEN_A });

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(factory).not.toHaveBeenCalled();
      expect(harness.app.sessionCount()).toBe(0);
    });

    it('probes once per credential rather than once per request', async () => {
      // The flood this guards against is many distinct tokens, so each must cost one upstream
      // probe and not one per request.
      const validate = vi.fn<CredentialValidator>(async () => ok('user-a'));
      harness = await startApp(undefined, validate);

      const first = await mcpRequest(harness.origin, { token: TOKEN_A });
      const sessionId = first.headers.get('mcp-session-id')!;
      await mcpRequest(harness.origin, {
        token: TOKEN_A,
        sessionId,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });
      // A second fresh connection on the same credential.
      await mcpRequest(harness.origin, { token: TOKEN_A });

      expect(validate).toHaveBeenCalledTimes(1);
    });

    it('lets a credential through when validation is inconclusive', async () => {
      // A transport failure or a 5xx is not evidence about the token. Treating it as a rejection
      // would lock every user out of a working connector during an API blip.
      harness = await startApp(undefined, async (accessToken) => ({
        status: 'ok',
        identity: { subject: credentialFingerprint(oauthCredential(accessToken)), unknown: true },
        credential: oauthCredential(accessToken),
      }));

      const response = await mcpRequest(harness.origin, { token: TOKEN_A });

      expect(response.status).toBe(200);
    });

    it('survives the hourly token refresh it is meant to outlast', async () => {
      // The defect this closes. The session was bound to sha256(token value), and Claude refreshes
      // its access token about hourly -- so an hour in, every legitimate session was rejected with
      // invalid_token and a fresh server, API client and cache allocated in its place. Binding to
      // the user keeps the security property and survives rotation, which is the point of having
      // refresh tokens at all.
      harness = await startApp(undefined, async () => ok('company-1:user-1'));

      const initialized = await mcpRequest(harness.origin, { token: 'gremlin_oat_before_refresh' });
      const sessionId = initialized.headers.get('mcp-session-id')!;

      const afterRefresh = await mcpRequest(harness.origin, {
        // A different token value for the same user, which is exactly what a refresh produces.
        token: 'gremlin_oat_after_refresh',
        sessionId,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });

      expect(afterRefresh.status).toBe(200);
      expect(harness.app.sessionCount()).toBe(1);
    });

    it('attributes a source behind a private-address hop to the real caller', async () => {
      // The rightmost hop is not necessarily the caller: depending on how this server is fronted,
      // a load balancer may append its own private address last. Taking that verbatim would
      // collapse every caller into one bucket and turn a per-source limit into a global one that
      // throttles all users together.
      harness = await startApp();
      const statuses: number[] = [];

      for (let i = 0; i < 25; i++) {
        const response = await fetch(`${harness.origin}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer gremlin_oat_distinct_${i}`,
            // Distinct real callers, each behind the same private infrastructure hop.
            'X-Forwarded-For': `203.0.113.${i}, 10.0.0.5`,
          },
          body: JSON.stringify(INITIALIZE),
        });
        statuses.push(response.status);
      }

      // Each caller has its own budget, so none is refused for another's traffic.
      expect(statuses.filter((s) => s === 429).length).toBe(0);
    });

    it('does not count requests that reuse an established session', async () => {
      // A legitimate client makes many calls against one session and must never be throttled for
      // it; only creation is bounded.
      harness = await startApp();
      const initialized = await mcpRequest(harness.origin, { token: TOKEN_A });
      const sessionId = initialized.headers.get('mcp-session-id')!;

      for (let i = 0; i < 40; i++) {
        const response = await mcpRequest(harness.origin, {
          token: TOKEN_A,
          sessionId,
          body: { jsonrpc: '2.0', id: i + 2, method: 'tools/list', params: {} },
        });
        expect(response.status).toBe(200);
      }
    });
  });

  describe('session lifecycle', () => {
    it('reports an unknown session rather than failing opaquely', async () => {
      harness = await startApp();

      const response = await mcpRequest(harness.origin, {
        token: TOKEN_A,
        sessionId: 'never-issued',
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });

      expect(response.status).toBe(404);
    });

    it('reaps sessions left idle longer than the access token lives', async () => {
      harness = await startApp();

      await mcpRequest(harness.origin, { token: TOKEN_A });
      expect(harness.app.sessionCount()).toBe(1);

      // Idle past the timeout. An abandoned session must not pin a server object for longer than
      // the credential that opened it is valid.
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      harness.app.reapIdleSessions();
      vi.useRealTimers();

      expect(harness.app.sessionCount()).toBe(0);
    });
  });
});
