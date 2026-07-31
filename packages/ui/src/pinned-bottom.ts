export interface PinnedBottomViewport {
  scrollTop: number;
  readonly scrollHeight: number;
}

export interface PinnedBottomObserver {
  observe(element: Element, options?: MutationObserverInit): void;
  disconnect(): void;
}

export type PinnedBottomObserverFactory = (callback: () => void) => PinnedBottomObserver;

export interface PinnedBottomSizeObserver {
  observe(element: Element): void;
  disconnect(): void;
}

export type PinnedBottomSizeObserverFactory = (callback: () => void) => PinnedBottomSizeObserver;

export function resolvePinnedBottomScroll(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold: number;
  wasPinned: boolean;
  lastFollowedScrollTop?: number;
}): { pinned: boolean; shouldFollow: boolean } {
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  const followsLastWrite =
    input.wasPinned &&
    input.lastFollowedScrollTop !== undefined &&
    Math.abs(input.scrollTop - input.lastFollowedScrollTop) <= 1;
  return {
    pinned: followsLastWrite || distanceFromBottom <= input.threshold,
    shouldFollow: followsLastWrite && distanceFromBottom > input.threshold,
  };
}

/**
 * Follows the scroll content's actual commit clock. Streaming text is revealed
 * by requestAnimationFrame after raw deltas arrive, while OverlayScrollbars
 * keeps the outer content box viewport-sized; observing raw state or that fixed
 * box cannot keep a pinned viewport aligned with each visible growth step.
 *
 * Two channels feed the follower:
 * - a MutationObserver on the content subtree — streaming text and appended
 *   turns commit as DOM mutations;
 * - a ResizeObserver on the content's element children — render-skipped turns
 *   (`content-visibility: auto`) inflate from their 250px placeholder to
 *   their real height with NO mutation and no scroll event, which otherwise
 *   strands a pinned viewport mid-document after a long session mounts.
 */
export function createPinnedBottomFollower(options: {
  viewport: PinnedBottomViewport;
  content: Element;
  isPinned: () => boolean;
  onFollow?: (scrollTop: number) => void;
  createObserver?: PinnedBottomObserverFactory;
  createSizeObserver?: PinnedBottomSizeObserverFactory;
}): () => void {
  const follow = (): void => {
    if (!options.isPinned()) return;
    options.viewport.scrollTop = options.viewport.scrollHeight;
    options.onFollow?.(options.viewport.scrollTop);
  };
  const createObserver = options.createObserver
    ?? (typeof MutationObserver === 'function'
      ? (callback: () => void) => new MutationObserver(callback)
      : undefined);
  if (!createObserver) return () => {};
  const createSizeObserver = options.createSizeObserver
    ?? (typeof ResizeObserver === 'function'
      ? (callback: () => void) => new ResizeObserver(callback)
      : undefined);
  const sizeObserver = createSizeObserver?.(follow);
  const sizeObserved = new WeakSet<Element>();
  const observeNewChildren = (): void => {
    if (!sizeObserver) return;
    for (const child of options.content.children) {
      if (sizeObserved.has(child)) continue;
      sizeObserved.add(child);
      sizeObserver.observe(child);
    }
  };
  observeNewChildren();
  const observer = createObserver(() => {
    follow();
    observeNewChildren();
  });
  observer.observe(options.content, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    sizeObserver?.disconnect();
  };
}
