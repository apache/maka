/**
 * Chat model pickers, extracted from `components.tsx`.
 *
 * `ChatModelSwitcher` (in-session) and `NewChatModelPicker` (home / empty
 * state) were ~200 lines of Select JSX living next to the Composer in the
 * 8k-line `components.tsx`. They are consumed only by the Composer and share
 * the grouped model-choice helpers, so they form a clean seam. `index.ts` does
 * not re-export them (they are internal to the `@maka/ui` Composer surface).
 *
 * Thinking level is a separate Selector (not nested in the model menu). The
 * Composer places it immediately after the model control in the left footer.
 */

import { type ReactNode, useMemo } from 'react';
import { Button as UiButton, Selector } from '@astryxdesign/core';
import { ModelPicker } from './model-picker.js';
import { Settings } from './icons.js';
import {
  type ChatModelChoice,
  modelMenuGroups,
  modelChoiceValue,
  parseModelChoiceValue,
} from './chat-model-helpers.js';
import { type ProviderType, type SessionSummary, type ThinkingLevel } from '@maka/core';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

const DEFAULT_THINKING_LEVEL = '__default__';

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
  loading?: boolean;
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

  return (
    <Selector
      label={copy.thinkingLevel}
      isLabelHidden
      options={options}
      value={props.current ?? DEFAULT_THINKING_LEVEL}
      size="sm"
      placement="above"
      // Content-sized: short zh labels (关/中/高) must not sit in a fixed field.
      width="max-content"
      className="maka-thinking-level-selector"
      isDisabled={props.disabled}
      isLoading={props.loading}
      changeAction={(value) =>
        props.onChange?.(
          value === DEFAULT_THINKING_LEVEL ? undefined : value as ThinkingLevel,
        )
      }
    />
  );
}

export function ChatModelSwitcher(props: {
  activeSession: SessionSummary;
  activeModel?: string;
  activeConnectionLabel?: string;
  activeModelLabel?: string;
  currentProviderType?: ProviderType;
  choices: ChatModelChoice[];
  pending?: boolean;
  disabledReason?: string;
  renderProviderMark?(type: ProviderType): ReactNode;
  onChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).model;
  const currentModel = props.activeModel ?? props.activeSession.model;
  const currentValue = modelChoiceValue(props.activeSession.llmConnectionSlug, currentModel);
  const pending = Boolean(props.pending);
  const disabled = pending || Boolean(props.disabledReason) || !props.onChange || props.choices.length === 0;
  const grouped = modelMenuGroups(props.choices, locale);
  const currentKnownChoice = props.choices.some((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === currentValue);
  const displayLabel = props.activeModelLabel ?? currentModel;
  const currentSessionModelTitle = props.activeConnectionLabel && props.activeModelLabel
    ? copy.pinnedSession(props.activeConnectionLabel, props.activeModelLabel)
    : copy.switchSession;
  const title = pending
    ? `${copy.switching}…`
    : props.disabledReason ?? copy.switchTitle(currentSessionModelTitle);

  return (
    <div
      className="maka-model-switcher"
      title={title}
      data-disabled={disabled ? 'true' : undefined}
      data-pending={pending ? 'true' : undefined}
      aria-busy={pending ? 'true' : undefined}
    >
      <ModelPicker
        groups={grouped}
        value={currentValue}
        disabled={disabled}
        loading={pending}
        renderProviderMark={props.renderProviderMark}
        ariaLabel={copy.switchAriaLabel}
        triggerClassName="maka-model-switcher-trigger"
        leadingOption={!currentKnownChoice ? {
          value: currentValue,
          label: displayLabel,
          providerType: props.currentProviderType,
        } : undefined}
        onValueChange={async (value) => {
          const next = parseModelChoiceValue(value);
          if (!next) return;
          if (
            next.llmConnectionSlug === props.activeSession.llmConnectionSlug &&
            next.model === currentModel
          ) return;
          try {
            await props.onChange?.(next);
          } catch {
            // The AppShell action owner reports the visible model-switch failure.
          }
        }}
      />
    </div>
  );
}

/**
 * Home / empty-state model picker (no active session yet). Unlike
 * `ChatModelSwitcher` — which is bound to a live session and switches THAT
 * session's model — this one just records which model the next new chat should
 * start with. Reuses the model chip's look so the only visible change is that
 * the chevron now actually opens a menu. The thinking level for new chats is a
 * separate right-footer control owned by the Composer.
 */
export function NewChatModelPicker(props: {
  label: string;
  choices: ChatModelChoice[];
  currentValue?: string;
  currentProviderType?: ProviderType;
  renderProviderMark?(type: ProviderType): ReactNode;
  onPick(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).model;
  const grouped = modelMenuGroups(props.choices, locale);
  const currentValue = props.currentValue ?? '';
  const currentKnownChoice = props.choices.some(
    (choice) => modelChoiceValue(choice.connectionSlug, choice.model) === currentValue,
  );
  return (
    <ModelPicker
      groups={grouped}
      value={currentValue}
      renderProviderMark={props.renderProviderMark}
      ariaLabel={copy.newChatAriaLabel(props.label)}
      triggerClassName="maka-new-chat-model-selector"
      leadingOption={!currentKnownChoice ? {
        value: currentValue,
        label: props.label,
        providerType: props.currentProviderType,
      } : undefined}
      onValueChange={async (value) => {
        const next = parseModelChoiceValue(value);
        if (next) await props.onPick(next);
      }}
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
export function ModelChipStatic(props: { label: string; onOpenSettings?: () => void }) {
  const copy = getConversationCopy(useUiLocale()).model;
  if (props.onOpenSettings) {
    return (
      <UiButton
        variant="ghost"
        size="sm"
        onClick={props.onOpenSettings}
        aria-label={copy.configureAriaLabel(props.label)}
        tooltip={copy.configureTitle}
        icon={<Settings size={12} aria-hidden="true" />}
        label={props.label}
      />
    );
  }
  return (
    <span className="maka-composer-model-chip" title={props.label}>
      <span className="maka-composer-model-chip-text">{props.label}</span>
      <span className="maka-composer-model-status" aria-hidden="true" />
    </span>
  );
}
