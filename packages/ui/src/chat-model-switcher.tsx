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
 * state) were ~200 lines of Select JSX living next to the Composer in the
 * 8k-line `components.tsx`. They are consumed only by the Composer and share
 * the grouped model-choice helpers, so they form a clean seam. `index.ts` does
 * not re-export them (they are internal to the `@maka/ui` Composer surface).
 *
 * Composer footer pickers are ghost-button DropdownMenus — the same toolbar
 * primitive as the ＋ and permission controls beside them, so resting, hover,
 * focus, and disabled chrome all derive from one Button instead of a product
 * overlay restyling a form field. The Astryx Selector (a field primitive,
 * with search) remains the right shape for Settings forms via `ModelPicker`.
 *
 * Thinking level is a separate menu (not nested in the model menu). The
 * Composer places it immediately after the model control in the left footer.
 */

import { type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button as UiButton } from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { ICON_SIZE, AlertTriangle, Check, Settings } from './icons.js';
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

/** Scroll previews a model; click or Enter commits it. No popup escapes the window. */
function ModelWheel(props: {
  groups: readonly ModelMenuGroup[];
  currentValue?: string;
  label: string;
  disabled: boolean;
  onPick(choice: ChatModelChoice): void;
  onClose(restoreFocus: boolean): void;
}) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; scrollTop: number; moved: boolean } | undefined>(undefined);
  const choices = props.groups.flatMap((group) => group.choices.map((choice) => ({ choice, heading: group.heading, value: exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model) })));
  const [preview, setPreview] = useState(() => Math.max(0, choices.findIndex((entry) => entry.value === props.currentValue)));
  const rowHeight = 44;
  const finishDrag = (element: HTMLDivElement) => {
    if (!element.dataset.dragging) return;
    delete element.dataset.dragging;
    element.scrollTo({
      top: Math.round(element.scrollTop / rowHeight) * rowHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  };
  useLayoutEffect(() => {
    if (!viewport.current) return;
    viewport.current.scrollTop = preview * rowHeight;
    viewport.current.focus({ preventScroll: true });
  }, []);
  return <div className="maka-model-wheel">
    <div ref={viewport} className="maka-model-wheel-viewport" role="listbox" tabIndex={0} aria-label={props.label} aria-disabled={props.disabled} aria-activedescendant={`${id}-${preview}`}
      style={{ height: rowHeight * 3, paddingBlock: rowHeight }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) props.onClose(false); }}
      onScroll={(event) => setPreview(Math.max(0, Math.min(choices.length - 1, Math.round(event.currentTarget.scrollTop / rowHeight))))}
      onPointerDown={(event) => {
        drag.current = undefined;
        if (props.disabled || event.button !== 0 || event.pointerType !== 'mouse') return;
        drag.current = { pointerId: event.pointerId, startY: event.clientY, scrollTop: event.currentTarget.scrollTop, moved: false };
      }}
      onPointerMove={(event) => {
        const gesture = drag.current;
        if (!gesture || gesture.pointerId !== event.pointerId || !(event.buttons & 1)) return;
        const distance = event.clientY - gesture.startY;
        if (!gesture.moved && Math.abs(distance) < 5) return;
        if (!gesture.moved) {
          gesture.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.dragging = 'true';
        }
        event.preventDefault();
        event.currentTarget.scrollTop = gesture.scrollTop - distance;
      }}
      onPointerUp={(event) => finishDrag(event.currentTarget)}
      onPointerCancel={(event) => { finishDrag(event.currentTarget); drag.current = undefined; }}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget)}
      onClickCapture={(event) => {
        if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); }
        drag.current = undefined;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(true); return; }
        if (props.disabled) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation();
          const entry = choices[preview];
          if (entry) props.onPick(entry.choice);
          return;
        }
        const next = event.key === 'ArrowDown' ? preview + 1 : event.key === 'ArrowUp' ? preview - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.scrollTop = Math.max(0, Math.min(choices.length - 1, next)) * rowHeight;
      }}>
      {choices.map(({ choice, heading, value }, index) => <div key={value} id={`${id}-${index}`} className="maka-model-wheel-option" role="option" aria-selected={index === preview} aria-disabled={props.disabled} style={{ height: rowHeight }} title={`${choice.label} · ${heading}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { if (!props.disabled) props.onPick(choice); }}>
        <span className="maka-model-wheel-label">{choice.label}</span>
        <span className="maka-model-wheel-provider">{heading}</span>
        {value === props.currentValue && <span className="maka-model-wheel-check">{currentCheck}</span>}
      </div>)}
    </div>
  </div>;
}

/**
 * The one shared body of both model menus: an optional leading row for a
 * current model the catalog no longer lists, then one `role="group"` section
 * per connection (heading + its models). Radio semantics expose the selected
 * value to assistive technology while the aria-hidden check preserves the
 * quiet footer's visual density. `disabled` locks every row, not just the trigger: an aria-disabled
 * trigger still opens its menu on ArrowDown (Astryx DropdownMenu's keydown
 * path does not consult `isDisabled`), so the lock must live on the items too.
 */
function ModelMenuItems(props: {
  groups: readonly ModelMenuGroup[];
  currentValue?: string;
  label: string;
  leadingOption?: { label: string; providerType?: ProviderType };
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
  onPick(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): void | Promise<void>;
}) {
  const locale = useUiLocale();
  return (
    <DropdownMenuRadioGroup
      value={props.currentValue}
      label={props.label}
      onChange={(value) => {
        const choice = props.groups
          .flatMap((group) => group.choices)
          .find((entry) => exactModelChoiceValue(
            entry.connectionId,
            entry.connectionSlug,
            entry.model,
          ) === value);
        if (choice) {
          void props.onPick({
            llmConnectionId: choice.connectionId,
            llmConnectionSlug: choice.connectionSlug,
            model: choice.model,
          });
        }
      }}
    >
      {props.leadingOption ? (
        <DropdownMenuRadioItem
          value={props.currentValue ?? ''}
          icon={providerMarkIcon(props.leadingOption.providerType, props.renderProviderMark)}
          label={props.leadingOption.label}
          endContent={currentCheck}
          isDisabled={props.disabled}
        />
      ) : null}
      {props.groups.map((group) => (
        <div role="group" aria-label={group.heading} key={group.connectionSlug}>
          <div className="maka-model-menu-group-heading" aria-hidden="true">
            {group.heading}
          </div>
          {group.choices.map((choice) => {
            const value = exactModelChoiceValue(
              choice.connectionId,
              choice.connectionSlug,
              choice.model,
            );
            return (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                icon={providerMarkIcon(choice.providerType, props.renderProviderMark)}
                label={choice.label}
                description={modelChoiceDescription(choice, locale)}
                endContent={value === props.currentValue ? currentCheck : undefined}
                isDisabled={props.disabled}
              />
            );
          })}
        </div>
      ))}
    </DropdownMenuRadioGroup>
  );
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
  presentation?: 'menu' | 'wheel';
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
  const trigger = useRef<HTMLButtonElement>(null);
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

  if (props.presentation === 'wheel') {
    const close = (restoreFocus: boolean) => {
      setMenuOpen(false);
      if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
    };
    return menuOpen ? <ModelWheel groups={grouped} currentValue={currentValue} label={copy.switchAriaLabel} disabled={disabled}
      onClose={close}
      onPick={(choice) => {
        close(true);
        void pick({ llmConnectionId: choice.connectionId, llmConnectionSlug: choice.connectionSlug, model: choice.model });
      }} /> : <UiButton ref={trigger} type="button" variant="ghost" size="sm" label={displayLabel} icon={providerMarkIcon(props.currentProviderType, props.renderProviderMark)} isDisabled={disabled} className="maka-model-switcher-trigger" aria-label={`${copy.switchAriaLabel}: ${displayLabel}`} aria-expanded={false} onClick={() => setMenuOpen(true)} />;
  }

  return (
    <>
      <DropdownMenu
        {...(props.isMenuOpen === undefined ? {} : { isMenuOpen: props.isMenuOpen })}
        placement="above"
        hasChevron={false}
        className="maka-composer-quiet-menu"
        onOpenChange={setMenuOpen}
        button={{
          label: displayLabel,
          icon: providerMarkIcon(props.currentProviderType, props.renderProviderMark),
          variant: 'ghost',
          size: 'sm',
          isDisabled: disabled,
          tooltip: title,
          className: 'maka-model-switcher-trigger',
          'aria-label': `${copy.switchAriaLabel}: ${displayLabel}`,
        }}
      >
        {announceWarning ? (
          <div className="maka-model-switch-notice" aria-hidden="true">
            <AlertTriangle size={ICON_SIZE.meta} />
            <span>{copy.switchWarning}</span>
          </div>
        ) : null}
        <ModelMenuItems
          groups={grouped}
          currentValue={currentValue}
          label={`${copy.switchAriaLabel}: ${displayLabel}`}
          leadingOption={
            !currentKnownChoice && !props.hideUnavailableCurrentOption
              ? { label: displayLabel, providerType: props.currentProviderType }
              : undefined
          }
          renderProviderMark={props.renderProviderMark}
          disabled={disabled}
          onPick={pick}
        />
      </DropdownMenu>
      <span
        className="maka-visually-hidden maka-model-switch-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announceWarning ? copy.switchWarning : ''}
      </span>
    </>
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
  return (
    <DropdownMenu
      placement="above"
      hasChevron={false}
      className="maka-composer-quiet-menu"
      button={{
        label: props.label,
        icon: providerMarkIcon(props.currentProviderType, props.renderProviderMark),
        variant: 'ghost',
        size: 'sm',
        tooltip: copy.newChatTitle(props.label),
        className: 'maka-new-chat-model-selector',
        'aria-label': copy.newChatAriaLabel(props.label),
      }}
    >
      <ModelMenuItems
        groups={grouped}
        currentValue={currentValue}
        label={copy.newChatAriaLabel(props.label)}
        leadingOption={!currentKnownChoice && currentValue ? { label: props.label, providerType: props.currentProviderType } : undefined}
        renderProviderMark={props.renderProviderMark}
        onPick={props.onPick}
      />
    </DropdownMenu>
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
