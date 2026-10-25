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

// One session's transcript: history paging, live updates, and the list that
// draws it.
//
// Rows. A canonical row is one transcript row and field from `agent.history`;
// the fragments a page boundary split it into are joined back into one row.
// A live row holds a part's `delta` text, and a pending row is a sent message
// history has not recorded yet. All three use `<messageId>/<field>` as their
// display key, so recording a message preserves its reading position.
// Row objects are never edited, and each update
// replaces `rows`, `live` or `pending` with a new array, so a render can hand
// the list one consistent snapshot without copying anything.
//
// The conversation follows the public Host session lifecycle:
// - observe, then watch from the observed fence, or from just before the
//   first open part so its earlier deltas replay (results.ts:547-564);
// - the tail page at that fence, going back while a page is empty
//   (results.ts:726-737); older pages keep that first fence. Opened at an
//   anchor (a Search result), the first page is the one that starts at the
//   anchor's row instead, and the pages after it are read up to the newest
//   (results.ts:588-596);
// - facts that change the canonical transcript re-read history after the last
//   loaded row at the newest fence (actions.ts:314-376, results.ts:1080-1087),
//   re-reading the last fragment so its tool and timing metadata refresh;
// - deltas only grow live rows; history replaces them once it has the
//   message (messages.ts:35-122, 186-218).

import { div, list } from 'gpui-kit';
import { v_flex, h_flex, TextView, Scrollbar } from 'gpui-base';
import { query, subscribe, next, close, log, readHistory, readSource } from './host.js';
import { Interactions } from './interactions.js';
import { compareRowPositions, rowPositionKey } from './history-position.js';
import { markedPlain, holdsRow, FOUND_ROW } from './find.js';
import {
  palette,
  typeset,
  text,
  icon,
  tippedIcon,
  markdownStyle,
  byteSize,
  fileChip,
  escapeHtml,
  MONTHS,
  MATCH_FILL,
} from './theme.js';
import { t, tn, language } from './locale.js';

/** A visible range starting at or above this index counts as "at the top" for paging. */
const NEAR_TOP = 3;
/** How many rows back to look for a tool call when its result arrives. */
const TOOL_PAIR_WINDOW = 64;
/** The reading column: at most this wide, with this much on each side (transcriptItem). */
const COLUMN_WIDTH = 720;
const COLUMN_GUTTER = 24;
/** The footer's Fork button, square at the end of the column (turnFooter). */
const FORK_BUTTON = 24;

const FIELD_ORDER = { thinking: 0, body: 1 };

function rowKey(chunk) {
  return `${chunk.messageId}/${chunk.field}`;
}

function textOf(fragments) {
  return fragments.length === 1
    ? fragments[0].text
    : fragments.map((fragment) => fragment.text).join('');
}

function rowFromChunk(chunk) {
  const fragments = [{ offset: chunk.offset, text: chunk.text }];
  return {
    key: rowKey(chunk),
    position: chunk.position,
    field: chunk.field,
    role: chunk.field === 'thinking' ? 'thinking' : chunk.role,
    messageId: chunk.messageId,
    turnId: chunk.turnId,
    tool: chunk.tool,
    timing: chunk.timing ?? null,
    compaction: chunk.compaction ?? null,
    // What posted a user message that is not the user's (a WorkHub notice).
    origin: chunk.origin ?? null,
    // A user message's files, on its first fragment only.
    attachments: chunk.attachments ?? [],
    totalBytes: chunk.totalBytes,
    fragments,
    text: chunk.text,
  };
}

/** The row with `chunk`'s fragment added, or replaced when one starts at the same offset. */
function withFragment(row, chunk) {
  const fragments = row.fragments.filter((fragment) => fragment.offset !== chunk.offset);
  fragments.push({ offset: chunk.offset, text: chunk.text });
  fragments.sort((a, b) => a.offset - b.offset);
  return {
    ...row,
    tool: chunk.tool ?? row.tool,
    timing: chunk.timing ?? row.timing,
    origin: chunk.origin ?? row.origin,
    attachments: chunk.offset === 0 ? (chunk.attachments ?? []) : row.attachments,
    fragments,
    text: textOf(fragments),
  };
}

/** Joins an older part of a row (from a page before) onto the part already loaded. */
function joinRows(older, newer) {
  const fragments = [
    ...older.fragments.filter((a) => !newer.fragments.some((b) => b.offset === a.offset)),
    ...newer.fragments,
  ];
  fragments.sort((a, b) => a.offset - b.offset);
  // The files come with the first fragment, which the older part holds.
  const attachments = older.attachments.length > 0 ? older.attachments : newer.attachments;
  return { ...newer, attachments, fragments, text: textOf(fragments) };
}

/** Negative when the chunk comes before the row in transcript order. */
function compareToRow(chunk, row) {
  return (
    compareRowPositions(chunk.position, row.position) ||
    FIELD_ORDER[chunk.field] - FIELD_ORDER[row.field]
  );
}

function partField(textKind) {
  return textKind === 'thinking' ? 'thinking' : 'body';
}

/** The size after a file's name in a line history adds for it (see ownText). */
const FILE_SIZE = /^ · [\d.]+ (?:B|KiB|MiB)$/;

/**
 * A user message's own text. History writes a line after it for each file
 * sent with it, "↳ name · 26 B", and one for each folder, "▱ path"
 * (platform/event-log/src/transcript/history.rs, BODY); the files' chips show
 * the files, so their lines are left out. Text that does not end in exactly
 * those lines is kept whole.
 */
function ownText(row) {
  const files = row.attachments ?? [];
  if (files.length === 0) return row.text;
  const lines = row.text.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].startsWith('▱ ')) end -= 1;
  const start = end - files.length;
  const listed =
    start >= 0 &&
    files.every((file, index) => {
      const line = lines[start + index];
      const name = `↳ ${file.name}`;
      // The size is left out when the Host has none.
      return line === name || (line.startsWith(name) && FILE_SIZE.test(line.slice(name.length)));
    });
  return listed ? [...lines.slice(0, start), ...lines.slice(end)].join('\n') : row.text;
}

/** The UTF-8 size of `text`, which the Host's byte counts are in. */
function utf8Length(text) {
  let size = 0;
  for (const point of text) {
    const value = point.codePointAt(0);
    size += value <= 0x7f ? 1 : value <= 0x7ff ? 2 : value <= 0xffff ? 3 : 4;
  }
  return size;
}

export class Transcript {
  /**
   * @param {{ id: string, title: string }} session the catalog entry
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   * @param {string} endpoint the Agent endpoint that holds the session: `agent`
   *   for a task, `coordinator` for WorkHub's conversation; every call goes to it
   * @param {{ anchor?: import('./history-position.js').RowPosition | null, anchorField?: string | null }} options
   *   `anchor`, a transcript row position (a Search passage's
   *   `anchorPosition`, a Find match's `position`), opens the transcript at
   *   that row instead of at the newest; `anchorField`, the source field of a
   *   Find match there, opens it at the row's thinking for `thinking`, else at
   *   its body
   */
  constructor(session, hooks, endpoint = 'agent', options = {}) {
    this.session = session;
    this.id = session.id;
    this.hooks = hooks;
    this.endpoint = endpoint;
    this.anchor = options.anchor ?? null;
    this.anchorField = options.anchorField === 'thinking' ? 'thinking' : 'body';
    /**
     * While the list opens at the anchor and keeps the reader where they
     * are, instead of following the newest row (see showing).
     */
    this.anchored = this.anchor !== null;
    /** Accepted local message whose arrival asks the list to resume at its end. */
    this.scrollToEnd = null;
    /** The items the list last showed, `{ start, end, count }`, or null before it drew. */
    this.visible = null;
    this.rows = [];
    this.live = [];
    this.pending = [];
    /** `<messageId>/<field>` of every canonical row, so a delta can tell history already has it. */
    this.covered = new Set();
    /** Open text parts: { invocationId, stepId, partId, messageId, field }. */
    this.parts = [];
    this.ready = false;
    this.closed = false;
    // Paging back: the fence of the first tail page, and the cursor before the oldest row.
    this.olderFence = 0;
    this.before = null;
    this.loadingOlder = false;
    // Reading forward: the cursor after the newest row when the last page stopped short of its fence.
    this.after = null;
    this.following = false;
    this.followAgain = false;
    // Live state from observe and watch.
    this.run = null;
    this.runThrough = 0;
    /**
     * How many runs ended while this was open: an `ended` fact newer than
     * what `run` was last set from, or an observation that found no run
     * where there was one. A run that opened and ended in one watch page
     * counts too, though `run` never showed it (the Workbar reads the
     * status on each).
     */
    this.runsEnded = 0;
    /** turnId -> the invocation id of its run, from the watch's `opened` and `ended` facts. */
    this.invocations = new Map();
    /** Turns whose failed run the Host will not continue: Continue is not offered for them. */
    this.noContinue = new Set();
    /** turnId -> 'reading', 'read' or 'unknown': ownFailure's reads in a fork of all history. */
    this.probes = new Map();
    this.latestKnown = 0;
    this.watchHandle = null;
    this.watchLast = 0;
    /** What the agent is waiting on the user for. */
    this.interactions = new Interactions(this.id, hooks, endpoint);
    this.lastOutcome = null;
    /** The session's backend preference from `agent.observe`, or null. */
    this.backend = null;
    /** Keys of the thinking and tool rows the reader opened; `expandedVersion` counts changes. */
    this.expanded = new Set();
    this.expandedVersion = 0;
    /** Why loading earlier messages failed, until it is tried again. */
    this.olderError = null;
    /** The footer whose turn was just copied, for two seconds. */
    this.copied = null;
    /**
     * Where the last left press in the transcript was, `{ x, width }` against
     * the list: the click that follows tells a footer's Fork button from the
     * rest of the footer by it (see onForkButton).
     */
    this.press = null;
    /**
     * Find's selected match, `{ position, field, pattern }`: its row is
     * tinted, and in a sent message the text `pattern` finds is marked. Null
     * without one.
     */
    this.found = null;
    /**
     * The row Find last showed at the top of the list, `{ position, field,
     * drawn }`, and how many times it did (the list's id counts them; see
     * reveal).
     */
    this.jump = null;
    this.jumps = 0;
    /** The list items last built from the rows (see displayItems). */
    this.view = null;
    /**
     * Tool arguments and results read with `agent.source`, by
     * `<sourceSequence>/<itemIndex>/<field>/<path>`: `{ text, complete, totalBytes, tail }` once
     * read (with `failed` when the read failed), null while it is under way.
     * A conversation page carries tool metadata only.
     */
    this.sources = new Map();
    this.stats = {
      firstPageMs: 0,
      tailCalls: 0,
      olderPages: 0,
      olderCalls: 0,
      follows: 0,
      deltas: 0,
      deltaPages: 0,
    };
  }

  /** Loads the tail, or the page at the anchor, and starts the live updates. */
  async open() {
    const started = Date.now();
    try {
      const observed = await query(this.endpoint, 'observe', { sessionId: this.id });
      if (this.closed) return;
      this.acceptObservation(observed);
      this.parts = observed.parts.map((part) => ({
        invocationId: observed.run?.invocationId ?? null,
        stepId: part.stepId,
        partId: part.partId,
        messageId: part.messageId,
        field: partField(part.textKind),
      }));
      const after = Math.min(
        observed.through,
        ...observed.parts.map((part) => part.startSequence - 1),
      );
      const handle = await subscribe(this.endpoint, 'watch', { sessionId: this.id, after });
      if (this.closed) {
        await close(handle);
        return;
      }
      this.watchHandle = handle;
      this.watchLast = after;
      this.interactions.refresh();
      const fence = observed.through;
      const anchored = this.anchor === null ? null : await this.readAnchor(fence);
      if (this.closed) return;
      if (anchored !== null) {
        this.olderFence = anchored.through;
        this.before = anchored.before;
        this.after = anchored.after;
        this.append(anchored.chunks);
      }
      let position = { kind: 'tail' };
      while (anchored === null) {
        const { page, calls } = await readHistory(
          this.historyInput(fence, position),
          this.endpoint,
        );
        this.stats.tailCalls += calls;
        if (this.closed) return;
        if (page.chunks.length === 0 && page.before !== null) {
          position = { kind: 'before', cursor: page.before };
          continue;
        }
        this.olderFence = page.through;
        this.before = page.before;
        this.after = page.after;
        this.append(page.chunks);
        break;
      }
      this.ready = true;
      this.stats.firstPageMs = Date.now() - started;
      log(
        `transcript "${this.session.title}": first page ${this.rows.length} rows in ${this.stats.firstPageMs} ms ` +
          `(${this.stats.tailCalls} history call(s), fence ${fence}, older ${this.before ? 'available' : 'none'}` +
          `${anchored === null ? '' : `, at row ${rowPositionKey(this.anchor)}`})`,
      );
      this.hooks.changed();
      // Facts after the observed fence arrive on the first pages; any that
      // change the transcript read history after the tail just loaded.
      this.watch(handle);
      // At the anchor, the rows after the first page are read up to the newest.
      if (anchored !== null) this.follow();
    } catch (error) {
      if (!this.closed) this.hooks.report(t('transcriptFailed', { value: error.message }));
    }
  }

  /**
   * The history page that starts at the anchor's row (its `anchorField`),
   * read at `fence` as the exact inclusive row boundary. Null when it cannot
   * be read or has nothing, and the transcript then opens at the newest row
   * as usual.
   */
  async readAnchor(fence) {
    const position = { kind: 'row', position: this.anchor, field: this.anchorField };
    try {
      const { page, calls } = await readHistory(this.historyInput(fence, position), this.endpoint);
      this.stats.tailCalls += calls;
      if (page.chunks.length > 0) return page;
      log(
        `transcript "${this.session.title}": nothing at row ${rowPositionKey(this.anchor)}; opening at the newest`,
      );
    } catch (error) {
      log(
        `transcript "${this.session.title}": reading at row ${rowPositionKey(this.anchor)} failed: ${error.message}; opening at the newest`,
      );
    }
    this.anchored = false;
    return null;
  }

  /**
   * The list showed items `range` of `count`. A transcript opened at its
   * anchor follows its newest row again once that row is on screen with
   * nothing newer left to read: the reader has caught up.
   */
  showing(range, count) {
    this.visible = { start: range.start, end: range.end, count };
    if (
      this.anchored &&
      this.ready &&
      !this.following &&
      this.after === null &&
      range.end >= count
    ) {
      this.anchored = false;
      log(`transcript "${this.session.title}": the newest row is on screen; following it again`);
      this.hooks.changed();
    }
  }

  /**
   * The newest turn when it failed and nothing runs or waits to be sent:
   * `{ turnId, message }`, with the whole text of the message that started
   * it, or null as `message` when only part of that text is loaded, it has
   * none, it came with files (the files are not at hand to send again), or a
   * WorkHub notice started the turn. A turn whose message is not loaded, or
   * that a continued run started (it has no message of its own), has a null
   * `message` too. Null otherwise, and while newer history is still to be
   * read. A stopped turn is left alone: the user stopped it.
   */
  failedTurn() {
    if (!this.ready || this.after !== null) return null;
    if (this.run !== null || this.pending.length > 0 || this.live.length > 0) return null;
    const last = this.rows.at(-1);
    if (last?.timing?.finished?.outcome !== 'failed') return null;
    const start = this.rows.find((row) => row.turnId === last.turnId && row.role === 'user');
    if (!start) return { turnId: last.turnId, message: null };
    // A turn a WorkHub notice started is WorkHub's to start again, not the user's.
    const notice = start.origin !== null;
    const whole = start.fragments[0]?.offset === 0 && utf8Length(start.text) === start.totalBytes;
    const files = (start.attachments ?? []).length > 0;
    const message = whole && !notice && !files ? ownText(start) : '';
    return { turnId: last.turnId, message: message.trim() !== '' ? message : null };
  }

  /**
   * The invocation id of the run that failed `turnId`, for `agent.resume`:
   * from the watch when the run ended while this was open, else from the
   * newest execution entries of `agent.diagnostics` (a few pages at most).
   * Null when neither has it.
   */
  async failedRun(turnId) {
    const seen = this.invocations.get(turnId);
    if (seen !== undefined) return seen;
    let position = { kind: 'latest' };
    for (let pages = 0; pages < 4; pages += 1) {
      const page = await query(this.endpoint, 'diagnostics', { sessionId: this.id, position });
      const entry = page.entries.find(
        (each) => each.detail?.kind === 'execution' && each.detail.invocation?.turn_id === turnId,
      );
      if (entry) return entry.detail.invocation.invocation_id;
      if (page.nextBefore === null || page.nextBefore === undefined) return null;
      position = { kind: 'before', through: page.through, sequence: page.nextBefore };
    }
    return null;
  }

  /**
   * Whether the run that failed `turnId` is this task's own, the only kind
   * `agent.resume` continues. In a fork the newest turn can be a failure
   * copied from the source, whose runs the fork's diagnostics do not list.
   * A fork through a turn copied that turn and none after it. In a fork of
   * all history this reads failedRun once, and is false while it reads: a
   * run it finds is kept in `invocations`, a turn it does not goes to
   * `noContinue`, and when the read fails this is true, so Continue can ask.
   */
  ownFailure(turnId) {
    const branch = this.session.branch ?? null;
    if (branch === null || this.invocations.has(turnId)) return true;
    if ((branch.turnId ?? null) !== null) return branch.turnId !== turnId;
    if (!this.probes.has(turnId)) {
      this.probes.set(turnId, 'reading');
      this.failedRun(turnId).then(
        (invocationId) => {
          if (invocationId === null) this.noContinue.add(turnId);
          else this.invocations.set(turnId, invocationId);
          this.probes.set(turnId, 'read');
          if (!this.closed) this.hooks.changed();
        },
        (error) => {
          log(
            `transcript "${this.session.title}": finding the failed run failed: ${error.message}`,
          );
          this.probes.set(turnId, 'unknown');
          if (!this.closed) this.hooks.changed();
        },
      );
    }
    return this.probes.get(turnId) === 'unknown';
  }

  /** Stops the live updates. A pending `next()` resolves with null. */
  async close() {
    this.closed = true;
    this.interactions.close();
    const handle = this.watchHandle;
    this.watchHandle = null;
    if (handle !== null) await close(handle);
  }

  historyInput(through, position) {
    return { sessionId: this.id, through, position, includeThinking: true, view: 'conversation' };
  }

  /** The single `next()` loop for this transcript's watch subscription. */
  async watch(handle) {
    try {
      for (;;) {
        const page = await next(handle);
        if (page === null || this.closed) break;
        this.deliver(page);
      }
      if (!this.closed) this.hooks.report(t('liveUpdatesEnded'));
    } catch (error) {
      if (!this.closed) this.hooks.report(t('liveUpdatesFailed', { value: error.message }));
    }
  }

  /** Applies one watch page (results.ts:972-1087). */
  deliver(page) {
    if (page.kind === 'interactions') {
      this.interactions.accept(page.pending);
      this.observeRun();
      return;
    }
    if (page.kind !== 'events') return;
    this.latestKnown = Math.max(this.latestKnown, page.through);
    let canonicalChanged = false;
    let observeAgain = false;
    let deltas = 0;
    for (const event of page.events) {
      if (event.sequence <= this.watchLast) continue;
      const fact = event.fact;
      switch (fact.kind) {
        case 'opened':
          if (event.turnId) this.invocations.set(event.turnId, event.invocationId);
          if (event.sequence > this.runThrough) {
            this.run = { invocationId: event.invocationId, turnId: event.turnId, state: 'running' };
            this.runThrough = event.sequence;
            log(`watch: run ${event.invocationId} opened at ${event.sequence}`);
          }
          canonicalChanged = observeAgain = true;
          break;
        case 'executor_started':
          this.openParts(
            ['text', 'thinking'].map((textKind) => ({
              invocationId: event.invocationId,
              stepId: event.invocationId,
              partId: textKind,
              messageId: fact.messageId,
              field: partField(textKind),
            })),
          );
          canonicalChanged = true;
          break;
        case 'part_started':
          this.openParts([
            {
              invocationId: event.invocationId,
              stepId: fact.stepId,
              partId: fact.partId,
              messageId: fact.messageId,
              field: partField(fact.textKind),
            },
          ]);
          break;
        case 'delta': {
          const part = this.parts.find(
            (open) =>
              open.invocationId === event.invocationId &&
              open.stepId === fact.stepId &&
              open.partId === fact.partId,
          );
          if (part) {
            this.appendLive(part, fact.text, event.sequence);
            deltas += 1;
          }
          break;
        }
        case 'part_finished':
          this.parts = this.parts.filter(
            (open) =>
              open.invocationId !== event.invocationId ||
              open.stepId !== fact.stepId ||
              open.partId !== fact.partId,
          );
          canonicalChanged = true;
          break;
        case 'step_ended':
          this.closeLive(event.sequence, event.invocationId, fact.stepId);
          this.parts = this.parts.filter(
            (open) => open.invocationId !== event.invocationId || open.stepId !== fact.stepId,
          );
          canonicalChanged = observeAgain = true;
          break;
        case 'transcript_changed':
        case 'tool_input_ready':
        case 'tool_dispatched':
        case 'tool_rejected':
        case 'tool_settled':
        case 'provider_tool_result':
        case 'executor_tool_start':
        case 'executor_tool_result':
          canonicalChanged = true;
          break;
        case 'ended':
          if (event.turnId) this.invocations.set(event.turnId, event.invocationId);
          this.closeLive(event.sequence, event.invocationId);
          this.parts = this.parts.filter((open) => open.invocationId !== event.invocationId);
          if (event.sequence > this.runThrough) this.runsEnded += 1;
          if (event.sequence > this.runThrough && this.run?.invocationId === event.invocationId) {
            this.run = null;
            this.runThrough = event.sequence;
          }
          this.lastOutcome = fact.failed ? 'failed' : 'completed';
          log(`watch: run ${event.invocationId} ended at ${event.sequence}, failed=${fact.failed}`);
          canonicalChanged = observeAgain = true;
          break;
      }
    }
    this.watchLast = Math.max(this.watchLast, page.nextAfter);
    if (deltas > 0) {
      this.stats.deltas += deltas;
      this.stats.deltaPages += 1;
    }
    if (canonicalChanged) this.follow();
    if (observeAgain) this.observeRun();
    this.hooks.changed();
  }

  openParts(started) {
    const same = (a, b) =>
      a.invocationId === b.invocationId && a.stepId === b.stepId && a.partId === b.partId;
    this.parts = [
      ...this.parts.filter((open) => !started.some((part) => same(open, part))),
      ...started,
    ];
  }

  appendLive(part, text, sequence) {
    const covered = `${part.messageId}/${part.field}`;
    if (text === '' || this.covered.has(covered)) return;
    const key = covered;
    const index = this.live.findIndex((row) => row.key === key);
    if (index < 0) {
      const row = {
        key,
        role: part.field === 'thinking' ? 'thinking' : 'assistant',
        covered,
        live: true,
        text,
        invocationId: part.invocationId,
        stepId: part.stepId,
        sequence,
        closedAt: null,
      };
      this.live = [...this.live, row];
    } else {
      const row = this.live[index];
      const live = this.live.slice();
      live[index] = { ...row, text: row.text + text, sequence };
      this.live = live;
    }
  }

  /** Marks the live text of a step, or of a whole run, as finished at `sequence` (messages.ts closeLive). */
  closeLive(sequence, invocationId, stepId = undefined) {
    this.live = this.live.map((row) =>
      row.closedAt === null &&
      row.invocationId === invocationId &&
      (stepId === undefined || row.stepId === stepId)
        ? { ...row, closedAt: sequence }
        : row,
    );
  }

  /** Re-reads `run` after a run fact; an older answer than the facts already seen is ignored. */
  async observeRun() {
    try {
      const observed = await query(this.endpoint, 'observe', { sessionId: this.id });
      if (this.closed) return;
      this.acceptObservation(observed);
      this.hooks.changed();
    } catch (error) {
      if (!this.closed) this.hooks.report(t('sessionStateFailed', { value: error.message }));
    }
  }

  acceptObservation(observed) {
    this.latestKnown = Math.max(this.latestKnown, observed.through);
    // The model the TUI would send with: the session's own, else the one the owner remembers.
    this.backend = observed.session.backend ?? observed.rememberedBackend ?? null;
    if (observed.through >= this.runThrough) {
      const run = observed.run ?? null;
      if (this.run !== null && run === null) this.runsEnded += 1;
      this.run = run;
      this.runThrough = observed.through;
    }
  }

  /**
   * Reads history after the newest loaded row at the newest known fence and
   * appends it. One read at a time; facts that arrive meanwhile ask for one
   * more pass.
   */
  async follow() {
    if (this.following) {
      this.followAgain = true;
      return;
    }
    this.following = true;
    try {
      do {
        this.followAgain = false;
        this.stats.follows += 1;
        const fence = this.latestKnown;
        let position = this.afterPosition();
        const chunks = [];
        for (;;) {
          const { page } = await readHistory(this.historyInput(fence, position), this.endpoint);
          if (this.closed) return;
          chunks.push(...page.chunks);
          if (page.after === null) break;
          position = { kind: 'after', cursor: page.after };
        }
        // Publish the whole pass together: a partial field must not replace
        // live text or suppress its deltas while the next page is pending.
        // Merge into the current rows, including any intervening older page.
        this.append(chunks);
        this.after = null;
        // History through `fence` is read to its end. Text it now holds, and
        // text whose step closed by then without reaching history, is no longer
        // live (results.ts history case).
        this.live = this.live.filter(
          (row) =>
            !this.covered.has(row.covered) &&
            (row.sequence > fence || row.closedAt === null || row.closedAt > fence),
        );
        this.pending = this.pending.filter((row) => !this.covered.has(row.covered));
        this.hooks.changed();
      } while (this.followAgain && !this.closed);
    } catch (error) {
      if (!this.closed) this.hooks.report(t('transcriptFailed', { value: error.message }));
    } finally {
      this.following = false;
    }
  }

  afterPosition() {
    if (this.after !== null) return { kind: 'after', cursor: this.after };
    const last = this.rows.at(-1);
    if (!last) return { kind: 'start' };
    const fragment = last.fragments[last.fragments.length - 1];
    return {
      kind: 'after',
      cursor: { position: last.position, field: last.field, offset: fragment.offset },
    };
  }

  /** Adds a page's chunks after the loaded rows. */
  append(chunks) {
    if (chunks.length === 0) return;
    const rows = this.rows.slice();
    for (const chunk of chunks) {
      const last = rows[rows.length - 1];
      if (last && last.key === rowKey(chunk)) {
        rows[rows.length - 1] = withFragment(last, chunk);
      } else if (last && compareToRow(chunk, last) < 0) {
        // Re-read boundary rows are already loaded; only their tool pair can have moved on.
      } else {
        const row = rowFromChunk(chunk);
        rows.push(row);
        this.covered.add(`${row.messageId}/${row.field}`);
      }
      this.pairTool(rows, chunk);
    }
    this.rows = rows;
  }

  /**
   * A tool result carries its call's reference; give the call row the newer
   * pair so it can show how the call settled (results.ts:754-764).
   */
  pairTool(rows, chunk) {
    const call = chunk.tool?.call;
    if (!call || !chunk.tool.result || compareRowPositions(call.position, chunk.position) === 0)
      return;
    const floor = Math.max(0, rows.length - TOOL_PAIR_WINDOW);
    for (let index = rows.length - 1; index >= floor; index -= 1) {
      if (
        compareRowPositions(rows[index].position, call.position) === 0 &&
        rows[index].role === 'tool_call'
      ) {
        rows[index] = { ...rows[index], tool: chunk.tool };
        return;
      }
    }
  }

  /** Adds a page's chunks before the loaded rows. */
  prepend(chunks) {
    const older = [];
    for (const chunk of chunks) {
      const last = older[older.length - 1];
      if (last && last.key === rowKey(chunk)) older[older.length - 1] = withFragment(last, chunk);
      else older.push(rowFromChunk(chunk));
    }
    let rest = this.rows;
    if (older.length > 0 && rest.length > 0 && older[older.length - 1].key === rest[0].key) {
      older[older.length - 1] = joinRows(older[older.length - 1], rest[0]);
      rest = rest.slice(1);
    }
    for (const row of older) this.covered.add(`${row.messageId}/${row.field}`);
    this.rows = older.concat(rest);
  }

  /** Loads the page before the oldest row, at the first page's fence. Resolves with the history calls made. */
  async loadOlder() {
    if (this.before === null || this.loadingOlder || this.closed || !this.ready) return 0;
    this.loadingOlder = true;
    this.olderError = null;
    this.hooks.changed();
    let calls = 0;
    try {
      let position = { kind: 'before', cursor: this.before };
      for (;;) {
        const read = await readHistory(this.historyInput(this.olderFence, position), this.endpoint);
        calls += read.calls;
        if (this.closed) return calls;
        const page = read.page;
        this.before = page.before;
        if (page.chunks.length > 0 || page.before === null) {
          this.prepend(page.chunks);
          break;
        }
        position = { kind: 'before', cursor: page.before };
      }
      this.stats.olderPages += 1;
      this.stats.olderCalls += calls;
    } catch (error) {
      if (!this.closed) {
        this.olderError = error.message;
        this.hooks.report(t('earlierMessagesFailed', { value: error.message }));
      }
    } finally {
      this.loadingOlder = false;
      this.hooks.changed();
    }
    return calls;
  }

  /**
   * A click on a list item: opens or closes a thinking or tool row, retries
   * the history, or copies a finished turn's reply.
   */
  click(key, cx) {
    if (key === 'history') {
      if (this.olderError !== null) this.loadOlder();
      return;
    }
    if (key.startsWith('footer/')) {
      const turnId = key.slice('footer/'.length);
      if (this.forks() && this.onForkButton()) {
        this.hooks.fork(this.session, turnId);
        return;
      }
      if (!this.view?.items.find((entry) => entry.key === key)?.copies) return;
      const reply = this.rows
        .filter((row) => row.turnId === turnId && row.role === 'assistant')
        .map((row) => row.text)
        .join('\n\n');
      cx.write_to_clipboard(reply);
      this.copied = key;
      this.hooks.changed();
      cx.spawn(async (cx) => {
        await cx.sleep(2000);
        if (this.copied === key) {
          this.copied = null;
          this.hooks.changed();
        }
      });
      return;
    }
    const item = this.view?.items.find((entry) => entry.key === key);
    if (item?.kind === 'notice') {
      // A WorkHub notice shows its task in WorkHub's Tasks tab.
      const { taskId, worker } = item.notice;
      if (taskId !== null) this.hooks.openTask?.(taskId, worker);
      return;
    }
    if (item?.kind !== 'thinking' && item?.kind !== 'tool') return;
    if (!this.expanded.delete(key)) this.expanded.add(key);
    this.expandedVersion += 1;
    this.hooks.changed();
  }

  /**
   * Shows the row at `position` (its `field`, when given; see holdsRow) at
   * the top of the list, for Find, when it is loaded, and answers whether it
   * was. A list cannot be scrolled to an item, but a new list opens at its
   * first item: a list with a new id is drawn from the row's item for one
   * frame, then whole, and keeps that item at its top (transcriptPane). It
   * stays there while rows are added, as at an anchor, until the reader
   * reaches the newest row again. A loaded row that no item shows leaves the
   * list as it is.
   */
  reveal(position, field = null) {
    const loaded = this.rows.some((row) => compareRowPositions(row.position, position) === 0);
    if (!this.ready || !loaded) return false;
    if (!displayItems(this).some((item) => holdsRow(item, position, field))) {
      log(`transcript "${this.session.title}": no item shows row ${rowPositionKey(position)}`);
      return true;
    }
    this.jumps += 1;
    this.jump = { position, field, drawn: false };
    this.anchored = true;
    this.hooks.changed();
    return true;
  }

  /** Whether turn footers offer Fork: a task's conversation, not WorkHub's. */
  forks() {
    return this.endpoint === 'agent' && typeof this.hooks.fork === 'function';
  }

  /** A left press in the transcript, from the area around the list. */
  pressed(event) {
    const { local_position: at, bounds } = event;
    this.press = at && bounds ? { x: at.x, width: bounds.width } : null;
  }

  /**
   * Whether the press before a footer's click was on its Fork button, the
   * last FORK_BUTTON of the reading column. List rows take one click
   * handler for the whole list, so the press's place tells the button from
   * the rest of the footer, which copies.
   */
  onForkButton() {
    const press = this.press;
    this.press = null;
    if (press === null) return false;
    const column = Math.min(COLUMN_WIDTH, press.width - 2 * COLUMN_GUTTER);
    const end = (press.width + column) / 2;
    return press.x >= end - FORK_BUTTON && press.x <= end;
  }

  /**
   * The start of a tool row's `arguments` or `result`, or of the value at
   * `path` in it, as `{ text, complete, totalBytes, tail, failed? }`; null until
   * it has been read. The first ask starts the read and the transcript changes
   * when it lands. Rows never change, so a read is kept for as long as the
   * transcript.
   *
   * With `ends`, a value too long for one excerpt is read on: whole when it
   * is at most WHOLE_BYTES (the size a command's captured output is held to),
   * else from its end as well, `tail` becoming `{ text, offset }` (null until
   * then). An output block shows both ends, since a command's last lines say
   * how it ended.
   */
  source(rowPosition, field, path = [], ends = false) {
    const key = `${rowPositionKey(rowPosition)}/${field}/${path.join('/')}`;
    if (this.sources.has(key)) {
      const known = this.sources.get(key);
      if (
        ends &&
        known !== null &&
        !known.complete &&
        known.failed === undefined &&
        known.tail === undefined
      ) {
        this.readRest(key, rowPosition, field, path, known);
      }
      return known;
    }
    this.sources.set(key, null);
    this.excerpt(rowPosition, field, path, { kind: 'start' }).then(
      (source) => {
        const complete = source.offset === 0 && utf8Length(source.text) === source.totalBytes;
        const read = {
          text: source.text,
          complete,
          totalBytes: source.totalBytes,
          tail: undefined,
        };
        this.sources.set(key, read);
        if (ends && !complete) this.readRest(key, rowPosition, field, path, read);
        if (!this.closed) this.hooks.changed();
      },
      (error) => {
        log(`source ${key}: ${error.message}`);
        this.sources.set(key, { text: '', complete: false, failed: error.message });
        if (!this.closed) this.hooks.changed();
      },
    );
    return null;
  }

  /**
   * Reads on past a start excerpt that did not reach the end: the rest of a
   * value of at most WHOLE_BYTES, else its end. On a failure the start still
   * shows; only the rest is missing.
   */
  async readRest(key, rowPosition, field, path, read) {
    read.tail = null;
    try {
      if (read.totalBytes <= WHOLE_BYTES) {
        let text = read.text;
        let end = utf8Length(text);
        while (end < read.totalBytes) {
          const page = await this.excerpt(rowPosition, field, path, { kind: 'after', offset: end });
          if (page.offset !== end || page.text === '') throw new Error(`no excerpt after ${end}`);
          text += page.text;
          end += utf8Length(page.text);
        }
        read.text = text;
        read.complete = true;
      } else {
        const page = await this.excerpt(rowPosition, field, path, { kind: 'tail' });
        read.tail = { text: page.text, offset: page.offset };
      }
      if (!this.closed) this.hooks.changed();
    } catch (error) {
      log(`source ${key} rest: ${error.message}`);
    }
  }

  excerpt(rowPosition, field, path, position) {
    return readSource(
      {
        sessionId: this.id,
        // An event fence, not a row position: every loaded row is at or below it.
        through: this.latestKnown,
        source: { kind: 'row', position: rowPosition },
        field,
        path: path.length > 0 ? path : null,
        position,
      },
      this.endpoint,
    );
  }

  /**
   * Shows a sent message, with the files sent with it (`{ name, bytes }`),
   * until history records it. Sending ends reading at the anchor: the list
   * follows the newest row again, where the message shows.
   */
  addPending(messageId, text, attachments = []) {
    this.anchored = false;
    this.scrollToEnd = messageId;
    const covered = `${messageId}/body`;
    if (this.covered.has(covered)) return;
    this.pending = [
      ...this.pending,
      { key: covered, role: 'user', covered, pending: true, text, attachments },
    ];
  }
}

/** Where the transcript's earliest history stands, as the row above the first message shows it. */
function historyState(transcript) {
  if (transcript.loadingOlder) return 'loading';
  if (transcript.olderError !== null) return 'failed';
  if (transcript.before === null && transcript.rows.length > 0) return 'start';
  return null;
}

/**
 * The items the list draws: the history row, the transcript rows (a tool
 * result is drawn with its call), a footer after each finished turn, and a
 * working row while a run is open. Rebuilt only when what it reads changed.
 */
function displayItems(transcript) {
  const { rows, pending, live } = transcript;
  const history = historyState(transcript);
  const working = transcript.run !== null && transcript.interactions.entries.length === 0;
  const cached = transcript.view;
  if (
    cached !== null &&
    cached.rows === rows &&
    cached.pending === pending &&
    cached.live === live &&
    cached.expanded === transcript.expandedVersion &&
    cached.history === history &&
    cached.working === working
  ) {
    return cached.items;
  }
  // A result goes with the call the Host paired it with (`tool.call.position`);
  // tool use ids are only unique within a step.
  const calls = new Set();
  const results = new Map();
  const timings = new Map();
  /** Turns with reply text, the only ones whose footer copies. */
  const replied = new Set();
  for (const row of rows) {
    if (row.role === 'tool_call') calls.add(rowPositionKey(row.position));
    if (row.role === 'assistant' && row.text.trim() !== '') replied.add(row.turnId);
    const call = row.tool?.call?.position;
    if (row.role === 'tool_result' && call !== undefined) results.set(rowPositionKey(call), row);
    if (row.timing) timings.set(row.turnId, row.timing);
  }
  /** @type {any[]} */
  const items = [];
  if (history !== null) items.push({ key: 'history', kind: 'history', state: history });
  rows.forEach((row, index) => {
    if (
      row.role === 'tool_result' &&
      row.tool?.call &&
      calls.has(rowPositionKey(row.tool.call.position))
    ) {
      // Drawn with its call.
    } else if (row.role === 'tool_call' || row.role === 'tool_result') {
      const result =
        row.role === 'tool_call' ? (results.get(rowPositionKey(row.position)) ?? null) : row;
      // Keyed by its call's position, whether the call is loaded or not: a
      // result read before its call (a transcript opened at the result) keeps
      // its key, and so its place at the top of the list, when the call is
      // read in above it.
      const call = row.role === 'tool_call' ? row.position : row.tool?.call?.position;
      const key = call === undefined ? row.key : `tool/${rowPositionKey(call)}`;
      items.push({
        key,
        kind: 'tool',
        row,
        result,
        open: transcript.expanded.has(key),
      });
    } else if (row.role === 'thinking') {
      items.push({ key: row.key, kind: 'thinking', row, open: transcript.expanded.has(row.key) });
    } else if (row.role === 'failure') {
      // A run's interruption and its end can both record the same reason:
      // one item shows both, keyed by the later row so that its key stays
      // when the earlier one is read in after it. `also` lists the rows it
      // stands for besides its own (holdsRow).
      const previous = items.at(-1);
      const repeated =
        previous?.kind === 'failure' &&
        previous.row.turnId === row.turnId &&
        previous.row.text === row.text;
      const item = { key: row.key, kind: 'failure', row };
      if (repeated) {
        item.also = [previous.row.position, ...(previous.also ?? [])];
        items[items.length - 1] = item;
      } else {
        items.push(item);
      }
    } else if (row.role === 'compaction') {
      // As in the TUI, a checkpoint shows only once it was adopted.
      if (row.compaction !== null) items.push({ key: row.key, kind: 'compaction', row });
    } else if (row.role === 'user' && row.origin !== null) {
      items.push({ key: row.key, kind: 'notice', row, notice: workhubNotice(row) });
    } else {
      items.push({ key: row.key, kind: row.role === 'user' ? 'user' : 'assistant', row });
    }
    const next = rows[index + 1];
    const finished = timings.get(row.turnId)?.finished ?? null;
    if ((next === undefined || next.turnId !== row.turnId) && finished !== null) {
      items.push({
        key: `footer/${row.turnId}`,
        kind: 'footer',
        turnId: row.turnId,
        finished,
        copies: replied.has(row.turnId),
      });
    }
  });
  for (const row of pending) items.push({ key: row.key, kind: 'user', row });
  for (const row of live) {
    items.push(
      row.role === 'thinking'
        ? {
            key: row.key,
            kind: 'thinking',
            row,
            open: transcript.expanded.has(row.key),
            streaming: true,
          }
        : { key: row.key, kind: 'assistant', row },
    );
  }
  if (working) items.push({ key: 'working', kind: 'working' });
  // Consecutive tool calls form one group; the space after a row depends on what follows.
  items.forEach((item, index) => {
    const next = items[index + 1];
    const previous = items[index - 1];
    if (item.kind === 'tool') {
      item.first = previous?.kind !== 'tool';
      item.last = next?.kind !== 'tool';
    }
    item.gap = item.kind === 'user' ? 24 : item.kind === 'tool' && next?.kind === 'tool' ? 0 : 12;
  });
  transcript.view = {
    rows,
    pending,
    live,
    expanded: transcript.expandedVersion,
    history,
    working,
    items,
  };
  return items;
}

/**
 * The selected task's transcript: the measured list in the reading column,
 * and its scrollbar. `empty`, when given, is what a transcript with no
 * messages shows instead of saying so.
 */
export function transcriptPane(transcript, loadOlder, cx, empty = null) {
  const m = palette(cx);
  // One snapshot for this render; the list's callbacks run during later
  // layouts and must agree with the count given here.
  const all = displayItems(transcript);
  // After Find showed a row: the items from it on for one frame (reveal).
  const jump = transcript.jump;
  const from =
    jump === null || jump.drawn
      ? 0
      : Math.max(
          0,
          all.findIndex((item) => holdsRow(item, jump.position, jump.field)),
        );
  const items = from > 0 ? all.slice(from) : all;
  const hasRows = transcript.rows.length + transcript.pending.length + transcript.live.length > 0;
  const id = `transcript-${transcript.id}${transcript.jumps > 0 ? `-${transcript.jumps}` : ''}`;
  return (
    v_flex()
      .id(`${id}-area`)
      .relative()
      .flex_1()
      .min_h_0()
      // A footer's click comes on release; the press before it says where it was.
      .on_mouse_down('left', (event) => transcript.pressed(event))
      .when(!transcript.ready || !hasRows, (el) =>
        el
          .items_center()
          .justify_center()
          .child(
            transcript.ready && empty !== null
              ? empty
              : text(transcript.ready ? t('noMessagesYet') : t('loading'), 'body', m.inkMuted),
          ),
      )
      .when(transcript.ready && hasRows, (el) =>
        el
          .child(
            list(
              id,
              items.length,
              (index) => items[index].key,
              (index, cx) => transcriptItem(items[index], transcript, cx),
            )
              // Opens at the newest row and stays there while a reply
              // streams, until the reader scrolls up. Opened at an anchor, it
              // opens at its top, the anchor's row, and keeps the reader's top
              // row in place as pages are put above and added below, until the
              // reader reaches the newest row or sends (Transcript.showing).
              .with_follow_mode(transcript.anchored ? 'normal' : 'tail')
              .scroll_to_end(transcript.scrollToEnd)
              // Reported after the frame, however the range changed: a
              // wheel, a scrollbar drag, or rows that do not fill the view.
              // The range is of the items drawn, which start at `from`.
              .on_visible_range_change((range, shown) => {
                const start = range.start + from;
                const end = range.end + from;
                log(`transcript: showing ${start}..${end} of ${shown + from}`);
                if (jump !== null && !jump.drawn) {
                  jump.drawn = true;
                  if (from > 0) transcript.hooks.changed();
                }
                transcript.showing({ start, end }, shown + from);
                if (start < NEAR_TOP && transcript.before !== null) loadOlder();
              })
              .on_item_click((key, cx) => transcript.click(key, cx)),
          )
          .child(Scrollbar.vertical(id).absolute().inset_0()),
      )
  );
}

/** One item of the transcript list, in the reading column; called from layout for each visible item. */
function transcriptItem(item, transcript, cx) {
  const found = transcript.found;
  const hit = found !== null && holdsRow(item, found.position, found.field);
  const body = itemBody(item, transcript, cx, hit ? found.pattern : null);
  const dark = cx.theme().is_dark;
  // Find's match: the row tinted, reaching 8 past the column on each side
  // and 8 above and below the row (16 for a sent message, which has 16
  // above it already), taken from the space after it where there is some.
  const below = item.kind === 'user' ? 16 : 8;
  return h_flex()
    .w_full()
    .px(COLUMN_GUTTER)
    .justify_center()
    .child(
      v_flex()
        .w_full()
        .max_w(COLUMN_WIDTH)
        .pb(hit ? Math.max(0, item.gap - below) : item.gap)
        .child(
          hit
            ? div()
                .mx(-8)
                .px(8)
                .when(item.kind !== 'user', (el) => el.pt(8))
                .pb(below)
                .rounded(8)
                .bg(dark ? FOUND_ROW.dark : FOUND_ROW.light)
                .child(body)
            : body,
        ),
    );
}

/**
 * An item's content; `pattern`, when given, finds the text to mark in a sent
 * message (Find). Replies are markdown, which marks inserted into it can
 * change, so they get only the row's tint.
 */
function itemBody(item, transcript, cx, pattern = null) {
  const m = palette(cx);
  const fill = cx.theme().is_dark ? MATCH_FILL.dark : MATCH_FILL.light;
  switch (item.kind) {
    case 'history':
      return historyRow(item.state, transcript, cx);
    case 'user':
      return userMessage(
        item.row,
        cx,
        pattern === null ? null : (own) => markedPlain(own, pattern, fill),
      );
    case 'assistant':
      return markdownText(`md-${item.key}`, item.row.text, cx);
    case 'thinking':
      return thinkingRow(item, cx);
    case 'tool':
      return toolRow(item, transcript, cx);
    case 'footer':
      return turnFooter(item, transcript, cx);
    case 'failure':
      return failureRow(item, cx);
    case 'compaction':
      return compactionRow(item, cx);
    case 'notice':
      return noticeRow(item, transcript, cx);
    case 'working':
      return h_flex()
        .h(24)
        .gap(4)
        .items_center()
        .child(icon('status-running', 12, m.primary))
        .child(text(t('working'), 'small', m.inkMuted));
    default:
      return div();
  }
}

/**
 * Markdown as an assistant's reply reads: the reading style and the native
 * client's markdown look. WorkHub's task replies use it too.
 */
export function markdownText(id, source, cx) {
  return typeset(div(), 'reading')
    .w_full()
    .text_color(palette(cx).ink)
    .child(TextView.markdown(id, source).text_style(markdownStyle(cx)));
}

/**
 * `value` as HTML that reads as the plain text it is: escaped, in a `<pre>`
 * so its spaces, tabs and line breaks stay as they are and a copy gives back
 * the text sent. The line feed after `<pre>` is the one HTML drops there, so
 * a message that starts with a blank line keeps it.
 */
function plainHtml(value) {
  return `<pre>\n${escapeHtml(value)}</pre>`;
}

/**
 * A message the user sent: its files right-aligned above the bubble with its
 * text, which can be selected and copied as a reply's can. A message of files
 * alone has no bubble. `marked`, when given, makes the text's HTML with
 * Find's matches marked.
 */
function userMessage(row, cx, marked = null) {
  const m = palette(cx);
  const files = row.attachments ?? [];
  const own = ownText(row);
  return v_flex()
    .w_full()
    .pt(16)
    .gap(8)
    .items_end()
    .when(row.pending === true, (el) => el.opacity(0.6))
    .when(files.length > 0, (el) =>
      el.child(
        h_flex()
          .max_w('70%')
          .flex_wrap()
          .justify_end()
          .gap(8)
          .children(files.map((file) => fileChip(file, cx))),
      ),
    )
    .when(own.trim() !== '' || files.length === 0, (el) =>
      el.child(
        typeset(div(), 'reading')
          .max_w('70%')
          .px(18)
          .py(10)
          .rounded(28)
          .bg(m.bubble)
          .text_color(m.ink)
          .child(
            TextView.html(
              marked === null ? `sent-${row.key}` : `sent-${row.key}-found`,
              marked === null ? plainHtml(own) : `<pre>\n${marked(own)}</pre>`,
            ).text_style({
              paragraph_gap: 0,
              foreground: m.ink,
            }),
          ),
      ),
    );
}

/** Why a run stopped, as the Host recorded it; the reason itself is not translated. */
function failureRow(item, cx) {
  const m = palette(cx);
  return h_flex()
    .w_full()
    .gap(8)
    .items_start()
    .child(
      div()
        .flex_none()
        .pt(2)
        .child(icon('status-failed', 14, m.destructive)),
    )
    .child(
      text(t('runError', { value: item.row.text }), 'small', m.ink)
        .flex_1()
        .min_w_0(),
    );
}

/**
 * What a WorkHub notice says: `{ graph, taskId, worker, outcome }`. History
 * gives the message's origin, a task (`taskId`) or a task graph (`graph`,
 * which says the graph has new results). A task's notice text ends with the
 * task as one line of JSON, from which come its worker and its outcome:
 * 'completed', 'failed', 'cancelled', 'rejected', or null when it cannot be
 * read (the text is not all loaded, or its form changed). The text is for
 * the coordinator's model, in the language the Host resolves for it when it
 * is written (workhub/tasks/notifications.rs); the row says it in the
 * user's words.
 */
function workhubNotice(row) {
  const origin = row.origin;
  const ofTask = origin.kind === 'workhub_task';
  const notice = {
    graph: origin.kind === 'workhub_graph',
    taskId: ofTask ? origin.taskId : null,
    worker: null,
    outcome: null,
  };
  if (!ofTask) return notice;
  const at = row.text.lastIndexOf('\n');
  if (at < 0) return notice;
  try {
    const task = JSON.parse(row.text.slice(at + 1));
    const status = task?.status ?? {};
    const work = status.progress ?? {};
    notice.worker = typeof task?.worker === 'string' ? task.worker : null;
    notice.outcome =
      status.kind === 'cancelled' || work.kind === 'cancelled'
        ? 'cancelled'
        : status.kind === 'rejected'
          ? 'rejected'
          : work.kind === 'delivered' &&
              ['completed', 'failed', 'cancelled'].includes(work.execution?.state)
            ? work.execution.state
            : null;
  } catch {
    // Not all of it is loaded; the row says only that a task ended.
  }
  return notice;
}

/**
 * The notice's words by outcome, with a title and without one, its glyph,
 * and whether the glyph is in the destructive color; a task that ended some
 * other way has NOTICE_ENDED's.
 */
const NOTICE_OUTCOMES = {
  completed: ['workhubNoticeCompleted', 'workhubNoticeCompletedUntitled', 'status-done', false],
  failed: ['workhubNoticeFailed', 'workhubNoticeFailedUntitled', 'status-failed', true],
  cancelled: ['workhubNoticeCancelled', 'workhubNoticeCancelledUntitled', 'status-stopped', false],
  rejected: ['workhubNoticeRejected', 'workhubNoticeRejectedUntitled', 'status-failed', true],
};
const NOTICE_ENDED = ['workhubNoticeEnded', 'workhubNoticeEndedUntitled', 'workhub', false];

/** A task graph's notice: its words and glyph, as NOTICE_OUTCOMES gives them. */
const NOTICE_GRAPH = ['workhubNoticeGraph', 'workhubNoticeGraph', 'workhub', false];

/**
 * A WorkHub notice in the coordinator's conversation: which task ended and
 * how, and View, or that a task graph has new results; a click on a task's
 * row shows the task in WorkHub's Tasks tab (`Transcript.click`). The title
 * comes from WorkHub (`hooks.taskTitle`).
 */
function noticeRow(item, transcript, cx) {
  const m = palette(cx);
  const { graph, taskId, outcome } = item.notice;
  const [titled, untitled, glyph, alarm] = graph
    ? NOTICE_GRAPH
    : (NOTICE_OUTCOMES[outcome] ?? NOTICE_ENDED);
  const title = taskId === null ? '' : (transcript.hooks.taskTitle?.(taskId) ?? '');
  const open = taskId !== null && typeof transcript.hooks.openTask === 'function';
  return h_flex()
    .w_full()
    .pt(12)
    .gap(8)
    .items_center()
    .child(icon(glyph, 14, alarm ? m.destructive : m.inkMuted))
    .child(
      text(title === '' ? t(untitled) : t(titled, { title }), 'small', m.inkMuted)
        .min_w_0()
        .truncate(),
    )
    .when(open, (el) =>
      // The list takes the click (`Transcript.click`); the label says what it does.
      el.child(
        typeset(div(), 'smallLabel')
          .flex_none()
          .px(6)
          .rounded(6)
          .cursor_pointer()
          .text_color(m.ink)
          .hover((style) => style.bg(m.wash))
          .child(t('workhubNoticeView')),
      ),
    );
}

/** Where the context was compacted, as the TUI marks it: a rule with the time it took. */
function compactionRow(item, cx) {
  const m = palette(cx);
  const seconds = (item.row.compaction.durationMs / 1000).toFixed(1).replace(/\.0$/, '');
  const rule = () => div().flex_1().h(1).bg(m.border);
  return h_flex()
    .w_full()
    .gap(12)
    .items_center()
    .child(rule())
    .child(text(t('contextCompacted', { seconds }), 'small', m.inkMuted))
    .child(rule());
}

function historyRow(state, transcript, cx) {
  const m = palette(cx);
  const row = h_flex().min_h(32).gap(6).items_center().justify_center();
  switch (state) {
    case 'loading':
      return row
        .child(icon('status-running', 12, m.primary))
        .child(text(t('loadingEarlier'), 'small', m.inkMuted));
    case 'failed':
      return row
        .child(text(t('loadEarlierFailed'), 'small', m.destructive))
        .child(
          typeset(div(), 'smallLabel')
            .px(6)
            .rounded(6)
            .text_color(m.ink)
            .hover((style) => style.bg(m.wash))
            .child(t('retry')),
        )
        .tooltip(transcript.olderError ?? '');
    default:
      return row.child(text(t('beginningOfTask'), 'small', m.inkMuted));
  }
}

function thinkingRow(item, cx) {
  const m = palette(cx);
  const preview = item.row.text.trim().split('\n', 1)[0] ?? '';
  return v_flex()
    .w_full()
    .child(
      h_flex()
        .w_full()
        .h(36)
        .px(12)
        .gap(10)
        .items_center()
        .rounded(10)
        .hover((style) => style.bg(m.hover))
        .child(icon('activity', 16, m.inkMuted))
        .child(
          text(item.streaming ? t('thinking') : t('thought'), 'label', m.ink)
            .flex_none()
            .w(84)
            .when(item.streaming === true, (el) => el.opacity(0.7)),
        )
        .child(
          text(item.open ? '' : preview, 'small', m.inkMuted)
            .flex_1()
            .min_w_0()
            .truncate(),
        )
        .child(icon(item.open ? 'chevron-down' : 'chevron-right', 14, m.inkMuted)),
    )
    .when(item.open, (el) =>
      el.child(text(item.row.text, 'body', m.inkMuted).pl(38).pr(12).pt(2).pb(8)),
    );
}

/**
 * Tools whose display contract the Host names in `call.presentation` (the
 * keys shared with the terminal shell): the
 * message for the label in the name lane, the icon, and the argument the
 * header shows.
 */
const TOOL_KINDS = {
  'maka.workspace.Files@1/readText': ['toolRead', 'tool-read', ['path']],
  'maka.workspace.Files@1/write': ['toolWrite', 'tool-edit', ['path']],
  'maka.workspace.Files@1/edit': ['toolEdit', 'tool-edit', ['path']],
  'maka.workspace.Files@1/applyPatch': ['toolPatch', 'tool-edit', ['operation', 'path']],
  'maka.workspace.Files@1/glob': ['toolGlob', 'tool-search', ['pattern']],
  'maka.workspace.Files@1/grep': ['toolGrep', 'tool-search', ['pattern']],
  'maka.workspace.Processes@1/execute': ['toolRun', 'tool-terminal', ['command']],
  'maka.workspace.Processes@1/read': ['toolOutput', 'tool-terminal', ['ref']],
  'maka.workspace.Processes@1/writeStdin': ['toolInput', 'tool-terminal', ['ref']],
  'maka.workspace.Processes@1/stop': ['toolStop', 'tool-terminal', ['ref']],
};

/**
 * Tools the Host names no contract for that have a name of their own here, by
 * the call's name: the message for the label and the icon. The header's
 * summary is found as for any other call.
 */
const NAMED_TOOLS = {
  workhub_tasks: ['workhubName', 'workhub'],
  // The workspace tools by the names the model calls them, for a call the
  // Host rejected before binding it to its contract (no `presentation`).
  Read: ['toolRead', 'tool-read'],
  Write: ['toolWrite', 'tool-edit'],
  Edit: ['toolEdit', 'tool-edit'],
  ApplyPatch: ['toolPatch', 'tool-edit'],
  Glob: ['toolGlob', 'tool-search'],
  Grep: ['toolGrep', 'tool-search'],
  Shell: ['toolRun', 'tool-terminal'],
};

/** The message that names each state of a tool call (see toolStatus). */
const TOOL_STATES = {
  running: 'toolStateRunning',
  done: 'toolStateDone',
  failed: 'toolStateFailed',
  stopped: 'toolStateStopped',
  notRun: 'toolStateNotRun',
};

/** The longest value a tool row reads whole; past it, the start and the end. */
const WHOLE_BYTES = 64 * 1024;

/** The Processes methods, whose result carries a process's output. */
const PROCESS_METHODS = new Set(['execute', 'read', 'writeStdin', 'stop']);

/** Files methods whose output is one value in the result, and how it reads. */
const OUTPUT_PATHS = {
  readText: [['value', 'content'], 'text'],
  glob: [['value', 'files'], 'lines'],
  grep: [['value', 'matches'], 'lines'],
};

/** What a tool with no named contract does, by its name: the icon its header shows. */
function toolIcon(name) {
  const lower = name.toLowerCase();
  if (/bash|shell|exec|command|terminal|run/.test(lower)) return 'tool-terminal';
  if (/write|edit|patch|replace|create/.test(lower)) return 'tool-edit';
  if (/grep|glob|search|find|^ls$|list/.test(lower)) return 'tool-search';
  if (/web|fetch|http|url|browse/.test(lower)) return 'tool-web';
  if (/read|open|view|cat/.test(lower)) return 'tool-read';
  return 'tool-plug';
}

/**
 * The tool call's state: running, done, failed, stopped or not run, with its
 * icon and color. `reportedFailure` is a result whose own `kind` says it
 * failed. A call the Host rejected never ran (its result is the reason: the
 * input was invalid, policy denied it, another call in the same step had to
 * run alone, ...): the model is told and goes on, so it is not drawn as a
 * failure.
 */
function toolStatus(row, result, reportedFailure, m) {
  if (result !== null) {
    if (result.tool?.result?.settlement === 'rejected')
      return ['notRun', 'status-stopped', m.inkMuted];
    if (
      reportedFailure ||
      result.tool?.result?.isError ||
      result.tool?.result?.settlement === 'failed'
    ) {
      return ['failed', 'status-failed', m.destructive];
    }
    return ['done', 'status-done', m.inkMuted];
  }
  if (row.tool?.call?.pending) return ['running', 'status-running', m.primary];
  return ['stopped', 'status-stopped', m.inkMuted];
}

/** The first line of `value`, or of the first string inside it. */
function firstLine(value) {
  if (typeof value === 'string') return value.trim().split('\n', 1)[0];
  if (value === null || typeof value !== 'object') return '';
  for (const entry of Object.values(value)) {
    const line = firstLine(entry);
    if (line !== '') return line;
  }
  return '';
}

/** `source` parsed as JSON, or undefined when it is cut short or is not JSON. */
function parsed(source) {
  if (!source.complete) return undefined;
  try {
    return JSON.parse(source.text);
  } catch {
    return undefined;
  }
}

/**
 * The header's summary: the call's title when the Host recorded one, else the
 * argument its contract names, else the first line of the first argument.
 */
function toolSummary(tool, kind, transcript) {
  const call = tool?.call;
  if (!call) return '';
  if (call.title) return call.title.fallback;
  const source = transcript.source(call.position, 'arguments', kind?.[2] ?? []);
  if (source === null) return '';
  return kind ? source.text.trim().split('\n', 1)[0] : firstLine(parsed(source) ?? '');
}

/**
 * The parts an opened call's output shows, each `{ label, source, format }`
 * with `source` null while it is read. A contract's result is read by the
 * paths the TUI's tool details read (tool-details/index.ts:241-350): a
 * failure's message, a process's stdout and stderr or screen, a file's
 * content, the files or matches found. Those are plain text however long, so
 * a long one still shows as text. Any other result is read whole.
 */
function outputParts(tool, kind, status, transcript) {
  const position = tool.result.position;
  const read = (path) => transcript.source(position, 'result', path, true);
  const whole = [{ label: null, source: read([]), format: 'result' }];
  if (kind === null) return whole;
  if (status === null) return [{ label: null, source: null, format: 'text' }];
  if (status.failed !== undefined) return whole;
  if (status.text === 'failed') return [{ label: null, source: read(['message']), format: 'text' }];
  if (status.text !== 'completed') return whole;
  const method = tool.call.presentation.split('/').pop();
  if (PROCESS_METHODS.has(method)) {
    // A command started in the background answers before it has any output
    // (tool-details/index.ts:281-292); its output comes with a later call.
    const state = transcript.source(position, 'result', ['value', 'status']);
    if (state === null) return [{ label: null, source: null, format: 'text' }];
    if (
      method === 'execute' &&
      state.failed === undefined &&
      ['starting', 'running'].includes(state.text)
    ) {
      return [{ note: t('runningInBackground') }];
    }
    const mode = transcript.source(position, 'result', ['value', 'output', 'mode']);
    if (mode === null) return [{ label: null, source: null, format: 'text' }];
    const flag = (name) =>
      transcript.source(position, 'result', ['value', 'output', name])?.text === 'true';
    // A stream is captured up to its last 64 KB; the flag says whether
    // earlier output was dropped, and then the stream starts mid-line.
    if (mode.failed === undefined && mode.text === 'pipes') {
      return ['stdout', 'stderr'].map((stream) => {
        const cut = flag(`${stream}Truncated`);
        const label = stream === 'stdout' ? t('outputStdout') : t('outputStderr');
        return {
          label,
          source: read(['value', 'output', stream]),
          format: 'text',
          cut,
          midLine: cut,
        };
      });
    }
    // A terminal's lines above the screen, then the screen, as the TUI shows
    // both. They are whole lines; the flag says some earlier ones are gone.
    if (mode.failed === undefined && mode.text === 'pty') {
      return [
        {
          label: t('outputScrollback'),
          source: read(['value', 'output', 'scrollback']),
          format: 'text',
          cut: flag('truncated'),
        },
        { label: t('outputScreen'), source: read(['value', 'output', 'screen']), format: 'text' },
      ];
    }
    return whole;
  }
  const output = OUTPUT_PATHS[method];
  if (output === undefined) return whole;
  return [{ label: null, source: read(output[0]), format: output[1] }];
}

/**
 * The lines the Host puts before what it kept of a field it cut short
 * (platform/presentation/src/shell/project.rs): a terminal's, a long
 * stream's, and any field's.
 */
const CUT_MARKERS = [
  /^\[terminal snapshot truncated to fit the output limit\]\n/,
  /^\.\.\.\d+ (?:lines|bytes) truncated\. [^\n]*\n\n/,
  /^\[runtime resource field truncated\]\n/,
];

/**
 * A part's text as the output block shows it, `{ text, cut }`, `cut` saying
 * that earlier output was not kept. The Host's own note on a cut it made is
 * left out. Without one, a stream held to its last 64 KB begins mid-line, and
 * that partial first line is left out.
 */
function partText(part) {
  if (part.format === 'result') return { text: resultText(part.source), cut: false };
  if (part.format === 'lines') {
    const value = parsed(part.source);
    if (Array.isArray(value)) {
      const lines = value.map((entry) =>
        typeof entry === 'string' ? entry : JSON.stringify(entry),
      );
      return { text: lines.join('\n'), cut: false };
    }
  }
  const text = bothEnds(part.source);
  for (const marker of CUT_MARKERS) {
    const found = marker.exec(text);
    if (found !== null) return { text: text.slice(found[0].length), cut: true };
  }
  if (part.midLine === true) {
    const newline = text.indexOf('\n');
    return { text: newline >= 0 && newline < 1024 ? text.slice(newline + 1) : text, cut: true };
  }
  return { text, cut: part.cut === true };
}

/**
 * A value as read: whole, or for a long one its start and its end with how
 * much lies between them (the start alone, cut, until the end is read).
 */
function bothEnds(source) {
  if (source.complete) return source.text;
  const tail = source.tail;
  if (!tail) return `${source.text}…`;
  const headBytes = utf8Length(source.text);
  if (tail.offset <= headBytes) return source.text + dropBytes(tail.text, headBytes - tail.offset);
  const gap = t('notShown', { size: byteSize(tail.offset - headBytes) });
  return `${source.text}\n\n${gap}\n\n${tail.text}`;
}

/** `text` without its first `bytes` UTF-8 bytes. */
function dropBytes(text, bytes) {
  let dropped = 0;
  let index = 0;
  for (const point of text) {
    if (dropped >= bytes) break;
    dropped += utf8Length(point);
    index += point.length;
  }
  return text.slice(index);
}

/**
 * What the output block shows for a whole `result` field: a failure's
 * message, a command's output, a file's content, the files or matches found;
 * anything else as indented JSON. One too long to read whole shows as read.
 */
function resultText(source) {
  const result = parsed(source);
  if (result === undefined) return bothEnds(source);
  if (result?.kind === 'failed' && typeof result.message === 'string') return result.message;
  const value = result?.kind === 'completed' ? result.value : result;
  if (typeof value === 'string') return value;
  const output = value?.output;
  if (output?.mode === 'pipes') {
    return [output.stdout, output.stderr]
      .filter((part) => typeof part === 'string' && part !== '')
      .join('\n');
  }
  if (output?.mode === 'pty') return output.screen ?? output.scrollback ?? '';
  if (typeof value?.content === 'string') return value.content;
  const found = value?.files ?? value?.matches;
  if (Array.isArray(found)) {
    return found
      .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .join('\n');
  }
  return JSON.stringify(value, null, 2);
}

/** The arguments as indented JSON, or as read when they are cut short or are not JSON. */
function argumentsText(source) {
  const value = parsed(source);
  if (value === undefined) return bothEnds(source);
  return JSON.stringify(value, null, 2);
}

function toolRow(item, transcript, cx) {
  const m = palette(cx);
  const { row, result } = item;
  const tool = (result ?? row).tool ?? row.tool;
  const kind = TOOL_KINDS[tool?.call?.presentation] ?? null;
  const own =
    kind === null && Object.hasOwn(NAMED_TOOLS, tool?.call?.name ?? '')
      ? NAMED_TOOLS[tool.call.name]
      : null;
  const name =
    kind !== null ? t(kind[0]) : own !== null ? t(own[0]) : (tool?.call?.name ?? t('toolUnnamed'));
  // A contract's result says in its `kind` whether it failed, as the TUI
  // reads it (tool-details/index.ts:257, 268, 325).
  const outcome =
    kind !== null && tool?.result
      ? transcript.source(tool.result.position, 'result', ['kind'])
      : null;
  const [status, statusIcon, statusColor] = toolStatus(row, result, outcome?.text === 'failed', m);
  const summary = toolSummary(tool, kind, transcript);
  // Opened, a call shows its output, after its arguments when the header
  // does not show them: a contract's argument under a title, or all of
  // another call's.
  const parts = [];
  if (item.open && tool?.call && kind === null) {
    parts.push({
      label: null,
      source: transcript.source(tool.call.position, 'arguments', [], true),
      format: 'arguments',
    });
  } else if (item.open && tool?.call?.title) {
    parts.push({
      label: null,
      source: transcript.source(tool.call.position, 'arguments', kind[2], true),
      format: 'text',
    });
  }
  if (item.open && tool?.result) parts.push(...outputParts(tool, kind, outcome, transcript));
  const blocks = parts
    .filter(
      (part) => part.note === undefined && part.source !== null && part.source.failed === undefined,
    )
    .map((part) => {
      const shown =
        part.format === 'arguments'
          ? { text: argumentsText(part.source), cut: false }
          : partText(part);
      return { label: part.label, cut: shown.cut, content: shown.text };
    })
    .filter((block) => block.content.trim() !== '');
  // stdout and stderr (a terminal's scrollback and screen) are named only
  // when both have something.
  const named = blocks.filter((block) => block.label !== null).length > 1;
  const caption = (block) =>
    [named ? block.label : null, block.cut ? t('earlierOutputNotKept') : null]
      .filter((part) => part !== null)
      .join(' · ') || null;
  const note =
    parts.find((part) => part.note !== undefined)?.note ??
    (parts.some((part) => part.source === null)
      ? t('loading')
      : parts.some((part) => part.source?.failed !== undefined)
        ? t('couldNotReadCall')
        : status === 'running'
          ? t('running')
          : t('noOutput'));
  const ring = !(item.first && item.last && !item.open);
  return (
    v_flex()
      .w_full()
      // One ring around the group: each row draws its sides, the first the top
      // edge, the last the bottom one, and the top edge of the others divides.
      .when(ring, (el) =>
        el
          .bg(m.plate)
          .border_x_1()
          .border_t_1()
          .border_color(m.border)
          .when(item.first, (el) => el.rounded_t(12))
          .when(item.last, (el) => el.border_b_1().rounded_b(12)),
      )
      .child(
        h_flex()
          .w_full()
          .h(36)
          .px(12)
          .gap(10)
          .items_center()
          .rounded(ring ? 0 : 10)
          .hover((style) => style.bg(m.hover))
          .child(icon(kind?.[1] ?? own?.[1] ?? toolIcon(name), 16, m.inkMuted))
          .child(text(name, 'label', m.ink).flex_none().min_w(84).max_w(200).truncate())
          .child(
            div()
              .flex_1()
              .min_w_0()
              .truncate()
              .when(tool?.call?.title != null, (el) => typeset(el, 'small'))
              .when(tool?.call?.title == null, (el) =>
                el.text_size(12).line_height('20px').font_family('Menlo'),
              )
              .text_color(m.inkMuted)
              .child(summary),
          )
          .child(tippedIcon(statusIcon, 14, statusColor, t(TOOL_STATES[status])))
          .when(item.open || status === 'failed' || status === 'notRun', (el) =>
            el.child(icon(item.open ? 'chevron-down' : 'chevron-right', 14, m.inkMuted)),
          ),
      )
      .when(item.open, (el) =>
        el.child(
          v_flex()
            .pl(38)
            .pr(12)
            .pt(2)
            .pb(12)
            .gap(8)
            .children(
              blocks.map((block, index) =>
                codeBlock(`${item.key}/output/${index}`, caption(block), block.content, m),
              ),
            )
            .when(blocks.length === 0, (el) => el.child(text(note, 'small', m.inkMuted))),
        ),
      )
  );
}

/**
 * The most of one block a row lays out, as its first and last halves: the
 * whole block is laid out again on every frame the transcript scrolls.
 */
const BLOCK_CHARS = 32 * 1024;

/**
 * Tool input or output: 12/20 mono on the code fill, 256px of text that
 * scrolls with a bar of its own, under an optional label.
 */
function codeBlock(id, label, content, m) {
  const trimmed = content.replace(/\s+$/, '');
  let shown = trimmed;
  if (trimmed.length > BLOCK_CHARS) {
    // The cuts are moved off the middle of a surrogate pair: half of one
    // cannot be turned into the UTF-8 an element's text is.
    let headEnd = BLOCK_CHARS / 2;
    if (lowSurrogate(trimmed, headEnd)) headEnd -= 1;
    let tailStart = trimmed.length - BLOCK_CHARS / 2;
    if (lowSurrogate(trimmed, tailStart)) tailStart += 1;
    const head = trimmed.slice(0, headEnd);
    const tail = trimmed.slice(tailStart);
    const hidden = trimmed.slice(head.length, trimmed.length - tail.length).split('\n').length - 1;
    shown = `${head}\n\n${tn(hidden, 'linesNotShownOne', 'linesNotShownOther')}\n\n${tail}`;
  }
  return v_flex()
    .w_full()
    .gap(4)
    .when(label !== null, (el) => el.child(text(label, 'small', m.inkMuted)))
    .child(
      div()
        .relative()
        .w_full()
        .child(
          div()
            .id(id)
            .w_full()
            .max_h(276)
            .overflow_y_scroll()
            .px(12)
            .py(10)
            .rounded(10)
            .bg(m.code)
            .text_size(12)
            .line_height('20px')
            .font_family('Menlo')
            .text_color(m.ink)
            .child(shown),
        )
        // Placed beside the box rather than with overflow_y_scrollbar, which
        // would leave the box's background and padding on the scrolled
        // content, to scroll away with the text.
        .child(Scrollbar.vertical(id).absolute().inset_0()),
    );
}

/** Whether the UTF-16 unit at `index` is the second half of a surrogate pair. */
function lowSurrogate(text, index) {
  const unit = text.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Below a finished turn, as the native client's footer: how it ended when it
 * did not complete, when, and the copy icon right after when the turn has
 * reply text; in a task's conversation, Fork at the end of the row. A click
 * on Fork forks the task through this turn, anywhere else on the row it
 * copies the reply (list rows take one click handler, see click).
 */
function turnFooter(item, transcript, cx) {
  const m = palette(cx);
  const outcome = { failed: t('failed'), aborted: t('stopped') }[item.finished.outcome] ?? null;
  const copied = transcript.copied === item.key;
  return h_flex()
    .w_full()
    .h(24)
    .gap(4)
    .items_center()
    .when(outcome !== null, (el) =>
      el.child(
        text(outcome, 'small', item.finished.outcome === 'failed' ? m.destructive : m.inkMuted),
      ),
    )
    .child(
      text(
        [outcome !== null ? '·' : null, relativeTime(item.finished.at)].filter(Boolean).join(' '),
        'small',
        m.inkMuted,
      ),
    )
    .when(item.copies, (el) =>
      el.child(
        h_flex()
          .h(24)
          .px(4)
          .gap(4)
          .items_center()
          .rounded(6)
          .hover((style) => style.bg(m.wash))
          .child(icon(copied ? 'check' : 'copy', 14, copied ? m.ink : m.inkMuted))
          .when(copied, (el) => el.child(text(t('copied'), 'small', m.inkMuted))),
      ),
    )
    .when(transcript.forks(), (el) =>
      el.child(div().flex_1()).child(
        h_flex()
          .id(`fork-${item.turnId}`)
          .flex_none()
          .size(FORK_BUTTON)
          .items_center()
          .justify_center()
          .rounded(6)
          .hover((style) => style.bg(m.wash))
          .tooltip(t('forkFromHere'))
          .child(icon('fork', 14, m.inkMuted)),
      ),
    );
}

/**
 * How long ago `at` (ms) was, in words, as the native client's
 * `relative_time` (maka-gpui crates/shared/src/time.rs) says it: "just now",
 * "5 minutes ago", "3 hours ago", "yesterday", "2 days ago" (前天), … and
 * from a week on the date and time.
 */
export function relativeTime(at, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return tn(minutes, 'minutesAgoOne', 'minutesAgoOther');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tn(hours, 'hoursAgoOne', 'hoursAgoOther');
  const days = Math.floor(hours / 24);
  if (days === 1) return t('yesterday');
  if (days === 2) return t('twoDaysAgo');
  if (days < 7) return t('daysAgo', { count: days });
  return absoluteTime(at);
}

/**
 * A date and time as the native client's `absolute_time` writes it:
 * "Sep 18, 2026, 3:04 PM", "2026年9月18日 15:04", "2026年9月18日 下午3:04".
 */
function absoluteTime(at) {
  const date = new Date(at);
  const [year, month, day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  const hour = date.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  const period = hour < 12 ? t('timeAm') : t('timePm');
  switch (language()) {
    case 'zh-CN':
      return `${year}年${month}月${day}日 ${String(hour).padStart(2, '0')}:${minute}`;
    case 'zh-TW':
      return `${year}年${month}月${day}日 ${period}${hour12}:${minute}`;
    default:
      return `${MONTHS[month - 1]} ${day}, ${year}, ${hour12}:${minute} ${period}`;
  }
}
