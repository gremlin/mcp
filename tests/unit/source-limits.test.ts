import { describe, it, expect } from 'vitest';

import {
  isTrustedSource,
  parseSourceRange,
  SourceRateLimiter,
  trustedSourcesFrom,
  type SourceRange,
} from '../../src/http/source-limits';

function trustedRanges(...entries: string[]) {
  return trustedSourcesFrom(entries.map((entry) => parseSourceRange(entry) as SourceRange));
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
  it('gives each source its own allowance and a trusted source a larger one', () => {
    const limiter = new SourceRateLimiter(60_000, 2, 5, trustedRanges('198.51.100.0/24'));
    const now = 1_000;

    const attacker = [1, 2, 3].map(() => limiter.exceeded('203.0.113.1', now));
    expect(attacker).toEqual([false, false, true]);
    // Another caller is untouched by the first one's flood.
    expect(limiter.exceeded('203.0.113.2', now)).toBe(false);

    const vendor = [1, 2, 3, 4, 5, 6].map(() => limiter.exceeded('198.51.100.10', now));
    expect(vendor).toEqual([false, false, false, false, false, true]);
  });

  it('starts a fresh allowance each window', () => {
    const limiter = new SourceRateLimiter(60_000, 1, 1, trustedRanges());

    expect(limiter.exceeded('203.0.113.1', 0)).toBe(false);
    expect(limiter.exceeded('203.0.113.1', 30_000)).toBe(true);
    expect(limiter.exceeded('203.0.113.1', 60_000)).toBe(false);
  });
});
