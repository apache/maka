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
// empty state for a new task, or WorkHub (workhub.js), whose conversation is
// drawn as a task's, or the Search page (search.js). Settings (settings.js)
// takes the sidebar and the plate while open. The look follows the native
// client (theme.js). Every Host call goes through `maka-host` (see host.js);
// MAKA_HOST_ENDPOINT and MAKA_HOST_EPOCH name the Host.
//
// An optional `dev.js` beside this file (never committed) can turn on the
// debug log and drive the window without focus:
//
//   export default { debug: true, run: async ({ app, cx, log }) => { ... } };

import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { query, operation, log, setDebug } from './host.js';
import { SessionCatalog, SidebarState, sidebar } from './sessions.js';
import { Transcript, transcriptPane } from './transcript.js';
import { Composer, composerPane } from './composer.js';
import { interactionCard } from './interactions.js';
import { Settings, settingsNav, settingsPage } from './settings.js';
import { Directories, folderPicker } from './directories.js';
import { WorkHub, workhubTabs, workhubBody, chatHint } from './workhub.js';
import { Search, searchPage } from './search.js';
import { usable } from './subagents.js';
import { followAppearance, palette, text, icon, controlButton, ghostButton } from './theme.js';
import { t, onLanguageChange } from './locale.js';

/**
 * Where the window controls start, from the left of the strip or header that
 * holds them: the traffic lights sit at 16 from the window's left (window.rs)
 * and span 56, and the controls start 8 after them. The header keeps the same
 * clearance from the plate's edge, as the native client's title bar does.
 */
const LIGHTS_END = 80;

/** WorkHub and the Search page as places in the Back and Forward lists, beside session ids. */
const WORKHUB = 'workhub';
const SEARCH = 'search';

/** The application's shortcuts, as the native client binds them. */
const SHORTCUTS = [
  { keystroke: 'secondary-n', action: 'maka.new-task' },
  { keystroke: 'secondary-b', action: 'maka.toggle-sidebar' },
  { keystroke: 'secondary-[', action: 'maka.back' },
  { keystroke: 'secondary-]', action: 'maka.forward' },
  { keystroke: 'secondary-,', action: 'maka.settings' },
  { keystroke: 'secondary-shift-f', action: 'maka.search' },
  { keystroke: 'secondary-.', action: 'maka.stop' },
  { keystroke: 'f2', action: 'maka.rename-task' },
];

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
        // A page read before a change the app made itself (a permission
        // level) can arrive after it; an older revision is not taken.
        const entry = this.catalog.sessions.find((session) => session.id === this.transcript?.id);
        if (
          entry &&
          this.transcript !== null &&
          entry.revision >= this.transcript.session.revision
        ) {
          this.transcript.session = entry;
        }
        hooks.changed();
      },
    });
    // With no session selected, sending starts one in the folder the
    // composer's folder chip shows (the first root until one is chosen).
    this.composer = new Composer(
      hooks,
      () => this.current(),
      () => {
        const folder = this.startFolder();
        return folder === null ? Promise.resolve(null) : this.newSession(folder);
      },
    );
    // A model added or chosen in Settings is what the composer sends with next,
    // and the subagents Settings reads or saves are what WorkHub's hint goes by.
    this.settings = new Settings({
      ...hooks,
      modelsChanged: () => this.composer.loadModel(),
      presetsChanged: (snapshot) => this.workhub.acceptPresets(snapshot),
    });
    /** @type {Transcript | null} */
    this.transcript = null;
    /** Where a session starts when none is selected, and the menu to choose it. */
    this.directories = new Directories(hooks);
    this.workhub = new WorkHub(hooks, this.directories);
    // A result opens its task as the sidebar does; the session the Host
    // answered with gives way to the catalog's entry, which is fresher.
    // Archived tasks, which the catalog does not list, open too.
    const listed = (session) =>
      this.catalog.sessions.find((entry) => entry.id === session.id) ?? session;
    this.search = new Search(
      {
        changed: hooks.changed,
        openTask: (session) => this.select(listed(session)),
        openPassage: (session, anchor) => this.select(listed(session), true, anchor),
        back: () => this.go(-1),
      },
      cx,
    );
    // A rename shows in the open task's header at once; an archived task
    // that is open is left for the start pane, as after closing one.
    this.sidebarUi = new SidebarState(
      {
        ...hooks,
        renamed: (session) => {
          if (this.transcript?.id === session.id) this.transcript.session = session;
        },
        archived: (sessionId) => {
          if (this.transcript?.id === sessionId) this.home();
        },
        focusRoot: () => this.rootFocus.focus(),
      },
      cx,
    );
    this.creating = false;
    this.error = null;
    this.sidebarHidden = false;
    /**
     * The places Back and Forward go to: a session id, WORKHUB, SEARCH, or
     * null for the start pane. The current place is not on either list.
     */
    this.history = { back: [], forward: [] };
    // The shortcuts' actions are handled on the root below, and an action
    // only reaches the elements on the focus path. So the root holds the
    // focus whenever nothing inside it does: from the start, and after a
    // press on anything that does not take focus itself (GPUI moves focus to
    // the innermost tracking element under the press). It is a tab stop so
    // that when a pressed control goes away with the focus (Settings' close
    // button, a form's Submit), the window root gives the focus back to it.
    this.rootFocus = cx.focus_handle();
    cx.spawn(async (cx) => followAppearance(cx));
    // Every label is looked up while rendering, so a new language needs only
    // a new frame. The app lives as long as the window, so this never ends.
    onLanguageChange(() => this.cx.notify());
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
    cx.bind_keys(SHORTCUTS);
    this.rootFocus.focus();
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

  /** Where the window is: WORKHUB, SEARCH, the selected session's id, or null for the start pane. */
  place() {
    if (this.workhub.open) return WORKHUB;
    if (this.search.open) return SEARCH;
    return this.transcript?.id ?? null;
  }

  /**
   * The conversation the composer sends to and Stop stops: WorkHub's while
   * WorkHub is open, else the selected task's.
   */
  current() {
    return this.workhub.open ? this.workhub.transcript : this.transcript;
  }

  /** Records a move from the current place, for Back. */
  visit(next) {
    const current = this.place();
    if (next === current) return;
    this.history.back.push(current);
    this.history.forward = [];
  }

  /** Goes one place back (`direction` -1) or forward (1), skipping tasks that are gone. */
  async go(direction) {
    const [from, to] =
      direction < 0
        ? [this.history.back, this.history.forward]
        : [this.history.forward, this.history.back];
    const current = this.place();
    while (from.length > 0) {
      const place = from.pop();
      // A removed task is skipped, and so is the place shown now, which the
      // skip can bring next to itself (A, X, A with X removed).
      if (place === current) continue;
      if (place === WORKHUB) {
        to.push(current);
        await this.openWorkHub(false);
        return;
      }
      if (place === SEARCH) {
        to.push(current);
        await this.openSearch(false);
        return;
      }
      const session =
        place === null ? null : this.catalog.sessions.find((entry) => entry.id === place);
      if (place !== null && session === undefined) continue;
      to.push(current);
      if (session === null) await this.home(false);
      else await this.select(session, false);
      return;
    }
    this.cx.notify();
  }

  toggleSidebar() {
    this.sidebarHidden = !this.sidebarHidden;
    this.cx.notify();
  }

  /**
   * Switches the transcript, leaving WorkHub or the Search page; the previous
   * one's watch is closed first. With `anchor` (a transcript row, from a
   * Search passage) it opens at that row, also when the task is open already.
   */
  async select(session, record = true, anchor = null) {
    if (this.settings.open) this.settings.hide();
    if (this.place() === session.id && anchor === null) return;
    if (record) this.visit(session.id);
    const previous = this.transcript;
    const transcript = new Transcript(session, this.hooks, 'agent', { anchor });
    this.transcript = transcript;
    const leaving = this.workhub.hide();
    this.search.hide();
    log(`select "${session.title}"${anchor === null ? '' : ` at row ${anchor}`}`);
    this.cx.notify();
    if (previous !== null) await previous.close();
    await leaving;
    await transcript.open();
  }

  /** Leaves the selected task or WorkHub for the start pane, where a message starts a new one. */
  async home(record = true) {
    if (this.settings.open) this.settings.hide();
    if (record) this.visit(null);
    const previous = this.transcript;
    this.transcript = null;
    const leaving = this.workhub.hide();
    this.search.hide();
    this.cx.notify();
    if (previous !== null) await previous.close();
    await leaving;
  }

  /** Shows WorkHub in the plate; the selected task's transcript closes, as `select` closes it. */
  async openWorkHub(record = true) {
    if (this.settings.open) this.settings.hide();
    if (this.workhub.open) return;
    if (record) this.visit(WORKHUB);
    const previous = this.transcript;
    this.transcript = null;
    this.search.hide();
    log('open WorkHub');
    const showing = this.workhub.show();
    this.cx.notify();
    if (previous !== null) await previous.close();
    await showing;
  }

  /**
   * Shows the Search page in the plate, as it was left: WorkHub hides and
   * the selected task's transcript closes, as `openWorkHub` does.
   */
  async openSearch(record = true) {
    if (this.settings.open) this.settings.hide();
    if (this.search.open) return;
    if (record) this.visit(SEARCH);
    const previous = this.transcript;
    this.transcript = null;
    const leaving = this.workhub.hide();
    this.search.show();
    log('open Search');
    this.cx.notify();
    if (previous !== null) await previous.close();
    await leaving;
  }

  /**
   * The sidebar's search button and ⇧⌘F: the Search page, with the keyboard
   * in its field and the field's text selected. On the page already, only
   * the field is focused.
   */
  async startSearch() {
    const opening = this.openSearch();
    this.search.focusField();
    await opening;
  }

  /** Selects a session WorkHub routed a task to: from the catalog, else as the Host observes it. */
  async openSession(sessionId) {
    let session = this.catalog.sessions.find((entry) => entry.id === sessionId);
    if (session === undefined) {
      try {
        session = (await query('agent', 'observe', { sessionId })).session;
      } catch (error) {
        this.workhub.fail(t('workhubOpenFailed', { value: error.message }));
        return;
      }
    }
    await this.select(session);
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
        // Stored in the Host until the automatic title replaces it, so it
        // stays in the language the task was started in.
        title: t('newTask'),
        automaticTitle: true,
        labels: [],
        workspace,
      });
      if (created.kind !== 'created') {
        throw new Error(t('hostRejectedTask', { value: JSON.stringify(created.reason) }));
      }
      log(`new session ${created.session.id} in ${workspace.kind}`);
      await this.select(created.session);
      return this.transcript;
    } catch (error) {
      this.report(t('newSessionFailed', { value: error.message }));
      return null;
    } finally {
      this.creating = false;
      this.cx.notify();
    }
  }

  /** F2: renames the selected task in the sidebar, which shows its row first. */
  renameSelected() {
    if (this.settings.open || this.sidebarHidden || this.workhub.open || this.transcript === null) {
      return;
    }
    const session = this.catalog.sessions.find((entry) => entry.id === this.transcript.id);
    if (session === undefined) return;
    this.sidebarUi.reveal(session, this.catalog.sessions);
    this.sidebarUi.startRename(session);
  }

  /** Where a session started with no task selected works: the chosen folder, or the first root. */
  startFolder() {
    return this.directories.target();
  }

  report(message) {
    console.error(`maka-desktop: ${message}`);
    this.error = { message, at: new Date() };
    this.cx.notify();
  }

  render(cx) {
    const m = palette(cx);
    const settings = this.settings.open;
    // Settings keep their navigation in the sidebar's place even while the
    // sidebar is hidden: it is the only way between their pages.
    const column = settings || !this.sidebarHidden;
    return h_flex()
      .size_full()
      .items_start()
      .bg(m.canvas)
      .text_color(m.ink)
      .track_focus(this.rootFocus)
      .tab_stop(true)
      .on_action('maka.new-task', () => this.home())
      .on_action('maka.toggle-sidebar', () => this.toggleSidebar())
      .on_action('maka.back', () => this.go(-1))
      .on_action('maka.forward', () => this.go(1))
      .on_action('maka.settings', () => this.settings.show())
      .on_action('maka.search', () => this.startSearch())
      .on_action('maka.rename-task', () => this.renameSelected())
      .on_action('maka.stop', () => {
        const current = this.current();
        if (current !== null) this.composer.stop(current);
      })
      .when(column, (el) =>
        el.child(
          v_flex()
            .w(256)
            .flex_none()
            .h_full()
            .child(this.chromeStrip(!settings, cx))
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
                      workhub: () => this.openWorkHub(),
                      search: () => this.startSearch(),
                      newIn: (session) => this.newSession(null, session),
                      settings: () => this.settings.show(),
                      drafting: this.place() === null,
                      inWorkHub: this.workhub.open,
                      searching: this.search.open,
                    },
                    cx,
                  ),
            ),
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .h_full()
          .py(8)
          .pr(8)
          .when(!column, (el) => el.pl(8))
          .child(
            v_flex()
              .size_full()
              .rounded(12)
              .bg(m.plate)
              .overflow_hidden()
              .when(settings, (el) => el.child(settingsPage(this.settings, cx)))
              .when(!settings && this.workhub.open, (el) => this.workhubPane(el, cx))
              .when(!settings && this.search.open, (el) => this.searchPane(el, cx))
              .when(!settings && !this.workhub.open && !this.search.open, (el) =>
                this.taskPane(el, cx),
              ),
          ),
      );
  }

  /** The plate's content for a task or a new one: header, connection strip, then the conversation. */
  taskPane(el, cx) {
    const transcript = this.transcript;
    const folder = transcript === null ? this.startFolder() : null;
    return this.conversation(
      el
        .child(this.header(transcript?.session.title ?? '', runState(transcript), null, cx))
        .child(this.connectionStrip(cx)),
      transcript,
      {
        empty: transcript === null ? this.emptyState(cx) : null,
        hint: null,
        bar: null,
        folder: folder === null ? null : { name: folder.name, path: folder.path },
        picker:
          transcript === null
            ? folderPicker(
                this.directories,
                this.catalog.sessions,
                this.creating || folder === null,
                cx,
              )
            : null,
      },
      cx,
    );
  }

  /**
   * The plate's content while WorkHub is open: its header, with the tabs once
   * it is set up, the connection strip, then its conversation, drawn as a
   * task's, or its setup or tasks (workhub.js).
   */
  workhubPane(el, cx) {
    const workhub = this.workhub;
    const chat = workhub.chat();
    el = el
      .child(
        this.header(t('workhubName'), runState(workhub.transcript), workhubTabs(workhub, cx), cx),
      )
      .child(this.connectionStrip(cx));
    if (chat === null) {
      return el.child(
        workhubBody(workhub, { openSession: (sessionId) => this.openSession(sessionId) }, cx),
      );
    }
    // Its folder was fixed when it was set up.
    return this.conversation(
      el,
      chat,
      {
        empty: null,
        hint: chatHint(cx),
        bar: this.workhubNeedsSubagent() ? this.subagentBar(cx) : null,
        folder: null,
        picker: null,
      },
      cx,
    );
  }

  /** The plate's content while the Search page shows: its header, the connection strip, then the page. */
  searchPane(el, cx) {
    return el
      .child(this.header(t('search'), null, null, cx))
      .child(this.connectionStrip(cx))
      .child(searchPage(this.search, this.catalog.sessions, cx));
  }

  /**
   * Whether WorkHub has no subagent to delegate with: its subagents and the
   * models have been read, and none is enabled with a model the Host offers.
   */
  workhubNeedsSubagent() {
    const presets = this.workhub.presets;
    return (
      presets !== null &&
      this.composer.loaded &&
      !presets.entries.some((entry) => usable(entry, this.composer.choices))
    );
  }

  /**
   * What a conversation fills the plate with under its header: the
   * transcript, or `view.empty` before there is one; the card for what the
   * agent waits on; the bar for a failed turn; and the composer. `view.hint`
   * is what an empty transcript shows, null for the usual line; `view.bar` a
   * bar above the composer when neither the card nor the failed turn's bar
   * shows, or null; and `view.folder` and `view.picker` are the composer's
   * (see composerPane).
   */
  conversation(el, transcript, view, cx) {
    const card = transcript ? interactionCard(transcript.interactions, cx) : null;
    const failed = transcript !== null && card === null ? transcript.failedTurn() : null;
    const bar = card === null && failed === null ? view.bar : null;
    return el
      .when(transcript === null, (el) => el.child(view.empty))
      .when(transcript !== null, (el) =>
        el.child(transcriptPane(transcript, () => transcript.loadOlder(), cx, view.hint)),
      )
      .when(card !== null, (el) => el.child(card))
      .when(failed !== null, (el) => el.child(this.failedBar(transcript, failed, cx)))
      .when(bar !== null, (el) => el.child(bar))
      .child(
        composerPane(
          this.composer,
          transcript,
          {
            folder: view.folder,
            picker: view.picker,
            // A session whose permissions were never changed still has the
            // level the Host gives every new one.
            defaultAccess:
              this.catalog.sessions.find((session) => session.boundaryRevision === 0)?.permissions
                ?.access ?? null,
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

  /**
   * Above the composer when the newest turn failed: says so and offers to
   * send its message again. Picking the failed run up where it ended
   * (`agent.resume`) is not offered yet.
   */
  failedBar(transcript, turn, cx) {
    const m = palette(cx);
    return composerBar(
      icon('status-failed', 16, m.destructive),
      t('turnFailedNote'),
      turn.message === null
        ? null
        : controlButton('send-again', t('sendAgain'), 'outline', this.composer.sending, cx)
            .tooltip(t('sendAgainTip'))
            .on_click(() => this.composer.send(transcript, turn.message)),
      cx,
    );
  }

  /**
   * Above the composer in WorkHub's conversation while it has no subagent to
   * delegate with: says so, and opens Settings on the subagents.
   */
  subagentBar(cx) {
    const m = palette(cx);
    return composerBar(
      icon('triangle-alert', 16, m.warning),
      t('workhubNeedsSubagent'),
      controlButton('workhub-subagents', t('workhubSetUpSubagents'), 'outline', false, cx).on_click(
        () => this.settings.show('subagents'),
      ),
      cx,
    );
  }

  /**
   * The plate's body with no task selected, as the native client's empty
   * state: one display line centered over the reading column. The composer's
   * folder chip says where the task will run. Without a model, it also says
   * that one is missing and opens Settings on the connections.
   */
  emptyState(cx) {
    const m = palette(cx);
    const noModel = this.composer.loaded && this.composer.model === null;
    return v_flex()
      .id('empty-state')
      .flex_1()
      .min_h_0()
      .w_full()
      .items_center()
      .justify_center()
      .px(24)
      .py(32)
      .gap(16)
      .child(text(t('emptyStateTitle'), 'display', m.ink).max_w(720).text_center())
      .when(noModel, (el) =>
        el.child(
          h_flex()
            .max_w(720)
            .px(16)
            .py(12)
            .gap(12)
            .items_center()
            .rounded(12)
            .bg(m.warningTint)
            .child(icon('triangle-alert', 16, m.warning))
            .child(text(t('noModelYet'), 'body', m.ink))
            .child(
              controlButton(
                'open-settings',
                t('addModelInSettings'),
                'primary',
                false,
                cx,
              ).on_click(() => this.settings.show('connections')),
            ),
        ),
      );
  }

  /**
   * The plate's 48px header: `title`, and what its conversation is doing
   * (`state`, or null). `controls`, when given, sit in the middle of the
   * plate, with the state after them. With the sidebar hidden it also
   * carries the window controls, clear of the traffic lights.
   */
  header(title, state, controls, cx) {
    const m = palette(cx);
    const hidden = this.sidebarHidden;
    // The parts around the buttons move the window; the buttons are outside
    // them, so a press on one never starts a move.
    const side = () =>
      h_flex().flex_1().min_w_0().h_full().gap(12).items_center().window_control_area('drag');
    const stateText = state === null ? null : text(state, 'small', m.inkMuted).flex_none();
    // The title's half: the window controls when the sidebar is hidden, then
    // the title. Middle controls get a half of the same width after them.
    const leading = h_flex()
      .flex_1()
      .min_w_0()
      .h_full()
      .items_center()
      .when(hidden, (el) =>
        el
          .child(dragArea().w(LIGHTS_END).h_full())
          .child(this.windowControls(cx))
          .child(dragArea().w(8).h_full()),
      )
      .when(!hidden, (el) => el.child(dragArea().w(20).h_full()))
      .child(
        side()
          .child(text(title, 'strong', m.ink).flex_1().min_w_0().truncate())
          .when(controls === null && stateText !== null, (el) => el.child(stateText)),
      );
    return h_flex()
      .flex_none()
      .h(48)
      .pr(12)
      .items_center()
      .child(leading)
      .when(controls !== null, (el) =>
        el.child(controls).child(
          side()
            .justify_end()
            .when(stateText !== null, (el) => el.child(stateText)),
        ),
      );
  }

  /**
   * The 56px strip above the sidebar: the traffic lights, then the window
   * controls (`controls`). Settings leave the controls out, as the native
   * client does: they act on the task view, which waits behind settings. The
   * empty parts move the
   * window; the buttons are outside the drag areas so a press on them never
   * starts a move.
   */
  chromeStrip(controls, cx) {
    return h_flex()
      .flex_none()
      .h(56)
      .pt(8)
      .items_center()
      .child(dragArea().w(LIGHTS_END).h_full())
      .when(controls, (el) => el.child(this.windowControls(cx)))
      .child(dragArea().flex_1().h_full());
  }

  /** Sidebar toggle, Back and Forward: 28px ghost buttons, 2 apart. */
  windowControls(cx) {
    const m = palette(cx);
    const control = (id, glyph, enabled, run) =>
      ghostButton(id, cx)
        .size(28)
        .justify_center()
        .rounded(8)
        .disabled(!enabled)
        .when(enabled, (el) => el.on_click(run))
        .child(icon(glyph, 16, enabled ? m.inkMuted : m.inkDisabled));
    return h_flex()
      .flex_none()
      .gap(2)
      .items_center()
      .child(
        control('window-sidebar', 'sidebar', true, () => this.toggleSidebar()).tooltip(
          this.sidebarHidden
            ? t('showSidebar', { shortcut: '⌘B' })
            : t('hideSidebar', { shortcut: '⌘B' }),
        ),
      )
      .child(
        control('window-back', 'chevron-left', this.history.back.length > 0, () =>
          this.go(-1),
        ).tooltip(t('goBack', { shortcut: '⌘[' })),
      )
      .child(
        control('window-forward', 'chevron-right', this.history.forward.length > 0, () =>
          this.go(1),
        ).tooltip(t('goForward', { shortcut: '⌘]' })),
      );
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
          .child(text(t('starting'), 'body', m.inkMuted)),
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
            .child(text(t('hostNotAnswering'), 'strong', m.ink))
            .child(text(t('hostNotAnsweringDetail'), 'body', m.ink))
            .when(this.error !== null, (el) =>
              el.child(text(this.error.message, 'small', m.destructive).truncate()),
            ),
        )
        .child(
          controlButton('host-retry', t('retry'), 'quiet', false, cx)
            .h(28)
            .on_click(() => this.catalog.retryNow()),
        ),
    );
  }
}

/** What a conversation is doing, as its header says it: waiting on the user, working, or null. */
function runState(transcript) {
  if (transcript === null) return null;
  if (transcript.interactions.entries.length > 0) return t('needsYou');
  return transcript.run ? t('working') : null;
}

/** A bar above the composer, in its column: a glyph, a line, and a button at its end, or none. */
function composerBar(glyph, words, button, cx) {
  const m = palette(cx);
  return h_flex()
    .flex_none()
    .w_full()
    .px(24)
    .pt(8)
    .justify_center()
    .child(
      h_flex()
        .w_full()
        .max_w(720)
        .py(8)
        .pl(12)
        .pr(8)
        .gap(8)
        .items_center()
        .rounded(12)
        .border_1()
        .border_color(m.border)
        .bg(m.plate)
        .child(glyph)
        .child(text(words, 'body', m.ink).flex_1().min_w_0())
        .when(button !== null, (el) => el.child(button)),
    );
}

/** An empty part of the window chrome that moves the window. */
function dragArea() {
  return div().flex_none().window_control_area('drag');
}
