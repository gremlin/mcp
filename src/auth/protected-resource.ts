/**
 * RFC 9728 protected resource metadata, and the challenges that point clients at it.
 *
 * <p>This is the entry point to the whole OAuth flow. Claude's first request arrives with no token
 * at all; the 401 below is what tells it where to authenticate. Without it there is no discovery
 * path and the connection simply fails.
 */

const DEFAULT_AUTHORIZATION_SERVER = 'https://api.gremlin.com';

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * This server's RFC 8707 resource identifier.
 *
 * <p>Compared as an exact string by the authorization server (RFC 8707 defers to RFC 3986 section
 * 6.2.1: no normalisation, no prefix matching), so this value, the `resource` field of the metadata
 * document, and whatever a client sends as `resource` must match byte for byte. It is normalised
 * once here -- trailing slash removed -- and never adjusted again downstream.
 *
 * <p>Host-only on purpose. RFC 9728 locates the metadata document by inserting the well-known path
 * between the identifier's host and its path, so an identifier with a path would have to be served
 * at `/.well-known/oauth-protected-resource/<path>`. Keeping it at the root is the shape everything
 * is best tested against.
 *
 * <p>The convention is `https://<host>.gremlin.com`, and for the hosted server that is
 * `https://mcp.gremlin.com`: the MCP authorization spec makes the canonical resource identifier the
 * MCP server's own URL, which is what Claude reads from this document and sends to the
 * authorization server as `resource`. It must match the authorization server's allow list
 * (`GREMLIN_OAUTH_RESOURCES`) byte for byte -- there is no normalisation on either side beyond the
 * trailing slash stripped here.
 *
 * <p>No default, deliberately: an identifier that disagrees with what the authorization server
 * audiences tokens for surfaces as an authentication failure with no obvious cause, and a wrong
 * default would be harder to notice than a missing one.
 */
export function getResourceIdentifier(): string {
  const configured = process.env.GREMLIN_MCP_RESOURCE_URL?.trim();
  if (!configured) {
    throw new Error('GREMLIN_MCP_RESOURCE_URL environment variable is required');
  }
  return stripTrailingSlash(configured);
}

/** The authorization server that issues tokens for this resource. */
export function getAuthorizationServer(): string {
  const configured = process.env.GREMLIN_AUTHORIZATION_SERVER?.trim();
  return stripTrailingSlash(configured || DEFAULT_AUTHORIZATION_SERVER);
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_documentation?: string;
}

/**
 * RFC 9728 section 2. Field names are the wire contract -- a client reads these exact keys.
 */
export function buildProtectedResourceMetadata(): ProtectedResourceMetadata {
  return {
    resource: getResourceIdentifier(),
    authorization_servers: [getAuthorizationServer()],
    // RFC 6750 section 2.1. We accept the Authorization header and nothing else: query-parameter
    // tokens land in access logs and browser history, and form-encoded ones do not apply here.
    bearer_methods_supported: ['header'],
    // Mirrors the authorization server's vocabulary. One functional scope today; a token inherits
    // the authorizing user's own RBAC rather than a narrower subset.
    scopes_supported: ['gremlin:full', 'offline_access'],
    resource_documentation: 'https://www.gremlin.com/docs',
  };
}

/**
 * The `WWW-Authenticate` value for a request that needs a token, or has presented a bad one.
 *
 * <p>The `resource_metadata` parameter is the load-bearing part: RFC 9728 section 5.1 makes it how
 * a client discovers where to authenticate, so a bare `401` would leave Claude with nowhere to go.
 *
 * @param error an RFC 6750 section 3.1 error code. Omitted when no credential was presented at all
 *     -- there is nothing wrong with the request yet, it is simply unauthenticated.
 */
export function buildChallenge(error?: 'invalid_token' | 'insufficient_scope', description?: string): string {
  const params = [`resource_metadata="${getResourceIdentifier()}${PROTECTED_RESOURCE_PATH}"`];
  if (error) {
    params.unshift(`error="${error}"`);
    if (description) {
      params.splice(1, 0, `error_description="${escapeQuoted(description)}"`);
    }
  }
  return `Bearer ${params.join(', ')}`;
}

/**
 * Extracts a bearer token from an `Authorization` header.
 *
 * <p>Returns null for anything that is not a well-formed Bearer credential, including the `Key`
 * scheme the locally-run server uses: this server authenticates one way only, and quietly accepting
 * a second scheme is how a hosted service ends up with an unintended auth path.
 */
export function bearerTokenFrom(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const token = match[1].trim();
  if (token.length === 0) return null;

  // Must be one of our OAuth access tokens, not merely a well-formed bearer.
  //
  // This is not defence in depth against a forged token -- only the API can validate one, and it
  // will. It is about what this server is willing to relay. The Gremlin API also accepts an
  // internal webapp session token under the same Bearer scheme, as
  // `base64(orgId:identifier:token)`, so without this check a hosted MCP server would happily
  // forward a stolen browser session upstream and it would authenticate: a public endpoint turned
  // into a relay for a credential class that was never meant to reach it. Rejecting here also
  // means an unparseable credential is refused before it can cost us a session.
  return isAccessToken(token) ? token : null;
}

/**
 * Recognises the prefix the authorization server puts on its access tokens.
 *
 * <p>Kept in step with `OAuthTokens.ACCESS_TOKEN_PREFIX` on the service side; changing it there
 * invalidates every issued credential, so it is stable by construction.
 */
export function isAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

/** Mirrors `com.gremlininc.oauth.OAuthTokens.ACCESS_TOKEN_PREFIX`. */
export const ACCESS_TOKEN_PREFIX = 'gremlin_oat_';

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function escapeQuoted(value: string): string {
  // RFC 9110 quoted-string: backslash and double quote must be escaped.
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
