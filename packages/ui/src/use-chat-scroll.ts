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

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { createArrivalBottomPin, type ArrivalBottomPin } from './arrival-bottom-pin.js';

export function useChatScroll(input: {
  scrollRef: RefObject<HTMLElement | null>;
  sessionId?: string;
  hasTurns: boolean;
  messages: readonly StoredMessage[];
  target?: { turnId: string; nonce: number };
  behavior: ScrollBehavior;
  hasOlderHistory?: boolean;
  historyLoadPending?: boolean;
  onLoadEarlierHistory?(): Promise<void> | void;
  latestNavigationNonce?: number;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const arrivalPin = useRef<ArrivalBottomPin | null>(null);
  const loadEarlierRef = useRef(input.onLoadEarlierHistory);
  loadEarlierRef.current = input.onLoadEarlierHistory;
  const historyLoadPendingRef = useRef(input.historyLoadPending);
  historyLoadPendingRef.current = input.historyLoadPending;
  const canLoadEarlier = input.onLoadEarlierHistory !== undefined;
  const earlierLoadRequest = useRef<object | null>(null);

  useEffect(() => {
    earlierLoadRequest.current = null;
  }, [input.sessionId]);

  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root || !input.hasOlderHistory || !canLoadEarlier) return;
    let previousScrollTop = root.scrollTop;
    const requestEarlier = (): void => {
      if (historyLoadPendingRef.current || earlierLoadRequest.current) return;
      // Scroll anchoring is suppressed at the very top, so give it something
      // to anchor against before the turns land above the reader.
      if (root.scrollTop === 0) root.scrollTop = 1;
      const request = {};
      earlierLoadRequest.current = request;
      arrivalPin.current?.release();
      void Promise.resolve(loadEarlierRef.current?.()).catch(() => undefined).finally(() => {
        if (earlierLoadRequest.current === request) earlierLoadRequest.current = null;
      });
    };
    const nearStart = (): boolean =>
      root.scrollTop <= Math.max(640, root.clientHeight * 2);
    const onScroll = (): void => {
      const nextScrollTop = root.scrollTop;
      if (nextScrollTop < previousScrollTop && nearStart()) requestEarlier();
      previousScrollTop = nextScrollTop;
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && nearStart()) requestEarlier();
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('wheel', onWheel);
    };
  }, [
    input.hasOlderHistory,
    input.historyLoadPending,
    canLoadEarlier,
    input.scrollRef,
    input.sessionId,
  ]);

  // A session switch is navigation, so its initial virtual tail arrives at the
  // bottom instead of animating there as ordinary content growth.
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
      onStateChange: (state) => { viewport.dataset.arrivalPin = state; },
    });
    arrivalPin.current = pin;
    return () => {
      pin.dispose();
      arrivalPin.current = null;
      delete viewport.dataset.arrivalPin;
    };
  }, [input.sessionId, input.hasTurns, input.scrollRef, input.latestNavigationNonce]);

  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root || !input.hasTurns) return;
    let disposed = false;
    let pollTimer: number | undefined;
    let frame = 0;
    let polls = 0;
    const finishArrival = () => {
      if (disposed) return;
      if (root.querySelector('.maka-markdown-pending') && polls < 50) {
        polls += 1;
        pollTimer = window.setTimeout(finishArrival, 100);
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          if (disposed) return;
          root.dataset.turnWindow = 'ready';
          arrivalPin.current?.release();
        });
      });
    };
    const fontsReady: Promise<unknown> =
      typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve();
    void fontsReady.then(finishArrival);
    return () => {
      disposed = true;
      window.clearTimeout(pollTimer);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      delete root.dataset.turnWindow;
    };
  }, [input.sessionId, input.hasTurns, input.scrollRef, input.latestNavigationNonce]);

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
