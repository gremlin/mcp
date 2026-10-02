import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { apiKeyCredentialFromEnvironment } from './auth/credential';
import { createGremlinMcpServer } from './server';

/**
 * The locally-run server: one process, one person, one static API key.
 *
 * <p>This is the deployment customers run themselves and the one Private Edition uses, and it is
 * deliberately left alone. The hosted, OAuth-authenticated server is a separate entrypoint
 * (`src/http.ts`) rather than a mode of this one, so that neither can quietly acquire the other's
 * authentication model.
 */
function readCredentialOrExit() {
  try {
    return apiKeyCredentialFromEnvironment();
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const server = createGremlinMcpServer(readCredentialOrExit());
const transport = new StdioServerTransport();
server.connect(transport);
