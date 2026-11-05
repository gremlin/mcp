import { describe, it, expect } from 'vitest';

import {
  bearerTokenFrom,
  buildChallenge,
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_PATH,
} from '../../src/auth/protected-resource';

const RESOURCE = 'https://mcp.gremlin.com';
const CONFIG = { resourceUrl: RESOURCE, authorizationServer: 'https://api.gremlin.com' };

describe('protected resource metadata', () => {
  it('points at the authorization server that issues its tokens', () => {
    const metadata = buildProtectedResourceMetadata(CONFIG);

    expect(metadata.resource).toBe(RESOURCE);
    expect(metadata.authorization_servers).toEqual(['https://api.gremlin.com']);
  });

  it('accepts bearer tokens in the header only', () => {
    // Query-parameter tokens end up in access logs and browser history.
    expect(buildProtectedResourceMetadata(CONFIG).bearer_methods_supported).toEqual(['header']);
  });

  it('advertises only the scopes this server actually needs', () => {
    // The MCP specification calls this the minimal set for basic functionality. offline_access is
    // deliberately absent: Claude appends it itself from the authorization server's metadata when
    // that server offers it, so listing it here would request a refresh token from organizations
    // whose session policy declines them.
    expect(buildProtectedResourceMetadata(CONFIG).scopes_supported).toEqual(['gremlin:full']);
  });

  it('carries no credential material', () => {
    const raw = JSON.stringify(buildProtectedResourceMetadata(CONFIG));
    expect(raw).not.toContain('gremlin_oat_');
    expect(raw).not.toContain('gremlin_osc_');
  });
});

describe('buildChallenge', () => {
  it('always names where to find the metadata document', () => {
    // RFC 9728 section 5.1. Without this parameter a 401 leaves the client with nowhere to go, and
    // the connection fails with no diagnostics.
    expect(buildChallenge(RESOURCE)).toBe(
      `Bearer resource_metadata="${RESOURCE}${PROTECTED_RESOURCE_PATH}", scope="gremlin:full"`,
    );
  });

  it('names the scopes it needs, so the consent prompt is not the whole catalogue', () => {
    // Claude reads this in preference to the metadata document, and it is the entry point to the
    // step-up flow that makes narrow scopes usable once there is more than one of them.
    expect(buildChallenge(RESOURCE)).toContain('scope="gremlin:full"');
    expect(buildChallenge(RESOURCE, 'invalid_token', 'expired')).toContain('scope="gremlin:full"');
  });

  it('reports invalid_token so a client knows to refresh rather than re-consent', () => {
    const challenge = buildChallenge(RESOURCE, 'invalid_token', 'The access token expired');

    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('error_description="The access token expired"');
    expect(challenge).toContain(`resource_metadata="${RESOURCE}${PROTECTED_RESOURCE_PATH}"`);
  });

  it('escapes a description so it cannot break out of the quoted string', () => {
    const challenge = buildChallenge(RESOURCE, 'invalid_token', 'say "hi" \\ bye');

    expect(challenge).toContain('error_description="say \\"hi\\" \\\\ bye"');
  });
});

describe('bearerTokenFrom', () => {
  it('extracts a bearer token', () => {
    expect(bearerTokenFrom('Bearer gremlin_oat_abc')).toBe('gremlin_oat_abc');
  });

  it('is case-insensitive about the scheme name', () => {
    // RFC 9110 makes the scheme token case-insensitive; clients do vary here.
    expect(bearerTokenFrom('bearer gremlin_oat_abc')).toBe('gremlin_oat_abc');
  });

  it('rejects a bearer that is not one of our OAuth access tokens', () => {
    // The Gremlin API also accepts an internal webapp session token under the Bearer scheme, as
    // base64(orgId:identifier:token). Without this check the hosted server would relay a stolen
    // browser session upstream and it would authenticate -- a public endpoint turned into a relay
    // for a credential class that was never meant to reach it.
    const sessionToken = Buffer.from('org-1:user-1:secret').toString('base64');

    expect(bearerTokenFrom(`Bearer ${sessionToken}`)).toBeNull();
    expect(bearerTokenFrom('Bearer gremlin_ort_a_refresh_token')).toBeNull();
    expect(bearerTokenFrom('Bearer arbitrary-opaque-value')).toBeNull();
  });

  it('accepts a Gremlin OAuth access token', () => {
    expect(bearerTokenFrom('Bearer gremlin_oat_abc')).toBe('gremlin_oat_abc');
  });

  it('rejects the Key scheme the local server uses', () => {
    // The hosted server authenticates exactly one way. Quietly accepting a static API key here
    // would add an unintended auth path that bypasses OAuth entirely.
    expect(bearerTokenFrom('Key some-api-key')).toBeNull();
  });

  it('rejects an empty or missing credential', () => {
    expect(bearerTokenFrom('Bearer ')).toBeNull();
    expect(bearerTokenFrom('Bearer')).toBeNull();
    expect(bearerTokenFrom(undefined)).toBeNull();
    expect(bearerTokenFrom('')).toBeNull();
  });
});
