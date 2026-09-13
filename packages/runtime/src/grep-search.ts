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

import { spawn } from 'node:child_process';

export const GREP_MAX_LINES_PER_FILE = 50;
export const GREP_MAX_LINES = 200;
export const GREP_MAX_MATCH_BYTES = 24 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

export interface GrepResult {
  matches: string[];
  matchedLines: number;
  returnedLines: number;
  omittedLines: number;
  truncated: boolean;
}

export interface GrepRunInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onStdout(chunk: Buffer): void;
}

export interface GrepRunResult {
  exitCode: number;
  stderrTail: string;
}

export type GrepRunner = (input: GrepRunInput) => Promise<GrepRunResult>;

export class GrepSearchError extends Error {}

export async function searchFiles(
  input: {
    executable: string;
    cwd: string;
    path: string;
    pattern: string;
    glob?: string;
    maxCountPerFile: number;
    limit: number;
    timeoutMs: number;
    abortSignal?: AbortSignal;
  },
  run: GrepRunner = runRipgrep,
): Promise<GrepResult> {
  const matches: string[] = [];
  let matchBytes = 2;
  let returnedInFile = 0;
  let matchedLines: number | undefined;
  let pending = Buffer.alloc(0);
  let oversized = false;
  const perFile = Math.min(input.maxCountPerFile, GREP_MAX_LINES_PER_FILE);
  const limit = Math.min(input.limit, GREP_MAX_LINES);
  // Text mode prevents binary detection from stopping a file early. Single-threaded
  // output keeps each file's begin/match/end records together without a growing map.
  const args = ['--no-config', '--json', '--text', '--threads=1', '--line-buffered'];
  if (input.glob) args.push('--glob', input.glob);
  args.push('--', input.pattern, input.path);
  const result = await run({ ...input, args, onStdout });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GrepSearchError(
      `Grep failed; search totals are unknown. Check the regex and search path, then retry.\n${result.stderrTail.trim()}`,
    );
  }
  if (pending.length || oversized || matchedLines === undefined || matchedLines < matches.length) {
    throw new GrepSearchError(
      'Grep did not produce a complete search summary; search totals are unknown. Retry with a narrower path or glob.',
    );
  }
  return {
    matches,
    matchedLines,
    returnedLines: matches.length,
    omittedLines: matchedLines - matches.length,
    truncated: matchedLines > matches.length,
  };

  function onStdout(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!oversized) {
        const part = chunk.subarray(start, end);
        if (pending.length + part.length > MAX_RECORD_BYTES) {
          oversized = true;
          pending = Buffer.alloc(0);
        } else {
          pending = Buffer.concat([pending, part]);
        }
      }
      if (newline === -1) break;
      // Oversized match records are omitted, not shortened. The final engine
      // summary still counts their lines without retaining their content.
      if (!oversized) consumeRecord(pending.toString('utf8'));
      pending = Buffer.alloc(0);
      oversized = false;
      start = newline + 1;
    }
  }

  function consumeRecord(line: string): void {
    const event = JSON.parse(line);
    if (matchedLines !== undefined)
      throw new GrepSearchError('Grep emitted data after its summary; search totals are unknown.');
    if (event.type === 'begin') returnedInFile = 0;
    if (event.type === 'summary') {
      const count = event.data.stats.matched_lines;
      if (!Number.isSafeInteger(count) || count < 0)
        throw new GrepSearchError(
          'Grep returned an invalid line count; search totals are unknown.',
        );
      matchedLines = count;
    }
    if (event.type !== 'match' || matches.length >= limit || returnedInFile >= perFile) return;
    const { path, lines, line_number: lineNumber } = event.data;
    // ripgrep uses base64 for non-UTF8 paths/content; do not pass a lossy decoded
    // filename or pretend that a replacement-character preview is the original.
    if (typeof path.text !== 'string' || typeof lines.text !== 'string') return;
    const match = `${path.text}:${lineNumber}:${lines.text.replace(/\r?\n$/, '')}`;
    const bytes = Buffer.byteLength(JSON.stringify(match)) + (matches.length ? 1 : 0);
    if (matchBytes + bytes > GREP_MAX_MATCH_BYTES) return;
    matchBytes += bytes;
    matches.push(match);
    returnedInFile++;
  }
}

async function runRipgrep(input: GrepRunInput): Promise<GrepRunResult> {
  input.abortSignal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let failure: unknown;
    const timer = setTimeout(
      () =>
        fail(
          new GrepSearchError(
            'Grep timed out; search totals are unknown. Retry with a narrower path or glob.',
          ),
        ),
      input.timeoutMs,
    );
    const abort = () => fail(new GrepSearchError('Grep was cancelled; search totals are unknown.'));
    input.abortSignal?.addEventListener('abort', abort, { once: true });
    if (input.abortSignal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      try {
        input.onStdout(chunk);
      } catch {
        fail(
          new GrepSearchError('Grep returned invalid search output; search totals are unknown.'),
        );
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-MAX_STDERR_BYTES);
    });
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      input.abortSignal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ exitCode: exitCode ?? 2, stderrTail: stderrTail.toString('utf8') });
    });
    function fail(error: unknown): void {
      failure ??= error;
      child.kill('SIGKILL');
    }
  });
}
