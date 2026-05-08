import TTLCache from '@isaacs/ttlcache';
import type { GremlinClient } from './interface';
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

export class GremlinApi implements GremlinClient {
  private baseUrl: string = 'https://api.gremlin.com/v1';
  private userAgent = "@gremlin/gremlin-mcp/2.2.0";
  private cache = new TTLCache<string, unknown>();

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
    limit: number = 100,
  ): Promise<Page<ReliabilityTestRun> | ReliabilityTestRun> {
    if (!serviceId || !teamId) {
      throw new Error('Both serviceId and teamId are required to fetch the reliability experiment.');
    }

    const params: Record<string, any> = { teamId, serviceId, pageSize: limit };
    if (dependencyId) params.dependencyId = dependencyId;

    const path = testId ? `reliability-tests/${testId}/runs` : `reliability-tests/runs`;

    return this.requestWithRetry<Page<ReliabilityTestRun> | ReliabilityTestRun>(path, {
      method: 'GET',
      params,
    });
  }

  async runReliabilityTest(
    reliabilityTestId: string,
    teamId: string,
    params: ReliabilityTestRunParameters,
  ): Promise<ReliabilityTestRun> {
    if (!reliabilityTestId || !teamId || !params.serviceId) {
      throw new Error('reliabilityTestId, teamId, and serviceId are required to run a reliability test.');
    }

    return this.requestWithRetry<ReliabilityTestRun>(
      `reliability-tests/${reliabilityTestId}/runs`,
      {
        method: 'POST',
        params: { teamId },
        body: JSON.stringify(params),
        skipCache: true,
      },
    );
  }

  async getPendingTestRuns(serviceId: string, teamId: string): Promise<PendingReliabilityTestRun[]> {
    if (!serviceId || !teamId) {
      throw new Error('Both serviceId and teamId are required to fetch pending test runs.');
    }

    return this.requestWithRetry<PendingReliabilityTestRun[]>(
      `reliability-tests/next-runs`,
      {
        method: 'GET',
        params: { serviceId, teamId },
      },
    );
  }

  async getService(serviceId: string, teamId: string): Promise<Page<Service>> {
    return this.requestWithRetry<Page<Service>>(`services/${serviceId}`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getPricingReport(startDate: string, endDate: string, trackingPeriod?: TrackingPeriod): Promise<PricingReport> {
    if (!startDate || !endDate) {
      throw new Error('Both startDate and endDate are required to fetch the pricing report.');
    }

    const params: Record<string, string> = { startDate, endDate };
    if (trackingPeriod) {
      params.trackingPeriod = trackingPeriod;
    }

    return this.requestWithRetry<PricingReport>('reports/pricing', {
      method: 'GET',
      params,
    });
  }

  async getClientSummary(teamId: string, start: string, end: string, period: ReportPeriod): Promise<unknown> {
    if (!teamId || !start || !end || !period) {
      throw new Error('teamId, start, end, and period are all required to fetch the client summary.');
    }

    return this.requestWithRetry<unknown>('reports/clients', {
      method: 'GET',
      params: { teamId, start, end, period },
    });
  }

  async getAttackSummary(teamId: string, start: string, end: string, period: ReportPeriod): Promise<unknown> {
    if (!teamId || !start || !end || !period) {
      throw new Error('teamId, start, end, and period are all required to fetch the attack summary.');
    }

    return this.requestWithRetry<unknown>('reports/attacks', {
      method: 'GET',
      params: { teamId, start, end, period },
    });
  }

  async getSelf(): Promise<Self> {
    return this.requestWithRetry<Self>('users/self', {
      method: 'GET',
    });
  }

  async execute<T = unknown>(
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return this.requestWithRetry<T>(path, {
      method: method.toUpperCase(),
      params: queryParams,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      skipCache: true,
    });
  }

  private async requestWithRetry<T>(
    path: string,
    options: RequestInit & {
      params?: Record<string, any>;
      maxRetries?: number;
      skipCache?: boolean;
    } = {},
  ): Promise<T> {
    const { params, maxRetries = 3, skipCache = false, ...fetchOptions } = options;
    const url = new URL(`${this.baseUrl}/${path}`);

    if (params) {
      Object.keys(params).forEach(key => url.searchParams.append(key, String(params[key])));
    }

    const urlString = url.toString();
    if (!skipCache && this.cache.has(urlString)) {
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
          const body = await response.text().catch(() => '');
          const msg = body
            ? `HTTP ${response.status}: ${body}`
            : `HTTP error! status: ${response.status}`;

          if (response.status >= 400 && response.status < 500) {
            throw Object.assign(new Error(msg), { noRetry: true });
          }
          throw new Error(msg);
        }
        const responseData = await response.json() as T;

        if (!skipCache) {
          this.cache.set(urlString, responseData, { ttl: 10 * 60 * 1000 });
        }
        return responseData;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if ((lastError as any).noRetry) break;
      }
    }

    throw lastError;
  }
}
