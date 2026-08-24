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
 * Scroll motion policy helper (PR109f).
 *
 * Centralizes the rule for whether a `scrollIntoView` / scroll-driven
 * animation should collapse to `auto` (no animation) vs. `smooth`.
 * Extracted so the rule can be unit-tested without a DOM.
 *
 * Three triggers collapse motion:
 *   1. `data-maka-reduced-motion="true"` on the document root — set by
 *      the PR-IR-04 reduced variant of the e2e-fixture fixture.
 *   2. `data-maka-e2e-fixture="true"` on the document root — set by
 *      ANY e2e-fixture capture (@xuan PR109f confirmed e2e-fixture
 *      always writes this attribute; the reduced-motion attr is only
 *      set on the reduced variant). This is the broader signal for
 *      "deterministic capture, no animations".
 *   3. OS-level `prefers-reduced-motion: reduce` user preference.
 *
 * The helper accepts the inputs as plain values so the caller decides
 * how to extract them (DOM in app code, fixtures in tests).
 */

export type ScrollMotionBehavior = 'auto' | 'smooth';

export interface ScrollMotionPolicyInputs {
  /** `document.documentElement.dataset.makaReducedMotion === 'true'` */
  reducedMotionAttr: boolean;
  /** `document.documentElement.dataset.makaE2eFixture === 'true'` */
  e2eFixtureAttr: boolean;
  /** `window.matchMedia('(prefers-reduced-motion: reduce)').matches` */
  prefersReducedMotion: boolean;
  /**
   * `document.documentElement.dataset.makaScrollMotion`, set by a fixture that
   * asks for a specific behavior.
   *
   * Collapsing motion for every capture is right for a screenshot and wrong
   * for a test about scrolling: a scroll that finishes in one frame cannot
   * collide with anything, so the fixture suite had no way to exercise the
   * production smooth path at all (`prompt-rail.spec.ts` needs it — Astryx's
   * auto-follow lock only contends with a scroll still in flight). This lets
   * one fixture opt back in without loosening the default for the rest.
   *
   * Deliberately below the reduced-motion triggers: a fixture may ask for
   * motion the capture would otherwise skip, but nothing may override a
   * stated preference for less of it.
   */
  scrollMotionAttr?: ScrollMotionBehavior | undefined;
}

/**
 * Returns the scroll behavior the caller should pass to
 * `scrollIntoView({ behavior })`.
 *
 * Pure function — no DOM access. Caller resolves the three input
 * flags from whatever environment they're in.
 */
export function resolveScrollMotionBehavior(inputs: ScrollMotionPolicyInputs): ScrollMotionBehavior {
  if (inputs.reducedMotionAttr || inputs.prefersReducedMotion) {
    return 'auto';
  }
  if (inputs.scrollMotionAttr) {
    return inputs.scrollMotionAttr;
  }
  if (inputs.e2eFixtureAttr) {
    return 'auto';
  }
  return 'smooth';
}

/**
 * Convenience wrapper that reads from `document` + `window`. Browser-
 * side only. Use this in renderer code; use `resolveScrollMotionBehavior`
 * directly in tests.
 */
export function readScrollMotionBehavior(): ScrollMotionBehavior {
  const root = document.documentElement;
  const prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const requested = root.dataset.makaScrollMotion;
  return resolveScrollMotionBehavior({
    reducedMotionAttr: root.dataset.makaReducedMotion === 'true',
    e2eFixtureAttr: root.dataset.makaE2eFixture === 'true',
    prefersReducedMotion,
    scrollMotionAttr: requested === 'smooth' || requested === 'auto' ? requested : undefined,
  });
}
