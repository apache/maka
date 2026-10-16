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
// shows it, grouped by day or by folder as the native client does. A task's
// "…" menu (or a right-click on its row) renames it, copies its id or
// archives it, as the native client's task menu does
// (maka-gpui crates/session/src/sidebar/row_menu.rs).

import { div, svg } from 'gpui-kit';
import { v_flex, h_flex, Button, InputState, Popover } from 'gpui-base';
import { query, operation, subscribe, next, close, log } from './host.js';
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
  textField,
  menuSurface,
  menuRow,
  menuSeparator,
} from './theme.js';
import { t, onLanguageChange } from './locale.js';

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

/** The longest title the Host takes, in characters (`agent.metadata`). */
const MAX_TITLE = 128;

/**
 * Renames `session` (`agent.metadata`) with its labels kept and nothing else
 * changed. A revision conflict reads the session again and tries once more,
 * as the composer's permission change does. Resolves with the session as
 * the Host committed it.
 */
async function renameSession(session, title) {
  let current = session;
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation('agent', 'metadata', {
      sessionId: current.id,
      expectedRevision: current.revision,
      title,
      labels: [...current.labels],
    });
    if (result.kind === 'committed') return result.session;
    if (result.kind === 'rejected') throw new Error(t('hostRefused', { value: result.reason }));
    if (attempt > 0) throw new Error(t('taskChangedMeanwhile'));
    current = (await query('agent', 'observe', { sessionId: current.id })).session;
  }
}

/**
 * Archives, restores or removes `session` (`agent.changeSession`, `action`
 * 'archive', 'restore' or 'remove'), with the same one retry on a revision
 * conflict. Resolves with the Host's answer, `changed` or `removed`. A
 * refusal throws; a busy session throws a whole sentence (`error.whole`)
 * that is shown as it is.
 */
export async function changeSession(session, action) {
  let current = session;
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation('agent', 'changeSession', {
      sessionId: current.id,
      expectedRevision: current.revision,
      action,
    });
    if (result.kind === 'changed' || result.kind === 'removed') return result;
    if (result.kind === 'rejected') {
      if (result.reason === 'busy') throw whole(t('sessionChangeBusy'));
      throw new Error(t('hostRefused', { value: result.reason }));
    }
    if (result.kind !== 'revision_conflict') {
      throw new Error(t('unexpectedAnswer', { value: result.kind }));
    }
    if (attempt > 0) throw new Error(t('taskChangedMeanwhile'));
    current = (await query('agent', 'observe', { sessionId: current.id })).session;
  }
}

function whole(message) {
  const error = new Error(message);
  error.whole = true;
  return error;
}

/**
 * What a failed change says: a whole sentence (see changeSession) as it is,
 * any other failure through `failed` ("Couldn't archive the task: …").
 * @param {(value: string) => string} failed
 */
export function changeFailure(error, failed) {
  return error.whole === true ? error.message : failed(error.message);
}

/** How many tasks a group shows before "Show more". */
const GROUP_ROWS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the sidebar shows: how tasks are grouped, which groups are folded or
 * opened, the row under the pointer, the task whose menu is open, and the
 * rename and archive under way.
 */
export class SidebarState {
  /**
   * Creates retained input state and a focus handle, so it belongs in the
   * view's `init`, whose context it keeps for the waits below.
   * @param {{ changed: () => void, report: (message: string) => void,
   *   renamed: (session: object) => void, archived: (sessionId: string) => void,
   *   focusRoot: () => void }} hooks
   *   `renamed` gets the session as the Host committed the new title,
   *   `archived` the id of a task the Host archived, and `focusRoot` gives
   *   the keyboard back to the window after a rename ends from it
   */
  constructor(hooks, cx) {
    this.hooks = hooks;
    this.changed = hooks.changed;
    this.cx = cx;
    /** "time" or "project". */
    this.grouping = 'time';
    this.folded = new Set();
    this.expanded = new Set();
    /** The id of the row under the pointer, or null. */
    this.hovered = null;
    /** The id of the task whose menu is open, or null. */
    this.menu = null;
    /**
     * The rename under way, `{ session, original, saving, title, focused }`,
     * or null. The title is edited in `name`, starting from `original`, the
     * title the row showed; `saving` while the Host is asked for `title`, and
     * `focused` once the field has the keyboard.
     */
    this.renaming = null;
    /** Whether the name being edited is longer than the Host takes. */
    this.tooLong = false;
    /** id -> `{ title, revision }` of a rename the catalog has not brought yet. */
    this.titles = new Map();
    /**
     * id -> 'running' while the Host archives a task, then the revision it
     * was archived at: the row shows it being archived until the catalog
     * drops it, or lists it again at a later revision (restored).
     */
    this.archiving = new Map();
    this.name = InputState.new({ placeholder: t('renameTask') });
    onLanguageChange(() => this.name.set_placeholder(t('renameTask')));
    // Enter saves; leaving the field saves too, as Finder does. Escape is
    // handled on the row (renameRow).
    this.name.on('submit', () => this.commitRename(true));
    this.name.on('blur', () => this.commitRename(false));
    this.name.on('focus', () => {
      if (this.renaming !== null) this.renaming.focused = true;
    });
    this.name.on('change', () => {
      const tooLong = [...this.name.value().trim()].length > MAX_TITLE;
      if (tooLong !== this.tooLong) {
        this.tooLong = tooLong;
        this.changed();
      }
    });
    /** On the row around the field: what the keyboard is moved from to reach it (focusField). */
    this.renameFocus = cx.focus_handle();
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

  /** Notes the row under the pointer; the "…" button shows on it. */
  hover(id, hovered) {
    const next = hovered ? id : this.hovered === id ? null : this.hovered;
    if (next === this.hovered) return;
    this.hovered = next;
    this.changed();
  }

  /**
   * Whether the row of `session` shows the "…" button: it is under the
   * pointer, selected or its menu is open, and it is not being archived.
   */
  showsMenu(session, selected) {
    return (
      !this.isArchiving(session) &&
      (this.menu === session.id || selected || this.hovered === session.id)
    );
  }

  /** Whether the row of `session`, as the catalog lists it, shows it being archived. */
  isArchiving(session) {
    const state = this.archiving.get(session.id);
    return state === 'running' || (typeof state === 'number' && session.revision < state);
  }

  /** Opens the menu of task `id` (the "…" button or a right-click), or closes it. */
  setMenu(id, open) {
    if (open && this.renaming?.session.id === id) return;
    if (open) this.menu = id;
    else if (this.menu === id) this.menu = null;
    this.changed();
  }

  /** The title a row shows: a new one the Host committed before the catalog brought it, else the catalog's. */
  title(session) {
    const renamed = this.titles.get(session.id);
    if (renamed === undefined) return session.title;
    if (session.revision >= renamed.revision) {
      this.titles.delete(session.id);
      return session.title;
    }
    return renamed.title;
  }

  /** Unfolds the group `session` is in and shows all of it when the row would be under "Show more". */
  reveal(session, sessions) {
    const key = groupKey(session, this.grouping, Date.now());
    this.folded.delete(key);
    const now = Date.now();
    const index = sessions
      .filter((entry) => groupKey(entry, this.grouping, now) === key)
      .findIndex((entry) => entry.id === session.id);
    if (index >= GROUP_ROWS) this.expanded.add(key);
  }

  /**
   * Turns the row of `session` into a field holding its title, focused with
   * all of it selected.
   */
  startRename(session) {
    this.menu = null;
    if (this.renaming?.saving) return;
    if (this.renaming?.session.id === session.id) return;
    const original = this.title(session);
    const renaming = { session, original, saving: false, title: null, focused: false };
    this.renaming = renaming;
    this.tooLong = false;
    this.name.set_value(original);
    log(`sessions: renaming ${session.id}`);
    this.changed();
    this.cx.spawn(async (cx) => this.focusField(renaming, cx));
  }

  /**
   * Moves the keyboard into the field. An input's focus belongs to its
   * state, which has no focus call, so the keyboard goes to the row around
   * the field and then to the next tab stop, the field. That needs a frame
   * with the field drawn: an attempt that lands elsewhere (the field was not
   * drawn yet) is made again, after waiting for the field's focus event.
   * GPUI reports no focus path for an inactive window, so there the event
   * only comes once the window is active again and one attempt is all
   * there is.
   */
  async focusField(renaming, cx) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await cx.sleep(50);
      if (this.renaming !== renaming || renaming.focused) break;
      this.renameFocus.focus();
      window.focus_next();
      if (!window.is_window_active()) break;
      for (let waited = 0; waited < 10 && this.renaming === renaming && !renaming.focused; waited += 1) {
        await cx.sleep(50);
      }
      if (this.renaming !== renaming || renaming.focused) break;
    }
    if (this.renaming !== renaming) return;
    this.name.set_selected_range({ start: 0, end: this.name.value().length });
    log(`sessions: the name field ${renaming.focused ? 'has the keyboard' : 'was given the keyboard (no focus event yet)'}`);
  }

  /**
   * Saves the name being edited: Enter (`fromKeyboard`) or the field losing
   * the keyboard. An empty or unchanged name ends editing; one longer than
   * the Host takes keeps it, with the reason under the field. While the Host
   * is asked the field shows the new title, disabled.
   */
  async commitRename(fromKeyboard) {
    const renaming = this.renaming;
    if (renaming === null || renaming.saving) return;
    const title = this.name.value().trim();
    if (title === '' || title === renaming.original) {
      this.endRename(fromKeyboard);
      return;
    }
    if ([...title].length > MAX_TITLE) {
      this.tooLong = true;
      this.changed();
      return;
    }
    renaming.saving = true;
    renaming.title = title;
    this.changed();
    try {
      const session = await renameSession(renaming.session, title);
      log(`sessions: renamed ${session.id} at revision ${session.revision}`);
      this.titles.set(session.id, { title: session.title, revision: session.revision });
      this.hooks.renamed(session);
    } catch (error) {
      this.hooks.report(t('renameFailed', { value: error.message }));
    } finally {
      if (this.renaming === renaming) this.endRename(fromKeyboard);
    }
  }

  /** Leaves the name as it was (Escape). */
  cancelRename() {
    if (this.renaming === null || this.renaming.saving) return;
    log(`sessions: rename of ${this.renaming.session.id} cancelled`);
    this.endRename(true);
  }

  /** Ends editing; `focusRoot` when the keyboard was in the field, so the shortcuts work again. */
  endRename(focusRoot) {
    this.renaming = null;
    this.tooLong = false;
    this.changed();
    if (focusRoot) this.hooks.focusRoot();
  }

  /** Puts the task's id on the clipboard. */
  copyId(session, cx) {
    this.menu = null;
    cx.write_to_clipboard(session.id);
    log(`sessions: copied the id of ${session.id}`);
    this.changed();
  }

  /**
   * Archives the task. The row shows the running glyph until the catalog
   * drops it; the window leaves the task when it is open (`archived`).
   */
  async archive(session) {
    this.menu = null;
    if (this.isArchiving(session) || session.activity !== 'idle') {
      this.changed();
      return;
    }
    this.archiving.set(session.id, 'running');
    this.changed();
    try {
      const result = await changeSession(session, 'archive');
      log(`sessions: archived ${session.id}`);
      this.archiving.set(session.id, result.session.revision);
      this.hooks.archived(session.id);
    } catch (error) {
      this.archiving.delete(session.id);
      log(`sessions: archiving ${session.id} failed: ${error.message}`);
      this.hooks.report(changeFailure(error, (value) => t('archiveFailed', { value })));
    } finally {
      this.changed();
    }
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

/** The key of the group `session` is listed in. */
function groupKey(session, grouping, now) {
  return grouping === 'time'
    ? timeGroup(session.updatedAt, now)
    : `project:${session.workspace?.path ?? ''}`;
}

/** The sessions in groups, newest first: by day, or by the folder they work in. */
function groups(sessions, grouping) {
  const now = Date.now();
  /** @type {Map<string, { key: string, label: string, path: string | null, sessions: object[] }>} */
  const byKey = new Map();
  for (const session of sessions) {
    const path = session.workspace?.path ?? '';
    const key = groupKey(session, grouping, now);
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
      shown.map((session) => taskRow(session, session.id === selectedId, ui, actions.select, cx)),
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

/**
 * One task: its title, then a lane at the end with the waiting and working
 * marks and its age. While the row is under the pointer, selected or its
 * menu is open, the "…" button takes the age's place. While it is being
 * archived, the running glyph does, and the row is dimmed. Being renamed, it
 * is the name field instead (renameRow).
 */
function taskRow(session, selected, ui, select, cx) {
  const m = palette(cx);
  if (ui.renaming?.session.id === session.id) return renameRow(ui, cx);
  const working = session.activity === 'working';
  const archiving = ui.isArchiving(session);
  const more = ui.showsMenu(session, selected);
  return typeset(Button.new(`session-${session.id}`), 'body')
    .w_full()
    .h(32)
    .pl(8)
    .pr(8)
    .gap(8)
    .items_center()
    .rounded(10)
    .text_color(archiving ? m.inkMuted : m.ink)
    .when(selected, (el) => el.bg(m.selected))
    .when(!selected, (el) => el.hover((style) => style.bg(m.hover)))
    .on_hover((hovered) => ui.hover(session.id, hovered))
    .when(!archiving, (el) => el.on_mouse_down('right', () => ui.setMenu(session.id, true)))
    .on_click(() => select(session))
    .child(div().flex_1().min_w_0().truncate().child(ui.title(session)))
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
        .when(archiving, (el) => el.child(icon('status-running', 14, m.inkMuted)))
        .when(more, (el) => el.child(taskMenu(session, ui, cx)))
        .when(!working && !archiving && !more, (el) =>
          el.child(text(compactAge(session.updatedAt), 'small', m.inkMuted)),
        ),
    );
}

/**
 * The "…" button and the menu it opens: Rename (F2), Copy task ID, then
 * Archive, which only an idle task offers. The button's press opens the
 * menu and goes no further, so the row under it is not selected; the menu
 * hangs 8 under the row with its end on the row's end, as the native
 * client's does (the button sits 8 in from the row's end and 6 above its
 * bottom).
 */
function taskMenu(session, ui, cx) {
  const m = palette(cx);
  const open = ui.menu === session.id;
  const idle = session.activity === 'idle';
  return Popover.new(`task-menu-${session.id}`)
    .anchor('top_right')
    .open(open)
    .on_open_change((value) => ui.setMenu(session.id, value))
    .trigger(
      iconButton(`task-more-${session.id}`, 'more', cx, 20, 14)
        .accessibility_label(t('taskActions', { title: ui.title(session) }))
        .rounded_full()
        .when(open, (el) => el.bg(m.hover)),
    )
    .content(
      menuSurface(cx)
        .id(`task-menu-rows-${session.id}`)
        .mt(14)
        .mr(-8)
        .child(
          menuRow('task-rename', t('renameTask'), { icon: 'tool-edit', detail: 'F2' }, cx).on_click(
            () => ui.startRename(session),
          ),
        )
        .child(
          menuRow('task-copy-id', t('copyTaskId'), { icon: 'copy' }, cx).on_click((_, cx) =>
            ui.copyId(session, cx),
          ),
        )
        .child(menuSeparator(cx))
        .child(
          menuRow('task-archive', t('archiveTask'), { icon: 'archive', disabled: !idle }, cx)
            .when(!idle, (el) => el.tooltip(t('sessionChangeBusy')))
            .on_click(() => ui.archive(session)),
        ),
    );
}

/**
 * The row of the task being renamed: the name field in the row's 32, its
 * text where the title starts. Escape leaves the name as it was. While the
 * Host is asked, the new name shows in a disabled field (an input cannot be
 * disabled, so a box drawn like it); a name that is too long says so under
 * the field.
 */
function renameRow(ui, cx) {
  const m = palette(cx);
  const renaming = ui.renaming;
  const field = renaming.saving
    ? typeset(div(), 'body')
        .w_full()
        .h(32)
        .px(7)
        .flex()
        .items_center()
        .rounded(10)
        .border_1()
        .border_color(m.borderStrong)
        .bg(m.plate)
        .text_color(m.inkMuted)
        .opacity(0.6)
        .child(div().min_w_0().truncate().child(renaming.title))
    : textField(ui.name, cx).px(7);
  return v_flex()
    .w_full()
    .child(
      h_flex()
        .w_full()
        .h(32)
        .items_center()
        .track_focus(ui.renameFocus)
        .on_key_down((event) => {
          if (event.key === 'escape') ui.cancelRename();
        })
        .child(field),
    )
    .when(ui.tooLong, (el) =>
      el.child(text(t('taskNameTooLong'), 'small', m.destructive).pl(8).pb(4)),
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
