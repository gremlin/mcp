import type { BlockList } from 'node:net';

import z from 'zod';

import { parseSourceRange, trustedSourcesFrom, type SourceRange } from './http/source-limits';

/**
 * Every Gremlin setting the server reads from its environment, validated in one pass at startup.
 *
 * <p>Each entrypoint loads its config once and passes values down; nothing else reads these
 * variables. A bad value therefore stops the server before it serves anything, with every problem
 * reported together rather than one per restart.
 *
 * <p>`OTEL_*` variables are deliberately absent: the OpenTelemetry SDK reads those to spec.
 */

export const DEFAULT_SERVICE_URL = 'https://api.gremlin.com/v1';
const DEFAULT_AUTHORIZATION_SERVER = 'https://api.gremlin.com';
const DEFAULT_PORT = 8080;

/**
 * Hard ceiling on concurrent sessions.
 *
 * <p>Each session holds an McpServer, a GremlinApi and that client's own response cache, and is
 * built on the first request rather than on demand -- so without a ceiling, N requests bearing N
 * distinct tokens allocate N of them and nothing is released until the idle reaper runs half an
 * hour later. Refusing at the limit degrades for new connections; not refusing degrades for
 * everyone.
 */
const DEFAULT_MAX_SESSIONS = 2000;

/**
 * Per-source cap on session creation. Session setup is the expensive path; reusing an established
 * session is deliberately not counted, so a legitimate client is never throttled for it.
 */
const DEFAULT_MAX_NEW_SESSIONS_PER_MINUTE = 20;

/** The same cap for a trusted source, sized for an LLM vendor's whole user base. */
const DEFAULT_MAX_NEW_SESSIONS_PER_MINUTE_TRUSTED = 1000;

/**
 * Per-source cap on credential validations that go upstream.
 *
 * <p>Only a cache miss counts, so what this bounds is a flood of distinct junk tokens, each of
 * which would otherwise cost a token exchange at the authorization server. Those exchanges all
 * leave under this server's one client identity, so without a bound one caller could spend the
 * budget every user's exchanges share. Generous for one caller: a person's client presents one
 * token, revalidated about once a minute at most.
 */
const DEFAULT_MAX_VALIDATIONS_PER_MINUTE = 60;

/**
 * The same cap for a trusted source. Below the authorization server's per-client bound, so no
 * single source -- trusted or not -- can spend all of it.
 */
const DEFAULT_MAX_VALIDATIONS_PER_MINUTE_TRUSTED = 3000;

export type Env = Record<string, string | undefined>;

export interface Loaded<T> {
  config: T;
  warnings: string[];
}

/** Every problem with the configuration, so one restart can fix them all. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface StdioConfig {
  serviceUrl: string;
  telemetry: boolean;
  apiKey: string;
}

/** What the HTTP app itself needs; see `createMcpHttpApp`. */
export interface HttpAppConfig {
  serviceUrl: string;
  resourceUrl: string;
  authorizationServer: string;
  allowedOrigins: string[];
  trustedSources: BlockList;
  maxSessions: number;
  maxNewSessionsPerMinute: number;
  maxNewSessionsPerMinuteTrusted: number;
  maxValidationsPerMinute: number;
  maxValidationsPerMinuteTrusted: number;
}

/**
 * Note what is absent: an API key. The hosted server authenticates every user with their own token
 * and must never fall back to a process-wide credential, so its config has nowhere to put one.
 */
export interface HostedConfig {
  serviceUrl: string;
  telemetry: boolean;
  port: number;
  /** Must exceed the idle timeout of any load balancer in front, or it can return 502s. */
  keepAliveTimeoutSeconds?: number;
  apiResourceUrl: string;
  oauthClientId: string;
  oauthClientSecret: string;
  app: HttpAppConfig;
}

// Messages name the rule, never the value, so a secret cannot leak through a config error.
const POSITIVE_INT = 'must be a positive whole number';

function httpUrl() {
  return z
    .string({ required_error: 'is required' })
    .refine(isHttpUrl, 'must be an http or https URL')
    .transform((url) => url.replace(/\/+$/, ''));
}

function positiveInt() {
  return z.coerce.number({ invalid_type_error: POSITIVE_INT }).int(POSITIVE_INT).positive(POSITIVE_INT);
}

const required = z.string({ required_error: 'is required' });

const list = z.string().optional().transform(splitList);

const sourceRanges = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const ranges: SourceRange[] = [];
    for (const entry of splitList(value)) {
      const range = parseSourceRange(entry);
      // The one setting whose errors name the value: an index into a list is slow to act on, and
      // these ranges are not secret.
      if (range) ranges.push(range);
      else ctx.addIssue({ code: 'custom', message: `has "${entry}", which is not an IP address or CIDR range` });
    }
    return trustedSourcesFrom(ranges);
  });

const shared = {
  GREMLIN_SERVICE_URL: httpUrl().default(DEFAULT_SERVICE_URL),
  // Optional, so an unrecognised value warns and leaves telemetry off rather than stopping the server.
  GREMLIN_MCP_ENABLE_TELEMETRY: z.string().optional(),
};

const stdioShape = {
  ...shared,
  GREMLIN_API_KEY: required,
};

const hostedShape = {
  ...shared,
  PORT: z.coerce
    .number({ invalid_type_error: 'must be a port number (1-65535)' })
    .int('must be a port number (1-65535)')
    .min(1, 'must be a port number (1-65535)')
    .max(65535, 'must be a port number (1-65535)')
    .default(DEFAULT_PORT),
  GREMLIN_MCP_KEEP_ALIVE_TIMEOUT_SECONDS: positiveInt().optional(),
  /**
   * This server's RFC 9728 resource identifier, which Claude echoes to the authorization server as
   * the token's audience. No default: one that disagrees with the URL the user typed surfaces as a
   * discovery failure with no obvious cause. Host-only, because the metadata document is served at
   * the root and RFC 9728 would put an identifier with a path somewhere else.
   */
  GREMLIN_MCP_RESOURCE_URL: httpUrl().refine(
    isOrigin,
    'must be a bare origin (scheme, host and optional port; no path, query, fragment or credentials)',
  ),
  GREMLIN_AUTHORIZATION_SERVER: httpUrl().default(DEFAULT_AUTHORIZATION_SERVER),
  /** The audience requested when exchanging: the Gremlin API, distinct from this server. */
  GREMLIN_API_RESOURCE_URL: httpUrl().default(DEFAULT_AUTHORIZATION_SERVER),
  GREMLIN_MCP_OAUTH_CLIENT_ID: required,
  GREMLIN_MCP_OAUTH_CLIENT_SECRET: required,
  GREMLIN_MCP_ALLOWED_ORIGINS: list,
  GREMLIN_MCP_TRUSTED_SOURCE_CIDRS: sourceRanges,
  GREMLIN_MCP_MAX_SESSIONS: positiveInt().default(DEFAULT_MAX_SESSIONS),
  GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE: positiveInt().default(DEFAULT_MAX_NEW_SESSIONS_PER_MINUTE),
  GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE_TRUSTED: positiveInt().default(
    DEFAULT_MAX_NEW_SESSIONS_PER_MINUTE_TRUSTED,
  ),
  GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE: positiveInt().default(DEFAULT_MAX_VALIDATIONS_PER_MINUTE),
  GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE_TRUSTED: positiveInt().default(
    DEFAULT_MAX_VALIDATIONS_PER_MINUTE_TRUSTED,
  ),
};

/** Config for the locally-run stdio server. */
export function loadStdioConfig(env: Env): Loaded<StdioConfig> {
  return load(stdioShape, env, (vars, warnings) => ({
    serviceUrl: vars.GREMLIN_SERVICE_URL,
    telemetry: telemetryFlag(vars.GREMLIN_MCP_ENABLE_TELEMETRY, warnings),
    apiKey: vars.GREMLIN_API_KEY,
  }));
}

/** Config for the hosted HTTP server. */
export function loadHostedConfig(env: Env): Loaded<HostedConfig> {
  return load(hostedShape, env, (vars, warnings) => {
    if (env.GREMLIN_API_KEY?.trim()) {
      warnings.push('GREMLIN_API_KEY is ignored: the hosted server authenticates each user with OAuth');
    }
    return {
      serviceUrl: vars.GREMLIN_SERVICE_URL,
      telemetry: telemetryFlag(vars.GREMLIN_MCP_ENABLE_TELEMETRY, warnings),
      port: vars.PORT,
      keepAliveTimeoutSeconds: vars.GREMLIN_MCP_KEEP_ALIVE_TIMEOUT_SECONDS,
      apiResourceUrl: vars.GREMLIN_API_RESOURCE_URL,
      oauthClientId: vars.GREMLIN_MCP_OAUTH_CLIENT_ID,
      oauthClientSecret: vars.GREMLIN_MCP_OAUTH_CLIENT_SECRET,
      app: {
        serviceUrl: vars.GREMLIN_SERVICE_URL,
        resourceUrl: vars.GREMLIN_MCP_RESOURCE_URL,
        authorizationServer: vars.GREMLIN_AUTHORIZATION_SERVER,
        allowedOrigins: vars.GREMLIN_MCP_ALLOWED_ORIGINS,
        trustedSources: vars.GREMLIN_MCP_TRUSTED_SOURCE_CIDRS,
        maxSessions: vars.GREMLIN_MCP_MAX_SESSIONS,
        maxNewSessionsPerMinute: vars.GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE,
        maxNewSessionsPerMinuteTrusted: vars.GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE_TRUSTED,
        maxValidationsPerMinute: vars.GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE,
        maxValidationsPerMinuteTrusted: vars.GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE_TRUSTED,
      },
    };
  });
}

/**
 * Loads config from the process environment, printing warnings, or reports every problem and
 * exits. For entrypoints only.
 */
export function loadOrExit<T>(loader: (env: Env) => Loaded<T>): T {
  try {
    const { config, warnings } = loader(process.env);
    for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
    return config;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

function load<S extends z.ZodRawShape, T>(
  shape: S,
  env: Env,
  build: (vars: z.output<z.ZodObject<S>>, warnings: string[]) => T,
): Loaded<T> {
  // Blank and whitespace-only values mean unset, as they always have.
  const vars = Object.fromEntries(
    Object.entries(env)
      .map(([name, value]) => [name, value?.trim()])
      .filter(([, value]) => value),
  );

  const result = z.object(shape).safeParse(vars);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`));
  }

  // Only the MCP-specific prefix: GREMLIN_* alone is shared with the agent and other tooling.
  const warnings = Object.keys(vars)
    .filter((name) => name.startsWith('GREMLIN_MCP_') && !(name in shape))
    .map((name) => `${name} is not a setting this server uses; check the spelling`);

  return { config: build(result.data, warnings), warnings };
}

function telemetryFlag(value: string | undefined, warnings: string[]): boolean {
  const normalised = value?.toLowerCase();
  if (normalised === undefined || normalised === '0' || normalised === 'false') return false;
  if (normalised === '1' || normalised === 'true') return true;
  warnings.push('GREMLIN_MCP_ENABLE_TELEMETRY should be 1, true, 0 or false; telemetry is off');
  return false;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// Exact match, because even an empty `?` or `#` would swallow the metadata path appended to it.
// zod still runs this after a failed URL check, which has already reported the problem.
function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return true;
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
