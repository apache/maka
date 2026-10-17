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

// The Workbar's Files tool: the tree of a conversation's folder. A folder is
// listed (`listFiles`, 128 entries a page) when it is first expanded, and
// while the tool shows each expanded folder, the root included, has a
// `watchFiles` subscription that says when to list it again, as
// plugins/agent/api/README.md describes: start the watch, wait for `ready`,
// list from the start and check the listing is of the folder the watch
// reports on; on `changed` list again from the start; `unavailable` means
// the folder was deleted or replaced. Every watch closes when the tool
// hides, the Workbar closes, the conversation changes, or its folder
// collapses.
//
// A file opens with the system's application, or shows in the file manager
// (`maka-files` open and reveal), at the folder's path and the file's
// relative one joined. Paths come as exact bytes in base64; the decoded text
// is shown, and the Host is always sent the object it gave.

import { div, uniform_list } from 'gpui-kit';
import { v_flex, h_flex, Scrollbar, Popover } from 'gpui-base';
import { Buffer } from 'buffer';
import { open as openWithSystem, reveal as revealInFinder } from 'maka-files';
import { query, subscribe, next, close, log } from './host.js';
import { decodePath } from './changes.js';
import { palette, typeset, text, icon, menuSurface, menuRow, menuSeparator } from './theme.js';
import { t } from './locale.js';

/**
 * The most folders watched at once, the root included. Expanding one more
 * collapses the folder expanded longest ago (not the root, and not one the
 * new folder is inside), so every folder that shows is kept current. When
 * every folder open is one the new folder is inside, it does not open, and
 * a row under it says to collapse others first.
 */
const MAX_WATCHED = 32;

/** How many times a listing that failed while a `changed` waited is tried again. */
const LIST_RETRIES = 3;

/** The deepest level rows are indented for; deeper rows line up with it, so their names still show. */
const INDENT_LEVELS = 16;

/** The root's key; any other folder's is its path's `bytesBase64`. */
const ROOT = '';

/**
 * The expanded folders of each session the window showed, by session id:
 * key -> `{ path, parent }` in the order they were expanded. Kept for as long
 * as the window, so a task shown again opens as it was left.
 */
const EXPANDED = new Map();

/** The watch subscriptions open now, every tree's. */
const WATCHES = new Set();

/** How many `watchFiles` subscriptions are open, for the dev driver. */
export function openWatches() {
  return WATCHES.size;
}

/** Changes kinds whose file name is drawn in a color (Changes `kindOf`), and the palette role. */
const CHANGE_COLORS = {
  added: 'success',
  modified: 'warning',
  type_changed: 'warning',
  conflicted: 'destructive',
};

/**
 * Whether `entry` opens with the system's application: a file or a folder.
 * A link would open whatever it points to, and a special file has nothing
 * to open, so those are only revealed or copied.
 */
function opens(entry) {
  return entry.kind === 'file' || entry.kind === 'directory';
}

/** A folder's problem as its row shows it: one of ours by message key, or the Host's text. */
function problemText(problem) {
  return problem.key !== undefined ? t(problem.key) : problem.text;
}

/** A listed entry as the tree draws it. */
function entryOf(entry) {
  const text = decodePath(entry.path);
  return {
    key: entry.path.bytesBase64,
    path: entry.path,
    kind: entry.kind,
    text,
    name: text.slice(text.lastIndexOf('/') + 1),
    lower: text.slice(text.lastIndexOf('/') + 1).toLowerCase(),
  };
}

/** Folders first, then the rest, each by name without regard to case. */
function sorted(entries) {
  const rank = (entry) => (entry.kind === 'directory' ? 0 : 1);
  return entries.map(entryOf).sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.lower !== b.lower) return a.lower < b.lower ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * The Files of one conversation's folder: each folder as last listed, which
 * are expanded, their watches, the file selected and the menu open on one.
 * Made for each conversation the window shows and closed when it leaves.
 */
export class FileTree {
  /**
   * @param {import('./transcript.js').Transcript} transcript the conversation;
   *   its `endpoint` answers the reads, and its session names the folder
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   */
  constructor(transcript, hooks) {
    this.transcript = transcript;
    this.sessionId = transcript.id;
    this.endpoint = transcript.endpoint;
    this.hooks = hooks;
    /**
     * Folders by key: `{ key, path, entries, error, watch }`. `entries` is
     * null until first listed; `error` null, or `{ key }` (a message key) or
     * `{ text }` (the Host's message); `watch` the open subscription, `{
     * handle, closed, identity, listing, again }`, or null.
     */
    this.dirs = new Map();
    if (!EXPANDED.has(this.sessionId)) EXPANDED.set(this.sessionId, new Map());
    this.expanded = EXPANDED.get(this.sessionId);
    /** Whether the tool shows, and so whether the folders are watched. */
    this.shown = false;
    /** The key of the row selected, or null. */
    this.selected = null;
    /** The folder that did not open because of MAX_WATCHED (its key), or null. */
    this.refused = null;
    /**
     * The menu: the row it is for, then where the press was in the pane,
     * `{ key, x, y }`, or null. `pressed` holds the row between the row's
     * press and the pane's (see placeMenu).
     */
    this.menu = null;
    this.pressed = null;
    /** How many presses the last one counted: 2 on a double click. */
    this.presses = 1;
    /** Counts changes to the tree; the rows are rebuilt when it moves (see items). */
    this.version = 0;
    this.view = null;
    this.closed = false;
  }

  /** The folder's absolute path, as the session names it, or null. */
  folder() {
    return this.transcript.session.workspace?.path ?? null;
  }

  /** The root row's name: the folder's last component, or null without a folder. */
  rootName() {
    const folder = this.folder();
    if (folder === null) return null;
    return folder.split('/').filter(Boolean).pop() ?? folder;
  }

  touch() {
    this.version += 1;
    if (!this.closed) this.hooks.changed();
  }

  dir(key, path) {
    let dir = this.dirs.get(key);
    if (dir === undefined) {
      dir = { key, path, entries: null, error: null, watch: null, attempts: 0 };
      this.dirs.set(key, dir);
    }
    return dir;
  }

  /** Starts watching the root and every expanded folder; the watches list them. */
  show() {
    if (this.shown || this.closed) return;
    this.shown = true;
    log(`files: showing ${this.sessionId}, ${this.expanded.size} expanded`);
    this.watch(this.dir(ROOT, null));
    for (const [key, { path }] of this.expanded) this.watch(this.dir(key, path));
  }

  /** Closes every watch. The listings stay, to show at once when the tool shows again. */
  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.menu = null;
    for (const dir of this.dirs.values()) this.unwatch(dir);
    log(`files: hidden ${this.sessionId}, ${WATCHES.size} watches open`);
  }

  close() {
    this.hide();
    this.closed = true;
  }

  /** Whether the folder `inner` is inside `outer` (both keys), by the parents recorded on expanding. */
  inside(inner, outer) {
    for (let key = inner; key !== ROOT && key !== undefined; key = this.expanded.get(key)?.parent) {
      if (key === outer) return true;
    }
    return false;
  }

  /**
   * Expands the folder `entry`, listed in the folder `parent` (a key), and
   * watches it. One past MAX_WATCHED collapses the folder expanded longest
   * ago first, or, when every folder open is around this one, does not
   * open it (see MAX_WATCHED).
   */
  expand(entry, parent) {
    if (this.closed || this.expanded.has(entry.key)) return;
    // Only a folder that shows: the root's, or one in an expanded folder.
    if (parent !== ROOT && !this.expanded.has(parent)) return;
    if (this.expanded.size + 1 >= MAX_WATCHED) {
      const oldest = [...this.expanded.keys()].find((key) => !this.inside(parent, key));
      if (oldest === undefined) {
        // Every folder open is one this one is inside; none can close for it.
        log(`files: ${MAX_WATCHED} folders watched, all around ${entry.text}; not opening it`);
        this.refused = entry.key;
        this.touch();
        return;
      }
      log(`files: ${MAX_WATCHED} folders watched; collapsing the one expanded first`);
      this.collapse(oldest);
    }
    this.refused = null;
    this.expanded.set(entry.key, { path: entry.path, parent });
    const dir = this.dir(entry.key, entry.path);
    if (this.shown) this.watch(dir);
    this.touch();
  }

  /** Collapses the folder `key` and every folder inside it: their watches close and their listings go. */
  collapse(key) {
    this.refused = null;
    const gone = [...this.expanded.keys()].filter((other) => this.inside(other, key));
    for (const other of gone) {
      this.expanded.delete(other);
      const dir = this.dirs.get(other);
      if (dir !== undefined) {
        this.unwatch(dir);
        this.dirs.delete(other);
      }
    }
    this.touch();
  }

  /**
   * Watches the folder `dir` and lists it whenever the watch says to. Ends
   * on `unavailable` (the folder collapses), on an error or when the Host
   * ends it (the folder shows the error with Retry), or when closed here.
   */
  async watch(dir) {
    if (dir.watch !== null || this.closed || !this.shown) return;
    const watch = { handle: null, closed: false, identity: null, listing: false, again: false };
    dir.watch = watch;
    let ended = null;
    try {
      const handle = await subscribe(this.endpoint, 'watchFiles', {
        sessionId: this.sessionId,
        path: dir.path,
      });
      if (watch.closed) {
        await close(handle).catch(() => {});
        return;
      }
      watch.handle = handle;
      WATCHES.add(handle);
      for (;;) {
        const event = await next(handle);
        if (watch.closed) return;
        if (event === null) {
          ended = { key: 'filesWatchEnded' };
          break;
        }
        if (event.kind === 'ready') {
          watch.identity = event.directoryIdentity;
          this.list(dir, watch);
        } else if (event.kind === 'changed') {
          this.list(dir, watch);
        } else if (event.kind === 'unavailable') {
          log(`files: folder ${dir.key || '(root)'} is no longer there (${event.reason})`);
          if (dir.key === ROOT) {
            ended = { key: 'filesFolderGone' };
            break;
          }
          this.collapse(dir.key);
          return;
        }
      }
    } catch (error) {
      if (watch.closed) return;
      ended = { text: error.message };
    } finally {
      // Ended by the Host or failed rather than closed here.
      if (!watch.closed) {
        watch.closed = true;
        if (watch.handle !== null) {
          WATCHES.delete(watch.handle);
          close(watch.handle).catch(() => {});
        }
        if (dir.watch === watch) dir.watch = null;
      }
    }
    if (ended !== null && !this.closed && this.dirs.get(dir.key) === dir) {
      log(`files: watch of ${dir.key || '(root)'} ended: ${ended.key ?? ended.text}`);
      dir.error = ended;
      this.touch();
    }
  }

  unwatch(dir) {
    const watch = dir.watch;
    if (watch === null) return;
    dir.watch = null;
    watch.closed = true;
    if (watch.handle !== null) {
      WATCHES.delete(watch.handle);
      close(watch.handle).catch(() => {});
    }
  }

  /**
   * Lists `dir` from the start, every page, for `watch`. One listing at a
   * time; a `changed` meanwhile drops the cursor and lists from the start
   * again, also when the listing failed (up to LIST_RETRIES times). A
   * listing of another folder than the one the watch reports on (it was
   * replaced in between) watches it again, at most three times.
   */
  async list(dir, watch) {
    if (watch.listing) {
      watch.again = true;
      return;
    }
    watch.listing = true;
    let retries = 0;
    try {
      do {
        watch.again = false;
        try {
          const entries = [];
          let identity = null;
          let after = null;
          do {
            const page = await query(this.endpoint, 'listFiles', {
              sessionId: this.sessionId,
              path: dir.path,
              after,
            });
            if (watch.closed) return;
            if (watch.again || (identity !== null && page.directoryIdentity !== identity)) {
              watch.again = true;
              break;
            }
            identity = page.directoryIdentity;
            entries.push(...page.entries);
            after = page.next;
          } while (after !== null);
          if (watch.again) continue;
          if (identity !== watch.identity) {
            this.rewatch(dir);
            return;
          }
          dir.entries = sorted(entries);
          dir.error = null;
          dir.attempts = 0;
          log(
            `files: listed ${dir.key === ROOT ? '(root)' : decodePath(dir.path)}: ${entries.length}`,
          );
          this.touch();
        } catch (error) {
          if (watch.closed) return;
          // The folder changed while this listing failed: list it again.
          if (watch.again && retries < LIST_RETRIES) {
            retries += 1;
            log(`files: listing ${dir.key || '(root)'} failed (${error.message}); listing again`);
            continue;
          }
          log(`files: listing ${dir.key || '(root)'} failed: ${error.message}`);
          dir.error = { text: error.message };
          this.touch();
          return;
        }
      } while (watch.again && !watch.closed);
    } finally {
      watch.listing = false;
    }
  }

  /** Watches `dir` again after its listing was of another folder than the watch's. */
  rewatch(dir) {
    this.unwatch(dir);
    dir.attempts += 1;
    if (dir.attempts > 3) {
      dir.error = { key: 'filesFolderReplaced' };
      this.touch();
      return;
    }
    log(`files: ${dir.key || '(root)'} was replaced while it was listed; watching it again`);
    this.watch(dir);
  }

  /** Tries a folder that failed again: its watch, or its listing when the watch is still open. */
  retry(key) {
    const dir = this.dirs.get(key);
    if (dir === undefined) return;
    dir.error = null;
    dir.attempts = 0;
    if (dir.watch === null) this.watch(dir);
    else this.list(dir, dir.watch);
    this.touch();
  }

  /**
   * The rows: the root, then each folder's entries under it, expanded ones
   * with theirs; a folder still being listed, empty, or whose watch or
   * listing failed has a row saying so. Rebuilt only when the tree, the
   * status its names are colored by, or the selection changed.
   * @param {import('./changes.js').Changes | null} changes
   */
  items(changes) {
    const status = changes?.status;
    if (
      this.view?.version === this.version &&
      this.view.status === status &&
      this.view.selected === this.selected
    ) {
      return this.view.items;
    }
    /** @type {any[]} */
    // Text is kept as message keys and translated as the rows are drawn,
    // so a change of language shows without rebuilding them.
    const items = [{ kind: 'root', key: 'root', name: this.rootName(), depth: 0 }];
    const walk = (dir, depth) => {
      if (dir.error !== null) {
        items.push({
          kind: 'failed',
          key: `failed/${dir.key}`,
          dir: dir.key,
          depth,
          problem: dir.error,
        });
      }
      if (dir.entries === null) {
        if (dir.error === null) {
          items.push({ kind: 'note', key: `note/${dir.key}`, depth, message: 'loading' });
        }
        return;
      }
      if (dir.entries.length === 0) {
        items.push({ kind: 'note', key: `note/${dir.key}`, depth, message: 'filesEmpty' });
      }
      for (const entry of dir.entries) {
        if (entry.kind === 'directory') {
          const open = this.expanded.has(entry.key);
          items.push({
            kind: 'directory',
            key: `d/${entry.key}`,
            entry,
            parent: dir.key,
            depth,
            open,
          });
          const inner = this.dirs.get(entry.key);
          if (open && inner !== undefined) walk(inner, depth + 1);
          // Under the folder that did not open, from the tree's left edge: it
          // is at least 32 levels down, where the indent leaves the text no room.
          if (entry.key === this.refused) {
            items.push({
              kind: 'note',
              key: `refused/${entry.key}`,
              depth: 0,
              message: 'filesTooManyOpen',
            });
          }
        } else {
          const change = changes?.kindOf(entry.key);
          items.push({ kind: 'file', key: `f/${entry.key}`, entry, depth, change });
        }
      }
    };
    walk(this.dir(ROOT, null), 0);
    for (const item of items) item.selected = item.key === this.selected;
    this.view = {
      version: this.version,
      status,
      selected: this.selected,
      items,
      byKey: new Map(items.map((item) => [item.key, item])),
    };
    return items;
  }

  /** The row `key` of the rows last built. */
  item(key) {
    return this.view?.byKey.get(key) ?? null;
  }

  /**
   * A click on a row: selects it; a folder opens or closes, a file opens with
   * its application on a double click, a failed folder is tried again.
   */
  click(key) {
    const item = this.item(key);
    if (item === null) return;
    if (item.kind === 'failed') {
      this.retry(item.dir);
      return;
    }
    if (item.kind !== 'directory' && item.kind !== 'file') return;
    this.selected = key;
    if (item.kind === 'directory') {
      // The second click of a double click would close it again.
      if (this.presses < 2) this.toggle(item);
    } else if (this.presses >= 2 && opens(item.entry)) {
      this.open(item.entry);
    }
    this.hooks.changed();
  }

  toggle(item) {
    if (item.open) this.collapse(item.entry.key);
    else this.expand(item.entry, item.parent);
  }

  /** Enter: opens the file selected (not a link or special file), or opens or closes the folder selected. */
  openSelected() {
    const item = this.selected === null ? null : this.item(this.selected);
    if (item?.kind === 'file' && opens(item.entry)) this.open(item.entry);
    else if (item?.kind === 'directory') this.toggle(item);
  }

  /**
   * What the menu of `item` offers: Open for files and folders, Reveal and
   * the two Copy items for every entry, and Show changes for a file the
   * last status lists.
   * @param {import('./changes.js').Changes | null} changes
   */
  menuActions(item, changes) {
    const actions = [];
    if (opens(item.entry)) actions.push('open');
    actions.push('reveal', 'copyPath', 'copyRelativePath');
    if (item.kind === 'file' && changes?.status?.paths.has(item.entry.key) === true) {
      actions.push('showChanges');
    }
    return actions;
  }

  /**
   * The path of `entry` in the folder, as text. Throws for one that is
   * absolute, has an empty, `.` or `..` component, or is not UTF-8 (its text
   * would name another file).
   */
  relative(entry) {
    const relative = entry.text;
    const parts = relative.split('/');
    const exact = Buffer.from(relative, 'utf8').toString('base64') === entry.path.bytesBase64;
    if (!exact || parts.some((part) => ['', '.', '..'].includes(part))) {
      throw new Error(t('filesPathRefused', { path: relative }));
    }
    return relative;
  }

  /** The absolute path of `entry`: the folder's path and `relative(entry)`. Throws as that does. */
  absolute(entry) {
    const folder = this.folder();
    const relative = this.relative(entry);
    if (folder === null) throw new Error(t('filesPathRefused', { path: relative }));
    return `${folder.replace(/\/+$/, '')}/${relative}`;
  }

  /** Opens `entry` (a file or folder) with the system's application for it; a failure is reported. */
  async open(entry) {
    this.menu = null;
    this.hooks.changed();
    try {
      if (!opens(entry)) throw new Error(t('filesPathRefused', { path: entry.text }));
      const path = this.absolute(entry);
      log(`files: opening ${entry.text}`);
      await openWithSystem(path);
    } catch (error) {
      this.hooks.report(t('filesOpenFailed', { name: entry.name, value: error.message }));
    }
  }

  /** Shows `entry` in the file manager; a failure is reported. */
  async reveal(entry) {
    this.menu = null;
    this.hooks.changed();
    try {
      await revealInFinder(this.absolute(entry));
    } catch (error) {
      this.hooks.report(t('filesRevealFailed', { name: entry.name, value: error.message }));
    }
  }

  /** Puts the entry's absolute path, or its path in the folder (`relative`), on the clipboard. */
  copyPath(entry, relative, cx) {
    this.menu = null;
    try {
      cx.write_to_clipboard(relative ? this.relative(entry) : this.absolute(entry));
    } catch (error) {
      this.hooks.report(t('filesCopyFailed', { value: error.message }));
    }
    this.hooks.changed();
  }

  /** A right press on a row: it is selected, and the pane's press places the menu (placeMenu). */
  pressMenu(key) {
    const item = this.item(key);
    if (item?.kind !== 'file' && item?.kind !== 'directory') return;
    this.selected = key;
    this.pressed = key;
  }

  /** The pane's right press, after the row's: opens the menu at `position` in the pane. */
  placeMenu(position) {
    const key = this.pressed;
    this.pressed = null;
    if (key === null || position === undefined) return;
    this.menu = { key, x: position.x, y: position.y };
    this.hooks.changed();
  }

  closeMenu() {
    if (this.menu === null) return;
    this.menu = null;
    this.hooks.changed();
  }
}

/**
 * The Files tool under the Workbar's header: the tree, and the menu of the
 * row pressed with the right button. `actions.showChanges(b64)` shows a
 * file's diff in the Changes tool.
 * @param {FileTree} tree
 * @param {import('./changes.js').Changes} changes
 */
export function filesBody(tree, changes, actions, cx) {
  const items = tree.items(changes);
  const id = `files-${tree.sessionId}`;
  return (
    v_flex()
      .id('files-pane')
      .relative()
      .flex_1()
      .min_h_0()
      // The row's click comes on release; the press before it says whether it
      // was the second of a double click.
      .on_mouse_down('left', (event) => {
        tree.presses = event.click_count;
      })
      .on_mouse_down('right', (event) => tree.placeMenu(event.local_position))
      .child(
        uniform_list(
          id,
          items.length,
          (index) => items[index].key,
          (range) => {
            const rows = [];
            for (let index = range.start; index < range.end; index += 1) {
              rows.push(fileRow(items[index], cx));
            }
            return rows;
          },
        )
          .size_full()
          .pb(8)
          .on_item_click((key) => tree.click(key))
          .on_item_secondary_click((key) => tree.pressMenu(key)),
      )
      .child(Scrollbar.vertical(id).absolute().inset_0())
      .when(tree.menu !== null && tree.item(tree.menu.key) !== null, (el) =>
        el.child(fileMenu(tree, changes, actions, cx)),
      )
  );
}

/** One row of the tree, 28 high, indented 16 a level (up to INDENT_LEVELS). */
function fileRow(item, cx) {
  const m = palette(cx);
  const lane = (child) =>
    h_flex().flex_none().w(14).h_full().items_center().justify_center().child(child);
  const row = h_flex()
    .w_full()
    .h_full()
    .pl(8 + Math.min(item.depth, INDENT_LEVELS) * 16)
    .pr(8)
    .gap(6)
    .items_center()
    .rounded(8);
  let content;
  switch (item.kind) {
    case 'root':
      content = row.child(icon('folder-open', 16, m.inkMuted)).child(
        text(item.name ?? t('workbarFiles'), 'strong', m.ink)
          .min_w_0()
          .truncate(),
      );
      break;
    case 'directory':
      content = row
        .when(item.selected, (el) => el.bg(m.selected))
        .when(!item.selected, (el) => el.hover((style) => style.bg(m.hover)))
        .tooltip(item.entry.text)
        .child(lane(icon(item.open ? 'chevron-down' : 'chevron-right', 12, m.inkMuted)))
        .child(icon(item.open ? 'folder-open' : 'folder', 16, m.inkMuted))
        .child(text(item.entry.name, 'body', m.ink).min_w_0().truncate());
      break;
    case 'file': {
      const color = CHANGE_COLORS[item.change] ?? null;
      const kind = item.entry.kind;
      const other =
        kind === 'symlink' ? t('filesLink') : kind === 'other' ? t('filesSpecial') : null;
      content = row
        .when(item.selected, (el) => el.bg(m.selected))
        .when(!item.selected, (el) => el.hover((style) => style.bg(m.hover)))
        .tooltip(item.entry.text)
        .child(lane(div()))
        .child(icon('file', 16, other === null ? m.inkMuted : m.inkDisabled))
        .child(
          text(item.entry.name, 'body', color === null ? m.ink : m[color])
            .min_w_0()
            .truncate(),
        )
        .when(other !== null, (el) => el.child(text(other, 'small', m.inkMuted).flex_none()));
      break;
    }
    case 'failed': {
      const problem = problemText(item.problem);
      content = row
        .child(lane(div()))
        .child(text(problem, 'small', m.destructive).flex_1().min_w_0().truncate())
        .child(
          typeset(div(), 'smallLabel')
            .flex_none()
            .px(6)
            .rounded(6)
            .text_color(m.ink)
            .hover((style) => style.bg(m.wash))
            .child(t('retry')),
        )
        .tooltip(problem);
      break;
    }
    default:
      content = row
        .child(lane(div()))
        .child(text(t(item.message), 'small', m.inkMuted).min_w_0().truncate())
        .tooltip(t(item.message));
  }
  return h_flex().w_full().h(28).px(8).child(content);
}

/**
 * The menu of the row pressed with the right button, where it was pressed,
 * with what `menuActions` offers for it.
 */
function fileMenu(tree, changes, actions, cx) {
  const item = tree.item(tree.menu.key);
  const entry = item.entry;
  const offered = tree.menuActions(item, changes);
  const has = (action) => offered.includes(action);
  return div()
    .absolute()
    .left(tree.menu.x)
    .top(tree.menu.y)
    .child(
      Popover.new('files-menu')
        .anchor('top_left')
        .open(true)
        .on_open_change((open) => {
          if (!open) tree.closeMenu();
        })
        .trigger(div().size(1))
        .content(
          menuSurface(cx)
            .id('files-menu-rows')
            .min_w(200)
            .when(has('open'), (el) =>
              el.child(
                menuRow('files-open', t('filesOpen'), { icon: 'file' }, cx).on_click(() =>
                  tree.open(entry),
                ),
              ),
            )
            .child(
              menuRow('files-reveal', t('filesReveal'), { icon: 'folder' }, cx).on_click(() =>
                tree.reveal(entry),
              ),
            )
            .child(menuSeparator(cx))
            .child(
              menuRow('files-copy-path', t('filesCopyPath'), { icon: 'copy' }, cx).on_click(
                (_, cx) => tree.copyPath(entry, false, cx),
              ),
            )
            .child(
              menuRow(
                'files-copy-relative',
                t('filesCopyRelativePath'),
                { icon: 'copy' },
                cx,
              ).on_click((_, cx) => tree.copyPath(entry, true, cx)),
            )
            .when(has('showChanges'), (el) =>
              el.child(menuSeparator(cx)).child(
                menuRow(
                  'files-show-changes',
                  t('filesShowChanges'),
                  { icon: 'file-diff' },
                  cx,
                ).on_click(() => {
                  tree.closeMenu();
                  actions.showChanges(entry.key);
                }),
              ),
            ),
        ),
    );
}
