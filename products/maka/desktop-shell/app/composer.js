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

// The composer: a multi-line draft in a rounded dock, the files attached to
// it, the model menu, the folder a new task starts in, and Send or Stop.

import { div } from 'gpui-kit';
import { v_flex, h_flex, Button, Textarea, TextareaState, Popover } from 'gpui-base';
import { chooseFiles, release } from 'maka-files';
import { query, operation, log, readModels } from './host.js';
import {
  palette,
  typeset,
  text,
  icon,
  ghostButton,
  iconButton,
  fileChip,
  menuSurface,
  menuRow,
  menuLabel,
  menuSeparator,
  controlButton,
} from './theme.js';
import { t, onLanguageChange } from './locale.js';

/** The most files one message carries (`agent.send` `attachments`). */
const MAX_ATTACHMENTS = 8;

/** Why the Host refused an upload (`AttachmentRejection`), in words. */
const REJECTIONS = {
  invalid_file: 'attachmentInvalidFile',
  closed: 'attachmentClosed',
  archived: 'attachmentArchived',
};

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
    /** Whether the permission menu is open. */
    this.accessOpen = false;
    /** The permission level picked for a new task, or null for the Host's default. */
    this.newAccess = null;
    /** Whether a permission change is under way. */
    this.changingAccess = false;
    /**
     * sessionId (or '' for a new task) -> the files attached to that draft,
     * in order: `{ handle, name, bytes, digest, id, state, error }`. `handle`
     * is `maka-files`' registration, `id` the Host's once the file is uploaded
     * to that session (null before), and `state` 'ready', 'uploading' or
     * 'failed', with `error` saying why.
     */
    this.attached = new Map();
    /** Whether the open panel for attachments is up. */
    this.choosing = false;
  }

  /** The files attached to the draft for `transcript`, or for a new task. */
  attachments(transcript) {
    return this.attached.get(transcript?.id ?? '') ?? [];
  }

  /** Whether files can be attached to the draft for `transcript` now. */
  canAttach(transcript) {
    return (
      !this.sending &&
      !this.choosing &&
      transcript?.backend?.kind !== 'executor' &&
      this.attachments(transcript).length < MAX_ATTACHMENTS
    );
  }

  /** Shows the open panel and attaches the files chosen to the draft for `transcript`. */
  async chooseAttachments(transcript) {
    if (!this.canAttach(transcript)) return;
    this.choosing = true;
    this.hooks.changed();
    try {
      this.attach(transcript, await chooseFiles());
    } catch (error) {
      this.hooks.report(t('attachFailed', { value: error.message }));
    } finally {
      this.choosing = false;
      this.hooks.changed();
    }
  }

  /**
   * Adds files `maka-files` registered to the draft for `transcript`, up to
   * MAX_ATTACHMENTS in all; those past the limit are released. What was not
   * attached is reported: files too large, unreadable, or past the limit.
   */
  attach(transcript, files) {
    const attached = [...this.attachments(transcript)];
    const problems = [];
    const over = [];
    for (const file of files) {
      if (file.tooLarge) {
        problems.push(t('attachmentTooLarge', { name: file.name }));
      } else if (file.handle === undefined) {
        problems.push(t('attachmentUnreadable', { name: file.name, value: file.error ?? '' }));
      } else if (attached.length >= MAX_ATTACHMENTS) {
        over.push(file.handle);
      } else {
        attached.push({
          handle: file.handle,
          name: file.name,
          bytes: file.bytes,
          digest: file.digest,
          id: null,
          state: 'ready',
          error: null,
        });
      }
    }
    if (over.length > 0) {
      release(over);
      problems.push(t('attachmentLimit', { limit: MAX_ATTACHMENTS }));
    }
    this.attached.set(transcript?.id ?? '', attached);
    log(`composer: ${attached.length} file(s) attached, ${problems.length} problem(s)`);
    if (problems.length > 0) this.hooks.report(problems.join(' '));
    this.hooks.changed();
  }

  /** Takes a file off the draft for `transcript` and releases it. */
  detach(transcript, handle) {
    if (this.sending) return;
    const kept = this.attachments(transcript).filter((file) => file.handle !== handle);
    this.attached.set(transcript?.id ?? '', kept);
    release([handle]);
    this.hooks.changed();
  }

  /**
   * Uploads each of `files` that `transcript`'s session does not have yet,
   * one at a time. An uploaded file keeps its id, so a later try sends it as
   * it is. Resolves to whether all of them are uploaded; one that is not (the
   * Host refused it, or it could not be read or sent) is marked failed and
   * reported, and the rest wait for the next try.
   */
  async upload(transcript, files) {
    for (const file of files) {
      if (file.id !== null) continue;
      file.state = 'uploading';
      file.error = null;
      this.hooks.changed();
      try {
        const result = await operation(
          transcript.endpoint,
          'uploadAttachment',
          { sessionId: transcript.id, name: file.name, bytes: file.bytes, digest: file.digest },
          { file: { file: file.handle } },
        );
        if (result.kind === 'rejected') {
          const reason = Object.hasOwn(REJECTIONS, result.reason)
            ? t(REJECTIONS[result.reason])
            : JSON.stringify(result.reason);
          log(`composer: upload of ${file.name} rejected: ${JSON.stringify(result.reason)}`);
          file.state = 'failed';
          file.error = reason;
          this.hooks.report(t('attachmentRejected', { name: file.name, reason }));
          return false;
        }
        file.id = result.attachment.id;
        file.state = 'ready';
        log(`composer: uploaded ${file.name} as ${file.id}`);
      } catch (error) {
        file.state = 'failed';
        file.error = error.message;
        this.hooks.report(t('attachmentUploadFailed', { name: file.name, value: error.message }));
        return false;
      } finally {
        this.hooks.changed();
      }
    }
    return true;
  }

  /**
   * The permission level `transcript`'s agent runs with, or the one a new
   * task starts with: the level picked for it, else `defaultAccess`, the
   * Host's default as far as it is known (null when it is not).
   */
  access(transcript, defaultAccess) {
    if (transcript !== null) return transcript.session.permissions?.access ?? null;
    return this.newAccess ?? defaultAccess;
  }

  /**
   * Sets how much `transcript`'s agent may do before it asks, as the TUI's
   * sandbox picker does: `agent.metadata` with the session's own title and
   * labels (so an automatic title stays automatic) and the approvals granted
   * so far revoked. A stale revision is read again once. With no transcript,
   * it picks the level the next new task starts with. Resolves to whether the
   * level is now `access`; a failure has been reported.
   */
  async setAccess(transcript, access) {
    this.accessOpen = false;
    if (transcript === null) {
      this.newAccess = access;
      this.hooks.changed();
      return true;
    }
    if (transcript.session.permissions?.access === access) {
      this.hooks.changed();
      return true;
    }
    if (this.changingAccess) return false;
    this.changingAccess = true;
    this.hooks.changed();
    try {
      let session = transcript.session;
      for (let attempt = 0; ; attempt += 1) {
        const result = await operation(transcript.endpoint, 'metadata', {
          sessionId: session.id,
          expectedRevision: session.revision,
          title: session.title,
          labels: [...session.labels],
          permissions: { settings: { ...session.permissions, access }, revokeGrants: true },
        });
        if (result.kind === 'committed') {
          transcript.session = result.session;
          log(`composer: ${session.id} runs with ${access}`);
          return true;
        }
        if (result.kind === 'rejected') {
          throw new Error(t('hostRefused', { value: JSON.stringify(result.reason) }));
        }
        if (attempt > 0) throw new Error(t('taskChangedMeanwhile'));
        session = (await query(transcript.endpoint, 'observe', { sessionId: session.id })).session;
      }
    } catch (error) {
      this.hooks.report(t('permissionFailed', { value: error.message }));
      return false;
    } finally {
      this.changingAccess = false;
      this.hooks.changed();
    }
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
      const models = await readModels();
      if (models === null) throw new Error(t('modelListChangingReopen'));
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
    const models = await readModels(model.modelId);
    if (models === null) throw new Error(t('modelListChanging'));
    return models.choices.find((choice) => sameModel(choice.selection, model)) ?? null;
  }

  /**
   * Sends the draft and its files to the transcript's session, starting a
   * session first when none is selected. The files are uploaded first; the
   * message goes only when all of them are. The draft is cleared only once
   * the Host accepted it, and its text only if it was not edited meanwhile.
   * With `again`, sends that text instead (a failed turn's message), without
   * files, and leaves the draft alone.
   */
  async send(transcript, again = null) {
    const message = again ?? this.draft.value();
    const files = again === null ? this.attachments(transcript) : [];
    if (this.sending || this.model === null || (message.trim() === '' && files.length === 0)) {
      return;
    }
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
        // So do its files, uploaded to the new task below.
        if (files.length > 0) {
          this.attached.set(transcript.id, files);
          this.attached.delete('');
        }
        // So does a permission level, set before the first message runs; the
        // next new task starts from the Host's default again. When it cannot
        // be set, the message is not sent with a level the user did not pick.
        if (this.newAccess !== null) {
          const access = this.newAccess;
          this.newAccess = null;
          if (!(await this.setAccess(transcript, access))) return;
        }
      }
      const { model, thinkingLevel } = await this.selection(transcript);
      if (!(await this.upload(transcript, files))) return;
      const result = await operation(transcript.endpoint, 'send', {
        sessionId: transcript.id,
        message,
        model,
        ...(files.length > 0 ? { attachments: files.map((file) => file.id) } : {}),
        // Left out, the model's default applies; an explicit level is sent only when chosen.
        ...(thinkingLevel !== null ? { thinkingLevel } : {}),
      });
      log(
        `composer: send ${result.kind} ${result.invocationId ?? ''} message ${result.messageId ?? ''}`,
      );
      if (result.kind === 'rejected')
        throw new Error(t('hostRejectedMessage', { value: result.reason }));
      if (again === null && this.draft.value() === message) {
        // `set_value` sends no change event, so the draft's emptiness is set here.
        this.draft.set_value('');
        this.empty = true;
      }
      // The files went with the message: the draft lets go of them.
      if (files.length > 0) {
        const kept = this.attachments(transcript).filter((file) => !files.includes(file));
        this.attached.set(transcript.id, kept);
        release(files.map((file) => file.handle));
      }
      // The run itself shows up through the watch (`opened`), as in the TUI.
      transcript.addPending(
        result.messageId,
        message,
        files.map((file) => ({ name: file.name, bytes: file.bytes })),
      );
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
      const result = await operation(transcript.endpoint, 'stop', {
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
 *   defaultAccess: string | null, notice: string | null, dismiss: () => void,
 *   addConnection: () => void }} context
 *   `folder` is where a new task starts when no task is selected, and `picker`
 *   the chip that chooses it; `defaultAccess` the permission level new tasks
 *   get when known; `notice` is the last error
 */
export function composerPane(composer, transcript, context, cx) {
  const m = palette(cx);
  const dark = cx.theme().is_dark;
  const inactive = transcript === null && context.folder === null;
  const running = transcript?.run != null;
  const executor = transcript?.backend?.kind === 'executor';
  const files = composer.attachments(transcript);
  const unsent = !composer.empty || files.length > 0;
  const canSend = !inactive && !composer.sending && composer.model !== null && unsent;
  const stop = running && !unsent;
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
            .when(files.length > 0, (el) =>
              el.child(attachmentRow(composer, transcript, files, cx)),
            )
            .child(
              h_flex()
                .gap(2)
                .items_center()
                .child(
                  attachButton(
                    composer,
                    transcript,
                    !inactive && composer.canAttach(transcript),
                    cx,
                  ),
                )
                .child(modelMenu(composer, transcript, context, cx))
                .child(permissionMenu(composer, transcript, context, cx))
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

/** The "+" that attaches files to the draft, first in the controls row. */
function attachButton(composer, transcript, enabled, cx) {
  const m = palette(cx);
  return ghostButton('attach-files', cx)
    .size(28)
    .justify_center()
    .rounded(8)
    .disabled(!enabled)
    .when(!enabled, (el) => el.opacity(0.5))
    .tooltip(t('attachFiles'))
    .child(icon('plus', 16, m.ink))
    .on_click(() => composer.chooseAttachments(transcript));
}

/** The files attached to the draft, above the controls row, each with a remove button. */
function attachmentRow(composer, transcript, files, cx) {
  return h_flex()
    .flex_wrap()
    .gap(8)
    .children(
      files.map((file) =>
        fileChip(file, cx).child(
          iconButton(`attachment-remove-${file.handle}`, 'close', cx, 20, 14)
            .disabled(composer.sending)
            .tooltip(t('remove'))
            .on_click(() => composer.detach(transcript, file.handle)),
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
  const selected =
    chosen?.selection ??
    (transcript?.backend?.kind === 'model' ? transcript.backend : composer.model);
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

/**
 * The permission levels, by the Host's access value, with the native
 * client's names and one-line descriptions: Read only asks before writing or
 * using the network, Auto works inside the workspace and asks before going
 * further, Full access reaches files and the network directly.
 */
const ACCESS = [
  ['read_only', 'permissionReadOnly', 'permissionReadOnlyHint'],
  ['workspace_write', 'permissionAuto', 'permissionAutoHint'],
  ['danger_full_access', 'permissionFullAccess', 'permissionFullAccessHint'],
];

/** The permission chip and its menu, which opens upward. */
function permissionMenu(composer, transcript, context, cx) {
  const current = composer.access(transcript, context.defaultAccess);
  const name = ACCESS.find(([access]) => access === current)?.[1] ?? 'permissionMode';
  return Popover.new('permission-menu')
    .anchor('bottom_left')
    .open(composer.accessOpen)
    .on_open_change((open) => {
      composer.accessOpen = open;
      composer.hooks.changed();
    })
    .trigger(
      chip('permission-chip', t(name), cx)
        .disabled(composer.changingAccess)
        .tooltip(t('permissionMode')),
    )
    .content(
      menuSurface(cx)
        .id('permission-menu-rows')
        .w(340)
        .mb(8)
        .children(
          ACCESS.map(([access, label, hint]) =>
            accessRow(access, label, hint, access === current, cx).on_click(() =>
              composer.setAccess(transcript, access),
            ),
          ),
        ),
    );
}

/** One level in the permission menu: the check, its name, and what it allows below. */
function accessRow(access, label, hint, checked, cx) {
  const m = palette(cx);
  return Button.new(`permission-${access}`)
    .w_full()
    .px(8)
    .py(6)
    .gap(8)
    .items_start()
    .rounded(6)
    .hover((style) => style.bg(m.activeRow))
    .child(
      div()
        .w(16)
        .pt(3)
        .flex_none()
        .when(checked, (el) => el.child(icon('check', 14, m.ink))),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(2)
        .child(typeset(div(), 'body').text_color(m.ink).child(t(label)))
        .child(text(t(hint), 'small', access === 'danger_full_access' ? m.warning : m.inkMuted)),
    );
}

/** The note between the chips and Send: the last error, or why sending is not possible. */
function note(context, executor, cx) {
  const m = palette(cx);
  const message = context.notice ?? (executor ? t('executorNote') : null);
  return h_flex()
    .id('composer-note')
    .flex_1()
    .min_w_0()
    .px(8)
    .when(message !== null, (el) =>
      el
        .tooltip(context.notice !== null ? t('noticeDismiss', { value: message }) : message)
        .when(context.notice !== null, (el) =>
          el.cursor_pointer().on_click(() => context.dismiss()),
        )
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
