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
// transcript, the composer, and a status line. Every Host call goes through
// `maka-host` (see host.js); MAKA_HOST_ENDPOINT and MAKA_HOST_EPOCH name the
// Host.
//
// An optional `dev.js` beside this file (never committed) can turn on the
// debug log and drive the window without focus:
//
//   export default { debug: true, run: async ({ app, cx, log }) => { ... } };

import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { log, setDebug } from './host.js';
import { SessionCatalog, sidebar } from './sessions.js';
import { Transcript, transcriptPane } from './transcript.js';
import { Composer, composerPane } from './composer.js';

export default class MakaDesktop extends View {
  init(_props, cx) {
    // The context `init` receives may be held across awaits; the Host loops
    // below notify through it.
    this.cx = cx;
    const hooks = { changed: () => this.cx.notify(), report: (message) => this.report(message) };
    this.hooks = hooks;
    this.catalog = new SessionCatalog(hooks);
    this.composer = new Composer(hooks, () => this.transcript);
    /** @type {Transcript | null} */
    this.transcript = null;
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
    if (this.transcript?.id === session.id) return;
    const previous = this.transcript;
    const transcript = new Transcript(session, this.hooks);
    this.transcript = transcript;
    log(`select "${session.title}"`);
    this.cx.notify();
    if (previous !== null) await previous.close();
    await transcript.open();
  }

  report(message) {
    console.error(`maka-desktop: ${message}`);
    this.error = { message, at: new Date() };
    this.cx.notify();
  }

  render(cx) {
    const theme = cx.theme();
    const selectedId = this.transcript?.id ?? null;
    return h_flex()
      .size_full()
      .bg(theme.colors.background)
      .text_color(theme.colors.foreground)
      .child(sidebar(this.catalog, selectedId, (session) => this.select(session), cx))
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .h_full()
          .child(transcriptPane(this.transcript, () => this.transcript?.loadOlder(), cx))
          .child(composerPane(this.composer, this.transcript, cx))
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
