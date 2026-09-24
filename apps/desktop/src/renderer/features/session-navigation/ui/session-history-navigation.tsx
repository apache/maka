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
  motion: ReturnType<ReturnType<typeof createSessionSwipe>['motion']>;
}

/** Local feedback updates do not re-render the shell. */
export function SessionHistoryNavigation(props: SessionHistoryNavigationProps) {
  const current = useRef(props);
  const history = useRef(createSessionVisitHistory());
  const gesture = useRef(createSessionSwipe());
  const [indicator, setIndicator] = useState<SwipeIndicator | null>(null);

  // Both catalog notifications and visibility/render reconciliation enter
  // here, so a removed-but-still-selected Session can never become a visit.
  const observe = () => {
    const { catalog, visible } = current.current;
    const state = catalog.getState();
    history.current.forget(state.removedIds);
    if (visible && !state.removedIds.has(state.activeSessionId ?? '')) {
      history.current.visit(state.activeSessionId);
    }
  };

  useLayoutEffect(() => {
    current.current = props;
    observe();
  });

  useLayoutEffect(() => props.catalog.subscribe(observe), [props.catalog]);

  useLayoutEffect(() => {
    const swipe = gesture.current;
    setIndicator(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSettlement = () => {
      clearTimeout(timer);
      const delay = swipe.settleAfter();
      if (delay === null) return;
      timer = setTimeout(() => {
        const phase = swipe.settle();
        setIndicator((value) => phase && value ? { ...value, phase } : null);
        scheduleSettlement();
      }, delay);
    };
    const cancel = () => {
      swipe.cancel();
      clearTimeout(timer);
      setIndicator(null);
    };
    const onWheel = (event: WheelEvent) => {
      const { catalog, visible, blocked, openSession } = current.current;
      const state = catalog.getState();
      const surface = resolveSwipeSurface(event);
      const eligible = visible && !blocked && Boolean(state.activeSessionId)
        && !event.defaultPrevented && event.deltaMode === 0
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && (surface === 'loading' ? null : Boolean(surface));
      const result = swipe.sample({
        deltaX: event.deltaX, deltaY: event.deltaY, timeStamp: event.timeStamp, eligible,
      });
      // Chromium may make only the first frame cancelable. That flag governs
      // preventDefault, not whether subsequent displacement belongs to a swipe.
      if (result.claimed && event.cancelable) event.preventDefault();
      const feedback = swipe.feedback();
      if (!feedback) {
        clearTimeout(timer);
        setIndicator(null);
        return;
      }
      if (feedback.committed && result.direction === null) {
        scheduleSettlement();
        return;
      }
      const available = (id: string) => catalog.getState().sessions.some((session) => session.id === id && session.localState !== 'pending');
      const canMove = history.current.peek(feedback.direction, available) !== undefined;
      let moved = false;
      if (result.direction !== null) moved = history.current.move(result.direction, available,
        (id) => {
          openSession(id);
          return catalog.getState().activeSessionId === id;
        });
      if (!surface || surface === 'loading') return;
      const rect = surface.getBoundingClientRect();
      setIndicator({ ...feedback, motion: swipe.motion(), phase: moved ? 'committed' : (!canMove || feedback.committed) ? 'unavailable' : 'pulling',
        edge: feedback.direction === -1 ? rect.left : rect.right, top: rect.top + rect.height / 2 });
      scheduleSettlement();
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
      '--swipe-progress': indicator.progress,
      '--swipe-arrival-duration': `${indicator.motion.arrivalMs}ms`,
      '--swipe-opacity-duration': `${indicator.motion.opacityMs}ms`,
      '--swipe-return-duration': `${indicator.motion.returnMs}ms`,
    } as CSSProperties}
  >
    {/* This large edge affordance overrides the global toolbar stroke weight. */}
    <Arrow size={24} style={{ strokeWidth: 3 }} />
  </div>, document.body);
}

/** Horizontal content keeps its entire gesture, even at either scroll edge. */
function surfaceFromPath(path: EventTarget[]): Element | null {
  for (const target of path) {
    if (!(target instanceof Element)) continue;
    if (target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"], [data-session-history-ignore]')) return null;
    const style = getComputedStyle(target);
    if (/^(auto|scroll)$/.test(style.overflowX) && target.scrollWidth > target.clientWidth + 1) return null;
    if (target.hasAttribute('data-session-history-surface')) return target;
  }
  return null;
}

function resolveSwipeSurface(event: WheelEvent): Element | 'loading' | null {
  const path = event.composedPath();
  // A real descendant path is authoritative, including all its exclusions.
  if (path.some((node) => node instanceof Element && node.hasAttribute('data-session-history-surface'))) {
    const surface = surfaceFromPath(path);
    return surface?.closest('[inert]') ? 'loading' : surface;
  }
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  const surface = document.querySelector('[data-session-history-surface]');
  const target = path[0];
  if (!surface || !(target instanceof Element) || !target.contains(surface)) return null;
  const rect = surface.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX >= rect.right
    || event.clientY < rect.top || event.clientY >= rect.top + rect.height) return null;
  // Chromium retargets wheel streams to a non-inert ancestor during Session
  // replacement and can retain that target afterwards. Loading is a pause;
  // once interactive, resolve the actual hit and apply the same exclusions.
  if (surface.closest('[inert]')) return 'loading';
  const livePath: Element[] = [];
  for (let node = document.elementFromPoint(event.clientX, event.clientY); node; node = node.parentElement) livePath.push(node);
  return surfaceFromPath(livePath);
}
