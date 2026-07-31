/**
 * Product-specific model catalog composition over Astryx Selector.
 *
 * Maka owns provider/model shaping, provider marks, unknown-current display,
 * and the selection action. Astryx exclusively owns search, empty results,
 * option semantics, keyboard navigation, focus, scrolling, and popup behavior.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import type { ProviderType } from '@maka/core';
import type { ModelMenuGroup } from './chat-model-helpers.js';
import {
  buildModelPickerOptions,
  createModelSelectionGuard,
  type ModelPickerLeadingOption,
  type ModelPickerOption,
} from './model-picker-internals.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useMountedRef } from './use-mounted-ref.js';

export interface ModelPickerProps {
  groups: readonly ModelMenuGroup[];
  value: string;
  onValueChange(value: string): void | Promise<void>;
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
  loading?: boolean;
  /**
   * An ordinary option placed before the catalog for product values such as
   * “not set” or a current model that is no longer listed. Astryx search treats
   * it exactly like every other option.
   */
  leadingOption?: ModelPickerLeadingOption;
  searchPlaceholder?: string;
  triggerClassName?: string;
  ariaLabel: string;
}

function selectableOptions(options: ReturnType<typeof buildModelPickerOptions>): ModelPickerOption[] {
  return options.flatMap((option) =>
    'type' in option && option.type === 'section' ? option.options : 'type' in option ? [] : [option],
  );
}

export function ModelPicker(props: ModelPickerProps) {
  const copy = getSharedUiCopy(useUiLocale()).modelPicker;
  const mountedRef = useMountedRef();
  const [selectionGuard] = useState(createModelSelectionGuard);
  const [selectionPending, setSelectionPending] = useState(false);
  const options = useMemo(
    () => buildModelPickerOptions(props.groups, props.leadingOption),
    [props.groups, props.leadingOption],
  );
  const selectedProviderType = useMemo(
    () => selectableOptions(options).find((option) => option.value === props.value)?.providerType,
    [options, props.value],
  );
  const selectedProviderMark =
    selectedProviderType && props.renderProviderMark ? (
      <span
        className="modelPickerProviderMark"
        data-provider={selectedProviderType}
        aria-hidden="true"
      >
        {props.renderProviderMark(selectedProviderType)}
      </span>
    ) : undefined;

  return (
    <Selector
      label={props.ariaLabel}
      isLabelHidden
      options={options}
      value={props.value}
      hasSearch
      searchPlaceholder={props.searchPlaceholder ?? copy.searchPlaceholder}
      size="sm"
      placement="above"
      startIcon={selectedProviderMark}
      isDisabled={props.disabled || selectionPending}
      isLoading={props.loading || selectionPending}
      className={props.triggerClassName}
      changeAction={async (value) => {
        await selectionGuard.run(value, async (acceptedValue) => {
          setSelectionPending(true);
          try {
            await props.onValueChange(acceptedValue);
          } finally {
            if (mountedRef.current) setSelectionPending(false);
          }
        });
      }}
      renderOption={(option: SelectorOptionData) => {
        const modelOption = option as ModelPickerOption;
        const providerMark =
          modelOption.providerType && props.renderProviderMark ? (
            <span
              className="modelPickerProviderMark"
              data-provider={modelOption.providerType}
              aria-hidden="true"
            >
              {props.renderProviderMark(modelOption.providerType)}
            </span>
          ) : undefined;
        return (
          <SelectorOption
            className="modelPickerOption"
            icon={providerMark}
            label={<span className="modelPickerOptionLabel">{option.label ?? option.value}</span>}
          />
        );
      }}
    />
  );
}
