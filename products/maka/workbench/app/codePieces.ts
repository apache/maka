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

import { tr } from './locale';

// macOS draws each text into one Core Animation layer, and a layer taller or
// wider than the GPU's largest texture (16384 pixels) shows nothing. Code text
// is laid out in pieces of 200 lines, and a line too wide for one layer is cut,
// its note on what was cut included. The budget holds for the widest code text
// the desktop shows: 13 pt at the largest text size on a 2x display, where one
// monospace column measures about 20.9 pixels. 720 columns are about 15,050
// pixels wide, and 200 lines are 10,400 pixels tall. Copy buttons still copy
// the whole text.
//
// Wrapped text is as wide as its column, so only its height counts: a piece
// holds about 200 shown rows, a line counting the rows it takes at a narrow
// column, and a line is cut where it would take more than 100 of them.
export const largestTextSize = 1.3;
export const pieceLines = 200;
export const lineColumns = 720;
export const narrowColumns = 30;
export const wrappedLineColumns = narrowColumns * 100;

export type CodePiece = { index: number; text: string; gutter?: string | undefined };

// Measured at that size: East Asian characters take up to 1.6 columns, and
// emoji and symbols such as ✅ take 2.2.
const pictograph = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const width = (char: string) =>
  pictograph.test(char) ? 3 : char.codePointAt(0)! >= 0x1100 ? 2 : 1;
export const columns = (text: string) => {
  let total = 0;
  for (const char of text) total += width(char);
  return total;
};
const note = (count: number) => ` ${tr('… {count} more characters', { count: String(count) })}`;

function cut(line: string, limit: number) {
  // Each code unit takes at most three columns.
  if (line.length * 3 <= limit || columns(line) <= limit) return line;
  // The note's count has no more digits than the line's length.
  const room = limit - columns(note(line.length));
  let used = 0;
  let end = 0;
  for (const char of line) {
    used += width(char);
    if (used > room) break;
    end += char.length;
  }
  return `${line.slice(0, end)}${note([...line.slice(end)].length)}`;
}

export function codePieces(text: string, gutter?: string, wrap = false): CodePiece[] {
  const limit = wrap ? wrappedLineColumns : lineColumns;
  const lines = text.split('\n').map((line) => cut(line, limit));
  const rows = (line: string) => (wrap ? Math.max(1, Math.ceil(columns(line) / narrowColumns)) : 1);
  const total = wrap ? lines.reduce((sum, line) => sum + rows(line), 0) : lines.length;
  if (total <= pieceLines) return [{ index: 0, text: lines.join('\n'), gutter }];
  // Numbers padded to one width keep every piece's text in one column.
  const split = gutter?.split('\n');
  const digits = Math.max(0, ...(split ?? []).map((mark) => mark.length));
  const marks = split?.map((mark) => mark.padStart(digits));
  const pieces: CodePiece[] = [];
  const close = (start: number, end: number) =>
    pieces.push({
      index: pieces.length,
      text: lines
        .slice(start, end)
        // A text drops an empty first or last line; a space keeps its height.
        .map((line, at, all) => (line === '' && (at === 0 || at === all.length - 1) ? ' ' : line))
        .join('\n'),
      gutter: marks?.slice(start, end).join('\n'),
    });
  let start = 0;
  let used = 0;
  lines.forEach((line, index) => {
    if (used > 0 && used + rows(line) > pieceLines) {
      close(start, index);
      start = index;
      used = 0;
    }
    used += rows(line);
  });
  close(start, lines.length);
  return pieces;
}
