const DEFAULT_SERVICE_URL = 'https://api.gremlin.com/v1';
const DEFAULT_API_TIMEOUT_MS = 15_000;

// Base URL for the Gremlin API, including the version prefix.
// Overridable via GREMLIN_SERVICE_URL (e.g. to point at a staging or
// self-hosted environment); falls back to production. Trailing slashes are
// trimmed so callers can safely build `${base}/path` without doubling up.
export function getServiceUrl(): string {
  const configured = process.env.GREMLIN_SERVICE_URL?.trim();
  if (!configured) return DEFAULT_SERVICE_URL;
  return configured.replace(/\/+$/, '');
}

// Per-attempt timeout for calls to the Gremlin API, overridable via GREMLIN_API_TIMEOUT_SECONDS.
export function getApiTimeoutMs(): number {
  return durationFromEnv('GREMLIN_API_TIMEOUT_SECONDS', DEFAULT_API_TIMEOUT_MS);
}

// A duration configured in seconds, in milliseconds; the default when unset or not a positive number.
export function durationFromEnv(name: string, defaultMs: number): number {
  const seconds = Number(process.env[name]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}
