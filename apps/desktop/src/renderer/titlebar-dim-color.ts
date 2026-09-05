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

// apps/desktop/src/renderer/titlebar-dim-color.ts
//
// Pure color math for the modal-open titlebar dim (theme.ts drives it; the
// main-process tests pin it). No DOM access and no imports, so the module
// compiles standalone into `dist/renderer/` for `node --test`.

/**
 * scrim composited over an opaque hex background, channel-wise. An
 * unparseable background comes back unchanged so the caller degrades to the
 * undimmed color rather than dimming wrong.
 */
export function compositeScrimOverBackground(
  scrim: { r: number; g: number; b: number; a: number },
  backgroundHex: string,
): string {
  const base = hexToRgb(backgroundHex);
  if (!base) return backgroundHex;
  const channel = (top: number, bottom: number): number =>
    Math.round(scrim.a * top + (1 - scrim.a) * bottom);
  return rgbToHex(channel(scrim.r, base.r), channel(scrim.g, base.g), channel(scrim.b, base.b));
}

/**
 * Parse a computed `rgb()`/`rgba()` serialization (any separator style —
 * commas, spaces, slash alpha, percent alpha). Returns null for anything
 * else (e.g. `oklch()`/`color(...)` serializations), letting callers fall
 * back instead of guessing.
 */
export function parseCssRgbColor(
  used: string,
): { r: number; g: number; b: number; a: number } | null {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(used);
  if (!match) return null;
  const alphaRaw = match[4];
  const alpha = alphaRaw === undefined
    ? 1
    : alphaRaw.endsWith('%')
      ? Number.parseFloat(alphaRaw) / 100
      : Number.parseFloat(alphaRaw);
  if ([match[1], match[2], match[3]].some((c) => Number.isNaN(Number.parseFloat(c))) || Number.isNaN(alpha)) {
    return null;
  }
  return {
    r: Number.parseFloat(match[1]),
    g: Number.parseFloat(match[2]),
    b: Number.parseFloat(match[3]),
    a: alpha,
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
