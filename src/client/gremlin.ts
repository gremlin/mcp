import TTLCache from '@isaacs/ttlcache';
import { getServiceUrl } from '../config';


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

export interface ContainerSummary {
  id: string;
  clientId: string;
  name: string;
  labels: Record<string, string>;
}

export interface ContainerMatchResponse {
  matchedContainers: ContainerSummary[];
  totalContainerCount: number;
}

export interface LabelKeysResponse {
  labelKeys: string[];
}

// Exactly one of isAll, ids, or multiSelectLabels must be set — enforced
// server-side (400) and mirrored client-side in matchContainers below so
// callers get a clear error before making the request.
export interface ContainerSelectorRequest {
  isAll?: boolean;
  ids?: string[];
  multiSelectLabels?: Record<string, string[]>;
}

export interface User { }

export interface Team {
  identifier: string;
  name: string;
  companyId: string;
  production: boolean;
}

export interface GremlinApiResult {
  status: number;
  contentType: string | null;
  /** True when `body` is parsed JSON; false when it's the raw response text. */
  isJsonBody: boolean;
  body: unknown;
}

// True for `application/json` and the `+json` media-type suffix convention
// (RFC 6839, e.g. `application/problem+json`), ignoring any `; charset=...` parameter.
export function isJsonContentTypeHeader(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/**
 * Thrown for every failure GremlinApi can produce — a real error response
 * from api.gremlin.com, a response that didn't match the shape we assumed,
 * or a transport failure below that. `isInputError` classifies whether a
 * tool-calling model could plausibly fix this by changing its arguments.
 *
 * It has no default: every construction site must pass it explicitly. A
 * default would let a throw site slip through unclassified, and silently
 * telling a model to retry a failure retrying can never fix (or the
 * reverse) is worse than forcing the decision at the call site.
 */
export class GremlinApiError extends Error {
  readonly isInputError: boolean;
  readonly statusCode?: number;
  /** Internal to the retry loops below — not surfaced to tool callers. */
  readonly noRetry: boolean;

  constructor(
    message: string,
    { isInputError, statusCode, noRetry = false }: { isInputError: boolean; statusCode?: number; noRetry?: boolean },
  ) {
    super(message);
    this.name = 'GremlinApiError';
    this.isInputError = isInputError;
    this.statusCode = statusCode;
    this.noRetry = noRetry;
  }
}

// Throws a GremlinApiError (isInputError: true) when a required parameter is
// missing. A plain Error here would be structurally indistinguishable from a
// systemic failure, wrongly telling a tool-calling model that supplying the
// missing argument can't fix the failure. Exported so tool handlers can use
// the same helper for their own pre-call argument checks, instead of each
// hand-rolling the same `throw new GremlinApiError(msg, { isInputError: true })`.
export function assertRequiredParams(isValid: boolean, message: string): void {
  if (isValid) return;
  throw new GremlinApiError(message, { isInputError: true });
}

/**
 * Prefixes a caught error's message for re-throwing, preserving its
 * classification if it's a `GremlinApiError`. Every tool handler that calls
 * into `GremlinApi` re-wraps the error with a friendlier, tool-specific
 * message; without this, that re-wrap would collapse a classified
 * `GremlinApiError` into a plain `Error`, losing `isInputError`/`statusCode`
 * before it ever reaches the tool result.
 */
export function wrapGremlinError(prefix: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GremlinApiError) {
    return new GremlinApiError(`${prefix}: ${message}`, {
      isInputError: error.isInputError,
      statusCode: error.statusCode,
      noRetry: error.noRetry,
    });
  }
  return new Error(`${prefix}: ${message}`);
}

// 4xx codes that don't indicate a problem with the caller's arguments:
// auth/permission failures, billing/plan issues, and rate limits aren't
// fixable by changing input. Confirmed against the real Gremlin API spec:
// 402 appears on POST /scenarios and others as "Payment Required".
const NON_INPUT_ERROR_STATUS_CODES = new Set([401, 402, 403, 429]);

// Builds the error thrown for a non-2xx response. Beyond the status and raw
// body, the message tells the caller (an LLM driving this tool) whether the
// failure can plausibly be fixed by changing its arguments — without this,
// a tool-calling model can't distinguish a bad request from a systemic
// failure and tends to retry the same call indefinitely.
function buildHttpError(status: number, body: string): GremlinApiError {
  const base = body ? `HTTP ${status}: ${body}` : `HTTP error! status: ${status}`;
  const isNonInputError = NON_INPUT_ERROR_STATUS_CODES.has(status);
  const isInputError = status >= 400 && status < 500 && !isNonInputError;

  const guidance = status >= 500
    ? ' This is a server-side error, not a problem with your input — do not retry with different arguments; report the failure instead.'
    : isNonInputError
      ? ' This is an authentication, authorization, billing, or rate-limit error — it cannot be fixed by changing tool arguments.'
      : isInputError
        ? ' Check the arguments you provided and retry with corrected input.'
        : '';

  // 4xx errors are client-side; retrying the same request within this loop won't help.
  const noRetry = status >= 400 && status < 500;
  return new GremlinApiError(`${base}${guidance}`, { isInputError, statusCode: status, noRetry });
}

export class GremlinApi {
  private baseUrl: string = getServiceUrl();
  private userAgent = "@gremlin/gremlin-mcp/2.4.0";
  private cache = new TTLCache<string, unknown>();

  async listUsers(): Promise<User[]> {
    return this.jsonRequestWithRetry<User[]>('users', {
      method: 'GET',
    });
  }

  async listTeams(): Promise<Team[]> {
    return this.jsonRequestWithRetry<Team[]>('teams', {
      method: 'GET',
    });
  }

  async getTeam(teamId: string): Promise<Team> {
    assertRequiredParams(Boolean(teamId), 'teamId is required to fetch the team details.');
    return this.jsonRequestWithRetry<Team>(`teams/${teamId}`, {
      method: 'GET',
    });
  }

  async listTeamsForCompany(): Promise<Team[]> {
    return this.jsonRequestWithRetry<Team[]>('teams', {
      method: 'GET',
    });
  }

  async listServicesForTeam(teamId: string): Promise<Page<Service>> {
    return this.jsonRequestWithRetry<Page<Service>>(`services`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getReliabilityReport(serviceId: string, teamId: string, date?: string): Promise<ReliabilityReport> {
    assertRequiredParams(
      Boolean(serviceId) && Boolean(teamId),
      'Both serviceId and teamId are required to fetch the reliability report.',
    );

    const params: Record<string, any> = { teamId };
    if (date && date !== 'undefined') {
      params.date = date;
    }

    return this.jsonRequestWithRetry<ReliabilityReport>(`policies/${serviceId}/reliability-report`, {
      method: 'GET',
      params,
    });
  }

  async getServiceDependencies(serviceId: string, teamId: string): Promise<ReliabilityReport> {
    assertRequiredParams(
      Boolean(serviceId) && Boolean(teamId),
      'Both serviceId and teamId are required to fetch the service dependencies.',
    );

    return this.jsonRequestWithRetry<ReliabilityReport>(`services/${serviceId}/dependencies`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getServiceStatusChecks(serviceId: string, teamId: string): Promise<ReliabilityReport> {
    assertRequiredParams(
      Boolean(serviceId) && Boolean(teamId),
      'Both serviceId and teamId are required to fetch the service status checks.',
    );
    return this.jsonRequestWithRetry<ReliabilityReport>(`services/${serviceId}/status-checks`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getServiceRisks(serviceId: string, teamId: string): Promise<ReliabilityReport> {
    assertRequiredParams(
      Boolean(serviceId) && Boolean(teamId),
      'Both serviceId and teamId are required to fetch the service risks.',
    );
    return this.jsonRequestWithRetry<ReliabilityReport>(`services/${serviceId}/risk-summary`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getAllTestSuite(): Promise<ReliabilityTestSuite[]> {
    return this.jsonRequestWithRetry<ReliabilityTestSuite[]>(`test-suites`, {
      method: 'GET',
    });
  }

  async getRecentReliabilityTests(teamId: string, limit: number = 5, pageToken?: string): Promise<Page<RecentRunResponse>> {
    const params: Record<string, any> = { teamId, pageSize: limit };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    return this.jsonRequestWithRetry<Page<RecentRunResponse>>(`reliability-tests/completed/paged`, {
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
    assertRequiredParams(
      Boolean(serviceId) && Boolean(teamId),
      'Both serviceId and teamId are required to fetch the reliability experiment.',
    );

    const params: Record<string, any> = { teamId, serviceId, pageSize: limit };
    if (dependencyId) params.dependencyId = dependencyId;

    const path = testId ? `reliability-tests/${testId}/runs` : `reliability-tests/runs`;

    return this.jsonRequestWithRetry<Page<ReliabilityTestRun> | ReliabilityTestRun>(path, {
      method: 'GET',
      params,
    });
  }

  async runReliabilityTest(
    reliabilityTestId: string,
    teamId: string,
    params: ReliabilityTestRunParameters,
  ): Promise<ReliabilityTestRun> {
    assertRequiredParams(
      Boolean(reliabilityTestId) && Boolean(teamId) && Boolean(params.serviceId),
      'reliabilityTestId, teamId, and serviceId are required to run a reliability test.',
    );

    return this.jsonRequestWithRetry<ReliabilityTestRun>(
      `reliability-tests/${reliabilityTestId}/runs`,
      {
        method: 'POST',
        params: { teamId },
        body: JSON.stringify(params),
        skipCache: true,
      },
    );
  }

  async getPendingTestRuns(
    serviceId: string,
    teamId: string,
  ): Promise<PendingReliabilityTestRun[]> {
    assertRequiredParams(
      Boolean(serviceId) && Boolean(teamId),
      'Both serviceId and teamId are required to fetch pending test runs.',
    );

    return this.jsonRequestWithRetry<PendingReliabilityTestRun[]>(
      `reliability-tests/next-runs`,
      {
        method: 'GET',
        params: { serviceId, teamId },
      },
    );
  }

  async getService(serviceId: string, teamId: string): Promise<Page<Service>> {
    return this.jsonRequestWithRetry<Page<Service>>(`services/${serviceId}`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async getPricingReport(startDate: string, endDate: string, trackingPeriod?: TrackingPeriod): Promise<PricingReport> {
    assertRequiredParams(
      Boolean(startDate) && Boolean(endDate),
      'Both startDate and endDate are required to fetch the pricing report.',
    );

    const params: Record<string, string> = { startDate, endDate };
    if (trackingPeriod) {
      params.trackingPeriod = trackingPeriod;
    }

    return this.jsonRequestWithRetry<PricingReport>('reports/pricing', {
      method: 'GET',
      params,
    });
  }

  async getClientSummary(teamId: string, start: string, end: string, period: ReportPeriod): Promise<unknown> {
    assertRequiredParams(
      Boolean(teamId) && Boolean(start) && Boolean(end) && Boolean(period),
      'teamId, start, end, and period are all required to fetch the client summary.',
    );

    return this.jsonRequestWithRetry<unknown>('reports/clients', {
      method: 'GET',
      params: { teamId, start, end, period },
    });
  }

  async getAttackSummary(teamId: string, start: string, end: string, period: ReportPeriod): Promise<unknown> {
    assertRequiredParams(
      Boolean(teamId) && Boolean(start) && Boolean(end) && Boolean(period),
      'teamId, start, end, and period are all required to fetch the attack summary.',
    );

    return this.jsonRequestWithRetry<unknown>('reports/attacks', {
      method: 'GET',
      params: { teamId, start, end, period },
    });
  }

  async getSelf(): Promise<Self> {
    return this.jsonRequestWithRetry<Self>('users/self', {
      method: 'GET',
    });
  }

  async getContainer(containerId: string, teamId: string): Promise<ContainerSummary> {
    assertRequiredParams(
      Boolean(containerId) && Boolean(teamId),
      'Both containerId and teamId are required to fetch a container.',
    );
    return this.jsonRequestWithRetry<ContainerSummary>(`containers/${encodeURIComponent(containerId)}`, {
      method: 'GET',
      params: { teamId },
    });
  }

  async matchContainers(teamId: string, selector: ContainerSelectorRequest): Promise<ContainerMatchResponse> {
    assertRequiredParams(Boolean(teamId), 'teamId is required to preview a container match.');

    const fieldsSet = [selector.isAll === true, selector.ids !== undefined, selector.multiSelectLabels !== undefined]
      .filter(Boolean).length;
    assertRequiredParams(fieldsSet === 1, 'Exactly one of isAll, ids, or multiSelectLabels must be set.');

    return this.jsonRequestWithRetry<ContainerMatchResponse>('containers/match', {
      method: 'POST',
      params: { teamId },
      body: JSON.stringify(selector),
      skipCache: true, // preview endpoint — always reflect current container state
    });
  }

  async getContainerLabelKeys(teamId: string): Promise<LabelKeysResponse> {
    assertRequiredParams(Boolean(teamId), 'teamId is required to fetch container label keys.');
    return this.jsonRequestWithRetry<LabelKeysResponse>('containers/labels', {
      method: 'GET',
      params: { teamId },
    });
  }

  /**
   * Runs an arbitrary Gremlin API endpoint (backs execute_gremlin_api). Unlike
   * every typed method above — which can assume a JSON response — an arbitrary
   * call may return a non-JSON body (e.g. a bare-text UUID from a POST that
   * creates a resource), so this inspects content-type before deciding whether
   * to parse it, rather than assuming JSON and failing opaquely.
   */
  async execute(
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<GremlinApiResult> {
    const response = await this.fetchWithRetry(path, {
      method: method.toUpperCase(),
      params: queryParams,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const contentType = response.headers.get('content-type');
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The request itself succeeded (2xx); this is a failure to read the
      // body afterward (e.g. a connection reset mid-stream) — not something
      // the caller's arguments could have caused.
      throw new GremlinApiError(
        `Failed to read the Gremlin API response body: ${error instanceof Error ? error.message : String(error)}. ` +
        'This is not caused by your input — do not retry with different arguments; report the failure instead.',
        { isInputError: false, statusCode: response.status },
      );
    }

    if (isJsonContentTypeHeader(contentType)) {
      try {
        return { status: response.status, contentType, isJsonBody: true, body: JSON.parse(text) };
      } catch (e) {
        console.error(`GremlinApi#execute: labeled JSON but not parseable: falling back to raw text: ${e}`);
      }
    }

    return { status: response.status, contentType, isJsonBody: false, body: text };
  }

  private buildUrl(path: string, params?: Record<string, any>): string {
    const url = new URL(`${this.baseUrl}/${path}`);
    if (params) {
      Object.keys(params).forEach(key => url.searchParams.append(key, String(params[key])));
    }
    return url.toString();
  }

  /**
   * Makes a single fetch attempt (no retry) and returns the raw `ok`
   * response, doing no body-reading or parsing. The single attempt inside
   * `fetchWithRetry`'s loop.
   */
  private async fetchOnce(
    path: string,
    options: RequestInit & { params?: Record<string, any> } = {},
  ): Promise<Response> {
    const { params, ...fetchOptions } = options;
    const urlString = this.buildUrl(path, params);

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
      throw buildHttpError(response.status, body);
    }
    return response;
  }

  // A GremlinApiError from fetchOnce (via buildHttpError) is already
  // classified; anything else is a transport-level failure (DNS, connection
  // reset, timeout) that never reached api.gremlin.com at all — not something
  // the caller's arguments could have caused, so it's classified the same
  // way rather than letting a bare, unlabeled error reach the tool-calling
  // model.
  private classifyRetryError(error: unknown): GremlinApiError {
    if (error instanceof GremlinApiError) return error;
    return new GremlinApiError(
      `Network error calling the Gremlin API: ${error instanceof Error ? error.message : String(error)}. ` +
      'This is not caused by your input — do not retry with different arguments; report the failure instead.',
      { isInputError: false },
    );
  }

  /**
   * Fetches with retry and returns the raw `ok` response, doing no parsing.
   * Used by `execute`, which must not assume a JSON body.
   */
  private async fetchWithRetry(
    path: string,
    options: RequestInit & {
      params?: Record<string, any>;
      maxRetries?: number;
    } = {},
  ): Promise<Response> {
    const { maxRetries = 3, ...rest } = options;

    let lastError: GremlinApiError | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.fetchOnce(path, rest);
      } catch (error) {
        lastError = this.classifyRetryError(error);
        if (lastError.noRetry) break;
      }
    }

    throw lastError;
  }

  /**
   * Like `fetchWithRetry`, but also reads and parses the response as JSON
   * (throwing a clear error, rather than a bare SyntaxError, if the body
   * turns out not to be parseable) and caches the result. Used by every
   * typed method, which can assume the Gremlin API always returns JSON for
   * these endpoints.
   *
   * Deliberately delegates to `fetchWithRetry` for a single attempt and does
   * not retry the parse itself: unlike a network/HTTP-status failure, a
   * successfully-received-but-unparseable body isn't a transient condition a
   * fresh request would fix, and the error thrown below already tells the
   * caller not to retry. Matches psyduck's reference implementation
   * (`jsonRequestWithRetry` = `fetchWithRetry` + one `parseJsonBody` call).
   */
  private async jsonRequestWithRetry<T>(
    path: string,
    options: RequestInit & {
      params?: Record<string, any>;
      maxRetries?: number;
      skipCache?: boolean;
    } = {},
  ): Promise<T> {
    const { params, skipCache = false, ...rest } = options;
    const urlString = this.buildUrl(path, params);

    if (!skipCache && this.cache.has(urlString)) {
      return this.cache.get(urlString) as T;
    }

    const response = await this.fetchWithRetry(path, { params, ...rest });
    const text = await response.text();

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      const preview = text.slice(0, 500);
      throw new GremlinApiError(
        `Expected a JSON response body from the Gremlin API but received (HTTP ${response.status})` +
        `${preview ? `: ${preview}` : ' an empty body'}. This is not caused by your input — do not retry with different arguments; report the failure instead.`,
        { isInputError: false, statusCode: response.status },
      );
    }

    if (!skipCache) {
      this.cache.set(urlString, data, { ttl: 10 * 60 * 1000 }); // Cache for 10 minutes
    }
    return data;
  }
}
