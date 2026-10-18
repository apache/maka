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

// The Workbar: a plate to the right of the conversation with its tools,
// Changes (changes.js), Files (files.js) and Terminal (terminal.js), one
// shown at a time. It serves the conversation the window shows, a task's or
// WorkHub's, and nothing else: main.js tells it which (`follow`) whenever
// the window changed, and everything it opened for the one before closes
// then.
//
// Whether it is open, the tool it shows and its width are the window's, not
// a task's, and are kept in localStorage so a restart keeps them.

import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { log } from './host.js';
import { Changes, changesBody } from './changes.js';
import { FileTree, filesBody } from './files.js';
import { Terminals, terminalBody } from './terminal.js';
import { palette, text, icon, ghostButton, iconButton, segmentedControl } from './theme.js';
import { t } from './locale.js';

const STORAGE_KEY = 'maka.workbar';
const TOOLS = ['changes', 'files', 'terminal'];

/** The Workbar's width: at first, and the range a drag keeps it in. */
export const WORKBAR_WIDTH = { initial: 420, min: 320, max: 720 };

/** The shortcut that shows Changes, as the button's tooltip writes it (main.js binds it). */
const CHANGES_SHORTCUT = '⌃⇧G';

function stored() {
  const state = { open: false, tool: 'changes', width: WORKBAR_WIDTH.initial };
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof value?.open === 'boolean') state.open = value.open;
    if (TOOLS.includes(value?.tool)) state.tool = value.tool;
    if (Number.isFinite(value?.width)) {
      state.width = Math.min(WORKBAR_WIDTH.max, Math.max(WORKBAR_WIDTH.min, value.width));
    }
  } catch {
    // Unreadable: the defaults.
  }
  return state;
}

export class Workbar {
  /**
   * Creates a focus handle, so it belongs in the view's `init`, whose context
   * it keeps for the timers of the status reads.
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   */
  constructor(hooks, cx) {
    this.hooks = hooks;
    this.cx = cx;
    const state = stored();
    this.open = state.open;
    /** 'changes', 'files' or 'terminal'. */
    this.tool = state.tool;
    this.width = state.width;
    /** On the Workbar's plate: a press inside gives it the keyboard, for Escape, Enter, [ and ]. */
    this.focus = cx.focus_handle();
    /** The conversation it serves (a Transcript), or null where there is none. */
    this.transcript = null;
    /** Its Changes, Files and Terminals, made with it. */
    this.changes = null;
    this.files = null;
    this.terminals = null;
    /** How many runs of the conversation had ended, and its rows, when last looked at (see follow). */
    this.runsEnded = 0;
    this.rows = null;
  }

  save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ open: this.open, tool: this.tool, width: this.width }),
      );
    } catch {
      // Not kept; the next start opens as before.
    }
  }

  /** Whether the Workbar is on screen: open, beside a conversation. */
  shown() {
    return this.open && this.transcript !== null;
  }

  /**
   * Takes the conversation the window shows now (a Transcript, or null on
   * the start pane, Search, Settings and WorkHub's tasks) and what it is
   * doing. A new one closes the last one's reads and watches and reads its
   * status: the header's button counts its changes even while the Workbar
   * is closed. After that the status is read again when a run ends (the
   * transcript counts them, so a run that opened and ended between two
   * looks counts too) and, while Changes shows, at most every 2 s while a
   * run adds rows. Files and Terminal watch only while they show. Called
   * whenever the window changed, so it does nothing unless something it
   * looks at did.
   */
  follow(transcript) {
    if (transcript !== this.transcript) {
      this.changes?.close();
      this.files?.close();
      this.terminals?.close();
      this.transcript = transcript;
      this.changes = null;
      this.files = null;
      this.terminals = null;
      if (transcript !== null) {
        log(`workbar: following ${transcript.id} (${transcript.endpoint})`);
        this.changes = new Changes(transcript, this.hooks, this.cx);
        this.files = new FileTree(transcript, this.hooks, this.cx);
        this.terminals = new Terminals(transcript, this.hooks, this.cx);
        this.runsEnded = transcript.runsEnded;
        this.rows = transcript.rows;
        this.changes.refresh();
      }
    }
    if (transcript === null) return;
    const showingChanges = this.open && this.tool === 'changes';
    this.changes.showing = showingChanges;
    if (this.open && this.tool === 'files') this.files.show();
    else this.files.hide();
    if (this.open && this.tool === 'terminal') this.terminals.show();
    else this.terminals.hide();
    if (transcript.runsEnded !== this.runsEnded) {
      log('workbar: a run ended; reading the status');
      this.changes.refresh();
    } else if (transcript.run !== null && transcript.rows !== this.rows && showingChanges) {
      this.changes.refreshSoon();
    }
    this.runsEnded = transcript.runsEnded;
    this.rows = transcript.rows;
  }

  /**
   * The shortcuts and the header's button: shows `tool`, or closes the
   * Workbar when it shows that tool already. Nothing without a conversation.
   */
  toggle(tool) {
    if (this.transcript === null) return;
    if (this.open && this.tool === tool) this.open = false;
    else {
      this.open = true;
      this.tool = tool;
    }
    this.changedState();
  }

  /** Shows `tool` (the header's segments). */
  choose(tool) {
    if (this.open && this.tool === tool) return;
    this.open = true;
    this.tool = tool;
    this.changedState();
  }

  /** The close button. */
  close() {
    if (!this.open) return;
    this.open = false;
    this.changedState();
  }

  /**
   * Keeps what changed, reads the status when Changes shows, and opens or
   * closes Files' and Terminal's subscriptions.
   */
  changedState() {
    log(`workbar: ${this.open ? `showing ${this.tool}` : 'closed'}`);
    this.save();
    if (this.transcript !== null) {
      if (this.open && this.tool === 'changes') this.changes.refresh();
      this.follow(this.transcript);
    }
    this.hooks.changed();
  }

  /** A drag of the divider ended at `width`. */
  resized(width) {
    const next = Math.round(Math.min(WORKBAR_WIDTH.max, Math.max(WORKBAR_WIDTH.min, width)));
    if (next === this.width) return;
    this.width = next;
    this.save();
  }

  /** Files' "Show changes": the Changes tool, at the diff of the file at `b64`. */
  showChanges(b64) {
    if (this.changes?.openPath(b64)) this.choose('changes');
  }

  /**
   * Keys while the Workbar has the keyboard: in a diff, Escape goes back and
   * [ and ] go to the file before and after; in Files, Enter opens the file
   * selected.
   */
  keyDown(event) {
    const diff = this.tool === 'changes' ? this.changes?.diff : null;
    if (diff && event.keystroke === 'escape') this.changes.back();
    else if (diff && event.keystroke === '[') this.changes.step(-1);
    else if (diff && event.keystroke === ']') this.changes.step(1);
    else if (this.tool === 'files' && event.keystroke === 'enter') this.files?.openSelected();
  }
}

/**
 * The plate header's button for the Workbar: the diff glyph, and how many
 * files the conversation's status lists as changed when there are any.
 */
export function workbarButton(workbar, cx) {
  const m = palette(cx);
  const count = workbar.changes?.count() ?? 0;
  return ghostButton('workbar-toggle', cx)
    .flex_none()
    .h(28)
    .min_w(28)
    .px(count > 0 ? 6 : 0)
    .gap(4)
    .justify_center()
    .rounded(8)
    .when(workbar.open, (el) => el.bg(m.selected))
    .tooltip(t('workbarChangesTip', { shortcut: CHANGES_SHORTCUT }))
    .on_click(() => workbar.toggle('changes'))
    .child(icon('file-diff', 16, m.inkMuted))
    .when(count > 0, (el) => el.child(text(String(count), 'small', m.inkMuted)));
}

/**
 * The Workbar's plate: a 48px header with the tools, Refresh (Changes) and
 * Close, then the tool.
 */
export function workbarPane(workbar, cx) {
  const m = palette(cx);
  const changes = workbar.changes;
  const reading = changes?.reading === true;
  return v_flex()
    .id('workbar')
    .size_full()
    .rounded(12)
    .bg(m.plate)
    .overflow_hidden()
    .track_focus(workbar.focus)
    .on_key_down((event) => workbar.keyDown(event))
    .child(
      h_flex()
        .flex_none()
        .h(48)
        .px(12)
        .gap(4)
        .items_center()
        .child(
          segmentedControl(
            'workbar-tool',
            [
              ['changes', t('workbarChanges')],
              ['files', t('workbarFiles')],
              ['terminal', t('workbarTerminal')],
            ],
            workbar.tool,
            (tool) => workbar.choose(tool),
            cx,
          ).w(216),
        )
        // The space between moves the window, as the plate header's does.
        .child(div().flex_1().h_full().window_control_area('drag'))
        .when(workbar.tool === 'changes', (el) =>
          el.child(
            ghostButton('workbar-refresh', cx)
              .size(28)
              .justify_center()
              .rounded(8)
              .tooltip(t('workbarRefresh'))
              .on_click(() => changes?.refresh())
              .child(icon('refresh', 16, m.inkMuted).when(reading, (glyph) => glyph.spin(1000))),
          ),
        )
        .child(
          iconButton('workbar-close', 'close', cx)
            .tooltip(t('close'))
            .on_click(() => workbar.close()),
        ),
    )
    .when(changes !== null && workbar.tool === 'changes', (el) =>
      el.child(changesBody(changes, cx)),
    )
    .when(workbar.files !== null && workbar.tool === 'files', (el) =>
      el.child(
        filesBody(workbar.files, changes, { showChanges: (b64) => workbar.showChanges(b64) }, cx),
      ),
    )
    .when(workbar.terminals !== null && workbar.tool === 'terminal', (el) =>
      el.child(terminalBody(workbar.terminals, cx)),
    );
}
