/**
 * Codex-compatible ApplyPatch parse + in-memory apply (#1552 / #1383).
 *
 * Per-run editing protocol projection: hosts pass this into tool builders so
 * exactly one of Edit/Write or ApplyPatch appears on the effective surface.
 */
export type EditingProtocol = 'edit_write' | 'apply_patch';

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
  /** Canonical patch text (without heredoc wrappers). */
  patch: string;
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

export interface PlannedPatchMutation {
  operation: 'add' | 'update' | 'delete' | 'move';
  /** Source path for update/delete; destination for pure add. */
  path: string;
  /** Present for move (update + Move to). */
  fromPath?: string;
  /** Final content after update/add; absent for delete. */
  content?: string;
  /** Absolute or caller-resolved path keys are filled by the tool layer. */
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
      patch: lines.join('\n') + (trimmed.endsWith('\n') ? '\n' : ''),
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
  const hadTrailingNewline =
    original.length > 0 && (original.endsWith('\n') || original.endsWith('\r'));
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
    const insertedEnds = chunk.newLines.map(() => defaultEnding);
    bodies = [...bodies.slice(0, match.start), ...chunk.newLines, ...bodies.slice(match.end)];
    endings = [...endings.slice(0, match.start), ...insertedEnds, ...endings.slice(match.end)];
  }

  let content = '';
  for (let i = 0; i < bodies.length; i += 1) {
    content += bodies[i]!;
    const isLast = i === bodies.length - 1;
    const ending = endings[i] ?? '';
    if (!isLast) {
      content += ending || defaultEnding;
    } else if (hadTrailingNewline) {
      content += ending || defaultEnding;
    } else if (ending) {
      // Last original line had no terminator; keep that for untouched last line.
      // For replaced/inserted last lines, only add a terminator when the original
      // file used trailing newlines (handled above).
    }
  }
  return { ok: true, content };
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
    const ctxIndex = lines.findIndex((line) => line.includes(chunk.changeContext!));
    if (ctxIndex < 0) return null;
    searchFrom = ctxIndex;
  }

  const old = chunk.oldLines;
  if (old.length === 0) {
    // Codex pure-insertion: EOF marker or no context → insert at EOF.
    // With @@ context only, insert immediately after the context line.
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

function invalidHunk(
  message: string,
  lineNumber: number,
): { ok: false; error: ApplyPatchParseError } {
  return { ok: false, error: { code: 'invalid_hunk', message, lineNumber } };
}
