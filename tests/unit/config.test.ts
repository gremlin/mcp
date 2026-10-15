import { describe, it, expect, afterEach } from 'vitest';
import { getApiTimeoutMs, getServiceUrl } from '../../src/config';

const DEFAULT_SERVICE_URL = 'https://api.gremlin.com/v1';

describe('getServiceUrl', () => {
  afterEach(() => {
    delete process.env.GREMLIN_SERVICE_URL;
  });

  it('falls back to the production URL when unset', () => {
    delete process.env.GREMLIN_SERVICE_URL;
    expect(getServiceUrl()).toBe(DEFAULT_SERVICE_URL);
  });

  it('falls back when set to an empty or whitespace-only value', () => {
    process.env.GREMLIN_SERVICE_URL = '   ';
    expect(getServiceUrl()).toBe(DEFAULT_SERVICE_URL);
  });

  it('uses the configured value when set', () => {
    process.env.GREMLIN_SERVICE_URL = 'https://api.staging.gremlin.com/v1';
    expect(getServiceUrl()).toBe('https://api.staging.gremlin.com/v1');
  });

  it('trims surrounding whitespace and trailing slashes', () => {
    process.env.GREMLIN_SERVICE_URL = '  https://api.staging.gremlin.com/v1//  ';
    expect(getServiceUrl()).toBe('https://api.staging.gremlin.com/v1');
  });
});

describe('getApiTimeoutMs', () => {
  afterEach(() => {
    delete process.env.GREMLIN_API_TIMEOUT_SECONDS;
  });

  it('defaults to 15 seconds', () => {
    expect(getApiTimeoutMs()).toBe(15_000);
  });

  it('reads seconds, including fractions', () => {
    process.env.GREMLIN_API_TIMEOUT_SECONDS = '2.5';
    expect(getApiTimeoutMs()).toBe(2_500);
  });

  it('keeps the default for a value that is not a positive number', () => {
    for (const value of ['', 'abc', '0', '-5', 'Infinity']) {
      process.env.GREMLIN_API_TIMEOUT_SECONDS = value;
      expect(getApiTimeoutMs()).toBe(15_000);
    }
  });
});
