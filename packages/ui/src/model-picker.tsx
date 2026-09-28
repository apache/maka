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

/**
 * Product-specific model catalog composition over Astryx Selector.
 *
 * Maka owns provider/model shaping, provider marks, unknown-current display,
 * and the selection action. Astryx owns search, empty results, option
 * semantics, keyboard navigation, focus, scrolling, and popup behavior.
 */

import { useMemo, type ReactNode } from 'react';
import { Selector } from '@astryxdesign/core/Selector';
import type { ProviderType } from '@maka/core/llm-connections';
import type { ModelMenuGroup } from './chat-model-helpers.js';
import {
  buildModelPickerOptions,
  renderModelPickerOption,
  renderModelPickerValue,
  type ModelPickerLeadingOption,
} from './model-picker-internals.js';
import { modelChoiceValue } from './chat-model-helpers.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { usePendingSelection } from './use-pending-selection.js';

export interface ModelPickerProps {
  groups: readonly ModelMenuGroup[];
  value: string;
  onValueChange(value: string): void | Promise<void>;
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
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

const slugScopedValue = (choice: ModelMenuGroup['choices'][number]) =>
  modelChoiceValue(choice.connectionSlug, choice.model);

export function ModelPicker(props: ModelPickerProps) {
  const locale = useUiLocale();
  const copy = getSharedUiCopy(locale).modelPicker;

  const options = useMemo(
    () =>
      buildModelPickerOptions(props.groups, props.leadingOption, slugScopedValue, props.renderProviderMark),
    [props.groups, props.leadingOption, props.renderProviderMark],
  );

  // Reflect the pick immediately and hold it until the caller's write settles,
  // then defer to the authoritative `value`. See usePendingSelection.
  const selection = usePendingSelection(props.value, props.onValueChange);

  // size=md matches the other settings-row selectors, so the size is a fact
  // of the component, not a prop.
  return (
    <div className="maka-model-picker-root">
      <Selector
        label={props.ariaLabel}
        isLabelHidden
        options={options}
        value={selection.value}
        hasSearch
        searchPlaceholder={props.searchPlaceholder ?? copy.searchPlaceholder}
        size="md"
        placement="above"
        isDisabled={props.disabled}
        className={props.triggerClassName}
        // `onChange`, not `changeAction`: the async `changeAction` path wraps
        // the caller's save in a transition and spins the trigger (Astryx's
        // built-in optimistic `isBusy`) for the whole round-trip. On the
        // fire-and-forget `onChange` path the trigger never enters that busy
        // state; usePendingSelection shows the pick at once and settles it when
        // the write finishes.
        onChange={selection.onChange}
        renderOption={renderModelPickerOption}
        renderValue={renderModelPickerValue}
      />
    </div>
  );
}
