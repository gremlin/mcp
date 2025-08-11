import cache, { Cache } from '@stacksjs/ts-cache';


export interface Team {
  identifier: string;
  name: string;
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
  results: {status: 'Passed' | 'Failed' | 'Unsure'};
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
  embeddings: {serviceId: string, key: string}[];
}

interface DiagnosisResponse {
  summary: string;
  suggestions: Suggestion[];
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

export interface User { }

export interface Team { 
  identifier: string;
  name: string;
  companyId: string;
  production: boolean;
}

export class GremlinApi {
  private baseUrl: string = 'https://api.gremlin.com/v1';
  private userAgent = "@gremlin/gremlin-mcp/1.0.0";
  private cache;

  constructor() {
    this.cache = new Cache({
          useClones: true,
        })
  }

  async listUsers(): Promise<User[]> {
    return this.requestWithRetry<User[]>('users', {
      method: 'GET',
    });
  }

  async listTeams(): Promise<Team[]> {
    return this.requestWithRetry<Team[]>('teams', {
      method: 'GET',
    });
  }

  async getTeam(teamId: string): Promise<Team> {
    if (!teamId) {
      throw new Error('teamId is required to fetch the team details.');
    }
    return this.requestWithRetry<Team>(`teams/${teamId}`, {
      method: 'GET',
    });
  }

  async listTeamsForCompany(): Promise<Team[]> {
    return this.requestWithRetry<Team[]>('teams', {
      method: 'GET',
    });
  }

  async listServicesForTeam(teamId: string): Promise<Page<Service>> {
    return this.requestWithRetry<Page<Service>>(`services`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getReliabilityReport(serviceId: string, teamId: string, date?: string): Promise<ReliabilityReport> {
    if (!serviceId || !teamId) {
      throw new Error('Both serviceId and teamId are required to fetch the reliability report.');
    }

    const params: Record<string, any> = { teamId };
    if (date && date !== 'undefined') {
      params.date = date;
    }

    return this.requestWithRetry<ReliabilityReport>(`policies/${serviceId}/reliability-report`, {
      method: 'GET',
      params,
    });
  }

  async getServiceDependencies(serviceId: string, teamId: string): Promise<ReliabilityReport> {
    if (!serviceId || !teamId) {
      throw new Error('Both serviceId and teamId are required to fetch the service dependencies.');
    }

    return this.requestWithRetry<ReliabilityReport>(`services/${serviceId}/dependencies`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getServiceStatusChecks(serviceId: string, teamId: string): Promise<ReliabilityReport> {
    if (!serviceId || !teamId) {
      throw new Error('Both serviceId and teamId are required to fetch the service status checks.');
    }
    return this.requestWithRetry<ReliabilityReport>(`services/${serviceId}/status-checks`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getServiceRisks(serviceId: string, teamId: string): Promise<ReliabilityReport> {
    if (!serviceId || !teamId) { 
      throw new Error('Both serviceId and teamId are required to fetch the service risks.');
    } 
    return this.requestWithRetry<ReliabilityReport>(`services/${serviceId}/risk-summary`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getAllTestSuite(): Promise<ReliabilityTestSuite[]> {
    return this.requestWithRetry<ReliabilityTestSuite[]>(`test-suites`, {
      method: 'GET',
    });
  }

  async getRecentReliabilityTests(teamId: string, limit: number = 5, pageToken?: string): Promise<Page<RecentRunResponse>> {
    const params: Record<string, any> = { teamId, pageSize: limit };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    return this.requestWithRetry<Page<RecentRunResponse>>(`reliability-tests/completed/paged`, {
      method: 'GET',
      params,
    });
  }


  async getReliabilityExperiment(
    serviceId: string,
    teamId: string,
    dependencyId?: string,
    testId?: string,
    limit: number = 100
  ): Promise<Page<ReliabilityTestRun> | ReliabilityTestRun> {
    if (!serviceId || !teamId) {
      throw new Error('Both serviceId and teamId are required to fetch the reliability experiment.');
    }

    const params: Record<string, any> = { teamId, serviceId, pageSize: limit };
    if (dependencyId) params.dependencyId = dependencyId;

    const path = testId ? `reliability-tests/${testId}/runs` : `reliability-tests/runs`;

    return this.requestWithRetry<Promise<Page<ReliabilityTestRun> | ReliabilityTestRun>>(path, {
      method: 'GET',
      params,
    });
  }

  async getService(serviceId: string, teamId: string): Promise<Page<Service>> {
    return this.requestWithRetry<Page<Service>>(`services/${serviceId}`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getSelf(): Promise<Self> {
    return this.requestWithRetry<Self>('users/self', {
      method: 'GET',
    });
  }

  private async requestWithRetry<T>(
    path: string,
    options: RequestInit & {
      params?: Record<string, any>;
      maxRetries?: number;
    } = {},
  ): Promise<T> {
    const { params, maxRetries = 3, ...fetchOptions } = options;
    const url = new URL(`${this.baseUrl}/${path}`);

    if (params) {
      Object.keys(params).forEach(key => url.searchParams.append(key, String(params[key])));
    }

    const urlString = url.toString();
    if (this.cache.has(urlString)) {
      return this.cache.get(urlString) as T;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(urlString, {
            ...fetchOptions,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${process.env.GREMLIN_API_KEY}`,
                'User-Agent': this.userAgent,
                ...fetchOptions.headers,
            },
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const responseData =  await response.json() as T;

        this.cache.set(urlString, responseData, 60 * 10); // Cache for 10 minutes
        return responseData;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError;

  }
}
