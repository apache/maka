import { useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  SearchErrorReason,
  SearchRequest,
  SearchResult,
  UiLocale,
} from '@maka/core';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
} from '@maka/core';
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
  onClose(): void;
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

  const searchSource = useMemo<SearchSource<SearchItem>>(
    () => ({
      bootstrap: () => [],
      search: async (query) => {
        const trimmed = query.trim();
        setActiveQuery(trimmed);
        itemByIdRef.current = new Map();
        if (!trimmed || !props.deps?.searchThread) {
          setError(null);
          return [];
        }
        try {
          const response = await props.deps.searchThread({
            source: 'thread',
            query: trimmed,
            limit: 10,
          });
          if (!Array.isArray(response)) {
            setError({
              reason: response.reason,
              message: response.message,
            });
            return [];
          }
          setError(null);
          const items = response.flatMap<SearchItem>((result, index) => {
            if (
              !props.onNavigateToSession ||
              result.target?.kind !== 'thread'
            ) {
              return [];
            }
            const item: SearchItem = {
              id: `${result.target.sessionId}:${result.target.turnId ?? ''}:${index}`,
              label: result.title ?? result.summary ?? copy.resultsLabel,
              auxiliaryData: { result },
            };
            return [item];
          });
          itemByIdRef.current = new Map(
            items.map((item) => [item.id, item]),
          );
          return items;
        } catch (caught) {
          setError({
            reason: 'provider_error',
            message: searchModalThrownErrorMessage(
              caught,
              locale,
              copy.errorFallback,
            ),
          });
          return [];
        }
      },
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
        isOpen
        onOpenChange={(isOpen) => {
          if (!isOpen) props.onClose();
        }}
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
          props.onNavigateToSession?.(
            result.target.sessionId,
            result.target.turnId,
          );
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
