import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { join } from 'node:path';
import { InProcessPackageActivation } from './in-process-package-runtime.js';
import type { InstalledToolPackage, ToolPackageManifest } from './tool-package-store.js';
import type { InstalledUiPackage } from './ui-package-store.js';

/** Executes a trusted UI revision's package-private Host methods in process. */
export class UiPackageService {
  async healthCheck(installed: InstalledUiPackage): Promise<void> {
    if (!installed.manifest.host) return;
    const packageRevision = asRuntimePackage(installed);
    const activation = new InProcessPackageActivation(packageRevision);
    try {
      await activation.healthCheck(packageRevision.manifest.tools.map(({ handler }) => handler));
    } finally {
      await activation.dispose();
    }
  }

  async invoke(
    installed: InstalledUiPackage,
    methodName: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const declaration = installed.manifest.host?.methods.find(({ name }) => name === methodName);
    if (!declaration) throw new Error(`UI Host method is not declared: ${methodName}`);
    const activation = new InProcessPackageActivation(asRuntimePackage(installed));
    const context: MakaToolContext = {
      sessionId: `ui:${installed.extensionId}`,
      turnId: installed.revision,
      cwd: installed.root,
      toolCallId: `ui-host:${methodName}`,
      abortSignal: signal,
      emitOutput: () => undefined,
    };
    try {
      return await activation.invoke(declaration.handler, args, context);
    } finally {
      await activation.dispose();
    }
  }
}

function asRuntimePackage(installed: InstalledUiPackage): InstalledToolPackage {
  const host = installed.manifest.host;
  if (!host) throw new Error('UI package does not declare a Host service');
  const manifest: ToolPackageManifest = {
    schemaVersion: 1,
    id: installed.extensionId,
    version: installed.manifest.version,
    entry: host.entry,
    tools: Object.freeze(
      host.methods.map(({ name, handler }) =>
        Object.freeze({
          name,
          description: `Private UI Host method ${name}`,
          handler,
          inputSchema: Object.freeze({}),
          category: 'network_send' as const,
          recoveryMode: 'never_auto_retry' as const,
        }),
      ),
    ),
    permissions: Object.freeze({
      workspace: 'none' as const,
      network: installed.manifest.permissions.network,
    }),
  };
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    root: installed.root,
    entry: join(installed.root, ...host.entry.split('/')),
    manifest: Object.freeze(manifest),
  });
}
