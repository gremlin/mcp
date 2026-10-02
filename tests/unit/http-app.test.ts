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

import {
  authorizationHeader,
  credentialFingerprint,
  delegatedCredential,
  oauthCredential,
} from '../../src/auth/credential';
import type { GremlinCredential } from '../../src/auth/credential';
import { createGremlinMcpServer } from '../../src/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
 * The credential is delegated, as the real validator's always is: it is the only kind a session
 * accepts, because the token that goes upstream is always an exchanged one (design invariant 13).
 * `resolve` returns a stand-in for the exchanged token rather than calling an authorization
 * server -- no request in these tests reaches either upstream.
 */
function ok(subject: string): ValidationOutcome {
  return {
    status: 'ok',
    identity: { subject },
    credential: delegatedCredential(`client-token-for-${subject}`, async () => `exchanged-for-${subject}`),
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

/** An MCP initialize arriving from `address`, as the load balancer in front of us reports it. */
function fromSource(origin: string, address: string, token: string) {
  return fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'X-Forwarded-For': address,
    },
    body: JSON.stringify(INITIALIZE),
  });
}


/**
 * A server whose one tool reports the `Authorization` header its credential actually resolves to.
 *
 * <p>Yields a few times first, the way a real tool does while its upstream call is in flight --
 * which is exactly the window in which another request on the same session can arrive.
 */
function credentialReportingServer(credential: GremlinCredential): McpServer {
  const server = new McpServer({ name: 'probe', version: '1' });
  server.registerTool(
    'whoami',
    { title: 'whoami', description: 'Reports the resolved credential', inputSchema: {} },
    async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      return { content: [{ type: 'text' as const, text: await authorizationHeader(credential) }] };
    },
  );
  return server;
}

/** The JSON-RPC payload of a response, which the SDK may send as JSON or as a single SSE event. */
async function rpcBody(response: Response): Promise<any> {
  const text = await response.text();
  const event = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(event ? event.slice(5).trim() : text);
}

const callWhoami = (id: number) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} },
});

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
      // away from another. Asserted on the header each one actually presents upstream rather than
      // on its shape: the server is handed a slot-backed credential so that rotation can be
      // reflected later, and what matters is whose authority it resolves to, not how it is
      // wrapped. The exact values come from the stub validator.
      expect(await Promise.all(credentials.map(authorizationHeader))).toEqual([
        `Bearer exchanged-for-subject-for-${TOKEN_A}`,
        `Bearer exchanged-for-subject-for-${TOKEN_B}`,
      ]);
      // Distinct instances, not one memoised server handed to both.
      expect(factory.mock.results[0].value).not.toBe(factory.mock.results[1].value);
    });


    it('serves each in-flight request with the credential that request authenticated with', async () => {
      // One session, two requests overlapping while the client rotates: one began before the
      // refresh, one after. Both belong to the same user, so both are entitled to the session --
      // but they are not entitled to each other's authority. Holding the credential on the session
      // lets whichever arrived last win for both, so the request presenting a freshly narrowed
      // token executes with the older, wider one. Asserted end to end because the scoping has to
      // survive the SDK's own dispatch to reach the tool handler.
      harness = await startApp(credentialReportingServer, async (accessToken) => ({
        status: 'ok',
        identity: { subject: 'company-1:user-1' },
        credential: delegatedCredential(accessToken, async () => `exchanged<${accessToken}>`),
      }));

      const initialized = await mcpRequest(harness.origin, { token: 'gremlin_oat_before' });
      const sessionId = initialized.headers.get('mcp-session-id')!;

      const [before, after] = await Promise.all([
        mcpRequest(harness.origin, {
          token: 'gremlin_oat_before',
          sessionId,
          body: callWhoami(2),
        }).then(rpcBody),
        mcpRequest(harness.origin, {
          token: 'gremlin_oat_after',
          sessionId,
          body: callWhoami(3),
        }).then(rpcBody),
      ]);

      expect(before.result.content[0].text).toBe('Bearer exchanged<gremlin_oat_before>');
      expect(after.result.content[0].text).toBe('Bearer exchanged<gremlin_oat_after>');
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
        credential: delegatedCredential(accessToken, async () => `exchanged-for-${accessToken}`),
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
      // Captured so the assertion can be about the authority the session exercises, not just the
      // status code. A 200 on its own passed even when the server was still authenticating with
      // the token that opened the session, because `tools/list` never reaches the Gremlin API.
      const built: GremlinCredential[] = [];
      harness = await startApp(
        (credential) => {
          built.push(credential);
          return createGremlinMcpServer(credential);
        },
        // Each token exchanges to its own upstream credential, as the real validator does.
        async (accessToken) => ({
          status: 'ok',
          identity: { subject: 'company-1:user-1' },
          credential: delegatedCredential(accessToken, async () => `exchanged-for-${accessToken}`),
        }),
      );

      const initialized = await mcpRequest(harness.origin, { token: 'gremlin_oat_before_refresh' });
      const sessionId = initialized.headers.get('mcp-session-id')!;

      expect(built).toHaveLength(1);
      expect(await authorizationHeader(built[0])).toBe('Bearer exchanged-for-gremlin_oat_before_refresh');

      const afterRefresh = await mcpRequest(harness.origin, {
        // A different token value for the same user, which is exactly what a refresh produces.
        token: 'gremlin_oat_after_refresh',
        sessionId,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });

      expect(afterRefresh.status).toBe(200);
      expect(harness.app.sessionCount()).toBe(1);

      // The session survived rotation without being rebuilt...
      expect(built).toHaveLength(1);
      // ...and the one server it kept now authenticates upstream with the token the caller is
      // currently presenting, rather than the one that opened the session. Without this the
      // session goes on acting under the first token's authority until that token expires, at
      // which point every tool call fails while the transport still answers 200.
      expect(await authorizationHeader(built[0])).toBe('Bearer exchanged-for-gremlin_oat_after_refresh');
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

    it('caps upstream validations per source before they reach the authorization server', async () => {
      // A flood of distinct junk tokens used to cost one token exchange each, all under this
      // server's one client identity -- so one caller could spend the budget every user's exchanges
      // share. A source over its bound is refused here and the validator is never called.
      process.env.GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE = '5';
      const validate = vi.fn<CredentialValidator>(async () => ({ status: 'invalid' }));
      harness = await startApp(undefined, validate);
      const statuses: number[] = [];

      for (let i = 0; i < 12; i++) {
        const response = await fromSource(harness.origin, '203.0.113.50', `gremlin_oat_junk_${i}`);
        statuses.push(response.status);
      }

      expect(validate).toHaveBeenCalledTimes(5);
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
    });

    it("keeps one source's flood from throttling another source", async () => {
      process.env.GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE = '3';
      // Junk is rejected; the bystander's real token is accepted.
      harness = await startApp(undefined, async (token) =>
        token === TOKEN_B ? ok('bystander') : { status: 'invalid' },
      );

      for (let i = 0; i < 10; i++) {
        await fromSource(harness.origin, '203.0.113.50', `gremlin_oat_junk_${i}`);
      }
      const bystander = await fromSource(harness.origin, '203.0.113.51', TOKEN_B);

      expect(bystander.status).toBe(200);
    });

    it('never throttles a credential it has already validated', async () => {
      // Only a cache miss goes upstream, so only a miss is counted: a known user keeps working
      // even while its own source is over the bound.
      process.env.GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE = '2';
      harness = await startApp();

      expect((await fromSource(harness.origin, '203.0.113.60', TOKEN_A)).status).toBe(200);
      await fromSource(harness.origin, '203.0.113.60', 'gremlin_oat_other_1');
      expect((await fromSource(harness.origin, '203.0.113.60', 'gremlin_oat_other_2')).status).toBe(
        429,
      );
      expect((await fromSource(harness.origin, '203.0.113.60', TOKEN_A)).status).toBe(200);
    });

    it('gives a configured trusted source a larger allowance for both bounds', async () => {
      // An LLM vendor's users all arrive from a few addresses; the ordinary bound would make them
      // throttle each other. A trusted range gets its own raised bound instead.
      process.env.GREMLIN_MCP_TRUSTED_SOURCE_CIDRS = '198.51.100.0/24';
      process.env.GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE = '2';
      process.env.GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE_TRUSTED = '30';
      process.env.GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE = '2';
      process.env.GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE_TRUSTED = '30';
      harness = await startApp();
      const vendor: number[] = [];
      const other: number[] = [];

      for (let i = 0; i < 10; i++) {
        vendor.push((await fromSource(harness.origin, '198.51.100.9', `gremlin_oat_v_${i}`)).status);
        other.push((await fromSource(harness.origin, '203.0.113.70', `gremlin_oat_o_${i}`)).status);
      }

      expect(vendor.every((s) => s === 200)).toBe(true);
      expect(other.slice(2).every((s) => s === 429)).toBe(true);
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
