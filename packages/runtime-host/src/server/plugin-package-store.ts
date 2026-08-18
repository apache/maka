import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';
import {
  type ExtensionPackageManifest,
  loadExtensionPackageManifest,
} from './extension-package-manifest.js';
import {
  type InstalledEventPackage,
  type EventPackageManifest,
  decodeEventPackageManifest,
} from './plugin-hook-manifest.js';
import {
  type InstalledToolPackage,
  type PackageFile,
  type ToolPackageManifest,
  decodeToolPackageManifest,
  packageRevision,
  readSourcePackage,
  syncDirectory,
  syncTree,
  writeStoredFile,
} from './plugin-runtime-manifest.js';
import {
  type InstalledUiPackage,
  type UiPackageManifest,
  decodeUiPackageManifest,
} from './plugin-ui-manifest.js';

const STORE_DIRECTORY = 'plugin-packages-v1';
const MANIFEST_FILE = 'maka.extension.json';
const REVISION_PATTERN = /^sha256-[a-f0-9]{64}$/u;

export interface InstalledPluginPackage {
  readonly extensionId: string;
  readonly revision: string;
  readonly root: string;
  readonly manifest: ExtensionPackageManifest;
  readonly toolManifest?: ToolPackageManifest;
  readonly uiManifest?: UiPackageManifest;
  readonly eventManifest?: EventPackageManifest;
}

export class PluginPackageStoreError extends Error {
  readonly name = 'PluginPackageStoreError';

  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** One content-addressed store for complete Tool/UI/Hook plugin revisions. */
export class PluginPackageStore {
  readonly root: string;

  constructor(controlDirectory: string) {
    this.root = join(controlDirectory, STORE_DIRECTORY);
  }

  async install(sourcePath: string): Promise<InstalledPluginPackage> {
    const files = await readFiles(sourcePath);
    const decoded = await decodePackage(sourcePath, files);
    const revision = packageRevision(files);
    const extensionRoot = join(this.root, decoded.manifest.id);
    const target = join(extensionRoot, revision);
    try {
      return await this.load(decoded.manifest.id, revision);
    } catch (error) {
      if (!(error instanceof PluginPackageStoreError) || error.code !== 'not_found') throw error;
    }
    const staging = join(this.root, `.staging-${randomUUID()}`);
    let committed = false;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      for (const file of files) await writeStoredFile(staging, file);
      await syncTree(staging, files);
      await mkdir(extensionRoot, { recursive: true, mode: 0o700 });
      await rename(staging, target);
      committed = true;
      await syncDirectory(extensionRoot);
      return freezeInstalled(target, revision, decoded);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return await this.load(decoded.manifest.id, revision);
      }
      throw persistence(
        `Unable to install Plugin package ${decoded.manifest.id}@${revision}`,
        error,
      );
    } finally {
      if (!committed) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<readonly InstalledPluginPackage[]> {
    let packages: Dirent[];
    try {
      packages = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw persistence('Unable to list installed Plugin packages', error);
    }
    const installed: InstalledPluginPackage[] = [];
    for (const item of packages.sort(compareDirent)) {
      if (!item.isDirectory() || !isCanonicalExtensionId(item.name)) continue;
      const revisions = await readdir(join(this.root, item.name), { withFileTypes: true });
      for (const revision of revisions.sort(compareDirent)) {
        if (revision.isDirectory() && REVISION_PATTERN.test(revision.name)) {
          installed.push(await this.load(item.name, revision.name));
        }
      }
    }
    return Object.freeze(installed);
  }

  async load(extensionId: string, revision: string): Promise<InstalledPluginPackage> {
    requireIdentity(extensionId, revision);
    const root = join(this.root, extensionId, revision);
    try {
      if (!(await stat(root)).isDirectory()) {
        throw invalid('Installed Plugin package is not a directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PluginPackageStoreError(
          'not_found',
          `Plugin package revision is not installed: ${extensionId}@${revision}`,
        );
      }
      if (error instanceof PluginPackageStoreError) throw error;
      throw persistence(`Unable to read Plugin package ${extensionId}@${revision}`, error);
    }
    const files = await readFiles(root);
    const decoded = await decodePackage(root, files);
    if (decoded.manifest.id !== extensionId || packageRevision(files) !== revision) {
      throw invalid(`Installed Plugin package integrity check failed: ${extensionId}@${revision}`);
    }
    return freezeInstalled(root, revision, decoded);
  }

  async loadTool(extensionId: string, revision: string): Promise<InstalledToolPackage> {
    const installed = await this.load(extensionId, revision);
    if (!installed.toolManifest)
      throw invalid(`Plugin revision has no Tool contributions: ${extensionId}@${revision}`);
    return Object.freeze({
      extensionId,
      revision,
      root: installed.root,
      entry: join(installed.root, ...installed.toolManifest.entry.split('/')),
      manifest: installed.toolManifest,
    });
  }

  async loadUi(extensionId: string, revision: string): Promise<InstalledUiPackage> {
    const installed = await this.load(extensionId, revision);
    if (!installed.uiManifest)
      throw invalid(`Plugin revision has no UI contributions: ${extensionId}@${revision}`);
    return Object.freeze({
      extensionId,
      revision,
      root: installed.root,
      manifest: installed.uiManifest,
    });
  }

  async loadEvent(extensionId: string, revision: string): Promise<InstalledEventPackage> {
    const installed = await this.load(extensionId, revision);
    if (!installed.eventManifest)
      throw invalid(`Plugin revision has no Hook contributions: ${extensionId}@${revision}`);
    return Object.freeze({
      extensionId,
      revision,
      root: installed.root,
      entry: join(installed.root, ...installed.eventManifest.entry.split('/')),
      manifest: installed.eventManifest,
    });
  }

  async readText(
    installed: Pick<InstalledPluginPackage, 'root'>,
    relativePath: string,
  ): Promise<string> {
    const content = await readFile(join(installed.root, ...relativePath.split('/')));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch (error) {
      throw invalid(`Plugin package file is not valid UTF-8: ${relativePath}`, error);
    }
  }

  async readDocument(
    installed: Pick<InstalledPluginPackage, 'root'>,
    relativePath: string,
  ): Promise<string> {
    return await this.readText(installed, relativePath);
  }

  async uninstall(extensionId: string, revision: string): Promise<void> {
    await this.load(extensionId, revision);
    const target = join(this.root, extensionId, revision);
    try {
      await rm(target, { recursive: true, force: false });
      const parent = dirname(target);
      if ((await readdir(parent)).length === 0) {
        await rm(parent, { recursive: true, force: false });
      }
      await syncDirectory(this.root).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw persistence(`Unable to uninstall Plugin package ${extensionId}@${revision}`, error);
      }
    }
  }
}

interface DecodedPackage {
  readonly manifest: ExtensionPackageManifest;
  readonly toolManifest?: ToolPackageManifest;
  readonly uiManifest?: UiPackageManifest;
  readonly eventManifest?: EventPackageManifest;
}

async function decodePackage(root: string, files: readonly PackageFile[]): Promise<DecodedPackage> {
  const manifestFile = files.find(({ path }) => path === MANIFEST_FILE);
  if (!manifestFile) throw invalid(`Plugin package is missing ${MANIFEST_FILE}`);
  let manifest: ExtensionPackageManifest;
  try {
    const loaded = await loadExtensionPackageManifest(root);
    if (!loaded) throw invalid(`Plugin package is missing ${MANIFEST_FILE}`);
    manifest = loaded;
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'Plugin manifest is invalid', error);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(manifestFile.content.toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw invalid('Plugin manifest is invalid JSON', error);
  }
  const runtime = raw.runtime as Record<string, unknown> | undefined;
  const hasTools = Array.isArray(runtime?.tools) && runtime.tools.length > 0;
  const hasEvents = ['events', 'listeners', 'services', 'timers'].some(
    (key) => Array.isArray(runtime?.[key]) && (runtime[key] as unknown[]).length > 0,
  );
  const hasUi = raw.ui !== undefined;
  if (!hasTools && !hasEvents && !hasUi) {
    throw invalid('Plugin package must declare Tool, UI, or Hook contributions');
  }
  try {
    const toolManifest = hasTools ? decodeToolPackageManifest(raw) : undefined;
    const eventManifest = hasEvents ? decodeEventPackageManifest(raw) : undefined;
    const uiManifest = hasUi ? decodeUiPackageManifest(raw) : undefined;
    const paths = new Set(files.map(({ path }) => path));
    if (toolManifest && !paths.has(toolManifest.entry)) {
      throw invalid(`Plugin runtime entry does not exist: ${toolManifest.entry}`);
    }
    if (eventManifest && !paths.has(eventManifest.entry)) {
      throw invalid(`Plugin runtime entry does not exist: ${eventManifest.entry}`);
    }
    if (uiManifest) {
      for (const item of uiManifest.ui) {
        if (!paths.has(item.document))
          throw invalid(`Plugin UI document does not exist: ${item.document}`);
      }
      if (uiManifest.host && !paths.has(uiManifest.host.entry)) {
        throw invalid(`Plugin UI Host entry does not exist: ${uiManifest.host.entry}`);
      }
    }
    return Object.freeze({
      manifest,
      ...(toolManifest ? { toolManifest } : {}),
      ...(uiManifest ? { uiManifest } : {}),
      ...(eventManifest ? { eventManifest } : {}),
    });
  } catch (error) {
    throw invalid(
      error instanceof Error ? error.message : 'Plugin contributions are invalid',
      error,
    );
  }
}

async function readFiles(root: string): Promise<readonly PackageFile[]> {
  try {
    return await readSourcePackage(root);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'Plugin package is invalid', error);
  }
}

function freezeInstalled(
  root: string,
  revision: string,
  decoded: DecodedPackage,
): InstalledPluginPackage {
  return Object.freeze({ extensionId: decoded.manifest.id, revision, root, ...decoded });
}

function requireIdentity(extensionId: string, revision: string): void {
  if (!isCanonicalExtensionId(extensionId) || !REVISION_PATTERN.test(revision)) {
    throw invalid('Plugin package identity is invalid');
  }
}

function compareDirent(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

function invalid(message: string, cause?: unknown): PluginPackageStoreError {
  return new PluginPackageStoreError('invalid_package', message, { cause });
}

function persistence(message: string, cause?: unknown): PluginPackageStoreError {
  return new PluginPackageStoreError('persistence_failed', message, { cause });
}
