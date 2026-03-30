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

let cachedSpec: OpenApiSpec | null = null;
let specFetchPromise: Promise<OpenApiSpec> | null = null;

// Lazily fetches and caches the Gremlin OpenAPI spec. Concurrent callers share
// a single in-flight request rather than hammering the spec endpoint.
export async function getSpec(): Promise<OpenApiSpec> {
  if (cachedSpec) return cachedSpec;

  if (!specFetchPromise) {
    specFetchPromise = fetchSpec()
      .then(spec => {
        cachedSpec = spec;
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

// Searches the spec by weighted keyword scoring. Returns top `topN` matches.
export function searchSpec(
  spec: OpenApiSpec,
  query: string,
  methodFilter?: string,
  tagFilter?: string,
  topN = 10,
): EndpointMatch[] {
  const queryLower = query.toLowerCase();
  const methodLower = methodFilter?.toLowerCase();
  const tagLower = tagFilter?.toLowerCase();

  const scored: Array<{ score: number; match: EndpointMatch }> = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      if (methodLower && method !== methodLower) continue;
      if (tagLower && !op.tags?.some(t => t.toLowerCase().includes(tagLower))) continue;

      let score = 0;
      const pathLower = path.toLowerCase();

      if (pathLower.includes(queryLower)) score += 3;
      if (op.operationId?.toLowerCase().includes(queryLower)) score += 3;
      if (op.summary?.toLowerCase().includes(queryLower)) score += 2;
      if (op.tags?.some(t => t.toLowerCase().includes(queryLower))) score += 2;
      if (op.description?.toLowerCase().includes(queryLower)) score += 1;

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
