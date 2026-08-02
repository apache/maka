import type { UiLocale } from '@maka/core';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

export function dailyReviewExportDefaultName(label: string): string {
  const zh = getShellRemainingCopy('zh').dailyReview;
  const en = getShellRemainingCopy('en').dailyReview;
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const scope = label.includes('30')
    ? '30d'
    : label.includes('7')
      ? '7d'
      : label === zh.yesterday || label === en.yesterday
        ? 'yesterday'
        : label === zh.today || label === en.today
          ? 'today'
          : 'day';
  return `maka-daily-review-${scope}-${yyyy}-${mm}-${dd}.md`;
}

export function dailyReviewActionErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}
