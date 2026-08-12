import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SearchErrorReason, SearchRequest, SearchResult } from '@maka/core/search';
import type { UiLocale } from '@maka/core/ui-locale';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteFooter,
  CommandPaletteInput,
  type SearchSource,
  type SearchableItem,
} from '@astryxdesign/core';
import { AstryxLocaleProvider } from './astryx-i18n.js';
import { getShellControlsCopy } from './shell-controls-copy.js';
import { useUiLocale } from './locale-context.js';

interface SearchModalDeps {
  searchThread(
    request: SearchRequest,
  ): Promise<
    SearchResult[] | {
      ok: false;
      reason: SearchErrorReason;
      message: string;
    }
  >;
}

interface SearchItemAuxiliaryData {
  result: SearchResult;
}

type SearchItem = SearchableItem<SearchItemAuxiliaryData>;

interface ThreadSearchSourceInput {
  searchThread?: SearchModalDeps['searchThread'];
  canNavigate: boolean;
  resultsLabel: string;
  onQueryChange(query: string): void;
  onErrorChange(
    error: { reason: SearchErrorReason; message: string } | null,
  ): void;
  onItemsChange(items: SearchItem[]): void;
  thrownErrorMessage(error: unknown): string;
}

export function createThreadSearchSource(
  input: ThreadSearchSourceInput,
): SearchSource<SearchItem> {
  let generation = 0;
  return {
    bootstrap: () => [],
    cancel: () => {
      generation += 1;
    },
    search: async (query) => {
      const requestGeneration = ++generation;
      const trimmed = query.trim();
      input.onQueryChange(trimmed);
      if (!trimmed || !input.searchThread) {
        input.onErrorChange(null);
        input.onItemsChange([]);
        return [];
      }
      try {
        const response = await input.searchThread({
          source: 'thread',
          query: trimmed,
          limit: 10,
        });
        if (generation !== requestGeneration) return [];
        if (!Array.isArray(response)) {
          input.onErrorChange({
            reason: response.reason,
            message: response.message,
          });
          input.onItemsChange([]);
          return [];
        }
        input.onErrorChange(null);
        const items = response.flatMap<SearchItem>((result, index) => {
          if (!input.canNavigate || result.target?.kind !== 'thread') {
            return [];
          }
          return [
            {
              id: `${result.target.sessionId}:${result.target.turnId ?? ''}:${index}`,
              label: result.title ?? result.summary ?? input.resultsLabel,
              auxiliaryData: { result },
            },
          ];
        });
        input.onItemsChange(items);
        return items;
      } catch (caught) {
        if (generation !== requestGeneration) return [];
        input.onErrorChange({
          reason: 'provider_error',
          message: input.thrownErrorMessage(caught),
        });
        input.onItemsChange([]);
        return [];
      }
    },
  };
}

function searchModalThrownErrorMessage(
  error: unknown,
  locale: UiLocale,
  fallback: string,
): string {
  return locale === 'zh'
    ? generalizedErrorMessageChinese(error, fallback)
    : generalizedErrorMessage(error, fallback);
}

/**
 * Thread search is an asynchronous result picker. Astryx CommandPalette owns
 * the dialog, search input, listbox, keyboard navigation, focus, and
 * dismissal. Maka only adapts the product search boundary and renders result
 * content.
 */
export function SearchModal(props: {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  onNavigateToSession?(sessionId: string, turnId?: string): void;
  deps?: SearchModalDeps;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).search;
  const astryxOverrides = useMemo(
    () => ({
      '@astryx.commandPalette.list.label': copy.resultsLabel,
    }),
    [copy.resultsLabel],
  );
  const [error, setError] = useState<{
    reason: SearchErrorReason;
    message: string;
  } | null>(null);
  const [activeQuery, setActiveQuery] = useState('');
  const itemByIdRef = useRef(new Map<string, SearchItem>());
  const pendingNavigationRef = useRef<{
    sessionId: string;
    turnId?: string;
  } | null>(null);

  useEffect(() => {
    if (props.isOpen) return;
    const navigation = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    if (!navigation || !props.onNavigateToSession) return;
    const frame = window.requestAnimationFrame(() => {
      props.onNavigateToSession?.(navigation.sessionId, navigation.turnId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.isOpen, props.onNavigateToSession]);

  const searchSource = useMemo<SearchSource<SearchItem>>(
    () =>
      createThreadSearchSource({
        searchThread: props.deps?.searchThread,
        canNavigate: Boolean(props.onNavigateToSession),
        resultsLabel: copy.resultsLabel,
        onQueryChange: setActiveQuery,
        onErrorChange: setError,
        onItemsChange: (items) => {
          itemByIdRef.current = new Map(
            items.map((item) => [item.id, item]),
          );
        },
        thrownErrorMessage: (caught) =>
          searchModalThrownErrorMessage(
            caught,
            locale,
            copy.errorFallback,
          ),
      }),
    [
      copy.errorFallback,
      copy.resultsLabel,
      locale,
      props.deps,
      props.onNavigateToSession,
    ],
  );

  const emptySearchText = error
    ? error.reason === 'incognito_active'
      ? copy.privacyDetail
      : error.message
    : copy.empty;

  return (
    <AstryxLocaleProvider overrides={astryxOverrides}>
      <AstryxCommandPalette
        isOpen={props.isOpen}
        onOpenChange={props.onOpenChange}
        searchSource={searchSource}
        label={copy.title}
        width={560}
        maxHeight="64vh"
        data-maka-contract="search-modal"
        input={(
          <CommandPaletteInput
            placeholder={copy.placeholder}
            label={copy.conversationsLabel}
          />
        )}
        footer={(
          <CommandPaletteFooter>
            {copy.resultsLabel}
          </CommandPaletteFooter>
        )}
        emptyBootstrapText={
          props.deps?.searchThread ? copy.introduction : copy.unavailable
        }
        emptySearchText={emptySearchText}
        onValueChange={(itemId) => {
          const result =
            itemByIdRef.current.get(itemId)?.auxiliaryData?.result;
          if (result?.target?.kind !== 'thread') return;
          pendingNavigationRef.current = {
            sessionId: result.target.sessionId,
            turnId: result.target.turnId,
          };
        }}
        renderItem={(item) => {
          const result = item.auxiliaryData?.result;
          if (!result) return item.label;
          return (
            <div className="maka-search-modal-result">
              <div className="maka-search-modal-result-title">
                {result.title}
              </div>
              {result.summary && (
                <div className="maka-search-modal-result-meta">
                  {result.summary}
                </div>
              )}
              {result.snippet && (
                <div className="maka-search-modal-result-snippet">
                  {renderSearchSnippet(result.snippet, activeQuery)}
                </div>
              )}
            </div>
          );
        }}
      />
    </AstryxLocaleProvider>
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
      <mark
        key={`${matchIndex}-${end}`}
        className="maka-search-modal-snippet-hit"
      >
        {snippet.slice(matchIndex, end)}
      </mark>,
    );
    cursor = end;
    matchIndex = haystack.indexOf(lowerNeedle, cursor);
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor));
  return parts.length > 0 ? parts : snippet;
}
