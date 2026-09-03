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

import { MAKA_WORDMARK_PATH } from '@maka/core/maka-wordmark';
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
        <path d={MAKA_WORDMARK_PATH} />
      </g>
    </svg>
  );
}
