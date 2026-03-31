import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRunPrivileges, createExecuteGremlinApiTool } from '../../src/tools/openapi';
import type { OpenApiSpec } from '../../src/openapi/spec-loader';

// vi.mock is hoisted above all imports, so MOCK_SPEC must be defined via
// vi.hoisted to be available inside the factory at hoist time.
const { MOCK_SPEC } = vi.hoisted(() => {
  const MOCK_SPEC: OpenApiSpec = {
    paths: {
      '/failure-flags/experiments/{id}/run': {
        post: {
          operationId: 'runExperiment',
          security: [{ ApiKeyAuth: ['EXPERIMENTS_RUN', 'EXPERIMENTS_READ'] }],
        },
      },
      '/reliability-tests/{id}/runs': {
        post: {
          operationId: 'runReliabilityTest',
          security: [{ ApiKeyAuth: ['RELIABILITY_TESTS_RUN', 'RELIABILITY_TESTS_READ'] }],
        },
      },
      '/failure-flags/experiments': {
        get: {
          operationId: 'listExperiments',
          // No security field — public or read-only
        },
        post: {
          operationId: 'createExperiment',
          security: [{ ApiKeyAuth: ['EXPERIMENTS_WRITE'] }], // write, not _RUN
        },
      },
      '/teams': {
        get: {
          operationId: 'listTeams',
          security: [{ ApiKeyAuth: ['TEAMS_READ'] }],
        },
      },
    },
  };
  return { MOCK_SPEC };
});

// Mock getSpec so the handler never hits the network.
vi.mock('../../src/openapi/spec-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/openapi/spec-loader')>();
  return {
    ...actual,
    getSpec: vi.fn().mockResolvedValue(MOCK_SPEC),
  };
});

// ── getRunPrivileges unit tests ────────────────────────────────────────────

describe('getRunPrivileges', () => {
  it('returns _RUN privileges for an endpoint that requires them', () => {
    const privs = getRunPrivileges(MOCK_SPEC, '/failure-flags/experiments/{id}/run', 'POST');
    expect(privs).toEqual(['EXPERIMENTS_RUN']);
  });

  it('does not include non-_RUN permissions in the result', () => {
    const privs = getRunPrivileges(MOCK_SPEC, '/failure-flags/experiments/{id}/run', 'POST');
    expect(privs).not.toContain('EXPERIMENTS_READ');
  });

  it('returns multiple _RUN privileges when both are present', () => {
    const spec: OpenApiSpec = {
      paths: {
        '/multi-run': {
          post: {
            security: [{ ApiKeyAuth: ['FOO_RUN', 'BAR_RUN', 'BAZ_READ'] }],
          },
        },
      },
    };
    const privs = getRunPrivileges(spec, '/multi-run', 'POST');
    expect(privs).toEqual(['FOO_RUN', 'BAR_RUN']);
  });

  it('returns [] when security field is absent', () => {
    const privs = getRunPrivileges(MOCK_SPEC, '/failure-flags/experiments', 'GET');
    expect(privs).toEqual([]);
  });

  it('returns [] when security lists only non-_RUN permissions', () => {
    const privs = getRunPrivileges(MOCK_SPEC, '/failure-flags/experiments', 'POST');
    expect(privs).toEqual([]);
  });

  it('returns [] for an unknown path', () => {
    const privs = getRunPrivileges(MOCK_SPEC, '/does-not-exist', 'POST');
    expect(privs).toEqual([]);
  });

  it('is case-sensitive for the method (lowercased internally)', () => {
    // The handler always passes the method lowercased; confirm it works
    const privs = getRunPrivileges(MOCK_SPEC, '/failure-flags/experiments/{id}/run', 'post');
    expect(privs).toEqual(['EXPERIMENTS_RUN']);
  });
});

// ── execute_gremlin_api handler — elicitation behaviour ───────────────────

function makeMockServer(elicitResponse: { action: string; content?: Record<string, unknown> }) {
  return {
    server: {
      elicitInput: vi.fn().mockResolvedValue(elicitResponse),
    },
  };
}

function makeMockApi() {
  return {
    execute: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('execute_gremlin_api handler — privilege elicitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prompts for confirmation when the endpoint requires a _RUN privilege', async () => {
    const mockServer = makeMockServer({ action: 'accept', content: { confirmed: true } });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await tool.handler({
      method: 'POST',
      path: '/failure-flags/experiments/{id}/run',
      pathParams: { id: 'exp-123' },
      queryParams: { teamId: 'team-1' },
    });

    expect(mockServer.server.elicitInput).toHaveBeenCalledOnce();
    const call = mockServer.server.elicitInput.mock.calls[0][0];
    expect(call.message).toContain('EXPERIMENTS_RUN');
    expect(call.message).toContain('POST /failure-flags/experiments/{id}/run');
  });

  it('proceeds with the API call when the user confirms', async () => {
    const mockServer = makeMockServer({ action: 'accept', content: { confirmed: true } });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await tool.handler({
      method: 'POST',
      path: '/failure-flags/experiments/{id}/run',
      pathParams: { id: 'exp-123' },
      queryParams: { teamId: 'team-1' },
    });

    expect(mockApi.execute).toHaveBeenCalledOnce();
  });

  it('throws and does NOT call the API when the user declines (confirmed: false)', async () => {
    const mockServer = makeMockServer({ action: 'accept', content: { confirmed: false } });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await expect(
      tool.handler({
        method: 'POST',
        path: '/failure-flags/experiments/{id}/run',
        pathParams: { id: 'exp-123' },
        queryParams: { teamId: 'team-1' },
      }),
    ).rejects.toThrow('Execution cancelled');

    expect(mockApi.execute).not.toHaveBeenCalled();
  });

  it('throws and does NOT call the API when the user dismisses the dialog (action: decline)', async () => {
    const mockServer = makeMockServer({ action: 'decline' });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await expect(
      tool.handler({
        method: 'POST',
        path: '/failure-flags/experiments/{id}/run',
        pathParams: { id: 'exp-123' },
        queryParams: { teamId: 'team-1' },
      }),
    ).rejects.toThrow('Execution cancelled');

    expect(mockApi.execute).not.toHaveBeenCalled();
  });

  it('skips elicitation entirely for endpoints without _RUN privileges', async () => {
    const mockServer = makeMockServer({ action: 'accept', content: { confirmed: true } });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await tool.handler({ method: 'GET', path: '/failure-flags/experiments' });

    expect(mockServer.server.elicitInput).not.toHaveBeenCalled();
    expect(mockApi.execute).toHaveBeenCalledOnce();
  });

  it('blocks the call when elicitInput throws (e.g. client does not support elicitation)', async () => {
    // Claude Desktop raises MCP error -32601 when elicitation is unsupported.
    const mockServer = {
      server: {
        elicitInput: vi.fn().mockRejectedValue(new Error('MCP error -32601: Method not found')),
      },
    };
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await expect(
      tool.handler({
        method: 'POST',
        path: '/failure-flags/experiments/{id}/run',
        pathParams: { id: 'exp-123' },
        queryParams: { teamId: 'team-1' },
      }),
    ).rejects.toThrow('MCP client does not support interactive prompts');

    expect(mockApi.execute).not.toHaveBeenCalled();
  });

  it('error message hints at confirmExecution when elicitation is unsupported', async () => {
    const mockServer = {
      server: {
        elicitInput: vi.fn().mockRejectedValue(new Error('MCP error -32601: Method not found')),
      },
    };
    const tool = createExecuteGremlinApiTool(makeMockApi() as never, mockServer as never);

    const err = await tool.handler({
      method: 'POST',
      path: '/failure-flags/experiments/{id}/run',
      pathParams: { id: 'exp-123' },
      queryParams: { teamId: 'team-1' },
    }).catch((e: unknown) => e);

    expect(err instanceof Error && err.message).toContain('confirmExecution: true');
  });

  it('skips elicitation and proceeds when confirmExecution is true', async () => {
    const mockServer = makeMockServer({ action: 'accept', content: { confirmed: true } });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await tool.handler({
      method: 'POST',
      path: '/failure-flags/experiments/{id}/run',
      pathParams: { id: 'exp-123' },
      queryParams: { teamId: 'team-1' },
      confirmExecution: true,
    });

    expect(mockServer.server.elicitInput).not.toHaveBeenCalled();
    expect(mockApi.execute).toHaveBeenCalledOnce();
  });

  it('does not skip elicitation when confirmExecution is false', async () => {
    const mockServer = makeMockServer({ action: 'accept', content: { confirmed: true } });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    await tool.handler({
      method: 'POST',
      path: '/failure-flags/experiments/{id}/run',
      pathParams: { id: 'exp-123' },
      queryParams: { teamId: 'team-1' },
      confirmExecution: false,
    });

    expect(mockServer.server.elicitInput).toHaveBeenCalledOnce();
  });

  it('skips elicitation for endpoints with only non-_RUN permissions', async () => {
    const mockServer = makeMockServer({ action: 'accept', content: { confirmed: true } });
    const mockApi = makeMockApi();
    const tool = createExecuteGremlinApiTool(mockApi as never, mockServer as never);

    // POST /failure-flags/experiments requires EXPERIMENTS_WRITE, not a _RUN permission
    await tool.handler({ method: 'POST', path: '/failure-flags/experiments', body: {} });

    expect(mockServer.server.elicitInput).not.toHaveBeenCalled();
    expect(mockApi.execute).toHaveBeenCalledOnce();
  });
});
