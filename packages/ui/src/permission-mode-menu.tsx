import type { ChatDefaultPermissionMode, PermissionMode } from '@maka/core';
import { CHAT_DEFAULT_PERMISSION_MODES } from '@maka/core';
import type { UiLocale } from '@maka/core';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import {
  SelectItem,
  SelectPopup,
  SelectPortal,
  SelectPositioner,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  type PickerTriggerAppearance,
} from './ui.js';

export interface PermissionModeMeta {
  label: string;
  hint: string;
  tone: 'info' | 'accent' | 'destructive';
}

/**
 * PR-MOVE-PERMISSION-MODE (WAWQAQ msgs 47fe0d0e / 21993dcc / a667cf6c
 * 2026-06-23): the user-facing permission-mode picker is a three-option
 * dropdown. The `explore` (read-only) mode is not user-selectable — it
 * exists in the `PermissionMode` enum because Deep Research sessions and
 * Bot-incoming guards use it as their default; pickers collapse those
 * sessions to display 询问权限 so the user sees a coherent option.
 *
 * Labels follow WAWQAQ's a667cf6c renaming — direct, action-led copy
 * instead of engineering shorthand.
 *
 * This module is the ONE home for the mode table and the shared picker —
 * both the composer and Settings → 通用 → 默认权限模式 render from it, so
 * labels/hints/markup can't drift between the two surfaces.
 */
const PERMISSION_MODE_TONE: Record<PermissionMode, PermissionModeMeta['tone']> = {
  explore: 'info', ask: 'accent', execute: 'info', bypass: 'destructive',
};

export function getPermissionModeMeta(locale: UiLocale): Record<PermissionMode, PermissionModeMeta> {
  const copy = getConversationCopy(locale).permissions.mode;
  return {
    explore: { ...copy.explore, tone: PERMISSION_MODE_TONE.explore },
    ask: { ...copy.ask, tone: PERMISSION_MODE_TONE.ask },
    execute: { ...copy.execute, tone: PERMISSION_MODE_TONE.execute },
    bypass: { ...copy.bypass, tone: PERMISSION_MODE_TONE.bypass },
  };
}

/** User-selectable modes, in display order — the canonical non-`explore`
 *  list from @maka/core, aliased under the name the composer historically
 *  exported. */
export const PERMISSION_MODE_ORDER: readonly ChatDefaultPermissionMode[] = CHAT_DEFAULT_PERMISSION_MODES;

/**
 * The shared permission-mode picker, built on Base UI Select — the
 * semantically correct primitive for a single-value choice (the earlier
 * Menu + hand-styled "chip" trigger was a category error: Menu is for
 * actions, and the bespoke chip CSS existed to compensate). Both the
 * composer and Settings → 通用 → 默认权限模式 render this, so labels,
 * hints, and markup can't drift. Every option shows its label AND full
 * hint in the popup so the user never has to select a mode to learn what
 * it does; the selected option carries the standard Select check indicator.
 *
 * `explore` collapses to `ask` for display (Deep Research uses it
 * internally; it's not a useful user toggle).
 */
export function PermissionModeSelect(props: {
  activeMode: PermissionMode;
  onSelect(mode: ChatDefaultPermissionMode): void | Promise<void>;
  align?: 'start' | 'end';
  disabled?: boolean;
  disabledReason?: string;
  ariaLabel?: string;
  className?: string;
  appearance?: PickerTriggerAppearance;
}) {
  const locale = useUiLocale();
  const permissionCopy = getConversationCopy(locale).permissions;
  const modeMeta = getPermissionModeMeta(locale);
  const displayMode: PermissionMode =
    props.activeMode === 'bypass' ? 'bypass' : 'ask';
  const meta = modeMeta[displayMode];
  return (
    <SelectRoot
      value={displayMode}
      items={PERMISSION_MODE_ORDER.map((mode) => ({ value: mode, label: modeMeta[mode].label }))}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null) void props.onSelect(value as ChatDefaultPermissionMode);
      }}
    >
      <SelectTrigger
        appearance={props.appearance}
        aria-label={props.ariaLabel ?? permissionCopy.modeAriaLabel(meta.label)}
        title={props.disabledReason ?? meta.hint}
        className={props.className}
      >
        <SelectValue>
          {(value: string) => modeMeta[value as PermissionMode]?.label ?? meta.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPortal>
        <SelectPositioner alignItemWithTrigger={false} align={props.align ?? 'start'} sideOffset={6}>
          <SelectPopup className="min-w-[280px] max-w-[320px]">
            {PERMISSION_MODE_ORDER.map((mode) => {
              const optionMeta = modeMeta[mode];
              return (
                <SelectItem key={mode} value={mode}>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">{optionMeta.label}</span>
                    <span className="text-xs leading-snug text-muted-foreground">{optionMeta.hint}</span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </SelectPositioner>
      </SelectPortal>
    </SelectRoot>
  );
}
