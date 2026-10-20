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

import { MakaWordmark } from './maka-wordmark.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy, type DayPeriod } from './conversation-copy.js';
export type { DayPeriod } from './conversation-copy.js';

/**
 * PR-UI-LAYOUT-4 / B1-a1 review fixup (@kenji msg 1d7ba56c):
 * Compute the day-period bucket from a millisecond epoch timestamp,
 * not from `new Date()`. E2e-fixture renders freeze `Date.now()`
 * to a deterministic value (see `applyE2eFixture` in
 * `apps/desktop/src/renderer/main.tsx`) but do NOT freeze the
 * `Date` constructor itself; reading `new Date()` directly would
 * pick up the host clock and let the rendered fixture drift at the
 * 11:00 / 14:00 / 18:00 boundaries.
 *
 * Default arg is `Date.now()`, which the e2e-fixture renderer
 * replaces with `state.now`. Tests pass an explicit timestamp.
 * Exported so the day-period boundary contract is reachable from
 * `apps/desktop/src/main/__tests__/empty-hero-day-period.test.ts`.
 */
export function detectDayPeriod(nowMs: number = Date.now()): DayPeriod {
  const hour = new Date(nowMs).getHours();
  if (hour < 5) return 'evening';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export function EmptyChatHero(props: {
  onPromptSuggestion?(prompt: string): void;
  userLabel?: string;
}) {
  // Greet the user by name when they've set one in Personalization Settings.
  // Falls back to a neutral title so first-run users don't see "Hi 你, …".
  //
  // PR-REFERENCE_APP-HERO-0: the normal empty chat page now follows the
  // reference implementation single-card pattern: calm copy above the one real composer
  // card, without a grid of starter chips competing for the first
  // viewport. `onPromptSuggestion` stays in the signature for callers
  // that still pass it, but the generic empty-chat surface no longer
  // renders suggestions.
  const label = props.userLabel?.trim();
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).empty;
  // PR-UI-LAYOUT-4: time-of-day greeting prefix. `detectDayPeriod`
  // reads the user's local clock at render time; we don't memo
  // because the hero is short-lived and React will re-render when
  // the user navigates back into it.
  const period = detectDayPeriod();
  const greeting = copy.greeting[period];
  const greetingTail = copy.greetingTail[period];
  // #1433: the visual used to be two chat bubbles plus a Maka/user avatar
  // pair — a staged conversation the user never had. It read as real
  // content on the one surface that has none, so it went; the wordmark
  // takes its place as the surface's anchor. The product-pitch line under
  // the greeting went with it: the daily empty chat is where returning
  // users land, and they do not need the product explained every time.
  return (
    <section className="maka-hero maka-hero-empty-chat" aria-label={copy.ariaLabel}>
      {/* 160px puts the mark's cap height at ~42px against the 25px
          greeting — a 1.7:1 ratio that reads as anchor-then-line. At the
          104px it shipped with, the two were within 8% of each other and
          neither led. */}
      <div className="maka-hero-visual">
        <MakaWordmark width={160} />
      </div>
      <header>
        <h1>
          {label ? copy.headlineWithLabel(greeting, label) : copy.headlineFallback(greeting, greetingTail)}
        </h1>
      </header>
    </section>
  );
}
