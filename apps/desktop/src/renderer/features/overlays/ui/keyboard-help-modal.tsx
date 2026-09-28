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

// Discoverable keyboard cheat sheet. Opened by `?` (when no input is focused)
// or `⌘/` (`Ctrl+/` off macOS) through the overlays controller. Lists every
// shortcut the renderer reacts to so users don't need to scrape the README.
// Astryx Dialog owns focus trapping, Esc, and focus restoration.

import { ICON_SIZE, Keyboard } from '@maka/ui/icons';
import { useUiLocale } from '@maka/ui';
import { Heading } from '@astryxdesign/core/Heading';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { getShellCopy } from '../../../locales/shell-copy.js';
import { useOverlays } from './overlays-context.js';

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

export function KeyboardHelpModal() {
  const { commands, selectors } = useOverlays();
  const locale = useUiLocale();
  const copy = getShellCopy(locale).keyboardHelp;

  return (
    <Dialog
      isOpen={selectors.helpOpen}
      onOpenChange={(open) => {
        if (!open) commands.closeHelp();
      }}
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
            onOpenChange={(open) => {
              if (!open) commands.closeHelp();
            }}
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
