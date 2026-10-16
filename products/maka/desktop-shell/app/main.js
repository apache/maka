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

// The Maka desktop window: sessions on the side, the selected session's
// transcript, the composer, and a status line; Settings (settings.js) takes
// the session's place while open. Every Host call goes through `maka-host`
// (see host.js); MAKA_HOST_ENDPOINT and MAKA_HOST_EPOCH name the Host.
//
// An optional `dev.js` beside this file (never committed) can turn on the
// debug log and drive the window without focus:
//
//   export default { debug: true, run: async ({ app, cx, log }) => { ... } };

import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { operation, log, setDebug } from './host.js';
import { SessionCatalog, sidebar } from './sessions.js';
import { Transcript, transcriptPane } from './transcript.js';
import { Composer, composerPane, button } from './composer.js';
import { interactionCard } from './interactions.js';
import { Settings, settingsPane } from './settings.js';
import { Directories, startPane } from './directories.js';

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
    this.composer = new Composer(hooks, () => this.transcript);
    // A model added or chosen in Settings is what the composer sends with next.
    this.settings = new Settings({ ...hooks, modelsChanged: () => this.composer.loadModel() });
    /** @type {Transcript | null} */
    this.transcript = null;
    /** The folders a session can start in when none is selected. */
    this.directories = new Directories(hooks);
    this.creating = false;
    this.error = null;
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

  /**
   * Starts a session, as the TUI's "New" does: in the selected session's
   * workspace, or in `directory` when given. The title comes from the first
   * message.
   */
  async newSession(directory = null) {
    const workspace =
      directory !== null
        ? { kind: 'directory', selection: directory.selection }
        : this.transcript !== null
          ? { kind: 'session', sessionId: this.transcript.id }
          : null;
    if (workspace === null || this.creating) return;
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
    } catch (error) {
      this.report(`New session: ${error.message}`);
    } finally {
      this.creating = false;
      this.cx.notify();
    }
  }

  report(message) {
    console.error(`maka-desktop: ${message}`);
    this.error = { message, at: new Date() };
    this.cx.notify();
  }

  render(cx) {
    const theme = cx.theme();
    const selectedId = this.transcript?.id ?? null;
    const card = this.transcript ? interactionCard(this.transcript.interactions, cx) : null;
    return h_flex()
      .size_full()
      .bg(theme.colors.background)
      .text_color(theme.colors.foreground)
      .child(
        sidebar(
          this.catalog,
          selectedId,
          (session) => this.select(session),
          { enabled: this.transcript !== null && !this.creating, create: () => this.newSession() },
          { open: this.settings.open, show: () => this.settings.show() },
          cx,
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .h_full()
          .when(this.settings.open, (el) =>
            el.child(settingsPane(this.settings, () => this.settings.hide(), cx)),
          )
          .when(!this.settings.open, (el) =>
            el
              .when(this.transcript === null, (el) =>
                el.child(
                  startPane(
                    this.directories,
                    {
                      creating: this.creating,
                      start: (directory) => this.newSession(directory),
                      noModel: this.composer.loaded && this.composer.model === null,
                      openSettings: () => this.settings.show(),
                    },
                    cx,
                  ),
                ),
              )
              .when(this.transcript !== null, (el) =>
                el.child(transcriptPane(this.transcript, () => this.transcript?.loadOlder(), cx)),
              )
              .when(card !== null, (el) => el.child(card))
              .child(composerPane(this.composer, this.transcript, cx)),
          )
          .child(this.statusLine(cx)),
      );
  }

  statusLine(cx) {
    const theme = cx.theme();
    const connection = {
      connecting: 'Connecting to the Maka Host…',
      live: 'Connected',
      offline: 'Disconnected; retrying',
    }[this.catalog.state];
    const error = this.error;
    return h_flex()
      .flex_none()
      .px(theme.spacing.lg)
      .py(theme.spacing.xs)
      .gap(theme.spacing.md)
      .items_center()
      .border_t_1()
      .border_color(theme.colors.border)
      .text_xs()
      .text_color(theme.colors.muted_foreground)
      .child(div().flex_none().child(connection))
      .when(error !== null, (el) =>
        el.child(
          div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_color(theme.colors.destructive)
            .child(`${clock(error.at)} ${error.message}`),
        ),
      );
  }
}

function clock(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
