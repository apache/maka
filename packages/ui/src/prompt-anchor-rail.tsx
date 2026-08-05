import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/**
 * Chromium keeps sub-pixel scroll offsets, so a scroller flush with its own
 * end can report a distance of 1 rather than 0 (`scroll-geometry.spec.ts`
 * documents the same reading). Astryx's own scroll-spy allows 2; match it.
 */
const SCROLL_END_EPSILON_PX = 2;

/**
 * How far the dock-style hover falloff reaches, in ticks. The hovered tick is
 * at 0 and grows most; each neighbour out to this distance grows less. Ticks
 * beyond it — and every tick while the pointer is away — sit at rest width,
 * which is why this doubles as the resting proximity.
 */
const HOVER_FALLOFF_TICKS = 3;

export interface PromptAnchorRailTurn {
  turnId: string;
  /** The user prompt text for this turn; used as the hover preview + a11y label. */
  label: string;
  /** The start of the assistant reply, shown under the prompt in the preview. */
  reply?: string;
}

export interface PromptAnchorRailProps {
  turns: readonly PromptAnchorRailTurn[];
  /** The scroll container that holds the `[data-turn-id]` turn sections. */
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * #2052: called when a clicked turn has no `[data-turn-id]` element yet.
   * The progressive mount keeps early turns out of the DOM until the idle
   * fill reaches them, so the owner mounts the turn and finishes the scroll.
   */
  onNavigateFallback?: (turnId: string) => void;
  /**
   * #2052: bumped whenever turn DOM membership changes without `turns`
   * changing, i.e. each idle fill step. The observer effect below re-snapshots
   * on it so newly mounted turns are observed too.
   */
  mountedTurnsRevision?: number;
}

/**
 * A slim right-edge rail with one tick per user prompt — jump between your
 * questions in a long conversation (Codex / ChatGPT style). Reuses the
 * `[data-turn-id]` anchors the chat view already renders, so a click just
 * scrolls the target turn into view; an IntersectionObserver highlights the
 * tick whose turn is currently at the top of the viewport.
 *
 * The rail is pinned to the scrollport by the zero-height sticky anchor it
 * renders into, not by `position: absolute` against the chat shell. Astryx's
 * ChatLayout owns the scroll container and the whole transcript — chat shell
 * included — now lives *inside* it, so an absolutely positioned rail resolves
 * against a box as tall as the conversation and scrolls away with it. See
 * `styles/prompt-rail.css` for the geometry the anchor establishes.
 */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef, onNavigateFallback, mountedTurnsRevision }: PromptAnchorRailProps): React.ReactElement | null {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  // The scrollport height and the height of Astryx's sticky composer dock.
  // Centring on the bare scrollport ran the lower ticks under the dock — up to
  // 122px of overlap at an 860x617 window — so the rail centres on, and is
  // capped to, what is left above it. Neither number is knowable in CSS and
  // neither is a constant: the dock grows with the composer's draft and with
  // the panels docked above it.
  const [safeArea, setSafeArea] = useState<{ scrollport: number; dock: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  // Which tick the pointer is on, so its neighbours can grow with it. Sibling
  // selectors cannot express this: Astryx's HoverCard wraps each tick in its
  // own `display: contents` element, so the ticks are not DOM siblings.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // Rebuilding this observer costs one querySelector + observe per turn over
  // the whole transcript, so it must not run per streamed token (#2030). What
  // keeps it from running is the caller: ChatView hands back the same array
  // while no rail-visible field moved. Keying the effect on that array is
  // therefore both the cheap check and the thing that fails loudly if the
  // caller ever stops reusing it. The progressive mount (#2052) changes turn
  // DOM membership WITHOUT changing the array, so the caller also bumps
  // `mountedTurnsRevision` per fill step; a bounded handful of re-snapshots
  // per session switch, never per token.
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
      // At the end of the scroller there is nothing left to read past, so the
      // final prompt is the current one — even when its turn is too short to
      // ever cross the activation band below. Without this, a one-line last
      // answer leaves `aria-current` stranded on the previous prompt with the
      // reader already at the bottom. Astryx's own scroll-spy resolves the end
      // of a scroller the same way.
      if (root.scrollHeight - root.scrollTop - root.clientHeight <= SCROLL_END_EPSILON_PX) {
        setActiveTurnId(turns[turns.length - 1]!.turnId);
        return;
      }
      // Otherwise the topmost prompt still in view is the "current" one.
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
      // Only count a turn as active once it reaches the top third of the
      // viewport, so the highlight tracks reading position, not mere presence.
      { root, rootMargin: '0px 0px -66% 0px', threshold: 0 },
    );
    for (const el of idByElement.keys()) observer.observe(el);

    // Reaching the bottom crosses no intersection boundary once the last turns
    // are already on screen, so the observer alone never hears about it.
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
    const tick = rail.querySelector<HTMLElement>('.maka-prompt-rail-tick[data-active="true"]');
    if (!tick) return;
    const railBox = rail.getBoundingClientRect();
    const tickBox = tick.getBoundingClientRect();
    if (tickBox.top < railBox.top) rail.scrollTop -= railBox.top - tickBox.top;
    else if (tickBox.bottom > railBox.bottom) rail.scrollTop += tickBox.bottom - railBox.bottom;
  }, [activeTurnId]);

  function jumpTo(turnId: string): void {
    const el = scrollRef.current?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (!el) {
      onNavigateFallback?.(turnId);
    }
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
            // HoverCard, not a hand-positioned popover: it is portalled, so the
            // topmost and bottommost ticks no longer push their preview off the
            // window edge, and the card arrives with the theme's own surface.
            // (Tooltip portals too, but its palette is deliberately inverted
            // for short strings; this is a prompt plus a slice of its reply.)
            <HoverCard
              key={turn.turnId}
              placement="start"
              content={
                <span className="maka-prompt-rail-preview">
                  <span className="maka-prompt-rail-preview-prompt">{preview}</span>
                  {replyPreview ? (
                    <span className="maka-prompt-rail-preview-reply">{replyPreview}</span>
                  ) : null}
                </span>
              }
            >
              <button
                type="button"
                className="maka-prompt-rail-tick"
                data-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'true' : undefined}
                aria-label={copy.jumpToPrompt(preview)}
                onClick={() => jumpTo(turn.turnId)}
                onPointerEnter={() => setHoveredIndex(index)}
                style={
                  {
                    '--maka-prompt-rail-index': index,
                    '--maka-prompt-rail-proximity': proximity,
                  } as CSSProperties
                }
              >
                {/* The bar is its own element, not a `::after`, because the
                    travelling highlight anchors to it — and a pseudo-element
                    cannot be an anchor. It cannot anchor to the button either:
                    the HoverCard puts its own `anchor-name` there, inline,
                    which wins over any rule of ours. */}
                <span className="maka-prompt-rail-tick-bar" />
              </button>
            </HoverCard>
          );
        })}
        {/* The travelling highlight. It is one element anchored to whichever
            tick is active rather than a state on the tick itself, so changing
            the active prompt moves a bar the reader can follow instead of
            swapping two static ones. */}
        <span className="maka-prompt-rail-indicator" aria-hidden="true" />
      </nav>
    </div>
  );
});
