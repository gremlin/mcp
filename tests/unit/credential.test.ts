import { describe, it, expect, afterEach } from 'vitest';

import {
  apiKeyCredentialFromEnvironment,
  authorizationHeader,
  credentialFingerprint,
  credentialSlot,
  delegatedCredential,
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

describe('credentialSlot', () => {
  it('presents the exchanged token of the request it is serving', async () => {
    const slot = credentialSlot(delegatedCredential('client-1', async () => 'exchanged-1'));

    await slot.during(delegatedCredential('client-1', async () => 'exchanged-1'), async () => {
      expect(await authorizationHeader(slot.credential)).toBe('Bearer exchanged-1');
    });

    // Same credential object, different authority. This is what lets one McpServer outlive the
    // token that built it without going on acting under that token (design §B4.3 step 5).
    await slot.during(delegatedCredential('client-2', async () => 'exchanged-2'), async () => {
      expect(await authorizationHeader(slot.credential)).toBe('Bearer exchanged-2');
    });
  });

  it('keeps two overlapping requests from taking each other\'s authority', async () => {
    // One session, two requests in flight while the client rotates: one began before the refresh,
    // one after. Assigning the credential to the session lets whichever arrived last win for both,
    // so a request presenting a freshly narrowed token could execute with the older, wider one.
    const slot = credentialSlot(delegatedCredential('client-1', async () => 'exchanged-1'));
    const seen: string[] = [];

    const request = (n: number) =>
      slot.during(delegatedCredential(`client-${n}`, async () => `exchanged-${n}`), async () => {
        // Yield, so the other request is inside its own `during` before this one resolves.
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        seen.push(await authorizationHeader(slot.credential));
      });

    await Promise.all([request(1), request(2)]);

    expect(seen.sort()).toEqual(['Bearer exchanged-1', 'Bearer exchanged-2']);
  });

  it('falls back to the latest credential outside any request', async () => {
    // Work the server initiates itself on a standing stream has no request scope around it. The
    // most recent credential is the best answer available, and the only one a plain slot ever had.
    const slot = credentialSlot(delegatedCredential('client-1', async () => 'exchanged-1'));

    await slot.during(delegatedCredential('client-2', async () => 'exchanged-2'), async () => {});

    expect(await authorizationHeader(slot.credential)).toBe('Bearer exchanged-2');
  });

  it('never presents the client token it delegates for', async () => {
    const slot = credentialSlot(delegatedCredential('gremlin_oat_client', async () => 'exchanged'));

    expect(await authorizationHeader(slot.credential)).not.toContain('gremlin_oat_client');
  });

  it('refuses a credential that is not an exchanged one', () => {
    // Design invariant 13: the one API client is constructed only from an exchanged token. An
    // oauth credential's value is the client's own token (D31), and the slot presents whatever it
    // holds as a bearer -- so accepting one would forward that token upstream while still
    // reporting `kind: 'delegated'` to anything that looked later.
    expect(() => credentialSlot(oauthCredential('gremlin_oat_client'))).toThrow(/must be delegated/);
    expect(() => credentialSlot({ kind: 'apiKey', value: 'a-key' })).toThrow(/must be delegated/);
  });

  it('refuses one handed to it after construction, not just at construction', () => {
    const slot = credentialSlot(delegatedCredential('client-1', async () => 'exchanged-1'));

    expect(() => slot.during(oauthCredential('gremlin_oat_client'), () => {})).toThrow(
      /must be delegated/,
    );
  });
});
