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

import type { ToolOutputStream, ToolResultContent } from '@maka/core/events';
import { formatQuietJsonValue, formatToolInvocationLine } from '@maka/core/tool-quiet-preview';
import {
  isActiveShellRunStatus,
  type PtyShellOutput,
  type ShellRunOperation,
} from '@maka/core/shell-run';
import { countDiffLineStats } from '@maka/core/unified-diff';
import { ptyTuiTerminalRows, ptyTuiTerminalView } from '@maka/core/pty-output-view';
import { readWriteStdinInputPreview } from '@maka/core/tool-activity-args';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { ansi, disc } from './tui-ansi.js';
import { colorDiff } from './tui-diff.js';
import {
  collapseToSingleLine,
  fitLine,
  formatUnknownInline,
  limitText,
  renderIndented,
} from './pi-transcript-format.js';
import type { MakaPiToolEntry, MakaPiToolOutputDelta } from './pi-transcript.js';

export function renderToolBlock(
  entry: MakaPiToolEntry,
  width: number,
  expanded: boolean,
): string[] {
  return expanded ? renderExpandedToolBlock(entry, width) : renderCompactToolBlock(entry, width);
}

/** Status disc for a tool row: green = done, accent = running, danger = error/aborted/failed, muted = detached/unavailable. */
function toolDisc(entry: MakaPiToolEntry): string {
  if (entry.status === 'running') return disc('accent');
  if (entry.status === 'error' || entry.status === 'aborted' || entry.status === 'failed')
    return disc('danger');
  if (entry.status === 'detached' || entry.status === 'unavailable') return disc('muted');
  return disc('ok');
}

/**
 * Duration/status part of the annotation, in integer seconds (#1053): `5s`,
 * `running 12s`. Sub-second durations are noise and never shown — the gate is
 * on the raw milliseconds, not the rounded value, so 999ms does not surface
 * as `1s`. Status words for rows without a live process (`detached`,
 * `source unavailable`) are dimmed like the other placeholders.
 */
function toolDurationText(entry: MakaPiToolEntry): string {
  const subSecond = entry.durationMs !== undefined && entry.durationMs < 1000;
  const secs =
    entry.durationMs === undefined ? undefined : Math.max(0, Math.round(entry.durationMs / 1000));
  if (entry.status === 'running') {
    return secs === undefined || subSecond ? 'running' : `running ${secs}s`;
  }
  if (entry.status === 'detached') return ansi.dim('detached');
  if (entry.status === 'unavailable') return ansi.dim('source unavailable');
  return secs === undefined || subSecond ? '' : `${secs}s`;
}

/**
 * Compact tool card: a single line — `● Name  target (annotation)`. The disc
 * carries the status color (green done / blue running / red failed / grey
 * detached); the parenthesized annotation carries the outcome in short fixed
 * shapes: counts (`5 matches`, `3 lines`), sizes (`42 bytes`), a diff tally
 * (`+1 -3`), durations (`5s`, sharing the parens as `5s · 3 lines`), red exit
 * codes, the dim `no output` placeholder, or a free-text `N lines · M bytes`
 * summary. Output content never appears on the row — it lives in the expanded
 * card, and the annotation's shapes already say whether there is anything to
 * expand, so the row needs neither
 * a separator glyph nor an expand marker. Short annotations are reserved
 * whole during truncation: a long command can never hide an `exit 1`.
 */
function renderCompactToolBlock(entry: MakaPiToolEntry, width: number): string[] {
  const inputSummary = collapseToSingleLine(toolInputSummary(entry));
  const head = `${toolDisc(entry)} ${entry.title ?? entry.toolName}`;
  const annotation = compactAnnotation(entry);
  return [
    fitLine(
      assembleCompactToolRow(head, inputSummary, annotation.text, width, annotation.protect),
      width,
    ),
  ];
}

/**
 * Build the `(part · part)` annotation for a compact row: duration/status
 * first, then the outcome. While running only the duration part shows
 * (`(running 12s)`). A placeholder outcome (`no output`) appears only when it
 * would be the annotation's sole content — `(5s)` needs no silence disclaimer.
 * `protect` reports whether every part is a fixed shape (durations always
 * are): only protected annotations are reserved whole during truncation.
 */
function compactAnnotation(entry: MakaPiToolEntry): { text: string; protect: boolean } {
  const parts: string[] = [];
  const duration = toolDurationText(entry);
  if (duration) parts.push(duration);
  let protect = true;
  if (entry.status !== 'running') {
    const summary = compactToolSummary(entry);
    if (summary && !(summary.placeholder && parts.length > 0)) {
      parts.push(collapseToSingleLine(summary.text));
      protect = summary.protect === true;
    }
  }
  return { text: parts.length > 0 ? `(${parts.join(' · ')})` : '', protect };
}

/**
 * Lay out `head  target (annotation)` on one line. A protected annotation is
 * preserved whole whenever it fits alongside the head; the input target
 * truncates first, so a long command can never hide a fixed-shape outcome.
 * An annotation that cannot fit with the head takes whatever room remains.
 */
function assembleCompactToolRow(
  head: string,
  input: string,
  annotation: string,
  width: number,
  protect: boolean,
): string {
  const inputSeg = input ? `  ${input}` : '';
  const annSeg = annotation ? ` ${annotation}` : '';
  const full = `${head}${inputSeg}${annSeg}`;
  if (visibleWidth(full) <= width) return full;
  const reserved = protect && visibleWidth(annSeg) <= Math.max(0, width - visibleWidth(head));
  const budget = Math.max(0, width - visibleWidth(head) - (reserved ? visibleWidth(annSeg) : 0));
  let builtInput = '';
  if (input && budget > 3) {
    const room = budget - 2;
    builtInput = `  ${visibleWidth(input) > room ? truncateToWidth(input, room, '…') : input}`;
  }
  if (reserved) return `${head}${builtInput}${annSeg}`;
  let builtAnnotation = '';
  const leftover = budget - visibleWidth(builtInput);
  if (annotation && leftover > 1) {
    builtAnnotation = ` ${visibleWidth(annotation) > leftover ? truncateToWidth(annotation, leftover, '…') : annotation}`;
  }
  return `${head}${builtInput}${builtAnnotation}`;
}

function renderExpandedToolBlock(entry: MakaPiToolEntry, width: number): string[] {
  const duration = toolDurationText(entry);
  let header = `${toolDisc(entry)} ${entry.title ?? entry.toolName}`;
  if (duration) header += ` (${duration})`;
  const lines = [fitLine(header, width)];

  const inputSummary = toolInputSummary(entry);
  if (inputSummary) lines.push(...renderIndented(inputSummary, width, 2).map(ansi.dim));
  if (entry.progress.droppedChars > 0) {
    lines.push(
      ...renderIndented(
        ansi.dim(`⋯ ${entry.progress.droppedChars} earlier progress chars truncated ⋯`),
        width,
        2,
      ),
    );
  }
  if (entry.progress.length > 0) {
    lines.push(...renderCappedResultText(entry.progress.values().join(''), width, ansi.dim));
  }
  // A terminal snapshot is the authoritative accumulated stream. Rendering
  // the deltas that preceded it as well would repeat every line once the Bash
  // card settles. Compact results intentionally keep the live deltas because
  // they may be the only output available.
  const renderLiveOutput = !shellResultSupersedesLiveOutput(entry.result);
  if (renderLiveOutput) {
    if (entry.outputDeltas.droppedChars > 0) {
      lines.push(
        ...renderIndented(
          ansi.dim(`⋯ ${entry.outputDeltas.droppedChars} earlier live-output chars truncated ⋯`),
          width,
          2,
        ),
      );
    }
    lines.push(...renderToolStreams(entry.outputDeltas.values(), width));
  }
  if (entry.result || entry.output) {
    lines.push(...renderToolResult(entry, width));
  }
  if (
    entry.toolName === 'Bash' &&
    entry.status === 'running' &&
    entry.result?.kind === 'shell_run'
  ) {
    lines.push(...renderIndented(ansi.dim('Ask Maka to stop this task'), width, 2));
  }
  return lines.map((line) => fitLine(line, width));
}

function shellResultSupersedesLiveOutput(result: ToolResultContent | undefined): boolean {
  return (
    (result?.kind === 'terminal' || result?.kind === 'shell_run') && result.output !== undefined
  );
}

interface CompactToolSummary {
  text: string;
  /** Placeholder shown only when the annotation would otherwise be empty (`no output`). */
  placeholder?: boolean;
  /**
   * Fixed-shape outcome (a count, size, diff tally, exit status, or free-text
   * line/byte count) eligible for whole-annotation reservation when the row
   * overflows. A WriteStdin operation echo remains unprotected because it is
   * an action preview rather than an outcome.
   */
  protect?: boolean;
}

function noOutput(): CompactToolSummary {
  return { text: ansi.dim('no output'), placeholder: true, protect: true };
}

function textResultSummary(text: string): CompactToolSummary {
  if (!text.trim()) return noOutput();
  return {
    text: `${linesText(readBodyLineCount(text))} · ${byteLength(text)} bytes`,
    protect: true,
  };
}

function linesText(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`;
}

/**
 * Combined line count for a pipes result. Each stream is counted after
 * trimming its own trailing newlines and the counts are summed — joining the
 * streams first would invent a line at the boundary (`out\n` + `err\n` is
 * two lines, not three).
 */
function pipeOutputLineCount(output: { stdout?: string; stderr?: string }): number {
  let count = 0;
  for (const stream of [output.stdout, output.stderr]) {
    const trimmed = stream?.replace(/\n+$/, '');
    if (trimmed) count += trimmed.split('\n').length;
  }
  return count;
}

function compactToolSummary(entry: MakaPiToolEntry): CompactToolSummary | undefined {
  const result = entry.result;
  if (result?.kind === 'shell_run') {
    if (entry.toolName === 'WriteStdin') {
      return { text: formatPtyControlOperation(result.operation, entry.input) };
    }
    // A settled background run reports its outcome, not its output: the status
    // and exit code are the signal, the stream body lives in the expanded card.
    if (!isActiveShellRunStatus(result.status) && result.status !== 'completed') {
      const parts: string[] = [result.status];
      if (result.exitCode !== undefined) parts.push(`exit ${result.exitCode}`);
      return { text: ansi.red(parts.join(' · ')), protect: true };
    }
    if (result.output?.mode === 'pty') {
      const rows = ptyTuiTerminalRows(result.output).length;
      return rows > 0 ? { text: linesText(rows), protect: true } : noOutput();
    }
    if (result.output?.mode === 'pipes') {
      const lines = pipeOutputLineCount(result.output);
      if (lines > 0) return { text: linesText(lines), protect: true };
    }
    return noOutput();
  }

  if (result?.kind === 'terminal') return compactTerminalSummary(result);
  if (result?.kind === 'file_diff') return compactDiffSummary(result);
  if (result?.kind === 'file_write') {
    // The path is already the card's input summary; the result adds only size.
    return { text: `${result.bytes} bytes`, protect: true };
  }

  if (entry.toolName === 'Grep') {
    const count = jsonArrayCount(entry, 'matches');
    if (count !== undefined)
      return { text: `${count} match${count === 1 ? '' : 'es'}`, protect: true };
  }

  if (entry.toolName === 'Glob') {
    const count = jsonArrayCount(entry, 'files');
    if (count !== undefined)
      return { text: `${count} file${count === 1 ? '' : 's'}`, protect: true };
  }

  if (result?.kind === 'archived_tool_result') {
    return { text: `archived: ${result.status}`, protect: true };
  }

  const text = plainResultText(entry);
  if (!text) return result ? noOutput() : undefined;
  // Only a successful filesystem Read that carries real file content gets the
  // line summary — the same guard the expanded card uses. A runtime
  // resource or errored Read uses the generic fixed-shape summary instead of a
  // fabricated file count.
  if (
    entry.toolName === 'Read' &&
    entry.status !== 'error' &&
    isFilesystemReadPath(entry) &&
    isReadBodyResult(result)
  ) {
    return { text: linesText(readBodyLineCount(text)), protect: true };
  }
  return textResultSummary(text);
}

function compactTerminalSummary(
  content: Extract<ToolResultContent, { kind: 'terminal' }>,
): CompactToolSummary {
  if (content.status !== 'completed') {
    // The exit code is the whole signal on a failed row; the error text lives
    // in the expanded card.
    return {
      text: ansi.red(content.exitCode === undefined ? content.status : `exit ${content.exitCode}`),
      protect: true,
    };
  }
  if (content.output.mode === 'pty') {
    const rows = ptyTuiTerminalRows(content.output).length;
    return rows > 0 ? { text: linesText(rows), protect: true } : noOutput();
  }
  const lines = pipeOutputLineCount(content.output);
  return lines > 0 ? { text: linesText(lines), protect: true } : noOutput();
}

function compactDiffSummary(
  content: Extract<ToolResultContent, { kind: 'file_diff' }>,
): CompactToolSummary {
  const { additions, deletions } = countDiffLineStats(content.diff);
  // The path is already the card's input summary; the tally is the outcome.
  return { text: `${ansi.green(`+${additions}`)} ${ansi.red(`-${deletions}`)}`, protect: true };
}

/**
 * Row count for list-shaped json results (Grep `matches`, Glob `files`).
 * Returns a count only when the keyed field is genuinely an array; an
 * error-shaped result (e.g. `{ error: "..." }`) returns undefined so the
 * caller falls back to a generic first-line summary rather than reporting a
 * fabricated "N matches" / "N files" from an unrelated line count.
 */
function jsonArrayCount(entry: MakaPiToolEntry, key: string): number | undefined {
  const result = entry.result;
  if (result?.kind === 'json' && result.value !== null && typeof result.value === 'object') {
    const rows = (result.value as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return undefined;
}

function renderToolText(text: string, width: number): string[] {
  return renderIndented(limitText(text, 12_000), width, 2);
}

// Expanding a tool card should reveal enough to orient, not replay a whole
// file or command dump into the transcript. Long output collapses to its first
// and last few lines with a hidden-count marker; diffs are the deliberate
// exception (rendered in full) because the whole change is the point.
const EXPANDED_TOOL_HEAD_LINES = 3;
const EXPANDED_TOOL_TAIL_LINES = 3;

/**
 * Render tool output for the expanded card, keeping at most the first
 * `EXPANDED_TOOL_HEAD_LINES` and last `EXPANDED_TOOL_TAIL_LINES` source lines
 * with a dim marker in between. `style` colors the content lines (e.g. dim for
 * stderr); the marker is always dim.
 */
function renderCappedResultText(
  text: string,
  width: number,
  style: (line: string) => string = (line) => line,
): string[] {
  // Command output almost always ends in a newline; splitting raw would count
  // that trailing empty string as a line, capping 7 real lines as if they were
  // 8 and spending a tail slot on a blank. Drop trailing newlines before both
  // the cap decision and the slice so the head/tail counts are real lines.
  const trimmed = text.replace(/\n+$/, '');
  const sourceLines = trimmed.split('\n');
  if (sourceLines.length <= EXPANDED_TOOL_HEAD_LINES + EXPANDED_TOOL_TAIL_LINES + 1) {
    return renderToolText(trimmed, width).map(style);
  }
  const hidden = sourceLines.length - EXPANDED_TOOL_HEAD_LINES - EXPANDED_TOOL_TAIL_LINES;
  const head = sourceLines.slice(0, EXPANDED_TOOL_HEAD_LINES).join('\n');
  const tail = sourceLines.slice(sourceLines.length - EXPANDED_TOOL_TAIL_LINES).join('\n');
  return [
    ...renderToolText(head, width).map(style),
    ...renderIndented(ansi.dim(`⋯ ${hidden} lines hidden ⋯`), width, 2),
    ...renderToolText(tail, width).map(style),
  ];
}

/**
 * Line count for a Read body, dropping only the single conventional EOF newline
 * so `foo\n` counts as one line while a real trailing blank line is preserved
 * (`a\n\n` is two lines, `\n` is one). Shared by the compact and expanded
 * summaries so the same card can never flip its line count when toggled.
 */
function readBodyLineCount(text: string): number {
  if (text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}

function renderReadSummary(entry: MakaPiToolEntry, width: number): string[] {
  const text = plainResultText(entry);
  // Byte count keeps the full content, since that is the file's real size on
  // disk; the line count drops the trailing newline (see readBodyLineCount).
  const lineCount = readBodyLineCount(text);
  const summary = `Read ${lineCount} line${lineCount === 1 ? '' : 's'}, ${byteLength(text)} bytes`;
  return renderIndented(ansi.dim(summary), width, 2);
}

function readInputPath(entry: MakaPiToolEntry): string | undefined {
  const input = entry.input;
  const path =
    input !== null && typeof input === 'object' ? (input as { path?: unknown }).path : undefined;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function readInputRef(entry: MakaPiToolEntry): string | undefined {
  const input = entry.input;
  const ref =
    input !== null && typeof input === 'object' ? (input as { ref?: unknown }).ref : undefined;
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

/** A Read using the filesystem branch. */
function isFilesystemReadPath(entry: MakaPiToolEntry): boolean {
  return readInputPath(entry) !== undefined;
}

/** A Read using the runtime-resource branch (background-task output, etc.). */
function isRuntimeResourceRead(entry: MakaPiToolEntry): boolean {
  return readInputRef(entry)?.startsWith('maka://runtime/') ?? false;
}

/**
 * True only for the result shapes a filesystem Read uses to carry actual file
 * content. An `archived_tool_result` placeholder (or any other kind) is not a
 * read body, so it renders its own status instead of a fabricated line count.
 */
function isReadBodyResult(result: ToolResultContent | undefined): boolean {
  if (result?.kind === 'text') return true;
  // A json Read body is the `{ content: string }` shape the file loader
  // returns; any other json (e.g. an `{ error }` payload) is a status object,
  // not file content, and should render its real shape rather than a
  // fabricated line/byte count.
  if (result?.kind === 'json') {
    const value = result.value;
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { content?: unknown }).content === 'string'
    );
  }
  return false;
}

/**
 * Render live `tool_output_delta` chunks. Chunks are de-duped and ordered by
 * `seq` (so a late or repeated seq cannot corrupt the display), consecutive
 * same-stream chunks are grouped under a single dim `[stream]` label, and any
 * redacted chunk shows a `[redacted]` marker instead of its raw content.
 */
function renderToolStreams(deltas: readonly MakaPiToolOutputDelta[], width: number): string[] {
  const lines: string[] = [];
  for (const group of groupOutputDeltas(deltas)) {
    lines.push(fitLine(ansi.dim(`[${group.stream}]`), width));
    lines.push(...renderCappedResultText(group.text, width, ansi.dim));
  }
  return lines;
}

function groupOutputDeltas(
  deltas: readonly MakaPiToolOutputDelta[],
): Array<{ stream: ToolOutputStream; text: string }> {
  const bySeq = new Map<number, MakaPiToolOutputDelta>();
  for (const delta of deltas) {
    if (!bySeq.has(delta.seq)) bySeq.set(delta.seq, delta);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const groups: Array<{ stream: ToolOutputStream; text: string }> = [];
  for (const delta of ordered) {
    const chunk = delta.redacted ? '[redacted]' : delta.chunk;
    const last = groups[groups.length - 1];
    if (last && last.stream === delta.stream) {
      last.text += chunk;
    } else {
      groups.push({ stream: delta.stream, text: chunk });
    }
  }
  return groups;
}

function renderToolResult(entry: MakaPiToolEntry, width: number): string[] {
  const result = entry.result;
  // A `maka://runtime/...` resource Read surfaces live state (background-task
  // metadata + stdout/stderr) that only lives in the transcript. Its body opens
  // with several metadata/separator lines, so a head/tail cap would hide the very
  // output the user expanded to see — render it in full.
  if (entry.toolName === 'Read' && isRuntimeResourceRead(entry)) {
    return renderToolText(plainResultText(entry), width);
  }
  // A successful filesystem Read that returned real file content pulled it into
  // the model's context; the transcript only needs to note that it happened, so
  // skip the content and keep a summary. Everything else falls through to render
  // its content: a failed Read (its error), and — critically — an
  // `archived_tool_result` placeholder, so its not_loaded/missing status stays
  // visible instead of being mistaken for a one-line file.
  if (
    entry.toolName === 'Read' &&
    entry.status !== 'error' &&
    isFilesystemReadPath(entry) &&
    isReadBodyResult(result)
  ) {
    return renderReadSummary(entry, width);
  }
  if (result?.kind === 'terminal') return renderTerminalResult(result, width);
  // A background `shell_run` carries process metadata (ref, status, exit) the
  // head/tail cap must never hide — otherwise a failed or timed-out background
  // command looks the same as a successful one. Render the status in full and
  // cap only the stdout/stderr stream bodies.
  if (result?.kind === 'shell_run') {
    if (entry.toolName === 'WriteStdin') {
      return renderIndented(formatPtyControlOperation(result.operation, entry.input), width, 2);
    }
    return renderShellRunResult(entry, result, width);
  }
  // Diffs are the deliberate exception to the head/tail cap: the whole change
  // is what the user is expanding to see.
  if (result?.kind === 'file_diff') return renderDiffResult(result.diff, width);
  if (result?.kind === 'file_write') {
    return renderIndented(`Wrote ${result.bytes} bytes to ${result.path}`, width, 2);
  }
  // A generic `text` dump — a Bash body or raw tool text — is what the head/tail
  // cap targets: the model already holds the full body, so the transcript only
  // needs enough to orient. An undefined result with a formatted `output` string
  // is treated the same way. `json` is deliberately excluded: a Read json is
  // summarized above, a Grep/Glob json is a structured list the user expands to
  // scan in full, and any other json collapses to a single inline line where the
  // cap would be a no-op anyway.
  if (result === undefined || result.kind === 'text') {
    return renderCappedResultText(plainResultText(entry), width);
  }
  // Everything else — json lists (Grep/Glob), agent reports, web-search results,
  // subagent / workflow summaries, structured tool output — is content the user
  // expands to read in full, so render it without the cap, like a diff.
  return renderToolText(plainResultText(entry), width);
}

/** Best-effort extraction of the human-readable body from a tool result. */
function plainResultText(entry: MakaPiToolEntry): string {
  const result = entry.result;
  if (result?.kind === 'text') return typeof result.text === 'string' ? result.text : '';
  if (result?.kind === 'json') {
    const value = result.value;
    if (value !== null && typeof value === 'object') {
      const content = (value as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      const record = value as { matches?: unknown; files?: unknown };
      const rows = record.matches ?? record.files;
      if (Array.isArray(rows)) return rows.map((row) => String(row)).join('\n');
    }
    // Generic json fallback: use the shared quiet-value formatter instead of
    // dumping a single-line JSON blob. It extracts headline + body from
    // known shapes (lists, text payloads, Write/Edit results, key-value) and
    // never produces escaped JSON braces (#1065). AskUserQuestion, GoalSet,
    // ScheduledTask, and any future tool without a custom case render
    // human-readable text here.
    const preview = formatQuietJsonValue(value, 'en');
    return preview.headline ? `${preview.headline}\n${preview.body}` : preview.body;
  }
  return entry.output ?? '';
}

function renderTerminalResult(
  content: Extract<ToolResultContent, { kind: 'terminal' }>,
  width: number,
): string[] {
  const lines: string[] = [];
  if (content.status !== 'completed') {
    const status = content.exitCode === undefined ? content.status : `exit ${content.exitCode}`;
    lines.push(...renderIndented(ansi.red(status), width, 2));
    if (content.failureMessage)
      lines.push(...renderIndented(ansi.red(content.failureMessage), width, 2));
  }
  if (content.output.mode === 'pty') {
    lines.push(...renderPtyTerminalRows(content.output, width));
  } else {
    if (content.output.stdout) lines.push(...renderCappedResultText(content.output.stdout, width));
    if (content.output.stderr) {
      lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
      lines.push(...renderCappedResultText(content.output.stderr, width, ansi.dim));
    }
  }
  return lines;
}

function renderPtyTerminalRows(output: PtyShellOutput, width: number): string[] {
  const view = ptyTuiTerminalView(output);
  const lines = view.rows.map((row) => {
    const available = Math.max(0, width - 2);
    const body = visibleWidth(row) > available ? truncateToWidth(row, available, '…') : row;
    return `  ${body}`;
  });
  if (output.truncated || view.rowsOmitted) {
    lines.push(...renderIndented(ansi.dim('terminal output truncated'), width, 2));
  }
  if (output.redacted)
    lines.push(...renderIndented(ansi.dim('terminal output redacted'), width, 2));
  return lines;
}

function renderPipeShellOutput(
  output: Extract<
    NonNullable<Extract<ToolResultContent, { kind: 'shell_run' }>['output']>,
    { mode: 'pipes' }
  >,
  width: number,
): string[] {
  const lines: string[] = [];
  if (output.stdout) lines.push(...renderCappedResultText(output.stdout, width));
  if (output.stderr) {
    lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
    lines.push(...renderCappedResultText(output.stderr, width, ansi.dim));
  }
  return lines;
}

/**
 * Render a `shell_run` (background-process) result. The status line — status,
 * exit code, failure message, and the run `ref` — is always shown in full so a
 * head/tail cap can never hide whether the command failed or timed out; only
 * the stdout/stderr stream bodies are capped.
 */
function renderShellRunResult(
  entry: MakaPiToolEntry,
  content: Extract<ToolResultContent, { kind: 'shell_run' }>,
  width: number,
): string[] {
  const lines: string[] = [];
  // The command/cwd live on the result. The Bash input summary shows only the
  // command's first line (`command.split('\n')[0]`), so skip the result-side
  // `$ cmd` only when the input already shows the whole command — a single-line
  // command. A multiline command, or a ref-only StopBackgroundTask input,
  // renders the full command here so none of it is lost. The cwd is in neither
  // input summary, so show it once here.
  const input = entry.input;
  const command =
    input !== null && typeof input === 'object'
      ? (input as { command?: unknown }).command
      : undefined;
  const inputShowsFullCommand =
    typeof command === 'string' && command.trim() !== '' && !command.includes('\n');
  if (!inputShowsFullCommand) {
    lines.push(...renderIndented(ansi.dim(`$ ${content.cmd}`), width, 2));
  }
  lines.push(...renderIndented(ansi.dim(`cwd: ${content.cwd}`), width, 2));
  const settled = !isActiveShellRunStatus(content.status) && content.status !== 'completed';
  const parts: string[] = [content.status];
  if (content.exitCode !== undefined) parts.push(`exit ${content.exitCode}`);
  if (content.failureMessage) parts.push(content.failureMessage);
  const head = parts.join(' · ');
  // Keep the colored status and the dim ref as separate ansi spans; nesting one
  // inside the other would let the inner reset terminate the outer color early.
  const statusLine = `${settled ? ansi.red(head) : ansi.dim(head)} ${ansi.dim(`(${content.ref})`)}`;
  lines.push(...renderIndented(statusLine, width, 2));
  if (content.output?.mode === 'pty') {
    const hasTerminalView = ptyTuiTerminalRows(content.output).length > 0;
    lines.push(...renderPtyTerminalRows(content.output, width));
    if (!hasTerminalView && (content.status === 'failed' || content.status === 'orphaned')) {
      lines.push(...renderIndented(ansi.dim('No terminal view available'), width, 2));
    }
  } else if (content.output?.mode === 'pipes') {
    lines.push(...renderPipeShellOutput(content.output, width));
  }
  return lines;
}

function renderDiffResult(diff: string, width: number): string[] {
  // The structural parse drops the `---`/`+++` file headers the card already
  // names; the copyable ledger keeps them.
  return renderIndented(colorDiff(limitText(diff, 12_000)), width, 2);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatPtyControlOperation(
  operation: ShellRunOperation | undefined,
  args: unknown,
): string {
  if (operation?.kind !== 'pty_control') return 'Background terminal interaction failed';
  const parts: string[] = [];
  if (operation.input) {
    const preview = readWriteStdinInputPreview(args);
    const action = operation.input.queued ? 'Entered' : 'Not entered';
    if (preview) {
      parts.push(
        preview.truncated
          ? `${action}: ${preview.text}… · ${operation.input.bytes} bytes total`
          : `${action}: ${preview.text}`,
      );
    } else {
      parts.push(`${action} ${operation.input.bytes} bytes`);
    }
  }
  if (operation.resize) {
    const size = `${operation.resize.cols}x${operation.resize.rows}`;
    if (!operation.resize.applied) parts.push(`Did not resize to ${size}`);
    else if (operation.resize.changed) parts.push(`Resized to ${size}`);
    else if (!operation.input) parts.push(`Size already ${size}`);
  }
  if (operation.failed) parts.push('Background terminal interaction failed');
  return parts.join(' · ') || 'Background terminal interaction completed';
}

function toolInputSummary(entry: MakaPiToolEntry): string {
  const input = entry.input;
  const obj =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  switch (entry.toolName) {
    case 'Bash': {
      const command = obj?.command;
      if (typeof command === 'string' && command.trim()) {
        // Agents often lead with `#` comment lines; the row names what the
        // command does, so show the first real command line when one exists.
        const firstRealLine = command
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line !== '' && !line.startsWith('#'));
        return `$ ${firstRealLine ?? command.split('\n')[0]!.trim()}`;
      }
      break;
    }
    case 'Read': {
      const path = obj?.path;
      if (typeof path === 'string' && path.trim()) {
        const parts = [path];
        if (typeof obj?.offset === 'number') parts.push(`offset ${obj.offset}`);
        if (typeof obj?.limit === 'number') parts.push(`limit ${obj.limit}`);
        return parts.join(' ');
      }
      break;
    }
    case 'WriteStdin': {
      const parts: string[] = [];
      const input = readWriteStdinInputPreview(obj);
      if (input) parts.push(input.truncated ? `${input.text}… · ${input.bytes} bytes` : input.text);
      if (obj?.size && typeof obj.size === 'object') {
        const size = obj.size as { cols?: unknown; rows?: unknown };
        if (typeof size.cols === 'number' && typeof size.rows === 'number') {
          parts.push(`${size.cols}x${size.rows}`);
        }
      }
      if (parts.length > 0) return parts.join(' · ');
      if (typeof obj?.ref === 'string') return obj.ref;
      break;
    }
    case 'Write':
    case 'Edit': {
      const path = obj?.path;
      if (typeof path === 'string' && path.trim()) return path;
      break;
    }
    case 'Grep': {
      const pattern = obj?.pattern;
      if (typeof pattern === 'string' && pattern.trim()) {
        const parts = [pattern];
        if (typeof obj?.path === 'string' && obj.path.trim()) parts.push(`in ${obj.path}`);
        if (typeof obj?.glob === 'string' && obj.glob.trim()) parts.push(`glob ${obj.glob}`);
        return parts.join(' ');
      }
      break;
    }
    case 'Glob': {
      const pattern = obj?.pattern;
      if (typeof pattern === 'string' && pattern.trim()) {
        const cwd = obj?.cwd;
        return typeof cwd === 'string' && cwd.trim() ? `${pattern} in ${cwd}` : pattern;
      }
      break;
    }
    case 'maka_computer': {
      const line = computerCallSummary(obj);
      if (line) return line;
      break;
    }
  }
  if (input === undefined) return '';
  // Generic fallback: use the shared invocation-line formatter instead of
  // dumping raw JSON. It extracts headline fields (command/path/pattern/query/
  // name/…) and never produces escaped JSON braces (#1065). The explicit per-
  // tool cases above are an optimization for the common tools; this fallback
  // covers Skill, AskUserQuestion, GoalSet, ScheduledTask, and any future tool.
  const line = formatToolInvocationLine({ toolName: entry.toolName, args: input }, 'en');
  if (line) return limitText(line, 600);
  // Absolute last resort — still single-line for the compact header contract.
  return `input: ${limitText(formatUnknownInline(input), 600)}`;
}

/**
 * What one Computer Use call did, for the row that names it.
 *
 * Every other tool's row is legible from its name plus one headline argument.
 * This tool's name is `Maka Computer` for observing a window, clicking a
 * button and observing again alike, so ten calls in a turn printed ten
 * identical headers; the generic fallback then spelled the arguments out as
 * `action: … / approvalClass: … / rememberForTurnAllowed: …`, which names the
 * host's own approval bookkeeping rather than anything the model asked for.
 *
 * The arguments here are a `ComputerUseModelCallArgs`, not the raw wire call:
 * `ToolRuntime` substitutes that projection for any tool declaring
 * `categoryHint: 'computer_use'` before anything is persisted. It keeps every
 * key the model sent in the names the tool accepts — `window_id`, `element_id`
 * — and reduces a screen-derived or typed value to its shape, so the action,
 * the app, the window and the element are available and a written value is
 * not. Reading `windowId`/`elementId` here instead is not a compile error and
 * not a crash; it is every row silently losing its element, which is the defect
 * this function exists to remove.
 */
function computerCallSummary(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const text = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const action = text('action');
  if (!action) return undefined;
  const parts = [action];
  const elementId = text('element_id');
  if (elementId) parts.push(`element ${elementId}`);
  const app = text('app');
  const windowId = args.window_id;
  const target =
    app && typeof windowId === 'number'
      ? `${app} window ${windowId}`
      : (app ?? (typeof windowId === 'number' ? `window ${windowId}` : undefined));
  if (target) parts.push(target);
  return limitText(parts.join(' · '), 600);
}
