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

// The composer: a multi-line draft in a rounded dock, the model menu, the
// folder a new task starts in, and Send or Stop.

import { div } from 'gpui-kit';
import { v_flex, h_flex, Button, Textarea, TextareaState, Popover } from 'gpui-base';
import { query, operation, log } from './host.js';
import {
  palette,
  typeset,
  text,
  icon,
  ghostButton,
  menuSurface,
  menuRow,
  menuLabel,
  menuSeparator,
  controlButton,
} from './theme.js';
import { t, onLanguageChange } from './locale.js';

export class Composer {
  /**
   * Creates retained input state, so it belongs in the view's `init`.
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   * @param {() => import("./transcript.js").Transcript | null} target the session Enter sends to
   * @param {() => Promise<import("./transcript.js").Transcript | null>} start starts a session
   *   when none is selected, and resolves with it
   */
  constructor(hooks, target, start) {
    this.hooks = hooks;
    this.start = start;
    this.draft = TextareaState.new({ placeholder: t('composerPlaceholder'), rows: 1 });
    this.draft.set_auto_grow(1, 8);
    // The placeholder follows a change of language; the draft lives as long as the app.
    onLanguageChange(() => this.draft.set_placeholder(t('composerPlaceholder')));
    // Send turns on and off with the draft; redraw only when that flips.
    this.empty = true;
    this.draft.on('change', () => {
      const empty = this.draft.value().trim() === '';
      if (empty !== this.empty) {
        this.empty = empty;
        this.hooks.changed();
      }
    });
    // Enter sends without inserting a newline; Shift+Enter inserts one and
    // still reports `submit`, with `shift` set.
    this.draft.set_submit_on_enter(true);
    this.draft.on('submit', (event) => {
      if (!event.shift) this.send(target());
    });
    /** The default model's choice, or the first offered one, for sessions without their own. */
    this.model = null;
    /** That model's name, or null when there is none (the footer then says so). */
    this.modelLabel = null;
    /** Whether the model list has been read once, so "no model" is known rather than pending. */
    this.loaded = false;
    /** The first page of `settings.models`, used to name a session's own model. */
    this.choices = [];
    this.sending = false;
    this.stopping = false;
    /** Whether the model menu is open. */
    this.menuOpen = false;
    /** sessionId (or '' for a new task) -> the model chosen in the menu, which the next send uses. */
    this.chosen = new Map();
  }

  /** Picks the model the next message in `transcript` (or a new task) is sent with. */
  choose(transcript, choice) {
    this.chosen.set(transcript?.id ?? '', choice);
    this.menuOpen = false;
    log(`composer: chose ${choiceLabel(choice)}`);
    this.hooks.changed();
  }

  /**
   * Reads the models the Host offers. A session without a model of its own
   * uses the configured default, or the first choice when there is none.
   */
  async loadModel() {
    try {
      const models = await query('settings', 'models', { kind: 'start', query: '' });
      if (models.kind !== 'ready') throw new Error(t('modelListChangingReopen'));
      this.choices = models.choices;
      const fallback =
        models.defaultModel.kind === 'ready' ? models.defaultModel.choice : models.choices[0];
      this.model = fallback?.selection ?? null;
      this.modelLabel = fallback ? choiceLabel(fallback) : null;
      // No model yet is not an error: the start pane offers Settings.
      log(`composer: default model ${this.modelLabel ?? 'none'}`);
      // A model chosen in the menu is kept as the Host offers it now, with
      // its connection's current revision; one whose connection was removed
      // is dropped, and the task's own model or the default applies again.
      for (const [id, choice] of this.chosen) {
        const current = await this.offered(choice.selection);
        if (current !== null) this.chosen.set(id, current);
        else {
          this.chosen.delete(id);
          log(`composer: ${choiceLabel(choice)} is not offered any more`);
        }
      }
    } catch (error) {
      this.hooks.report(t('modelsFailed', { value: error.message }));
    } finally {
      this.loaded = true;
    }
    this.hooks.changed();
  }

  /** What the footer names for `transcript`: its own model when it has one (as the TUI picks it). */
  label(transcript) {
    const chosen = this.chosen.get(transcript?.id ?? '');
    if (chosen) return choiceLabel(chosen);
    const backend = transcript?.backend ?? null;
    if (backend?.kind === 'executor') return t('executorModel');
    if (backend?.kind !== 'model') return this.modelLabel ?? t('noModel');
    const choice = this.choices.find((c) => sameModel(c.selection, backend));
    return choice ? choiceLabel(choice) : backend.modelId;
  }

  /**
   * The `model` and `thinkingLevel` to send with: the session's own backend
   * (`agent.observe`, as agent-screen/actions.ts reads it), else the default.
   * The backend has no connection revision, so its choice is looked up.
   */
  async selection(transcript) {
    const chosen = this.chosen.get(transcript.id);
    if (chosen) {
      const current = await this.offered(chosen.selection);
      if (current === null) {
        this.chosen.delete(transcript.id);
        throw new Error(t('modelNotOffered', { model: choiceLabel(chosen) }));
      }
      return { model: current.selection, thinkingLevel: null };
    }
    const backend = transcript.backend;
    if (backend?.kind === 'executor') {
      throw new Error(t('executorCannotStart'));
    }
    if (backend?.kind !== 'model') {
      if (this.model === null) throw new Error(t('noModelConfigured'));
      return { model: this.model, thinkingLevel: null };
    }
    const choice = await this.offered(backend);
    if (!choice) throw new Error(t('sessionModelNotOffered', { model: backend.modelId }));
    return { model: choice.selection, thinkingLevel: backend.thinkingLevel ?? null };
  }

  /**
   * The choice the Host offers now for a model (a connection and a model
   * id), with its connection's current revision, or null when it offers none.
   */
  async offered(model) {
    const models = await query('settings', 'models', { kind: 'start', query: model.modelId });
    if (models.kind !== 'ready') throw new Error(t('modelListChanging'));
    return models.choices.find((choice) => sameModel(choice.selection, model)) ?? null;
  }

  /**
   * Sends the draft to the transcript's session, starting a session first
   * when none is selected. The draft is cleared only once the Host accepted
   * it, and only if it was not edited meanwhile.
   */
  async send(transcript) {
    const message = this.draft.value();
    if (this.sending || this.model === null || message.trim() === '') return;
    this.sending = true;
    this.hooks.changed();
    try {
      if (transcript === null) {
        transcript = await this.start();
        // Starting it failed; the app has said why.
        if (transcript === null) return;
        // A model chosen for the new task stays with the task.
        const chosen = this.chosen.get('');
        if (chosen) {
          this.chosen.set(transcript.id, chosen);
          this.chosen.delete('');
        }
      }
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
        throw new Error(t('hostRejectedMessage', { value: result.reason }));
      if (this.draft.value() === message) {
        // `set_value` sends no change event, so the draft's emptiness is set here.
        this.draft.set_value('');
        this.empty = true;
      }
      // The run itself shows up through the watch (`opened`), as in the TUI.
      transcript.addPending(result.messageId, message);
    } catch (error) {
      this.hooks.report(t('sendFailed', { value: error.message }));
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
      this.hooks.report(t('stopFailed', { value: error.message }));
    } finally {
      this.stopping = false;
      this.hooks.changed();
    }
  }
}

/**
 * The composer under the transcript or the empty state, in the reading column.
 * @param {Composer} composer
 * @param {import("./transcript.js").Transcript | null} transcript
 * @param {{ folder: { name: string, path: string } | null, picker: object | null,
 *   notice: string | null, dismiss: () => void, addConnection: () => void }} context
 *   `folder` is where a new task starts when no task is selected, and `picker`
 *   the chip that chooses it; `notice` is the last error
 */
export function composerPane(composer, transcript, context, cx) {
  const m = palette(cx);
  const dark = cx.theme().is_dark;
  const inactive = transcript === null && context.folder === null;
  const running = transcript?.run != null;
  const executor = transcript?.backend?.kind === 'executor';
  const canSend = !inactive && !composer.sending && composer.model !== null && !composer.empty;
  const stop = running && composer.empty;
  return h_flex()
    .flex_none()
    .w_full()
    .px(24)
    .pt(8)
    .pb(16)
    .justify_center()
    .child(
      v_flex()
        .w_full()
        .max_w(720)
        .rounded(28)
        .bg(m.plate)
        .border_1()
        .border_color(dark ? m.border : m.dockRing)
        .when(!dark, (el) => el.shadow_sm())
        .child(
          v_flex()
            .p(12)
            .gap(6)
            .child(
              typeset(Textarea.new(composer.draft), 'body')
                .w_full()
                .px(8)
                .py(4)
                .bg('#00000000')
                .border_0()
                .text_color(m.ink)
                .disabled(inactive),
            )
            .child(
              h_flex()
                .gap(2)
                .items_center()
                .child(modelMenu(composer, transcript, context, cx))
                .when(context.picker !== null, (el) => el.child(context.picker))
                .child(note(context, executor, cx))
                .child(
                  stop
                    ? actionButton('stop', 'stop', cx)
                        .bg(m.ink)
                        .disabled(composer.stopping)
                        .tooltip(t('stop'))
                        .hover((style) => style.opacity(0.84))
                        .on_click(() => composer.stop(transcript))
                    : actionButton('send', 'send', cx, canSend ? m.onPrimary : m.inkMuted)
                        .bg(canSend ? m.primary : m.wash)
                        .disabled(!canSend)
                        .tooltip(t('send'))
                        .when(canSend, (el) => el.hover((style) => style.bg(m.primaryHover)))
                        .on_click(() => composer.send(transcript)),
                ),
            ),
        ),
    );
}

/** The 32px round Send or Stop button. */
function actionButton(id, glyph, cx, color = null) {
  const m = palette(cx);
  return Button.new(id)
    .flex_none()
    .size(32)
    .rounded(16)
    .items_center()
    .justify_center()
    .child(icon(glyph, 16, color ?? m.plate));
}

/** A chip in the controls row: 28 high, label and a chevron. */
function chip(id, label, cx) {
  const m = palette(cx);
  return typeset(ghostButton(id, cx), 'label')
    .h(28)
    .px(8)
    .gap(4)
    .max_w(260)
    .child(div().min_w_0().truncate().child(label))
    .child(icon('chevron-down', 14, m.inkMuted));
}

/** The model chip and the menu it opens upward: models by connection, then Add connection. */
function modelMenu(composer, transcript, context, cx) {
  const current = composer.label(transcript);
  const chosen = composer.chosen.get(transcript?.id ?? '');
  const selected = chosen?.selection ?? (transcript?.backend?.kind === 'model' ? transcript.backend : composer.model);
  const byConnection = new Map();
  for (const choice of composer.choices) {
    const name = choice.connectionName ?? '';
    if (!byConnection.has(name)) byConnection.set(name, []);
    byConnection.get(name).push(choice);
  }
  const rows = [];
  for (const [name, choices] of byConnection) {
    if (name !== '') rows.push(menuLabel(name, cx));
    choices.forEach((choice, index) => {
      rows.push(
        menuRow(
          `model-${slugOf(name)}-${index}`,
          choice.label,
          { checked: selected != null && sameModel(choice.selection, selected) },
          cx,
        ).on_click(() => composer.choose(transcript, choice)),
      );
    });
  }
  if (rows.length > 0) rows.push(menuSeparator(cx));
  rows.push(
    menuRow('model-add', t('addConnectionMenu'), { icon: 'plus' }, cx).on_click(() => {
      composer.menuOpen = false;
      context.addConnection();
    }),
  );
  return Popover.new('model-menu')
    .anchor('bottom_left')
    .open(composer.menuOpen)
    .on_open_change((open) => {
      composer.menuOpen = open;
      composer.hooks.changed();
    })
    .trigger(chip('model-chip', current.split(' · ')[0], cx).tooltip(current))
    .content(
      menuSurface(cx)
        .id('model-menu-rows')
        .w(280)
        .max_h(360)
        .overflow_y_scroll()
        .mb(8)
        .children(rows),
    );
}

/** The note between the chips and Send: the last error, or why sending is not possible. */
function note(context, executor, cx) {
  const m = palette(cx);
  const message =
    context.notice ?? (executor ? t('executorNote') : null);
  return h_flex()
    .id('composer-note')
    .flex_1()
    .min_w_0()
    .px(8)
    .when(message !== null, (el) =>
      el
        .tooltip(context.notice !== null ? t('noticeDismiss', { value: message }) : message)
        .when(context.notice !== null, (el) => el.cursor_pointer().on_click(() => context.dismiss()))
        .child(
          text(message, 'small', context.notice !== null ? m.destructive : m.inkMuted).truncate(),
        ),
    );
}

function slugOf(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function choiceLabel(choice) {
  return choice.connectionName ? `${choice.label} · ${choice.connectionName}` : choice.label;
}

function sameModel(selection, backend) {
  return selection.connectionId === backend.connectionId && selection.modelId === backend.modelId;
}

/** A control button; `primary` fills it with the primary color (see theme.js controlButton). */
export function button(id, label, primary, disabled, cx) {
  return controlButton(id, label, primary ? 'primary' : 'outline', disabled, cx);
}
