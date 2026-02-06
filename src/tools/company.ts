import z from "zod";
import { GremlinApi, type ReportPeriod } from "../client/gremlin";

const reportPeriodSchema = z.enum(["MONTHS", "WEEKS", "DAYS"]);

const teamIdSchema = z.string().describe(
    "The team identifier. Use the list_teams tool to find available teams and match by name or ID."
);

export function createGetPricingReportTool(api: GremlinApi) {
    return {
        name: "get_pricing_report",
        description: "Fetches the pricing usage report for the company over a specified date range. Returns usage broken down by tracking period including active agents, targetable applications, and unique targets by type (host, container, application).",
        schema: {
            startDate: z.string().describe("Start date (yyyy-mm-dd) for the pricing usage. Should be within the current contract duration."),
            endDate: z.string().describe("End date (yyyy-mm-dd) for the pricing usage. Should be within the current contract duration."),
            trackingPeriod: z.enum(["Daily", "Weekly", "Monthly"]).optional().describe("Tracking period for the pricing usage. Defaults to the currently configured period for the company's plan."),
        },
        handler: async (args: { startDate: string; endDate: string; trackingPeriod?: "Daily" | "Weekly" | "Monthly" }) => {
            const { startDate, endDate, trackingPeriod } = args;
            if (!startDate || !endDate) {
                throw new Error(`got ${JSON.stringify(args)} but expected { startDate: string, endDate: string, trackingPeriod?: "Daily" | "Weekly" | "Monthly" }`);
            }

            try {
                return await api.getPricingReport(startDate, endDate, trackingPeriod);
            } catch (error) {
                throw new Error(`Failed to fetch pricing report: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createGetClientSummaryTool(api: GremlinApi) {
    return {
        name: "get_client_summary",
        description: "Loads the client (agent) summary for a team over a specified time period. Shows agent activity and status. Requires a teamId, use the list_teams tool first to find available teams.",
        schema: {
            teamId: teamIdSchema,
            start: z.string().describe("Start date (yyyy-mm-dd) for the report."),
            end: z.string().describe("End date (yyyy-mm-dd) for the report."),
            period: reportPeriodSchema.describe("Aggregation period for the report: MONTHS, WEEKS, or DAYS."),
        },
        handler: async (args: { teamId: string; start: string; end: string; period: ReportPeriod }) => {
            const { teamId, start, end, period } = args;
            if (!teamId || !start || !end || !period) {
                throw new Error(`got ${JSON.stringify(args)} but expected { teamId: string, start: string, end: string, period: "MONTHS" | "WEEKS" | "DAYS" }`);
            }

            try {
                return await api.getClientSummary(teamId, start, end, period);
            } catch (error) {
                throw new Error(`Failed to fetch client summary: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

export function createGetAttackSummaryTool(api: GremlinApi) {
    return {
        name: "get_attack_summary",
        description: "Loads the attack summary for a team over a specified time period. Shows attack activity and results. Requires a teamId, use the list_teams tool first to find available teams.",
        schema: {
            teamId: teamIdSchema,
            start: z.string().describe("Start date (yyyy-mm-dd) for the report."),
            end: z.string().describe("End date (yyyy-mm-dd) for the report."),
            period: reportPeriodSchema.describe("Aggregation period for the report: MONTHS, WEEKS, or DAYS."),
        },
        handler: async (args: { teamId: string; start: string; end: string; period: ReportPeriod }) => {
            const { teamId, start, end, period } = args;
            if (!teamId || !start || !end || !period) {
                throw new Error(`got ${JSON.stringify(args)} but expected { teamId: string, start: string, end: string, period: "MONTHS" | "WEEKS" | "DAYS" }`);
            }

            try {
                return await api.getAttackSummary(teamId, start, end, period);
            } catch (error) {
                throw new Error(`Failed to fetch attack summary: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
