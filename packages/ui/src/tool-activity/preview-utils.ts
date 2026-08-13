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

export function formatUserVisibleToolText(text: string, locale: UiLocale = 'zh'): string {
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
