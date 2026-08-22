/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Small pure helpers backing the chat surface (TurnView,
 * RelativeTime, AssistantAnswerBubble, etc.) —
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
 * the answer bubble's rendering lifecycle; the bundle now
 * sits as short pure functions easy to unit-test in isolation.
 *
 * PR-CHAT-CHROME-FOLLOWUP-0: `messageRoleLabel` / `avatarInitial`
 * were removed — the chat surface dropped per-message avatars and
 * name labels (MessageMeta), leaving both helpers with zero call
 * sites.
 */

import { uiLocaleToIntlLocale, type UiLocale } from '@maka/core/ui-locale';
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

/* `formatClockTime` (a 24-hour `HH:mm` for the user-message time) lived here
   until the meta row moved to Astryx's `Timestamp`. Locking the hour cycle was
   the app overriding a preference that belongs to the reader's system, which is
   why `Timestamp` formats against the host locale and offers no hour-cycle
   knob. Absolute readings now come from that component, not from a local bag of
   `Intl` options. */

/**
 * A turn's duration, counted in whole seconds: `0s`, `25s`, `1m 54s`.
 *
 * Deliberately NOT tool-activity's `formatDuration`, which resolves below the
 * second (`450 ms`, `8.2s`). That shape reports a span measured after the fact.
 * A turn's duration is first read while it advances, one second at a time, in
 * the live status line, and a counter must only show precision its own tick can
 * deliver — a tenths digit driven by a one-second timer moves in visible jumps,
 * and a millisecond reading claims an accuracy the interval never had. The
 * settled turn's meta tooltip uses the same shape rather than a finer one, so a
 * turn that read `25s` while it ran does not report a differently-rounded
 * number afterwards. Seconds truncate rather than round so the counter never
 * runs ahead of the time it reports.
 */
export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

export function turnAbortMarkerLabel(abortSource: string | undefined, locale: UiLocale): string {
  const copy = getConversationCopy(locale).messages;
  switch (abortSource) {
    case 'renderer.stop_button': return copy.abortedByStop;
    default: return copy.aborted;
  }
}
