// packages/runtime/src/tool-output.ts
//
// Shared, model-facing truncation for tool output (Bash stdout/stderr today).
//
// WHY: an unbounded tool result either floods the model's context (a chatty
// command's full output) or, worse, gets discarded outright when a hard byte
// cap is hit (the old Bash behavior threw away *all* output past 10MB, failing
// otherwise-finished work). Both hurt completion reliability. This bounds what
// the model sees to a line/byte budget, keeps the most useful slice, and tells
// the model the output was cut and how to recover the rest.
//
// This helper does not own a spill-file lifecycle. Instead the truncation
// marker points the model at portable recovery — re-run the command (only when
// it is safe to repeat) redirecting to a file, then Read/Grep that file;
// otherwise work from the kept window.
//
// ATTRIBUTION: truncateToolOutput below is adapted from opencode's
// truncate.output() (packages/opencode/src/tool/truncate.ts): same byte+line
// budget and head/tail windowing, minus the file spill + retention machinery.
// Maka adds byte-safe single-line slicing, trailing-newline handling, and the
// recovery hint above.
//
//   Source:    https://github.com/anomalyco/opencode
//   Revision:  fc80874f45a595ff6874a4d36b1090f6a64424d2
//   License:   MIT
//   Copyright: Copyright (c) 2025 opencode
//
// Scope: the adapted material only; the rest is Maka source under the
// repository Apache-2.0 license, so there is no whole-file SPDX identifier.
// See LICENSE, THIRD-PARTY COMPONENTS for the notice and the upstream chain.

export interface TruncateToolOutputOptions {
  /** Max retained lines before truncation kicks in. Default 2000. */
  maxLines?: number;
  /** Max retained UTF-8 bytes before truncation kicks in. Default 50KB. */
  maxBytes?: number;
  /**
   * Which end to KEEP. 'head' keeps the start (default, good for generic
   * output); 'tail' keeps the end (good for shell logs, where the failing
   * summary is usually last).
   */
  direction?: 'head' | 'tail';
}

export interface TruncatedToolOutput {
  /** The bounded text, including an inline truncation marker when cut. */
  content: string;
  /** Whether any content was removed. */
  truncated: boolean;
  /** How much was removed (lines or bytes — see `unit`). 0 when not truncated. */
  removed: number;
  /** What `removed` counts. */
  unit: 'lines' | 'bytes';
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

// Single recovery instruction shared by every "output was omitted" marker (the
// byte/line truncation marker here and the oversized-line drop marker in
// shell-exec). Conditioned on safety so it never encourages repeating a
// side-effecting command. Keep both "safe to re-run" and "side effects" phrasing
// — markers and their tests rely on it.
export const OUTPUT_RECOVERY_HINT =
  'If the command is safe to re-run, redirect its output to a file ' +
  '(e.g. `cmd > out.txt 2>&1`) then Read or Grep that file for the omitted portion. ' +
  'If re-running could repeat side effects, do not.';

function utf8Len(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Keep at most `maxBytes` UTF-8 bytes of a single line, from the head or tail.
 * Cutting mid-character is avoided: Buffer.toString replaces the partial
 * multi-byte sequence at the boundary with U+FFFD, which we strip.
 */
function sliceLineByBytes(line: string, maxBytes: number, keep: 'head' | 'tail'): string {
  if (utf8Len(line) <= maxBytes) return line;
  // One UTF-16 unit needs at least one UTF-8 byte. The extra unit keeps a
  // surrogate pair crossing the window boundary outside the retained bytes.
  // Preserve Buffer.subarray's original behavior for unusual numeric budgets.
  const window =
    Number.isInteger(maxBytes) && maxBytes >= 0
      ? keep === 'head'
        ? line.slice(0, maxBytes + 1)
        : line.slice(-(maxBytes + 1))
      : line;
  const buf = Buffer.from(window, 'utf8');
  const slice = keep === 'head' ? buf.subarray(0, maxBytes) : buf.subarray(buf.length - maxBytes);
  const decoded = slice.toString('utf8');
  return keep === 'head' ? decoded.replace(/�+$/, '') : decoded.replace(/^�+/, '');
}

/**
 * Bound `text` to a line/byte budget for inclusion in a tool result the model
 * reads. Returns the text unchanged when it already fits. When it does not, the
 * kept window (head or tail) is returned with an inline marker naming how much
 * was dropped and how to recover the omitted portion.
 */
export function truncateToolOutput(
  text: string,
  options: TruncateToolOutputOptions = {},
): TruncatedToolOutput {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const direction = options.direction ?? 'head';

  const totalBytes = utf8Len(text);
  // A single trailing newline terminates the last line; it is not an extra
  // empty line, so it must not count against the line budget.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  let lineCount = 1;
  for (let index = body.indexOf('\n'); index !== -1; index = body.indexOf('\n', index + 1)) {
    lineCount++;
  }
  if (lineCount <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false, removed: 0, unit: 'lines' };
  }

  const out: string[] = [];
  let bytes = 0;
  let hitBytes = false;

  if (direction === 'head') {
    let start = 0;
    for (let i = 0; i < lineCount && i < maxLines; i++) {
      const newline = body.indexOf('\n', start);
      const end = newline === -1 ? body.length : newline;
      const line = body.slice(start, end);
      const size = utf8Len(line) + (i > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        hitBytes = true;
        break;
      }
      out.push(line);
      bytes += size;
      start = end + 1;
    }
  } else {
    let end = body.length;
    for (let i = lineCount - 1; i >= 0 && out.length < maxLines; i--) {
      const start = end > 0 ? body.lastIndexOf('\n', end - 1) + 1 : 0;
      const line = body.slice(start, end);
      const size = utf8Len(line) + (out.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        hitBytes = true;
        break;
      }
      out.unshift(line);
      bytes += size;
      end = start - 1;
    }
  }

  // The boundary line alone exceeds the byte budget. Rather than show only a
  // marker (the common single-huge-line case: minified file, base64, one-line
  // JSON/stack trace), keep a byte-safe slice of that line.
  let preview: string;
  if (out.length === 0) {
    const firstNewline = body.indexOf('\n');
    const line =
      direction === 'head'
        ? body.slice(0, firstNewline === -1 ? body.length : firstNewline)
        : body.slice(body.lastIndexOf('\n') + 1);
    preview = sliceLineByBytes(line, maxBytes, direction);
    bytes = utf8Len(preview);
    hitBytes = true;
  } else {
    preview = out.join('\n');
  }

  const removed = hitBytes ? Math.max(0, totalBytes - bytes) : lineCount - out.length;
  if (removed <= 0) {
    // Nothing was actually dropped — e.g. content fits but a lone trailing
    // newline pushed totalBytes one over the byte budget. Don't emit a
    // misleading "0 ... truncated" marker.
    return { content: text, truncated: false, removed: 0, unit: 'lines' };
  }
  const unit: 'lines' | 'bytes' = hitBytes ? 'bytes' : 'lines';
  const marker =
    `...${removed} ${unit} truncated. ${OUTPUT_RECOVERY_HINT} ` +
    'Otherwise work from the kept output above.';

  const content = direction === 'head' ? `${preview}\n\n${marker}` : `${marker}\n\n${preview}`;

  return { content, truncated: true, removed, unit };
}
