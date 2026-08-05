import { ipcMain } from 'electron';
import type {
  DailyReviewConfig,
  DailyReviewRange,
  DailyReviewSummary,
} from '@maka/core';
import { DAILY_REVIEW_RANGES } from '@maka/core';
import { tryResult } from '@maka/core/result';
import type { createMainWindowController } from './main-window.js';
import type { createDailyReviewArchiveStore } from './daily-review-archive-store.js';
import type { createDailyReviewMainService } from './daily-review-main.js';
import { saveMarkdownViaDialog } from './markdown-save-main.js';

type MainWindowController = ReturnType<typeof createMainWindowController>;
type DailyReviewArchiveStore = ReturnType<typeof createDailyReviewArchiveStore>;
type DailyReviewMainService = ReturnType<typeof createDailyReviewMainService>;

interface DailyReviewIpcDeps {
  dailyReview: DailyReviewMainService;
  dailyReviewArchiveStore: DailyReviewArchiveStore;
  mainWindowController: MainWindowController;
}

export function registerDailyReviewIpc(deps: DailyReviewIpcDeps): void {
  ipcMain.handle(
    'daily-review:day',
    (
      _event,
      payload: { offsetDays?: number; daySpan?: number } | undefined,
    ) =>
      tryResult(async (): Promise<DailyReviewSummary> => {
        const offset = Number.isFinite(payload?.offsetDays) ? Math.trunc(payload!.offsetDays!) : 0;
        const rawSpan = Number.isFinite(payload?.daySpan) ? Math.trunc(payload!.daySpan!) : 1;
        return deps.dailyReview.buildSummaryForRange(offset, rawSpan);
      }, 'DAILY_REVIEW_DAY_FAILED'),
  );
  ipcMain.handle('daily-review:getConfig', () => deps.dailyReviewArchiveStore.getConfig());
  ipcMain.handle('daily-review:setConfig', (_event, patch: Partial<DailyReviewConfig>) =>
    deps.dailyReviewArchiveStore.setConfig(patch),
  );
  ipcMain.handle(
    'daily-review:runOnce',
    (_event, input: { range?: DailyReviewRange; offsetDays?: number; modelKey?: string } | undefined) =>
      deps.dailyReview.run({
        range: DAILY_REVIEW_RANGES.includes(input?.range as DailyReviewRange) ? input!.range! : 1,
        offsetDays: Number.isFinite(input?.offsetDays) ? Math.trunc(input!.offsetDays!) : undefined,
        modelKeyOverride: typeof input?.modelKey === 'string' ? input.modelKey : undefined,
        trigger: 'manual',
      }),
  );
  ipcMain.handle('daily-review:list', () => deps.dailyReviewArchiveStore.listArchives());
  ipcMain.handle('daily-review:get', (_event, archiveId: string) =>
    deps.dailyReviewArchiveStore.getArchive(archiveId),
  );
  ipcMain.handle(
    'daily-review:saveMarkdownToFile',
    (_event, input: { markdown?: unknown; defaultName?: unknown } | undefined) =>
      saveMarkdownViaDialog(deps.mainWindowController, input, '保存今日回顾'),
  );
  ipcMain.handle(
    'chat:saveConversationToFile',
    (_event, input: { markdown?: unknown; defaultName?: unknown } | undefined) =>
      saveMarkdownViaDialog(deps.mainWindowController, input, '保存当前对话'),
  );
}
