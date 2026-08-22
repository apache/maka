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

import { Editor } from '@earendil-works/pi-tui';
import { SKILL_INVOCATION_TOKEN_SOURCE } from '@maka/core/skill-invocation-token';
import { ansi } from './tui-ansi.js';

// A `/`-token that begins mid-message (after whitespace). Only `/skill:` has
// semantic value mid-message (a parseable invocation token); plain commands
// only execute at line start, so the provider offers `/skill:xxx` (not plain
// commands) for a mid-message `/`. Line-start `/` is left to pi-tui's own
// slash trigger; this matches only mid-message tokens (after whitespace).
const MID_MESSAGE_SLASH_TOKEN = /(?:\s)\/\S*$/;

/**
 * Editor with `/skill:<name>` invocation highlighting (issue #1148). Valid
 * tokens render in the CLI brand accent; anything else stays plain — the
 * absence of the affordance IS the inactive state, so there is deliberately
 * no "failed" style.
 *
 * pi-tui's Editor has no span-decoration hook (its theme covers borders and
 * the autocomplete list only), so this subclass post-processes the rendered
 * lines: tokens are ASCII and the regex is prefix-anchored, so it can never
 * match inside the editor's own escape sequences (border colors, the inline
 * cursor's reverse-video marker). Two known, self-healing limits: a token
 * split across word-wrapped lines, and a token with the cursor inside it
 * (cursor escape codes break the plain-text match) render unhighlighted.
 */
export class MakaSkillHighlightEditor extends Editor {
  private isInvocable: (name: string) => boolean = () => false;

  /**
   * Swap the validator used by the render pass. Must be synchronous and
   * cheap (called per token per render) — the runner feeds it a snapshot of
   * the last fetched invocable-skill list.
   */
  setSkillTokenValidator(validator: (name: string) => boolean): void {
    this.isInvocable = validator;
    this.invalidate();
  }

  override render(width: number): string[] {
    const pattern = new RegExp(SKILL_INVOCATION_TOKEN_SOURCE, 'g');
    return super
      .render(width)
      .map((line) =>
        line.replace(pattern, (whole, name: string) =>
          this.isInvocable(name) ? ansi.accent(whole) : whole,
        ),
      );
  }

  override handleInput(data: string): void {
    // Detect a printable input by whether it actually changed the editor text,
    // instead of re-deriving pi-tui's printable decoding (Kitty CSI-u, xterm
    // modifyOtherKeys, IME, paste). Navigation/control sequences (arrows, Enter,
    // Escape) do not change the text, so they are ignored. Capture "before"
    // here because super.handleInput performs the insertion.
    const textBefore = this.getText();
    super.handleInput(data);
    if (this.isShowingAutocomplete()) return;
    if (this.getText() === textBefore) return;
    // pi-tui auto-triggers slash completion only at line start (its
    // isAtStartOfMessage/isInSlashCommandContext predicates require the `/` at
    // column 0). Also trigger when a `/`-token begins mid-message, so `see /`
    // surfaces `/skill:xxx` completions immediately. Plain commands are
    // intentionally NOT completed mid-message (they only execute at line start);
    // the provider offers only `/skill:`. The provider shapes the prefix so
    // selection inserts rather than auto-submits.
    const { line, col } = this.getCursor();
    // Slash completion is first-line only, matching pi-tui's isSlashMenuAllowed.
    if (line !== 0) return;
    const textBeforeCursor = (this.getLines()[line] ?? '').slice(0, col);
    if (MID_MESSAGE_SLASH_TOKEN.test(textBeforeCursor)) {
      // `tryTriggerAutocomplete` is TS-private but runtime-public (pi-tui ships
      // plain JS with no #private fields). A contract test pins it so a future
      // rename fails loudly instead of silently regressing mid-message trigger.
      (this as unknown as { tryTriggerAutocomplete: () => void }).tryTriggerAutocomplete();
    }
  }
}
