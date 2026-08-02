import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * A live text selection inside the chat transcript, captured as a quotable
 * excerpt for the "quote this" affordance (Codex/Cursor-style). The `rect` is
 * the selection's viewport-space bounding box, used to position the floating
 * action near the selection.
 */
export interface MessageSelectionQuote {
  text: string;
  /** `data-turn-id` of the turn the selection sits in, when resolvable. */
  turnId?: string;
  rect: { top: number; left: number; bottom: number; right: number; width: number };
}

/**
 * Watches for a non-empty text selection within `scrollRef` (the messages
 * container) and exposes a captured snapshot as a
 * {@link MessageSelectionQuote}. The snapshot survives native selection
 * collapse so keyboard and accessibility activation can reach the action that
 * owns it; consumers explicitly clear it when that action is dismissed or
 * consumed. Scrolling still clears it because its rect would be stale.
 * Read-only: the hook never mutates the selection, so native copy still works.
 *
 * Listeners live on `document` and resolve `scrollRef.current` at event time —
 * binding them to the element instead would capture whatever the ref held on
 * the first effect run, and ChatView's empty state renders a different scroll
 * area before the transcript one exists, so the affordance would stay dead for
 * the rest of the session.
 */
export function useMessageSelectionQuote(
  scrollRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): { quote: MessageSelectionQuote | null; clear: () => void } {
  const [quote, setQuote] = useState<MessageSelectionQuote | null>(null);
  const clear = useCallback(() => setQuote(null), []);

  useEffect(() => {
    if (!enabled) return;

    function computeQuote(): MessageSelectionQuote | null {
      const root = scrollRef.current;
      if (!root) return null;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return null;
      let node: Node | null = range.commonAncestorContainer;
      let turnId: string | undefined;
      while (node && node !== root) {
        if (node instanceof HTMLElement && node.dataset.turnId) {
          turnId = node.dataset.turnId;
          break;
        }
        node = node.parentNode;
      }
      const box = range.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return null;
      return {
        text,
        ...(turnId ? { turnId } : {}),
        rect: {
          top: box.top,
          left: box.left,
          bottom: box.bottom,
          right: box.right,
          width: box.width,
        },
      };
    }

    function capture(): void {
      const nextQuote = computeQuote();
      if (nextQuote) setQuote(nextQuote);
    }

    // mouseup finalizes a drag-select; keyup covers keyboard (shift+arrow)
    // selection. These events only capture; dismissal and consumption own
    // clearing the snapshot. Scroll is capture-phase because it does not bubble.
    document.addEventListener('mouseup', capture);
    document.addEventListener('keyup', capture);
    document.addEventListener('scroll', clear, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mouseup', capture);
      document.removeEventListener('keyup', capture);
      document.removeEventListener('scroll', clear, { capture: true });
    };
  }, [scrollRef, enabled, clear]);

  return { quote, clear };
}
