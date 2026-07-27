import { describe, it, expect, afterEach } from 'vitest';
import { getServiceUrl } from '../../src/config';

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
