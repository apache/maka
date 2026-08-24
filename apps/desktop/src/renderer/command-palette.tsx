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

// apps/desktop/src/renderer/command-palette.tsx
//
// ⌘K (Ctrl+K off macOS) command palette. Combines static actions (new chat, theme
// switch, open settings, open keyboard help) with the live session list so
// the user can fuzzy-search across both. Astryx owns the dialog, input,
// listbox, keyboard navigation, focus, and dismissal.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ICON_SIZE,
  ChevronRight,
  CornerDownLeft,
} from '@maka/ui/icons';
import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteFooter,
  CommandPaletteInput,
  AstryxLocaleProvider,
  type SearchSource,
  type SearchableItem,
  useUiLocale,
} from '@maka/ui';
import { Kbd } from '@astryxdesign/core/Kbd';
import { useHotkeys } from '@astryxdesign/core/hooks';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import type { Command, CommandKind } from './command-palette-types';
import { getShellCopy } from './locales/shell-copy';
export type { Command } from './command-palette-types';

// `Command` / `CommandKind` types live in `./command-palette-types`
// (extracted so non-JSX consumers can import them under the main
// tsconfig). Re-exported via the explicit `export { ... }` above.

export function useCommandPalette(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);

  // `allowInInputs` because the palette's whole point is being reachable
  // mid-sentence in the composer — the hook skips typing surfaces by default,
  // which would have made ⌘K dead exactly where it is used most.
  useHotkeys([
    {
      keys: 'mod+k',
      allowInInputs: true,
      onPress: () => setOpen((prev) => !prev),
    },
  ]);

  // Stable open/close identities: callers feed these into memoized callback
  // chains (the palette's command pipeline), so fresh closures per render
  // would churn every memo downstream for no state change.
  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  return [open, openPalette, closePalette];
}

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

export function CommandPalette(props: {
  commands: Command[];
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
}) {
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
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const pendingCommandRef = useRef<Command | null>(null);

  useEffect(() => {
    if (props.isOpen) return;
    const command = pendingCommandRef.current;
    pendingCommandRef.current = null;
    if (!command) return;
    const frame = window.requestAnimationFrame(() => {
      void Promise.resolve(command.run()).catch(() => undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.isOpen]);
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
          return command.keywords?.some((keyword) =>
            fuzzy(normalized, keyword),
          ) ?? false;
        });
      },
    }),
    [items],
  );

  function commit(commandId: string) {
    const command = itemById.get(commandId)?.auxiliaryData?.command;
    if (!command || pendingCommandRef.current) return;
    pendingCommandRef.current = command;
    props.onOpenChange(false);
  }

  return (
    <AstryxLocaleProvider overrides={astryxOverrides}>
      <AstryxCommandPalette
        isOpen={props.isOpen}
        onOpenChange={props.onOpenChange}
        searchSource={searchSource}
        label={copy.label}
        width={584}
        maxHeight="min(620px, 68vh)"
        input={(
          <CommandPaletteInput
            placeholder={copy.placeholder}
            label={copy.searchLabel}
          />
        )}
        emptySearchText={(
          /* Filter empty (DESIGN.md §10 tier 1): no clear action here — the
             palette input itself is the exit from a no-match search. */
          <EmptyState
            role="presentation"
            className="maka-palette-empty"
            title={copy.emptyTitle}
            isCompact
          />
        )}
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
              {command.hint ? (
                <span className="maka-palette-hint">
                  {command.hint}
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
        footer={(
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
        )}
      />
    </AstryxLocaleProvider>
  );
}
