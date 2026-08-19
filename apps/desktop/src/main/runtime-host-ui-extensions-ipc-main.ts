import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import { handleReconnectableRead } from './ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { createMainWindowController } from './main-window.js';

const DESKTOP_UI_SCOPE = 'desktop-ui';
const PROFILE_EXTENSION_SCOPE = 'profile';
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
          title: 'Import Extension',
          properties: ['openDirectory', 'openFile'],
          filters: [{ name: 'Maka Extension', extensions: ['maka-extension'] }],
        });
    const sourcePath = selected.filePaths[0];
    if (selected.canceled || !sourcePath) return { ok: false as const, reason: 'cancelled' as const };
    const manifest = await previewPackage(sourcePath);
    const confirmation = input.automatedImportSourcePath
      ? { response: 0 }
      : await input.mainWindowController.showMessageBox({
          type: 'warning',
          title: `Import ${manifest.id}`,
          message: `Install Extension “${manifest.id}”?`,
          detail: [
            `${manifest.uiCount} UI contribution${manifest.uiCount === 1 ? '' : 's'}`,
            `${manifest.toolCount} Tool contribution${manifest.toolCount === 1 ? '' : 's'}`,
            `${manifest.eventCount} Event/Listener contribution${manifest.eventCount === 1 ? '' : 's'}`,
            `${manifest.serviceCount} Service contribution${manifest.serviceCount === 1 ? '' : 's'}`,
            `${manifest.timerCount} Timer contribution${manifest.timerCount === 1 ? '' : 's'}`,
            `Host state: ${manifest.permissions.hostState ? 'allowed' : 'not allowed'}`,
            `Session control: ${manifest.permissions.sessionAccess ? 'allowed' : 'not allowed'}`,
            `Host methods: ${manifest.hostMethods.length === 0 ? 'none' : manifest.hostMethods.join(', ')}`,
            `Network: ${manifest.permissions.network ? 'allowed' : 'blocked'}`,
            `Workspace: ${manifest.permissions.workspace}`,
            '',
            'Trusted code warning: enabling this Extension executes its code inside the Runtime Host process. It has the same authority as a local application or Bash command and may read credentials, access files and the network, change MAKA behavior, block, or terminate the Runtime. Manifest permissions are approval and audit metadata, not a security boundary against malicious code.',
          ].join('\n'),
          buttons: ['Install and enable', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
    if (confirmation.response !== 0) return { ok: false as const, reason: 'cancelled' as const };
    const installed = await input.client.request('extension.package.install', { sourcePath });
    const catalog = await input.client.request('extension.composition.query', {});
    for (const scopeId of new Set([
      ...(installed.uiContributionIds.length > 0 ? [DESKTOP_UI_SCOPE] : []),
      ...(installed.toolNames.length > 0 || installed.eventContributionIds.length > 0 || (installed.serviceContributionIds?.length ?? 0) > 0 || (installed.timerContributionIds?.length ?? 0) > 0
        ? [PROFILE_EXTENSION_SCOPE]
        : []),
    ])) {
      const current = catalog.entries.find(
        (entry) => entry.scopeId === scopeId && entry.extensionId === installed.extensionId,
      );
      await input.client.request(
        'extension.composition.mutate',
        current
          ? { kind: 'reload', entryId: current.entryId }
          : {
              kind: 'enable',
              entryId: userEntryId(installed.extensionId, scopeId),
              scopeId,
              extensionId: installed.extensionId,
            },
      );
    }
    return { ok: true as const, extensionId: installed.extensionId };
  });

  input.ipcMain.handle('ui-extensions:setEnabled', async (_event, extensionId: string, enabled: boolean) => {
    const catalog = await input.client.request('extension.composition.query', {});
    const entries = catalog.entries.filter((item) => item.extensionId === extensionId);
    if (entries.length === 0) throw new Error('Extension entry is not installed');
    for (const entry of entries) {
      await input.client.request('extension.composition.mutate', enabled
        ? { kind: 'enable', entryId: entry.entryId, scopeId: entry.scopeId, extensionId: entry.extensionId }
        : { kind: 'disable', entryId: entry.entryId });
    }
    return { ok: true as const };
  });

  input.ipcMain.handle('ui-extensions:remove', async (_event, extensionId: string) => {
    const catalog = await input.client.request('extension.composition.query', {});
    for (const entry of catalog.entries.filter((item) => item.extensionId === extensionId)) {
      await input.client.request('extension.composition.mutate', { kind: 'remove', entryId: entry.entryId });
    }
    if (catalog.extensions.some((item) => item.extensionId === extensionId))
      await input.client.request('extension.package.uninstall', { extensionId });
    return { ok: true as const };
  });

  input.ipcMain.handle('ui-extensions:configure', async (_event, entryId: string, configuration: Record<string, string | number | boolean>) => {
    const result = await input.client.request('extension.configuration.mutate', { entryId, configuration });
    return { ok: true as const, configuration: result.configuration };
  });

  handleReconnectableRead(input.ipcMain, 'ui-extensions:getConfiguration', async (_event, entryId: string) =>
    input.client.request('extension.configuration.query', { entryId }),
  );

  input.ipcMain.handle('ui-extensions:export', async (_event, extensionId: string) => {
    if (!input.allowLocalPaths) throw new Error('Extension export is unavailable for a remote Runtime Host');
    const selected = await input.mainWindowController.showSaveDialog({
      title: `Export ${extensionId}`,
      defaultPath: `${extensionId}.maka-extension`,
      filters: [{ name: 'Maka Extension', extensions: ['maka-extension'] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: false as const, reason: 'cancelled' as const };
    await input.client.request('extension.package.export', { extensionId, targetPath: selected.filePath });
    return { ok: true as const, path: selected.filePath };
  });
}

async function listUiExtensions(client: DesktopRuntimeHostClient) {
  const catalog = await client.request('extension.composition.query', {});
  const contracts = await client.request('extension.contract.query', {}).catch(() => ({ packages: [] }));
  return catalog.extensions
    .map((extension) => {
      const entries = catalog.entries.filter((item) => item.extensionId === extension.extensionId);
      const contract = contracts.packages.find((item) => item.extensionId === extension.extensionId);
      return {
        extensionId: extension.extensionId,
        displayName: contract?.displayName ?? extension.extensionId,
        description: contract?.description ?? '',
        contributionIds: [
          ...extension.toolNames,
          ...extension.uiContributionIds,
          ...extension.eventContributionIds,
          ...(extension.serviceContributionIds ?? []),
          ...(extension.timerContributionIds ?? []),
        ],
        toolNames: extension.toolNames,
        uiContributionIds: extension.uiContributionIds,
        eventContributionIds: extension.eventContributionIds,
        serviceContributionIds: extension.serviceContributionIds ?? [],
        timerContributionIds: extension.timerContributionIds ?? [],
        dependencies: contract?.dependencies ?? [],
        configuration: contract?.configuration ?? { properties: {}, required: [] },
        entries,
        active: entries.some((item) => item.status === 'active'),
        enabled: entries.some((item) => item.enabled),
        status: entries.some((item) => item.status === 'failed') ? 'failed' : entries.some((item) => item.status === 'active') ? 'active' : entries.some((item) => item.status === 'waiting') ? 'waiting' : 'disabled',
        error: entries.find((item) => item.error)?.error ?? null,
      };
    });
}

async function previewPackage(sourcePath: string): Promise<{ id: string; uiCount: number; toolCount: number; eventCount: number; serviceCount: number; timerCount: number; hostMethods: string[]; permissions: { network: boolean; hostState: boolean; sessionAccess: boolean; workspace: string } }> {
  if (!(await stat(sourcePath)).isDirectory()) return previewBundle(sourcePath);
  const encoded = await readFile(join(sourcePath, 'maka.extension.json'), 'utf8');
  return previewManifest(JSON.parse(encoded) as Record<string, unknown>);
}

async function previewBundle(sourcePath: string): ReturnType<typeof previewPackage> {
  const encoded = await readFile(sourcePath);
  if (encoded.byteLength > 32 * 1024 * 1024) throw new Error('Extension Bundle is too large');
  const bundle = JSON.parse(encoded.toString('utf8')) as { files?: unknown };
  if (!Array.isArray(bundle.files)) throw new Error('Extension Bundle is invalid');
  let manifest: string | undefined;
  for (const value of bundle.files) {
    const file = value as { path?: unknown; content?: unknown };
    if (typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('Extension Bundle file is invalid');
    }
    if (file.path === 'maka.extension.json') {
      manifest = Buffer.from(file.content, 'base64').toString('utf8');
    }
  }
  if (!manifest) {
    throw new Error(`Extension Bundle is missing manifests: ${basename(sourcePath)}`);
  }
  return previewManifest(JSON.parse(manifest) as Record<string, unknown>);
}

function previewManifest(value: Record<string, unknown>): Awaited<ReturnType<typeof previewPackage>> {
  if (typeof value.id !== 'string') {
    throw new Error('Extension manifest is invalid');
  }
  const runtime = value.runtime as Record<string, unknown> | undefined;
  const uiValue = value.ui as Record<string, unknown> | undefined;
  const ui = Array.isArray(uiValue?.contributions) ? uiValue.contributions : [];
  const tools = Array.isArray(runtime?.tools) ? runtime.tools : [];
  const eventDefinitions = Array.isArray(runtime?.events) ? runtime.events : [];
  const listeners = Array.isArray(runtime?.listeners) ? runtime.listeners : [];
  const services = Array.isArray(runtime?.services) ? runtime.services : [];
  const timers = Array.isArray(runtime?.timers) ? runtime.timers : [];
  if (
    ui.length === 0 &&
    tools.length === 0 &&
    eventDefinitions.length === 0 &&
    listeners.length === 0 &&
    services.length === 0 &&
    timers.length === 0
  ) {
    throw new Error('Extension package has no contributions');
  }
  const permissions = uiValue?.permissions as Record<string, unknown> | undefined;
  const runtimePermissions = runtime?.permissions as Record<string, unknown> | undefined;
  const host = uiValue?.host as Record<string, unknown> | undefined;
  const methods = Array.isArray(host?.methods) ? host.methods : [];
  const hostMethods = methods.map((item) => (item as Record<string, unknown>)?.name);
  if (hostMethods.some((name) => typeof name !== 'string')) {
    throw new Error('Extension Bundle Host methods are invalid');
  }
  return {
    id: value.id,
    uiCount: ui.length,
    toolCount: tools.length,
    eventCount: eventDefinitions.length + listeners.length,
    serviceCount: services.length,
    timerCount: timers.length,
    hostMethods: hostMethods as string[],
    permissions: {
      network: permissions?.network === true || runtimePermissions?.network === true,
      hostState: permissions?.hostState === true,
      sessionAccess: permissions?.sessionAccess === true,
      workspace:
        typeof runtimePermissions?.workspace === 'string' ? runtimePermissions.workspace : 'none',
    },
  };
}

function userEntryId(extensionId: string, scopeId: string): string {
  return `user_extension_${createHash('sha256').update(`${scopeId}\u0000${extensionId}`).digest('hex').slice(0, 32)}`;
}
