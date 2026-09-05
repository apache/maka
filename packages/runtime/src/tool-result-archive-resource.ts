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

import type { ToolResultArchiveReadResult } from './tool-result-archive.js';

export const TOOL_RESULT_ARCHIVE_RESOURCE_PROTOCOL = 'maka:';
export const TOOL_RESULT_ARCHIVE_RESOURCE_HOST = 'archive';
export const TOOL_RESULT_ARCHIVE_DEFAULT_LIMIT = 4_000;
export const TOOL_RESULT_ARCHIVE_MAX_LIMIT = 6_000;
export const TOOL_RESULT_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;
export const TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS = 7_500;

const ARCHIVE_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_MANIFEST_ITEMS = 100;
const MAX_METADATA_STRING_CHARS = 160;

export type ToolResultArchiveResourceOperation = 'inspect' | 'read' | 'query' | 'search';

export type ToolResultArchiveReadUnit = 'char' | 'line';

/** Upper bound on matches returned by a single search page. */
export const TOOL_RESULT_ARCHIVE_MAX_SEARCH_MATCHES = 50;
/** Characters of surrounding context kept on each side of a search match. */
const SEARCH_SNIPPET_RADIUS = 80;
/** Longest search snippet retained, so many matches still fit one response. */
const MAX_SEARCH_SNIPPET_CHARS = 240;
/** Maximum pattern length accepted by the ArchiveRead tool schema. */
const MAX_SEARCH_PATTERN_CHARS = 256;
/** Preview length surfaced by inspect for text/object payloads. */
const INSPECT_PREVIEW_CHARS = 600;

export interface ToolResultArchiveResourceIdentity {
  artifactId: string;
  bodySha256: string;
  originalBytes: number;
}

export interface ToolResultArchiveResourceReadInput extends ToolResultArchiveResourceIdentity {
  sessionId: string;
  maxBytes: number;
}

export interface ToolResultArchiveResourceReader {
  readArchivedToolResultResource(
    input: ToolResultArchiveResourceReadInput,
  ): Promise<ToolResultArchiveReadResult> | ToolResultArchiveReadResult;
}

export interface ToolResultArchiveResourceRequest {
  ref: string;
  operation?: ToolResultArchiveResourceOperation;
  offset?: number;
  limit?: number;
  itemId?: string;
  /** For `read`: whether offset/limit count characters (default) or lines. */
  unit?: ToolResultArchiveReadUnit;
  /** For `search`: the literal, case-insensitive substring to locate. */
  pattern?: string;
}

export function buildToolResultArchiveResourceRef(
  input: ToolResultArchiveResourceIdentity,
): string {
  const artifactId = encodeURIComponent(input.artifactId);
  const sha256 = encodeURIComponent(input.bodySha256);
  return `maka://archive/${artifactId}/${sha256}/${input.originalBytes}`;
}

export function parseToolResultArchiveResourceRef(
  ref: string,
): ToolResultArchiveResourceIdentity | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  if (
    url.protocol !== TOOL_RESULT_ARCHIVE_RESOURCE_PROTOCOL ||
    url.hostname !== TOOL_RESULT_ARCHIVE_RESOURCE_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (url.hash || url.search || pathParts.length !== 3) return null;
  let artifactId: string;
  let bodySha256: string;
  let bytesText: string;
  try {
    artifactId = decodeURIComponent(pathParts[0] ?? '');
    bodySha256 = decodeURIComponent(pathParts[1] ?? '');
    bytesText = decodeURIComponent(pathParts[2] ?? '');
  } catch {
    return null;
  }
  if (
    !ARCHIVE_ARTIFACT_ID_PATTERN.test(artifactId) ||
    !/^[a-f0-9]{64}$/i.test(bodySha256) ||
    !/^[1-9]\d*$/.test(bytesText)
  ) {
    return null;
  }
  const originalBytes = Number(bytesText);
  if (!Number.isSafeInteger(originalBytes) || originalBytes <= 0) return null;
  return { artifactId, bodySha256, originalBytes };
}

export async function readToolResultArchiveResource(
  reader: ToolResultArchiveResourceReader,
  sessionId: string,
  request: ToolResultArchiveResourceRequest,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const identity = parseToolResultArchiveResourceRef(request.ref);
  if (!identity) {
    return archiveFailure(request.ref, 'invalid_ref');
  }
  if (identity.originalBytes > TOOL_RESULT_ARCHIVE_MAX_BYTES) {
    return archiveFailure(request.ref, 'too_large', {
      originalBytes: identity.originalBytes,
      maxBytes: TOOL_RESULT_ARCHIVE_MAX_BYTES,
    });
  }
  if (abortSignal?.aborted) throw new Error('ArchiveRead aborted');

  const read = await Promise.resolve(
    reader.readArchivedToolResultResource({
      ...identity,
      sessionId,
      maxBytes: identity.originalBytes,
    }),
  );
  if (!read.ok) return archiveFailure(request.ref, read.reason);
  if (abortSignal?.aborted) throw new Error('ArchiveRead aborted');

  const operation = request.operation ?? 'inspect';
  const limit = normalizeLimit(request.limit);
  const offset = normalizeOffset(request.offset);
  const parsed = deserializeArchive(read.serializedResult);

  if (operation === 'search') {
    const text = resolveArchiveText(parsed, read.serializedResult);
    return searchArchive(request.ref, text, request.pattern, offset);
  }
  if (operation === 'read') {
    // Page the decoded text for string payloads so offsets land on real
    // characters, not JSON escape bytes; structured payloads still page their
    // canonical JSON serialization.
    const text = resolveArchiveText(parsed, read.serializedResult);
    if (request.unit === 'line') {
      return pagedLines(request.ref, text, offset, limit);
    }
    return pagedContent({ ref: request.ref, operation, content: text, offset, limit });
  }
  if (operation === 'query') {
    return queryArchiveItem(request.ref, parsed, request.itemId, offset, limit);
  }
  return inspectArchive(request.ref, identity, parsed, read.serializedResult);
}

/**
 * The text an archive should page/search over. String payloads decode to their
 * raw content, and terminal/shell-run payloads project their stdout/stderr;
 * everything else pages its canonical JSON serialization.
 */
function resolveArchiveText(parsed: unknown, serializedResult: string): string {
  if (typeof parsed === 'string') return parsed;
  if (!isTerminalArchivePayload(parsed)) return serializedResult;

  // Bash archives retain the canonical terminal/shell-run object. Search and
  // line reads should operate on the human-readable streams, not JSON-escaped
  // `\\n` sequences in that object.
  const output = isRecord(parsed.output) ? parsed.output : undefined;
  if (output?.mode === 'pty') {
    const ptyParts = [output.scrollback, output.screen, output.lastAlternateScreen].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    return ptyParts.join('\n');
  }
  const stdout = output && typeof output.stdout === 'string' ? output.stdout : undefined;
  const stderr = output && typeof output.stderr === 'string' ? output.stderr : undefined;
  if (stdout !== undefined || stderr !== undefined) {
    const parts = [stdout, stderr].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    return parts.join('\n');
  }
  return serializedResult;
}

function isTerminalArchivePayload(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (value.kind === 'terminal' || value.kind === 'shell_run') &&
    isRecord(value.output)
  );
}

export const TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS =
  'This result is archived but still readable. Call ArchiveRead with the provided ref and operation "inspect"; use operation "query" with itemId for one structured item, or operation "read" with offset/limit for a bounded page. Do not use Glob to find the archive.';

function inspectArchive(
  ref: string,
  identity: ToolResultArchiveResourceIdentity,
  value: unknown,
  serializedResult: string,
): unknown {
  const base = {
    ok: true,
    kind: 'tool_result_archive',
    operation: 'inspect',
    ref,
    artifactId: identity.artifactId,
    originalBytes: identity.originalBytes,
  };
  const readHint =
    'Call ArchiveRead with operation "read" (unit "char" or "line"), offset, and limit for bounded pages, or operation "search" with a pattern to locate text.';
  if (isTerminalArchivePayload(value)) {
    const text = resolveArchiveText(value, serializedResult);
    return {
      ...base,
      valueType: 'terminal',
      totalChars: text.length,
      totalLines: countLines(text),
      preview: boundedString(text, INSPECT_PREVIEW_CHARS),
      readHint,
    };
  }
  if (typeof value === 'string') {
    // A plain-text/terminal payload: report the char/line coordinate space plus
    // a short preview so the model can page or search without a blind first read.
    return {
      ...base,
      valueType: 'text',
      totalChars: value.length,
      totalLines: countLines(value),
      preview: boundedString(value, INSPECT_PREVIEW_CHARS),
      readHint,
    };
  }
  if (isRecord(value)) {
    const items = Array.isArray(value.items) ? value.items : undefined;
    let objectKeys = Object.keys(value)
      .slice(0, 25)
      .map((key) => boundedString(key));
    const buildObjectBase = (): Record<string, unknown> => ({
      ...base,
      valueType: 'object',
      totalChars: serializedResult.length,
      keys: objectKeys,
      ...(typeof value.kind === 'string' ? { archivedKind: boundedString(value.kind) } : {}),
      ...(typeof value.status === 'string' ? { status: boundedString(value.status) } : {}),
    });
    if (items) {
      const queryHint =
        'Call ArchiveRead with operation "query" and one of the listed itemId values.';
      const projectedItems = items.slice(0, MAX_MANIFEST_ITEMS).map(inspectItem);
      let manifestItems = projectedItems;
      const buildManifest = (): Record<string, unknown> => ({
        ...buildObjectBase(),
        itemCount: items.length,
        items: manifestItems,
        queryHint,
        readHint,
        ...(manifestItems.length < items.length
          ? { itemsTruncated: true, listedItemCount: manifestItems.length }
          : {}),
      });
      // Keep one actionable itemId when it can fit, then trade keys for more
      // manifest entries and re-add entries against the complete envelope.
      while (JSON.stringify(buildManifest()).length > TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS) {
        if (manifestItems.length > 1) {
          manifestItems = manifestItems.slice(0, -1);
          continue;
        }
        if (objectKeys.length > 0) {
          objectKeys = objectKeys.slice(0, -1);
          continue;
        }
        if (manifestItems.length > 0) {
          manifestItems = [];
          continue;
        }
        break;
      }
      for (const projectedItem of projectedItems.slice(manifestItems.length)) {
        const next = [...manifestItems, projectedItem];
        manifestItems = next;
        if (JSON.stringify(buildManifest()).length > TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS) {
          manifestItems = next.slice(0, -1);
          break;
        }
      }
      return buildManifest();
    }
    const buildObject = (): Record<string, unknown> => ({
      ...buildObjectBase(),
      preview: boundedString(serializedResult, INSPECT_PREVIEW_CHARS),
      readHint,
    });
    while (
      objectKeys.length > 0 &&
      JSON.stringify(buildObject()).length > TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS
    ) {
      objectKeys = objectKeys.slice(0, -1);
    }
    return buildObject();
  }
  if (Array.isArray(value)) {
    return {
      ...base,
      valueType: 'array',
      itemCount: value.length,
      totalChars: serializedResult.length,
      preview: boundedString(serializedResult, INSPECT_PREVIEW_CHARS),
      readHint,
    };
  }
  return {
    ...base,
    valueType: value === null ? 'null' : typeof value,
    totalChars: serializedResult.length,
    preview: boundedString(serializedResult, INSPECT_PREVIEW_CHARS),
    readHint,
  };
}

function queryArchiveItem(
  ref: string,
  value: unknown,
  itemId: string | undefined,
  offset: number,
  limit: number,
): unknown {
  if (!itemId) return archiveFailure(ref, 'item_id_required');
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : undefined;
  if (!items) return archiveFailure(ref, 'not_queryable');
  const item = items.find(
    (candidate) =>
      isRecord(candidate) && String(candidate.itemId ?? candidate.item_id ?? '') === itemId,
  );
  if (!isRecord(item)) {
    return archiveFailure(ref, 'item_not_found', {
      itemId,
      availableItemIds: items
        .map((candidate) =>
          isRecord(candidate)
            ? boundedString(String(candidate.itemId ?? candidate.item_id ?? ''))
            : '',
        )
        .filter(Boolean)
        .slice(0, 25),
    });
  }
  const content =
    typeof item.summary === 'string'
      ? item.summary
      : typeof item.result === 'string'
        ? item.result
        : JSON.stringify(item);
  return pagedContent({
    ref,
    operation: 'query',
    content,
    offset,
    limit,
    extra: {
      itemId,
      item: inspectItem(item),
    },
  });
}

function pagedContent(input: {
  ref: string;
  operation: 'read' | 'query';
  content: string;
  offset: number;
  limit: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const offset = Math.min(input.offset, input.content.length);
  const requestedEnd = Math.min(input.content.length, offset + input.limit);
  const buildPage = (end: number): Record<string, unknown> => ({
    ok: true,
    kind: 'tool_result_archive',
    operation: input.operation,
    ref: input.ref,
    offset,
    limit: end - offset,
    totalChars: input.content.length,
    nextOffset: end < input.content.length ? end : null,
    hasMore: end < input.content.length,
    content: input.content.slice(offset, end),
    ...(input.extra ?? {}),
  });
  let low = offset;
  let high = requestedEnd;
  while (low < high) {
    const candidateEnd = Math.ceil((low + high) / 2);
    if (JSON.stringify(buildPage(candidateEnd)).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS) {
      low = candidateEnd;
    } else {
      high = candidateEnd - 1;
    }
  }
  return buildPage(low);
}

/**
 * Locate a literal (case-insensitive) substring inside the archived text and
 * return matched offsets with bounded context snippets. The pattern is escaped
 * before using a Unicode-aware literal regex, so it cannot inject regex syntax
 * or introduce pathological backtracking. Matches accumulate only while the
 * envelope stays within
 * TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS, and `nextOffset` resumes the scan.
 */
function searchArchive(
  ref: string,
  text: string,
  pattern: string | undefined,
  offset: number,
): unknown {
  if (!pattern) return archiveFailure(ref, 'pattern_required');
  // Escape the user pattern before using a Unicode-aware literal regex. This
  // preserves original source indices while retaining contextual case folding
  // (for example, Greek final sigma), and remains safe from regex injection or
  // pathological backtracking because the pattern is literal.
  const matcher = new RegExp(escapeRegExp(pattern), 'giu');
  const base = {
    ok: true as const,
    kind: 'tool_result_archive' as const,
    operation: 'search' as const,
    ref,
    pattern: boundedString(pattern, MAX_SEARCH_PATTERN_CHARS),
    totalChars: text.length,
  };
  const buildResponse = (
    matches: unknown[],
    nextOffset: number | null,
  ): Record<string, unknown> => ({
    ...base,
    matchCount: matches.length,
    matches,
    nextOffset,
    hasMore: nextOffset !== null,
  });

  const matches: unknown[] = [];
  // Line numbers are assigned by a single forward scan; match offsets only
  // increase, so total work stays linear in the text length.
  let scanChar = 0;
  let scanLine = 1;
  const lineAt = (index: number): number => {
    while (scanChar < index && scanChar < text.length) {
      if (text.charCodeAt(scanChar) === 10) scanLine++;
      scanChar++;
    }
    return scanLine;
  };

  let from = normalizeSearchOffset(text, offset);
  while (matches.length < TOOL_RESULT_ARCHIVE_MAX_SEARCH_MATCHES) {
    matcher.lastIndex = from;
    const match = matcher.exec(text);
    if (!match) return buildResponse(matches, null);
    const index = match.index;
    const matchEnd = index + match[0].length;
    // Keep the complete match representable when the accepted pattern is
    // longer than the normal snippet budget; trim surrounding context first.
    const snippetLimit = Math.min(
      MAX_SEARCH_PATTERN_CHARS + SEARCH_SNIPPET_RADIUS * 2,
      Math.max(MAX_SEARCH_SNIPPET_CHARS, matchEnd - index),
    );
    const contextBudget = Math.max(0, snippetLimit - (matchEnd - index));
    const before = Math.min(SEARCH_SNIPPET_RADIUS, Math.floor(contextBudget / 2));
    const after = Math.min(SEARCH_SNIPPET_RADIUS, contextBudget - before);
    const snippetStart = Math.max(0, index - before);
    const snippetEnd = Math.min(text.length, matchEnd + after);
    const candidate = {
      offset: index,
      line: lineAt(index),
      snippetStart,
      snippet: text.slice(snippetStart, snippetEnd),
    };
    if (
      JSON.stringify(buildResponse([...matches, candidate], index)).length >
      TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS
    ) {
      // This match would overflow the budget; resume here next call.
      return buildResponse(matches, index);
    }
    matches.push(candidate);
    from = index + Math.max(1, match[0].length);
  }
  // Hit the per-page match cap; report where an unread match still waits.
  matcher.lastIndex = from;
  const more = matcher.exec(text);
  return buildResponse(matches, more === null ? null : more.index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchOffset(text: string, offset: number): number {
  const clamped = Math.min(Math.max(0, offset), text.length);
  if (
    clamped > 0 &&
    clamped < text.length &&
    isLowSurrogate(text.charCodeAt(clamped)) &&
    isHighSurrogate(text.charCodeAt(clamped - 1))
  ) {
    return clamped + 1;
  }
  return clamped;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

/** Count 1-based lines in text (an empty string has zero lines). */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Collect up to `maxLines` lines starting at the zero-based `lineOffset` without
 * materializing the whole text as an array — the scan stops after the window,
 * so cost is bounded by the requested window, not the archive size.
 */
function collectLineWindow(
  text: string,
  lineOffset: number,
  maxLines: number,
): { lines: string[]; startChar: number } {
  if (text.length === 0) return { lines: [], startChar: 0 };
  let cursor = 0;
  let line = 0;
  while (line < lineOffset && cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    if (nl === -1) return { lines: [], startChar: text.length };
    cursor = nl + 1;
    line++;
  }
  const startChar = cursor;
  const lines: string[] = [];
  while (lines.length < maxLines && cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    if (nl === -1) {
      lines.push(text.slice(cursor));
      break;
    }
    lines.push(text.slice(cursor, nl));
    cursor = nl + 1;
    if (cursor > text.length) break;
  }
  return { lines, startChar };
}

/**
 * Read a bounded window of whole lines. offset/limit count lines; the returned
 * line count is trimmed by binary search so the response never exceeds
 * TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS, and `nextLineOffset` resumes paging.
 */
function pagedLines(ref: string, text: string, lineOffset: number, lineLimit: number): unknown {
  const totalLines = countLines(text);
  const { lines } = collectLineWindow(text, lineOffset, lineLimit);
  const buildPage = (count: number): Record<string, unknown> => {
    const endLine = lineOffset + count;
    const hasMore = endLine < totalLines;
    return {
      ok: true,
      kind: 'tool_result_archive',
      operation: 'read',
      ref,
      unit: 'line',
      lineOffset,
      lineLimit: count,
      totalLines,
      nextLineOffset: hasMore ? endLine : null,
      hasMore,
      content: lines.slice(0, count).join('\n'),
    };
  };
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (JSON.stringify(buildPage(candidate)).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }
  if (low === 0 && lines.length > 0) {
    return archiveFailure(ref, 'line_too_large', {
      unit: 'line',
      lineOffset,
      totalLines,
      lineChars: lines[0]!.length,
      readHint: 'Retry with operation "read" and unit "char" to page this oversized line.',
    });
  }
  return buildPage(low);
}

function inspectItem(value: unknown): unknown {
  if (!isRecord(value)) return { valueType: value === null ? 'null' : typeof value };
  return {
    ...(typeof value.itemId === 'string' ? { itemId: boundedString(value.itemId) } : {}),
    ...(typeof value.item_id === 'string' ? { itemId: boundedString(value.item_id) } : {}),
    ...(typeof value.index === 'number' ? { index: value.index } : {}),
    ...(typeof value.started === 'boolean' ? { started: value.started } : {}),
    ...(typeof value.status === 'string' ? { status: boundedString(value.status) } : {}),
    ...(typeof value.profile === 'string' ? { profile: boundedString(value.profile) } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: boundedString(value.agentId) } : {}),
    ...(typeof value.agentName === 'string' ? { agentName: boundedString(value.agentName) } : {}),
    ...(typeof value.childSessionId === 'string'
      ? { childSessionId: boundedString(value.childSessionId) }
      : {}),
    ...(typeof value.turnId === 'string' ? { turnId: boundedString(value.turnId) } : {}),
    ...(typeof value.runId === 'string' ? { runId: boundedString(value.runId) } : {}),
    ...(typeof value.resumedFromRunId === 'string'
      ? { resumedFromRunId: boundedString(value.resumedFromRunId) }
      : {}),
    ...(Array.isArray(value.artifactIds)
      ? {
          artifactIds: value.artifactIds
            .filter((artifactId): artifactId is string => typeof artifactId === 'string')
            .slice(0, 8)
            .map(boundedString),
          artifactCount: value.artifactIds.length,
        }
      : {}),
    ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
    ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
    ...(typeof value.failureClass === 'string'
      ? { failureClass: boundedString(value.failureClass) }
      : {}),
    ...(typeof value.summary === 'string' ? { summaryChars: value.summary.length } : {}),
    ...(typeof value.result === 'string' ? { resultChars: value.result.length } : {}),
  };
}

function boundedString(value: string, max: number = MAX_METADATA_STRING_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function deserializeArchive(serialized: string): unknown {
  if (serialized === 'undefined') return undefined;
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return TOOL_RESULT_ARCHIVE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(TOOL_RESULT_ARCHIVE_MAX_LIMIT, Math.floor(value as number)));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function archiveFailure(ref: string, reason: string, detail?: Record<string, unknown>): unknown {
  return {
    ok: false,
    kind: 'tool_result_archive',
    ref,
    reason,
    ...(detail ?? {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
