import z from "zod";
import { GremlinApi } from "../client/gremlin";

export function createGetReliabilityExperimentTool(api: GremlinApi) {
    return {
        name: "get_reliability_experiments",
        description: "Retrieves recent reliability experiment for a specific service.",
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve the reliability experiment."),
            dependendyId: z.string().optional().describe("The ID of the dependency to retrieve the reliability experiment for, if applicable."),
            testId: z.string().optional().describe("The ID of the reliability test to retrieve the experiment for, if applicable."),
            limit: z.number().optional().describe("The maximum number of results to return. Defaults to 100."),
        },
        handler: async (args: { serviceId: string, teamId: string, dependencyId?: string, testId?: string, limit?: number }) => {
            const { serviceId, teamId, dependencyId, testId, limit } = args;
            if (!serviceId || !teamId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`);
            }

            try {
                let results =  await api.getReliabilityExperiment(serviceId, teamId, dependencyId, testId, limit);
                if ("items" in results) {
                    results.items = results.items.map(run => {
                        // Delete extraneous data to save on data transfer
                        run.run.graph.nodesRecursive = []
                        return run;
                    })
                } else {
                    // Delete extraneous data to save on data transfer
                    results.run.graph.nodesRecursive = [];
                }
            } catch (error) {
                console.error(`Error fetching reliability report`, error);
                throw new Error(`Failed to fetch reliability report: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createGetReliabilityReportTool(api: GremlinApi) {
    return {
        name: "get_reliability_report",
        description: "Retrieves the reliability report for a specific service.",
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve the reliability report."),
            date: z.string().optional().describe("The date for which to retrieve the reliability report, in YYYY-MM-DD format. Defaults to today."),
        },
        handler: async (args: { serviceId: string, teamId: string, date?: string }) => {
            const { serviceId, teamId, date } = args;
            if (!serviceId || !teamId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`);
            }

            try {
                return  await api.getReliabilityReport(serviceId, teamId, date);
            } catch (error) {
                console.error(`Error fetching reliability report`, error);
                throw new Error(`Failed to fetch reliability report: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createGetCurrentTestSuiteTool(api: GremlinApi) {
    return {
        name: "get_current_test_suite",
        description: "Retrieves the current test suite for a specific team. Or all if no team is specified.",
        schema: {
            teamId: z.string().optional().describe("The ID of the team you're examining the current test suite for."),
        },
        handler: async (args: { teamId: string }) => {
            const { teamId } = args;

            try {
                const testSuites = await api.getAllTestSuite()
                if (!teamId) {
                    return testSuites;
                }

                if (!testSuites || !Array.isArray(testSuites)) {
                    throw new Error("No test suites found or invalid format.");
                }

                if (testSuites.length === 0) {
                    return [];
                }

                // Filter test suites by teamId
                if (!testSuites.some(suite => suite.targetTeamIds.includes(teamId))) {
                    throw new Error(`No test suites found for team ID: ${teamId}`);
                }

                // Return only test suites that target the specified team       
                return testSuites.filter(suite => suite.targetTeamIds.includes(teamId));
            } catch (error) {
                console.error(`Error fetching current test suite`, error);
                throw new Error(`Failed to fetch current test suite: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createGetRecentReliabilityTestsTool(api: GremlinApi) {
    return {
        name: "get_recent_reliability_tests",
        description: "Retrieves recent reliability tests for a given team.",
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            pageSize: z.number().optional().describe("The maximum number of results to return. Defaults to 5."),
            pageToken: z.string().optional().describe("The token for pagination, if applicable."),
        },
        handler: async (args: { teamId: string, pageSize?: number, pageToken?: string }) => {
            const { teamId, pageSize, pageToken } = args;
            let limit = pageSize;
            if (!teamId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { teamId: string }`);
            }

            if (!limit) {
                limit = 5;
            }

            try {
                return await api.getRecentReliabilityTests(teamId, limit, pageToken);
            } catch (error) {
                console.error(`Error fetching recent reliability tests`, error);
                throw new Error(`Failed to fetch recent reliability tests: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}