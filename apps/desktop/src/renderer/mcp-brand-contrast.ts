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

// Dark-theme contrast gate for MCP library brand marks.
//
// simple-icons marks fill with their official brand hex in light theme. On the
// dark neutral plate (`--foreground-5`, which sits near the background in dark
// theme) a near-black brand hex disappears, so those marks fall back to
// currentColor. The decision is a pure luminance check — no hand-maintained
// brand list — so it stays honest as the catalog grows and is unit-testable in
// isolation (this module carries zero JSX / React).

/**
 * WCAG relative luminance of a `#rrggbb` (or `rrggbb`) hex, in [0, 1].
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
export function hexRelativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const toLinear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = toLinear(Number.parseInt(value.slice(0, 2), 16));
  const g = toLinear(Number.parseInt(value.slice(2, 4), 16));
  const b = toLinear(Number.parseInt(value.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A brand mark darker than this relative luminance disappears on the dark
// neutral plate, so it renders currentColor instead of its brand hex. 0.06 sits
// comfortably between the darkest KEPT mark (Google/Figma ≈ 0.24) and the
// near-black marks that must flip (Vercel/Notion = 0.00, Slack aubergine ≈ 0.025).
export const DARK_PLATE_MIN_LUMINANCE = 0.06;

/** True when a brand hex is too dark for the dark-theme plate and must use currentColor. */
export function shouldUseCurrentColorOnDark(hex: string): boolean {
  return hexRelativeLuminance(hex) < DARK_PLATE_MIN_LUMINANCE;
}
