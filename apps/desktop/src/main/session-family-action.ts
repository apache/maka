import { revisionFamilySessionIds } from '@maka/core/session-revisions';

import { type SessionSummary } from '@maka/core/session';

export function requestsRevisionFamily(options: unknown): boolean {
  if (options === undefined) return false;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid session family action options');
  }
  const value = (options as { revisionFamily?: unknown }).revisionFamily;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('Invalid revisionFamily option');
  return value;
}

export async function resolveSessionActionIds(
  listSessions: () => Promise<readonly SessionSummary[]>,
  sessionId: string,
  options: unknown,
): Promise<string[]> {
  if (!requestsRevisionFamily(options)) return [sessionId];
  return revisionFamilySessionIds(await listSessions(), sessionId);
}
