import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import { handleReconnectableRead } from './ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { createMainWindowController } from './main-window.js';

const DESKTOP_UI_SCOPE = 'desktop-ui';
type MainWindowController = ReturnType<typeof createMainWindowController>;

export function registerRuntimeHostUiExtensionsIpc(input: {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly mainWindowController: MainWindowController;
  readonly allowLocalPaths: boolean;
  readonly automatedImportSourcePath?: string;
}): void {
  handleReconnectableRead(input.ipcMain, 'ui-extensions:list', async () => listUiExtensions(input.client));

  input.ipcMain.handle('ui-extensions:importLocal', async () => {
    if (!input.allowLocalPaths) throw new Error('Local UI Extension import is unavailable for a remote Runtime Host');
    const selected = input.automatedImportSourcePath
      ? { canceled: false, filePaths: [input.automatedImportSourcePath] }
      : await input.mainWindowController.showOpenDialog({
          title: 'Import UI Extension',
          properties: ['openDirectory'],
        });
    const sourcePath = selected.filePaths[0];
    if (selected.canceled || !sourcePath) return { ok: false as const, reason: 'cancelled' as const };
    const manifest = await previewManifest(sourcePath);
    const confirmation = input.automatedImportSourcePath
      ? { response: 0 }
      : await input.mainWindowController.showMessageBox({
          type: 'question',
          title: `Import ${manifest.id}`,
          message: `Install UI Extension “${manifest.id}” ${manifest.version}?`,
          detail: [
            `${manifest.ui.length} UI contribution${manifest.ui.length === 1 ? '' : 's'}`,
            `Host state: ${manifest.permissions.hostState ? 'allowed' : 'not allowed'}`,
            `Session control: ${manifest.permissions.sessionAccess ? 'allowed' : 'not allowed'}`,
            `Host methods: ${manifest.hostMethods.length === 0 ? 'none' : manifest.hostMethods.join(', ')}`,
            `Network: ${manifest.permissions.network ? 'allowed' : 'blocked'}`,
          ].join('\n'),
          buttons: ['Import and enable', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
    if (confirmation.response !== 0) return { ok: false as const, reason: 'cancelled' as const };
    const installed = await input.client.request('extension.package.install', { sourcePath });
    if (installed.uiContributionIds.length === 0) throw new Error('Selected directory is not a UI Extension package');
    const catalog = await input.client.request('extension.catalog.query', {});
    const current = catalog.bindings.find((binding) => binding.scopeId === DESKTOP_UI_SCOPE && binding.extensionId === installed.extensionId);
    if (current) {
      await input.client.request('extension.catalog.mutate', { kind: 'update', bindingId: current.bindingId, revision: installed.revision });
    } else {
      await input.client.request('extension.catalog.mutate', {
        kind: 'enable',
        bindingId: userBindingId(installed.extensionId),
        scopeId: DESKTOP_UI_SCOPE,
        extensionId: installed.extensionId,
        revision: installed.revision,
      });
    }
    return { ok: true as const, extensionId: installed.extensionId, revision: installed.revision };
  });

  input.ipcMain.handle('ui-extensions:setEnabled', async (_event, extensionId: string, enabled: boolean) => {
    const catalog = await input.client.request('extension.catalog.query', {});
    const binding = catalog.bindings.find((item) => item.scopeId === DESKTOP_UI_SCOPE && item.extensionId === extensionId);
    if (!binding) throw new Error('UI Extension binding is not installed');
    await input.client.request('extension.catalog.mutate', enabled
      ? { kind: 'enable', bindingId: binding.bindingId, scopeId: binding.scopeId, extensionId: binding.extensionId, revision: binding.desiredRevision }
      : { kind: 'disable', bindingId: binding.bindingId });
    return { ok: true as const };
  });

  input.ipcMain.handle('ui-extensions:remove', async (_event, extensionId: string) => {
    const catalog = await input.client.request('extension.catalog.query', {});
    const binding = catalog.bindings.find((item) => item.scopeId === DESKTOP_UI_SCOPE && item.extensionId === extensionId);
    if (binding) await input.client.request('extension.catalog.mutate', { kind: 'remove', bindingId: binding.bindingId });
    for (const revision of catalog.revisions.filter((item) => item.extensionId === extensionId && item.uiContributionIds.length > 0)) {
      await input.client.request('extension.package.uninstall', { extensionId, revision: revision.revision });
    }
    return { ok: true as const };
  });
}

async function listUiExtensions(client: DesktopRuntimeHostClient) {
  const catalog = await client.request('extension.catalog.query', {});
  return catalog.revisions
    .filter((revision) => revision.uiContributionIds.length > 0)
    .map((revision) => {
      const binding = catalog.bindings.find((item) => item.scopeId === DESKTOP_UI_SCOPE && item.extensionId === revision.extensionId);
      return {
        extensionId: revision.extensionId,
        revision: revision.revision,
        contributionIds: revision.uiContributionIds,
        active: binding?.status === 'active' && binding.lastGoodRevision === revision.revision,
        enabled: binding?.enabled ?? false,
        status: binding?.status ?? 'disabled',
        error: binding?.error ?? null,
      };
    });
}

async function previewManifest(sourcePath: string): Promise<{ id: string; version: string; ui: unknown[]; hostMethods: string[]; permissions: { network: boolean; hostState: boolean; sessionAccess: boolean } }> {
  const encoded = await readFile(join(sourcePath, 'maka.ui.json'), 'utf8');
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new Error('UI Extension manifest is too large');
  const value = JSON.parse(encoded) as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.version !== 'string' || !Array.isArray(value.ui)) throw new Error('UI Extension manifest is invalid');
  const permissions = value.permissions as Record<string, unknown> | undefined;
  const host = value.host as Record<string, unknown> | undefined;
  const methods = Array.isArray(host?.methods) ? host.methods : [];
  const hostMethods = methods.map((item) => (item as Record<string, unknown>)?.name);
  if (hostMethods.some((name) => typeof name !== 'string')) throw new Error('UI Extension Host methods are invalid');
  return {
    id: value.id,
    version: value.version,
    ui: value.ui,
    hostMethods: hostMethods as string[],
    permissions: {
      network: permissions?.network === true,
      hostState: permissions?.hostState === true,
      sessionAccess: permissions?.sessionAccess === true,
    },
  };
}

function userBindingId(extensionId: string): string {
  return `user_ui_${createHash('sha256').update(extensionId).digest('hex').slice(0, 32)}`;
}
