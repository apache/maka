import type { IpcMain } from "electron";

export type IpcHandler = Parameters<IpcMain["handle"]>[1];

export interface ReconnectableReadIpcMain extends Pick<IpcMain, "handle"> {
  handleReconnectableRead?(channel: string, listener: IpcHandler): void;
}

export function handleReconnectableRead(
  ipcMain: ReconnectableReadIpcMain,
  channel: string,
  listener: IpcHandler,
): void {
  if (ipcMain.handleReconnectableRead) {
    ipcMain.handleReconnectableRead(channel, listener);
  } else {
    ipcMain.handle(channel, listener);
  }
}
