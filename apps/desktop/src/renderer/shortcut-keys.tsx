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

// apps/desktop/src/renderer/shortcut-keys.tsx
//
// Keycap chips for a shortcut that carries a modifier.
//
// Astryx's own Kbd resolves `mod` per platform (⌘ on macOS, Ctrl elsewhere) but
// spells `ctrl`, `alt` and `shift` with Apple glyphs on every platform, so a
// Windows user reading the shortcuts sheet saw `Ctrl ⇧ D` — half translated
// (#3876). Kbd takes only its token vocabulary, so there is no argument that
// asks it for the word: the chips are ours, drawn from the same theme tokens
// Kbd draws from, and one platform answer — the one the main process gave us —
// decides every glyph.
//
// Kbd stays where a shortcut names no modifier: the palette footer's ↑ ↓ ↵ Esc
// are the same on every keyboard, so there is nothing there to decide.

import { Fragment } from 'react';
import {
  formatShortcutKey,
  orderShortcutKeys,
  parseShortcutKeys,
  shortcutLabel,
  useHostPlatform,
} from '@maka/ui';

export function ShortcutKeys(props: {
  /** Neutral tokens, or one Astryx-style `'mod+shift+d'` string. */
  keys: readonly string[] | string;
  /**
   * Whether a `+` sits between the chips. The shortcuts sheet spells the chord
   * out because its rows are read as instructions; a lone chip beside a button
   * is a label and takes the plainer form.
   */
  separator?: 'plus' | 'gap';
}) {
  const platform = useHostPlatform();
  const tokens = typeof props.keys === 'string' ? parseShortcutKeys(props.keys) : props.keys;
  const ordered = orderShortcutKeys(tokens, platform);

  // One accessible name for the whole chord ("Control + Shift + D"), on the
  // wrapper: the glyphs inside announce as nothing useful, and a per-chip label
  // makes a screen reader read one shortcut as three unrelated images.
  return (
    <span className="maka-shortcut-keys" role="img" aria-label={shortcutLabel(tokens, platform)}>
      {ordered.map((key, index) => (
        <Fragment key={`${key}:${index}`}>
          {index > 0 && props.separator === 'plus' && (
            <span className="maka-shortcut-plus" aria-hidden="true">
              +
            </span>
          )}
          <kbd className="maka-shortcut-kbd" aria-hidden="true">
            {formatShortcutKey(key, platform)}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}
