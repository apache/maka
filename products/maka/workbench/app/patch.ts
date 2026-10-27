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

// Unified diff text from `gitDiff`, as the rows the Changes view draws.

export type PatchRow =
  | { kind: 'meta' | 'hunk'; text: string }
  | { kind: 'context'; text: string; old: number; new: number }
  | { kind: 'added'; text: string; old: null; new: number }
  | { kind: 'removed'; text: string; old: number; new: null };

/** `text` with each tab replaced by the spaces to the next multiple of 4 columns. */
function expandTabs(value: string): string {
  if (!value.includes('\t')) return value;
  let out = '';
  let column = 0;
  for (const point of value) {
    if (point === '\t') {
      const spaces = 4 - (column % 4);
      out += ' '.repeat(spaces);
      column += spaces;
    } else {
      out += point;
      column += 1;
    }
  }
  return out;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DROPPED = /^(?:diff --git |index |--- |\+\+\+ )/;

/**
 * The rows a unified diff shows, in order. Each is `{ kind, text }` with
 * `kind` one of 'meta' (the file's mode lines, as one row, and "\ No newline
 * at end of file"), 'hunk' (its header line as written), 'context', 'added'
 * or 'removed'; the last three also carry `old` and `new`, the line numbers
 * on each side (null on the side the line is not on), counted from the hunk
 * header. `diff --git`, `index`, `---` and `+++` lines are left out. Inside a
 * hunk the header's counts decide what a line is, not its first characters:
 * a removed line `-- a` arrives as `--- a`. Tabs are expanded to 4 columns.
 * Pure, with no imports, so tests run it under Node
 * (scripts/rust/workbench-patch.test.mjs).
 */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  const meta: string[] = [];
  const flush = () => {
    if (meta.length > 0) rows.push({ kind: 'meta', text: meta.join(' · ') });
    meta.length = 0;
  };
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft + newLeft > 0) {
      const first = line[0];
      if (first === '\\') {
        rows.push({ kind: 'meta', text: line });
      } else if (first === '-') {
        rows.push({ kind: 'removed', old: oldLine, new: null, text: expandTabs(line.slice(1)) });
        oldLine += 1;
        oldLeft = Math.max(0, oldLeft - 1);
      } else if (first === '+') {
        rows.push({ kind: 'added', old: null, new: newLine, text: expandTabs(line.slice(1)) });
        newLine += 1;
        newLeft = Math.max(0, newLeft - 1);
      } else {
        // A context line; some generators write an empty one bare.
        rows.push({ kind: 'context', old: oldLine, new: newLine, text: expandTabs(line.slice(1)) });
        oldLine += 1;
        newLine += 1;
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      flush();
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('\\')) {
      flush();
      rows.push({ kind: 'meta', text: line });
    } else if (line !== '' && !DROPPED.test(line)) {
      // `new file mode`, `deleted file mode`, `old mode` and `new mode`.
      meta.push(line);
    }
  }
  flush();
  return rows;
}
