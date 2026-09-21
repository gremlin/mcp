import { describe, it, expect, afterEach } from 'vitest';
import { getServiceUrl, getAuthHeader } from '../../src/config';

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

describe('getAuthHeader', () => {
  afterEach(() => {
    delete process.env.GREMLIN_API_KEY;
    delete process.env.GREMLIN_BEARER_TOKEN;
  });

  it('uses the API key when only GREMLIN_API_KEY is set', () => {
    process.env.GREMLIN_API_KEY = 'my-api-key';
    delete process.env.GREMLIN_BEARER_TOKEN;
    expect(getAuthHeader()).toBe('Key my-api-key');
  });

  it('uses the bearer token when only GREMLIN_BEARER_TOKEN is set', () => {
    delete process.env.GREMLIN_API_KEY;
    process.env.GREMLIN_BEARER_TOKEN = 'my-bearer-token';
    expect(getAuthHeader()).toBe('Bearer my-bearer-token');
  });

  it('throws when both are set', () => {
    process.env.GREMLIN_API_KEY = 'my-api-key';
    process.env.GREMLIN_BEARER_TOKEN = 'my-bearer-token';
    expect(() => getAuthHeader()).toThrow(
      'Only one of GREMLIN_API_KEY or GREMLIN_BEARER_TOKEN may be set, not both',
    );
  });

  it('ignores a whitespace-only API key and falls back to the bearer token', () => {
    process.env.GREMLIN_API_KEY = '   ';
    process.env.GREMLIN_BEARER_TOKEN = 'my-bearer-token';
    expect(getAuthHeader()).toBe('Bearer my-bearer-token');
  });

  it('throws when neither is set', () => {
    delete process.env.GREMLIN_API_KEY;
    delete process.env.GREMLIN_BEARER_TOKEN;
    expect(() => getAuthHeader()).toThrow(
      'Either GREMLIN_API_KEY or GREMLIN_BEARER_TOKEN environment variable is required',
    );
  });
});
