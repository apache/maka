import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@maka/core/settings';
import type { LocalMemoryState } from '@maka/core/local-memory';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  appendManualLocalMemoryEntryDraft,
  findLocalMemoryEntryDraftRange,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryIdMaterial,
} from '@maka/core/local-memory';
import { webSha256Digest } from '../local-memory-digest';
import { useToast, useUiLocale } from '@maka/ui';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { settingsActionErrorMessage } from './settings-error-copy';
import {
  formatLocalMemorySaveSummary,
  localMemoryBackupKindLabel,
  localMemoryBackupSummary,
  memoryEntryStatusLabel,
  memoryOriginLabel,
} from './memory-settings-labels';
import { deriveMemorySettingsViewModel } from './memory-settings-view-model';
import { useKeyedActionGuard } from './use-action-guard';
import { getMemorySettingsCopy } from '../locales/settings-memory-copy';
import { readScrollMotionBehavior } from '../scroll-motion-policy';
import { useRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';

export interface MemoryDocumentControllerProps {
  settings: AppSettings;
  onReloadSettings(): Promise<void>;
}

/** Owns the MEMORY.md document lifecycle. */
export function useMemoryDocumentController(props: MemoryDocumentControllerProps) {
  const host = useRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getMemorySettingsCopy(locale);
  type MemoryWriteAction = 'reload' | 'enable' | 'agent-read' | 'save' | 'reset' | 'restore' | 'entry-status';

  const [state, setState] = useState<LocalMemoryState | null>(null);
  const [draft, setDraft] = useState('');
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryTags, setNewMemoryTags] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [memoryEntryQuery, setMemoryEntryQuery] = useState('');
  const [lastSaveSummary, setLastSaveSummary] = useState<{
    title: string;
    detail: string;
    savedAt: number;
  } | null>(null);
  const [loadingMemory, setLoadingMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingMemoryWriteAction, setPendingMemoryWriteAction] = useState<MemoryWriteAction | null>(null);
  const [pendingMemoryActions, setPendingMemoryActions] = useState<Set<string>>(() => new Set());
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  // One keyed guard holds both the single write latch (key 'write', the old
  // memoryWriteBusyRef) and the per-action latches (the old
  // pendingMemoryActionKeysRef set) with owner-checked releases.
  const memoryActionGuard = useKeyedActionGuard<string>();
  const memoryPageMountedRef = useRef(false);
  const memoryPageLifecycleRef = useRef(0);
  const memoryReloadTicketRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    memoryPageLifecycleRef.current += 1;
    memoryPageMountedRef.current = true;
    const lifecycle = memoryPageLifecycleRef.current;
    return () => {
      if (memoryPageLifecycleRef.current !== lifecycle) return;
      memoryPageMountedRef.current = false;
      memoryReloadTicketRef.current += 1;
    };
  }, []);

  function isMemoryPageCurrent(lifecycle: number): boolean {
    return memoryPageMountedRef.current && memoryPageLifecycleRef.current === lifecycle;
  }

  async function runMemoryWriteAction<T>(
    action: MemoryWriteAction,
    run: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    const releaseWrite = memoryActionGuard.begin('write');
    if (!releaseWrite) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    setPendingMemoryWriteAction(action);
    setBusy(true);
    try {
      return await run(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      releaseWrite();
      if (isMemoryPageCurrent(lifecycle)) {
        setPendingMemoryWriteAction(null);
        setBusy(false);
      }
    }
  }

  async function runMemoryAction<T>(
    key: string,
    action: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    const release = memoryActionGuard.begin(key);
    if (!release) return undefined;
    const lifecycle = memoryPageLifecycleRef.current;
    setPendingMemoryActions((current) => new Set(current).add(key));
    try {
      return await action(() => isMemoryPageCurrent(lifecycle));
    } catch (error) {
      if (!isMemoryPageCurrent(lifecycle)) return undefined;
      throw error;
    } finally {
      release();
      if (isMemoryPageCurrent(lifecycle)) {
        setPendingMemoryActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }

  async function reload(): Promise<boolean> {
    const lifecycle = memoryPageLifecycleRef.current;
    const ticket = ++memoryReloadTicketRef.current;
    try {
      const next = await window.maka.memory.getState(undefined, host);
      if (!isMemoryPageCurrent(lifecycle) || ticket !== memoryReloadTicketRef.current) return false;
      setState(next);
      setDraft(next.content);
      setLastSaveSummary(null);
      return true;
    } catch (error) {
      if (isMemoryPageCurrent(lifecycle) && ticket === memoryReloadTicketRef.current) {
        toast.error(copy.text.loadFailed, settingsActionErrorMessage(error, locale));
      }
      return false;
    } finally {
      if (isMemoryPageCurrent(lifecycle) && ticket === memoryReloadTicketRef.current) {
        setLoadingMemory(false);
      }
    }
  }

  async function reloadDraftFromDisk() {
    await runMemoryWriteAction('reload', async (isCurrent) => {
      const ok = await reload();
      if (ok && isCurrent()) toast.success(copy.text.reloaded, copy.text.reloadDiscarded);
    });
  }

  useEffect(() => {
    void reload();
  }, []);

  async function setEnabled(enabled: boolean) {
    try {
      await runMemoryWriteAction('enable', async (isCurrent) => {
        const next = await window.maka.memory.setEnabled(enabled, host);
        await props.onReloadSettings();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
      });
    } catch (error) {
      toast.error(copy.text.toggleFailed, settingsActionErrorMessage(error, locale));
    }
  }

  async function setAgentReadEnabled(agentReadEnabled: boolean) {
    try {
      await runMemoryWriteAction('agent-read', async (isCurrent) => {
        const next = await window.maka.memory.setAgentReadEnabled(agentReadEnabled, host);
        await props.onReloadSettings();
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
      });
    } catch (error) {
      toast.error(copy.text.agentReadFailed, settingsActionErrorMessage(error, locale));
    }
  }

  async function save() {
    try {
      await runMemoryWriteAction('save', async (isCurrent) => {
        const next = await window.maka.memory.save(draft, host);
        if (!isCurrent()) return;
        const redacted = next.content !== draft;
        setState(next);
        setDraft(next.content);
        if (next.status === 'safe_mode') {
          setLastSaveSummary(null);
          toast.error(copy.text.saveBlocked, copy.text.safeMode);
        } else if (redacted) {
          const detail = copy.redactedDetail(formatLocalMemorySaveSummary(next, copy));
          setLastSaveSummary({
            title: copy.text.savedRedacted,
            detail,
            savedAt: Date.now(),
          });
          toast.success(copy.text.savedRedacted, detail);
        } else {
          const detail = formatLocalMemorySaveSummary(next, copy);
          setLastSaveSummary({
            title: copy.text.savedFile,
            detail,
            savedAt: Date.now(),
          });
          toast.success(copy.text.savedFile, detail);
        }
      });
    } catch (error) {
      toast.error(copy.text.saveFailed, settingsActionErrorMessage(error, locale));
    }
  }

  async function reset() {
    try {
      await runMemoryWriteAction('reset', async (isCurrent) => {
        const next = await window.maka.memory.reset(host);
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
        setLastSaveSummary(null);
        toast.success(copy.text.resetDone, copy.text.resetDoneDetail);
      });
    } catch (error) {
      toast.error(copy.text.resetFailed, settingsActionErrorMessage(error, locale));
    }
  }

  async function restoreLatestBackup() {
    await runMemoryAction('backup:latest:restore', async () => {
      try {
        await runMemoryWriteAction('restore', async (isCurrent) => {
          const backup = state?.latestBackup;
          if (!backup) {
            toast.error(copy.text.noBackup, copy.text.noBackupDetail);
            return;
          }
          const backupLabel = `${localMemoryBackupKindLabel(backup.kind, copy)} · ${localMemoryBackupSummary(backup, copy)} · ${new Date(backup.updatedAt).toLocaleString(copy.intlLocale)}`;
          const ok = await toast.confirm({
            title: copy.text.restoreLatestTitle,
            description: copy.restoreLatestDescription(backupLabel),
            confirmLabel: copy.text.confirmRestore,
            cancelLabel: copy.text.cancel,
            destructive: true,
          });
          if (!ok) return;
          if (!isCurrent()) return;
          const result = await window.maka.memory.restoreLatestBackup(host);
          if (!isCurrent()) return;
          setState(result.state);
          setDraft(result.state.content);
          setLastSaveSummary(null);
          if (result.ok) {
            toast.success(copy.text.restoredLatest, `${backupLabel} · ${copy.text.restoredDetail}`);
          } else {
            toast.error(copy.text.restoreFailed, memoryResultMessage(result.message, locale, copy.text.restoreFailed));
          }
        });
      } catch (error) {
        toast.error(copy.text.restoreLatestFailed, settingsActionErrorMessage(error, locale));
      }
    });
  }

  async function restoreBackupCandidate(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:restore`, async () => {
      try {
        await runMemoryWriteAction('restore', async (isCurrent) => {
          const backupLabel = `${localMemoryBackupKindLabel(backup.kind, copy)} · ${localMemoryBackupSummary(backup, copy)} · ${new Date(backup.updatedAt).toLocaleString(copy.intlLocale)}`;
          const ok = await toast.confirm({
            title: copy.text.restoreCandidateTitle,
            description: copy.restoreCandidateDescription(backupLabel),
            confirmLabel: copy.text.confirmRestore,
            cancelLabel: copy.text.cancel,
            destructive: true,
          });
          if (!ok) return;
          if (!isCurrent()) return;
          const result = await window.maka.memory.restoreBackup(backup.kind, host);
          if (!isCurrent()) return;
          setState(result.state);
          setDraft(result.state.content);
          setLastSaveSummary(null);
          if (result.ok) {
            toast.success(copy.text.restoredCandidate, `${backupLabel} · ${copy.text.restoredDetail}`);
          } else {
            toast.error(copy.text.restoreFailed, memoryResultMessage(result.message, locale, copy.text.restoreFailed));
          }
        });
      } catch (error) {
        toast.error(copy.text.restoreCandidateFailed, settingsActionErrorMessage(error, locale));
      }
    });
  }

  async function openFile() {
    await runMemoryAction('memory:file:open', async (isCurrent) => {
      try {
        const result = await window.maka.memory.openFile(host);
        if (!isCurrent()) return;
        if (!result.ok) toast.error(copy.text.openFailed, memoryResultMessage(result.message, locale, copy.text.openFailed));
      } catch (error) {
        if (isCurrent()) toast.error(copy.text.openFailed, settingsActionErrorMessage(error, locale));
      }
    });
  }

  async function openLatestBackup() {
    await runMemoryAction('backup:latest:open', async (isCurrent) => {
      try {
        const result = await window.maka.memory.openLatestBackup(host);
        if (!isCurrent()) return;
        if (!result.ok) toast.error(copy.text.openPreviousFailed, memoryResultMessage(result.message, locale, copy.text.openPreviousFailed));
      } catch (error) {
        if (isCurrent()) toast.error(copy.text.openPreviousFailed, settingsActionErrorMessage(error, locale));
      }
    });
  }

  async function openBackupCandidate(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:open`, async (isCurrent) => {
      try {
        const result = await window.maka.memory.openBackup(backup.kind, host);
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error(copy.openBackupFailed(localMemoryBackupKindLabel(backup.kind, copy)), memoryResultMessage(result.message, locale, copy.text.openFailed));
        }
      } catch (error) {
        if (isCurrent())
          toast.error(copy.openBackupFailed(localMemoryBackupKindLabel(backup.kind, copy)), settingsActionErrorMessage(error, locale));
      }
    });
  }

  async function openFolder() {
    await runMemoryAction('memory:folder:open', async (isCurrent) => {
      try {
        const result = await window.maka.app.openPath('memory', undefined, host);
        if (!isCurrent()) return;
        if (!result.ok) {
          toast.error(copy.openBackupFailed(openPathActionLabel('memory', locale)), openPathFailureCopy(result.reason, locale));
        }
      } catch (error) {
        if (isCurrent())
          toast.error(copy.openBackupFailed(openPathActionLabel('memory', locale)), settingsActionErrorMessage(error, locale));
      }
    });
  }

  async function copyPath() {
    await runMemoryAction('memory:path:copy', async (isCurrent) => {
      if (!state?.path) return;
      try {
        await navigator.clipboard.writeText(state.path);
        if (isCurrent()) toast.success(copy.text.pathCopied, state.path);
      } catch {
        if (isCurrent()) toast.error(copy.text.copyFailed, copy.text.copyFailedDetail);
      }
    });
  }

  async function copyBackupReference(backup: NonNullable<LocalMemoryState['latestBackup']>) {
    await runMemoryAction(`backup:${backup.kind}:copy`, async (isCurrent) => {
      const reference = [
        `Memory backup: ${localMemoryBackupKindLabel(backup.kind, copy)}`,
        `Path: ${backup.path}`,
        `Updated: ${new Date(backup.updatedAt).toISOString()}`,
        `Entries: ${localMemoryBackupSummary(backup, copy)}`,
        `Size: ${backup.sizeBytes} bytes`,
        backup.safeMode ? `Safe mode: ${backup.reason ?? 'oversize'}` : 'Safe mode: false',
      ].join('\n');
      try {
        await navigator.clipboard.writeText(reference);
        if (isCurrent()) toast.success(copy.text.backupReferenceCopied, localMemoryBackupSummary(backup, copy));
      } catch {
        if (isCurrent()) toast.error(copy.text.copyFailed, copy.text.copyFailedDetail);
      }
    });
  }

  async function copyLatestBackupReference() {
    const backup = state?.latestBackup;
    if (!backup) return;
    await copyBackupReference(backup);
  }

  async function copyMemoryEntryReference(entry: LocalMemoryState['entries'][number]) {
    await runMemoryAction(`entry:${entry.id}:copy`, async (isCurrent) => {
      const reference = [
        `Memory entry: ${entry.title}`,
        `ID: ${entry.id}`,
        `Status: ${memoryEntryStatusLabel(entry.status, copy)}`,
        `Origin: ${memoryOriginLabel(entry.origin, copy)}`,
        entry.createdAt === undefined ? '' : `Created: ${new Date(entry.createdAt).toISOString()}`,
        entry.updatedAt === undefined ? '' : `Updated: ${new Date(entry.updatedAt).toISOString()}`,
        entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      try {
        await navigator.clipboard.writeText(reference);
        if (isCurrent()) toast.success(copy.text.entryReferenceCopied, entry.id);
      } catch {
        if (isCurrent()) toast.error(copy.text.copyFailed, copy.text.copyFailedDetail);
      }
    });
  }

  function focusMemoryEntryInDraft(entry: LocalMemoryState['entries'][number]) {
    const range = findLocalMemoryEntryDraftRange(draft, entry.id);
    if (!range) {
      toast.error(copy.text.locateFailed, copy.text.locateFailedDetail);
      return;
    }
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(range.start, range.end);
      editorRef.current?.scrollIntoView({
        block: 'center',
        behavior: readScrollMotionBehavior(),
      });
    });
  }

  async function addManualMemoryEntry() {
    const title = newMemoryTitle;
    const content = newMemoryContent;
    const tags = newMemoryTags.split(',');
    const currentDraft = draft;
    const currentHost = host;
    if (!title.trim()) {
      toast.error(copy.text.emptyTitle, copy.text.emptyTitleDetail);
      return;
    }
    if (!content.trim()) {
      toast.error(copy.text.emptyContent, copy.text.emptyContentDetail);
      return;
    }

    try {
      await runMemoryWriteAction('save', async (isCurrent) => {
        const { timestamp, material } = stableLocalMemoryIdMaterial(content, Date.now());
        const sha256 = await webSha256Digest(material);
        if (!isCurrent()) return;
        const result = appendManualLocalMemoryEntryDraft(currentDraft, {
          title,
          content,
          tags,
          now: timestamp,
          sha256,
        });
        if (!result.ok) {
          switch (result.reason) {
            case 'empty_title':
              toast.error(copy.text.emptyTitle, copy.text.emptyTitleDetail);
              return;
            case 'empty_content':
              toast.error(copy.text.emptyContent, copy.text.emptyContentDetail);
              return;
            case 'oversize':
              toast.error(copy.text.draftOversize, copy.text.oversizeDetail);
              return;
          }
        }
        const next = await window.maka.memory.save(result.draft, currentHost);
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
        if (next.status === 'safe_mode') {
          toast.error(copy.text.saveBlocked, copy.text.safeMode);
          return;
        }
        setNewMemoryTitle('');
        setNewMemoryTags('');
        setNewMemoryContent('');
        toast.success(copy.text.addedDraft, title.trim());
      });
    } catch (error) {
      toast.error(copy.text.saveFailed, settingsActionErrorMessage(error, locale));
    }
  }

  async function updateMemoryEntryStatus(
    entry: LocalMemoryState['activeEntries'][number],
    status: 'active' | 'archived',
  ) {
    const result = setLocalMemoryEntryStatusDraft(draft, {
      id: entry.id,
      status,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'invalid_id':
          toast.error(copy.text.updateFailed, copy.text.invalidIdDetail);
          return;
        case 'not_found':
          toast.error(copy.text.updateFailed, copy.text.locateFailedDetail);
          return;
        case 'oversize':
          toast.error(copy.text.updateFailed, copy.text.oversizeDetail);
          return;
      }
    }

    try {
      await runMemoryWriteAction('entry-status', async (isCurrent) => {
        const next = await window.maka.memory.save(result.draft, host);
        if (!isCurrent()) return;
        setState(next);
        setDraft(next.content);
        if (next.status === 'safe_mode') {
          toast.error(copy.text.updateBlocked, copy.text.safeMode);
        } else {
          toast.success(status === 'archived' ? copy.text.archived : copy.text.restored, entry.title);
        }
      });
    } catch (error) {
      toast.error(status === 'archived' ? copy.text.archiveFailed : copy.text.entryRestoreFailed, settingsActionErrorMessage(error, locale));
    }
  }

  const viewModel = useMemo(
    () =>
      deriveMemorySettingsViewModel({
      state,
      localMemorySettings: props.settings.localMemory,
      draft,
      query: memoryEntryQuery,
      copy,
    }),
    [copy, state, props.settings, draft, memoryEntryQuery],
  );
  const {
    effective,
    memoryDraftDirty,
    visibleMemoryEntries,
    memoryEntryPreviewBlockedReason,
    normalizedMemoryEntryQuery,
    filteredActiveEntries,
    filteredArchivedEntries,
    filteredEntryCount,
    localMemoryPromptPreview,
    promptPreviewBlockedReason,
    promptPreviewWillInject,
    localMemoryPromptPreviewBudgetLabel,
    memoryDraftHasSensitiveFields,
  } = viewModel;
  const memoryControlsDisabled = loadingMemory || busy;
  const isMemoryActionPending = (key: string) => pendingMemoryActions.has(key);

  async function copyLocalMemoryPromptPreview() {
    if (!localMemoryPromptPreview) return;
    await runMemoryAction('memory:prompt-preview:copy', async (isCurrent) => {
      try {
        await navigator.clipboard.writeText(localMemoryPromptPreview);
        if (isCurrent()) toast.success(copy.text.promptCopied, copy.text.promptCopiedDetail);
      } catch {
        if (isCurrent()) toast.error(copy.text.copyFailed, copy.text.copyFailedDetail);
      }
    });
  }

  return {
    draft,
    setDraft,
    newMemoryTitle,
    setNewMemoryTitle,
    newMemoryTags,
    setNewMemoryTags,
    newMemoryContent,
    setNewMemoryContent,
    memoryEntryQuery,
    setMemoryEntryQuery,
    lastSaveSummary,
    pendingMemoryWriteAction,
    pendingMemoryActions,
    editorRef,
    reloadDraftFromDisk,
    setEnabled,
    setAgentReadEnabled,
    save,
    reset,
    restoreLatestBackup,
    restoreBackupCandidate,
    openFile,
    openLatestBackup,
    openBackupCandidate,
    openFolder,
    copyPath,
    copyBackupReference,
    copyLatestBackupReference,
    copyMemoryEntryReference,
    focusMemoryEntryInDraft,
    addManualMemoryEntry,
    updateMemoryEntryStatus,
    effective,
    memoryDraftDirty,
    visibleMemoryEntries,
    memoryEntryPreviewBlockedReason,
    normalizedMemoryEntryQuery,
    filteredActiveEntries,
    filteredArchivedEntries,
    filteredEntryCount,
    localMemoryPromptPreview,
    promptPreviewBlockedReason,
    promptPreviewWillInject,
    localMemoryPromptPreviewBudgetLabel,
    memoryDraftHasSensitiveFields,
    memoryControlsDisabled,
    isMemoryActionPending,
    copyLocalMemoryPromptPreview,
  };
}

function memoryResultMessage(message: string, locale: UiLocale, fallback: string): string {
  return locale === 'zh' || !/[\u3400-\u9fff]/u.test(message) ? message : fallback;
}
