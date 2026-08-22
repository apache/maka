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

import type { SelectorDivider, SelectorOptionData } from '@astryxdesign/core/Selector';
import type { ProviderType } from '@maka/core/llm-connections';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  type ModelMenuGroup,
  modelChoiceDescription,
  modelChoiceValue,
} from './chat-model-helpers.js';

export type ModelPickerOption = SelectorOptionData;

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
 * entirely inside Selector. Provider marks use the separate public-value map
 * below rather than relying on Selector to preserve product-only fields.
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
    })),
  }));

  if (!leadingOption) return sections;

  const option: ModelPickerOption = {
    value: leadingOption.value,
    label: leadingOption.label,
  };
  return sections.length > 0 ? [option, { type: 'divider' }, ...sections] : [option];
}

export function buildModelPickerProviderTypes(
  groups: readonly ModelMenuGroup[],
  leadingOption?: ModelPickerLeadingOption,
): ReadonlyMap<string, ProviderType> {
  const entries: [string, ProviderType][] = groups.flatMap((group) =>
    group.choices.map((choice) => [
      modelChoiceValue(choice.connectionSlug, choice.model),
      group.providerType,
    ]),
  );
  if (leadingOption?.providerType) {
    entries.unshift([leadingOption.value, leadingOption.providerType]);
  }
  return new Map(entries);
}

export function buildModelPickerDescriptions(
  groups: readonly ModelMenuGroup[],
  locale: UiLocale,
): ReadonlyMap<string, string | undefined> {
  return new Map(
    groups.flatMap((group) =>
      group.choices.map((choice) => [
        modelChoiceValue(choice.connectionSlug, choice.model),
        modelChoiceDescription(choice, locale),
      ] as const),
    ),
  );
}
