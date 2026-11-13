import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type z from 'zod';

/**
 * Encrypts a cache value under a key derived from both the client token it belongs to and a secret
 * only this server holds.
 *
 * <p>With Redis these entries leave the process, so the store is not trusted either way:
 * - Reading it yields only ciphertext. Exchanged tokens are live API credentials.
 * - Writing to it gets nothing honoured. A validation outcome decides which session a caller may
 *   join, so a forged one would hand out another user's session. The token alone cannot make the
 *   key, because whoever forges an entry holds their own token; the server secret is what stops them.
 *
 * <p>Entries for different tokens cannot be swapped, since each opens only under its own key.
 *
 * <pre>
 *   server secret ──HKDF──▶ sealing key ─┐
 *                                        ├─HKDF──▶ entry key ──AES-256-GCM──▶ iv | tag | ciphertext
 *   client token ────────────────────────┘
 * </pre>
 *
 * <p>The HKDF `info` labels keep these keys distinct from the server secret's OAuth use and from the
 * SHA-256 lookup hash of the same token.
 */

const ALGORITHM = 'aes-256-gcm';
const SEALING_KEY_INFO = 'gremlin-mcp sealing key v1';
// v2: v1 entries were keyed on the token alone. They no longer open, so they read as misses.
const ENTRY_INFO = 'gremlin-mcp token cache v2';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Derives the key all entries are sealed under. Derived once rather than using the secret directly,
 * so the secret's other job (authenticating to the authorization server) stays out of this module.
 */
export function sealingKey(serverSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', serverSecret, Buffer.alloc(0), SEALING_KEY_INFO, KEY_BYTES));
}

function entryKey(sealing: Buffer, token: string): Buffer {
  return Buffer.from(hkdfSync('sha256', token, sealing, ENTRY_INFO, KEY_BYTES));
}

/** `iv | tag | ciphertext`, base64. */
export function seal(sealing: Buffer, token: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, entryKey(sealing, token), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** The plaintext, or undefined when `sealed` is malformed, tampered with, or not under these keys. */
export function open(sealing: Buffer, token: string, sealed: string): string | undefined {
  const bytes = Buffer.from(sealed, 'base64');
  if (bytes.length < IV_BYTES + TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv(ALGORITHM, entryKey(sealing, token), bytes.subarray(0, IV_BYTES));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Opens a sealed JSON value as `schema`. Undefined for a miss, or anything that does not open or fit. */
export function openJson<T>(
  sealing: Buffer,
  token: string,
  sealed: string | undefined,
  schema: z.ZodType<T>,
): T | undefined {
  const plaintext = sealed === undefined ? undefined : open(sealing, token, sealed);
  if (plaintext === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(plaintext));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
