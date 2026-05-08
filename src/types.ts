export interface Team {
  identifier: string;
  name: string;
  companyId: string;
  production: boolean;
}

export interface Service {
  serviceId: string;
  teamId: string;
  name: string;
  targetingStrategy?: string;
  applicationSelector?: string;
  description?: string;
  schedulableTests?: string[];
}

export interface Self {
  identifier: string;
  user_id: string;
  company_id: string;
  team_memberships: string[];
}

export interface ReliabilityReport {
  reliabilityScore: number;
  testSuiteId: string;
  reliability: Map<string, ReliabilityCategorySummary>;
}

export interface ReliabilityCategorySummary {
  category: string;
  score: number;
  policyTarget: string;
  policyStates: PolicyEvaluation[];
}

export interface PolicyEvaluation {
  policyId: string;
  reliabilityTestId: string;
  serviceId: string;
  dependencyId?: string;
  failureFlagName?: string;
  evaluationTime?: number;
  staleness: number;
  result: 'PASSED' | 'FAILED' | 'EXPIRED' | 'NEVER_RUN';
}

interface ScenarioRunResponse {
  scenarioId: string;
  runNumber: number;
  orgId: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  endTime?: Date;
  createSource: string;
  triggerSource: string;
  results: { status: 'Passed' | 'Failed' | 'Unsure' };
  graph: ScenarioGraph;
}

interface ScenarioGraph {
  nodesRecursive: never[];
  expectedLength: number;
  graph: Record<string, ScenarioGraphNode>;
}

interface ScenarioGraphNode {
  id: string;
  state: {
    lifeCycle: 'NotStarted' | 'Running' | 'Completed' | 'Failed' | 'Halted' | 'HaltRequested' | 'Active' | 'Successful';
  };
}

interface Suggestion {
  markdown: string;
  embeddings: { serviceId: string; key: string }[];
}

interface DiagnosisResponse {
  summary: string;
  suggestions: Suggestion[];
}

export interface PendingReliabilityTestRun {
  reliabilityTestId: string;
  reliabilityTestName: string;
  dependencyId?: string;
  dependencyName?: string;
  failureFlagName?: string;
  triggerSource: 'MANUAL' | 'RUN_ALL' | 'SCHEDULED' | 'RECURRING_SCHEDULE';
  triggeredBy?: string;
  expectedTriggerTime?: string;
}

export interface ReliabilityTestRunParameters {
  serviceId: string;
  dependencyId?: string;
  failureFlagName?: string;
}

export interface ReliabilityTestRun {
  guid: string;
  serviceId: string;
  dependencyId?: string;
  dependencyName?: string;
  failureFlagName?: string;
  isDependencySpof?: boolean;
  runNumber?: number;
  run: ScenarioRunResponse;
  diagnosis?: DiagnosisResponse;
}

export interface RecentRunResponse {
  serviceId: string;
  dependencyId?: string;
  dependencyName?: string;
  diagnosisAvailable: boolean;
  createTime: Date;
  endTime?: Date;
  passCriteria: string;
  reliabilityTestId: string;
  reliabilityTestName: string;
  runNumber: number;
  status: 'Passed' | 'Failed' | 'Unsure';
  triggerSource: string;
  triggeredBy: string;
}

export interface Page<T> {
  items: T[];
  pageToken?: string;
  pageSize?: number;
}

export interface ReliabilityTestSuite {
  identifier: string;
  name: string;
  description?: string;
  targetTeamIds: string[];
  testResponses: any[];
  excludedRiskIds?: string[];
}

export interface PricingUsage {
  start: string;
  end: string;
  maxActiveAgents: number;
  maxTargetableApplications: number;
  uniqueTargetsApplication: number;
  uniqueTargetsContainer: number;
  uniqueTargetsHost: number;
}

export type TrackingPeriod = 'Daily' | 'Weekly' | 'Monthly';

export interface PricingReport {
  companyId: string;
  startDate: string;
  endDate: string;
  trackingPeriod: TrackingPeriod;
  usageByTrackingPeriod: PricingUsage[];
}

export type ReportPeriod = 'MONTHS' | 'WEEKS' | 'DAYS';

export interface User {}
