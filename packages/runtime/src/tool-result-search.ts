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

import {
  GREP_MAX_LINES_PER_FILE,
  GrepSearchError,
  runRipgrep,
  type GrepResult,
  type GrepRunner,
} from './grep-search.js';
import {
  readableToolResult,
  readToolResultMetadata,
  READ_PAGE_MAX_BYTES,
  readContinuationPath,
  readTextDigest,
  type ReadInput,
} from './read-page.js';
import { defaultRipgrepCandidates, resolveRipgrepExecutable } from './ripgrep-executable.js';
import {
  currentRipgrepEnvironment,
  ripgrepMissingOnPathMessage,
  RipgrepUnavailableError,
} from './ripgrep-guidance.js';

const EXCERPT_MAX_BYTES = 512;
const SEARCH_TIMEOUT_MS = 10_000;
const INCOMPLETE_SEARCH =
  'Grep did not complete; search totals are unknown. Retry with a narrower pattern.';

export interface ToolResultSearchResult extends GrepResult {
  readHints?: Array<{ matchIndex: number; read: ReadInput }>;
  metadata?: Record<string, unknown>;
}

/** Search exactly Read's retained view; keep positions rather than full matched lines. */
export async function searchToolResultText(
  input: {
    path: string;
    pattern: string;
    serializedResult: string;
    abortSignal?: AbortSignal;
    executable?: string;
    timeoutMs?: number;
  },
  run: GrepRunner = runRipgrep,
): Promise<ToolResultSearchResult> {
  input.abortSignal?.throwIfAborted();
  const executable =
    input.executable ?? (await resolveRipgrepExecutable(defaultRipgrepCandidates(process.env)));
  if (!executable)
    throw new RipgrepUnavailableError(ripgrepMissingOnPathMessage(currentRipgrepEnvironment()));
  const text = readableToolResult(input.serializedResult);
  const bytes = Buffer.from(text);
  const positions: Array<{ line: number; at: number }> = [];
  let matchedLines = 0;
  let lastLine = 0;
  let lastPosition = 0;
  let prefix = '';
  let inMatch = false;
  // rg --json repeats the entire source line, even with --only-matching. A
  // minified JSON line can be megabytes. Parse only the numeric prefix of
  // ordinary -n -b -o records and discard each match body as it streams past.
  if (input.pattern === '') {
    // Empty regexes emit a record per character with -o. Grep counts lines,
    // so the equivalent bounded pass needs only one position per source line.
    for (let at = 0, line = 1; at < bytes.length; line++) {
      record(line, at);
      const end = bytes.indexOf(10, at);
      at = end === -1 ? bytes.length : end + 1;
    }
  } else {
    const result = await run({
      executable,
      stdin: text,
      timeoutMs: input.timeoutMs ?? SEARCH_TIMEOUT_MS,
      abortSignal: input.abortSignal,
      args: [
        '--no-config',
        '--text',
        // The source is already Read's UTF-8 text; do not strip a BOM or transcode it.
        '--encoding=none',
        '--only-matching',
        '--line-number',
        '--byte-offset',
        '--no-filename',
        '--no-heading',
        '--color=never',
        '--line-buffered',
        '--',
        input.pattern,
        '-',
      ],
      onStdout(chunk) {
        for (let at = 0; at < chunk.length; ) {
          if (inMatch) {
            const end = chunk.indexOf(10, at);
            if (end === -1) return;
            inMatch = false;
            at = end + 1;
            continue;
          }
          const char = String.fromCharCode(chunk[at++]!);
          prefix += char;
          if (prefix.length > 40 || !/^[0-9:]+$/.test(prefix))
            throw new GrepSearchError(INCOMPLETE_SEARCH);
          if (char !== ':' || prefix.indexOf(':') === prefix.length - 1) continue;
          const match = /^([1-9]\d*):(0|[1-9]\d*):$/.exec(prefix);
          if (!match) throw new GrepSearchError(INCOMPLETE_SEARCH);
          record(Number(match[1]), Number(match[2]));
          prefix = '';
          inMatch = true;
        }
      },
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GrepSearchError(
        `Grep failed; search totals are unknown. Check the regex, then retry.\n${result.stderrTail.trim().slice(-1024)}`,
      );
    }
    if (
      prefix ||
      inMatch ||
      (result.exitCode === 1 && matchedLines > 0) ||
      (result.exitCode === 0 && matchedLines === 0)
    )
      throw new GrepSearchError(INCOMPLETE_SEARCH);
  }
  input.abortSignal?.throwIfAborted();
  const metadata = readToolResultMetadata(input.serializedResult);
  const output: ToolResultSearchResult = {
    matches: [],
    matchedLines,
    returnedLines: 0,
    omittedLines: matchedLines,
    truncated: matchedLines > 0,
    ...(metadata ? { metadata } : {}),
  };
  const fits = () => Buffer.byteLength(JSON.stringify(output)) <= READ_PAGE_MAX_BYTES;
  if (!fits()) throw new GrepSearchError('Tool-result metadata exceeds the bounded Grep response.');
  let digest: string | undefined;
  let decodedThrough = 0;
  let charsThrough = 0;
  for (const { line, at } of positions) {
    const lineStart = at === 0 ? 0 : bytes.lastIndexOf(10, at - 1) + 1;
    const newline = bytes.indexOf(10, at);
    let lineEnd = newline === -1 ? bytes.length : newline;
    if (newline !== -1 && bytes[lineEnd - 1] === 13) lineEnd--;
    let start = lineStart;
    let end = lineEnd;
    if (lineEnd - lineStart > EXCERPT_MAX_BYTES) {
      start = Math.max(lineStart, Math.min(at - 128, lineEnd - EXCERPT_MAX_BYTES));
      end = Math.min(lineEnd, start + EXCERPT_MAX_BYTES);
      // rg offsets count UTF-8 bytes; Read continuations count UTF-16 units.
      while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
      while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    }
    const clipped = start > lineStart || end < lineEnd;
    const excerpt = `${start > lineStart ? '…' : ''}${bytes.subarray(start, end).toString('utf8')}${end < lineEnd ? '…' : ''}`;
    if (clipped) {
      charsThrough += bytes.subarray(decodedThrough, start).toString('utf8').length;
      decodedThrough = start;
      (output.readHints ??= []).push({
        matchIndex: output.matches.length,
        read: {
          path: readContinuationPath(input.path, charsThrough, (digest ??= readTextDigest(text))),
          limit: 1,
        },
      });
    }
    output.matches.push(`${input.path}:${line}:${excerpt}`);
  }
  output.returnedLines = output.matches.length;
  output.omittedLines = matchedLines - output.returnedLines;
  output.truncated = output.omittedLines > 0 || (output.readHints?.length ?? 0) > 0;
  // Budget the complete envelope, including counters, escaping and Read hints.
  while (!fits() && output.matches.length > 0) {
    output.matches.pop();
    output.readHints = output.readHints?.filter((hint) => hint.matchIndex < output.matches.length);
    if (output.readHints?.length === 0) delete output.readHints;
    output.returnedLines = output.matches.length;
    output.omittedLines = matchedLines - output.returnedLines;
    output.truncated = true;
  }
  return output;

  function record(line: number, at: number): void {
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(at) ||
      line < 1 ||
      line < lastLine ||
      at < lastPosition ||
      at > bytes.length
    )
      throw new GrepSearchError(INCOMPLETE_SEARCH);
    if (line !== lastLine) {
      matchedLines++;
      if (positions.length < GREP_MAX_LINES_PER_FILE) positions.push({ line, at });
    }
    lastLine = line;
    lastPosition = at;
  }
}
