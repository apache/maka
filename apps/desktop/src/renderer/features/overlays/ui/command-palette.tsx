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

// ⌘K (Ctrl+K off macOS) command palette. Renders the rows the shell built
// (static actions plus the live session list) so the user can fuzzy-search
// across both. Astryx owns the dialog, input, listbox, keyboard navigation,
// focus, and dismissal; the overlays controller owns whether it is open.

import { useEffect, useMemo, useRef } from 'react';
import { ICON_SIZE, ChevronRight, CornerDownLeft } from '@maka/ui/icons';
import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteFooter,
  CommandPaletteInput,
  AstryxLocaleProvider,
  type SearchSource,
  type SearchableItem,
  PlatformShortcutText,
  useUiLocale,
} from '@maka/ui';
import { Kbd } from '@astryxdesign/core/Kbd';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { getShellCopy } from '../../../locales/shell-copy.js';
import type { Command } from '../model/command.js';
import { useOverlays } from './overlays-context.js';

function fuzzy(query: string, text: string): boolean {
  // Cheap subsequence match: every char of query (lowercase) must appear in
  // order somewhere inside text (lowercase). Good enough for a palette with
  // <100 commands; we can swap in a real fuzzy matcher later.
  if (!query) return true;
  let i = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let j = 0; j < t.length && i < q.length; j += 1) {
    if (t[j] === q[i]) i += 1;
  }
  return i === q.length;
}

export function CommandPalette(props: { readonly commands: Command[] }) {
  const { commands: overlayCommands, selectors } = useOverlays();
  const isOpen = selectors.paletteOpen;
  const locale = useUiLocale();
  const copy = getShellCopy(locale).commandPalette;
  const astryxOverrides = useMemo(
    () => ({
      '@astryx.commandPalette.list.label': copy.resultsLabel,
    }),
    [copy.resultsLabel],
  );
  type PaletteItem = SearchableItem<{
    command: Command;
    group: string;
  }>;
  const items = useMemo<PaletteItem[]>(
    () =>
      props.commands.map((command) => ({
        id: command.id,
        label: command.label,
        auxiliaryData: { command, group: command.group },
      })),
    [props.commands],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const pendingCommandRef = useRef<Command | null>(null);

  useEffect(() => {
    if (isOpen) return;
    const command = pendingCommandRef.current;
    pendingCommandRef.current = null;
    if (!command) return;
    const frame = window.requestAnimationFrame(() => {
      void Promise.resolve(command.run()).catch(() => undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);
  const searchSource = useMemo<SearchSource<PaletteItem>>(
    () => ({
      bootstrap: () => items,
      search: (query) => {
        const normalized = query.trim();
        if (!normalized) return items;
        return items.filter(({ auxiliaryData }) => {
          const command = auxiliaryData?.command;
          if (!command) return false;
          if (fuzzy(normalized, command.label)) return true;
          if (command.hint && fuzzy(normalized, command.hint)) return true;
          if (
            command.platformHint &&
            (fuzzy(normalized, command.platformHint.apple) ||
              fuzzy(normalized, command.platformHint.other))
          ) {
            return true;
          }
          return command.keywords?.some((keyword) => fuzzy(normalized, keyword)) ?? false;
        });
      },
    }),
    [items],
  );

  function commit(commandId: string) {
    const command = itemById.get(commandId)?.auxiliaryData?.command;
    if (!command || pendingCommandRef.current) return;
    pendingCommandRef.current = command;
    overlayCommands.closePalette();
  }

  return (
    <AstryxLocaleProvider overrides={astryxOverrides}>
      <AstryxCommandPalette
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) overlayCommands.closePalette();
        }}
        searchSource={searchSource}
        label={copy.label}
        width={584}
        maxHeight="min(620px, 68vh)"
        input={<CommandPaletteInput placeholder={copy.placeholder} label={copy.searchLabel} />}
        emptySearchText={
          /* Filter empty (DESIGN.md §10 tier 1): no clear action here — the
             palette input itself is the exit from a no-match search. */
          <EmptyState
            role="presentation"
            className="maka-palette-empty"
            title={copy.emptyTitle}
            isCompact
          />
        }
        emptyBootstrapText={copy.emptyDescription}
        onValueChange={commit}
        renderItem={(item) => {
          const command = item.auxiliaryData?.command;
          if (!command) return item.label;
          return (
            <>
              <span className="maka-palette-icon" aria-hidden="true">
                <command.Icon size={ICON_SIZE.chrome} />
              </span>
              <span className="maka-palette-label">{command.label}</span>
              {command.hint || command.platformHint ? (
                <span className="maka-palette-hint">
                  {command.hint ?? (
                    <PlatformShortcutText
                      apple={command.platformHint!.apple}
                      other={command.platformHint!.other}
                    />
                  )}
                  <ChevronRight size={ICON_SIZE.meta} aria-hidden="true" />
                </span>
              ) : (
                <span className="maka-palette-hint maka-palette-cursor" aria-hidden="true">
                  <CornerDownLeft size={ICON_SIZE.meta} />
                </span>
              )}
            </>
          );
        }}
        footer={
          <CommandPaletteFooter>
            <span className="maka-palette-footer-hint">
              <Kbd keys="up" />
              <Kbd keys="down" />
              <span>{copy.selectHint}</span>
            </span>
            <span className="maka-palette-footer-hint">
              <Kbd keys="enter" />
              <span>{copy.runHint}</span>
            </span>
            <span className="maka-palette-footer-hint">
              <Kbd keys="escape" />
              <span>{copy.closeHint}</span>
            </span>
          </CommandPaletteFooter>
        }
      />
    </AstryxLocaleProvider>
  );
}
