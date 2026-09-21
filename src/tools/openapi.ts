import z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertRequiredParams, GremlinApi, GremlinApiError, wrapGremlinError } from '../client/gremlin';
import { getSpec, searchSpec, OpenApiSpec } from '../openapi/spec-loader';

export function createSearchGremlinApiTool(_api: GremlinApi) {
  return {
    name: 'search_gremlin_api',
    title: 'Search Gremlin API',
    description: [
      'Search the Gremlin OpenAPI spec to discover available API endpoints.',
      'Returns matching endpoints with their method, path, parameters, and request body schema.',
      'Each result also includes a `responses` summary (status code → response content-types,',
      'e.g. {"202": {"content": {"text/plain": {}}}}) so you know in advance whether',
      'the API tools will return JSON or plain text for that endpoint.',
      'Use this before read_gremlin_api, create_gremlin_api, update_gremlin_api or',
      'delete_gremlin_api to find the correct path and parameter names.',
      'Paths use OpenAPI template syntax (e.g. /reliability-tests/{reliabilityTestId}/runs) —',
      'pass them directly to the API tools.',
    ].join(' '),
    annotations: { readOnlyHint: true },
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

      assertRequiredParams(Boolean(query?.trim()), 'query must be a non-empty string');

      let spec;
      try {
        spec = await getSpec();
      } catch (err) {
        throw wrapGremlinError('Failed to load Gremlin OpenAPI spec', err);
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
export function getRunPrivileges(spec: OpenApiSpec, specPath: string, method: string): string[] {
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

/** HTTP methods that only read. RFC 9110 calls these safe. */
export type SafeMethod = 'GET';

/** HTTP methods that change state, grouped by the kind of change they make. */
export type UnsafeMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type AnyMethod = SafeMethod | UnsafeMethod;

interface ApiCallArgs {
  path: string;
  method?: AnyMethod;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: Record<string, unknown>;
  confirmExecution?: boolean;
}

/**
 * The parts of the request surface every API tool shares.
 *
 * <p>`method` is deliberately absent: each tool either fixes it or offers a choice within one
 * safety class. Anthropic's directory review rejects a single tool that accepts both safe and
 * unsafe methods, and the reason holds independently of the review -- a tool's annotations tell
 * Claude whether a call needs confirmation, and one tool spanning GET and DELETE cannot carry an
 * honest annotation for both.
 */
const SHARED_SCHEMA = {
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
};

const RESPONSE_CONTRACT = [
  'On success (2xx), returns { status, contentType, isJsonBody, body }.',
  '`body` is the parsed JSON when isJsonBody is true; otherwise it is the raw response text',
  '(e.g. a bare-text ID). isJsonBody: false on a 2xx response is a normal, successful result — not an error,',
  'even when the response is labeled JSON but fails to parse; the raw text is returned instead.',
  'Only a 4xx/5xx response or a network-level failure calling the API is reported as a tool error, not in this envelope.',
].join(' ');

/**
 * Escape hatch for clients that cannot show an elicitation prompt.
 *
 * <p>Worth being clear about what this is not: it is an ordinary tool parameter, so the calling
 * model sets it itself and nothing routes it past a person. It is not user consent and must not be
 * described or relied on as though it were.
 *
 * <p>What actually asks a human is the tool's own `destructiveHint`, which makes the MCP client
 * confirm the call before it is ever dispatched. The elicitation below is a second, more specific
 * prompt for endpoints that start experiments; this field skips that second prompt for clients
 * without elicitation support, on a call the client has already confirmed.
 */
const CONFIRM_EXECUTION_FIELD = z
  .boolean()
  .optional()
  .describe(
    'Set to true only when your MCP client does not support interactive prompts (elicitation). ' +
      'This skips the extra confirmation for endpoints that can trigger live experiments; it is ' +
      'not a substitute for asking the user. Verify the endpoint and parameters first.',
  );

/**
 * The single implementation behind every API tool.
 *
 * <p>Splitting the tools is a change to the surface Claude sees, not to what happens when a call
 * runs: path templating, the {@code *_RUN} privilege check, elicitation and error wrapping are
 * identical whichever tool was invoked. Four copies of this would be four places for that
 * behaviour to drift, and the privilege check is the last thing that should drift.
 */
function callGremlinApi(
  api: GremlinApi,
  mcpServer: McpServer,
  method: AnyMethod,
  args: ApiCallArgs,
) {
  return (async () => {
    const { path: rawPath, pathParams, queryParams, body, confirmExecution } = args;

    // Normalize the spec path: always leading slash, no substitutions yet.
    const specPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

    // Check whether this endpoint requires a *_RUN permission.
    //
    // The spec fetch used to be purely best-effort: on failure runPrivileges stayed empty and no
    // prompt happened at all, so a transient spec outage silently removed the confirmation from
    // every endpoint that needed it. Unknown is now treated as dangerous for anything that is not
    // a GET -- we cannot tell whether the endpoint starts an experiment, and guessing "harmless"
    // is the wrong direction for a call that might.
    let runPrivileges: string[] = [];
    let privilegesUnknown = false;
    try {
      const spec = await getSpec();
      runPrivileges = getRunPrivileges(spec, specPath, method);
    } catch (err) {
      privilegesUnknown = method !== 'GET';
      console.error(
        `Warning: could not load spec to check permissions for ${method} ${specPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if ((runPrivileges.length > 0 || privilegesUnknown) && !confirmExecution) {
      let result;
      try {
        result = await mcpServer.server.elicitInput({
          message: privilegesUnknown
            ? `The Gremlin API spec could not be loaded, so it is not known whether this ` +
              `endpoint triggers a live chaos experiment. Do you want to proceed?\n\n` +
              `Endpoint: ${method} ${specPath}`
            : `This endpoint requires the ${runPrivileges.join(', ')} privilege(s), which can ` +
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fixable by the caller: pass confirmExecution: true instead of relying on elicitation.
        throw new GremlinApiError(
          `Cannot confirm execution of ${method} ${specPath}: the MCP client does not support ` +
            `interactive prompts (elicitation). ` +
            (privilegesUnknown
              ? `The API spec could not be loaded, so whether this endpoint triggers a live ` +
                `experiment is unknown. `
              : `This endpoint requires the ${runPrivileges.join(', ')} privilege(s). `) +
            `Pass confirmExecution: true to bypass the prompt and proceed directly. (${msg})`,
          { isInputError: true },
        );
      }

      if (result.action !== 'accept' || !result.content?.['confirmed']) {
        // A deliberate decline, not a bad argument — retrying with different
        // arguments won't change the human's decision.
        throw new GremlinApiError(
          `Execution cancelled (action: ${result.action}). The request was not sent to Gremlin.`,
          { isInputError: false },
        );
      }
    }

    // Strip leading slash — GremlinApi base URL already includes the version
    // prefix and buildUrl constructs `${baseUrl}/${path}`, so no leading slash wanted.
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
    assertRequiredParams(
      !unresolved,
      `Path still contains unresolved template variables: ${unresolved?.join(', ')}. ` +
        `Provide values for these in pathParams.`,
    );

    try {
      return await api.execute(method, resolvedPath, queryParams, body);
    } catch (err) {
      throw wrapGremlinError('Gremlin API call failed', err);
    }
  })();
}

/**
 * GET only.
 *
 * <p>The one API tool that can carry {@code readOnlyHint}, which is what lets Claude run it
 * without confirming every call. It earns that by being unable to express a state change at all:
 * the method is fixed here rather than passed in.
 */
export function createReadGremlinApiTool(api: GremlinApi, mcpServer: McpServer) {
  return {
    name: 'read_gremlin_api',
    title: 'Read Gremlin API',
    description: [
      'Read any Gremlin API endpoint with a GET request.',
      'Use search_gremlin_api first to discover the correct path and parameter names.',
      'The path should use OpenAPI template syntax for path parameters',
      '(e.g. /reliability-tests/{reliabilityTestId}/runs) — they are substituted automatically.',
      'This tool cannot change anything; use create_gremlin_api, update_gremlin_api or',
      'delete_gremlin_api for writes.',
      RESPONSE_CONTRACT,
    ].join(' '),
    schema: { ...SHARED_SCHEMA },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (args: ApiCallArgs) => callGremlinApi(api, mcpServer, 'GET', args),
  };
}

/**
 * POST.
 *
 * <p>Marked destructive, which looks wrong for a tool that creates things and is not. In Gremlin a
 * POST is how a chaos experiment starts, so the additive/destructive distinction that annotation
 * usually draws does not survive contact with this API: the call adds a record and takes down a
 * production dependency. Claude prompting before every one of these is the correct behaviour.
 *
 * <p>The {@code *_RUN} privilege elicitation still runs underneath and is the finer control. It is
 * not a substitute for this annotation, because the spec fetch behind it is best-effort.
 */
export function createCreateGremlinApiTool(api: GremlinApi, mcpServer: McpServer) {
  return {
    name: 'create_gremlin_api',
    title: 'Create Gremlin Resource or Run Experiment',
    description: [
      'Send a POST request to a Gremlin API endpoint, to create a resource or start a run.',
      'Use search_gremlin_api first to discover the correct path, parameter names and body schema.',
      'WARNING: This tool can trigger real chaos experiments against live systems.',
      'Verify the endpoint and parameters carefully.',
      RESPONSE_CONTRACT,
    ].join(' '),
    schema: {
      ...SHARED_SCHEMA,
      body: z.record(z.unknown()).optional().describe('Request body for the POST request.'),
      confirmExecution: CONFIRM_EXECUTION_FIELD,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: (args: ApiCallArgs) => callGremlinApi(api, mcpServer, 'POST', args),
  };
}

/**
 * PUT and PATCH.
 *
 * <p>Both modify something that already exists, which is the definition Anthropic gives for
 * {@code destructiveHint}. They are kept in one tool rather than split further because the choice
 * between them is a property of the endpoint, not a different intent on the caller's part -- and
 * both are equally consequential, so the annotation is the same either way.
 */
export function createUpdateGremlinApiTool(api: GremlinApi, mcpServer: McpServer) {
  return {
    name: 'update_gremlin_api',
    title: 'Update Gremlin Resource',
    description: [
      'Modify an existing Gremlin resource with a PUT or PATCH request.',
      'Use PUT to replace a resource and PATCH to change part of one; search_gremlin_api shows',
      'which an endpoint accepts.',
      'Use search_gremlin_api first to discover the correct path, parameter names and body schema.',
      RESPONSE_CONTRACT,
    ].join(' '),
    schema: {
      ...SHARED_SCHEMA,
      method: z
        .enum(['PUT', 'PATCH'])
        .describe('PUT to replace the resource, PATCH to change part of it.'),
      body: z.record(z.unknown()).optional().describe('Request body for the update.'),
      confirmExecution: CONFIRM_EXECUTION_FIELD,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: (args: ApiCallArgs & { method: 'PUT' | 'PATCH' }) =>
      callGremlinApi(api, mcpServer, args.method, args),
  };
}

/** DELETE. Separated by action type, as the directory review criteria ask for. */
export function createDeleteGremlinApiTool(api: GremlinApi, mcpServer: McpServer) {
  return {
    name: 'delete_gremlin_api',
    title: 'Delete Gremlin Resource',
    description: [
      'Delete a Gremlin resource, or halt a running experiment, with a DELETE request.',
      'Use search_gremlin_api first to discover the correct path and parameter names.',
      RESPONSE_CONTRACT,
    ].join(' '),
    schema: {
      ...SHARED_SCHEMA,
      confirmExecution: CONFIRM_EXECUTION_FIELD,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: (args: ApiCallArgs) => callGremlinApi(api, mcpServer, 'DELETE', args),
  };
}
