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

/**
 * Attention layer for long-running turns, permission prompts, and errors.
 *
 * Two signals, driven from the runner's turn lifecycle:
 *  - the terminal title carries a state marker (busy / attention-needed / idle),
 *    so a glance at the tab tells you what the session is doing; and
 *  - a terminal BEL rings when something wants the user *while the terminal is
 *    not focused*, so a turn finishing or a prompt appearing in a background tab
 *    is not missed.
 *
 * Focus is tracked out of band: the runner enables DEC private mode 1004 and
 * feeds `focusChanged` from the `\x1b[I` / `\x1b[O` reports. Terminals that do
 * not support 1004 never report a blur, so `focused` stays true and no BEL ever
 * fires — the title markers still work everywhere, but the ring is suppressed
 * rather than sounding while the user is watching. That is the conservative
 * degradation: never ring when we cannot confirm the user is away.
 */

/** The terminal surface the attention layer writes to: a raw BEL plus the title. */
export interface AttentionTerminal {
  write(data: string): void;
  setTitle(title: string): void;
}

export interface AttentionControllerOptions {
  /** The bare title with no state marker, e.g. `Maka`. */
  baseTitle: string;
  /** Injectable clock so tests can drive turn duration; defaults to `Date.now`. */
  now?: () => number;
  /**
   * A prompt turn must run at least this long for its completion to be worth a
   * ring — a turn that finishes in a blink does not pull you back to a tab you
   * are already watching. Permission prompts and errors ring regardless.
   */
  longTurnThresholdMs?: number;
  /** Busy-marker spinner frames; defaults to the braille cycle. */
  busySpinnerFrames?: readonly string[];
  /** Spinner frame interval in ms; defaults to {@link DEFAULT_BUSY_SPINNER_INTERVAL_MS}. */
  busySpinnerIntervalMs?: number;
  /**
   * Injectable interval scheduler for the spinner so tests can advance frames by
   * hand instead of waiting real timers. Returns a cancel function. Defaults to
   * an unref'd global setInterval so a lingering tick never blocks process exit.
   */
  scheduleSpinnerInterval?: (callback: () => void, intervalMs: number) => () => void;
}

/** DEC 1004 focus reports the runner enables and forwards to `focusChanged`. */
export const FOCUS_IN_SEQUENCE = '\x1b[I';
export const FOCUS_OUT_SEQUENCE = '\x1b[O';
/** Enable / disable DEC private mode 1004 (focus reporting). */
export const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
export const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';

const BELL = '\x07';
// Braille spinner (matches pi-tui's Loader frames) shown while a turn or control
// action runs, so a glance at the tab tells you Maka is working — a static dot
// could not be told apart from an idle indicator.
export const BUSY_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const DEFAULT_BUSY_SPINNER_INTERVAL_MS = 80;
const ATTENTION_TITLE_MARKER = '★ ';
const DEFAULT_LONG_TURN_THRESHOLD_MS = 8000;

function defaultScheduleSpinnerInterval(callback: () => void, intervalMs: number): () => void {
  const handle = setInterval(callback, intervalMs);
  // Never let the spinner tick alone keep the process alive; it is always
  // cleared when the turn ends or the session closes anyway.
  handle.unref?.();
  return () => clearInterval(handle);
}

export class AttentionController {
  private readonly now: () => number;
  private readonly longTurnThresholdMs: number;
  // Assume focused until the terminal reports a blur, so a terminal that never
  // reports focus (no 1004 support) is treated as always-watching and stays
  // silent, rather than ringing on every turn.
  private focused = true;
  private busy = false;
  // Latched when something the user has not yet acknowledged is waiting; drives
  // the attention title marker until they engage (focus, answer, or a new turn).
  private attention = false;
  private turnStartedAt = 0;
  private baseTitle: string;
  private lastTitle: string | null = null;
  // Set once the session is closing; every event method then no-ops so a turn
  // finalizer that settles after close() cannot re-dirty the handed-back title.
  private stopped = false;
  // Spinner animation state for the busy marker.
  private readonly busySpinnerFrames: readonly string[];
  private readonly busySpinnerIntervalMs: number;
  private readonly scheduleSpinnerInterval: (
    callback: () => void,
    intervalMs: number,
  ) => () => void;
  private spinnerFrame = 0;
  private cancelSpinner: (() => void) | null = null;

  constructor(
    private readonly terminal: AttentionTerminal,
    private readonly options: AttentionControllerOptions,
  ) {
    this.baseTitle = options.baseTitle;
    this.now = options.now ?? Date.now;
    this.longTurnThresholdMs = options.longTurnThresholdMs ?? DEFAULT_LONG_TURN_THRESHOLD_MS;
    this.busySpinnerFrames =
      options.busySpinnerFrames && options.busySpinnerFrames.length > 0
        ? options.busySpinnerFrames
        : BUSY_SPINNER_FRAMES;
    this.busySpinnerIntervalMs =
      options.busySpinnerIntervalMs && options.busySpinnerIntervalMs > 0
        ? options.busySpinnerIntervalMs
        : DEFAULT_BUSY_SPINNER_INTERVAL_MS;
    this.scheduleSpinnerInterval =
      options.scheduleSpinnerInterval ?? defaultScheduleSpinnerInterval;
    this.refreshTitle();
  }

  setBaseTitle(title: string): void {
    if (this.stopped) return;
    this.baseTitle = title;
    this.refreshTitle();
  }

  /** A prompt turn began: activity starts and any prior attention is acknowledged. */
  promptTurnStarted(): void {
    if (this.stopped) return;
    this.turnStartedAt = this.now();
    this.attention = false;
    this.busy = true;
    this.refreshTitle();
  }

  /**
   * A prompt turn ended (completed, errored, or aborted): a turn that ran past
   * the threshold rings if the user is away, so a long turn finishing in a
   * background tab pulls them back. The outcome does not matter — a long turn
   * that failed is exactly as worth surfacing as one that succeeded.
   */
  promptTurnEnded(): void {
    if (this.stopped) return;
    this.busy = false;
    if (this.now() - this.turnStartedAt >= this.longTurnThresholdMs) {
      this.raiseAttention();
    } else {
      this.refreshTitle();
    }
  }

  /** A control action (model/session switch, compaction) started: busy, never rings. */
  controlStarted(): void {
    if (this.stopped) return;
    this.attention = false;
    this.busy = true;
    this.refreshTitle();
  }

  /** A control action ended. */
  controlEnded(): void {
    if (this.stopped) return;
    this.busy = false;
    this.refreshTitle();
  }

  /** The app needs the user now (a permission prompt appeared, or an error surfaced). */
  attentionNeeded(): void {
    if (this.stopped) return;
    this.raiseAttention();
  }

  /** Terminal focus changed; regaining focus acknowledges any pending attention. */
  focusChanged(focused: boolean): void {
    if (this.stopped) return;
    this.focused = focused;
    if (focused) this.attention = false;
    this.refreshTitle();
  }

  /**
   * The session is closing: drop any busy / attention marker so the tab is not
   * handed back to the shell still marked busy, and go inert so a turn finalizer
   * that settles after this cannot re-dirty the title.
   */
  reset(): void {
    this.stopped = true;
    this.busy = false;
    this.attention = false;
    this.refreshTitle();
  }

  /**
   * Ring and mark the title only when the terminal is not focused. The `★`
   * marker means "an attention-worthy event fired while you were away", not a
   * live needs-you state: it is set on the event and cleared when you return
   * (focus) or a new turn starts. While focused the on-screen UI (the finished
   * turn, the y/n prompt, the error notice) is the signal, so no ring and no
   * decoration — just drop back to the plain title if the turn had made it busy.
   *
   * The bell rings once per away-episode: a second event while the marker is
   * already up (e.g. a turn that errors and then ends long) does not re-ring, so
   * a background tab is alerted once, not repeatedly, until the user engages.
   */
  private raiseAttention(): void {
    if (this.focused) {
      this.refreshTitle();
      return;
    }
    if (!this.attention) this.terminal.write(BELL);
    this.attention = true;
    this.refreshTitle();
  }

  private refreshTitle(): void {
    // Keep the spinner ticking exactly while the busy marker is on screen, so it
    // animates during work and stops (freeing the timer) the moment it isn't.
    this.syncSpinner();
    // Attention outranks busy: a turn parked on a permission prompt is "busy"
    // but what it actually needs is the user, so surface that first. Attention
    // is only ever set while unfocused, so a normal running turn still shows busy.
    const title = this.attention
      ? `${ATTENTION_TITLE_MARKER}${this.baseTitle}`
      : this.busy
        ? `${this.busySpinnerFrames[this.spinnerFrame] ?? ''} ${this.baseTitle}`
        : this.baseTitle;
    // Only write on a real change so the title stream stays quiet between turns
    // and a test can read the transitions rather than a run of duplicates. Each
    // spinner tick advances the frame first, so the title genuinely differs.
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    this.terminal.setTitle(title);
  }

  // Start or stop the spinner interval to match whether the busy marker is
  // currently shown (busy, not overridden by attention, session still live).
  private syncSpinner(): void {
    const shouldRun =
      this.busy && !this.attention && !this.stopped && this.busySpinnerFrames.length > 0;
    if (shouldRun && !this.cancelSpinner) {
      this.cancelSpinner = this.scheduleSpinnerInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % this.busySpinnerFrames.length;
        this.refreshTitle();
      }, this.busySpinnerIntervalMs);
    } else if (!shouldRun && this.cancelSpinner) {
      this.cancelSpinner();
      this.cancelSpinner = null;
      // Reset so the next busy episode opens on the first frame, not mid-cycle.
      this.spinnerFrame = 0;
    }
  }
}
