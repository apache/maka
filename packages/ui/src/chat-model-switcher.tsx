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

import { type ReactNode, useMemo } from 'react';
import { Button as UiButton } from '@astryxdesign/core';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { ICON_SIZE, Check, Settings } from './icons.js';
import {
  type ChatModelChoice,
  type ModelMenuGroup,
  modelChoiceDescription,
  modelMenuGroups,
  modelChoiceValue,
} from './chat-model-helpers.js';
import { type ProviderType } from '@maka/core/llm-connections';
import { type SessionSummary } from '@maka/core/session';
import { type ThinkingLevel } from '@maka/core/model-thinking';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

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

/**
 * The one shared body of both model menus: an optional leading row for a
 * current model the catalog no longer lists, then one `role="group"` section
 * per connection (heading + its models). The current value wears a check —
 * plain menu items, not radio rows, so the menu keeps the quiet footer's sm
 * density. `disabled` locks every row, not just the trigger: an aria-disabled
 * trigger still opens its menu on ArrowDown (Astryx DropdownMenu's keydown
 * path does not consult `isDisabled`), so the lock must live on the items too.
 */
function ModelMenuItems(props: {
  groups: readonly ModelMenuGroup[];
  currentValue?: string;
  leadingOption?: { label: string; providerType?: ProviderType };
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
  onPick(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
}) {
  const locale = useUiLocale();
  return (
    <>
      {props.leadingOption ? (
        <DropdownMenuItem
          icon={providerMarkIcon(props.leadingOption.providerType, props.renderProviderMark)}
          label={props.leadingOption.label}
          endContent={currentCheck}
          isDisabled={props.disabled}
          // Current value: picking it changes nothing, but the click still
          // owes the user the menu close every other item gives.
          onClick={() => {}}
        />
      ) : null}
      {props.groups.map((group) => (
        <div role="group" aria-label={group.heading} key={group.connectionSlug}>
          <div className="maka-model-menu-group-heading" aria-hidden="true">
            {group.heading}
          </div>
          {group.choices.map((choice) => {
            const value = modelChoiceValue(choice.connectionSlug, choice.model);
            return (
              <DropdownMenuItem
                key={value}
                icon={providerMarkIcon(choice.providerType, props.renderProviderMark)}
                label={choice.label}
                description={modelChoiceDescription(choice, locale)}
                endContent={value === props.currentValue ? currentCheck : undefined}
                isDisabled={props.disabled}
                onClick={() => {
                  void props.onPick({ llmConnectionSlug: choice.connectionSlug, model: choice.model });
                }}
              />
            );
          })}
        </div>
      ))}
    </>
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
        isLoading: props.loading,
        tooltip: props.disabledReason ?? copy.changeThinkingLevel,
        className: 'maka-thinking-level-selector',
        'aria-label': `${copy.thinkingLevel}: ${currentLabel}`,
      }}
    >
      {options.map((option) => (
        <DropdownMenuItem
          key={option.value}
          label={option.label}
          endContent={option.value === currentValue ? currentCheck : undefined}
          isDisabled={props.disabled}
          onClick={() => {
            void props.onChange?.(
              option.value === DEFAULT_THINKING_LEVEL ? undefined : (option.value as ThinkingLevel),
            );
          }}
        />
      ))}
    </DropdownMenu>
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
    <DropdownMenu
      placement="above"
      hasChevron={false}
      className="maka-composer-quiet-menu"
      button={{
        label: displayLabel,
        icon: providerMarkIcon(props.currentProviderType, props.renderProviderMark),
        variant: 'ghost',
        size: 'sm',
        isDisabled: disabled,
        isLoading: pending,
        tooltip: title,
        className: 'maka-model-switcher-trigger',
        'aria-label': copy.switchAriaLabel,
      }}
    >
      <ModelMenuItems
        groups={grouped}
        currentValue={currentValue}
        leadingOption={!currentKnownChoice ? { label: displayLabel, providerType: props.currentProviderType } : undefined}
        renderProviderMark={props.renderProviderMark}
        disabled={disabled}
        onPick={async (next) => {
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
    </DropdownMenu>
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
