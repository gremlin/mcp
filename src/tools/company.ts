import z from "zod";
import { GremlinApi } from "../client/gremlin";

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
