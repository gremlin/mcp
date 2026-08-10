import z from "zod";
import { assertRequiredParams, GremlinApi, Self, Service, wrapGremlinError } from "../client/gremlin";


export function createGetServiceDependenciesTool(api: GremlinApi) {
    return {
        name: "get_service_dependencies",
        description: "Retrieves the service dependencies for a specific service.",
        annotations: { readOnlyHint: true },
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve the dependencies for"),
        },
        handler: async (args: { serviceId: string, teamId: string }) => {
            const { serviceId, teamId } = args;
            assertRequiredParams(
                Boolean(serviceId) && Boolean(teamId),
                `got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`,
            );

            try {
                return await api.getServiceDependencies(serviceId, teamId);
            } catch (error) {
                console.error(`Error fetching service dependencies`, error);
                throw wrapGremlinError('Failed to fetch service dependencies', error);
            }
        }
    }
}

export function createListServiceRisksTool(api: GremlinApi) {
    return {
        name: "list_service_risks",
        description: "Lists the risks associated with a specific service.",
        annotations: { readOnlyHint: true },
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve risks for."),
        },
        handler: async (args: { serviceId: string, teamId: string }) => {
            const { serviceId, teamId } = args;
            assertRequiredParams(
                Boolean(serviceId) && Boolean(teamId),
                `got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`,
            );
            try {
                return await api.getServiceRisks(serviceId, teamId);
            } catch (error) {
                console.error(`Error fetching service risks`, error);
                throw wrapGremlinError('Failed to fetch service risks', error);
            }
        }
    }
}

export function createGetServiceStatusChecksTool(api: GremlinApi) {
    return {
        name: "get_service_status_checks",
        description: "Retrieves the status checks for a specific service.",
        annotations: { readOnlyHint: true },
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve status checks for."),
        },
        handler: async (args: { serviceId: string, teamId: string }) => {
            const { serviceId, teamId } = args;
            assertRequiredParams(
                Boolean(serviceId) && Boolean(teamId),
                `got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`,
            );
            try {
                return await api.getServiceStatusChecks(serviceId, teamId);
            } catch (error) {
                console.error(`Error fetching service status checks`, error);
                throw wrapGremlinError('Failed to fetch service status checks', error);
            }
        }
    }
}

export function createListServicesTool(api: GremlinApi) {
  return {
    name: "list_services",
    description: "Lists available reliability management services (RM Services for short). Returns service names, descriptions, score, and targeting information.",
    annotations: { readOnlyHint: true },
    schema: {},
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
        throw wrapGremlinError('Failed to fetch services', error);
      }

    }
  }
}