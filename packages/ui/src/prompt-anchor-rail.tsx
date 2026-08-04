import { memo, useEffect, useState, type RefObject } from 'react';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

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
}

/**
 * A slim right-edge rail with one tick per user prompt — jump between your
 * questions in a long conversation (Codex / ChatGPT style). Reuses the
 * `[data-turn-id]` anchors the chat view already renders, so a click just
 * scrolls the target turn into view; an IntersectionObserver highlights the
 * tick whose turn is currently at the top of the viewport.
 */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef }: PromptAnchorRailProps): React.ReactElement | null {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  // Rebuilding this observer costs one querySelector + observe per turn over
  // the whole transcript, so it must not run per streamed token (#2030). What
  // keeps it from running is the caller: ChatView hands back the same array
  // while no rail-visible field moved. Keying the effect on that array is
  // therefore both the cheap check and the thing that fails loudly if the
  // caller ever stops reusing it.
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
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = idByElement.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        // The topmost prompt still in view is the "current" one.
        const firstVisible = turns.find((turn) => visible.has(turn.turnId));
        if (firstVisible) setActiveTurnId(firstVisible.turnId);
      },
      // Only count a turn as active once it reaches the top third of the
      // viewport, so the highlight tracks reading position, not mere presence.
      { root, rootMargin: '0px 0px -66% 0px', threshold: 0 },
    );
    for (const el of idByElement.keys()) observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef, turns]);

  function jumpTo(turnId: string): void {
    const el = scrollRef.current?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setActiveTurnId(turnId);
  }

  // A rail is only useful once there are a few prompts to jump between.
  if (turns.length < 3) return null;

  return (
    <nav className="maka-prompt-rail" aria-label={copy.promptRailAriaLabel}>
      {turns.map((turn) => {
        const isActive = turn.turnId === activeTurnId;
        const preview = turn.label.trim() || copy.emptyPrompt;
        const replyPreview = (turn.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
        return (
          <button
            key={turn.turnId}
            type="button"
            className="maka-prompt-rail-tick"
            data-active={isActive ? 'true' : undefined}
            aria-current={isActive ? 'true' : undefined}
            aria-label={copy.jumpToPrompt(preview)}
            onClick={() => jumpTo(turn.turnId)}
          >
            <span className="maka-prompt-rail-preview" aria-hidden="true">
              <span className="maka-prompt-rail-preview-prompt">{preview}</span>
              {replyPreview ? (
                <span className="maka-prompt-rail-preview-reply">{replyPreview}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </nav>
  );
});
