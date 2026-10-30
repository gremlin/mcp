import { metrics, type Attributes } from '@opentelemetry/api';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';

/** Holds metrics in memory until a test collects them. */
class InMemoryReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

export interface CollectedMetric {
  name: string;
  points: DataPoint<unknown>[];
}

/**
 * Registers a global meter provider whose metrics the test can read back.
 *
 * <p>Call before creating whatever records: instruments made before a provider is registered stay
 * no-ops.
 */
export function collectMetrics() {
  const reader = new InMemoryReader();
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  async function all(): Promise<CollectedMetric[]> {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => ({
        name: metric.descriptor.name,
        points: metric.dataPoints as DataPoint<unknown>[],
      })),
    );
  }

  return {
    all,
    /** The data points recorded for one metric; empty when it has recorded nothing. */
    async points(name: string): Promise<DataPoint<unknown>[]> {
      return (await all()).find((metric) => metric.name === name)?.points ?? [];
    },
    /** Every attribute set recorded, across all metrics. */
    async attributes(): Promise<Attributes[]> {
      return (await all()).flatMap((metric) => metric.points.map((point) => point.attributes));
    },
    async stop(): Promise<void> {
      metrics.disable();
      await provider.shutdown();
    },
  };
}
