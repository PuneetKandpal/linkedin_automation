const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomChars(length: number): string {
  if (length <= 0) return '';
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += ALPHANUM[bytes[i] % ALPHANUM.length];
    }
    return out;
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  }
  return out;
}

export function generateId(prefix: string): string {
  const p = prefix.toUpperCase().slice(0, 3);
  return `${p}${randomChars(7)}`;
}

export function generateAccountId(): string {
  return generateId('ACT');
}

export function generateArticleId(): string {
  return generateId('ART');
}

export function generateJobId(): string {
  return generateId('PBJ');
}
