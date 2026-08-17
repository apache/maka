import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/extension-lifecycle-kernel';
import {
  validateExtensionEventDefinition,
  validateExtensionEventListener,
} from '@maka/runtime/extension-event-contributions';
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

export const EVENT_PACKAGE_MANIFEST_FILE = 'maka.event.json';
const STORE_DIRECTORY = 'event-packages-v1';
const MAX_MANIFEST_BYTES = 512 * 1024;
const REVISION_PATTERN = /^sha256-[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export interface EventPackageManifestEvent {
  readonly name: string;
  readonly description: string;
  readonly payloadSchema: Readonly<Record<string, unknown>>;
}

export interface EventPackageManifestListener {
  readonly id: string;
  readonly event: string;
  readonly handler: string;
  readonly priority: number;
  readonly timeoutMs: number;
}

export interface EventPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly events: readonly EventPackageManifestEvent[];
  readonly listeners: readonly EventPackageManifestListener[];
  readonly permissions: {
    readonly workspace: 'none' | 'read';
    readonly network: boolean;
  };
}

export interface InstalledEventPackage {
  readonly extensionId: string;
  readonly revision: string;
  readonly root: string;
  readonly entry: string;
  readonly manifest: EventPackageManifest;
}

export class EventPackageStoreError extends Error {
  readonly name = 'EventPackageStoreError';

  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class EventPackageStore {
  readonly root: string;

  constructor(controlDirectory: string) {
    this.root = join(controlDirectory, STORE_DIRECTORY);
  }

  async install(sourcePath: string): Promise<InstalledEventPackage> {
    let files: Awaited<ReturnType<typeof readSourcePackage>>;
    try {
      files = await readSourcePackage(sourcePath);
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : 'Unable to read Event package',
        error,
      );
    }
    const manifestFile = files.find(({ path }) => path === EVENT_PACKAGE_MANIFEST_FILE);
    if (!manifestFile)
      throw invalidPackage(`Event package is missing ${EVENT_PACKAGE_MANIFEST_FILE}`);
    if (manifestFile.content.byteLength > MAX_MANIFEST_BYTES) {
      throw invalidPackage('Event package manifest exceeds its size limit');
    }
    const manifest = decodeStoredManifest(manifestFile.content);
    if (!files.some(({ path }) => path === manifest.entry)) {
      throw invalidPackage(`Event package entry does not exist: ${manifest.entry}`);
    }
    const revision = packageRevision(files);
    const extensionRoot = join(this.root, manifest.id);
    const target = join(extensionRoot, revision);
    try {
      const installed = await this.load(manifest.id, revision);
      if (JSON.stringify(installed.manifest) === JSON.stringify(manifest)) return installed;
      throw new EventPackageStoreError(
        'already_installed',
        `Event package revision already exists with conflicting metadata: ${manifest.id}@${revision}`,
      );
    } catch (error) {
      if (!(error instanceof EventPackageStoreError) || error.code !== 'not_found') throw error;
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
      throw persistenceFailure(`Unable to install Event package ${manifest.id}@${revision}`, error);
    } finally {
      if (!committed) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<readonly InstalledEventPackage[]> {
    let extensions: Dirent[];
    try {
      extensions = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw persistenceFailure('Unable to list installed Event packages', error);
    }
    const installed: InstalledEventPackage[] = [];
    for (const extension of extensions.sort(compareDirent)) {
      if (!extension.isDirectory() || !isCanonicalExtensionId(extension.name)) continue;
      const extensionRoot = join(this.root, extension.name);
      const revisions = await readdir(extensionRoot, { withFileTypes: true }).catch((error) => {
        throw persistenceFailure(`Unable to list Event package ${extension.name}`, error);
      });
      for (const revision of revisions.sort(compareDirent)) {
        if (!revision.isDirectory() || !REVISION_PATTERN.test(revision.name)) continue;
        installed.push(await this.load(extension.name, revision.name));
      }
    }
    return Object.freeze(installed);
  }

  async load(extensionId: string, revision: string): Promise<InstalledEventPackage> {
    requireIdentity(extensionId, revision);
    const root = join(this.root, extensionId, revision);
    try {
      if (!(await stat(root)).isDirectory())
        throw invalidPackage('Installed Event package is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EventPackageStoreError(
          'not_found',
          `Event package revision is not installed: ${extensionId}@${revision}`,
        );
      }
      if (error instanceof EventPackageStoreError) throw error;
      throw persistenceFailure(`Unable to read Event package ${extensionId}@${revision}`, error);
    }
    let files: Awaited<ReturnType<typeof readSourcePackage>>;
    try {
      files = await readSourcePackage(root);
    } catch (error) {
      throw invalidPackage('Unable to read installed Event package', error);
    }
    const manifestFile = files.find(({ path }) => path === EVENT_PACKAGE_MANIFEST_FILE);
    if (!manifestFile)
      throw invalidPackage(`Installed Event package is missing ${EVENT_PACKAGE_MANIFEST_FILE}`);
    const manifest = decodeStoredManifest(manifestFile.content);
    if (manifest.id !== extensionId)
      throw invalidPackage(
        `Installed Event package identity does not match its path: ${extensionId}`,
      );
    if (packageRevision(files) !== revision)
      throw invalidPackage(
        `Installed Event package content hash does not match: ${extensionId}@${revision}`,
      );
    const entry = join(root, ...manifest.entry.split('/'));
    if (!(await stat(entry).catch(() => undefined))?.isFile()) {
      throw invalidPackage(`Event package entry is unavailable: ${manifest.entry}`);
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
      if ((await readdir(extensionRoot)).length === 0)
        await rm(extensionRoot, { recursive: true, force: false });
      await syncDirectory(this.root).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw persistenceFailure(
        `Unable to uninstall Event package ${extensionId}@${revision}`,
        error,
      );
    }
  }
}

export function decodeEventPackageManifest(value: unknown): EventPackageManifest {
  const record = exactRecord(value, [
    'schemaVersion',
    'id',
    'version',
    'entry',
    'events',
    'listeners',
    'permissions',
  ]);
  if (record.schemaVersion !== 1) throw invalidPackage('Event package schemaVersion must be 1');
  const id = boundedString(record.id, 'Event id', 128);
  if (!isCanonicalExtensionId(id)) throw invalidPackage('Event package id is invalid');
  const version = boundedString(record.version, 'Event version', 128);
  const entry = packagePath(record.entry, 'Event entry');
  if (!entry.endsWith('.mjs')) throw invalidPackage('Event package entry must be an .mjs file');
  if (!Array.isArray(record.events) || record.events.length > 64) {
    throw invalidPackage('Event package events must contain at most 64 definitions');
  }
  if (!Array.isArray(record.listeners) || record.listeners.length > 64) {
    throw invalidPackage('Event package listeners must contain at most 64 definitions');
  }
  if (record.events.length === 0 && record.listeners.length === 0) {
    throw invalidPackage('Event package must declare at least one Event or Listener');
  }
  const eventNames = new Set<string>();
  const events = record.events.map((value, index): EventPackageManifestEvent => {
    const event = exactRecord(value, ['name', 'description', 'payloadSchema']);
    const name = boundedString(event.name, `Event events[${index}].name`, 192);
    const description = boundedString(
      event.description,
      `Event events[${index}].description`,
      4096,
    );
    const payloadSchema = requireJsonSchema(event.payloadSchema, name);
    if (eventNames.has(name)) throw invalidPackage(`Event definition repeats: ${name}`);
    eventNames.add(name);
    const definition = Object.freeze({ name, description, payloadSchema });
    try {
      validateExtensionEventDefinition(id, definition);
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : `Event definition is invalid: ${name}`,
        error,
      );
    }
    return definition;
  });
  const listenerIds = new Set<string>();
  const listeners = record.listeners.map((value, index): EventPackageManifestListener => {
    const listener = optionalExactRecord(value, [
      'id',
      'event',
      'handler',
      'priority',
      'timeoutMs',
    ]);
    const listenerId = boundedString(listener.id, `Event listeners[${index}].id`, 128);
    const event = boundedString(listener.event, `Event listeners[${index}].event`, 192);
    const handler = boundedString(listener.handler, `Event listeners[${index}].handler`, 128);
    const priority = listener.priority === undefined ? 0 : listener.priority;
    const timeoutMs = listener.timeoutMs === undefined ? 3_000 : listener.timeoutMs;
    if (listenerIds.has(`${event}\0${listenerId}`))
      throw invalidPackage(`Event Listener repeats: ${event}:${listenerId}`);
    listenerIds.add(`${event}\0${listenerId}`);
    if (!ID_PATTERN.test(listenerId) || !ID_PATTERN.test(handler))
      throw invalidPackage(`Event Listener identity is invalid: ${listenerId}`);
    const contribution = {
      id: listenerId,
      event,
      handler,
      priority: priority as number,
      timeoutMs: timeoutMs as number,
      invoke: async () => undefined,
    };
    try {
      validateExtensionEventListener(contribution);
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : `Event Listener is invalid: ${listenerId}`,
        error,
      );
    }
    return Object.freeze({
      id: listenerId,
      event,
      handler,
      priority: priority as number,
      timeoutMs: timeoutMs as number,
    });
  });
  const permissions = exactRecord(record.permissions, ['workspace', 'network']);
  if (permissions.workspace !== 'none' && permissions.workspace !== 'read') {
    throw invalidPackage('Event package workspace permission must be none or read');
  }
  if (typeof permissions.network !== 'boolean')
    throw invalidPackage('Event package network permission is invalid');
  return Object.freeze({
    schemaVersion: 1,
    id,
    version,
    entry,
    events: Object.freeze(events.sort((left, right) => compareString(left.name, right.name))),
    listeners: Object.freeze(
      listeners.sort(
        (left, right) =>
          left.event.localeCompare(right.event) ||
          right.priority - left.priority ||
          compareString(left.id, right.id),
      ),
    ),
    permissions: Object.freeze({ workspace: permissions.workspace, network: permissions.network }),
  });
}

function requireJsonSchema(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPackage(`Event payloadSchema must be an object: ${name}`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw invalidPackage(`Event payloadSchema is not JSON: ${name}`, error);
  }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024)
    throw invalidPackage(`Event payloadSchema is too large: ${name}`);
  return Object.freeze(structuredClone(value as Record<string, unknown>));
}

function decodeStoredManifest(encoded: Buffer): EventPackageManifest {
  try {
    return decodeEventPackageManifest(parseJson(encoded));
  } catch (error) {
    if (error instanceof EventPackageStoreError) throw error;
    throw invalidPackage(
      error instanceof Error ? error.message : 'Event package manifest is invalid',
      error,
    );
  }
}

function freezeInstalled(
  root: string,
  revision: string,
  manifest: EventPackageManifest,
): InstalledEventPackage {
  return Object.freeze({
    extensionId: manifest.id,
    revision,
    root,
    entry: join(root, ...manifest.entry.split('/')),
    manifest,
  });
}

function requireIdentity(extensionId: string, revision: string): void {
  if (!isCanonicalExtensionId(extensionId)) throw invalidPackage('Event package id is invalid');
  if (!REVISION_PATTERN.test(revision)) throw invalidPackage('Event package revision is invalid');
}

function invalidPackage(message: string, cause?: unknown): EventPackageStoreError {
  return new EventPackageStoreError('invalid_package', message, { cause });
}

function persistenceFailure(message: string, cause?: unknown): EventPackageStoreError {
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  return new EventPackageStoreError('persistence_failed', `${message}${detail}`, { cause });
}
