import { describe, it, expect, afterEach } from 'vitest';

import {
  apiKeyCredentialFromEnvironment,
  authorizationHeader,
  credentialFingerprint,
  oauthCredential,
} from '../../src/auth/credential';

describe('authorizationHeader', () => {
  it('presents an API key under the Gremlin Key scheme', async () => {
    expect(await authorizationHeader({ kind: 'apiKey', value: 'abc' })).toBe('Key abc');
  });

  it('presents an OAuth access token as an RFC 6750 bearer', async () => {
    expect(await authorizationHeader(oauthCredential('gremlin_oat_xyz'))).toBe('Bearer gremlin_oat_xyz');
  });
});

describe('credentialFingerprint', () => {
  it('is stable for the same credential', () => {
    const token = 'gremlin_oat_stable';
    expect(credentialFingerprint(oauthCredential(token))).toBe(
      credentialFingerprint(oauthCredential(token)),
    );
  });

  it('differs between users', () => {
    expect(credentialFingerprint(oauthCredential('token-a'))).not.toBe(
      credentialFingerprint(oauthCredential('token-b')),
    );
  });

  it('is a full-width cryptographic digest, not a bucketing hash', () => {
    // This value is the sole authorization check for attaching to an existing MCP session, so its
    // width is a security parameter. It was a 32-bit polynomial hash: with a known session id, a
    // colliding token was a 1-in-2^32 guess against a server with no rate limiting, and a
    // collision handed over a session holding the original user's token.
    const fingerprint = credentialFingerprint(oauthCredential('gremlin_oat_abc'));

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates credentials that differ only in their last character', () => {
    // A weak polynomial hash over short, highly-similar tokens is exactly where collisions show
    // up first, so this is the shape worth pinning.
    const seen = new Set(
      Array.from({ length: 256 }, (_, i) =>
        credentialFingerprint(oauthCredential(`gremlin_oat_token_${i}`)),
      ),
    );

    expect(seen.size).toBe(256);
  });

  it('does not contain the credential it describes', () => {
    // It is used as a Map key and appears in logs, so leaking the token through it would undo the
    // reason for hashing at all.
    const token = 'gremlin_oat_super_secret_value';
    expect(credentialFingerprint(oauthCredential(token))).not.toContain(token);
  });

  it('separates an API key from an OAuth token of the same value', () => {
    expect(credentialFingerprint({ kind: 'apiKey', value: 'same' })).not.toBe(
      credentialFingerprint({ kind: 'oauth', value: 'same' }),
    );
  });
});

describe('apiKeyCredentialFromEnvironment', () => {
  const original = process.env.GREMLIN_API_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.GREMLIN_API_KEY;
    else process.env.GREMLIN_API_KEY = original;
  });

  it('reads the key from the environment', () => {
    process.env.GREMLIN_API_KEY = 'from-env';
    expect(apiKeyCredentialFromEnvironment()).toEqual({ kind: 'apiKey', value: 'from-env' });
  });

  it('throws rather than yielding a credential with no key', () => {
    delete process.env.GREMLIN_API_KEY;
    expect(() => apiKeyCredentialFromEnvironment()).toThrow(/GREMLIN_API_KEY/);
  });
});
