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

import { normalizeUserSessionName } from '@maka/core/session-name';

const MAX_SOURCE_BYTES = 8 * 1024;
const MAX_FALLBACK_CODE_POINTS = 42;
export const SESSION_TITLE_GENERATION_TIMEOUT_MS = 15_000;

export function sessionTitleSource(input: { text: string; displayText?: string }): string {
  const raw = input.displayText ?? input.text;
  const cleaned = (raw.match(/<user-message>([\s\S]*?)<\/user-message>/i)?.[1] ?? raw)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim();
  const bytes = new TextEncoder().encode(cleaned);
  if (bytes.length <= MAX_SOURCE_BYTES) return cleaned;
  let end = MAX_SOURCE_BYTES;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

export function fallbackSessionTitle(sourceText: string): string | undefined {
  const firstLine = sourceText
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  return firstLine ? Array.from(firstLine).slice(0, MAX_FALLBACK_CODE_POINTS).join('') : undefined;
}

export function buildSessionTitlePrompt(sourceText: string): string {
  return `Create a descriptive 5–10 word title for the user message below. Use the user's language; for Chinese and similar languages, use an equivalently brief natural title. Output only the title.\n\n${sourceText}`;
}

export function cleanGeneratedSessionTitle(text: string): string | undefined {
  const firstLine = text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .trim();
  if (!firstLine) return undefined;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
  ];
  const unquoted = pairs.find(
    ([left, right]) => firstLine.startsWith(left) && firstLine.endsWith(right),
  )
    ? firstLine.slice(1, -1).trim()
    : firstLine;
  const normalized = normalizeUserSessionName(unquoted);
  return normalized.ok ? normalized.value : undefined;
}
