import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { format } from 'node:util';
import { getHeapSpaceStatistics } from 'node:v8';

import { diag, DiagLogLevel, metrics, type DiagLogger, type Meter } from '@opentelemetry/api';
import {
  diagLogLevelFromString,
  getBooleanFromEnv,
  getNumberFromEnv,
  getStringFromEnv,
  getStringListFromEnv,
} from '@opentelemetry/core';
import { OTLPMetricExporter as OTLPJsonMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPProtobufMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import { SERVER_VERSION } from './server';

export const SERVICE_NAME = 'gremlin-mcp';
const RUNTIME_METER_NAME = 'gremlin-mcp-runtime';
const EVENT_LOOP_DELAY_PERCENTILES = [50, 90, 99];
const NANOSECONDS_PER_SECOND = 1e9;

// The OpenTelemetry specification's defaults.
const DEFAULT_EXPORTER = 'otlp';
const DEFAULT_PROTOCOL = 'http/protobuf';
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LEVEL = DiagLogLevel.INFO;

/**
 * Starts exporting metrics over OTLP, beginning with Node runtime metrics.
 *
 * <p>Off unless `GREMLIN_MCP_ENABLE_TELEMETRY` is set, see docs/telemetry.md for what is supported.
 *
 * <p>Telemetry is optional, so a configuration it cannot use turns it off rather than stopping the
 * server.
 *
 * @returns a function that exports what is pending and stops; a no-op when telemetry is off
 */
export function startTelemetry(): () => Promise<void> {
  const off = async () => {};
  if (!enabled() || getBooleanFromEnv('OTEL_SDK_DISABLED')) return off;

  diag.setLogger(
    stderrLogger(),
    diagLogLevelFromString(getStringFromEnv('OTEL_LOG_LEVEL')) ?? DEFAULT_LOG_LEVEL,
  );

  const exporters = getStringListFromEnv('OTEL_METRICS_EXPORTER') ?? [DEFAULT_EXPORTER];
  for (const exporter of exporters.filter((e) => e !== 'otlp' && e !== 'none')) {
    diag.warn(`Unsupported OTEL_METRICS_EXPORTER "${exporter}"; supported values are otlp and none`);
  }
  if (!exporters.includes('otlp') || exporters.includes('none')) return off;

  try {
    const exportIntervalMillis =
      getNumberFromEnv('OTEL_METRIC_EXPORT_INTERVAL') ?? DEFAULT_EXPORT_INTERVAL_MS;
    const provider = new MeterProvider({
      resource: defaultResource()
        .merge(
          resourceFromAttributes({
            [ATTR_SERVICE_NAME]: SERVICE_NAME,
            [ATTR_SERVICE_VERSION]: SERVER_VERSION,
          }),
        )
        .merge(detectResources({ detectors: [envDetector] })),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: otlpExporter(),
          exportIntervalMillis,
          // The reader rejects a timeout longer than the interval rather than clamping it.
          exportTimeoutMillis: Math.min(
            getNumberFromEnv('OTEL_METRIC_EXPORT_TIMEOUT') ?? DEFAULT_EXPORT_TIMEOUT_MS,
            exportIntervalMillis,
          ),
        }),
      ],
    });
    metrics.setGlobalMeterProvider(provider);
    const stopRuntimeMetrics = recordRuntimeMetrics(provider.getMeter(RUNTIME_METER_NAME));
    return async () => {
      try {
        await provider.shutdown();
      } finally {
        stopRuntimeMetrics();
      }
    };
  } catch (err) {
    diag.error('Telemetry is off: its configuration could not be used', err);
    return off;
  }
}

function enabled(): boolean {
  const value = process.env.GREMLIN_MCP_ENABLE_TELEMETRY?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function otlpExporter(): PushMetricExporter {
  const protocol =
    (
      getStringFromEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL') ??
      getStringFromEnv('OTEL_EXPORTER_OTLP_PROTOCOL')
    )?.trim() ?? DEFAULT_PROTOCOL;
  if (protocol === 'http/json') return new OTLPJsonMetricExporter();
  if (protocol !== DEFAULT_PROTOCOL) {
    diag.warn(`Unsupported OTLP protocol "${protocol}"; using ${DEFAULT_PROTOCOL}`);
  }
  return new OTLPProtobufMetricExporter();
}

/** Every level goes to stderr: in the stdio server, stdout carries the MCP protocol. */
function stderrLogger(): DiagLogger {
  const at =
    (level: string) =>
    (message: string, ...args: unknown[]) => {
      process.stderr.write(`OpenTelemetry ${level}: ${format(message, ...args)}\n`);
    };
  return {
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    verbose: at('verbose'),
  };
}

/**
 * Event loop delay and utilization, and V8 heap used, under their semantic-convention names.
 *
 * <p>Read directly from `perf_hooks` and `v8`. `@opentelemetry/instrumentation-runtime-node` reports
 * the same, but its base class bundles module-patching code that fails to load in this ESM bundle.
 *
 * @returns a function that stops sampling; call it after the final export
 */
function recordRuntimeMetrics(meter: Meter): () => void {
  const delay = monitorEventLoopDelay();
  delay.enable();
  const percentiles = EVENT_LOOP_DELAY_PERCENTILES.map((p) => ({
    p,
    gauge: meter.createObservableGauge(`nodejs.eventloop.delay.p${p}`, { unit: 's' }),
  }));
  const max = meter.createObservableGauge('nodejs.eventloop.delay.max', { unit: 's' });
  // Each export covers the delay since the previous one.
  meter.addBatchObservableCallback(
    (result) => {
      if (delay.count === 0) return;
      for (const { p, gauge } of percentiles) {
        result.observe(gauge, delay.percentile(p) / NANOSECONDS_PER_SECOND);
      }
      result.observe(max, delay.max / NANOSECONDS_PER_SECOND);
      delay.reset();
    },
    [...percentiles.map(({ gauge }) => gauge), max],
  );

  let previous = performance.eventLoopUtilization();
  meter.createObservableGauge('nodejs.eventloop.utilization', { unit: '1' }).addCallback((result) => {
    const current = performance.eventLoopUtilization();
    result.observe(performance.eventLoopUtilization(current, previous).utilization);
    previous = current;
  });

  meter.createObservableUpDownCounter('v8js.memory.heap.used', { unit: 'By' }).addCallback((result) => {
    for (const space of getHeapSpaceStatistics()) {
      result.observe(space.space_used_size, { 'v8js.heap.space.name': space.space_name });
    }
  });

  return () => delay.disable();
}
