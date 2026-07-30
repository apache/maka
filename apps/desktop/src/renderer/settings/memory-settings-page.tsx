import type { AppSettings, UpdateAppSettingsResult } from '@maka/core';
import { Alert, AlertDescription, Button, Chip, Input, RelativeTime, SettingsSwitch as Switch, Textarea, useUiLocale } from '@maka/ui';
import { getMemorySettingsCopy } from '../locales/settings-memory-copy';
import { SettingsRows } from './settings-rows';
import { MemoryEntryList } from './memory-entry-list';
import { MemoryPromptPreviewSection, WorkspaceInstructionsSection } from './memory-settings-sections';
import { useMemoryDocumentController } from './use-memory-settings-controller';
import { useWorkspaceInstructionsController } from './use-workspace-instructions-controller';
import {
  displayMemoryPath,
  localMemoryBackupKindLabel,
  localMemoryBackupSummary,
  memoryStatusLabel,
  memoryStatusTone,
} from './memory-settings-labels';

export function MemorySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getMemorySettingsCopy(locale);
  const {
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
    addManualMemoryDraftEntry,
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
    memoryControlsDisabled: memoryDocumentControlsDisabled,
    isMemoryActionPending,
    copyLocalMemoryPromptPreview,
  } = useMemoryDocumentController({
    settings: props.settings,
    onReloadSettings: props.onReloadSettings,
  });
  const workspaceInstructions = useWorkspaceInstructionsController({
    onUpdate: props.onUpdate,
    onReloadSettings: props.onReloadSettings,
  });
  const memoryControlsDisabled = memoryDocumentControlsDisabled || workspaceInstructions.busy;

  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <div className="settingsFormRow">
          <div>
            <strong>{copy.text.localFile}</strong>
            <small>{copy.text.localFileHelp}</small>
          </div>
          {/* #1363 review: one control cluster, not two loose siblings — on a
              narrow card the row stacks and the chip + switch stay on one
              line together instead of holding the row horizontal and
              crushing the label. */}
          <span className="settingsFormRowControlCluster">
            <Chip variant={memoryStatusTone(effective.status)}>
              {memoryStatusLabel(effective.status, copy)}
            </Chip>
            <Switch
              ariaLabel={copy.text.enableLocalFile}
              checked={effective.enabled}
              disabled={memoryControlsDisabled}
              onChange={(enabled) => void setEnabled(enabled)}
            />
          </span>
        </div>

        <div className="settingsFormRow">
          <div>
            <strong>{copy.text.agentReadable}</strong>
            <small>{copy.text.agentReadableHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.text.enableAgentRead}
            checked={effective.agentReadEnabled}
            disabled={memoryControlsDisabled || !effective.enabled}
            onChange={(enabled) => void setAgentReadEnabled(enabled)}
          />
        </div>

        <div className="settingsFormRow">
          <div>
            <strong>{copy.text.instructions}</strong>
            <small>{copy.text.instructionsHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.text.enableInstructions}
            checked={props.settings.workspaceInstructions.enabled}
            disabled={memoryControlsDisabled}
            onChange={(enabled) => void workspaceInstructions.setEnabled(enabled)}
          />
        </div>
      </SettingsRows>

      <WorkspaceInstructionsSection
        copy={copy}
        state={workspaceInstructions.state}
        disabled={memoryControlsDisabled}
        isActionPending={workspaceInstructions.isActionPending}
        onOpen={workspaceInstructions.openFile}
        onCreate={workspaceInstructions.createFile}
      />

      <div className="settingsConnectionMeta settingsMemoryMeta">
        <span className="settingsMemoryPath" title={effective.path || undefined}>
          {effective.path ? displayMemoryPath(effective.path) : copy.text.waitingFile}
        </span>
        {effective.latestBackup ? (
          <span className="settingsMemoryBackupState">
            {copy.text.openPrevious} · {localMemoryBackupKindLabel(effective.latestBackup.kind, copy)} · {localMemoryBackupSummary(effective.latestBackup, copy)} · <RelativeTime ts={effective.latestBackup.updatedAt} />
          </span>
        ) : (
          <span className="settingsMemoryBackupState" data-empty="true">{copy.text.waitingBackup}</span>
        )}
        <span className="settingsMemoryDirtyState" data-dirty={memoryDraftDirty ? 'true' : 'false'}>
          {memoryDraftDirty ? copy.text.dirty : copy.text.savedDraft}
        </span>
        <span>
          {copy.countActive(visibleMemoryEntries.activeEntries.length, memoryDraftDirty)}
        </span>
        {visibleMemoryEntries.archivedEntries.length > 0 && (
          <span>
            {copy.countArchived(visibleMemoryEntries.archivedEntries.length, memoryDraftDirty)}
          </span>
        )}
      </div>

      {effective.backups && effective.backups.length > 1 && (
        <div className="settingsMemoryBackupList" role="status">
          <strong>{copy.text.backupCandidates}</strong>
          {/* PR-MEMORY-BACKUP-LIST-A11Y-0 (round 16/30): same
              fix as round-7 daily-review archive list. Was
              `<div role="list">` with `<span role="listitem">`
              children — invalid layering (a span is not a list,
              and a listitem on a span has no list context to
              attach to). Switched to semantic <ul>/<li> so
              screen readers get the relationship from the
              elements themselves. */}
          <ul className="settingsMemoryBackupCandidates" aria-label={copy.text.backupCandidatesAria}>
            {effective.backups.map((backup) => {
              const backupCandidateLabel = `${localMemoryBackupKindLabel(backup.kind, copy)} · ${localMemoryBackupSummary(backup, copy)}`;
              return (
                <li key={`${backup.kind}:${backup.path}`} className="settingsMemoryBackupCandidate">
                  <span>{backupCandidateLabel} · <RelativeTime ts={backup.updatedAt} /></span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={copy.openBackupAria(backupCandidateLabel)}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:open`)}
                    onClick={() => void openBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:open`) ? copy.text.opening : copy.text.open}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={copy.restoreBackupAria(backupCandidateLabel)}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:restore`)}
                    onClick={() => void restoreBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:restore`) ? copy.text.restoring : copy.text.restore}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={copy.copyBackupAria(backupCandidateLabel)}
                    disabled={isMemoryActionPending(`backup:${backup.kind}:copy`)}
                    onClick={() => void copyBackupReference(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:copy`) ? copy.text.copying : copy.text.copyReference}
                  </Button>
                </li>
              );
            })}
          </ul>
          <small>{copy.text.backupHelp}</small>
        </div>
      )}

      {lastSaveSummary && !memoryDraftDirty && (
        <div className="settingsMemorySaveSummary" role="status">
          <strong>{lastSaveSummary.title}</strong>
          <small className="settingsMemorySaveSummaryTime">
            {copy.text.savedAt}<RelativeTime ts={lastSaveSummary.savedAt} />
          </small>
          <small>{lastSaveSummary.detail}</small>
        </div>
      )}

      {memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryEntryPreviewNotice" role="status">
          <strong>{copy.text.previewPaused}</strong>
          <small>{memoryEntryPreviewBlockedReason}</small>
        </div>
      )}

      <MemoryPromptPreviewSection
        copy={copy}
        active={promptPreviewWillInject}
        preview={localMemoryPromptPreview}
        budgetLabel={localMemoryPromptPreviewBudgetLabel}
        blockedReason={promptPreviewBlockedReason}
        safeMode={effective.status === 'safe_mode'}
        copyPending={isMemoryActionPending('memory:prompt-preview:copy')}
        onCopy={copyLocalMemoryPromptPreview}
      />

      {visibleMemoryEntries.entries.length > 0 && (
        <>
          <div className="settingsMemoryFilter">
            <Input
              type="search"
              value={memoryEntryQuery}
              onChange={(event) => setMemoryEntryQuery(event.currentTarget.value)}
              aria-label={copy.text.filterAria}
              placeholder={copy.text.filterPlaceholder}
            />
            {normalizedMemoryEntryQuery ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setMemoryEntryQuery('')}
              >
                {copy.text.clear}
              </Button>
            ) : null}
            <small>
              {normalizedMemoryEntryQuery
                ? copy.countMatches(filteredEntryCount, visibleMemoryEntries.entries.length)
                : copy.countEntries(visibleMemoryEntries.entries.length)}
            </small>
          </div>
          {normalizedMemoryEntryQuery && filteredEntryCount === 0 ? (
            <div className="settingsMemoryFilterEmpty" role="status">
              <strong>{copy.text.filterEmpty}</strong>
              <small>{copy.text.filterEmptyHelp}</small>
            </div>
          ) : (
            <div className="settingsMemoryEntryGroups">
              <MemoryEntryList
                title={copy.text.activeMemories}
                copy={copy}
                entries={filteredActiveEntries}
                filtered={normalizedMemoryEntryQuery.length > 0}
                draftDirty={memoryDraftDirty}
                busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                pendingCopyIds={pendingMemoryActions}
                onCopyReference={copyMemoryEntryReference}
                onFocusDraft={focusMemoryEntryInDraft}
                onStatusChange={updateMemoryEntryStatus}
              />
              {visibleMemoryEntries.archivedEntries.length > 0 && (
                <MemoryEntryList
                  title={copy.text.archivedMemories}
                  copy={copy}
                  entries={filteredArchivedEntries}
                  filtered={normalizedMemoryEntryQuery.length > 0}
                  archived
                  draftDirty={memoryDraftDirty}
                  busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                  pendingCopyIds={pendingMemoryActions}
                  onCopyReference={copyMemoryEntryReference}
                  onFocusDraft={focusMemoryEntryInDraft}
                  onStatusChange={updateMemoryEntryStatus}
                />
              )}
            </div>
          )}
        </>
      )}

      {visibleMemoryEntries.entries.length === 0 && !memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryListEmpty" role="status">
          <strong>{copy.text.waitingEntry}</strong>
          <small>{copy.text.waitingEntryHelp}</small>
        </div>
      )}

      <div className="settingsMemoryManualAdd" role="group" aria-label={copy.text.manualAddAria}>
        <div className="settingsMemoryManualAddHeader">
          <strong>{copy.text.manualAdd}</strong>
          <small>{copy.text.manualAddHelp}</small>
        </div>
        <div className="settingsMemoryManualAddGrid">
          <Input
            type="text"
            value={newMemoryTitle}
            onChange={(event) => setNewMemoryTitle(event.currentTarget.value)}
            aria-label={copy.text.titleAria}
            placeholder={copy.text.titlePlaceholder}
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <Input
            type="text"
            value={newMemoryTags}
            onChange={(event) => setNewMemoryTags(event.currentTarget.value)}
            aria-label={copy.text.tagsAria}
            placeholder={copy.text.tagsPlaceholder}
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <Textarea
            value={newMemoryContent}
            onChange={(event) => setNewMemoryContent(event.currentTarget.value)}
            aria-label={copy.text.contentAria}
            placeholder={copy.text.contentPlaceholder}
            rows={3}
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          onClick={addManualMemoryDraftEntry}
        >
          {copy.text.addDraft}
        </Button>
      </div>

      {memoryDraftHasSensitiveFields && (
        <div className="settingsMemoryDraftWarning" role="status">
          <strong>{copy.text.sensitiveDraft}</strong>
          <small>{copy.text.sensitiveDraftHelp}</small>
        </div>
      )}

      <label className="settingsMemoryEditor">
        <span>{copy.text.fileContent}</span>
        <Textarea
          ref={editorRef}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          rows={12}
          spellCheck={false}
          aria-label={copy.text.contentEditorAria}
        />
      </label>

      {effective.reason && (
        <Alert variant="passive" role="status">
          <AlertDescription>{effective.reason}</AlertDescription>
        </Alert>
      )}

      <div className="settingsActionRow" role="group" aria-label={copy.text.fileActionsAria}>
        <Button type="button" className="min-w-[3.5rem]" disabled={memoryControlsDisabled || !effective.enabled || !memoryDraftDirty} onClick={() => void save()}>
          {pendingMemoryWriteAction === 'save' ? copy.text.saving : memoryDraftDirty ? copy.text.save : copy.text.saved}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[7.5rem]" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:file:open')} onClick={() => void openFile()}>
          {isMemoryActionPending('memory:file:open') ? copy.text.opening : copy.text.openFile}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[6rem]" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:folder:open')} onClick={() => void openFolder()}>
          {isMemoryActionPending('memory:folder:open') ? copy.text.opening : copy.text.openFolder}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[4rem]" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reloadDraftFromDisk()}>
          {pendingMemoryWriteAction === 'reload' ? copy.text.loading : copy.text.reload}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:open')} onClick={() => void openLatestBackup()}>
          {isMemoryActionPending('backup:latest:open') ? copy.text.opening : copy.text.openPrevious}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[4rem]" disabled={!effective.path || isMemoryActionPending('memory:path:copy')} onClick={() => void copyPath()}>
          {isMemoryActionPending('memory:path:copy') ? copy.text.copying : copy.text.copyPath}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[7rem]" disabled={!effective.latestBackup || (effective.latestBackup ? isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) : false)} onClick={() => void copyLatestBackupReference()}>
          {effective.latestBackup && isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) ? copy.text.copying : copy.text.copyPrevious}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reset()}>
          {pendingMemoryWriteAction === 'reset' ? copy.text.resetting : copy.text.resetBackup}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:restore')} onClick={() => void restoreLatestBackup()}>
          {isMemoryActionPending('backup:latest:restore') ? copy.text.restoring : copy.text.restorePrevious}
        </Button>
      </div>
    </div>
  );
}
