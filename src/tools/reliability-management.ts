import z from "zod";
import { GremlinApi, ReliabilityTestRun } from "../client/gremlin";

/**
 * Strip the bulky ScenarioRunResponse down to the fields Claude actually
 * needs for decision-making. The full `graph` (which can be enormous) is
 * replaced with a compact summary.
 */
function summarizeScenarioRun(testRun: ReliabilityTestRun): ReliabilityTestRun {
    const { graph: _graph, ...runSummary } = testRun.run;
    return {
        ...testRun,
        run: runSummary as ReliabilityTestRun["run"],
    };
}

export function createGetReliabilityExperimentTool(api: GremlinApi) {
    return {
        name: "get_reliability_experiments",
        description: "Retrieves recent reliability experiment for a specific service.",
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to retrieve the reliability experiment."),
            dependencyId: z.string().optional().describe("The ID of the dependency to retrieve the reliability experiment for, if applicable."),
            testId: z.string().optional().describe("The ID of the reliability test to retrieve the experiment for, if applicable."),
            limit: z.number().optional().describe("The maximum number of results to return. Defaults to 100."),
            includeScenarioRun: z.boolean().optional().describe("Include the full scenario run graph data. Defaults to false. Only set to true when you need detailed step-by-step execution data."),
        },
        handler: async (args: { serviceId: string, teamId: string, dependencyId?: string, testId?: string, limit?: number, includeScenarioRun?: boolean }) => {
            const { serviceId, teamId, dependencyId, testId, limit, includeScenarioRun } = args;
            if (!serviceId || !teamId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { serviceId: string, teamId: string }`);
            }

            try {
                const results = await api.getReliabilityExperiment(serviceId, teamId, dependencyId, testId, limit);
                if (includeScenarioRun) {
                    return results;
                }
                if ("items" in results) {
                    results.items = results.items.map(summarizeScenarioRun);
                } else {
                    return summarizeScenarioRun(results);
                }
                return results;
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

export function createRunReliabilityTestTool(api: GremlinApi) {
    return {
        name: "run_reliability_test",
        description: [
            "Run a reliability test for a service.",
            "Use get_reliability_report to discover valid reliabilityTestId, dependencyId, and failureFlagName values for a service.",
            "You can also extract these parameters from a previous reliability test run (via get_reliability_experiments) to rerun a test.",
            "Requires the SERVICES_RUN privilege.",
        ].join(" "),
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to run the reliability test against."),
            reliabilityTestId: z.string().describe("The ID of the reliability test to run. Found in the reliability report's policyStates as 'reliabilityTestId'."),
            dependencyId: z.string().optional().describe("The ID of the dependency to target, if the test is a dependency test. Found in the reliability report's policyStates."),
            failureFlagName: z.string().optional().describe("The name of the failure flag to target, if the test uses failure flags. Found in the reliability report's policyStates."),
            includeScenarioRun: z.boolean().optional().describe("Include the full scenario run graph data. Defaults to false. Only set to true when you need detailed step-by-step execution data."),
        },
        annotations: {
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
        handler: async (args: { teamId: string, serviceId: string, reliabilityTestId: string, dependencyId?: string, failureFlagName?: string, includeScenarioRun?: boolean }) => {
            const { teamId, serviceId, reliabilityTestId, dependencyId, failureFlagName, includeScenarioRun } = args;
            if (!teamId || !serviceId || !reliabilityTestId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { teamId: string, serviceId: string, reliabilityTestId: string }`);
            }

            try {
                const result = await api.runReliabilityTest(reliabilityTestId, teamId, {
                    serviceId,
                    dependencyId,
                    failureFlagName,
                });
                if (includeScenarioRun) {
                    return result;
                }
                return summarizeScenarioRun(result);
            } catch (error) {
                console.error(`Error running reliability test`, error);
                throw new Error(`Failed to run reliability test: ${error instanceof Error ? error.message : String(error)}`);
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