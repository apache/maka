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
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/** Match Astryx scroll-spy: Chromium sub-pixel scroll end can read 1px short. */
const SCROLL_END_EPSILON_PX = 2;
/** Hover falloff radius in ticks (0 = hovered). */
const HOVER_FALLOFF_TICKS = 3;
/**
 * Astryx's HoverCard waits 300ms before opening, which guards against a
 * pointer crossing a wide row on its way somewhere else. A tick is 22px of
 * rail that nothing else is on the way to, and the wait is the one part of
 * this hover with no motion in it — 300ms of nothing reads as lag rather than
 * as restraint.
 */
const PREVIEW_DELAY_MS = 120;
const MAX_PROMPT_RAIL_TICKS = 64;
/** Distinguish a positive IO overlap from Chromium's zero-area edge contact. */
const POSITIVE_INTERSECTION_RATIO = 0.000_001;

/** Quiet frames at the destination that end a jump's hold. */
const JUMP_SETTLE_QUIET_FRAMES = 3;
/**
 * Frames a hold may run before it gives up regardless. Only a backstop against
 * a destination that never becomes available; this is ~4s at 60Hz.
 */
const JUMP_HOLD_FRAME_BUDGET = 240;
/** How close to the scrollport's top edge counts as landed. */
const JUMP_LANDED_TOLERANCE_PX = 4;
/** Input that means the reader has taken the transcript back. */
const READER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

interface PromptRailResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

/** Frame scheduler seam, so the jump hold can be driven by a test. */
export interface PromptRailFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const browserFrameScheduler: PromptRailFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Hold a jump's destination while the transcript grows under it.
 *
 * Content can still resolve while a jump is moving, changing geometry under its
 * destination. Releasing the tail (`onNavigateStart`) does not answer that —
 * only re-aiming does, through each geometry change, and once more if a still
 * frame finds the target off the top edge. A frame where nothing moved and the
 * target is where the click asked costs one `getBoundingClientRect` and nothing
 * else.
 *
 * `onNavigateStart` is re-asserted on every frame of the hold rather than once
 * at the click. It is idempotent, and a jump that starts from the tail would
 * otherwise be re-pinned by the first scroll the mounting window produces.
 *
 * The hold ends after the mounted destination is still for a few frames, or
 * the moment the reader takes the transcript back.
 */
export function holdJumpDestination(input: {
  root: Element;
  readTargetId: () => string | null;
  /** The tail release, re-asserted for the life of the hold. */
  releaseAutoFollow?: (() => void) | undefined;
  onSettled: () => void;
  scheduler?: PromptRailFrameScheduler;
}): () => void {
  const { root, readTargetId, releaseAutoFollow, onSettled } = input;
  const scheduler = input.scheduler ?? browserFrameScheduler;
  let handle = 0;
  let done = false;
  let lastHeight = root.scrollHeight;
  let lastTop = root.scrollTop;
  let quietFrames = 0;
  let framesRun = 0;

  const stop = (): void => {
    if (done) return;
    done = true;
    scheduler.cancel(handle);
    for (const type of READER_SCROLL_EVENTS) root.removeEventListener(type, stop);
    onSettled();
  };

  const reaim = (): { found: boolean; corrected: boolean } => {
    const turnId = readTargetId();
    if (turnId === null) return { found: false, corrected: false };
    const target = root.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (!target) return { found: false, corrected: false };
    const offset = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (Math.abs(offset) <= JUMP_LANDED_TOLERANCE_PX) {
      return { found: true, corrected: false };
    }
    const before = root.scrollTop;
    // `auto`: this is a correction, not a second journey.
    (target as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'start' });
    lastTop = root.scrollTop;
    // A correction that moves nothing means the target is as close to the top
    // as this scroller can put it — the last turn of a transcript cannot reach
    // it at all. Report it as landed, or the hold would keep trying until its
    // frame budget ran out.
    return { found: true, corrected: root.scrollTop !== before };
  };

  const hold = (): void => {
    if (done) return;
    handle = scheduler.request(hold);
    framesRun += 1;
    releaseAutoFollow?.();
    const grew = root.scrollHeight !== lastHeight;
    const moved = root.scrollTop !== lastTop;
    lastHeight = root.scrollHeight;
    lastTop = root.scrollTop;
    // Growth can move the destination while content resolves; re-aim through it.
    // A still frame that is nonetheless off-target is the other failure: a
    // scroll that was cancelled part-way and will never resume on its own,
    // which is what happens when the mount's compensation lands on top of one.
    const target = grew || !moved
      ? reaim()
      : { found: false, corrected: false };
    // Quiet means nothing moved at all — not the content, not the position.
    // Height alone was not enough: with the transcript already mounted there
    // is nothing to re-aim through, and the hold released three frames in,
    // handing the highlight and the tail release back while the jump’s
    // own scroll was still in flight.
    if (
      !grew &&
      !moved &&
      !target.corrected &&
      target.found
    ) quietFrames += 1;
    else quietFrames = 0;
    if (quietFrames >= JUMP_SETTLE_QUIET_FRAMES || framesRun >= JUMP_HOLD_FRAME_BUDGET) stop();
  };

  for (const type of READER_SCROLL_EVENTS) {
    root.addEventListener(type, stop, { passive: true });
  }
  handle = scheduler.request(hold);
  return stop;
}

type PromptRailResizeObserverFactory = (
  onResize: () => void,
) => PromptRailResizeObserver;

const createPromptRailResizeObserver: PromptRailResizeObserverFactory = (onResize) =>
  new ResizeObserver(onResize);

/** Keep the active tick reachable without scrolling the transcript ancestor. */
export function keepActivePromptRailTickVisible(rail: HTMLElement): void {
  const tick = rail.querySelector<HTMLElement>('.maka-prompt-rail-tick[data-active="true"]');
  if (!tick) return;
  const railBox = rail.getBoundingClientRect();
  const tickBox = tick.getBoundingClientRect();
  if (tickBox.top < railBox.top) rail.scrollTop -= railBox.top - tickBox.top;
  else if (tickBox.bottom > railBox.bottom)
    rail.scrollTop += tickBox.bottom - railBox.bottom;
}

export function observeActivePromptRailVisibility(
  rail: HTMLElement,
  createObserver: PromptRailResizeObserverFactory = createPromptRailResizeObserver,
): () => void {
  const observer = createObserver(() => keepActivePromptRailTickVisible(rail));
  observer.observe(rail);
  keepActivePromptRailTickVisible(rail);
  return () => observer.disconnect();
}

export interface PromptAnchorRailTurn {
  turnId: string;
  label: string;
  reply?: string;
  sequence?: number;
}

export function mergePromptAnchorRailTurns(
  loadedTurns: ReadonlyArray<{ turnId: string; label: string; reply: string }>,
  index?: ReadonlyArray<{ turnId: string; sequence: number; label: string }>,
): PromptAnchorRailTurn[] {
  if (!index || index.length === 0) {
    return loadedTurns.map((turn) => ({ ...turn }));
  }
  const loadedByTurnId = new Map(loadedTurns.map((turn) => [turn.turnId, turn]));
  return index.map((landmark) => {
    const loaded = loadedByTurnId.get(landmark.turnId);
    return {
      ...(loaded ?? {
        turnId: landmark.turnId,
        label: landmark.label,
        reply: '',
      }),
      sequence: landmark.sequence,
    };
  });
}

export interface PromptAnchorRailProps {
  turns: readonly PromptAnchorRailTurn[];
  scrollRef: RefObject<HTMLElement | null>;
  /** When the indexed Turn is outside the Host's active transcript range. */
  onNavigateFallback?: (turn: PromptAnchorRailTurn) => void;
  /**
   * Stop following the tail, before a jump scrolls.
   *
   * A tick is the reader choosing where to look, which outranks the tail. It
   * has to be said before the scroll, not after: released afterwards, the
   * release lands on a viewport the pin has already written back to the bottom.
   */
  onNavigateStart?: (() => void) | undefined;
}

export function selectPromptRailActiveTurn(input: {
  atEnd: boolean;
  mountedTurnIds: Iterable<string>;
  readingBandTurnIds: Iterable<string>;
  scrollportTurnIds: Iterable<string>;
  turnIndexById: ReadonlyMap<string, number>;
}): string | null {
  const readingBandTurnIds = [...input.readingBandTurnIds];
  const candidates = input.atEnd
    ? input.mountedTurnIds
    : readingBandTurnIds.length > 0
      ? readingBandTurnIds
      : input.scrollportTurnIds;
  let selected: string | null = null;
  let selectedIndex = input.atEnd ? -1 : Number.POSITIVE_INFINITY;
  for (const turnId of candidates) {
    const index = input.turnIndexById.get(turnId);
    if (index === undefined) continue;
    if (
      (input.atEnd && index > selectedIndex)
      || (!input.atEnd && index < selectedIndex)
    ) {
      selected = turnId;
      selectedIndex = index;
    }
  }
  return selected;
}

export function selectPromptRailTickForMountedTurn(input: {
  activeTurnId: string;
  mountedTurnIds: readonly string[];
  railTurns: readonly PromptAnchorRailTurn[];
  previousRailTurnId: string | null;
  atEnd: boolean;
}): string | null {
  const previousRailTurnId = input.railTurns.some(
    (turn) => turn.turnId === input.previousRailTurnId,
  ) ? input.previousRailTurnId : null;
  const fallbackRailTurnId = input.atEnd
    ? input.railTurns.at(-1)?.turnId ?? null
    : previousRailTurnId ?? input.railTurns[0]?.turnId ?? null;
  const direct = input.railTurns.find((turn) => turn.turnId === input.activeTurnId);
  if (direct) return direct.turnId;
  const activeIndex = input.mountedTurnIds.indexOf(input.activeTurnId);
  if (activeIndex === -1) return fallbackRailTurnId;
  const mountedRailTurns = input.mountedTurnIds.flatMap((turnId, mountedIndex) => {
    const railIndex = input.railTurns.findIndex((turn) => turn.turnId === turnId);
    return railIndex === -1 ? [] : [{ mountedIndex, railIndex }];
  });
  const nearestMountedRailTurn = [...mountedRailTurns]
    .sort((left, right) =>
      Math.abs(left.mountedIndex - activeIndex) - Math.abs(right.mountedIndex - activeIndex)
      || left.mountedIndex - right.mountedIndex,
    )[0];
  const nearestMountedRailTurnId = nearestMountedRailTurn
    ? input.railTurns[nearestMountedRailTurn.railIndex]?.turnId ?? null
    : null;
  const sequenceAnchors = mountedRailTurns
    .flatMap(({ mountedIndex, railIndex }) => {
      const sequence = input.railTurns[railIndex]?.sequence;
      return sequence === undefined ? [] : [{ mountedIndex, railIndex, sequence }];
    })
    .sort((left, right) =>
      Math.abs(left.mountedIndex - activeIndex) - Math.abs(right.mountedIndex - activeIndex)
      || left.mountedIndex - right.mountedIndex,
    )
    .slice(0, 2)
    .sort((left, right) => left.mountedIndex - right.mountedIndex);
  const [firstAnchor, secondAnchor] = sequenceAnchors;
  if (!firstAnchor || !secondAnchor) {
    return firstAnchor
      ? input.railTurns[firstAnchor.railIndex]?.turnId ?? null
      : nearestMountedRailTurnId ?? fallbackRailTurnId;
  }
  const activeSequence = firstAnchor.sequence
    + (secondAnchor.sequence - firstAnchor.sequence)
      * (activeIndex - firstAnchor.mountedIndex)
      / (secondAnchor.mountedIndex - firstAnchor.mountedIndex);
  const firstSequence = input.railTurns[0]?.sequence;
  const lastSequence = input.railTurns[input.railTurns.length - 1]?.sequence;
  const projectedRailIndex = firstSequence !== undefined
    && lastSequence !== undefined
    && lastSequence > firstSequence
    ? Math.round(
      (activeSequence - firstSequence)
        * (input.railTurns.length - 1)
        / (lastSequence - firstSequence),
    )
    : firstAnchor.railIndex;
  let selected: PromptAnchorRailTurn | null = null;
  let selectedIndex = -1;
  let selectedDistance = Number.POSITIVE_INFINITY;
  const candidateRange = activeIndex < firstAnchor.mountedIndex
    ? [Math.max(0, firstAnchor.railIndex - 1), firstAnchor.railIndex]
    : activeIndex > secondAnchor.mountedIndex
      ? [
          secondAnchor.railIndex,
          Math.min(input.railTurns.length - 1, secondAnchor.railIndex + 1),
        ]
      : [firstAnchor.railIndex, secondAnchor.railIndex];
  for (let index = 0; input.railTurns.length > index; index += 1) {
    if (index < candidateRange[0]! || index > candidateRange[1]!) continue;
    const turn = input.railTurns[index]!;
    if (turn.sequence === undefined) continue;
    const distance = Math.abs(turn.sequence - activeSequence);
    if (
      distance < selectedDistance
      || (
        distance === selectedDistance
        && Math.abs(index - projectedRailIndex) < Math.abs(selectedIndex - projectedRailIndex)
      )
    ) {
      selected = turn;
      selectedIndex = index;
      selectedDistance = distance;
    }
  }
  return selected?.turnId ?? fallbackRailTurnId;
}

/** Right-edge rail: bounded prompt landmarks that scroll to `[data-turn-id]`. */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef, onNavigateFallback, onNavigateStart }: PromptAnchorRailProps): React.ReactElement | null {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [activeSelection, setActiveSelection] = useState<{
    turnId: string;
    atEnd: boolean;
  } | null>(null);
  const activeTurnId = activeSelection?.turnId ?? null;
  const [mountedTurnIds, setMountedTurnIds] = useState<readonly string[]>([]);
  const [safeArea, setSafeArea] = useState<{ scrollport: number; dock: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const previousActiveRailTurnIdRef = useRef<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const activeVisibilityFrame = useRef(0);
  const markActiveTurn = useCallback((turnId: string, atEnd = false) => {
    setActiveSelection((current) =>
      current?.turnId === turnId && current.atEnd === atEnd ? current : { turnId, atEnd },
    );
  }, []);
  // Identified by a sequence number rather than a boolean so a second click
  // during a jump starts its own claim instead of inheriting what is left of
  // the first one's — which would leave the earlier jump's lifetime governing
  // the later jump's target.
  const [jump, setJump] = useState<{ sequence: number; turnId: string } | null>(null);
  const jumpSequenceRef = useRef(0);
  // The turn a click aimed at, held until that click's scroll settles. A ref,
  // not state: the observer effect reads it on every scroll frame and must not
  // be torn down and rebuilt over the whole transcript when it changes.
  const jumpTargetRef = useRef<string | null>(null);
  const onNavigateStartRef = useRef(onNavigateStart);
  onNavigateStartRef.current = onNavigateStart;
  // Prompt/reply text changes while an answer streams, but the scroll spy only
  // depends on Turn identity and order. Keep that structural value stable so a
  // text delta does not tear down and rebuild every transcript observer.
  const orderedTurnIdsRef = useRef<readonly string[]>([]);
  const nextOrderedTurnIds = turns.map((turn) => turn.turnId);
  if (
    orderedTurnIdsRef.current.length !== nextOrderedTurnIds.length
    || nextOrderedTurnIds.some((turnId, index) => orderedTurnIdsRef.current[index] !== turnId)
  ) {
    orderedTurnIdsRef.current = nextOrderedTurnIds;
  }
  const orderedTurnIds = orderedTurnIdsRef.current;
  const railTurnIndexes = useMemo(() => {
    if (orderedTurnIds.length <= MAX_PROMPT_RAIL_TICKS) {
      return orderedTurnIds.map((_, index) => index);
    }
    return Array.from({ length: MAX_PROMPT_RAIL_TICKS }, (_, index) =>
      Math.round(index * (orderedTurnIds.length - 1) / (MAX_PROMPT_RAIL_TICKS - 1)),
    );
  }, [orderedTurnIds]);
  const railTurnIds = useMemo(
    () => railTurnIndexes.map((turnIndex) => orderedTurnIds[turnIndex]!),
    [orderedTurnIds, railTurnIndexes],
  );
  const railTurns = railTurnIndexes.map((turnIndex) => turns[turnIndex]!);
  const mappedActiveRailTurnId = (() => {
    if (activeTurnId === null) return null;
    if (railTurnIds.includes(activeTurnId)) return activeTurnId;
    const orderedActiveIndex = orderedTurnIds.indexOf(activeTurnId);
    if (orderedActiveIndex !== -1 && orderedTurnIds.length > railTurnIds.length) {
      return railTurnIds[Math.round(
        orderedActiveIndex * (railTurnIds.length - 1) / (orderedTurnIds.length - 1),
      )] ?? null;
    }
    return selectPromptRailTickForMountedTurn({
      activeTurnId,
      mountedTurnIds,
      railTurns,
      previousRailTurnId: previousActiveRailTurnIdRef.current,
      atEnd: activeSelection?.atEnd ?? false,
    });
  })();
  const activeRailTurnId = mappedActiveRailTurnId
    ?? (railTurnIds.includes(previousActiveRailTurnIdRef.current ?? '')
      ? previousActiveRailTurnIdRef.current
      : null);
  useEffect(() => {
    if (activeRailTurnId !== null) previousActiveRailTurnIdRef.current = activeRailTurnId;
  }, [activeRailTurnId]);

  // React is the only writer of the active attributes. Once that render has
  // committed, bring the current tick into the rail's own bounded viewport.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || activeRailTurnId === null) return;
    if (activeVisibilityFrame.current !== 0) cancelAnimationFrame(activeVisibilityFrame.current);
    activeVisibilityFrame.current = requestAnimationFrame(() => {
      activeVisibilityFrame.current = requestAnimationFrame(() => {
        activeVisibilityFrame.current = 0;
        keepActivePromptRailTickVisible(rail);
      });
    });
    return () => {
      if (activeVisibilityFrame.current !== 0) {
        cancelAnimationFrame(activeVisibilityFrame.current);
        activeVisibilityFrame.current = 0;
      }
    };
  }, [activeRailTurnId]);

  useEffect(() => {
    const root = scrollRef.current;
    const messageList = root?.querySelector('.maka-chat-message-list');
    // Astryx ChatMessageList renders one inner flex column as its first child;
    // that column is the direct parent of Maka's keyed transcript Turn wrappers.
    const mountedTurnList = messageList?.firstElementChild;
    if (!root || !mountedTurnList || orderedTurnIds.length === 0) return;

    const idByElement = new Map<Element, string>();
    let mountedTurnIndexById = new Map<string, number>();
    const readingBandTurnIds = new Set<string>();
    const observeElement = (element: Element): void => {
      const turnId = element.getAttribute('data-transcript-turn-id');
      if (!turnId || idByElement.has(element)) return;
      idByElement.set(element, turnId);
      observer.observe(element);
    };
    const unobserveElement = (element: Element): void => {
      const turnId = idByElement.get(element);
      if (!turnId) return;
      idByElement.delete(element);
      readingBandTurnIds.delete(turnId);
      observer.unobserve(element);
    };
    const visitTurnElements = (node: Node, visit: (element: Element) => void): void => {
      if (!(node instanceof Element)) return;
      if (node.hasAttribute('data-transcript-turn-id')) visit(node);
      for (const element of node.querySelectorAll('[data-transcript-turn-id]')) visit(element);
    };
    const refreshMountedTurnOrder = (): void => {
      const nextMountedTurnIds = [...mountedTurnList.querySelectorAll(
        '[data-transcript-turn-id]',
      )].flatMap((element) => {
        const turnId = element.getAttribute('data-transcript-turn-id');
        return turnId ? [turnId] : [];
      });
      mountedTurnIndexById = new Map(
        nextMountedTurnIds.map((turnId, index) => [turnId, index]),
      );
      setMountedTurnIds((current) =>
        current.length === nextMountedTurnIds.length
        && nextMountedTurnIds.every((turnId, index) => current[index] === turnId)
          ? current
          : nextMountedTurnIds,
      );
    };
    const turnIdsIntersecting = (top: number, bottom: number): string[] => {
      const turnIds: string[] = [];
      for (const [element, turnId] of idByElement) {
        const bounds = element.getBoundingClientRect();
        if (bounds.bottom > top && bounds.top < bottom) turnIds.push(turnId);
      }
      return turnIds;
    };
    const seedReadingBandFromGeometry = (): void => {
      const rootBounds = root.getBoundingClientRect();
      readingBandTurnIds.clear();
      for (const turnId of turnIdsIntersecting(
        rootBounds.top,
        rootBounds.top + rootBounds.height * 0.34,
      )) {
        readingBandTurnIds.add(turnId);
      }
    };
    const resolveActive = (): void => {
      // A jump owns the highlight until its scroll settles. Without this the
      // observer walks the highlight through every prompt the scroll passes,
      // which is the travelling the click was meant to skip.
      if (jumpTargetRef.current !== null) return;
      const atEnd =
        root.scrollHeight - root.scrollTop - root.clientHeight <= SCROLL_END_EPSILON_PX;
      const rootBounds = !atEnd && readingBandTurnIds.size === 0
        ? root.getBoundingClientRect()
        : null;
      const active = selectPromptRailActiveTurn({
        atEnd,
        mountedTurnIds: idByElement.values(),
        readingBandTurnIds,
        scrollportTurnIds: rootBounds !== null
          ? turnIdsIntersecting(rootBounds.top, rootBounds.bottom)
          : [],
        turnIndexById: mountedTurnIndexById,
      });
      if (active !== null) markActiveTurn(active, atEnd);
    };

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const turnId = idByElement.get(entry.target);
        if (!turnId) continue;
        if (entry.intersectionRect.height > 0) readingBandTurnIds.add(turnId);
        else readingBandTurnIds.delete(turnId);
      }
      resolveActive();
    }, {
      root,
      rootMargin: '0px 0px -66% 0px',
      // The positive threshold delivers a callback when an overlap becomes
      // a zero-area boundary touch, which the strict geometry rule excludes.
      threshold: [0, POSITIVE_INTERSECTION_RATIO],
    });
    for (const element of mountedTurnList.querySelectorAll('[data-transcript-turn-id]')) {
      observeElement(element);
    }
    refreshMountedTurnOrder();
    seedReadingBandFromGeometry();
    resolveActive();

    let membershipFrame = 0;
    let membershipFramesLeft = 0;
    const settleMembershipGeometry = (): void => {
      membershipFrame = requestAnimationFrame(() => {
        membershipFrame = 0;
        seedReadingBandFromGeometry();
        resolveActive();
        membershipFramesLeft -= 1;
        if (membershipFramesLeft > 0) settleMembershipGeometry();
      });
    };
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) visitTurnElements(node, unobserveElement);
        for (const node of record.addedNodes) visitTurnElements(node, observeElement);
      }
      refreshMountedTurnOrder();
      // Browser scroll anchoring and the paged transcript projection can land
      // across several frames after the child-list mutation. Follow that short
      // settle window, or a prepended page can leave its previous boundary
      // Turn current after the replacement is being read.
      membershipFramesLeft = 6;
      if (membershipFrame === 0) {
        settleMembershipGeometry();
      }
    });
    mutationObserver.observe(mountedTurnList, { childList: true });

    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resolveActive();
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      root.removeEventListener('scroll', onScroll);
      if (membershipFrame !== 0) cancelAnimationFrame(membershipFrame);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [markActiveTurn, orderedTurnIds, scrollRef]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    // Astryx renders the dock as the scroll container's last child; the
    // scroll-geometry spec reads it the same way for want of a published hook.
    const dock = root.lastElementChild;
    const measure = (): void => {
      setSafeArea((previous) => {
        const next = {
          scrollport: root.clientHeight,
          dock: dock?.getBoundingClientRect().height ?? 0,
        };
        return previous && previous.scrollport === next.scrollport && previous.dock === next.dock
          ? previous
          : next;
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (dock) observer.observe(dock);
    measure();
    return () => observer.disconnect();
  }, [scrollRef]);

  // Past enough prompts the rail hits its cap and becomes a scroller of its own,
  // and then marking a tick active is not enough — the tick can be outside the
  // rail's own viewport, where it is neither visible nor clickable. Scrolling
  // the main transcript to the end of a 60-prompt conversation put the last
  // tick there while the rail sat at scrollTop 0.
  //
  // Deliberately arithmetic on the rail rather than `scrollIntoView`: that
  // walks every scrollable ancestor, and the nearest one here is the
  // transcript itself. Nudging the rail must never move the conversation the
  // reader is scrolling.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    return observeActivePromptRailVisibility(rail);
  }, [orderedTurnIds]);

  // A click owns the highlight until the destination settles, so the scroll it
  // started cannot walk the active tick through every prompt on the way. Keyed
  // on the jump sequence so a second click starts its own claim.
  //
  // The hold re-aims through content geometry changes and reports back
  // when the mounted destination is still, or when the reader takes it back.
  useEffect(() => {
    if (!jump) return;
    const root = scrollRef.current;
    if (!root) return;
    return holdJumpDestination({
      root,
      readTargetId: () => jumpTargetRef.current,
      releaseAutoFollow: onNavigateStartRef.current,
      onSettled: () => {
        // Only the latest jump releases the highlight: a later click has
        // already claimed it, and its own hold owns it now. Decided against
        // the ref rather than inside the state updater, which React may run
        // twice.
        if (jumpSequenceRef.current !== jump.sequence) return;
        jumpTargetRef.current = null;
        setJump((current) => (current?.sequence === jump.sequence ? null : current));
      },
    });
  }, [jump, scrollRef]);

  function jumpTo(turn: PromptAnchorRailTurn): void {
    const turnId = turn.turnId;
    const root = scrollRef.current;
    const el = root?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    // Before the scroll, not after: the tail has to be released while the
    // transcript is still where the reader left it, or the release lands after
    // the next growth has already written the view back to the bottom.
    onNavigateStart?.();
    // Claimed before the scroll starts: a same-frame `scroll` event would
    // otherwise reach the observer while the highlight is still unowned.
    jumpTargetRef.current = turnId;
    if (el && 'scrollIntoView' in el) {
      // Instant, whatever the app's scroll-motion policy says. A jump is a
      // teleport the reader asked for, not a journey — and an animated one
      // does not survive this surface: traced against a 30-prompt session, the
      // smooth scroll was cancelled by concurrent content growth and stalled
      // two pixels from where it started. Landing reliably beats animating
      // unreliably.
      (el as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'start' });
    } else if (!el) {
      onNavigateFallback?.(turn);
    }
    jumpSequenceRef.current += 1;
    setJump({ sequence: jumpSequenceRef.current, turnId });
    markActiveTurn(turnId);
  }

  // A rail is only useful once there are a few prompts to jump between.
  if (railTurns.length < 3) return null;

  return (
    <div
      className="maka-prompt-rail-anchor"
      style={
        safeArea
          ? ({
              '--maka-prompt-rail-scrollport': `${safeArea.scrollport}px`,
              '--maka-prompt-rail-dock': `${safeArea.dock}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <nav
        className="maka-prompt-rail"
        aria-label={copy.promptRailAriaLabel}
        ref={railRef}
        onPointerLeave={() => setHoveredIndex(null)}
      >
        {railTurns.map((turn, index) => {
          const isActive = turn.turnId === activeRailTurnId;
          const preview = turn.label.trim() || copy.emptyPrompt;
          const replyPreview = (turn.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
          const proximity =
            hoveredIndex === null
              ? HOVER_FALLOFF_TICKS
              : Math.min(Math.abs(index - hoveredIndex), HOVER_FALLOFF_TICKS);
          const scale = (14 + ((HOVER_FALLOFF_TICKS - proximity) * 3)) / 26;
          return (
            <HoverCard
              key={turn.turnId}
              placement="start"
              delay={PREVIEW_DELAY_MS}
              content={
                <span className="maka-prompt-rail-preview">
                  <span className="maka-prompt-rail-preview-prompt">{preview}</span>
                  {replyPreview ? (
                    <span className="maka-prompt-rail-preview-reply">{replyPreview}</span>
                  ) : null}
                </span>
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                label={copy.jumpToPrompt(preview)}
                className="maka-prompt-rail-tick"
                data-prompt-turn-id={turn.turnId}
                data-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => jumpTo(turn)}
                onPointerEnter={() => setHoveredIndex(index)}
                style={
                  {
                    '--maka-prompt-rail-index': index,
                    '--maka-prompt-rail-scale': scale,
                  } as CSSProperties
                }
              >
                <span className="maka-prompt-rail-tick-bar" />
              </Button>
            </HoverCard>
          );
        })}
      </nav>
    </div>
  );
});
