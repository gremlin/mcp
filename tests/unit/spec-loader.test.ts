import { afterEach, describe, it, expect, vi } from 'vitest';
import { getSpec, searchSpec, OpenApiSpec } from '../../src/openapi/spec-loader';

describe('getSpec', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caches per service URL, sharing one fetch between concurrent callers', async () => {
    const fetch = vi.fn(async (url: string) => Response.json({ paths: { [url]: {} } }));
    vi.stubGlobal('fetch', fetch);

    const [a1, a2] = await Promise.all([
      getSpec('https://a.example.com/v1'),
      getSpec('https://a.example.com/v1'),
    ]);
    const b = await getSpec('https://b.example.com/v1');
    const a3 = await getSpec('https://a.example.com/v1');

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://a.example.com/v1/openapi.json',
      'https://b.example.com/v1/openapi.json',
    ]);
    expect(a1).toBe(a2);
    expect(a3).toBe(a1);
    expect(Object.keys(b.paths)).toEqual(['https://b.example.com/v1/openapi.json']);
  });

  it('retries after a failed fetch rather than caching the failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ paths: {} }));
    vi.stubGlobal('fetch', fetch);

    await expect(getSpec('https://retry.example.com/v1')).rejects.toThrow('HTTP 503');
    await expect(getSpec('https://retry.example.com/v1')).resolves.toEqual({ paths: {} });
  });
});

// Minimal spec that mirrors the shapes we care about testing.
const MOCK_SPEC: OpenApiSpec = {
  paths: {
    '/failure-flags/experiments/{id}/run': {
      post: {
        summary: 'Run an Experiment by team and ID.',
        operationId: 'runExperiment',
        tags: ['failure-flags.experiments'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'teamId', in: 'query', required: true, schema: { type: 'string' } },
        ],
      },
    },
    '/failure-flags/experiments/{id}/halt': {
      post: {
        summary: 'Halt an Experiment by team and ID.',
        operationId: 'haltExperiment',
        tags: ['failure-flags.experiments'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
      },
    },
    '/failure-flags/experiments': {
      post: {
        summary: 'Create an Experiment.',
        operationId: 'createExperiment',
        tags: ['failure-flags.experiments'],
      },
      get: {
        summary: 'List Experiments.',
        operationId: 'listExperiments',
        tags: ['failure-flags.experiments'],
      },
    },
    '/reliability-tests/{reliabilityTestId}/runs': {
      post: {
        summary: 'Run a reliability test.',
        operationId: 'runReliabilityTest',
        tags: ['reliability-tests'],
        parameters: [
          { name: 'reliabilityTestId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '202': {
            description: 'Accepted',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          '400': { description: 'Bad request' },
        },
      },
    },
    '/teams': {
      get: {
        summary: 'List teams.',
        operationId: 'listTeams',
        tags: ['teams'],
      },
    },
  },
};

describe('searchSpec', () => {
  describe('single-token queries (original behavior)', () => {
    it('matches by path substring', () => {
      const results = searchSpec(MOCK_SPEC, 'failure-flags');
      const paths = results.map(r => r.path);
      expect(paths).toContain('/failure-flags/experiments/{id}/run');
      expect(paths).toContain('/failure-flags/experiments/{id}/halt');
      expect(paths).toContain('/failure-flags/experiments');
    });

    it('matches by operationId', () => {
      const results = searchSpec(MOCK_SPEC, 'runExperiment');
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('/failure-flags/experiments/{id}/run');
      expect(results[0].method).toBe('POST');
    });

    it('matches by summary', () => {
      const results = searchSpec(MOCK_SPEC, 'halt');
      expect(results.some(r => r.path === '/failure-flags/experiments/{id}/halt')).toBe(true);
    });

    it('returns empty when nothing matches', () => {
      const results = searchSpec(MOCK_SPEC, 'kubernetes');
      expect(results).toHaveLength(0);
    });
  });

  describe('multi-token queries (tokenized search)', () => {
    it('finds endpoint when query tokens are spread across the path', () => {
      // The exact failing case that prompted this change.
      // "failure-flags experiments run" tokenizes to ["failure", "flags", "experiments", "run"]
      // — none of which appear as a verbatim substring of the whole query in any field,
      // but each token individually matches the path.
      const results = searchSpec(MOCK_SPEC, 'failure-flags experiments run');
      expect(results.some(r => r.path === '/failure-flags/experiments/{id}/run')).toBe(true);
    });

    it('ranks the best multi-token match first', () => {
      const results = searchSpec(MOCK_SPEC, 'failure-flags experiments run');
      expect(results[0].path).toBe('/failure-flags/experiments/{id}/run');
    });

    it('requires ALL tokens to match (AND logic) — partial match returns nothing', () => {
      // "failure-flags" matches, but "kubernetes" does not appear anywhere
      const results = searchSpec(MOCK_SPEC, 'failure-flags kubernetes');
      expect(results).toHaveLength(0);
    });

    it('natural-language word order still resolves the right endpoint', () => {
      const results = searchSpec(MOCK_SPEC, 'run failure flag experiment');
      expect(results.some(r => r.path === '/failure-flags/experiments/{id}/run')).toBe(true);
    });
  });

  describe('methods in results', () => {
    it('labels every result with its method, so write endpoints are found without a filter', () => {
      const results = searchSpec(MOCK_SPEC, 'experiment');
      const methods = new Set(results.map((r) => r.method));

      expect(methods).toEqual(new Set(['GET', 'POST']));
      expect(
        results.some((r) => r.method === 'POST' && r.path === '/failure-flags/experiments/{id}/run'),
      ).toBe(true);
    });
  });

  describe('topN limit', () => {
    it('respects the limit parameter', () => {
      const results = searchSpec(MOCK_SPEC, 'experiment', undefined, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('response summaries', () => {
    it('summarizes each response down to description and content-types', () => {
      const results = searchSpec(MOCK_SPEC, 'runReliabilityTest');
      expect(results[0].responses).toEqual({
        '202': { description: 'Accepted', content: { 'text/plain': {} } },
        '400': { description: 'Bad request' },
      });
    });

    it('strips schema/examples/encoding nested under each media type', () => {
      const results = searchSpec(MOCK_SPEC, 'runReliabilityTest');
      expect(results[0].responses?.['202'].content?.['text/plain']).toEqual({});
    });

    it('omits responses when the operation has none', () => {
      const results = searchSpec(MOCK_SPEC, 'listTeams');
      expect(results[0].responses).toBeUndefined();
    });
  });
});
