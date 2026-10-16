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
    /** The default model's choice, or the first offered one, for sessions without their own. */
    this.model = null;
    this.modelLabel = 'No model';
    /** The first page of `settings.models`, used to name a session's own model. */
    this.choices = [];
    this.sending = false;
    this.stopping = false;
  }

  /**
   * Reads the models the Host offers. A session without a model of its own
   * uses the configured default, or the first choice when there is none.
   */
  async loadModel() {
    try {
      const models = await query('settings', 'models', { kind: 'start', query: '' });
      if (models.kind !== 'ready') throw new Error('the model list is changing; reopen the app');
      this.choices = models.choices;
      const fallback =
        models.defaultModel.kind === 'ready' ? models.defaultModel.choice : models.choices[0];
      if (!fallback) throw new Error('the Host has no selectable model');
      this.model = fallback.selection;
      this.modelLabel = choiceLabel(fallback);
      log(`composer: default model ${this.modelLabel}`);
    } catch (error) {
      this.hooks.report(`Models: ${error.message}`);
    }
    this.hooks.changed();
  }

  /** What the footer names for `transcript`: its own model when it has one (as the TUI picks it). */
  label(transcript) {
    const backend = transcript?.backend ?? null;
    if (backend?.kind === 'executor') return 'An executor (send from the terminal app)';
    if (backend?.kind !== 'model') return this.modelLabel;
    const choice = this.choices.find((c) => sameModel(c.selection, backend));
    return choice ? choiceLabel(choice) : backend.modelId;
  }

  /**
   * The `model` and `thinkingLevel` to send with: the session's own backend
   * (`agent.observe`, as agent-screen/actions.ts reads it), else the default.
   * The backend has no connection revision, so its choice is looked up.
   */
  async selection(transcript) {
    const backend = transcript.backend;
    if (backend?.kind === 'executor') {
      throw new Error('this session runs on an executor, which the desktop cannot start yet');
    }
    if (backend?.kind !== 'model') {
      if (this.model === null) throw new Error('no model is configured');
      return { model: this.model, thinkingLevel: null };
    }
    const models = await query('settings', 'models', { kind: 'start', query: backend.modelId });
    const choice =
      models.kind === 'ready' ? models.choices.find((c) => sameModel(c.selection, backend)) : null;
    if (!choice) throw new Error(`the session's model ${backend.modelId} is not offered any more`);
    return { model: choice.selection, thinkingLevel: backend.thinkingLevel ?? null };
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
      const { model, thinkingLevel } = await this.selection(transcript);
      const result = await operation('agent', 'send', {
        sessionId: transcript.id,
        message,
        model,
        // Left out, the model's default applies; an explicit level is sent only when chosen.
        ...(thinkingLevel !== null ? { thinkingLevel } : {}),
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
            .child(`${composer.label(transcript)} · Enter to send, Shift+Enter for a new line`),
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

function choiceLabel(choice) {
  return choice.connectionName ? `${choice.label} · ${choice.connectionName}` : choice.label;
}

function sameModel(selection, backend) {
  return selection.connectionId === backend.connectionId && selection.modelId === backend.modelId;
}

/** A small button in the app's style; `primary` fills it with the primary color. */
export function button(id, label, primary, disabled, cx) {
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
