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
 * The Maka wordmark — our own brand asset, not a generic UI icon.
 *
 * Lives beside `bot-brand-logo.tsx` for the same reason: `icons.tsx` is a
 * pass-through to lucide-react for generic UI glyphs, while fixed product
 * assets carry their own module.
 *
 * Outlines were traced (potrace, deterministic) from the `maka` lockup in
 * `apps/desktop/assets/icon.png`, which is the app icon shipped with the
 * desktop build — so the empty-state mark and the dock icon cannot drift
 * apart. Paths are filled with `currentColor` so the mark inherits the
 * surface's text colour and works in both themes; callers set the opacity
 * they want rather than baking a tint in here.
 */

import type { CSSProperties } from 'react';

export interface MakaWordmarkProps {
  /** Rendered width in px; height follows the 460:120 aspect ratio. */
  width?: number | string;
  className?: string;
  style?: CSSProperties;
  /**
   * Accessible name. Omit it (the default) for decorative use — the mark
   * then renders `aria-hidden`, because the surrounding hero already names
   * the surface and a second "Maka" announcement is just noise.
   */
  title?: string;
}

export function MakaWordmark({ width = 104, className, style, title }: MakaWordmarkProps) {
  return (
    <svg
      viewBox="0 0 460 120"
      width={width}
      className={className}
      style={style}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <g transform="translate(0,120) scale(0.1,-0.1)" fill="currentColor" stroke="none">
        <path d="M2639 1187 c-38 -29 -39 -46 -39 -479 0 -400 1 -425 19 -455 23 -37 68 -50 108 -31 41 20 53 53 53 154 0 83 2 92 25 114 l24 23 143 -138 c79 -75 156 -143 171 -151 57 -30 127 14 127 79 0 32 -39 75 -217 238 l-82 75 130 103 c157 125 173 152 123 210 -21 25 -34 31 -65 31 -35 0 -55 -13 -209 -140 l-170 -139 0 229 0 228 -26 31 c-20 24 -34 31 -62 31 -21 0 -44 -6 -53 -13z M1926 969 c-109 -26 -216 -114 -264 -217 -24 -50 -27 -69 -27 -162 0 -95 3 -111 28 -162 39 -79 104 -143 185 -181 62 -29 75 -32 168 -32 94 0 105 2 164 33 35 18 64 31 64 30 18 -50 63 -74 111 -58 57 19 60 32 57 258 -2 176 -6 211 -23 258 -24 63 -100 151 -163 188 -84 49 -205 67 -300 45z m142 -170 c93 -20 171 -113 172 -205 0 -58 -45 -140 -97 -177 -112 -80 -278 -26 -328 107 -43 112 34 247 158 276 45 11 41 11 95 -1z M547 960 c-105 -18 -200 -90 -248 -187 -23 -45 -24 -60 -27 -268 -2 -120 -1 -229 3 -242 7 -30 58 -56 94 -48 16 3 38 16 49 28 19 20 21 36 24 227 3 226 8 248 69 290 69 50 157 44 215 -14 46 -46 54 -88 54 -297 0 -179 1 -186 23 -207 43 -40 100 -37 134 7 9 11 12 71 13 201 0 102 5 202 10 222 32 114 172 160 264 87 55 -44 60 -66 61 -284 1 -110 5 -208 9 -218 13 -27 63 -49 97 -42 16 4 38 18 49 32 19 24 20 40 20 228 0 224 -8 268 -61 348 -60 90 -158 139 -280 139 -62 1 -88 -4 -135 -26 -33 -15 -71 -38 -85 -52 l-27 -26 -50 36 c-82 60 -179 83 -275 66z M3659 960 c-137 -23 -264 -138 -299 -268 -53 -202 61 -407 260 -466 102 -30 242 -14 304 35 15 12 28 20 29 18 1 -2 7 -13 13 -24 26 -48 94 -55 135 -14 19 19 20 30 17 237 -3 214 -3 218 -31 273 -50 103 -163 186 -282 208 -65 12 -79 12 -146 1z m114 -201 c33 -65 48 -81 107 -112 59 -31 61 -49 10 -72 -52 -24 -93 -70 -115 -131 -10 -27 -24 -56 -32 -64 -11 -12 -15 -12 -26 0 -8 8 -19 35 -26 59 -14 48 -67 110 -121 139 -19 10 -35 25 -35 33 0 7 21 23 46 35 52 25 106 82 115 122 8 34 24 54 38 49 6 -2 23 -28 39 -58z" />
      </g>
    </svg>
  );
}
