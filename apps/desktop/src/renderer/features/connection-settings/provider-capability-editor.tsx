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

import { useId, type ReactNode } from 'react';
import { parseContextWindowInput } from './context-window-input.js';
import { DropdownMenu, DropdownMenuCheckboxItem, Field, FormLayout } from '@astryxdesign/core';
import {
  DECLARABLE_RELAY_THINKING_LEVELS,
  THINKING_LEVELS,
  type ModelOverride,
  type ThinkingLevel,
} from '@maka/core/model-thinking';
import { Selector, TextInput } from '@maka/ui';
import { getProviderSettingsCopy } from './settings-provider-copy.js';

export function CapabilityEditor(props: {
  children?: ReactNode;
  copy: ReturnType<typeof getProviderSettingsCopy>['detail'];
  modelId: string;
  isRelay: boolean;
  declared: ModelOverride | undefined;
  contextWindowInput: string;
  contextWindowInputInvalid: boolean;
  numericInputs?: Partial<Record<'inputLimit' | 'compactionThreshold' | 'maxOutputTokens', string>>;
  onNumericInput(field: 'inputLimit' | 'compactionThreshold' | 'maxOutputTokens', input: string): void;
  defaultContextWindow?: number;
  defaultInputLimit?: number;
  limitsConflict?: boolean;
  contextWindowError?: string;
  disabled: boolean;
  showsFastMode: boolean;
  defaultVision: boolean | undefined;
  onContextWindowInput(value: string): void;
  onChange(patch: Partial<ModelOverride>): void;
}) {
  const { copy, modelId, declared } = props;
  const thinkingId = useId();
  const visionValue =
    declared?.vision === true ? 'enabled' : declared?.vision === false ? 'disabled' : 'auto';
  const draftLevels = declared?.thinkingLevels ?? [];
  // The menu offers the five declarable levels PLUS anything the stored table
  // already claims — a level saved while it was still declarable (or
  // hand-written into the document) must stay visible and un-checkable, never
  // an invisible selection the trigger counts but the menu cannot show.
  const menuLevels: readonly ThinkingLevel[] = THINKING_LEVELS.filter(
    (level) =>
      (DECLARABLE_RELAY_THINKING_LEVELS as readonly ThinkingLevel[]).includes(level) ||
      draftLevels.includes(level),
  );
  return (
    <FormLayout direction="vertical" defaultOptionality="optional">
      {props.children}
      <TextInput
        size="sm"
        width="100%"
        label={copy.modelDisplayName}
        labelTooltip={copy.modelDisplayNameHelp}
        value={declared?.displayName ?? ''}
        hasClear
        isDisabled={props.disabled}
        onChange={(displayName) =>
          props.onChange({ displayName: displayName.trim() ? displayName : undefined })
        }
      />

      <Selector
        label={copy.visionInput}
        labelTooltip={copy.visionInputHelp}
        size="sm"
        width="100%"
        options={[
          { value: 'auto', label: copy.visionDefaultOption(props.defaultVision) },
          { value: 'enabled', label: copy.visionEnabledOption },
          { value: 'disabled', label: copy.visionDisabledOption },
        ]}
        value={visionValue}
        onChange={(value) =>
          props.onChange({ vision: value === 'auto' ? undefined : value === 'enabled' })
        }
        isDisabled={props.disabled}
      />

      <TextInput
        size="sm"
        width="100%"
        value={props.contextWindowInput}
        isDisabled={props.disabled}
        label={copy.contextWindow}
        labelTooltip={copy.contextWindowHelp}
        hasClear
        placeholder={props.defaultContextWindow === undefined ? '128000 / 128K / 1M' : String(props.defaultContextWindow)}
        onChange={props.onContextWindowInput}
        status={
          props.contextWindowInputInvalid
            ? { type: 'error', message: props.contextWindowError ?? copy.contextWindowInputInvalid }
            : undefined
        }
      />
      {(['inputLimit', 'compactionThreshold', 'maxOutputTokens'] as const).map((field) => {
        const input = props.numericInputs?.[field] ?? String(declared?.[field] ?? '');
        const invalid = input.trim() !== '' && parseContextWindowInput(input) === null;
        return (
          <TextInput
            size="sm"
            width="100%"
            key={field}
            label={copy[field]}
            labelTooltip={copy[`${field}Help`]}
            value={input}
            onChange={(value) => props.onNumericInput(field, value)}
            isDisabled={props.disabled}
            hasClear
            placeholder={field === 'inputLimit' && props.defaultInputLimit !== undefined ? String(props.defaultInputLimit) : field === 'maxOutputTokens' ? '8192 / 8K' : '128000 / 128K / 1M'}
            status={
              invalid ? { type: 'error', message: copy.contextWindowInputInvalid } : field === 'inputLimit' && props.limitsConflict ? { type: 'error', message: copy.modelLimitsConflict } : undefined
            }
          />
        );
      })}
      {/* Only relays accept a reasoning_effort declaration. */}
      {props.isRelay && (
        <Field
          label={copy.thinkingEffort}
          inputID={thinkingId}
          labelTooltip={copy.thinkingEffortHelp}
        >
          {/* DropdownMenu, not MultiSelector: levels have a canonical order
              (low → max) that must not shuffle — MultiSelector pins the
              selected-at-open options to the top with no opt-out, which
              misread as the declaration being order-sensitive. */}
          <DropdownMenu
            button={{
              variant: 'secondary',
              size: 'sm',
              label:
                draftLevels.length > 0
                  ? copy.thinkingSelectedCount(draftLevels.length)
                  : copy.thinkingUndeclared,
              id: thinkingId,
              'aria-label': copy.thinkingEffort,
              isDisabled: props.disabled,
            }}
            hasChevron
            menuWidth={224}
          >
            {menuLevels.map((level) => (
              <DropdownMenuCheckboxItem
                key={level}
                label={level}
                aria-label={`${modelId} ${level}`}
                value={draftLevels.includes(level)}
                onChange={(checked) => {
                  props.onChange({
                    thinkingLevels: checked
                      ? [...draftLevels, level]
                      : draftLevels.filter((existing) => existing !== level),
                  });
                }}
                isDisabled={props.disabled}
              />
            ))}
          </DropdownMenu>
        </Field>
      )}
      {props.showsFastMode && (
        <Selector
          label={copy.fastMode}
          labelTooltip={copy.fastModeHelp}
          size="sm"
          width="100%"
          options={[
            { value: 'auto', label: copy.fastAuto },
            { value: 'fast', label: copy.fastEnabled },
          ]}
          value={declared?.serviceTier ?? 'auto'}
          onChange={(value) =>
            props.onChange({ serviceTier: value === 'fast' ? 'fast' : undefined })
          }
          isDisabled={props.disabled}
        />
      )}
    </FormLayout>
  );
}
