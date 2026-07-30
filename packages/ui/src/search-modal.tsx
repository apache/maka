import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type { SearchErrorReason, SearchRequest, SearchResult, UiLocale } from '@maka/core';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { Search, X } from './icons.js';
import { EmptyState } from './empty-state.js';
import { DialogHeader } from './primitives/dialog-header.js';
import { InputGroup, InputGroupAddon, InputGroupInput } from './primitives/input-group.js';
import { IconButton } from '@astryxdesign/core';
import { DialogContent, DialogRoot } from './ui.js';
import { useUiLocale } from './locale-context.js';
import { getShellControlsCopy } from './shell-controls-copy.js';

/**
 * PR-SIDEBAR-IA-0 Phase 2 fixup (xuan `91401163` + kenji `6465cf22`,
 * `7c320898`) + Phase 3 P0 fixup (WAWQAQ msg `d53852ac`, xuan
 * `558f1356`, kenji `3ddc91fe`): Search modal SHELL.
 *
 * Renders the real thread-search dialog: local query state,
 * debounced `search:thread` IPC, result list, incognito/error states,
 * and shell-owned navigation. It never writes history and never
 * constructs `maka://session` URIs.
 *
 * Lifecycle contract: SearchModal MUST be conditionally mounted by
 * the parent (`{open && <SearchModal onClose={...} />}`), NOT
 * always-mounted with an `open` prop. The previous pattern
 * (`<SearchModal open=... />` with an internal `if (!open) return
 * null`) sat hooks before a conditional return; while React allows
 * this in principle, in production WAWQAQ hit a React #310 hook
 * order mismatch via the same surface (msg `d53852ac`). Matching
 * `KeyboardHelpModal`'s conditional-mount pattern eliminates the
 * "hooks before early return" class of bug entirely — there's no
 * way for a future hook addition to drift past a stale return
 * statement.
 *
 * #520 PR8: the result list converges onto Base UI Autocomplete
 * (`inline` + `mode="none"` + `autoHighlight="always"` + `filter={null}`).
 * Autocomplete owns the listbox/option ARIA structure and the
 * ArrowUp/Down/Enter/Escape keyboard navigation in activedescendant
 * mode (input keeps focus, the active item is reflected via
 * aria-activedescendant). Server-side IPC filtering is preserved by
 * `filter={null}` + `mode="none"` (Autocomplete does not re-filter
 * the IPC results locally). The previous hand-rolled roving-focus
 * machinery (activeResultIndex / moveActiveResult / jumpActiveResult
 * / keyboardSelectionHandledRef) is gone.
 *
 * Gate per kenji `7c320898`:
 *   - role="dialog" / aria-modal="true" / explicit title.
 *   - Esc and close button close the modal.
 *   - Focus enters the modal on open; returns to the trigger on close.
 *   - Modal calls injected `searchThread` only; it does NOT store
 *     the query, write history, or route via internal URI strings.
 */
/**
 * Dependency-injected search interface. Production wiring binds this to the
 * desktop preload's thread search; tests pass an in-memory fake.
 *
 * The return type matches the IPC envelope exactly: either an array
 * of `SearchResult` (success path) or a `{ ok: false, reason, message }`
 * error envelope. Renderer never throws across the IPC boundary —
 * fail-closed paths return the error envelope and the modal renders
 * them as user-facing copy.
 */
interface SearchModalDeps {
  searchThread(
    request: SearchRequest,
  ): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }>;
}

function searchModalThrownErrorMessage(error: unknown, locale: UiLocale, fallback: string): string {
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}

interface SearchModalCloseOptions {
  restoreFocus?: boolean;
}

export function SearchModal(props: {
  onClose(options?: SearchModalCloseOptions): void;
  /** Seed query for the funnel bridge (palette 查看全部结果 → modal).
   *  Read once on mount; the modal owns the state afterwards. */
  initialQuery?: string;
  /**
   * Navigate to a session (optionally scrolling to a specific turn).
   * Provided by the application shell so the modal stays portable —
   * navigation lives in the shell, not in @maka/ui.
   *
   * Per kenji `2844f64f` SEARCH gate: navigation MUST NOT construct
   * `maka://session/<id>` URIs. The callback receives raw ids; the
   * shell handles routing via existing session-pane state.
   */
  onNavigateToSession?(sessionId: string, turnId?: string): void;
  /**
   * Injected `search:thread` IPC. Production binds to the desktop preload;
   * tests supply a fake.
   *
   * Optional so the modal renders a degraded "search unavailable"
   * state when the renderer cannot bind to the IPC (legacy / smoke
   * fixture / preload not loaded). Without an injected deps the
   * modal does NOT crash.
   */
  deps?: SearchModalDeps;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).search;
  // PR-UX-POLISH-1 commit 5 (kenji `2844f64f` SEARCH gate):
  //   - `query` is local state ONLY (no localStorage / no IPC echo).
  //   - `results` is the most recent successful response; older
  //     responses are discarded by the inflight ticket guard so the
  //     UI never shows stale data behind a newer query.
  //   - `error` carries the IPC error envelope when present. We do
  //     NOT raise it as a JS throw — the modal renders the message
  //     copy and the gate's `incognito_active` / `invalid_query`
  //     reasons trigger specific UI states (privacy banner / empty).
  //   - `pending` reflects whether ANY IPC call is in flight. We do
  //     NOT show a spinner if the query is empty (avoids flashing
  //     loading state during typing).
  const [query, setQuery] = useState(props.initialQuery ?? '');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<{
    reason: SearchErrorReason;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ticketRef = useRef(0);
  const searchMountedRef = useMountedRef();
  const searchThread = props.deps?.searchThread;
  const suppressFocusRestoreRef = useRef(false);

  useEffect(() => {
    return () => {
      ticketRef.current += 1;
    };
  }, []);

  // Debounced search: ~180ms after the user stops typing, send the
  // request. Empty query clears state without an IPC roundtrip.
  useEffect(() => {
    if (!searchThread) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      ticketRef.current += 1;
      setResults([]);
      setError(null);
      setPending(false);
      return;
    }
    const ticket = ++ticketRef.current;
    setPending(true);
    const handle = window.setTimeout(async () => {
      try {
        const response = await searchThread({
          source: 'thread',
          query: trimmed,
          limit: 10,
        });
        if (!searchMountedRef.current) return;
        if (ticket !== ticketRef.current) return; // newer query in flight
        if (Array.isArray(response)) {
          setResults(response);
          setError(null);
        } else {
          setResults([]);
          setError({ reason: response.reason, message: response.message });
        }
      } catch (err) {
        if (!searchMountedRef.current) return;
        if (ticket !== ticketRef.current) return;
        // IPC layer should never throw, but defend anyway. Render as a
        // generic provider_error so the user sees a coherent state.
        setResults([]);
        setError({
          reason: 'provider_error',
          message: searchModalThrownErrorMessage(err, locale, copy.errorFallback),
        });
      } finally {
        if (searchMountedRef.current && ticket === ticketRef.current) setPending(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [copy.errorFallback, locale, query, searchThread]);

  function selectResult(result: SearchResult) {
    if (!props.onNavigateToSession) return;
    if (result.target?.kind !== 'thread') return;
    props.onNavigateToSession(result.target.sessionId, result.target.turnId);
    // Navigating away owns focus now — tell DialogContent.finalFocus to
    // skip its restore so Base UI doesn't yank focus back to the search trigger.
    suppressFocusRestoreRef.current = true;
    props.onClose({ restoreFocus: false });
  }

  function clearSearchState() {
    ticketRef.current += 1;
    setResults([]);
    setError(null);
    setPending(false);
  }

  function updateSearchQuery(nextQuery: string) {
    setQuery(nextQuery);
    if (nextQuery.trim().length === 0) {
      clearSearchState();
    }
  }

  function clearSearchQuery() {
    setQuery('');
    clearSearchState();
    inputRef.current?.focus();
  }

  function keyboardKey(event: KeyboardEvent, keys: string[]) {
    return keys.includes(event.key) || keys.includes(event.code);
  }

  const incognitoBlocked = error?.reason === 'incognito_active';
  const trimmed = query.trim();
  const showResults = !error && trimmed.length > 0 && !pending && results.length > 0;
  const showEmpty = !error && trimmed.length > 0 && !pending && results.length === 0;
  const resultsTruncated = showResults && results.some((result) => result.truncated === true);

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="maka-modal maka-search-modal w-[min(92vw,640px)] p-0"
        data-maka-contract="search-modal"
        aria-labelledby="maka-search-modal-title"
        showClose={false}
        initialFocus={inputRef}
        finalFocus={() => (suppressFocusRestoreRef.current ? false : true)}
      >
        <DialogHeader
          icon={<Search aria-hidden="true" />}
          title={copy.title}
          titleId="maka-search-modal-title"
          onClose={() => props.onClose()}
        />
        {/*
          #520 PR8: Autocomplete owns the listbox/option ARIA + ArrowUp/Down/
          Enter/Escape keyboard nav (activedescendant mode). `inline` keeps the
          list in the modal body (no floating popup). `mode="none"` + `filter={null}`
          preserve server-side IPC filtering — Autocomplete does not re-filter the
          IPC results locally. `autoHighlight="always"` so Enter on the first result
          works without an extra ArrowDown.
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
            // input — never write the result object back into the query.
            if (details.reason === 'item-press') return;
            updateSearchQuery(next);
          }}
          itemToStringValue={(result) => result.title ?? ''}
          items={results}
        >
          <InputGroup className="maka-search-modal-input-row" aria-label={copy.conversationsLabel}>
            <InputGroupAddon>
              <Search size={16} aria-hidden="true" className="maka-search-modal-input-icon" />
            </InputGroupAddon>
            <Autocomplete.Input
              render={
                <InputGroupInput
                  ref={inputRef}
                  type="search"
                  className="maka-search-modal-input"
                  placeholder={copy.placeholder}
                  aria-label={copy.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onKeyDown={(event) => {
                    // Escape with a query clears it; Escape without a query
                    // bubbles to DialogRoot.onOpenChange and closes the modal.
                    // Autocomplete's own Escape handler only fires when the
                    // popup is mounted, which the inline list is not, so there
                    // is no conflict here.
                    if (keyboardKey(event, ['Escape']) && query) {
                      event.preventDefault();
                      clearSearchQuery();
                    }
                  }}
                />
              }
            />
            {query.length > 0 && (
              <InputGroupAddon align="inline-end">
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={copy.clearLabel}
                  icon={<X size={14} aria-hidden="true" />}
                  onClick={clearSearchQuery}
                />
              </InputGroupAddon>
            )}
          </InputGroup>
          <div className="maka-search-modal-body" role="region" aria-label={copy.statusRegionLabel} aria-live="polite">
            {!searchThread && <p className="maka-search-modal-placeholder">{copy.unavailable}</p>}
            {searchThread && incognitoBlocked && (
              <div className="maka-search-modal-state" data-tone="info">
                <p>{copy.privacyTitle}</p>
                <p className="maka-search-modal-state-detail">{copy.privacyDetail}</p>
              </div>
            )}
            {searchThread && !incognitoBlocked && error && (
              <div className="maka-search-modal-state" data-tone="warning">
                <p>{copy.errorTitle}</p>
                <p className="maka-search-modal-state-detail">{error.message}</p>
              </div>
            )}
            {searchThread && !error && trimmed.length === 0 && (
              <EmptyState
                variant="inline"
                title={copy.introduction}
                body=""
                extraClassName="maka-search-modal-placeholder"
              />
            )}
            {searchThread && pending && trimmed.length > 0 && (
              <p className="maka-search-modal-placeholder" aria-live="polite">
                {copy.searching}
              </p>
            )}
            {showEmpty && <p className="maka-search-modal-placeholder">{copy.empty}</p>}
            {showResults && (
              <>
                <div className="maka-search-modal-result-summary" aria-live="polite">
                  <span>{copy.results(results.length)}</span>
                  {resultsTruncated && <span>{copy.truncatedResults(results.length)}</span>}
                </div>
                {/*
                  Autocomplete.List renders a <div role="listbox">; Autocomplete.Item
                  renders a <div role="option">. Autocomplete.Item fires onClick for
                  both pointer click and Enter on the highlighted item, so selectResult
                  covers both paths. aria-activedescendant on the input is managed by
                  Autocomplete — no manual wiring.
                */}
                <Autocomplete.List className="maka-search-modal-results" aria-label={copy.resultsLabel}>
                  {results.map((result, index) => (
                    <Autocomplete.Item
                      key={`${result.target?.kind === 'thread' ? result.target.sessionId : index}-${index}`}
                      value={result}
                      index={index}
                      onClick={() => selectResult(result)}
                      className="maka-search-modal-result"
                      disabled={!props.onNavigateToSession || result.target?.kind !== 'thread'}
                    >
                      <div className="maka-search-modal-result-title">{result.title}</div>
                      {result.summary && <div className="maka-search-modal-result-meta">{result.summary}</div>}
                      {result.snippet && (
                        // Plain text only — IPC already redacts secrets
                        // and the snippet is bounded by SNIPPET_MAX_CODE_POINTS.
                        // No markdown rendering, no <img>, no <a href> —
                        // per kenji SEARCH gate (no path / no URL exposure).
                        <div className="maka-search-modal-result-snippet">
                          {renderSearchSnippet(result.snippet, trimmed)}
                        </div>
                      )}
                    </Autocomplete.Item>
                  ))}
                </Autocomplete.List>
              </>
            )}
          </div>
        </Autocomplete.Root>
      </DialogContent>
    </DialogRoot>
  );
}

function renderSearchSnippet(snippet: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return snippet;
  const haystack = snippet.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = haystack.indexOf(lowerNeedle);
  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(snippet.slice(cursor, matchIndex));
    }
    const end = matchIndex + needle.length;
    parts.push(
      <mark key={`${matchIndex}-${end}`} className="maka-search-modal-snippet-hit">
        {snippet.slice(matchIndex, end)}
      </mark>,
    );
    cursor = end;
    matchIndex = haystack.indexOf(lowerNeedle, cursor);
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor));
  return parts.length > 0 ? parts : snippet;
}
