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
 * Minimal unified-diff generator for tool results. Producing the diff at the
 * write site — where both contents are already in memory — lets the UI show
 * what actually changed without a verification read, at zero extra I/O for
 * edits. Bounded by design: anything beyond the caps returns `undefined` and
 * callers fall back to a plain summary.
 */

const MAX_DIFF_SOURCE_LINES = 800;
const MAX_DIFF_SOURCE_BYTES = 32 * 1024;
const CONTEXT_LINES = 3;

/**
 * Unified diff of `oldContent` → `newContent` for `path`, or `undefined` when
 * the content is binary-ish or too large to diff cheaply. `oldContent` is
 * `undefined` for a newly created file — the whole content renders as
 * additions under a `--- /dev/null` header.
 */
export function createUnifiedDiff(
  path: string,
  oldContent: string | undefined,
  newContent: string,
): string | undefined {
  if (isUndiffable(newContent)) return undefined;
  if (oldContent !== undefined && isUndiffable(oldContent)) return undefined;
  const oldLines = oldContent === undefined ? [] : splitLines(oldContent);
  const newLines = splitLines(newContent);
  if (oldLines.length > MAX_DIFF_SOURCE_LINES || newLines.length > MAX_DIFF_SOURCE_LINES)
    return undefined;

  const ops = diffLines(oldLines, newLines);
  if (ops.every((op) => op.kind === 'keep')) return undefined;

  const header =
    oldContent === undefined
      ? [`--- /dev/null`, `+++ b/${path}`]
      : [`--- a/${path}`, `+++ b/${path}`];
  return [...header, ...formatHunks(ops)].join('\n');
}

function isUndiffable(content: string): boolean {
  return content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_DIFF_SOURCE_BYTES;
}

function splitLines(content: string): string[] {
  const lines = content.split('\n');
  // A trailing newline terminates the last line rather than starting an empty
  // one; newline-termination differences are deliberately invisible.
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type DiffOp = { kind: 'keep' | 'del' | 'add'; oldIndex: number; newIndex: number; line: string };

/** Line-level edit script via LCS dynamic programming, bounded by the caps above. */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'keep', oldIndex: i, newIndex: j, line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: 'del', oldIndex: i, newIndex: j, line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: 'add', oldIndex: i, newIndex: j, line: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', oldIndex: i, newIndex: j, line: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'add', oldIndex: i, newIndex: j, line: newLines[j] });
    j += 1;
  }
  return ops;
}

/** Group the edit script into hunks with CONTEXT_LINES of surrounding context. */
function formatHunks(ops: DiffOp[]): string[] {
  const changed = ops.flatMap((op, index) => (op.kind === 'keep' ? [] : [index]));
  if (changed.length === 0) return [];

  const groups: Array<{ start: number; end: number }> = [];
  let start = Math.max(0, changed[0] - CONTEXT_LINES);
  let end = Math.min(ops.length - 1, changed[0] + CONTEXT_LINES);
  for (let c = 1; c < changed.length; c += 1) {
    const next = changed[c];
    if (next - end > CONTEXT_LINES * 2 + 1) {
      groups.push({ start, end });
      start = Math.max(0, next - CONTEXT_LINES);
    }
    end = Math.min(ops.length - 1, next + CONTEXT_LINES);
  }
  groups.push({ start, end });

  const out: string[] = [];
  for (const group of groups) {
    const slice = ops.slice(group.start, group.end + 1);
    const oldStart = slice[0].oldIndex + 1;
    const newStart = slice[0].newIndex + 1;
    const oldCount = slice.filter((op) => op.kind !== 'add').length;
    const newCount = slice.filter((op) => op.kind !== 'del').length;
    out.push(
      `@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`,
    );
    for (const op of slice) {
      out.push(`${op.kind === 'keep' ? ' ' : op.kind === 'del' ? '-' : '+'}${op.line}`);
    }
  }
  return out;
}
