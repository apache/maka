import { isCanonicalExtensionId } from '@maka/runtime/extension-lifecycle-kernel';
import type { TrustedExtensionRevisionProjection } from '../protocol/index.js';
import type {
  HostExtensionRevisionInput,
  HostPreparedToolExtensionRevisionInput,
  HostToolExtensionRevisionInput,
  HostTrustedToolExtensionRevisionInput,
} from './extension-runtime.js';
import { ToolPackageActivation } from './tool-package-worker.js';
import {
  type InstalledToolPackage,
  ToolPackageStore,
  ToolPackageStoreError,
} from './tool-package-store.js';
import {
  type InstalledUiPackage,
  UiPackageStore,
  UiPackageStoreError,
} from './ui-package-store.js';
import { UiPackageService } from './ui-package-service.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

export type StaticTrustedToolExtensionRevision = HostTrustedToolExtensionRevisionInput;

export class HostExtensionLoaderError extends Error {
  readonly name = 'HostExtensionLoaderError';

  constructor(
    readonly code: 'not_found' | 'invalid_definition' | 'load_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface HostTrustedToolExtensionLoader {
  list(): Promise<readonly TrustedExtensionRevisionProjection[]>;
  load(extensionId: string, revision: string): Promise<HostExtensionRevisionInput>;
  installPackage?(sourcePath: string): Promise<TrustedExtensionRevisionProjection>;
  uninstallPackage?(extensionId: string, revision: string): Promise<void>;
}

/**
 * Loader for Tool revisions explicitly registered by the trusted Host composition.
 *
 * It never resolves a path or executes workspace code. Installed packages use
 * a separate loader and isolated worker without weakening this static boundary.
 */
export class StaticTrustedToolExtensionLoader implements HostTrustedToolExtensionLoader {
  readonly #definitions = new Map<string, HostTrustedToolExtensionRevisionInput>();
  readonly #catalog: readonly TrustedExtensionRevisionProjection[];

  constructor(definitions: readonly StaticTrustedToolExtensionRevision[] = []) {
    for (const definition of definitions) {
      assertDefinition(definition);
      const key = revisionKey(definition.extensionId, definition.revision);
      if (this.#definitions.has(key)) {
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Trusted Extension revision is registered more than once: ${key}`,
        );
      }
      this.#definitions.set(key, freezeDefinition(definition));
    }
    this.#catalog = Object.freeze(
      [...this.#definitions.values()]
        .map((definition) =>
          Object.freeze({
            extensionId: definition.extensionId,
            revision: definition.revision,
            toolNames: Object.freeze(definition.tools.map(({ name }) => name).sort(compareString)),
            uiContributionIds: Object.freeze([]),
          }),
        )
        .sort(compareRevision),
    );
  }

  async list(): Promise<readonly TrustedExtensionRevisionProjection[]> {
    return this.#catalog;
  }

  async load(
    extensionId: string,
    revision: string,
  ): Promise<HostTrustedToolExtensionRevisionInput> {
    const definition = this.#definitions.get(revisionKey(extensionId, revision));
    if (!definition) {
      throw new HostExtensionLoaderError(
        'not_found',
        `Trusted Extension revision is not available: ${extensionId}@${revision}`,
      );
    }
    return definition;
  }
}

/** Combines Host-composed static Tools with real packages installed in the root-private Store. */
export class InstalledToolPackageExtensionLoader implements HostTrustedToolExtensionLoader {
  constructor(
    private readonly statics: StaticTrustedToolExtensionLoader,
    private readonly packages: ToolPackageStore,
    private readonly uiPackages?: UiPackageStore,
  ) {}

  async list(): Promise<readonly TrustedExtensionRevisionProjection[]> {
    const combined = [...(await this.statics.list())];
    for (const installed of await this.packages.list()) combined.push(projectPackage(installed));
    if (this.uiPackages) {
      for (const installed of await this.uiPackages.list())
        combined.push(projectUiPackage(installed));
    }
    const keys = new Set<string>();
    for (const item of combined) {
      const key = revisionKey(item.extensionId, item.revision);
      if (keys.has(key)) {
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Tool Extension revision exists in both static and package catalogs: ${item.extensionId}@${item.revision}`,
        );
      }
      keys.add(key);
    }
    return Object.freeze(combined.sort(compareRevision));
  }

  async load(extensionId: string, revision: string): Promise<HostExtensionRevisionInput> {
    try {
      return await this.statics.load(extensionId, revision);
    } catch (error) {
      if (!(error instanceof HostExtensionLoaderError) || error.code !== 'not_found') throw error;
    }
    try {
      return packageRevisionInput(await this.packages.load(extensionId, revision));
    } catch (error) {
      if (!(error instanceof ToolPackageStoreError) || error.code !== 'not_found') {
        throw translatePackageError(error);
      }
    }
    if (this.uiPackages) {
      try {
        return await uiPackageRevisionInput(
          this.uiPackages,
          await this.uiPackages.load(extensionId, revision),
        );
      } catch (error) {
        throw translatePackageError(error);
      }
    }
    throw new HostExtensionLoaderError(
      'not_found',
      `Extension revision is not available: ${extensionId}@${revision}`,
    );
  }

  async installPackage(sourcePath: string): Promise<TrustedExtensionRevisionProjection> {
    try {
      const isUi = this.uiPackages && (await exists(join(sourcePath, 'maka.ui.json')));
      const installed = isUi
        ? await this.uiPackages!.install(sourcePath)
        : await this.packages.install(sourcePath);
      const staticConflict = (await this.statics.list()).some(
        (item) =>
          item.extensionId === installed.extensionId && item.revision === installed.revision,
      );
      if (staticConflict) {
        await (isUi
          ? this.uiPackages!.uninstall(installed.extensionId, installed.revision)
          : this.packages.uninstall(installed.extensionId, installed.revision)
        ).catch(() => undefined);
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Installed package conflicts with a static revision: ${installed.extensionId}@${installed.revision}`,
        );
      }
      return isUi
        ? projectUiPackage(installed as InstalledUiPackage)
        : projectPackage(installed as InstalledToolPackage);
    } catch (error) {
      throw translatePackageError(error);
    }
  }

  async uninstallPackage(extensionId: string, revision: string): Promise<void> {
    const staticRevision = (await this.statics.list()).some(
      (item) => item.extensionId === extensionId && item.revision === revision,
    );
    if (staticRevision) {
      throw new HostExtensionLoaderError(
        'invalid_definition',
        `Static Tool Extension revisions cannot be uninstalled: ${extensionId}@${revision}`,
      );
    }
    try {
      try {
        await this.packages.uninstall(extensionId, revision);
      } catch (error) {
        if (
          !(error instanceof ToolPackageStoreError) ||
          error.code !== 'not_found' ||
          !this.uiPackages
        ) {
          throw error;
        }
        await this.uiPackages.uninstall(extensionId, revision);
      }
    } catch (error) {
      throw translatePackageError(error);
    }
  }
}

function packageRevisionInput(
  installed: InstalledToolPackage,
): HostPreparedToolExtensionRevisionInput {
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    toolNames: Object.freeze(installed.manifest.tools.map(({ name }) => name)),
    prepare: async () => {
      const activation = new ToolPackageActivation(installed);
      return {
        tools: activation.tools(),
        healthCheck: () => activation.healthCheck(),
        dispose: () => activation.dispose(),
      };
    },
  });
}

function projectPackage(installed: InstalledToolPackage): TrustedExtensionRevisionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    toolNames: Object.freeze(installed.manifest.tools.map(({ name }) => name).sort(compareString)),
    uiContributionIds: Object.freeze([]),
  });
}

async function uiPackageRevisionInput(
  store: UiPackageStore,
  installed: InstalledUiPackage,
): Promise<HostExtensionRevisionInput> {
  const service = new UiPackageService();
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    ui: Object.freeze(
      await Promise.all(
        installed.manifest.ui.map(async (item) =>
          Object.freeze({
            id: item.id,
            surface: item.surface,
            priority: item.priority,
            document: await store.readDocument(installed, item.document),
            network: installed.manifest.permissions.network,
            hostState: installed.manifest.permissions.hostState,
            hostMethods: Object.freeze(
              installed.manifest.host?.methods.map(({ name }) => name) ?? [],
            ),
          }),
        ),
      ),
    ),
    healthCheck: () => service.healthCheck(installed),
  });
}

function projectUiPackage(installed: InstalledUiPackage): TrustedExtensionRevisionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    toolNames: Object.freeze([]),
    uiContributionIds: Object.freeze(installed.manifest.ui.map(({ id }) => id).sort(compareString)),
  });
}

function translatePackageError(error: unknown): HostExtensionLoaderError {
  if (error instanceof HostExtensionLoaderError) return error;
  if (error instanceof ToolPackageStoreError) {
    return new HostExtensionLoaderError(
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'invalid_package' || error.code === 'already_installed'
          ? 'invalid_definition'
          : 'load_failed',
      error.message,
      { cause: error },
    );
  }
  if (error instanceof UiPackageStoreError) {
    return new HostExtensionLoaderError(
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'invalid_package' || error.code === 'already_installed'
          ? 'invalid_definition'
          : 'load_failed',
      error.message,
      { cause: error },
    );
  }
  return new HostExtensionLoaderError('load_failed', 'Extension package operation failed', {
    cause: error,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertDefinition(definition: HostTrustedToolExtensionRevisionInput): void {
  if (!definition || typeof definition !== 'object') {
    throw new HostExtensionLoaderError('invalid_definition', 'Trusted Extension is required');
  }
  if (!isCanonicalExtensionId(definition.extensionId)) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'Trusted Extension extensionId is invalid',
    );
  }
  if (
    typeof definition.revision !== 'string' ||
    definition.revision.length === 0 ||
    Buffer.byteLength(definition.revision, 'utf8') > 128 ||
    /[\r\n]/u.test(definition.revision)
  ) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'Trusted Extension revision is invalid',
    );
  }
  if (!Array.isArray(definition.tools) || definition.tools.length === 0) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'Trusted Extension must declare at least one Tool',
    );
  }
  const names = new Set<string>();
  for (const tool of definition.tools) {
    if (
      !tool ||
      typeof tool !== 'object' ||
      typeof tool.name !== 'string' ||
      tool.name.length === 0 ||
      tool.name.length > 128 ||
      /[\r\n\0]/u.test(tool.name) ||
      typeof tool.description !== 'string' ||
      typeof tool.impl !== 'function' ||
      tool.parameters === undefined
    ) {
      throw new HostExtensionLoaderError('invalid_definition', 'Trusted Extension Tool is invalid');
    }
    const key = tool.name.toLowerCase();
    if (names.has(key)) {
      throw new HostExtensionLoaderError(
        'invalid_definition',
        `Trusted Extension repeats Tool name: ${tool.name}`,
      );
    }
    names.add(key);
  }
}

function freezeDefinition(
  definition: HostTrustedToolExtensionRevisionInput,
): HostTrustedToolExtensionRevisionInput {
  return Object.freeze({
    extensionId: definition.extensionId,
    revision: definition.revision,
    tools: Object.freeze(definition.tools.map((tool) => Object.freeze({ ...tool }))),
    ...(definition.dependencies
      ? {
          dependencies: Object.freeze(
            definition.dependencies.map((item) => Object.freeze({ ...item })),
          ),
        }
      : {}),
    ...(definition.healthCheck ? { healthCheck: definition.healthCheck } : {}),
  });
}

function revisionKey(extensionId: string, revision: string): string {
  return `${extensionId}\u0000${revision}`;
}

function compareRevision(
  left: TrustedExtensionRevisionProjection,
  right: TrustedExtensionRevisionProjection,
): number {
  return (
    compareString(left.extensionId, right.extensionId) ||
    compareString(left.revision, right.revision)
  );
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
