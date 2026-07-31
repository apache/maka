import { dialog, ipcMain, shell } from 'electron';
import type { MainWindowController } from './main-window.js';
import type { SkinRuntime, SkinRuntimeSnapshot } from './skin-runtime.js';

export function registerSkinIpc(options: {
  runtime: SkinRuntime;
  mainWindowController: MainWindowController;
  sendToRenderer(channel: string, ...args: unknown[]): void;
}): void {
  const { runtime, mainWindowController, sendToRenderer } = options;
  const publish = (snapshot: SkinRuntimeSnapshot): SkinRuntimeSnapshot => {
    sendToRenderer('skins:changed', snapshot);
    return snapshot;
  };

  ipcMain.handle('skins:list', () => runtime.list());
  ipcMain.handle('skins:install', async (): Promise<{
    canceled: boolean;
    snapshot: SkinRuntimeSnapshot;
  }> => {
    const selection = await mainWindowController.showOpenDialog({
      title: 'Install Maka skin',
      properties: ['openFile'],
      filters: [
        { name: 'Maka Skin', extensions: ['maka-skin'] },
        { name: 'Zip archive', extensions: ['zip'] },
      ],
    });
    const archivePath = selection.filePaths[0];
    if (selection.canceled || !archivePath) {
      return { canceled: true, snapshot: await runtime.list() };
    }

    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Install a full-access skin?',
      message: 'Maka skins can restyle and modify the entire app interface.',
      detail: 'Only install skins you trust. Skin JavaScript runs without Node.js or the Maka preload bridge, but it can read and change visible page content. Use --disable-skins if a skin prevents the app from opening normally.',
      buttons: ['Cancel', 'Install'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) {
      return { canceled: true, snapshot: await runtime.list() };
    }

    const snapshot = publish(await runtime.installFromFile(archivePath));
    return { canceled: false, snapshot };
  });
  ipcMain.handle('skins:activate', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid skin id.');
    return publish(await runtime.activate(id));
  });
  ipcMain.handle('skins:disable', async () => publish(await runtime.disable()));
  ipcMain.handle('skins:openFolder', async () => {
    const error = await shell.openPath(runtime.rootDir);
    if (error) throw new Error(error);
  });
}
