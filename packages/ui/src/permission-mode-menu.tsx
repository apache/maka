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

import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { PermissionMode } from '@maka/core/permission';
import { CHAT_DEFAULT_PERMISSION_MODES } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { ICON_SIZE, Eye, ShieldAlert, ShieldCheck } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { cn } from './utils.js';

type PermissionModeAppearance = 'field' | 'icon';

function permissionModeIcon(mode: PermissionMode) {
  if (mode === 'bypass') return <ShieldAlert size={ICON_SIZE.control} aria-hidden="true" />;
  if (mode === 'explore') return <Eye size={ICON_SIZE.control} aria-hidden="true" />;
  return <ShieldCheck size={ICON_SIZE.control} aria-hidden="true" />;
}

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
 * Shared permission-mode picker.
 *
 * - **field** (Settings): Astryx Selector with option hints — the correct
 *   single-value primitive.
 * - **icon** (quiet composer footer): ghost icon button + radio menu of the
 *   two selectable modes (label only). Hints stay on the trigger tooltip /
 *   aria-description so the open panel stays short and matches the ＋ control.
 *
 * Legacy `execute` sessions collapse to Auto for display. A read-only
 * (`explore`) session has no matching option, so the control shows that state
 * without selecting Auto or full access.
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
  const selectedValue: ChatDefaultPermissionMode | undefined = PERMISSION_MODE_ORDER.includes(
    displayMode as ChatDefaultPermissionMode,
  )
    ? (displayMode as ChatDefaultPermissionMode)
    : undefined;
  const options: SelectorOptionData[] = PERMISSION_MODE_ORDER.map((mode) => ({
    value: mode,
    label: modeMeta[mode].label,
  }));
  const ariaLabel = props.ariaLabel ?? permissionCopy.modeAriaLabel(meta.label);

  // Composer footer: match the ＋ ghost icon button. Astryx puts DropdownMenu
  // className on the panel, so product anchors wrap the whole control.
  if (props.appearance === 'icon') {
    return (
      <span className={cn('permissionModeIcon', props.className)}>
        <DropdownMenu
          placement="above"
          hasChevron={false}
          className="maka-composer-quiet-menu"
          button={{
            label: ariaLabel,
            icon: permissionModeIcon(displayMode),
            isIconOnly: true,
            variant: 'ghost',
            size: 'sm',
            isDisabled: props.disabled,
            tooltip: props.disabledReason ?? `${meta.label} — ${meta.hint}`,
            'aria-description': meta.hint,
          }}
        >
          <DropdownMenuRadioGroup
            value={selectedValue}
            label={ariaLabel}
            onChange={(value) => {
              void props.onSelect(value as ChatDefaultPermissionMode);
            }}
          >
            {PERMISSION_MODE_ORDER.map((mode) => (
              <DropdownMenuRadioItem
                key={mode}
                value={mode}
                label={modeMeta[mode].label}
                icon={permissionModeIcon(mode)}
                isDisabled={props.disabled}
              />
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenu>
      </span>
    );
  }

  return (
    <Selector
      label={ariaLabel}
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
      className={cn('permissionModeSelector', props.className)}
      renderOption={(option) => (
        <SelectorOption
          icon={permissionModeIcon(option.value as PermissionMode)}
          label={option.label ?? option.value}
          description={
            modeMeta[option.value as ChatDefaultPermissionMode].hint
          }
        />
      )}
    />
  );
}
