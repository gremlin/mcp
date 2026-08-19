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
