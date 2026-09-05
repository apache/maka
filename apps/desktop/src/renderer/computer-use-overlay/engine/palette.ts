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

// Agent-cursor colour palettes — faithful 1:1 port of trycua/cua's
// cursor-overlay/src/palette.rs (itself a port of AgentCursorPalette.cs).
// Colours are [R,G,B] 0-255. The overlay picks a palette from the session id so
// distinct agent runs are visually distinct but a given id is stable.
export type Rgb = readonly [number, number, number];

export interface Palette {
  name: string;
  /** Tip colour (lightest, gradient position 0.0). */
  cursorStart: Rgb;
  /** Mid-gradient colour (position 0.53). */
  cursorMid: Rgb;
  /** Tail colour (position 1.0). */
  cursorEnd: Rgb;
  /** Outer bloom layer. */
  bloomOuter: Rgb;
  /** Inner bloom layer (brighter core). */
  bloomInner: Rgb;
}

/**
 * Maka's brand cursor palette, derived from the app's primary token
 * `--action` = oklch(0.62 0.19 264) (a blue/indigo). Gradient tip→tail around it
 * plus a soft brand bloom, so the agent cursor reads as "Maka" rather than a
 * random per-session hue. (FOLLOW-UP: thread the live --primary from the renderer
 * so it tracks theme changes instead of this baked snapshot.)
 */
export function makaBrandPalette(): Palette {
  return {
    name: 'maka_brand',
    cursorStart: [144, 182, 255], // lightest at the tip
    cursorMid: [73, 126, 247], // the primary
    cursorEnd: [71, 97, 228], // deeper at the tail
    bloomOuter: [157, 189, 255],
    bloomInner: [212, 229, 255],
  };
}

export const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
