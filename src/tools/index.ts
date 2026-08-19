import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GremlinApi, GremlinApiError } from "../client/gremlin";
import { createGetCurrentTestSuiteTool, createGetPendingTestRunsTool, createGetRecentReliabilityTestsTool, createGetReliabilityExperimentTool, createGetReliabilityReportTool, createRunReliabilityTestTool } from "./reliability-management";
import { createGetServiceDependenciesTool, createGetServiceStatusChecksTool, createListServiceRisksTool, createListServicesTool } from "./services";
import { createListTeamsTool } from "./teams";
import { createGetPricingReportTool, createGetClientSummaryTool, createGetAttackSummaryTool } from "./company";
import { createSearchGremlinApiTool, createExecuteGremlinApiTool } from "./openapi";
import { createGetContainerTool, createMatchContainersTool, createListContainerLabelKeysTool } from "./containers";

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
    createRunReliabilityTestTool(api),
    createGetPendingTestRunsTool(api),

    createListTeamsTool(api),

    createGetPricingReportTool(api),
    createGetClientSummaryTool(api),
    createGetAttackSummaryTool(api),

    createGetContainerTool(api),
    createMatchContainersTool(api),
    createListContainerLabelKeysTool(api),

    createSearchGremlinApiTool(api),
    createExecuteGremlinApiTool(api, server),
  ];

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema as any,
        annotations: tool.annotations as any,
      },
      async (args: Record<string, any>, extra: any) => {
        try {
          const result = await tool.handler(args, extra);

          if (result && typeof result === 'object' && 'content' in result) {
            return result as any;
          }

          return {
            content: [
              {
                type: "text",
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            ],
          } as any;
        } catch (error) {
          // structuredContent is a best-effort signal for clients that read it —
          // the text block above (readable by any MCP client) remains the
          // channel that actually carries the retry guidance to the model.
          // Output-schema validation is skipped entirely for isError results
          // (see the MCP SDK's validateToolOutput), so this needs no outputSchema.
          const structuredContent = error instanceof GremlinApiError
            ? { isInputError: error.isInputError, ...(error.statusCode !== undefined && { statusCode: error.statusCode }) }
            : undefined;

          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
            ...(structuredContent && { structuredContent }),
          } as any;
        }
      }
    );
  }
}
