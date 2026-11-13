import { createServer } from 'node:http';

import { createMcpHttpApp, exchangeForApiCredential } from './http/app';
import { loadHostedConfig, loadOrExit } from './config';
import { createSharedStoreMetrics } from './metrics';
import { FallbackStore, MemoryStore, RedisStore, type SharedStore } from './shared-store';
import { startTelemetry } from './telemetry';
import { sealingKey } from './auth/sealed';
import { TokenExchanger } from './auth/token-exchange';

/**
 * The hosted, OAuth-authenticated server.
 *
 * <p>A separate entrypoint from `main.ts` rather than a mode of it. The locally-run server
 * authenticates one person with a static API key from the environment; this one authenticates many
 * people, each with their own OAuth access token, and must never fall back to a process-wide
 * credential. Keeping them as different programs is what makes that structural instead of a flag
 * somebody can set wrongly.
 *
 * <p>This file is deliberately only wiring. Everything worth testing lives in `http/app.ts`.
 */

// Every setting is checked before anything starts: a missing client secret or a mistyped resource
// URL would otherwise surface as authorization failures with no obvious cause.
const config = loadOrExit(loadHostedConfig);

const stopTelemetry = startTelemetry(config.telemetry);

async function connectStore(redisUrl: string | undefined): Promise<SharedStore> {
  if (!redisUrl) return new MemoryStore();
  let redis: RedisStore;
  try {
    redis = await RedisStore.connect(redisUrl);
  } catch (error) {
    // Not the URL itself: it may carry a password. A refused dual-stack connect is an AggregateError
    // with an empty message, so fall back to its code.
    const reason =
      error instanceof Error ? error.message || ('code' in error ? String(error.code) : error.name) : String(error);
    process.stderr.write(`Cannot connect to GREMLIN_MCP_REDIS_URL: ${reason}\n`);
    process.exit(1);
  }
  const storeMetrics = createSharedStoreMetrics();
  return new FallbackStore(redis, new MemoryStore(), (operation) => storeMetrics.failed(operation));
}

// Async only because connecting to Redis is; nothing is served until it has finished.
async function main(): Promise<void> {
  const store = await connectStore(config.redisUrl);

  const exchanger = new TokenExchanger(
    {
      tokenEndpoint: `${config.app.authorizationServer}/v1/oauth2/token`,
      clientId: config.oauthClientId,
      clientSecret: config.oauthClientSecret,
      targetResource: config.apiResourceUrl,
    },
    store,
  );

  const app = createMcpHttpApp({
    config: config.app,
    store,
    sealing: sealingKey(config.oauthClientSecret),
    ...exchangeForApiCredential(exchanger, config.serviceUrl),
  });
  const httpServer = createServer((req, res) => app.handle(req, res));

  if (config.keepAliveTimeoutSeconds) {
    httpServer.keepAliveTimeout = config.keepAliveTimeoutSeconds * 1000;
  }

  const reaper = setInterval(() => app.reapIdleSessions(), 60_000);
  reaper.unref();

  httpServer.listen(config.port, () => {
    process.stderr.write(
      `Gremlin MCP server listening on :${config.port} as ${config.app.resourceUrl}\n`,
    );
  });

  async function shutdown(): Promise<void> {
    clearInterval(reaper);
    // Stop accepting first, so no session can open after closeAll has run.
    const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await app.closeAll();
    await Promise.all([closed, stopTelemetry(), store.close()]);
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
