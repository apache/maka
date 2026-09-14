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

/** Session and new-chat adapters for the shared magnetic model picker. */

import { type ReactNode, useMemo, useState } from 'react';
import { Button as UiButton } from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { ICON_SIZE, Check, Settings } from './icons.js';
import {
  type ChatModelChoice,
  type ModelMenuGroup,
  exactModelChoiceValue,
  modelChoiceDescription,
  modelMenuGroups,
} from './chat-model-helpers.js';
import { type ProviderType } from '@maka/core/llm-connections';
import { type SessionSummary } from '@maka/core/session';
import { type ThinkingLevel } from '@maka/core/model-thinking';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { ModelWheelPicker, type ModelWheelOption } from './model-wheel-picker.js';
import type { ComposerModelSwitchAvailability } from './composer-helpers.js';

const DEFAULT_THINKING_LEVEL = '__default__';

function providerMarkIcon(
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

const currentCheck = <Check size={ICON_SIZE.control} aria-hidden="true" />;

function wheelOptions(groups: readonly ModelMenuGroup[], locale: Parameters<typeof modelChoiceDescription>[1]): ModelWheelOption[] {
  return groups.flatMap((group) => group.choices.map((choice) => ({
    value: exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model),
    label: choice.label,
    heading: group.heading,
    description: modelChoiceDescription(choice, locale),
  })));
}

/**
 * Standalone thinking-level picker. Hidden when the active model has no
 * variants — the control does not appear as a disabled husk or change the
 * model menu's shape.
 */
export function ThinkingLevelSelector(props: {
  levels: readonly ThinkingLevel[];
  current?: ThinkingLevel;
  onChange?(level: ThinkingLevel | undefined): void | Promise<void>;
  disabled?: boolean;
  /** Why the control is locked (mid-turn etc.); replaces the action tooltip so the reason is discoverable, matching the model switcher beside it. */
  disabledReason?: string;
}) {
  const copy = getConversationCopy(useUiLocale()).model;
  const hasVariants = props.levels.length > 0 && Boolean(props.onChange);
  const options = useMemo(
    () => [
      { value: DEFAULT_THINKING_LEVEL, label: copy.defaultLevel },
      ...props.levels.map((level) => ({ value: level, label: copy.level[level] })),
    ],
    [copy.defaultLevel, copy.level, props.levels],
  );

  if (!hasVariants) return null;

  const currentValue = props.current ?? DEFAULT_THINKING_LEVEL;
  const currentLabel = options.find((option) => option.value === currentValue)?.label ?? copy.defaultLevel;

  return (
    <DropdownMenu
      placement="above"
      hasChevron={false}
      className="maka-composer-quiet-menu"
      button={{
        label: currentLabel,
        variant: 'ghost',
        size: 'sm',
        isDisabled: props.disabled,
        tooltip: props.disabledReason ?? copy.changeThinkingLevel,
        className: 'maka-thinking-level-selector',
        'aria-label': `${copy.thinkingLevel}: ${currentLabel}`,
      }}
    >
      <DropdownMenuRadioGroup
        value={currentValue}
        label={`${copy.thinkingLevel}: ${currentLabel}`}
        onChange={(value) => {
          void props.onChange?.(
            value === DEFAULT_THINKING_LEVEL ? undefined : (value as ThinkingLevel),
          );
        }}
      >
        {options.map((option) => (
          <DropdownMenuRadioItem
            key={option.value}
            value={option.value}
            label={option.label}
            endContent={option.value === currentValue ? currentCheck : undefined}
            isDisabled={props.disabled}
          />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}

export function ChatModelSwitcher(props: {
  activeSession: SessionSummary;
  activeModelConnectionId?: string;
  activeModelConnectionSlug?: string;
  activeModel?: string;
  activeModelLabel?: string;
  currentProviderType?: ProviderType;
  choices: ChatModelChoice[];
  hasConversationHistory?: boolean;
  availability?: ComposerModelSwitchAvailability;
  disabledReason?: string;
  /** Optional controlled open state used by an external recovery action. */
  isMenuOpen?: boolean;
  onMenuOpenChange?(open: boolean): void;
  /** Hide a stale display-only row while the Session requires identity recovery. */
  hideUnavailableCurrentOption?: boolean;
  renderProviderMark?(type: ProviderType): ReactNode;
  onChange?(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).model;
  const currentConnectionId =
    props.activeModelConnectionId ?? props.activeSession.llmConnectionId;
  const currentConnectionSlug =
    props.activeModelConnectionSlug ?? props.activeSession.llmConnectionSlug;
  const currentModel = props.activeModel ?? props.activeSession.model;
  const currentValue = currentConnectionId
    ? exactModelChoiceValue(
        currentConnectionId,
        currentConnectionSlug,
        currentModel,
      )
    : undefined;
  const availability = props.availability ?? { available: true, pending: false };
  const [internalMenuOpen, setInternalMenuOpen] = useState(false);
  const menuOpen = props.isMenuOpen ?? internalMenuOpen;
  const setMenuOpen = (open: boolean) => {
    if (props.isMenuOpen === undefined) setInternalMenuOpen(open);
    props.onMenuOpenChange?.(open);
  };
  const disabled =
    Boolean(props.disabledReason) ||
    !availability.available || !props.onChange || props.choices.length === 0;
  const grouped = modelMenuGroups(props.choices, locale);
  const currentKnownChoice = props.choices.some(
    (choice) =>
      exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model) ===
      currentValue,
  );
  const displayLabel = props.activeModelLabel ?? currentModel;
  const title = props.disabledReason ?? copy.switchAriaLabel;
  const announceWarning = menuOpen && props.hasConversationHistory === true;
  const pick = async (next: { llmConnectionSlug: string; llmConnectionId: string; model: string }) => {
    if (next.llmConnectionSlug === currentConnectionSlug && next.llmConnectionId === currentConnectionId && next.model === currentModel) return;
    try { await props.onChange?.(next); } catch { /* The action owner reports the failure. */ }
  };

  const options = wheelOptions(grouped, locale);
  if (!currentKnownChoice && currentValue && !props.hideUnavailableCurrentOption) {
    options.unshift({ value: currentValue, label: displayLabel, disabled: true });
  }
  return <>
    <ModelWheelPicker options={options} value={currentValue} label={displayLabel}
      ariaLabel={`${copy.switchAriaLabel}: ${displayLabel}`}
      icon={providerMarkIcon(props.currentProviderType, props.renderProviderMark)}
      tooltip={title} triggerClassName="maka-model-switcher-trigger"
      disabled={disabled} open={menuOpen} onOpenChange={setMenuOpen}
      onValueChange={(value) => {
        const choice = props.choices.find((entry) => exactModelChoiceValue(entry.connectionId, entry.connectionSlug, entry.model) === value);
        if (choice) return pick({ llmConnectionId: choice.connectionId, llmConnectionSlug: choice.connectionSlug, model: choice.model });
      }} />
    <span className="maka-visually-hidden maka-model-switch-announcement" role="status" aria-live="polite" aria-atomic="true">
      {announceWarning ? copy.switchWarning : ''}
    </span>
  </>;
}

/**
 * Home / empty-state model picker (no active session yet). Unlike
 * `ChatModelSwitcher` — which is bound to a live session and switches THAT
 * session's model — this one just records which model the next new chat should
 * start with. Reuses the model chip's look: a chevronless ghost button like
 * the ＋ and permission controls beside it — the hover wash and tooltip are
 * the menu affordance. The thinking level for new chats is a separate
 * right-footer control owned by the Composer.
 */
export function NewChatModelPicker(props: {
  label: string;
  choices: ChatModelChoice[];
  currentValue?: string;
  currentProviderType?: ProviderType;
  renderProviderMark?(type: ProviderType): ReactNode;
  onPick(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).model;
  const grouped = modelMenuGroups(props.choices, locale);
  const currentValue = props.currentValue ?? '';
  const currentKnownChoice = props.choices.some(
    (choice) =>
      exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model) ===
      currentValue,
  );
  const options = wheelOptions(grouped, locale);
  if (!currentKnownChoice && currentValue) {
    options.unshift({ value: currentValue, label: props.label, disabled: true });
  }
  return <ModelWheelPicker options={options} value={currentValue} label={props.label}
    ariaLabel={copy.newChatAriaLabel(props.label)}
    icon={providerMarkIcon(props.currentProviderType, props.renderProviderMark)}
    tooltip={copy.newChatTitle(props.label)} triggerClassName="maka-new-chat-model-selector"
    onValueChange={(value) => {
      const choice = props.choices.find((entry) => exactModelChoiceValue(entry.connectionId, entry.connectionSlug, entry.model) === value);
      if (choice) return props.onPick({ llmConnectionId: choice.connectionId, llmConnectionSlug: choice.connectionSlug, model: choice.model });
    }} />;
}

/**
 * Non-interactive model chip for the composer's empty state: no active
 * session and no models to pick from yet. Replaces a former inline `<span>`
 * that wore a dropdown chevron it could not honor. When `onOpenSettings` is
 * given it becomes an honest button into Settings · 模型 (with a gear, no fake
 * chevron); otherwise it is plain inert text. Shares the `.maka-composer-model-chip`
 * look with `NewChatModelPicker` so the chip reads identically across states.
 */
export function ModelChipStatic(props: {
  label: string;
  onOpenSettings?: () => void;
  showUnavailableStatus?: boolean;
}) {
  const copy = getConversationCopy(useUiLocale()).model;
  if (props.onOpenSettings) {
    return (
      <UiButton
        variant="ghost"
        size="sm"
        onClick={props.onOpenSettings}
        aria-label={copy.configureAriaLabel(props.label)}
        tooltip={copy.configureTitle}
        icon={<Settings size={ICON_SIZE.meta} aria-hidden="true" />}
        label={props.label}
      />
    );
  }
  return (
    <span className="maka-composer-model-chip" title={props.label}>
      <span className="maka-composer-model-chip-text">{props.label}</span>
      {props.showUnavailableStatus !== false ? (
        <span className="maka-composer-model-status" aria-hidden="true" />
      ) : null}
    </span>
  );
}
