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

// apps/desktop/src/renderer/keyboard-help.tsx
//
// Discoverable keyboard cheat sheet. Modal triggered by `?` (when no input is
// focused) or `⌘/` (`Ctrl+/` off macOS). Lists every shortcut the renderer reacts to so
// users don't need to scrape the README. Astryx Dialog owns focus trapping,
// Esc, and focus restoration.

import { useState } from 'react';
import { ICON_SIZE, Keyboard } from '@maka/ui/icons';
import { useUiLocale } from '@maka/ui';
import { Heading } from '@astryxdesign/core/Heading';
import { Kbd } from '@astryxdesign/core/Kbd';
import { useHotkeys } from '@astryxdesign/core/hooks';
import {
  Dialog,
  DialogHeader,
} from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { getShellCopy } from './locales/shell-copy';

const ASTRYX_KEY_TOKENS: Readonly<Record<string, string>> = {
  '⌘': 'mod',
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
  esc: 'escape',
};

function toAstryxKeyToken(key: string): string {
  const normalized = key.toLowerCase();
  return ASTRYX_KEY_TOKENS[key] ?? ASTRYX_KEY_TOKENS[normalized] ?? normalized;
}

/**
 * Manages the global key listener that opens and closes the help modal.
 * Returned tuple gives callers the current open state and an imperative
 * close function for the rendered modal.
 */
/**
 * Manages the global key listener that opens and closes the help modal.
 *
 * PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji msg
 * `2844f64f`): the `openHelp` third tuple element added in commit
 * 2 is RETAINED — the Command Palette `查看快捷键` entry uses it
 * to open the modal without dispatching synthetic KeyboardEvent's.
 * The sidebar chip that originally needed it is removed; the
 * Command Palette is the new caller.
 */
export function useKeyboardHelp(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);

  // The hand-written "is the user typing?" guard is gone: skipping
  // input/textarea/select/contenteditable is what useHotkeys does by default,
  // and it is the only reason the bare `?` entry needs no guard of its own —
  // `?` must still type itself into the composer. The two modified combos opt
  // back in, matching the old code, which reached them before its guard.
  useHotkeys([
    { keys: 'mod+/', allowInInputs: true, onPress: () => setOpen((prev) => !prev) },
    { keys: 'mod+?', allowInInputs: true, onPress: () => setOpen((prev) => !prev) },
    { keys: '?', onPress: () => setOpen(true) },
  ]);

  return [open, () => setOpen(false), () => setOpen(true)];
}

export function KeyboardHelpModal(props: {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).keyboardHelp;

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      className="maka-help-modal"
      width={560}
      maxHeight="calc(100dvh - 96px)"
      purpose="info"
    >
      <Layout
        header={
          <DialogHeader
            startContent={<Keyboard size={ICON_SIZE.chrome} aria-hidden="true" />}
            title={copy.title}
            onOpenChange={props.onOpenChange}
          />
        }
        content={
          <LayoutContent padding={0}>
            <div className="maka-help-body">
          {copy.sections.map((section) => (
            <section key={section.heading} className="maka-help-section">
              <Heading level={3}>{section.heading}</Heading>
              <dl>
                {section.rows.map((row) => (
                  <div key={row.description}>
                    <dt>{row.description}</dt>
                    <dd>
                      {row.keys.map((key, index) => (
                        <span key={`${row.description}:${key}:${index}`}>
                          {index > 0 && (
                            <span className="maka-help-plus" aria-hidden="true">
                              +
                            </span>
                          )}
                          <Kbd keys={toAstryxKeyToken(key)} />
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
