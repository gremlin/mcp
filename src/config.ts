const DEFAULT_SERVICE_URL = 'https://api.gremlin.com/v1';

// Base URL for the Gremlin API, including the version prefix.
// Overridable via GREMLIN_SERVICE_URL (e.g. to point at a staging or
// self-hosted environment); falls back to production. Trailing slashes are
// trimmed so callers can safely build `${base}/path` without doubling up.
export function getServiceUrl(): string {
  const configured = process.env.GREMLIN_SERVICE_URL?.trim();
  if (!configured) return DEFAULT_SERVICE_URL;
  return configured.replace(/\/+$/, '');
}

// The `Authorization` header value to send to the Gremlin API. Exactly one
// of GREMLIN_API_KEY (`Key <key>`) or GREMLIN_BEARER_TOKEN (`Bearer <token>`)
// must be set — this throws if neither, or both, are present rather than
// silently picking one or sending an empty/invalid header.
export function getAuthHeader(): string {
  const apiKey = process.env.GREMLIN_API_KEY?.trim();
  const bearerToken = process.env.GREMLIN_BEARER_TOKEN?.trim();

  if (apiKey && bearerToken) {
    throw new Error('Only one of GREMLIN_API_KEY or GREMLIN_BEARER_TOKEN may be set, not both');
  }

  if (apiKey) return `Key ${apiKey}`;
  if (bearerToken) return `Bearer ${bearerToken}`;

  throw new Error('Either GREMLIN_API_KEY or GREMLIN_BEARER_TOKEN environment variable is required');
}
