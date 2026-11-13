import { describe, it, expect } from 'vitest';

import {
  isTrustedSource,
  parseSourceRange,
  SourceRateLimiter,
  trustedSourcesFrom,
  type SourceRange,
} from '../../src/http/source-limits';
import { MemoryStore } from '../../src/shared-store';

function trustedRanges(...entries: string[]) {
  return trustedSourcesFrom(
    entries.map((entry): SourceRange => {
      const range = parseSourceRange(entry);
      if (!range) throw new Error(`Test range "${entry}" does not parse`);
      return range;
    }),
  );
}

describe('trusted sources', () => {
  it('matches addresses inside a configured range, IPv4 and IPv6', () => {
    const trusted = trustedRanges('160.79.104.0/21', '2001:db8::/32', '198.51.100.7');

    expect(isTrustedSource(trusted, '160.79.107.200')).toBe(true);
    expect(isTrustedSource(trusted, '2001:db8::1')).toBe(true);
    expect(isTrustedSource(trusted, '198.51.100.7')).toBe(true);
    expect(isTrustedSource(trusted, '::ffff:160.79.104.1')).toBe(true);
    expect(isTrustedSource(trusted, '160.79.112.1')).toBe(false);
    expect(isTrustedSource(trusted, 'unattributed')).toBe(false);
  });

  it('trusts nothing when no range is configured', () => {
    expect(isTrustedSource(trustedRanges(), '160.79.104.1')).toBe(false);
  });
});

describe('parseSourceRange', () => {
  it('parses a single address or a CIDR range', () => {
    expect(parseSourceRange('198.51.100.7')).toEqual({ address: '198.51.100.7', type: 'ipv4' });
    expect(parseSourceRange('2001:db8::/32')).toEqual({ address: '2001:db8::', prefix: 32, type: 'ipv6' });
  });

  it('rejects anything it cannot represent exactly, rather than widening it', () => {
    for (const entry of ['not-a-range', '10.0.0.0/99', '10.0.0.0/', '10.0.0.0/8/8', '2001:db8::/129', '10.0.0.0/1.5']) {
      expect(parseSourceRange(entry)).toBeUndefined();
    }
  });
});

describe('SourceRateLimiter', () => {
  function limiter(perSource: number, perTrusted: number, trusted = trustedRanges(), store = new MemoryStore()) {
    return new SourceRateLimiter('test', store, 60_000, perSource, perTrusted, trusted);
  }

  async function sequence(l: SourceRateLimiter, source: string, count: number, now = 1_000) {
    const results: boolean[] = [];
    for (let i = 0; i < count; i++) results.push(await l.exceeded(source, now));
    return results;
  }

  it('gives each source its own allowance and a trusted source a larger one', async () => {
    const l = limiter(2, 5, trustedRanges('198.51.100.0/24'));

    expect(await sequence(l, '203.0.113.1', 3)).toEqual([false, false, true]);
    // Another caller is untouched by the first one's flood.
    expect(await l.exceeded('203.0.113.2', 1_000)).toBe(false);

    expect(await sequence(l, '198.51.100.10', 6)).toEqual([false, false, false, false, false, true]);
  });

  it('starts a fresh allowance each window', async () => {
    const l = limiter(1, 1);

    expect(await l.exceeded('203.0.113.1', 0)).toBe(false);
    expect(await l.exceeded('203.0.113.1', 30_000)).toBe(true);
    expect(await l.exceeded('203.0.113.1', 60_000)).toBe(false);
  });

  it('enforces one bound across every limiter sharing a store', async () => {
    // Several instances behind a load balancer. The authorization-server budget is shared by all of
    // them, so the bound protecting it must be too, not multiplied by the instance count.
    const store = new MemoryStore();
    const a = limiter(2, 2, trustedRanges(), store);
    const b = limiter(2, 2, trustedRanges(), store);

    expect(await a.exceeded('203.0.113.1', 1_000)).toBe(false);
    expect(await b.exceeded('203.0.113.1', 2_000)).toBe(false);
    expect(await a.exceeded('203.0.113.1', 3_000)).toBe(true);
    expect(await b.exceeded('203.0.113.1', 4_000)).toBe(true);
  });
});
