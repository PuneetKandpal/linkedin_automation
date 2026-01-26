function randomPart(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  }
  return Math.random().toString(36).slice(2, 12);
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomPart()}`;
}

export function generateAccountId(): string {
  return generateId('acct');
}

export function generateArticleId(): string {
  return generateId('art');
}

export function generateJobId(): string {
  return generateId('job');
}
