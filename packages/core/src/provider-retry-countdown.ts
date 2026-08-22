import type { ProviderRetryScheduledEvent } from './events.js';

/**
 * The one remaining-wait computation behind every provider retry countdown
 * surface (TUI activity strip, desktop banner). Extracted in #3393 after the
 * two client copies drifted apart at the expiry floor.
 *
 * `elapsedSinceReceiptMs` is measured on the CLIENT's own clock from the
 * moment the event entered the client projection, keeping the whole
 * computation in one clock domain; the granted length comes from the
 * skew-free `remainingMs` duration when the emitter provided one (older
 * emitters fall back to the full `delayMs`). Floors at zero: an expired
 * countdown reads `0s` on every surface until the `started` event replaces
 * it.
 */
export function providerRetryRemainingMs(
  retry: Pick<ProviderRetryScheduledEvent, 'delayMs' | 'remainingMs'>,
  elapsedSinceReceiptMs: number,
): number {
  const grantedMs = retry.remainingMs ?? retry.delayMs;
  return Math.max(0, grantedMs - Math.max(0, elapsedSinceReceiptMs));
}
