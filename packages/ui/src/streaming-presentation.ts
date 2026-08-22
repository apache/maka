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
 * Maka's deterministic fixture contract is product-owned. Astryx handles the
 * real OS reduced-motion media query; these attributes cover only renderer
 * fixtures, whose captured content must not depend on animation timing.
 */
export function isProgressiveStreamingEnabled(streaming?: boolean): boolean {
  if (!streaming || typeof document === 'undefined') return streaming === true;
  return isTimeDrivenMotionEnabled();
}

const FROZEN_HOST_SELECTOR = '[data-maka-e2e-fixture="true"],[data-maka-reduced-motion="true"]';

/**
 * The same gate, for UI driven by the clock rather than by a stream: the live
 * turn's elapsed counter and its rotating working phrase.
 *
 * Progressive streaming re-renders because tokens arrive, so freezing it just
 * means "print the whole buffer at once". These two re-render because time
 * passed, which a fixture has no way to hold still — a capture taken a second
 * later differs from one taken now. Frozen, they never move at all.
 *
 * `within` matters because the CSS contract these attributes drive is written
 * with descendant selectors (`[data-maka-reduced-motion="true"] *`), so a host
 * is free to mark a SUBTREE rather than the document — Storybook marks its
 * shell frame, not `<html>`. Reading only the root agreed with the CSS in the
 * app and disagreed with it in exactly the place built to be deterministic:
 * motion capped to nothing, while a one-second timer kept running behind it.
 */
export function isTimeDrivenMotionEnabled(within?: Element | null): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  if (root.dataset.makaE2eFixture === 'true' || root.dataset.makaReducedMotion === 'true') return false;
  return within?.closest(FROZEN_HOST_SELECTOR) == null;
}
