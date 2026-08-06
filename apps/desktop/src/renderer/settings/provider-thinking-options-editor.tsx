import { useState } from 'react';
import { MultiSelector, Selector, Text } from '@astryxdesign/core';
import { THINKING_LEVELS, type ModelInfo, type ThinkingOptions } from '@maka/core';
import { useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { SettingsExpandableRow } from './settings-expandable-row';

/**
 * Per-model thinking-level declaration editor for connections whose models
 * have no built-in catalog entry (openai-compatible relays and other
 * user-configured gateways). The user states which effort values their relay's
 * backing model accepts; `thinkingVariantsForConnection` then reports those
 * levels, and the chat composer gains the thinking-level selector that the
 * UI otherwise hides for such models.
 *
 * Declared values are the provider-native `reasoning_effort` enum: `none`
 * (surfaces as the off level), `low`, `medium`, `high`, `xhigh`, `max`. They
 * are sent verbatim, so the hint tells the user to confirm what their relay
 * actually passes through before declaring more than the common `low/high/max`.
 */
const EFFORT_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'none', label: 'off' },
  ...THINKING_LEVELS.filter((level) => level !== 'off').map((level) => ({
    value: level,
    label: level,
  })),
];

const EFFORT_ORDER = new Map(EFFORT_CHOICES.map((choice, index) => [choice.value, index] as const));

function orderEfforts(efforts: readonly string[]): string[] {
  return [...efforts].sort((a, b) => (EFFORT_ORDER.get(a) ?? 0) - (EFFORT_ORDER.get(b) ?? 0));
}

function declaredEfforts(model: ModelInfo | undefined): string[] {
  return [...(model?.thinkingOptions?.efforts ?? [])];
}

function sameEfforts(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const orderedA = orderEfforts(a);
  const orderedB = orderEfforts(b);
  return orderedA.every((value, index) => value === orderedB[index]);
}

export function ThinkingOptionsEditor(props: {
  models: ModelInfo[];
  enabledModelIds: string[];
  disabled: boolean;
  isEditing: boolean;
  onEdit(): void;
  onCancel(): void;
  onSave(modelId: string, thinkingOptions: ThinkingOptions | undefined): Promise<boolean>;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  // Editable models are the enabled ones (declaring an option for a model the
  // user has disabled would silently do nothing until re-enabled).
  const editableModels = props.models.filter((model) => props.enabledModelIds.includes(model.id));
  const declaredCount = props.models.filter((model) => model.thinkingOptions !== undefined).length;

  const [draftModelId, setDraftModelId] = useState<string>(editableModels[0]?.id ?? '');
  const [draftEfforts, setDraftEfforts] = useState<string[]>(
    declaredEfforts(editableModels[0]),
  );

  const draftModel = editableModels.find((model) => model.id === draftModelId);
  // Switching models already re-seeds the draft from that model's declaration,
  // so a save is only offered when the selected model's efforts actually differ
  // from what is persisted.
  const hasDraftChange = !sameEfforts(draftEfforts, declaredEfforts(draftModel));

  return (
    <SettingsExpandableRow
      label={copy.thinkingOptions}
      value={
        declaredCount === 0
          ? copy.thinkingOptionsNone
          : copy.thinkingOptionsDeclared(declaredCount)
      }
      actionLabel={copy.edit}
      isEditing={props.isEditing}
      isDisabled={props.disabled || editableModels.length === 0}
      canSave={hasDraftChange}
      saveLabel={copy.save}
      cancelLabel={copy.cancel}
      onEdit={props.onEdit}
      onCancel={props.onCancel}
      onSave={async () => {
        const modelId = draftModelId || editableModels[0]?.id;
        if (!modelId) return;
        const thinkingOptions =
          draftEfforts.length > 0 ? { efforts: orderEfforts(draftEfforts) } : undefined;
        const ok = await props.onSave(modelId, thinkingOptions);
        if (ok) props.onCancel();
      }}
    >
      <Text type="body" color="secondary">
        {copy.thinkingOptionsHint}
      </Text>
      <Selector
        value={draftModelId}
        label={copy.thinkingOptionsModel}
        options={editableModels.map((model) => ({
          value: model.id,
          label: model.displayName?.trim() || model.id,
        }))}
        width="100%"
        onChange={(modelId) => {
          setDraftModelId(modelId);
          setDraftEfforts(declaredEfforts(editableModels.find((model) => model.id === modelId)));
        }}
      />
      <MultiSelector
        label={copy.thinkingOptionsEfforts}
        options={EFFORT_CHOICES}
        value={draftEfforts}
        onChange={setDraftEfforts}
        width="100%"
      />
    </SettingsExpandableRow>
  );
}
