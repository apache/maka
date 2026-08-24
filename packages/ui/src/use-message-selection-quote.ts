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

// Capturing an interactive descendant onto its Turn would retarget pointerup
// away from the control and can suppress its click. Control labels are UI, not
// transcript content, so they are not quote-selection gesture owners.
const INTERACTIVE_QUOTE_TARGET = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
].join(',');

// A Markdown CodeBlock owns a native horizontal-scroll gesture. Capturing a
// pointer that starts here onto the enclosing Turn prevents Chromium from
// dragging the scrollbar thumb and from auto-scrolling while text selection
// crosses the viewport edge. Selection changes still reach this hook and can
// produce a quote; only the Turn-level pointer capture is skipped.
const NATIVE_SELECTION_SCROLL_TARGET = '.maka-markdown-code [role="group"]';

export function preservesNativeSelectionScroll(
  target: Element | null,
  turnOwner: Element,
): boolean {
  const scrollOwner = target?.closest(NATIVE_SELECTION_SCROLL_TARGET) ?? null;
  return scrollOwner !== null && turnOwner.contains(scrollOwner);
}

export type SelectionQuoteGestureDisposition = 'commit' | 'cancel';

export interface SelectionQuoteGestureBoundary<Owner> {
  beginPointerSelection(pointerId: number, owner: Owner): boolean;
  selectionChanged(): void;
  finishPointerSelection(pointerId: number, disposition: SelectionQuoteGestureDisposition): Owner | null;
  discardActivePointerSelection(): Owner | null;
}

/**
 * Turns pointer release into the commit boundary for drag selection without
 * making unrelated pointer events another way to resurrect a dismissed quote.
 */
export function createSelectionQuoteGestureBoundary<Owner>(actions: {
  hideAndCancel(): void;
  scheduleSettle(): void;
}): SelectionQuoteGestureBoundary<Owner> {
  let active: { pointerId: number; owner: Owner; changed: boolean } | null = null;

  function finish(
    pointerId: number,
    disposition: SelectionQuoteGestureDisposition,
  ): Owner | null {
    if (!active || pointerId !== active.pointerId) return null;
    const completed = active;
    active = null;
    if (disposition === 'commit' && completed.changed) actions.scheduleSettle();
    if (disposition === 'cancel') actions.hideAndCancel();
    return completed.owner;
  }

  return {
    beginPointerSelection(pointerId, owner) {
      if (active) return false;
      active = { pointerId, owner, changed: false };
      actions.hideAndCancel();
      return true;
    },
    selectionChanged() {
      actions.hideAndCancel();
      if (!active) actions.scheduleSettle();
      else active.changed = true;
    },
    finishPointerSelection(pointerId, disposition) {
      return finish(pointerId, disposition);
    },
    discardActivePointerSelection() {
      if (!active) return null;
      const discarded = active;
      active = null;
      return discarded.owner;
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
 * inside a turn that can own a quote, and that turn captures the pointer so a
 * release outside the Electron window still closes the gesture. Controls
 * elsewhere in the scroll surface (including the quote actions themselves)
 * are not selection gestures.
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

    const gesture = createSelectionQuoteGestureBoundary<Element>({ hideAndCancel, scheduleSettle });

    function finishGesture(
      pointerId: number,
      disposition: SelectionQuoteGestureDisposition,
    ): void {
      const owner = gesture.finishPointerSelection(pointerId, disposition);
      owner?.removeEventListener('lostpointercapture', onLostPointerCapture);
    }

    function onPointerDown(event: PointerEvent): void {
      const root = scrollRef.current;
      const targetNode = event.target instanceof Node ? event.target : null;
      const targetElement =
        targetNode instanceof Element ? targetNode : targetNode?.parentElement ?? null;
      const turnOwner = targetElement?.closest('[data-turn-id]') ?? null;
      const interactiveOwner = targetElement?.closest(INTERACTIVE_QUOTE_TARGET) ?? null;
      if (
        !root ||
        !event.isPrimary ||
        event.button !== 0 ||
        !targetNode ||
        !turnOwner ||
        !root.contains(turnOwner) ||
        (interactiveOwner !== null && turnOwner.contains(interactiveOwner)) ||
        preservesNativeSelectionScroll(targetElement, turnOwner) ||
        findEnclosingTurnId(
          targetNode as unknown as QuoteScopeNode,
          root as unknown as QuoteScopeNode,
        ) === null
      ) {
        return;
      }
      if (!gesture.beginPointerSelection(event.pointerId, turnOwner)) return;
      try {
        // `lostpointercapture` belongs to the element that owns capture. Listen
        // there instead of relying on it crossing the document boundary: in
        // Electron, the owner receives this event even when a document-level
        // capture listener does not. Keeping the listener on the owner also
        // makes the capture lifetime and its cleanup one local responsibility.
        turnOwner.addEventListener('lostpointercapture', onLostPointerCapture);
        turnOwner.setPointerCapture(event.pointerId);
      } catch {
        // Capture can fail if Chromium has already retired the physical
        // pointer. Do not retain a gesture that can no longer deliver its end.
        finishGesture(event.pointerId, 'cancel');
      }
    }

    function onSelectionChange(): void {
      gesture.selectionChanged();
    }

    function onPointerUp(event: PointerEvent): void {
      finishGesture(event.pointerId, 'commit');
    }

    function onPointerCancel(event: PointerEvent): void {
      finishGesture(event.pointerId, 'cancel');
    }

    function onLostPointerCapture(event: Event): void {
      // Capture loss can happen without a physical release (capture transfer,
      // owner removal, or pointer lock), so it cancels rather than commits.
      const pointerId = (event as PointerEvent).pointerId;
      finishGesture(pointerId, 'cancel');
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
    // Capture-phase: scroll does not bubble.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      window.clearTimeout(settleTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('pointerup', onPointerUp, { capture: true });
      document.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      const owner = gesture.discardActivePointerSelection();
      owner?.removeEventListener('lostpointercapture', onLostPointerCapture);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [scrollRef, enabled]);

  return { quote, clear };
}
