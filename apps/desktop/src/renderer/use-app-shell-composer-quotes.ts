import { useState } from 'react';
import type { QuoteRef } from '@maka/core/events';
import {
  appendPending,
  clearPending,
  removePending,
  selectPending,
  type PendingByKey,
} from './app-shell-pending-attachments';

/**
 * Excerpts longer than this are truncated before staging. Kept equal to the
 * `sessions:send` normalizer's per-quote cap so the renderer can never stage
 * something the IPC boundary would reject on send.
 */
const MAX_QUOTE_CHARS = 32_000;

/**
 * Quoted excerpts staged for the next send, keyed by draft key so each session
 * keeps its own (mirrors pending attachments). Cleared once the turn is sent.
 */
export function useAppShellComposerQuotes(options: { draftKey: string }) {
  const [pendingByKey, setPendingByKey] = useState<PendingByKey<QuoteRef>>({});
  const pendingQuotes = selectPending(pendingByKey, options.draftKey);

  function addQuote(input: { text: string; turnId?: string; label?: string }): void {
    const text = input.text.slice(0, MAX_QUOTE_CHARS).trim();
    if (!text) return;
    const ownerKey = options.draftKey;
    const quote: QuoteRef = {
      text,
      ...(input.label ? { label: input.label } : {}),
      ...(input.turnId ? { sourceTurnId: input.turnId } : {}),
    };
    setPendingByKey((map) => appendPending(map, ownerKey, [quote]));
  }

  function removeQuote(index: number): void {
    const ownerKey = options.draftKey;
    setPendingByKey((map) => removePending(map, ownerKey, index));
  }

  function clearQuotes(): void {
    const ownerKey = options.draftKey;
    setPendingByKey((map) => clearPending(map, ownerKey));
  }

  function clearAllQuotes(): void {
    setPendingByKey({});
  }

  return { pendingQuotes, addQuote, removeQuote, clearQuotes, clearAllQuotes };
}
