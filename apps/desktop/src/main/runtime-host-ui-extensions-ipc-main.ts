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
          type: 'question',
          title: `Import ${manifest.id}`,
          message: `Install Extension “${manifest.id}” ${manifest.version}?`,
          detail: [
            `${manifest.uiCount} UI contribution${manifest.uiCount === 1 ? '' : 's'}`,
            `${manifest.toolCount} Tool contribution${manifest.toolCount === 1 ? '' : 's'}`,
            `${manifest.hookCount} Hook contribution${manifest.hookCount === 1 ? '' : 's'}`,
            `${manifest.eventCount} Event/Listener contribution${manifest.eventCount === 1 ? '' : 's'}`,
            `Host state: ${manifest.permissions.hostState ? 'allowed' : 'not allowed'}`,
            `Session control: ${manifest.permissions.sessionAccess ? 'allowed' : 'not allowed'}`,
            `Host methods: ${manifest.hostMethods.length === 0 ? 'none' : manifest.hostMethods.join(', ')}`,
            `Network: ${manifest.permissions.network ? 'allowed' : 'blocked'}`,
            `Workspace: ${manifest.permissions.workspace}`,
          ].join('\n'),
          buttons: ['Install and enable', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
    if (confirmation.response !== 0) return { ok: false as const, reason: 'cancelled' as const };
    const installed = await input.client.request('extension.package.install', { sourcePath });
    const catalog = await input.client.request('extension.catalog.query', {});
    for (const scopeId of new Set([
      ...(installed.uiContributionIds.length > 0 ? [DESKTOP_UI_SCOPE] : []),
      ...(installed.toolNames.length > 0 || installed.hookContributionIds.length > 0 || installed.eventContributionIds.length > 0
        ? [PROFILE_EXTENSION_SCOPE]
        : []),
    ])) {
      const current = catalog.bindings.find(
        (binding) => binding.scopeId === scopeId && binding.extensionId === installed.extensionId,
      );
      await input.client.request(
        'extension.catalog.mutate',
        current
          ? { kind: 'update', bindingId: current.bindingId, revision: installed.revision }
          : {
              kind: 'enable',
              bindingId: userBindingId(installed.extensionId, scopeId),
              scopeId,
              extensionId: installed.extensionId,
              revision: installed.revision,
            },
      );
    }
    return { ok: true as const, extensionId: installed.extensionId, revision: installed.revision };
  });

  input.ipcMain.handle('ui-extensions:setEnabled', async (_event, extensionId: string, enabled: boolean) => {
    const catalog = await input.client.request('extension.catalog.query', {});
    const bindings = catalog.bindings.filter((item) => item.extensionId === extensionId);
    if (bindings.length === 0) throw new Error('Extension binding is not installed');
    for (const binding of bindings) {
      await input.client.request('extension.catalog.mutate', enabled
        ? { kind: 'enable', bindingId: binding.bindingId, scopeId: binding.scopeId, extensionId: binding.extensionId, revision: binding.desiredRevision }
        : { kind: 'disable', bindingId: binding.bindingId });
    }
    return { ok: true as const };
  });

  input.ipcMain.handle('ui-extensions:remove', async (_event, extensionId: string) => {
    const catalog = await input.client.request('extension.catalog.query', {});
    for (const binding of catalog.bindings.filter((item) => item.extensionId === extensionId)) {
      await input.client.request('extension.catalog.mutate', { kind: 'remove', bindingId: binding.bindingId });
    }
    for (const revision of catalog.revisions.filter((item) => item.extensionId === extensionId)) {
      await input.client.request('extension.package.uninstall', { extensionId, revision: revision.revision });
    }
    return { ok: true as const };
  });

  input.ipcMain.handle('ui-extensions:configure', async (_event, bindingId: string, configuration: Record<string, string | number | boolean>) => {
    const result = await input.client.request('extension.configuration.mutate', { bindingId, configuration });
    return { ok: true as const, configuration: result.configuration };
  });

  handleReconnectableRead(input.ipcMain, 'ui-extensions:getConfiguration', async (_event, bindingId: string) =>
    input.client.request('extension.configuration.query', { bindingId }),
  );

  input.ipcMain.handle('ui-extensions:export', async (_event, extensionId: string, revision: string) => {
    if (!input.allowLocalPaths) throw new Error('Extension export is unavailable for a remote Runtime Host');
    const selected = await input.mainWindowController.showSaveDialog({
      title: `Export ${extensionId}`,
      defaultPath: `${extensionId}-${revision.slice(0, 12)}.maka-extension`,
      filters: [{ name: 'Maka Extension', extensions: ['maka-extension'] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: false as const, reason: 'cancelled' as const };
    await input.client.request('extension.package.export', { extensionId, revision, targetPath: selected.filePath });
    return { ok: true as const, path: selected.filePath };
  });
}

async function listUiExtensions(client: DesktopRuntimeHostClient) {
  const catalog = await client.request('extension.catalog.query', {});
  const contracts = await client.request('extension.contract.query', {}).catch(() => ({ packages: [] }));
  return catalog.revisions
    .map((revision) => {
      const bindings = catalog.bindings.filter((item) => item.extensionId === revision.extensionId);
      const binding = bindings.find((item) => item.lastGoodRevision === revision.revision) ?? bindings[0];
      const contract = contracts.packages.find((item) => item.extensionId === revision.extensionId && item.revision === revision.revision);
      return {
        extensionId: revision.extensionId,
        revision: revision.revision,
        displayName: contract?.displayName ?? revision.extensionId,
        version: contract?.version ?? revision.revision,
        description: contract?.description ?? '',
        contributionIds: [
          ...revision.toolNames,
          ...revision.uiContributionIds,
          ...revision.hookContributionIds,
          ...revision.eventContributionIds,
        ],
        toolNames: revision.toolNames,
        uiContributionIds: revision.uiContributionIds,
        hookContributionIds: revision.hookContributionIds,
        eventContributionIds: revision.eventContributionIds,
        dependencies: contract?.dependencies ?? [],
        configuration: contract?.configuration ?? { properties: {}, required: [] },
        bindings,
        active: bindings.some((item) => item.status === 'active' && item.lastGoodRevision === revision.revision),
        enabled: bindings.some((item) => item.enabled),
        status: bindings.some((item) => item.status === 'failed') ? 'failed' : bindings.some((item) => item.status === 'active') ? 'active' : bindings.some((item) => item.status === 'waiting') ? 'waiting' : 'disabled',
        error: bindings.find((item) => item.error)?.error ?? null,
      };
    });
}

async function previewPackage(sourcePath: string): Promise<{ id: string; version: string; uiCount: number; toolCount: number; hookCount: number; eventCount: number; hostMethods: string[]; permissions: { network: boolean; hostState: boolean; sessionAccess: boolean; workspace: string } }> {
  if (!(await stat(sourcePath)).isDirectory()) return previewBundle(sourcePath);
  let uiValue: Record<string, unknown> = {};
  let toolValue: Record<string, unknown> = {};
  let hookValue: Record<string, unknown> = {};
  let eventValue: Record<string, unknown> = {};
  try { uiValue = JSON.parse(await readFile(join(sourcePath, 'maka.ui.json'), 'utf8')) as Record<string, unknown>; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { toolValue = JSON.parse(await readFile(join(sourcePath, 'maka.tool.json'), 'utf8')) as Record<string, unknown>; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { hookValue = JSON.parse(await readFile(join(sourcePath, 'maka.hook.json'), 'utf8')) as Record<string, unknown>; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { eventValue = JSON.parse(await readFile(join(sourcePath, 'maka.event.json'), 'utf8')) as Record<string, unknown>; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const value = Object.keys(uiValue).length ? uiValue : Object.keys(toolValue).length ? toolValue : Object.keys(hookValue).length ? hookValue : eventValue;
  if (typeof value.id !== 'string' || typeof value.version !== 'string') throw new Error('Extension manifest is invalid');
  const ui = Array.isArray(uiValue.ui) ? uiValue.ui : [];
  const tools = Array.isArray(toolValue.tools) ? toolValue.tools : [];
  const hooks = Array.isArray(hookValue.hooks) ? hookValue.hooks : [];
  const eventDefinitions = Array.isArray(eventValue.events) ? eventValue.events : [];
  const listeners = Array.isArray(eventValue.listeners) ? eventValue.listeners : [];
  if (ui.length === 0 && tools.length === 0 && hooks.length === 0 && eventDefinitions.length === 0 && listeners.length === 0) throw new Error('Extension package has no contributions');
  const permissions = uiValue.permissions as Record<string, unknown> | undefined;
  const toolPermissions = toolValue.permissions as Record<string, unknown> | undefined;
  const hookPermissions = hookValue.permissions as Record<string, unknown> | undefined;
  const eventPermissions = eventValue.permissions as Record<string, unknown> | undefined;
  const host = uiValue.host as Record<string, unknown> | undefined;
  const methods = Array.isArray(host?.methods) ? host.methods : [];
  const hostMethods = methods.map((item) => (item as Record<string, unknown>)?.name);
  if (hostMethods.some((name) => typeof name !== 'string')) throw new Error('UI Extension Host methods are invalid');
  return {
    id: value.id,
    version: value.version,
    uiCount: ui.length,
    toolCount: tools.length,
    hookCount: hooks.length,
    eventCount: eventDefinitions.length + listeners.length,
    hostMethods: hostMethods as string[],
    permissions: {
      network: permissions?.network === true || toolPermissions?.network === true || hookPermissions?.network === true || eventPermissions?.network === true,
      hostState: permissions?.hostState === true,
      sessionAccess: permissions?.sessionAccess === true,
      workspace: typeof toolPermissions?.workspace === 'string' ? toolPermissions.workspace : typeof hookPermissions?.workspace === 'string' ? hookPermissions.workspace : typeof eventPermissions?.workspace === 'string' ? eventPermissions.workspace : 'none',
    },
  };
}

async function previewBundle(sourcePath: string): ReturnType<typeof previewPackage> {
  const encoded = await readFile(sourcePath);
  if (encoded.byteLength > 32 * 1024 * 1024) throw new Error('Extension Bundle is too large');
  const bundle = JSON.parse(encoded.toString('utf8')) as { files?: unknown };
  if (!Array.isArray(bundle.files)) throw new Error('Extension Bundle is invalid');
  const files = new Map<string, string>();
  for (const value of bundle.files) {
    const file = value as { path?: unknown; content?: unknown };
    if (typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('Extension Bundle file is invalid');
    }
    if (file.path === 'maka.ui.json' || file.path === 'maka.tool.json' || file.path === 'maka.hook.json' || file.path === 'maka.event.json') {
      files.set(file.path, Buffer.from(file.content, 'base64').toString('utf8'));
    }
  }
  const uiValue = files.has('maka.ui.json')
    ? (JSON.parse(files.get('maka.ui.json')!) as Record<string, unknown>)
    : {};
  const toolValue = files.has('maka.tool.json')
    ? (JSON.parse(files.get('maka.tool.json')!) as Record<string, unknown>)
    : {};
  const hookValue = files.has('maka.hook.json')
    ? (JSON.parse(files.get('maka.hook.json')!) as Record<string, unknown>)
    : {};
  const eventValue = files.has('maka.event.json')
    ? (JSON.parse(files.get('maka.event.json')!) as Record<string, unknown>)
    : {};
  const value = Object.keys(uiValue).length ? uiValue : Object.keys(toolValue).length ? toolValue : Object.keys(hookValue).length ? hookValue : eventValue;
  if (typeof value.id !== 'string' || typeof value.version !== 'string') {
    throw new Error(`Extension Bundle is missing manifests: ${basename(sourcePath)}`);
  }
  const ui = Array.isArray(uiValue.ui) ? uiValue.ui : [];
  const tools = Array.isArray(toolValue.tools) ? toolValue.tools : [];
  const hooks = Array.isArray(hookValue.hooks) ? hookValue.hooks : [];
  const eventDefinitions = Array.isArray(eventValue.events) ? eventValue.events : [];
  const listeners = Array.isArray(eventValue.listeners) ? eventValue.listeners : [];
  const permissions = uiValue.permissions as Record<string, unknown> | undefined;
  const toolPermissions = toolValue.permissions as Record<string, unknown> | undefined;
  const hookPermissions = hookValue.permissions as Record<string, unknown> | undefined;
  const eventPermissions = eventValue.permissions as Record<string, unknown> | undefined;
  const host = uiValue.host as Record<string, unknown> | undefined;
  const methods = Array.isArray(host?.methods) ? host.methods : [];
  const hostMethods = methods.map((item) => (item as Record<string, unknown>)?.name);
  if (hostMethods.some((name) => typeof name !== 'string')) {
    throw new Error('Extension Bundle Host methods are invalid');
  }
  return {
    id: value.id,
    version: value.version,
    uiCount: ui.length,
    toolCount: tools.length,
    hookCount: hooks.length,
    eventCount: eventDefinitions.length + listeners.length,
    hostMethods: hostMethods as string[],
    permissions: {
      network: permissions?.network === true || toolPermissions?.network === true || hookPermissions?.network === true || eventPermissions?.network === true,
      hostState: permissions?.hostState === true,
      sessionAccess: permissions?.sessionAccess === true,
      workspace: typeof toolPermissions?.workspace === 'string' ? toolPermissions.workspace : typeof hookPermissions?.workspace === 'string' ? hookPermissions.workspace : typeof eventPermissions?.workspace === 'string' ? eventPermissions.workspace : 'none',
    },
  };
}

function userBindingId(extensionId: string, scopeId: string): string {
  return `user_extension_${createHash('sha256').update(`${scopeId}\u0000${extensionId}`).digest('hex').slice(0, 32)}`;
}
