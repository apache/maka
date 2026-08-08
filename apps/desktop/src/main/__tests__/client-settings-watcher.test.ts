import assert from "node:assert/strict";
import { test } from "node:test";
import { startClientSettingsWatcher } from "../client-settings-watcher.js";

test("refreshes only for client settings replacements and stops cleanly", async () => {
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let closed = false;
  let refreshes = 0;
  const watcher = startClientSettingsWatcher(
    "/workspace",
    () => {
      refreshes += 1;
    },
    {
      debounceMs: 0,
      watch: (_root, nextListener) => {
        listener = nextListener;
        return {
          on: () => undefined,
          close: () => {
            closed = true;
          },
        };
      },
    },
  );

  assert.ok(listener);
  listener("rename", "runtime.sqlite");
  listener("rename", "settings.json");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshes, 1);

  watcher.stop();
  assert.equal(closed, true);
  listener("rename", "settings.json");
  watcher.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshes, 1);
});
