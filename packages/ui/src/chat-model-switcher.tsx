/**
 * Chat model pickers, extracted from `components.tsx`.
 *
 * `ChatModelSwitcher` (in-session) and `NewChatModelPicker` (home / empty
 * state) were ~200 lines of Select JSX living next to the Composer in the
 * 8k-line `components.tsx`. They are consumed only by the Composer and share
 * the grouped model-choice helpers, so they form a clean seam. `index.ts` does
 * not re-export them (they are internal to the `@maka/ui` Composer surface).
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './primitives/menu.js';
import { Button as UiButton } from '@astryxdesign/core';
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

/**
 * Static footer row for per-model thinking levels. The flyout uses the shared
 * Base UI Menu primitive; ModelPicker keeps the host popup open while pointer
 * events land inside the portaled flyout via `data-model-picker-nested-popup`.
 */
function ThinkingLevelSection(props: {
  levels: readonly ThinkingLevel[];
  current?: ThinkingLevel;
  parentOpen: boolean;
  onCommit?(): void;
  onChange?(level: ThinkingLevel | undefined): void | Promise<void>;
}) {
  const copy = getConversationCopy(useUiLocale()).model;
  const [open, setOpen] = useState(false);
  const hasVariants = props.levels.length > 0 && Boolean(props.onChange);
  const currentLabel = props.current ? copy.level[props.current] : copy.defaultLevel;

  useEffect(() => {
    if (!props.parentOpen) setOpen(false);
  }, [props.parentOpen]);

  const choose = (level: ThinkingLevel | undefined) => {
    props.onCommit?.();
    void props.onChange?.(level);
  };

  return (
    <div className="maka-thinking-section">
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          nativeButton={false}
          disabled={!hasVariants}
          render={(triggerProps) => (
            <div
              {...triggerProps}
              role="button"
              tabIndex={hasVariants ? 0 : -1}
              aria-disabled={!hasVariants || undefined}
              aria-haspopup={hasVariants ? 'menu' : undefined}
              className="maka-thinking-section-row"
              data-disabled={!hasVariants || undefined}
              title={hasVariants ? copy.changeThinkingLevel : copy.thinkingUnsupported}
            >
              <span className="maka-thinking-section-label">{copy.thinkingLevel}</span>
              <span className="maka-thinking-section-value">
                {currentLabel}
                {hasVariants && <span className="maka-thinking-section-chev" aria-hidden="true">▸</span>}
              </span>
            </div>
          )}
        />
        {hasVariants && (
          <MenuPopup
            className="maka-thinking-flyout"
            align="start"
            side="inline-end"
            sideOffset={8}
            data-model-picker-nested-popup=""
          >
            <MenuItem
              onClick={() => choose(undefined)}
              className="maka-thinking-flyout-item"
              data-selected={!props.current || undefined}
            >
              <span>{copy.defaultLevel}</span>
              {!props.current && <span className="maka-thinking-flyout-check" aria-hidden="true">✓</span>}
            </MenuItem>
            {props.levels.map((level) => (
              <MenuItem
                key={level}
                onClick={() => choose(level)}
                className="maka-thinking-flyout-item"
                data-selected={props.current === level || undefined}
              >
                <span>{copy.level[level]}</span>
                {props.current === level && <span className="maka-thinking-flyout-check" aria-hidden="true">✓</span>}
              </MenuItem>
            ))}
          </MenuPopup>
        )}
      </Menu>
    </div>
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
  thinkingLevels?: readonly ThinkingLevel[];
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?(level: ThinkingLevel | undefined): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).model;
  const [localPending, setLocalPending] = useState(false);
  const pendingRef = useRef(false);
  const modelSwitcherMountedRef = useMountedRef();
  const pendingModelChangeRef = useRef<{ sessionId: string; token: number } | null>(null);
  const pendingModelChangeTokenRef = useRef(0);
  const currentModel = props.activeModel ?? props.activeSession.model;
  const currentValue = modelChoiceValue(props.activeSession.llmConnectionSlug, currentModel);
  const pending = props.pending || localPending;
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

  useEffect(() => {
    return () => {
      pendingModelChangeRef.current = null;
      pendingModelChangeTokenRef.current += 1;
      pendingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (pendingModelChangeRef.current?.sessionId === props.activeSession.id) return;
    pendingModelChangeRef.current = null;
    pendingModelChangeTokenRef.current += 1;
    pendingRef.current = false;
    setLocalPending(false);
  }, [props.activeSession.id]);

  return (
    <div
      className="maka-model-switcher"
      title={title}
      data-disabled={disabled ? 'true' : undefined}
      data-pending={pending ? 'true' : undefined}
      aria-busy={pending ? 'true' : undefined}
    >
      <ModelPicker
        triggerAppearance="quiet"
        groups={grouped}
        value={currentValue}
        disabled={disabled}
        renderProviderMark={props.renderProviderMark}
        ariaLabel={copy.switchAriaLabel}
        title={title}
        triggerClassName="maka-model-switcher-trigger"
        pinnedItem={!currentKnownChoice ? { value: currentValue, label: currentModel } : undefined}
        onValueChange={(value) => {
          if (pendingRef.current || props.pending) return;
          const next = parseModelChoiceValue(value);
          if (!next) return;
          if (
            next.llmConnectionSlug === props.activeSession.llmConnectionSlug &&
            next.model === currentModel
          ) {
            return;
          }
          const sessionId = props.activeSession.id;
          const token = pendingModelChangeTokenRef.current + 1;
          pendingModelChangeTokenRef.current = token;
          pendingModelChangeRef.current = { sessionId, token };
          pendingRef.current = true;
          setLocalPending(true);
          void (async () => {
            try {
              await props.onChange?.(next);
            } catch {
              // The AppShell action owner reports the visible model-switch failure.
            } finally {
              const owner = pendingModelChangeRef.current;
              if (modelSwitcherMountedRef.current && owner?.sessionId === sessionId && owner.token === token) {
                pendingModelChangeRef.current = null;
                pendingRef.current = false;
                setLocalPending(false);
              }
            }
          })();
        }}
        footer={({ open, close }) => (
          <ThinkingLevelSection
            levels={props.thinkingLevels ?? []}
            current={props.thinkingLevel}
            parentOpen={open}
            onCommit={close}
            onChange={props.onThinkingLevelChange}
          />
        )}
      >
        {props.currentProviderType && props.renderProviderMark && (
          <span className="maka-composer-provider-mark" data-provider={props.currentProviderType} aria-hidden="true">
            {props.renderProviderMark(props.currentProviderType)}
          </span>
        )}
        <span className="maka-model-switcher-label">{pending ? copy.switching : copy.model}</span>
        <span className="maka-model-switcher-value">
          {displayLabel}
          {props.thinkingLevel && <span className="maka-thinking-level-tag">{copy.level[props.thinkingLevel]}</span>}
        </span>
      </ModelPicker>
    </div>
  );
}

/**
 * Home / empty-state model picker (no active session yet). Unlike
 * `ChatModelSwitcher` — which is bound to a live session and switches THAT
 * session's model — this one just records which model the next new chat should
 * start with. Reuses the model chip's look so the only visible change is that
 * the chevron now actually opens a menu. The thinking level chosen here is
 * passed to `createSession` on the first message (so reasoning models start at
 * the right depth without a mid-session change that would invalidate the
 * provider prompt cache).
 */
export function NewChatModelPicker(props: {
  label: string;
  choices: ChatModelChoice[];
  currentValue?: string;
  currentProviderType?: ProviderType;
  renderProviderMark?(type: ProviderType): ReactNode;
  onPick(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
  thinkingLevels?: readonly ThinkingLevel[];
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?(level: ThinkingLevel | undefined): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).model;
  const grouped = modelMenuGroups(props.choices, locale);
  return (
    <ModelPicker
      triggerAppearance="quiet"
      groups={grouped}
      value={props.currentValue ?? ''}
      renderProviderMark={props.renderProviderMark}
      ariaLabel={copy.newChatAriaLabel(props.label)}
      title={copy.newChatTitle(props.label)}
      triggerClassName="maka-composer-model-chip"
      onValueChange={(value) => {
        const next = parseModelChoiceValue(value);
        if (next) void props.onPick(next);
      }}
      footer={({ open, close }) => (
        <ThinkingLevelSection
          levels={props.thinkingLevels ?? []}
          current={props.thinkingLevel}
          parentOpen={open}
          onCommit={close}
          onChange={props.onThinkingLevelChange}
        />
      )}
    >
      {props.currentProviderType && props.renderProviderMark && (
        <span className="maka-composer-provider-mark" data-provider={props.currentProviderType} aria-hidden="true">
          {props.renderProviderMark(props.currentProviderType)}
        </span>
      )}
      <span className="maka-composer-model-chip-text">{props.label}</span>
      {props.thinkingLevel && <span className="maka-thinking-level-tag">{copy.level[props.thinkingLevel]}</span>}
      {/* ModelPicker's trigger already renders a chevron — no manual one. */}
    </ModelPicker>
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
    <span className="maka-composer-model-chip" aria-label={copy.currentAriaLabel(props.label)} title={props.label}>
      <span className="maka-composer-model-chip-text">{props.label}</span>
      <span className="maka-composer-model-status" aria-hidden="true" />
    </span>
  );
}
