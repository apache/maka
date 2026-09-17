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
 * Chat model pickers, extracted from `components.tsx`.
 *
 * `ChatModelSwitcher` (in-session) and `NewChatModelPicker` (home / empty
 * state) are consumed only by the Composer and share the grouped model-choice
 * helpers, so they form a clean seam. `index.ts` does not re-export them (they
 * are internal to the `@maka/ui` Composer surface).
 *
 * Both are ghost-trigger Astryx Selectors — the same searchable single-select
 * list the settings pages use, so every model picker in the product shares one
 * interaction. The one exception is the collapsed WorkHub window, which keeps
 * the inline wheel (`presentation="wheel"`) it was built for.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Button as UiButton } from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { Selector } from '@astryxdesign/core/Selector';
import { ModelWheelPicker, type ModelWheelOption } from './model-wheel-picker.js';
import { ICON_SIZE, Check, Settings } from './icons.js';
import {
  type ChatModelChoice,
  exactModelChoiceValue,
  modelChoiceDescription,
  modelMenuGroups,
  type ModelMenuGroup,
} from './chat-model-helpers.js';
import {
  buildModelPickerOptions,
  renderModelPickerOption,
  renderModelPickerValue,
} from './model-picker-internals.js';
import { type ProviderType } from '@maka/core/llm-connections';
import { type SessionSummary } from '@maka/core/session';
import { type ThinkingLevel } from '@maka/core/model-thinking';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { usePendingSelection } from './use-pending-selection.js';
import type { ComposerModelSwitchAvailability } from './composer-helpers.js';

const DEFAULT_THINKING_LEVEL = '__default__';
/** Sentinel option value for the switch-warning row; disabled so it can never be picked. */
const SWITCH_WARNING_VALUE = '__maka_model_switch_warning__';

const exactChoiceValue = (choice: ChatModelChoice) =>
  exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model);

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

function wheelOptions(
  groups: readonly ModelMenuGroup[],
  locale: Parameters<typeof modelChoiceDescription>[1],
): ModelWheelOption[] {
  return groups.flatMap((group) =>
    group.choices.map((choice) => ({
      value: exactChoiceValue(choice),
      label: choice.label,
      heading: group.heading,
      description: modelChoiceDescription(choice, locale),
    })),
  );
}

const currentCheck = <Check size={ICON_SIZE.control} aria-hidden="true" />;

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
      className="maka-composer-quiet-menu maka-thinking-level-menu"
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
  /** 'popover' anchors to the trigger; 'bottom-sheet' stays inside compact windows; 'wheel' is the collapsed WorkHub's inline picker. */
  presentation?: 'popover' | 'bottom-sheet' | 'wheel';
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
  /**
   * Selector has no controlled open prop, so recovery bumps this instead: the
   * remount keyed on it opens the panel via `isDefaultOpen`, an entirely
   * documented surface. Session changes share the key so a switch always lands
   * closed.
   */
  openNonce?: number;
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
  const searchPlaceholder = getSharedUiCopy(locale).modelPicker.searchPlaceholder;
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
    : '';
  const availability = props.availability ?? { available: true, pending: false };
  const disabled =
    Boolean(props.disabledReason) ||
    !availability.available || !props.onChange || props.choices.length === 0;
  const grouped = modelMenuGroups(props.choices, locale);
  const currentKnownChoice = props.choices.some(
    (choice) => exactChoiceValue(choice) === currentValue,
  );
  const displayLabel = props.activeModelLabel ?? currentModel;
  const choiceByValue = useMemo(
    () => new Map(props.choices.map((choice) => [exactChoiceValue(choice), choice] as const)),
    [props.choices],
  );
  const options = useMemo(() => {
    const list = buildModelPickerOptions(
      grouped,
      !currentKnownChoice && currentValue && !props.hideUnavailableCurrentOption
        ? { value: currentValue, label: displayLabel, providerType: props.currentProviderType, disabled: true }
        : undefined,
      exactChoiceValue,
      { locale, renderProviderMark: props.renderProviderMark },
    );
    // Switching can abandon a provider prompt cache — a property of the pending
    // action, announced as a disabled first row whenever the panel opens.
    if (props.hasConversationHistory === true) {
      list.unshift({ value: SWITCH_WARNING_VALUE, label: copy.switchWarning, disabled: true });
    }
    return list;
  }, [grouped, currentKnownChoice, currentValue, props.hideUnavailableCurrentOption,
      props.hasConversationHistory, displayLabel, props.currentProviderType, copy.switchWarning,
      locale, props.renderProviderMark]);

  // Reflect the pick on the trigger immediately and hold it until the write
  // settles, then defer to the authoritative value. See usePendingSelection.
  const selection = usePendingSelection(currentValue, async (value) => {
    const choice = choiceByValue.get(value);
    if (!choice) return;
    try {
      await props.onChange?.({
        llmConnectionId: choice.connectionId,
        llmConnectionSlug: choice.connectionSlug,
        model: choice.model,
      });
    } catch { /* The action owner reports the failure. */ }
  });

  // The collapsed WorkHub window keeps the wheel it was built for. The nonce
  // edge opens it once, then the wheel owns its own open state.
  const [wheelOpen, setWheelOpen] = useState(false);
  useEffect(() => {
    if (props.openNonce) setWheelOpen(true);
  }, [props.openNonce]);
  if (props.presentation === 'wheel') {
    const wheelList = wheelOptions(grouped, locale);
    if (!currentKnownChoice && currentValue && !props.hideUnavailableCurrentOption) {
      wheelList.unshift({ value: currentValue, label: displayLabel, disabled: true });
    }
    return (
      <>
        <ModelWheelPicker
          options={wheelList}
          value={currentValue}
          label={displayLabel}
          ariaLabel={`${copy.switchAriaLabel}: ${displayLabel}`}
          icon={providerMarkIcon(props.currentProviderType, props.renderProviderMark)}
          tooltip={props.disabledReason ?? copy.switchAriaLabel}
          triggerClassName="maka-model-switcher-trigger"
          disabled={disabled}
          open={wheelOpen}
          onOpenChange={setWheelOpen}
          onValueChange={(value) => {
            if (value !== currentValue) selection.onChange(value);
          }}
        />
        <span
          className="maka-visually-hidden maka-model-switch-announcement"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {wheelOpen && props.hasConversationHistory === true ? copy.switchWarning : ''}
        </span>
      </>
    );
  }

  return (
    <Selector
      key={`${props.activeSession.id}:${props.openNonce ?? 0}`}
      label={`${copy.switchAriaLabel}: ${displayLabel}`}
      isLabelHidden
      options={options}
      value={selection.value}
      hasSearch
      searchPlaceholder={searchPlaceholder}
      variant="ghost"
      size="sm"
      placement="above"
      presentation={props.presentation}
      isDisabled={disabled}
      disabledMessage={props.disabledReason}
      isDefaultOpen={Boolean(props.openNonce)}
      placeholder={displayLabel}
      className="maka-model-switcher-trigger"
      onChange={selection.onChange}
      renderOption={renderModelPickerOption}
      renderValue={renderModelPickerValue}
    />
  );
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
  /** Same surfaces as ChatModelSwitcher; the collapsed WorkHub window passes 'wheel'. */
  presentation?: 'popover' | 'bottom-sheet' | 'wheel';
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
  const searchPlaceholder = getSharedUiCopy(locale).modelPicker.searchPlaceholder;
  const grouped = modelMenuGroups(props.choices, locale);
  const currentValue = props.currentValue ?? '';
  const currentKnownChoice = props.choices.some(
    (choice) => exactChoiceValue(choice) === currentValue,
  );
  const choiceByValue = useMemo(
    () => new Map(props.choices.map((choice) => [exactChoiceValue(choice), choice] as const)),
    [props.choices],
  );
  const options = useMemo(
    () => buildModelPickerOptions(
      grouped,
      !currentKnownChoice && currentValue
        ? { label: props.label, value: currentValue, providerType: props.currentProviderType }
        : undefined,
      exactChoiceValue,
      { locale, renderProviderMark: props.renderProviderMark },
    ),
    [grouped, currentKnownChoice, currentValue, props.label, props.currentProviderType,
      locale, props.renderProviderMark],
  );
  const selection = usePendingSelection(currentValue, async (value) => {
    const choice = choiceByValue.get(value);
    if (!choice) return;
    await props.onPick({
      llmConnectionId: choice.connectionId,
      llmConnectionSlug: choice.connectionSlug,
      model: choice.model,
    });
  });
  if (props.presentation === 'wheel') {
    const wheelList = wheelOptions(grouped, locale);
    if (!currentKnownChoice && currentValue) {
      wheelList.unshift({ value: currentValue, label: props.label, disabled: true });
    }
    return (
      <ModelWheelPicker
        options={wheelList}
        value={selection.value}
        label={props.label}
        ariaLabel={copy.newChatAriaLabel(props.label)}
        icon={providerMarkIcon(props.currentProviderType, props.renderProviderMark)}
        tooltip={copy.newChatTitle(props.label)}
        triggerClassName="maka-new-chat-model-selector"
        onValueChange={(value) => {
          if (value !== currentValue) selection.onChange(value);
        }}
      />
    );
  }
  return (
    <Selector
      label={copy.newChatAriaLabel(props.label)}
      isLabelHidden
      options={options}
      value={selection.value}
      hasSearch
      searchPlaceholder={searchPlaceholder}
      variant="ghost"
      size="sm"
      placement="above"
      placeholder={props.label}
      className="maka-new-chat-model-selector"
      onChange={selection.onChange}
      renderOption={renderModelPickerOption}
      renderValue={renderModelPickerValue}
    />
  );
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
