import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from "zod";
import { GremlinApi } from "./client/gremlin";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";
import { getAuthHeader } from "./config";

try {
  getAuthHeader();
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const server = new McpServer({
  name: "Gremlin Inc Server",
  version: "2.4.2"
});

const gremlinApi = new GremlinApi();

// Register resources
registerResources(server, gremlinApi);

// Register tools
registerTools(server, gremlinApi);  


const transport = new StdioServerTransport();
server.connect(transport);
