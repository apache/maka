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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteFooter,
  CommandPaletteInput,
  type SearchSource,
  type SearchableItem,
} from '@astryxdesign/core';
import { AstryxLocaleProvider } from './astryx-i18n.js';
import { lookupCopy } from '@maka/core/ui-locale';
import { getShellControlsCopy } from './shell-controls-copy.js';
import { useUiLocale } from './locale-context.js';

/**
 * One passage recall returned, as the modal renders it.
 *
 * Recall answers with ranked passages that already carry their surrounding
 * exchange, so a result is a piece of a conversation rather than a single
 * line. `sequence` is the anchor's index in its Session transcript, which is
 * what navigation scrolls to.
 */
export interface RecallSearchPassage {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly turnId?: string;
  readonly anchorMessageId: string;
  readonly sequence: number;
  readonly messages: readonly {
    readonly messageId: string;
    readonly role: 'user' | 'assistant' | 'tool';
    readonly matchKind: string;
    readonly text: string;
    readonly timestamp: number;
    readonly isAnchor: boolean;
  }[];
  readonly matchedTerms: readonly string[];
  readonly score: number;
  readonly lastMessageAt?: number;
}

export interface RecallSearchRequest {
  readonly terms: readonly string[];
  readonly limit?: number;
}

export interface RecallSearchOutcome {
  readonly passages: readonly RecallSearchPassage[];
  readonly gaps: string;
  readonly searchedEverySession: boolean;
}

export interface RecallSearchFailure {
  readonly ok: false;
  readonly reason: string;
  readonly message: string;
}

interface SearchModalDeps {
  searchRecall(
    request: RecallSearchRequest,
    requestId?: string,
  ): Promise<RecallSearchOutcome | RecallSearchFailure>;
  cancelRecall?(requestId: string): Promise<void>;
}

interface SearchItemAuxiliaryData {
  passage: RecallSearchPassage;
}

type SearchItem = SearchableItem<SearchItemAuxiliaryData>;

interface RecallSearchSourceInput {
  searchRecall?: SearchModalDeps['searchRecall'];
  cancelRecall?: SearchModalDeps['cancelRecall'];
  canNavigate: boolean;
  resultsLabel: string;
  onQueryChange(query: string): void;
  onErrorChange(error: { reason: string } | null): void;
  onItemsChange(items: SearchItem[]): void;
}

/**
 * Turns a phrase into the literal terms recall matches.
 *
 * Recall matches case-insensitive substrings, OR-combined, and ranks a passage
 * higher when it contains more of them — so a sentence works best as its
 * distinct words rather than as one string. Splitting on whitespace keeps the
 * user's typed phrase intact as a query while giving recall terms it can act
 * on; a single word is passed through unchanged.
 */
export function recallTermsFor(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/u).filter((word) => word.length > 0);
  const unique: string[] = [];
  for (const word of words) {
    if (!unique.includes(word)) unique.push(word);
  }
  return unique.slice(0, 8);
}

export function createRecallSearchSource(
  input: RecallSearchSourceInput,
): SearchSource<SearchItem> {
  let generation = 0;
  let cancelPending: (() => void) | undefined;
  const cancel = () => {
    generation += 1;
    const pending = cancelPending;
    cancelPending = undefined;
    pending?.();
  };
  return {
    bootstrap: () => [],
    cancel,
    search: async (query) => {
      cancel();
      const requestGeneration = generation;
      const trimmed = query.trim();
      input.onQueryChange(trimmed);
      const terms = recallTermsFor(trimmed);
      if (terms.length === 0 || !input.searchRecall) {
        input.onErrorChange(null);
        input.onItemsChange([]);
        return [];
      }
      const requestId = crypto.randomUUID();
      const cancelled = new Promise<undefined>((resolve) => {
        cancelPending = () => {
          // React's palette transition must finish even if the Host is slow
          // or disconnected. Ignoring its eventual result alone leaves it busy.
          resolve(undefined);
          void input.cancelRecall?.(requestId).catch((error) => {
            console.error('[search] cancellation failed', error);
          });
        };
      });
      try {
        const response = await Promise.race([
          input.searchRecall({ terms, limit: 10 }, requestId),
          cancelled,
        ]);
        if (generation !== requestGeneration || response === undefined) return [];
        if (!Array.isArray((response as RecallSearchOutcome).passages)) {
          console.error('[search] recall search failed', response);
          input.onErrorChange({ reason: (response as RecallSearchFailure).reason });
          input.onItemsChange([]);
          return [];
        }
        input.onErrorChange(null);
        const items = (response as RecallSearchOutcome).passages.flatMap<SearchItem>(
          (passage, index) => {
            if (!input.canNavigate) return [];
            return [
              {
                // Two Hosts can name the same Session id, so the index and the
                // anchor id are part of the identity, not decoration.
                id: `${passage.sessionId}:${passage.anchorMessageId}:${index}`,
                label: passage.sessionTitle || input.resultsLabel,
                auxiliaryData: { passage },
              },
            ];
          },
        );
        input.onItemsChange(items);
        return items;
      } catch (caught) {
        if (generation !== requestGeneration) return [];
        console.error('[search] recall search failed', caught);
        input.onErrorChange({ reason: 'provider_error' });
        input.onItemsChange([]);
        return [];
      } finally {
        if (generation === requestGeneration) cancelPending = undefined;
      }
    },
  };
}

export function searchErrorText(
  reason: string,
  copy: ReturnType<typeof getShellControlsCopy>['search'],
): string {
  return lookupCopy(copy.errorByReason, reason) ?? copy.errorFallback;
}

/**
 * A passage's anchor text, used as the result's snippet. The anchor is the
 * message recall matched on, so it is the line that explains the hit; falling
 * back to the first non-empty message keeps a file-only anchor visible.
 */
export function passageSnippet(passage: RecallSearchPassage): string {
  const anchor = passage.messages.find((message) => message.isAnchor);
  if (anchor && anchor.text.trim().length > 0) return anchor.text;
  for (const message of passage.messages) {
    if (message.text.trim().length > 0) return message.text;
  }
  return '';
}

/**
 * Recall search is an asynchronous result picker. Astryx CommandPalette owns
 * the dialog, search input, listbox, keyboard navigation, focus, and
 * dismissal. Maka only adapts the product search boundary and renders result
 * content.
 */
export function SearchModal(props: {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  onNavigateToSession?(sessionId: string, turnId?: string, sequence?: number): void;
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
  const [error, setError] = useState<{ reason: string } | null>(null);
  const [activeQuery, setActiveQuery] = useState('');
  const itemByIdRef = useRef(new Map<string, SearchItem>());
  const pendingNavigationRef = useRef<{
    sessionId: string;
    turnId?: string;
    sequence?: number;
  } | null>(null);

  useEffect(() => {
    if (props.isOpen) return;
    const navigation = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    if (!navigation || !props.onNavigateToSession) return;
    const frame = window.requestAnimationFrame(() => {
      props.onNavigateToSession?.(
        navigation.sessionId,
        navigation.turnId,
        navigation.sequence,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.isOpen, props.onNavigateToSession]);

  const searchSource = useMemo<SearchSource<SearchItem>>(
    () =>
      createRecallSearchSource({
        searchRecall: props.deps?.searchRecall,
        cancelRecall: props.deps?.cancelRecall,
        canNavigate: Boolean(props.onNavigateToSession),
        resultsLabel: copy.resultsLabel,
        onQueryChange: setActiveQuery,
        onErrorChange: setError,
        onItemsChange: (items) => {
          itemByIdRef.current = new Map(
            items.map((item) => [item.id, item]),
          );
        },
      }),
    [copy.resultsLabel, props.deps, props.onNavigateToSession],
  );

  useEffect(() => {
    if (!props.isOpen) searchSource.cancel?.();
    return () => searchSource.cancel?.();
  }, [props.isOpen, searchSource]);

  const emptySearchText = error
    ? searchErrorText(error.reason, copy)
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
        input={
          <CommandPaletteInput
            placeholder={copy.placeholder}
            label={copy.conversationsLabel}
          />
        }
        footer={
          <CommandPaletteFooter>
            {copy.resultsLabel}
          </CommandPaletteFooter>
        }
        emptyBootstrapText={
          props.deps?.searchRecall ? copy.introduction : copy.unavailable
        }
        emptySearchText={emptySearchText}
        onValueChange={(itemId) => {
          const passage =
            itemByIdRef.current.get(itemId)?.auxiliaryData?.passage;
          if (!passage) return;
          pendingNavigationRef.current = {
            sessionId: passage.sessionId,
            ...(passage.turnId ? { turnId: passage.turnId } : {}),
            sequence: passage.sequence,
          };
        }}
        renderItem={(item) => {
          const passage = item.auxiliaryData?.passage;
          if (!passage) return item.label;
          const snippet = passageSnippet(passage);
          return (
            <div className="maka-search-modal-result">
              <div className="maka-search-modal-result-title">
                {passage.sessionTitle || item.label}
              </div>
              <div className="maka-search-modal-result-meta">
                {passage.messages.find((message) => message.isAnchor)?.matchKind ??
                  ''}
              </div>
              {snippet && (
                <div className="maka-search-modal-result-snippet">
                  {renderSearchSnippet(snippet, activeQuery)}
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
