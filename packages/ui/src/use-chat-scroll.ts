import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { createArrivalBottomPin, type ArrivalBottomPin } from './arrival-bottom-pin.js';
import { createTurnSizeWarmup } from './turn-size-warmup.js';

export function useChatScroll(input: {
  scrollRef: RefObject<HTMLElement | null>;
  sessionId?: string;
  hasTurns: boolean;
  messages: readonly StoredMessage[];
  target?: { turnId: string; nonce: number };
  behavior: ScrollBehavior;
  /**
   * #2052: false while the progressive mount is still filling the transcript.
   * The warm-up snapshots the `.maka-turn` NodeList once, so starting it
   * against a partial window would leave every not-yet-mounted turn at its
   * 250px placeholder size for the life of the session.
   */
  warmupReady?: boolean;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const arrivalPin = useRef<ArrivalBottomPin | null>(null);

  // ChatLayout owns steady-state following. A session change is product
  // navigation rather than content growth, so the new transcript must be at its
  // latest turn the first time it is painted — and it arrives in pieces (mount
  // window, idle fill chunks, content-visibility warm-up), each of which reads
  // to Astryx as growth to spring after. Writing `scrollTop` once here is not
  // enough: at this point the switched-to transcript is still an empty scroller,
  // and every piece that lands afterwards restarts the flight. The pin consumes
  // those growth steps instantly instead, until the warm-up below reports the
  // geometry settled or the reader takes over; see arrival-bottom-pin.ts.
  //
  // Passive, not a layout effect: ChatLayout re-renders with the switch and
  // hands React a fresh merged callback ref, so its own root ref is detached
  // and not yet reattached while a child's layout effects run — the scroller is
  // reliably reachable only after the commit, which is the same reason the
  // warm-up effect below publishes its marker passively.
  useEffect(() => {
    const viewport = input.scrollRef.current;
    if (!viewport) return;
    // Nothing to arrive: keep the plain positioning this effect has always done
    // for a transcript that is empty (or still loading its first turn), and let
    // the pin install on the commit those turns land in.
    if (!input.hasTurns) {
      viewport.scrollTop = viewport.scrollHeight;
      return;
    }
    const pin = createArrivalBottomPin({
      viewport,
      content: viewport.querySelector('.maka-chat-message-list'),
      // Published the way the warm-up and the progressive fill publish theirs,
      // so a test can wait on the arrival window instead of guessing at timing.
      onStateChange: (state) => { viewport.dataset.arrivalPin = state; },
    });
    arrivalPin.current = pin;
    return () => {
      pin.dispose();
      arrivalPin.current = null;
      delete viewport.dataset.arrivalPin;
    };
  }, [input.sessionId, input.hasTurns, input.scrollRef]);

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
              // Arrival is over: nothing else grows the document on its own, so
              // following goes back to Astryx for streaming and new turns.
              arrivalPin.current?.release();
              return;
            }
            settleAttempts += 1;
            if (settleAttempts < 50) {
              settleTimer = window.setTimeout(finishPinnedWarmup, 100);
              return;
            }
            arrivalPin.current?.release();
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
    // Navigating to a turn is the reader choosing a position, so it outranks an
    // arrival still in flight. (An upward scroll would release the pin on its
    // own a frame later; releasing here keeps the first frame honest too.)
    arrivalPin.current?.release();
    const frame = window.requestAnimationFrame(() => {
      const root = input.scrollRef.current;
      if (!root) return;
      const element = root.querySelector(`[data-turn-id="${CSS.escape(target.turnId)}"]`);
      if (!element || !('scrollIntoView' in element)) return;
      const targetElement = element as HTMLElement;
      targetElement.setAttribute('tabindex', '-1');
      targetElement.scrollIntoView({
        behavior: input.behavior,
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
