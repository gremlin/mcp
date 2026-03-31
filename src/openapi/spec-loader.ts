// Minimal OpenAPI 3.0 types — only what we actually traverse
export interface OpenApiSpec {
  paths: Record<string, PathItem>;
}

export interface PathItem {
  [method: string]: Operation | undefined;
}

export interface Operation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: RequestBody;
  security?: Array<Record<string, string[]>>;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface RequestBody {
  required?: boolean;
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

export interface EndpointMatch {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: RequestBody;
}

const SPEC_URL = 'https://api.gremlin.com/v1/openapi.json';
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
const SPEC_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedSpec: OpenApiSpec | null = null;
let cachedAt = 0;
let specFetchPromise: Promise<OpenApiSpec> | null = null;

// Lazily fetches and caches the Gremlin OpenAPI spec. Concurrent callers share
// a single in-flight request rather than hammering the spec endpoint.
// The cache expires after SPEC_TTL_MS so long-lived servers (e.g. Claude Desktop)
// pick up spec changes without needing a restart.
export async function getSpec(): Promise<OpenApiSpec> {
  if (cachedSpec && Date.now() - cachedAt < SPEC_TTL_MS) return cachedSpec;

  if (!specFetchPromise) {
    specFetchPromise = fetchSpec()
      .then(spec => {
        cachedSpec = spec;
        cachedAt = Date.now();
        specFetchPromise = null;
        return spec;
      })
      .catch(err => {
        specFetchPromise = null; // allow retry on next call
        throw err;
      });
  }

  return specFetchPromise;
}

async function fetchSpec(): Promise<OpenApiSpec> {
  const res = await fetch(SPEC_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Gremlin OpenAPI spec: HTTP ${res.status}`);
  }
  return res.json() as Promise<OpenApiSpec>;
}

// Score a single token against the searchable fields of one endpoint.
// Weights: path/operationId = 3, summary/tags = 2, description = 1.
function scoreToken(token: string, pathLower: string, op: Operation): number {
  let score = 0;
  if (pathLower.includes(token)) score += 3;
  if (op.operationId?.toLowerCase().includes(token)) score += 3;
  if (op.summary?.toLowerCase().includes(token)) score += 2;
  if (op.tags?.some(t => t.toLowerCase().includes(token))) score += 2;
  if (op.description?.toLowerCase().includes(token)) score += 1;
  return score;
}

// Tokenize a query into lowercase words. Splits on whitespace and common
// non-word separators (/, -, _, {, }) so that a natural-language query like
// "failure-flags experiments run" produces ["failure", "flags", "experiments", "run"]
// while still preserving tokens that are meaningful as whole words.
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s/\-_{}]+/)
    .filter(t => t.length > 0);
}

// Searches the spec by weighted keyword scoring. Returns top `topN` matches.
//
// The query is scored two ways and the results are combined:
//   1. Full-phrase match — the entire query is treated as a substring (good for
//      exact path fragments like "/runs").
//   2. Token match — the query is split into words; each token is scored
//      independently and the scores are summed. This handles multi-word queries
//      like "failure-flags experiments run" that don't appear verbatim in any
//      single field but whose parts each do.
//
// An endpoint must score > 0 on at least one strategy to appear in results.
export function searchSpec(
  spec: OpenApiSpec,
  query: string,
  methodFilter?: string,
  tagFilter?: string,
  topN = 10,
): EndpointMatch[] {
  const queryLower = query.toLowerCase();
  const tokens = tokenize(query);
  const methodLower = methodFilter?.toLowerCase();
  const tagLower = tagFilter?.toLowerCase();

  const scored: Array<{ score: number; match: EndpointMatch }> = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      if (methodLower && method !== methodLower) continue;
      if (tagLower && !op.tags?.some(t => t.toLowerCase().includes(tagLower))) continue;

      const pathLower = path.toLowerCase();

      // Strategy 1: full-phrase score (original behavior).
      const phraseScore = scoreToken(queryLower, pathLower, op);

      // Strategy 2: per-token score — sum across all tokens, but only count
      // an endpoint if every token matches at least once somewhere (AND logic).
      // This avoids surfacing noisy partial matches for long queries.
      let tokenScore = 0;
      let allTokensMatched = true;
      for (const token of tokens) {
        const ts = scoreToken(token, pathLower, op);
        if (ts === 0) {
          allTokensMatched = false;
          break;
        }
        tokenScore += ts;
      }
      if (!allTokensMatched) tokenScore = 0;

      const score = Math.max(phraseScore, tokenScore);
      if (score === 0) continue;

      scored.push({
        score,
        match: {
          method: method.toUpperCase(),
          path,
          summary: op.summary,
          description: op.description,
          operationId: op.operationId,
          tags: op.tags,
          parameters: op.parameters,
          requestBody: op.requestBody,
        },
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => s.match);
}
