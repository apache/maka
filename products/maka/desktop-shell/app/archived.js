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

// Settings › Archived: the tasks the sidebar's menu archived, which the
// catalog the sidebar watches (filter 'all') no longer lists. `agent.list`
// with filter 'archived' reads them, and `agent.changeSession` restores one,
// which the sidebar then lists again by itself, or removes it. Removing
// deletes the conversation only; the files in its workspace are kept. The
// native client keeps them on a settings page as well
// (maka-gpui crates/settings/src/archived_page.rs).

import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { query, log } from './host.js';
import { changeSession, changeFailure } from './sessions.js';
import { group, settingRow, button } from './settings.js';
import { palette, typeset, text, controlButton, compactAge } from './theme.js';
import { t } from './locale.js';

/** Pages read after the first; the Host pages at most 32 sessions in id order. */
const MAX_PAGES = 32;

export class Archived {
  /**
   * @param {{ changed: () => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    /** The archived sessions as last read, newest first, or null before the first read. */
    this.sessions = null;
    this.loading = false;
    /** Counts the reads; an answer for an earlier one is dropped. */
    this.reads = 0;
    /** Why the last read failed, in words, until one succeeds. */
    this.loadError = null;
    /** The id of the session being restored or deleted, or null; one change at a time. */
    this.busy = null;
    /** Why the last restore or delete did not go through, in words, or null. */
    this.error = null;
    /** The id of the session whose deletion waits for a confirmation, or null. */
    this.removing = null;
  }

  /** Reads every archived session, newest first. */
  async load() {
    const read = ++this.reads;
    this.loading = true;
    this.loadError = null;
    this.hooks.changed();
    try {
      const sessions = await readArchived();
      if (read !== this.reads) return;
      this.sessions = sessions;
      log(`archived: ${sessions.length} read`);
    } catch (error) {
      if (read !== this.reads) return;
      log(`archived: reading failed: ${error.message}`);
      this.loadError = t('archivedReadFailed', { value: error.message });
    } finally {
      if (read === this.reads) {
        this.loading = false;
        this.hooks.changed();
      }
    }
  }

  /** Leaving the page drops a question and the last failure. */
  close() {
    this.removing = null;
    this.error = null;
  }

  restore(session) {
    return this.change(session, 'restore', (value) => t('restoreFailed', { value }));
  }

  /** Asks before deleting, in the session's row. */
  askRemove(session) {
    if (this.busy !== null) return;
    this.removing = session.id;
    this.error = null;
    this.hooks.changed();
  }

  cancelRemove() {
    this.removing = null;
    this.hooks.changed();
  }

  remove(session) {
    this.removing = null;
    return this.change(session, 'remove', (value) => t('deleteFailed', { value }));
  }

  /**
   * Restores or removes the session, then reads the list again, whether it
   * went through or not. A failure is said in the page's status line, in the
   * words the sidebar's Archive uses.
   * @param {(value: string) => string} failed
   */
  async change(session, action, failed) {
    if (this.busy !== null) return;
    this.busy = session.id;
    this.error = null;
    this.hooks.changed();
    try {
      const result = await changeSession(session, action);
      log(`archived: ${action} ${session.id}: ${result.kind}`);
    } catch (error) {
      log(`archived: ${action} ${session.id} failed: ${error.message}`);
      this.error = changeFailure(error, failed);
    } finally {
      this.busy = null;
      this.hooks.changed();
    }
    await this.load();
  }
}

/** Reads made after a later page failed, as the catalog changed meanwhile. */
const MAX_READS = 3;

/**
 * Every page of `agent.list` with filter 'archived', at the first page's
 * revision, newest first. A later page fails once the catalog has changed
 * since the first (any session's change moves the revision), and the read
 * then starts over.
 */
async function readArchived() {
  for (let read = 1; ; read += 1) {
    const first = await query('agent', 'list', { filter: 'archived', position: { kind: 'start' } });
    const sessions = [...first.sessions];
    let after = first.after;
    try {
      for (let count = 0; after !== null && count < MAX_PAGES; count += 1) {
        const page = await query('agent', 'list', {
          filter: 'archived',
          position: { kind: 'after', revision: first.revision, cursor: after },
        });
        sessions.push(...page.sessions);
        after = page.after;
      }
    } catch (error) {
      if (read === MAX_READS) throw error;
      log(`archived: later pages: ${error.message}; reading again`);
      continue;
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/**
 * The line under the page's description: why reading failed, with Retry, or
 * why the last restore or delete failed. Null when there is nothing to say.
 * @param {Archived} archived
 */
export function archivedStatus(archived, cx) {
  const m = palette(cx);
  if (archived.loadError !== null) {
    return h_flex()
      .gap(8)
      .items_center()
      .child(text(archived.loadError, 'small', m.destructive).flex_1().min_w_0())
      .child(
        button('archived-retry', t('retry'), false, archived.loading, cx)
          .h(28)
          .on_click(() => archived.load()),
      );
  }
  if (archived.error !== null) return text(archived.error, 'small', m.destructive);
  return null;
}

/**
 * The archived tasks, one row each, or a line saying there are none.
 * @param {Archived} archived
 */
export function archivedSection(archived, cx) {
  const m = palette(cx);
  if (archived.sessions === null) return div();
  const rows = archived.sessions.map((session) => archivedRow(archived, session, cx));
  if (rows.length === 0) rows.push(text(t('noArchivedTasks'), 'body', m.inkMuted).py(8));
  return group(null, null, null, rows, cx);
}

/**
 * One archived task: its title; the folder it works in and when it was
 * archived, as the sidebar writes ages; Restore and Delete…. Delete asks in
 * the row first, with what deleting keeps.
 */
function archivedRow(archived, session, cx) {
  const m = palette(cx);
  const busy = archived.busy !== null;
  const confirming = archived.removing === session.id;
  const path = session.workspace?.path ?? '';
  const folder = path.split('/').filter(Boolean).pop() ?? t('noFolder');
  return v_flex()
    .w_full()
    .child(
      settingRow(
        session.title,
        `${folder} · ${compactAge(session.updatedAt)}`,
        h_flex()
          .gap(8)
          .child(
            button(`archived-restore-${session.id}`, t('restoreTask'), false, busy, cx)
              .h(28)
              .on_click(() => archived.restore(session)),
          )
          .child(
            controlButton(`archived-delete-${session.id}`, t('deleteTask'), 'outline', busy || confirming, cx)
              .h(28)
              .text_color(m.destructive)
              .on_click(() => archived.askRemove(session)),
          ),
        cx,
      ),
    )
    .when(confirming, (el) =>
      el.child(
        h_flex()
          .w_full()
          .pb(10)
          .gap(12)
          .items_center()
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .child(typeset(div(), 'label').text_color(m.ink).child(t('deleteTaskQuestion')))
              .child(text(t('deleteTaskHelp'), 'small', m.inkMuted)),
          )
          .child(
            controlButton(`archived-delete-confirm-${session.id}`, t('deleteAction'), 'primary', busy, cx)
              .h(28)
              .bg(m.destructive)
              .when(!busy, (el) => el.hover((style) => style.bg(m.destructive).opacity(0.84)))
              .on_click(() => archived.remove(session)),
          )
          .child(
            button(`archived-delete-cancel-${session.id}`, t('cancel'), false, busy, cx)
              .h(28)
              .on_click(() => archived.cancelRemove()),
          ),
      ),
    );
}
