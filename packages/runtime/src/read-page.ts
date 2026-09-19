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

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const READ_PAGE_MAX_CHARS = 7_500;
export const READ_DESCRIPTION =
  'Read a text file, view a PNG/JPEG/GIF/WebP image, or read a Maka resource returned by a tool. Only path is required. Images are returned as images, without text pagination. Text reads return one bounded page by default; offset and limit select a line range within the response-size cap. If next is non-null, pass its complete object to Read to continue, including partial lines; otherwise the requested range is complete.';
export const readParameters = z.object({
  path: z
    .string({
      error: 'path is required. Provide a file path or the Maka address returned by a tool.',
    })
    .min(1, 'path cannot be empty. Provide the location to read.')
    .describe(
      'File path relative to the session cwd, an absolute path, or a Maka address returned by a tool.',
    ),
  offset: z
    .number({ error: 'offset must be a non-negative integer. Omit it to start at the beginning.' })
    .int('offset must be an integer. Omit it to start at the beginning.')
    .nonnegative('offset must be non-negative. Omit it to start at the beginning.')
    .optional()
    .describe(
      'Zero-based starting text line; defaults to 0. offset 200 starts at line 201. Omit for images or when using a continuation address.',
    ),
  limit: z
    .number({ error: 'limit must be a positive integer. Omit it to read one bounded page.' })
    .int('limit must be an integer. Omit it to read one bounded page.')
    .positive('limit must be positive. Omit it to read one bounded page.')
    .optional()
    .describe(
      'Maximum text lines in the requested range. Omit for images or to browse one bounded page at a time. Use next to obtain any remaining content.',
    ),
});
export type ReadInput = z.infer<typeof readParameters>;
export const readPageSchema = z.object({
  content: z.string(),
  offset: z.number().int().nonnegative(),
  returnedLines: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  partialLine: z.literal(true).optional(),
  next: readParameters.nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ReadPage = z.infer<typeof readPageSchema>;
export const readContinuationSchema = z
  .object({
    position: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();

const CONTINUATION_PREFIX = 'maka://read/';

export function resolveReadInput(input: ReadInput): {
  path: string;
  position?: number;
  digest?: string;
} {
  if (!input.path.startsWith(CONTINUATION_PREFIX)) return { path: input.path };
  try {
    const url = new URL(input.path);
    const path = Buffer.from(url.pathname.slice(1), 'base64url').toString('utf8');
    const at = url.searchParams.get('at') ?? '';
    const position = Number(at);
    const digest = url.searchParams.get('sha') ?? '';
    if (
      !path ||
      path.startsWith(CONTINUATION_PREFIX) ||
      !/^\d+$/.test(at) ||
      !Number.isSafeInteger(position) ||
      !/^[a-f0-9]{32}$/.test(digest) ||
      input.offset !== undefined
    )
      throw new Error();
    return { path, position, digest };
  } catch {
    throw new Error(
      'Invalid Read continuation. Copy the complete next object from the preceding result. To start again, use the original path and omit offset and limit.',
    );
  }
}

function digestText(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

export function readPage(
  content: string,
  input: ReadInput,
  maxChars = READ_PAGE_MAX_CHARS,
  continuation?: z.infer<typeof readContinuationSchema>,
): ReadPage {
  const resolved = continuation ? { path: input.path, ...continuation } : resolveReadInput(input);
  if (resolved.digest && digestText(content) !== resolved.digest) {
    throw new Error(
      'The content changed since the previous page. This continuation cannot be used. Read the original path again to start from the current content.',
    );
  }
  if (resolved.position !== undefined && resolved.position > content.length) {
    throw new Error(
      'Invalid Read continuation position. Copy the complete next object from the preceding result.',
    );
  }
  const starts = [0];
  for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1))
    starts.push(at + 1);
  const totalLines = starts.length;
  const lineAt = (position: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle]! <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const offset = resolved.position === undefined ? (input.offset ?? 0) : lineAt(resolved.position);
  const start = resolved.position ?? starts[Math.min(offset, totalLines)] ?? content.length;
  const lastLine = Math.min(totalLines, offset + (input.limit ?? totalLines));
  const end = lastLine < totalLines ? starts[lastLine]! - 1 : content.length;
  let digest = resolved.digest;
  const makePage = (stop: number): ReadPage => {
    const complete = stop >= end;
    const nextLine = Math.max(offset, lineAt(stop));
    const boundary = stop === (starts[nextLine + 1] ?? content.length + 1) - 1;
    const partialLine = !complete && !boundary;
    const returnedLines =
      offset >= totalLines
        ? 0
        : complete
          ? lastLine - offset
          : nextLine - offset + (partialLine ? 0 : 1);
    let next: ReadInput | null = null;
    if (!complete) {
      const remaining = input.limit === undefined ? undefined : input.limit - returnedLines;
      const position = partialLine ? stop : stop + 1;
      next = {
        path: `${CONTINUATION_PREFIX}${Buffer.from(resolved.path).toString('base64url')}?at=${position}&sha=${(digest ??= digestText(content))}`,
        ...(remaining === undefined ? {} : { limit: remaining }),
      };
    }
    return {
      content: content.slice(start, Math.max(start, stop)),
      offset,
      returnedLines,
      totalLines,
      ...(partialLine || (offset < totalLines && start > starts[offset]!)
        ? { partialLine: true as const }
        : {}),
      next,
    };
  };
  if (end - start <= maxChars) {
    const page = makePage(end);
    if (JSON.stringify(page).length <= maxChars) return page;
  }
  let low = start;
  let high = Math.min(end, start + maxChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(makePage(middle)).length <= maxChars) low = middle;
    else high = middle - 1;
  }
  // Never split a UTF-16 surrogate pair between responses.
  if (low > start && /[\uD800-\uDBFF]/.test(content[low - 1]!)) low--;
  if (low <= start)
    throw new Error(
      'The Read address is too long to fit a bounded response. Use a shorter original path.',
    );
  const newline = content.lastIndexOf('\n', low);
  if (newline > start) low = newline;
  return makePage(low);
}

export function readableToolResult(serialized: string): string {
  try {
    const value: unknown = JSON.parse(serialized);
    if (typeof value === 'string') return value;
    if (
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 2 &&
      'kind' in value &&
      value.kind === 'text' &&
      'text' in value &&
      typeof value.text === 'string'
    )
      return value.text;
    if (
      value &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      'content' in value &&
      typeof value.content === 'string'
    )
      return value.content;
    if (
      value &&
      typeof value === 'object' &&
      'kind' in value &&
      (value.kind === 'terminal' || value.kind === 'shell_run')
    ) {
      const shell = value as Record<string, unknown>;
      let output: string | undefined;
      if (typeof shell.output === 'string') output = shell.output;
      if (shell.output && typeof shell.output === 'object') {
        const shellOutput = shell.output as Record<string, unknown>;
        output = (
          shellOutput.mode === 'pty'
            ? [shellOutput.scrollback, shellOutput.screen, shellOutput.lastAlternateScreen]
            : [shellOutput.stdout, shellOutput.stderr]
        )
          .filter((part): part is string => typeof part === 'string' && part.length > 0)
          .join('\n');
      }
      if (typeof shell.failureMessage === 'string' && shell.failureMessage.length > 0)
        return output ? `${output}\n${shell.failureMessage}` : shell.failureMessage;
      if (output !== undefined) return output;
    }
  } catch {
    /* Plain text projections are already readable. */
  }
  return serialized;
}

export function readToolResultPage(
  serialized: string,
  input: ReadInput,
  maxChars = READ_PAGE_MAX_CHARS,
): ReadPage {
  let metadata: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(serialized);
    if (value?.kind === 'terminal' || value?.kind === 'shell_run') {
      metadata = Object.fromEntries(
        Object.entries(value).filter(([key]) =>
          ['kind', 'status', 'exitCode', 'signal', 'revision', 'mode'].includes(key),
        ),
      );
      if (value.output && typeof value.output === 'object')
        for (const key of ['stdoutTruncated', 'stderrTruncated', 'redacted']) {
          if (typeof value.output[key] === 'boolean') metadata[key] = value.output[key];
        }
    }
  } catch {
    /* Text has no separate execution metadata. */
  }
  const page = readPage(
    readableToolResult(serialized),
    input,
    maxChars - (metadata ? JSON.stringify(metadata).length + 16 : 0),
  );
  return metadata ? { ...page, metadata } : page;
}
