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

// apps/desktop/src/renderer/features/overlays/model/palette-session-commands.ts
//
// The palette's 会话 group. Session rows subscribe the catalog here — at the
// consumption point — so the shell is not woken by palette-only reads.

import { useMemo } from 'react';
import { MessageSquare, Palette } from '@maka/ui/icons';
import type { SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellCopy } from '../../../locales/shell-copy.js';
import {
  selectClosedPaletteSessions,
  selectPaletteSessions,
  paletteSessionsEqual,
} from '../../../application/contracts/session-catalog/session-rail-visibility.js';
import type { SessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';
import type { Command } from './command.js';

/**
 * Session rows for the palette's 会话 group, derived separately from the
 * base command list (#1045): the base list is frozen per palette open/close,
 * while these rebuild only when the visible session catalog or the active
 * session actually changes, so background session creates/renames stay live
 * without reintroducing per-render list rebuilds.
 */
export function buildSessionCommands(args: {
  locale: UiLocale;
  sessions: readonly SessionSummary[];
  activeSessionId: string | undefined;
  onSelectSession(id: string): void;
}): Command[] {
  const copy = getShellCopy(args.locale).commandPalette;
  const cmds: Command[] = [];
  for (const session of args.sessions) {
    if (session.isArchived) continue;
    cmds.push({
      id: `session:${session.id}`,
      kind: 'session',
      label: session.name,
      hint: session.id === args.activeSessionId ? copy.current : undefined,
      group: copy.groups.conversations,
      Icon: session.isFlagged ? Palette : MessageSquare,
      keywords: ['session', 'chat', session.name],
      run: () => args.onSelectSession(session.id),
    });
  }
  return cmds;
}

/**
 * The live session rows, subscribed only while the palette is open.
 */
export function usePaletteSessionCommands(args: {
  catalog: SessionCatalogController;
  hiddenSessionIds: ReadonlySet<string>;
  paletteOpen: boolean;
  activeSessionId: string | undefined;
  locale: UiLocale;
  onSelectSession(id: string): void;
}): Command[] {
  const sessions = useExternalStoreSelector(
    args.catalog,
    args.paletteOpen ? selectPaletteSessions : selectClosedPaletteSessions,
    args.hiddenSessionIds,
    paletteSessionsEqual,
  );
  return useMemo(
    () =>
      args.paletteOpen
        ? buildSessionCommands({
            locale: args.locale,
            sessions,
            activeSessionId: args.activeSessionId,
            onSelectSession: args.onSelectSession,
          })
        : [],
    [args.paletteOpen, args.locale, sessions, args.activeSessionId, args.onSelectSession],
  );
}
