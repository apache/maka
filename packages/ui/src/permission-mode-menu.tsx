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
 * Internal sessions still use `explore` and legacy records may contain
 * `execute`, so metadata remains complete for the persisted PermissionMode
 * union. User-facing pickers expose only Auto (`ask`) and Bypass.
 *
 * This module is the one home for the mode table and shared picker: both the
 * composer and Settings render from it so labels, hints, and markup cannot
 * drift between the two surfaces.
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

/** User-selectable modes in canonical display order. */
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
 * Internal `explore` and legacy `execute` sessions collapse to Auto for
 * display because neither is a user-selectable boundary mode.
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
