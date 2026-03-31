import { describe, it, expect } from 'vitest';
import { searchSpec, OpenApiSpec } from '../../src/openapi/spec-loader';

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
      const results = searchSpec(MOCK_SPEC, 'failure-flags experiments run', 'POST');
      expect(results.some(r => r.path === '/failure-flags/experiments/{id}/run')).toBe(true);
    });

    it('ranks the best multi-token match first', () => {
      const results = searchSpec(MOCK_SPEC, 'failure-flags experiments run', 'POST');
      expect(results[0].path).toBe('/failure-flags/experiments/{id}/run');
    });

    it('requires ALL tokens to match (AND logic) — partial match returns nothing', () => {
      // "failure-flags" matches, but "kubernetes" does not appear anywhere
      const results = searchSpec(MOCK_SPEC, 'failure-flags kubernetes');
      expect(results).toHaveLength(0);
    });

    it('natural-language word order still resolves the right endpoint', () => {
      const results = searchSpec(MOCK_SPEC, 'run failure flag experiment', 'POST');
      expect(results.some(r => r.path === '/failure-flags/experiments/{id}/run')).toBe(true);
    });
  });

  describe('method filter', () => {
    it('excludes endpoints with the wrong method', () => {
      const results = searchSpec(MOCK_SPEC, 'experiment', 'GET');
      expect(results.every(r => r.method === 'GET')).toBe(true);
    });

    it('returns results for the matching method', () => {
      const results = searchSpec(MOCK_SPEC, 'experiment', 'POST');
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.method === 'POST')).toBe(true);
    });
  });

  describe('topN limit', () => {
    it('respects the limit parameter', () => {
      const results = searchSpec(MOCK_SPEC, 'experiment', undefined, undefined, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });
});
