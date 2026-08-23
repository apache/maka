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

import type { IBuffer, IDisposable } from '@xterm/headless';
import type { PtyShellOutput } from '@maka/core/shell-run';
import type { TerminalInputState, TerminalMouseEncoding } from '@maka/core/terminal-input';
import { redactSecrets } from '@maka/core/redaction';

import type { PtyStack } from './pty-stack.js';

export const PTY_INITIAL_COLS = 80;
export const PTY_INITIAL_ROWS = 24;
export const PTY_SCROLLBACK_ROWS = 500;
export const PTY_PARSER_HIGH_WATER_BYTES = 1024 * 1024;
export const PTY_PROTOCOL_REPLY_MAX_BYTES = 1024 * 1024;

const REDACTED_MARKER = '[redacted]';
const BLOCKED_OSC = [0, 1, 2, 7, 8, 9, 52, 777] as const;
const ALTERNATE_BUFFER_MODES = new Set([47, 1047, 1049]);

interface RawRow {
  text: string;
  isWrapped: boolean;
  region: 'scrollback' | 'screen';
  screenIndex?: number;
}

interface PendingEntry {
  data: string;
  bytes: number;
  dropped: boolean;
}

interface SanitizedBuffer {
  screen: string;
  scrollback: string;
  truncated: boolean;
  redacted: boolean;
}

export interface PtySnapshotAtCut {
  output: PtyShellOutput;
  generation: number;
}

export interface PtyScreenCollectorOptions {
  stack: PtyStack;
  cols?: number;
  rows?: number;
  onProtocolReply: (data: string) => void;
  onDirty: (generation: number) => void;
  onFailure: (error: Error) => void;
}

export class PtyScreenCollector {
  private readonly terminal: InstanceType<PtyStack['Terminal']>;
  private readonly subscriptions: IDisposable[] = [];
  private sequence: Promise<void> = Promise.resolve();
  private admittedGeneration = 0;
  private parsedGeneration = 0;
  private pendingBytes = 0;
  private pending: PendingEntry[] = [];
  private resetBeforeNextWrite = false;
  private dataOpen = true;
  private disposed = false;
  private cursorVisible = true;
  private mouseEncoding: TerminalMouseEncoding = 'default';
  private normalBufferAtScrollbackLimit = false;
  private suppressNextNormalScrollRetention = false;
  private historyTruncated = false;
  private failure: Error | undefined;
  private lastGood: PtyShellOutput;
  private lastAlternateRows: RawRow[] | undefined;
  private protocolReplyBatch: string | undefined;
  private protocolReplyBytes = 0;

  constructor(private readonly options: PtyScreenCollectorOptions) {
    const cols = options.cols ?? PTY_INITIAL_COLS;
    const rows = options.rows ?? PTY_INITIAL_ROWS;
    this.terminal = new options.stack.Terminal({
      cols,
      rows,
      scrollback: PTY_SCROLLBACK_ROWS,
      allowProposedApi: true,
      scrollOnEraseInDisplay: false,
      windowOptions: {},
    });
    const unicode = new options.stack.Unicode11Addon();
    this.terminal.loadAddon(unicode);
    this.terminal.unicode.activeVersion = '11';
    this.subscriptions.push(this.terminal.onScroll(() => this.trackScrollbackRetention()));
    this.installProtocolBoundary();
    this.lastGood = blankPtyOutput(cols, rows);
  }

  accept(data: string): void {
    if (!data) return;
    if (!this.dataOpen || this.disposed) {
      this.fail(new Error('PTY data arrived after collector admission closed'));
      return;
    }
    const generation = ++this.admittedGeneration;
    const bytes = Buffer.byteLength(data, 'utf8');
    const entry: PendingEntry = { data, bytes, dropped: false };
    this.pendingBytes += bytes;
    this.pending.push(entry);
    this.evictOldestIfOverBudget();
    this.options.onDirty(generation);

    const parse = this.sequence.then(() => (entry.dropped ? undefined : this.write(entry.data)));
    this.sequence = parse.then(
      () => {
        if (entry.dropped) return;
        this.parsedGeneration = generation;
        this.pendingBytes -= bytes;
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
      },
      (error: unknown) => {
        if (!entry.dropped) this.pendingBytes -= bytes;
        this.fail(asError(error, 'PTY parser failed'));
      },
    );
  }

  private evictOldestIfOverBudget(): void {
    // The parse queue is a newest-first bounded buffer: when it exceeds its
    // budget, evict the oldest queued data instead of pausing the source.
    // The source is never paused, so process exit can never strand unread
    // bytes behind node-pty's socket-destroy fence; only the newest frame is
    // ever guaranteed to reach the terminal. Eviction marks the output
    // truncated, matching scrollback eviction semantics.
    while (this.pendingBytes > PTY_PARSER_HIGH_WATER_BYTES && this.pending.length > 1) {
      const oldest = this.pending.shift();
      if (!oldest) break;
      oldest.dropped = true;
      // Release the payload: the queued closure still references the entry
      // until the parse chain reaches it, so a paused write would otherwise
      // keep every evicted string alive — the byte counter would be bounded
      // while actual memory grows without bound.
      oldest.data = '';
      this.pendingBytes -= oldest.bytes;
      this.historyTruncated = true;
      // Eviction creates an input gap: the dropped chunk may have carried the
      // terminator of an escape sequence the parser is still waiting on, so
      // the retained suffix must be parsed from a known ground state.
      this.resetBeforeNextWrite = true;
    }
  }

  mutateAtCut<T>(mutation: () => T | Promise<T>): Promise<T> {
    const result = this.sequence.then(async () => {
      this.throwIfUnavailable();
      return await mutation();
    });
    this.sequence = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  mutateAndSnapshotAtCut(mutation: () => void | Promise<void>): Promise<PtySnapshotAtCut> {
    return this.mutateAtCut(async () => {
      await mutation();
      this.throwIfUnavailable();
      return this.captureSnapshot();
    });
  }

  snapshotAtCut(): Promise<PtySnapshotAtCut> {
    return this.mutateAtCut(() => this.captureSnapshot());
  }

  private captureSnapshot(): PtySnapshotAtCut {
    try {
      const output = this.createSnapshot();
      this.lastGood = output;
      return { output, generation: this.parsedGeneration };
    } catch (error) {
      const failure = asError(error, 'PTY snapshot failed');
      this.fail(failure);
      throw failure;
    }
  }

  resize(cols: number, rows: number): void {
    this.throwIfUnavailable();
    try {
      this.terminal.resize(cols, rows);
    } catch (error) {
      const failure = asError(error, 'PTY screen resize failed');
      this.fail(failure);
      throw failure;
    }
  }

  currentSize(): { cols: number; rows: number } {
    this.throwIfUnavailable();
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  currentInputState(): TerminalInputState {
    this.throwIfUnavailable();
    return {
      applicationCursorKeysMode: this.terminal.modes.applicationCursorKeysMode,
      mouseTrackingMode: this.terminal.modes.mouseTrackingMode,
      mouseEncoding: this.mouseEncoding,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  closeDataAdmission(): void {
    this.dataOpen = false;
  }

  lastGoodSnapshot(): PtyShellOutput {
    return this.lastGood;
  }

  currentGeneration(): number {
    return this.admittedGeneration;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dataOpen = false;
    for (const subscription of this.subscriptions) {
      try {
        subscription.dispose();
      } catch {
        // Continue terminal cleanup even if a proposed parser handle changed.
      }
    }
    this.terminal.dispose();
  }

  private installProtocolBoundary(): void {
    this.subscriptions.push(
      this.terminal.onData((data) => {
        if (this.failure || this.disposed) return;
        if (this.protocolReplyBatch === undefined) {
          this.fail(new Error('PTY protocol reply escaped its parser write boundary'));
          return;
        }
        const bytes = Buffer.byteLength(data, 'utf8');
        if (this.protocolReplyBytes + bytes > PTY_PROTOCOL_REPLY_MAX_BYTES) {
          this.fail(
            new Error(
              `PTY protocol replies exceeded the ${PTY_PROTOCOL_REPLY_MAX_BYTES}-byte process limit`,
            ),
          );
          return;
        }
        this.protocolReplyBytes += bytes;
        this.protocolReplyBatch += data;
      }),
    );
    for (const ident of BLOCKED_OSC) {
      this.subscriptions.push(this.terminal.parser.registerOscHandler(ident, () => true));
    }
    this.subscriptions.push(
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        const values = flatParams(params);
        if (values.some((value) => ALTERNATE_BUFFER_MODES.has(value))) {
          this.lastAlternateRows = undefined;
          this.suppressNextNormalScrollRetention = true;
        }
        if (values.includes(25)) this.cursorVisible = true;
        for (const value of values) {
          if (value === 1006) this.mouseEncoding = 'sgr';
          if (value === 1016) this.mouseEncoding = 'sgr_pixels';
        }
        return false;
      }),
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        const values = flatParams(params);
        if (
          values.some((value) => ALTERNATE_BUFFER_MODES.has(value)) &&
          this.terminal.buffer.active.type === 'alternate'
        ) {
          const rows = readScreenRows(this.terminal.buffer.active, this.terminal.rows);
          this.lastAlternateRows = rows.some((row) => row.text.length > 0) ? rows : undefined;
        }
        if (values.some((value) => ALTERNATE_BUFFER_MODES.has(value))) {
          this.suppressNextNormalScrollRetention = true;
        }
        if (values.includes(25)) this.cursorVisible = false;
        if (values.includes(1006) || values.includes(1016)) this.mouseEncoding = 'default';
        return false;
      }),
      this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
        this.cursorVisible = true;
        this.mouseEncoding = 'default';
        this.lastAlternateRows = undefined;
        return false;
      }),
      this.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
        this.cursorVisible = true;
        return false;
      }),
    );
  }

  private write(data: string): Promise<void> {
    this.throwIfUnavailable();
    return new Promise<void>((resolve, reject) => {
      this.protocolReplyBatch = '';
      try {
        if (this.resetBeforeNextWrite) {
          this.resetBeforeNextWrite = false;
          this.resetTerminalAtInputGap();
        }
        this.terminal.write(data, () => {
          this.suppressNextNormalScrollRetention = false;
          const protocolReply = this.protocolReplyBatch;
          this.protocolReplyBatch = undefined;
          if (!this.failure && protocolReply) {
            try {
              this.options.onProtocolReply(protocolReply);
            } catch (error) {
              this.fail(asError(error, 'PTY protocol reply failed'));
            }
          }
          if (this.failure) reject(this.failure);
          else resolve();
        });
      } catch (error) {
        this.protocolReplyBatch = undefined;
        reject(error);
      }
    });
  }

  private resetTerminalAtInputGap(): void {
    // The retained suffix must be parsed from a known ground state: eviction
    // may have dropped the terminator of an escape sequence the parser is
    // still waiting on. `terminal.reset()` alone clears the buffer but leaves
    // the parser state machine untouched (an unterminated OSC still swallows
    // the suffix), so feed RIS (ESC c): its full reset puts the parser back
    // to ground and empties the buffer. The old screen was built from
    // incomplete input and is cleared with it. historyTruncated is kept:
    // eviction itself is truncation.
    this.terminal.write('\u001bc');
    this.cursorVisible = true;
    this.mouseEncoding = 'default';
    this.lastAlternateRows = undefined;
    this.normalBufferAtScrollbackLimit = false;
    this.suppressNextNormalScrollRetention = false;
  }

  private createSnapshot(): PtyShellOutput {
    const active = this.terminal.buffer.active;
    const rows = readActiveRows(active, this.terminal.rows);
    const current = sanitizeBuffer(rows, this.terminal.rows);
    const lastAlternate = this.lastAlternateRows
      ? sanitizeBuffer(this.lastAlternateRows, this.terminal.rows)
      : undefined;
    return {
      mode: 'pty',
      screen: current.screen,
      scrollback: current.scrollback,
      ...(lastAlternate?.screen ? { lastAlternateScreen: lastAlternate.screen } : {}),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cursor: {
        x: active.cursorX,
        y: active.cursorY,
        visible: this.cursorVisible,
      },
      alternateScreen: active.type === 'alternate',
      truncated: this.historyTruncated || current.truncated || Boolean(lastAlternate?.truncated),
      redacted: current.redacted || Boolean(lastAlternate?.redacted),
    };
  }

  private trackScrollbackRetention(): void {
    if (this.terminal.buffer.active.type !== 'normal') return;
    if (this.suppressNextNormalScrollRetention) {
      this.suppressNextNormalScrollRetention = false;
      this.normalBufferAtScrollbackLimit = this.terminal.buffer.normal.baseY >= PTY_SCROLLBACK_ROWS;
      return;
    }
    const atLimit = this.terminal.buffer.normal.baseY >= PTY_SCROLLBACK_ROWS;
    if (atLimit && this.normalBufferAtScrollbackLimit) this.historyTruncated = true;
    this.normalBufferAtScrollbackLimit = atLimit;
  }

  private throwIfUnavailable(): void {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error('PTY collector is disposed');
  }

  private fail(error: Error): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    this.dataOpen = false;
    this.options.onFailure(error);
  }
}

function readActiveRows(buffer: IBuffer, rows: number): RawRow[] {
  const result: RawRow[] = [];
  const viewportStart = buffer.type === 'normal' ? buffer.baseY : buffer.viewportY;
  const end = Math.min(buffer.length, viewportStart + rows);
  for (let index = 0; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const inViewport = index >= viewportStart;
    result.push({
      text: line.translateToString(true),
      isWrapped: line.isWrapped,
      region: inViewport ? 'screen' : 'scrollback',
      ...(inViewport ? { screenIndex: index - viewportStart } : {}),
    });
  }
  return result;
}

function readScreenRows(buffer: IBuffer, rows: number): RawRow[] {
  const result: RawRow[] = [];
  const start = buffer.viewportY;
  for (let offset = 0; offset < rows; offset += 1) {
    const line = buffer.getLine(start + offset);
    result.push({
      text: line?.translateToString(true) ?? '',
      isWrapped: line?.isWrapped ?? false,
      region: 'screen',
      screenIndex: offset,
    });
  }
  return result;
}

function sanitizeBuffer(input: RawRow[], screenRows: number): SanitizedBuffer {
  const rows = input.map((row) => ({ ...row }));
  const screen = Array<string>(screenRows).fill('');
  let truncated = false;
  while (rows[0]?.isWrapped) {
    rows.shift();
    truncated = true;
  }

  const scrollback: string[] = [];
  let redacted = false;
  for (let index = 0; index < rows.length; ) {
    const group = [rows[index]];
    index += 1;
    while (index < rows.length && rows[index].isWrapped) {
      group.push(rows[index]);
      index += 1;
    }
    const rawLogicalLine = group.map((row) => row.text).join('');
    const secret = redactSecrets(rawLogicalLine) !== rawLogicalLine;
    const scrollbackRows = group.filter((row) => row.region === 'scrollback');
    const screenGroup = group.filter((row) => row.region === 'screen');
    if (secret) {
      redacted = true;
      if (scrollbackRows.length > 0) scrollback.push(REDACTED_MARKER);
      const firstScreen = screenGroup[0]?.screenIndex;
      if (firstScreen !== undefined) screen[firstScreen] = REDACTED_MARKER;
      continue;
    }
    if (scrollbackRows.length > 0) {
      scrollback.push(scrollbackRows.map((row) => row.text).join(''));
    }
    for (const row of screenGroup) {
      if (row.screenIndex !== undefined) screen[row.screenIndex] = row.text;
    }
  }

  while (screen.at(-1) === '') screen.pop();
  let screenText = screen.join('\n');
  let scrollbackText = scrollback.join('\n');
  const complete =
    scrollbackText && screenText
      ? `${scrollbackText}\n${screenText}`
      : scrollbackText || screenText;
  if (redactSecrets(complete) !== complete) {
    screenText = REDACTED_MARKER;
    scrollbackText = '';
    redacted = true;
  }
  return { screen: screenText, scrollback: scrollbackText, truncated, redacted };
}

function blankPtyOutput(cols: number, rows: number): PtyShellOutput {
  return {
    mode: 'pty',
    screen: '',
    scrollback: '',
    cols,
    rows,
    cursor: { x: 0, y: 0, visible: true },
    alternateScreen: false,
    truncated: false,
    redacted: false,
  };
}

function flatParams(params: (number | number[])[]): number[] {
  return params.flatMap((value) => (typeof value === 'number' ? [value] : value));
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(`${fallback}: ${String(error)}`);
}
