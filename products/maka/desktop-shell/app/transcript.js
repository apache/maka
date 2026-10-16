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
import { query, subscribe, next, close, log, readHistory } from './host.js';
import { Interactions } from './interactions.js';

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
      if (!this.closed) this.hooks.report(`Earlier messages: ${error.message}`);
    } finally {
      this.loadingOlder = false;
      this.hooks.changed();
    }
    return calls;
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

/** The selected session's pane: header, the measured list, and its scrollbar. */
export function transcriptPane(transcript, loadOlder, cx) {
  const theme = cx.theme();
  // One snapshot of the three arrays for this render; the list's callbacks
  // run during later layouts and must agree with the count given here.
  const { rows, pending, live } = transcript;
  const count = rows.length + pending.length + live.length;
  const rowAt = (index) =>
    index < rows.length
      ? rows[index]
      : index < rows.length + pending.length
        ? pending[index - rows.length]
        : live[index - rows.length - pending.length];
  const id = `transcript-${transcript.id}`;
  return v_flex()
    .flex_1()
    .min_h_0()
    .child(header(transcript, cx))
    .child(
      v_flex()
        .id(`${id}-area`)
        .relative()
        .flex_1()
        .min_h_0()
        .when(transcript.ready && count === 0, (el) =>
          el
            .items_center()
            .justify_center()
            .text_color(theme.colors.muted_foreground)
            .child('No messages yet'),
        )
        .when(!transcript.ready, (el) =>
          el
            .items_center()
            .justify_center()
            .text_color(theme.colors.muted_foreground)
            .child('Loading…'),
        )
        .when(transcript.ready && count > 0, (el) =>
          el
            .child(
              list(
                id,
                count,
                (index) => rowAt(index).key,
                (index, cx) => transcriptRow(rowAt(index), cx),
              )
                // Opens at the newest row and stays there while a reply
                // streams, until the reader scrolls up.
                .with_follow_mode('tail')
                // Reported after the frame, however the range changed: a
                // wheel, a scrollbar drag, or rows that do not fill the view.
                .on_visible_range_change((range, shown) => {
                  log(`transcript: showing ${range.start}..${range.end} of ${shown}`);
                  if (range.start < NEAR_TOP && transcript.before !== null) loadOlder();
                }),
            )
            .child(Scrollbar.vertical(id).absolute().inset_0()),
        ),
    );
}

function header(transcript, cx) {
  const theme = cx.theme();
  const state =
    transcript.interactions.entries.length > 0
      ? 'Needs you'
      : transcript.run
        ? 'Working…'
        : transcript.lastOutcome === 'failed'
          ? 'Last turn failed'
          : null;
  return h_flex()
    .flex_none()
    .px(theme.spacing.xl)
    .py(theme.spacing.md)
    .gap(theme.spacing.md)
    .items_center()
    .border_b_1()
    .border_color(theme.colors.border)
    .child(div().flex_1().min_w_0().truncate().font_weight(600).child(transcript.session.title))
    .when(transcript.loadingOlder, (el) =>
      el.child(
        div()
          .text_sm()
          .text_color(theme.colors.muted_foreground)
          .child('Loading earlier messages…'),
      ),
    )
    .when(state !== null, (el) =>
      el.child(div().text_sm().text_color(theme.colors.muted_foreground).child(state)),
    );
}

/** One row of the transcript list; called from layout for each visible row. */
export function transcriptRow(entry, cx) {
  const theme = cx.theme();
  const body = v_flex().w_full().px(theme.spacing.xl).py(theme.spacing.sm);
  switch (entry.role) {
    case 'user':
      return body.items_end().child(
        div()
          .max_w('80%')
          .px(theme.spacing.md)
          .py(theme.spacing.sm)
          .rounded(theme.radius.lg)
          .bg(theme.colors.secondary)
          .text_color(theme.colors.secondary_foreground)
          .when(entry.pending === true, (el) => el.opacity(0.6))
          .child(entry.text),
      );
    case 'assistant':
      return body.child(TextView.markdown(`md-${entry.key}`, entry.text));
    case 'thinking':
      return body.child(
        div().text_sm().italic().text_color(theme.colors.muted_foreground).child(entry.text),
      );
    case 'tool_call':
    case 'tool_result':
      return body.child(toolLine(entry, cx));
    default:
      return body.child(
        div().text_sm().text_color(theme.colors.muted_foreground).child(entry.text),
      );
  }
}

function toolLine(entry, cx) {
  const theme = cx.theme();
  const tool = entry.tool;
  const name = tool?.call?.name ?? 'Tool';
  const result = tool?.result;
  const status = result
    ? result.isError
      ? 'failed'
      : (result.settlement ?? 'done')
    : tool?.call?.pending
      ? 'running'
      : '';
  const label = entry.role === 'tool_call' ? name : `${name} result`;
  return h_flex()
    .gap(theme.spacing.sm)
    .items_center()
    .px(theme.spacing.md)
    .py(theme.spacing.xs)
    .rounded(theme.radius.md)
    .border_1()
    .border_color(theme.colors.border)
    .text_sm()
    .font_family(theme.typography.mono)
    .text_color(theme.colors.muted_foreground)
    .child(div().text_color(theme.colors.foreground).child(label))
    .when(status !== '', (el) => el.child(div().child(status)))
    .when(entry.text !== '', (el) => el.child(div().min_w_0().truncate().child(entry.text)));
}
