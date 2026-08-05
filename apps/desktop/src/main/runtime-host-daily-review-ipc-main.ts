import type { IpcMain } from "electron";
import {
  DAILY_REVIEW_RANGES,
  normalizeDailyReviewConfig,
  type DailyReviewConfig,
  type DailyReviewRange,
} from "@maka/core/daily-review";
import { tryResult } from "@maka/core/result";
import { saveMarkdownViaDialog } from "./markdown-save-main.js";
import type { createMainWindowController } from "./main-window.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

type MainWindowController = ReturnType<typeof createMainWindowController>;

export function registerRuntimeHostDailyReviewIpc(deps: {
  ipcMain: Pick<IpcMain, "handle">;
  client: Pick<
    DesktopRuntimeHostClient,
    "queryDailyReview" | "mutateDailyReview"
  >;
  mainWindowController: MainWindowController;
}): void {
  deps.ipcMain.handle(
    "daily-review:day",
    (
      _event,
      payload: { offsetDays?: number; daySpan?: number } | undefined,
    ) =>
      tryResult(async () => {
        const result = await deps.client.queryDailyReview({
          kind: "summary",
          offsetDays: integer(payload?.offsetDays, 0),
          daySpan: boundedDaySpan(payload?.daySpan),
        });
        if (result.kind !== "summary") {
          throw new Error("Runtime Host returned an invalid Daily Review summary");
        }
        return result.summary;
      }, "DAILY_REVIEW_DAY_FAILED"),
  );
  deps.ipcMain.handle("daily-review:getConfig", async () => {
    const result = await deps.client.queryDailyReview({ kind: "config" });
    if (result.kind !== "config") {
      throw new Error("Runtime Host returned an invalid Daily Review config");
    }
    return result.config;
  });
  deps.ipcMain.handle(
    "daily-review:setConfig",
    (_event, patch: Partial<DailyReviewConfig>) =>
      updateConfig(deps.client, patch),
  );
  deps.ipcMain.handle(
    "daily-review:runOnce",
    async (
      _event,
      input:
        | { range?: DailyReviewRange; offsetDays?: number; modelKey?: string }
        | undefined,
    ) => {
      const result = await deps.client.mutateDailyReview({
        kind: "run",
        range: DAILY_REVIEW_RANGES.includes(input?.range as DailyReviewRange)
          ? input!.range!
          : 1,
        offsetDays: integer(input?.offsetDays, 0),
        modelKeyOverride:
          typeof input?.modelKey === "string" ? input.modelKey : "",
        replaceExisting: false,
      });
      if (result.kind !== "archive") {
        throw new Error("Runtime Host returned an invalid Daily Review run");
      }
      return { archiveId: result.archive.id };
    },
  );
  deps.ipcMain.handle("daily-review:list", () => listArchives(deps.client));
  deps.ipcMain.handle("daily-review:get", async (_event, archiveId: string) => {
    const result = await deps.client.queryDailyReview({
      kind: "archive",
      archiveId,
    });
    if (result.kind !== "archive") {
      throw new Error("Runtime Host returned an invalid Daily Review archive");
    }
    return result.archive;
  });
  deps.ipcMain.handle(
    "daily-review:saveMarkdownToFile",
    (_event, input) =>
      saveMarkdownViaDialog(
        deps.mainWindowController,
        input,
        "Save daily review",
      ),
  );
  deps.ipcMain.handle("chat:saveConversationToFile", (_event, input) =>
    saveMarkdownViaDialog(
      deps.mainWindowController,
      input,
      "Save conversation",
    ),
  );
}

async function updateConfig(
  client: Pick<DesktopRuntimeHostClient, "queryDailyReview" | "mutateDailyReview">,
  patch: Partial<DailyReviewConfig>,
): Promise<DailyReviewConfig> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await client.queryDailyReview({ kind: "config" });
    if (current.kind !== "config") {
      throw new Error("Runtime Host returned an invalid Daily Review config");
    }
    const config = normalizeDailyReviewConfig({ ...current.config, ...patch });
    const result = await client.mutateDailyReview({
      kind: "update_config",
      expectedRevision: current.revision,
      config,
    });
    if (
      result.kind === "config_committed" ||
      result.kind === "config_unchanged"
    ) {
      return result.config;
    }
  }
  throw new Error("Daily Review config kept changing while Desktop updated it");
}

async function listArchives(
  client: Pick<DesktopRuntimeHostClient, "queryDailyReview">,
) {
  const archives = [];
  let beforeArchiveId: string | null = null;
  do {
    const result = await client.queryDailyReview({
      kind: "archives",
      beforeArchiveId,
      limit: 32,
    });
    if (result.kind !== "archives") {
      throw new Error("Runtime Host returned an invalid Daily Review page");
    }
    archives.push(...result.archives);
    beforeArchiveId = result.nextBeforeArchiveId;
  } while (beforeArchiveId !== null);
  return archives;
}

function integer(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value as number) : fallback;
}

function boundedDaySpan(value: unknown): number {
  return Math.max(1, Math.min(30, integer(value, 1)));
}
