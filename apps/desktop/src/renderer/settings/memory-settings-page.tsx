/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useState } from 'react';
import type { AppSettings, UpdateAppSettingsResult } from '@maka/core/settings';

import {
  Banner,
  Button,
  EmptyState,
  FormLayout,
  MoreMenu,
  RelativeTime,
  StatusDot,
  Switch,
  TextArea,
  TextInput,
  useUiLocale,
} from '@maka/ui';
import { ICON_SIZE, Brain, Search } from '@maka/ui/icons';
import { getMemorySettingsCopy } from '../locales/settings-memory-copy';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
import { SettingsActions, SettingsField, SettingsPage, SettingsRow, SettingsSection } from './settings-section';
import { MemoryEntryList } from './memory-entry-list';
import { MemoryPromptPreviewSection } from './memory-settings-sections';
import { useMemoryDocumentController } from './use-memory-settings-controller';
import {
  displayMemoryPath,
  localMemoryBackupKindLabel,
  localMemoryBackupSummary,
  memoryStatusLabel,
  memoryStatusSemantic,
} from './memory-settings-labels';
import { dotForStatus } from '@maka/ui';

export function MemorySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getMemorySettingsCopy(locale);
  const sharedCopy = getSettingsSharedCopy(locale);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  } = useMemoryDocumentController({
    settings: props.settings,
    onReloadSettings: props.onReloadSettings,
  });
  const entryActionsBlocked = memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled;
  const hasLocalMemoryPaths = Boolean(effective.path);

  return (
    <SettingsPage>
      <SettingsSection description={sharedCopy.groups.memorySourcesHelp}>
        <SettingsRow
          label={hasLocalMemoryPaths ? copy.text.localFile : 'MEMORY.md'}
          description={hasLocalMemoryPaths ? copy.text.localFileHelp : copy.text.fileContent}
          end={(
            <span className="settingsFormRowControlCluster">
              <span className="settingsStatus">
                <StatusDot
                  variant={dotForStatus(memoryStatusSemantic(effective.status))}
                  label={memoryStatusLabel(effective.status, copy)}
                />
                <span>{memoryStatusLabel(effective.status, copy)}</span>
              </span>
              <Switch
                label={hasLocalMemoryPaths ? copy.text.enableLocalFile : copy.text.fileContent}
                isLabelHidden
                value={effective.enabled}
                isDisabled={memoryControlsDisabled}
                onChange={(enabled) => void setEnabled(enabled)}
              />
            </span>
          )}
        />
        <SettingsRow
          label={copy.text.agentReadable}
          description={copy.text.agentReadableHelp}
          end={<Switch
            label={copy.text.enableAgentRead}
            isLabelHidden
            value={effective.agentReadEnabled}
            isDisabled={memoryControlsDisabled || !effective.enabled}
            onChange={(enabled) => void setAgentReadEnabled(enabled)}
          />}
        />
      </SettingsSection>

      <SettingsSection
        title={sharedCopy.groups.memoryEntries}
        description={sharedCopy.groups.memoryEntriesHelp}
        action={(
          <Button
            variant="secondary"
            size="sm"
            isDisabled={entryActionsBlocked}
            aria-expanded={addFormOpen}
            onClick={() => setAddFormOpen((open) => !open)}
            label={copy.text.manualAdd}
          />
        )}
      >
        {memoryEntryPreviewBlockedReason && (
          <SettingsField>
            <Banner
              status="warning"
              role="status"
              title={copy.text.previewPaused}
              description={memoryEntryPreviewBlockedReason}
            />
          </SettingsField>
        )}
        {addFormOpen && (
          <SettingsField>
            <div className="settingsMemoryManualAdd" role="group" aria-label={copy.text.manualAddAria}>
              <small className="settingsQuietStatus">{copy.text.manualAddHelp}</small>
              <FormLayout>
                <TextInput
                  type="text"
                  value={newMemoryTitle}
                  onChange={setNewMemoryTitle}
                  label={copy.text.title}
                  placeholder={copy.text.titlePlaceholder}
                  isDisabled={entryActionsBlocked}
                  width="100%"
                />
                <TextInput
                  type="text"
                  value={newMemoryTags}
                  onChange={setNewMemoryTags}
                  label={copy.text.tags}
                  placeholder={copy.text.tagsPlaceholder}
                  isDisabled={entryActionsBlocked}
                  width="100%"
                />
                <TextArea
                  value={newMemoryContent}
                  onChange={setNewMemoryContent}
                  label={copy.text.content}
                  placeholder={copy.text.contentPlaceholder}
                  rows={3}
                  isDisabled={entryActionsBlocked}
                  width="100%"
                />
              </FormLayout>
              <SettingsActions>
                <Button
                  variant="primary"
                  isDisabled={entryActionsBlocked}
                  onClick={() => void addManualMemoryEntry()}
                  label={copy.text.addDraft}
                />
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAddFormOpen(false);
                    setNewMemoryTitle('');
                    setNewMemoryTags('');
                    setNewMemoryContent('');
                  }}
                  label={sharedCopy.cancel}
                />
              </SettingsActions>
            </div>
          </SettingsField>
        )}
        {memoryDraftHasSensitiveFields && (
          <SettingsField>
            <Banner
              status="warning"
              role="status"
              title={copy.text.sensitiveDraft}
              description={copy.text.sensitiveDraftHelp}
            />
          </SettingsField>
        )}
        {visibleMemoryEntries.entries.length > 0 ? (
          <>
            <SettingsField>
              <div className="settingsMemoryFilter">
                <TextInput
                  type="text"
                  value={memoryEntryQuery}
                  onChange={setMemoryEntryQuery}
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
            </SettingsField>
            {normalizedMemoryEntryQuery && filteredEntryCount === 0 ? (
              <SettingsField>
                {/* Filter empty (DESIGN.md §10): a filter no-match always carries
                    the clear action — the user is in a state they caused and must
                    be able to exit. */}
                <EmptyState
                  icon={<Search size={ICON_SIZE.empty} />}
                  title={copy.text.filterEmpty}
                  description={copy.text.filterEmptyHelp}
                  actions={(
                    <Button
                      variant="ghost"
                      size="sm"
                      label={copy.text.clear}
                      onClick={() => setMemoryEntryQuery('')}
                    />
                  )}
                />
              </SettingsField>
            ) : (
              <SettingsField>
                <div className="settingsMemoryEntryGroups">
                  <MemoryEntryList
                    title={copy.text.activeMemories}
                    copy={copy}
                    entries={filteredActiveEntries}
                    filtered={normalizedMemoryEntryQuery.length > 0}
                    busy={entryActionsBlocked}
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
                      busy={entryActionsBlocked}
                      pendingCopyIds={pendingMemoryActions}
                      onCopyReference={copyMemoryEntryReference}
                      onFocusDraft={focusMemoryEntryInDraft}
                      onStatusChange={updateMemoryEntryStatus}
                    />
                  )}
                </div>
              </SettingsField>
            )}
          </>
        ) : !memoryEntryPreviewBlockedReason ? (
          <SettingsField>
            {/* Panel empty (DESIGN.md §10 tier 2): the description points at the
                existing add flows; a duplicate action button here would be a
                second path to the same affordance. */}
            <EmptyState
              icon={<Brain size={ICON_SIZE.empty} />}
              title={copy.text.waitingEntry}
              description={copy.text.waitingEntryHelp}
            />
          </SettingsField>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={sharedCopy.groups.memoryDocument}
        description={sharedCopy.groups.memoryDocumentHelp}
        action={(
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            label={advancedOpen ? sharedCopy.hideDetails : sharedCopy.showDetails}
          />
        )}
        bodyClassName={advancedOpen ? undefined : 'settingsSectionBodyHidden'}
      >
        <SettingsRow
          align="start"
          label={effective.path ? displayMemoryPath(effective.path) : 'MEMORY.md'}
          description={(
            <>
              {effective.latestBackup ? (
                <span>
                  {localMemoryBackupKindLabel(effective.latestBackup.kind, copy)} · {localMemoryBackupSummary(effective.latestBackup, copy)} · <RelativeTime ts={effective.latestBackup.updatedAt} />
                </span>
              ) : (
                <span>{copy.text.waitingBackup}</span>
              )}
            </>
          )}
          end={(
            <span className="settingsMemoryDirtyState" data-dirty={memoryDraftDirty ? 'true' : 'false'}>
              {memoryDraftDirty ? copy.text.dirty : copy.text.savedDraft}
            </span>
          )}
        />
        {effective.backups && effective.backups.length > 1 && (
          <SettingsField>
            <div className="settingsMemoryBackupList" role="status">
              <strong>{copy.text.backupCandidates}</strong>
              <ul className="settingsMemoryBackupCandidates" aria-label={copy.text.backupCandidatesAria}>
                {effective.backups.map((backup) => {
                  const backupCandidateLabel = `${localMemoryBackupKindLabel(backup.kind, copy)} · ${localMemoryBackupSummary(backup, copy)}`;
                  return (
                    <li key={`${backup.kind}:${backup.path}`} className="settingsMemoryBackupCandidate">
                      <span>{backupCandidateLabel} · <RelativeTime ts={backup.updatedAt} /></span>
                      {backup.path && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={copy.openBackupAria(backupCandidateLabel)}
                          isDisabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:open`)}
                          onClick={() => void openBackupCandidate(backup)}
                          label={isMemoryActionPending(`backup:${backup.kind}:open`) ? copy.text.opening : copy.text.open}
                        />
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={copy.restoreBackupAria(backupCandidateLabel)}
                        isDisabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:restore`)}
                        onClick={() => void restoreBackupCandidate(backup)}
                        label={isMemoryActionPending(`backup:${backup.kind}:restore`) ? copy.text.restoring : copy.text.restore}
                      />
                      {backup.path && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={copy.copyBackupAria(backupCandidateLabel)}
                          isDisabled={isMemoryActionPending(`backup:${backup.kind}:copy`)}
                          onClick={() => void copyBackupReference(backup)}
                          label={isMemoryActionPending(`backup:${backup.kind}:copy`) ? copy.text.copying : copy.text.copyReference}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
              <small>{copy.text.backupHelp}</small>
            </div>
          </SettingsField>
        )}
        {lastSaveSummary && !memoryDraftDirty && (
          <SettingsField>
            <div className="settingsMemorySaveSummary" role="status">
              <strong>{lastSaveSummary.title}</strong>
              <small className="settingsMemorySaveSummaryTime">
                {copy.text.savedAt}<RelativeTime ts={lastSaveSummary.savedAt} />
              </small>
              <small>{lastSaveSummary.detail}</small>
            </div>
          </SettingsField>
        )}
        <SettingsField>
          <TextArea
            ref={editorRef}
            value={draft}
            onChange={setDraft}
            isDisabled={entryActionsBlocked}
            rows={12}
            hasSpellCheck={false}
            label={copy.text.fileContent}
            width="100%"
          />
        </SettingsField>
        {effective.reason && (
          <SettingsField>
            <p className="settingsQuietStatus" role="status">{effective.reason}</p>
          </SettingsField>
        )}
        <SettingsActions role="group" aria-label={copy.text.fileActionsAria}>
          <Button variant="primary" className="settingsActionWidthXs" isDisabled={memoryControlsDisabled || !effective.enabled || !memoryDraftDirty} onClick={() => void save()} label={pendingMemoryWriteAction === 'save' ? copy.text.saving : memoryDraftDirty ? copy.text.save : copy.text.saved} />
          {hasLocalMemoryPaths && <Button variant="ghost" isDisabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:file:open')} onClick={() => void openFile()} label={isMemoryActionPending('memory:file:open') ? copy.text.opening : copy.text.openFile} />}
          <Button variant="ghost" isDisabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reloadDraftFromDisk()} label={pendingMemoryWriteAction === 'reload' ? copy.text.loading : copy.text.reload} />
          <MoreMenu
            label={copy.text.fileActionsAria}
            size="sm"
            items={[
              { label: copy.text.openFolder, isDisabled: memoryControlsDisabled || !effective.enabled || !hasLocalMemoryPaths, onClick: () => void openFolder() },
              { label: copy.text.copyPath, isDisabled: !hasLocalMemoryPaths, onClick: () => void copyPath() },
              { type: 'divider' },
              { label: copy.text.openPrevious, isDisabled: memoryControlsDisabled || !effective.enabled || !effective.latestBackup?.path, onClick: () => void openLatestBackup() },
              { label: copy.text.copyPrevious, isDisabled: !effective.latestBackup?.path, onClick: () => void copyLatestBackupReference() },
              { label: copy.text.restorePrevious, isDisabled: memoryControlsDisabled || !effective.enabled || !effective.latestBackup, onClick: () => void restoreLatestBackup() },
              { type: 'divider' },
              { label: copy.text.resetBackup, isDisabled: memoryControlsDisabled || !effective.enabled, onClick: () => void reset() },
            ]}
          />
        </SettingsActions>
      </SettingsSection>

      {advancedOpen && <MemoryPromptPreviewSection
        copy={copy}
        active={promptPreviewWillInject}
        preview={localMemoryPromptPreview}
        budgetLabel={localMemoryPromptPreviewBudgetLabel}
        blockedReason={promptPreviewBlockedReason}
        safeMode={effective.status === 'safe_mode'}
        copyPending={isMemoryActionPending('memory:prompt-preview:copy')}
        onCopy={copyLocalMemoryPromptPreview}
      />}
    </SettingsPage>
  );
}
