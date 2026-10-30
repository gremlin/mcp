import { metrics, type Attributes } from '@opentelemetry/api';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_NETWORK_PROTOCOL_NAME,
  ATTR_NETWORK_TRANSPORT,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  METRIC_HTTP_CLIENT_REQUEST_DURATION,
  NETWORK_TRANSPORT_VALUE_PIPE,
  NETWORK_TRANSPORT_VALUE_TCP,
} from '@opentelemetry/semantic-conventions';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ClientRequestSchema,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

const METER_NAME = 'gremlin-mcp';

const OPERATION_DURATION = 'mcp.server.operation.duration';
const SESSION_DURATION = 'mcp.server.session.duration';
const SESSIONS_ACTIVE = 'gremlin.mcp.sessions.active';
const REQUESTS_REJECTED = 'gremlin.mcp.requests.rejected';

// The MCP semantic conventions' advice for both duration histograms.
const DURATION_BUCKETS_S = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
// Sessions idle out after 30 minutes, so most outlive the advised 300s top bucket.
const SESSION_DURATION_BUCKETS_S = [...DURATION_BUCKETS_S, 600, 1800, 3600, 7200];
// The HTTP semantic conventions' advice, extended past 10s: calls to Gremlin have no timeout, so a
// slow one would otherwise be indistinguishable from a hung one.
const HTTP_CLIENT_DURATION_BUCKETS_S = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 15, 30, 60, 120, 300,
];
const HTTP_DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };
const HTTP_ERROR_STATUS = 400;

// Development-status semantic conventions, copied rather than imported from the incubating entry
// point, which can break in a minor release.
const ATTR_MCP_METHOD_NAME = 'mcp.method.name';
const ATTR_MCP_PROTOCOL_VERSION = 'mcp.protocol.version';
const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
const ATTR_RPC_RESPONSE_STATUS_CODE = 'rpc.response.status_code';
const ATTR_URL_TEMPLATE = 'url.template';
const GEN_AI_OPERATION_EXECUTE_TOOL = 'execute_tool';
const ERROR_TYPE_TOOL_ERROR = 'tool_error';
const OTHER = '_OTHER';

const ATTR_REJECTION_REASON = 'gremlin.mcp.rejection.reason';
const ATTR_SOURCE_TRUSTED = 'gremlin.mcp.source.trusted';
const ATTR_SESSION_END_REASON = 'gremlin.mcp.session.end_reason';
const ERROR_TYPE_CANCELLED = 'cancelled';
const ERROR_TYPE_SESSION_CLOSED = 'session_closed';
const ERROR_TYPE_TRANSPORT_ERROR = 'transport_error';

const METHOD_INITIALIZE = 'initialize';
const METHOD_TOOLS_CALL = 'tools/call';
const NOTIFICATION_CANCELLED = 'notifications/cancelled';

// Every request method a client may send, from the SDK's own schema. Anything else is whatever the
// client made up, so it is labelled `_OTHER` however the request ends.
const CLIENT_REQUEST_METHODS: ReadonlySet<string> = new Set(
  ClientRequestSchema.options.map((option) => option.shape.method.value),
);

const MS_PER_SECOND = 1000;

const TRANSPORT_ATTRIBUTES = {
  http: { [ATTR_NETWORK_TRANSPORT]: NETWORK_TRANSPORT_VALUE_TCP, [ATTR_NETWORK_PROTOCOL_NAME]: 'http' },
  stdio: { [ATTR_NETWORK_TRANSPORT]: NETWORK_TRANSPORT_VALUE_PIPE },
} satisfies Record<string, Attributes>;

/** Why a request to `/mcp` was refused before reaching an MCP session. */
export type RejectionReason =
  | 'origin_rejected'
  | 'no_token'
  | 'invalid_token'
  | 'forbidden'
  | 'throttled_validation'
  | 'auth_unavailable'
  | 'session_not_found'
  | 'subject_mismatch'
  | 'throttled_session'
  | 'at_capacity';

export type SessionEndReason = 'closed' | 'reaped' | 'shutdown';

export type McpMetrics = ReturnType<typeof createMcpMetrics>;

/**
 * The MCP server's metrics, on the global meter provider.
 *
 * <p>Create after telemetry has started: an instrument made before a provider is registered stays
 * a no-op. No attribute carries a user, company, session id or token.
 */
export function createMcpMetrics(transport: keyof typeof TRANSPORT_ATTRIBUTES) {
  const transportAttributes: Attributes = TRANSPORT_ATTRIBUTES[transport];
  const meter = metrics.getMeter(METER_NAME);
  const operationDuration = meter.createHistogram(OPERATION_DURATION, {
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_S },
  });
  const sessionDuration = meter.createHistogram(SESSION_DURATION, {
    unit: 's',
    advice: { explicitBucketBoundaries: SESSION_DURATION_BUCKETS_S },
  });
  const sessionsActive = meter.createUpDownCounter(SESSIONS_ACTIVE, { unit: '{session}' });
  const requestsRejected = meter.createCounter(REQUESTS_REJECTED, { unit: '{request}' });

  return {
    rejected(reason: RejectionReason, trusted: boolean): void {
      requestsRejected.add(1, { [ATTR_REJECTION_REASON]: reason, [ATTR_SOURCE_TRUSTED]: trusted });
    },

    sessionStarted(): void {
      sessionsActive.add(1);
    },

    /** @param startedAt when the session started, from `performance.now()` */
    sessionEnded(startedAt: number, reason: SessionEndReason): void {
      sessionsActive.add(-1);
      sessionDuration.record((performance.now() - startedAt) / MS_PER_SECOND, {
        ...transportAttributes,
        [ATTR_SESSION_END_REASON]: reason,
      });
    },

    /**
     * Records `mcp.server.operation.duration` for every request the transport receives, from
     * arrival until its response is sent, or until it is cancelled or its session closes.
     *
     * <p>Measured at the transport rather than in the tool handlers, because the SDK answers an
     * unknown tool or invalid arguments with a JSON-RPC error before any handler runs. Call after
     * `server.connect(transport)`, which installs the handlers wrapped here.
     *
     * @param isKnownTool whether a client-supplied tool name is registered; others become `_OTHER`
     */
    observeOperations(transport: Transport, isKnownTool: (name: string) => boolean): void {
      const pending = new Map<RequestId, { startedAt: number; method: string; tool?: string }>();
      let protocolVersion: string | undefined;

      function finish(id: RequestId, outcome: Attributes): void {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        operationDuration.record((performance.now() - request.startedAt) / MS_PER_SECOND, {
          ...transportAttributes,
          [ATTR_MCP_METHOD_NAME]: request.method,
          ...(protocolVersion && { [ATTR_MCP_PROTOCOL_VERSION]: protocolVersion }),
          ...(request.tool !== undefined && {
            [ATTR_GEN_AI_TOOL_NAME]: request.tool,
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_EXECUTE_TOOL,
          }),
          ...outcome,
        });
      }

      const receive = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if (isJSONRPCRequest(message)) {
          const name = message.params?.name;
          pending.set(message.id, {
            startedAt: performance.now(),
            method: CLIENT_REQUEST_METHODS.has(message.method) ? message.method : OTHER,
            ...(message.method === METHOD_TOOLS_CALL && {
              tool: typeof name === 'string' && isKnownTool(name) ? name : OTHER,
            }),
          });
        } else if (isJSONRPCNotification(message) && message.method === NOTIFICATION_CANCELLED) {
          // The SDK sends no response to a cancelled request.
          const id = message.params?.requestId;
          if (typeof id === 'string' || typeof id === 'number') {
            finish(id, { [ATTR_ERROR_TYPE]: ERROR_TYPE_CANCELLED });
          }
        }
        receive?.(message, extra);
      };

      /** The request a message answers and how it went; undefined when it is not a response. */
      function responseTo(message: JSONRPCMessage): { id: RequestId; outcome: Attributes } | undefined {
        if (isJSONRPCResultResponse(message)) {
          const { result } = message;
          if (pending.get(message.id)?.method === METHOD_INITIALIZE && typeof result.protocolVersion === 'string') {
            protocolVersion = result.protocolVersion;
          }
          return {
            id: message.id,
            outcome: result.isError === true ? { [ATTR_ERROR_TYPE]: ERROR_TYPE_TOOL_ERROR } : {},
          };
        }
        if (isJSONRPCErrorResponse(message) && message.id !== undefined) {
          const code = String(message.error.code);
          return {
            id: message.id,
            outcome: {
              [ATTR_ERROR_TYPE]: code,
              [ATTR_RPC_RESPONSE_STATUS_CODE]: code,
            },
          };
        }
        return undefined;
      }

      // Finished once the send settles: a client that has gone never received the response.
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        const response = responseTo(message);
        try {
          await send(message, options);
        } catch (error) {
          if (response) finish(response.id, { [ATTR_ERROR_TYPE]: ERROR_TYPE_TRANSPORT_ERROR });
          throw error;
        }
        if (response) finish(response.id, response.outcome);
      };

      // Closing a session abandons whatever it was still serving, which then never gets a response.
      const close = transport.onclose;
      transport.onclose = () => {
        for (const id of [...pending.keys()]) {
          finish(id, { [ATTR_ERROR_TYPE]: ERROR_TYPE_SESSION_CLOSED });
        }
        close?.();
      };
    },
  };
}

/** `fetch`, plus the path's low-cardinality template when the caller has one. */
export type MeteredFetch = (url: string, init?: RequestInit, template?: string) => Promise<Response>;

/**
 * `fetch` that records `http.client.request.duration` on the global meter provider, one point per
 * call (so each retry counts), timed until the response headers arrive.
 *
 * <p>Create after telemetry has started, like {@link createMcpMetrics}. No attribute carries a path,
 * query or token: pass a `template` only when it has no ids in it.
 */
export function meteredFetch(): MeteredFetch {
  const meter = metrics.getMeter(METER_NAME);
  const requestDuration = meter.createHistogram(METRIC_HTTP_CLIENT_REQUEST_DURATION, {
    unit: 's',
    advice: { explicitBucketBoundaries: HTTP_CLIENT_DURATION_BUCKETS_S },
  });

  return async (url, init = {}, template) => {
    const startedAt = performance.now();
    const { hostname, port, protocol } = new URL(url);
    function record(outcome: Attributes): void {
      requestDuration.record((performance.now() - startedAt) / MS_PER_SECOND, {
        [ATTR_HTTP_REQUEST_METHOD]: init.method ?? 'GET',
        [ATTR_SERVER_ADDRESS]: hostname,
        [ATTR_SERVER_PORT]: port ? Number(port) : HTTP_DEFAULT_PORTS[protocol],
        ...(template !== undefined && { [ATTR_URL_TEMPLATE]: template }),
        ...outcome,
      });
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      record({ [ATTR_ERROR_TYPE]: fetchErrorType(error) });
      throw error;
    }
    record({
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: response.status,
      ...(response.status >= HTTP_ERROR_STATUS && { [ATTR_ERROR_TYPE]: String(response.status) }),
    });
    return response;
  };
}

/** Why a request got no response: its system error code (`ECONNRESET`), else the error's name. */
function fetchErrorType(error: unknown): string {
  if (!(error instanceof Error)) return OTHER;
  // undici wraps the system error as the cause of a generic "fetch failed".
  const { cause } = error as { cause?: { code?: unknown } };
  return typeof cause?.code === 'string' ? cause.code : error.name;
}
