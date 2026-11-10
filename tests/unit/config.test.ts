import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  ConfigError,
  DEFAULT_SERVICE_URL,
  loadHostedConfig,
  loadOrExit,
  loadStdioConfig,
  type Env,
} from '../../src/config';
import { isTrustedSource } from '../../src/http/source-limits';

const HOSTED: Env = {
  GREMLIN_MCP_RESOURCE_URL: 'https://mcp.gremlin.com',
  GREMLIN_MCP_OAUTH_CLIENT_ID: 'client-id',
  GREMLIN_MCP_OAUTH_CLIENT_SECRET: 'client-secret',
};

/** The problems a load reports, or an empty list when it succeeds. */
function problems(load: () => unknown): string[] {
  try {
    load();
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe('loadStdioConfig', () => {
  it('needs only an API key, defaulting everything else', () => {
    const { config, warnings } = loadStdioConfig({ GREMLIN_API_KEY: 'key' });

    expect(config).toEqual({ apiKey: 'key', serviceUrl: DEFAULT_SERVICE_URL, telemetry: false });
    expect(warnings).toEqual([]);
  });

  it('requires an API key, treating a blank one as missing', () => {
    expect(problems(() => loadStdioConfig({}))).toEqual(['GREMLIN_API_KEY is required']);
    expect(problems(() => loadStdioConfig({ GREMLIN_API_KEY: '  ' }))).toEqual([
      'GREMLIN_API_KEY is required',
    ]);
  });

  it('trims the service URL and its trailing slashes, and falls back when blank', () => {
    const load = (url: string) =>
      loadStdioConfig({ GREMLIN_API_KEY: 'key', GREMLIN_SERVICE_URL: url }).config.serviceUrl;

    expect(load('  https://api.staging.gremlin.com/v1//  ')).toBe('https://api.staging.gremlin.com/v1');
    expect(load('   ')).toBe(DEFAULT_SERVICE_URL);
  });

  it('rejects a service URL that is not http(s)', () => {
    for (const url of ['api.gremlin.com/v1', 'ftp://api.gremlin.com/v1']) {
      expect(problems(() => loadStdioConfig({ GREMLIN_API_KEY: 'key', GREMLIN_SERVICE_URL: url }))).toEqual([
        'GREMLIN_SERVICE_URL must be an http or https URL',
      ]);
    }
  });

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
  ])('reads GREMLIN_MCP_ENABLE_TELEMETRY=%s as %s', (value, expected) => {
    const { config, warnings } = loadStdioConfig({
      GREMLIN_API_KEY: 'key',
      GREMLIN_MCP_ENABLE_TELEMETRY: value,
    });
    expect(config.telemetry).toBe(expected);
    expect(warnings).toEqual([]);
  });

  it('warns and leaves telemetry off for a value it does not recognise, rather than stopping', () => {
    // Telemetry is optional, so a bad flag must not keep a local user's server from starting.
    const { config, warnings } = loadStdioConfig({
      GREMLIN_API_KEY: 'key',
      GREMLIN_MCP_ENABLE_TELEMETRY: 'yes',
    });

    expect(config.telemetry).toBe(false);
    expect(warnings).toEqual([expect.stringContaining('GREMLIN_MCP_ENABLE_TELEMETRY')]);
  });
});

describe('loadHostedConfig', () => {
  it('applies the documented defaults', () => {
    const { config, warnings } = loadHostedConfig(HOSTED);

    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      serviceUrl: DEFAULT_SERVICE_URL,
      telemetry: false,
      port: 8080,
      keepAliveTimeoutSeconds: undefined,
      apiResourceUrl: 'https://api.gremlin.com',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      app: {
        serviceUrl: DEFAULT_SERVICE_URL,
        resourceUrl: 'https://mcp.gremlin.com',
        authorizationServer: 'https://api.gremlin.com',
        allowedOrigins: [],
        maxSessions: 2000,
        maxNewSessionsPerMinute: 20,
        maxNewSessionsPerMinuteTrusted: 1000,
        maxValidationsPerMinute: 60,
        maxValidationsPerMinuteTrusted: 3000,
      },
    });
    expect(isTrustedSource(config.app.trustedSources, '160.79.104.1')).toBe(false);
  });

  it('reads every setting it is given', () => {
    const { config } = loadHostedConfig({
      ...HOSTED,
      PORT: '9090',
      GREMLIN_MCP_KEEP_ALIVE_TIMEOUT_SECONDS: '65',
      GREMLIN_AUTHORIZATION_SERVER: 'https://auth.staging.gremlin.com/',
      GREMLIN_API_RESOURCE_URL: 'https://api.staging.gremlin.com/',
      GREMLIN_MCP_ALLOWED_ORIGINS: 'http://localhost:6274, http://localhost:3000',
      GREMLIN_MCP_TRUSTED_SOURCE_CIDRS: '160.79.104.0/21, 2001:db8::/32',
      GREMLIN_MCP_MAX_SESSIONS: '10',
      GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE: '1',
      GREMLIN_MCP_MAX_NEW_SESSIONS_PER_MINUTE_TRUSTED: '2',
      GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE: '3',
      GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE_TRUSTED: '4',
    });

    expect(config).toMatchObject({
      port: 9090,
      keepAliveTimeoutSeconds: 65,
      apiResourceUrl: 'https://api.staging.gremlin.com',
      app: {
        authorizationServer: 'https://auth.staging.gremlin.com',
        allowedOrigins: ['http://localhost:6274', 'http://localhost:3000'],
        maxSessions: 10,
        maxNewSessionsPerMinute: 1,
        maxNewSessionsPerMinuteTrusted: 2,
        maxValidationsPerMinute: 3,
        maxValidationsPerMinuteTrusted: 4,
      },
    });
    expect(isTrustedSource(config.app.trustedSources, '160.79.107.200')).toBe(true);
    expect(isTrustedSource(config.app.trustedSources, '2001:db8::1')).toBe(true);
  });

  it('reports every problem at once, so one restart can fix them all', () => {
    expect(
      problems(() =>
        loadHostedConfig({
          PORT: '70000',
          GREMLIN_MCP_MAX_SESSIONS: 'lots',
          GREMLIN_MCP_TRUSTED_SOURCE_CIDRS: '10.0.0.0/8, not-a-range',
        }),
      ),
    ).toEqual([
      'PORT must be a port number (1-65535)',
      'GREMLIN_MCP_RESOURCE_URL is required',
      'GREMLIN_MCP_OAUTH_CLIENT_ID is required',
      'GREMLIN_MCP_OAUTH_CLIENT_SECRET is required',
      'GREMLIN_MCP_TRUSTED_SOURCE_CIDRS has "not-a-range", which is not an IP address or CIDR range',
      'GREMLIN_MCP_MAX_SESSIONS must be a positive whole number',
    ]);
  });

  it.each(['0', '-5', '1.5', 'abc', 'Infinity'])(
    'stops rather than silently defaulting a limit set to %s',
    (value) => {
      // A typo in a deploy's values used to fall back to the default unnoticed.
      expect(problems(() => loadHostedConfig({ ...HOSTED, GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE: value }))).toEqual([
        'GREMLIN_MCP_MAX_VALIDATIONS_PER_MINUTE must be a positive whole number',
      ]);
    },
  );

  it('normalises a trailing slash on the resource identifier so it is byte-stable', () => {
    // `https://x` and `https://x/` are different audiences under exact comparison.
    const { config } = loadHostedConfig({ ...HOSTED, GREMLIN_MCP_RESOURCE_URL: 'https://mcp.gremlin.com/' });
    expect(config.app.resourceUrl).toBe('https://mcp.gremlin.com');
  });

  it.each([
    'https://gremlin.com/mcp',
    'https://mcp.gremlin.com?',
    'https://mcp.gremlin.com?x=1',
    'https://mcp.gremlin.com#release',
    'https://user:pass@mcp.gremlin.com',
  ])('rejects %s as a resource identifier, which discovery would never find', (url) => {
    // buildChallenge appends the metadata path, which a path, query or fragment would misplace.
    expect(problems(() => loadHostedConfig({ ...HOSTED, GREMLIN_MCP_RESOURCE_URL: url }))).toEqual([
      expect.stringMatching(/^GREMLIN_MCP_RESOURCE_URL must be a bare origin/),
    ]);
  });

  it('accepts an origin with a port, as local development uses', () => {
    const { config } = loadHostedConfig({ ...HOSTED, GREMLIN_MCP_RESOURCE_URL: 'http://localhost:8080' });
    expect(config.app.resourceUrl).toBe('http://localhost:8080');
  });

  it('reports a malformed resource identifier once', () => {
    expect(problems(() => loadHostedConfig({ ...HOSTED, GREMLIN_MCP_RESOURCE_URL: 'mcp.gremlin.com' }))).toEqual([
      'GREMLIN_MCP_RESOURCE_URL must be an http or https URL',
    ]);
  });

  it('never repeats a URL or number value in a problem, so a misplaced secret stays out of the logs', () => {
    const secret = 'gremlin_osc_super_secret';
    const reported = problems(() =>
      loadHostedConfig({
        ...HOSTED,
        GREMLIN_SERVICE_URL: secret,
        GREMLIN_AUTHORIZATION_SERVER: secret,
        GREMLIN_MCP_MAX_SESSIONS: secret,
        PORT: secret,
      }),
    );

    expect(reported).toHaveLength(4);
    expect(reported.join('\n')).not.toContain(secret);
  });

  it('warns about an API key it will never use', () => {
    const { warnings } = loadHostedConfig({ ...HOSTED, GREMLIN_API_KEY: 'key' });
    expect(warnings).toEqual([expect.stringContaining('GREMLIN_API_KEY is ignored')]);
  });

  it('warns about a misspelt setting, but not about GREMLIN_* variables other tools own', () => {
    const { warnings } = loadHostedConfig({
      ...HOSTED,
      GREMLIN_MCP_MAX_SESION: '10',
      GREMLIN_TEAM_ID: 'team',
    });
    expect(warnings).toEqual([expect.stringContaining('GREMLIN_MCP_MAX_SESION')]);
  });
});

describe('loadOrExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('prints every problem and exits non-zero', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited');
    });
    vi.stubEnv('GREMLIN_API_KEY', '');

    expect(() => loadOrExit(loadStdioConfig)).toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith('Invalid configuration:\n  GREMLIN_API_KEY is required\n');
  });

  it('prints warnings and returns the config', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('GREMLIN_API_KEY', 'key');
    vi.stubEnv('GREMLIN_MCP_ENABLE_TELEMETRY', 'maybe');

    expect(loadOrExit(loadStdioConfig).apiKey).toBe('key');
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^Warning: GREMLIN_MCP_ENABLE_TELEMETRY/));
  });
});
