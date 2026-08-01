import type { AppSettings, UpdateAppSettingsResult } from '@maka/core';
import { Card, Item } from '@astryxdesign/core';
import {
  Badge,
  Button,
  FormLayout,
  TextInput,
  RelativeTime,
  Switch,
  TextArea,
  useUiLocale,
  Banner,
} from '@maka/ui';
import { getMemorySettingsCopy } from '../locales/settings-memory-copy';
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
import { statusBadgeVariant } from './settings-status-badge';

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
      <Card padding={0} className="settingsRows">
        <Item
          label={copy.text.localFile}
          description={copy.text.localFileHelp}
          endContent={(
            <span className="settingsFormRowControlCluster">
              <Badge
                variant={statusBadgeVariant(memoryStatusTone(effective.status))}
                label={memoryStatusLabel(effective.status, copy)}
              />
              <Switch
                label={copy.text.enableLocalFile}
                isLabelHidden
                value={effective.enabled}
                isDisabled={memoryControlsDisabled}
                onChange={(enabled) => void setEnabled(enabled)}
              />
            </span>
          )}
        />

        <Item
          label={copy.text.agentReadable}
          description={copy.text.agentReadableHelp}
          endContent={<Switch
            label={copy.text.enableAgentRead}
            isLabelHidden
            value={effective.agentReadEnabled}
            isDisabled={memoryControlsDisabled || !effective.enabled}
            onChange={(enabled) => void setAgentReadEnabled(enabled)}
          />}
        />

        <Item
          label={copy.text.instructions}
          description={copy.text.instructionsHelp}
          endContent={<Switch
            label={copy.text.enableInstructions}
            isLabelHidden
            value={props.settings.workspaceInstructions.enabled}
            isDisabled={memoryControlsDisabled}
            onChange={(enabled) => void workspaceInstructions.setEnabled(enabled)}
          />}
        />
      </Card>
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
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={copy.openBackupAria(backupCandidateLabel)}
                    isDisabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:open`)}
                    onClick={() => void openBackupCandidate(backup)}
                    label={isMemoryActionPending(`backup:${backup.kind}:open`) ? copy.text.opening : copy.text.open}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={copy.restoreBackupAria(backupCandidateLabel)}
                    isDisabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:restore`)}
                    onClick={() => void restoreBackupCandidate(backup)}
                    label={isMemoryActionPending(`backup:${backup.kind}:restore`) ? copy.text.restoring : copy.text.restore}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={copy.copyBackupAria(backupCandidateLabel)}
                    isDisabled={isMemoryActionPending(`backup:${backup.kind}:copy`)}
                    onClick={() => void copyBackupReference(backup)}
                    label={isMemoryActionPending(`backup:${backup.kind}:copy`) ? copy.text.copying : copy.text.copyReference}
                  />
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
            <TextInput
              type="text"
              value={memoryEntryQuery}
              onChange={(value) => setMemoryEntryQuery(value)}
              label={copy.text.filterAria}
              isLabelHidden
              placeholder={copy.text.filterPlaceholder}
              width="100%"
            />
            {normalizedMemoryEntryQuery ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setMemoryEntryQuery('')}
                label={copy.text.clear}
              />
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
        <FormLayout>
          <TextInput
            type="text"
            value={newMemoryTitle}
            onChange={(value) => setNewMemoryTitle(value)}
            label={copy.text.title}
            placeholder={copy.text.titlePlaceholder}
            isDisabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
            width="100%"
          />
          <TextInput
            type="text"
            value={newMemoryTags}
            onChange={(value) => setNewMemoryTags(value)}
            label={copy.text.tags}
            placeholder={copy.text.tagsPlaceholder}
            isDisabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
            width="100%"
          />
          <TextArea
            value={newMemoryContent}
            onChange={(value) => setNewMemoryContent(value)}
            label={copy.text.content}
            placeholder={copy.text.contentPlaceholder}
            rows={3}
            isDisabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
            width="100%"
          />
        </FormLayout>
        <Button
          variant="secondary"
          isDisabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          onClick={addManualMemoryDraftEntry}
          label={copy.text.addDraft}
        />
      </div>
      {memoryDraftHasSensitiveFields && (
        <div className="settingsMemoryDraftWarning" role="status">
          <strong>{copy.text.sensitiveDraft}</strong>
          <small>{copy.text.sensitiveDraftHelp}</small>
        </div>
      )}
      <TextArea
        ref={editorRef}
        value={draft}
        onChange={(value) => setDraft(value)}
        isDisabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
        rows={12}
        hasSpellCheck={false}
        label={copy.text.fileContent}
        width="100%"
      />
      {effective.reason && (
        <Banner status="info" role="status" title={effective.reason} />
      )}
      <div className="settingsActionRow" role="group" aria-label={copy.text.fileActionsAria}>
        <Button variant="primary" className="min-w-[3.5rem]" isDisabled={memoryControlsDisabled || !effective.enabled || !memoryDraftDirty} onClick={() => void save()} label={pendingMemoryWriteAction === 'save' ? copy.text.saving : memoryDraftDirty ? copy.text.save : copy.text.saved} />
        <Button variant="ghost" className="min-w-[7.5rem]" isDisabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:file:open')} onClick={() => void openFile()} label={isMemoryActionPending('memory:file:open') ? copy.text.opening : copy.text.openFile} />
        <Button variant="ghost" className="min-w-[6rem]" isDisabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:folder:open')} onClick={() => void openFolder()} label={isMemoryActionPending('memory:folder:open') ? copy.text.opening : copy.text.openFolder} />
        <Button variant="ghost" className="min-w-[4rem]" isDisabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reloadDraftFromDisk()} label={pendingMemoryWriteAction === 'reload' ? copy.text.loading : copy.text.reload} />
        <Button variant="ghost" className="min-w-[5rem]" isDisabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:open')} onClick={() => void openLatestBackup()} label={isMemoryActionPending('backup:latest:open') ? copy.text.opening : copy.text.openPrevious} />
        <Button variant="ghost" className="min-w-[4rem]" isDisabled={!effective.path || isMemoryActionPending('memory:path:copy')} onClick={() => void copyPath()} label={isMemoryActionPending('memory:path:copy') ? copy.text.copying : copy.text.copyPath} />
        <Button variant="ghost" className="min-w-[7rem]" isDisabled={!effective.latestBackup || (effective.latestBackup ? isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) : false)} onClick={() => void copyLatestBackupReference()} label={effective.latestBackup && isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) ? copy.text.copying : copy.text.copyPrevious} />
        <Button variant="ghost" className="min-w-[5rem]" isDisabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reset()} label={pendingMemoryWriteAction === 'reset' ? copy.text.resetting : copy.text.resetBackup} />
        <Button variant="ghost" className="min-w-[5rem]" isDisabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:restore')} onClick={() => void restoreLatestBackup()} label={isMemoryActionPending('backup:latest:restore') ? copy.text.restoring : copy.text.restorePrevious} />
      </div>
    </div>
  );
}
