import { createServer } from 'node:http';

import { createMcpHttpApp } from './http/app';
import { getResourceIdentifier } from './auth/protected-resource';

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

// Fail at startup rather than on the first request: a resource identifier that does not match what
// the authorization server audiences tokens for would otherwise surface as an authentication
// failure with no obvious cause.
const resourceIdentifier = getResourceIdentifier();

const app = createMcpHttpApp();
const httpServer = createServer((req, res) => app.handle(req, res));

const reaper = setInterval(() => app.reapIdleSessions(), 60_000);
reaper.unref();

const port = Number(process.env.PORT ?? 8080);
httpServer.listen(port, () => {
  process.stderr.write(`Gremlin MCP server listening on :${port} as ${resourceIdentifier}\n`);
});

async function shutdown(): Promise<void> {
  clearInterval(reaper);
  await app.closeAll();
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
