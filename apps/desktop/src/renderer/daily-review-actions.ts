import type { DailyReviewArchive } from '@maka/core/daily-review';
import type { UiLocale } from '@maka/core/ui-locale';
import { dailyReviewArchiveId } from '@maka/core/daily-review';

import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';

export function dailyReviewExportDefaultName(
  input: Pick<DailyReviewArchive, 'day' | 'range'>,
): string {
  return `maka-daily-review-${dailyReviewArchiveId(input.day, input.range)}.md`;
}

export function dailyReviewActionErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}
