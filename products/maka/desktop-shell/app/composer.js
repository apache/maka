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

// The composer: a multi-line draft, the model, Send and Stop.

import { div } from 'gpui-kit';
import { v_flex, h_flex, Button, Textarea, TextareaState } from 'gpui-base';
import { query, operation, log } from './host.js';

export class Composer {
  /**
   * Creates retained input state, so it belongs in the view's `init`.
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   * @param {() => import("./transcript.js").Transcript | null} target the session Enter sends to
   */
  constructor(hooks, target) {
    this.hooks = hooks;
    this.draft = TextareaState.new({ placeholder: 'Message', rows: 2 });
    this.draft.set_auto_grow(2, 8);
    // Enter sends without inserting a newline; Shift+Enter inserts one and
    // still reports `submit`, with `shift` set.
    this.draft.set_submit_on_enter(true);
    this.draft.on('submit', (event) => {
      if (!event.shift) this.send(target());
    });
    /** The `settings.models` selection sent with every message. */
    this.model = null;
    this.modelLabel = 'No model';
    this.sending = false;
    this.stopping = false;
  }

  /** Takes choice 0 of `settings.models` for now. */
  async loadModel() {
    try {
      const models = await query('settings', 'models', { kind: 'start' });
      const choice = models.kind === 'ready' ? models.choices?.[0] : undefined;
      if (!choice) throw new Error('the Host has no selectable model');
      this.model = choice.selection;
      this.modelLabel = choice.connectionName
        ? `${choice.label} · ${choice.connectionName}`
        : choice.label;
      log(`composer: model ${this.modelLabel}`);
    } catch (error) {
      this.hooks.report(`Models: ${error.message}`);
    }
    this.hooks.changed();
  }

  /**
   * Sends the draft to the transcript's session. The draft is cleared only
   * once the Host accepted it, and only if it was not edited meanwhile.
   */
  async send(transcript) {
    const message = this.draft.value();
    if (transcript === null || this.sending || this.model === null || message.trim() === '') return;
    this.sending = true;
    this.hooks.changed();
    try {
      const result = await operation('agent', 'send', {
        sessionId: transcript.id,
        message,
        model: this.model,
      });
      log(
        `composer: send ${result.kind} ${result.invocationId ?? ''} message ${result.messageId ?? ''}`,
      );
      if (result.kind === 'rejected')
        throw new Error(`the Host rejected the message (${result.reason})`);
      if (this.draft.value() === message) this.draft.set_value('');
      // The run itself shows up through the watch (`opened`), as in the TUI.
      transcript.addPending(result.messageId, message);
    } catch (error) {
      this.hooks.report(`Send: ${error.message}`);
    } finally {
      this.sending = false;
      this.hooks.changed();
    }
  }

  async stop(transcript) {
    const run = transcript?.run;
    if (!run || this.stopping) return;
    this.stopping = true;
    this.hooks.changed();
    try {
      const result = await operation('agent', 'stop', {
        sessionId: transcript.id,
        invocationId: run.invocationId,
      });
      log(`composer: stop requested=${result.requested}`);
    } catch (error) {
      this.hooks.report(`Stop: ${error.message}`);
    } finally {
      this.stopping = false;
      this.hooks.changed();
    }
  }
}

/**
 * @param {Composer} composer
 * @param {import("./transcript.js").Transcript | null} transcript
 */
export function composerPane(composer, transcript, cx) {
  const theme = cx.theme();
  const inactive = transcript === null;
  const running = transcript?.run != null;
  const canSend = !inactive && !composer.sending && composer.model !== null;
  return v_flex()
    .flex_none()
    .px(theme.spacing.xl)
    .py(theme.spacing.md)
    .gap(theme.spacing.sm)
    .border_t_1()
    .border_color(theme.colors.border)
    .child(
      Textarea.new(composer.draft)
        .w_full()
        .px(theme.spacing.md)
        .py(theme.spacing.sm)
        .rounded(theme.radius.md)
        .border_1()
        .border_color(theme.colors.input)
        .bg(theme.colors.background)
        .focus((style) => style.border_color(theme.colors.ring))
        .disabled(inactive),
    )
    .child(
      h_flex()
        .gap(theme.spacing.sm)
        .items_center()
        .child(
          div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_xs()
            .text_color(theme.colors.muted_foreground)
            .child(`${composer.modelLabel} · Enter to send, Shift+Enter for a new line`),
        )
        .when(running, (el) =>
          el.child(
            button(
              'stop',
              composer.stopping ? 'Stopping…' : 'Stop',
              false,
              composer.stopping,
              cx,
            ).on_click(() => composer.stop(transcript)),
          ),
        )
        .child(
          button('send', composer.sending ? 'Sending…' : 'Send', true, !canSend, cx).on_click(() =>
            composer.send(transcript),
          ),
        ),
    );
}

function button(id, label, primary, disabled, cx) {
  const theme = cx.theme();
  return Button.new(id)
    .h_8()
    .px(theme.spacing.md)
    .items_center()
    .justify_center()
    .rounded(theme.radius.md)
    .text_sm()
    .disabled(disabled)
    .when(primary, (el) => el.bg(theme.colors.primary).text_color(theme.colors.primary_foreground))
    .when(!primary, (el) =>
      el
        .border_1()
        .border_color(theme.colors.border)
        .bg(theme.colors.background)
        .text_color(theme.colors.foreground),
    )
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.hover((style) => style.opacity(0.9)))
    .focus((style) => style.border_1().border_color(theme.colors.ring))
    .child(label);
}
