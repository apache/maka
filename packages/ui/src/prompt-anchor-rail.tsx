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
  createContext,
  useContext,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@astryxdesign/core/Button';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { useTranscriptScrollAuthority } from './transcript-scroll-authority.js';

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

interface PromptRailResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
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
  /** Optional host identity color; ordinary Session ticks remain neutral. */
  accentColor?: string;
  highlighted?: boolean;
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
  /** Presentation-only hover/focus linkage; never navigates the transcript. */
  onHighlightTurn?: (turn: PromptAnchorRailTurn | undefined) => void;
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

/**
 * The tick for a reading position the rail may not have sampled. Past its cap
 * the rail shows one tick per few Turns, so it projects the reader's Turn onto
 * the sampled positions the same way the sampling picked them.
 */
export function selectPromptRailTick(input: {
  readingTurnId: string | undefined;
  orderedTurnIds: readonly string[];
  railTurnIds: readonly string[];
  previousRailTurnId: string | null;
}): string | null {
  const { readingTurnId, orderedTurnIds, railTurnIds } = input;
  if (readingTurnId !== undefined) {
    if (railTurnIds.includes(readingTurnId)) return readingTurnId;
    const readingIndex = orderedTurnIds.indexOf(readingTurnId);
    if (readingIndex !== -1 && orderedTurnIds.length > 1 && railTurnIds.length > 1) {
      return railTurnIds[Math.round(
        readingIndex * (railTurnIds.length - 1) / (orderedTurnIds.length - 1),
      )] ?? null;
    }
  }
  // An unknown reading position — a Turn the rail has no landmark for, or none
  // reported yet — leaves the current tick alone rather than jumping it home.
  return input.previousRailTurnId !== null && railTurnIds.includes(input.previousRailTurnId)
    ? input.previousRailTurnId
    : null;
}

/** The scroll layout owns the rail's full-width sticky anchor. */
export const PromptAnchorRailHostContext = createContext<HTMLElement | null>(null);

/** Right-edge rail: bounded prompt landmarks that scroll to `[data-turn-id]`. */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef, onNavigateFallback, onNavigateStart, onHighlightTurn }: PromptAnchorRailProps): React.ReactElement | null {
  const host = useContext(PromptAnchorRailHostContext);
  const copy = getConversationCopy(useUiLocale()).sessions;
  const authority = useTranscriptScrollAuthority();
  const snapshot = useSyncExternalStore(
    authority.subscribe,
    authority.getSnapshot,
    authority.getSnapshot,
  );
  const [safeArea, setSafeArea] = useState<{ scrollport: number; dock: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const previousActiveRailTurnIdRef = useRef<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const activeVisibilityFrame = useRef(0);
  // Prompt/reply text changes while an answer streams, but the tick layout only
  // depends on Turn identity and order. Keep that structural value stable so a
  // text delta does not rebuild the sampling.
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
  const activeRailTurnId = selectPromptRailTick({
    // Pinned to the tail, the reader is on the newest Turn, whichever one
    // happens to cross the top of the scrollport.
    readingTurnId: snapshot.pinned ? orderedTurnIds.at(-1) : snapshot.readingTurnId,
    orderedTurnIds,
    railTurnIds,
    previousRailTurnId: previousActiveRailTurnIdRef.current,
  });
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
  }, [activeRailTurnId, host]);

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
  }, [orderedTurnIds, host]);

  function jumpTo(turn: PromptAnchorRailTurn): void {
    const root = scrollRef.current;
    const el = root?.querySelector(`[data-turn-id="${CSS.escape(turn.turnId)}"]`);
    // Before the scroll, not after: the tail has to be released while the
    // transcript is still where the reader left it, or the release lands after
    // the next growth has already written the view back to the bottom.
    onNavigateStart?.();
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
  }

  // A rail is only useful once there are a few prompts to jump between.
  if (railTurns.length < 3 || !host) return null;

  const rail = (
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
        onPointerLeave={() => { setHoveredIndex(null); onHighlightTurn?.(undefined); }}
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
                data-highlighted={turn.highlighted || undefined}
                data-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => jumpTo(turn)}
                onPointerEnter={() => { setHoveredIndex(index); onHighlightTurn?.(turn); }}
                onFocus={() => onHighlightTurn?.(turn)}
                onBlur={() => onHighlightTurn?.(undefined)}
                style={
                  {
                    color: turn.accentColor,
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
  return createPortal(rail, host);
});
