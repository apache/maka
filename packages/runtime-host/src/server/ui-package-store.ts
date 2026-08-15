import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/extension-lifecycle-kernel';
import {
  EXTENSION_UI_DOCUMENT_MAX_BYTES,
  EXTENSION_UI_SURFACES,
  type ExtensionUiSurface,
} from '@maka/runtime/extension-ui-contributions';
import { EXTENSION_UI_OFFICIAL_SLOTS } from '../protocol/extension.js';

const MANIFEST_FILE = 'maka.ui.json';
const STORE_DIRECTORY = 'ui-packages-v1';
const MAX_FILES = 64;
const MAX_FILE_BYTES = EXTENSION_UI_DOCUMENT_MAX_BYTES;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const REVISION_PATTERN = /^sha256-[a-f0-9]{64}$/u;

export interface UiPackageManifestContribution {
  readonly id: string;
  readonly surface: ExtensionUiSurface;
  readonly slot?: string;
  readonly priority: number;
  readonly document: string;
}

export interface UiPackageHostMethod {
  readonly name: string;
  readonly handler: string;
}

export interface UiPackageManifestHost {
  readonly entry: string;
  readonly methods: readonly UiPackageHostMethod[];
}

export interface UiPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly ui: readonly UiPackageManifestContribution[];
  readonly host?: UiPackageManifestHost;
  readonly permissions: {
    readonly network: boolean;
    readonly hostState: boolean;
    readonly sessionAccess: boolean;
  };
}

export interface InstalledUiPackage {
  readonly extensionId: string;
  readonly revision: string;
  readonly root: string;
  readonly manifest: UiPackageManifest;
}

export class UiPackageStoreError extends Error {
  readonly name = 'UiPackageStoreError';
  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface PackageFile {
  readonly path: string;
  readonly content: Buffer;
}

/** Content-addressed, root-private storage for client-only UI packages. */
export class UiPackageStore {
  readonly root: string;

  constructor(controlDirectory: string) {
    this.root = join(controlDirectory, STORE_DIRECTORY);
  }

  async install(sourcePath: string): Promise<InstalledUiPackage> {
    const files = await readSourcePackage(sourcePath);
    const manifestFile = files.find(({ path }) => path === MANIFEST_FILE);
    if (!manifestFile) throw invalidPackage(`UI package is missing ${MANIFEST_FILE}`);
    const manifest = decodeUiPackageManifest(parseJson(manifestFile.content));
    for (const contribution of manifest.ui) {
      const file = files.find(({ path }) => path === contribution.document);
      if (!file) throw invalidPackage(`UI document does not exist: ${contribution.document}`);
      validateHtml(file.content, contribution.document);
    }
    validateHostFiles(manifest, files);
    const revision = packageRevision(files);
    const extensionRoot = join(this.root, manifest.id);
    const target = join(extensionRoot, revision);
    try {
      const installed = await this.load(manifest.id, revision);
      if (JSON.stringify(installed.manifest) === JSON.stringify(manifest)) return installed;
      throw new UiPackageStoreError(
        'already_installed',
        `UI package revision has conflicting metadata: ${manifest.id}@${revision}`,
      );
    } catch (error) {
      if (!(error instanceof UiPackageStoreError) || error.code !== 'not_found') throw error;
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
      return Object.freeze({ extensionId: manifest.id, revision, root: target, manifest });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        return this.load(manifest.id, revision);
      throw persistenceFailure(`Unable to install UI package ${manifest.id}@${revision}`, error);
    } finally {
      if (!committed) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<readonly InstalledUiPackage[]> {
    let extensions: Dirent[];
    try {
      extensions = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw persistenceFailure('Unable to list installed UI packages', error);
    }
    const packages: InstalledUiPackage[] = [];
    for (const extension of extensions.sort(compareDirent)) {
      if (!extension.isDirectory() || !isCanonicalExtensionId(extension.name)) continue;
      const revisions = await readdir(join(this.root, extension.name), { withFileTypes: true });
      for (const revision of revisions.sort(compareDirent)) {
        if (revision.isDirectory() && REVISION_PATTERN.test(revision.name)) {
          packages.push(await this.load(extension.name, revision.name));
        }
      }
    }
    return Object.freeze(packages);
  }

  async load(extensionId: string, revision: string): Promise<InstalledUiPackage> {
    requireId(extensionId);
    requireRevision(revision);
    const root = join(this.root, extensionId, revision);
    try {
      if (!(await stat(root)).isDirectory())
        throw invalidPackage('Installed UI package is invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new UiPackageStoreError(
          'not_found',
          `UI package revision is not installed: ${extensionId}@${revision}`,
        );
      }
      if (error instanceof UiPackageStoreError) throw error;
      throw persistenceFailure(`Unable to read UI package ${extensionId}@${revision}`, error);
    }
    const files = await readSourcePackage(root);
    const manifestFile = files.find(({ path }) => path === MANIFEST_FILE);
    if (!manifestFile) throw invalidPackage(`Installed UI package is missing ${MANIFEST_FILE}`);
    const manifest = decodeUiPackageManifest(parseJson(manifestFile.content));
    if (
      manifest.id !== extensionId ||
      (packageRevision(files) !== revision && legacyPackageRevision(files) !== revision)
    ) {
      throw invalidPackage(
        `Installed UI package integrity check failed: ${extensionId}@${revision}`,
      );
    }
    for (const item of manifest.ui) {
      const file = files.find(({ path }) => path === item.document);
      if (!file) throw invalidPackage(`UI document does not exist: ${item.document}`);
      validateHtml(file.content, item.document);
    }
    validateHostFiles(manifest, files);
    return Object.freeze({ extensionId, revision, root, manifest });
  }

  async readDocument(installed: InstalledUiPackage, relativePath: string): Promise<string> {
    const path = packagePath(relativePath, 'document');
    if (!installed.manifest.ui.some((item) => item.document === path)) {
      throw invalidPackage(`UI document is not declared: ${path}`);
    }
    const content = await readFile(join(installed.root, ...path.split('/')));
    validateHtml(content, path);
    return content.toString('utf8');
  }

  async uninstall(extensionId: string, revision: string): Promise<void> {
    await this.load(extensionId, revision);
    const target = join(this.root, extensionId, revision);
    try {
      await rm(target, { recursive: true, force: false });
      const parent = dirname(target);
      if ((await readdir(parent)).length === 0) await rm(parent, { recursive: true, force: false });
      await syncDirectory(this.root).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw persistenceFailure(
          `Unable to uninstall UI package ${extensionId}@${revision}`,
          error,
        );
      }
    }
  }
}

export function decodeUiPackageManifest(value: unknown): UiPackageManifest {
  const candidate = value as Record<string, unknown> | null;
  const record = exactRecord(
    value,
    candidate && Object.hasOwn(candidate, 'host')
      ? ['schemaVersion', 'id', 'version', 'ui', 'host', 'permissions']
      : ['schemaVersion', 'id', 'version', 'ui', 'permissions'],
  );
  if (record.schemaVersion !== 1) throw invalidPackage('UI package schemaVersion must be 1');
  const id = requireId(record.id);
  const version = boundedString(record.version, 'version', 128);
  if (!Array.isArray(record.ui) || record.ui.length === 0 || record.ui.length > 16) {
    throw invalidPackage('UI package must declare between 1 and 16 contributions');
  }
  const ids = new Set<string>();
  const ui = record.ui.map((value, index): UiPackageManifestContribution => {
    const candidate = value as Record<string, unknown> | null;
    const item = exactRecord(value, [
      'id',
      'surface',
      'priority',
      'document',
      ...(candidate && Object.hasOwn(candidate, 'slot') ? ['slot'] : []),
    ]);
    const contributionId = boundedString(item.id, `ui[${index}].id`, 128);
    if (ids.has(contributionId))
      throw invalidPackage(`UI contribution id repeats: ${contributionId}`);
    ids.add(contributionId);
    if (!EXTENSION_UI_SURFACES.includes(item.surface as ExtensionUiSurface)) {
      throw invalidPackage(`UI contribution surface is invalid: ${String(item.surface)}`);
    }
    if (
      (item.surface === 'app.slot' &&
        (typeof item.slot !== 'string' ||
          !EXTENSION_UI_OFFICIAL_SLOTS.includes(
            item.slot as (typeof EXTENSION_UI_OFFICIAL_SLOTS)[number],
          ))) ||
      (item.surface !== 'app.slot' && item.slot !== undefined)
    ) {
      throw invalidPackage('UI contribution slot is invalid');
    }
    if (!Number.isSafeInteger(item.priority) || Math.abs(item.priority as number) > 10_000) {
      throw invalidPackage('UI contribution priority is invalid');
    }
    return Object.freeze({
      id: contributionId,
      surface: item.surface as ExtensionUiSurface,
      ...(item.slot === undefined ? {} : { slot: item.slot as string }),
      priority: item.priority as number,
      document: packagePath(item.document, `ui[${index}].document`),
    });
  });
  const permissionRecord = record.permissions as Record<string, unknown> | null;
  const permissionKeys = ['network'];
  if (permissionRecord && Object.hasOwn(permissionRecord, 'hostState')) {
    permissionKeys.push('hostState');
  }
  if (permissionRecord && Object.hasOwn(permissionRecord, 'sessionAccess')) {
    permissionKeys.push('sessionAccess');
  }
  const permissions = exactRecord(record.permissions, permissionKeys);
  if (typeof permissions.network !== 'boolean')
    throw invalidPackage('UI network permission is invalid');
  if (permissions.hostState !== undefined && typeof permissions.hostState !== 'boolean')
    throw invalidPackage('UI Host state permission is invalid');
  if (permissions.sessionAccess !== undefined && typeof permissions.sessionAccess !== 'boolean')
    throw invalidPackage('UI Session access permission is invalid');
  if (permissions.sessionAccess === true && !ui.some(({ surface }) => surface === 'app.root')) {
    throw invalidPackage('Only a complete app.root UI may request Session access');
  }
  const host = record.host === undefined ? undefined : decodeHost(record.host);
  return Object.freeze({
    schemaVersion: 1,
    id,
    version,
    ui: Object.freeze(ui),
    ...(host ? { host } : {}),
    permissions: Object.freeze({
      network: permissions.network,
      hostState: permissions.hostState === true,
      sessionAccess: permissions.sessionAccess === true,
    }),
  });
}

function decodeHost(value: unknown): UiPackageManifestHost {
  const record = exactRecord(value, ['entry', 'methods']);
  const entry = packagePath(record.entry, 'host.entry');
  if (!entry.endsWith('.mjs')) throw invalidPackage('UI Host entry must be an .mjs file');
  if (!Array.isArray(record.methods) || record.methods.length === 0 || record.methods.length > 64) {
    throw invalidPackage('UI Host must declare between 1 and 64 methods');
  }
  const names = new Set<string>();
  const methods = record.methods.map((value, index) => {
    const method = exactRecord(value, ['name', 'handler']);
    const name = boundedString(method.name, `host.methods[${index}].name`, 128);
    const handler = boundedString(method.handler, `host.methods[${index}].handler`, 128);
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(name) ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(handler)
    ) {
      throw invalidPackage('UI Host method name or handler is invalid');
    }
    if (names.has(name)) throw invalidPackage(`UI Host method repeats: ${name}`);
    names.add(name);
    return Object.freeze({ name, handler });
  });
  return Object.freeze({ entry, methods: Object.freeze(methods) });
}

function validateHostFiles(manifest: UiPackageManifest, files: readonly PackageFile[]): void {
  if (!manifest.host) return;
  if (!files.some(({ path }) => path === manifest.host!.entry)) {
    throw invalidPackage(`UI Host entry does not exist: ${manifest.host.entry}`);
  }
}

async function readSourcePackage(sourcePath: string): Promise<readonly PackageFile[]> {
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) {
    throw invalidPackage('UI package sourcePath must be absolute');
  }
  let root: string;
  try {
    root = await realpath(resolve(sourcePath));
    if (!(await stat(root)).isDirectory())
      throw invalidPackage('UI package source is not a directory');
  } catch (error) {
    if (error instanceof UiPackageStoreError) throw error;
    throw invalidPackage('UI package source directory is unavailable', error);
  }
  const paths: string[] = [];
  await collectFiles(root, '', paths);
  if (paths.length === 0 || paths.length > MAX_FILES)
    throw invalidPackage('UI package file count is invalid');
  let total = 0;
  const files: PackageFile[] = [];
  for (const path of paths.sort(compareString)) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        join(root, ...path.split('/')),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
        throw invalidPackage(`UI package file is invalid: ${path}`);
      const content = await handle.readFile();
      total += content.byteLength;
      if (total > MAX_PACKAGE_BYTES) throw invalidPackage('UI package exceeds its size limit');
      files.push(Object.freeze({ path, content }));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return Object.freeze(files);
}

async function collectFiles(root: string, directory: string, paths: string[]): Promise<void> {
  const entries = await readdir(directory ? join(root, ...directory.split('/')) : root, {
    withFileTypes: true,
  });
  for (const entry of entries.sort(compareDirent)) {
    if (entry.name === '.git') continue;
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    packagePath(path, 'file path');
    if (entry.isSymbolicLink())
      throw invalidPackage(`UI package may not contain symlinks: ${path}`);
    if (entry.isDirectory()) await collectFiles(root, path, paths);
    else if (entry.isFile()) paths.push(path);
    else throw invalidPackage(`UI package contains unsupported entry: ${path}`);
    if (paths.length > MAX_FILES) throw invalidPackage('UI package contains too many files');
  }
}

async function writeStoredFile(root: string, file: PackageFile): Promise<void> {
  const target = join(root, ...file.path.split('/'));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(file.content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTree(root: string, files: readonly PackageFile[]): Promise<void> {
  const directories = new Set<string>([root]);
  for (const file of files) {
    let directory = dirname(join(root, ...file.path.split('/')));
    while (directory.startsWith(root)) {
      directories.add(directory);
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateHtml(content: Buffer, path: string): void {
  if (content.byteLength === 0 || content.byteLength > EXTENSION_UI_DOCUMENT_MAX_BYTES) {
    throw invalidPackage(`UI document is empty or too large: ${path}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw invalidPackage(`UI document is not valid UTF-8 text: ${path}`, error);
  }
  if (/\0/u.test(text)) {
    throw invalidPackage(`UI document is not valid UTF-8 text: ${path}`);
  }
}

function packageRevision(files: readonly PackageFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const path = Buffer.from(file.path, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(path.byteLength));
    hash.update(length).update(path);
    length.writeBigUInt64BE(BigInt(file.content.byteLength));
    hash.update(length).update(file.content);
  }
  return `sha256-${hash.digest('hex')}`;
}

/** Read compatibility for UI revisions sealed before Tool/UI shared one package hash. */
function legacyPackageRevision(files: readonly PackageFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path).update('\0').update(file.content).update('\0');
  return `sha256-${hash.digest('hex')}`;
}

function packagePath(value: unknown, label: string): string {
  const path = boundedString(value, label, 512);
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw invalidPackage(`UI package ${label} is invalid`);
  return path;
}

function requireId(value: unknown): string {
  const id = boundedString(value, 'id', 128);
  if (!isCanonicalExtensionId(id)) throw invalidPackage('UI package id is invalid');
  return id;
}

function requireRevision(value: string): void {
  if (!REVISION_PATTERN.test(value)) throw invalidPackage('UI package revision is invalid');
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\r\n\0]/u.test(value)
  )
    throw invalidPackage(`UI package ${label} is invalid`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidPackage('UI package record is invalid');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalidPackage('UI package record fields are invalid');
  }
  return record;
}

function parseJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw invalidPackage('UI package manifest is not valid JSON', error);
  }
}

function invalidPackage(message: string, cause?: unknown): UiPackageStoreError {
  return new UiPackageStoreError('invalid_package', message, { cause });
}

function persistenceFailure(message: string, cause?: unknown): UiPackageStoreError {
  return new UiPackageStoreError('persistence_failed', message, { cause });
}

function compareDirent(left: Dirent, right: Dirent): number {
  return compareString(left.name, right.name);
}
function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
