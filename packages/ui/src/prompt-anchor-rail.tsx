import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
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

/** Quiet frames after the transcript is filled that end a jump's hold. */
const JUMP_SETTLE_QUIET_FRAMES = 3;
/**
 * Frames a hold may run before it gives up regardless. Only a backstop against
 * a transcript that never reports itself filled — the fill boundary is what
 * normally ends the hold, and this is ~4s at 60Hz.
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
 *  - The progressive mount's own scroll compensation, which holds the reader's
 *    position across each fill step. Mounting the turn a jump asked for is
 *    itself a fill step, so the compensation lands after the scroll and
 *    restores the position the jump just left.
 *
 * Re-aiming outlasts both: through each fill step, and once more if a still
 * frame finds the target off the top edge, which is what a scroll cancelled
 * part-way leaves behind. A frame where nothing moved and the target is where
 * the click asked costs one `getBoundingClientRect` and nothing else.
 *
 * `releaseAutoFollow` runs on every frame of the hold rather than once at the
 * click, because Astryx re-locks on any `scrollend` that settles near the
 * bottom — and a jump out of a session that opens at the bottom produces
 * exactly that while the mount is still catching up, so a single release is
 * undone before the jump has gone anywhere. Traced: released at the click,
 * re-aimed to the target at 154ms, dragged back to the bottom by 166ms.
 *
 * The hold ends on the progressive mount's own boundary — the transcript
 * reporting itself filled, then holding still for a few frames — rather than
 * on a clock, so a long transcript is not released mid-fill. It also ends the
 * moment the reader touches the transcript: a jump may outlive its own scroll,
 * but it must never outlive the reader's interest in it.
 */
export function holdJumpDestination(input: {
  root: Element;
  readTargetId: () => string | null;
  /** Progressive mount has every turn in the DOM (ChatView's `turnsFilled`). */
  isTranscriptFilled: () => boolean;
  /** Astryx's auto-follow release, re-asserted for the life of the hold. */
  releaseAutoFollow?: (() => void) | undefined;
  onSettled: () => void;
  scheduler?: PromptRailFrameScheduler;
}): () => void {
  const { root, readTargetId, isTranscriptFilled, releaseAutoFollow, onSettled } = input;
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

  const reaim = (): boolean => {
    const turnId = readTargetId();
    if (turnId === null) return false;
    const target = root.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (!target) return false;
    const offset = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (Math.abs(offset) <= JUMP_LANDED_TOLERANCE_PX) return false;
    const before = root.scrollTop;
    // `auto`: this is a correction, not a second journey.
    (target as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'start' });
    lastTop = root.scrollTop;
    // A correction that moves nothing means the target is as close to the top
    // as this scroller can put it — the last turn of a transcript cannot reach
    // it at all. Report it as landed, or the hold would keep trying until its
    // frame budget ran out.
    return root.scrollTop !== before;
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
    // Growth is the mount working through the transcript; re-aim through it.
    // A still frame that is nonetheless off-target is the other failure: a
    // scroll that was cancelled part-way and will never resume on its own,
    // which is what happens when the mount's compensation lands on top of one.
    const corrected = grew || (!moved && isTranscriptFilled()) ? reaim() : false;
    // Quiet means nothing moved at all — not the content, not the position.
    // Height alone was not enough: with the transcript already mounted there
    // is nothing to re-aim through, and the hold released three frames in,
    // handing the highlight and the auto-follow release back while the jump's
    // own scroll was still in flight.
    if (!grew && !moved && !corrected && isTranscriptFilled()) quietFrames += 1;
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
  /** When progressive mount has not yet placed the turn in the DOM. */
  onNavigateFallback?: (turn: PromptAnchorRailTurn) => void;
  /** Bumped when turn DOM membership changes without `turns` changing. */
  mountedTurnsRevision?: number;
  /**
   * Release Astryx's auto-follow before a jump scrolls.
   *
   * ChatLayout keeps the transcript pinned to the bottom while a turn streams
   * and unlocks when the reader scrolls up, which it detects by comparing
   * scrollTop between scroll events — but it discards any scroll event that
   * arrives with a changed scrollHeight, since Chrome fires those on content
   * resize and they are not the reader moving. A jump into a turn the
   * progressive mount has not reached has to mount it first, so its own scroll
   * always arrives with a changed height and is discarded: auto-follow stays on
   * and pulls the transcript back to the bottom.
   */
  onNavigateStart?: (() => void) | undefined;
  /**
   * Progressive mount has placed every turn in the DOM (ChatView's
   * `turnsFilled`). A jump holds its destination until this goes true and the
   * transcript stops moving; see `holdJumpDestination`.
   */
  transcriptFilled?: boolean;
}

/** Right-edge rail: one tick per user prompt, scrolls to `[data-turn-id]`. */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef, onNavigateFallback, mountedTurnsRevision, onNavigateStart, transcriptFilled }: PromptAnchorRailProps): React.ReactElement | null {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [safeArea, setSafeArea] = useState<{ scrollport: number; dock: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
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
  // Read by the hold, which outlives the render that started it.
  const transcriptFilledRef = useRef(transcriptFilled ?? true);
  transcriptFilledRef.current = transcriptFilled ?? true;
  const onNavigateStartRef = useRef(onNavigateStart);
  onNavigateStartRef.current = onNavigateStart;

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || turns.length === 0) return;

    const idByElement = new Map<Element, string>();
    for (const turn of turns) {
      const el = root.querySelector(`[data-turn-id="${CSS.escape(turn.turnId)}"]`);
      if (el) idByElement.set(el, turn.turnId);
    }
    if (idByElement.size === 0) return;

    const visible = new Set<string>();
    const resolveActive = (): void => {
      // A jump owns the highlight until its scroll settles. Without this the
      // observer walks the highlight through every prompt the scroll passes,
      // which is the travelling the click was meant to skip — suppressing the
      // glide alone would only turn one long slide into a burst of hops.
      if (jumpTargetRef.current !== null) return;
      if (root.scrollHeight - root.scrollTop - root.clientHeight <= SCROLL_END_EPSILON_PX) {
        setActiveTurnId(Array.from(idByElement.values()).at(-1) ?? null);
        return;
      }
      const firstVisible = turns.find((turn) => visible.has(turn.turnId));
      if (firstVisible) setActiveTurnId(firstVisible.turnId);
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
    for (const el of idByElement.keys()) observer.observe(el);

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
      root.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRef, turns, mountedTurnsRevision]);

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
    if (!rail || activeTurnId === null) return;
    return observeActivePromptRailVisibility(rail);
  }, [activeTurnId, turns]);

  // The highlight glides between prompts because the reader is following it as
  // the transcript scrolls under it. A click is the opposite: the reader picked
  // the destination, so the highlight switches there once and holds, and the
  // scroll the click started moves underneath it without moving it. The `jump`
  // state (the CSS side) kills the glide for that one switch; `jumpTargetRef`
  // (read by the observer above) is what keeps the scroll from walking the
  // highlight through every prompt it passes on the way. Keyed on the jump's
  // sequence, so a second click starts its own claim rather than inheriting
  // the remains of the first one's.
  //
  // The claim ends where the progressive mount does, not on a clock: the hold
  // below re-aims through the fill and reports back when the transcript is
  // filled and still, or when the reader takes it back.
  useEffect(() => {
    if (!jump) return;
    const root = scrollRef.current;
    if (!root) return;
    return holdJumpDestination({
      root,
      readTargetId: () => jumpTargetRef.current,
      isTranscriptFilled: () => transcriptFilledRef.current,
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
    setActiveTurnId(turnId);
  }

  // A rail is only useful once there are a few prompts to jump between.
  if (turns.length < 3) return null;

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
        data-jumping={jump ? 'true' : undefined}
        ref={railRef}
        onPointerLeave={() => setHoveredIndex(null)}
      >
        {turns.map((turn, index) => {
          const isActive = turn.turnId === activeTurnId;
          const preview = turn.label.trim() || copy.emptyPrompt;
          const replyPreview = (turn.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
          const proximity =
            hoveredIndex === null
              ? HOVER_FALLOFF_TICKS
              : Math.min(Math.abs(index - hoveredIndex), HOVER_FALLOFF_TICKS);
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
                data-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => jumpTo(turn)}
                onPointerEnter={() => setHoveredIndex(index)}
                style={
                  {
                    '--maka-prompt-rail-index': index,
                    '--maka-prompt-rail-proximity': proximity,
                  } as CSSProperties
                }
              >
                <span className="maka-prompt-rail-tick-bar" />
              </Button>
            </HoverCard>
          );
        })}
        <span className="maka-prompt-rail-indicator" aria-hidden="true" />
      </nav>
    </div>
  );
});
