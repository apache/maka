import type { UiLocale } from '@maka/core/ui-locale';
import type { DailyReviewMarkdownActionInput } from '@maka/ui';
import { dailyReviewActionErrorMessage, dailyReviewExportDefaultName } from './daily-review-actions';
import { getShellCopy } from './locales/shell-copy.js';

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

type RefBox<T> = { current: T };

type ComposerAppendHandle = {
  appendText(text: string): void;
};

type DailyReviewFeedbackOptions = {
  shouldShowFeedback?: () => boolean;
};

export interface AppShellDailyReviewActions {
  copyDailyReviewMarkdown(input: DailyReviewMarkdownActionInput, options?: DailyReviewFeedbackOptions): Promise<void>;
  appendDailyReviewMarkdown(input: DailyReviewMarkdownActionInput): void;
  saveDailyReviewMarkdown(input: DailyReviewMarkdownActionInput, options?: DailyReviewFeedbackOptions): Promise<void>;
}

export function createAppShellDailyReviewActions(deps: {
  uiLocale: UiLocale;
  composerRef: RefBox<ComposerAppendHandle | null>;
  toastApi: ToastApi;
}): AppShellDailyReviewActions {
  const { uiLocale, composerRef, toastApi } = deps;
  const copy = getShellCopy(uiLocale).commandActions;

  async function copyDailyReviewMarkdown(input: DailyReviewMarkdownActionInput, options: DailyReviewFeedbackOptions = {}) {
    const shouldShowFeedback = options.shouldShowFeedback ?? (() => true);
    try {
      await navigator.clipboard.writeText(input.markdown);
      if (shouldShowFeedback()) {
        toastApi.success(
          copy.reviewCopied(input.label),
          copy.reviewSummary(input.totals.sessionCount, input.totals.requestCount),
        );
      }
    } catch (error) {
      if (shouldShowFeedback()) {
        toastApi.error(copy.copyFailedTitle, dailyReviewActionErrorMessage(error, copy.clipboardDenied, uiLocale));
      }
    }
  }

  function appendDailyReviewMarkdown(input: DailyReviewMarkdownActionInput): void {
    composerRef.current?.appendText(input.markdown);
    toastApi.success(
      copy.reviewPasted(input.label),
      copy.reviewSummary(input.totals.sessionCount, input.totals.requestCount),
    );
  }

  async function saveDailyReviewMarkdown(input: DailyReviewMarkdownActionInput, options: DailyReviewFeedbackOptions = {}) {
    const shouldShowFeedback = options.shouldShowFeedback ?? (() => true);
    try {
      const result = await window.maka.dailyReview.saveMarkdownToFile({
        markdown: input.markdown,
        defaultName: dailyReviewExportDefaultName({ range: input.range, day: input.day }),
      });
      if (result.ok) {
        if (shouldShowFeedback()) {
          toastApi.success(
            copy.reviewSaved(input.label),
            copy.reviewSummary(input.totals.sessionCount, input.totals.requestCount),
          );
        }
      } else if (result.reason === 'canceled') {
        // User dismissed the dialog, no toast.
      } else if (result.reason === 'invalid_input') {
        if (shouldShowFeedback()) toastApi.error(copy.saveFailedTitle, copy.invalidExport);
      } else {
        if (shouldShowFeedback()) toastApi.error(copy.saveFailedTitle, copy.writeFailed);
      }
    } catch (err) {
      if (shouldShowFeedback()) {
        toastApi.error(copy.saveFailedTitle, dailyReviewActionErrorMessage(err, copy.reviewSaveFallback, uiLocale));
      }
    }
  }

  return {
    copyDailyReviewMarkdown,
    appendDailyReviewMarkdown,
    saveDailyReviewMarkdown,
  };
}
