import type { Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/extension-lifecycle-kernel';
import {
  EXTENSION_HOOK_EVENTS,
  modeForEvent,
  type ExtensionHookDispatchMode,
  type ExtensionHookEventName,
} from '@maka/runtime/extension-hook-contributions';
import {
  boundedString,
  compareDirent,
  compareString,
  exactRecord,
  optionalExactRecord,
  packagePath,
  packageRevision,
  parseJson,
  readSourcePackage,
  syncDirectory,
  syncTree,
  writeStoredFile,
} from './tool-package-store.js';

export const HOOK_PACKAGE_MANIFEST_FILE = 'maka.hook.json';
const STORE_DIRECTORY = 'hook-packages-v1';
const MAX_MANIFEST_BYTES = 256 * 1024;
const REVISION_PATTERN = /^sha256-[a-f0-9]{64}$/u;
const HANDLER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export interface HookPackageManifestHook {
  readonly id: string;
  readonly event: ExtensionHookEventName;
  readonly mode: ExtensionHookDispatchMode;
  readonly handler: string;
  readonly matcher?: string;
  readonly priority: number;
  readonly timeoutMs: number;
}

export interface HookPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly hooks: readonly HookPackageManifestHook[];
  readonly permissions: {
    readonly workspace: 'none' | 'read';
    readonly network: boolean;
  };
}

export interface InstalledHookPackage {
  readonly extensionId: string;
  readonly revision: string;
  readonly root: string;
  readonly entry: string;
  readonly manifest: HookPackageManifest;
}

export class HookPackageStoreError extends Error {
  readonly name = 'HookPackageStoreError';

  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class HookPackageStore {
  readonly root: string;

  constructor(controlDirectory: string) {
    this.root = join(controlDirectory, STORE_DIRECTORY);
  }

  async install(sourcePath: string): Promise<InstalledHookPackage> {
    let files: Awaited<ReturnType<typeof readSourcePackage>>;
    try {
      files = await readSourcePackage(sourcePath);
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : 'Unable to read Hook package',
        error,
      );
    }
    const manifestFile = files.find(({ path }) => path === HOOK_PACKAGE_MANIFEST_FILE);
    if (!manifestFile)
      throw invalidPackage(`Hook package is missing ${HOOK_PACKAGE_MANIFEST_FILE}`);
    if (manifestFile.content.byteLength > MAX_MANIFEST_BYTES) {
      throw invalidPackage('Hook package manifest exceeds its size limit');
    }
    const manifest = decodeStoredManifest(manifestFile.content);
    if (!files.some(({ path }) => path === manifest.entry)) {
      throw invalidPackage(`Hook package entry does not exist: ${manifest.entry}`);
    }
    const revision = packageRevision(files);
    const extensionRoot = join(this.root, manifest.id);
    const target = join(extensionRoot, revision);
    try {
      const installed = await this.load(manifest.id, revision);
      if (JSON.stringify(installed.manifest) === JSON.stringify(manifest)) return installed;
      throw new HookPackageStoreError(
        'already_installed',
        `Hook package revision already exists with conflicting metadata: ${manifest.id}@${revision}`,
      );
    } catch (error) {
      if (!(error instanceof HookPackageStoreError) || error.code !== 'not_found') throw error;
    }

    const staging = join(this.root, `.staging-${randomUUID()}`);
    let committed = false;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(staging, { recursive: false, mode: 0o700 });
      for (const file of files) await writeStoredFile(staging, file);
      await syncTree(staging, files);
      await mkdir(extensionRoot, { recursive: true, mode: 0o700 });
      await rename(staging, target);
      committed = true;
      await syncDirectory(extensionRoot);
      return freezeInstalled(target, revision, manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        return this.load(manifest.id, revision);
      throw persistenceFailure(`Unable to install Hook package ${manifest.id}@${revision}`, error);
    } finally {
      if (!committed) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<readonly InstalledHookPackage[]> {
    let extensions: Dirent[];
    try {
      extensions = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw persistenceFailure('Unable to list installed Hook packages', error);
    }
    const installed: InstalledHookPackage[] = [];
    for (const extension of extensions.sort(compareDirent)) {
      if (!extension.isDirectory() || !isCanonicalExtensionId(extension.name)) continue;
      const extensionRoot = join(this.root, extension.name);
      const revisions = await readdir(extensionRoot, { withFileTypes: true }).catch((error) => {
        throw persistenceFailure(`Unable to list Hook package ${extension.name}`, error);
      });
      for (const revision of revisions.sort(compareDirent)) {
        if (!revision.isDirectory() || !REVISION_PATTERN.test(revision.name)) continue;
        installed.push(await this.load(extension.name, revision.name));
      }
    }
    return Object.freeze(installed);
  }

  async load(extensionId: string, revision: string): Promise<InstalledHookPackage> {
    requireIdentity(extensionId, revision);
    const root = join(this.root, extensionId, revision);
    try {
      if (!(await stat(root)).isDirectory())
        throw invalidPackage('Installed Hook package is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HookPackageStoreError(
          'not_found',
          `Hook package revision is not installed: ${extensionId}@${revision}`,
        );
      }
      if (error instanceof HookPackageStoreError) throw error;
      throw persistenceFailure(`Unable to read Hook package ${extensionId}@${revision}`, error);
    }
    let files: Awaited<ReturnType<typeof readSourcePackage>>;
    try {
      files = await readSourcePackage(root);
    } catch (error) {
      throw invalidPackage('Unable to read installed Hook package', error);
    }
    const manifestFile = files.find(({ path }) => path === HOOK_PACKAGE_MANIFEST_FILE);
    if (!manifestFile)
      throw invalidPackage(`Installed Hook package is missing ${HOOK_PACKAGE_MANIFEST_FILE}`);
    const manifest = decodeStoredManifest(manifestFile.content);
    if (manifest.id !== extensionId) {
      throw invalidPackage(
        `Installed Hook package identity does not match its path: ${extensionId}`,
      );
    }
    if (packageRevision(files) !== revision) {
      throw invalidPackage(
        `Installed Hook package content hash does not match: ${extensionId}@${revision}`,
      );
    }
    const entry = join(root, ...manifest.entry.split('/'));
    if (!(await stat(entry).catch(() => undefined))?.isFile()) {
      throw invalidPackage(`Hook package entry is unavailable: ${manifest.entry}`);
    }
    return freezeInstalled(root, revision, manifest);
  }

  async uninstall(extensionId: string, revision: string): Promise<void> {
    requireIdentity(extensionId, revision);
    await this.load(extensionId, revision);
    const target = join(this.root, extensionId, revision);
    try {
      await rm(target, { recursive: true, force: false });
      const extensionRoot = dirname(target);
      if ((await readdir(extensionRoot)).length === 0) {
        await rm(extensionRoot, { recursive: true, force: false });
      }
      await syncDirectory(this.root).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw persistenceFailure(
        `Unable to uninstall Hook package ${extensionId}@${revision}`,
        error,
      );
    }
  }
}

export function decodeHookPackageManifest(value: unknown): HookPackageManifest {
  const record = exactRecord(value, [
    'schemaVersion',
    'id',
    'version',
    'entry',
    'hooks',
    'permissions',
  ]);
  if (record.schemaVersion !== 1) throw invalidPackage('Hook package schemaVersion must be 1');
  const id = boundedString(record.id, 'Hook id', 128);
  if (!isCanonicalExtensionId(id)) throw invalidPackage('Hook package id is invalid');
  const version = boundedString(record.version, 'Hook version', 128);
  const entry = packagePath(record.entry, 'Hook entry');
  if (!entry.endsWith('.mjs')) throw invalidPackage('Hook package entry must be an .mjs file');
  if (!Array.isArray(record.hooks) || record.hooks.length === 0 || record.hooks.length > 64) {
    throw invalidPackage('Hook package must declare between 1 and 64 Hooks');
  }
  const identities = new Set<string>();
  const hooks = record.hooks.map((value, index): HookPackageManifestHook => {
    const hook = optionalExactRecord(value, [
      'id',
      'event',
      'mode',
      'handler',
      'matcher',
      'priority',
      'timeoutMs',
    ]);
    const hookId = boundedString(hook.id, `Hook hooks[${index}].id`, 128);
    const handler = boundedString(hook.handler, `Hook hooks[${index}].handler`, 128);
    if (!HANDLER_PATTERN.test(hookId) || !HANDLER_PATTERN.test(handler)) {
      throw invalidPackage(`Hook declaration identity is invalid: ${hookId}`);
    }
    const event = hook.event;
    if (
      typeof event !== 'string' ||
      !EXTENSION_HOOK_EVENTS.includes(event as ExtensionHookEventName)
    ) {
      throw invalidPackage(`Hook event is invalid: ${String(event)}`);
    }
    const canonicalEvent = event as ExtensionHookEventName;
    const mode =
      hook.mode === undefined ? modeForEvent(canonicalEvent) : decodeDispatchMode(hook.mode);
    if (mode !== modeForEvent(canonicalEvent)) {
      throw invalidPackage(
        `${canonicalEvent} requires ${modeForEvent(canonicalEvent)} dispatch mode`,
      );
    }
    const identity = `${canonicalEvent}\0${hookId}`;
    if (identities.has(identity)) throw invalidPackage(`Hook declaration repeats: ${hookId}`);
    identities.add(identity);
    const matcher =
      hook.matcher === undefined ? undefined : boundedString(hook.matcher, 'Hook matcher', 256);
    const priority = hook.priority === undefined ? 0 : hook.priority;
    const timeoutMs = hook.timeoutMs === undefined ? 3_000 : hook.timeoutMs;
    if (!Number.isSafeInteger(priority) || Math.abs(priority as number) > 10_000) {
      throw invalidPackage('Hook priority is invalid');
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) < 10 ||
      (timeoutMs as number) > 120_000
    ) {
      throw invalidPackage('Hook timeout is invalid');
    }
    return Object.freeze({
      id: hookId,
      event: canonicalEvent,
      mode,
      handler,
      ...(matcher ? { matcher } : {}),
      priority: priority as number,
      timeoutMs: timeoutMs as number,
    });
  });
  const permissions = exactRecord(record.permissions, ['workspace', 'network']);
  if (permissions.workspace !== 'none' && permissions.workspace !== 'read') {
    throw invalidPackage('Hook package workspace permission must be none or read');
  }
  if (typeof permissions.network !== 'boolean') {
    throw invalidPackage('Hook package network permission is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    id,
    version,
    entry,
    hooks: Object.freeze(
      hooks.sort(
        (left, right) =>
          left.event.localeCompare(right.event) ||
          right.priority - left.priority ||
          compareString(left.id, right.id),
      ),
    ),
    permissions: Object.freeze({ workspace: permissions.workspace, network: permissions.network }),
  });
}

function decodeStoredManifest(encoded: Buffer): HookPackageManifest {
  try {
    return decodeHookPackageManifest(parseJson(encoded));
  } catch (error) {
    if (error instanceof HookPackageStoreError) throw error;
    throw invalidPackage(
      error instanceof Error ? error.message : 'Hook package manifest is invalid',
      error,
    );
  }
}

function decodeDispatchMode(value: unknown): ExtensionHookDispatchMode {
  if (value === 'observe' || value === 'gate' || value === 'transform') return value;
  throw invalidPackage(`Hook dispatch mode is invalid: ${String(value)}`);
}

function freezeInstalled(
  root: string,
  revision: string,
  manifest: HookPackageManifest,
): InstalledHookPackage {
  return Object.freeze({
    extensionId: manifest.id,
    revision,
    root,
    entry: join(root, ...manifest.entry.split('/')),
    manifest,
  });
}

function requireIdentity(extensionId: string, revision: string): void {
  if (!isCanonicalExtensionId(extensionId)) throw invalidPackage('Hook package id is invalid');
  if (!REVISION_PATTERN.test(revision)) throw invalidPackage('Hook package revision is invalid');
}

function invalidPackage(message: string, cause?: unknown): HookPackageStoreError {
  return new HookPackageStoreError('invalid_package', message, { cause });
}

function persistenceFailure(message: string, cause?: unknown): HookPackageStoreError {
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  return new HookPackageStoreError('persistence_failed', `${message}${detail}`, { cause });
}
