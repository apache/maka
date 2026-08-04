/**
 * Pure helpers for the Claude subscription OAuth service. Split out from
 * `claude-subscription-service.ts` so unit tests can import them without
 * dragging in the `electron` ESM module (which is not loadable from
 * node --test directly). Mirrors the claude service helpers split.
 */

/**
 * Whether the Claude subscription card is enabled at all in this build.
 * Opt-out shape: enabled unless the env flag is explicitly '0'.
 */
export function isSubscriptionExperimentalEnabled(): boolean {
  return process.env.MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL !== '0';
}
