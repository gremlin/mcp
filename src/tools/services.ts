import z from "zod";
import { GremlinApi, Self, Service } from "../client/gremlin";


export function createGetServiceDependenciesTool(api: GremlinApi) {
    return {
        name: "get_service_dependencies",
        description: "Retrieves the service dependencies for a specific service.",
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve the dependencies for"),
        },
        handler: async (args: { serviceId: string, teamId: string }) => {
            const { serviceId, teamId } = args;
            if (!serviceId || !teamId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`);
            }

            try {
                return await api.getServiceDependencies(serviceId, teamId);
            } catch (error) {
                console.error(`Error fetching service dependencies`, error);
                throw new Error(`Failed to fetch service dependencies: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createListServiceRisksTool(api: GremlinApi) {
    return {
        name: "list_service_risks",
        description: "Lists the risks associated with a specific service.",
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve risks for."),
        },
        handler: async (args: { serviceId: string, teamId: string }) => {
            const { serviceId, teamId } = args;
            if (!serviceId || !teamId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`);
            }
            try {
                return await api.getServiceRisks(serviceId, teamId);
            } catch (error) {
                console.error(`Error fetching service risks`, error);
                throw new Error(`Failed to fetch service risks: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createGetServiceStatusChecksTool(api: GremlinApi) {
    return {
        name: "get_service_status_checks",
        description: "Retrieves the status checks for a specific service.",
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve status checks for."),
        },
        handler: async (args: { serviceId: string, teamId: string }) => {
            const { serviceId, teamId } = args;
            if (!serviceId || !teamId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`);
            }
            try {
                return await api.getServiceStatusChecks(serviceId, teamId);
            } catch (error) {
                console.error(`Error fetching service status checks`, error);
                throw new Error(`Failed to fetch service status checks: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createListServicesTool(api: GremlinApi) {
  return {
    name: "list_services",
    description: "Lists available reliability management services (RM Services for short). Returns service names, descriptions, score, and targeting information.",
    schema: { },
    /**
     * Handles the list_services tool request with pagination and search
     *
     * @param params -  none currently, but will be extended for pagination 
     * @returns list of services with their details
     */
    handler: async (params: { } ) => {
      try {
          const self : Self = await api.getSelf();
          const services : Service[] =  []
          for (const team of self.team_memberships) {
            const teamServices : Service[] = (await api.listServicesForTeam(team)).items.map(s => {
              // Clear this to save on data
              s.schedulableTests = []
              return s;
            });
            services.push(...teamServices);
          }

          return services;
      } catch (error) {
        console.error(`Error fetching services`, error);
        throw new Error(`Failed to fetch services: ${error instanceof Error ? error.message : String(error)}`);
      }

    }
  }
}