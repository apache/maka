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
import { Selector } from '@astryxdesign/core/Selector';
import { ModelWheelPicker, type ModelWheelOption } from './model-wheel-picker.js';
import { ICON_SIZE, Settings } from './icons.js';
import {
  type ChatModelChoice,
  exactModelChoiceValue,
  modelChoiceDescription,
  modelMenuGroups,
  type ModelMenuGroup,
} from './chat-model-helpers.js';
import {
  buildModelPickerOptions,
  providerMarkIcon,
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

/**
 * Standalone thinking-level picker — the same ghost Selector as the model
 * switcher beside it, minus the search (a handful of levels never needs it).
 * Hidden when the active model has no variants — the control does not appear
 * as a disabled husk or change the model picker's shape.
 */
export function ThinkingLevelSelector(props: {
  levels: readonly ThinkingLevel[];
  current?: ThinkingLevel;
  /** Same surface as the model picker; compact windows that cannot fit an anchored popup use 'bottom-sheet'. */
  presentation?: 'popover' | 'bottom-sheet';
  /** Force any open surface closed while an interaction prompt occludes the composer. */
  isReadOnly?: boolean;
  onChange?(level: ThinkingLevel | undefined): void | Promise<void>;
  disabled?: boolean;
  /** Why the control is locked (mid-turn etc.); Selector exposes it as the disabled tooltip. */
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

  const currentValue = props.current ?? DEFAULT_THINKING_LEVEL;
  const selection = usePendingSelection(currentValue, (value) =>
    props.onChange?.(value === DEFAULT_THINKING_LEVEL ? undefined : (value as ThinkingLevel)),
  );

  if (!hasVariants) return null;

  const currentLabel = options.find((option) => option.value === currentValue)?.label ?? copy.defaultLevel;

  return (
    <Selector
      label={`${copy.thinkingLevel}: ${currentLabel}`}
      isLabelHidden
      options={options}
      value={selection.value}
      variant="ghost"
      size="sm"
      placement="above"
      presentation={props.presentation}
      isReadOnly={props.isReadOnly}
      isDisabled={props.disabled}
      disabledMessage={props.disabledReason}
      placeholder={currentLabel}
      className="maka-thinking-level-selector"
      onChange={selection.onChange}
    />
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
  /** Force any open surface closed while an interaction prompt occludes the composer. */
  isReadOnly?: boolean;
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
    // action, shown as a disabled first row whenever the panel opens.
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
  // A wheel left open survives its unmount (the layer's hide callback never
  // fires) — reset it on session and presentation flips so a remount does not
  // reopen it spontaneously.
  useEffect(() => {
    if (props.presentation !== 'wheel') setWheelOpen(false);
  }, [props.presentation]);
  useEffect(() => setWheelOpen(false), [props.activeSession.id]);
  if (props.presentation === 'wheel') {
    const wheelList = wheelOptions(grouped, locale);
    if (!currentKnownChoice && currentValue && !props.hideUnavailableCurrentOption) {
      wheelList.unshift({ value: currentValue, label: displayLabel, disabled: true });
    }
    return (
      <>
        <ModelWheelPicker
          options={wheelList}
          value={selection.value}
          label={displayLabel}
          ariaLabel={`${copy.switchAriaLabel}: ${displayLabel}`}
          icon={providerMarkIcon(props.currentProviderType, props.renderProviderMark)}
          tooltip={props.disabledReason ?? copy.switchAriaLabel}
          triggerClassName="maka-model-switcher-trigger"
          disabled={disabled}
          open={wheelOpen}
          onOpenChange={setWheelOpen}
          onValueChange={selection.onChange}
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
      isReadOnly={props.isReadOnly}
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
 * start with. The thinking level for new chats is a separate right-footer
 * control owned by the Composer.
 */
export function NewChatModelPicker(props: {
  label: string;
  /** Same surfaces as ChatModelSwitcher; the collapsed WorkHub window passes 'wheel'. */
  presentation?: 'popover' | 'bottom-sheet' | 'wheel';
  /** Force any open surface closed while an interaction prompt occludes the composer. */
  isReadOnly?: boolean;
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
        ? { label: props.label, value: currentValue, providerType: props.currentProviderType, disabled: true }
        : undefined,
      exactChoiceValue,
      { locale, renderProviderMark: props.renderProviderMark },
    ),
    [grouped, currentKnownChoice, currentValue, props.label, props.currentProviderType,
      locale, props.renderProviderMark],
  );
  // The only producer is synchronous state (pending new-chat model), so the
  // pick shows through `currentValue` on the same render — no pending state.
  const pick = (value: string) => {
    if (value === currentValue) return Promise.resolve();
    const choice = choiceByValue.get(value);
    if (!choice) return Promise.resolve();
    return Promise.resolve(props.onPick({
      llmConnectionId: choice.connectionId,
      llmConnectionSlug: choice.connectionSlug,
      model: choice.model,
    }));
  };
  if (props.presentation === 'wheel') {
    const wheelList = wheelOptions(grouped, locale);
    if (!currentKnownChoice && currentValue) {
      wheelList.unshift({ value: currentValue, label: props.label, disabled: true });
    }
    return (
      <ModelWheelPicker
        options={wheelList}
        value={currentValue}
        label={props.label}
        ariaLabel={copy.newChatAriaLabel(props.label)}
        icon={providerMarkIcon(props.currentProviderType, props.renderProviderMark)}
        tooltip={copy.newChatTitle(props.label)}
        triggerClassName="maka-new-chat-model-selector"
        onValueChange={pick}
      />
    );
  }
  return (
    <Selector
      label={copy.newChatAriaLabel(props.label)}
      isLabelHidden
      options={options}
      value={currentValue}
      hasSearch
      searchPlaceholder={searchPlaceholder}
      variant="ghost"
      size="sm"
      placement="above"
      presentation={props.presentation}
      isReadOnly={props.isReadOnly}
      placeholder={props.label}
      className="maka-new-chat-model-selector"
      onChange={pick}
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
