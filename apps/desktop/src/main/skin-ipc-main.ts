import { dialog, ipcMain, shell } from 'electron';
import type { MainWindowController } from './main-window.js';
import type {
  SkinActionName,
  SkinPermission,
  SkinRuntime,
  SkinRuntimeSnapshot,
} from './skin-runtime.js';

const SKIN_PERMISSION_DESCRIPTIONS: Record<SkinPermission, string> = {
  dom: 'Read and modify visible Maka page content',
  canvas: 'Render Canvas or WebGL graphics',
  audio: 'Play or process audio',
  storage: 'Persist skin-owned settings',
  'actions.navigation': 'Switch the visible conversation after a skin UI click',
  'actions.task': 'Open a new-task surface after a skin UI click',
  'actions.submit': 'Submit a new prompt after a skin UI click',
  'actions.stop': 'Stop the active generation after a skin UI click',
};

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

    const inspection = await runtime.inspectFile(archivePath);
    const { manifest } = inspection;
    const permissions = manifest.permissions
      .map((permission) => `• ${SKIN_PERMISSION_DESCRIPTIONS[permission]}`)
      .join('\n');
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: manifest.permissions.includes('dom')
        ? 'Install a full-access skin?'
        : 'Install this skin?',
      message: `Install “${manifest.name}” by ${manifest.author ?? 'an unknown author'}?`,
      detail: [
        manifest.entry
          ? 'Skin JavaScript runs without Node.js or the Maka preload bridge, but DOM access can still read and change all visible page content.'
          : 'This package contains CSS only and does not run skin JavaScript.',
        '',
        permissions || 'This package declares no optional permissions.',
        '',
        manifest.permissions.includes('dom')
          ? 'FULL UI TRUST: DOM-enabled skin code can imitate page interaction. Granular action permissions govern the stable Skin API, but they cannot turn arbitrary DOM JavaScript into a strict sandbox.'
          : 'Controlled actions are checked by the host and only run after a trusted click in skin-owned UI.',
        '',
        manifest.permissions.includes('actions.submit')
          ? 'Every composer.submit request also requires a native Maka confirmation. Only install packages you trust.'
          : 'Only install packages you trust.',
      ].join('\n'),
      buttons: ['Cancel', 'Install'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) {
      return { canceled: true, snapshot: await runtime.list() };
    }

    const snapshot = publish(
      await runtime.installFromFile(archivePath, inspection.archiveDigest),
    );
    return { canceled: false, snapshot };
  });
  ipcMain.handle('skins:activate', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid skin id.');
    return publish(await runtime.activate(id));
  });
  ipcMain.handle('skins:disable', async () => publish(await runtime.disable()));
  ipcMain.handle('skins:reload', async () => publish(await runtime.reload()));
  ipcMain.handle('skins:uninstall', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid skin id.');
    const installed = (await runtime.list()).installed.find(({ manifest }) => manifest.id === id);
    if (!installed) throw new Error('Skin is not installed.');
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Remove Maka skin?',
      message: `Remove “${installed.manifest.name}” from this device?`,
      detail: 'The installed skin files will be deleted. You can import the .maka-skin package again later.',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return runtime.list();
    return publish(await runtime.uninstall(id));
  });
  ipcMain.handle('skins:openFolder', async () => {
    const error = await shell.openPath(runtime.rootDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle('skins:authorizeAction', async (
    _event,
    action: unknown,
    context: unknown,
  ) => {
    if (
      action !== 'navigation.switch-session' &&
      action !== 'task.new' &&
      action !== 'composer.submit' &&
      action !== 'generation.stop'
    ) {
      return false;
    }
    if (!(await runtime.authorizeAction(action satisfies SkinActionName))) return false;
    if (action !== 'composer.submit') return true;
    const textPreview = (
      context &&
      typeof context === 'object' &&
      'textPreview' in context &&
      typeof context.textPreview === 'string'
    )
      ? context.textPreview.slice(0, 240)
      : '';
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Allow skin to submit a prompt?',
      message: 'A skin is asking Maka to start model generation.',
      detail: textPreview
        ? `Prompt preview:\n\n${textPreview}`
        : 'The prompt preview is unavailable.',
      buttons: ['Cancel', 'Submit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return confirmation.response === 1;
  });
}
