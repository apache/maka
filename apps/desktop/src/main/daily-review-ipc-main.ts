import { ipcMain } from 'electron';
import type {
  DailyReviewConfig,
  DailyReviewMode,
  DailyReviewSummary,
} from '@maka/core';
import { tryResult } from '@maka/core/result';
import type { createMainWindowController } from './main-window.js';
import type { createDailyReviewArchiveStore } from './daily-review-archive-store.js';
import type { createDailyReviewMainService } from './daily-review-main.js';

type MainWindowController = ReturnType<typeof createMainWindowController>;
type DailyReviewArchiveStore = ReturnType<typeof createDailyReviewArchiveStore>;
type DailyReviewMainService = ReturnType<typeof createDailyReviewMainService>;

interface DailyReviewIpcDeps {
  dailyReview: DailyReviewMainService;
  dailyReviewArchiveStore: DailyReviewArchiveStore;
  mainWindowController: MainWindowController;
}

async function saveMarkdownViaDialog(
  mainWindowController: MainWindowController,
  input: { markdown?: unknown; defaultName?: unknown } | undefined,
  dialogTitle: string,
): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
> {
  const markdown = typeof input?.markdown === 'string' ? input.markdown : null;
  const defaultName = typeof input?.defaultName === 'string' ? input.defaultName : null;
  if (!markdown || markdown.length === 0 || markdown.length > 1_000_000) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!defaultName || defaultName.length === 0 || defaultName.length > 200) {
    return { ok: false, reason: 'invalid_input' };
  }
  const safeName = defaultName.replace(/[\\/]/g, '_');
  const result = await mainWindowController.showSaveDialog({
    title: dialogTitle,
    defaultPath: safeName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' };
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(result.filePath, markdown, 'utf8');
    return { ok: true, path: result.filePath };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
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
    (_event, input: { mode?: DailyReviewMode; day?: number; modelKey?: string } | undefined) =>
      deps.dailyReview.run({
        mode: input?.mode === 'deep' ? 'deep' : 'daily',
        day: Number.isFinite(input?.day) ? Math.trunc(input!.day!) : undefined,
        modelKeyOverride: typeof input?.modelKey === 'string' ? input.modelKey : undefined,
        trigger: 'manual',
      }),
  );
  ipcMain.handle('daily-review:list', () => deps.dailyReviewArchiveStore.listArchives());
  ipcMain.handle('daily-review:get', (_event, archiveId: string) =>
    deps.dailyReviewArchiveStore.getArchive(archiveId),
  );
  ipcMain.handle('daily-review:delete', async (_event, archiveId: string) => {
    await deps.dailyReviewArchiveStore.deleteArchive(archiveId);
  });
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
