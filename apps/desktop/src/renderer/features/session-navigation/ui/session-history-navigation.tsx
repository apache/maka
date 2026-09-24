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

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight } from '@maka/ui/icons';
import type { SessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { createSessionVisitHistory } from '../model/session-visit-history.js';
import { createSessionSwipe, type SessionSwipeFeedback } from '../model/session-swipe.js';

export interface SessionHistoryNavigationProps {
  catalog: SessionCatalogController;
  /** Only the session destination participates; settings and WorkHub do not. */
  visible: boolean;
  blocked: boolean;
  openSession(sessionId: string): void;
}

interface SwipeIndicator extends SessionSwipeFeedback {
  phase: 'pulling' | 'committed' | 'unavailable' | 'returning';
  edge: number;
  top: number;
}

/** Local feedback updates do not re-render the shell. */
export function SessionHistoryNavigation(props: SessionHistoryNavigationProps) {
  const current = useRef(props);
  const history = useRef(createSessionVisitHistory());
  const gesture = useRef(createSessionSwipe());
  const [indicator, setIndicator] = useState<SwipeIndicator | null>(null);

  useLayoutEffect(() => {
    current.current = props;
    if (props.visible) history.current.visit(props.catalog.getState().activeSessionId);
  });

  useLayoutEffect(() => {
    const observe = () => {
      const state = props.catalog.getState();
      history.current.forget(state.removedIds);
      if (current.current.visible && !state.removedIds.has(state.activeSessionId ?? '')) {
        history.current.visit(state.activeSessionId);
      }
    };
    observe();
    return props.catalog.subscribe(observe);
  }, [props.catalog]);

  useLayoutEffect(() => {
    const swipe = gesture.current;
    setIndicator(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      setIndicator((value) => value && { ...value, phase: 'returning' });
      timer = setTimeout(() => setIndicator(null), 180);
    };
    const cancel = () => {
      swipe.cancel();
      clearTimeout(timer);
      setIndicator(null);
    };
    const onWheel = (event: WheelEvent) => {
      const { catalog, visible, blocked, openSession } = current.current;
      const state = catalog.getState();
      const eligible = visible && !blocked && Boolean(state.activeSessionId)
        && !event.defaultPrevented && event.cancelable && event.deltaMode === 0
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && isSessionHistorySwipeTarget(event);
      const result = swipe.sample({
        deltaX: event.deltaX, deltaY: event.deltaY, timeStamp: event.timeStamp, eligible,
      });
      if (result.claimed) event.preventDefault();
      const feedback = swipe.feedback();
      if (!feedback) {
        clearTimeout(timer);
        setIndicator(null);
        return;
      }
      if (feedback.committed && result.direction === null) return;
      const available = (id: string) => catalog.getState().sessions.some((session) => session.id === id && session.localState !== 'pending');
      const canMove = history.current.peek(feedback.direction, available) !== undefined;
      let moved = false;
      if (result.direction !== null) moved = history.current.move(result.direction, available,
        (id) => {
          openSession(id);
          return catalog.getState().activeSessionId === id;
        });
      const surface = event.composedPath().find((target): target is Element =>
        target instanceof Element && target.hasAttribute('data-session-history-surface'));
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      setIndicator({ ...feedback, phase: moved ? 'committed' : (!canMove || feedback.committed) ? 'unavailable' : 'pulling',
        edge: feedback.direction === -1 ? rect.left : rect.right, top: rect.top + rect.height / 2 });
      clearTimeout(timer);
      timer = setTimeout(release, 250);
    };
    document.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', cancel);
      clearTimeout(timer);
      swipe.cancel();
    };
  }, [props.visible, props.blocked]);
  if (!indicator || !props.visible || props.blocked) return null;
  const Arrow = indicator.direction === -1 ? ArrowLeft : ArrowRight;
  return createPortal(<div
    className="session-history-swipe"
    aria-hidden="true"
    data-phase={indicator.phase}
    data-progress={indicator.progress}
    data-direction={indicator.direction}
    style={{ left: indicator.edge, top: indicator.top,
      '--swipe-inward': -indicator.direction,
      '--swipe-progress': indicator.progress,
    } as CSSProperties}
  >
    <svg className="session-history-swipe-ring" viewBox="0 0 44 44" fill="none">
      <circle cx="22" cy="22" r="19" pathLength="1" stroke="currentColor" strokeWidth="2" />
    </svg>
    <Arrow size={20} strokeWidth={2} />
  </div>, document.body);
}

/** Horizontal content keeps its entire gesture, even at either scroll edge. */
export function isSessionHistorySwipeTarget(event: Pick<WheelEvent, 'composedPath'>): boolean {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue;
    if (target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"], [data-session-history-ignore]')) return false;
    const style = getComputedStyle(target);
    if (/^(auto|scroll)$/.test(style.overflowX) && target.scrollWidth > target.clientWidth + 1) return false;
    if (target.hasAttribute('data-session-history-surface')) return true;
  }
  return false;
}
