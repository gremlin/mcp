import z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GremlinApi } from '../client/gremlin';
import { getSpec, searchSpec, OpenApiSpec } from '../openapi/spec-loader';

export function createSearchGremlinApiTool(_api: GremlinApi) {
  return {
    name: 'search_gremlin_api',
    description: [
      'Search the Gremlin OpenAPI spec to discover available API endpoints.',
      'Returns matching endpoints with their method, path, parameters, and request body schema.',
      'Use this before execute_gremlin_api to find the correct path and parameter names.',
      'Paths use OpenAPI template syntax (e.g. /reliability-tests/{reliabilityTestId}/runs) —',
      'pass them directly to execute_gremlin_api.',
    ].join(' '),
    schema: {
      query: z.string().describe(
        'Text to search for in endpoint paths, summaries, operationIds, tags, and descriptions.',
      ),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
        .optional()
        .describe('Filter results to a specific HTTP method.'),
      tag: z
        .string()
        .optional()
        .describe('Filter results to endpoints with this tag (partial match, case-insensitive).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of results to return. Defaults to 10.'),
    },
    handler: async (args: {
      query: string;
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      tag?: string;
      limit?: number;
    }) => {
      const { query, method, tag, limit = 10 } = args;

      if (!query?.trim()) {
        throw new Error('query must be a non-empty string');
      }

      let spec;
      try {
        spec = await getSpec();
      } catch (err) {
        throw new Error(
          `Failed to load Gremlin OpenAPI spec: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const results = searchSpec(spec, query, method, tag, limit);

      if (results.length === 0) {
        return {
          message: 'No matching endpoints found. Try a broader query or different filters.',
          results: [],
        };
      }

      return {
        message: `Found ${results.length} matching endpoint(s).`,
        results,
      };
    },
  };
}

// Returns the *_RUN privileges required by the given endpoint, or [] if none.
function getRunPrivileges(spec: OpenApiSpec, specPath: string, method: string): string[] {
  const op = spec.paths[specPath]?.[method.toLowerCase()];
  if (!op?.security) return [];

  const privileges: string[] = [];
  for (const secReq of op.security as Array<Record<string, string[]>>) {
    for (const perms of Object.values(secReq)) {
      for (const perm of perms) {
        if (perm.endsWith('_RUN')) privileges.push(perm);
      }
    }
  }
  return privileges;
}

export function createExecuteGremlinApiTool(api: GremlinApi, mcpServer: McpServer) {
  return {
    name: 'execute_gremlin_api',
    description: [
      'Execute any Gremlin API endpoint directly.',
      'Use search_gremlin_api first to discover the correct path, method, and parameter names.',
      'The path should use OpenAPI template syntax for path parameters',
      '(e.g. /reliability-tests/{reliabilityTestId}/runs) — they are substituted automatically.',
      'WARNING: This tool can trigger real chaos experiments. Verify the endpoint and parameters carefully.',
    ].join(' '),
    schema: {
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
        .describe('HTTP method for the request.'),
      path: z
        .string()
        .describe(
          'API path as shown in the OpenAPI spec, e.g. /reliability-tests/{reliabilityTestId}/runs. Leading slash is optional.',
        ),
      pathParams: z
        .record(z.string())
        .optional()
        .describe(
          "Values to substitute into path template variables, e.g. { reliabilityTestId: 'abc123' }.",
        ),
      queryParams: z
        .record(z.string())
        .optional()
        .describe("Query string parameters, e.g. { teamId: 'my-team' }."),
      body: z
        .record(z.unknown())
        .optional()
        .describe('Request body for POST/PUT/PATCH requests.'),
    },
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      path: string;
      pathParams?: Record<string, string>;
      queryParams?: Record<string, string>;
      body?: Record<string, unknown>;
    }) => {
      const { method, path: rawPath, pathParams, queryParams, body } = args;

      // Normalize the spec path: always leading slash, no substitutions yet.
      const specPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

      // Check if this endpoint requires a *_RUN permission. Best-effort: if the
      // spec isn't cached yet, fetch it; if unavailable, skip the check.
      try {
        const spec = await getSpec();
        const runPrivileges = getRunPrivileges(spec, specPath, method);

        if (runPrivileges.length > 0) {
          const result = await mcpServer.server.elicitInput({
            message:
              `This endpoint requires the ${runPrivileges.join(', ')} privilege(s), which can ` +
              `trigger live chaos experiments. Do you want to proceed?\n\n` +
              `Endpoint: ${method} ${specPath}`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirmed: {
                  type: 'boolean',
                  title: 'Proceed with execution',
                  description: 'Set to true to confirm you want to run this endpoint.',
                  default: false,
                },
              },
              required: ['confirmed'],
            },
          });

          if (result.action !== 'accept' || !result.content?.['confirmed']) {
            throw new Error(
              `Execution cancelled (action: ${result.action}). The request was not sent to Gremlin.`,
            );
          }
        }
      } catch (err) {
        // Re-throw cancellations and elicitation errors as-is
        if (err instanceof Error && err.message.startsWith('Execution cancelled')) throw err;
        // For spec/network failures, log and continue — don't block all execute calls
        // just because the spec is temporarily unreachable.
        console.error(
          `Warning: could not check permissions for ${method} ${specPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Strip leading slash — GremlinApi base URL is https://api.gremlin.com/v1
      // and requestWithRetry constructs `${baseUrl}/${path}`, so no leading slash wanted.
      let resolvedPath = specPath.slice(1);

      if (pathParams) {
        for (const [key, value] of Object.entries(pathParams)) {
          resolvedPath = resolvedPath.replace(
            new RegExp(`\\{${key}\\}`, 'g'),
            encodeURIComponent(value),
          );
        }
      }

      // Catch the common mistake of forgetting pathParams
      const unresolved = resolvedPath.match(/\{[^}]+\}/g);
      if (unresolved) {
        throw new Error(
          `Path still contains unresolved template variables: ${unresolved.join(', ')}. ` +
            `Provide values for these in pathParams.`,
        );
      }

      try {
        return await api.execute(method, resolvedPath, queryParams, body);
      } catch (err) {
        throw new Error(
          `Gremlin API call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
