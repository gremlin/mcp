import type {
  Page,
  PendingReliabilityTestRun,
  PricingReport,
  RecentRunResponse,
  ReliabilityReport,
  ReliabilityTestRun,
  ReliabilityTestRunParameters,
  ReliabilityTestSuite,
  ReportPeriod,
  Self,
  Service,
  Team,
  TrackingPeriod,
  User,
} from '../types';

export interface GremlinClient {
  listUsers(): Promise<User[]>;
  listTeams(): Promise<Team[]>;
  getTeam(teamId: string): Promise<Team>;
  listServicesForTeam(teamId: string): Promise<Page<Service>>;
  getService(serviceId: string, teamId: string): Promise<Page<Service>>;
  getSelf(): Promise<Self>;

  getReliabilityReport(serviceId: string, teamId: string, date?: string): Promise<ReliabilityReport>;
  getServiceDependencies(serviceId: string, teamId: string): Promise<ReliabilityReport>;
  getServiceStatusChecks(serviceId: string, teamId: string): Promise<ReliabilityReport>;
  getServiceRisks(serviceId: string, teamId: string): Promise<ReliabilityReport>;

  getAllTestSuite(): Promise<ReliabilityTestSuite[]>;
  getRecentReliabilityTests(teamId: string, limit?: number, pageToken?: string): Promise<Page<RecentRunResponse>>;
  getReliabilityExperiment(
    serviceId: string,
    teamId: string,
    dependencyId?: string,
    testId?: string,
    limit?: number,
  ): Promise<Page<ReliabilityTestRun> | ReliabilityTestRun>;
  runReliabilityTest(
    reliabilityTestId: string,
    teamId: string,
    params: ReliabilityTestRunParameters,
  ): Promise<ReliabilityTestRun>;
  getPendingTestRuns(serviceId: string, teamId: string): Promise<PendingReliabilityTestRun[]>;

  getPricingReport(startDate: string, endDate: string, trackingPeriod?: TrackingPeriod): Promise<PricingReport>;
  getClientSummary(teamId: string, start: string, end: string, period: ReportPeriod): Promise<unknown>;
  getAttackSummary(teamId: string, start: string, end: string, period: ReportPeriod): Promise<unknown>;

  execute<T = unknown>(
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<T>;
}
