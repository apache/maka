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
// is laid out in pieces of 200 lines, and a line too wide for one layer is cut.
// Both stay well under the limit at 2x. Copy buttons still copy the whole text.
export const pieceLines = 200;
export const lineColumns = 800;

export type CodePiece = { index: number; text: string; gutter?: string | undefined };

// Wide characters (East Asian, emoji) take two columns in a monospace font.
const width = (char: string) => (char.codePointAt(0)! >= 0x1100 ? 2 : 1);

function cut(line: string) {
  // A line of this many code units cannot be wider than the limit.
  if (line.length <= lineColumns / 2) return line;
  let used = 0;
  let end = 0;
  for (const char of line) {
    used += width(char);
    if (used > lineColumns) break;
    end += char.length;
  }
  if (end === line.length) return line;
  const rest = [...line.slice(end)].length;
  return `${line.slice(0, end)} ${tr('… {count} more characters', { count: String(rest) })}`;
}

export function codePieces(text: string, gutter?: string): CodePiece[] {
  const lines = text.split('\n').map(cut);
  if (lines.length <= pieceLines) return [{ index: 0, text: lines.join('\n'), gutter }];
  // Numbers padded to one width keep every piece's text in one column.
  const split = gutter?.split('\n');
  const digits = Math.max(0, ...(split ?? []).map((mark) => mark.length));
  const marks = split?.map((mark) => mark.padStart(digits));
  const pieces: CodePiece[] = [];
  for (let start = 0; start < lines.length; start += pieceLines)
    pieces.push({
      index: pieces.length,
      text: lines
        .slice(start, start + pieceLines)
        // A text drops an empty first or last line; a space keeps its height.
        .map((line, at, all) => (line === '' && (at === 0 || at === all.length - 1) ? ' ' : line))
        .join('\n'),
      gutter: marks?.slice(start, start + pieceLines).join('\n'),
    });
  return pieces;
}
