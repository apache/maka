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

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Terminal } from '@earendil-works/pi-tui';

export class FakeTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;
  readonly progressStates: boolean[] = [];
  readonly writes: string[] = [];
  readonly titles: string[] = [];
  stopCalls = 0;
  // Index into `writes` at the moment `start()` (raw mode) ran. Anything written
  // before this went out while the terminal was still in cooked mode. Null until
  // start() is called.
  startWriteIndex: number | null = null;
  private onInput: ((data: string) => void) | null = null;
  private onResize: (() => void) | null = null;

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.startWriteIndex = this.writes.length;
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  drainInput(): Promise<void> {
    return Promise.resolve();
  }

  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}

  setTitle(title: string): void {
    this.titles.push(title);
  }

  setProgress(active: boolean): void {
    this.progressStates.push(active);
  }

  input(data: string): void {
    this.onInput?.(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }

  output(): string {
    return this.writes.join('');
  }

  screenOutput(): string {
    return renderTerminalScreen(this.writes, this.rows);
  }
}

export function plainTerminalOutput(output: string): string {
  return output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_pi:c\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function findInputSurfaceRows(lines: readonly string[]): [number, number] | undefined {
  const editorBorderIndexes = lines
    .map((line, index) => (/^─+$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (editorBorderIndexes.length < 2) return undefined;
  return [
    editorBorderIndexes[editorBorderIndexes.length - 2]!,
    editorBorderIndexes[editorBorderIndexes.length - 1]!,
  ];
}

export function inputSurfaceRows(lines: readonly string[]): [number, number] {
  const rows = findInputSurfaceRows(lines);
  assert.ok(rows, 'expected a settled input surface with top and bottom editor borders');
  return rows;
}

/**
 * The slash-autocomplete suggestion rows on the input surface: the contiguous
 * `/command` lines sitting immediately above the editor's top border. The
 * empty-session home also renders `/session `/model `/setup as hint text
 * (#1098), so autocomplete assertions scope here instead of grepping the whole
 * screen, which would pick up the home's hints and misorder them against the
 * menu. Returns an empty list until the autocomplete menu is open (its → cursor
 * is absent from the home) so this is safe to call inside a polling waitFor.
 */
export function autocompleteSuggestionLines(lines: readonly string[]): readonly string[] {
  if (!lines.some((line) => line.includes('→'))) return [];
  const inputRows = findInputSurfaceRows(lines);
  if (!inputRows) return [];
  const [editorTopBorder] = inputRows;
  const end = /^\s*\(\d+\/\d+\)\s*$/.test(lines[editorTopBorder - 1] ?? '')
    ? editorTopBorder - 1
    : editorTopBorder;
  let start = end;
  while (start > 0 && /\/\w/.test(lines[start - 1]!)) start -= 1;
  return lines.slice(start, end);
}

export function assertBottomPickerPlacement(
  terminal: FakeTerminal,
  title: string,
  statusText: string,
): void {
  const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => line.includes(title));
  const statusLineIndex = lines.findIndex((line) => line.includes(statusText));
  const [topEditorBorderIndex, bottomEditorBorderIndex] = inputSurfaceRows(lines);

  assert.ok(titleIndex > 0);
  assert.ok(titleIndex < topEditorBorderIndex);
  assert.equal(bottomEditorBorderIndex, terminal.rows - 2);
  assert.equal(statusLineIndex, terminal.rows - 1);
}

export function latestPlainLineContaining(output: string, text: string): string {
  const line = plainTerminalOutput(output)
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.includes(text));
  assert.ok(line, `Expected terminal output to contain ${text}`);
  return line;
}

// A passing wait returns the moment the predicate turns true, so the budget
// below only bounds how long a FAILING assertion takes to report. 250ms kept
// local red runs snappy but lost races on loaded CI runners (#2221: a
// docs-only PR failed test_workspaces at 262ms); CI pays a bigger budget
// because a red test there costs one report, while a false red costs every
// reader a log dive. MAKA_TEST_WAIT_BUDGET_MS overrides both.
export const WAIT_BUDGET_MS =
  Number(process.env.MAKA_TEST_WAIT_BUDGET_MS ?? '') || (process.env.CI ? 5_000 : 250);

/** Resolves once the TUI is in raw mode and has painted its first frame, so
 *  typed input reaches a mounted editor instead of racing runner startup. */
export async function waitForTuiPaint(terminal: FakeTerminal): Promise<void> {
  await waitFor(
    () => terminal.startWriteIndex !== null && terminal.writes.length > terminal.startWriteIndex,
    'the first TUI paint after raw-mode start',
  );
}

export async function waitFor(predicate: () => boolean, description?: string): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.equal(
    predicate(),
    true,
    `waited ${WAIT_BUDGET_MS}ms for ${description ?? 'a predicate that never became true'}`,
  );
}

function renderTerminalScreen(writes: readonly string[], rows: number): string {
  const screen: string[] = [];
  let row = 0;
  let col = 0;

  const ensureRow = () => {
    while (screen.length <= row) screen.push('');
  };

  const writeText = (text: string) => {
    ensureRow();
    const line = screen[row] ?? '';
    screen[row] = `${line.slice(0, col)}${text}${line.slice(col + text.length)}`;
    col += text.length;
  };

  for (const write of writes) {
    for (let index = 0; index < write.length; ) {
      const char = write[index]!;
      if (char === '\x1b') {
        index = consumeEscapeSequence(write, index, {
          clearScreen: () => {
            screen.length = 0;
            row = 0;
            col = 0;
          },
          clearLine: () => {
            ensureRow();
            screen[row] = '';
          },
          moveTo: (nextRow, nextCol) => {
            row = Math.max(0, nextRow);
            col = Math.max(0, nextCol);
          },
          moveBy: (rowDelta, colDelta) => {
            row = Math.max(0, row + rowDelta);
            col = Math.max(0, col + colDelta);
          },
          moveCol: (nextCol) => {
            col = Math.max(0, nextCol);
          },
        });
        continue;
      }
      if (char === '\r') {
        col = 0;
        index += 1;
        continue;
      }
      if (char === '\n') {
        row += 1;
        col = 0;
        index += 1;
        continue;
      }
      writeText(char);
      index += 1;
    }
  }

  while (screen.length < rows) screen.push('');
  return screen.slice(Math.max(0, screen.length - rows)).join('\n');
}

interface ScreenEscapeActions {
  clearScreen(): void;
  clearLine(): void;
  moveTo(row: number, col: number): void;
  moveBy(rowDelta: number, colDelta: number): void;
  moveCol(col: number): void;
}

function consumeEscapeSequence(input: string, index: number, actions: ScreenEscapeActions): number {
  const kind = input[index + 1];
  if (kind === '[') {
    const finalIndex = findCsiFinalIndex(input, index + 2);
    if (finalIndex < 0) return input.length;
    const params = input.slice(index + 2, finalIndex);
    applyCsiSequence(params, input[finalIndex]!, actions);
    return finalIndex + 1;
  }
  if (kind === ']') return skipUntilTerminator(input, index + 2);
  if (kind === '_' || kind === 'P') return skipUntilTerminator(input, index + 2);
  return index + 2;
}

function findCsiFinalIndex(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function skipUntilTerminator(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === '\x07') return index + 1;
    if (input[index] === '\x1b' && input[index + 1] === '\\') return index + 2;
  }
  return input.length;
}

function applyCsiSequence(params: string, final: string, actions: ScreenEscapeActions): void {
  const values = parseCsiValues(params);
  const first = values[0] ?? 1;
  if (final === 'A') actions.moveBy(-first, 0);
  if (final === 'B') actions.moveBy(first, 0);
  if (final === 'C') actions.moveBy(0, first);
  if (final === 'D') actions.moveBy(0, -first);
  if (final === 'G') actions.moveCol(first - 1);
  if (final === 'H' || final === 'f') actions.moveTo((values[0] ?? 1) - 1, (values[1] ?? 1) - 1);
  if (final === 'J' && (values[0] === 2 || values[0] === 3)) actions.clearScreen();
  if (final === 'K' && (values[0] ?? 0) === 2) actions.clearLine();
}

function parseCsiValues(params: string): number[] {
  return params
    .replace(/^\?/, '')
    .split(';')
    .filter((part) => /^\d+$/.test(part))
    .map((part) => Number(part));
}
