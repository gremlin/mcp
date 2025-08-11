import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GremlinApi } from "../client/gremlin";
import { createGetCurrentTestSuiteTool, createGetRecentReliabilityTestsTool, createGetReliabilityExperimentTool, createGetReliabilityReportTool } from "./reliability-management";
import { createGetServiceDependenciesTool, createGetServiceStatusChecksTool, createListServiceRisksTool, createListServicesTool } from "./services";
import { createListTeamsTool } from "./teams";

interface Tool {
  name: string;
  description: string;
  schema: Record<string, any>;
  annotations?: Record<string, any>;
  handler: (args: any, extra: any) => Promise<any>;
}

export function registerTools(server: McpServer, api: GremlinApi) {
  const tools: Tool[] = [
    createListServicesTool(api),
    createGetServiceDependenciesTool(api),
    createGetServiceStatusChecksTool(api),
    createListServiceRisksTool(api),

    createGetReliabilityReportTool(api),
    createGetReliabilityExperimentTool(api),
    createGetRecentReliabilityTestsTool(api),
    createGetCurrentTestSuiteTool(api),

    createListTeamsTool(api) 
  ];

  // Register each tool with the server
  for (const tool of tools) {
    // Register the tool with the server using type assertion to bypass TypeScript's strict type checking
    server.tool(
      tool.name,
      tool.description,
      tool.schema, 
      //tool.annotations || { example: "annotation"},
      async (args: Record<string, any>, extra: any) => {
        try {
          // Use type assertion to satisfy TypeScript's type checking
          const result = await tool.handler(args, extra);

          // If the result already has the expected format, return it directly
          if (result && typeof result === 'object' && 'content' in result) {
            return result as any;
          }

          // Otherwise, format the result as expected by the SDK
          return {
            content: [
              {
                type: "text",
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            ],
          } as any;
        } catch (error) {
          // Format errors to match the SDK's expected format
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          } as any;
        }
      }
    );
  }
}
