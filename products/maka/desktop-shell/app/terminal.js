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

// The Workbar's Terminal tool: the conversation's terminals, the PTYs the
// agent started in the background and shells started here, one shown at a
// time in `maka-desktop`'s native Terminal. The Host's `terminal` endpoint
// (WorkHub's conversation: `coordinatorTerminal`) answers every call with an
// outcome, `{ kind: 'completed', value }` or `{ kind: 'failed', message }`.
//
// The tabs follow `watchList`, which lists the terminals again on every
// change to one, its output included: a page each time a shell prints. Every
// page is pulled as it comes, only the latest is kept, and it is applied at
// most every LIST_PACE ms; the tool is redrawn only when what the tabs show
// changed. The terminal shown is painted, then followed
// with `watchOutput`: when the Host still holds its output from the start,
// it is replayed from there; otherwise the Host's screen (`read`) is painted
// and the output followed from where that screen is. The Host's ring holds
// only its last 8 events and `read` carries no output sequence, so the
// output since a `gap` cannot be joined exactly: the output is walked with
// `readOutput` to the newest event first, then the screen is read and
// painted, then the output is followed from that event. Only what arrived
// between the walk and the read can show twice. The output goes to the
// native component as the Host's base64, unread here.
//
// Typing or a paste in the terminal acquires its controller (`acquire`), and
// in a shell started here a press does too; input then goes in `control`
// calls with consecutive sequences, at most 64 actions each and one at a
// time. A shell started here also gets the grid the element holds as the
// PTY's size. The agent's terminals are taken only by typing, keep the size
// the agent gave them, and say so while held, with Release: holding one keeps
// the agent from typing into it. The controller is released when the
// terminal hides, another is selected, the Workbar closes or the
// conversation changes. The Host offers no takeover: while another client
// holds a terminal it is view only, with the Host's reason, and Try again
// where asking again can help.
// Everything the tool opened (watches, acquire subscriptions, controllers)
// closes when it hides; the terminals' screens stay, to show at once when it
// shows again, until the conversation changes.

import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { Buffer } from 'buffer';
import { TerminalState, Terminal } from 'maka-desktop';
import { query, subscribe, next, close, operation, log } from './host.js';
import {
  palette,
  terminalColors,
  typeset,
  text,
  icon,
  ghostButton,
  iconButton,
  controlButton,
} from './theme.js';
import { t } from './locale.js';

/** The most actions in one `control` call (the Host's limit). */
const MAX_ACTIONS = 64;

/** The most text in one `control` call: the Host takes 32 KiB a call. */
const MAX_TEXT_BYTES = 24 * 1024;

/** The most `readOutput` steps a walk to the newest event takes: the ring holds 8. */
const WALK_LIMIT = 32;

/** The size a shell starts at before any terminal has measured its pane. */
const DEFAULT_GRID = { cols: 80, rows: 24 };

/**
 * The wait before following again after a `gap`, in ms: none after the
 * first, then from `first` doubling up to `max` while each comes within
 * `quiet` of following again, and none again after `quiet` without one.
 */
const BACKOFF = { first: 100, max: 500, quiet: 2000 };

/**
 * The least time between two listings applied, in ms. The Host lists the
 * terminals again whenever one prints, so a busy shell would otherwise have
 * the list sorted and compared hundreds of times a second. Pages are still
 * pulled as they come: the Host holds the next back until the last is
 * pulled, so pulling at this pace left the tabs seconds behind.
 */
const LIST_PACE = 150;

/** How long a shell started here stays selected before a page lists it, in ms. */
const START_LISTED = 5000;

/** The Host's refusal while another client holds the controller (its controller.rs). */
const TAKEN = 'Terminal already has a connected controller';

/**
 * The Host's refusals that asking again can get past: the controller free
 * again, the terminal ready, or a call cut short made again. Any other (an
 * archived Session, a PTY started under other permissions, one that ended)
 * stays until the terminal is shown again.
 */
const PASSING = new Set([
  TAKEN,
  'Terminal is not ready',
  'Terminal acquire cancelled',
  'Terminal input cancelled before admission',
  'Terminal controller is not held by this caller',
  'Terminal controller is held by another caller or subscription',
  'Terminal controller subscription ended',
  'Controller sequence is out of order',
]);

/** A refusal as the notice says it: the Host's words, but the tool's for another controller. */
function refusalOf(message, retry = PASSING.has(message)) {
  return { text: message === TAKEN ? t('terminalTaken') : message, retry };
}

/** The subscriptions open now, every conversation's. */
const SUBSCRIPTIONS = new Set();

/** How many terminal subscriptions are open (watches and acquires), for the dev driver. */
export function openTerminalSubscriptions() {
  return SUBSCRIPTIONS.size;
}

/**
 * Closed TerminalStates, to use again. A state lives as long as the
 * application, so a conversation that leaves closes its terminals' states
 * (their emulators and scrollback go) and the next one takes them from here.
 */
const POOL = [];

function takeState() {
  return POOL.pop() ?? TerminalState();
}

function giveBack(state) {
  state.close();
  POOL.push(state);
}

/** The value of a terminal method's outcome; a failure throws its message. */
function unwrap(outcome) {
  if (outcome?.kind === 'completed') return outcome.value;
  throw new Error(outcome?.message ?? `unexpected answer ${JSON.stringify(outcome).slice(0, 200)}`);
}

function untrack(handle) {
  if (handle === null) return;
  close(handle)
    .catch(() => {})
    .finally(() => SUBSCRIPTIONS.delete(handle));
}

/** Milliseconds, as finely as the engine tells them. */
const now = typeof globalThis.performance?.now === 'function' ? () => performance.now() : Date.now;

const RUNNING = new Set(['starting', 'running']);
const FAILED = new Set(['failed', 'timed_out', 'orphaned']);

/**
 * One terminal: its resource as last listed, the TerminalState it shows in
 * while it has one, how far its output has been applied, and its
 * controller.
 */
class Term {
  constructor(owner, entry) {
    this.owner = owner;
    this.ref = entry.result.ref;
    /** The ResourceUpdate as last listed or read. */
    this.entry = entry;
    this.state = null;
    /** The last output sequence applied to `state`, and whether it has been painted at all. */
    this.after = 0;
    this.painted = false;
    /** A pipes run's output as last painted: the listed resource carries none. */
    this.pipes = null;
    /** The PTY's size as `state` has it, and the grid the element holds. */
    this.size = null;
    this.grid = null;
    /** Whether the element shows the bottom of the output. */
    this.atBottom = true;
    /** 'idle', 'loading', 'live', 'ended' (closed), 'unavailable' (not retained) or 'failed'. */
    this.live = 'idle';
    this.problem = null;
    /** The output follow running now: `{ closed, handle }`, or null. */
    this.follow = null;
    /** When the output was last followed again after a gap, and the wait before the next. */
    this.followedAt = 0;
    this.backoff = 0;
    /** The controller: `{ handle, closed, held, controllerId, next }`, or null. */
    this.lease = null;
    /** 'none', 'acquiring', 'held', or 'refused' (view only, `refusal` says why). */
    this.control = 'none';
    /** Why it is view only: `{ text, retry }`, retry when asking again can help. */
    this.refusal = null;
    /** Actions waiting for the controller or for the call before them. */
    this.queue = [];
    this.sending = false;
    /** The size last asked of the PTY while held. */
    this.sentSize = null;
    /** The script's share of following the output, for the dev driver. */
    this.stats = { events: 0, bytes: 0, ms: 0, gaps: 0, recoveries: 0, recoverMs: 0, waited: 0 };
  }

  target() {
    return { sessionId: this.owner.sessionId, ref: this.ref };
  }

  get endpoint() {
    return this.owner.endpoint;
  }

  mode() {
    return this.entry.result.mode;
  }

  running() {
    return RUNNING.has(this.entry.result.status);
  }

  /** Started by the agent's Shell, not by `start`: a shell started here is its own source. */
  agents() {
    return this.entry.sourceTurnId !== this.entry.sourceToolCallId;
  }

  /** Whether this conversation owns it; one shared from another is read only. */
  local() {
    return this.entry.ownership?.kind === 'local';
  }

  /** Whether typing here may reach it. */
  controllable() {
    return this.mode() === 'pty' && this.running() && this.local();
  }

  update(entry) {
    this.entry = entry;
    // An ended process takes its controller with it.
    if (!this.running() && this.control === 'refused') this.control = 'none';
  }

  touch() {
    this.owner.touch();
  }

  /** Starts showing: paints and follows the output. Called while it is selected and the tool shows. */
  show() {
    if (this.follow !== null || this.owner.closed) return;
    if (this.live === 'failed') {
      this.live = 'idle';
      this.problem = null;
    }
    if (this.state === null) {
      this.state = takeState();
      this.after = 0;
      this.painted = false;
      this.size = null;
      this.atBottom = true;
    }
    const run = { closed: false, handle: null };
    this.follow = run;
    if (this.mode() === 'pty') this.followPty(run);
    else this.followPipes(run);
  }

  /** Stops following and releases the controller; the screen stays. */
  hide() {
    const run = this.follow;
    if (run !== null) {
      this.follow = null;
      run.closed = true;
      untrack(run.handle);
      run.handle = null;
    }
    this.release();
    if (this.control === 'refused') this.control = 'none';
  }

  /** Lets the screen go too: the conversation is leaving. */
  dispose() {
    this.hide();
    if (this.state !== null) {
      giveBack(this.state);
      this.state = null;
    }
  }

  /**
   * Paints and follows a PTY's output until hidden, or until it ends
   * (`closed`), the Host lets its output go (`unavailable`) or a call fails.
   */
  async followPty(run) {
    try {
      let after = this.after;
      if (!this.painted) {
        this.live = 'loading';
        const first = unwrap(
          await query(this.endpoint, 'readOutput', { target: this.target(), after: 0 }),
        );
        if (run.closed) return;
        if (first.kind === 'gap') {
          after = await this.recover(run, first.firstAvailable - 1);
          if (after === null) return;
        } else if (first.kind === 'unavailable') {
          await this.paintRead(run);
          if (run.closed) return;
          this.live = 'unavailable';
          this.touch();
          return;
        } else {
          // Everything it wrote is still held: replay it from an empty screen.
          const size = first.size ?? DEFAULT_GRID;
          this.state.reset(size.cols, size.rows);
          this.size = size;
          this.after = 0;
          this.painted = true;
          after = 0;
        }
      }
      for (;;) {
        const handle = await subscribe(this.endpoint, 'watchOutput', {
          target: this.target(),
          after,
        });
        if (run.closed) {
          close(handle).catch(() => {});
          return;
        }
        run.handle = handle;
        SUBSCRIPTIONS.add(handle);
        if (this.live !== 'live') {
          this.live = 'live';
          this.touch();
        }
        let end = null;
        for (;;) {
          const item = await next(handle);
          if (run.closed) return;
          if (item === null) {
            end = { kind: 'finished' };
            break;
          }
          const started = now();
          const event = unwrap(item);
          if (event.kind === 'data') {
            this.apply(event);
            this.stats.events += 1;
            this.stats.bytes += event.dataBase64.length;
            this.stats.ms += now() - started;
          } else if (event.kind === 'resize') {
            this.resizeTo(event.size);
            this.after = event.sequence;
          } else if (event.kind === 'pending') {
            this.resizeTo(event.size);
          } else {
            end = event;
            break;
          }
        }
        run.handle = null;
        untrack(handle);
        if (end.kind === 'gap') {
          this.stats.gaps += 1;
          await this.pause(run);
          if (run.closed) return;
          after = await this.recover(run, end.firstAvailable - 1);
          if (after === null) return;
          continue;
        }
        if (end.kind === 'closed') {
          this.resizeTo(end.size);
          this.live = 'ended';
        } else if (end.kind === 'unavailable') {
          if (!this.painted) await this.paintRead(run);
          if (run.closed) return;
          this.live = 'unavailable';
        } else {
          // The Host ended the watch without saying why.
          this.failed(t('terminalWatchEnded'));
        }
        log(`terminal: ${this.ref} output ${this.live} after ${this.after}`);
        this.touch();
        return;
      }
    } catch (error) {
      if (run.closed) return;
      log(`terminal: following ${this.ref} failed: ${error.message}`);
      this.failed(error.message);
    } finally {
      if (run.handle !== null) {
        untrack(run.handle);
        run.handle = null;
      }
      if (this.follow === run && this.live !== 'live' && this.live !== 'loading') {
        this.follow = null;
      }
    }
  }

  /**
   * Following the output failed (its watch, or a read to join it again):
   * says so, with Retry, and releases the controller. Input is not taken
   * while the output is not followed, so a held controller would only keep
   * the agent from typing into its own terminal; after Retry, typing takes
   * it again.
   */
  failed(message) {
    this.live = 'failed';
    this.problem = message;
    this.release();
    this.touch();
  }

  /** One `data` event: at the PTY's size it was written at, after everything before it. */
  apply(event) {
    if (event.sequence <= this.after) return;
    this.resizeTo(event.size);
    this.state.feed(event.dataBase64);
    this.after = event.sequence;
  }

  resizeTo(size) {
    if (size === undefined || size === null) return;
    if (this.size?.cols === size.cols && this.size?.rows === size.rows) return;
    this.size = { cols: size.cols, rows: size.rows };
    this.state.resize(size.cols, size.rows);
  }

  /**
   * After a gap that came soon after following again, waits a little longer
   * each time (up to BACKOFF.max, and there while gaps keep coming): output
   * faster than it can be followed is shown as the Host's screen every so
   * often instead of one recovery after another. The time is counted from
   * following again, so neither the wait nor the recovery counts as quiet.
   */
  async pause(run) {
    const quiet = Date.now() - this.followedAt >= BACKOFF.quiet;
    this.backoff = quiet ? 0 : Math.min(BACKOFF.max, Math.max(BACKOFF.first, this.backoff * 2));
    if (this.backoff > 0 && !run.closed) {
      this.stats.waited += this.backoff;
      await this.owner.cx.sleep(this.backoff);
    }
  }

  /**
   * Joins the output again after a gap (or on first showing one whose start
   * is gone): walks `readOutput` from `from` to the newest event, then
   * paints the Host's screen, and returns the sequence to follow from; null
   * when hidden meanwhile. A walk that does not reach the newest event
   * (output faster than the walk) follows from where it stopped.
   */
  async recover(run, from) {
    const started = now();
    let after = from;
    for (let step = 0; step < WALK_LIMIT; step += 1) {
      const event = unwrap(
        await query(this.endpoint, 'readOutput', { target: this.target(), after }),
      );
      if (run.closed) return null;
      if (event.kind === 'data' || event.kind === 'resize') after = event.sequence;
      else if (event.kind === 'gap') after = event.firstAvailable - 1;
      else break;
    }
    await this.paintRead(run);
    if (run.closed) return null;
    this.after = after;
    this.followedAt = Date.now();
    this.stats.recoveries += 1;
    this.stats.recoverMs += now() - started;
    log(`terminal: ${this.ref} painted from the Host's screen; following from ${after}`);
    return after;
  }

  /** Paints the Host's screen of it (`read`). */
  async paintRead(run) {
    const resource = unwrap(await query(this.endpoint, 'read', this.target()));
    if (run.closed) return;
    this.update(resource);
    const output = resource.result.output;
    if (output?.mode !== 'pty') return;
    this.state.paint(output);
    this.size = { cols: output.cols, rows: output.rows };
    this.painted = true;
  }

  /**
   * A background run without a PTY: its output as the Host keeps it, the
   * tail of stdout and stderr, painted again on each change (`watch`).
   */
  async followPipes(run) {
    try {
      const handle = await subscribe(this.endpoint, 'watch', this.target());
      if (run.closed) {
        close(handle).catch(() => {});
        return;
      }
      run.handle = handle;
      SUBSCRIPTIONS.add(handle);
      this.live = 'live';
      for (;;) {
        const item = await next(handle);
        if (run.closed) return;
        if (item === null) break;
        const resource = unwrap(item);
        this.update(resource);
        this.paintPipes(resource.result.output);
        this.touch();
      }
      this.live = 'ended';
      this.touch();
    } catch (error) {
      if (run.closed) return;
      this.failed(error.message);
    } finally {
      if (run.handle !== null) {
        untrack(run.handle);
        run.handle = null;
      }
      if (this.follow === run) this.follow = null;
    }
  }

  paintPipes(output) {
    if (output?.mode !== 'pipes') return;
    this.pipes = output;
    const grid = this.grid ?? this.owner.grid ?? DEFAULT_GRID;
    const lines = [output.stdout ?? '', output.stderr ?? '']
      .filter((part) => part.length > 0)
      .join('\n')
      .replace(/\n$/, '')
      .split('\n');
    const screen = lines.slice(-grid.rows);
    this.state.paint({
      screen: screen.join('\n'),
      scrollback: lines.slice(0, lines.length - screen.length).join('\n'),
      cols: grid.cols,
      rows: grid.rows,
      cursor: { x: 0, y: Math.max(0, screen.length - 1), visible: false },
    });
    this.size = { cols: grid.cols, rows: grid.rows };
    this.painted = true;
  }

  // The controller.

  /**
   * Keys, text, a paste or the mouse: sent once the controller is held.
   * The mouse never asks for it: the element reports the mouse only while it
   * is held (`controlled`), and a report from just before a release is
   * dropped.
   */
  input(actions) {
    if (!this.controllable() || this.control === 'refused' || this.follow === null) return;
    if (this.control !== 'held' && actions.every((action) => action.type === 'mouse')) return;
    this.queue.push(...actions);
    if (this.control === 'held') this.pump();
    else if (this.control === 'none') this.acquire();
  }

  /**
   * A press in the terminal, which took the keyboard: a shell started here
   * takes its controller, again after a refusal asking again can get past.
   * The agent's terminal waits for typing: a press to select or scroll
   * leaves the agent able to type into it.
   */
  activate() {
    if (this.agents() || !this.controllable()) return;
    if (this.control === 'none' || (this.control === 'refused' && this.refusal?.retry)) {
      this.acquire();
    }
  }

  /** The notice's Try again: asks for the controller again. */
  retry() {
    if (this.controllable() && this.control === 'refused') this.acquire();
  }

  /** The bar's Release: the agent can type into its terminal again, and typing here takes it back. */
  letGo() {
    this.release();
    this.touch();
  }

  /** The notice's Retry after following the output failed: follows it again. */
  refollow() {
    if (this.live !== 'failed' || this.owner.current() !== this || !this.owner.shown) return;
    this.show();
    this.touch();
  }

  /** The element measured the grid its pane holds: the PTY's size while a shell started here is held. */
  resized(grid) {
    this.grid = grid;
    if (this.control === 'held') this.pump();
    else if (this.mode() === 'pipes' && this.pipes !== null) this.paintPipes(this.pipes);
  }

  async acquire() {
    if (this.lease !== null || this.follow === null || this.owner.closed) return;
    const lease = { handle: null, closed: false, held: false, controllerId: null, next: 1 };
    this.lease = lease;
    this.control = 'acquiring';
    this.refusal = null;
    this.touch();
    let refusal = null;
    try {
      const handle = await subscribe(this.endpoint, 'acquire', this.target());
      if (lease.closed) {
        close(handle).catch(() => {});
        return;
      }
      lease.handle = handle;
      SUBSCRIPTIONS.add(handle);
      const first = await next(handle);
      if (lease.closed) return;
      // A refused `acquire` finishes with a failed outcome, which `next`
      // gives as its last item.
      if (first === null) refusal = refusalOf(t('terminalLeaseLost'), true);
      else if (first.kind === 'failed') refusal = refusalOf(first.message);
      else if (!first.value.held || first.value.nextSequence == null) {
        refusal = refusalOf(t('terminalLeaseLost'), true);
      } else {
        lease.held = true;
        lease.controllerId = first.value.controllerId;
        lease.next = first.value.nextSequence;
        this.control = 'held';
        this.sentSize = null;
        log(`terminal: holding ${this.ref} from sequence ${lease.next}`);
        this.touch();
        this.pump();
        for (;;) {
          const item = await next(handle);
          if (lease.closed) return;
          if (item === null || item.kind === 'failed' || !item.value?.held) {
            refusal =
              item?.kind === 'failed'
                ? refusalOf(item.message)
                : refusalOf(t('terminalLeaseLost'), true);
            break;
          }
        }
      }
    } catch (error) {
      if (lease.closed) return;
      refusal = refusalOf(error.message);
    } finally {
      if (!lease.closed) {
        lease.closed = true;
        untrack(lease.handle);
      }
      if (this.lease === lease) this.lease = null;
    }
    if (this.lease !== null || this.owner.closed) return;
    log(`terminal: no controller for ${this.ref}: ${refusal.text}`);
    this.queue = [];
    this.control = this.controllable() ? 'refused' : 'none';
    this.refusal = refusal;
    this.touch();
  }

  /** Releases the controller, if held, and closes its subscription. */
  release() {
    const lease = this.lease;
    this.queue = [];
    if (lease === null) return;
    this.lease = null;
    lease.closed = true;
    this.control = 'none';
    const handle = lease.handle;
    lease.handle = null;
    const target = this.target();
    const endpoint = this.endpoint;
    (async () => {
      if (lease.held) {
        try {
          const outcome = await operation(endpoint, 'release', {
            target,
            controllerId: lease.controllerId,
          });
          if (outcome.kind === 'failed')
            log(`terminal: release of ${target.ref}: ${outcome.message}`);
          else log(`terminal: released ${target.ref}`);
        } catch (error) {
          log(`terminal: release of ${target.ref} failed: ${error.message}`);
        }
      }
      untrack(handle);
    })();
  }

  /**
   * The size to ask of the PTY with the next call, or null when it has it
   * already. The agent's terminal keeps the size the agent gave it: what it
   * prints is laid out for that, and the element shows its bottom rows when
   * the pane holds fewer.
   */
  wantedSize() {
    const grid = this.grid;
    if (grid === null || this.agents()) return null;
    const current = this.sentSize ?? this.size;
    if (current?.cols === grid.cols && current?.rows === grid.rows) return null;
    return { cols: grid.cols, rows: grid.rows };
  }

  /** Takes the next call's actions off the queue: at most MAX_ACTIONS and MAX_TEXT_BYTES of text. */
  batch() {
    const actions = [];
    let bytes = 0;
    while (this.queue.length > 0 && actions.length < MAX_ACTIONS) {
      const action = this.queue[0];
      const size = typeof action.text === 'string' ? Buffer.byteLength(action.text, 'utf8') : 16;
      if (actions.length > 0 && bytes + size > MAX_TEXT_BYTES) break;
      actions.push(this.queue.shift());
      bytes += size;
    }
    return actions;
  }

  /**
   * Sends what is queued, one `control` call at a time, while the
   * controller is held. A refused call (the Host lost the sequence, or the
   * controller) drops what is queued and makes the terminal view only.
   */
  async pump() {
    if (this.sending) return;
    const lease = this.lease;
    if (lease === null || !lease.held) return;
    this.sending = true;
    try {
      while (this.lease === lease && !lease.closed) {
        const size = this.wantedSize();
        if (this.queue.length === 0 && size === null) break;
        const input = {
          controller: { target: this.target(), controllerId: lease.controllerId },
          sequence: lease.next,
          actions: this.batch(),
        };
        if (size !== null) input.size = size;
        const receipt = unwrap(await operation(this.endpoint, 'control', input));
        lease.next = receipt.sequence + 1;
        if (size !== null) this.sentSize = size;
      }
    } catch (error) {
      if (this.lease === lease && !lease.closed) {
        log(`terminal: input to ${this.ref} refused: ${error.message}`);
        this.release();
        this.control = 'refused';
        this.refusal = refusalOf(error.message);
        this.touch();
      }
    } finally {
      this.sending = false;
    }
    // A controller taken again while the last call was out sends what waits.
    if (this.lease !== lease && this.lease?.held) this.pump();
  }
}

/**
 * The terminals of one conversation: its resources as last listed, their
 * Terms, which one is selected, and whether the tool shows. Made for each
 * conversation the Workbar serves and closed when it leaves.
 */
export class Terminals {
  /**
   * @param {import('./transcript.js').Transcript} transcript
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   * @param cx the Workbar's view context, whose timers pace the recoveries
   */
  constructor(transcript, hooks, cx) {
    this.sessionId = transcript.id;
    this.endpoint = transcript.endpoint === 'coordinator' ? 'coordinatorTerminal' : 'terminal';
    this.hooks = hooks;
    this.cx = cx;
    /** The listed resources (ResourceUpdate), oldest first, and whether a list arrived yet. */
    this.entries = [];
    this.listed = false;
    this.listError = null;
    /** Terms by ref, made when first selected. */
    this.terms = new Map();
    this.selected = null;
    this.shown = false;
    this.closed = false;
    /** The open `watchList`: `{ handle, closed }`, or null. */
    this.listWatch = null;
    /** The grid the last terminal shown measured: the size a new shell starts at. */
    this.grid = null;
    this.starting = false;
    /** A shell started here and not listed yet: `{ ref, entry, until }`, or null. */
    this.pending = null;
    /** Pages pulled and listings applied, for the dev driver. */
    this.stats = { pages: 0, applied: 0 };
  }

  touch() {
    if (!this.closed) this.hooks.changed();
  }

  term(ref) {
    if (ref === null) return null;
    let term = this.terms.get(ref);
    if (term === undefined) {
      const entry = this.entries.find((each) => each.result.ref === ref);
      if (entry === undefined) return null;
      term = new Term(this, entry);
      this.terms.set(ref, term);
    }
    return term;
  }

  /** The Term shown, or null. */
  current() {
    return this.term(this.selected);
  }

  /** Follows the list and the terminal selected. */
  show() {
    if (this.shown || this.closed) return;
    this.shown = true;
    log(`terminal: showing ${this.sessionId} (${this.endpoint})`);
    this.watchList();
    this.current()?.show();
  }

  /** Closes every subscription and releases the controller; the screens stay. */
  hide() {
    if (!this.shown) return;
    this.shown = false;
    const watch = this.listWatch;
    this.listWatch = null;
    if (watch !== null) {
      watch.closed = true;
      untrack(watch.handle);
    }
    for (const term of this.terms.values()) term.hide();
    log(`terminal: hidden ${this.sessionId}`);
  }

  close() {
    this.hide();
    this.closed = true;
    for (const term of this.terms.values()) term.dispose();
    this.terms.clear();
  }

  /**
   * Follows `watchList` while the tool shows; each page lists the terminals
   * again. Pages are pulled as they come and only the latest is kept for
   * `applyList`.
   */
  async watchList() {
    const watch = { handle: null, closed: false, latest: null, applying: false, applied: 0 };
    this.listWatch = watch;
    try {
      const handle = await subscribe(this.endpoint, 'watchList', {
        sessionId: this.sessionId,
        offset: 0,
      });
      if (watch.closed) {
        close(handle).catch(() => {});
        return;
      }
      watch.handle = handle;
      SUBSCRIPTIONS.add(handle);
      for (;;) {
        const item = await next(handle);
        if (watch.closed) return;
        if (item === null) throw new Error(t('terminalWatchEnded'));
        watch.latest = unwrap(item);
        this.stats.pages += 1;
        this.applyList(watch);
      }
    } catch (error) {
      this.listFailed(watch, error.message);
    }
  }

  /**
   * Applies the latest page: at once when the last was applied LIST_PACE
   * ago, otherwise when that much time has passed. A long list continues in
   * pages of `list`.
   */
  async applyList(watch) {
    if (watch.applying) return;
    watch.applying = true;
    try {
      while (watch.latest !== null && !watch.closed) {
        const wait = watch.applied + LIST_PACE - Date.now();
        if (wait > 0) {
          await this.cx.sleep(wait);
          continue;
        }
        const page = watch.latest;
        watch.latest = null;
        const resources = [...page.resources];
        for (let offset = page.nextOffset ?? null; offset !== null; ) {
          const more = unwrap(
            await query(this.endpoint, 'list', { sessionId: this.sessionId, offset }),
          );
          if (watch.closed) return;
          resources.push(...more.resources);
          offset = more.nextOffset ?? null;
        }
        watch.applied = Date.now();
        this.stats.applied += 1;
        this.accept(resources);
      }
    } catch (error) {
      this.listFailed(watch, error.message);
    } finally {
      watch.applying = false;
    }
  }

  /** The list could not be followed: closes its watch and says so, with Retry. */
  listFailed(watch, message) {
    if (watch.closed) return;
    watch.closed = true;
    untrack(watch.handle);
    if (this.listWatch === watch) this.listWatch = null;
    if (!this.shown) return;
    log(`terminal: the list of ${this.sessionId} ended: ${message}`);
    this.listError = message;
    this.touch();
  }

  /** The list line's Retry: follows the list again. */
  retryList() {
    if (!this.shown || this.closed || this.listWatch !== null) return;
    this.listError = null;
    this.touch();
    this.watchList();
  }

  /**
   * A listing: the shell runs, oldest first, and a selection still listed.
   * Redraws only when what the tabs show changed: most pages differ from the
   * last only in a revision and a time.
   */
  accept(listed) {
    // A shell just started stays listed, and selected, until a page lists
    // it: pages queued before it started do not.
    let resources = listed;
    const pending = this.pending;
    if (pending !== null) {
      if (listed.some((entry) => entry.result?.ref === pending.ref)) this.pending = null;
      else if (Date.now() < pending.until) resources = [...listed, pending.entry];
      else this.unlisted(pending.ref);
    }
    const before = this.listed && this.listError === null ? tabsOf(this.entries) : null;
    this.entries = resources
      .filter((entry) => entry.result?.kind === 'shell_run')
      .sort(
        (a, b) =>
          a.result.startedAt - b.result.startedAt ||
          (a.result.ref < b.result.ref ? -1 : a.result.ref > b.result.ref ? 1 : 0),
      );
    this.listed = true;
    this.listError = null;
    for (const entry of this.entries) this.terms.get(entry.result.ref)?.update(entry);
    if (!this.entries.some((entry) => entry.result.ref === this.selected)) {
      const running = this.entries.filter((entry) => RUNNING.has(entry.result.status));
      this.select((running.at(-1) ?? this.entries.at(-1))?.result.ref ?? null);
    }
    if (tabsOf(this.entries) !== before) this.touch();
  }

  /** Shows the terminal `ref`: the one before stops following and releases its controller. */
  select(ref) {
    if (ref === this.selected) return;
    this.current()?.hide();
    this.selected = ref;
    if (this.shown) this.current()?.show();
    this.touch();
  }

  /** An event from the Terminal element of `term`. */
  event(term, event) {
    if (this.closed || this.current() !== term) return;
    switch (event.kind) {
      case 'input':
        term.input(event.actions);
        break;
      case 'activate':
        term.activate();
        break;
      case 'resize':
        this.grid = { cols: event.cols, rows: event.rows };
        term.resized(this.grid);
        break;
      case 'scrolled':
        term.atBottom = event.atBottom;
        this.touch();
        break;
    }
  }

  /**
   * "+": a shell in the conversation's folder, at the grid the pane holds,
   * selected with the keyboard and its controller, to type in at once.
   */
  async start() {
    if (this.starting || this.closed) return;
    this.starting = true;
    this.touch();
    try {
      const size = this.grid ?? DEFAULT_GRID;
      log(`terminal: starting a shell in ${this.sessionId} at ${size.cols}x${size.rows}`);
      const resource = unwrap(
        await operation(this.endpoint, 'start', {
          sessionId: this.sessionId,
          command: null,
          size: { cols: size.cols, rows: size.rows },
        }),
      );
      if (this.closed) return;
      const ref = resource.result.ref;
      if (!this.entries.some((entry) => entry.result.ref === ref)) {
        this.entries = [...this.entries, resource];
        this.pending = { ref, entry: resource, until: Date.now() + START_LISTED };
        (async () => {
          await this.cx.sleep(START_LISTED + LIST_PACE);
          // Without a page meanwhile (the tool hidden, the list failed) the
          // next page decides.
          if (this.shown && this.listWatch !== null && this.pending?.ref === ref) {
            this.unlisted(ref);
            this.accept(this.entries.filter((entry) => entry.result.ref !== ref));
          }
        })();
      }
      this.select(ref);
      const term = this.current();
      if (term !== null && this.shown) {
        // The element draws with the next frame; focus it then.
        await this.cx.sleep(50);
        if (this.current() === term && term.state !== null) {
          term.state.focus();
          term.activate();
        }
      }
    } catch (error) {
      this.hooks.report(t('terminalStartFailed', { value: error.message }));
    } finally {
      this.starting = false;
      this.touch();
    }
  }

  /**
   * A shell started here that no page listed in time: the Host lost it or
   * never ran it. It goes, and the start is reported as failed.
   */
  unlisted(ref) {
    if (this.pending?.ref !== ref) return;
    this.pending = null;
    log(`terminal: ${ref} was started but never listed`);
    this.hooks.report(t('terminalStartFailed', { value: t('terminalNotListed') }));
  }

  /** A tab's close button: stops the process once the user agrees. */
  askStop(term) {
    if (!term.running() || !term.local()) return;
    window.open_dialog(() => stopDialog(this, term, this.cx), { backdrop_dismissable: false });
  }

  async stop(term) {
    window.close_dialog();
    if (this.closed) return;
    try {
      log(`terminal: stopping ${term.ref}`);
      unwrap(await operation(this.endpoint, 'stop', term.target()));
    } catch (error) {
      this.hooks.report(t('terminalStopFailed', { value: error.message }));
    }
  }

  cancelStop() {
    window.close_dialog();
  }

  /** What a tab says: "Shell" (numbered when there are several) or the agent's command's first line. */
  label(entry) {
    if (entry.sourceTurnId !== entry.sourceToolCallId) {
      return (entry.result.cmd ?? '').split('\n')[0].trim() || t('terminalShell');
    }
    const shells = this.entries.filter((each) => each.sourceTurnId === each.sourceToolCallId);
    const index = shells.findIndex((each) => each.result.ref === entry.result.ref);
    return shells.length > 1 ? `${t('terminalShell')} ${index + 1}` : t('terminalShell');
  }
}

/** What the tabs and the notice show of the listed terminals, to tell whether a page changed it. */
function tabsOf(entries) {
  return JSON.stringify(
    entries.map(({ result, ownership, sourceTurnId, sourceToolCallId }) => [
      result.ref,
      result.status,
      result.mode,
      result.cmd,
      result.exitCode,
      result.failureMessage,
      ownership?.kind,
      sourceTurnId === sourceToolCallId,
    ]),
  );
}

/**
 * The line over the terminal, when there is something to say: its text,
 * whether it is a failure, whether it wraps instead of being cut short, and
 * the button it offers (`{ id, label, run }`), or null.
 */
function notice(term) {
  const result = term.entry.result;
  if (!term.local()) return { text: t('terminalOtherConversation') };
  if (term.live === 'failed') {
    return {
      text: t('terminalFailed', { value: term.problem }),
      error: true,
      action: { id: 'terminal-refollow', label: t('retry'), run: () => term.refollow() },
    };
  }
  if (!term.running()) {
    if (result.failureMessage)
      return { text: t('terminalEndedWith', { value: result.failureMessage }) };
    if (result.exitCode !== undefined && result.exitCode !== null) {
      return { text: t('terminalExited', { code: result.exitCode }) };
    }
    return { text: t('terminalEnded') };
  }
  if (term.live === 'unavailable') return { text: t('terminalNotLive') };
  if (term.mode() === 'pipes') return { text: t('terminalPipes') };
  if (term.control === 'refused') {
    return {
      text: t('terminalViewOnly', { value: term.refusal.text }),
      action:
        term.refusal.retry && term.controllable() && term.live === 'live'
          ? { id: 'terminal-retry', label: t('terminalRetry'), run: () => term.retry() }
          : null,
    };
  }
  if (term.control === 'held' && term.agents()) {
    // Its second sentence is what holding it does: at the Workbar's usual
    // width it goes to a second line rather than being cut off.
    return {
      text: t('terminalTyping'),
      wrap: true,
      action: { id: 'terminal-release', label: t('terminalRelease'), run: () => term.letGo() },
    };
  }
  return null;
}

/** A line of the tool's: what `said` says, in red for a failure, and its button. */
function noticeLine(id, said, cx) {
  const m = palette(cx);
  const action = said.action ?? null;
  const words = text(said.text, 'small', said.error ? m.destructive : m.inkMuted)
    .flex_1()
    .min_w_0();
  return h_flex()
    .id(id)
    .flex_none()
    .when(said.wrap === true, (el) => el.min_h(28).py(5))
    .when(said.wrap !== true, (el) => el.h(28))
    .px(12)
    .items_center()
    .gap(8)
    .child(said.wrap === true ? words : words.truncate())
    .when(said.wrap !== true, (el) => el.tooltip(said.text))
    .when(action !== null, (el) =>
      el.child(
        ghostButton(action.id, cx)
          .flex_none()
          .h(22)
          .px(8)
          .rounded(6)
          .on_click(action.run)
          .child(typeset(div(), 'smallLabel').text_color(m.primary).child(action.label)),
      ),
    );
}

/** The colour of a terminal's dot: running, failed, or ended. */
function dotColor(entry, m) {
  if (RUNNING.has(entry.result.status)) return m.success;
  if (FAILED.has(entry.result.status)) return m.destructive;
  return m.inkDisabled;
}

function terminalTab(terminals, entry, cx) {
  const m = palette(cx);
  const ref = entry.result.ref;
  const selected = ref === terminals.selected;
  const agents = entry.sourceTurnId !== entry.sourceToolCallId;
  // Only this conversation's own terminals can be stopped from here.
  const stoppable = RUNNING.has(entry.result.status) && entry.ownership?.kind === 'local';
  const label = terminals.label(entry);
  return h_flex()
    .id(`terminal-tab-${ref}`)
    .flex_none()
    .h(28)
    .max_w(220)
    .pl(8)
    .pr(stoppable ? 2 : 10)
    .gap(6)
    .items_center()
    .rounded(8)
    .when(selected, (el) => el.bg(m.selected))
    .when(!selected, (el) => el.hover((style) => style.bg(m.hover)))
    .tooltip(entry.result.cmd ?? label)
    .on_click(() => terminals.select(ref))
    .child(div().flex_none().size(8).rounded(9999).bg(dotColor(entry, m)))
    .child(
      text(label, 'smallLabel', selected ? m.ink : m.inkMuted)
        .min_w_0()
        .truncate(),
    )
    .when(agents, (el) =>
      el.child(
        div()
          .flex_none()
          .h(16)
          .px(4)
          .rounded(4)
          .bg(m.badge)
          .text_size(11)
          .line_height('16px')
          .font_weight(500)
          .text_color(m.inkMuted)
          .child(t('terminalAgent')),
      ),
    )
    .when(stoppable, (el) =>
      el.child(
        iconButton(`terminal-stop-${ref}`, 'close', cx, 20, 12)
          .tooltip(t('terminalStop'))
          .on_click(() => terminals.askStop(terminals.term(ref))),
      ),
    );
}

/**
 * The Terminal tool under the Workbar's header: a tab per terminal and "+",
 * then the one selected, or what there is to say without one.
 * @param {Terminals} terminals
 */
export function terminalBody(terminals, cx) {
  const m = palette(cx);
  const term = terminals.current();
  const tabs = h_flex()
    .flex_none()
    .h(36)
    .px(12)
    .gap(4)
    .items_center()
    .child(
      h_flex()
        .id('terminal-tabs')
        .flex_1()
        .min_w_0()
        .gap(2)
        .items_center()
        .overflow_x_scroll()
        .children(terminals.entries.map((entry) => terminalTab(terminals, entry, cx))),
    )
    .child(
      iconButton('terminal-new', 'plus', cx)
        .tooltip(t('terminalNew'))
        .when(terminals.starting, (el) => el.opacity(0.5))
        .on_click(() => terminals.start()),
    );
  let body;
  if (term === null || term.state === null) {
    // A list that failed before any page says so in its line alone.
    const message = terminals.listed
      ? t('terminalEmpty')
      : terminals.listError === null
        ? t('terminalLoading')
        : null;
    body = v_flex()
      .flex_1()
      .min_h_0()
      .gap(12)
      .items_center()
      .justify_center()
      .px(24)
      .when(message !== null, (el) => el.child(text(message, 'body', m.inkMuted).text_center()))
      .when(terminals.listed && terminals.entries.length === 0, (el) =>
        el.child(
          controlButton(
            'terminal-start',
            t('terminalNew'),
            'outline',
            terminals.starting,
            cx,
          ).on_click(() => terminals.start()),
        ),
      );
  } else {
    body = terminalPane(terminals, term, cx);
  }
  const listFailure =
    terminals.listError === null
      ? null
      : {
          text: t('terminalListFailed', { value: terminals.listError }),
          error: true,
          action: {
            id: 'terminal-list-retry',
            label: t('retry'),
            run: () => terminals.retryList(),
          },
        };
  return v_flex()
    .flex_1()
    .min_h_0()
    .child(tabs)
    .when(listFailure !== null, (el) =>
      el.child(noticeLine('terminal-list-failed', listFailure, cx).mx(12)),
    )
    .child(body);
}

/** The terminal selected, on the code fill, with its notice and the way back to the bottom. */
function terminalPane(terminals, term, cx) {
  const m = palette(cx);
  const colors = terminalColors(cx);
  const said = notice(term);
  const cursor = term.running() && term.live !== 'unavailable' && term.live !== 'ended';
  return v_flex()
    .id('terminal-pane')
    .relative()
    .flex_1()
    .min_h_0()
    .mx(12)
    .mb(12)
    .rounded(10)
    .bg(colors.background)
    .overflow_hidden()
    .when(said !== null, (el) =>
      el.child(noticeLine('terminal-notice', said, cx).border_b_1().border_color(m.borderSoft)),
    )
    .child(
      Terminal(term.state)
        .palette(colors.ansi, colors.foreground, colors.background, colors.cursor, colors.selection)
        .cursor(cursor)
        .controlled(term.control === 'held')
        .on_event((event) => terminals.event(term, event))
        .flex_1()
        .min_h_0()
        .w_full()
        .px(10)
        .py(8)
        .font_family('Menlo')
        .text_size(14)
        .line_height('20px'),
    )
    .when(!term.atBottom, (el) =>
      el.child(
        ghostButton('terminal-bottom', cx)
          .absolute()
          .right(12)
          .bottom(12)
          .h(28)
          .px(10)
          .gap(6)
          .rounded(9999)
          .bg(m.overlay)
          .border_1()
          .border_color(m.border)
          .shadow_xs()
          .tooltip(t('terminalBottom'))
          .on_click(() => term.state?.scroll_to_bottom())
          .child(icon('chevron-down', 14, m.inkMuted))
          .child(typeset(div(), 'smallLabel').text_color(m.inkMuted).child(t('terminalBottom'))),
      ),
    );
}

/** The dialog before stopping a running terminal: what stopping does, then Cancel and Stop. */
function stopDialog(terminals, term, cx) {
  const m = palette(cx);
  const name = terminals.label(term.entry);
  return v_flex()
    .w(360)
    .gap(16)
    .child(
      v_flex()
        .gap(6)
        .child(typeset(div(), 'heading').text_color(m.ink).child(t('terminalStopTitle', { name })))
        .child(
          text(
            term.agents() ? t('terminalStopAgentBody') : t('terminalStopBody'),
            'body',
            m.inkMuted,
          ),
        ),
    )
    .child(
      h_flex()
        .gap(8)
        .justify_end()
        .child(
          controlButton('terminal-stop-cancel', t('cancel'), 'outline', false, cx).on_click(() =>
            terminals.cancelStop(),
          ),
        )
        .child(
          controlButton('terminal-stop-confirm', t('terminalStop'), 'primary', false, cx)
            .bg(m.destructive)
            .hover((style) => style.bg(m.destructive).opacity(0.84))
            .on_click(() => terminals.stop(term)),
        ),
    );
}
