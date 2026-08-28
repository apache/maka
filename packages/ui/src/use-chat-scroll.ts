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
  /** Astryx's auto-follow release, for the moves the reader asks for. */
  unlockAutoFollow?(): void;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const unlockAutoFollowRef = useRef(input.unlockAutoFollow);
  unlockAutoFollowRef.current = input.unlockAutoFollow;
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
      unlockAutoFollowRef.current?.();
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

  useEffect(() => {
    const target = input.target;
    if (!target?.turnId) return;
    // Navigating to a turn is the reader choosing a position, so it outranks
    // following the tail.
    unlockAutoFollowRef.current?.();
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
