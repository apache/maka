import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isPathInside, isSafeSkillId } from '@maka/runtime/path-containment';

import { MANAGED_SKILL_BASELINE_RELATIVE_PATH } from '@maka/runtime/skills';

const TRANSACTION_DIRECTORY = join('.maka', 'skill-transactions');
const INTENT_FILE = 'intent.json';
const INTENT_TEMP_FILE = 'intent.json.tmp';
const EXPECTED_DIRECTORY = 'expected';
const NEXT_DIRECTORY = 'next';
const TOMBSTONE_DIRECTORY = 'tombstone';
const MANAGED_FROZEN_PREFIX = '.maka-frozen-';

const SKILL_FILE = 'SKILL.md';
const LOCK_FILE = 'skill.lock.json';
const BASELINE_FILE = MANAGED_SKILL_BASELINE_RELATIVE_PATH;
const MANAGED_FILES = [BASELINE_FILE, SKILL_FILE, LOCK_FILE] as const;

const SKILL_MAX_BYTES = 256 * 1024;
const LOCK_MAX_BYTES = 32 * 1024;
const INTENT_MAX_BYTES = 64 * 1024;
const DELETE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const DELETE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const DELETE_MAX_ENTRIES = 256;
const DELETE_MAX_DEPTH = 16;
const DELETE_MANIFEST_MAX_BYTES = 48 * 1024;
const PATH_MAX_BYTES = 4 * 1024;
const TRANSACTION_ROOT_MAX_ENTRIES = 128;
const TRANSACTION_MAX_ENTRIES = 12;
const ARTIFACT_MAX_ENTRIES = 3;
const GC_MAX_ENTRIES = DELETE_MAX_ENTRIES + 4;
const GC_MAX_DEPTH = DELETE_MAX_DEPTH + 2;
const READ_CHUNK_BYTES = 64 * 1024;
const TRANSACTION_PATTERN = /^tx-([0-9a-f-]{36})-([0-9a-f]{64})$/;
const GC_PATTERN = /^gc-([0-9a-f-]{36})-([0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type SkillCatalogTransactionErrorCode = 'persistence_failed' | 'commit_outcome_unknown';

export class SkillCatalogTransactionError extends Error {
  constructor(
    readonly code: SkillCatalogTransactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SkillCatalogTransactionError';
  }
}

export type SkillCatalogRunWithRoot = <T>(operation: (root: string) => Promise<T>) => Promise<T>;

export interface SkillCatalogTransactionArtifacts {
  readonly skill: string | Uint8Array;
  readonly lock?: string | Uint8Array;
  readonly baseline?: string | Uint8Array;
}

export interface ManagedSkillTransactionArtifacts {
  readonly skill: string | Uint8Array;
  readonly lock: string | Uint8Array;
  readonly baseline: string | Uint8Array;
}

export type SkillCatalogTransactionFailpoint =
  | 'after_intent_write_before_file_sync'
  | 'after_intent_rename_before_directory_sync'
  | 'after_intent'
  | 'after_publish_rename_before_directory_sync'
  | 'after_publish_skills_directory_sync_before_transaction_sync'
  | 'after_publish_rename'
  | 'after_managed_freeze_rename_before_directory_sync'
  | 'after_managed_freeze'
  | 'after_managed_publish_rename_before_directory_sync'
  | 'after_managed_publish_skills_directory_sync_before_transaction_sync'
  | 'after_managed_publish'
  | 'after_managed_handoff_rename_before_directory_sync'
  | 'after_managed_handoff_transaction_sync_before_skills_sync'
  | 'after_managed_handoff'
  | 'after_delete_rename_before_directory_sync'
  | 'after_delete_skills_directory_sync_before_transaction_sync'
  | 'after_gc_handoff_rename_before_directory_sync'
  | 'after_gc_handoff'
  | 'during_gc_cleanup'
  | 'after_delete_rename';

export interface SkillCatalogTransactionOptions {
  readonly failpoint?: (point: SkillCatalogTransactionFailpoint) => void;
}

export interface SkillDeletionArtifactDigest {
  readonly bytes: number;
  readonly sha256: string;
}

export type SkillDeletionManifest = Readonly<Record<string, SkillDeletionArtifactDigest>>;

type ArtifactDigest = SkillDeletionArtifactDigest;
type ManagedManifest = Readonly<Record<(typeof MANAGED_FILES)[number], ArtifactDigest>>;

interface PublishIntent {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly kind: 'publish';
  readonly skillId: string;
  readonly next: Readonly<Record<string, ArtifactDigest>>;
}

interface ReplaceIntent {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly kind: 'replace-managed';
  readonly skillId: string;
  readonly expected: ManagedManifest;
  readonly next: ManagedManifest;
}

interface DeleteIntent {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly kind: 'delete-workspace';
  readonly skillId: string;
  readonly expected: Readonly<Record<string, ArtifactDigest>>;
}

type TransactionIntent = PublishIntent | ReplaceIntent | DeleteIntent;

interface PreparedRoot {
  readonly root: string;
  readonly skills: string;
  readonly transactions: string;
}

interface PreparedTransaction {
  readonly directory: string;
  readonly intent: TransactionIntent;
  readonly intentBytes: Buffer;
}

interface SkillDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Durable mutation helper for Host-owned Data Root Skill files.
 *
 * The caller supplies the lease-bound root runner; this class never resolves or
 * writes project, user, machine-source, or arbitrary caller-selected paths.
 */
export class SkillCatalogTransactionWriter {
  readonly #runWithRoot: SkillCatalogRunWithRoot;
  readonly #failpoint: ((point: SkillCatalogTransactionFailpoint) => void) | undefined;

  constructor(runWithRoot: SkillCatalogRunWithRoot, options: SkillCatalogTransactionOptions = {}) {
    this.#runWithRoot = runWithRoot;
    this.#failpoint = options.failpoint;
  }

  recover(): Promise<void> {
    return this.#runWithRoot(async (root) => {
      const prepared = await prepareRoot(root, false);
      if (!prepared) return;
      const entries = await safeReadDirectory(prepared.transactions, TRANSACTION_ROOT_MAX_ENTRIES);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw persistenceFailed('Skill transaction root contains an unsafe entry');
        }
        if (GC_PATTERN.test(entry.name)) {
          await cleanupGcEntry(prepared.transactions, join(prepared.transactions, entry.name));
          continue;
        }
        const match = TRANSACTION_PATTERN.exec(entry.name);
        if (!match) {
          throw persistenceFailed('Skill transaction root contains an unknown entry');
        }
        const directory = join(prepared.transactions, entry.name);
        const transaction = await readPreparedTransaction(directory, entry.name);
        if (!transaction) {
          await removePreIntentTransaction(prepared.transactions, directory);
          continue;
        }
        await replayTransaction(prepared, transaction);
      }
    });
  }

  publishSkill(skillId: string, artifacts: SkillCatalogTransactionArtifacts): Promise<void> {
    assertSkillId(skillId);
    const files = artifactFiles(artifacts);
    return this.#runWithRoot(async (root) => {
      const prepared = await requiredPreparedRoot(root);
      const target = join(prepared.skills, skillId);
      await requireMissing(target, 'Skill publication target already exists');

      const transactionId = randomUUID();
      const intent: PublishIntent = {
        schemaVersion: 1,
        transactionId,
        kind: 'publish',
        skillId,
        next: manifestForBuffers(files),
      };
      await this.#executeNewTransaction(prepared, intent, async (transaction) => {
        await writeArtifactDirectory(transaction.directory, NEXT_DIRECTORY, files);
      });
    });
  }

  replaceManagedSkill(
    skillId: string,
    expected: ManagedSkillTransactionArtifacts,
    next: ManagedSkillTransactionArtifacts,
  ): Promise<void> {
    assertSkillId(skillId);
    const expectedFiles = managedArtifactFiles(expected);
    const nextFiles = managedArtifactFiles(next);
    return this.#runWithRoot(async (root) => {
      const prepared = await requiredPreparedRoot(root);
      const target = await requireContainedDirectory(
        prepared.skills,
        join(prepared.skills, skillId),
      );
      await verifyManagedExpected(target, expectedFiles);

      const transactionId = randomUUID();
      const intent: ReplaceIntent = {
        schemaVersion: 1,
        transactionId,
        kind: 'replace-managed',
        skillId,
        expected: manifestForBuffers(expectedFiles) as ManagedManifest,
        next: manifestForBuffers(nextFiles) as ManagedManifest,
      };
      await this.#executeNewTransaction(prepared, intent, async (transaction) => {
        await writeArtifactDirectory(transaction.directory, EXPECTED_DIRECTORY, expectedFiles);
        await writeArtifactDirectory(transaction.directory, NEXT_DIRECTORY, nextFiles);
      });
    });
  }

  deleteWorkspaceSkill(skillId: string, expected: SkillDeletionManifest): Promise<void> {
    assertSkillId(skillId);
    const exactExpected = parseManifest(expected, undefined, true);
    return this.#runWithRoot(async (root) => {
      const prepared = await requiredPreparedRoot(root);
      const target = await requireContainedDirectory(
        prepared.skills,
        join(prepared.skills, skillId),
      );
      await verifyTreeManifest(target, exactExpected);
      const transactionId = randomUUID();
      const intent: DeleteIntent = {
        schemaVersion: 1,
        transactionId,
        kind: 'delete-workspace',
        skillId,
        expected: exactExpected,
      };
      await this.#executeNewTransaction(prepared, intent);
    });
  }

  async #executeNewTransaction(
    prepared: PreparedRoot,
    intent: TransactionIntent,
    stage?: (transaction: PreparedTransaction) => Promise<void>,
  ): Promise<void> {
    const intentBytes = serializeIntent(intent);
    const directoryName = transactionDirectoryName(intent.transactionId, intentBytes);
    const directory = join(prepared.transactions, directoryName);
    const transaction: PreparedTransaction = { directory, intent, intentBytes };
    let intentPublicationUncertain = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      await syncDirectory(prepared.transactions);
      if (stage) await stage(transaction);
      await writeNewDurableFile(directory, INTENT_TEMP_FILE, intentBytes, () =>
        this.#failpoint?.('after_intent_write_before_file_sync'),
      );
      await rename(join(directory, INTENT_TEMP_FILE), join(directory, INTENT_FILE));
      intentPublicationUncertain = true;
      this.#failpoint?.('after_intent_rename_before_directory_sync');
      await syncDirectory(directory);
      this.#failpoint?.('after_intent');
      await replayTransaction(prepared, transaction, this.#failpoint);
    } catch (error) {
      if (intentPublicationUncertain) {
        throw commitOutcomeUnknown(
          'Skill transaction outcome is unknown; recover before retrying',
          error,
        );
      }
      let cleanupFailure: unknown;
      try {
        await removePreIntentTransaction(prepared.transactions, directory);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      if (cleanupFailure) {
        throw persistenceFailed(
          'Skill transaction failed before intent and staging cleanup failed',
          new AggregateError([error, cleanupFailure]),
        );
      }
      if (error instanceof SkillCatalogTransactionError) throw error;
      throw persistenceFailed('Skill transaction failed before durable intent', error);
    }
  }
}

export async function snapshotWorkspaceSkillTree(
  dataRoot: string,
  skillId: string,
): Promise<SkillDeletionManifest> {
  assertSkillId(skillId);
  const root = await canonicalRoot(dataRoot);
  const skills = await requireContainedDirectory(root, join(root, 'skills'));
  const target = await requireContainedDirectory(skills, join(skills, skillId));
  return manifestDirectoryTree(target);
}

async function replayTransaction(
  root: PreparedRoot,
  transaction: PreparedTransaction,
  failpoint?: (point: SkillCatalogTransactionFailpoint) => void,
): Promise<void> {
  await verifyTransactionEntries(transaction);
  switch (transaction.intent.kind) {
    case 'publish':
      await replayPublish(root, transaction, failpoint);
      return;
    case 'replace-managed':
      await replayReplace(root, transaction, failpoint);
      return;
    case 'delete-workspace':
      await replayDelete(root, transaction, failpoint);
      return;
  }
}

async function verifyTransactionEntries(transaction: PreparedTransaction): Promise<void> {
  const allowed =
    transaction.intent.kind === 'publish'
      ? new Set([INTENT_FILE, NEXT_DIRECTORY])
      : transaction.intent.kind === 'replace-managed'
        ? new Set([INTENT_FILE, EXPECTED_DIRECTORY, NEXT_DIRECTORY, TOMBSTONE_DIRECTORY])
        : new Set([INTENT_FILE, TOMBSTONE_DIRECTORY]);
  for (const entry of await safeReadDirectory(transaction.directory, TRANSACTION_MAX_ENTRIES)) {
    if (entry.isSymbolicLink() || !allowed.has(entry.name)) {
      throw persistenceFailed('Skill transaction contains a modified or unknown artifact');
    }
    const shouldBeFile = entry.name === INTENT_FILE;
    if (shouldBeFile ? !entry.isFile() : !entry.isDirectory()) {
      throw persistenceFailed('Skill transaction contains an artifact of the wrong type');
    }
  }
}

async function replayPublish(
  root: PreparedRoot,
  transaction: PreparedTransaction,
  failpoint?: (point: SkillCatalogTransactionFailpoint) => void,
): Promise<void> {
  const intent = transaction.intent as PublishIntent;
  const target = join(root.skills, intent.skillId);
  const next = join(transaction.directory, NEXT_DIRECTORY);
  const [targetStat, nextStat] = await Promise.all([safeLstat(target), safeLstat(next)]);
  if (targetStat && nextStat) {
    await Promise.all([
      verifyArtifactDirectory(target, intent.next),
      verifyArtifactDirectory(next, intent.next),
    ]);
  } else if (targetStat) {
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw persistenceFailed('Published Skill target is unsafe');
    }
    await verifyArtifactDirectory(target, intent.next);
  } else {
    if (!nextStat || !nextStat.isDirectory() || nextStat.isSymbolicLink()) {
      throw persistenceFailed('Skill publication artifact is missing or unsafe');
    }
    await verifyArtifactDirectory(next, intent.next);
    await rename(next, target);
    failpoint?.('after_publish_rename_before_directory_sync');
    await syncDirectory(root.skills);
    failpoint?.('after_publish_skills_directory_sync_before_transaction_sync');
    await syncDirectory(transaction.directory);
    failpoint?.('after_publish_rename');
  }
  await finishTransaction(root.transactions, transaction.directory, failpoint);
}

async function replayReplace(
  root: PreparedRoot,
  transaction: PreparedTransaction,
  failpoint?: (point: SkillCatalogTransactionFailpoint) => void,
): Promise<void> {
  const intent = transaction.intent as ReplaceIntent;
  const expectedDirectory = join(transaction.directory, EXPECTED_DIRECTORY);
  const nextDirectory = join(transaction.directory, NEXT_DIRECTORY);
  const target = join(root.skills, intent.skillId);
  const frozen = join(root.skills, `${MANAGED_FROZEN_PREFIX}${intent.transactionId}`);
  const tombstone = join(transaction.directory, TOMBSTONE_DIRECTORY);
  await verifyArtifactDirectory(expectedDirectory, intent.expected);
  let nextStat = await safeLstat(nextDirectory);
  if (nextStat) await verifyArtifactDirectory(nextDirectory, intent.next);

  const [initialTargetStat, frozenStat, tombstoneStat] = await Promise.all([
    safeLstat(target),
    safeLstat(frozen),
    safeLstat(tombstone),
  ]);
  let targetStat = initialTargetStat;
  const retainedOld = new Set<'frozen' | 'tombstone'>();
  if (frozenStat) retainedOld.add('frozen');
  if (tombstoneStat) retainedOld.add('tombstone');
  for (const retained of retainedOld) {
    await verifyArtifactDirectory(retained === 'frozen' ? frozen : tombstone, intent.expected);
  }

  const targetState = targetStat
    ? await classifyManagedTarget(target, intent.expected, intent.next)
    : undefined;
  if (retainedOld.size === 2) {
    if (!targetStat || targetState === 'expected') {
      throw persistenceFailed('Managed Skill has conflicting live and retained old generations');
    }
    // Tombstone owns the old generation; the source-parent duplicate can enter recoverable GC.
    await handoffDuplicateToGc(root, frozen);
    retainedOld.delete('frozen');
  }

  if (targetStat && targetState === 'expected') {
    if (retainedOld.has('frozen')) {
      throw persistenceFailed('Managed Skill has conflicting live and frozen expected generations');
    }
    if (retainedOld.has('tombstone') || !nextStat) {
      await finishTransaction(root.transactions, transaction.directory);
      return;
    }
  } else if (targetStat && !retainedOld.has('frozen')) {
    await finishTransaction(root.transactions, transaction.directory);
    return;
  } else if (!targetStat && retainedOld.size === 0) {
    throw persistenceFailed('Managed Skill replacement has no live or retained old generation');
  }

  if (targetStat && targetState === 'expected') {
    await rename(target, frozen);
    failpoint?.('after_managed_freeze_rename_before_directory_sync');
    await syncDirectory(root.skills);
    failpoint?.('after_managed_freeze');
    targetStat = undefined;
    retainedOld.add('frozen');
  }

  if (!targetStat && !nextStat) {
    const rollback = retainedOld.has('frozen')
      ? frozen
      : retainedOld.has('tombstone')
        ? tombstone
        : undefined;
    if (!rollback) {
      throw persistenceFailed('Managed Skill replacement cannot restore its old generation');
    }
    await rename(rollback, target);
    await syncDirectory(root.skills);
    if (rollback === tombstone) await syncDirectory(transaction.directory);
    await finishTransaction(root.transactions, transaction.directory);
    return;
  }

  if (!targetStat) {
    if (!retainedOld.has('frozen') || retainedOld.has('tombstone')) {
      throw persistenceFailed('Managed Skill replacement cannot publish from its current state');
    }
    await rename(nextDirectory, target);
    failpoint?.('after_managed_publish_rename_before_directory_sync');
    await syncDirectory(root.skills);
    // This destination sync is the durable target=next publication cut.
    // Everything retained in frozen is now a stale old generation.
    failpoint?.('after_managed_publish_skills_directory_sync_before_transaction_sync');
    await syncDirectory(transaction.directory);
    failpoint?.('after_managed_publish');
    nextStat = await safeLstat(nextDirectory);
  }

  await verifyArtifactDirectory(target, intent.next);
  if (nextStat) await verifyArtifactDirectory(nextDirectory, intent.next);

  if (retainedOld.has('frozen')) {
    await verifyArtifactDirectory(frozen, intent.expected);
    await rename(frozen, tombstone);
    failpoint?.('after_managed_handoff_rename_before_directory_sync');
    await syncDirectory(transaction.directory);
    failpoint?.('after_managed_handoff_transaction_sync_before_skills_sync');
    await syncDirectory(root.skills);
    failpoint?.('after_managed_handoff');
    retainedOld.delete('frozen');
    retainedOld.add('tombstone');
  }
  if (!retainedOld.has('tombstone')) {
    throw persistenceFailed('Managed Skill replacement lost its stale old generation');
  }
  // A non-cooperating old fd after this check is beyond the retention guarantee of transaction GC.
  await verifyArtifactDirectory(tombstone, intent.expected);
  await finishTransaction(root.transactions, transaction.directory, failpoint);
}

async function handoffDuplicateToGc(root: PreparedRoot, duplicate: string): Promise<void> {
  const gcId = randomUUID();
  const gcDigest = createHash('sha256').update(gcId).digest('hex');
  const gcDirectory = join(root.transactions, `gc-${gcId}-${gcDigest}`);
  await rename(duplicate, gcDirectory);
  await syncDirectory(root.transactions);
  await syncDirectory(dirname(duplicate));
  await cleanupGcEntry(root.transactions, gcDirectory);
}

async function classifyManagedTarget(
  target: string,
  expected: ManagedManifest,
  next: ManagedManifest,
): Promise<'expected' | 'next' | 'both'> {
  const [expectedResult, nextResult] = await Promise.all([
    matchArtifactDirectory(target, expected),
    matchArtifactDirectory(target, next),
  ]);
  if (expectedResult.matches && nextResult.matches) return 'both';
  if (expectedResult.matches) return 'expected';
  if (nextResult.matches) return 'next';
  throw persistenceFailed(
    'Managed Skill live directory conflicts with the durable transaction',
    new AggregateError([expectedResult.error, nextResult.error]),
  );
}

async function matchArtifactDirectory(
  directory: string,
  manifest: ManagedManifest,
): Promise<{ matches: true } | { matches: false; error: unknown }> {
  try {
    await verifyArtifactDirectory(directory, manifest);
    return { matches: true };
  } catch (error) {
    return { matches: false, error };
  }
}

async function replayDelete(
  root: PreparedRoot,
  transaction: PreparedTransaction,
  failpoint?: (point: SkillCatalogTransactionFailpoint) => void,
): Promise<void> {
  const intent = transaction.intent as DeleteIntent;
  const target = join(root.skills, intent.skillId);
  const tombstone = join(transaction.directory, TOMBSTONE_DIRECTORY);
  const [targetStat, tombstoneStat] = await Promise.all([safeLstat(target), safeLstat(tombstone)]);
  if (targetStat && tombstoneStat) {
    await Promise.all([
      verifyTreeManifest(target, intent.expected),
      verifyTreeManifest(tombstone, intent.expected),
    ]);
    await handoffDuplicateToGc(root, target);
  } else if (targetStat) {
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw persistenceFailed('Workspace Skill deletion target is unsafe');
    }
    const targetReal = await requireContainedDirectory(root.skills, target);
    await verifyTreeManifest(targetReal, intent.expected);
    await rename(targetReal, tombstone);
    failpoint?.('after_delete_rename_before_directory_sync');
    await syncDirectory(root.skills);
    failpoint?.('after_delete_skills_directory_sync_before_transaction_sync');
    await syncDirectory(transaction.directory);
    failpoint?.('after_delete_rename');
  } else if (tombstoneStat && (!tombstoneStat.isDirectory() || tombstoneStat.isSymbolicLink())) {
    throw persistenceFailed('Workspace Skill tombstone is unsafe');
  }
  if (await safeLstat(tombstone)) {
    await verifyTreeManifest(tombstone, intent.expected);
  }
  await finishTransaction(root.transactions, transaction.directory, failpoint);
}

async function verifyManagedExpected(
  target: string,
  expected: Readonly<Record<string, Buffer>>,
): Promise<void> {
  await verifyArtifactDirectory(target, manifestForBuffers(expected));
}

async function prepareRoot(rootInput: string, create: boolean): Promise<PreparedRoot | undefined> {
  const root = await canonicalRoot(rootInput);
  const skills = join(root, 'skills');
  const metadata = join(root, '.maka');
  const transactions = join(root, TRANSACTION_DIRECTORY);
  if (!create) {
    const transactionStat = await safeLstat(transactions);
    if (!transactionStat) return undefined;
    await requireContainedDirectory(root, metadata);
    await requireContainedDirectory(metadata, transactions);
    const skillsStat = await safeLstat(skills);
    if (skillsStat) await requireContainedDirectory(root, skills);
    return { root, skills, transactions };
  }
  await ensureDirectory(root, skills);
  await ensureDirectory(root, metadata);
  await ensureDirectory(metadata, transactions);
  return { root, skills, transactions };
}

async function requiredPreparedRoot(root: string): Promise<PreparedRoot> {
  const prepared = await prepareRoot(root, true);
  if (!prepared) throw persistenceFailed('Skill transaction root could not be prepared');
  return prepared;
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpath(resolve(root));
  } catch (error) {
    throw persistenceFailed('Data Root could not be resolved', error);
  }
}

async function ensureDirectory(containmentRoot: string, path: string): Promise<string> {
  assertContained(containmentRoot, path);
  const existing = await safeLstat(path);
  if (existing) return requireContainedDirectory(containmentRoot, path);
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw persistenceFailed('Skill transaction directory could not be created', error);
    }
  }
  return requireContainedDirectory(containmentRoot, path);
}

async function requireContainedDirectory(containmentRoot: string, path: string): Promise<string> {
  assertContained(containmentRoot, path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw persistenceFailed('Required Skill directory is missing', error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw persistenceFailed('Skill transaction path must be a real directory');
  }
  let resolved;
  try {
    resolved = await realpath(path);
  } catch (error) {
    throw persistenceFailed('Skill transaction directory could not be resolved', error);
  }
  assertContained(containmentRoot, resolved);
  return resolved;
}

function assertContained(root: string, path: string): void {
  // The lease excludes sibling writers; Node has no dirfd-relative rename API,
  // so no-follow containment assumes that owner-held directory parents stay stable.
  if (!isPathInside(resolve(root), resolve(path))) {
    throw persistenceFailed('Skill transaction path escaped its containment root');
  }
}

async function writeArtifactDirectory(
  transaction: string,
  name: typeof EXPECTED_DIRECTORY | typeof NEXT_DIRECTORY,
  files: Readonly<Record<string, Buffer>>,
): Promise<void> {
  const directory = join(transaction, name);
  await mkdir(directory, { mode: 0o700 });
  const directories = new Set<string>();
  for (const file of Object.keys(files)) {
    let parent = dirname(file);
    while (parent !== '.') {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const relativeDirectory of [...directories].sort(
    (left, right) => left.split('/').length - right.split('/').length,
  )) {
    const path = join(directory, relativeDirectory);
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  }
  for (const [file, bytes] of Object.entries(files)) {
    await writeNewDurableFile(directory, file, bytes);
    await syncDirectory(dirname(join(directory, file)));
  }
  await syncDirectory(directory);
  await syncDirectory(transaction);
}

async function writeNewDurableFile(
  directory: string,
  file: string,
  bytes: Uint8Array,
  afterWrite?: () => void,
): Promise<void> {
  const path = join(directory, file);
  let handle;
  let failure: unknown;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    afterWrite?.();
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    throw persistenceFailed(`Skill transaction artifact ${file} could not be written`, failure);
  }
}

async function readPreparedTransaction(
  directory: string,
  directoryName: string,
): Promise<PreparedTransaction | undefined> {
  await requireContainedDirectory(dirname(directory), directory);
  const intentPath = join(directory, INTENT_FILE);
  const intentStat = await safeLstat(intentPath);
  if (!intentStat) return undefined;
  const intentBytes = await readBoundedFile(directory, INTENT_FILE, INTENT_MAX_BYTES);
  const match = TRANSACTION_PATTERN.exec(directoryName);
  if (!match || sha256(intentBytes) !== match[2]) {
    throw persistenceFailed('Skill transaction intent was modified');
  }
  const intent = parseIntent(intentBytes);
  if (intent.transactionId !== match[1]) {
    throw persistenceFailed('Skill transaction identity does not match its directory');
  }
  return { directory, intent, intentBytes };
}

function parseIntent(bytes: Buffer): TransactionIntent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw persistenceFailed('Skill transaction intent is not valid UTF-8 JSON', error);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.transactionId !== 'string') {
    throw persistenceFailed('Skill transaction intent has an invalid envelope');
  }
  if (value.kind === 'publish') {
    requireExactKeys(value, ['kind', 'next', 'schemaVersion', 'skillId', 'transactionId']);
    assertSkillIdValue(value.skillId);
    const next = parseManifest(value.next, new Set([SKILL_FILE, LOCK_FILE, BASELINE_FILE]), true);
    if (!next[SKILL_FILE]) throw persistenceFailed('Skill publication is missing SKILL.md');
    return { ...value, next } as PublishIntent;
  }
  if (value.kind === 'replace-managed') {
    requireExactKeys(value, [
      'expected',
      'kind',
      'next',
      'schemaVersion',
      'skillId',
      'transactionId',
    ]);
    assertSkillIdValue(value.skillId);
    return {
      ...value,
      expected: parseManagedManifest(value.expected),
      next: parseManagedManifest(value.next),
    } as ReplaceIntent;
  }
  if (value.kind === 'delete-workspace') {
    requireExactKeys(value, ['expected', 'kind', 'schemaVersion', 'skillId', 'transactionId']);
    assertSkillIdValue(value.skillId);
    return {
      ...value,
      expected: parseManifest(value.expected, undefined, true),
    } as DeleteIntent;
  }
  throw persistenceFailed('Skill transaction intent kind is invalid');
}

function parseManagedManifest(value: unknown): ManagedManifest {
  const parsed = parseManifest(value, new Set(MANAGED_FILES), true);
  if (Object.keys(parsed).length !== MANAGED_FILES.length) {
    throw persistenceFailed('Managed Skill transaction manifest is incomplete');
  }
  return parsed as ManagedManifest;
}

function parseManifest(
  value: unknown,
  allowedFiles?: ReadonlySet<string>,
  allowNested = false,
): Readonly<Record<string, ArtifactDigest>> {
  if (!isRecord(value)) throw persistenceFailed('Skill transaction manifest is invalid');
  const result = Object.create(null) as Record<string, ArtifactDigest>;
  for (const [file, digest] of Object.entries(value)) {
    if (
      !(allowNested ? isSafeTreeFile(file) : isSafeRelativeFile(file)) ||
      (allowedFiles && !allowedFiles.has(file))
    ) {
      throw persistenceFailed('Skill transaction manifest contains an unsafe file');
    }
    if (
      !isRecord(digest) ||
      Object.keys(digest).sort().join(',') !== 'bytes,sha256' ||
      !Number.isSafeInteger(digest.bytes) ||
      (digest.bytes as number) < 0 ||
      typeof digest.sha256 !== 'string' ||
      !SHA256_PATTERN.test(digest.sha256)
    ) {
      throw persistenceFailed('Skill transaction manifest digest is invalid');
    }
    result[file] = { bytes: digest.bytes as number, sha256: digest.sha256 };
  }
  return result;
}

function isSafeTreeFile(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.startsWith('/')) return false;
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  return (
    normalized.length > 0 && normalized.split('/').every((segment) => isSafeRelativeFile(segment))
  );
}

async function verifyArtifactDirectory(
  directory: string,
  manifest: Readonly<Record<string, ArtifactDigest>>,
): Promise<void> {
  const resolved = await requireContainedDirectory(dirname(directory), directory);
  const expectedFiles = new Set(Object.keys(manifest));
  const expectedDirectories = new Set<string>();
  for (const file of expectedFiles) {
    let parent = dirname(file);
    while (parent !== '.') {
      expectedDirectories.add(parent);
      parent = dirname(parent);
    }
  }
  const visit = async (current: string, prefix: string): Promise<void> => {
    const expectedChildren = new Set<string>();
    for (const file of expectedFiles) {
      if (dirname(file) === (prefix || '.')) expectedChildren.add(basename(file));
    }
    for (const child of expectedDirectories) {
      if (dirname(child) === (prefix || '.')) expectedChildren.add(basename(child));
    }
    const entries = await safeReadDirectory(
      current,
      Math.max(ARTIFACT_MAX_ENTRIES, expectedChildren.size),
    );
    if (
      entries.length !== expectedChildren.size ||
      entries.some((entry) => !expectedChildren.has(entry.name))
    ) {
      throw persistenceFailed('Skill transaction artifact set was modified');
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw persistenceFailed('Skill transaction artifact contains a symbolic link');
      }
      if (expectedDirectories.has(relative)) {
        if (!entry.isDirectory()) {
          throw persistenceFailed('Skill transaction artifact directory has the wrong type');
        }
        await visit(join(current, entry.name), relative);
      } else {
        if (!entry.isFile()) {
          throw persistenceFailed('Skill transaction artifact must be a regular file');
        }
        await readVerifiedArtifact(resolved, relative, manifest[relative]);
      }
    }
  };
  await visit(resolved, '');
}

async function readVerifiedArtifact(
  directory: string,
  file: string,
  expected: ArtifactDigest,
): Promise<Buffer> {
  const bytes = await readBoundedFile(directory, file, limitForFile(file));
  if (!digestEquals(digest(bytes), expected)) {
    throw persistenceFailed(`Skill transaction artifact ${file} was modified`);
  }
  return bytes;
}

async function manifestDirectoryTree(
  root: string,
): Promise<Readonly<Record<string, ArtifactDigest>>> {
  const manifest = Object.create(null) as Record<string, ArtifactDigest>;
  const budget = { entries: 0, totalBytes: 0 };
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > DELETE_MAX_DEPTH) {
      throw persistenceFailed('Workspace Skill deletion tree exceeds its depth limit');
    }
    const remaining = DELETE_MAX_ENTRIES - budget.entries;
    for (const entry of await safeReadDirectory(directory, remaining)) {
      budget.entries += 1;
      if (entry.isSymbolicLink()) {
        throw persistenceFailed('Workspace Skill deletion refuses symbolic links');
      }
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (Buffer.byteLength(relativePath, 'utf8') > PATH_MAX_BYTES) {
        throw persistenceFailed('Workspace Skill deletion path exceeds its byte limit');
      }
      if (entry.isDirectory()) {
        await requireContainedDirectory(root, path);
        manifest[`${relativePath}/`] = digest(Buffer.alloc(0));
        assertDeletionManifestBound(manifest);
        await visit(path, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw persistenceFailed('Workspace Skill deletion tree is unsupported or too large');
      }
      const bytes = await readBoundedFile(directory, entry.name, DELETE_FILE_MAX_BYTES);
      budget.totalBytes += bytes.length;
      if (budget.totalBytes > DELETE_TOTAL_MAX_BYTES) {
        throw persistenceFailed('Workspace Skill deletion tree exceeds its byte limit');
      }
      manifest[relativePath] = digest(bytes);
      assertDeletionManifestBound(manifest);
    }
  };
  await visit(root, '', 0);
  return manifest;
}

function assertDeletionManifestBound(manifest: SkillDeletionManifest): void {
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > DELETE_MANIFEST_MAX_BYTES) {
    throw persistenceFailed('Workspace Skill deletion manifest exceeds its byte limit');
  }
}

async function verifyTreeManifest(
  root: string,
  expected: Readonly<Record<string, ArtifactDigest>>,
): Promise<void> {
  const actual = await manifestDirectoryTree(await requireContainedDirectory(dirname(root), root));
  const actualNames = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some(
      (name, index) => name !== expectedNames[index] || !digestEquals(actual[name], expected[name]),
    )
  ) {
    throw persistenceFailed('Workspace Skill deletion target changed after durable intent');
  }
}

async function digestBoundedFile(
  directory: string,
  file: string,
  maxBytes: number,
): Promise<ArtifactDigest> {
  return digest(await readBoundedFile(directory, file, maxBytes));
}

async function readBoundedFile(directory: string, file: string, maxBytes: number): Promise<Buffer> {
  if (!isSafeTreeFile(file)) throw persistenceFailed('Skill file name is unsafe');
  const path = join(directory, file);
  assertContained(directory, path);
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(path, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw persistenceFailed(`Skill file ${file} is not a bounded regular file`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw persistenceFailed(`Skill file ${file} exceeds its byte limit`);
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw persistenceFailed(`Skill file ${file} exceeds its byte limit`);
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof SkillCatalogTransactionError) throw error;
    throw persistenceFailed(`Skill file ${file} could not be read safely`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function finishTransaction(
  transactions: string,
  directory: string,
  failpoint?: (point: SkillCatalogTransactionFailpoint) => void,
): Promise<void> {
  const match = TRANSACTION_PATTERN.exec(basename(directory));
  if (!match) throw persistenceFailed('Active Skill transaction name is invalid');
  const gcDirectory = join(transactions, `gc-${match[1]}-${match[2]}`);
  await rename(directory, gcDirectory);
  failpoint?.('after_gc_handoff_rename_before_directory_sync');
  await syncDirectory(transactions);
  failpoint?.('after_gc_handoff');
  await cleanupGcEntry(transactions, gcDirectory, failpoint);
}

async function removePreIntentTransaction(transactions: string, directory: string): Promise<void> {
  const metadata = await safeLstat(directory);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw persistenceFailed('Pre-intent Skill transaction path is unsafe');
  }
  const match = TRANSACTION_PATTERN.exec(basename(directory));
  if (!match) throw persistenceFailed('Pre-intent Skill transaction name is invalid');
  const gcDirectory = join(transactions, `gc-${match[1]}-${match[2]}`);
  await rename(directory, gcDirectory);
  await syncDirectory(transactions);
  await cleanupGcEntry(transactions, gcDirectory);
}

async function requireMissing(path: string, message: string): Promise<void> {
  if (await safeLstat(path)) throw persistenceFailed(message);
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw persistenceFailed('Skill transaction path could not be inspected', error);
  }
}

async function cleanupGcEntry(
  transactions: string,
  gcDirectory: string,
  failpoint?: (point: SkillCatalogTransactionFailpoint) => void,
): Promise<void> {
  const root = await requireContainedDirectory(transactions, gcDirectory);
  const removals: { readonly path: string; readonly directory: boolean }[] = [];
  const budget = { entries: 0 };
  const visit = async (directory: string, relativePrefix: string, depth: number): Promise<void> => {
    if (depth > GC_MAX_DEPTH) {
      throw persistenceFailed('Skill transaction GC entry exceeds its depth limit');
    }
    const remaining = GC_MAX_ENTRIES - budget.entries;
    for (const entry of await safeReadDirectory(directory, remaining)) {
      budget.entries += 1;
      if (entry.isSymbolicLink()) {
        throw persistenceFailed('Skill transaction GC entry contains a symbolic link');
      }
      const path = join(directory, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (Buffer.byteLength(relativePath, 'utf8') > PATH_MAX_BYTES) {
        throw persistenceFailed('Skill transaction GC path exceeds its byte limit');
      }
      if (entry.isDirectory()) {
        await requireContainedDirectory(root, path);
        await visit(path, relativePath, depth + 1);
        removals.push({ path, directory: true });
      } else if (entry.isFile()) {
        removals.push({ path, directory: false });
      } else {
        throw persistenceFailed('Skill transaction GC entry contains an unsupported artifact');
      }
    }
  };
  await visit(root, '', 0);

  let removed = false;
  for (const entry of removals) {
    if (entry.directory) await rmdir(entry.path);
    else await unlink(entry.path);
    await syncDirectory(dirname(entry.path));
    if (!removed) {
      removed = true;
      failpoint?.('during_gc_cleanup');
    }
  }
  await rmdir(root);
  await syncDirectory(transactions);
}

async function safeReadDirectory(
  path: string,
  maxEntries: number,
): Promise<readonly SkillDirectoryEntry[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw persistenceFailed('Skill transaction directory entry budget is invalid');
  }
  let handle;
  const entries: SkillDirectoryEntry[] = [];
  let failure: unknown;
  try {
    handle = await opendir(path);
    for (;;) {
      const entry = await handle.read();
      if (!entry) break;
      if (entries.length >= maxEntries) {
        throw persistenceFailed('Skill transaction directory exceeds its entry limit');
      }
      entries.push(entry);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') failure ??= error;
    }
  }
  if (failure instanceof SkillCatalogTransactionError) throw failure;
  if (failure) throw persistenceFailed('Skill transaction directory could not be listed', failure);
  return entries;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    throw persistenceFailed('Skill transaction directory could not be synchronized', error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function artifactFiles(
  artifacts: SkillCatalogTransactionArtifacts,
): Readonly<Record<string, Buffer>> {
  const files: Record<string, Buffer> = { [SKILL_FILE]: toBuffer(artifacts.skill) };
  if (artifacts.lock !== undefined) files[LOCK_FILE] = toBuffer(artifacts.lock);
  if (artifacts.baseline !== undefined) files[BASELINE_FILE] = toBuffer(artifacts.baseline);
  validateArtifactSizes(files);
  return files;
}

function managedArtifactFiles(
  artifacts: ManagedSkillTransactionArtifacts,
): Readonly<Record<string, Buffer>> {
  const files = {
    [SKILL_FILE]: toBuffer(artifacts.skill),
    [LOCK_FILE]: toBuffer(artifacts.lock),
    [BASELINE_FILE]: toBuffer(artifacts.baseline),
  };
  validateArtifactSizes(files);
  return files;
}

function validateArtifactSizes(files: Readonly<Record<string, Buffer>>): void {
  for (const [file, bytes] of Object.entries(files)) {
    if (bytes.length > limitForFile(file)) {
      throw persistenceFailed(`Skill artifact ${file} exceeds its byte limit`);
    }
  }
}

function manifestForBuffers(
  files: Readonly<Record<string, Buffer>>,
): Readonly<Record<string, ArtifactDigest>> {
  return Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)]));
}

function serializeIntent(intent: TransactionIntent): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(intent)}\n`, 'utf8');
  if (bytes.length > INTENT_MAX_BYTES) {
    throw persistenceFailed('Skill transaction intent exceeds its byte limit');
  }
  return bytes;
}

function transactionDirectoryName(transactionId: string, intentBytes: Buffer): string {
  return `tx-${transactionId}-${sha256(intentBytes)}`;
}

function digest(bytes: Uint8Array): ArtifactDigest {
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function digestEquals(left: ArtifactDigest, right: ArtifactDigest): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBuffer(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

function limitForFile(file: string): number {
  return file === LOCK_FILE ? LOCK_MAX_BYTES : SKILL_MAX_BYTES;
}

function assertSkillId(value: string): void {
  assertSkillIdValue(value);
}

function assertSkillIdValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isSafeSkillId(value)) {
    throw persistenceFailed('Skill id is unsafe');
  }
}

function isSafeRelativeFile(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    basename(value) === value &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw persistenceFailed('Skill transaction intent contains unknown fields');
  }
}

function persistenceFailed(message: string, cause?: unknown): SkillCatalogTransactionError {
  return new SkillCatalogTransactionError('persistence_failed', message, { cause });
}

function commitOutcomeUnknown(message: string, cause: unknown): SkillCatalogTransactionError {
  return new SkillCatalogTransactionError('commit_outcome_unknown', message, { cause });
}
