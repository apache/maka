/**
 * Codex-compatible ApplyPatch parse + in-memory apply (#1552 / #1383).
 *
 * Per-run editing protocol projection belongs to the normalized product-tool
 * policy. Tool builders bind implementations; the projector selects exactly
 * one of Edit/Write or ApplyPatch for a run.
 */
export type EditingProtocol = 'edit_write' | 'apply_patch';

export function isEditingProtocol(value: unknown): value is EditingProtocol {
  return value === 'edit_write' || value === 'apply_patch';
}

/**
 * Parse the MAKA_EDITING_PROTOCOL environment value. Undefined/empty means
 * "no override" (callers apply their own default); any other value must be a
 * valid protocol or the process is misconfigured. One parser for CLI, Desktop,
 * and Headless so the three hosts cannot drift.
 */
export function resolveEditingProtocolEnv(
  value: string | undefined,
  label = 'MAKA_EDITING_PROTOCOL',
): EditingProtocol | undefined {
  if (value === undefined || value === '') return undefined;
  if (isEditingProtocol(value)) return value;
  throw new Error(`${label} must be "edit_write" or "apply_patch"`);
}

/**
 * Grammar (lenient around heredoc wrappers):
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +lines...
 *   *** Delete File: <path>
 *   *** Update File: <path>
 *   *** Move to: <new path>   (optional)
 *   @@ [optional context]
 *    context / -old / +new lines
 *   *** End of File           (optional, anchors match at EOF)
 *   *** End Patch
 *
 * This module never touches the filesystem. Callers preflight and mutate
 * through WorkspaceExecutor / filesystem worker + permission boundaries.
 */

export const BEGIN_PATCH_MARKER = '*** Begin Patch';
export const END_PATCH_MARKER = '*** End Patch';
export const ADD_FILE_MARKER = '*** Add File: ';
export const DELETE_FILE_MARKER = '*** Delete File: ';
export const UPDATE_FILE_MARKER = '*** Update File: ';
export const MOVE_TO_MARKER = '*** Move to: ';
export const EOF_MARKER = '*** End of File';
export const CHANGE_CONTEXT_MARKER = '@@';

export type ApplyPatchHunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | {
      kind: 'update';
      path: string;
      movePath?: string;
      chunks: ApplyPatchUpdateChunk[];
    };

export interface ApplyPatchUpdateChunk {
  /** Optional @@ context header used to narrow the search window. */
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export interface ApplyPatchParseResult {
  hunks: ApplyPatchHunk[];
}

export type ApplyPatchParseError =
  | { code: 'invalid_patch'; message: string }
  | { code: 'invalid_hunk'; message: string; lineNumber: number };

export type ApplyPatchParseOutcome =
  | { ok: true; value: ApplyPatchParseResult }
  | { ok: false; error: ApplyPatchParseError };

export type ApplyContentError =
  | { code: 'hunk_mismatch'; message: string; path: string }
  | { code: 'empty_update'; message: string; path: string };

export type ApplyContentOutcome =
  | { ok: true; content: string }
  | { ok: false; error: ApplyContentError };

export type PlannedPatchMutation =
  | { operation: 'add'; path: string; content: string }
  | { operation: 'update'; path: string; content: string }
  | { operation: 'delete'; path: string }
  | { operation: 'move'; path: string; fromPath: string; content: string };

export type ApplyPatchPathState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly content: string }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'other' };

/**
 * Canonicalize lexical aliases before locking, permission planning, or state
 * lookup. Filesystem containment remains the host adapter's responsibility.
 */
export function canonicalizeApplyPatchHunks(hunks: readonly ApplyPatchHunk[]): ApplyPatchHunk[] {
  return hunks.map((hunk) => {
    const path = canonicalApplyPatchPath(hunk.path);
    if (hunk.kind === 'add' || hunk.kind === 'delete') return { ...hunk, path };
    return {
      ...hunk,
      path,
      ...(hunk.movePath ? { movePath: canonicalApplyPatchPath(hunk.movePath) } : {}),
    };
  });
}

export function canonicalApplyPatchPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').trim();
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/') || '.';
}

/**
 * Pure ApplyPatch planner.
 *
 * The caller snapshots every referenced directory entry under the transaction
 * locks and passes that immutable state here. Planning never touches the
 * filesystem, so Runtime and Headless cannot acquire different overwrite,
 * alias, or partial-order semantics.
 */
export function planApplyPatchMutations(
  hunks: readonly ApplyPatchHunk[],
  initialState: ReadonlyMap<string, ApplyPatchPathState>,
): PlannedPatchMutation[] {
  const state = new Map(initialState);
  const mutations: PlannedPatchMutation[] = [];

  const current = (path: string): ApplyPatchPathState => state.get(path) ?? { kind: 'missing' };
  const requireRegularFile = (path: string, operation: string): string => {
    const value = current(path);
    if (value.kind === 'missing') {
      throw new Error(`ApplyPatch ${operation} target missing: ${path}`);
    }
    if (value.kind !== 'file') {
      throw new Error(`ApplyPatch ${operation} target must be a regular file: ${path}`);
    }
    return value.content;
  };

  for (const hunk of hunks) {
    if (hunk.kind === 'add') {
      if (current(hunk.path).kind !== 'missing') {
        throw new Error(`ApplyPatch Add File target already exists: ${hunk.path}`);
      }
      mutations.push({ operation: 'add', path: hunk.path, content: hunk.contents });
      state.set(hunk.path, { kind: 'file', content: hunk.contents });
      continue;
    }

    if (hunk.kind === 'delete') {
      const value = current(hunk.path);
      if (value.kind === 'missing') {
        throw new Error(`ApplyPatch Delete File target missing: ${hunk.path}`);
      }
      if (value.kind !== 'file' && value.kind !== 'symlink') {
        throw new Error(`ApplyPatch Delete File target must be a file or symlink: ${hunk.path}`);
      }
      mutations.push({ operation: 'delete', path: hunk.path });
      state.set(hunk.path, { kind: 'missing' });
      continue;
    }

    const original = requireRegularFile(hunk.path, 'Update File');
    const applied = applyUpdateChunksToContent(original, hunk.chunks, hunk.path);
    if (!applied.ok) throw new Error(applied.error.message);

    if (hunk.movePath) {
      if (current(hunk.movePath).kind !== 'missing') {
        throw new Error(`ApplyPatch Move destination already exists: ${hunk.movePath}`);
      }
      mutations.push({
        operation: 'move',
        path: hunk.movePath,
        fromPath: hunk.path,
        content: applied.content,
      });
      state.set(hunk.path, { kind: 'missing' });
      state.set(hunk.movePath, { kind: 'file', content: applied.content });
      continue;
    }

    mutations.push({ operation: 'update', path: hunk.path, content: applied.content });
    state.set(hunk.path, { kind: 'file', content: applied.content });
  }

  return mutations;
}

export function parseApplyPatch(input: string): ApplyPatchParseOutcome {
  const trimmed = input.replace(/^\uFEFF/, '').trimEnd();
  const rawLines = trimmed.split(/\r?\n/);
  const boundary = extractPatchLines(rawLines);
  if (!boundary.ok) return boundary;

  const lines = boundary.lines;
  const hunks: ApplyPatchHunk[] = [];
  let i = 1; // skip Begin Patch

  while (i < lines.length - 1) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    if (line.startsWith(ADD_FILE_MARKER)) {
      const path = line.slice(ADD_FILE_MARKER.length).trim();
      if (!path) {
        return invalidHunk('Add File header is missing a path', lineNumber);
      }
      i += 1;
      const contentLines: string[] = [];
      while (i < lines.length - 1 && lines[i]!.startsWith('+')) {
        contentLines.push(lines[i]!.slice(1));
        i += 1;
      }
      if (contentLines.length === 0) {
        return invalidHunk('Add File must include at least one + content line', lineNumber);
      }
      hunks.push({ kind: 'add', path, contents: contentLines.join('\n') + '\n' });
      continue;
    }

    if (line.startsWith(DELETE_FILE_MARKER)) {
      const path = line.slice(DELETE_FILE_MARKER.length).trim();
      if (!path) {
        return invalidHunk('Delete File header is missing a path', lineNumber);
      }
      hunks.push({ kind: 'delete', path });
      i += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_MARKER)) {
      const path = line.slice(UPDATE_FILE_MARKER.length).trim();
      if (!path) {
        return invalidHunk('Update File header is missing a path', lineNumber);
      }
      i += 1;
      let movePath: string | undefined;
      if (i < lines.length - 1 && lines[i]!.startsWith(MOVE_TO_MARKER)) {
        movePath = lines[i]!.slice(MOVE_TO_MARKER.length).trim();
        if (!movePath) {
          return invalidHunk('Move to header is missing a path', i + 1);
        }
        i += 1;
      }
      const chunks: ApplyPatchUpdateChunk[] = [];
      while (i < lines.length - 1 && !isFileOpHeader(lines[i]!)) {
        if (
          lines[i] === CHANGE_CONTEXT_MARKER ||
          lines[i]!.startsWith(`${CHANGE_CONTEXT_MARKER} `)
        ) {
          const changeContext =
            lines[i] === CHANGE_CONTEXT_MARKER
              ? undefined
              : lines[i]!.slice(CHANGE_CONTEXT_MARKER.length + 1);
          i += 1;
          const chunkResult = readChunkBody(lines, i, lines.length - 1);
          if (!chunkResult.ok) return chunkResult;
          i = chunkResult.nextIndex;
          chunks.push({
            ...(changeContext !== undefined && changeContext.length > 0 ? { changeContext } : {}),
            oldLines: chunkResult.oldLines,
            newLines: chunkResult.newLines,
            isEndOfFile: chunkResult.isEndOfFile,
          });
          continue;
        }
        // Bare chunk without @@ — tolerate as a single chunk body.
        if (
          lines[i]!.startsWith(' ') ||
          lines[i]!.startsWith('-') ||
          lines[i]!.startsWith('+') ||
          lines[i] === EOF_MARKER
        ) {
          const chunkResult = readChunkBody(lines, i, lines.length - 1);
          if (!chunkResult.ok) return chunkResult;
          i = chunkResult.nextIndex;
          chunks.push({
            oldLines: chunkResult.oldLines,
            newLines: chunkResult.newLines,
            isEndOfFile: chunkResult.isEndOfFile,
          });
          continue;
        }
        return invalidHunk(`Unexpected line in Update File: ${lines[i]}`, i + 1);
      }
      if (chunks.length === 0 && !movePath) {
        return invalidHunk('Update File must include at least one hunk or Move to', lineNumber);
      }
      hunks.push({
        kind: 'update',
        path,
        ...(movePath ? { movePath } : {}),
        chunks,
      });
      continue;
    }

    return invalidHunk(`Expected a file operation header, got: ${line}`, lineNumber);
  }

  if (hunks.length === 0) {
    return {
      ok: false,
      error: { code: 'invalid_patch', message: 'Patch contains no file operations' },
    };
  }

  return {
    ok: true,
    value: {
      hunks,
    },
  };
}

/**
 * Reject absolute paths and `..` escapes in patch path strings (lexical check).
 * Resolved containment still happens at the tool/worker layer.
 */
export function assertSafePatchPath(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').trim();
  if (!normalized) return 'path is empty';
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return 'path must be relative (absolute paths are rejected)';
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    return 'path must not contain parent-directory segments (..)';
  }
  return null;
}

/** Apply update chunks to file text, preserving the original newline style. */
export function applyUpdateChunksToContent(
  original: string,
  chunks: readonly ApplyPatchUpdateChunk[],
  path: string,
): ApplyContentOutcome {
  if (chunks.length === 0) {
    return { ok: true, content: original };
  }

  // Preserve CR-only, CRLF, LF, and mixed endings outside the edited region by
  // carrying each original line's terminator through untouched lines.
  const originalLines = splitContentLinesWithEnds(original);
  let bodies = originalLines.map((line) => line.body);
  let endings = originalLines.map((line) => line.ending);
  const defaultEnding = detectDefaultLineEnding(original);

  for (const chunk of chunks) {
    const match = findChunkMatch(bodies, chunk);
    if (!match) {
      return {
        ok: false,
        error: {
          code: 'hunk_mismatch',
          path,
          message: `ApplyPatch hunk did not match in ${path}${
            chunk.changeContext ? ` (context ${JSON.stringify(chunk.changeContext)})` : ''
          }`,
        },
      };
    }
    const removedEnds = endings.slice(match.start, match.end);
    const insertedEnds = chunk.newLines.map((_, index) => {
      if (index < chunk.newLines.length - 1) return defaultEnding;
      if (removedEnds.length > 0) return removedEnds.at(-1) === '' ? '' : defaultEnding;
      if (match.start < bodies.length) return defaultEnding;
      return endings.at(-1) ? defaultEnding : '';
    });
    // Appending to a file without an EOF newline still needs a separator
    // between the former last line and the first inserted line. The inserted
    // last line itself keeps the file's no-EOF-newline state.
    if (
      match.start === bodies.length &&
      match.end === bodies.length &&
      chunk.newLines.length > 0 &&
      bodies.length > 0 &&
      endings.at(-1) === ''
    ) {
      endings[endings.length - 1] = defaultEnding;
    }
    bodies = [...bodies.slice(0, match.start), ...chunk.newLines, ...bodies.slice(match.end)];
    endings = [...endings.slice(0, match.start), ...insertedEnds, ...endings.slice(match.end)];
  }

  return {
    ok: true,
    content: bodies.map((body, index) => body + (endings[index] ?? '')).join(''),
  };
}

export function collectPatchPaths(hunks: readonly ApplyPatchHunk[]): string[] {
  const paths: string[] = [];
  for (const hunk of hunks) {
    paths.push(hunk.path);
    if (hunk.kind === 'update' && hunk.movePath) paths.push(hunk.movePath);
  }
  return paths;
}

// ── internals ──────────────────────────────────────────────────────────────

function extractPatchLines(
  lines: string[],
): { ok: true; lines: string[] } | { ok: false; error: ApplyPatchParseError } {
  const strict = checkBoundariesStrict(lines);
  if (strict.ok) return strict;

  // Lenient: strip heredoc wrappers (<<EOF / <<'EOF' / <<"EOF" … EOF).
  if (lines.length >= 4) {
    const first = lines[0]!.trim();
    const last = lines[lines.length - 1]!.trim();
    if ((first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith('EOF')) {
      return checkBoundariesStrict(lines.slice(1, -1));
    }
  }
  return strict;
}

function checkBoundariesStrict(
  lines: string[],
): { ok: true; lines: string[] } | { ok: false; error: ApplyPatchParseError } {
  if (lines.length < 2) {
    return {
      ok: false,
      error: {
        code: 'invalid_patch',
        message: `Patch must start with ${BEGIN_PATCH_MARKER} and end with ${END_PATCH_MARKER}`,
      },
    };
  }
  if (lines[0]!.trim() !== BEGIN_PATCH_MARKER) {
    return {
      ok: false,
      error: {
        code: 'invalid_patch',
        message: `Patch must start with ${BEGIN_PATCH_MARKER}`,
      },
    };
  }
  if (lines[lines.length - 1]!.trim() !== END_PATCH_MARKER) {
    return {
      ok: false,
      error: {
        code: 'invalid_patch',
        message: `Patch must end with ${END_PATCH_MARKER}`,
      },
    };
  }
  return { ok: true, lines };
}

function isFileOpHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE_MARKER) ||
    line.startsWith(DELETE_FILE_MARKER) ||
    line.startsWith(UPDATE_FILE_MARKER)
  );
}

function readChunkBody(
  lines: string[],
  start: number,
  endExclusive: number,
):
  | {
      ok: true;
      nextIndex: number;
      oldLines: string[];
      newLines: string[];
      isEndOfFile: boolean;
    }
  | { ok: false; error: ApplyPatchParseError } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let i = start;
  let isEndOfFile = false;

  while (i < endExclusive) {
    const line = lines[i]!;
    if (
      line === CHANGE_CONTEXT_MARKER ||
      line.startsWith(`${CHANGE_CONTEXT_MARKER} `) ||
      isFileOpHeader(line)
    ) {
      break;
    }
    if (line === EOF_MARKER) {
      isEndOfFile = true;
      i += 1;
      break;
    }
    const prefix = line[0];
    if (prefix === ' ') {
      const text = line.slice(1);
      oldLines.push(text);
      newLines.push(text);
      i += 1;
      continue;
    }
    if (prefix === '-') {
      oldLines.push(line.slice(1));
      i += 1;
      continue;
    }
    if (prefix === '+') {
      newLines.push(line.slice(1));
      i += 1;
      continue;
    }
    return invalidHunk(`Invalid hunk line (expected ' ', '-', or '+'): ${line}`, i + 1);
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    return invalidHunk('Update hunk is empty', start + 1);
  }

  return { ok: true, nextIndex: i, oldLines, newLines, isEndOfFile };
}

function detectDefaultLineEnding(content: string): string {
  if (content.includes('\r\n')) return '\r\n';
  if (content.includes('\r') && !content.includes('\n')) return '\r';
  return '\n';
}

/** Split content into bodies + original line terminators (preserves mixed endings). */
function splitContentLinesWithEnds(content: string): Array<{ body: string; ending: string }> {
  if (content.length === 0) return [];
  const lines: Array<{ body: string; ending: string }> = [];
  let body = '';
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    if (ch === '\r') {
      if (content[i + 1] === '\n') {
        lines.push({ body, ending: '\r\n' });
        body = '';
        i += 1;
      } else {
        lines.push({ body, ending: '\r' });
        body = '';
      }
      continue;
    }
    if (ch === '\n') {
      lines.push({ body, ending: '\n' });
      body = '';
      continue;
    }
    body += ch;
  }
  if (body.length > 0) {
    lines.push({ body, ending: '' });
  }
  return lines;
}

function findChunkMatch(
  lines: readonly string[],
  chunk: ApplyPatchUpdateChunk,
): { start: number; end: number } | null {
  let searchFrom = 0;
  if (chunk.changeContext) {
    const ctxIndex = findContextLine(lines, chunk.changeContext);
    if (ctxIndex < 0) {
      // A substring-only (or absent) context never anchors a pure addition:
      // Codex places it at EOF instead of an arbitrary substring position.
      if (chunk.oldLines.length === 0) {
        return { start: lines.length, end: lines.length };
      }
      return null;
    }
    searchFrom = ctxIndex;
  }

  const old = chunk.oldLines;
  if (old.length === 0) {
    // Codex pure-insertion: EOF marker or no context → insert at EOF.
    // With @@ context only, insert immediately after the context line — but
    // only when the context is a real line match. A substring-only context
    // must never anchor the insertion at an arbitrary position, so it falls
    // back to EOF exactly like Codex's pure-addition behavior.
    if (chunk.isEndOfFile || !chunk.changeContext) {
      return { start: lines.length, end: lines.length };
    }
    return { start: searchFrom + 1, end: searchFrom + 1 };
  }

  const candidates: number[] = [];
  for (let i = searchFrom; i <= lines.length - old.length; i += 1) {
    let matched = true;
    for (let j = 0; j < old.length; j += 1) {
      if (lines[i + j] !== old[j]) {
        matched = false;
        break;
      }
    }
    if (matched) candidates.push(i);
  }

  if (candidates.length === 0) {
    // Line-trimmed fallback (indentation drift), only when unique.
    const trimmedOld = old.map((line) => line.trimEnd());
    for (let i = searchFrom; i <= lines.length - old.length; i += 1) {
      let matched = true;
      for (let j = 0; j < old.length; j += 1) {
        if (lines[i + j]!.trimEnd() !== trimmedOld[j]) {
          matched = false;
          break;
        }
      }
      if (matched) candidates.push(i);
    }
  }

  if (candidates.length !== 1) return null;

  const start = candidates[0]!;
  const end = start + old.length;
  if (chunk.isEndOfFile && end !== lines.length) return null;
  return { start, end };
}

/**
 * Locate the `@@` context as a whole line (Codex semantics): the header names
 * a line, not a substring, so `foo` must not anchor inside `prefix foo suffix`.
 * Exact match after trimming trailing whitespace first, then a controlled
 * full-trim fallback for indentation drift. Returns -1 when no line matches.
 */
function findContextLine(lines: readonly string[], context: string): number {
  const trimmed = context.trimEnd();
  const exact = lines.findIndex((line) => line.trimEnd() === trimmed);
  if (exact >= 0) return exact;
  const fullyTrimmed = context.trim();
  return lines.findIndex((line) => line.trim() === fullyTrimmed);
}

function invalidHunk(
  message: string,
  lineNumber: number,
): { ok: false; error: ApplyPatchParseError } {
  return { ok: false, error: { code: 'invalid_hunk', message, lineNumber } };
}
