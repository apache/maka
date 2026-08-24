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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { captureChatScrollAnchor, restoreChatScrollAnchor } from './chat-scroll-anchor.js';
import { createTurnHeightIndex, turnLayoutGap, turnLayoutKey } from './turn-height-index.js';
import {
  buildTurnVirtualLayout,
  DEFAULT_TURN_GAP,
  DEFAULT_TURN_WINDOW_SIZE,
  estimatedTurnHeight,
  initialTurnVirtualWindow,
  MIN_TURN_WINDOW_SIZE,
  reconcileTurnVirtualWindow,
  stableTurnVirtualWindowForViewport,
  turnVirtualWindowForRange,
  turnVirtualWindowForViewport,
  turnVirtualizationRequired,
  type TurnVirtualLayout,
  type TurnVirtualWindow,
} from './turn-virtualizer.js';

const turnHeightIndex = createTurnHeightIndex();

interface VirtualState {
  readonly sessionId: string | undefined;
  readonly turnIds: readonly string[];
  readonly window: TurnVirtualWindow;
}

export function useTurnVirtualizer(input: {
  sessionId: string | undefined;
  turnIds: readonly string[];
  targetTurnId?: string;
  targetKey?: string | number;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const [geometryRevision, setGeometryRevision] = useState(0);
  const root = input.scrollRef.current;
  const gap = root ? turnLayoutGap(root, DEFAULT_TURN_GAP) : DEFAULT_TURN_GAP;
  const layoutKey = root ? turnLayoutKey(root, gap) : '';
  const heights = input.sessionId && layoutKey
    ? turnHeightIndex.lookup(input.sessionId, layoutKey)
    : undefined;
  const layout = useMemo(
    () => buildTurnVirtualLayout(input.turnIds, heights, {
      estimatedHeight: estimatedTurnHeight(heights),
      gap,
    }),
    [input.turnIds, heights, gap, geometryRevision],
  );
  const targetKey = input.targetTurnId === undefined
    ? undefined
    : `${input.targetTurnId}:${input.targetKey ?? ''}`;
  const handledTargetKey = useRef<string | undefined>(undefined);
  const candidateEnsureIndex = input.targetTurnId !== undefined
    && targetKey !== handledTargetKey.current
    ? input.turnIds.indexOf(input.targetTurnId)
    : -1;
  const ensureIndex = candidateEnsureIndex < 0 ? undefined : candidateEnsureIndex;
  const retainRange = root ? interactiveTurnRange(root, input.turnIds) : undefined;
  const virtualizationRequired = turnVirtualizationRequired(
    layout,
    root?.clientHeight,
    root?.scrollHeight,
  );
  const [state, setState] = useState<VirtualState>(() => ({
    sessionId: input.sessionId,
    turnIds: input.turnIds,
    window: initialTurnVirtualWindow(layout, undefined, ensureIndex),
  }));
  let current = state;
  if (!virtualizationRequired) {
    const fullWindow = turnVirtualWindowForRange(layout, 0, input.turnIds.length);
    current = {
      sessionId: input.sessionId,
      turnIds: input.turnIds,
      window: fullWindow,
    };
    if (
      state.sessionId !== current.sessionId
      || !sameTurnIds(state.turnIds, current.turnIds)
      || !sameWindow(state.window, fullWindow)
    ) {
      setState(current);
    }
  } else if (state.sessionId !== input.sessionId || !sameTurnIds(state.turnIds, input.turnIds)) {
    const sameSession = state.sessionId === input.sessionId;
    const reconciled = sameSession
      ? reconcileTurnVirtualWindow(state.turnIds, layout, state.window, undefined, retainRange)
      : initialTurnVirtualWindow(layout, undefined, ensureIndex);
    current = {
      sessionId: input.sessionId,
      turnIds: input.turnIds,
      window: !sameSession && ensureIndex !== undefined
        && reconciled.end - reconciled.start > DEFAULT_TURN_WINDOW_SIZE
        ? initialTurnVirtualWindow(layout, DEFAULT_TURN_WINDOW_SIZE, ensureIndex)
        : reconciled,
    };
    setState(current);
  } else {
    const geometryWindow = turnVirtualWindowForRange(layout, state.window.start, state.window.end);
    if (!sameWindow(state.window, geometryWindow)) {
      current = { ...state, window: geometryWindow };
      setState(current);
    }
  }

  const layoutRef = useRef(layout);
  const stateRef = useRef(current);
  const pendingAnchor = useRef<ReturnType<typeof captureChatScrollAnchor>>(undefined);
  const pendingReveal = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    layoutRef.current = layout;
    stateRef.current = current;
    if (
      ensureIndex !== undefined
      && ensureIndex >= current.window.start
      && ensureIndex < current.window.end
    ) {
      handledTargetKey.current = targetKey;
    }
  }, [current, ensureIndex, layout, targetKey]);

  const installWindow = useCallback((next: TurnVirtualWindow, anchor = true): boolean => {
    const root = input.scrollRef.current;
    if (sameWindow(stateRef.current.window, next)) return false;
    if (anchor && root) pendingAnchor.current = captureChatScrollAnchor(root);
    if (root) handOffExcludedInteraction(root, stateRef.current.turnIds, next);
    setState((previous) => sameWindow(previous.window, next)
      ? previous
      : { ...previous, window: next });
    return true;
  }, [input.scrollRef]);

  useLayoutEffect(() => {
    if (ensureIndex === undefined) return;
    const window = stateRef.current.window;
    if (ensureIndex >= window.start && ensureIndex < window.end) {
      handledTargetKey.current = targetKey;
      return;
    }
    installWindow(initialTurnVirtualWindow(layoutRef.current, undefined, ensureIndex));
  }, [ensureIndex, installWindow, targetKey]);

  useLayoutEffect(() => {
    pendingReveal.current = undefined;
  }, [input.sessionId]);

  const revealTurn = useCallback((turnId: string) => {
    const index = stateRef.current.turnIds.indexOf(turnId);
    if (index < 0) return;
    const next = initialTurnVirtualWindow(layoutRef.current, DEFAULT_TURN_WINDOW_SIZE, index);
    pendingReveal.current = turnId;
    if (!installWindow(next)) pendingReveal.current = undefined;
  }, [installWindow]);

  useLayoutEffect(() => {
    const root = input.scrollRef.current;
    if (!root) return;
    if (pendingAnchor.current) {
      restoreChatScrollAnchor(root, pendingAnchor.current);
      pendingAnchor.current = undefined;
    }
    const reveal = pendingReveal.current;
    pendingReveal.current = undefined;
    if (reveal) {
      const target = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(reveal)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
        const targetIndex = stateRef.current.turnIds.indexOf(reveal);
        installWindow(turnVirtualWindowForViewport(
          layoutRef.current,
          { scrollTop: root.scrollTop, clientHeight: root.clientHeight },
          {
            ensureIndex: targetIndex < 0 ? undefined : targetIndex,
            preferredTurns: MIN_TURN_WINDOW_SIZE,
          },
        ), false);
      }
    }
  }, [current.window, input.scrollRef, installWindow]);

  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root) {
      const frame = window.requestAnimationFrame(() => {
        setGeometryRevision((revision) => revision + 1);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    let frame = 0;
    const updateWindow = (): void => {
      frame = 0;
      if (!virtualizationRequired || pendingReveal.current) return;
      installWindow(stableTurnVirtualWindowForViewport(
        layoutRef.current,
        stateRef.current.window,
        { scrollTop: root.scrollTop, clientHeight: root.clientHeight },
        {
          preferredTurns: MIN_TURN_WINDOW_SIZE,
          retainRange: interactiveTurnRange(root, stateRef.current.turnIds),
        },
      ));
    };
    const scheduleWindow = (): void => {
      if (!virtualizationRequired) return;
      if (frame === 0) frame = window.requestAnimationFrame(updateWindow);
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const nextGap = turnLayoutGap(root, DEFAULT_TURN_GAP);
      const nextLayoutKey = turnLayoutKey(root, nextGap);
      let changed = nextLayoutKey !== layoutKey;
      const anchor = virtualizationRequired ? captureChatScrollAnchor(root) : undefined;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const turnId = element.dataset.virtualTurnId;
        if (!turnId) continue;
        if (input.sessionId) {
          changed = turnHeightIndex.record(
            input.sessionId,
            nextLayoutKey,
            turnId,
            entry.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height,
          ) || changed;
        }
      }
      if (changed) {
        if (anchor) pendingAnchor.current = anchor;
        setGeometryRevision((revision) => revision + 1);
      }
      scheduleWindow();
    });
    const observeTree = (node: Node): void => {
      if (!(node instanceof HTMLElement)) return;
      if (node.dataset.virtualTurnId) resizeObserver.observe(node);
      for (const turn of node.querySelectorAll<HTMLElement>('[data-virtual-turn-id]')) {
        resizeObserver.observe(turn);
      }
    };
    const unobserveTree = (node: Node): void => {
      if (!(node instanceof HTMLElement)) return;
      if (node.dataset.virtualTurnId) resizeObserver.unobserve(node);
      for (const turn of node.querySelectorAll<HTMLElement>('[data-virtual-turn-id]')) {
        resizeObserver.unobserve(turn);
      }
    };
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) unobserveTree(node);
        for (const node of record.addedNodes) observeTree(node);
      }
    });
    mutationObserver.observe(root, { childList: true, subtree: true });
    resizeObserver.observe(root);
    for (const turn of root.querySelectorAll<HTMLElement>('[data-virtual-turn-id]')) {
      resizeObserver.observe(turn);
    }
    root.addEventListener('scroll', scheduleWindow, { passive: true });
    scheduleWindow();
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      root.removeEventListener('scroll', scheduleWindow);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [input.sessionId, input.scrollRef, installWindow, layoutKey, virtualizationRequired]);

  return {
    start: current.window.start,
    end: current.window.end,
    beforeHeight: current.window.beforeHeight,
    afterHeight: current.window.afterHeight,
    revealTurn,
  };
}

function sameTurnIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((turnId, index) => turnId === right[index]);
}

function sameWindow(left: TurnVirtualWindow, right: TurnVirtualWindow): boolean {
  return left.start === right.start
    && left.end === right.end
    && left.beforeHeight === right.beforeHeight
    && left.afterHeight === right.afterHeight;
}

function interactiveTurnRange(
  root: HTMLElement,
  turnIds: readonly string[],
): { start: number; end: number } | undefined {
  const indexes: number[] = [];
  const appendNode = (node: Node | null): void => {
    if (!node) return;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element || !root.contains(element)) return;
    const turnId = interactionTurnId(element);
    const index = turnId === undefined ? -1 : turnIds.indexOf(turnId);
    if (index >= 0) indexes.push(index);
  };
  const active = root.ownerDocument.activeElement;
  if (active instanceof Element) appendNode(active);
  const selection = root.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) {
    appendNode(selection.anchorNode);
    appendNode(selection.focusNode);
  }
  if (indexes.length === 0) return undefined;
  return { start: Math.min(...indexes), end: Math.max(...indexes) + 1 };
}

function handOffExcludedInteraction(
  root: HTMLElement,
  turnIds: readonly string[],
  next: TurnVirtualWindow,
): void {
  const isExcluded = (node: Node | null): boolean => {
    if (!node) return false;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element || !root.contains(element)) return false;
    const turnId = interactionTurnId(element);
    const index = turnId === undefined ? -1 : turnIds.indexOf(turnId);
    return index >= 0 && (index < next.start || index >= next.end);
  };

  const selection = root.ownerDocument.getSelection();
  if (
    selection
    && !selection.isCollapsed
    && (isExcluded(selection.anchorNode) || isExcluded(selection.focusNode))
  ) {
    selection.removeAllRanges();
  }

  if (isExcluded(root.ownerDocument.activeElement)) {
    root.querySelector<HTMLElement>('.maka-chat-message-list')?.focus({ preventScroll: true });
  }
}

function interactionTurnId(element: Element): string | undefined {
  const owner = element.closest<HTMLElement>('[data-turn-id], [data-virtual-turn-id]');
  return owner?.dataset.turnId ?? owner?.dataset.virtualTurnId;
}
