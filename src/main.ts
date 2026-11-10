import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { apiKeyCredential } from './auth/credential';
import { loadOrExit, loadStdioConfig } from './config';
import { createMcpMetrics } from './metrics';
import { createGremlinMcpServer } from './server';
import { startTelemetry } from './telemetry';
import { isRegisteredTool } from './tools/index';

/**
 * The locally-run server: one process, one person, one static API key.
 *
 * <p>This is the deployment customers run themselves and the one Private Edition uses, and it is
 * deliberately left alone. The hosted, OAuth-authenticated server is a separate entrypoint
 * (`src/http.ts`) rather than a mode of this one, so that neither can quietly acquire the other's
 * authentication model.
 */
const config = loadOrExit(loadStdioConfig);
startTelemetry(config.telemetry);

const server = createGremlinMcpServer(apiKeyCredential(config.apiKey), config.serviceUrl);
const transport = new StdioServerTransport();
server.connect(transport).then(() =>
  createMcpMetrics('stdio').observeOperations(transport, isRegisteredTool),
);
