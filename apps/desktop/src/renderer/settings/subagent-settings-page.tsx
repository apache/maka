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

// 设置 · 子 Agent — the approved model routes the main agent may delegate to.
//
// Two levels, one container, one back affordance, and nothing modal:
//
//   list ── editor(new | existing)
//
// The providers panel next door answers the same list→detail shape, so this
// page follows it rather than inventing a second answer — down to the shared
// focus controller and route header.
//
// The page owns no CSS of its own: layout comes from the settings kit and the
// controls from `@maka/ui`, and `.settingsRouteLevel` is the route-level focus
// reset it shares with the providers panel.
import { useId, useMemo, useRef, useState } from 'react';
import { Banner, HStack, VStack } from '@astryxdesign/core';
import {
  isSafeSubagentPresetId,
  MAX_SUBAGENT_PRESETS,
  SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS,
  SUBAGENT_PRESET_ID_MAX_CHARS,
  SUBAGENT_PRESET_NAME_MAX_CHARS,
  type SubagentPreset,
  type SubagentProfile,
} from '@maka/core/subagent-settings';
import { type AppSettings, type UpdateAppSettingsResult } from '@maka/core/settings';
import { type LlmConnection } from '@maka/core/llm-connections';
import { type ThinkingLevel } from '@maka/core/model-thinking';
import { connectionEnabledModelIds } from '@maka/core/llm-connections';
import { thinkingVariantsForConnection } from '@maka/core/model-thinking';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Selector,
  Switch,
  TextArea,
  TextInput,
  type SelectorOptionData,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { ICON_SIZE, ChevronRight, Workflow } from '@maka/ui/icons';
import { getSubagentSettingsCopy } from '../locales/settings-subagents-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import { useSettingsRouteFocus } from './settings-route-focus.js';
import { SettingsRouteHeader } from './settings-route-header.js';
import {
  SettingsActions,
  SettingsField,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './settings-section.js';
import { SettingRow } from './settings-rows.js';
import {
  isSelectableSubagentConnection,
  nextSubagentDraftForName,
  resolveSubagentRoute,
  subagentPresetAvailability,
  type SubagentPageRoute,
} from './subagent-preset-presentation.js';
import { statusBadgeVariant } from './settings-status-badge.js';
import { useRuntimeHostSettingsErrorReporter } from './runtime-host-settings-target.js';

/** How many characters a value spends on leading whitespace the store trims. */
function leadingSpace(value: string): number {
  return value.length - value.trimStart().length;
}

/** The preset as the form holds it: `thinkingLevel` gains the Selector's ''. */
type SubagentEditorDraft = Omit<SubagentPreset, 'thinkingLevel'> & {
  thinkingLevel: ThinkingLevel | '';
};

export function SubagentSettingsPage(props: {
  settings: AppSettings;
  connections: readonly LlmConnection[];
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
}) {
  const reportHostError = useRuntimeHostSettingsErrorReporter();
  const locale = useUiLocale();
  const copy = getSubagentSettingsCopy(locale);
  const toast = useToast();
  const [route, setRoute] = useState<SubagentPageRoute>({ kind: 'list' });
  const [saving, setSaving] = useState(false);
  const presets = props.settings.subagents.presets;
  const { level, preset: editorPreset } = resolveSubagentRoute(route, presets);
  const atLimit = presets.length >= MAX_SUBAGENT_PRESETS;
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const listReturnFocusRef = useRef<string | null>(null);
  const detailTitleId = useId();

  useSettingsRouteFocus({
    level,
    resolveTarget: (current) => {
      // The region rather than its back button, so a screen reader announces
      // the preset the user landed in instead of the way out of it.
      if (current !== 'list') {
        return document.querySelector<HTMLElement>('[data-maka-contract="subagent-detail"]');
      }
      // Consumed here and only here: the ref is set on the way down. The row
      // may be gone — that is exactly what a deletion does — so the add button
      // is the fallback, not the default.
      const returnToId = listReturnFocusRef.current;
      listReturnFocusRef.current = null;
      return (returnToId
        ? document.querySelector<HTMLElement>(`[data-subagent-preset="${returnToId}"]`)
        : null) ?? addButtonRef.current;
    },
  });

  function openEditor(presetId: string): void {
    listReturnFocusRef.current = presetId;
    setRoute({ kind: 'edit', presetId });
  }

  function openCreate(): void {
    // Nothing to return to: the create level was not opened from a row.
    listReturnFocusRef.current = null;
    setRoute({ kind: 'create' });
  }

  /**
   * Settings normalization DROPS a preset it dislikes instead of rejecting the
   * write, so a resolved promise is not a saved preset. The fields the user
   * can get wrong are held inside their limits before they are submitted;
   * `expectPresent` is the backstop for the rest — a count that filled up
   * elsewhere, a rule this page has not heard about — because the alternative
   * failure is silent, and returns the user to a list missing what they saved.
   */
  async function persist(
    nextPresets: SubagentPreset[],
    expectPresent?: string,
  ): Promise<boolean> {
    setSaving(true);
    try {
      const result = await props.onUpdate({ subagents: { presets: nextPresets } });
      if (
        expectPresent !== undefined &&
        !result.settings.subagents.presets.some((candidate) => candidate.id === expectPresent)
      ) {
        reportHostError(copy.toast.saveFailed, copy.toast.rejected);
        return false;
      }
      return true;
    } catch (error) {
      reportHostError(
        copy.toast.saveFailed,
        settingsActionErrorMessage(error, locale),
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removePreset(preset: SubagentPreset): Promise<void> {
    const confirmed = await toast.confirm({
      title: copy.remove.title(preset.name),
      description: copy.remove.description,
      confirmLabel: copy.remove.confirm,
      cancelLabel: copy.remove.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    // No `setRoute`: with the preset gone the edit route is unsatisfiable, so
    // `resolveSubagentRoute` renders the list for this path and for a deletion
    // that happened somewhere else alike.
    await persist(presets.filter((candidate) => candidate.id !== preset.id));
  }

  if (level !== 'list') {
    return (
      // A named region, so a screen reader announces which preset the user
      // landed in. tabIndex -1 so the level itself can take the focus the
      // route-focus hook hands it; it draws no ring.
      <VStack
        gap={5}
        tabIndex={-1}
        role="region"
        aria-labelledby={detailTitleId}
        className="settingsRouteLevel"
        data-maka-contract="subagent-detail"
      >
        <SettingsRouteHeader
          onBack={() => setRoute({ kind: 'list' })}
          backLabel={copy.editor.backToList}
          // Leaving mid-save discards a draft the failed write cannot give back.
          isBackDisabled={saving}
          titleId={detailTitleId}
          title={editorPreset ? editorPreset.name : copy.section.add}
          subtitle={editorPreset ? copy.editor.editSubtitle : copy.editor.createSubtitle}
        />
        <SubagentPresetEditor
          key={editorPreset?.id ?? 'new'}
          preset={editorPreset}
          presets={presets}
          connections={props.connections}
          isSaving={saving}
          onCancel={() => setRoute({ kind: 'list' })}
          onDelete={editorPreset ? () => void removePreset(editorPreset) : undefined}
          onSave={async (next) => {
            const nextPresets = editorPreset
              ? presets.map((candidate) => candidate.id === editorPreset.id ? next : candidate)
              : [...presets, next];
            if (await persist(nextPresets, next.id)) setRoute({ kind: 'list' });
          }}
        />
      </VStack>
    );
  }

  return (
    <SettingsPage>
      <SettingsSection
        title={copy.section.title}
        /* The 「/ 64」 was a system ceiling nobody can raise or act on;
           MAX_SUBAGENT_PRESETS still gates creation, and the disabled
           新建 button says so when you actually reach it. */
        description={copy.section.count(presets.length)}
        action={presets.length > 0 ? (
          <Button
            ref={addButtonRef}
            variant="primary"
            size="sm"
            label={copy.section.add}
            isDisabled={saving || atLimit}
            onClick={openCreate}
          />
        ) : undefined}
      >
        {presets.length === 0 ? (
          // The empty state owns the only call to action on an empty page.
          (<EmptyState
            icon={<Workflow size={ICON_SIZE.empty} />}
            title={copy.section.emptyTitle}
            description={copy.section.emptyDescription}
            actions={(
              <Button
                ref={addButtonRef}
                variant="primary"
                label={copy.section.add}
                isDisabled={saving}
                onClick={openCreate}
              />
            )}
          />)
        ) : presets.map((preset) => {
          const availability = subagentPresetAvailability(preset, props.connections);
          // Only a route the main agent cannot take earns a badge: 已停用 is
          // the switch beside it said twice, and a row that says 可用 says
          // nothing a list of approved presets does not already say.
          const problem = {
            available: null,
            disabled: null,
            missing_connection: copy.status.missingConnection,
            provider_retired: copy.status.providerRetired,
            connection_disabled: copy.status.connectionDisabled,
            model_disabled: copy.status.modelDisabled,
          }[availability.kind];
          return (
            <SettingsRow
              key={preset.id}
              align="start"
              label={(
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <span>{preset.name}</span>
                  {problem ? (
                    <Badge variant={statusBadgeVariant(availability.tone)} label={problem} />
                  ) : null}
                </HStack>
              )}
              description={preset.description || copy.row.fallbackDescription}
              end={(
                <>
                  <Switch
                    label={`${copy.row.enabled}: ${preset.name}`}
                    isLabelHidden
                    value={preset.enabled}
                    isDisabled={saving}
                    onChange={(enabled) => {
                      void persist(
                        presets.map((candidate) =>
                          candidate.id === preset.id ? { ...candidate, enabled } : candidate,
                        ),
                      );
                    }}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    label={copy.row.configure(preset.name)}
                    tooltip={copy.row.configure(preset.name)}
                    icon={<ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" />}
                    isDisabled={saving}
                    // The focus anchor for the way back.
                    data-subagent-preset={preset.id}
                    onClick={() => openEditor(preset.id)}
                  />
                </>
              )}
            />
          );
        })}
      </SettingsSection>
    </SettingsPage>
  );
}

function SubagentPresetEditor(props: {
  preset: SubagentPreset | null;
  presets: readonly SubagentPreset[];
  connections: readonly LlmConnection[];
  isSaving: boolean;
  onCancel(): void;
  onDelete?(): void;
  onSave(preset: SubagentPreset): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getSubagentSettingsCopy(locale);
  const usableConnections = useMemo(
    () => props.connections.filter(isSelectableSubagentConnection),
    [props.connections],
  );
  const existingIds = useMemo(
    () => new Set(props.presets.filter((preset) => preset.id !== props.preset?.id).map((preset) => preset.id)),
    [props.preset?.id, props.presets],
  );
  const initialConnection = props.preset
    ? props.connections.find((connection) => connection.slug === props.preset?.connectionSlug)
    : usableConnections[0];
  const initialModels = initialConnection && isSelectableSubagentConnection(initialConnection)
    ? connectionEnabledModelIds(initialConnection)
    : [];
  const [draft, setDraft] = useState<SubagentEditorDraft>(() => ({
    // Empty, not a pre-derived `subagent`: an id the user has not been asked
    // for yet reads as a value the page already decided.
    id: props.preset?.id ?? '',
    name: props.preset?.name ?? '',
    description: props.preset?.description ?? '',
    profile: props.preset?.profile ?? 'local_read',
    connectionSlug: props.preset?.connectionSlug ?? usableConnections[0]?.slug ?? '',
    model: props.preset?.model ?? initialModels[0] ?? '',
    thinkingLevel: props.preset?.thinkingLevel ?? '',
    enabled: props.preset?.enabled ?? true,
  }));
  const [idWasEdited, setIdWasEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const selectedConnection = props.connections.find(
    (connection) => connection.slug === draft.connectionSlug,
  );
  const enabledModels = selectedConnection && isSelectableSubagentConnection(selectedConnection)
    ? connectionEnabledModelIds(selectedConnection)
    : [];
  const thinkingLevels = selectedConnection
    ? thinkingVariantsForConnection(selectedConnection, draft.model)
    : [];
  const profileCopy = copy.profiles[draft.profile];
  const validId = isSafeSubagentPresetId(draft.id.trim());
  const duplicateId = existingIds.has(draft.id.trim());
  const validConnection = Boolean(
    selectedConnection && isSelectableSubagentConnection(selectedConnection),
  );
  const validModel = enabledModels.includes(draft.model);
  const canSave = Boolean(
    draft.name.trim() &&
    (props.preset !== null || (validId && !duplicateId)) &&
    validConnection &&
    validModel,
  );
  const connectionOptions = props.connections.map((connection) => {
    // Enabled yet unselectable means retired. Its option says why it cannot
    // be picked, the way a vanished connection's placeholder below does — a
    // silently disabled row would be exactly the unexplained state this
    // retirement is meant to avoid.
    const retired = connection.enabled && !isSelectableSubagentConnection(connection);
    return {
      value: connection.slug,
      label: retired ? `${connection.name} · ${copy.status.providerRetired}` : connection.name,
      disabled: !isSelectableSubagentConnection(connection),
    };
  });
  if (
    draft.connectionSlug &&
    !props.connections.some((connection) => connection.slug === draft.connectionSlug)
  ) {
    connectionOptions.unshift({
      value: draft.connectionSlug,
      label: `${draft.connectionSlug} · ${copy.status.missingConnection}`,
      disabled: true,
    });
  }
  const modelOptions: SelectorOptionData[] = enabledModels.map((model) => ({
    value: model,
    label: model,
  }));
  if (draft.model && !enabledModels.includes(draft.model)) {
    modelOptions.unshift({
      value: draft.model,
      label: `${draft.model} · ${copy.status.modelDisabled}`,
      disabled: true,
    });
  }

  function updateName(value: string): void {
    // Capped at the one place the name changes, because the store DROPS a
    // preset whose name is over the limit rather than trimming it — an error
    // message would arrive after the row had already disappeared, and Astryx's
    // TextInput has no maxLength to lean on. Measured the way the store
    // measures it, after trimming, so leading spaces cost no real characters.
    const name = value.slice(0, SUBAGENT_PRESET_NAME_MAX_CHARS + leadingSpace(value));
    // An existing preset's id is settled: it is not rendered in this branch and
    // it is not derived here either, so the two cannot disagree.
    if (props.preset) {
      setDraft((current) => ({ ...current, name }));
      return;
    }
    setDraft((current) => nextSubagentDraftForName(current, name, idWasEdited, existingIds));
  }

  function selectConnection(connectionSlug: string): void {
    const connection = usableConnections.find((candidate) => candidate.slug === connectionSlug);
    const models = connection ? connectionEnabledModelIds(connection) : [];
    setDraft((current) => ({
      ...current,
      connectionSlug,
      model: models[0] ?? '',
      thinkingLevel: '',
    }));
  }

  async function submit(): Promise<void> {
    setSubmitted(true);
    if (!canSave) return;
    await props.onSave({
      // An existing preset's id comes from the preset, never from the draft:
      // session history and the main agent's routing key on it, and the field
      // is not even rendered in this branch.
      id: props.preset ? props.preset.id : draft.id.trim(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      profile: draft.profile,
      connectionSlug: draft.connectionSlug,
      model: draft.model,
      // Only if the row is on screen: a level left over from a previous model
      // is not a choice the user can still see, let alone change.
      ...(draft.thinkingLevel && thinkingLevels.includes(draft.thinkingLevel)
        ? { thinkingLevel: draft.thinkingLevel }
        : {}),
      enabled: draft.enabled,
    });
  }

  const idStatus = submitted && !validId
    ? { type: 'error' as const, message: copy.editor.invalidId(SUBAGENT_PRESET_ID_MAX_CHARS) }
    : submitted && duplicateId
      ? { type: 'error' as const, message: copy.editor.duplicateId }
      : undefined;

  return (
    <SettingsPage>
      {/* Name and guidance are prose the user writes, so they are full-width
          fields, not values crammed into a row's end slot. */}
      <SettingsSection title={copy.editor.groupPurpose} description={copy.editor.groupPurposeHelp}>
        <SettingsField>
          <TextInput
            label={copy.editor.name}
            value={draft.name}
            placeholder={copy.editor.namePlaceholder}
            isDisabled={props.isSaving}
            status={submitted && !draft.name.trim()
              ? { type: 'error', message: copy.editor.requiredName }
              : undefined}
            onChange={updateName}
          />
        </SettingsField>
        <SettingsField>
          {/* Optional, because the stored contract is: the list carries a
              fallback line for a preset that has no guidance yet. */}
          <TextArea
            label={copy.editor.description}
            value={draft.description}
            placeholder={copy.editor.descriptionPlaceholder}
            rows={3}
            // The counter is Astryx's; the cap is ours, because `maxLength`
            // only styles the counter and the store truncates silently.
            maxLength={SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS}
            isDisabled={props.isSaving}
            onChange={(description) => setDraft((current) => ({
              ...current,
              description: description.slice(
                0,
                SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS + leadingSpace(description),
              ),
            }))}
          />
        </SettingsField>
        {/* An existing id is a settled fact — session history and the main
            agent's routing both reference it — so it reads as a row's value.
            Only a new preset's id is still the user's to type. */}
        {props.preset ? (
          <SettingRow
            title={copy.editor.id}
            detail={copy.editor.idDescription}
            value={props.preset.id}
            mono
          />
        ) : (
          <SettingsField>
            <TextInput
              label={copy.editor.id}
              description={copy.editor.idDescription}
              value={draft.id}
              placeholder={copy.editor.idPlaceholder}
              isDisabled={props.isSaving}
              status={idStatus}
              onChange={(id) => {
                setIdWasEdited(true);
                setDraft((current) => ({ ...current, id }));
              }}
            />
          </SettingsField>
        )}
      </SettingsSection>

      <SettingsSection title={copy.editor.groupRoute} description={copy.editor.groupRouteHelp}>
        <SettingsRow
          label={copy.editor.profile}
          description={profileCopy.description}
          align="start"
          end={(
            <Selector
              label={copy.editor.profile}
              isLabelHidden
              value={draft.profile}
              options={(Object.keys(copy.profiles) as SubagentProfile[]).map((profile) => ({
                value: profile,
                label: copy.profiles[profile].label,
              }))}
              width="100%"
              isDisabled={props.isSaving}
              onChange={(profile) => setDraft((current) => ({
                ...current,
                profile: profile as SubagentProfile,
              }))}
            />
          )}
        />
        {draft.profile === 'implementation' ? (
          <SettingsField>
            <Banner status="warning" title={copy.editor.implementationWarning} />
          </SettingsField>
        ) : null}
        <SettingsRow
          label={copy.editor.connection}
          end={(
            <Selector
              label={copy.editor.connection}
              isLabelHidden
              value={draft.connectionSlug}
              options={connectionOptions}
              width="100%"
              isDisabled={props.isSaving || usableConnections.length === 0}
              disabledMessage={usableConnections.length === 0 ? copy.editor.noConnection : undefined}
              status={submitted && !validConnection
                ? { type: 'error', message: copy.editor.invalidConnection }
                : usableConnections.length === 0
                  ? { type: 'warning', message: copy.editor.noConnection }
                  : undefined}
              onChange={selectConnection}
            />
          )}
        />
        <SettingsRow
          label={copy.editor.model}
          end={(
            <Selector
              label={copy.editor.model}
              isLabelHidden
              value={draft.model}
              options={modelOptions}
              width="100%"
              isDisabled={props.isSaving || enabledModels.length === 0}
              disabledMessage={enabledModels.length === 0 ? copy.editor.noModel : undefined}
              // The route is two choices, so it gets two errors: an enabled
              // connection with no model selected is the model's problem.
              status={submitted && validConnection && !validModel
                ? { type: 'error', message: copy.editor.invalidModel }
                : undefined}
              onChange={(model) => setDraft((current) => ({ ...current, model, thinkingLevel: '' }))}
            />
          )}
        />
        {thinkingLevels.length > 0 ? (
          <SettingsRow
            label={copy.editor.thinking}
            end={(
              <Selector
                label={copy.editor.thinking}
                isLabelHidden
                value={thinkingLevels.includes(draft.thinkingLevel as ThinkingLevel)
                  ? draft.thinkingLevel
                  : ''}
                options={[
                  { value: '', label: copy.editor.defaultThinking },
                  ...thinkingLevels.map((level) => ({ value: level, label: copy.thinking[level] })),
                ]}
                width="100%"
                isDisabled={props.isSaving}
                onChange={(thinkingLevel) => setDraft((current) => ({
                  ...current,
                  thinkingLevel: thinkingLevel as ThinkingLevel | '',
                }))}
              />
            )}
          />
        ) : null}
        <SettingsRow
          label={copy.editor.enabled}
          description={copy.editor.enabledDescription}
          align="start"
          end={(
            <Switch
              label={copy.editor.enabled}
              isLabelHidden
              value={draft.enabled}
              isDisabled={props.isSaving}
              onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          )}
        />
      </SettingsSection>

      {/* Save commits the whole preset, not the group above it. */}
      <HStack gap={2} wrap="wrap">
        <Button
          variant="primary"
          label={props.isSaving
            ? copy.editor.saving
            : props.preset
              ? copy.editor.save
              : copy.editor.create}
          isDisabled={props.isSaving}
          onClick={() => void submit()}
        />
        <Button
          variant="ghost"
          label={copy.editor.cancel}
          isDisabled={props.isSaving}
          onClick={props.onCancel}
        />
      </HStack>

      {/* Deletion is last and stands alone, so a mis-aimed cursor has nothing
          quiet to hit beside it. */}
      {props.onDelete ? (
        <SettingsSection title={copy.editor.dangerZone} description={copy.editor.dangerZoneHelp}>
          <SettingsActions>
            <Button
              variant="destructive"
              label={copy.editor.delete}
              isDisabled={props.isSaving}
              onClick={props.onDelete}
            />
          </SettingsActions>
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
