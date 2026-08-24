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
 * Structural parser for unified diffs, shared by every surface that reads one:
 * the desktop diff panel (line-number gutter), the tool-row +/- badges, the
 * TUI transcript, and the model-facing result summaries.
 *
 * The parse is driven by the declared hunk counts, not per-line heuristics:
 * inside a hunk body the first character is the marker, however header-like
 * the rest of the line looks — the deletion of a SQL `-- a` comment arrives
 * as `--- a`, and an added `++i` as `+++i`. Prefix matching cannot tell those
 * from file headers; the hunk counts can.
 *
 * Pure and dependency-free, like `tool-quiet-preview.ts` — the packages that
 * consume it (ui, cli, runtime) must not pull React or Node builtins from
 * here.
 */

export type UnifiedDiffRowKind = 'add' | 'del' | 'ctx' | 'meta' | 'hunk';

export type UnifiedDiffRow = {
  kind: UnifiedDiffRowKind;
  /** The raw diff line, prefix included. */
  text: string;
  /** Old-side line number, set on del/ctx rows. */
  oldLine?: number;
  /** New-side line number, set on add/ctx rows. */
  newLine?: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into display rows. File headers (`---`/`+++`/`index`)
 * are structure, not content, and are omitted; `diff --git` separators and
 * `\ No newline at end of file` markers survive as unnumbered meta rows;
 * hunk headers survive as hunk rows so callers that want them (the TUI) can
 * keep them. Anything before the first hunk header — a foreign diff with no
 * structure — degrades to unnumbered meta rows.
 */
export function parseUnifiedDiffRows(diff: string): UnifiedDiffRow[] {
  const lines = diff.split('\n');
  // A trailing newline terminates the diff rather than starting an empty row.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const rows: UnifiedDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let remainingOld = 0;
  let remainingNew = 0;
  let inHunk = false;

  for (const line of lines) {
    if (inHunk && remainingOld + remainingNew > 0) {
      const marker = line.charAt(0);
      if (marker === '\\') {
        // `\ No newline at end of file` annotates the previous row without
        // consuming a line on either side.
        rows.push({ kind: 'meta', text: line });
        continue;
      }
      if (marker === '-') {
        rows.push({ kind: 'del', text: line, oldLine });
        oldLine += 1;
        remainingOld -= 1;
        continue;
      }
      if (marker === '+') {
        rows.push({ kind: 'add', text: line, newLine });
        newLine += 1;
        remainingNew -= 1;
        continue;
      }
      // ' ' context, and the bare empty line some generators emit for one.
      rows.push({ kind: 'ctx', text: line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      remainingOld -= 1;
      remainingNew -= 1;
      continue;
    }
    inHunk = false;

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      remainingOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
      remainingNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('diff ')) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      continue;
    }
    rows.push({ kind: 'meta', text: line });
  }
  return rows;
}

/** Green `+N` / red `-N` counts, from the structural parse. */
export function countDiffLineStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const row of parseUnifiedDiffRows(diff)) {
    if (row.kind === 'add') additions += 1;
    else if (row.kind === 'del') deletions += 1;
  }
  return { additions, deletions };
}
