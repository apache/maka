import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { registerRuntimeHostDailyReviewIpc } from "../runtime-host-daily-review-ipc-main.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

describe("Runtime Host Daily Review IPC", () => {
  test("preserves custom day spans and retries config conflicts", async () => {
    const handlers = new Map<string, Handler>();
    const summaries: unknown[] = [];
    let revision = 1;
    const client = {
      async queryDailyReview(input: Record<string, unknown>) {
        if (input.kind === "summary") {
          summaries.push(input);
          return { kind: "summary", summary: { day: {}, totals: {} } };
        }
        if (input.kind === "config") {
          return {
            kind: "config",
            revision,
            config: { enabled: false, executeTime: "08:00", modelKey: "" },
          };
        }
        return {
          kind: "archives",
          archives: [],
          beforeArchiveId: null,
          nextBeforeArchiveId: null,
        };
      },
      async mutateDailyReview(input: Record<string, unknown>) {
        if (revision === 1) {
          revision = 2;
          return {
            kind: "revision_conflict",
            expectedRevision: 1,
            actualRevision: 2,
          };
        }
        return {
          kind: "config_committed",
          revision: 3,
          config: { enabled: true, executeTime: "08:00", modelKey: "" },
        };
      },
    };
    registerRuntimeHostDailyReviewIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler as Handler);
        },
      },
      client: client as never,
      mainWindowController: {} as never,
    });

    const day = await handlers.get("daily-review:day")?.({}, {
      offsetDays: -2,
      daySpan: 14,
    });
    assert.deepEqual(day, { ok: true, data: { day: {}, totals: {} } });
    assert.deepEqual(summaries, [
      { kind: "summary", offsetDays: -2, daySpan: 14 },
    ]);

    const config = await handlers.get("daily-review:setConfig")?.({}, {
      enabled: true,
    });
    assert.deepEqual(config, {
      enabled: true,
      executeTime: "08:00",
      modelKey: "",
    });
  });
});
