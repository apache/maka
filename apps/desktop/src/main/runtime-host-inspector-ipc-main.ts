import type { ipcMain as electronIpcMain } from "electron";
import { tryResult } from "@maka/core/result";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

export function registerRuntimeHostInspectorIpc(deps: {
  readonly ipcMain: Pick<typeof electronIpcMain, "handle">;
  readonly client: DesktopRuntimeHostClient;
}): void {
  deps.ipcMain.handle("inspector:trace", (_event, sessionId: string) =>
    tryResult(
      () => deps.client.loadSessionTrace(sessionId),
      "INSPECTOR_TRACE_FAILED",
    ),
  );
}
