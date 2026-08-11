import { cleanSessionRecapText, SESSION_RECAP_INSTRUCTION } from '@maka/runtime/session-recap';

export const RECAP_INSTRUCTION = SESSION_RECAP_INSTRUCTION;
export const cleanRecapText = cleanSessionRecapText;

/** Idle gap (ms) after which the first normal prompt on return triggers an automatic recap. */
export const AUTO_RECAP_IDLE_MS = 180_000;
/** Minimum main-turn count (user-prompted turns) before an automatic recap may fire. */
export const AUTO_RECAP_MIN_TURNS = 3;
/** Raw-output size (bytes) above which an automatic recap is not surfaced in the transcript (still persisted). */
export const AUTO_RECAP_DISPLAY_LIMIT_BYTES = 500;

/**
 * Cleans a raw model recap response: collapses whitespace, strips a leading
 * `Recap:` / `Summary:` / `回顾：`-style label, strips one layer of wrapping
 * quotes, and truncates to 1200 characters (with an ellipsis) if needed.
 */
export interface ShouldAutoRecapInput {
  /** Milliseconds since the last recorded user activity. */
  idleMs: number;
  /** Current main (user-prompted) turn count. */
  mainTurnCount: number;
  /** Main turn count as of the last recap (manual or automatic). */
  lastRecapMainTurnCount: number;
}

/**
 * Whether a normal-prompt submission after an idle gap should trigger an
 * automatic recap: idle for at least `AUTO_RECAP_IDLE_MS`, at least
 * `AUTO_RECAP_MIN_TURNS` main turns so far, and progress since the last recap
 * (a per-main-turn watermark).
 */
export function shouldAutoRecap(input: ShouldAutoRecapInput): boolean {
  return (
    input.idleMs >= AUTO_RECAP_IDLE_MS &&
    input.mainTurnCount >= AUTO_RECAP_MIN_TURNS &&
    input.mainTurnCount > input.lastRecapMainTurnCount
  );
}
