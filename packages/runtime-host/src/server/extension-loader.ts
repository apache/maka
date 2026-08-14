import type { TrustedExtensionRevisionProjection } from '../protocol/index.js';
import type {
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
  load(extensionId: string, revision: string): Promise<HostToolExtensionRevisionInput>;
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
  ) {}

  async list(): Promise<readonly TrustedExtensionRevisionProjection[]> {
    const combined = [...(await this.statics.list())];
    for (const installed of await this.packages.list()) combined.push(projectPackage(installed));
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

  async load(extensionId: string, revision: string): Promise<HostToolExtensionRevisionInput> {
    try {
      return await this.statics.load(extensionId, revision);
    } catch (error) {
      if (!(error instanceof HostExtensionLoaderError) || error.code !== 'not_found') throw error;
    }
    try {
      return packageRevisionInput(await this.packages.load(extensionId, revision));
    } catch (error) {
      throw translatePackageError(error);
    }
  }

  async installPackage(sourcePath: string): Promise<TrustedExtensionRevisionProjection> {
    try {
      const installed = await this.packages.install(sourcePath);
      const staticConflict = (await this.statics.list()).some(
        (item) =>
          item.extensionId === installed.extensionId && item.revision === installed.revision,
      );
      if (staticConflict) {
        await this.packages
          .uninstall(installed.extensionId, installed.revision)
          .catch(() => undefined);
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Tool package conflicts with a static revision: ${installed.extensionId}@${installed.revision}`,
        );
      }
      return projectPackage(installed);
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
      await this.packages.uninstall(extensionId, revision);
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
  return new HostExtensionLoaderError('load_failed', 'Tool package operation failed', {
    cause: error,
  });
}

function assertDefinition(definition: HostTrustedToolExtensionRevisionInput): void {
  if (!definition || typeof definition !== 'object') {
    throw new HostExtensionLoaderError('invalid_definition', 'Trusted Extension is required');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(definition.extensionId)) {
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
