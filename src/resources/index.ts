import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GremlinApi, Self, Service, Team } from "../client/gremlin";

/**
 * Interface for MCP resource items
 * taken from: Infer<typeof ListResourcesResultSchema>;
 */
interface ResourceItem {
  uri: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * Register all resources with the MCP server
 *
 * @param server - The MCP server instance
 * @param api - The Gremlin API client
 */
export function registerResources(server: McpServer, api: GremlinApi) {
  server.resource(
    "teams",
    new ResourceTemplate("gremlin://team/{teamId}", {
      list: async () => {
        const resources: ResourceItem[] = [];
        try {
          const teams: Team[] = await api.listTeams();
          teams.forEach((team) => {
            resources.push({
              uri: `gremlin://team/${team.identifier}`,
              name: team.name,
              companyId: team.companyId,
              production: team.production,
            });
          });
        } catch (error) {
          console.error(`Error fetching teams`, error);
        }
        return { resources };
      }
    }),
    async (_uri: URL, variables: Record<string, string | string[]>) => {
      const teamId = Array.isArray(variables.teamId) ? variables.teamId[0] : variables.teamId;

      try {
        const team = await api.getTeam(teamId);
        return {
          contents: [{
            uri: `gremlin://team/${teamId}`,
            text: JSON.stringify(team, null, 2),
            mimeType: "application/json"
          }]
        };
      } catch (error) {
        throw new Error(`Failed to get team: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // Register RMService resource
  server.resource(
    "services",
    new ResourceTemplate("gremlin://service/{teamId}/{serviceId}", {

      list: async () => {
        const resources: ResourceItem[] = [];
        try {
          const self : Self = await api.getSelf();
          const services : Service[] =  []
          for (const team of self.team_memberships) {
            const teamServices : Service[] = (await api.listServicesForTeam(team)).items;
            services.push(...teamServices);
          }
          
          // Add each dataset as a resource
          services.forEach((service: Service) => {
            resources.push({
              uri: `gremlin://service/${service.teamId}/${service.serviceId}`,
              name: service.name,
              targets: service.targetingStrategy || service.applicationSelector || '',
            });
          });
        } catch (error) {
          console.error(`Error fetching services`, error);
        }

        return { resources  };
      }
    }),
    async (_uri: URL, variables: Record<string, string | string[]>) => {
      const serviceId = Array.isArray(variables.serviceId) ? variables.serviceId[0] : variables.serviceId;
      const teamId = Array.isArray(variables.teamId) ? variables.teamId[0] : variables.teamId;

      try {
        const service = await api.getService(serviceId, teamId);

        return {
          contents: [{
            uri: `gremlin://service/${teamId}/${serviceId}`,
            text: JSON.stringify(service, null, 2),
            mimeType: "application/json"
          }]
        };
      } catch (error) {
        throw new Error(`Failed to get service: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

