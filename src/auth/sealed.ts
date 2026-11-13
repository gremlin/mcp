import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts a cache value under a key derived from the client token it belongs to.
 *
 * <p>Exchanged tokens are live API credentials, and with Redis they leave the process. Sealed this
 * way, reading the store yields only ciphertext: opening an entry takes the client token, which is
 * never stored. No key to provision or rotate, and entries for different tokens cannot be swapped,
 * since each opens only under its own key.
 *
 * <p>The HKDF `info` keeps this key distinct from the SHA-256 lookup hash of the same token.
 */

const ALGORITHM = 'aes-256-gcm';
const INFO = 'gremlin-mcp token cache v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFor(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), INFO, KEY_BYTES));
}

/** `iv | tag | ciphertext`, base64. */
export function seal(secret: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** The plaintext, or undefined when `sealed` is malformed, tampered with, or not under this secret. */
export function open(secret: string, sealed: string): string | undefined {
  const bytes = Buffer.from(sealed, 'base64');
  if (bytes.length < IV_BYTES + TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv(ALGORITHM, keyFor(secret), bytes.subarray(0, IV_BYTES));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}
