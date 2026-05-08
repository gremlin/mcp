import type { GremlinClient } from "../client/interface";


export function createListTeamsTool(api: GremlinClient) {
    return {
        name: "list_teams",
        description: "Lists all teams you have access to",
        schema: {},
        handler: async () => {
            try {
                return await api.listTeams();
            } catch (error) {
                console.error(`Error fetching teams`, error);
                throw new Error(`Failed to fetch teams: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}