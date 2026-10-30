import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { diag, metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { SERVICE_NAME, startTelemetry } from '../../src/telemetry';
import { SERVER_VERSION } from '../../src/server';


interface Export {
  path: string | undefined;
  contentType: string | undefined;
  // Decoded only for http/json.
  resource?: Record<string, unknown>;
  metrics?: Record<string, OtlpMetric>;
}

/** The OTLP data kind each metric was exported as. */
interface OtlpMetric {
  name: string;
  gauge?: object;
  sum?: { isMonotonic?: boolean };
}

/** A stand-in OTLP/HTTP collector that keeps what it is sent. */
async function startCollector() {
  const exports: Export[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const received: Export = { path: req.url, contentType: req.headers['content-type'] };
      if (received.contentType === 'application/json') {
        const [rm] = JSON.parse(Buffer.concat(chunks).toString()).resourceMetrics;
        received.resource = Object.fromEntries(
          rm.resource.attributes.map((a: { key: string; value: object }) => [
            a.key,
            Object.values(a.value)[0],
          ]),
        );
        received.metrics = Object.fromEntries(
          rm.scopeMetrics.flatMap((s: { metrics: OtlpMetric[] }) =>
            s.metrics.map((m) => [m.name, m]),
          ),
        );
      }
      exports.push(received);
      res.writeHead(200, { 'Content-Type': received.contentType ?? 'application/json' }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    exports,
    endpoint: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('startTelemetry', () => {
  let collector: Awaited<ReturnType<typeof startCollector>>;

  beforeEach(async () => {
    // Isolate from whatever telemetry configuration the machine running the tests has.
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('OTEL_') || name === 'GREMLIN_MCP_ENABLE_TELEMETRY') vi.stubEnv(name, '');
    }
    collector = await startCollector();
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.endpoint);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    metrics.disable();
    diag.disable();
    await collector.stop();
  });

  it('does nothing unless GREMLIN_MCP_ENABLE_TELEMETRY is set, even with an endpoint', async () => {
    await startTelemetry()();

    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider);
    expect(collector.exports).toEqual([]);
  });

  it('exports the service identity and runtime metrics when enabled', async () => {
    vi.stubEnv('GREMLIN_MCP_ENABLE_TELEMETRY', '1');
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');

    const stop = startTelemetry();
    // Long enough for the event loop delay monitor to take samples.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stop();

    expect(collector.exports).toHaveLength(1);
    const [exported] = collector.exports;
    expect(exported.path).toBe('/v1/metrics');
    expect(exported.resource).toMatchObject({
      'service.name': SERVICE_NAME,
      'service.version': SERVER_VERSION,
    });
    // Instrument types follow the semantic conventions: gauges, except heap used.
    expect(exported.metrics?.['nodejs.eventloop.delay.p99']).toHaveProperty('gauge');
    expect(exported.metrics?.['nodejs.eventloop.utilization']).toHaveProperty('gauge');
    expect(exported.metrics?.['v8js.memory.heap.used']?.sum).toMatchObject({ isMonotonic: false });
  });

  it('defaults to OTLP over HTTP/protobuf', async () => {
    vi.stubEnv('GREMLIN_MCP_ENABLE_TELEMETRY', 'true');

    await startTelemetry()();

    expect(collector.exports.map((e) => e.contentType)).toEqual(['application/x-protobuf']);
  });

  it.each([
    ['OTEL_SDK_DISABLED', 'true'],
    ['OTEL_METRICS_EXPORTER', 'none'],
  ])('stays off when %s=%s', async (name, value) => {
    vi.stubEnv('GREMLIN_MCP_ENABLE_TELEMETRY', '1');
    vi.stubEnv(name, value);

    await startTelemetry()();

    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider);
    expect(collector.exports).toEqual([]);
  });

  it('lets OTEL_SERVICE_NAME override the service name', async () => {
    vi.stubEnv('GREMLIN_MCP_ENABLE_TELEMETRY', '1');
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
    vi.stubEnv('OTEL_SERVICE_NAME', 'mcp-staging');

    await startTelemetry()();

    expect(collector.exports[0].resource?.['service.name']).toBe('mcp-staging');
  });

  it('writes its own logs to stderr, never stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('GREMLIN_MCP_ENABLE_TELEMETRY', '1');
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc');
    vi.stubEnv('OTEL_LOG_LEVEL', 'debug');

    const stop = startTelemetry();
    // The stock console logger sends these two levels to stdout.
    diag.info('probe');
    diag.debug('probe');
    await stop();

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unsupported OTLP protocol "grpc"'));
    expect(stderr).toHaveBeenCalledWith('OpenTelemetry info: probe\n');
    expect(stderr).toHaveBeenCalledWith('OpenTelemetry debug: probe\n');
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining('OpenTelemetry'));
    // The unsupported protocol falls back rather than dropping the export.
    expect(collector.exports.map((e) => e.contentType)).toEqual(['application/x-protobuf']);
  });

  it('turns off instead of throwing on a configuration it cannot use', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('GREMLIN_MCP_ENABLE_TELEMETRY', '1');
    vi.stubEnv('OTEL_METRIC_EXPORT_INTERVAL', '0');

    await startTelemetry()();

    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Telemetry is off'));
  });
});
