import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
  tryReconnectableReadResult,
} from "./ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

export function registerRuntimeHostInspectorIpc(deps: {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
}): void {
  handleReconnectableRead(
    deps.ipcMain,
    "inspector:trace",
    (_event, sessionId: string) =>
      tryReconnectableReadResult(
        () => deps.client.loadSessionTrace(sessionId),
        "INSPECTOR_TRACE_FAILED",
      ),
  );
}
