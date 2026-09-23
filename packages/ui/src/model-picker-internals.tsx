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

import type { ReactNode } from 'react';
import {
  SelectorOption,
  type SelectorOptionData,
  type SelectorOptionType,
  type SelectorSection,
} from '@astryxdesign/core/Selector';
import type { ProviderType } from '@maka/core/llm-connections';
import {
  type ModelMenuGroup,
} from './chat-model-helpers.js';

export interface ModelPickerLeadingOption {
  value: string;
  label: string;
  providerType?: ProviderType;
  disabled?: boolean;
}

type ModelChoiceValueFn = (choice: ModelMenuGroup['choices'][number]) => string;

export function providerMarkIcon(
  providerType: ProviderType | undefined,
  renderProviderMark: ((type: ProviderType) => ReactNode) | undefined,
): ReactNode {
  if (!providerType || !renderProviderMark) return undefined;
  return (
    <span className="modelPickerProviderMark" data-provider={providerType} aria-hidden="true">
      {renderProviderMark(providerType)}
    </span>
  );
}

/**
 * Shapes Maka's provider catalog into Astryx Selector's public option model:
 * each option carries its provider mark as `icon`, so Selector's default row
 * and trigger rendering need no product markup. Search, flattening, keyboard
 * navigation, selection, and empty results remain entirely inside Selector.
 *
 * `toValue` is `modelChoiceValue` for the settings catalog (slug-scoped) and
 * `exactModelChoiceValue` for the session switcher (connection-id-scoped).
 */
export function buildModelPickerOptions(
  groups: readonly ModelMenuGroup[],
  leadingOption: ModelPickerLeadingOption | undefined,
  toValue: ModelChoiceValueFn,
  renderProviderMark?: (type: ProviderType) => ReactNode,
): SelectorOptionType[] {
  const sections: SelectorSection[] = groups.map((group) => ({
    type: 'section',
    title: group.heading,
    options: group.choices.map((choice) => ({
      value: toValue(choice),
      label: choice.label,
      icon: providerMarkIcon(group.providerType, renderProviderMark),
    })),
  }));

  if (!leadingOption) return sections;

  const option: SelectorOptionData = {
    value: leadingOption.value,
    label: leadingOption.label,
    icon: providerMarkIcon(leadingOption.providerType, renderProviderMark),
    disabled: leadingOption.disabled,
  };
  return sections.length > 0 ? [option, { type: 'divider' }, ...sections] : [option];
}

/**
 * Ellipsizes at the START of the label: the ids long enough to truncate are
 * mostly path-style ids (`accounts/<provider>/models/<model>`), whose tail is
 * the actual model name. The `<bdi>` keeps weak-directional characters at the
 * string edges from jumping sides under `direction: rtl`.
 */
function TailVisibleLabel({ text }: { text: string }) {
  return (
    <span className="modelPickerOptionLabel">
      <bdi>{text}</bdi>
    </span>
  );
}

/**
 * Selector's default row is already this layout; the product additions are the
 * `modelPickerOption` hook that scopes the popup's width cap in
 * model-switcher.css, and the start-ellipsizing label above.
 */
export function renderModelPickerOption(option: SelectorOptionData): ReactNode {
  return (
    <SelectorOption
      className="modelPickerOption"
      icon={option.icon}
      label={<TailVisibleLabel text={option.label ?? option.value} />}
      description={option.description}
    />
  );
}

/** Same icon + start-ellipsized label inside the closed trigger. */
export function renderModelPickerValue(option: SelectorOptionData): ReactNode {
  return (
    <SelectorOption icon={option.icon} label={<TailVisibleLabel text={option.label ?? option.value} />} />
  );
}
