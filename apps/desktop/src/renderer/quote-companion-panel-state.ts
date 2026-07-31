import type { QuoteRef } from '@maka/core';

export interface StagedCompanionQuote {
  id: string;
  value: QuoteRef;
}

export interface QuoteCompanionPanelState {
  id: string;
  sourceSessionId: string;
  quotes: StagedCompanionQuote[];
}

/**
 * Immutable ownership token for one accepted send. `panelId` prevents a late
 * callback from an unmounted panel mutating its replacement; `quoteIds` let the
 * current panel remove exactly what that send attached while preserving quotes
 * staged later.
 */
export interface CompanionQuoteSnapshot {
  panelId: string;
  quoteIds: readonly string[];
  quotes: readonly QuoteRef[];
}

export interface CompanionQuoteTarget {
  panelId: string;
  quoteId: string;
}

export function stageCompanionQuote(
  current: QuoteCompanionPanelState | null,
  input: {
    sourceSessionId: string;
    quote: QuoteRef;
    newId: () => string;
  },
): QuoteCompanionPanelState {
  const staged = { id: input.newId(), value: input.quote };
  if (current?.sourceSessionId === input.sourceSessionId) {
    return { ...current, quotes: [...current.quotes, staged] };
  }
  return {
    id: input.newId(),
    sourceSessionId: input.sourceSessionId,
    quotes: [staged],
  };
}

export function snapshotCompanionQuotes(
  panelId: string,
  quotes: readonly StagedCompanionQuote[],
): CompanionQuoteSnapshot {
  return {
    panelId,
    quoteIds: quotes.map((quote) => quote.id),
    quotes: quotes.map((quote) => quote.value),
  };
}

export function consumeCompanionQuoteSnapshot(
  current: QuoteCompanionPanelState | null,
  snapshot: CompanionQuoteSnapshot,
): QuoteCompanionPanelState | null {
  if (!current || current.id !== snapshot.panelId || snapshot.quoteIds.length === 0) {
    return current;
  }
  const consumed = new Set(snapshot.quoteIds);
  const quotes = current.quotes.filter((quote) => !consumed.has(quote.id));
  return quotes.length === current.quotes.length ? current : { ...current, quotes };
}

export function removeStagedCompanionQuote(
  current: QuoteCompanionPanelState | null,
  target: CompanionQuoteTarget,
): QuoteCompanionPanelState | null {
  if (!current || current.id !== target.panelId) return current;
  const quotes = current.quotes.filter((quote) => quote.id !== target.quoteId);
  return quotes.length === current.quotes.length ? current : { ...current, quotes };
}
