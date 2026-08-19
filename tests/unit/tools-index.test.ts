import { describe, it, expect, vi } from 'vitest';
import { registerTools } from '../../src/tools/index';
import { GremlinApiError } from '../../src/client/gremlin';
import type { OpenApiSpec } from '../../src/openapi/spec-loader';

// vi.mock is hoisted above imports; MOCK_SPEC must be defined via vi.hoisted
// to be available inside the factory at hoist time (same pattern as
// privileges.test.ts).
const { MOCK_SPEC } = vi.hoisted(() => {
  const MOCK_SPEC: OpenApiSpec = { paths: {} };
  return { MOCK_SPEC };
});

vi.mock('../../src/openapi/spec-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/openapi/spec-loader')>();
  return {
    ...actual,
    getSpec: vi.fn().mockResolvedValue(MOCK_SPEC),
  };
});

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: { isInputError: boolean; statusCode?: number };
}

// Captures the handler registerTools actually wires up for each tool name,
// so tests can invoke the real end-to-end wrapping without a real MCP
// transport.
function makeFakeServer() {
  const handlers = new Map<string, (args: any, extra: any) => Promise<ToolResult>>();
  return {
    fake: {
      registerTool: (name: string, _config: any, handler: any) => {
        handlers.set(name, handler);
      },
      server: { elicitInput: vi.fn() },
    },
    get(name: string) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool "${name}" was not registered`);
      return handler;
    },
  };
}

describe('registerTools — error → CallToolResult wiring', () => {
  it('surfaces a validation error as isInputError: true, with no statusCode', async () => {
    const { fake, get } = makeFakeServer();
    registerTools(fake as any, {} as any);

    // list_service_risks requires serviceId and teamId; omitting them throws
    // before the API is ever called.
    const result = await get('list_service_risks')({}, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ isInputError: true });
    expect(result.content[0].text).toContain('expected { serviceId: string, teamId: string }');
  });

  it('preserves isInputError and statusCode through the tool-level catch-and-rewrap for a 5xx', async () => {
    const { fake, get } = makeFakeServer();
    const api = {
      getServiceRisks: vi.fn().mockRejectedValue(
        new GremlinApiError('HTTP 500: boom', { isInputError: false, statusCode: 500 }),
      ),
    };
    registerTools(fake as any, api as any);

    const result = await get('list_service_risks')({ serviceId: 'svc-1', teamId: 'team-1' }, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ isInputError: false, statusCode: 500 });
    // The tool's own "Failed to fetch service risks: " prefix must not have
    // swallowed the underlying message.
    expect(result.content[0].text).toContain('Failed to fetch service risks');
    expect(result.content[0].text).toContain('HTTP 500: boom');
  });

  it('preserves isInputError: true through the same wrap for a 4xx', async () => {
    const { fake, get } = makeFakeServer();
    const api = {
      getServiceRisks: vi.fn().mockRejectedValue(
        new GremlinApiError('HTTP 404: not found', { isInputError: true, statusCode: 404 }),
      ),
    };
    registerTools(fake as any, api as any);

    const result = await get('list_service_risks')({ serviceId: 'svc-1', teamId: 'team-1' }, {});

    expect(result.structuredContent).toEqual({ isInputError: true, statusCode: 404 });
  });

  it('omits structuredContent when the underlying error is not a GremlinApiError', async () => {
    const { fake, get } = makeFakeServer();
    const api = {
      getServiceRisks: vi.fn().mockRejectedValue(new Error('totally unrelated bug')),
    };
    registerTools(fake as any, api as any);

    const result = await get('list_service_risks')({ serviceId: 'svc-1', teamId: 'team-1' }, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('totally unrelated bug');
  });

  it('does not attach structuredContent to a successful result', async () => {
    const { fake, get } = makeFakeServer();
    const api = { listTeams: vi.fn().mockResolvedValue([{ identifier: 'team-1', name: 'Team One' }]) };
    registerTools(fake as any, api as any);

    const result = await get('list_teams')({}, {});

    expect(result.isError).toBeUndefined();
    expect((result as any).structuredContent).toBeUndefined();
  });
});
