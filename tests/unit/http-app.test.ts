import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createMcpHttpApp, type ServerFactory } from '../../src/http/app';
import { PROTECTED_RESOURCE_PATH } from '../../src/auth/protected-resource';

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

/** Stands up the app on a real socket, so the assertions cover actual HTTP rather than a mock. */
async function startApp(factory?: ServerFactory) {
  const app = createMcpHttpApp(factory ? { createServerForCredential: factory } : {});
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
      expect(credentials).toEqual([
        { kind: 'oauth', value: TOKEN_A },
        { kind: 'oauth', value: TOKEN_B },
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
