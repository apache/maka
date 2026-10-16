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

// The task list: a live `agent.catalog` subscription and the sidebar that
// shows it, grouped by day or by folder as the native client does.

import { div, svg } from 'gpui-kit';
import { v_flex, h_flex, Button } from 'gpui-base';
import { query, subscribe, next, close, log } from './host.js';
import {
  palette,
  typeset,
  text,
  icon,
  tippedIcon,
  dot,
  ghostButton,
  iconButton,
  segmentedControl,
  compactAge,
} from './theme.js';
import { t } from './locale.js';

const LIST = { filter: 'all', position: { kind: 'start' } };
const RETRY_MS = 2000;
/** Pages read after the subscribed first one; the Host pages at most 32 sessions in id order. */
const MAX_PAGES = 32;

export class SessionCatalog {
  /**
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    /** Every listed session, newest first. Replaced, never edited. */
    this.sessions = [];
    /** The subscribed first page, and the pages after it as last read. */
    this.first = [];
    this.rest = [];
    this.reading = 0;
    this.needsYou = 0;
    /** "connecting", "live" or "offline". */
    this.state = 'connecting';
    this.revision = null;
    this.handle = null;
    this.restarting = false;
    /** Set by Retry: the offline pause ends at once. */
    this.wakeUp = false;
  }

  /**
   * Holds one catalog subscription with a single `next()` loop. When it fails
   * or ends, one `agent.list` query keeps the sidebar current and the
   * subscription is opened again after a pause.
   */
  async run(cx) {
    for (;;) {
      try {
        this.handle = await subscribe('agent', 'catalog', LIST);
        log(`catalog: subscribed as ${this.handle}`);
        for (;;) {
          const page = await next(this.handle);
          if (page === null) break;
          this.apply(page, 'live');
        }
        if (!this.restarting) log('catalog: the Host ended the subscription');
      } catch (error) {
        // A restart closes the handle under the loop; its next() then fails.
        if (!this.restarting) this.hooks.report(t('sessionListFailed', { value: error.message }));
      } finally {
        if (this.handle !== null) await close(this.handle).catch(() => {});
        this.handle = null;
      }
      if (this.restarting) {
        this.restarting = false;
        continue;
      }
      this.state = 'offline';
      this.hooks.changed();
      try {
        this.apply(await query('agent', 'list', LIST), 'offline');
      } catch (error) {
        this.hooks.report(t('sessionListFailed', { value: error.message }));
      }
      for (let waited = 0; waited < RETRY_MS && !this.wakeUp; waited += 100) await cx.sleep(100);
      this.wakeUp = false;
    }
  }

  /** Ends the pause before the next attempt to reach the Host. */
  retryNow() {
    this.wakeUp = true;
  }

  /**
   * Reopens the subscription at the start. After a change the Host reads the
   * catalog again from the first id it last sent, and ids are random, so a
   * new session can sort before that id and fall outside the window; the TUI
   * likewise reopens its catalog watch after creating a session.
   */
  restart() {
    if (this.handle === null || this.restarting) return;
    this.restarting = true;
    close(this.handle).catch(() => {});
  }

  apply(page, state) {
    if (state === 'live' && page.before !== null) {
      log('catalog: sessions sort before the window; reopening at the start');
      this.restart();
      return;
    }
    // The catalog answers after every commit; an unchanged revision is the same page.
    if (page.revision === this.revision && state === this.state) return;
    this.revision = page.revision;
    this.first = page.sessions;
    this.needsYou = page.needsYouCount;
    this.state = state;
    if (page.after === null) {
      this.reading += 1;
      this.rest = [];
    } else {
      this.readRest(page);
    }
    this.publish();
  }

  /**
   * Reads the pages after the first at its revision. Sessions are paged in
   * id order, so the newest can be on any page. A conflict means the catalog
   * changed meanwhile; the page that change brings reads them again.
   */
  async readRest(page) {
    const reading = ++this.reading;
    const rest = [];
    let after = page.after;
    try {
      for (let count = 0; after !== null && count < MAX_PAGES; count += 1) {
        const next = await query('agent', 'list', {
          filter: LIST.filter,
          position: { kind: 'after', revision: page.revision, cursor: after },
        });
        if (reading !== this.reading) return;
        rest.push(...next.sessions);
        after = next.after;
      }
    } catch (error) {
      if (reading === this.reading) log(`catalog: later pages: ${error.message}`);
      return;
    }
    this.rest = rest;
    this.publish();
  }

  publish() {
    const byId = new Map(this.rest.map((session) => [session.id, session]));
    for (const session of this.first) byId.set(session.id, session);
    this.sessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    log(`catalog: ${this.sessions.length} sessions, ${this.needsYou} need you`);
    this.hooks.changed();
  }
}

/** A session is waiting on the user (a question or an approval). */
export function needsYou(session) {
  return session.activity === 'waiting';
}

/** How many tasks a group shows before "Show more". */
const GROUP_ROWS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the sidebar shows: how tasks are grouped, and which groups are folded or opened. */
export class SidebarState {
  /** @param {() => void} changed */
  constructor(changed) {
    this.changed = changed;
    /** "time" or "project". */
    this.grouping = 'time';
    this.folded = new Set();
    this.expanded = new Set();
  }

  group(grouping) {
    if (this.grouping === grouping) return;
    this.grouping = grouping;
    this.changed();
  }

  toggleFold(key) {
    if (!this.folded.delete(key)) this.folded.add(key);
    this.changed();
  }

  expand(key) {
    this.expanded.add(key);
    this.changed();
  }
}

/** Today, Yesterday, This week (two to six days ago) or Earlier, by calendar day. */
function timeGroup(at, now) {
  const midnight = (time) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(now) - midnight(at)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return 'Earlier';
}

/** The heading of each group `timeGroup` answers. */
const TIME_GROUPS = {
  Today: 'groupToday',
  Yesterday: 'groupYesterday',
  'This week': 'groupThisWeek',
  Earlier: 'groupEarlier',
};

/** The sessions in groups, newest first: by day, or by the folder they work in. */
function groups(sessions, grouping) {
  const now = Date.now();
  /** @type {Map<string, { key: string, label: string, path: string | null, sessions: object[] }>} */
  const byKey = new Map();
  for (const session of sessions) {
    const path = session.workspace?.path ?? '';
    const key = grouping === 'time' ? timeGroup(session.updatedAt, now) : `project:${path}`;
    let group = byKey.get(key);
    if (!group) {
      const label =
        grouping === 'time'
          ? t(TIME_GROUPS[key])
          : (path.split('/').filter(Boolean).pop() ?? (path || t('noFolder')));
      group = { key, label, path: grouping === 'time' ? null : path, sessions: [] };
      byKey.set(key, group);
    }
    group.sessions.push(session);
  }
  return [...byKey.values()];
}

/**
 * The sidebar: the wordmark, New task, WorkHub, the grouping control, the
 * task groups and the Host's state with the Settings button.
 * It takes the column's height left under the window strip (main.js).
 * @param {SessionCatalog} catalog
 * @param {SidebarState} ui
 * @param {string | null} selectedId
 * @param {{ select: (session: object) => void, newTask: () => void, workhub: () => void,
 *   newIn: (session: object) => void, settings: () => void, drafting: boolean,
 *   inWorkHub: boolean }} actions
 *   `drafting` and `inWorkHub` say which of New task and WorkHub shows as selected
 */
export function sidebar(catalog, ui, selectedId, actions, cx) {
  const m = palette(cx);
  const list = groups(catalog.sessions, ui.grouping);
  return v_flex()
    .w(256)
    .flex_1()
    .min_h_0()
    .bg(m.canvas)
    .text_color(m.ink)
    .child(
      v_flex()
        .flex_none()
        .px(8)
        .pt(8)
        .child(
          h_flex()
            .h(32)
            .mb(8)
            .pl(4)
            .items_center()
            .child(svg('icons/wordmark.svg').w(69).h(18).text_color(m.brand)),
        )
        .child(
          typeset(ghostButton('new-task', cx), 'body')
            .w_full()
            .h(32)
            .px(8)
            .gap(8)
            .justify_start()
            .when(actions.drafting, (el) => el.bg(m.selected))
            .on_click(() => actions.newTask())
            .child(icon('compose', 16, m.inkMuted))
            .child(div().flex_1().child(t('newTask')))
            .child(text('⌘N', 'small', m.inkMuted).flex_none()),
        )
        .child(
          typeset(ghostButton('open-workhub', cx), 'body')
            .w_full()
            .h(32)
            .px(8)
            .gap(8)
            .justify_start()
            .when(actions.inWorkHub, (el) => el.bg(m.selected))
            .on_click(() => actions.workhub())
            .child(icon('workhub', 16, m.inkMuted))
            .child(div().flex_1().child(t('workhubName'))),
        )
        .child(groupingControl(ui, cx)),
    )
    .child(
      v_flex()
        .id('sessions')
        .flex_1()
        .min_h_0()
        .overflow_y_scrollbar()
        .px(8)
        .pb(40)
        .when(catalog.sessions.length === 0, (el) =>
          el.child(
            text(
              catalog.state === 'connecting' ? t('loadingTasks') : t('noTasksYet'),
              'small',
              m.inkMuted,
            )
              .pl(8)
              .pt(16),
          ),
        )
        .children(list.map((group) => taskGroup(group, ui, selectedId, actions, cx))),
    )
    .child(footer(catalog, actions, cx));
}

function groupingControl(ui, cx) {
  return segmentedControl(
    'group-by',
    [
      ['time', t('groupByTime')],
      ['project', t('groupByProject')],
    ],
    ui.grouping,
    (grouping) => ui.group(grouping),
    cx,
  ).mt(8);
}

function taskGroup(group, ui, selectedId, actions, cx) {
  const m = palette(cx);
  const folded = ui.folded.has(group.key);
  const shown =
    folded ? [] : ui.expanded.has(group.key) ? group.sessions : group.sessions.slice(0, GROUP_ROWS);
  const hidden = folded ? 0 : group.sessions.length - shown.length;
  const id = slug(group.key);
  return v_flex()
    .w_full()
    .child(
      h_flex()
        .h(44)
        .items_end()
        .child(
          h_flex()
            .w_full()
            .h(28)
            .items_center()
            .child(
              typeset(Button.new(`group-${id}`), 'smallLabel')
                .h(28)
                .pl(8)
                .pr(4)
                .gap(4)
                .items_center()
                .rounded(6)
                .text_color(m.inkMuted)
                .hover((style) => style.text_color(m.ink))
                .on_click(() => ui.toggleFold(group.key))
                .when(group.path !== null, (el) =>
                  el.child(svg(`icons/${folded ? 'folder' : 'folder-open'}.svg`).size(14)),
                )
                .child(div().child(group.label))
                .child(svg(`icons/chevron-${folded ? 'right' : 'down'}.svg`).size(12)),
            )
            .child(div().flex_1())
            .when(group.path !== null, (el) =>
              el.child(
                iconButton(`group-new-${id}`, 'plus', cx, 20, 14)
                  .tooltip(t('newTaskIn', { path: group.path }))
                  .on_click(() => actions.newIn(group.sessions[0])),
              ),
            ),
        ),
    )
    .children(
      shown.map((session) => taskRow(session, session.id === selectedId, actions.select, cx)),
    )
    .when(hidden > 0, (el) =>
      el.child(
        typeset(ghostButton(`group-more-${id}`, cx), 'body')
          .w_full()
          .h(32)
          .pl(8)
          .justify_start()
          .text_color(m.inkMuted)
          .hover((style) => style.text_color(m.ink))
          .on_click(() => ui.expand(group.key))
          .child(t('showMore')),
      ),
    );
}

function taskRow(session, selected, select, cx) {
  const m = palette(cx);
  const working = session.activity === 'working';
  return typeset(Button.new(`session-${session.id}`), 'body')
    .w_full()
    .h(32)
    .pl(8)
    .pr(8)
    .gap(8)
    .items_center()
    .rounded(10)
    .text_color(m.ink)
    .when(selected, (el) => el.bg(m.selected))
    .when(!selected, (el) => el.hover((style) => style.bg(m.hover)))
    .on_click(() => select(session))
    .child(div().flex_1().min_w_0().truncate().child(session.title))
    .child(
      h_flex()
        .flex_none()
        .min_w(40)
        .gap(6)
        .items_center()
        .justify_end()
        .when(needsYou(session), (el) =>
          el.child(tippedIcon('status-waiting', 14, m.warning, t('needsYou'))),
        )
        .when(working, (el) =>
          el.child(tippedIcon('status-running', 14, m.primary, t('taskWorking'))),
        )
        .when(!working, (el) => el.child(text(compactAge(session.updatedAt), 'small', m.inkMuted))),
    );
}

function footer(catalog, actions, cx) {
  const m = palette(cx);
  const [color, word] = {
    connecting: [m.warning, t('starting')],
    live: [m.success, null],
    offline: [m.destructive, t('disconnected')],
  }[catalog.state];
  return h_flex()
    .flex_none()
    .p(8)
    .gap(4)
    .items_center()
    .border_t_1()
    .border_color(m.borderSoft)
    .child(
      h_flex()
        .flex_1()
        .min_w_0()
        .h(36)
        .pl(8)
        .pr(12)
        .gap(8)
        .items_center()
        .child(dot(color))
        .child(text(t('localHost'), 'body', m.ink).flex_none())
        .when(word !== null, (el) => el.child(text(word, 'small', m.inkMuted).truncate())),
    )
    .child(
      iconButton('open-settings', 'settings', cx)
        .tooltip(t('settings'))
        .on_click(() => actions.settings()),
    );
}

/** A group key as an element id. */
function slug(key) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
