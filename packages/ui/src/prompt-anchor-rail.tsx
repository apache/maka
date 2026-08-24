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

/** Quiet frames at the destination that end a jump's hold. */
const JUMP_SETTLE_QUIET_FRAMES = 3;
/**
 * Frames a hold may run before it gives up regardless. Only a backstop against
 * a destination that never mounts; this is ~4s at 60Hz.
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
 * Two different things move the transcript out from under a jump, and
 * releasing auto-follow (`onNavigateStart`) only answers the first:
 *
 *  - Astryx's auto-follow spring, which keeps pulling toward the bottom
 *    because it never sees the jump as a reader-initiated scroll up.
 *  - The virtual window's scroll compensation while the destination is
 *    mounted and its measured height replaces the estimate.
 *
 * Re-aiming outlasts both: through each geometry change, and once more if a still
 * frame finds the target off the top edge, which is what a scroll cancelled
 * part-way leaves behind. A frame where nothing moved and the target is where
 * the click asked costs one `getBoundingClientRect` and nothing else.
 *
 * `releaseAutoFollow` runs on every frame of the hold rather than once at the
 * click, because Astryx re-locks on any `scrollend` that settles near the
 * bottom. A jump from the initial tail can otherwise undo a single release
 * while the destination window is mounting.
 *
 * The hold ends after the mounted destination is still for a few frames, or
 * the moment the reader takes the transcript back.
 */
export function holdJumpDestination(input: {
  root: Element;
  readTargetId: () => string | null;
  /** Astryx's auto-follow release, re-asserted for the life of the hold. */
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
    // Growth is the virtual window replacing estimates; re-aim through it.
    // A still frame that is nonetheless off-target is the other failure: a
    // scroll that was cancelled part-way and will never resume on its own,
    // which is what happens when the mount's compensation lands on top of one.
    const target = grew || !moved
      ? reaim()
      : { found: false, corrected: false };
    // Quiet means nothing moved at all — not the content, not the position.
    // Height alone was not enough: with the transcript already mounted there
    // is nothing to re-aim through, and the hold released three frames in,
    // handing the highlight and the auto-follow release back while the jump's
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

export interface PromptAnchorRailProps {
  turns: readonly PromptAnchorRailTurn[];
  scrollRef: RefObject<HTMLElement | null>;
  /** When the bounded virtual window has not placed the turn in the DOM. */
  onNavigateFallback?: (turn: PromptAnchorRailTurn) => void;
  /**
   * Release Astryx's auto-follow before a jump scrolls.
   *
   * ChatLayout keeps the transcript pinned to the bottom while a turn streams
   * and unlocks when the reader scrolls up, which it detects by comparing
   * scrollTop between scroll events — but it discards any scroll event that
   * arrives with a changed scrollHeight, since Chrome fires those on content
   * resize and they are not the reader moving. A jump to an unmounted turn
   * changes the virtual window's height, so auto-follow must be released first.
   */
  onNavigateStart?: (() => void) | undefined;
}

/** Right-edge rail: bounded prompt landmarks that scroll to `[data-turn-id]`. */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef, onNavigateFallback, onNavigateStart }: PromptAnchorRailProps): React.ReactElement | null {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const activeTurnIdRef = useRef<string | null>(null);
  const [safeArea, setSafeArea] = useState<{ scrollport: number; dock: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const activeVisibilityFrame = useRef(0);
  const markActiveTurn = useCallback((turnId: string) => {
    if (activeTurnIdRef.current === turnId) return;
    activeTurnIdRef.current = turnId;
    const rail = railRef.current;
    const previous = rail?.querySelector<HTMLElement>('[data-active="true"]');
    previous?.removeAttribute('data-active');
    previous?.removeAttribute('aria-current');
    const target = rail?.querySelector<HTMLElement>(
      `[data-prompt-turn-id="${CSS.escape(turnId)}"]`,
    );
    target?.setAttribute('data-active', 'true');
    target?.setAttribute('aria-current', 'true');
    if (activeVisibilityFrame.current !== 0) cancelAnimationFrame(activeVisibilityFrame.current);
    activeVisibilityFrame.current = requestAnimationFrame(() => {
      activeVisibilityFrame.current = requestAnimationFrame(() => {
        activeVisibilityFrame.current = 0;
        if (rail) keepActivePromptRailTickVisible(rail);
      });
    });
  }, []);
  useEffect(() => () => {
    if (activeVisibilityFrame.current !== 0) {
      cancelAnimationFrame(activeVisibilityFrame.current);
    }
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
  const turnIndexById = useMemo(
    () => new Map(turns.map((turn, index) => [turn.turnId, index])),
    [turns],
  );
  const railTurns = useMemo(() => {
    if (turns.length <= MAX_PROMPT_RAIL_TICKS) return turns;
    return Array.from({ length: MAX_PROMPT_RAIL_TICKS }, (_, index) =>
      turns[Math.round(index * (turns.length - 1) / (MAX_PROMPT_RAIL_TICKS - 1))]!,
    );
  }, [turns]);

  const railTurnIdFor = (turnId: string): string | null => {
    const turnIndex = turnIndexById.get(turnId);
    if (turnIndex === undefined) return null;
    if (turns.length === railTurns.length) return turnId;
    const railIndex = Math.round(turnIndex * (railTurns.length - 1) / (turns.length - 1));
    return railTurns[railIndex]?.turnId ?? null;
  };

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || turns.length === 0) return;

    const idByElement = new Map<Element, string>();
    const visible = new Set<string>();
    const observeElement = (element: Element): void => {
      const turnId = element.getAttribute('data-turn-id');
      if (!turnId || !turnIndexById.has(turnId) || idByElement.has(element)) return;
      idByElement.set(element, turnId);
      observer.observe(element);
    };
    const unobserveElement = (element: Element): void => {
      const turnId = idByElement.get(element);
      if (!turnId) return;
      idByElement.delete(element);
      visible.delete(turnId);
      observer.unobserve(element);
    };
    const visitTurnElements = (node: Node, visit: (element: Element) => void): void => {
      if (!(node instanceof Element)) return;
      if (node.hasAttribute('data-turn-id')) visit(node);
      for (const element of node.querySelectorAll('[data-turn-id]')) visit(element);
    };
    const activeFor = (turnId: string | null): void => {
      if (turnId === null) return;
      const railTurnId = railTurnIdFor(turnId);
      if (railTurnId !== null) markActiveTurn(railTurnId);
    };
    const resolveActive = (): void => {
      // A jump owns the highlight until its scroll settles. Without this the
      // observer walks the highlight through every prompt the scroll passes,
      // which is the travelling the click was meant to skip.
      if (jumpTargetRef.current !== null) return;
      if (root.scrollHeight - root.scrollTop - root.clientHeight <= SCROLL_END_EPSILON_PX) {
        let latest: string | null = null;
        let latestIndex = -1;
        for (const turnId of idByElement.values()) {
          const index = turnIndexById.get(turnId) ?? -1;
          if (index > latestIndex) {
            latest = turnId;
            latestIndex = index;
          }
        }
        activeFor(latest);
        return;
      }
      let firstVisible: string | null = null;
      let firstIndex = Number.POSITIVE_INFINITY;
      for (const turnId of visible) {
        const index = turnIndexById.get(turnId) ?? Number.POSITIVE_INFINITY;
        if (index < firstIndex) {
          firstVisible = turnId;
          firstIndex = index;
        }
      }
      activeFor(firstVisible);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = idByElement.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        resolveActive();
      },
      { root, rootMargin: '0px 0px -66% 0px', threshold: 0 },
    );
    for (const element of root.querySelectorAll('[data-turn-id]')) observeElement(element);

    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) visitTurnElements(node, unobserveElement);
        for (const node of record.addedNodes) visitTurnElements(node, observeElement);
      }
      resolveActive();
    });
    mutationObserver.observe(root, { childList: true, subtree: true });

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
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [markActiveTurn, scrollRef, turnIndexById, railTurns]);

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
  }, [turns]);

  // A click owns the highlight until the destination settles, so the scroll it
  // started cannot walk the active tick through every prompt on the way. Keyed
  // on the jump sequence so a second click starts its own claim.
  //
  // The hold re-aims through virtual-window geometry changes and reports back
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
    // Before the scroll, not after: auto-follow has to be released while the
    // transcript is still where the reader left it, or the release lands after
    // it has already pulled the view back to the bottom.
    onNavigateStart?.();
    // Claimed before the scroll starts: a same-frame `scroll` event would
    // otherwise reach the observer while the highlight is still unowned.
    jumpTargetRef.current = turnId;
    if (el && 'scrollIntoView' in el) {
      // Instant, whatever the app's scroll-motion policy says. A jump is a
      // teleport the reader asked for, not a journey — and an animated one
      // does not survive this surface: traced against a 30-prompt session, the
      // smooth scroll was cancelled by the mount's own scroll compensation and
      // by auto-follow's spring, and stalled two pixels from where it started.
      // Landing reliably beats animating unreliably.
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
          const isActive = turn.turnId === activeTurnIdRef.current;
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
