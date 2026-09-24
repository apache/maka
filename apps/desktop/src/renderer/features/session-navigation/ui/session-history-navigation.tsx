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

import { useLayoutEffect, useRef } from 'react';
import type { SessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { createSessionVisitHistory } from '../model/session-visit-history.js';
import { createSessionSwipe } from '../model/session-swipe.js';

export interface SessionHistoryNavigationProps {
  catalog: SessionCatalogController;
  /** Only the session destination participates; settings and WorkHub do not. */
  visible: boolean;
  blocked: boolean;
  openSession(sessionId: string): void;
}

/** An effect-only child: history and wheel input do not re-render the shell. */
export function SessionHistoryNavigation(props: SessionHistoryNavigationProps) {
  const current = useRef(props);
  const history = useRef(createSessionVisitHistory());

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
    const swipe = createSessionSwipe();
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
      if (result.direction === null) return;
      history.current.move(result.direction,
        (id) => catalog.getState().sessions.some((session) => session.id === id && session.localState !== 'pending'),
        (id) => {
          openSession(id);
          return catalog.getState().activeSessionId === id;
        });
    };
    document.addEventListener('wheel', onWheel, { passive: false });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);
  return null;
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
