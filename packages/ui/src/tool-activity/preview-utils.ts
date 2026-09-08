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

import { normalizeSearchUrl } from '@maka/core/search';
import type { ToolResultContent } from '@maka/core/events';
import { redactSecrets } from '../redact.js';
import type { UiLocale } from '@maka/core/ui-locale';
import { getToolActivityCopy } from './copy.js';

export const TOOL_LINE_CAP = 500;

/** Read persists its file body inside a JSON content envelope. */
export function readResultText(result: ToolResultContent | undefined): string | undefined {
  if (result?.kind === 'text') return result.text;
  if (result?.kind !== 'json' || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return undefined;
  const record = result.value as Record<string, unknown>;
  // Preserve other fields (including diagnostics) in the generic JSON preview.
  return Object.keys(record).length === 1 && typeof record.content === 'string' ? record.content : undefined;
}

export function capLines(
  text: string,
  options: { lines?: number; chars?: number; tail?: boolean; paragraphs?: boolean } = {},
): { body: string; capped: number; hiddenChars: number } {
  const limit = options.lines ?? TOOL_LINE_CAP;
  const lines = text.split('\n');
  const kept = options.tail ? lines.slice(-limit) : lines.slice(0, limit);
  const joined = kept.join('\n');
  const chars = options.chars ?? Number.POSITIVE_INFINITY;
  let body = options.tail ? joined.slice(-chars) : joined.slice(0, chars);
  if (!options.tail && body.length < text.length) {
    // Prefer complete paragraphs for prose, then complete lines. A single
    // oversized line still needs a hard budget, but can end at a word boundary.
    const paragraph = options.paragraphs ? body.lastIndexOf('\n\n') : -1;
    const line = body.lastIndexOf('\n');
    if (paragraph > 0) body = body.slice(0, paragraph);
    else if (joined.length > chars && line > 0) body = body.slice(0, line);
    else if (options.paragraphs && joined.length > chars) {
      const word = body.search(/\s+\S*$/);
      if (word > 0) body = body.slice(0, word);
    }
  }
  // Never leave half a surrogate at a display boundary.
  if (options.tail && /^[\uDC00-\uDFFF]/.test(body)) body = body.slice(1);
  if (!options.tail && /[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  return { body, capped: Math.max(0, lines.length - body.split('\n').length), hiddenChars: text.length - body.length };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatUserVisibleToolText(text: string, locale: UiLocale): string {
  return text.replace(/\bUser denied permission(?: request)?\b|用户已拒绝权限请求/g, getToolActivityCopy(locale).permissionDenied);
}

/** One concise default summary of a tool failure: cap both characters and
 *  logical lines so a multi-line validation error cannot grow the banner to
 *  the ~2631px the issue tracked (a 240-char slice kept newlines, so 180 lines
 *  still rendered ~161 lines). The full redacted text stays in the disclosure
 *  for copy. */
export function summarizeErrorText(text: string): string {
  const MAX_CHARS = 240;
  const MAX_LINES = 4;
  const lines = text.split('\n');
  if (text.length <= MAX_CHARS && lines.length <= MAX_LINES) return text;
  const trimmed = lines.slice(0, MAX_LINES).join('\n').slice(0, MAX_CHARS);
  return `${trimmed}…`;
}

/** A citation label shared by the collapsed row and the expanded fetch card. */
export function webFetchReference(text: string, args: unknown) {
  const rawUrl = args && typeof args === 'object' && 'url' in args ? args.url : undefined;
  const normalized = typeof rawUrl === 'string' ? normalizeSearchUrl(redactSecrets(rawUrl)) : undefined;
  const url = normalized?.ok ? new URL(normalized.value) : undefined;
  const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m.exec(text.slice(0, 16_000))?.[1];
  return {
    title: redactSecrets(heading ?? url?.hostname ?? 'WebFetch').slice(0, 160),
    href: url?.href,
    location: url ? `${url.host}${url.pathname}` : undefined,
  };
}
