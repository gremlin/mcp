import { createServer } from 'node:http';

import { createMcpHttpApp, exchangeForApiCredential } from './http/app';
import { loadHostedConfig, loadOrExit } from './config';
import { startTelemetry } from './telemetry';
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

const exchanger = new TokenExchanger({
  tokenEndpoint: `${config.app.authorizationServer}/v1/oauth2/token`,
  clientId: config.oauthClientId,
  clientSecret: config.oauthClientSecret,
  targetResource: config.apiResourceUrl,
});

const app = createMcpHttpApp({
  config: config.app,
  validateCredential: exchangeForApiCredential(exchanger, config.serviceUrl),
  reapCredentialCaches: () => exchanger.reapExpired(),
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
  await Promise.all([closed, stopTelemetry()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
