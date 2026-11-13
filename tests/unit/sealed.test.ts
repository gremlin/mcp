import { describe, expect, it } from 'vitest';
import z from 'zod';

import { open, openJson, seal, sealingKey } from '../../src/auth/sealed';

/** Cache entries are sealed before they reach a shared store; see `sealed.ts`. */
describe('seal', () => {
  const SERVER = sealingKey('server-secret');
  const TOKEN = 'gremlin_oat_client';

  it('opens with the keys it was sealed under', () => {
    expect(open(SERVER, TOKEN, seal(SERVER, TOKEN, 'payload'))).toBe('payload');
  });

  it('does not contain the plaintext', () => {
    expect(
      Buffer.from(seal(SERVER, TOKEN, 'gremlin_oat_api_secret'), 'base64').toString('latin1'),
    ).not.toContain('gremlin_oat_api_secret');
  });

  it('refuses another token, so one token cannot open another token\'s entry', () => {
    expect(open(SERVER, 'gremlin_oat_someone_else', seal(SERVER, TOKEN, 'payload'))).toBeUndefined();
  });

  it('refuses an entry sealed without the server secret, even under the right token', () => {
    // Whoever writes to the store holds their own token, so the token alone must not be enough
    // to make an entry this server will open.
    expect(open(SERVER, TOKEN, seal(sealingKey('guessed'), TOKEN, 'payload'))).toBeUndefined();
  });

  it('refuses a tampered or malformed value', () => {
    const bytes = Buffer.from(seal(SERVER, TOKEN, 'payload'), 'base64');
    bytes[bytes.length - 1] ^= 1;

    expect(open(SERVER, TOKEN, bytes.toString('base64'))).toBeUndefined();
    expect(open(SERVER, TOKEN, '')).toBeUndefined();
    expect(open(SERVER, TOKEN, 'not base64')).toBeUndefined();
  });
});

describe('openJson', () => {
  const SERVER = sealingKey('server-secret');
  const TOKEN = 'gremlin_oat_client';
  const Shape = z.object({ n: z.number() });

  it('returns the parsed value, and undefined for a miss, non-JSON or the wrong shape', () => {
    expect(openJson(SERVER, TOKEN, seal(SERVER, TOKEN, '{"n":1}'), Shape)).toEqual({ n: 1 });
    expect(openJson(SERVER, TOKEN, undefined, Shape)).toBeUndefined();
    expect(openJson(SERVER, TOKEN, seal(SERVER, TOKEN, 'not json'), Shape)).toBeUndefined();
    expect(openJson(SERVER, TOKEN, seal(SERVER, TOKEN, '{"n":"1"}'), Shape)).toBeUndefined();
  });
});
