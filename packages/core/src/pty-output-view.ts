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

import type { PtyShellOutput } from './shell-run.js';

export function ptyHumanTerminalText(output: PtyShellOutput): string {
  const current = output.alternateScreen
    ? output.screen
    : joinNonEmpty(output.scrollback, output.screen);
  return current.trim().length > 0 ? current : (output.lastAlternateScreen ?? '');
}

export function ptyTuiTerminalRows(output: PtyShellOutput, maxRows = 6): string[] {
  return ptyTuiTerminalView(output, maxRows).rows;
}

export interface PtyTuiTerminalView {
  rows: string[];
  rowsOmitted: boolean;
}

export function ptyTuiTerminalView(output: PtyShellOutput, maxRows = 6): PtyTuiTerminalView {
  const limit = Math.max(0, Math.trunc(maxRows));
  if (limit === 0) {
    return {
      rows: [],
      rowsOmitted: Boolean(output.screen || output.scrollback || output.lastAlternateScreen),
    };
  }
  let screen = textRows(output.screen);
  const scrollback = output.alternateScreen ? [] : textRows(output.scrollback);
  if (screen.length === 0 && scrollback.length === 0 && output.lastAlternateScreen) {
    screen = textRows(output.lastAlternateScreen);
  }
  if (screen.length >= limit) {
    return {
      rows: edgeRows(screen, limit),
      rowsOmitted: screen.length > limit || scrollback.length > 0,
    };
  }
  const scrollbackRows = Math.min(scrollback.length, limit - screen.length);
  return {
    rows: [...scrollback.slice(-scrollbackRows), ...screen],
    rowsOmitted: scrollback.length > scrollbackRows,
  };
}

export function ptyCompactTerminalLine(output: PtyShellOutput): string | undefined {
  const screen = textRows(output.screen);
  if (output.cursor.visible) {
    const cursor = Math.min(output.cursor.y, Math.max(0, screen.length - 1));
    if (nonEmpty(screen[cursor])) return screen[cursor].trim();
    for (let index = cursor - 1; index >= 0; index -= 1) {
      if (nonEmpty(screen[index])) return screen[index].trim();
    }
  }
  return (
    lastNonEmpty(screen) ??
    lastNonEmpty(textRows(output.scrollback)) ??
    lastNonEmpty(textRows(output.lastAlternateScreen ?? ''))
  );
}

function edgeRows(rows: string[], limit: number): string[] {
  if (rows.length <= limit) return rows;
  const head = Math.ceil(limit / 2);
  return [...rows.slice(0, head), ...rows.slice(-(limit - head))];
}

function textRows(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

function lastNonEmpty(rows: readonly string[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (nonEmpty(rows[index])) return rows[index].trim();
  }
  return undefined;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function joinNonEmpty(first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  return `${first}\n${second}`;
}
