import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { StoredMessage } from '@maka/core';
import { createTurnSizeWarmup } from './turn-size-warmup.js';

export function useChatScroll(input: {
  scrollRef: RefObject<HTMLElement | null>;
  sessionId?: string;
  hasTurns: boolean;
  messages: readonly StoredMessage[];
  target?: { turnId: string; nonce: number };
  behavior?: ScrollBehavior;
  /**
   * #2052: false while the progressive mount is still filling the transcript.
   * The warm-up snapshots the `.maka-turn` NodeList once, so starting it
   * against a partial window would leave every not-yet-mounted turn at its
   * 250px placeholder size for the life of the session.
   */
  warmupReady?: boolean;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);

  // ChatLayout owns steady-state following. A session change is product
  // navigation rather than content growth, so position the shared Astryx
  // scroller at the new transcript's latest turn immediately.
  useEffect(() => {
    const viewport = input.scrollRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [input.sessionId, input.scrollRef]);

  // Withdraw a previous transcript's terminal marker in the same commit that
  // changes the session. ChatLayout owns the DOM ref, so on the first mount its
  // root can still be unavailable to this child layout effect; the passive
  // warm-up effect below publishes `running` once that parent ref is attached.
  useLayoutEffect(() => {
    const root = input.scrollRef.current;
    if (!root) return;
    root.dataset.turnWarmup = 'running';
    return () => { delete root.dataset.turnWarmup; };
  }, [input.sessionId, input.hasTurns, input.scrollRef]);

  // Replace content-visibility placeholders with final-layout remembered
  // sizes. ChatLayout's ResizeObserver follows each height change while its
  // scroll lock is active.
  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root) return;
    root.dataset.turnWarmup = 'running';
    if (!input.hasTurns || input.warmupReady === false) return;
    let disposed = false;
    let cancelWarmup: (() => void) | undefined;
    let pollTimer: number | undefined;
    let settleTimer: number | undefined;
    let settleAttempts = 0;
    const warmOnceSettled = () => {
      if (disposed) return;
      if (root.querySelector('.maka-markdown-pending')) {
        pollTimer = window.setTimeout(warmOnceSettled, 100);
        return;
      }
      cancelWarmup = createTurnSizeWarmup({
        turns: () => root.querySelectorAll<HTMLElement>('.maka-turn'),
        onSettled: () => {
          if (disposed) return;
          root.dataset.turnWarmup = 'settled';
          // Astryx follows each ResizeObserver update while locked. Chromium
          // can leave the final content-visibility release a few sub-pixels
          // short of the exact maximum; finish only when the user is still
          // inside Astryx's own 10px lock threshold, never after they read up.
          const finishPinnedWarmup = () => {
            const distanceFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
            if (distanceFromBottom <= 10) {
              root.scrollTop = root.scrollHeight;
              return;
            }
            settleAttempts += 1;
            if (settleAttempts < 50) {
              settleTimer = window.setTimeout(finishPinnedWarmup, 100);
            }
          };
          settleTimer = window.setTimeout(finishPinnedWarmup, 100);
        },
      });
    };
    const fontsReady: Promise<unknown> =
      typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve();
    void fontsReady.then(warmOnceSettled);
    return () => {
      disposed = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(settleTimer);
      cancelWarmup?.();
    };
  }, [input.sessionId, input.hasTurns, input.warmupReady, input.scrollRef]);

  useEffect(() => {
    const target = input.target;
    if (!target?.turnId) return;
    const frame = window.requestAnimationFrame(() => {
      const root = input.scrollRef.current;
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
      setHighlightedTurnId(target.turnId);
    });
    const clear = window.setTimeout(() => {
      setHighlightedTurnId((current) => (current === target.turnId ? null : current));
    }, 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [input.target?.turnId, input.target?.nonce, input.behavior, input.sessionId, input.messages, input.scrollRef]);

  return {
    highlightedTurnId,
  };
}
