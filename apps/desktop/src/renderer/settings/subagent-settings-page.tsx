import { useMemo, useState } from 'react';
import { Badge, HStack, Text, VStack } from '@astryxdesign/core';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import {
  connectionEnabledModelIds,
  isSafeSubagentPresetId,
  MAX_SUBAGENT_PRESETS,
  thinkingVariantsForModel,
  type AppSettings,
  type LlmConnection,
  type SubagentPreset,
  type SubagentProfile,
  type ThinkingLevel,
  type UpdateAppSettingsResult,
} from '@maka/core';
import {
  Button,
  EmptyState,
  FormLayout,
  Selector,
  Switch,
  TextArea,
  TextInput,
  type SelectorOptionData,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { AlertTriangle } from '@maka/ui/icons';
import { getSubagentSettingsCopy } from '../locales/settings-subagents-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import { SettingsPage, SettingsRow, SettingsSection } from './settings-section.js';
import {
  subagentPresetAvailability,
  suggestSubagentPresetId,
} from './subagent-preset-presentation.js';
import { statusBadgeVariant } from './settings-status-badge.js';

type EditorDraft = {
  id: string;
  name: string;
  description: string;
  profile: SubagentProfile;
  connectionSlug: string;
  model: string;
  thinkingLevel: ThinkingLevel | '';
  enabled: boolean;
};

export function SubagentSettingsPage(props: {
  settings: AppSettings;
  connections: readonly LlmConnection[];
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSubagentSettingsCopy(locale);
  const toast = useToast();
  const [editorPresetId, setEditorPresetId] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const presets = props.settings.subagents.presets;
  const editorPreset = editorPresetId == null
    ? null
    : presets.find((preset) => preset.id === editorPresetId) ?? null;
  const enabledCount = presets.filter((preset) => preset.enabled).length;
  const atLimit = presets.length >= MAX_SUBAGENT_PRESETS;

  async function persist(nextPresets: SubagentPreset[]): Promise<boolean> {
    setSaving(true);
    try {
      await props.onUpdate({ subagents: { presets: nextPresets } });
      return true;
    } catch (error) {
      toast.error(copy.toast.saveFailed, settingsActionErrorMessage(error, locale));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function savePreset(next: SubagentPreset): Promise<boolean> {
    const nextPresets = editorPresetId == null
      ? [...presets, next]
      : presets.map((candidate) => candidate.id === editorPresetId ? next : candidate);
    return persist(nextPresets);
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
    await persist(presets.filter((candidate) => candidate.id !== preset.id));
  }

  return (
    <SettingsPage className="settingsSubagentsPage">
      <SettingsSection
        title={copy.section.title}
        description={`${copy.section.description} ${copy.section.count(enabledCount, presets.length)}`}
        action={(
          <Button
            variant="primary"
            size="sm"
            label={atLimit ? copy.section.limitReached : copy.section.add}
            isDisabled={saving || atLimit}
            onClick={() => setEditorPresetId(null)}
          />
        )}
      >
        {presets.length === 0 ? (
          <EmptyState
            title={copy.section.emptyTitle}
            description={copy.section.emptyDescription}
            actions={(
              <Button
                variant="primary"
                label={copy.section.add}
                isDisabled={saving}
                onClick={() => setEditorPresetId(null)}
              />
            )}
          />
        ) : presets.map((preset) => {
          const availability = subagentPresetAvailability(preset, props.connections);
          const connection = props.connections.find(
            (candidate) => candidate.slug === preset.connectionSlug,
          );
          const profile = copy.profiles[preset.profile];
          const statusLabel = {
            available: copy.status.available,
            disabled: copy.status.disabled,
            missing_connection: copy.status.missingConnection,
            connection_disabled: copy.status.connectionDisabled,
            model_disabled: copy.status.modelDisabled,
          }[availability.kind];
          const thinking = preset.thinkingLevel
            ? copy.thinking[preset.thinkingLevel]
            : undefined;
          return (
            <SettingsRow
              key={preset.id}
              align="start"
              label={(
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <span>{preset.name}</span>
                  <Badge
                    variant={statusBadgeVariant(availability.tone)}
                    label={statusLabel}
                  />
                </HStack>
              )}
              description={(
                <VStack gap={0.5}>
                  <span>{preset.description || copy.row.fallbackDescription}</span>
                  <Text type="supporting" size="sm" color="secondary">
                    {copy.row.route(
                      profile.label,
                      connection?.name ?? preset.connectionSlug,
                      preset.model,
                      thinking,
                    )}
                    {' · '}
                    <code>{preset.id}</code>
                  </Text>
                </VStack>
              )}
              end={(
                <div className="subagentPresetActions">
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
                  <Button
                    variant="secondary"
                    size="sm"
                    label={copy.row.edit}
                    isDisabled={saving}
                    onClick={() => setEditorPresetId(preset.id)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    label={copy.row.remove}
                    isDisabled={saving}
                    onClick={() => void removePreset(preset)}
                  />
                </div>
              )}
            />
          );
        })}
      </SettingsSection>

      {editorPresetId !== undefined ? (
        <SubagentPresetEditor
          key={editorPreset?.id ?? 'new'}
          preset={editorPreset}
          presets={presets}
          connections={props.connections}
          isSaving={saving}
          onClose={() => setEditorPresetId(undefined)}
          onSave={async (next) => {
            const saved = await savePreset(next);
            if (saved) setEditorPresetId(undefined);
          }}
        />
      ) : null}
    </SettingsPage>
  );
}

function SubagentPresetEditor(props: {
  preset: SubagentPreset | null;
  presets: readonly SubagentPreset[];
  connections: readonly LlmConnection[];
  isSaving: boolean;
  onClose(): void;
  onSave(preset: SubagentPreset): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getSubagentSettingsCopy(locale);
  const usableConnections = useMemo(
    () => props.connections.filter((connection) => connection.enabled),
    [props.connections],
  );
  const existingIds = useMemo(
    () => new Set(props.presets.filter((preset) => preset.id !== props.preset?.id).map((preset) => preset.id)),
    [props.preset?.id, props.presets],
  );
  const initialConnection = props.preset
    ? props.connections.find((connection) => connection.slug === props.preset?.connectionSlug)
    : usableConnections[0];
  const initialModels = initialConnection && initialConnection.enabled
    ? connectionEnabledModelIds(initialConnection)
    : [];
  const [draft, setDraft] = useState<EditorDraft>(() => ({
    id: props.preset?.id ?? suggestSubagentPresetId('', existingIds),
    name: props.preset?.name ?? '',
    description: props.preset?.description ?? '',
    profile: props.preset?.profile ?? 'local_read',
    connectionSlug: props.preset?.connectionSlug ?? usableConnections[0]?.slug ?? '',
    model: props.preset?.model ?? initialModels[0] ?? '',
    thinkingLevel: props.preset?.thinkingLevel ?? '',
    enabled: props.preset?.enabled ?? true,
  }));
  const [idWasEdited, setIdWasEdited] = useState(props.preset !== null);
  const [submitted, setSubmitted] = useState(false);
  const selectedConnection = props.connections.find(
    (connection) => connection.slug === draft.connectionSlug,
  );
  const enabledModels = selectedConnection?.enabled
    ? connectionEnabledModelIds(selectedConnection)
    : [];
  const thinkingLevels = selectedConnection
    ? thinkingVariantsForModel(selectedConnection.providerType, draft.model)
    : [];
  const profileCopy = copy.profiles[draft.profile];
  const validId = isSafeSubagentPresetId(draft.id.trim());
  const duplicateId = existingIds.has(draft.id.trim());
  const validRoute = Boolean(
    selectedConnection?.enabled && enabledModels.includes(draft.model),
  );
  const canSave = Boolean(
    draft.name.trim() &&
    draft.description.trim() &&
    validId &&
    !duplicateId &&
    validRoute,
  );
  const connectionOptions = props.connections.map((connection) => ({
    value: connection.slug,
    label: connection.name,
    disabled: !connection.enabled,
  }));
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

  function updateName(name: string): void {
    setDraft((current) => ({
      ...current,
      name,
      ...(!idWasEdited ? { id: suggestSubagentPresetId(name, existingIds) } : {}),
    }));
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

  function selectModel(model: string): void {
    setDraft((current) => ({ ...current, model, thinkingLevel: '' }));
  }

  async function submit(): Promise<void> {
    setSubmitted(true);
    if (!canSave) return;
    await props.onSave({
      id: draft.id.trim(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      profile: draft.profile,
      connectionSlug: draft.connectionSlug,
      model: draft.model,
      ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
      enabled: draft.enabled,
    });
  }

  const idStatus = submitted && !validId
    ? { type: 'error' as const, message: copy.editor.invalidId }
    : submitted && duplicateId
      ? { type: 'error' as const, message: copy.editor.duplicateId }
      : undefined;

  return (
    <Dialog
      isOpen
      onOpenChange={(isOpen) => { if (!isOpen) props.onClose(); }}
      className="subagentPresetEditorDialog"
      width={560}
      maxHeight="calc(100dvh - 80px)"
      purpose="form"
    >
      <Layout
        header={(
          <DialogHeader
            title={props.preset ? copy.editor.editTitle : copy.editor.createTitle}
            subtitle={props.preset ? copy.editor.editSubtitle : copy.editor.createSubtitle}
            onOpenChange={(isOpen) => { if (!isOpen) props.onClose(); }}
          />
        )}
        content={(
          <LayoutContent padding={6} isScrollable>
            <FormLayout>
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
              <TextInput
                label={copy.editor.id}
                description={copy.editor.idDescription}
                value={draft.id}
                placeholder={copy.editor.idPlaceholder}
                isDisabled={props.preset !== null || props.isSaving}
                status={idStatus}
                onChange={(id) => {
                  setIdWasEdited(true);
                  setDraft((current) => ({ ...current, id }));
                }}
              />
              <TextArea
                label={copy.editor.description}
                description={copy.editor.descriptionHelp}
                value={draft.description}
                placeholder={copy.editor.descriptionPlaceholder}
                rows={3}
                isDisabled={props.isSaving}
                status={submitted && !draft.description.trim()
                  ? { type: 'error', message: copy.editor.requiredDescription }
                  : undefined}
                onChange={(description) => setDraft((current) => ({ ...current, description }))}
              />
              <Selector
                label={copy.editor.profile}
                description={profileCopy.description}
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
              {draft.profile === 'implementation' ? (
                <div className="subagentPresetWarning" role="note">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <Text type="supporting" size="sm">{copy.editor.implementationWarning}</Text>
                </div>
              ) : null}
              <FormLayout direction="horizontal">
                <Selector
                  label={copy.editor.connection}
                  value={draft.connectionSlug}
                  options={connectionOptions}
                  width="100%"
                  isDisabled={props.isSaving || usableConnections.length === 0}
                  disabledMessage={usableConnections.length === 0 ? copy.editor.noConnection : undefined}
                  status={submitted && !validRoute
                    ? { type: 'error', message: copy.editor.invalidRoute }
                    : usableConnections.length === 0
                      ? { type: 'warning', message: copy.editor.noConnection }
                      : undefined}
                  onChange={selectConnection}
                />
                <Selector
                  label={copy.editor.model}
                  value={draft.model}
                  options={modelOptions}
                  width="100%"
                  isDisabled={props.isSaving || enabledModels.length === 0}
                  disabledMessage={enabledModels.length === 0 ? copy.editor.noModel : undefined}
                  onChange={selectModel}
                />
              </FormLayout>
              {thinkingLevels.length > 0 ? (
                <Selector
                  label={copy.editor.thinking}
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
              ) : null}
              <Switch
                label={copy.editor.enabled}
                description={copy.editor.enabledDescription}
                value={draft.enabled}
                isDisabled={props.isSaving}
                onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
              <div className="subagentPresetEditorActions">
                <Button
                  variant="ghost"
                  label={copy.editor.cancel}
                  isDisabled={props.isSaving}
                  onClick={props.onClose}
                />
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
              </div>
            </FormLayout>
          </LayoutContent>
        )}
      />
    </Dialog>
  );
}
