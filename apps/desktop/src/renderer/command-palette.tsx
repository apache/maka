// apps/desktop/src/renderer/command-palette.tsx
//
// ⌘K / Ctrl+K command palette. Combines static actions (new chat, theme
// switch, open settings, open keyboard help) with the live session list so
// the user can fuzzy-search across both. Renders as a Base UI Dialog modal;
// Arrow/Enter/Esc navigation is local to the input, focus trap + restore +
// Esc-dismiss come from DialogRoot/DialogContent (#520 PR7).

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  CornerDownLeft,
  Search,
  X,
} from '@maka/ui/icons';
import {
  DialogContent,
  DialogRoot,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Kbd,
  KbdGroup,
  useUiLocale,
} from '@maka/ui';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { useThreadSearch } from './use-thread-search';
import { buildContentSearchCommands } from './command-palette-content-search';
import type { Command, CommandKind } from './command-palette-types';
import type { UseThreadSearchDeps } from './use-thread-search';
import { getShellCopy } from './locales/shell-copy';
export type { Command, CommandKind } from './command-palette-types';
export { buildContentSearchCommands } from './command-palette-content-search';
export { buildCommandList, buildSessionCommands } from './command-palette-commands';

// `Command` / `CommandKind` types live in `./command-palette-types`
// (extracted so non-JSX consumers can import them under the main
// tsconfig). Re-exported via the explicit `export { ... }` above.

export function useCommandPalette(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      event.preventDefault();
      setOpen((prev) => !prev);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
  onClose(): void;
  /**
   * Navigate to a session. Called when the user activates a content-
   * search hit so the palette can jump to the matched session and,
   * when the backend supplied one, scroll to the matched turn.
   */
  onSelectSession?: (sessionId: string, turnId?: string) => void;
  /** Funnel bridge: hands the current query to the search modal (the
   *  browse surface over the same thread-search backend). */
  onOpenSearchModal?: (query: string) => void;
  threadSearchDeps?: UseThreadSearchDeps;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).commandPalette;
  const inputRef = useRef<HTMLInputElement>(null);
  const commitPendingRef = useRef(false);
  const [query, setQuery] = useState('');
  const [committedCommandId, setCommittedCommandId] = useState<string | null>(null);

  // Focus + select the search input as soon as the dialog mounts.
  // DialogContent.initialFocus points Base UI at the input for the focus
  // trap; this useEffect adds the select-all so the first keystroke
  // replaces the previous query.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // PR-SEARCH-2.6: content-search hits from local thread store. The
  // hook handles debounce, ticket-based race control, and unmount
  // safety. Query body never enters telemetry or local history.
  const threadSearch = useThreadSearch(query, props.threadSearchDeps);

  // Keystrokes stay urgent; list filtering renders at deferred priority
  // (vercel rerender-use-deferred-value) so fast typing in the palette
  // never waits on the filter + content-command list re-render.
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => {
    const q = deferredQuery.trim();
    if (!q) return props.commands;
    return props.commands.filter((cmd) => {
      if (fuzzy(q, cmd.label)) return true;
      if (cmd.hint && fuzzy(q, cmd.hint)) return true;
      if (cmd.keywords && cmd.keywords.some((kw) => fuzzy(q, kw))) return true;
      return false;
    });
  }, [props.commands, deferredQuery]);

  // Build content-search commands from the hook state. These are
  // merged into the palette's command list after the existing
  // fuzzy-matched commands so the user sees actions / settings /
  // sessions first, then matched content. Single empty / blocked /
  // error tile per state.
  const contentCommands = useMemo(() => {
    return buildContentSearchCommands(threadSearch.state, props.onSelectSession, props.onOpenSearchModal, locale);
  }, [threadSearch.state, props.onSelectSession, props.onOpenSearchModal, locale]);

  // Combine. Filtered commands keep their existing order; content
  // commands always sit at the end so they don't disrupt muscle
  // memory for cmd-K + first-letter navigation.
  const combined = useMemo(() => [...filtered, ...contentCommands], [filtered, contentCommands]);

  const grouped = useMemo(() => groupCommands(combined), [combined]);

  function commit(cmd: Command | undefined) {
    if (!cmd) return;
    if (commitPendingRef.current) return;
    // xuan `fd675604`: disabled commands are inert. We MUST NOT fire
    // their `run()` and MUST NOT close the palette — that would make
    // a status tile (blocked / loading / error / empty) look like a
    // user action.
    if (cmd.disabled) return;
    commitPendingRef.current = true;
    setCommittedCommandId(cmd.id);
    void (async () => {
      try {
        await cmd.run();
      } finally {
        props.onClose();
      }
    })().catch(() => undefined);
  }

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="maka-palette-modal"
        width={584}
        maxHeight="min(620px, 68vh)"
        aria-label={copy.label}
        initialFocus={inputRef}
      >
        {/*
          #520 PR8: Autocomplete owns the listbox/option ARIA + ArrowUp/Down/
          Enter/Escape keyboard nav (activedescendant mode). `inline` keeps the
          list in the modal body. `mode="none"` + `filter={null}` preserve the
          palette's own fuzzy + content-search filtering — Autocomplete does not
          re-filter the combined list locally. `autoHighlight="always"` so Enter
          on the first command works without an extra ArrowDown.
        */}
        <Autocomplete.Root
          inline
          open
          mode="none"
          autoHighlight="always"
          keepHighlight
          filter={null}
          value={query}
          onValueChange={(next, details) => {
            // item-press (click / Enter on highlighted) is a selection, not
            // input — never write the command object back into the query.
            if (details.reason === 'item-press') return;
            setQuery(next);
          }}
          itemToStringValue={(cmd) => cmd.label}
          items={combined}
        >
          <div className="maka-palette-header">
            <InputGroup
              className="maka-palette-input-wrap"
              aria-label={copy.searchLabel}
              onMouseDown={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest('input')) return;
                event.preventDefault();
                inputRef.current?.focus();
              }}
            >
              <InputGroupAddon align="inline-start" className="maka-palette-search-icon" aria-hidden="true">
                <Search />
              </InputGroupAddon>
              <Autocomplete.Input
                render={
                  <InputGroupInput
                    ref={inputRef}
                    className="maka-palette-input"
                    type="text"
                    placeholder={copy.placeholder}
                    aria-label={copy.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                  />
                }
              />
            </InputGroup>
            <IconButton
              variant="ghost"
              size="sm"
              icon={<X aria-hidden="true" />}
              label={copy.closeLabel}
              onClick={props.onClose}
            />
          </div>
          <Autocomplete.List className="maka-palette-list" id="maka-palette-list" aria-label={copy.resultsLabel}>
            {grouped.length === 0 ? (
              <Empty className="maka-palette-empty py-8 md:py-10 gap-3">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>{copy.emptyTitle}</EmptyTitle>
                  <EmptyDescription>{copy.emptyDescription}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              grouped.map((group) => (
                <Autocomplete.Group key={group.label} className="maka-palette-group">
                  <Autocomplete.GroupLabel className="maka-palette-group-label">
                    {group.label}
                  </Autocomplete.GroupLabel>
                  {group.items.map((entry) => {
                    const cmd = entry.command;
                    const commandCommitPending = committedCommandId === cmd.id;
                    return (
                      <Autocomplete.Item
                        key={cmd.id}
                        value={cmd}
                        index={entry.index}
                        onClick={() => commit(cmd)}
                        disabled={cmd.disabled}
                        aria-busy={commandCommitPending ? 'true' : undefined}
                        data-disabled={cmd.disabled ? 'true' : undefined}
                        data-pending={commandCommitPending ? 'true' : undefined}
                        className="maka-palette-item"
                      >
                        <span className="maka-palette-icon" aria-hidden="true">
                          <cmd.Icon size={15} />
                        </span>
                        <span className="maka-palette-label">{cmd.label}</span>
                        {cmd.hint && (
                          <span className="maka-palette-hint">
                            {cmd.hint}
                            <ChevronRight size={12} aria-hidden="true" />
                          </span>
                        )}
                        {!cmd.hint && (
                          <span className="maka-palette-hint maka-palette-cursor" aria-hidden="true">
                            <CornerDownLeft size={12} />
                          </span>
                        )}
                      </Autocomplete.Item>
                    );
                  })}
                </Autocomplete.Group>
              ))
            )}
          </Autocomplete.List>
        </Autocomplete.Root>
        <div className="maka-palette-footer">
          <span className="maka-palette-footer-hint">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
            <span>{copy.selectHint}</span>
          </span>
          <span className="maka-palette-footer-hint">
            <Kbd>↵</Kbd>
            <span>{copy.runHint}</span>
          </span>
          <span className="maka-palette-footer-hint">
            <Kbd>Esc</Kbd>
            <span>{copy.closeHint}</span>
          </span>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function groupCommands(commands: Command[]): Array<{ label: string; items: Array<{ command: Command; index: number }> }> {
  const order: string[] = [];
  const map = new Map<string, Array<{ command: Command; index: number }>>();
  commands.forEach((command, index) => {
    if (!map.has(command.group)) {
      map.set(command.group, []);
      order.push(command.group);
    }
    map.get(command.group)!.push({ command, index });
  });
  return order.map((label) => ({ label, items: map.get(label)! }));
}

// `buildContentSearchCommands` moved to
// `./command-palette-content-search` so it can be unit-tested without
// JSX compilation. Re-exported via the explicit `export { ... }` at
// the top of this file.
