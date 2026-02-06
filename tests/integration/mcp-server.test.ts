import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';

const SKIP = !process.env.GREMLIN_API_KEY;

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// Helper to parse the text content out of a tool call result
function parseToolResult(result: ToolResult): unknown {
  const textBlock = result.content.find(c => c.type === 'text');
  if (!textBlock?.text) return null;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return textBlock.text;
  }
}

describe.skipIf(SKIP)('MCP server integration', () => {
  let client: Client;
  let transport: StdioClientTransport;

  // Stash real IDs discovered during tests so downstream tools can use them
  let teamId: string | undefined;
  let serviceId: string | undefined;

  beforeAll(async () => {
    const serverPath = path.resolve(process.cwd(), 'build/main.mjs');

    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: {
        ...process.env as Record<string, string>,
        GREMLIN_API_KEY: process.env.GREMLIN_API_KEY!,
      },
    });

    client = new Client({ name: 'integration-test', version: '1.0.0' });
    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    await transport?.close();
  });

  // ── Protocol-level checks ──────────────────────────────────────────

  it('registers all expected tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name).sort();

    expect(names).toContain('get_current_test_suite');
    expect(names).toContain('get_pricing_report');
    expect(names).toContain('get_client_summary');
    expect(names).toContain('get_attack_summary');
    expect(names).toContain('get_recent_reliability_tests');
    expect(names).toContain('get_reliability_experiments');
    expect(names).toContain('get_reliability_report');
    expect(names).toContain('get_service_dependencies');
    expect(names).toContain('get_service_status_checks');
    expect(names).toContain('list_service_risks');
    expect(names).toContain('list_services');
    expect(names).toContain('list_teams');
  });

  it('lists resource templates', async () => {
    const result = await client.listResourceTemplates();
    expect(result.resourceTemplates.length).toBeGreaterThanOrEqual(2);

    const uris = result.resourceTemplates.map(r => r.uriTemplate);
    expect(uris).toContain('gremlin://team/{teamId}');
    expect(uris).toContain('gremlin://service/{teamId}/{serviceId}');
  });

  // ── Tool calls: no-arg tools ───────────────────────────────────────

  it('list_teams returns an array of teams', async () => {
    const result = await client.callTool({ name: 'list_teams', arguments: {} }) as ToolResult;
    expect(result.isError).toBeFalsy();

    const teams = parseToolResult(result) as Array<{ identifier: string; name: string }>;
    expect(Array.isArray(teams)).toBe(true);
    expect(teams.length).toBeGreaterThan(0);
    expect(teams[0]).toHaveProperty('identifier');
    expect(teams[0]).toHaveProperty('name');

    teamId = teams[0].identifier;
  });

  it('list_services returns an array of services', async () => {
    const result = await client.callTool({ name: 'list_services', arguments: {} }) as ToolResult;
    expect(result.isError).toBeFalsy();

    const services = parseToolResult(result) as Array<{ serviceId: string; teamId: string; name: string }>;
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBeGreaterThan(0);
    expect(services[0]).toHaveProperty('serviceId');
    expect(services[0]).toHaveProperty('teamId');

    serviceId = services[0].serviceId;
    teamId = services[0].teamId;
  });

  it('get_current_test_suite returns test suites', async () => {
    const result = await client.callTool({ name: 'get_current_test_suite', arguments: {} }) as ToolResult;
    expect(result.isError).toBeFalsy();

    const suites = parseToolResult(result);
    expect(Array.isArray(suites)).toBe(true);
  });

  // ── Tool calls: tools that need real IDs ───────────────────────────

  it('get_service_dependencies with real IDs', async () => {
    expect(teamId).toBeDefined();
    expect(serviceId).toBeDefined();

    const result = await client.callTool({
      name: 'get_service_dependencies',
      arguments: { teamId: teamId!, serviceId: serviceId! },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('get_service_status_checks with real IDs', async () => {
    expect(teamId).toBeDefined();
    expect(serviceId).toBeDefined();

    const result = await client.callTool({
      name: 'get_service_status_checks',
      arguments: { teamId: teamId!, serviceId: serviceId! },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('list_service_risks with real IDs', async () => {
    expect(teamId).toBeDefined();
    expect(serviceId).toBeDefined();

    const result = await client.callTool({
      name: 'list_service_risks',
      arguments: { teamId: teamId!, serviceId: serviceId! },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('get_reliability_report with real IDs', async () => {
    expect(teamId).toBeDefined();
    expect(serviceId).toBeDefined();

    const result = await client.callTool({
      name: 'get_reliability_report',
      arguments: { teamId: teamId!, serviceId: serviceId! },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('get_recent_reliability_tests with real teamId', async () => {
    expect(teamId).toBeDefined();

    const result = await client.callTool({
      name: 'get_recent_reliability_tests',
      arguments: { teamId: teamId!, pageSize: 2 },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('get_reliability_experiments with real IDs', async () => {
    expect(teamId).toBeDefined();
    expect(serviceId).toBeDefined();

    const result = await client.callTool({
      name: 'get_reliability_experiments',
      arguments: { teamId: teamId!, serviceId: serviceId!, limit: 2 },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
  });

  // ── Tool calls: pricing ──────────────────────────────────────────

  it('get_pricing_report returns a valid report', async () => {
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
      .toISOString().split('T')[0];

    const result = await client.callTool({
      name: 'get_pricing_report',
      arguments: { startDate, endDate },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();

    const report = parseToolResult(result) as {
      companyId: string;
      startDate: string;
      endDate: string;
      trackingPeriod: string;
      usageByTrackingPeriod: Array<Record<string, unknown>>;
    };
    expect(report).toHaveProperty('companyId');
    expect(report).toHaveProperty('startDate');
    expect(report).toHaveProperty('endDate');
    expect(report).toHaveProperty('trackingPeriod');
    expect(['Daily', 'Weekly', 'Monthly']).toContain(report.trackingPeriod);
    expect(Array.isArray(report.usageByTrackingPeriod)).toBe(true);

    if (report.usageByTrackingPeriod.length > 0) {
      const entry = report.usageByTrackingPeriod[0];
      expect(entry).toHaveProperty('start');
      expect(entry).toHaveProperty('end');
      expect(entry).toHaveProperty('maxActiveAgents');
    }
  });

  it('get_pricing_report respects trackingPeriod param', async () => {
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
      .toISOString().split('T')[0];

    const result = await client.callTool({
      name: 'get_pricing_report',
      arguments: { startDate, endDate, trackingPeriod: 'Daily' },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();

    const report = parseToolResult(result) as { trackingPeriod: string };
    expect(report.trackingPeriod).toBe('Daily');
  });

  it('get_pricing_report rejects missing dates at the schema level', async () => {
    await expect(
      client.callTool({ name: 'get_pricing_report', arguments: {} })
    ).rejects.toThrow();
  });

  // ── Tool calls: team reports ─────────────────────────────────────

  it('get_client_summary returns a response for a real team', async () => {
    expect(teamId).toBeDefined();

    const now = new Date();
    const end = now.toISOString().split('T')[0];
    const start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
      .toISOString().split('T')[0];

    const result = await client.callTool({
      name: 'get_client_summary',
      arguments: { teamId: teamId!, start, end, period: 'MONTHS' },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('get_client_summary rejects missing params at the schema level', async () => {
    await expect(
      client.callTool({ name: 'get_client_summary', arguments: {} })
    ).rejects.toThrow();
  });

  it('get_attack_summary returns a response for a real team', async () => {
    expect(teamId).toBeDefined();

    const now = new Date();
    const end = now.toISOString().split('T')[0];
    const start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
      .toISOString().split('T')[0];

    const result = await client.callTool({
      name: 'get_attack_summary',
      arguments: { teamId: teamId!, start, end, period: 'MONTHS' },
    }) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('get_attack_summary rejects missing params at the schema level', async () => {
    await expect(
      client.callTool({ name: 'get_attack_summary', arguments: {} })
    ).rejects.toThrow();
  });

  // ── Error handling ─────────────────────────────────────────────────

  it('returns isError for missing required params', async () => {
    const result = await client.callTool({
      name: 'get_service_dependencies',
      arguments: { serviceId: '', teamId: '' },
    }) as ToolResult;
    expect(result.isError).toBe(true);
  });

  // ── Resources ──────────────────────────────────────────────────────

  it('lists team resources', async () => {
    const result = await client.listResources();
    expect(result.resources.length).toBeGreaterThan(0);

    const teamResources = result.resources.filter(r => r.uri.startsWith('gremlin://team/'));
    expect(teamResources.length).toBeGreaterThan(0);
  });

  it('reads a team resource by URI', async () => {
    expect(teamId).toBeDefined();

    const result = await client.readResource({ uri: `gremlin://team/${teamId}` });
    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.contents[0].mimeType).toBe('application/json');
  });
});
