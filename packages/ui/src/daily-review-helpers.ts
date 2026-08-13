/**
 * Pure helpers backing the DailyReviewPanel — formatters, error
 * mappers, and the Markdown serializer.
 *
 * PR-UI-LIB-EXTRACT-2 (WAWQAQ msg `510fef52`, round 3/10): pulled
 * out of `components.tsx`. `formatDailyReviewMarkdown` was already
 * a public export from `@maka/ui` (consumed by the desktop
 * renderer's main.tsx + the `daily-review-copy-feedback-contract`
 * test); the other four were internal to the panel file. byte-
 * for-byte equivalent; behavior unchanged; `index.ts` re-exports
 * everything from the new module so the public API surface stays
 * identical.
 *
 * Why this seam: serializing a Daily Review to Markdown is a pure
 * `summary → string` transform that has nothing to do with React.
 * Living next to ~600 lines of DailyReviewPanel JSX made it hard
 * to test (or even find) the formatter in isolation.
 */

import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewRange,
  DailyReviewSummary,
} from '@maka/core/daily-review';

import type { UiLocale } from '@maka/core/ui-locale';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import { getDailyReviewCopy } from './daily-review-copy.js';

export function dailyReviewScopeKey(offsetDays: number, range: DailyReviewRange): string {
  return `${offsetDays}:${range}`;
}

export function dailyReviewPanelErrorMessage(error: unknown, locale: UiLocale): string {
  const fallback = getDailyReviewCopy(locale).errorFallback;
  return locale === 'zh'
    ? generalizedErrorMessageChinese(error, fallback)
    : generalizedErrorMessage(error, fallback);
}

export function formatDailyReviewArchiveTitle(
  archive: DailyReviewArchive | DailyReviewArchiveSummary,
  locale: UiLocale,
): string {
  const copy = getDailyReviewCopy(locale);
  const d = new Date(archive.day.fromMs);
  const date = d.toLocaleDateString(uiLocaleToIntlLocale(locale), { month: '2-digit', day: '2-digit' });
  const rangeLabel = copy.archive.range[archive.range];
  return copy.archive.title(date, rangeLabel);
}

export function formatDailyReviewArchiveGeneratedAt(generatedAt: number, locale: UiLocale): string {
  return new Date(generatedAt).toLocaleString(uiLocaleToIntlLocale(locale), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * PR-DAILY-REVIEW-COPY-0: produce a Markdown summary of the current
 * Daily Review for clipboard share. Sessions list is title-only —
 * we deliberately skip lastMessagePreview because the message body
 * may contain content the user does not want in a shared note.
 */
export function formatDailyReviewMarkdown(
  summary: DailyReviewSummary,
  dayLabel: string,
  locale: UiLocale,
): string {
  const copy = getDailyReviewCopy(locale).markdown;
  const intlLocale = uiLocaleToIntlLocale(locale);
  const lines: string[] = [];
  lines.push(copy.title(dayLabel));
  lines.push('');
  lines.push(`- ${copy.conversations}${copy.separator} ${summary.totals.sessionCount}`);
  lines.push(`- ${copy.requests}${copy.separator} ${summary.totals.requestCount}`);
  lines.push(`- ${copy.tokens}${copy.separator} ${summary.totals.totalTokens.toLocaleString(intlLocale)}`);
  lines.push(`- ${copy.cost}${copy.separator} $${summary.totals.costUsd.toFixed(2)}`);
  if (summary.totals.errorCount > 0) {
    lines.push(`- ${copy.errors}${copy.separator} ${summary.totals.errorCount}`);
  }
  if (summary.sessions.length > 0) {
    lines.push('');
    lines.push(`## ${copy.activeConversations}`);
    for (const session of summary.sessions) {
      lines.push(`- ${session.name}`);
    }
  }
  if (summary.topModels.length > 0) {
    lines.push('');
    lines.push(`## ${copy.modelUsage}`);
    for (const entry of summary.topModels) {
      const cost = entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(2)}` : '';
      lines.push(`- ${entry.label}${copy.separator} ${copy.requestCount(entry.requests)} · ${entry.totalTokens.toLocaleString(intlLocale)} tok${cost}`);
    }
  }
  if (summary.topTools.length > 0) {
    lines.push('');
    lines.push(`## ${copy.toolCalls}`);
    for (const entry of summary.topTools) {
      lines.push(`- ${entry.label}${copy.separator} ${copy.requestCount(entry.requests)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Archive headers used to print the raw internal model key
 * (`<connectionSlug>::<modelId>`, e.g. `zai-live::glm-4.5`) — an
 * implementation detail leaking into UI copy (designer audit P1-8).
 * Show just the model id; the connection is not something the reader
 * needs to decode a report.
 */
export function formatDailyReviewModelLabel(modelKey: string): string {
  const separatorIndex = modelKey.lastIndexOf('::');
  if (separatorIndex === -1) return modelKey;
  const modelId = modelKey.slice(separatorIndex + 2).trim();
  return modelId.length > 0 ? modelId : modelKey;
}
