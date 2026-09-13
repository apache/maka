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

/** Settings catalog adapter for the shared magnetic model picker. */

import { type ReactNode } from 'react';
import type { ProviderType } from '@maka/core/llm-connections';
import { type ModelMenuGroup, modelChoiceDescription, modelChoiceValue } from './chat-model-helpers.js';
import { ModelWheelPicker, type ModelWheelOption } from './model-wheel-picker.js';
import { useUiLocale } from './locale-context.js';

export interface ModelPickerProps {
  groups: readonly ModelMenuGroup[];
  value: string;
  onValueChange(value: string): void | Promise<void>;
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
  leadingOption?: { value: string; label: string; providerType?: ProviderType };
  triggerClassName?: string;
  ariaLabel: string;
}

export function ModelPicker(props: ModelPickerProps) {
  const locale = useUiLocale();
  const choices = props.groups.flatMap((group) => group.choices);
  const current = choices.find((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === props.value);
  const options: ModelWheelOption[] = props.groups.flatMap((group) => group.choices.map((choice) => ({
    value: modelChoiceValue(choice.connectionSlug, choice.model),
    label: choice.label,
    heading: group.heading,
    description: modelChoiceDescription(choice, locale),
  })));
  if (props.leadingOption) options.unshift(props.leadingOption);
  const label = options.find((option) => option.value === props.value)?.label ?? props.value;
  if (!options.some((option) => option.value === props.value)) {
    options.unshift({ value: props.value, label, disabled: true });
  }
  const provider = current?.providerType ?? (props.leadingOption?.value === props.value ? props.leadingOption.providerType : undefined);
  return <div className="maka-model-picker-root">
    <ModelWheelPicker options={options} value={props.value} label={label}
      ariaLabel={props.ariaLabel} size="md" disabled={props.disabled}
      triggerClassName={props.triggerClassName} onValueChange={props.onValueChange}
      icon={provider && props.renderProviderMark ? <span className="modelPickerProviderMark" data-provider={provider} aria-hidden="true">{props.renderProviderMark(provider)}</span> : undefined} />
  </div>;
}
