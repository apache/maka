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

// The Workbar's Changes tool: the Git changes of a conversation's folder
// (`gitStatus`), grouped as Git keeps them, and one file's diff (`gitDiff`)
// in place of the list. Both are fresh reads of the folder, not snapshots:
// the status is read again after the agent did something (workbar.js says
// when), and the open diff with it.
//
// Paths come as exact bytes in base64 (`{ bytesBase64 }`). The decoded name
// is only shown; the Host is always sent the object it gave.

import { div, list, uniform_list } from 'gpui-kit';
import { v_flex, h_flex, Scrollbar } from 'gpui-base';
import { Buffer } from 'buffer';
import { query, log } from './host.js';
import { palette, typeset, text, icon, iconButton, pill, controlButton } from './theme.js';
import { t, tn } from './locale.js';

/** The areas in the order the list shows them, with each group's heading and the diff's pill. */
const AREAS = [
  ['staged', 'changesStaged', 'changesStaged'],
  ['worktree', 'changesWorktree', 'diffUnstaged'],
  ['untracked', 'changesUntracked', 'changesUntracked'],
];

/** The letter a change's kind shows as, and the palette role it is drawn in. */
const KINDS = {
  added: ['A', 'success'],
  modified: ['M', 'warning'],
  deleted: ['D', 'destructive'],
  type_changed: ['T', 'inkMuted'],
  conflicted: ['C', 'destructive'],
};

/** What a diff that is not text says, by its kind; null is a folder that stopped being a repository. */
const DIFF_NOTES = {
  binary: 'diffBinary',
  too_large: 'diffTooLarge',
  unchanged: 'diffUnchanged',
  unsupported: 'diffUnsupported',
};

/** The diff's text: Menlo at the theme's mono size (theme.js tokensFor, `mono_md`). */
const MONO = { size: 14, line: 20, advance: 8.43 };

/** The least time from the end of one status read to the next while a run goes on, in ms. */
const RUN_READ_MS = 2000;

/** The width of a diff row's sign column. */
const SIGN_WIDTH = Math.ceil(MONO.advance) + 4;

/** The space before a diff row's line numbers. */
const DIFF_INSET = 8;

/** A path as text, for showing only. */
export function decodePath(path) {
  return Buffer.from(path.bytesBase64, 'base64').toString('utf8');
}

/** `text` with each tab replaced by the spaces to the next multiple of 4 columns. */
function expandTabs(value) {
  if (!value.includes('\t')) return value;
  let out = '';
  let column = 0;
  for (const point of value) {
    if (point === '\t') {
      const spaces = 4 - (column % 4);
      out += ' '.repeat(spaces);
      column += spaces;
    } else {
      out += point;
      column += 1;
    }
  }
  return out;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DROPPED = /^(?:diff --git |index |--- |\+\+\+ )/;

/**
 * The rows a unified diff shows, in order. Each is `{ kind, text }` with
 * `kind` one of 'meta' (the file's mode lines, as one row, and "\ No newline
 * at end of file"), 'hunk' (its header line as written), 'context', 'added'
 * or 'removed'; the last three also carry `old` and `new`, the line numbers
 * on each side (null on the side the line is not on), counted from the hunk
 * header. `diff --git`, `index`, `---` and `+++` lines are left out. Inside a
 * hunk the header's counts decide what a line is, not its first characters:
 * a removed line `-- a` arrives as `--- a`. Tabs are expanded to 4 columns.
 * Pure: the driver calls it on sample patches.
 * @param {string} patch
 */
export function parsePatch(patch) {
  const rows = [];
  const meta = [];
  const flush = () => {
    if (meta.length > 0) rows.push({ kind: 'meta', text: meta.join(' · ') });
    meta.length = 0;
  };
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft + newLeft > 0) {
      const first = line[0];
      if (first === '\\') {
        rows.push({ kind: 'meta', text: line });
      } else if (first === '-') {
        rows.push({ kind: 'removed', old: oldLine, new: null, text: expandTabs(line.slice(1)) });
        oldLine += 1;
        oldLeft = Math.max(0, oldLeft - 1);
      } else if (first === '+') {
        rows.push({ kind: 'added', old: null, new: newLine, text: expandTabs(line.slice(1)) });
        newLine += 1;
        newLeft = Math.max(0, newLeft - 1);
      } else {
        // A context line; some generators write an empty one bare.
        rows.push({ kind: 'context', old: oldLine, new: newLine, text: expandTabs(line.slice(1)) });
        oldLine += 1;
        newLine += 1;
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      flush();
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('\\')) {
      flush();
      rows.push({ kind: 'meta', text: line });
    } else if (line !== '' && !DROPPED.test(line)) {
      // `new file mode`, `deleted file mode`, `old mode` and `new mode`.
      meta.push(line);
    }
  }
  flush();
  return rows;
}

/**
 * Status reads under way, by `<endpoint>/<sessionId>`: a conversation opened
 * again while its last read is still out waits for it rather than asking a
 * second time at once.
 */
const READING = new Map();

async function readStatus(endpoint, sessionId) {
  const key = `${endpoint}/${sessionId}`;
  while (READING.has(key)) await READING.get(key).catch(() => {});
  const reading = query(endpoint, 'gitStatus', { sessionId });
  READING.set(key, reading);
  try {
    return await reading;
  } finally {
    if (READING.get(key) === reading) READING.delete(key);
  }
}

/** One status entry as the list draws it. */
function entryOf(entry) {
  const path = decodePath(entry.path);
  const slash = path.lastIndexOf('/');
  return {
    key: `${entry.area}/${entry.path.bytesBase64}`,
    area: entry.area,
    path: entry.path,
    kind: entry.kind,
    text: path,
    name: path.slice(slash + 1),
    folder: slash < 0 ? '' : path.slice(0, slash + 1),
  };
}

/**
 * The Changes of one conversation's folder: its status as last read, and the
 * diff that shows instead of the list. Made for each conversation the window
 * shows and closed when it leaves (`close`); a read that lands after that is
 * dropped.
 */
export class Changes {
  /**
   * @param {import('./transcript.js').Transcript} transcript the conversation;
   *   its `endpoint` answers the reads
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   */
  constructor(transcript, hooks, cx) {
    this.transcript = transcript;
    this.sessionId = transcript.id;
    this.endpoint = transcript.endpoint;
    this.hooks = hooks;
    this.cx = cx;
    /**
     * The status as last read: undefined before the first read lands, null
     * when the folder is not a Git repository, else `{ head, entries,
     * truncated, groups, order, paths, kinds }` with the entries as the list
     * draws them (entryOf).
     */
    this.status = undefined;
    /** Why the last read failed, until one succeeds. */
    this.error = null;
    this.reading = false;
    this.again = false;
    /** When the last read ended, for the reads while a run goes on (refreshSoon). */
    this.readEnded = 0;
    /** Rows arrived during a run that no read started since has seen. */
    this.stale = false;
    this.timer = false;
    /** Whether the tool shows; the open diff is read again with the status only then (Workbar sets it). */
    this.showing = false;
    /**
     * The diff shown instead of the list, or null: `{ entry, index, result,
     * rows, error, reading, gone }`. `result` is undefined until the first
     * read, `rows` the parsed patch of a text one, `gone` set while the last
     * status no longer lists the file in that area.
     */
    this.diff = null;
    this.diffReads = 0;
    /** The key of the entry whose diff was shown last; its row stays marked in the list. */
    this.lastOpened = null;
    /** The list items last built (see items). */
    this.view = null;
    this.closed = false;
  }

  /** Drops what is under way; nothing read after this is taken. */
  close() {
    this.closed = true;
  }

  /** How many files the last status lists as changed (a file staged and changed again counts once). */
  count() {
    return this.status ? this.status.paths.size : 0;
  }

  /** The kind of change of `b64` (a path's `bytesBase64`) as the Files tree colors it, or undefined. */
  kindOf(b64) {
    return this.status?.kinds.get(b64);
  }

  /**
   * Reads the status. One read at a time: asked again meanwhile, it reads
   * once more when the read under way ends.
   */
  async refresh() {
    if (this.closed) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    this.hooks.changed();
    try {
      do {
        this.again = false;
        // This read sees every row that came before it.
        this.stale = false;
        try {
          const status = await readStatus(this.endpoint, this.sessionId);
          if (this.closed) return;
          this.accept(status);
          this.error = null;
        } catch (error) {
          if (this.closed) return;
          log(`changes: status of ${this.sessionId}: ${error.message}`);
          this.error = error.message;
        }
        this.hooks.changed();
      } while (this.again && !this.closed);
    } finally {
      this.reading = false;
      this.readEnded = Date.now();
      if (!this.closed) {
        this.hooks.changed();
        this.readSoon();
      }
    }
  }

  /**
   * Rows arrived while a run goes on: reads the status RUN_READ_MS after the
   * last read ended, or at once when that is past.
   */
  refreshSoon() {
    if (this.closed) return;
    this.stale = true;
    this.readSoon();
  }

  /**
   * Reads when rows wait for a read (`stale`) and the last one ended
   * RUN_READ_MS ago, else waits for that; a read under way calls it again
   * when it ends.
   */
  readSoon() {
    if (this.closed || !this.stale || this.timer || this.reading) return;
    const wait = this.readEnded + RUN_READ_MS - Date.now();
    if (wait <= 0) {
      this.refresh();
      return;
    }
    this.timer = true;
    this.cx.spawn(async (cx) => {
      await cx.sleep(wait);
      this.timer = false;
      this.readSoon();
    });
  }

  accept(status) {
    if (status === null) {
      this.status = null;
      log(`changes: ${this.sessionId} is not in a Git repository`);
    } else {
      const entries = status.entries.map(entryOf);
      const groups = AREAS.map(([area]) => entries.filter((entry) => entry.area === area)).filter(
        (group) => group.length > 0,
      );
      // The Files tree's color: the change in the work tree first, then an
      // untracked file, then the staged change. A file removed from the
      // index but kept (`git rm --cached`) is staged as deleted and
      // untracked, and shows as added.
      const kinds = new Map();
      for (const area of ['staged', 'untracked', 'worktree']) {
        for (const entry of entries) {
          if (entry.area === area) kinds.set(entry.path.bytesBase64, entry.kind);
        }
      }
      this.status = {
        head: status.head,
        truncated: status.truncated,
        entries,
        groups,
        order: groups.flat(),
        paths: new Set(entries.map((entry) => entry.path.bytesBase64)),
        kinds,
      };
      log(`changes: ${this.sessionId}: ${entries.length} entries, head ${status.head}`);
    }
    const diff = this.diff;
    if (diff === null) return;
    const index = this.status?.order.findIndex((entry) => entry.key === diff.entry.key) ?? -1;
    diff.gone = index < 0;
    if (index >= 0) {
      diff.index = index;
      // Not for a read while the Workbar is closed or on Files; showing
      // Changes again reads the status, and with it the diff.
      if (this.showing) this.readDiff(diff);
    }
  }

  /** Shows the diff of `entry` (a status entry as entryOf makes it) instead of the list. */
  open(entry) {
    if (this.closed) return;
    const index = this.status?.order.findIndex((other) => other.key === entry.key) ?? -1;
    const diff = {
      entry,
      index: Math.max(0, index),
      result: undefined,
      rows: null,
      patch: null,
      error: null,
      reading: false,
      gone: false,
    };
    this.diff = diff;
    this.lastOpened = entry.key;
    log(`changes: diff of ${entry.area} ${entry.text}`);
    this.hooks.changed();
    this.readDiff(diff);
  }

  /**
   * Shows the diff of the file at `b64` (a path's `bytesBase64`): its change
   * in the work tree, else the staged one, else the untracked file. False
   * when the last status does not list it.
   */
  openPath(b64) {
    for (const area of ['worktree', 'staged', 'untracked']) {
      const entry = this.status?.entries.find(
        (other) => other.area === area && other.path.bytesBase64 === b64,
      );
      if (entry !== undefined) {
        this.open(entry);
        return true;
      }
    }
    return false;
  }

  /** Back to the list. */
  back() {
    if (this.diff === null) return;
    this.diff = null;
    this.diffReads += 1;
    this.hooks.changed();
  }

  /**
   * The entry before (`step` -1) or after (1) the one shown, in the list's
   * order, or null at either end. A file that left the list keeps its place.
   */
  neighbor(step) {
    const diff = this.diff;
    const order = this.status?.order ?? [];
    if (diff === null) return null;
    const index = diff.gone ? (step < 0 ? diff.index - 1 : diff.index) : diff.index + step;
    return order[index] ?? null;
  }

  /** Shows the diff before or after the one shown (see neighbor). */
  step(step) {
    const entry = this.neighbor(step);
    if (entry !== null) this.open(entry);
  }

  /** Reads `diff` (again); only the newest read for the diff shown is taken. */
  async readDiff(diff) {
    const read = ++this.diffReads;
    diff.reading = true;
    this.hooks.changed();
    try {
      const result = await query(this.endpoint, 'gitDiff', {
        sessionId: this.sessionId,
        area: diff.entry.area,
        path: diff.entry.path,
      });
      if (this.closed || read !== this.diffReads || this.diff !== diff) return;
      diff.error = null;
      diff.result = result;
      if (result?.kind !== 'text') {
        diff.rows = null;
        diff.patch = null;
      } else if (result.patch !== diff.patch) {
        // Parsed once per text; the same patch read again keeps its rows.
        diff.patch = result.patch;
        diff.rows = parsePatch(result.patch);
        diff.gutter = gutterWidth(diff.rows);
      }
    } catch (error) {
      if (this.closed || read !== this.diffReads || this.diff !== diff) return;
      log(`changes: diff of ${diff.entry.text}: ${error.message}`);
      diff.error = error.message;
    } finally {
      if (read === this.diffReads && this.diff === diff) {
        diff.reading = false;
        if (!this.closed) this.hooks.changed();
      }
    }
  }

  /**
   * The list's items: a heading for each area with changes, its entries, and
   * the note when the status was cut short. Rebuilt only when the status or
   * the marked entry changed.
   */
  items() {
    const status = this.status;
    if (this.view?.status === status && this.view.marked === this.lastOpened) {
      return this.view.items;
    }
    const items = [];
    for (const group of status?.groups ?? []) {
      const [area, heading] = AREAS.find(([name]) => name === group[0].area);
      items.push({ kind: 'group', key: `group/${area}`, heading, count: group.length });
      for (const entry of group) {
        items.push({ kind: 'entry', key: entry.key, entry, marked: entry.key === this.lastOpened });
      }
    }
    if (status?.truncated) {
      items.push({ kind: 'truncated', key: 'truncated', count: status.entries.length });
    }
    this.view = { status, marked: this.lastOpened, items };
    return items;
  }
}

/** The width of a line number column for the largest number in `rows`. */
function gutterWidth(rows) {
  let largest = 0;
  for (const row of rows) largest = Math.max(largest, row.old ?? 0, row.new ?? 0);
  return Math.ceil(String(largest).length * MONO.advance) + 12;
}

/**
 * The Changes tool under the Workbar's header: the diff shown, or the list
 * with its states (reading, failed, not a repository, no changes).
 */
export function changesBody(changes, cx) {
  if (changes.diff !== null) return diffView(changes, cx);
  const m = palette(cx);
  const status = changes.status;
  if (changes.error !== null) {
    return centered(
      v_flex()
        .gap(12)
        .items_center()
        .child(
          text(t('changesFailed', { value: changes.error }), 'body', m.destructive).text_center(),
        )
        .child(
          controlButton('changes-retry', t('retry'), 'outline', changes.reading, cx).on_click(() =>
            changes.refresh(),
          ),
        ),
    );
  }
  if (status === undefined) {
    return centered(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon('status-running', 14, m.primary))
        .child(text(t('changesReading'), 'body', m.inkMuted)),
    );
  }
  if (status === null) {
    return centered(
      v_flex()
        .gap(8)
        .items_center()
        .child(icon('folder', 20, m.inkMuted))
        .child(text(t('changesNotRepository'), 'body', m.inkMuted).text_center()),
    );
  }
  if (status.entries.length === 0) {
    return centered(text(t('changesNone'), 'body', m.inkMuted));
  }
  const items = changes.items();
  const head = status.head === null ? t('changesNoCommits') : status.head.slice(0, 7);
  return v_flex()
    .flex_1()
    .min_h_0()
    .child(
      h_flex()
        .flex_none()
        .h(28)
        .px(16)
        .items_center()
        .child(
          text(
            `${head} · ${tn(changes.count(), 'changesFilesOne', 'changesFilesOther')}`,
            'small',
            m.inkMuted,
          ).truncate(),
        ),
    )
    .child(
      v_flex()
        .relative()
        .flex_1()
        .min_h_0()
        .child(
          uniform_list(
            `changes-${changes.sessionId}`,
            items.length,
            (index) => items[index].key,
            (range) => {
              const rows = [];
              for (let index = range.start; index < range.end; index += 1) {
                rows.push(changesItem(items[index], cx));
              }
              return rows;
            },
          )
            .size_full()
            .pb(8)
            .on_item_click((key) => {
              const item = items.find((entry) => entry.key === key);
              if (item?.kind === 'entry') changes.open(item.entry);
            }),
        )
        .child(Scrollbar.vertical(`changes-${changes.sessionId}`).absolute().inset_0()),
    );
}

/** One item of the Changes list, 28 high: an area's heading, an entry, or the note at the end. */
function changesItem(item, cx) {
  const m = palette(cx);
  const row = h_flex().w_full().h(28).px(8);
  if (item.kind === 'group') {
    return row.child(
      h_flex()
        .w_full()
        .h_full()
        .px(8)
        .gap(6)
        .items_center()
        .child(text(t(item.heading), 'smallLabel', m.inkMuted))
        .child(text(String(item.count), 'small', m.inkMuted)),
    );
  }
  if (item.kind === 'truncated') {
    return row.child(
      text(t('changesTruncated', { count: item.count }), 'small', m.inkMuted)
        .px(8)
        .truncate(),
    );
  }
  const entry = item.entry;
  const [letter, role] = entry.area === 'untracked' ? ['U', 'success'] : KINDS[entry.kind];
  return row.child(
    h_flex()
      .w_full()
      .h_full()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(8)
      .when(item.marked, (el) => el.bg(m.selected))
      .when(!item.marked, (el) => el.hover((style) => style.bg(m.hover)))
      .tooltip(entry.text)
      .child(kindBadge(letter, m[role]))
      .child(text(entry.name, 'label', m.ink).flex_none().max_w('70%').truncate())
      .child(
        typeset(div(), 'small')
          .flex_1()
          .min_w_0()
          .overflow_hidden()
          .whitespace_nowrap()
          .text_ellipsis_start()
          .text_color(m.inkMuted)
          .child(entry.folder),
      ),
  );
}

/** A change's one-letter kind, in its color. */
function kindBadge(letter, color) {
  return div()
    .flex_none()
    .w(12)
    .text_size(12)
    .line_height('20px')
    .font_family('Menlo')
    .font_weight(600)
    .text_color(color)
    .child(letter);
}

/** `child` in the middle of the tool's space. */
function centered(child) {
  return v_flex().flex_1().min_h_0().px(24).items_center().justify_center().child(child);
}

/**
 * One file's diff: a bar with Back (also Escape), the path, the area, and the
 * files before and after it; then the rows, or what a diff that is not text
 * says.
 */
function diffView(changes, cx) {
  const m = palette(cx);
  const diff = changes.diff;
  const entry = diff.entry;
  const area = AREAS.find(([name]) => name === entry.area);
  const previous = changes.neighbor(-1);
  const following = changes.neighbor(1);
  const stepButton = (id, glyph, target, step, tip) =>
    iconButton(id, glyph, cx)
      .disabled(target === null)
      .when(target === null, (el) => el.opacity(0.4))
      .tooltip(tip)
      .on_click(() => changes.step(step));
  return v_flex()
    .flex_1()
    .min_h_0()
    .child(
      h_flex()
        .flex_none()
        .h(40)
        .pl(8)
        .pr(12)
        .gap(6)
        .items_center()
        .border_b_1()
        .border_color(m.borderSoft)
        .child(
          iconButton('diff-back', 'chevron-left', cx)
            .tooltip(t('diffBack'))
            .on_click(() => changes.back()),
        )
        .child(
          h_flex()
            .flex_1()
            .min_w_0()
            .gap(6)
            .items_center()
            .tooltip(entry.text)
            .child(text(entry.name, 'label', m.ink).flex_none().max_w('60%').truncate())
            .child(
              typeset(div(), 'small')
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis_start()
                .text_color(m.inkMuted)
                .child(entry.folder),
            ),
        )
        .child(pill(t(area[2]), cx))
        .child(stepButton('diff-previous', 'chevron-up', previous, -1, t('diffPrevious')))
        .child(stepButton('diff-next', 'chevron-down', following, 1, t('diffNext'))),
    )
    .when(diff.gone, (el) =>
      el.child(
        h_flex()
          .flex_none()
          .h(28)
          .px(16)
          .items_center()
          .bg(m.wash)
          .child(text(t('diffGone'), 'small', m.inkMuted).truncate()),
      ),
    )
    .child(diffBody(changes, diff, cx));
}

/** The diff's rows in a measured list, or a line saying why there are none. */
function diffBody(changes, diff, cx) {
  const m = palette(cx);
  if (diff.error !== null && diff.result === undefined) {
    return centered(
      v_flex()
        .gap(12)
        .items_center()
        .child(text(t('diffFailed', { value: diff.error }), 'body', m.destructive).text_center())
        .child(
          controlButton('diff-retry', t('retry'), 'outline', diff.reading, cx).on_click(() =>
            changes.readDiff(diff),
          ),
        ),
    );
  }
  if (diff.result === undefined) {
    return centered(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon('status-running', 14, m.primary))
        .child(text(t('diffReading'), 'body', m.inkMuted)),
    );
  }
  if (diff.result === null) return centered(text(t('diffNotRepository'), 'body', m.inkMuted));
  if (diff.result.kind !== 'text') {
    return centered(text(t(DIFF_NOTES[diff.result.kind] ?? 'diffUnsupported'), 'body', m.inkMuted));
  }
  const rows = diff.rows;
  // One list per file, so each opens at its top; a file read again keeps
  // its place.
  const id = `diff-${changes.sessionId}-${diff.entry.key}`;
  return v_flex()
    .relative()
    .flex_1()
    .min_h_0()
    .child(
      list(
        id,
        rows.length,
        (index) => String(index),
        (index) => diffRow(rows[index], diff.gutter, m),
      ).size_full(),
    )
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

/** One diff row: the two line numbers, the sign, and the line, wrapped when long. */
function diffRow(row, gutter, m) {
  if (row.kind === 'hunk') {
    return div()
      .w_full()
      .px(12)
      .py(4)
      .bg(m.wash)
      .text_size(12)
      .line_height('20px')
      .font_family('Menlo')
      .text_color(m.inkMuted)
      .child(row.text);
  }
  if (row.kind === 'meta') {
    return div()
      .w_full()
      .pl(DIFF_INSET + gutter * 2 + SIGN_WIDTH)
      .pr(12)
      .text_size(12)
      .line_height('20px')
      .font_family('Menlo')
      .text_color(m.inkMuted)
      .child(row.text);
  }
  const [sign, background] =
    row.kind === 'added'
      ? ['+', m.addedTint]
      : row.kind === 'removed'
        ? ['-', m.removedTint]
        : [' ', null];
  const number = (value) =>
    div()
      .flex_none()
      .w(gutter)
      .pr(8)
      .text_right()
      .text_color(m.inkMuted)
      .child(value === null ? '' : String(value));
  return h_flex()
    .w_full()
    .pl(DIFF_INSET)
    .items_start()
    .text_size(MONO.size)
    .line_height(`${MONO.line}px`)
    .font_family('Menlo')
    .when(background !== null, (el) => el.bg(background))
    .child(number(row.old))
    .child(number(row.new))
    .child(div().flex_none().w(SIGN_WIDTH).text_color(m.inkMuted).child(sign))
    .child(div().flex_1().min_w_0().pr(12).text_color(m.ink).child(row.text));
}
