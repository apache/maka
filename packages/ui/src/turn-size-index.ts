/**
 * Measured turn geometry, remembered across session switches (#2224).
 *
 * The progressive mount (#2052) starts a revisited session with no geometry
 * for the unmounted prefix, so the scroller's height grows during the idle
 * fill and the native scrollbar visibly shrinks and jumps. Remounting also
 * discards the sizes content-visibility had remembered, so the warm-up had
 * to learn the same geometry again.
 *
 * A record keeps each turn's own height plus the list's between-turn gap,
 * keyed by session and by the layout the measurement was taken under. A
 * revisit under the same layout holds the unmounted prefix with one spacer
 * and seeds each turn's contain-intrinsic-size; a first visit, a changed
 * layout, or a missing turn yields no answer and the caller falls back to
 * the plain fill and warm-up path.
 *
 * Deliberately in-memory and bounded, one entry per session (a session's
 * record is replaced, never accumulated per layout): geometry is cheap to
 * relearn, so the index is a cache, not a store.
 */

export interface TurnGeometryRecord {
  /** Each turn's own border-box height, unrounded. */
  readonly heights: ReadonlyMap<string, number>;
  /** The list's between-turn gap, so a spacer can stand in for N turns
   *  plus the N-1 gaps between them. */
  readonly gap: number;
}

export interface TurnSizeIndex {
  record(sessionKey: string, layoutKey: string, geometry: TurnGeometryRecord): void;
  lookup(sessionKey: string, layoutKey: string): TurnGeometryRecord | undefined;
}

export function createTurnSizeIndex(capacity = 12): TurnSizeIndex {
  const sessions = new Map<string, { layoutKey: string; geometry: TurnGeometryRecord }>();
  return {
    record(sessionKey, layoutKey, geometry) {
      if (geometry.heights.size === 0) return;
      sessions.delete(sessionKey);
      sessions.set(sessionKey, { layoutKey, geometry });
      while (sessions.size > capacity) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    },
    lookup(sessionKey, layoutKey) {
      const entry = sessions.get(sessionKey);
      if (!entry || entry.layoutKey !== layoutKey) return undefined;
      return entry.geometry;
    },
  };
}

/** One key per geometry-relevant layout: measurements do not survive a
 *  width or density change. */
export function layoutKeyFor(width: number, density: string | undefined): string {
  return `${Math.round(width)}:${density ?? ''}`;
}

/**
 * Height of the spacer standing in for the unmounted prefix, or undefined
 * when any prefix turn lacks a measurement. All-or-nothing on purpose: a
 * partially estimated spacer would still let the total height wander, which
 * is the symptom this index exists to remove.
 *
 * The spacer replaces `start` turns and the gaps BETWEEN them; the gap that
 * joins it to the first mounted turn is the list's own and is not counted.
 */
export function prefixHeightFor(
  turnIds: readonly string[],
  start: number,
  geometry: TurnGeometryRecord | undefined,
): number | undefined {
  if (start <= 0) return 0;
  if (!geometry) return undefined;
  let total = (start - 1) * geometry.gap;
  for (let index = 0; index < start; index += 1) {
    const height = geometry.heights.get(turnIds[index]!);
    if (height === undefined) return undefined;
    total += height;
  }
  return Math.round(total);
}

/** The DOM surface the measurement reads, structurally typed so the guards
 *  are testable without a real scroller (same pattern as the warm-up). */
export interface GeometryRoot {
  readonly clientWidth: number;
  readonly dataset: { turnWarmup?: string; density?: string };
  querySelector(selectors: string): { clientWidth: number } | null;
  querySelectorAll(selectors: string): ArrayLike<GeometryTurnElement>;
}

export interface GeometryTurnElement {
  hasAttribute(qualifiedName: string): boolean;
  getAttribute(qualifiedName: string): string | null;
  getBoundingClientRect(): { top: number; height: number };
}

/**
 * The layout key of a live scroller. Turn heights are set by the reading
 * column's width, not the scroller's: the column is max-width capped and
 * centred, so chrome around the scroller (sidebar, panels) can change the
 * scroller's width without moving a single line break. Key on the column so
 * records survive that chrome.
 */
export function layoutKeyOf(root: GeometryRoot): string {
  const column = root.querySelector('.maka-chat-message-list');
  return layoutKeyFor((column ?? root).clientWidth, root.dataset.density);
}

export type SettledGeometryResult =
  | { status: 'pending' }
  | { status: 'aborted' }
  | { status: 'measured'; geometry: TurnGeometryRecord };

/**
 * One measurement attempt against a settled transcript. The guards are what
 * keep the cache honest, so they live here where a unit test can drive each
 * one deterministically:
 *
 * - `aborted` when the layout key moved since `startKey` was captured: the
 *   warm-up walked under the old width, so off-screen turns still report
 *   remembered sizes from it, and recording them under the new key would
 *   poison every future lookup there. Terminal; the next visit re-learns.
 * - `pending` while the warm-up has not settled: boxes are still moving,
 *   ask again later.
 * - `aborted` when the settled transcript has no measurable pair (a lone
 *   turn, or every turn still streaming). Terminal for the same reason the
 *   walk is done: nothing further will appear without a remount.
 *
 * Live-streaming turns are skipped, not aborted over: their boxes grow
 * every frame, but the turns around them are final.
 */
export function measureSettledGeometry(root: GeometryRoot, startKey: string): SettledGeometryResult {
  if (layoutKeyOf(root) !== startKey) return { status: 'aborted' };
  if (root.dataset.turnWarmup !== 'settled') return { status: 'pending' };
  const boxes: Array<{ turnId: string; top: number; height: number }> = [];
  for (const turn of Array.from(root.querySelectorAll('.maka-turn[data-turn-id]'))) {
    if (turn.hasAttribute('data-live-streaming')) continue;
    const turnId = turn.getAttribute('data-turn-id');
    if (!turnId) continue;
    const rect = turn.getBoundingClientRect();
    boxes.push({ turnId, top: rect.top, height: rect.height });
  }
  const geometry = measureTurnGeometry(boxes);
  return geometry ? { status: 'measured', geometry } : { status: 'aborted' };
}

/**
 * Build a record from mounted turn boxes, in document order. The gap is
 * taken from the space between adjacent boxes; without at least one
 * adjacent settled pair there is no gap to learn and nothing is recorded.
 */
export function measureTurnGeometry(
  boxes: ReadonlyArray<{ turnId: string; top: number; height: number }>,
): TurnGeometryRecord | undefined {
  if (boxes.length < 2) return undefined;
  const heights = new Map<string, number>();
  const gaps: number[] = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index]!;
    heights.set(box.turnId, box.height);
    const next = boxes[index + 1];
    if (next) gaps.push(next.top - box.top - box.height);
  }
  gaps.sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)]!;
  if (!(gap >= 0)) return undefined;
  return { heights, gap };
}
