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

import type { UiLocale } from '@maka/core/ui-locale';
import { getToolActivityCopy } from './copy.js';

export const TOOL_LINE_CAP = 500;

export function capLines(text: string): { body: string; capped: number } {
  const lines = text.split('\n');
  if (lines.length <= TOOL_LINE_CAP) return { body: text, capped: 0 };
  return {
    body: lines.slice(0, TOOL_LINE_CAP).join('\n'),
    capped: lines.length - TOOL_LINE_CAP,
  };
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * Binary-scaled size (1 KB = 1024 B), one decimal above bytes. A locale only
 * changes the decimal separator; the unit labels stay the same.
 */
export function formatBytes(bytes: number, locale?: UiLocale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = locale
    ? new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
        value,
      )
    : value.toFixed(1);
  return `${number} ${BYTE_UNITS[unit]}`;
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  // Round once, before splitting into units, so a value just under a unit
  // boundary carries into the next unit instead of printing `60s`.
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
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
