/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { withProcessLifetimeFileUpdateLock } from '@maka/storage/process-lifetime-file-update-lock';
import { z } from 'zod';
import {
  isProductReleaseVersion,
  isSha512PackageIntegrity,
  type RuntimeHostDeploymentIdentity,
} from './update-package-evidence.js';

const RECORD_SCHEMA_VERSION = 1 as const;
const RECORD_MAX_BYTES = 64 * 1024;
const AUTHORITY_LOCK_TIMEOUT_MS = 60_000;
const ROOT_ID = /^[a-f0-9]{64}$/u;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const boundedText = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        Buffer.byteLength(value, 'utf8') <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value),
    );

const OWNER_SCHEMA = z
  .object({
    kind: z.enum(['desktop', 'cli', 'managed_service', 'development']),
    installationId: boundedText(512),
  })
  .strict();

const DEPLOYMENT_IDENTITY_SCHEMA = z
  .object({
    kind: z.literal('npm_registry'),
    version: z.string().refine(isProductReleaseVersion),
    integrity: z.string().refine(isSha512PackageIntegrity),
  })
  .strict();

const OWNED_STATE_SCHEMA = z
  .object({
    kind: z.literal('owned'),
    owner: OWNER_SCHEMA,
    selected: DEPLOYMENT_IDENTITY_SCHEMA,
    previous: DEPLOYMENT_IDENTITY_SCHEMA.optional(),
  })
  .strict();

const HANDOFF_STATE_SCHEMA = z
  .object({
    kind: z.literal('handoff'),
    transactionId: boundedText(512),
    from: OWNER_SCHEMA,
    to: OWNER_SCHEMA,
    selected: DEPLOYMENT_IDENTITY_SCHEMA,
    previous: DEPLOYMENT_IDENTITY_SCHEMA.optional(),
    target: DEPLOYMENT_IDENTITY_SCHEMA,
  })
  .strict();

const RECORD_SCHEMA = z
  .object({
    schemaVersion: z.literal(RECORD_SCHEMA_VERSION),
    rootId: z.string().regex(ROOT_ID),
    revision: z.string().regex(REVISION),
    state: z.discriminatedUnion('kind', [OWNED_STATE_SCHEMA, HANDOFF_STATE_SCHEMA]),
  })
  .strict();

const TRANSITION_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('claim'),
      owner: OWNER_SCHEMA,
      selected: DEPLOYMENT_IDENTITY_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal('begin_handoff'),
      expectedRevision: z.string().regex(REVISION),
      transactionId: boundedText(512),
      from: OWNER_SCHEMA,
      to: OWNER_SCHEMA,
      target: DEPLOYMENT_IDENTITY_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal('commit_handoff'),
      expectedRevision: z.string().regex(REVISION),
      transactionId: boundedText(512),
      to: OWNER_SCHEMA,
      target: DEPLOYMENT_IDENTITY_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal('rollback_handoff'),
      expectedRevision: z.string().regex(REVISION),
      transactionId: boundedText(512),
      from: OWNER_SCHEMA,
      selected: DEPLOYMENT_IDENTITY_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal('release'),
      expectedRevision: z.string().regex(REVISION),
      owner: OWNER_SCHEMA,
    })
    .strict(),
]);

export interface RuntimeHostInstallationOwner {
  readonly kind: 'desktop' | 'cli' | 'managed_service' | 'development';
  readonly installationId: string;
}

export type LocalHostDeploymentState =
  | {
      readonly kind: 'owned';
      readonly owner: RuntimeHostInstallationOwner;
      readonly selected: RuntimeHostDeploymentIdentity;
      readonly previous?: RuntimeHostDeploymentIdentity;
    }
  | {
      readonly kind: 'handoff';
      readonly transactionId: string;
      readonly from: RuntimeHostInstallationOwner;
      readonly to: RuntimeHostInstallationOwner;
      readonly selected: RuntimeHostDeploymentIdentity;
      readonly previous?: RuntimeHostDeploymentIdentity;
      readonly target: RuntimeHostDeploymentIdentity;
    };

export interface LocalHostDeploymentRecord {
  readonly schemaVersion: typeof RECORD_SCHEMA_VERSION;
  readonly rootId: string;
  /** Opaque compare-and-swap token. It is intentionally not a HostEpoch or PID. */
  readonly revision: string;
  readonly state: LocalHostDeploymentState;
}

export type LocalHostDeploymentTransition =
  | {
      readonly kind: 'claim';
      readonly owner: RuntimeHostInstallationOwner;
      readonly selected: RuntimeHostDeploymentIdentity;
    }
  | {
      readonly kind: 'begin_handoff';
      readonly expectedRevision: string;
      readonly transactionId: string;
      readonly from: RuntimeHostInstallationOwner;
      readonly to: RuntimeHostInstallationOwner;
      readonly target: RuntimeHostDeploymentIdentity;
    }
  | {
      readonly kind: 'commit_handoff';
      readonly expectedRevision: string;
      readonly transactionId: string;
      readonly to: RuntimeHostInstallationOwner;
      readonly target: RuntimeHostDeploymentIdentity;
    }
  | {
      readonly kind: 'rollback_handoff';
      readonly expectedRevision: string;
      readonly transactionId: string;
      readonly from: RuntimeHostInstallationOwner;
      readonly selected: RuntimeHostDeploymentIdentity;
    }
  | {
      readonly kind: 'release';
      readonly expectedRevision: string;
      readonly owner: RuntimeHostInstallationOwner;
    };

export type LocalHostDeploymentTransitionRejection =
  | 'owner_exists'
  | 'not_owned'
  | 'owner_changed'
  | 'revision_changed'
  | 'handoff_in_progress'
  | 'handoff_changed';

export type LocalHostDeploymentTransitionResult =
  | {
      readonly kind: 'applied' | 'unchanged';
      readonly record: LocalHostDeploymentRecord | undefined;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: LocalHostDeploymentTransitionRejection;
      readonly record: LocalHostDeploymentRecord | undefined;
    };

export interface LocalHostDeploymentAuthorityOptions {
  /** Test-only or embedding override. Production callers should use the account-local default. */
  readonly authorityRoot?: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  /** Test-only fault injection. */
  readonly beforeDirectorySync?: (
    path: string,
    purpose: LocalHostDeploymentDirectorySyncPurpose,
  ) => void | Promise<void>;
}

export type LocalHostDeploymentDirectorySyncPurpose =
  | 'directory_entry'
  | 'record_publish'
  | 'record_remove'
  | 'unchanged_confirmation'
  | 'workspace_cleanup';

export interface LocalHostDeploymentAuthority {
  read(): Promise<LocalHostDeploymentRecord | undefined>;
  apply(transition: LocalHostDeploymentTransition): Promise<LocalHostDeploymentTransitionResult>;
}

export class LocalHostDeploymentAuthorityError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'invalid_record' | 'authority_io_failed' | 'commit_unknown',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalHostDeploymentAuthorityError';
  }
}

export function resolveLocalHostDeploymentAuthorityRoot(
  options: LocalHostDeploymentAuthorityOptions = {},
): string {
  return resolveLocalHostDeploymentAuthorityLocation(options).authorityRoot;
}

function resolveLocalHostDeploymentAuthorityLocation(
  options: LocalHostDeploymentAuthorityOptions,
): {
  readonly authorityRoot: string;
  readonly durabilityBoundary: string | undefined;
} {
  if (options.authorityRoot !== undefined) {
    if (!isAbsolute(options.authorityRoot)) {
      throw new LocalHostDeploymentAuthorityError(
        'invalid_input',
        'The local Runtime Host deployment authority root must be absolute',
      );
    }
    return {
      authorityRoot: resolve(options.authorityRoot),
      durabilityBoundary: undefined,
    };
  }
  const accountHome = options.homeDir ?? userInfo().homedir;
  const platform = options.platform ?? process.platform;
  const accountPath = platform === 'win32' ? win32 : posix;
  if (!accountPath.isAbsolute(accountHome)) {
    throw new LocalHostDeploymentAuthorityError(
      'invalid_input',
      'The OS account home must be absolute',
    );
  }
  const durabilityBoundary = accountPath.normalize(accountHome);
  const pathSegments =
    platform === 'darwin'
      ? ['Library', 'Application Support', 'Maka', 'runtime-host-ownership']
      : platform === 'win32'
        ? ['AppData', 'Local', 'Maka', 'runtime-host-ownership']
        : ['.local', 'share', 'Maka', 'runtime-host-ownership'];
  return {
    authorityRoot: accountPath.join(durabilityBoundary, ...pathSegments),
    durabilityBoundary,
  };
}

export async function readLocalHostDeploymentRecord(
  rootId: string,
  options: LocalHostDeploymentAuthorityOptions = {},
): Promise<LocalHostDeploymentRecord | undefined> {
  assertRootId(rootId);
  const path = recordPath(rootId, options);
  return readRecord(path, rootId);
}

export async function applyLocalHostDeploymentTransition(
  rootId: string,
  transition: LocalHostDeploymentTransition,
  options: LocalHostDeploymentAuthorityOptions = {},
): Promise<LocalHostDeploymentTransitionResult> {
  const canonicalTransition = parseTransition(transition);
  return withLocalHostDeploymentAuthority(
    rootId,
    (authority) => authority.apply(canonicalTransition),
    options,
  );
}

/**
 * Holds the one deployment-authority lock while a caller coordinates a complete
 * owner transition. The callback receives the only mutation capability and an
 * inheritable lease descriptor, so an exact child finalizer can keep the same
 * authority serialized if its parent exits.
 */
export async function withLocalHostDeploymentAuthority<T>(
  rootId: string,
  operation: (authority: LocalHostDeploymentAuthority, inheritableLeaseFd: number) => Promise<T>,
  options: LocalHostDeploymentAuthorityOptions = {},
): Promise<T> {
  assertRootId(rootId);
  const { authorityRoot, durabilityBoundary } =
    resolveLocalHostDeploymentAuthorityLocation(options);
  await preparePrivateDirectory(authorityRoot, durabilityBoundary, options);
  const path = join(authorityRoot, `${rootId}.json`);
  try {
    return await withProcessLifetimeFileUpdateLock(
      path,
      async (inheritableLeaseFd) => {
        await removeAbandonedRecordWorkspaces(authorityRoot, rootId, options);
        const authority: LocalHostDeploymentAuthority = {
          read: () => readRecord(path, rootId),
          apply: async (nextTransition) => {
            const canonicalTransition = parseTransition(nextTransition);
            const current = await readRecord(path, rootId);
            const result = reduceTransition(rootId, current, canonicalTransition);
            if (result.kind === 'unchanged') {
              await confirmUnchangedDurability(authorityRoot, options);
              return result;
            }
            if (result.kind === 'rejected') return result;
            if (result.record) await writeRecord(path, result.record, options);
            else await removeRecord(path, options);
            return result;
          },
        };
        return operation(authority, inheritableLeaseFd);
      },
      AUTHORITY_LOCK_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof LocalHostDeploymentAuthorityError) throw error;
    throw new LocalHostDeploymentAuthorityError(
      'authority_io_failed',
      'Unable to update local Runtime Host deployment ownership',
      { cause: error },
    );
  }
}

function reduceTransition(
  rootId: string,
  current: LocalHostDeploymentRecord | undefined,
  transition: LocalHostDeploymentTransition,
): LocalHostDeploymentTransitionResult {
  switch (transition.kind) {
    case 'claim': {
      if (!current) return applied(record(rootId, owned(transition.owner, transition.selected)));
      if (
        current.state.kind === 'owned' &&
        sameOwner(current.state.owner, transition.owner) &&
        sameDeployment(current.state.selected, transition.selected)
      ) {
        return unchanged(current);
      }
      return rejected(
        current.state.kind === 'handoff' ? 'handoff_in_progress' : 'owner_exists',
        current,
      );
    }
    case 'begin_handoff': {
      if (!current) return rejected('not_owned', current);
      if (current.state.kind === 'handoff') {
        return sameHandoff(current.state, transition)
          ? unchanged(current)
          : rejected('handoff_changed', current);
      }
      if (!sameOwner(current.state.owner, transition.from))
        return rejected('owner_changed', current);
      if (current.revision !== transition.expectedRevision)
        return rejected('revision_changed', current);
      return applied(
        record(rootId, {
          kind: 'handoff',
          transactionId: transition.transactionId,
          from: transition.from,
          to: transition.to,
          selected: current.state.selected,
          ...(current.state.previous ? { previous: current.state.previous } : {}),
          target: transition.target,
        }),
      );
    }
    case 'commit_handoff': {
      if (!current) return rejected('not_owned', current);
      if (current.state.kind === 'owned') {
        return sameOwner(current.state.owner, transition.to) &&
          sameDeployment(current.state.selected, transition.target)
          ? unchanged(current)
          : rejected('handoff_changed', current);
      }
      if (!matchesHandoffTarget(current.state, transition))
        return rejected('handoff_changed', current);
      if (current.revision !== transition.expectedRevision)
        return rejected('revision_changed', current);
      return applied(
        record(rootId, owned(transition.to, transition.target, current.state.selected)),
      );
    }
    case 'rollback_handoff': {
      if (!current) return rejected('not_owned', current);
      if (current.state.kind === 'owned') {
        return sameOwner(current.state.owner, transition.from) &&
          sameDeployment(current.state.selected, transition.selected)
          ? unchanged(current)
          : rejected('handoff_changed', current);
      }
      if (
        current.state.transactionId !== transition.transactionId ||
        !sameOwner(current.state.from, transition.from) ||
        !sameDeployment(current.state.selected, transition.selected)
      ) {
        return rejected('handoff_changed', current);
      }
      if (current.revision !== transition.expectedRevision)
        return rejected('revision_changed', current);
      return applied(
        record(rootId, owned(current.state.from, current.state.selected, current.state.previous)),
      );
    }
    case 'release': {
      if (!current) return unchanged(undefined);
      if (current.state.kind === 'handoff') return rejected('handoff_in_progress', current);
      if (!sameOwner(current.state.owner, transition.owner))
        return rejected('owner_changed', current);
      if (current.revision !== transition.expectedRevision)
        return rejected('revision_changed', current);
      return applied(undefined);
    }
  }
}

function record(rootId: string, state: LocalHostDeploymentState): LocalHostDeploymentRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    rootId,
    revision: randomUUID(),
    state,
  };
}

function owned(
  owner: RuntimeHostInstallationOwner,
  selected: RuntimeHostDeploymentIdentity,
  previous?: RuntimeHostDeploymentIdentity,
): Extract<LocalHostDeploymentState, { kind: 'owned' }> {
  return {
    kind: 'owned',
    owner,
    selected,
    ...(previous ? { previous } : {}),
  };
}

function sameHandoff(
  current: Extract<LocalHostDeploymentState, { kind: 'handoff' }>,
  transition: Extract<LocalHostDeploymentTransition, { kind: 'begin_handoff' }>,
): boolean {
  return (
    current.transactionId === transition.transactionId &&
    sameOwner(current.from, transition.from) &&
    sameOwner(current.to, transition.to) &&
    sameDeployment(current.target, transition.target)
  );
}

function matchesHandoffTarget(
  current: Extract<LocalHostDeploymentState, { kind: 'handoff' }>,
  transition: Extract<LocalHostDeploymentTransition, { kind: 'commit_handoff' }>,
): boolean {
  return (
    current.transactionId === transition.transactionId &&
    sameOwner(current.to, transition.to) &&
    sameDeployment(current.target, transition.target)
  );
}

function sameOwner(
  left: RuntimeHostInstallationOwner,
  right: RuntimeHostInstallationOwner,
): boolean {
  return left.kind === right.kind && left.installationId === right.installationId;
}

function sameDeployment(
  left: RuntimeHostDeploymentIdentity,
  right: RuntimeHostDeploymentIdentity,
): boolean {
  return (
    left.kind === right.kind && left.version === right.version && left.integrity === right.integrity
  );
}

function applied(
  record: LocalHostDeploymentRecord | undefined,
): LocalHostDeploymentTransitionResult {
  return { kind: 'applied', record };
}

function unchanged(
  record: LocalHostDeploymentRecord | undefined,
): LocalHostDeploymentTransitionResult {
  return { kind: 'unchanged', record };
}

function rejected(
  reason: LocalHostDeploymentTransitionRejection,
  record: LocalHostDeploymentRecord | undefined,
): LocalHostDeploymentTransitionResult {
  return { kind: 'rejected', reason, record };
}

function assertRootId(rootId: string): void {
  if (!ROOT_ID.test(rootId)) {
    throw new LocalHostDeploymentAuthorityError(
      'invalid_input',
      'The local Runtime Host deployment rootId is invalid',
    );
  }
}

function parseTransition(transition: LocalHostDeploymentTransition): LocalHostDeploymentTransition {
  try {
    return TRANSITION_SCHEMA.parse(transition) as LocalHostDeploymentTransition;
  } catch (error) {
    if (error instanceof LocalHostDeploymentAuthorityError) throw error;
    throw new LocalHostDeploymentAuthorityError(
      'invalid_input',
      'The local Runtime Host deployment transition is invalid',
      { cause: error },
    );
  }
}

function recordPath(rootId: string, options: LocalHostDeploymentAuthorityOptions): string {
  return join(resolveLocalHostDeploymentAuthorityRoot(options), `${rootId}.json`);
}

async function readRecord(
  path: string,
  expectedRootId: string,
): Promise<LocalHostDeploymentRecord | undefined> {
  let pathMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    pathMetadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw authorityIo('Unable to inspect local Runtime Host deployment ownership', error);
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new LocalHostDeploymentAuthorityError(
      'invalid_record',
      'The local Runtime Host deployment owner record is invalid',
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw authorityIo('Unable to open local Runtime Host deployment ownership', error);
  }
  let document: Uint8Array;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > RECORD_MAX_BYTES) {
      throw new LocalHostDeploymentAuthorityError(
        'invalid_record',
        'The local Runtime Host deployment owner record is invalid',
      );
    }
    document = await readBoundedRecord(handle);
  } catch (error) {
    if (error instanceof LocalHostDeploymentAuthorityError) throw error;
    throw authorityIo('Unable to read local Runtime Host deployment ownership', error);
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(document);
    const parsed = RECORD_SCHEMA.parse(JSON.parse(decoded));
    if (parsed.rootId !== expectedRootId) {
      throw new LocalHostDeploymentAuthorityError(
        'invalid_record',
        'The local Runtime Host deployment owner record belongs to a different State Root',
      );
    }
    return parsed as LocalHostDeploymentRecord;
  } catch (error) {
    if (error instanceof LocalHostDeploymentAuthorityError) throw error;
    throw new LocalHostDeploymentAuthorityError(
      'invalid_record',
      'The local Runtime Host deployment owner record is invalid',
      { cause: error },
    );
  }
}

async function readBoundedRecord(handle: Awaited<ReturnType<typeof open>>): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(RECORD_MAX_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > RECORD_MAX_BYTES) {
    throw new LocalHostDeploymentAuthorityError(
      'invalid_record',
      'The local Runtime Host deployment owner record is invalid',
    );
  }
  return bytes.subarray(0, offset);
}

async function writeRecord(
  path: string,
  value: LocalHostDeploymentRecord,
  options: LocalHostDeploymentAuthorityOptions,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const document = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(document, 'utf8') > RECORD_MAX_BYTES) {
    throw new LocalHostDeploymentAuthorityError(
      'invalid_input',
      'The local Runtime Host deployment owner record is too large',
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(document, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    published = true;
    await syncDirectory(dirname(path), 'record_publish', options);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (published) {
      throw new LocalHostDeploymentAuthorityError(
        'commit_unknown',
        'Local Runtime Host deployment ownership may have been persisted; re-read it before retrying',
        { cause: error },
      );
    }
    throw authorityIo('Unable to persist local Runtime Host deployment ownership', error);
  }
}

async function removeRecord(
  path: string,
  options: LocalHostDeploymentAuthorityOptions,
): Promise<void> {
  let removed = false;
  try {
    await unlink(path);
    removed = true;
    await syncDirectory(dirname(path), 'record_remove', options);
  } catch (error) {
    if (removed) {
      throw new LocalHostDeploymentAuthorityError(
        'commit_unknown',
        'Local Runtime Host deployment ownership may have been released; re-read it before retrying',
        { cause: error },
      );
    }
    if (isNodeError(error, 'ENOENT')) return;
    throw authorityIo('Unable to release local Runtime Host deployment ownership', error);
  }
}

async function preparePrivateDirectory(
  path: string,
  durabilityBoundary: string | undefined,
  options: LocalHostDeploymentAuthorityOptions,
): Promise<void> {
  try {
    const missing: string[] = [];
    let candidate = path;
    while (!(await pathExists(candidate))) {
      missing.push(candidate);
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    const boundaryMetadata = await lstat(candidate);
    if (!boundaryMetadata.isDirectory() || boundaryMetadata.isSymbolicLink()) {
      throw new Error('Authority path contains a non-directory entry');
    }
    if (candidate !== durabilityBoundary) {
      await confirmDirectoryEntry(dirname(candidate), options);
    }
    for (const directory of missing.reverse()) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('Authority path contains a non-directory entry');
      }
      await confirmDirectoryEntry(dirname(directory), options);
    }
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Authority path is not a private directory');
    }
    if (process.platform !== 'win32') await chmod(path, 0o700);
  } catch (error) {
    throw authorityIo('Unable to prepare local Runtime Host deployment authority', error);
  }
}

async function removeAbandonedRecordWorkspaces(
  authorityRoot: string,
  rootId: string,
  options: LocalHostDeploymentAuthorityOptions,
): Promise<void> {
  const temporaryRevision = new RegExp(
    `^${rootId}\\.json\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`,
    'u',
  );
  let removed = false;
  for (const entry of await readdir(authorityRoot, { withFileTypes: true })) {
    if (!temporaryRevision.test(entry.name)) continue;
    await unlink(join(authorityRoot, entry.name));
    removed = true;
  }
  if (removed) await syncDirectory(authorityRoot, 'workspace_cleanup', options);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function confirmDirectoryEntry(
  path: string,
  options: LocalHostDeploymentAuthorityOptions,
): Promise<void> {
  try {
    await syncDirectory(path, 'directory_entry', options);
  } catch (error) {
    throw new LocalHostDeploymentAuthorityError(
      'commit_unknown',
      'The local Runtime Host deployment authority directory may not be durable; retry the operation',
      { cause: error },
    );
  }
}

async function confirmUnchangedDurability(
  authorityRoot: string,
  options: LocalHostDeploymentAuthorityOptions,
): Promise<void> {
  try {
    await syncDirectory(authorityRoot, 'unchanged_confirmation', options);
  } catch (error) {
    throw new LocalHostDeploymentAuthorityError(
      'commit_unknown',
      'Local Runtime Host deployment ownership is visible but its durability is not confirmed; retry the exact transition',
      { cause: error },
    );
  }
}

async function syncDirectory(
  path: string,
  purpose: LocalHostDeploymentDirectorySyncPurpose,
  options: LocalHostDeploymentAuthorityOptions,
): Promise<void> {
  if (process.platform === 'win32') return;
  await options.beforeDirectorySync?.(path, purpose);
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function authorityIo(message: string, cause: unknown): LocalHostDeploymentAuthorityError {
  return cause instanceof LocalHostDeploymentAuthorityError
    ? cause
    : new LocalHostDeploymentAuthorityError('authority_io_failed', message, {
        cause,
      });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
