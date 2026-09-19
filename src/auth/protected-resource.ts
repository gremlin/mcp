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
  return token.length > 0 ? token : null;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function escapeQuoted(value: string): string {
  // RFC 9110 quoted-string: backslash and double quote must be escaped.
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
