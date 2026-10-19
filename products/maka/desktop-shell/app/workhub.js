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

// WorkHub: one conversation per Host that stays, with a coordinator that
// routes the work it is given as tasks into ordinary sessions of the worker
// (the `agent` endpoint, so those sessions are in the sidebar too) and brings
// the results back.
//
// `workhub.coordinator` says whether it is set up; `workhub.resolve` sets it
// up in a folder, which the first call fixes for good. The conversation is a
// session of the `coordinator` endpoint, drawn as a task's is (transcript.js
// with that endpoint). The tasks come a page at a time from
// `workhub.watchTasks`, and each one's status from `workhub.watchTask`, read
// and worded as the TUI's WorkHub screen does
// (plugins/workhub/workhub-root/index.ts). Its subagents (`workhub.presets`,
// edited in Settings, subagents.js) are read with the coordinator, so the
// conversation can say when there is none to delegate with.

import { div } from 'gpui-kit';
import { v_flex, h_flex, Button } from 'gpui-base';
import { chooseFolder } from 'maka-files';
import { query, subscribe, next, close, operation, log } from './host.js';
import { Transcript, markdownText } from './transcript.js';
import { shortPath } from './directories.js';
import {
  palette,
  typeset,
  text,
  icon,
  dot,
  ghostButton,
  controlButton,
  segmentedControl,
  compactAge,
} from './theme.js';
import { t } from './locale.js';

/**
 * The worker whose sessions the desktop can open: the `agent` endpoint, which
 * the bundle imports into WorkHub under this name (products/maka/bundle
 * composition.ts). The name is internal and never shown.
 */
export const WORKER = 'worker';

/** Why the Host did not set WorkHub up (`AgentRejection`), in words. */
const REJECTIONS = {
  title_invalid: 'workhubRejectedTitle',
  labels_invalid: 'workhubRejectedLabels',
  tools_unavailable: 'workhubRejectedTools',
  busy: 'workhubRejectedBusy',
  workspace_unavailable: 'workhubRejectedFolder',
  session_unavailable: 'workhubRejectedSession',
  closed: 'workhubRejectedClosed',
};

export class WorkHub {
  /**
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   * @param {import('./directories.js').Directories} directories finds a chosen
   *   folder in the Host's listing, and names a set-up folder
   */
  constructor(hooks, directories) {
    this.hooks = hooks;
    this.directories = directories;
    /** Whether WorkHub is the place the window shows. */
    this.open = false;
    /** Counts the times WorkHub was shown or left; an answer for an earlier visit is dropped. */
    this.visit = 0;
    /** What `workhub.coordinator` or `workhub.resolve` last answered, or null before then. */
    this.coordinator = null;
    this.loading = false;
    /** Why reading the coordinator failed, until it is read again. */
    this.readError = null;
    /** Whether the folder panel is up, and whether a setup is under way. */
    this.choosing = false;
    this.settingUp = false;
    /** Why the last setup did not go through, in words, until one does; shown under "not set up". */
    this.setupProblem = null;
    /** The coordinator's conversation while WorkHub is open and set up. */
    this.transcript = null;
    /** The tab shown once WorkHub is set up: 'chat' or 'tasks'. */
    this.tab = 'chat';
    /** The page of tasks as `watchTasks` last sent it, `{ entries, after }`, or null until then. */
    this.page = null;
    /**
     * The cursor the page is read from: null for the first page. The Host
     * pages tasks 16 at a time, the most recently accepted first.
     */
    this.pageAfter = null;
    /** taskId -> the task as `watchTask` last sent it. */
    this.tasks = new Map();
    /** taskId -> its entry, for every task a page listed: notices in the conversation name them. */
    this.entries = new Map();
    /** taskId -> the title of a task a notice named and no page listed; null while it is read, or when that failed. */
    this.titles = new Map();
    /**
     * The task whose detail shows, or null for the list: `{ entry, more,
     * reading, problem }`, `more` being the reply's pages read after its
     * first one, `{ invocationId, text, next }`, or null, and `problem` why
     * the last thing done there failed, in words.
     */
    this.selected = null;
    /**
     * The subscriptions of the tasks tab, `{ handle, closed }` each: the
     * page's, and taskId -> its task's. One that is closed is replaced, never
     * opened again.
     */
    this.pageWatch = null;
    this.taskWatches = new Map();
    /**
     * Set when a subscription of the tasks tab ended or failed, until they are
     * opened again: `{ error }`, the error's message or null when the Host
     * ended it.
     */
    this.stopped = null;
    /**
     * The subagents, `{ revision, entries }` as `workhub.presets` answers, as
     * last read or as Settings last read or saved them; null until read, and
     * after a read failed.
     */
    this.presets = null;
    /** Counts the reads of the subagents and the lists taken from Settings; an older read is dropped. */
    this.presetReads = 0;
  }

  /**
   * Whether WorkHub is set up, and its conversation and tasks can show: as
   * last read, kept while it is read again, and not while that read failed.
   */
  ready() {
    return this.coordinator?.kind === 'ready' && this.readError === null;
  }

  /** The conversation while its tab shows, else null. */
  chat() {
    return this.ready() && this.tab === 'chat' ? this.transcript : null;
  }

  /** Becomes the place the window shows: reads the coordinator, and opens the tab's subscriptions. */
  async show() {
    if (this.open) return;
    this.open = true;
    this.visit += 1;
    if (this.tab === 'tasks') this.watchTasks();
    this.hooks.changed();
    await this.load();
  }

  /** Stops being shown: the subscriptions and the conversation's watch close. */
  async hide() {
    if (!this.open) return;
    this.open = false;
    this.visit += 1;
    this.unwatchTasks();
    const transcript = this.transcript;
    this.transcript = null;
    this.hooks.changed();
    if (transcript !== null) await transcript.close();
  }

  /** Reads whether WorkHub is set up, and its subagents; once it is set up, its conversation opens. */
  async load() {
    const visit = this.visit;
    this.loading = true;
    this.readError = null;
    this.hooks.changed();
    this.readPresets();
    try {
      const coordinator = await query('workhub', 'coordinator', {});
      if (visit === this.visit) this.accept(coordinator);
    } catch (error) {
      if (visit !== this.visit) return;
      log(`workhub: reading the coordinator failed: ${error.message}`);
      this.readError = error.message;
    } finally {
      if (visit === this.visit) {
        this.loading = false;
        this.hooks.changed();
      }
    }
  }

  /** Reads the subagents. A failure is logged and leaves them unread; it is not reported. */
  async readPresets() {
    const read = ++this.presetReads;
    try {
      const presets = await query('workhub', 'presets', {});
      if (read !== this.presetReads) return;
      this.presets = presets;
      log(`workhub: ${presets.entries.length} subagents at revision ${presets.revision}`);
    } catch (error) {
      if (read !== this.presetReads) return;
      this.presets = null;
      log(`workhub: reading the subagents failed: ${error.message}`);
    }
    this.hooks.changed();
  }

  /** Takes the subagents as Settings read or saved them; a read under way is dropped. */
  acceptPresets(snapshot) {
    this.presetReads += 1;
    this.presets = snapshot;
    this.hooks.changed();
  }

  /** Takes what the Host said of the coordinator; a ready one's conversation opens. */
  accept(coordinator) {
    log(`workhub: coordinator ${coordinator.kind}`);
    this.coordinator = coordinator;
    if (coordinator.kind === 'ready') {
      this.setupProblem = null;
      this.attach(coordinator.session);
    }
    this.hooks.changed();
  }

  /**
   * Opens the conversation of `session` while WorkHub shows, at `anchor` and
   * `anchorField` when given (Transcript).
   */
  attach(session, anchor = null, anchorField = null) {
    if (!this.open || (this.transcript?.id === session.id && anchor === null)) return;
    this.transcript?.close();
    // A notice that a task ended names it and shows it in the Tasks tab.
    const hooks = {
      ...this.hooks,
      taskTitle: (taskId) => this.titleOf(taskId),
      openTask: (taskId, worker) => this.openTask(taskId, worker),
    };
    const transcript = new Transcript(session, hooks, 'coordinator', { anchor, anchorField });
    this.transcript = transcript;
    transcript.open();
  }

  /** Shows the folder panel and sets WorkHub up in the folder chosen there. */
  async chooseFolder() {
    if (this.choosing || this.settingUp) return;
    this.choosing = true;
    this.hooks.changed();
    let path;
    try {
      path = await chooseFolder({ prompt: t('choose') });
    } catch (error) {
      this.setupProblem = t('chooseFolderFailed', { value: error.message });
      return;
    } finally {
      this.choosing = false;
      this.hooks.changed();
    }
    if (path !== null) await this.setUpIn(path);
  }

  /** Finds `path` in the Host's folders and sets WorkHub up there, as a folder from the panel is. */
  async setUpIn(path) {
    if (this.settingUp) return;
    let directory;
    try {
      directory = await this.directories.find(path);
    } catch (error) {
      this.setupProblem = error.message;
      this.hooks.changed();
      return;
    }
    await this.setUp(directory.selection);
  }

  /**
   * Sets WorkHub up in `workspace` with `workhub.resolve`, or continues the
   * setup a pending coordinator has with its own. Never retried: when the
   * answer is lost or refused, the coordinator is read again to say where the
   * setup stands, since a first call may have fixed the folder already.
   */
  async setUp(workspace) {
    if (this.settingUp) return;
    this.settingUp = true;
    this.setupProblem = null;
    this.hooks.changed();
    try {
      const coordinator = await operation('workhub', 'resolve', { workspace });
      if (coordinator.kind !== 'rejected') {
        this.accept(coordinator);
        return;
      }
      log(`workhub: setup rejected: ${JSON.stringify(coordinator.reason)}`);
      this.setupProblem = rejection(coordinator.reason);
    } catch (error) {
      this.setupProblem = error.message;
    } finally {
      this.settingUp = false;
      this.hooks.changed();
    }
    await this.load();
  }

  /** Where a pending setup works, as the folder menu writes a path, or null when no root holds it. */
  folderOf(workspace) {
    const roots = this.directories.roots;
    const root = roots.find((entry) => entry.selection?.rootId === workspace.rootId);
    if (root === undefined) return null;
    const path = [root.path.replace(/\/$/, ''), ...workspace.segments].join('/');
    return shortPath(path, roots);
  }

  showTab(tab) {
    if (this.tab === tab) return;
    this.tab = tab;
    if (tab === 'tasks') this.watchTasks();
    else this.unwatchTasks();
    this.hooks.changed();
  }

  /** Shows the page of tasks at `after` (null for the first). */
  showPage(after) {
    this.pageAfter = after;
    this.page = null;
    this.watchTasks();
    this.hooks.changed();
  }

  /** Shows one task's detail. */
  showTask(entry) {
    this.selected = { entry, more: null, reading: false, problem: null };
    this.syncTaskWatches();
    this.hooks.changed();
  }

  /**
   * The title of the task `taskId`, as a page listed it or as `workhub.task`
   * says it, which is read once for a task no page has listed; null until
   * then.
   */
  titleOf(taskId) {
    const entry = this.entries.get(taskId);
    if (entry !== undefined) return entry.title;
    if (!this.titles.has(taskId)) {
      this.titles.set(taskId, null);
      this.readTitle(taskId);
    }
    return this.titles.get(taskId);
  }

  async readTitle(taskId) {
    try {
      const task = await query('workhub', 'task', { taskId, cursor: null });
      this.titles.set(taskId, task.title ?? null);
      this.hooks.changed();
    } catch (error) {
      log(`workhub: reading the title of ${taskId} failed: ${error.message}`);
    }
  }

  /** Shows the detail of the task `taskId` in the Tasks tab, as a notice in the conversation asks. */
  openTask(taskId, worker) {
    const entry = this.entries.get(taskId) ?? {
      taskId,
      worker: worker ?? WORKER,
      title: this.titles.get(taskId) ?? '',
    };
    this.showTab('tasks');
    this.showTask(entry);
  }

  /** Goes back from a task's detail to the list. */
  showList() {
    this.selected = null;
    this.syncTaskWatches();
    this.hooks.changed();
  }

  /** Opens the tasks tab's subscriptions: the page's, and each listed task's. */
  watchTasks() {
    this.unwatchTasks();
    this.stopped = null;
    const watch = { handle: null, closed: false };
    this.pageWatch = watch;
    this.watchPage(watch);
    this.syncTaskWatches();
  }

  /** Closes them all; their loops end. */
  unwatchTasks() {
    for (const watch of [this.pageWatch, ...this.taskWatches.values()]) {
      if (watch !== null) stopWatch(watch);
    }
    this.pageWatch = null;
    this.taskWatches.clear();
  }

  /**
   * The single `next()` loop of the page's subscription. When it ends or
   * fails it is not opened again on its own: the list says its updates
   * stopped, and Retry opens them all again.
   */
  async watchPage(watch) {
    try {
      watch.handle = await subscribe('workhub', 'watchTasks', { after: this.pageAfter });
      log(`workhub: tasks after ${this.pageAfter} subscribed as ${watch.handle}`);
      for (;;) {
        if (watch.closed) return;
        const page = await next(watch.handle);
        if (watch.closed) return;
        if (page === null) break;
        this.page = page;
        for (const entry of page.entries) this.entries.set(entry.taskId, entry);
        this.syncTaskWatches();
        this.hooks.changed();
      }
      log('workhub: the Host ended the tasks subscription');
      this.stop(null);
    } catch (error) {
      if (watch.closed) return;
      log(`workhub: tasks: ${error.message}`);
      this.stop(error.message);
    } finally {
      stopWatch(watch);
    }
  }

  /**
   * Watches each task the page lists, and the selected one, and stops
   * watching the rest.
   */
  syncTaskWatches() {
    if (this.pageWatch === null) return;
    const wanted = new Set((this.page?.entries ?? []).map((entry) => entry.taskId));
    if (this.selected !== null) wanted.add(this.selected.entry.taskId);
    for (const [taskId, watch] of this.taskWatches) {
      if (wanted.has(taskId)) continue;
      stopWatch(watch);
      this.taskWatches.delete(taskId);
    }
    for (const taskId of wanted) {
      if (this.taskWatches.has(taskId)) continue;
      const watch = { handle: null, closed: false };
      this.taskWatches.set(taskId, watch);
      this.watchTask(taskId, watch);
    }
  }

  /** The single `next()` loop of one task's subscription, with the first page of its reply. */
  async watchTask(taskId, watch) {
    try {
      watch.handle = await subscribe('workhub', 'watchTask', { taskId, cursor: null });
      for (;;) {
        if (watch.closed) return;
        const task = await next(watch.handle);
        if (watch.closed) return;
        if (task === null) break;
        this.tasks.set(taskId, task);
        this.hooks.changed();
      }
      log(`workhub: the Host ended the subscription of ${taskId}`);
      this.stop(null);
    } catch (error) {
      if (watch.closed) return;
      log(`workhub: ${taskId}: ${error.message}`);
      this.stop(error.message);
    } finally {
      stopWatch(watch);
    }
  }

  /**
   * Says why something done in a task's detail failed, under it while it
   * shows; reported as other failures are once it does not.
   */
  fail(message) {
    if (this.open && this.selected !== null) {
      this.selected.problem = message;
      this.hooks.changed();
    } else {
      this.hooks.report(message);
    }
  }

  /** Records that the tasks stopped updating, and the error when one stopped them; what was read stays. */
  stop(error) {
    this.stopped = { error };
    this.hooks.changed();
  }

  /**
   * The selected task's reply as read so far, `{ text, next }`, or null
   * while it has none: the first page comes with its status, and Continue
   * reading adds the pages after it. `next` is the cursor of the page after,
   * or null at the end. Pages read from an earlier run of the task are left
   * out.
   */
  answer() {
    const work = progressOf(this.tasks.get(this.selected.entry.taskId));
    const first = work?.kind === 'delivered' ? work.answer : null;
    if (first == null) return null;
    const more = this.selected.more;
    if (more === null || more.invocationId !== work.execution.invocationId) return first;
    return { text: first.text + more.text, next: more.next };
  }

  /** Reads the page of the selected task's reply after the ones shown, and adds it. */
  async readMore() {
    const selected = this.selected;
    const cursor = selected === null ? null : (this.answer()?.next ?? null);
    if (cursor === null || selected.reading) return;
    selected.reading = true;
    selected.problem = null;
    this.hooks.changed();
    try {
      const task = await query('workhub', 'task', { taskId: selected.entry.taskId, cursor });
      const work = progressOf(task);
      const page = work?.kind === 'delivered' ? work.answer : null;
      if (page == null || work.execution.invocationId !== cursor.invocationId) {
        // The task ran again meanwhile; its new reply starts over.
        log(`workhub: the reply of ${selected.entry.taskId} changed`);
        selected.more = null;
      } else {
        const before =
          selected.more?.invocationId === cursor.invocationId ? selected.more.text : '';
        selected.more = {
          invocationId: cursor.invocationId,
          text: before + page.text,
          next: page.next,
        };
      }
    } catch (error) {
      selected.problem = t('workhubReadMoreFailed', { value: error.message });
    } finally {
      selected.reading = false;
      this.hooks.changed();
    }
  }
}

/** Why the Host did not set WorkHub up, in words. */
function rejection(reason) {
  return Object.hasOwn(REJECTIONS, reason) ? t(REJECTIONS[reason]) : JSON.stringify(reason);
}

function stopWatch(watch) {
  watch.closed = true;
  if (watch.handle !== null) close(watch.handle).catch(() => {});
}

/** The progress of a task that was handed to its session (`AgentWork`), or null. */
function progressOf(task) {
  const status = task?.status;
  return status?.kind === 'started' || status?.kind === 'queued' ? (status.progress ?? null) : null;
}

/** The worker session a task runs in, or null when it has none yet or it is not the worker's. */
export function sessionOf(task, entry) {
  if (task === null || task.worker !== WORKER || entry.worker !== WORKER) return null;
  return task.status.sessionId ?? null;
}

/**
 * A task's status in words, and how its glyph marks it: 'running',
 * 'waiting', 'done', 'failed', 'stopped' or null (a plain dot). The words
 * follow the TUI's WorkHub screen (workhub-root/index.ts `status`).
 * @returns {[string, string | null]}
 */
export function taskStatus(task) {
  const status = task.status;
  switch (status.kind) {
    case 'blocked':
      return [t('workhubBlocked', { count: status.dependencies.length }), null];
    case 'cancelled':
      return [t('workhubCancelled'), 'stopped'];
    case 'preparing':
      switch (status.state.kind) {
        case 'pending':
          return [preparing(status.stage), 'running'];
        case 'rejected':
          return [t('workhubRejectedReason', { reason: status.state.reason }), 'failed'];
        case 'unavailable':
          return [t('workhubUnavailable'), null];
        default:
          // Uncertain, or waiting on the original call that sent the files.
          return [t('workhubUnknown'), null];
      }
    case 'pending':
      return [t('workhubSubmitted'), null];
    case 'unavailable':
      return [t('workhubUnavailable'), null];
    case 'rejected':
      return [t('workhubRejectedReason', { reason: status.reason }), 'failed'];
    case 'started':
    case 'queued':
      return workStatus(status.progress ?? null);
    default:
      return [t('workhubUnknown'), null];
  }
}

function preparing(stage) {
  switch (stage.kind) {
    case 'create':
      return t('workhubCreating');
    case 'attachment':
      return t('workhubUploading', { index: stage.index + 1, total: stage.total });
    default:
      return t('workhubDelivering');
  }
}

/** The status of a task handed to its session, by its progress there. */
function workStatus(work) {
  if (work === null || work.kind === 'missing') return [t('workhubUnavailable'), null];
  if (work.kind === 'changed') return [t('workhubChanged'), null];
  if (work.kind === 'cancelled') return [t('workhubCancelled'), 'stopped'];
  if (work.kind === 'pending') return [t('workhubQueued'), null];
  if (work.pendingInteractions > 0) return [t('workhubWaiting'), 'waiting'];
  switch (work.execution.state) {
    case 'admitted':
      return [t('workhubSubmitted'), null];
    case 'running':
      return [t('workhubRunning'), 'running'];
    case 'waiting':
      return [t('workhubWaiting'), 'waiting'];
    case 'paused':
      return [t('workhubPaused'), null];
    case 'completed':
      return [t('workhubCompleted'), 'done'];
    case 'failed':
      return [t('failed'), 'failed'];
    case 'cancelled':
      return [t('workhubCancelled'), 'stopped'];
    default:
      return [t('workhubUnknown'), null];
  }
}

/**
 * The status of a listed task: its own once it is read; until then that it
 * is being read, or that it cannot be while the updates are stopped.
 * @returns {[string, string | null]}
 */
function listedStatus(workhub, taskId) {
  const task = workhub.tasks.get(taskId);
  if (task !== undefined) return taskStatus(task);
  return [workhub.stopped !== null ? t('workhubUnavailable') : t('loading'), null];
}

/** The glyph for how a status is marked (see taskStatus); the running one turns. */
function statusGlyph(mark, size, cx) {
  const m = palette(cx);
  switch (mark) {
    case 'running':
      return icon('status-running', size, m.primary);
    case 'waiting':
      return icon('status-waiting', size, m.warning);
    case 'done':
      return icon('status-done', size, m.inkMuted);
    case 'failed':
      return icon('status-failed', size, m.destructive);
    case 'stopped':
      return icon('status-stopped', size, m.inkMuted);
    default:
      return dot(m.inkDisabled);
  }
}

/** The header's tabs once WorkHub is set up: the conversation and the tasks. Null before. */
export function workhubTabs(workhub, cx) {
  if (!workhub.ready()) return null;
  return segmentedControl(
    'workhub-tab',
    [
      ['chat', t('workhubChat')],
      ['tasks', t('workhubTasks')],
    ],
    workhub.tab,
    (tab) => workhub.showTab(tab),
    cx,
  ).w(168);
}

/** What an empty WorkHub conversation shows: what to ask it for. */
export function chatHint(cx) {
  const m = palette(cx);
  return v_flex()
    .max_w(560)
    .px(24)
    .gap(8)
    .items_center()
    .child(text(t('workhubChatTitle'), 'display', m.ink).text_center())
    .child(text(t('workhubChatHint'), 'body', m.inkMuted).text_center());
}

/**
 * The plate's body under WorkHub's header when its conversation does not
 * show: the setup until WorkHub is set up, then the task list or one task.
 * `actions.openSession(sessionId)` shows a worker session in the task view.
 * @param {WorkHub} workhub
 * @param {{ openSession: (sessionId: string) => void }} actions
 */
export function workhubBody(workhub, actions, cx) {
  if (!workhub.ready()) return setup(workhub, cx);
  if (workhub.tab === 'chat') return centered(loadingLine(t('loading'), cx));
  if (workhub.selected !== null) return taskDetail(workhub, actions, cx);
  return taskList(workhub, cx);
}

/** Content centered in the plate's body. */
function centered(child) {
  return v_flex()
    .flex_1()
    .min_h_0()
    .w_full()
    .items_center()
    .justify_center()
    .px(24)
    .py(32)
    .child(child);
}

/** The running glyph and a line saying what is being read. */
function loadingLine(words, cx) {
  const m = palette(cx);
  return h_flex()
    .h(32)
    .gap(8)
    .items_center()
    .child(icon('status-running', 16, m.primary))
    .child(text(words, 'body', m.inkMuted));
}

/** A warning on the tinted fill, as the connection banner draws one, with a button at its end. */
function warning(title, detail, button, cx) {
  const m = palette(cx);
  return h_flex()
    .w_full()
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
        .child(text(title, 'strong', m.ink))
        .when(detail !== null, (el) => el.child(text(detail, 'small', m.destructive))),
    )
    .when(button !== null, (el) => el.child(button));
}

/**
 * Before WorkHub is set up: what it is and the folder to choose, or the setup
 * to continue; while it is read, a line saying so, and when that failed, why,
 * with Retry.
 */
function setup(workhub, cx) {
  const m = palette(cx);
  if (workhub.readError !== null) {
    return centered(
      div()
        .w_full()
        .max_w(560)
        .child(
          warning(
            t('workhubReadFailed'),
            workhub.readError,
            controlButton('workhub-retry', t('retry'), 'quiet', workhub.loading, cx)
              .h(28)
              .on_click(() => workhub.load()),
            cx,
          ),
        ),
    );
  }
  const coordinator = workhub.coordinator;
  if (coordinator === null || coordinator.kind === 'ready') {
    return centered(loadingLine(t('workhubReading'), cx));
  }
  const pending = coordinator.kind === 'pending';
  const busy = workhub.choosing || workhub.settingUp || workhub.loading;
  const folder = pending ? workhub.folderOf(coordinator.workspace) : null;
  const problem =
    workhub.setupProblem ??
    (coordinator.kind === 'rejected' ? rejection(coordinator.reason) : null);
  const label = workhub.settingUp
    ? t('workhubSettingUp')
    : pending
      ? t('workhubContinueSetup')
      : problem !== null
        ? t('workhubChooseAnother')
        : t('chooseFolderMenu');
  const action = controlButton(
    pending ? 'workhub-continue' : 'workhub-choose-folder',
    label,
    'primary',
    busy,
    cx,
  ).on_click(() => (pending ? workhub.setUp(coordinator.workspace) : workhub.chooseFolder()));
  return centered(
    v_flex()
      .w_full()
      .max_w(520)
      .gap(8)
      .items_center()
      .child(text(t('workhubName'), 'display', m.ink).mb(4))
      .child(text(t('workhubIntro'), 'body', m.inkMuted).text_center())
      .child(
        text(
          pending ? t('workhubSetupPending') : t('workhubFolderNote'),
          'body',
          m.inkMuted,
        ).text_center(),
      )
      .when(folder !== null, (el) =>
        el.child(
          text(t('workhubSetupFolder', { path: folder }), 'small', m.inkMuted).text_center(),
        ),
      )
      .when(problem !== null, (el) =>
        el.child(
          div()
            .w_full()
            .mt(8)
            .child(warning(t('workhubNotSetUp'), problem, null, cx)),
        ),
      )
      .child(div().mt(16).child(action)),
  );
}

/** The column the tasks tab reads in: as wide as the transcript's, scrolling in the plate. */
function readingColumn(id, child) {
  return v_flex()
    .id(id)
    .flex_1()
    .min_h_0()
    .w_full()
    .overflow_y_scrollbar()
    .items_center()
    .px(24)
    .pt(8)
    .pb(32)
    .child(v_flex().w_full().max_w(720).child(child));
}

/**
 * The page of tasks: a row for each, the most recently accepted first, with
 * the buttons to the next page and back to the first. Above
 * them, when the updates stopped, a line saying so with Retry.
 */
function taskList(workhub, cx) {
  const m = palette(cx);
  const page = workhub.page;
  const stopped =
    workhub.stopped === null
      ? null
      : warning(
          t('workhubUpdatesStopped'),
          workhub.stopped.error,
          controlButton('workhub-tasks-retry', t('retry'), 'quiet', false, cx)
            .h(28)
            .on_click(() => workhub.watchTasks()),
          cx,
        );
  if (page === null) {
    return centered(
      stopped !== null
        ? div().w_full().max_w(720).child(stopped)
        : loadingLine(t('loadingTasks'), cx),
    );
  }
  const next = page.after;
  const paged = next !== null || workhub.pageAfter !== null;
  const pager = h_flex()
    .pt(16)
    .gap(8)
    .justify_center()
    .when(workhub.pageAfter !== null, (el) =>
      el.child(
        controlButton('workhub-first', t('workhubFirstPage'), 'outline', false, cx)
          .h(28)
          .on_click(() => workhub.showPage(null)),
      ),
    )
    .when(next !== null, (el) =>
      el.child(
        controlButton('workhub-more', t('workhubMoreTasks'), 'outline', false, cx)
          .h(28)
          .on_click(() => workhub.showPage(next)),
      ),
    );
  if (page.entries.length === 0) {
    return centered(
      v_flex()
        .w_full()
        .max_w(720)
        .gap(16)
        .items_center()
        .when(stopped !== null, (el) => el.child(stopped))
        .child(text(t('workhubNoTasks'), 'body', m.inkMuted).text_center())
        .when(paged, (el) => el.child(pager)),
    );
  }
  return readingColumn(
    'workhub-tasks',
    v_flex()
      .w_full()
      .gap(2)
      .when(stopped !== null, (el) => el.child(div().pb(8).child(stopped)))
      .children(page.entries.map((entry) => taskRow(workhub, entry, cx)))
      .when(paged, (el) => el.child(pager)),
  );
}

/** One task in the list: how it stands, its title, its status in words, and when it was accepted. */
function taskRow(workhub, entry, cx) {
  const m = palette(cx);
  const [words, mark] = listedStatus(workhub, entry.taskId);
  return typeset(Button.new(`workhub-task-${entry.taskId}`), 'body')
    .w_full()
    .h(40)
    .px(12)
    .gap(10)
    .items_center()
    .rounded(10)
    .text_color(m.ink)
    .hover((style) => style.bg(m.hover))
    .on_click(() => workhub.showTask(entry))
    .child(statusGlyph(mark, 16, cx))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .child(entry.title || t('workhubUntitled')),
    )
    .child(text(words, 'small', m.inkMuted).flex_none())
    .child(text(compactAge(entry.acceptedAt), 'small', m.inkMuted).flex_none());
}

/**
 * One task: back to the list, its title and status, the button that opens its
 * session, and its reply as Markdown, read on a page at a time.
 */
function taskDetail(workhub, actions, cx) {
  const m = palette(cx);
  const selected = workhub.selected;
  const entry = selected.entry;
  const task = workhub.tasks.get(entry.taskId) ?? null;
  const [words, mark] = listedStatus(workhub, entry.taskId);
  const sessionId = sessionOf(task, entry);
  const answer = workhub.answer();
  return readingColumn(
    'workhub-task',
    v_flex()
      .w_full()
      .gap(16)
      .child(
        h_flex().child(
          typeset(ghostButton('workhub-task-back', cx), 'body')
            .h(28)
            .pl(4)
            .pr(10)
            .gap(4)
            .rounded(8)
            .text_color(m.inkMuted)
            .on_click(() => workhub.showList())
            .child(icon('chevron-left', 16, m.inkMuted))
            .child(t('workhubAllTasks')),
        ),
      )
      .child(
        h_flex()
          .w_full()
          .gap(16)
          .items_center()
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .gap(4)
              .child(text(entry.title || t('workhubUntitled'), 'heading', m.ink))
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(statusGlyph(mark, 14, cx))
                  .child(text(words, 'small', m.inkMuted)),
              ),
          )
          .when(sessionId !== null, (el) =>
            el.child(
              controlButton(
                'workhub-open-session',
                t('workhubOpenSession'),
                'primary',
                false,
                cx,
              ).on_click(() => actions.openSession(sessionId)),
            ),
          ),
      )
      .child(div().w_full().h(1).bg(m.borderSoft))
      .child(
        answer === null
          ? text(t('workhubNoAnswer'), 'body', m.inkMuted)
          : markdownText(`workhub-answer-${entry.taskId}`, answer.text, cx),
      )
      .when(answer?.next != null, (el) =>
        el.child(
          h_flex().child(
            controlButton(
              'workhub-read-more',
              t('workhubReadMore'),
              'outline',
              selected.reading,
              cx,
            )
              .h(28)
              .on_click(() => workhub.readMore()),
          ),
        ),
      )
      .when(selected.problem !== null, (el) =>
        el.child(text(selected.problem, 'small', m.destructive)),
      ),
  );
}
