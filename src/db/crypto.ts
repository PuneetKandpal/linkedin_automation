import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.STORAGE_STATE_SECRET;
  if (!secret) {
    throw new Error('Missing STORAGE_STATE_SECRET');
  }

  const buf = Buffer.from(secret, 'utf-8');
  if (buf.length === 32) return buf;

  const padded = Buffer.alloc(32);
  buf.copy(padded, 0, 0, Math.min(buf.length, 32));
  return padded;
}

export function encryptJson(value: unknown): string {
  const key = getKey();
  const iv = randomBytes(12);

  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf-8');

  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptJson<T>(payload: string): T {
  const key = getKey();
  const data = Buffer.from(payload, 'base64');

  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
  return JSON.parse(dec) as T;
}
