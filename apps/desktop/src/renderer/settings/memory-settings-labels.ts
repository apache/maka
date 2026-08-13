import type { StatusSemantic } from '@maka/ui';
import type { LocalMemoryState } from '@maka/core/local-memory';
import type { MemorySettingsCopy } from '../locales/settings-memory-copy';

export function filterLocalMemoryEntries(
  entries: LocalMemoryState['activeEntries'],
  query: string,
  copy: MemorySettingsCopy,
): LocalMemoryState['activeEntries'] {
  if (!query) return entries;
  const needle = query.toLocaleLowerCase(copy.intlLocale);
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.title,
      entry.content,
      entry.origin,
      memoryOriginLabel(entry.origin, copy),
      entry.createdAt === undefined ? '' : String(entry.createdAt),
      entry.updatedAt === undefined ? '' : String(entry.updatedAt),
      ...entry.tags,
    ].join('\n').toLocaleLowerCase(copy.intlLocale);
    return haystack.includes(needle);
  });
}

export function memoryOriginLabel(origin: NonNullable<LocalMemoryState['latestEntry']>['origin'], copy: MemorySettingsCopy): string {
  return copy.origins[origin];
}

export function memoryEntryStatusLabel(status: LocalMemoryState['entries'][number]['status'], copy: MemorySettingsCopy): string {
  return copy.entryStatuses[status];
}

export function formatLocalMemorySaveSummary(state: LocalMemoryState, copy: MemorySettingsCopy): string {
  return copy.saveSummary(state.activeEntryCount, state.archivedEntryCount);
}

/** Display-only path shortening: the full absolute MEMORY.md path used
 * to render as a full-width mono line that shoved the sibling status
 * words into a cramped stack (and leaked the raw absolute path into
 * the renderer, against the UI quality plan). Show the meaningful
 * trailing segments; the full path stays available via title= and the
 * copy-path action. */
export function displayMemoryPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

export function localMemoryBackupKindLabel(kind: NonNullable<LocalMemoryState['latestBackup']>['kind'], copy: MemorySettingsCopy): string {
  return copy.backupKinds[kind];
}

export function localMemoryBackupSummary(backup: NonNullable<LocalMemoryState['latestBackup']>, copy: MemorySettingsCopy): string {
  if (backup.safeMode) return copy.backupOversize;
  return copy.backupSummary(backup.activeEntryCount, backup.archivedEntryCount);
}

export function memoryStatusLabel(status: LocalMemoryState['status'], copy: MemorySettingsCopy): string {
  return copy.memoryStatuses[status];
}

export function localMemoryPromptPreviewBlockedReason(state: LocalMemoryState, copy: MemorySettingsCopy): string {
  if (!state.enabled) return copy.promptBlocked.disabled;
  if (state.status === 'incognito_blocked') return copy.promptBlocked.incognito;
  if (state.status === 'safe_mode') return copy.promptBlocked.safeMode;
  if (!state.agentReadEnabled) return copy.promptBlocked.agentRead;
  return '';
}

/**
 * `disabled` is a settled fact the user chose, so it is `neutral`. It used to
 * say `info`, which the settings surface painted as the accent dot — making a
 * feature the user deliberately switched off look like one that was running.
 *
 * `error` replaces the old `destructive`: that word belongs to actions (a
 * delete button), not to states, and this was the only place in the app naming
 * this meaning differently from everywhere else.
 */
export function memoryStatusSemantic(status: LocalMemoryState['status']): StatusSemantic {
  switch (status) {
    case 'ok': return 'success';
    case 'disabled': return 'neutral';
    case 'safe_mode':
    case 'incognito_blocked': return 'attention';
    case 'error': return 'error';
  }
}
