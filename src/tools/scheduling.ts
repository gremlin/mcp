import z from "zod";
import { GremlinApi, PolicyEvaluation, ScheduleSettings } from "../client/gremlin";

interface TestDurationEntry {
    reliabilityTestId: string;
    testName: string;
    dependencyId?: string;
    expectedDurationSeconds: number;
}

interface DurationEstimate {
    serviceId: string;
    teamId: string;
    tests: TestDurationEntry[];
    totalDurationSeconds: number;
    totalDurationMinutes: number;
    totalDurationFormatted: string;
    testCount: number;
    note: string;
}

function formatDuration(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

/**
 * Dig out expectedLengthWithDelays from whatever shape the API gives us.
 *
 * The /reliability-tests/active endpoint swagger says ReliabilityTestRunResponse
 * (which nests duration under run.graph) but the actual response might use
 * scenario.graph instead. We check both paths defensively.
 */
function extractTestInfo(test: Record<string, unknown>): { guid: string; name: string; duration: number } {
    const guid = (test.guid as string) ?? '';

    // Try scenario.graph path (test definition shape)
    const scenario = test.scenario as Record<string, unknown> | undefined;
    if (scenario?.graph) {
        const graph = scenario.graph as Record<string, unknown>;
        return {
            guid,
            name: (scenario.name as string) ?? guid,
            duration: (graph.expectedLengthWithDelays as number) ?? 0,
        };
    }

    // Try run.graph path (test run shape)
    const run = test.run as Record<string, unknown> | undefined;
    if (run?.graph) {
        const graph = run.graph as Record<string, unknown>;
        return {
            guid,
            name: (run.name as string) ?? guid,
            duration: (graph.expectedLengthWithDelays as number) ?? 0,
        };
    }

    return { guid, name: guid, duration: 0 };
}

export function createEstimateTestSuiteDurationTool(api: GremlinApi) {
    return {
        name: "estimate_test_suite_duration",
        description: [
            "Estimates the total expected runtime for all reliability tests in a service's test suite.",
            "Uses the reliability report to discover which tests apply to the service,",
            "then fetches active test definitions to get each test's expected duration (expectedLengthWithDelays).",
            "DEPENDENCY tests run once per dependency on the service, so they appear multiple times in the breakdown.",
            "Each entry in the result represents a single test execution.",
            "Use this before calling set_service_schedule to figure out how much schedule window time is needed.",
            "If the total duration exceeds available schedule window time in a week, leftover tests automatically carry over to the next week.",
        ].join(" "),
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to estimate test suite duration for."),
        },
        handler: async (args: { teamId: string; serviceId: string }) => {
            const { teamId, serviceId } = args;
            if (!teamId || !serviceId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { teamId: string, serviceId: string }`);
            }

            try {
                // Fetch the reliability report to discover which tests apply to this service.
                // Each (reliabilityTestId, dependencyId) pair represents one test execution.
                const report = await api.getReliabilityReport(serviceId, teamId);

                const seen = new Set<string>();
                const policyEntries: PolicyEvaluation[] = [];
                const categories = Object.values(report.reliability);

                for (const category of categories) {
                    for (const policy of category.policyStates) {
                        const key = `${policy.reliabilityTestId}::${policy.dependencyId ?? 'none'}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            policyEntries.push(policy);
                        }
                    }
                }

                // Fetch active tests for the team to get duration info.
                // The graph data is huge but we only extract expectedLengthWithDelays.
                const activeTests = await api.getActiveReliabilityTests(teamId);

                const testLookup = new Map<string, { name: string; duration: number }>();
                for (const raw of activeTests) {
                    const test = raw as Record<string, unknown>;
                    const info = extractTestInfo(test);
                    if (info.guid) {
                        testLookup.set(info.guid, { name: info.name, duration: info.duration });
                    }
                }

                // Cross-reference: for each policy entry, look up its test duration
                const tests: TestDurationEntry[] = [];
                let totalDurationSeconds = 0;

                for (const policy of policyEntries) {
                    const testInfo = testLookup.get(policy.reliabilityTestId);
                    const duration = testInfo?.duration ?? 0;

                    tests.push({
                        reliabilityTestId: policy.reliabilityTestId,
                        testName: testInfo?.name ?? 'Unknown Test',
                        dependencyId: policy.dependencyId,
                        expectedDurationSeconds: duration,
                    });

                    totalDurationSeconds += duration;
                }

                const result: DurationEstimate = {
                    serviceId,
                    teamId,
                    tests,
                    totalDurationSeconds,
                    totalDurationMinutes: Math.ceil(totalDurationSeconds / 60),
                    totalDurationFormatted: formatDuration(totalDurationSeconds),
                    testCount: tests.length,
                    note: [
                        "Each entry represents one test execution.",
                        "Dependency tests appear once per dependency.",
                        "The total is sequential execution time (sum of all expectedLengthWithDelays).",
                        "If this exceeds your schedule window capacity, leftover tests carry to the next week.",
                    ].join(" "),
                };

                return result;
            } catch (error) {
                console.error(`Error estimating test suite duration`, error);
                throw new Error(`Failed to estimate test suite duration: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    };
}

export function createSetServiceScheduleTool(api: GremlinApi) {
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

    return {
        name: "set_service_schedule",
        description: [
            "Sets the schedule windows for when Gremlin can automatically run reliability tests against a service.",
            "Each trigger specifies a day of the week and an optional time window (HH:mm 24-hour format).",
            "Maximum of 1 schedule window per day.",
            "Use estimate_test_suite_duration first to understand how much window time is needed.",
            "If the total test suite duration exceeds the available window time in a single week,",
            "Gremlin automatically carries leftover tests into the following week(s). This is expected for large suites.",
            "Requires the SERVICES_WRITE privilege.",
        ].join(" "),
        schema: {
            teamId: z.string().describe("The ID of the team that owns the service."),
            serviceId: z.string().describe("The ID of the service to set the schedule for."),
            enabled: z.boolean().describe("Whether scheduling is enabled for this service."),
            scheduleType: z.enum(['OnlyOnce', 'Random']).describe(
                "OnlyOnce: run each test exactly once per schedule cycle. Random: pick tests randomly within the window."
            ),
            triggerType: z.enum(['Passed', 'RunOnce', 'Always']).describe(
                "Passed: only run tests that haven't passed yet. RunOnce: run each test once then stop. Always: run all tests every cycle."
            ),
            triggers: z.array(
                z.object({
                    dayOfWeek: z.enum(['M', 'T', 'W', 'Th', 'F', 'S', 'Su']).describe("Day of the week."),
                    scheduleWindows: z.array(
                        z.object({
                            start: z.string().regex(timeRegex, 'Must be HH:mm 24-hour format (e.g. "09:00")').describe("Window start time in HH:mm 24-hour format."),
                            end: z.string().regex(timeRegex, 'Must be HH:mm 24-hour format (e.g. "17:00")').describe("Window end time in HH:mm 24-hour format."),
                        })
                    ).max(1).describe("Time window for this day. Max 1 per day. Empty array means all-day."),
                })
            ).describe("One entry per day you want tests to run."),
        },
        annotations: {
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
        handler: async (args: {
            teamId: string;
            serviceId: string;
            enabled: boolean;
            scheduleType: 'OnlyOnce' | 'Random';
            triggerType: 'Passed' | 'RunOnce' | 'Always';
            triggers: Array<{
                dayOfWeek: string;
                scheduleWindows: Array<{ start: string; end: string }>;
            }>;
        }) => {
            const { teamId, serviceId, enabled, scheduleType, triggerType, triggers } = args;
            if (!teamId || !serviceId) {
                throw new Error(`got ${JSON.stringify(args)} but expected { teamId: string, serviceId: string, ... }`);
            }

            const scheduleSettings: ScheduleSettings = {
                enabled,
                scheduleType,
                triggerType,
                triggers: triggers as ScheduleSettings['triggers'],
            };

            try {
                await api.updateServiceSchedule(serviceId, teamId, scheduleSettings);

                const windowSummary = triggers.map(t => {
                    const windows = t.scheduleWindows.length > 0
                        ? t.scheduleWindows.map(w => `${w.start}-${w.end}`).join(', ')
                        : 'all day';
                    return `${t.dayOfWeek}: ${windows}`;
                }).join('; ');

                return {
                    success: true,
                    serviceId,
                    teamId,
                    scheduleSettings,
                    summary: `Schedule ${enabled ? 'enabled' : 'disabled'} (${scheduleType}/${triggerType}): ${windowSummary}`,
                };
            } catch (error) {
                console.error(`Error setting service schedule`, error);
                throw new Error(`Failed to set service schedule: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    };
}
