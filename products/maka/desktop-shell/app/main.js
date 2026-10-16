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

// The Maka desktop window: tasks on the canvas at the side, and the plate
// beside them with the selected task's transcript and the composer, or the
// start pane for a new task. Settings (settings.js) takes the sidebar and the
// plate while open. The look follows the native client (theme.js). Every Host call goes through `maka-host`
// (see host.js); MAKA_HOST_ENDPOINT and MAKA_HOST_EPOCH name the Host.
//
// An optional `dev.js` beside this file (never committed) can turn on the
// debug log and drive the window without focus:
//
//   export default { debug: true, run: async ({ app, cx, log }) => { ... } };

import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { operation, log, setDebug } from './host.js';
import { SessionCatalog, SidebarState, sidebar } from './sessions.js';
import { Transcript, transcriptPane } from './transcript.js';
import { Composer, composerPane } from './composer.js';
import { interactionCard } from './interactions.js';
import { Settings, settingsNav, settingsPage } from './settings.js';
import { Directories, startPane } from './directories.js';
import { followAppearance, palette, text, icon, controlButton } from './theme.js';

export default class MakaDesktop extends View {
  init(_props, cx) {
    // The context `init` receives may be held across awaits; the Host loops
    // below notify through it.
    this.cx = cx;
    const hooks = { changed: () => this.cx.notify(), report: (message) => this.report(message) };
    this.hooks = hooks;
    this.catalog = new SessionCatalog({
      ...hooks,
      changed: () => {
        // The header shows the catalog's title, which a first message can change.
        const entry = this.catalog.sessions.find((session) => session.id === this.transcript?.id);
        if (entry && this.transcript !== null) this.transcript.session = entry;
        hooks.changed();
      },
    });
    // With no session selected, sending starts one in the folder the start
    // pane shows (the first root until a folder is opened).
    this.composer = new Composer(
      hooks,
      () => this.transcript,
      () => {
        const folder = this.startFolder();
        return folder === null ? Promise.resolve(null) : this.newSession(folder);
      },
    );
    // A model added or chosen in Settings is what the composer sends with next.
    this.settings = new Settings({ ...hooks, modelsChanged: () => this.composer.loadModel() });
    /** @type {Transcript | null} */
    this.transcript = null;
    /** The folders a session can start in when none is selected. */
    this.directories = new Directories(hooks);
    this.sidebarUi = new SidebarState(() => this.cx.notify());
    this.creating = false;
    this.error = null;
    cx.spawn(async (cx) => followAppearance(cx));
    // Ages in the sidebar and turn footers are in minutes.
    cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(60000);
        this.cx.notify();
      }
    });
    cx.spawn(async (cx) => this.start(cx));
  }

  async start(cx) {
    const dev = await import('./dev.js').then(
      (module) => module.default ?? null,
      () => null,
    );
    setDebug(dev?.debug === true);
    log('start');
    this.composer.loadModel();
    this.directories.loadRoots();
    cx.spawn(async (cx) => this.catalog.run(cx));
    if (typeof dev?.run === 'function') {
      cx.spawn(async (cx) => {
        try {
          await dev.run({
            app: this,
            cx,
            log: (message) => console.log(`maka-desktop dev: ${message}`),
          });
        } catch (error) {
          this.report(`dev.js: ${error.message}`);
        }
      });
    }
  }

  /** Switches the transcript; the previous one's watch is closed first. */
  async select(session) {
    if (this.settings.open) this.settings.hide();
    if (this.transcript?.id === session.id) return;
    const previous = this.transcript;
    const transcript = new Transcript(session, this.hooks);
    this.transcript = transcript;
    log(`select "${session.title}"`);
    this.cx.notify();
    if (previous !== null) await previous.close();
    await transcript.open();
  }

  /** Leaves the selected task for the start pane, where a message starts a new one. */
  async home() {
    if (this.settings.open) this.settings.hide();
    const previous = this.transcript;
    this.transcript = null;
    this.cx.notify();
    if (previous !== null) await previous.close();
  }

  /**
   * Starts a session, as the TUI's "New" does: in the workspace of `session`
   * (the selected one when not given), or in `directory` when given. The
   * title comes from the first message. Resolves with the new session's
   * transcript, or null.
   */
  async newSession(directory = null, session = null) {
    const sessionId = session?.id ?? this.transcript?.id ?? null;
    const workspace =
      directory !== null
        ? { kind: 'directory', selection: directory.selection }
        : sessionId !== null
          ? { kind: 'session', sessionId }
          : null;
    if (workspace === null || this.creating) return null;
    this.creating = true;
    this.cx.notify();
    try {
      const created = await operation('agent', 'create', {
        title: 'New session',
        automaticTitle: true,
        labels: [],
        workspace,
      });
      if (created.kind !== 'created') {
        throw new Error(`the Host rejected it (${JSON.stringify(created.reason)})`);
      }
      log(`new session ${created.session.id} in ${workspace.kind}`);
      await this.select(created.session);
      return this.transcript;
    } catch (error) {
      this.report(`New session: ${error.message}`);
      return null;
    } finally {
      this.creating = false;
      this.cx.notify();
    }
  }

  /** Where a session started from the start pane works: the folder shown, or the first root. */
  startFolder() {
    return this.directories.current() ?? this.directories.roots[0] ?? null;
  }

  report(message) {
    console.error(`maka-desktop: ${message}`);
    this.error = { message, at: new Date() };
    this.cx.notify();
  }

  render(cx) {
    const m = palette(cx);
    const settings = this.settings.open;
    return h_flex()
      .size_full()
      .items_start()
      .bg(m.canvas)
      .text_color(m.ink)
      .child(
        settings
          ? settingsNav(this.settings, () => this.settings.hide(), cx)
          : sidebar(
              this.catalog,
              this.sidebarUi,
              this.transcript?.id ?? null,
              {
                select: (session) => this.select(session),
                newTask: () => this.home(),
                newIn: (session) => this.newSession(null, session),
                settings: () => this.settings.show(),
                drafting: this.transcript === null,
              },
              cx,
            ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .h_full()
          .py(8)
          .pr(8)
          .child(
            v_flex()
              .size_full()
              .rounded(12)
              .bg(m.plate)
              .overflow_hidden()
              .when(settings, (el) => el.child(settingsPage(this.settings, cx)))
              .when(!settings, (el) => this.taskPane(el, cx)),
          ),
      );
  }

  /** The plate's content for a task or a new one: header, connection strip, body, card, composer. */
  taskPane(el, cx) {
    const transcript = this.transcript;
    const card = transcript ? interactionCard(transcript.interactions, cx) : null;
    const folder = transcript === null ? this.startFolder() : null;
    return el
      .child(this.header(cx))
      .child(this.connectionStrip(cx))
      .when(transcript === null, (el) =>
        el.child(
          startPane(
            this.directories,
            {
              creating: this.creating,
              start: (directory) => this.newSession(directory),
              noModel: this.composer.loaded && this.composer.model === null,
              // Without a model, a connection is what is missing.
              openSettings: () => this.settings.show('connections'),
            },
            cx,
          ),
        ),
      )
      .when(transcript !== null, (el) =>
        el.child(transcriptPane(transcript, () => transcript.loadOlder(), cx)),
      )
      .when(card !== null, (el) => el.child(card))
      .child(
        composerPane(
          this.composer,
          transcript,
          {
            folder: folder === null ? null : { name: folder.name, path: folder.path },
            notice: this.error?.message ?? null,
            dismiss: () => {
              this.error = null;
              this.cx.notify();
            },
            addConnection: () => {
              this.settings.show('connections');
              this.settings.openAdd();
            },
          },
          cx,
        ),
      );
  }

  /** The plate's 48px header: the task's title and what it is doing. */
  header(cx) {
    const m = palette(cx);
    const transcript = this.transcript;
    const state =
      transcript === null
        ? null
        : transcript.interactions.entries.length > 0
          ? 'Needs you'
          : transcript.run
            ? 'Working…'
            : null;
    return h_flex()
      .flex_none()
      .h(48)
      .pl(20)
      .pr(12)
      .gap(12)
      .items_center()
      .window_control_area('drag')
      .child(
        text(transcript?.session.title ?? '', 'strong', m.ink)
          .flex_1()
          .min_w_0()
          .truncate(),
      )
      .when(state !== null, (el) => el.child(text(state, 'small', m.inkMuted).flex_none()));
  }

  /**
   * Above the transcript, in its column: "Starting…" while the Host is being
   * reached, and a banner while it cannot be. The catalog retries on its own;
   * Retry asks it to now.
   */
  connectionStrip(cx) {
    const m = palette(cx);
    const state = this.catalog.state;
    if (state === 'live') return div();
    const column = (child) =>
      h_flex()
        .flex_none()
        .w_full()
        .px(24)
        .pb(8)
        .justify_center()
        .child(v_flex().w_full().max_w(720).child(child));
    if (state === 'connecting') {
      return column(
        h_flex()
          .h(32)
          .gap(8)
          .items_center()
          .child(icon('status-running', 16, m.primary))
          .child(text('Starting…', 'body', m.inkMuted)),
      );
    }
    return column(
      h_flex()
        .px(16)
        .py(12)
        .gap(12)
        .items_start()
        .rounded(12)
        .bg(m.warningTint)
        .child(icon('triangle-alert', 16, m.warning).mt(2))
        .child(
          v_flex()
            .flex_1()
            .min_w_0()
            .gap(2)
            .child(text('The Maka Host is not answering', 'strong', m.ink))
            .child(
              text(
                'Tasks shown may be out of date. The desktop keeps trying to reach it.',
                'body',
                m.ink,
              ),
            )
            .when(this.error !== null, (el) =>
              el.child(text(this.error.message, 'small', m.destructive).truncate()),
            ),
        )
        .child(
          controlButton('host-retry', 'Retry', 'quiet', false, cx)
            .h(28)
            .on_click(() => this.catalog.retryNow()),
        ),
    );
  }
}
