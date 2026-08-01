import type { ChatDefaultPermissionMode, PermissionMode } from '@maka/core';
import { CHAT_DEFAULT_PERMISSION_MODES } from '@maka/core';
import type { UiLocale } from '@maka/core';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { cn } from './utils.js';

type PermissionModeAppearance = 'field' | 'quiet';

export interface PermissionModeMeta {
  label: string;
  hint: string;
}

/**
 * Sessions may run under a read-only (`explore`) boundary and legacy records
 * may contain `execute`, so metadata remains complete for the persisted
 * PermissionMode union. User-facing pickers offer only Auto (`ask`) and full
 * access (`bypass`), but any mode can be the state being displayed.
 *
 * This module is the one home for the mode table and shared picker: both the
 * composer and Settings render from it so labels, hints, and markup cannot
 * drift between the two surfaces.
 *
 * The danger of full access is carried by the words and by the destructive
 * confirmation dialog that guards the switch — not by a per-mode colour. An
 * earlier `tone` field here was never read by any renderer.
 */
export function getPermissionModeMeta(locale: UiLocale): Record<PermissionMode, PermissionModeMeta> {
  return getConversationCopy(locale).permissions.mode;
}

/** User-selectable modes in canonical display order. */
export const PERMISSION_MODE_ORDER: readonly ChatDefaultPermissionMode[] = CHAT_DEFAULT_PERMISSION_MODES;

/**
 * The shared permission-mode picker, built on Astryx Selector — the
 * semantically correct primitive for a single-value choice (the earlier
 * Menu + hand-styled "chip" trigger was a category error: Menu is for
 * actions, and the bespoke chip CSS existed to compensate). Both the
 * composer and Settings → 通用 → 默认权限模式 render this, so labels,
 * hints, and markup can't drift. Every option shows its label AND full
 * hint in the popup so the user never has to select a mode to learn what
 * it does; the selected option carries the standard Select check indicator.
 *
 * Legacy `execute` sessions collapse to Auto for display because that mode
 * no longer maps to a boundary of its own. A read-only (`explore`) session
 * is a state without a matching option, so the Select carries no value at
 * all and the trigger is labelled from the display state instead.
 */
export function PermissionModeSelect(props: {
  activeMode: PermissionMode;
  onSelect(mode: ChatDefaultPermissionMode): void | Promise<void>;
  align?: 'start' | 'end';
  disabled?: boolean;
  disabledReason?: string;
  ariaLabel?: string;
  className?: string;
  appearance?: PermissionModeAppearance;
}) {
  const locale = useUiLocale();
  const permissionCopy = getConversationCopy(locale).permissions;
  const modeMeta = getPermissionModeMeta(locale);
  // #1611: only legacy `execute` collapses to Auto. `explore` is a real
  // read-only boundary the user is running under, so it shows its own label
  // and hint instead of borrowing Auto's.
  const displayMode: PermissionMode =
    props.activeMode === 'execute' ? 'ask' : props.activeMode;
  const meta = modeMeta[displayMode];
  // A display state with no matching option is expressed as "no value", the
  // supported way to say nothing is selected. Passing an unmatched value
  // instead would depend on the component treating it as stale and trying to reset
  // it to null — behaviour we would only be surviving, not relying on.
  // The trigger reads its label from the display state, so it stays correct
  // whether or not the Select holds a value.
  const selectedValue: ChatDefaultPermissionMode | undefined = PERMISSION_MODE_ORDER.includes(
    displayMode as ChatDefaultPermissionMode,
  )
    ? (displayMode as ChatDefaultPermissionMode)
    : undefined;
  const options: SelectorOptionData[] = PERMISSION_MODE_ORDER.map((mode) => ({
    value: mode,
    label: modeMeta[mode].label,
  }));

  return (
    <Selector
      label={props.ariaLabel ?? permissionCopy.modeAriaLabel(meta.label)}
      isLabelHidden
      value={selectedValue}
      placeholder={meta.label}
      options={options}
      onChange={(value) =>
        void props.onSelect(value as ChatDefaultPermissionMode)
      }
      isDisabled={props.disabled}
      disabledMessage={props.disabledReason}
      aria-description={meta.hint}
      placement="below"
      width={props.appearance === 'quiet' ? undefined : 320}
      className={cn('permissionModeSelector', props.className)}
      renderOption={(option) => (
        <SelectorOption
          label={option.label ?? option.value}
          description={
            modeMeta[option.value as ChatDefaultPermissionMode].hint
          }
        />
      )}
    />
  );
}
