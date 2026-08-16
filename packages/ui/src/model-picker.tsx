/**
 * Product-specific model catalog composition over Astryx Selector.
 *
 * Maka owns provider/model shaping, provider marks, unknown-current display,
 * and the selection action. Astryx owns search, empty results, option
 * semantics, keyboard navigation, focus, scrolling, and popup behavior.
 */

import {
  useMemo,
  type ReactNode,
} from 'react';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import type { ProviderType } from '@maka/core/llm-connections';
import type { ModelMenuGroup } from './chat-model-helpers.js';
import {
  buildModelPickerOptions,
  buildModelPickerDescriptions,
  buildModelPickerProviderTypes,
  type ModelPickerLeadingOption,
} from './model-picker-internals.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

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

export function ModelPicker(props: ModelPickerProps) {
  const locale = useUiLocale();
  const copy = getSharedUiCopy(locale).modelPicker;

  const options = useMemo(
    () => buildModelPickerOptions(props.groups, props.leadingOption),
    [props.groups, props.leadingOption],
  );
  const providerTypes = useMemo(
    () => buildModelPickerProviderTypes(props.groups, props.leadingOption),
    [props.groups, props.leadingOption],
  );
  const descriptions = useMemo(
    () => buildModelPickerDescriptions(props.groups, locale),
    [locale, props.groups],
  );

  // size=md matches the other settings-row selectors. Settings is the only
  // production host since the composer footer moved to ghost DropdownMenus,
  // so the size is a fact of the component, not a prop.
  return (
    <div className="maka-model-picker-root">
      <Selector
        label={props.ariaLabel}
        isLabelHidden
        options={options}
        value={props.value}
        hasSearch
        searchPlaceholder={props.searchPlaceholder ?? copy.searchPlaceholder}
        size="md"
        placement="above"
        isDisabled={props.disabled}
        isLoading={props.loading}
        className={props.triggerClassName}
        changeAction={props.onValueChange}
        renderOption={(option: SelectorOptionData) => {
          const providerType = providerTypes.get(option.value);
          const providerMark =
            providerType && props.renderProviderMark ? (
              <span
                className="modelPickerProviderMark"
                data-provider={providerType}
                aria-hidden="true"
              >
                {props.renderProviderMark(providerType)}
              </span>
            ) : undefined;
          return (
            <SelectorOption
              className="modelPickerOption"
              icon={providerMark}
              label={<span className="modelPickerOptionLabel">{option.label ?? option.value}</span>}
              description={descriptions.get(option.value)}
            />
          );
        }}
      />
    </div>
  );
}
