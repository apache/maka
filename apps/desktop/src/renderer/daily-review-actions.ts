import type { DailyReviewArchive, UiLocale } from '@maka/core';
import {
  dailyReviewArchiveId,
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
} from '@maka/core';

export function dailyReviewExportDefaultName(
  input: Pick<DailyReviewArchive, 'day' | 'range'>,
): string {
  return `maka-daily-review-${dailyReviewArchiveId(input.day, input.range)}.md`;
}

export function dailyReviewActionErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}
