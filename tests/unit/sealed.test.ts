import { describe, expect, it } from 'vitest';

import { open, seal } from '../../src/auth/sealed';

/** Exchanged tokens are sealed before they reach a shared store; see `sealed.ts`. */
describe('seal', () => {
  const TOKEN = 'gremlin_oat_client';

  it('opens with the secret it was sealed under', () => {
    expect(open(TOKEN, seal(TOKEN, 'payload'))).toBe('payload');
  });

  it('does not contain the plaintext', () => {
    expect(Buffer.from(seal(TOKEN, 'gremlin_oat_api_secret'), 'base64').toString('latin1')).not.toContain(
      'gremlin_oat_api_secret',
    );
  });

  it('refuses another secret, so one token cannot open another token\'s entry', () => {
    expect(open('gremlin_oat_someone_else', seal(TOKEN, 'payload'))).toBeUndefined();
  });

  it('refuses a tampered or malformed value', () => {
    const bytes = Buffer.from(seal(TOKEN, 'payload'), 'base64');
    bytes[bytes.length - 1] ^= 1;

    expect(open(TOKEN, bytes.toString('base64'))).toBeUndefined();
    expect(open(TOKEN, '')).toBeUndefined();
    expect(open(TOKEN, 'not base64')).toBeUndefined();
  });
});
