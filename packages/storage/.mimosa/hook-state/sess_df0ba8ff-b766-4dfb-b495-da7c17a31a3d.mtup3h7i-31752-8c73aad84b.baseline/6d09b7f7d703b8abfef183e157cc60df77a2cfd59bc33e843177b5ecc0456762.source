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

import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory } from './stable-storage.js';
import {
  bundleSnapshot,
  bundleTarget,
  invalidMemoryDocument,
  isRevision,
  memoryBundleIoFailed,
  memoryBundleRecoveryConflict,
  missingDocument,
  MEMORY_DOCUMENT_MAX_BYTES,
  MemoryBundleBackupRevisionConflictError,
  MemoryBundleBackupNotFoundError,
  MemoryBundleRevisionConflictError,
  MemoryBundleStoreError,
  revision,
  snapshotForBytes,
  type CommitMemoryBundleInput,
  type MemoryBackupKind,
  type MemoryBackupSnapshot,
  type MemoryBundleMutationResult,
  type MemoryBundleSnapshot,
  type MemoryBundleTarget,
  type MemoryDocumentName,
  type MemoryRevision,
  type MemoryDocumentSnapshot,
  type RestoreMemoryBackupInput,
  validateDocumentBytes,
} from './memory-bundle-model.js';

const MEMORY_DIRECTORY = 'memory';
const MEMORY_FILE = 'MEMORY.md';
const PENDING_FILE = 'PENDING.md';
const BACKUP_FILES = {
  save: 'MEMORY.md.bak',
  reset: 'MEMORY.md.reset.bak',
  restore: 'MEMORY.md.restore.bak',
} as const;
const RESTORE_HISTORY_LIMIT = 5;
const TRANSACTION_DIRECTORY = '.memory-bundle-transaction';
const DECISION_FILE = 'decision.json';
const BACKUP_TEMP_PATTERN =
  /^MEMORY\.md\.(?:bak|reset\.bak|restore\.bak)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const TRANSACTION_SCHEMA_VERSION = 1 as const;
const TRANSACTION_DECISION_MAX_BYTES = 2 * 1024;
const DOCUMENT_SCAN_MAX_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

interface DirectoryBinding {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface TransactionDocumentDecision {
  readonly kind: MemoryDocumentSnapshot['kind'];
  readonly byteLength: number;
  readonly revision: MemoryRevision | null;
  readonly reason: 'invalid_utf8' | 'oversize' | null;
}

interface TransactionBundleDecision {
  readonly revision: MemoryRevision;
  readonly memory: TransactionDocumentDecision;
  readonly pending: TransactionDocumentDecision;
}

interface TransactionDecision {
  readonly schemaVersion: typeof TRANSACTION_SCHEMA_VERSION;
  readonly basis: TransactionBundleDecision;
  readonly target: TransactionBundleDecision;
}

export async function readMemoryBundle(root: string): Promise<MemoryBundleSnapshot> {
  const directory = await bindMemoryDirectory(root);
  if (!directory) return bundleSnapshot(missingDocument(), missingDocument());
  if (await bindTransactionDirectory(directory)) {
    throw new MemoryBundleStoreError(
      'io_failed',
      'Memory bundle requires writer recovery before it can be read',
    );
  }
  return readBoundMemoryBundle(directory);
}

async function readBoundMemoryBundle(directory: DirectoryBinding): Promise<MemoryBundleSnapshot> {
  const memory = await readDocument(directory, 'memory');
  const pending = await readDocument(directory, 'pending');
  await assertDirectoryBinding(directory);
  return bundleSnapshot(memory, pending);
}

export async function readMemoryBackups(root: string): Promise<readonly MemoryBackupSnapshot[]> {
  const directory = await bindMemoryDirectory(root);
  if (!directory) return [];
  const candidates = await Promise.all(
    (Object.keys(BACKUP_FILES) as MemoryBackupKind[]).map((kind) =>
      readBackupCandidate(directory, kind),
    ),
  );
  return candidates
    .filter((candidate): candidate is MemoryBackupSnapshot => candidate !== undefined)
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || backupPriority(right.kind) - backupPriority(left.kind),
    );
}

export async function recoverMemoryBundle(root: string): Promise<void> {
  const directory = await bindMemoryDirectory(root);
  if (!directory) return;
  await cleanupBackupTemps(directory);
  const transaction = await bindTransactionDirectory(directory);
  if (!transaction) return;

  const decision = await readTransactionDecision(transaction);
  if (!decision) {
    await removeTransactionDirectory(directory, transaction);
    return;
  }
  await finishDecision(directory, transaction, decision);
}

export async function commitMemoryBundle(
  root: string,
  input: CommitMemoryBundleInput,
): Promise<MemoryBundleMutationResult> {
  const memoryBytes = validateDocumentBytes('memory', input.memory);
  const pendingBytes =
    input.pending === null ? null : validateDocumentBytes('pending', input.pending);
  const current = await readMemoryBundle(root);
  if (current.revision !== input.expectedRevision) {
    throw new MemoryBundleRevisionConflictError(input.expectedRevision, current);
  }

  const target = bundleTarget(memoryBytes, pendingBytes);
  if (target.snapshot.revision === current.revision) {
    if (!input.backup) return { changed: false, snapshot: current };
    const directory = await prepareMemoryDirectory(root);
    const currentBeforeBackup = await readMemoryBundle(root);
    if (currentBeforeBackup.revision !== input.expectedRevision) {
      throw new MemoryBundleRevisionConflictError(input.expectedRevision, currentBeforeBackup);
    }
    await writeMemoryBackup(directory, input.backup);
    const currentAfterBackup = await readMemoryBundle(root);
    if (currentAfterBackup.revision !== input.expectedRevision) {
      throw new MemoryBundleRevisionConflictError(input.expectedRevision, currentAfterBackup);
    }
    return { changed: false, snapshot: currentAfterBackup };
  }

  const directory = await prepareMemoryDirectory(root);
  await assertDirectoryBinding(directory);
  const currentBeforePublication = await readMemoryBundle(root);
  if (currentBeforePublication.revision !== input.expectedRevision) {
    throw new MemoryBundleRevisionConflictError(input.expectedRevision, currentBeforePublication);
  }
  if (input.backup) {
    await writeMemoryBackup(directory, input.backup);
    const currentAfterBackup = await readMemoryBundle(root);
    if (currentAfterBackup.revision !== input.expectedRevision) {
      throw new MemoryBundleRevisionConflictError(input.expectedRevision, currentAfterBackup);
    }
  }

  await publishTransaction(directory, target, input.expectedRevision);
  const committed = await readMemoryBundle(root);
  if (committed.revision !== target.snapshot.revision) {
    throw commitOutcomeUnknown(
      'Memory bundle publication could not be verified',
      target.snapshot.revision,
      new Error(`Expected ${target.snapshot.revision}, read ${committed.revision}`),
    );
  }
  return { changed: true, snapshot: committed };
}

export async function restoreMemoryBackup(
  root: string,
  input: RestoreMemoryBackupInput,
): Promise<MemoryBundleMutationResult> {
  const current = await readMemoryBundle(root);
  if (current.revision !== input.expectedRevision) {
    throw new MemoryBundleRevisionConflictError(input.expectedRevision, current);
  }
  if (current.pending.kind === 'safe_mode') {
    throw invalidMemoryDocument('Cannot restore Memory while PENDING.md is in safe mode');
  }
  const directory = await bindMemoryDirectory(root);
  if (!directory) throw new MemoryBundleBackupNotFoundError(input.kind);
  const selected = await readBackupBytes(directory, input.kind);
  if (!selected) throw new MemoryBundleBackupNotFoundError(input.kind);
  const selectedRevision = revision(selected);
  if (selectedRevision !== input.expectedBackupRevision) {
    throw new MemoryBundleBackupRevisionConflictError(
      input.kind,
      input.expectedBackupRevision,
      selectedRevision,
    );
  }

  const currentBeforePublication = await readMemoryBundle(root);
  if (currentBeforePublication.revision !== input.expectedRevision) {
    throw new MemoryBundleRevisionConflictError(input.expectedRevision, currentBeforePublication);
  }
  await rotateRestoreHistory(directory);
  await writeMemoryBackup(directory, 'restore');
  const currentAfterBackup = await readMemoryBundle(root);
  if (currentAfterBackup.revision !== input.expectedRevision) {
    throw new MemoryBundleRevisionConflictError(input.expectedRevision, currentAfterBackup);
  }

  const target = bundleTarget(selected, documentBytesOrNull(currentAfterBackup.pending), true);
  if (target.snapshot.revision === currentAfterBackup.revision) {
    return { changed: false, snapshot: currentAfterBackup };
  }
  await publishTransaction(directory, target, input.expectedRevision);
  const committed = await readMemoryBundle(root);
  if (committed.revision !== target.snapshot.revision) {
    throw commitOutcomeUnknown(
      'Memory backup restoration could not be verified',
      target.snapshot.revision,
      new Error(`Expected ${target.snapshot.revision}, read ${committed.revision}`),
    );
  }
  return { changed: true, snapshot: committed };
}

async function publishTransaction(
  directory: DirectoryBinding,
  target: MemoryBundleTarget,
  expectedRevision: MemoryRevision,
): Promise<void> {
  const transactionPath = join(directory.path, TRANSACTION_DIRECTORY);
  let transaction: DirectoryBinding | undefined;
  let decisionPublished = false;
  let failure: unknown;
  try {
    await mkdir(transactionPath, { mode: 0o700 });
    transaction = await requireDirectoryBinding(
      transactionPath,
      'Memory transaction path must be a directory',
    );
    await syncDirectory(directory.path);
    await assertDirectoryBinding(directory);

    await stageDocument(transaction, 'memory', target.snapshot.memory, target.memory);
    await stageDocument(transaction, 'pending', target.snapshot.pending, target.pending);
    const current = await readBoundMemoryBundle(directory);
    if (current.revision !== expectedRevision) {
      throw new MemoryBundleRevisionConflictError(expectedRevision, current);
    }
    const decision = decisionFromSnapshots(current, target.snapshot);
    await publishDecision(transaction, decision, () => {
      decisionPublished = true;
    });
    await finishDecision(directory, transaction, decision);
  } catch (error) {
    failure = error;
  }

  if (failure === undefined) return;
  if (!decisionPublished) {
    if (transaction) {
      try {
        await removeTransactionDirectory(directory, transaction);
      } catch (cleanupError) {
        throw memoryBundleIoFailed(
          'Memory transaction failed before publication and cleanup also failed',
          new AggregateError([failure, cleanupError]),
        );
      }
    }
    if (
      failure instanceof MemoryBundleStoreError ||
      failure instanceof MemoryBundleRevisionConflictError
    ) {
      throw failure;
    }
    throw memoryBundleIoFailed('Memory transaction failed before publication', failure);
  }
  throw commitOutcomeUnknown(
    'Memory bundle commit outcome is unknown; read before deciding whether to retry',
    target.snapshot.revision,
    failure,
  );
}

async function publishDecision(
  transaction: DirectoryBinding,
  decision: TransactionDecision,
  onPublished: () => void,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(decision)}\n`, 'utf8');
  if (bytes.byteLength > TRANSACTION_DECISION_MAX_BYTES) {
    throw invalidMemoryDocument('Memory transaction decision exceeds its byte limit');
  }
  const temporaryPath = join(transaction.path, `${DECISION_FILE}.${randomUUID()}.tmp`);
  const decisionPath = join(transaction.path, DECISION_FILE);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryBinding(transaction);
    await rename(temporaryPath, decisionPath);
    onPublished();
    await syncDirectory(transaction.path);
    await assertDirectoryBinding(transaction);
  } finally {
    if (handle) await handle.close();
    await rm(temporaryPath, { force: true });
  }
}

async function stageDocument(
  transaction: DirectoryBinding,
  name: MemoryDocumentName,
  document: MemoryDocumentSnapshot,
  bytes: Buffer | null,
): Promise<void> {
  if (document.kind === 'missing') return;
  if (!bytes || bytes.byteLength !== document.byteLength || revision(bytes) !== document.revision) {
    throw invalidMemoryDocument(`Transaction bytes for ${displayName(name)} are inconsistent`);
  }
  const handle = await open(stagePath(transaction.path, name), 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertDirectoryBinding(transaction);
}

async function materializeDecision(
  directory: DirectoryBinding,
  transaction: DirectoryBinding,
  decision: TransactionDecision,
): Promise<void> {
  await materializeDocument(
    directory,
    transaction,
    'memory',
    decision.basis.memory,
    decision.target.memory,
  );
  await materializeDocument(
    directory,
    transaction,
    'pending',
    decision.basis.pending,
    decision.target.pending,
  );
  await syncDirectory(directory.path);
  await assertDirectoryBinding(directory);
}

async function materializeDocument(
  directory: DirectoryBinding,
  transaction: DirectoryBinding,
  name: MemoryDocumentName,
  basis: TransactionDocumentDecision,
  target: TransactionDocumentDecision,
): Promise<void> {
  const stablePath = documentPath(directory.path, name);
  const capturedPath = displacedPath(transaction.path, name);
  const captured = await readDisplacedDocument(transaction, name);
  if (captured && (basis.kind === 'missing' || !sameDocumentDecision(captured, basis))) {
    await restoreUnexpectedDisplaced(directory, transaction, name);
    throw recoveryConflict(name);
  }

  let current = await readDocument(directory, name);
  if (sameDocumentDecision(current, target)) return;

  const stagedPath = stagePath(transaction.path, name);
  let staged: Buffer | undefined;
  if (target.kind !== 'missing') {
    staged = await readExactFile(stagedPath, displayName(name), DOCUMENT_SCAN_MAX_BYTES);
    const stagedSnapshot = snapshotForBytes(staged);
    if (!sameDocumentDecision(stagedSnapshot, target)) {
      throw invalidMemoryDocument(`Staged ${displayName(name)} does not match its commit decision`);
    }
  }

  if (captured) {
    if (current.kind !== 'missing') throw recoveryConflict(name);
  } else if (basis.kind === 'missing') {
    if (current.kind !== 'missing') throw recoveryConflict(name);
  } else {
    if (!sameDocumentDecision(current, basis)) throw recoveryConflict(name);
    await assertDirectoryBinding(directory);
    await assertDirectoryBinding(transaction);
    try {
      await rename(stablePath, capturedPath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw recoveryConflict(name);
      throw error;
    }
    await syncDirectory(directory.path);
    await syncDirectory(transaction.path);
    await assertDirectoryBinding(directory);
    await assertDirectoryBinding(transaction);

    const capturedAfterRename = await readDisplacedDocument(transaction, name);
    if (!capturedAfterRename || !sameDocumentDecision(capturedAfterRename, basis)) {
      if (capturedAfterRename) {
        await restoreUnexpectedDisplaced(directory, transaction, name);
      }
      throw recoveryConflict(name);
    }
    current = await readDocument(directory, name);
    if (sameDocumentDecision(current, target)) return;
    if (current.kind !== 'missing') throw recoveryConflict(name);
  }

  if (target.kind === 'missing') return;
  if (!staged) {
    throw invalidMemoryDocument(`Staged ${displayName(name)} is missing`);
  }

  const candidatePath = join(transaction.path, `${displayName(name)}.${randomUUID()}.publish`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidatePath, 'wx', 0o600);
    await handle.writeFile(staged);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryBinding(transaction);
    try {
      await link(candidatePath, stablePath);
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) throw recoveryConflict(name);
      throw error;
    }
    await syncDirectory(directory.path);
    await assertDirectoryBinding(directory);

    const materialized = await readDocument(directory, name);
    if (!sameDocumentDecision(materialized, target)) throw recoveryConflict(name);
  } finally {
    if (handle) await handle.close();
    await rm(candidatePath, { force: true });
  }
}

async function readDisplacedDocument(
  transaction: DirectoryBinding,
  name: MemoryDocumentName,
): Promise<MemoryDocumentSnapshot | undefined> {
  try {
    const bytes = await readExactFile(
      displacedPath(transaction.path, name),
      `${displayName(name)} displaced state`,
      DOCUMENT_SCAN_MAX_BYTES,
    );
    await assertDirectoryBinding(transaction);
    return snapshotForBytes(bytes);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await assertDirectoryBinding(transaction);
      return undefined;
    }
    throw error;
  }
}

async function restoreUnexpectedDisplaced(
  directory: DirectoryBinding,
  transaction: DirectoryBinding,
  name: MemoryDocumentName,
): Promise<void> {
  const current = await readDocument(directory, name);
  if (current.kind !== 'missing') return;
  await assertDirectoryBinding(transaction);
  try {
    await link(displacedPath(transaction.path, name), documentPath(directory.path, name));
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return;
    throw error;
  }
  await syncDirectory(directory.path);
  await assertDirectoryBinding(directory);
}

async function finishDecision(
  directory: DirectoryBinding,
  transaction: DirectoryBinding,
  decision: TransactionDecision,
): Promise<void> {
  await materializeDecision(directory, transaction, decision);
  await verifyMaterializedDecision(directory, decision);
  // An old file descriptor follows the displaced inode across rename. This last check catches
  // writes completed before cleanup; later non-cooperating writes require a different storage model.
  await verifyDisplacedBasisBeforeCleanup(transaction, decision);
  await removeTransactionDirectory(directory, transaction);
}

async function verifyDisplacedBasisBeforeCleanup(
  transaction: DirectoryBinding,
  decision: TransactionDecision,
): Promise<void> {
  for (const name of ['memory', 'pending'] as const) {
    const captured = await readDisplacedDocument(transaction, name);
    if (
      captured &&
      (decision.basis[name].kind === 'missing' ||
        !sameDocumentDecision(captured, decision.basis[name]))
    ) {
      throw recoveryConflict(name);
    }
  }
}

function recoveryConflict(name: MemoryDocumentName): MemoryBundleStoreError {
  return memoryBundleRecoveryConflict(
    `${displayName(name)} changed after the Memory bundle decision was committed`,
  );
}

async function readTransactionDecision(
  transaction: DirectoryBinding,
): Promise<TransactionDecision | undefined> {
  const path = join(transaction.path, DECISION_FILE);
  let bytes: Buffer;
  try {
    bytes = await readExactFile(path, DECISION_FILE, TRANSACTION_DECISION_MAX_BYTES);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await assertDirectoryBinding(transaction);
      return undefined;
    }
    throw error;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw invalidMemoryDocument('Memory transaction decision is invalid JSON', error);
  }
  const decision = decodeDecision(decoded);
  await assertDirectoryBinding(transaction);
  return decision;
}

function decodeDecision(input: unknown): TransactionDecision {
  if (!isRecord(input)) {
    throw invalidMemoryDocument('Memory transaction decision must be an object');
  }
  const keys = Object.keys(input).sort();
  if (keys.join(',') !== ['basis', 'schemaVersion', 'target'].sort().join(',')) {
    throw invalidMemoryDocument('Memory transaction decision has unknown or missing fields');
  }
  if (input.schemaVersion !== TRANSACTION_SCHEMA_VERSION) {
    throw invalidMemoryDocument('Memory transaction decision schema is unsupported');
  }
  const decision = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    basis: decodeBundleDecision(input.basis, 'basis'),
    target: decodeBundleDecision(input.target, 'target'),
  };
  return decision;
}

function decodeBundleDecision(
  input: unknown,
  label: 'basis' | 'target',
): TransactionBundleDecision {
  if (!isRecord(input)) {
    throw invalidMemoryDocument(`Memory transaction ${label} must be an object`);
  }
  const keys = Object.keys(input).sort();
  if (keys.join(',') !== ['memory', 'pending', 'revision'].sort().join(',')) {
    throw invalidMemoryDocument(`Memory transaction ${label} has unknown or missing fields`);
  }
  if (!isRevision(input.revision)) {
    throw invalidMemoryDocument(`Memory transaction ${label} revision is invalid`);
  }
  const decision = {
    revision: input.revision,
    memory: decodeDocumentDecision(input.memory),
    pending: decodeDocumentDecision(input.pending),
  };
  const projected = bundleSnapshot(
    snapshotFromDecision(decision.memory),
    snapshotFromDecision(decision.pending),
  );
  if (projected.revision !== decision.revision) {
    throw invalidMemoryDocument(`Memory transaction ${label} revision is inconsistent`);
  }
  return decision;
}

async function verifyMaterializedDecision(
  directory: DirectoryBinding,
  decision: TransactionDecision,
): Promise<void> {
  const materialized = await readBoundMemoryBundle(directory);
  for (const name of ['memory', 'pending'] as const) {
    if (!sameDocumentDecision(materialized[name], decision.target[name])) {
      throw recoveryConflict(name);
    }
  }
}

function decodeDocumentDecision(input: unknown): TransactionDocumentDecision {
  if (!isRecord(input)) {
    throw invalidMemoryDocument('Memory transaction document decision must be an object');
  }
  const keys = Object.keys(input).sort();
  if (keys.join(',') !== ['byteLength', 'kind', 'reason', 'revision'].sort().join(',')) {
    throw invalidMemoryDocument('Memory transaction document decision is not exact');
  }
  if (input.kind !== 'missing' && input.kind !== 'document' && input.kind !== 'safe_mode') {
    throw invalidMemoryDocument('Memory transaction document kind is invalid');
  }
  if (
    typeof input.byteLength !== 'number' ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0 ||
    input.byteLength > DOCUMENT_SCAN_MAX_BYTES
  ) {
    throw invalidMemoryDocument('Memory transaction document length is invalid');
  }
  if (input.kind === 'missing') {
    if (input.revision !== null || input.byteLength !== 0 || input.reason !== null) {
      throw invalidMemoryDocument('Missing Memory transaction documents must be empty');
    }
  } else {
    if (!isRevision(input.revision)) {
      throw invalidMemoryDocument('Memory transaction document revision is invalid');
    }
    const validDocument =
      input.kind === 'document' &&
      input.reason === null &&
      input.byteLength <= MEMORY_DOCUMENT_MAX_BYTES;
    const validInvalidUtf8 =
      input.kind === 'safe_mode' &&
      input.reason === 'invalid_utf8' &&
      input.byteLength <= MEMORY_DOCUMENT_MAX_BYTES;
    const validOversize =
      input.kind === 'safe_mode' &&
      input.reason === 'oversize' &&
      input.byteLength > MEMORY_DOCUMENT_MAX_BYTES;
    if (!validDocument && !validInvalidUtf8 && !validOversize) {
      throw invalidMemoryDocument('Memory transaction document safe-mode state is invalid');
    }
  }
  return {
    kind: input.kind,
    byteLength: input.byteLength,
    revision: input.revision as MemoryRevision | null,
    reason: input.reason as 'invalid_utf8' | 'oversize' | null,
  };
}

function decisionFromSnapshots(
  basis: MemoryBundleSnapshot,
  target: MemoryBundleSnapshot,
): TransactionDecision {
  return {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    basis: bundleDecision(basis),
    target: bundleDecision(target),
  };
}

function bundleDecision(snapshot: MemoryBundleSnapshot): TransactionBundleDecision {
  return {
    revision: snapshot.revision,
    memory: documentDecision(snapshot.memory),
    pending: documentDecision(snapshot.pending),
  };
}

function documentDecision(snapshot: MemoryDocumentSnapshot): TransactionDocumentDecision {
  return {
    kind: snapshot.kind,
    byteLength: snapshot.byteLength,
    revision: snapshot.revision,
    reason: snapshot.kind === 'safe_mode' ? snapshot.reason : null,
  };
}

function snapshotFromDecision(decision: TransactionDocumentDecision): MemoryDocumentSnapshot {
  switch (decision.kind) {
    case 'missing':
      return missingDocument();
    case 'document':
      return {
        kind: 'document',
        revision: decision.revision!,
        byteLength: decision.byteLength,
        bytes: new Uint8Array(),
      };
    case 'safe_mode':
      return {
        kind: 'safe_mode',
        revision: decision.revision!,
        byteLength: decision.byteLength,
        reason: decision.reason!,
      };
  }
}

async function readDocument(
  directory: DirectoryBinding,
  name: MemoryDocumentName,
): Promise<MemoryDocumentSnapshot> {
  const path = documentPath(directory.path, name);
  let bytes: Buffer;
  try {
    bytes = await readExactFile(path, displayName(name), DOCUMENT_SCAN_MAX_BYTES);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await assertDirectoryBinding(directory);
      return missingDocument();
    }
    throw error;
  }
  await assertDirectoryBinding(directory);
  return snapshotForBytes(bytes);
}

async function readExactFile(path: string, label: string, maxBytes: number): Promise<Buffer> {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw error;
    throw memoryBundleIoFailed(`${label} could not be inspected`, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw invalidMemoryDocument(`${label} must be a regular file`);
  }
  if (metadata.size > BigInt(maxBytes)) {
    throw invalidMemoryDocument(`${label} exceeds its ${maxBytes} byte scan limit`);
  }

  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if (process.platform !== 'win32' && isNodeError(error, 'ELOOP')) {
      throw invalidMemoryDocument(`${label} must not be a symbolic link`, error);
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size > BigInt(maxBytes)) {
      throw invalidMemoryDocument(`${label} is not a bounded regular file`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) {
        throw invalidMemoryDocument(`${label} exceeds its ${maxBytes} byte scan limit`);
      }
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function readBackupCandidate(
  directory: DirectoryBinding,
  kind: MemoryBackupKind,
): Promise<MemoryBackupSnapshot | undefined> {
  const bytes = await readBackupBytes(directory, kind);
  if (!bytes) return undefined;
  const metadata = await lstat(backupPath(directory.path, kind), { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw invalidMemoryDocument(`${BACKUP_FILES[kind]} must be a regular file`);
  }
  await assertDirectoryBinding(directory);
  const document = snapshotForBytes(bytes);
  return {
    kind,
    revision: document.revision,
    updatedAt: Math.round(Number(metadata.mtimeMs)),
    document,
  };
}

async function readBackupBytes(
  directory: DirectoryBinding,
  kind: MemoryBackupKind,
): Promise<Buffer | undefined> {
  try {
    const bytes = await readExactFile(
      backupPath(directory.path, kind),
      BACKUP_FILES[kind],
      DOCUMENT_SCAN_MAX_BYTES,
    );
    await assertDirectoryBinding(directory);
    return bytes;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await assertDirectoryBinding(directory);
      return undefined;
    }
    throw error;
  }
}

async function writeMemoryBackup(
  directory: DirectoryBinding,
  kind: MemoryBackupKind,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readExactFile(
      documentPath(directory.path, 'memory'),
      MEMORY_FILE,
      DOCUMENT_SCAN_MAX_BYTES,
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await assertDirectoryBinding(directory);
      return;
    }
    throw error;
  }
  await writeBackupBytes(directory, kind, bytes);
}

async function writeBackupBytes(
  directory: DirectoryBinding,
  kind: MemoryBackupKind,
  bytes: Uint8Array,
): Promise<void> {
  const destination = backupPath(directory.path, kind);
  await assertRegularOrMissing(destination, BACKUP_FILES[kind]);
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryBinding(directory);
    await rename(temporaryPath, destination);
    await chmod(destination, 0o600);
    await syncDirectory(directory.path);
    await assertDirectoryBinding(directory);
  } finally {
    if (handle) await handle.close();
    await rm(temporaryPath, { force: true });
  }
}

async function rotateRestoreHistory(directory: DirectoryBinding): Promise<void> {
  for (let index = RESTORE_HISTORY_LIMIT - 1; index >= 1; index -= 1) {
    await renameRegularIfPresent(
      directory,
      restoreHistoryPath(directory.path, index),
      restoreHistoryPath(directory.path, index + 1),
    );
  }
  await renameRegularIfPresent(
    directory,
    backupPath(directory.path, 'restore'),
    restoreHistoryPath(directory.path, 1),
  );
  await syncDirectory(directory.path);
  await assertDirectoryBinding(directory);
}

async function renameRegularIfPresent(
  directory: DirectoryBinding,
  source: string,
  destination: string,
): Promise<void> {
  let sourceMetadata;
  try {
    sourceMetadata = await lstat(source);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw invalidMemoryDocument('Memory restore history must contain only regular files');
  }
  await assertRegularOrMissing(destination, 'Memory restore history destination');
  await assertDirectoryBinding(directory);
  await rename(source, destination);
}

async function assertRegularOrMissing(path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw invalidMemoryDocument(`${label} must be a regular file`);
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
}

async function prepareMemoryDirectory(root: string): Promise<DirectoryBinding> {
  const existing = await bindMemoryDirectory(root);
  if (existing) return existing;
  const path = join(root, MEMORY_DIRECTORY);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) {
      throw memoryBundleIoFailed('Memory directory could not be created', error);
    }
  }
  const prepared = await requireDirectoryBinding(
    path,
    'Memory path must be a directory inside the storage root',
  );
  await syncDirectory(root);
  return prepared;
}

async function bindMemoryDirectory(root: string): Promise<DirectoryBinding | undefined> {
  const path = join(root, MEMORY_DIRECTORY);
  try {
    return await requireDirectoryBinding(
      path,
      'Memory path must be a directory inside the storage root',
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function bindTransactionDirectory(
  directory: DirectoryBinding,
): Promise<DirectoryBinding | undefined> {
  const path = join(directory.path, TRANSACTION_DIRECTORY);
  try {
    const transaction = await requireDirectoryBinding(
      path,
      'Memory transaction path must be a directory',
    );
    await assertDirectoryBinding(directory);
    return transaction;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await assertDirectoryBinding(directory);
      return undefined;
    }
    throw error;
  }
}

async function requireDirectoryBinding(path: string, message: string): Promise<DirectoryBinding> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw error;
    throw memoryBundleIoFailed(`${message}: inspection failed`, error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidMemoryDocument(message);
  }
  return { path, dev: metadata.dev, ino: metadata.ino };
}

async function assertDirectoryBinding(binding: DirectoryBinding): Promise<void> {
  const metadata = await lstat(binding.path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== binding.dev ||
    metadata.ino !== binding.ino
  ) {
    throw invalidMemoryDocument('Memory directory identity changed during the operation');
  }
}

async function removeTransactionDirectory(
  directory: DirectoryBinding,
  transaction: DirectoryBinding,
): Promise<void> {
  await assertDirectoryBinding(directory);
  await assertDirectoryBinding(transaction);
  await rm(transaction.path, { recursive: true });
  await syncDirectory(directory.path);
  await assertDirectoryBinding(directory);
}

async function cleanupBackupTemps(directory: DirectoryBinding): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory.path);
  } catch (error) {
    throw memoryBundleIoFailed('Memory directory could not be listed', error);
  }
  let changed = false;
  for (const entry of entries) {
    if (!BACKUP_TEMP_PATTERN.test(entry)) continue;
    const path = join(directory.path, entry);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw invalidMemoryDocument('Memory temporary artifacts must be regular files');
    }
    await unlink(path);
    changed = true;
  }
  if (changed) {
    await syncDirectory(directory.path);
    await assertDirectoryBinding(directory);
  }
}

function sameDocumentDecision(
  snapshot: MemoryDocumentSnapshot,
  decision: TransactionDocumentDecision,
): boolean {
  return (
    snapshot.kind === decision.kind &&
    snapshot.byteLength === decision.byteLength &&
    snapshot.revision === decision.revision &&
    (snapshot.kind === 'safe_mode' ? snapshot.reason : null) === decision.reason
  );
}

function documentBytesOrNull(document: MemoryDocumentSnapshot): Buffer | null {
  if (document.kind === 'missing') return null;
  if (document.kind === 'document') return Buffer.from(document.bytes);
  throw invalidMemoryDocument(
    'Safe-mode PENDING.md bytes cannot be restored through Memory backup',
  );
}

function documentPath(directory: string, name: MemoryDocumentName): string {
  return join(directory, displayName(name));
}

function backupPath(directory: string, kind: MemoryBackupKind): string {
  return join(directory, BACKUP_FILES[kind]);
}

function restoreHistoryPath(directory: string, index: number): string {
  return join(directory, `MEMORY.md.restore.${index}.bak`);
}

function backupPriority(kind: MemoryBackupKind): number {
  switch (kind) {
    case 'save':
      return 0;
    case 'reset':
      return 1;
    case 'restore':
      return 2;
  }
}

function stagePath(transaction: string, name: MemoryDocumentName): string {
  return join(transaction, `${displayName(name)}.next`);
}

function displacedPath(transaction: string, name: MemoryDocumentName): string {
  return join(transaction, `${displayName(name)}.displaced`);
}

function displayName(name: MemoryDocumentName): string {
  return name === 'memory' ? MEMORY_FILE : PENDING_FILE;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function commitOutcomeUnknown(
  message: string,
  candidateRevision: MemoryRevision,
  cause: unknown,
): MemoryBundleStoreError {
  return new MemoryBundleStoreError('commit_outcome_unknown', message, candidateRevision, {
    cause,
  });
}
