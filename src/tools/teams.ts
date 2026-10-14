import z from "zod";
import { assertRequiredParams, GremlinApi, type Team, wrapGremlinError } from "../client/gremlin";

export type TeamSummary = Pick<Team, 'identifier' | 'name' | 'production' | 'created_at'>;

// Explicit pick so new API fields (and the multi-KB certificate) stay out of the list.
export function summarizeTeam({ identifier, name, production, created_at }: Team): TeamSummary {
    return { identifier, name, production, created_at };
}

export function createListTeamsTool(api: GremlinApi) {
    return {
        name: "list_teams",
        title: "List Teams",
        description: "Lists all teams you have access to. Returns a summary per team (identifier, name, production, created_at). Use get_team for a team's full details.",
        schema: {},
        annotations: { readOnlyHint: true },
        handler: async () => {
            try {
                return (await api.listTeams()).map(summarizeTeam);
            } catch (error) {
                console.error(`Error fetching teams`, error);
                throw wrapGremlinError('Failed to fetch teams', error);
            }
        }
    }
}

export function createGetTeamTool(api: GremlinApi) {
    return {
        name: "get_team",
        title: "Get Team",
        description: "Fetches the full details of a single team, including its state, preferences, client versions, and certificate metadata.",
        schema: {
            teamId: z.string().describe(
                "The team identifier. Use the list_teams tool to find available teams and match by name or ID."
            ),
        },
        annotations: { readOnlyHint: true },
        handler: async (args: { teamId: string }) => {
            const { teamId } = args;
            assertRequiredParams(Boolean(teamId), `got ${JSON.stringify(args)} but expected { teamId: string }`);

            try {
                return await api.getTeam(teamId);
            } catch (error) {
                throw wrapGremlinError('Failed to fetch team', error);
            }
        }
    }
}
