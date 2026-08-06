import { useCallback, useEffect, useState, type RefObject } from 'react';
import { resolveQuoteTarget, type QuoteScopeNode } from './selection-quote-target.js';

/**
 * How long the selection must hold still before the affordance appears.
 * Selecting text usually means "copy this", or is just a reading habit; only a
 * selection the user stops on carries enough intent to earn a floating action.
 * The pause also covers drag-select and shift+arrow, which fire a burst of
 * `selectionchange` events that would otherwise flash the layer mid-gesture.
 */
const SELECTION_SETTLE_MS = 350;

/**
 * A live text selection inside the chat transcript, captured as a quotable
 * excerpt for the "quote this" affordance (Codex/Cursor-style). `anchor` is
 * the selection's current viewport-space anchor point, re-measured while
 * scrolling so it can never describe a position the selection has left.
 */
export interface MessageSelectionQuote {
  text: string;
  /** `data-turn-id` of the turn the selection sits in. */
  turnId: string;
  /**
   * Top-centre of the selection in viewport coordinates, or null while the
   * selection is scrolled out of view. Null means "nothing to point at right
   * now", not "no longer quotable" — the quote survives so that scrolling back
   * restores the affordance.
   */
  anchor: { x: number; y: number } | null;
}

function measureAnchor(): { x: number; y: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const box = selection.getRangeAt(0).getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  return { x: box.left + box.width / 2, y: box.top };
}

function readSelection(root: HTMLElement): Omit<MessageSelectionQuote, 'anchor'> | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const container = selection.getRangeAt(0).commonAncestorContainer as unknown as QuoteScopeNode;
  return resolveQuoteTarget(selection.toString(), container, root as unknown as QuoteScopeNode);
}

/**
 * Watches for a settled text selection inside `scrollRef` (the messages
 * container) and exposes it as a {@link MessageSelectionQuote}. Read-only: the
 * hook never mutates the selection, so native copy still works.
 *
 * The selection is the single source of truth — the quote is derived from it
 * on every relevant event rather than snapshotted, so there is no stale state
 * to expire. `selectionchange` is the only trigger: it is the one event that
 * means the selection actually became something else. Watching key or pointer
 * events instead resurrects a dismissed layer on the next unrelated keystroke,
 * which is why Escape could not close this before.
 *
 * Listeners live on `document` and resolve `scrollRef.current` at event time —
 * binding them to the element instead would capture whatever the ref held on
 * the first effect run, and ChatView's empty state renders a different scroll
 * area before the transcript one exists, so the affordance would stay dead for
 * the rest of the session.
 */
export function useMessageSelectionQuote(
  scrollRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): { quote: MessageSelectionQuote | null; clear: () => void } {
  const [quote, setQuote] = useState<MessageSelectionQuote | null>(null);
  // Dismissal needs no "stay dismissed" flag: `selectionchange` is the only
  // thing that can recompute the quote, and dismissing (Escape, light-dismiss,
  // consuming the action) does not change the selection. Clearing is enough.
  const clear = useCallback(() => setQuote(null), []);

  useEffect(() => {
    if (!enabled) return;

    let settleTimer = 0;

    function settle(): void {
      const root = scrollRef.current;
      if (!root) return;
      const target = readSelection(root);
      const anchor = target ? measureAnchor() : null;
      setQuote(target && anchor ? { ...target, anchor } : null);
    }

    function onSelectionChange(): void {
      // Hide first, re-show only once the selection settles: a layer anchored
      // to the previous selection is wrong the moment that selection changes.
      setQuote(null);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, SELECTION_SETTLE_MS);
    }

    /**
     * Scrolling moves the selection, not the quote. Re-measuring keeps the
     * layer on it; a selection scrolled out of the viewport measures to
     * nothing, so the layer hides until it scrolls back.
     */
    function onScroll(): void {
      setQuote((current) => {
        if (!current) return current;
        const anchor = measureAnchor();
        if (anchor?.x === current.anchor?.x && anchor?.y === current.anchor?.y) return current;
        return { ...current, anchor };
      });
    }

    document.addEventListener('selectionchange', onSelectionChange);
    // Capture-phase: scroll does not bubble.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      window.clearTimeout(settleTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [scrollRef, enabled]);

  return { quote, clear };
}
