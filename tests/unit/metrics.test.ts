import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createMcpMetrics, meteredFetch } from '../../src/metrics';
import { collectMetrics } from './metric-reader';

const OPERATION_DURATION = 'mcp.server.operation.duration';
const KNOWN_TOOL = 'list_services';
const SPEC_BUCKETS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
const CLIENT_DURATION = 'http.client.request.duration';
const HTTP_SPEC_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const API_URL = 'https://api.gremlin.com/v1/teams/team-1?pageSize=10';

/**
 * A transport as `server.connect` leaves it: with the server's message and close handlers
 * installed, and keeping what passes through so a test can see nothing was swallowed.
 */
function connectedTransport() {
  const received: JSONRPCMessage[] = [];
  const sent: JSONRPCMessage[] = [];
  const state = {
    closed: false,
    // Replaceable, to hold a send open or make it fail.
    deliver: async (message: JSONRPCMessage) => {
      sent.push(message);
    },
  };
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: (message) => state.deliver(message),
  };
  transport.onmessage = (message) => received.push(message);
  transport.onclose = () => {
    state.closed = true;
  };
  return {
    transport,
    state,
    received,
    sent,
    request: (id: number, method: string, params: Record<string, unknown> = {}) =>
      transport.onmessage?.({ jsonrpc: '2.0', id, method, params }),
    notify: (method: string, params: Record<string, unknown>) =>
      transport.onmessage?.({ jsonrpc: '2.0', method, params }),
    result: (id: number, result: Record<string, unknown> = {}) =>
      transport.send({ jsonrpc: '2.0', id, result }),
    error: (id: number, code: number) =>
      transport.send({ jsonrpc: '2.0', id, error: { code, message: 'failed' } }),
  };
}

describe('observeOperations', () => {
  let collected: ReturnType<typeof collectMetrics>;
  let mcp: ReturnType<typeof connectedTransport>;

  beforeEach(() => {
    collected = collectMetrics();
    mcp = connectedTransport();
    createMcpMetrics('http').observeOperations(mcp.transport, (name) => name === KNOWN_TOOL);
  });

  afterEach(() => collected.stop());

  async function operations() {
    return (await collected.points(OPERATION_DURATION)).map((point) => point.attributes);
  }

  it('records each request with the semantic-convention buckets and attributes', async () => {
    mcp.request(1, 'initialize');
    await mcp.result(1, { protocolVersion: '2025-06-18' });
    mcp.request(2, 'tools/call', { name: KNOWN_TOOL });
    await mcp.result(2, { content: [] });

    const [point] = await collected.points(OPERATION_DURATION);
    expect((point.value as Histogram).buckets.boundaries).toEqual(SPEC_BUCKETS);
    expect(await operations()).toEqual([
      {
        'mcp.method.name': 'initialize',
        'mcp.protocol.version': '2025-06-18',
        'network.transport': 'tcp',
        'network.protocol.name': 'http',
      },
      {
        'mcp.method.name': 'tools/call',
        'mcp.protocol.version': '2025-06-18',
        'gen_ai.tool.name': KNOWN_TOOL,
        'gen_ai.operation.name': 'execute_tool',
        'network.transport': 'tcp',
        'network.protocol.name': 'http',
      },
    ]);
  });

  it('marks a tool result with isError as tool_error', async () => {
    mcp.request(1, 'tools/call', { name: KNOWN_TOOL });
    await mcp.result(1, { content: [], isError: true });

    expect(await operations()).toEqual([
      expect.objectContaining({ 'gen_ai.tool.name': KNOWN_TOOL, 'error.type': 'tool_error' }),
    ]);
  });

  it('records the JSON-RPC error code, and keeps unknown tool and method names out of the labels', async () => {
    mcp.request(1, 'tools/call', { name: 'not-a-tool' });
    await mcp.error(1, -32602);
    mcp.request(2, 'made/up');
    await mcp.error(2, -32601);

    expect(await operations()).toEqual([
      expect.objectContaining({
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': '_OTHER',
        'error.type': '-32602',
        'rpc.response.status_code': '-32602',
      }),
      expect.objectContaining({
        'mcp.method.name': '_OTHER',
        'error.type': '-32601',
        'rpc.response.status_code': '-32601',
      }),
    ]);
  });

  it('labels a made-up method _OTHER however its request ends', async () => {
    mcp.request(1, 'made/up/cancelled');
    mcp.notify('notifications/cancelled', { requestId: 1 });
    mcp.request(2, 'made/up/unsent');
    mcp.state.deliver = async () => {
      throw new Error('client went away');
    };
    await mcp.error(2, -32601).catch(() => {});
    mcp.request(3, 'made/up/abandoned');
    mcp.transport.onclose?.();

    const recorded = (await operations()).map((a) => [a['mcp.method.name'], a['error.type']]);
    expect(recorded).toHaveLength(3);
    expect(recorded).toEqual(
      expect.arrayContaining([
        ['_OTHER', 'cancelled'],
        ['_OTHER', 'transport_error'],
        ['_OTHER', 'session_closed'],
      ]),
    );
  });

  it('records a cancelled request once, as cancelled', async () => {
    mcp.request(1, 'tools/call', { name: KNOWN_TOOL });
    mcp.notify('notifications/cancelled', { requestId: 1 });
    await mcp.result(1, { content: [] });

    expect(await operations()).toEqual([expect.objectContaining({ 'error.type': 'cancelled' })]);
  });

  it('passes every message through untouched', async () => {
    mcp.request(1, 'tools/call', { name: KNOWN_TOOL });
    mcp.notify('notifications/initialized', {});
    await mcp.result(1, { content: [] });

    expect(mcp.received.map((m) => ('method' in m ? m.method : undefined))).toEqual([
      'tools/call',
      'notifications/initialized',
    ]);
    expect(mcp.sent).toEqual([{ jsonrpc: '2.0', id: 1, result: { content: [] } }]);
  });

  it('records requests still in flight when the session closes, once, as session_closed', async () => {
    mcp.request(1, 'tools/call', { name: KNOWN_TOOL });
    mcp.transport.onclose?.();
    await mcp.result(1, { content: [] });

    expect(await operations()).toEqual([expect.objectContaining({ 'error.type': 'session_closed' })]);
    expect(mcp.state.closed).toBe(true);
  });

  it('records a response only once it has been sent', async () => {
    let delivered = () => {};
    mcp.state.deliver = () => new Promise<void>((resolve) => (delivered = resolve));
    mcp.request(1, 'tools/call', { name: KNOWN_TOOL });
    const sending = mcp.result(1, { content: [] });

    expect(await operations()).toEqual([]);
    delivered();
    await sending;
    expect(await operations()).toEqual([expect.not.objectContaining({ 'error.type': expect.anything() })]);
  });

  it('records a response the transport failed to send as transport_error, and still fails the send', async () => {
    const failure = new Error('client went away');
    mcp.state.deliver = async () => {
      throw failure;
    };
    mcp.request(1, 'tools/call', { name: KNOWN_TOOL });

    await expect(mcp.result(1, { content: [] })).rejects.toBe(failure);
    expect(await operations()).toEqual([expect.objectContaining({ 'error.type': 'transport_error' })]);
  });
});

describe('meteredFetch', () => {
  let collected: ReturnType<typeof collectMetrics>;

  beforeEach(() => {
    collected = collectMetrics();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await collected.stop();
  });

  function respond(status: number) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status }) as Response));
  }

  function fail(error: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(error)));
  }

  async function requests() {
    return (await collected.points(CLIENT_DURATION)).map((point) => point.attributes);
  }

  it('records a request with the semantic-convention attributes, and buckets past the advised 10s', async () => {
    respond(200);

    await meteredFetch()(API_URL, { method: 'POST' });

    const [point] = await collected.points(CLIENT_DURATION);
    expect((point.value as Histogram).buckets.boundaries).toEqual([...HTTP_SPEC_BUCKETS, 15, 30, 60, 120, 300]);
    // Exactly these: no path, query or id.
    expect(await requests()).toEqual([
      {
        'http.request.method': 'POST',
        'server.address': 'api.gremlin.com',
        'server.port': 443,
        'http.response.status_code': 200,
      },
    ]);
  });

  it('labels the template when given, and an explicit port', async () => {
    respond(200);

    await meteredFetch()('http://localhost:8080/v1/oauth2/token', {}, '/v1/oauth2/token');

    expect(await requests()).toEqual([
      expect.objectContaining({
        'http.request.method': 'GET',
        'server.address': 'localhost',
        'server.port': 8080,
        'url.template': '/v1/oauth2/token',
      }),
    ]);
  });

  it('records an error status as error.type', async () => {
    respond(503);

    await meteredFetch()(API_URL);

    expect(await requests()).toEqual([
      expect.objectContaining({ 'http.response.status_code': 503, 'error.type': '503' }),
    ]);
  });

  it('records a request that got no response by its system error code, and still fails', async () => {
    // How undici reports a reset connection.
    const failure = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }),
    });
    fail(failure);

    await expect(meteredFetch()(API_URL)).rejects.toBe(failure);
    expect(await requests()).toEqual([
      {
        'http.request.method': 'GET',
        'server.address': 'api.gremlin.com',
        'server.port': 443,
        'error.type': 'ECONNRESET',
      },
    ]);
  });

  it('falls back to the error name when there is no system error code', async () => {
    fail(new DOMException('The operation timed out.', 'TimeoutError'));

    await expect(meteredFetch()(API_URL)).rejects.toThrow('timed out');
    expect(await requests()).toEqual([expect.objectContaining({ 'error.type': 'TimeoutError' })]);
  });
});
