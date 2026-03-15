/**
 * AES-256-GCM encryption for user credentials.
 * Key comes from CREDENTIAL_ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 * Format: "iv_b64:authTag_b64:ciphertext_b64"
 * Falls back to plaintext base64 in dev if no key is set.
 */
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_HEX = process.env.CREDENTIAL_ENCRYPTION_KEY;

function getKey(): Buffer | null {
  if (!ENCRYPTION_KEY_HEX || ENCRYPTION_KEY_HEX.length !== 64) return null;
  return Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
}

export function encrypt(data: object): string {
  const key = getKey();
  const json = JSON.stringify(data);

  if (!key) {
    // Dev fallback: plaintext base64 (NOT for production)
    console.warn('[encryption] No CREDENTIAL_ENCRYPTION_KEY — storing plaintext (dev only)');
    return `plain:${Buffer.from(json).toString('base64')}`;
  }

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(json, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

export function decrypt(encryptedString: string): object {
  // Dev fallback
  if (encryptedString.startsWith('plain:')) {
    const json = Buffer.from(encryptedString.slice(6), 'base64').toString('utf8');
    return JSON.parse(json);
  }

  const key = getKey();
  if (!key) {
    throw new Error('Cannot decrypt: CREDENTIAL_ENCRYPTION_KEY not set');
  }

  const [ivB64, authTagB64, ciphertext] = encryptedString.split(':');

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}
