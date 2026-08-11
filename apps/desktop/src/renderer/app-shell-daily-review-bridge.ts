import type { DailyReviewRange } from '@maka/core/daily-review';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

export function createAppShellDailyReviewBridge(locale: UiLocale = 'zh') {
  const copy = getShellRemainingCopy(locale).dailyReview;
  return {
    async fetchDay(offsetDays: number, daySpan?: number) {
      const result = await window.maka.dailyReview.day(offsetDays, daySpan);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    runOnce(input: { range: DailyReviewRange; offsetDays?: number }) {
      const runOnce = window.maka.dailyReview.runOnce;
      if (!runOnce) throw new Error(copy.unavailable);
      return runOnce(input);
    },
    listArchives() {
      const listArchives = window.maka.dailyReview.listArchives;
      if (!listArchives) throw new Error(copy.historyUnavailable);
      return listArchives();
    },
    async getArchive(archiveId: string) {
      const getArchive = window.maka.dailyReview.getArchive;
      if (!getArchive) throw new Error(copy.historyUnavailable);
      const archive = await getArchive(archiveId);
      if (!archive) throw new Error(copy.archiveMissing);
      return archive;
    },
  };
}
