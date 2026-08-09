import { useCallback, useEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  findEnclosingTurnId,
  resolveQuoteTarget,
  type QuoteScopeNode,
  type QuoteTarget,
} from './selection-quote-target.js';

/**
 * How long the selection must hold still before the affordance appears.
 * Selecting text usually means "copy this", or is just a reading habit; only a
 * selection the user stops on carries enough intent to earn a floating action.
 * The pause also covers drag-select and shift+arrow, which fire a burst of
 * `selectionchange` events that would otherwise flash the layer mid-gesture.
 */
const SELECTION_SETTLE_MS = 350;

export interface SelectionQuoteGestureBoundary {
  beginPointerSelection(pointerId: number): void;
  selectionChanged(): void;
  endPointerSelection(pointerId: number): void;
  cancelPointerSelection(pointerId: number): void;
  cancelActivePointerSelection(): void;
}

/**
 * Turns pointer release into the commit boundary for drag selection without
 * making unrelated pointer events another way to resurrect a dismissed quote.
 */
export function createSelectionQuoteGestureBoundary(actions: {
  hideAndCancel(): void;
  scheduleSettle(): void;
}): SelectionQuoteGestureBoundary {
  let activePointerId: number | undefined;
  let changedDuringPointer = false;

  return {
    beginPointerSelection(pointerId) {
      if (activePointerId !== undefined) return;
      activePointerId = pointerId;
      changedDuringPointer = false;
      actions.hideAndCancel();
    },
    selectionChanged() {
      actions.hideAndCancel();
      if (activePointerId === undefined) actions.scheduleSettle();
      else changedDuringPointer = true;
    },
    endPointerSelection(pointerId) {
      if (pointerId !== activePointerId) return;
      const shouldSettle = changedDuringPointer;
      activePointerId = undefined;
      changedDuringPointer = false;
      if (shouldSettle) actions.scheduleSettle();
    },
    cancelPointerSelection(pointerId) {
      if (pointerId !== activePointerId) return;
      activePointerId = undefined;
      changedDuringPointer = false;
      actions.hideAndCancel();
    },
    cancelActivePointerSelection() {
      if (activePointerId === undefined) return;
      activePointerId = undefined;
      changedDuringPointer = false;
      actions.hideAndCancel();
    },
  };
}

/**
 * A live text selection inside the chat transcript, captured as a quotable
 * excerpt for the "quote this" affordance (Codex/Cursor-style). `anchor` is
 * the selection's current viewport-space anchor point, re-measured while
 * scrolling so it can never describe a position the selection has left.
 */
export interface MessageSelectionQuote extends QuoteTarget {
  /** Top-centre of the selection, in viewport coordinates. */
  anchor: { x: number; y: number };
}

/**
 * The point the layer hangs from, or null when there is nothing to point at.
 *
 * The visibility test is against `root`, not the window: the layer lives in
 * the top layer and is never clipped by the scroller, so a selection scrolled
 * above the transcript would otherwise be pointed at by a bar sitting over the
 * header. An off-screen range still reports a full-size rect — only
 * `display:none` yields a zero one — so being out of view has to be measured,
 * not inferred from the rect collapsing.
 */
function measureAnchor(root: HTMLElement): { x: number; y: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const box = selection.getRangeAt(0).getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const band = root.getBoundingClientRect();
  if (box.top < band.top || box.top > band.bottom) return null;
  return { x: box.left + box.width / 2, y: box.top };
}

function readSelection(root: HTMLElement): QuoteTarget | null {
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
 * to expire. `selectionchange` remains the only event that says the selection
 * became something else. Primary pointer events only gate that signal while a
 * drag is active; they never capture a quote on their own, so an unrelated
 * click cannot resurrect a dismissed layer. The pointer gate starts only
 * inside a turn that can own a quote; controls elsewhere in the scroll surface
 * (including the quote actions themselves) are not selection gestures.
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
  //
  // One acknowledged gap: Escape pressed inside the settle window does not
  // cancel the pending show, because there is no layer yet for it to dismiss.
  // Cancelling would take a keydown listener — the class of listener this hook
  // exists to be rid of — to buy back a 350ms window in which the user has
  // nothing on screen to dismiss.
  const clear = useCallback(() => setQuote(null), []);

  useEffect(() => {
    if (!enabled) return;

    let settleTimer = 0;

    function settle(): void {
      const root = scrollRef.current;
      if (!root) return;
      const target = readSelection(root);
      const anchor = target ? measureAnchor(root) : null;
      setQuote(target && anchor ? { ...target, anchor } : null);
    }

    function hideAndCancel(): void {
      // Hide first, re-show only once the selection settles: a layer anchored
      // to the previous selection is wrong the moment that selection changes.
      // This listener is outside React's event system, so concurrent rendering
      // may otherwise leave the stale layer painted for another frame.
      flushSync(() => setQuote(null));
      window.clearTimeout(settleTimer);
    }

    function scheduleSettle(): void {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, SELECTION_SETTLE_MS);
    }

    const gesture = createSelectionQuoteGestureBoundary({ hideAndCancel, scheduleSettle });

    function onPointerDown(event: PointerEvent): void {
      const root = scrollRef.current;
      if (
        !root ||
        !event.isPrimary ||
        event.button !== 0 ||
        !(event.target instanceof Node) ||
        findEnclosingTurnId(
          event.target as unknown as QuoteScopeNode,
          root as unknown as QuoteScopeNode,
        ) === null
      ) {
        return;
      }
      gesture.beginPointerSelection(event.pointerId);
    }

    function onSelectionChange(): void {
      gesture.selectionChanged();
    }

    function onPointerUp(event: PointerEvent): void {
      gesture.endPointerSelection(event.pointerId);
    }

    function onPointerCancel(event: PointerEvent): void {
      gesture.cancelPointerSelection(event.pointerId);
    }

    function onWindowBlur(): void {
      // Releasing a mouse outside the window need not deliver pointerup back to
      // the document. Do not leave later keyboard selections behind that drag.
      gesture.cancelActivePointerSelection();
    }

    /**
     * Scrolling moves the selection, not the quote, so the layer follows it —
     * up to the edge of the scroller. Past that the anchor is gone and so is
     * the quote: keeping it to restore on the way back cannot work, because
     * hiding the layer runs `onHide`, which clears the quote anyway.
     *
     * Measured before `setQuote` rather than inside the updater: an updater
     * must be pure, and reading layout is not.
     */
    function onScroll(): void {
      const root = scrollRef.current;
      if (!root) return;
      const anchor = measureAnchor(root);
      setQuote((current) => {
        if (!current) return current;
        if (!anchor) return null;
        if (anchor.x === current.anchor.x && anchor.y === current.anchor.y) return current;
        return { ...current, anchor };
      });
    }

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    document.addEventListener('pointerup', onPointerUp, { capture: true });
    document.addEventListener('pointercancel', onPointerCancel, { capture: true });
    window.addEventListener('blur', onWindowBlur);
    // Capture-phase: scroll does not bubble.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      window.clearTimeout(settleTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('pointerup', onPointerUp, { capture: true });
      document.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [scrollRef, enabled]);

  return { quote, clear };
}
