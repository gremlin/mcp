import { describe, it, expect } from 'vitest';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerTools } from '../../src/tools/index';

import type { GremlinApi } from '../../src/client/gremlin';

/**
 * Directory review criteria that are cheap to satisfy and easy to regress.
 *
 * <p>Each of these is a documented rejection reason for the Claude Connectors Directory. They are
 * asserted mechanically because the feedback loop otherwise runs through a human review weeks after
 * the mistake: a tool added without a title, or a convenience tool that takes a `method`, would
 * look perfectly fine in code review.
 */
function registeredTools() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, {} as GremlinApi);

  // The SDK keeps registered tools on a private field; reading it is the only way to inspect what
  // a client would actually be shown without standing up a transport.
  return (server as unknown as { _registeredTools: Record<string, {
    title?: string;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    inputSchema?: Record<string, unknown>;
  }> })._registeredTools;
}

describe('directory review criteria', () => {
  it('actually inspects the registered tools', () => {
    // Guard against the whole suite passing vacuously. Every assertion below reads a private SDK
    // field; if that field is ever renamed the checks would silently see an empty object and every
    // criterion would "pass" while nothing was verified.
    const tools = registeredTools();

    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(18);
    expect(tools['read_gremlin_api']).toBeDefined();
  });

  it('registers every tool with a title', () => {
    // "All tools must include a `title` and the applicable readOnlyHint or destructiveHint."
    const missing = Object.entries(registeredTools())
      .filter(([, tool]) => !tool.title?.trim())
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  it('registers every tool with a read-only or destructive hint', () => {
    const missing = Object.entries(registeredTools())
      .filter(([, tool]) => {
        const hints = tool.annotations ?? {};
        return hints.readOnlyHint !== true && hints.destructiveHint !== true;
      })
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  it('exposes no tool that accepts both safe and unsafe HTTP methods', () => {
    // "A single tool that accepts both safe HTTP methods and unsafe methods is rejected. Do not
    // ship a catch-all api_request tool with a method parameter."
    //
    // The shape that fails is a `method` input whose options span the two classes. update_gremlin_api
    // has a `method` parameter and is fine, because PUT and PATCH are both unsafe.
    const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
    const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

    const offenders = Object.entries(registeredTools())
      .map(([name, tool]) => {
        const methodField = tool.inputSchema?.['method'] as
          | { options?: unknown[]; _def?: { values?: unknown[] } }
          | undefined;
        if (!methodField) return null;

        const options = (methodField.options ??
          methodField._def?.values ??
          []) as string[];
        const spansBoth =
          options.some((o) => SAFE.has(String(o).toUpperCase())) &&
          options.some((o) => UNSAFE.has(String(o).toUpperCase()));

        return spansBoth ? name : null;
      })
      .filter((name): name is string => name !== null);

    expect(offenders).toEqual([]);
  });

  it('keeps tool names within the 64-character limit', () => {
    const tooLong = Object.keys(registeredTools()).filter((name) => name.length > 64);

    expect(tooLong).toEqual([]);
  });
});
