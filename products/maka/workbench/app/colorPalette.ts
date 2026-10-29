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

// The desktop window's palettes (Settings › General): a recipe of a base hue,
// how much of it the grays carry, and an accent, from which both appearances'
// surfaces, text and accent are made in OKLCH, so every palette keeps the
// default's lightness steps and contrast. Status colors stay the default's.

/** What a palette is made from. */
export type PaletteRecipe = {
  /** The hue of the grays, in degrees. */
  hue: number;
  /** How much of the hue the grays carry, 0 (neutral) to 1. */
  tint: number;
  /** The accent, as `#rrggbb`. */
  accent: string;
};

export type PaletteId = 'default' | 'mist' | 'sage' | 'sand' | 'burgundy' | 'graphite' | 'custom';

/** The presets after the default, in the order Settings lists them. */
export const presetRecipes: Record<Exclude<PaletteId, 'default' | 'custom'>, PaletteRecipe> = {
  mist: { hue: 250, tint: 0.7, accent: '#4a6890' },
  sage: { hue: 165, tint: 0.6, accent: '#4f7a72' },
  sand: { hue: 70, tint: 0.6, accent: '#9a6a45' },
  burgundy: { hue: 45, tint: 0.5, accent: '#8a3446' },
  graphite: { hue: 250, tint: 0.15, accent: '#5b6573' },
};

/** Accents the custom palette offers before a typed one. */
export const accentSwatches = [
  '#4a6890',
  '#4f7a72',
  '#66805a',
  '#9a6a45',
  '#8a3446',
  '#a0646e',
  '#6d6496',
  '#5b6573',
];

/** The tokens a palette sets; the rest keep the default's. */
export type PaletteTokens = {
  background: string;
  surface: string;
  raised: string;
  line: string;
  text: string;
  secondary: string;
  muted: string;
  accent: string;
  accentHover: string;
};

type Oklch = [l: number, c: number, h: number];

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** `#rrggbb` → OKLCH, or null for anything else. */
export function parseHex(hex: string): Oklch | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** Linear sRGB of an OKLCH color, unclamped. */
function linearRgb([L, C, h]: Oklch): [number, number, number] {
  const A = C * Math.cos((h * Math.PI) / 180);
  const B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH → `#rrggbb`, lowering the chroma until the color fits sRGB. */
export function toHex([L, C, h]: Oklch): string {
  let chroma = C;
  let rgb = linearRgb([L, chroma, h]);
  while (chroma > 0 && rgb.some((v) => v < -1e-4 || v > 1 + 1e-4)) {
    chroma = Math.max(0, chroma - 0.002);
    rgb = linearRgb([L, chroma, h]);
  }
  return `#${rgb
    .map((v) =>
      Math.round(fromLinear(Math.min(1, Math.max(0, v))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

// Lightness steps near the default palette's, so a palette mostly changes hue and
// keeps contrast close to the default's (not guaranteed to match or exceed it).
const DARK_STEPS = {
  background: 0.2,
  surface: 0.235,
  raised: 0.272,
  line: 0.33,
  text: 0.96,
  secondary: 0.83,
  muted: 0.69,
};
const LIGHT_STEPS = {
  background: 0.99,
  surface: 0.968,
  raised: 0.94,
  line: 0.895,
  text: 0.22,
  secondary: 0.4,
  muted: 0.51,
};

/** A palette's tokens in one appearance. */
export function paletteTokens(recipe: PaletteRecipe, dark: boolean): PaletteTokens {
  const steps = dark ? DARK_STEPS : LIGHT_STEPS;
  const tint = Math.min(1, Math.max(0, recipe.tint));
  // Morandi grays: at most a little chroma, less on text than on surfaces and
  // less on light surfaces, where the same chroma shows more.
  const gray = (l: number, text: boolean) =>
    toHex([l, tint * (text ? 0.008 : dark ? 0.022 : 0.014), recipe.hue]);
  const [, accentChroma, accentHue] = parseHex(recipe.accent) ?? [0, 0, recipe.hue];
  // The accent keeps its hue and, up to a ceiling, its chroma; its lightness
  // is the default accent's, so links and selections read the same.
  const accent = (l: number, ceiling: number) =>
    toHex([l, Math.min(accentChroma, ceiling), accentHue]);
  return {
    background: gray(steps.background, false),
    surface: gray(steps.surface, false),
    raised: gray(steps.raised, false),
    line: gray(steps.line, false),
    text: gray(steps.text, true),
    secondary: gray(steps.secondary, true),
    muted: gray(steps.muted, true),
    accent: dark ? accent(0.75, 0.09) : accent(0.5, 0.13),
    accentHover: dark ? accent(0.83, 0.07) : accent(0.43, 0.13),
  };
}
