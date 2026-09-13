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

import { useMemo, useRef } from 'react';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewRange,
  DailyReviewSummary,
} from '@maka/core/daily-review';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  formatDailyReviewMarkdown,
  type DailyReviewMarkdownActionInput,
  useMountedRef,
} from '@maka/ui';
import {
  dailyReviewActionErrorMessage,
  dailyReviewExportDefaultName,
} from '../../../daily-review-actions.js';
import { getShellCopy } from '../../../locales/shell-copy.js';
import { getShellRemainingCopy } from '../../../locales/shell-remaining-copy.js';
import type { ModuleHubRuntimeHostRef, ModuleHubServices } from '../ports.js';
import {
  defaultRuntimeHostDiagnosticTarget,
  defaultRuntimeHostOperationHost,
  isDefaultRuntimeHostCurrent,
  runOnDefaultRuntimeHost,
} from './default-runtime-host.js';

type DailyReviewFeedbackOptions = {
  readonly shouldShowFeedback?: () => boolean;
};

export interface ModuleHubToastApi {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ): void;
}

export interface ActiveComposerClaim {
  /** True only while the same Session, navigation owner and composer still own this claim. */
  isCurrent(): boolean;
  /** Appends to the composer that was captured with the claim. */
  append(text: string): void;
}

/** Structural equivalent of the UI bridge; kept here so @maka/ui stays leaf-only. */
export interface DailyReviewBridge {
  fetchDay(offsetDays: number, daySpan?: number): Promise<DailyReviewSummary>;
  runOnce?(input: {
    range: DailyReviewRange;
    offsetDays?: number;
  }): Promise<{ archiveId: string }>;
  listArchives?(): Promise<DailyReviewArchiveSummary[]>;
  getArchive?(archiveId: string): Promise<DailyReviewArchive>;
}

export interface DailyReviewController {
  readonly bridge: DailyReviewBridge;
  copyMarkdown(
    input: DailyReviewMarkdownActionInput,
    options?: DailyReviewFeedbackOptions,
  ): Promise<void>;
  appendMarkdown(input: DailyReviewMarkdownActionInput): void;
  saveMarkdown(
    input: DailyReviewMarkdownActionInput,
    options?: DailyReviewFeedbackOptions,
  ): Promise<void>;
  copyToday(): Promise<void>;
  pasteToday(): Promise<void>;
  saveToday(): Promise<void>;
}

export interface UseDailyReviewControllerInput {
  readonly services: ModuleHubServices;
  readonly uiLocale: UiLocale;
  readonly toastApi: ModuleHubToastApi;
  readonly appendComposerText: (text: string) => void;
  readonly captureActiveComposerClaim: () => ActiveComposerClaim | undefined;
  readonly isDailyReviewSurfaceActive: () => boolean;
}

class StaleDailyReviewHostError extends Error {
  constructor() {
    super('The default Runtime Host changed while loading Daily Review');
    this.name = 'StaleDailyReviewHostError';
  }
}

async function operationFailureIsCurrent(
  services: ModuleHubServices,
  error: unknown,
): Promise<boolean> {
  if (error instanceof StaleDailyReviewHostError) return false;
  const host = defaultRuntimeHostOperationHost(error);
  return host ? isDefaultRuntimeHostCurrent(services.runtimeHosts, host) : true;
}

/**
 * Runs a Daily Review read against the default Host and refuses to expose a
 * result after that Host changes. One retry absorbs the normal profile-switch
 * race without making the page bridge identity depend on Host state.
 */
async function readCurrentDefaultHost<T>(
  services: ModuleHubServices,
  operation: (host: ModuleHubRuntimeHostRef) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runOnDefaultRuntimeHost(
        services.runtimeHosts,
        operation,
      );
      if (
        await isDefaultRuntimeHostCurrent(services.runtimeHosts, result.host)
      ) {
        return result.value;
      }
    } catch (error) {
      if (await operationFailureIsCurrent(services, error)) throw error;
    }
  }
  throw new StaleDailyReviewHostError();
}

export function createDailyReviewBridge(
  services: ModuleHubServices,
  locale: UiLocale,
): DailyReviewBridge {
  const copy = getShellRemainingCopy(locale).dailyReview;
  return {
    async fetchDay(offsetDays: number, daySpan?: number) {
      return readCurrentDefaultHost(services, async (host) => {
        const result = await services.dailyReview.day(
          offsetDays,
          daySpan,
          host,
        );
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      });
    },
    runOnce(input) {
      return services.dailyReview.runOnce(input);
    },
    listArchives() {
      return services.dailyReview.listArchives();
    },
    async getArchive(archiveId: string) {
      const archive = await services.dailyReview.getArchive(archiveId);
      if (!archive) throw new Error(copy.archiveMissing);
      return archive;
    },
  };
}

export function useDailyReviewController(
  input: UseDailyReviewControllerInput,
): DailyReviewController {
  const mountedRef = useMountedRef();
  const inputRef = useRef(input);
  inputRef.current = input;

  const bridge = useMemo(
    () => createDailyReviewBridge(input.services, input.uiLocale),
    [input.services, input.uiLocale],
  );

  return useMemo(() => {
    const copy = getShellCopy(input.uiLocale).commandActions;
    const showIfMounted = (predicate: () => boolean = () => true) =>
      mountedRef.current && predicate();
    const shouldReportOperationFailure = async (
      error: unknown,
      predicate: () => boolean = () => true,
    ) => {
      if (!showIfMounted(predicate)) return false;
      if (!(await operationFailureIsCurrent(input.services, error)))
        return false;
      return showIfMounted(predicate);
    };

    async function copyMarkdown(
      markdownInput: DailyReviewMarkdownActionInput,
      options: DailyReviewFeedbackOptions = {},
    ) {
      const shouldShowFeedback = options.shouldShowFeedback ?? (() => true);
      const shouldShowPageFeedback = () =>
        inputRef.current.isDailyReviewSurfaceActive() && shouldShowFeedback();
      try {
        await input.services.clipboard.writeText(markdownInput.markdown);
        if (showIfMounted(shouldShowPageFeedback)) {
          inputRef.current.toastApi.success(
            copy.reviewCopied(markdownInput.label),
            copy.reviewSummary(
              markdownInput.totals.sessionCount,
              markdownInput.totals.requestCount,
            ),
          );
        }
      } catch (error) {
        if (showIfMounted(shouldShowPageFeedback)) {
          inputRef.current.toastApi.error(
            copy.copyFailedTitle,
            dailyReviewActionErrorMessage(
              error,
              copy.clipboardDenied,
              input.uiLocale,
            ),
          );
        }
      }
    }

    function appendMarkdown(markdownInput: DailyReviewMarkdownActionInput) {
      inputRef.current.appendComposerText(markdownInput.markdown);
      if (showIfMounted(inputRef.current.isDailyReviewSurfaceActive)) {
        inputRef.current.toastApi.success(
          copy.reviewPasted(markdownInput.label),
          copy.reviewSummary(
            markdownInput.totals.sessionCount,
            markdownInput.totals.requestCount,
          ),
        );
      }
    }

    async function persistMarkdown(
      markdownInput: DailyReviewMarkdownActionInput,
      shouldShowFeedback: () => boolean,
    ) {
      try {
        const result = await input.services.dailyReview.saveMarkdownToFile({
          markdown: markdownInput.markdown,
          defaultName: dailyReviewExportDefaultName({
            range: markdownInput.range,
            day: markdownInput.day,
          }),
        });
        if (!showIfMounted(shouldShowFeedback)) return;
        if (result.ok) {
          inputRef.current.toastApi.success(
            copy.reviewSaved(markdownInput.label),
            copy.reviewSummary(
              markdownInput.totals.sessionCount,
              markdownInput.totals.requestCount,
            ),
          );
        } else if (result.reason === 'invalid_input') {
          inputRef.current.toastApi.error(
            copy.saveFailedTitle,
            copy.invalidExport,
          );
        } else if (result.reason === 'write_failed') {
          inputRef.current.toastApi.error(
            copy.saveFailedTitle,
            copy.writeFailed,
          );
        }
        // A canceled save dialog deliberately has no feedback.
      } catch (error) {
        if (showIfMounted(shouldShowFeedback)) {
          inputRef.current.toastApi.error(
            copy.saveFailedTitle,
            dailyReviewActionErrorMessage(
              error,
              copy.reviewSaveFallback,
              input.uiLocale,
            ),
          );
        }
      }
    }

    async function saveMarkdown(
      markdownInput: DailyReviewMarkdownActionInput,
      options: DailyReviewFeedbackOptions = {},
    ) {
      const shouldShowFeedback = options.shouldShowFeedback ?? (() => true);
      await persistMarkdown(
        markdownInput,
        () =>
          inputRef.current.isDailyReviewSurfaceActive() && shouldShowFeedback(),
      );
    }

    async function readToday() {
      return readCurrentDefaultHost(input.services, async (host) => {
        const result = await input.services.dailyReview.day(0, 1, host);
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      });
    }

    async function copyToday() {
      let summary;
      try {
        summary = await readToday();
      } catch (error) {
        if (await shouldReportOperationFailure(error)) {
          inputRef.current.toastApi.error(
            copy.copyFailedTitle,
            dailyReviewActionErrorMessage(
              error,
              copy.reviewCopyFallback,
              input.uiLocale,
            ),
            undefined,
            defaultRuntimeHostDiagnosticTarget(error),
          );
        }
        return;
      }

      try {
        const markdown = formatDailyReviewMarkdown(
          summary,
          copy.today,
          input.uiLocale,
        );
        await input.services.clipboard.writeText(markdown);
        if (showIfMounted()) {
          inputRef.current.toastApi.success(
            copy.reviewCopiedTitle,
            copy.reviewSummary(
              summary.totals.sessionCount,
              summary.totals.requestCount,
            ),
          );
        }
      } catch (error) {
        if (showIfMounted()) {
          inputRef.current.toastApi.error(
            copy.copyFailedTitle,
            dailyReviewActionErrorMessage(
              error,
              copy.clipboardDenied,
              input.uiLocale,
            ),
          );
        }
      }
    }

    async function pasteToday() {
      // Capture before the first await. The claim owns both the validity check
      // and append target, so a Session/nav/composer switch cannot redirect a
      // late Daily Review result into the new owner.
      const claim = inputRef.current.captureActiveComposerClaim();
      if (!claim) return;
      try {
        const summary = await readToday();
        if (!claim.isCurrent() || !showIfMounted()) return;
        claim.append(
          formatDailyReviewMarkdown(summary, copy.today, input.uiLocale),
        );
        if (!claim.isCurrent() || !showIfMounted()) return;
        inputRef.current.toastApi.success(
          copy.reviewPastedTitle,
          copy.reviewSummary(
            summary.totals.sessionCount,
            summary.totals.requestCount,
          ),
        );
      } catch (error) {
        if (await shouldReportOperationFailure(error, claim.isCurrent)) {
          inputRef.current.toastApi.error(
            copy.pasteFailedTitle,
            dailyReviewActionErrorMessage(
              error,
              copy.reviewUnavailable,
              input.uiLocale,
            ),
            undefined,
            defaultRuntimeHostDiagnosticTarget(error),
          );
        }
      }
    }

    async function saveToday() {
      let summary;
      try {
        summary = await readToday();
      } catch (error) {
        if (await shouldReportOperationFailure(error)) {
          inputRef.current.toastApi.error(
            copy.saveFailedTitle,
            dailyReviewActionErrorMessage(
              error,
              copy.reviewUnavailable,
              input.uiLocale,
            ),
            undefined,
            defaultRuntimeHostDiagnosticTarget(error),
          );
        }
        return;
      }
      const markdown = formatDailyReviewMarkdown(
        summary,
        copy.today,
        input.uiLocale,
      );
      await persistMarkdown(
        {
          day: summary.day,
          range: 1,
          totals: summary.totals,
          markdown,
          label: copy.today,
        },
        () => true,
      );
    }

    return {
      bridge,
      copyMarkdown,
      appendMarkdown,
      saveMarkdown,
      copyToday,
      pasteToday,
      saveToday,
    };
  }, [bridge, input.services, input.uiLocale, mountedRef]);
}
