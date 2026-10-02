import { describe, it, expect } from 'vitest';

import {
  isTrustedSource,
  positiveOr,
  SourceRateLimiter,
  trustedSourcesFrom,
} from '../../src/http/source-limits';

describe('trusted sources', () => {
  it('matches addresses inside a configured range, IPv4 and IPv6', () => {
    const trusted = trustedSourcesFrom('160.79.104.0/21, 2001:db8::/32, 198.51.100.7');

    expect(isTrustedSource(trusted, '160.79.107.200')).toBe(true);
    expect(isTrustedSource(trusted, '2001:db8::1')).toBe(true);
    expect(isTrustedSource(trusted, '198.51.100.7')).toBe(true);
    expect(isTrustedSource(trusted, '::ffff:160.79.104.1')).toBe(true);
    expect(isTrustedSource(trusted, '160.79.112.1')).toBe(false);
    expect(isTrustedSource(trusted, 'unattributed')).toBe(false);
  });

  it('trusts nothing when unset, and skips an entry it cannot parse rather than widening', () => {
    expect(isTrustedSource(trustedSourcesFrom(undefined), '160.79.104.1')).toBe(false);

    const trusted = trustedSourcesFrom('not-a-range, 10.0.0.0/99, 203.0.113.0/24');
    expect(isTrustedSource(trusted, '203.0.113.9')).toBe(true);
    expect(isTrustedSource(trusted, '10.1.2.3')).toBe(false);
  });
});

describe('positiveOr', () => {
  it('falls back when a bound is missing, not a number, or not positive', () => {
    expect(positiveOr('25', 60)).toBe(25);
    expect(positiveOr(undefined, 60)).toBe(60);
    expect(positiveOr('abc', 60)).toBe(60);
    expect(positiveOr('0', 60)).toBe(60);
    expect(positiveOr('-5', 60)).toBe(60);
  });
});

describe('SourceRateLimiter', () => {
  it('gives each source its own allowance and a trusted source a larger one', () => {
    const limiter = new SourceRateLimiter(60_000, 2, 5, trustedSourcesFrom('198.51.100.0/24'));
    const now = 1_000;

    const attacker = [1, 2, 3].map(() => limiter.exceeded('203.0.113.1', now));
    expect(attacker).toEqual([false, false, true]);
    // Another caller is untouched by the first one's flood.
    expect(limiter.exceeded('203.0.113.2', now)).toBe(false);

    const vendor = [1, 2, 3, 4, 5, 6].map(() => limiter.exceeded('198.51.100.10', now));
    expect(vendor).toEqual([false, false, false, false, false, true]);
  });

  it('starts a fresh allowance each window', () => {
    const limiter = new SourceRateLimiter(60_000, 1, 1, trustedSourcesFrom(undefined));

    expect(limiter.exceeded('203.0.113.1', 0)).toBe(false);
    expect(limiter.exceeded('203.0.113.1', 30_000)).toBe(true);
    expect(limiter.exceeded('203.0.113.1', 60_000)).toBe(false);
  });
});
