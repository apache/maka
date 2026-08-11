import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/** Match Astryx scroll-spy: Chromium sub-pixel scroll end can read 1px short. */
const SCROLL_END_EPSILON_PX = 2;
/** Hover falloff radius in ticks (0 = hovered). */
const HOVER_FALLOFF_TICKS = 3;

export interface PromptAnchorRailTurn {
  turnId: string;
  label: string;
  reply?: string;
}

export interface PromptAnchorRailProps {
  turns: readonly PromptAnchorRailTurn[];
  scrollRef: RefObject<HTMLElement | null>;
  scrollBehavior: ScrollBehavior;
  /** When progressive mount has not yet placed the turn in the DOM. */
  onNavigateFallback?: (turnId: string) => void;
  /** Bumped when turn DOM membership changes without `turns` changing. */
  mountedTurnsRevision?: number;
}

/** Right-edge rail: one tick per user prompt, scrolls to `[data-turn-id]`. */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef, scrollBehavior, onNavigateFallback, mountedTurnsRevision }: PromptAnchorRailProps): React.ReactElement | null {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [safeArea, setSafeArea] = useState<{ scrollport: number; dock: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

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
      if (root.scrollHeight - root.scrollTop - root.clientHeight <= SCROLL_END_EPSILON_PX) {
        setActiveTurnId(turns[turns.length - 1]!.turnId);
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
      (el as HTMLElement).scrollIntoView({ behavior: scrollBehavior, block: 'start' });
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                label={copy.jumpToPrompt(preview)}
                className="maka-prompt-rail-tick"
                data-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => jumpTo(turn.turnId)}
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
