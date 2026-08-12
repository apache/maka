import type { IpcMain } from 'electron';
import { saveMarkdownViaDialog } from './markdown-save-main.js';
import type { createMainWindowController } from './main-window.js';

export function registerMarkdownSaveIpc(input: {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly mainWindowController: ReturnType<typeof createMainWindowController>;
}): void {
  input.ipcMain.handle('daily-review:saveMarkdownToFile', (_event, value) =>
    saveMarkdownViaDialog(input.mainWindowController, value, 'Save daily review'),
  );
  input.ipcMain.handle('chat:saveConversationToFile', (_event, value) =>
    saveMarkdownViaDialog(input.mainWindowController, value, 'Save conversation'),
  );
}
