import type { SelectorDivider, SelectorOptionData } from '@astryxdesign/core/Selector';
import type { ProviderType } from '@maka/core';
import { type ModelMenuGroup, modelChoiceValue } from './chat-model-helpers.js';

export interface ModelPickerOption extends SelectorOptionData {
  providerType?: ProviderType;
}

export interface ModelPickerSection {
  type: 'section';
  title: string;
  options: ModelPickerOption[];
}

export type ModelPickerSelectorOption = ModelPickerOption | SelectorDivider | ModelPickerSection;

export interface ModelPickerLeadingOption {
  value: string;
  label: string;
  providerType?: ProviderType;
}

/**
 * Shapes Maka's provider catalog into Astryx Selector's public option model.
 * Search, flattening, keyboard navigation, selection, and empty results remain
 * entirely inside Selector; provider identity only survives here so the
 * product can render the corresponding brand mark.
 */
export function buildModelPickerOptions(
  groups: readonly ModelMenuGroup[],
  leadingOption?: ModelPickerLeadingOption,
): ModelPickerSelectorOption[] {
  const sections: ModelPickerSection[] = groups.map((group) => ({
    type: 'section',
    title: group.heading,
    options: group.choices.map((choice) => ({
      value: modelChoiceValue(choice.connectionSlug, choice.model),
      label: choice.label,
      providerType: group.providerType,
    })),
  }));

  if (!leadingOption) return sections;

  const option: ModelPickerOption = {
    value: leadingOption.value,
    label: leadingOption.label,
    ...(leadingOption.providerType ? { providerType: leadingOption.providerType } : {}),
  };
  return sections.length > 0 ? [option, { type: 'divider' }, ...sections] : [option];
}

/** Product action guard; it owns no Selector interaction or collection state. */
export function createModelSelectionGuard() {
  let pending = false;
  return {
    async run<Value>(
      value: Value,
      action: (value: Value) => void | Promise<void>,
    ): Promise<boolean> {
      if (pending) return false;
      pending = true;
      try {
        await action(value);
        return true;
      } finally {
        pending = false;
      }
    },
  };
}
