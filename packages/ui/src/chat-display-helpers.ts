/**
 * Small pure helpers backing the chat surface (TurnView,
 * RelativeTime, StreamingAssistantBubble, etc.) —
 * time formatters, turn duration + abort marker copy.
 *
 * PR-UI-LIB-EXTRACT-4 (round 5/10) introduced this module with a
 * deliberate ESM circular import on `./components.js` for
 * locale resolution. PR-UI-LIB-EXTRACT-5 (round 6/10) broke the
 * cycle by lifting locale helpers into a new `locale-helpers`
 * leaf module; this file now depends on that leaf instead.
 *
 * Why this seam: duration formatting has ms→s→m bucket rules, and
 * the abort-marker label is i18n-able copy. Each rule was
 * previously buried between TurnView's 200-line JSX block and
 * StreamingAssistantBubble's rendering lifecycle; the bundle now
 * sits as short pure functions easy to unit-test in isolation.
 *
 * PR-CHAT-CHROME-FOLLOWUP-0: `messageRoleLabel` / `avatarInitial`
 * were removed — the chat surface dropped per-message avatars and
 * name labels (MessageMeta), leaving both helpers with zero call
 * sites.
 */

import { uiLocaleToIntlLocale, type UiLocale } from '@maka/core';
import { getConversationCopy } from './conversation-copy.js';

function createAbsoluteTimeFormat(locale: UiLocale): Intl.DateTimeFormat {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return { format: (d: Date) => d.toISOString() } as unknown as Intl.DateTimeFormat;
  }
  return new Intl.DateTimeFormat(
    uiLocaleToIntlLocale(locale),
    { dateStyle: 'medium', timeStyle: 'short' },
  );
}

export function formatAbsoluteTimestamp(ts: number, locale: UiLocale): string {
  return createAbsoluteTimeFormat(locale).format(new Date(ts));
}

function createClockTimeFormat(locale: UiLocale): Intl.DateTimeFormat {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return { format: (d: Date) => d.toISOString().slice(11, 16) } as unknown as Intl.DateTimeFormat;
  }
  return new Intl.DateTimeFormat(
    uiLocaleToIntlLocale(locale),
    { hour: '2-digit', minute: '2-digit', hour12: false },
  );
}

/** Wall-clock `HH:mm` (24-hour), for the always-absolute user-message time. */
export function formatClockTime(ts: number, locale: UiLocale): string {
  return createClockTimeFormat(locale).format(new Date(ts));
}

export function formatTurnDuration(ms: number): string {
  // Same shape as tool-activity's formatDuration — the turn meta chip
  // and tool cards sit stacked in one view;「1 m 0 s」vs「8.2s」read as
  // two different products.
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function turnAbortMarkerLabel(abortSource: string | undefined, locale: UiLocale): string {
  const copy = getConversationCopy(locale).messages;
  switch (abortSource) {
    case 'renderer.stop_button': return copy.abortedByStop;
    default: return copy.aborted;
  }
}
