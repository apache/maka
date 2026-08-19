import { constants, type Dirent } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import type { ToolCategory } from '@maka/core/permission';
import type { ToolRecoveryMode } from '@maka/core/runtime-event';
import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';

const MANIFEST_FILE = 'maka.extension.json';
const MAX_FILES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const CATEGORIES = new Set<ToolCategory>([
  'read',
  'web_read',
  'file_write',
  'fs_destructive',
  'shell_safe',
  'shell_unsafe',
  'git_destructive',
  'network_send',
  'subagent',
  'computer_use',
  'client_capability',
]);
const RECOVERY_MODES = new Set<ToolRecoveryMode>([
  'replay_safe',
  'idempotent',
  'reconcile',
  'reattach',
  'outcome_unknown',
  'never_auto_retry',
]);

export type ToolPackageWorkspacePermission = 'none' | 'read' | 'write';

export interface ToolPackageManifestTool {
  readonly name: string;
  readonly description: string;
  readonly handler: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly displayName?: string;
  readonly category?: ToolCategory;
  readonly recoveryMode?: ToolRecoveryMode;
  readonly visualization?: { readonly stateKey: string };
}

export interface ToolPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly entry: string;
  readonly tools: readonly ToolPackageManifestTool[];
  readonly permissions: {
    readonly workspace: ToolPackageWorkspacePermission;
    readonly network: boolean;
  };
}

export interface InstalledToolPackage {
  readonly extensionId: string;
  readonly root: string;
  readonly entry: string;
  readonly manifest: ToolPackageManifest;
}

export class PluginPackageManifestError extends Error {
  readonly name = 'PluginPackageManifestError';

  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface PackageFile {
  readonly path: string;
  readonly content: Buffer;
}

/** Decode the runtime contribution view of one Extension package. */
export function decodeToolPackageManifest(value: unknown): ToolPackageManifest {
  const root = optionalExactRecord(value, [
    'schemaVersion',
    'id',
    'displayName',
    'description',
    'dependencies',
    'configuration',
    'runtime',
    'ui',
  ]);
  const runtime = exactRecord(root.runtime, [
    'entry',
    'tools',
    'events',
    'listeners',
    'services',
    'timers',
    'permissions',
  ]);
  const record = {
    schemaVersion: root.schemaVersion,
    id: root.id,
    entry: runtime.entry,
    tools: runtime.tools,
    permissions: runtime.permissions,
  };
  if (record.schemaVersion !== 1) throw invalidPackage('Tool package schemaVersion must be 1');
  const id = requireId(record.id);
  const entry = packagePath(record.entry, 'entry');
  if (!entry.endsWith('.mjs')) throw invalidPackage('Tool package entry must be an .mjs file');
  if (!Array.isArray(record.tools) || record.tools.length === 0 || record.tools.length > 64) {
    throw invalidPackage('Tool package must declare between 1 and 64 Tools');
  }
  const names = new Set<string>();
  const tools = record.tools.map((value, index): ToolPackageManifestTool => {
    const tool = optionalExactRecord(value, [
      'name',
      'description',
      'handler',
      'inputSchema',
      'displayName',
      'category',
      'recoveryMode',
      'visualization',
    ]);
    const name = boundedString(tool.name, `tools[${index}].name`, 128);
    if (!TOOL_NAME_PATTERN.test(name)) throw invalidPackage(`Tool name is invalid: ${name}`);
    const key = name.toLowerCase();
    if (names.has(key)) throw invalidPackage(`Tool package repeats Tool name: ${name}`);
    names.add(key);
    const handler = boundedString(tool.handler, `tools[${index}].handler`, 128);
    if (!TOOL_NAME_PATTERN.test(handler))
      throw invalidPackage(`Tool handler is invalid: ${handler}`);
    const inputSchema = jsonSchema(tool.inputSchema, `tools[${index}].inputSchema`);
    const displayName = optionalBoundedString(tool.displayName, `tools[${index}].displayName`, 128);
    const category = optionalEnum(tool.category, CATEGORIES, `tools[${index}].category`);
    const recoveryMode = optionalEnum(
      tool.recoveryMode,
      RECOVERY_MODES,
      `tools[${index}].recoveryMode`,
    );
    const visualization =
      tool.visualization === undefined ? undefined : exactRecord(tool.visualization, ['stateKey']);
    const stateKey = visualization
      ? boundedString(visualization.stateKey, `tools[${index}].visualization.stateKey`, 128)
      : undefined;
    if (stateKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(stateKey)) {
      throw invalidPackage(`Tool visualization state key is invalid: ${stateKey}`);
    }
    return Object.freeze({
      name,
      description: boundedString(tool.description, `tools[${index}].description`, 4096),
      handler,
      inputSchema,
      ...(displayName ? { displayName } : {}),
      ...(category ? { category } : {}),
      ...(recoveryMode ? { recoveryMode } : {}),
      ...(stateKey ? { visualization: Object.freeze({ stateKey }) } : {}),
    });
  });
  const permissions = exactRecord(record.permissions, ['workspace', 'network']);
  const workspace = permissions.workspace;
  if (workspace !== 'none' && workspace !== 'read' && workspace !== 'write') {
    throw invalidPackage('Tool package workspace permission is invalid');
  }
  if (typeof permissions.network !== 'boolean') {
    throw invalidPackage('Tool package network permission is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    id,
    entry,
    tools: Object.freeze(tools),
    permissions: Object.freeze({ workspace, network: permissions.network }),
  });
}

export async function readSourcePackage(sourcePath: string): Promise<readonly PackageFile[]> {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || !isAbsolute(sourcePath)) {
    throw invalidPackage('Tool package sourcePath must be absolute');
  }
  let root: string;
  try {
    root = await realpath(resolve(sourcePath));
    if (!(await stat(root)).isDirectory())
      throw invalidPackage('Tool package source is not a directory');
  } catch (error) {
    if (error instanceof PluginPackageManifestError) throw error;
    throw invalidPackage('Tool package source directory is unavailable', error);
  }
  const paths: string[] = [];
  await collectFiles(root, '', paths);
  if (paths.length === 0 || paths.length > MAX_FILES) {
    throw invalidPackage(`Tool package must contain between 1 and ${MAX_FILES} files`);
  }
  const files: PackageFile[] = [];
  let total = 0;
  for (const path of paths.sort(compareString)) {
    const absolute = join(root, ...path.split('/'));
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw invalidPackage(`Tool package contains a non-file: ${path}`);
      if (metadata.size > MAX_FILE_BYTES)
        throw invalidPackage(`Tool package file is too large: ${path}`);
      const content = await handle.readFile();
      total += content.byteLength;
      if (total > MAX_PACKAGE_BYTES) throw invalidPackage('Tool package exceeds its size limit');
      files.push(Object.freeze({ path, content }));
    } catch (error) {
      if (error instanceof PluginPackageManifestError) throw error;
      throw invalidPackage(`Unable to read Tool package file: ${path}`, error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return Object.freeze(files);
}

async function collectFiles(root: string, directory: string, paths: string[]): Promise<void> {
  const absolute = directory ? join(root, ...directory.split('/')) : root;
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort(compareDirent)) {
    if (entry.name === '.git') continue;
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    packagePath(path, 'file path');
    if (entry.isSymbolicLink())
      throw invalidPackage(`Tool package may not contain symlinks: ${path}`);
    if (entry.isDirectory()) await collectFiles(root, path, paths);
    else if (entry.isFile()) paths.push(path);
    else throw invalidPackage(`Tool package contains an unsupported entry: ${path}`);
    if (paths.length > MAX_FILES) throw invalidPackage('Tool package contains too many files');
  }
}

export async function writeStoredFile(root: string, file: PackageFile): Promise<void> {
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

export async function syncTree(root: string, files: readonly PackageFile[]): Promise<void> {
  const directories = new Set<string>([root]);
  for (const file of files) {
    let directory = dirname(join(root, ...file.path.split('/')));
    while (directory.startsWith(root)) {
      directories.add(directory);
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await syncDirectory(directory);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function packagePath(value: unknown, label: string): string {
  const path = boundedString(value, label, 512);
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalidPackage(`Tool package ${label} is invalid`);
  }
  return path;
}

function requireId(value: unknown): string {
  const id = boundedString(value, 'id', 128);
  if (!validId(id)) throw invalidPackage('Tool package id is invalid');
  return id;
}

function validId(value: string): boolean {
  return isCanonicalExtensionId(value);
}

export function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\r\n\0]/u.test(value)
  ) {
    throw invalidPackage(`Tool package ${label} is invalid`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maxBytes);
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw invalidPackage(`Tool package ${label} is invalid`);
  }
  return value as T;
}

function jsonSchema(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPackage(`Tool package ${label} must be a JSON Schema object`);
  }
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) {
      throw invalidPackage(`Tool package ${label} exceeds its size limit`);
    }
    return Object.freeze(structuredClone(value as Record<string, unknown>));
  } catch (error) {
    if (error instanceof PluginPackageManifestError) throw error;
    throw invalidPackage(`Tool package ${label} is not JSON-serializable`, error);
  }
}

export function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = optionalExactRecord(value, keys);
  if (keys.some((key) => !Object.hasOwn(record, key))) {
    throw invalidPackage('Tool package record fields are invalid');
  }
  return record;
}

export function optionalExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPackage('Tool package record is invalid');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw invalidPackage('Tool package record contains unknown fields');
  }
  return record;
}

export function parseJson(encoded: Buffer): unknown {
  try {
    return JSON.parse(encoded.toString('utf8'));
  } catch (error) {
    throw invalidPackage('Tool package manifest is not valid JSON', error);
  }
}

function sameManifest(left: ToolPackageManifest, right: ToolPackageManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalidPackage(message: string, cause?: unknown): PluginPackageManifestError {
  return new PluginPackageManifestError('invalid_package', message, { cause });
}

function persistenceFailure(message: string, cause?: unknown): PluginPackageManifestError {
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  return new PluginPackageManifestError('persistence_failed', `${message}${detail}`, { cause });
}

export function compareDirent(left: Dirent, right: Dirent): number {
  return compareString(left.name, right.name);
}

export function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
