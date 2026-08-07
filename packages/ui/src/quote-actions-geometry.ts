/**
 * Fixed-mode placement for the selection quote actions layer.
 *
 * The layer hangs just above the selection's top edge. Keeping the offset in
 * one place makes the scroll-follow contract checkable: when the selection
 * moves by `d` and stays clear of the min clamp, the layer must move by `d`
 * too (#2379).
 */
export const QUOTE_ACTIONS_OFFSET_Y = 42;
export const QUOTE_ACTIONS_MIN_TOP = 8;

export function quoteActionsFixedTop(selectionTop: number): number {
  return Math.max(QUOTE_ACTIONS_MIN_TOP, selectionTop - QUOTE_ACTIONS_OFFSET_Y);
}
