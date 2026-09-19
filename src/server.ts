import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { GremlinApi } from './client/gremlin';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

import type { GremlinCredential } from './auth/credential';

export const SERVER_NAME = 'Gremlin Inc Server';
export const SERVER_VERSION = '2.4.2';

/**
 * Builds a fully-registered MCP server bound to exactly one credential.
 *
 * <p>One server and one {@link GremlinApi} per credential, never shared. Both transports go
 * through here so the hosted path cannot drift into reusing an instance: the stdio server calls it
 * once for its single user, and the HTTP server calls it once per authenticated session.
 *
 * <p>The isolation is structural rather than conventional. Tools and resources close over the
 * {@link GremlinApi} passed to them at registration time, and that client holds both the
 * credential it authenticates with and its own response cache. Sharing one instance across users
 * would therefore not merely risk a leak; it would guarantee one, because the cache is keyed on URL
 * alone and would answer the second user's request with the first user's data.
 */
export function createGremlinMcpServer(credential: GremlinCredential): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const api = new GremlinApi(credential);

  registerResources(server, api);
  registerTools(server, api);

  return server;
}
