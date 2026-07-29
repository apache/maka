import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StoredMessage } from '@maka/core';
import { createPinnedBottomFollower } from './pinned-bottom.js';
import { createTurnSizeWarmup } from './turn-size-warmup.js';

const SCROLL_BOTTOM_THRESHOLD = 64;

export function useChatScroll(input: {
  sessionId?: string;
  hasTurns: boolean;
  messages: readonly StoredMessage[];
  target?: { turnId: string; nonce: number };
  behavior?: ScrollBehavior;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const pinnedToBottomRef = useRef(true);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);

  // A session owns one transcript DOM. Reset its initial position to latest.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    setPinnedToBottom(true);
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [input.sessionId]);

  // Follow the content's actual layout clock. Smooth streaming reveals text on
  // later RAF frames, so a state-driven scroll effect runs too early.
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = viewport?.querySelector(':scope > [data-overlayscrollbars-content]');
    if (!viewport || !content) return;
    return createPinnedBottomFollower({
      viewport,
      content,
      isPinned: () => pinnedToBottomRef.current,
    });
  }, [input.sessionId]);

  // Replace content-visibility placeholders with final-layout remembered sizes.
  // ChatView itself unmounts outside sessions, so every rebuilt transcript gets
  // a fresh hook lifecycle without depending on navigation state.
  //
  // A LAYOUT effect, only for the sake of the marker below. The scroller can
  // outlive a transcript — switching sessions empties `messages` and refills it
  // asynchronously on the same element — so `settled` has to be withdrawn in
  // the same commit that puts a different transcript on screen. A passive
  // effect withdraws it one paint too late, leaving a window in which the
  // marker vouches for geometry that has already been replaced. The body
  // itself only writes an attribute and schedules async work.
  useLayoutEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    // Publish the walk's phase on the scroller. Until the markdown pipeline
    // has landed and the warm-up has walked the turns it started with, this
    // scroller's geometry is still a placeholder-scale estimate, and nothing
    // outside can tell that apart from a pause between chunks. `settled` is
    // therefore about the transcript the walk was handed, not about turns that
    // stream in after it — those arrive already rendered.
    //
    // Claimed before the `hasTurns` bail and dropped on teardown, so the only
    // states this element can be observed in are `running`, a `settled` that
    // belongs to the transcript currently mounted, and absent.
    root.dataset.turnWarmup = 'running';
    const forget = () => { delete root.dataset.turnWarmup; };
    if (!input.hasTurns) return forget;
    let disposed = false;
    let cancelWarmup: (() => void) | undefined;
    let pollTimer: number | undefined;
    const warmOnceSettled = () => {
      if (disposed) return;
      if (root.querySelector('.maka-markdown-pending')) {
        pollTimer = window.setTimeout(warmOnceSettled, 100);
        return;
      }
      cancelWarmup = createTurnSizeWarmup({
        turns: () => root.querySelectorAll<HTMLElement>('.maka-turn'),
        onSettled: () => {
          if (!disposed) root.dataset.turnWarmup = 'settled';
        },
      });
    };
    const fontsReady: Promise<unknown> =
      typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve();
    void fontsReady.then(warmOnceSettled);
    return () => {
      disposed = true;
      forget();
      window.clearTimeout(pollTimer);
      cancelWarmup?.();
    };
  }, [input.sessionId, input.hasTurns]);

  useEffect(() => {
    const target = input.target;
    if (!target?.turnId) return;
    const frame = window.requestAnimationFrame(() => {
      const root = viewportRef.current;
      if (!root) return;
      const element = root.querySelector(`[data-turn-id="${CSS.escape(target.turnId)}"]`);
      if (!element || !('scrollIntoView' in element)) return;
      const targetElement = element as HTMLElement;
      targetElement.setAttribute('tabindex', '-1');
      targetElement.scrollIntoView({
        behavior: input.behavior ?? 'smooth',
        block: 'center',
      });
      targetElement.focus({ preventScroll: true });
      pinnedToBottomRef.current = false;
      setPinnedToBottom(false);
      setHighlightedTurnId(target.turnId);
    });
    const clear = window.setTimeout(() => {
      setHighlightedTurnId((current) => (current === target.turnId ? null : current));
    }, 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [input.target?.turnId, input.target?.nonce, input.behavior, input.sessionId, input.messages]);

  function onScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const pinned = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD;
    pinnedToBottomRef.current = pinned;
    setPinnedToBottom(pinned);
  }

  function scrollToBottom() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: input.behavior ?? 'smooth' });
    pinnedToBottomRef.current = true;
    setPinnedToBottom(true);
  }

  return {
    highlightedTurnId,
    onScroll,
    pinnedToBottom,
    scrollToBottom,
    viewportRef,
  };
}
