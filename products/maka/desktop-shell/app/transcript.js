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
// Rows. A canonical row is one transcript row and field from `agent.history`
// (key `<sequence>/<field>`); the fragments a page boundary split it into are
// joined back into one row. A live row holds the `delta` text of a part that
// history does not have yet (key `live/<messageId>/<field>`), and a pending
// row is a sent message the history has not recorded yet (key
// `pending/<messageId>`). Row objects are never edited, and each update
// replaces `rows`, `live` or `pending` with a new array, so a render can hand
// the list one consistent snapshot without copying anything.
//
// The flow mirrors the TUI (plugins/agent/agent-screen):
// - observe, then watch from the observed fence, or from just before the
//   first open part so its earlier deltas replay (results.ts:547-564);
// - the tail page at that fence, going back while a page is empty
//   (results.ts:726-737); older pages keep that first fence;
// - facts that change the canonical transcript re-read history after the last
//   loaded row at the newest fence (actions.ts:314-376, results.ts:1080-1087),
//   re-reading the last fragment so its tool and timing metadata refresh;
// - deltas only grow live rows; history replaces them once it has the
//   message (messages.ts:35-122, 186-218).

import { div, list } from 'gpui-kit';
import { v_flex, h_flex, TextView, Scrollbar } from 'gpui-base';
import { query, subscribe, next, close, log, readHistory, readSource } from './host.js';
import { Interactions } from './interactions.js';
import { palette, typeset, text, icon, tippedIcon } from './theme.js';

/** A visible range starting at or above this index counts as "at the top" for paging. */
const NEAR_TOP = 3;
/** How many rows back to look for a tool call when its result arrives. */
const TOOL_PAIR_WINDOW = 64;

const FIELD_ORDER = { thinking: 0, body: 1 };

function rowKey(chunk) {
  return `${chunk.sequence}/${chunk.field}`;
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
    sequence: chunk.sequence,
    field: chunk.field,
    role: chunk.field === 'thinking' ? 'thinking' : chunk.role,
    messageId: chunk.messageId,
    turnId: chunk.turnId,
    tool: chunk.tool,
    timing: chunk.timing ?? null,
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
  return { ...newer, fragments, text: textOf(fragments) };
}

/** Negative when the chunk comes before the row in transcript order. */
function compareToRow(chunk, row) {
  return chunk.sequence - row.sequence || FIELD_ORDER[chunk.field] - FIELD_ORDER[row.field];
}

function partField(textKind) {
  return textKind === 'thinking' ? 'thinking' : 'body';
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
   */
  constructor(session, hooks) {
    this.session = session;
    this.id = session.id;
    this.hooks = hooks;
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
    this.latestKnown = 0;
    this.watchHandle = null;
    this.watchLast = 0;
    /** What the agent is waiting on the user for. */
    this.interactions = new Interactions(this.id, hooks);
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
    /** The list items last built from the rows (see displayItems). */
    this.view = null;
    /**
       * Tool arguments and results read with `agent.source`, by
     * `<sequence>/<field>/<path>`: `{ text, complete }` once read (with
     * `failed` when the read failed), null while it is under way. A
     * conversation page carries tool metadata only.
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

  /** Loads the tail and starts the live updates. */
  async open() {
    const started = Date.now();
    try {
      const observed = await query('agent', 'observe', { sessionId: this.id });
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
      const handle = await subscribe('agent', 'watch', { sessionId: this.id, after });
      if (this.closed) {
        await close(handle);
        return;
      }
      this.watchHandle = handle;
      this.watchLast = after;
      this.interactions.refresh();
      const fence = observed.through;
      let position = { kind: 'tail' };
      for (;;) {
        const { page, calls } = await readHistory(this.historyInput(fence, position));
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
          `(${this.stats.tailCalls} history call(s), fence ${fence}, older ${this.before ? 'available' : 'none'})`,
      );
      this.hooks.changed();
      // Facts after the observed fence arrive on the first pages; any that
      // change the transcript read history after the tail just loaded.
      this.watch(handle);
    } catch (error) {
      if (!this.closed) this.hooks.report(`Transcript: ${error.message}`);
    }
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
      if (!this.closed) this.hooks.report('Live updates for this session ended');
    } catch (error) {
      if (!this.closed) this.hooks.report(`Live updates: ${error.message}`);
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
          canonicalChanged = true;
          break;
        case 'ended':
          this.closeLive(event.sequence, event.invocationId);
          this.parts = this.parts.filter((open) => open.invocationId !== event.invocationId);
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
    const key = `live/${covered}`;
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
      const observed = await query('agent', 'observe', { sessionId: this.id });
      if (this.closed) return;
      this.acceptObservation(observed);
      this.hooks.changed();
    } catch (error) {
      if (!this.closed) this.hooks.report(`Session state: ${error.message}`);
    }
  }

  acceptObservation(observed) {
    this.latestKnown = Math.max(this.latestKnown, observed.through);
    // The model the TUI would send with: the session's own, else the one the owner remembers.
    this.backend = observed.session.backend ?? observed.rememberedBackend ?? null;
    if (observed.through >= this.runThrough) {
      this.run = observed.run ?? null;
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
        let through = 0;
        for (;;) {
          const { page } = await readHistory(this.historyInput(fence, position));
          through = page.through;
          if (this.closed) return;
          if (this.rows.length === 0 && this.before === null && position.kind === 'tail') {
            this.olderFence = page.through;
            this.before = page.before;
          }
          this.append(page.chunks);
          this.after = page.after;
          if (page.after === null) break;
          position = { kind: 'after', cursor: page.after };
        }
        // History through `through` is read to its end. Text it now holds, and
        // text whose step closed by then without reaching history, is no longer
        // live (results.ts history case).
        this.live = this.live.filter(
          (row) =>
            !this.covered.has(row.covered) &&
            (row.sequence > through || row.closedAt === null || row.closedAt > through),
        );
        this.pending = this.pending.filter((row) => !this.covered.has(row.covered));
        this.hooks.changed();
      } while (this.followAgain && !this.closed);
    } catch (error) {
      if (!this.closed) this.hooks.report(`Transcript: ${error.message}`);
    } finally {
      this.following = false;
    }
  }

  afterPosition() {
    if (this.after !== null) return { kind: 'after', cursor: this.after };
    const last = this.rows.at(-1);
    if (!last) return { kind: 'tail' };
    const fragment = last.fragments[last.fragments.length - 1];
    return {
      kind: 'after',
      cursor: { sequence: last.sequence, field: last.field, offset: fragment.offset },
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
    if (!call || !chunk.tool.result || call.sequence === chunk.sequence) return;
    const floor = Math.max(0, rows.length - TOOL_PAIR_WINDOW);
    for (let index = rows.length - 1; index >= floor; index -= 1) {
      if (rows[index].sequence === call.sequence && rows[index].role === 'tool_call') {
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
        const read = await readHistory(this.historyInput(this.olderFence, position));
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
        this.hooks.report(`Earlier messages: ${error.message}`);
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
    if (item?.kind !== 'thinking' && item?.kind !== 'tool') return;
    if (!this.expanded.delete(key)) this.expanded.add(key);
    this.expandedVersion += 1;
    this.hooks.changed();
  }

  /**
   * The start of a tool row's `arguments` or `result`, or of the value at
   * `path` in it, as `{ text, complete, failed? }`; null until it has been read. The
   * first ask starts the read and the transcript changes when it lands. Rows
   * never change, so a read is kept for as long as the transcript.
   */
  source(sequence, field, path = []) {
    const key = `${sequence}/${field}/${path.join('/')}`;
    if (this.sources.has(key)) return this.sources.get(key);
    this.sources.set(key, null);
    readSource({
      sessionId: this.id,
      // An event fence, not a row position: every loaded row is at or below it.
      through: this.latestKnown,
      source: { kind: 'sequence', sequence },
      field,
      path: path.length > 0 ? path : null,
      position: { kind: 'start' },
    }).then(
      (source) => {
        const complete = source.offset === 0 && utf8Length(source.text) === source.totalBytes;
        this.sources.set(key, { text: source.text, complete });
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

  /** Shows a sent message until history records it. */
  addPending(messageId, text) {
    const covered = `${messageId}/body`;
    if (this.covered.has(covered)) return;
    this.pending = [
      ...this.pending,
      { key: `pending/${messageId}`, role: 'user', covered, pending: true, text },
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
  // A result goes with the call the Host paired it with (`tool.call.sequence`);
  // tool use ids are only unique within a step.
  const calls = new Set();
  const results = new Map();
  const timings = new Map();
  for (const row of rows) {
    if (row.role === 'tool_call') calls.add(row.sequence);
    const call = row.tool?.call?.sequence;
    if (row.role === 'tool_result' && call !== undefined) results.set(call, row);
    if (row.timing) timings.set(row.turnId, row.timing);
  }
  /** @type {any[]} */
  const items = [];
  if (history !== null) items.push({ key: 'history', kind: 'history', state: history });
  rows.forEach((row, index) => {
    if (row.role === 'tool_result' && calls.has(row.tool?.call?.sequence)) {
      // Drawn with its call.
    } else if (row.role === 'tool_call' || row.role === 'tool_result') {
      const result = row.role === 'tool_call' ? (results.get(row.sequence) ?? null) : row;
      items.push({ key: row.key, kind: 'tool', row, result, open: transcript.expanded.has(row.key) });
    } else if (row.role === 'thinking') {
      items.push({ key: row.key, kind: 'thinking', row, open: transcript.expanded.has(row.key) });
    } else {
      items.push({ key: row.key, kind: row.role === 'user' ? 'user' : 'assistant', row });
    }
    const next = rows[index + 1];
    const finished = timings.get(row.turnId)?.finished ?? null;
    if ((next === undefined || next.turnId !== row.turnId) && finished !== null) {
      items.push({ key: `footer/${row.turnId}`, kind: 'footer', turnId: row.turnId, finished });
    }
  });
  for (const row of pending) items.push({ key: row.key, kind: 'user', row });
  for (const row of live) {
    items.push(
      row.role === 'thinking'
        ? { key: row.key, kind: 'thinking', row, open: transcript.expanded.has(row.key), streaming: true }
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

/** The selected task's transcript: the measured list in the reading column, and its scrollbar. */
export function transcriptPane(transcript, loadOlder, cx) {
  const m = palette(cx);
  // One snapshot for this render; the list's callbacks run during later
  // layouts and must agree with the count given here.
  const items = displayItems(transcript);
  const hasRows = transcript.rows.length + transcript.pending.length + transcript.live.length > 0;
  const id = `transcript-${transcript.id}`;
  return v_flex()
    .id(`${id}-area`)
    .relative()
    .flex_1()
    .min_h_0()
    .when(!transcript.ready || !hasRows, (el) =>
      el
        .items_center()
        .justify_center()
        .child(text(transcript.ready ? 'No messages yet' : 'Loading…', 'body', m.inkMuted)),
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
            // streams, until the reader scrolls up.
            .with_follow_mode('tail')
            // Reported after the frame, however the range changed: a
            // wheel, a scrollbar drag, or rows that do not fill the view.
            .on_visible_range_change((range, shown) => {
              log(`transcript: showing ${range.start}..${range.end} of ${shown}`);
              if (range.start < NEAR_TOP && transcript.before !== null) loadOlder();
            })
            .on_item_click((key, cx) => transcript.click(key, cx)),
        )
        .child(Scrollbar.vertical(id).absolute().inset_0()),
    );
}

/** One item of the transcript list, in the reading column; called from layout for each visible item. */
function transcriptItem(item, transcript, cx) {
  return h_flex()
    .w_full()
    .px(24)
    .justify_center()
    .child(
      v_flex()
        .w_full()
        .max_w(720)
        .pb(item.gap)
        .child(itemBody(item, transcript, cx)),
    );
}

function itemBody(item, transcript, cx) {
  const m = palette(cx);
  switch (item.kind) {
    case 'history':
      return historyRow(item.state, transcript, cx);
    case 'user':
      return h_flex()
        .w_full()
        .pt(16)
        .justify_end()
        .child(
          typeset(div(), 'reading')
            .max_w('70%')
            .px(18)
            .py(10)
            .rounded(28)
            .bg(m.bubble)
            .text_color(m.ink)
            .when(item.row.pending === true, (el) => el.opacity(0.6))
            .child(item.row.text),
        );
    case 'assistant':
      return typeset(div(), 'reading')
        .w_full()
        .text_color(m.ink)
        .child(TextView.markdown(`md-${item.key}`, item.row.text));
    case 'thinking':
      return thinkingRow(item, cx);
    case 'tool':
      return toolRow(item, transcript, cx);
    case 'footer':
      return turnFooter(item, transcript, cx);
    case 'working':
      return h_flex()
        .h(24)
        .gap(4)
        .items_center()
        .child(icon('status-running', 12, m.primary))
        .child(text('Working…', 'small', m.inkMuted));
    default:
      return div();
  }
}

function historyRow(state, transcript, cx) {
  const m = palette(cx);
  const row = h_flex().min_h(32).gap(6).items_center().justify_center();
  switch (state) {
    case 'loading':
      return row
        .child(icon('status-running', 12, m.primary))
        .child(text('Loading earlier messages', 'small', m.inkMuted));
    case 'failed':
      return row
        .child(text('Couldn’t load earlier messages.', 'small', m.destructive))
        .child(
          typeset(div(), 'smallLabel')
            .px(6)
            .rounded(6)
            .text_color(m.ink)
            .hover((style) => style.bg(m.wash))
            .child('Retry'),
        )
        .tooltip(transcript.olderError ?? '');
    default:
      return row.child(text('Beginning of task', 'small', m.inkMuted));
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
          text(item.streaming ? 'Thinking…' : 'Thought', 'label', m.ink)
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
      el.child(
        text(item.row.text, 'body', m.inkMuted).pl(38).pr(12).pt(2).pb(8),
      ),
    );
}

/**
 * Tools whose display contract the Host names in `call.presentation` (the
 * keys the TUI reads, plugins/agent/tool-details/index.ts:48-78): the label
 * in the name lane, the icon, and the argument the header shows.
 */
const TOOL_KINDS = {
  'maka.workspace.Files@1/readText': ['Read', 'tool-read', ['path']],
  'maka.workspace.Files@1/write': ['Write', 'tool-edit', ['path']],
  'maka.workspace.Files@1/edit': ['Edit', 'tool-edit', ['path']],
  'maka.workspace.Files@1/applyPatch': ['Patch', 'tool-edit', ['operation', 'path']],
  'maka.workspace.Files@1/glob': ['Glob', 'tool-search', ['pattern']],
  'maka.workspace.Files@1/grep': ['Grep', 'tool-search', ['pattern']],
  'maka.workspace.Processes@1/execute': ['Run', 'tool-terminal', ['command']],
  'maka.workspace.Processes@1/read': ['Output', 'tool-terminal', ['ref']],
  'maka.workspace.Processes@1/writeStdin': ['Input', 'tool-terminal', ['ref']],
  'maka.workspace.Processes@1/stop': ['Stop', 'tool-terminal', ['ref']],
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
 * The tool call's state: running, done, failed or stopped, with its icon and
 * color. `reportedFailure` is a result whose own `kind` says it failed.
 */
function toolStatus(row, result, reportedFailure, m) {
  if (result !== null) {
    if (
      reportedFailure ||
      result.tool?.result?.isError ||
      result.tool?.result?.settlement === 'failed'
    ) {
      return ['failed', 'status-failed', m.destructive];
    }
    if (result.tool?.result?.settlement === 'rejected') return ['stopped', 'status-stopped', m.inkMuted];
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
  const source = transcript.source(call.sequence, 'arguments', kind?.[2] ?? []);
  if (source === null) return '';
  return kind ? source.text.trim().split('\n', 1)[0] : firstLine(parsed(source) ?? '');
}

/**
 * What the output block shows for a whole `result` field, read the way the
 * TUI's tool details read their parts (tool-details/index.ts:241-350): a
 * failure's message, a command's output, a file's content, the files or
 * matches found; anything else as indented JSON.
 */
function resultText(source) {
  const result = parsed(source);
  if (result === undefined) return source.complete ? source.text : `${source.text}…`;
  if (result?.kind === 'failed' && typeof result.message === 'string') return result.message;
  const value = result?.kind === 'completed' ? result.value : result;
  if (typeof value === 'string') return value;
  const output = value?.output;
  if (output?.mode === 'pipes') {
    return [output.stdout, output.stderr].filter((part) => typeof part === 'string' && part !== '').join('\n');
  }
  if (output?.mode === 'pty') return output.screen ?? output.scrollback ?? '';
  if (typeof value?.content === 'string') return value.content;
  const found = value?.files ?? value?.matches;
  if (Array.isArray(found)) {
    return found.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n');
  }
  return JSON.stringify(value, null, 2);
}

/** The arguments as indented JSON, or as read when they are cut short or are not JSON. */
function argumentsText(source) {
  const value = parsed(source);
  if (value === undefined) return source.complete ? source.text : `${source.text}…`;
  return JSON.stringify(value, null, 2);
}

function toolRow(item, transcript, cx) {
  const m = palette(cx);
  const { row, result } = item;
  const tool = (result ?? row).tool ?? row.tool;
  const kind = TOOL_KINDS[tool?.call?.presentation] ?? null;
  const name = kind?.[0] ?? tool?.call?.name ?? 'Tool';
  // A contract's result says in its `kind` whether it failed, as the TUI
  // reads it (tool-details/index.ts:257, 268, 325).
  const outcome =
    kind !== null && tool?.result ? transcript.source(tool.result.sequence, 'result', ['kind']) : null;
  const [status, statusIcon, statusColor] = toolStatus(row, result, outcome?.text === 'failed', m);
  const summary = toolSummary(tool, kind, transcript);
  // Opened, a call shows its output, after its arguments when the header
  // does not show them: a contract's argument under a title, or all of
  // another call's.
  const reads = [];
  if (item.open && tool?.call && kind === null) {
    reads.push(['arguments', transcript.source(tool.call.sequence, 'arguments')]);
  } else if (item.open && tool?.call?.title) {
    reads.push(['argument', transcript.source(tool.call.sequence, 'arguments', kind[2])]);
  }
  if (item.open && tool?.result) reads.push(['result', transcript.source(tool.result.sequence, 'result')]);
  const blocks = reads
    .filter(([, source]) => source !== null && source.failed === undefined)
    .map(([field, source]) =>
      field === 'result'
        ? resultText(source)
        : field === 'arguments'
          ? argumentsText(source)
          : `${source.text}${source.complete ? '' : '…'}`,
    )
    .filter((content) => content.trim() !== '');
  const note = reads.some(([, source]) => source === null)
    ? 'Loading…'
    : reads.some(([, source]) => source.failed !== undefined)
      ? 'Could not read this call'
      : status === 'running'
        ? 'Running…'
        : 'No output';
  const ring = !(item.first && item.last && !item.open);
  return v_flex()
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
        .child(icon(kind?.[1] ?? toolIcon(name), 16, m.inkMuted))
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
        .child(tippedIcon(statusIcon, 14, statusColor, status))
        .when(item.open || status === 'failed', (el) =>
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
          .children(blocks.map((content) => codeBlock(content, m)))
          .when(blocks.length === 0, (el) => el.child(text(note, 'small', m.inkMuted))),
      ),
    );
}

/** Tool input or output: 12/20 mono on the code fill, cut at 256px. */
function codeBlock(content, m) {
  return div()
    .w_full()
    .max_h(276)
    .overflow_hidden()
    .px(12)
    .py(10)
    .rounded(10)
    .bg(m.code)
    .text_size(12)
    .line_height('20px')
    .font_family('Menlo')
    .text_color(m.ink)
    .child(content.length > 4000 ? `${content.slice(0, 4000)}…` : content);
}

function turnFooter(item, transcript, cx) {
  const m = palette(cx);
  const outcome = { failed: 'Failed', aborted: 'Stopped' }[item.finished.outcome] ?? null;
  const copied = transcript.copied === item.key;
  return h_flex()
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
    .child(div().flex_1())
    .child(
      typeset(div(), 'small')
        .px(6)
        .rounded(6)
        .text_color(m.inkMuted)
        .hover((style) => style.bg(m.wash).text_color(m.ink))
        .child(copied ? 'Copied' : 'Copy'),
    );
}

/** How long ago `at` (ms) was, in words: "just now", "5 minutes ago", "3 hours ago", … */
export function relativeTime(at, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
