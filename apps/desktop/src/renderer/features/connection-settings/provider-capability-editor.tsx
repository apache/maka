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
import { parseContextWindowInput } from './context-window-input.js';
import { DropdownMenu, DropdownMenuCheckboxItem, HStack, Text, VStack } from '@astryxdesign/core';
import { DECLARABLE_RELAY_THINKING_LEVELS, THINKING_LEVELS, type ModelOverride, type ThinkingLevel } from '@maka/core/model-thinking';
import { Button, Selector, TextInput } from '@maka/ui';
import { getProviderSettingsCopy } from './settings-provider-copy.js';

export function CapabilityEditor(props: {
  copy: ReturnType<typeof getProviderSettingsCopy>['detail'];
  modelId: string;
  isRelay: boolean;
  declared: ModelOverride | undefined;
  contextWindowInput: string;
  contextWindowInputInvalid: boolean;
  numericInputs?: Partial<Record<'compactionThreshold' | 'maxOutputTokens', string>>;
  onNumericInput(field: 'compactionThreshold' | 'maxOutputTokens', input: string): void;
  contextWindowError?: string;
  disabled: boolean;
  showsFastMode: boolean;
  /** The window the provider's model list reports, offered as a one-click fill while nothing is declared. */
  reportedContextWindow: number | undefined;
  defaultVision: boolean | undefined;
  onContextWindowInput(value: string): void;
  onChange(patch: Partial<ModelOverride>): void;
}) {
  const { copy, modelId, declared } = props;
  const fieldLabel = (name: string) => modelId ? `${name} — ${modelId}` : name;
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
    <div className="providerCapabilityFields">
      <CapabilityField label={copy.modelDisplayName} description={copy.modelDisplayNameHelp}>
        <TextInput
          size="sm" width="100%" label={fieldLabel(copy.modelDisplayName)} isLabelHidden
          value={declared?.displayName ?? ''} hasClear isDisabled={props.disabled}
          onChange={(displayName) => props.onChange({ displayName: displayName.trim() ? displayName : undefined })}
        />
      </CapabilityField>
      <CapabilityField label={copy.visionInput} description={copy.visionInputHelp}>
          <Selector
            label={fieldLabel(copy.visionInput)}
            isLabelHidden
            size="sm"
            width="100%"
            options={[
              { value: 'auto', label: copy.visionDefaultOption(props.defaultVision) },
              { value: 'enabled', label: copy.visionEnabledOption },
              { value: 'disabled', label: copy.visionDisabledOption },
            ]}
            value={visionValue}
            onChange={(value) => props.onChange({ vision: value === 'auto' ? undefined : value === 'enabled' })}
            isDisabled={props.disabled}
          />
      </CapabilityField>
      <CapabilityField label={copy.contextWindow} description={copy.contextWindowHelp}>
        <VStack gap={1}>
          <TextInput
            size="sm"
            width="100%"
            value={props.contextWindowInput}
            isDisabled={props.disabled}
            /* Named per model, like the controls around it: the visible label
               is the field's, but the control's own name is all a screen reader
               gets, and every open row carries the same one. */
            label={fieldLabel(copy.contextWindow)}
            isLabelHidden
            hasClear
            placeholder="128000 / 128K / 1M"
            onChange={props.onContextWindowInput}
            status={props.contextWindowInputInvalid
              ? { type: 'error', message: props.contextWindowError ?? copy.contextWindowInputInvalid }
              : undefined}
          />
          {declared?.contextWindow === undefined && props.reportedContextWindow !== undefined && (
            <HStack gap={1} vAlign="center">
              <Text size="sm" type="supporting" color="secondary">
                {copy.contextWindowHint(props.reportedContextWindow)}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                label={copy.contextWindowApplyHint}
                isDisabled={props.disabled}
                onClick={() => props.onContextWindowInput(String(props.reportedContextWindow ?? ''))}
              />
            </HStack>
          )}
        </VStack>
      </CapabilityField>
      {(['compactionThreshold', 'maxOutputTokens'] as const).map((field) => {
        const input = props.numericInputs?.[field] ?? String(declared?.[field] ?? '');
        const invalid = input.trim() !== '' && parseContextWindowInput(input) === null;
        return (
          <CapabilityField key={field} label={copy[field]} description={copy[`${field}Help`]}>
            <TextInput
              size="sm"
              width="100%"
              label={fieldLabel(copy[field])}
              isLabelHidden
              value={input}
              onChange={(value) => props.onNumericInput(field, value)}
              isDisabled={props.disabled}
              hasClear
              placeholder={field === 'maxOutputTokens' ? '8192 / 8K' : '128000 / 128K / 1M'}
              status={invalid ? { type: 'error', message: copy.contextWindowInputInvalid } : undefined}
            />
          </CapabilityField>
        );
      })}
      {/* Only relays accept a reasoning_effort declaration. */}
      {props.isRelay && (
        <CapabilityField label={copy.thinkingEffort} description={copy.thinkingEffortHelp}>
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
              'aria-label': fieldLabel(copy.thinkingEffort),
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
                  props.onChange({ thinkingLevels:
                    checked
                      ? [...draftLevels, level]
                      : draftLevels.filter((existing) => existing !== level),
                  });
                }}
                isDisabled={props.disabled}
              />
            ))}
          </DropdownMenu>
        </CapabilityField>
      )}
      {props.showsFastMode && (
        <CapabilityField label={copy.fastMode} description={copy.fastModeHelp}>
          <Selector
            label={fieldLabel(copy.fastMode)}
            isLabelHidden
            size="sm"
            width="100%"
            options={[
              { value: 'auto', label: copy.fastAuto },
              { value: 'fast', label: copy.fastEnabled },
            ]}
            value={declared?.serviceTier ?? 'auto'}
            onChange={(value) => props.onChange({ serviceTier: value === 'fast' ? 'fast' : undefined })}
            isDisabled={props.disabled}
          />
        </CapabilityField>
      )}
    </div>
  );
}

function CapabilityField(props: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="providerCapabilityField">
      <Text>{props.label}</Text>
      {props.children}
      <Text type="supporting" color="secondary">{props.description}</Text>
    </div>
  );
}

// The OAuth notice for a re-loginable connection. The 重新登录 button drives
// the SAME shared browser-assisted OAuth flow the catalog cards use, so an
// expired connection can be re-authorized right where the problem surfaces.
// The button shows in every credential state except 'loading' — an EXPIRED
// token still reads hasSecret===true, so it must not hide behind
// hasSecret===false.
