# Telemetry

The hosted server (`build/http.mjs`) exports OpenTelemetry metrics when `GREMLIN_MCP_ENABLE_TELEMETRY` is set.

## Quick start

```bash
# 1. Turn telemetry on
export GREMLIN_MCP_ENABLE_TELEMETRY=1

# 2. Point it at your collector (default: http://localhost:4318)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example.com:4318

# 3. Optional: delta temporality, which Datadog recommends
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
```

## Configuration

| Variable | Description | Default | Example values |
| --- | --- | --- | --- |
| `GREMLIN_MCP_ENABLE_TELEMETRY` | Turns telemetry on (required) | *(off)* | `1`, `true` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL; `/v1/metrics` is appended | `http://localhost:4318` | `http://collector:4318` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full metrics URL; overrides the base URL | | `http://collector:4318/v1/metrics` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP protocol. `grpc` is not supported and falls back to `http/protobuf` | `http/protobuf` | `http/protobuf`, `http/json` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers sent with each export | | `Authorization=Bearer token` |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | Metric temporality | `cumulative` | `cumulative`, `delta`, `lowmemory` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between exports | `60000` | `10000` |
| `OTEL_METRIC_EXPORT_TIMEOUT` | Milliseconds an export may take; capped at the interval | `30000` | `5000` |
| `OTEL_METRICS_EXPORTER` | Metrics exporter | `otlp` | `otlp`, `none` |
| `OTEL_SERVICE_NAME` | Service name on every metric | `gremlin-mcp` | `gremlin-mcp-staging` |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes | | `deployment.environment.name=staging` |
| `OTEL_LOG_LEVEL` | SDK log level; logs go to stderr | `info` | `debug`, `warn` |
| `OTEL_SDK_DISABLED` | Turns telemetry off, even with the flag set | `false` | `true` |

Other [OTLP exporter variables](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) also
work, such as TLS certificates, compression and timeout.

A misconfigured SDK disables telemetry with an error on stderr.

## Metrics

All carry the `service.name` and `service.version` resource attributes.

### MCP

`mcp.*` metrics follow the
[MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md).

| Metric | Type | Unit | Attributes | Description |
| --- | --- | --- | --- | --- |
| `mcp.server.operation.duration` | Histogram | `s` | `mcp.method.name`, `mcp.protocol.version`, `gen_ai.tool.name`, `gen_ai.operation.name`, `error.type`, `rpc.response.status_code`, `network.transport`, `network.protocol.name` | Time from receiving a request to sending its response |
| `mcp.server.session.duration` | Histogram | `s` | `gremlin.mcp.session.end_reason`, `network.transport`, `network.protocol.name` | How long a session lasted |
| `gremlin.mcp.sessions.active` | UpDownCounter | `{session}` | | Open sessions |
| `gremlin.mcp.requests.rejected` | Counter | `{request}` | `gremlin.mcp.rejection.reason`, `gremlin.mcp.source.trusted` | Requests refused before reaching a session |

- **`error.type`:** `tool_error` when a tool returns `isError`, the JSON-RPC error code otherwise, or `cancelled`.
- **`gremlin.mcp.session.end_reason`:** `closed`, `reaped` (idle) or `shutdown`.
- **`gremlin.mcp.rejection.reason`:** `no_token`, `invalid_token`, `subject_mismatch`, `forbidden`, `origin_rejected`, `session_not_found`, `throttled_validation`, `throttled_session`, `at_capacity` or `auth_unavailable`. `no_token` is the normal first step of OAuth discovery.
- Unknown tool and method names are recorded as `_OTHER`.

### Runtime

Under their
[semantic-convention](https://opentelemetry.io/docs/specs/semconv/runtime/nodejs-metrics/) names.

| Metric | Type | Unit | Attributes | Description |
| --- | --- | --- | --- | --- |
| `nodejs.eventloop.delay.p50` | Gauge | `s` | | Event loop delay, 50th percentile, since the previous export |
| `nodejs.eventloop.delay.p90` | Gauge | `s` | | Event loop delay, 90th percentile, since the previous export |
| `nodejs.eventloop.delay.p99` | Gauge | `s` | | Event loop delay, 99th percentile, since the previous export |
| `nodejs.eventloop.delay.max` | Gauge | `s` | | Maximum event loop delay since the previous export |
| `nodejs.eventloop.utilization` | Gauge | `1` | | Share of time the event loop was busy since the previous export, 0 to 1 |
| `v8js.memory.heap.used` | UpDownCounter | `By` | `v8js.heap.space.name` | Heap used, per V8 heap space |
