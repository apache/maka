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

import type { SlashCommandIdForSurface } from '@maka/core/slash-command-catalog';
import {
  defineUiMessageCatalog,
  resolveUiMessageCatalog,
  type UiLocale,
} from '@maka/core/ui-locale';
import { renderTuiShortcutCopy } from './tui-shortcut-copy.js';
import { TUI_COPY_RESOURCES } from './tui-copy-catalog.js';

type TuiCommandId = SlashCommandIdForSurface<'tui'>;

export interface TuiPrimaryGuidanceCopy {
  readonly welcome: {
    readonly tagline: string;
    readonly start: string;
    readonly session: string;
    readonly model: string;
    readonly setup: string;
  };
  readonly commands: Readonly<Record<TuiCommandId, string>>;
  readonly help: {
    readonly commandsHeading: string;
    readonly userCommand: string;
    readonly keybindingsHeading: string;
    readonly keybindings: readonly string[];
  };
}

const TUI_PRIMARY_GUIDANCE = resolveUiMessageCatalog(
  defineUiMessageCatalog<TuiPrimaryGuidanceCopy>()(TUI_COPY_RESOURCES['primary-guidance']),
);

export function getTuiPrimaryGuidance(
  locale: UiLocale,
  platform: NodeJS.Platform = process.platform,
): TuiPrimaryGuidanceCopy {
  const guidance = TUI_PRIMARY_GUIDANCE[locale];
  return {
    ...guidance,
    help: {
      ...guidance.help,
      keybindings: guidance.help.keybindings.map((line) => renderTuiShortcutCopy(line, platform)),
    },
  };
}
