import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rename,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from '@maka/core';
import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  ARTIFACT_PUBLICATION_STAGING_PATTERN,
  ARTIFACT_PURGE_INTENT_FILE,
  ARTIFACT_WRITER_LOCK_FILE,
  isCanonicalArtifactRecoveryTempName,
} from './artifact-storage-layout.js';
import { decodeArtifactMetadata } from './artifact-metadata-codec.js';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import { LONG_TERM_MEMORY_DATABASE_NAME } from './long-term-memory-store.js';
import { exportLegacySessionTreeSnapshot } from './session-metadata-maintenance.js';
import {
  encodeExecutionBoundaryTransfer,
  EXECUTION_BOUNDARY_TRANSFER_FILE,
} from './session-metadata-transfer.js';
import {
  LEGACY_SESSION_METADATA_DATABASE_NAME,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';
import { createSqliteSessionMetadataStore } from './sqlite-session-metadata-store.js';
import type { SessionAuthoritySnapshot } from './sqlite-session-metadata-store.js';
import { createSqliteRuntimeStore } from './sqlite-runtime-store.js';
import {
  artifactMetadataSourceFingerprint,
  createSqliteArtifactMetadataRepository,
} from './sqlite-artifact-metadata.js';

/**
 * The first bundle slice is deliberately an uncompressed state-tree export.
 * Compression, manifests, and activation inputs belong to later bundle work;
 * this module owns the trust boundary that all of those consumers must use.
 */
export const SESSION_BUNDLE_STATE_ENTRIES = ['sessions', 'artifacts', 'runtime.sqlite'] as const;

export const SESSION_BUNDLE_PORTABLE_SESSION_DIRECTORIES = [
  'deep-research',
  'projections',
  'runs',
  'shell-runs',
  'turn-admissions',
] as const;

export const SESSION_BUNDLE_PORTABLE_SESSION_FILES = [
  EXECUTION_BOUNDARY_TRANSFER_FILE,
  'plan-events.jsonl',
  'plans.json',
  'task-events.jsonl',
  'tasks.json',
] as const;

export const SESSION_BUNDLE_PROTECTED_ENTRIES = [
  '.maka-storage-root.json',
  '.maka_cli_claude_device_id',
  'credentials.json',
  'llm-connections.json',
  'settings.json',
  'automations.json',
  'mcp.json',
  'skills',
  'memory',
  'daily-reviews',
  'logs',
  'log',
  'activation.json',
  'activation-input.json',
  'task-runs',
  '.maka',
  ARTIFACT_WRITER_LOCK_FILE,
  LEGACY_SESSION_METADATA_DATABASE_NAME,
  `${LEGACY_SESSION_METADATA_DATABASE_NAME}-wal`,
  `${LEGACY_SESSION_METADATA_DATABASE_NAME}-shm`,
  `${LEGACY_SESSION_METADATA_DATABASE_NAME}-journal`,
  LONG_TERM_MEMORY_DATABASE_NAME,
  `${LONG_TERM_MEMORY_DATABASE_NAME}-wal`,
  `${LONG_TERM_MEMORY_DATABASE_NAME}-shm`,
  `${LONG_TERM_MEMORY_DATABASE_NAME}-journal`,
  'runtime.sqlite-wal',
  'runtime.sqlite-shm',
  'runtime.sqlite-journal',
] as const;

const allowedEntries = new Set<string>(SESSION_BUNDLE_STATE_ENTRIES);
const protectedEntries = new Set<string>(SESSION_BUNDLE_PROTECTED_ENTRIES);
const portableSessionDirectories = new Set<string>(SESSION_BUNDLE_PORTABLE_SESSION_DIRECTORIES);
const portableSessionFiles = new Set<string>(SESSION_BUNDLE_PORTABLE_SESSION_FILES);
const require = createRequire(import.meta.url);

export type SessionBundleExportErrorCode =
  | 'invalid_root'
  | 'overlapping_roots'
  | 'symlink'
  | 'path_escape'
  | 'unknown_entry'
  | 'unsupported_entry'
  | 'destination_not_empty';

export class SessionBundleExportError extends Error {
  constructor(
    readonly code: SessionBundleExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SessionBundleExportError';
  }
}

export interface SessionBundleRootLayoutInput {
  stateRoot: string;
  configRoot: string;
  /** Legacy callers intentionally use one shared root. */
  allowShared?: boolean;
}

export interface SessionBundleExportPlanEntry {
  relativePath: string;
  kind: 'file' | 'directory';
  source:
    | 'copy'
    | 'selected_session_metadata'
    | 'selected_session_boundary'
    | 'filtered_runtime_sqlite';
}

export interface SessionBundleExportPlan {
  stateRoot: string;
  configRoot: string;
  destinationRoot: string;
  sessionId: string;
  includedEntries: string[];
  excludedEntries: string[];
  entries: SessionBundleExportPlanEntry[];
}

export interface SessionBundleExportInput extends SessionBundleRootLayoutInput {
  destinationRoot: string;
  sessionId: string;
}

interface ArtifactMetadataSnapshot {
  artifactRootExists: boolean;
  metadataExists: boolean;
  canonicalText: string;
  selectedRecords: ArtifactRecord[];
}

interface PreparedSessionBundleExport {
  plan: SessionBundleExportPlan;
  artifactMetadata: ArtifactMetadataSnapshot;
  requestedDestinationRoot: string;
  stateRootIdentity: SessionBundleRootIdentity;
}

interface SessionBundleRoots {
  stateRoot: string;
  stateRootIdentity: SessionBundleRootIdentity;
  configRoot: string;
  destinationRoot: string;
}

interface SessionBundleRootIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * Validate the state/config split. Identical roots are accepted only for the
 * legacy compatibility path; nested roots are never safe because one root
 * could silently contain the other root's protected material.
 */
export async function assertSessionBundleRootLayout(
  input: SessionBundleRootLayoutInput,
): Promise<void> {
  const stateRoot = await canonicalizeExistingOrMissingRoot(input.stateRoot, 'state');
  const configRoot = await canonicalizeExistingOrMissingRoot(input.configRoot, 'config');
  assertRootsDoNotOverlap(stateRoot, configRoot, input.allowShared === true);
}

/**
 * Build an auditable export plan. Only the three session-owned top-level
 * entries are eligible. Known host/config entries are recorded as excluded;
 * any new top-level entry fails closed until it is explicitly classified.
 */
export async function planSessionBundleExport(
  input: SessionBundleExportInput,
): Promise<SessionBundleExportPlan> {
  return (await prepareSessionBundleExport(input)).plan;
}

async function prepareSessionBundleExport(
  input: SessionBundleExportInput,
): Promise<PreparedSessionBundleExport> {
  const { stateRoot, stateRootIdentity, configRoot, destinationRoot } =
    await resolveSessionBundleRoots(input);

  const includedEntries: string[] = [];
  const excludedEntries: string[] = [];
  const entries: SessionBundleExportPlanEntry[] = [];
  const artifactMetadata = await readArtifactMetadataSnapshot(stateRoot, input.sessionId);
  if (!artifactMetadata.artifactRootExists && artifactMetadata.selectedRecords.length > 0) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Artifact metadata references a missing artifacts root for session ${input.sessionId}`,
    );
  }
  let sessionsClassified = false;
  let artifactsClassified = false;
  const topLevelEntries = await readdir(stateRoot, { withFileTypes: true });
  for (const entry of topLevelEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = resolve(stateRoot, entry.name);
    assertNoSymlink(entry.isSymbolicLink(), entry.name);
    if (entry.name === 'sessions') {
      sessionsClassified = true;
      await planSelectedSessionTree(
        sourcePath,
        input.sessionId,
        stateRoot,
        excludedEntries,
        entries,
      );
      includedEntries.push(entry.name);
      continue;
    }
    if (entry.name === 'artifacts') {
      artifactsClassified = true;
      await planSelectedArtifactTree(
        sourcePath,
        input.sessionId,
        stateRoot,
        excludedEntries,
        entries,
        artifactMetadata,
      );
      includedEntries.push(entry.name);
      continue;
    }
    if (allowedEntries.has(entry.name)) {
      includedEntries.push(entry.name);
      if (entry.name === 'runtime.sqlite') {
        await assertFile(sourcePath, 'runtime SQLite', stateRoot, entry.name);
        entries.push({
          relativePath: entry.name,
          kind: 'file',
          source: 'filtered_runtime_sqlite',
        });
      } else {
        await inspectTree(sourcePath, entry.name, stateRoot, entries, 'copy');
      }
      continue;
    }
    if (isKnownProtectedEntry(entry.name)) {
      excludedEntries.push(entry.name);
      continue;
    }
    throw new SessionBundleExportError(
      'unknown_entry',
      `Session bundle export encountered an unclassified top-level entry: ${entry.name}`,
    );
  }
  if (!sessionsClassified) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle state root has no sessions tree: ${stateRoot}`,
    );
  }
  if (artifactsClassified !== artifactMetadata.artifactRootExists) {
    throw artifactMetadataChanged();
  }

  return {
    plan: {
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: input.sessionId,
      includedEntries,
      excludedEntries,
      entries,
    },
    artifactMetadata,
    requestedDestinationRoot: input.destinationRoot,
    stateRootIdentity,
  };
}

async function resolveSessionBundleRoots(
  input: SessionBundleExportInput,
): Promise<SessionBundleRoots> {
  assertSafeSessionId(input.sessionId);
  const stateRoot = await canonicalizeExistingRoot(input.stateRoot, 'state');
  const stateRootIdentity = await readSessionBundleRootIdentity(stateRoot);
  const configRoot = await canonicalizeExistingOrMissingRoot(input.configRoot, 'config');
  assertRootsDoNotOverlap(stateRoot, configRoot, input.allowShared === true);

  const destinationRoot = await canonicalizeExistingOrMissingRoot(
    input.destinationRoot,
    'destination',
  );
  assertRootsDoNotOverlap(stateRoot, destinationRoot, false);
  assertRootsDoNotOverlap(configRoot, destinationRoot, false);

  return { stateRoot, stateRootIdentity, configRoot, destinationRoot };
}

/**
 * Copy the planned state tree into an empty destination. This intentionally
 * does not create an archive; callers can add compression around this stable,
 * checked tree contract later without changing the policy.
 */
export async function exportSessionBundleState(
  input: SessionBundleExportInput,
): Promise<SessionBundleExportPlan> {
  const preflight = await resolveSessionBundleRoots(input);
  // A session_file reference is committed only after its Artifact create
  // returns. Keep Artifact mutations fenced through session projection so a
  // create cannot land between the Artifact snapshot and a copied reference.
  return withArtifactWriterLock(preflight.stateRoot, async () => {
    await assertSessionBundleRootIdentity(preflight.stateRoot, preflight.stateRootIdentity);
    const current = await prepareSessionBundleExport(input);
    if (
      current.plan.stateRoot !== preflight.stateRoot ||
      !sameSessionBundleRootIdentity(current.stateRootIdentity, preflight.stateRootIdentity)
    ) {
      throw new SessionBundleExportError(
        'invalid_root',
        'Session bundle state root changed before Artifact snapshot export',
      );
    }
    await ensureEmptyDestination(current.requestedDestinationRoot, current.plan.destinationRoot);
    await assertSessionBundleRootIdentity(preflight.stateRoot, preflight.stateRootIdentity);
    await exportPreparedArtifactState(current);
    await assertSessionBundleRootIdentity(preflight.stateRoot, preflight.stateRootIdentity);
    await exportPreparedNonArtifactState(current.plan, current.artifactMetadata);
    await assertSessionBundleRootIdentity(preflight.stateRoot, preflight.stateRootIdentity);
    return current.plan;
  });
}

async function exportPreparedArtifactState(prepared: PreparedSessionBundleExport): Promise<void> {
  const { plan, artifactMetadata } = prepared;
  const artifactEntries = plan.entries.filter((entry) => isArtifactEntry(entry));
  const directories = artifactEntries.filter((entry) => entry.kind === 'directory');
  const files = artifactEntries.filter((entry) => entry.kind === 'file' && entry.source === 'copy');
  for (const entry of directories) {
    await mkdir(resolve(plan.destinationRoot, entry.relativePath), { recursive: true });
  }
  for (const entry of files) {
    const sourcePath = resolve(plan.stateRoot, entry.relativePath);
    const destinationPath = resolve(plan.destinationRoot, entry.relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyCheckedFile(sourcePath, destinationPath, plan.stateRoot, entry.relativePath);
  }
  await assertNoCanonicalArtifactTransactionResidue(plan.stateRoot);
  await assertArtifactMetadataSnapshotUnchanged(plan.stateRoot, artifactMetadata);
}

async function exportPreparedNonArtifactState(
  plan: SessionBundleExportPlan,
  artifactMetadata: ArtifactMetadataSnapshot,
): Promise<void> {
  const entries = plan.entries.filter((entry) => !isArtifactEntry(entry));
  const directories = entries.filter((entry) => entry.kind === 'directory');
  const files = entries.filter((entry) => entry.kind === 'file' && entry.source === 'copy');
  for (const entry of directories) {
    await mkdir(resolve(plan.destinationRoot, entry.relativePath), { recursive: true });
  }
  for (const entry of files) {
    const sourcePath = resolve(plan.stateRoot, entry.relativePath);
    const destinationPath = resolve(plan.destinationRoot, entry.relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyCheckedFile(sourcePath, destinationPath, plan.stateRoot, entry.relativePath);
  }
  const authoritySnapshot = entries.some(
    (entry) =>
      entry.source === 'selected_session_metadata' || entry.source === 'selected_session_boundary',
  )
    ? await readSelectedSessionAuthoritySnapshot(plan)
    : undefined;
  for (const entry of entries) {
    if (entry.source === 'selected_session_metadata') {
      await exportSelectedSessionMetadata(plan, authoritySnapshot!);
    } else if (entry.source === 'selected_session_boundary') {
      await exportSelectedSessionBoundary(plan, authoritySnapshot!);
    } else if (entry.source === 'filtered_runtime_sqlite') {
      await exportFilteredRuntimeSqlite(plan, entry);
    }
  }
  await exportSqliteArtifactMetadata(plan.destinationRoot, artifactMetadata.selectedRecords);
}

function isArtifactEntry(entry: SessionBundleExportPlanEntry): boolean {
  return entry.relativePath === 'artifacts' || entry.relativePath.startsWith('artifacts/');
}

async function planSelectedSessionTree(
  sourcePath: string,
  sessionId: string,
  stateRoot: string,
  excludedEntries: string[],
  entries: SessionBundleExportPlanEntry[],
): Promise<void> {
  await assertDirectory(sourcePath, 'sessions root', stateRoot, 'sessions');
  entries.push({ relativePath: 'sessions', kind: 'directory', source: 'copy' });
  let selectedSessionFound = false;
  for (const entry of (await readdir(sourcePath, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const childPath = resolve(sourcePath, entry.name);
    assertNoSymlink(entry.isSymbolicLink(), `sessions/${entry.name}`);
    if (entry.name === sessionId) {
      selectedSessionFound = true;
      await assertDirectory(childPath, `session ${sessionId}`, stateRoot, `sessions/${sessionId}`);
      const transcriptPath = resolve(childPath, 'session.jsonl');
      await assertFile(
        transcriptPath,
        `session ${sessionId} transcript`,
        stateRoot,
        `sessions/${sessionId}/session.jsonl`,
      );
      const children = await readdir(childPath, { withFileTypes: true });
      for (const child of children) {
        const relativePath = `sessions/${sessionId}/${child.name}`;
        const portablePath = resolve(childPath, child.name);
        assertNoSymlink(child.isSymbolicLink(), relativePath);
        if (child.name === 'session.jsonl') continue;
        if (child.name === EXECUTION_BOUNDARY_TRANSFER_FILE) {
          await assertFile(
            portablePath,
            'portable execution boundary transfer',
            stateRoot,
            relativePath,
          );
          continue;
        }
        if (portableSessionDirectories.has(child.name)) {
          await assertDirectory(
            portablePath,
            `portable session entry ${child.name}`,
            stateRoot,
            relativePath,
          );
          await inspectTree(portablePath, relativePath, stateRoot, entries, 'copy');
          continue;
        }
        if (portableSessionFiles.has(child.name)) {
          await assertFile(
            portablePath,
            `portable session entry ${child.name}`,
            stateRoot,
            relativePath,
          );
          entries.push({ relativePath, kind: 'file', source: 'copy' });
          continue;
        }
        throw new SessionBundleExportError(
          'unknown_entry',
          `Session bundle export encountered an unclassified selected-session entry: ${relativePath}`,
        );
      }
      entries.push({
        relativePath: `sessions/${sessionId}`,
        kind: 'directory',
        source: 'copy',
      });
      entries.push({
        relativePath: `sessions/${sessionId}/session.jsonl`,
        kind: 'file',
        source: 'selected_session_metadata',
      });
      entries.push({
        relativePath: `sessions/${sessionId}/${EXECUTION_BOUNDARY_TRANSFER_FILE}`,
        kind: 'file',
        source: 'selected_session_boundary',
      });
      continue;
    }
    if (entry.isDirectory() && isSafeSessionId(entry.name)) {
      excludedEntries.push(`sessions/${entry.name}`);
      continue;
    }
    if (isKnownProtectedEntry(entry.name)) {
      excludedEntries.push(`sessions/${entry.name}`);
      continue;
    }
    throw new SessionBundleExportError(
      'unknown_entry',
      `Session bundle export encountered an unclassified sessions entry: ${entry.name}`,
    );
  }
  if (!selectedSessionFound) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle session does not exist: ${sessionId}`,
    );
  }
}

async function exportSelectedSessionMetadata(
  plan: SessionBundleExportPlan,
  snapshot: SessionAuthoritySnapshot,
): Promise<void> {
  const stagingRoot = `${plan.destinationRoot}.selected-session-${randomUUID()}`;
  try {
    await exportLegacySessionTreeSnapshot({
      workspaceRoot: plan.stateRoot,
      destinationRoot: stagingRoot,
      records: [snapshot.record],
      boundaries: new Map([[plan.sessionId, snapshot.boundary]]),
      sessionIds: [plan.sessionId],
    });
    const relativePath = `sessions/${plan.sessionId}/session.jsonl`;
    const sourcePath = resolve(stagingRoot, relativePath);
    const destinationPath = resolve(plan.destinationRoot, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyCheckedFile(sourcePath, destinationPath, stagingRoot, relativePath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function exportSelectedSessionBoundary(
  plan: SessionBundleExportPlan,
  snapshot: SessionAuthoritySnapshot,
): Promise<void> {
  const destinationPath = resolve(
    plan.destinationRoot,
    'sessions',
    plan.sessionId,
    EXECUTION_BOUNDARY_TRANSFER_FILE,
  );
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, encodeExecutionBoundaryTransfer(snapshot.boundary), 'utf8');
}

async function readSelectedSessionAuthoritySnapshot(
  plan: SessionBundleExportPlan,
): Promise<SessionAuthoritySnapshot> {
  const metadata = createSqliteSessionMetadataStore(
    resolve(plan.stateRoot, OPERATIONAL_STATE_DATABASE_NAME),
  );
  try {
    return await metadata.readSessionAuthoritySnapshot(plan.sessionId);
  } finally {
    metadata.close();
  }
}

async function planSelectedArtifactTree(
  sourcePath: string,
  sessionId: string,
  stateRoot: string,
  excludedEntries: string[],
  entries: SessionBundleExportPlanEntry[],
  artifactMetadata: ArtifactMetadataSnapshot,
): Promise<void> {
  if (!artifactMetadata.artifactRootExists) throw artifactMetadataChanged();
  await assertDirectory(sourcePath, 'artifacts root', stateRoot, 'artifacts');
  entries.push({ relativePath: 'artifacts', kind: 'directory', source: 'copy' });
  let metadataClassified = false;
  let selectedSessionDirectoryClassified = false;
  for (const entry of (await readdir(sourcePath, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const childPath = resolve(sourcePath, entry.name);
    assertNoSymlink(entry.isSymbolicLink(), `artifacts/${entry.name}`);
    if (entry.name === sessionId) {
      selectedSessionDirectoryClassified = true;
      await assertDirectory(
        childPath,
        `artifacts for session ${sessionId}`,
        stateRoot,
        `artifacts/${sessionId}`,
      );
      await planSelectedArtifactSessionTree(
        childPath,
        sessionId,
        stateRoot,
        entries,
        artifactMetadata.selectedRecords,
      );
      continue;
    }
    if (entry.name === 'metadata.jsonl') {
      metadataClassified = true;
      if (!artifactMetadata.metadataExists) throw artifactMetadataChanged();
      excludedEntries.push('artifacts/metadata.jsonl');
      continue;
    }
    if (
      entry.name === ARTIFACT_PURGE_INTENT_FILE ||
      isCanonicalArtifactRecoveryTempName(entry.name)
    ) {
      throwArtifactRecoveryRequired(`artifacts/${entry.name}`);
    }
    if (entry.isDirectory() && isSafeSessionId(entry.name)) {
      await assertNoArtifactPublicationResidue(childPath, entry.name);
      excludedEntries.push(`artifacts/${entry.name}`);
      continue;
    }
    if (isKnownProtectedEntry(entry.name)) {
      excludedEntries.push(`artifacts/${entry.name}`);
      continue;
    }
    throw new SessionBundleExportError(
      'unknown_entry',
      `Session bundle export encountered an unclassified artifacts entry: ${entry.name}`,
    );
  }
  if (metadataClassified !== artifactMetadata.metadataExists) throw artifactMetadataChanged();
  if (!selectedSessionDirectoryClassified && artifactMetadata.selectedRecords.length > 0) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Artifact metadata references a missing selected-session payload directory: artifacts/${sessionId}`,
    );
  }
}

async function planSelectedArtifactSessionTree(
  sourcePath: string,
  sessionId: string,
  stateRoot: string,
  entries: SessionBundleExportPlanEntry[],
  selectedRecords: readonly ArtifactRecord[],
): Promise<void> {
  const sessionRelativePath = `artifacts/${sessionId}`;
  const expectedByName = new Map(
    selectedRecords.map((record) => [basename(record.relativePath), record] as const),
  );
  const foundExpectedNames = new Set<string>();
  for (const entry of (await readdir(sourcePath, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relativePath = `${sessionRelativePath}/${entry.name}`;
    assertNoSymlink(entry.isSymbolicLink(), relativePath);
    assertArtifactPublicationEntryIsPortable(entry.name, relativePath);
    const expected = expectedByName.get(entry.name);
    if (expected) {
      await assertFile(
        resolve(sourcePath, entry.name),
        `artifact payload ${expected.id}`,
        stateRoot,
        relativePath,
      );
      foundExpectedNames.add(entry.name);
      continue;
    }
    if (entry.isFile()) {
      throwArtifactRecoveryRequired(relativePath);
    }
    if (entry.isDirectory()) {
      throw new SessionBundleExportError(
        'unknown_entry',
        `Session bundle export encountered an unclassified selected-session artifact entry: ${relativePath}`,
      );
    }
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Session bundle export cannot classify selected-session artifact entry: ${relativePath}`,
    );
  }
  for (const [name, record] of expectedByName) {
    if (foundExpectedNames.has(name)) continue;
    throw new SessionBundleExportError(
      'invalid_root',
      `Artifact metadata references a missing payload: artifacts/${record.relativePath}`,
    );
  }
  if (selectedRecords.length === 0) return;
  entries.push({ relativePath: sessionRelativePath, kind: 'directory', source: 'copy' });
  for (const record of selectedRecords) {
    entries.push({
      relativePath: `artifacts/${record.relativePath}`,
      kind: 'file',
      source: 'copy',
    });
  }
}

async function assertNoArtifactPublicationResidue(
  sessionArtifactRoot: string,
  sessionId: string,
): Promise<void> {
  for (const entry of await readdir(sessionArtifactRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('.artifact-publish.')) continue;
    const relativePath = `artifacts/${sessionId}/${entry.name}`;
    assertNoSymlink(entry.isSymbolicLink(), relativePath);
    assertArtifactPublicationEntryIsPortable(entry.name, relativePath);
  }
}

async function assertNoCanonicalArtifactTransactionResidue(stateRoot: string): Promise<void> {
  const artifactRoot = resolve(stateRoot, 'artifacts');
  let rootEntries;
  try {
    rootEntries = await readdir(artifactRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of rootEntries) {
    const relativePath = `artifacts/${entry.name}`;
    assertNoSymlink(entry.isSymbolicLink(), relativePath);
    if (
      entry.name === ARTIFACT_PURGE_INTENT_FILE ||
      isCanonicalArtifactRecoveryTempName(entry.name)
    ) {
      throwArtifactRecoveryRequired(relativePath);
    }
    if (entry.isDirectory() && isSafeSessionId(entry.name)) {
      await assertNoArtifactPublicationResidue(resolve(artifactRoot, entry.name), entry.name);
    }
  }
}

function assertArtifactPublicationEntryIsPortable(entryName: string, relativePath: string): void {
  if (ARTIFACT_PUBLICATION_STAGING_PATTERN.test(entryName)) {
    throwArtifactRecoveryRequired(relativePath);
  }
  if (entryName.startsWith('.artifact-publish.')) {
    throw new SessionBundleExportError(
      'unknown_entry',
      `Session bundle export encountered an unclassified artifact entry: ${relativePath}`,
    );
  }
}

function throwArtifactRecoveryRequired(relativePath: string): never {
  throw new SessionBundleExportError(
    'unsupported_entry',
    `Artifact write authority recovery is required before session bundle export: ${relativePath}`,
  );
}

async function readArtifactMetadataSnapshot(
  stateRoot: string,
  sessionId: string,
): Promise<ArtifactMetadataSnapshot> {
  const source = await readArtifactMetadataSource(stateRoot);
  let records: ArtifactRecord[];
  try {
    records = decodeArtifactMetadata(source.canonicalText);
  } catch (error) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      'Artifact metadata cannot be reopened by the Artifact store',
      { cause: error },
    );
  }
  const selectedRecords = records.filter((record) => record.sessionId === sessionId);
  return {
    ...source,
    selectedRecords,
  };
}

async function readArtifactMetadataSource(
  stateRoot: string,
): Promise<
  Pick<ArtifactMetadataSnapshot, 'artifactRootExists' | 'metadataExists' | 'canonicalText'>
> {
  const legacy = await readLegacyArtifactMetadataSource(stateRoot);
  const canonicalText = await readCanonicalSqliteArtifactMetadata(
    stateRoot,
    legacy.metadataExists ? legacy.canonicalText : undefined,
  );
  return canonicalText === undefined ? legacy : { ...legacy, canonicalText };
}

async function readLegacyArtifactMetadataSource(
  stateRoot: string,
): Promise<
  Pick<ArtifactMetadataSnapshot, 'artifactRootExists' | 'metadataExists' | 'canonicalText'>
> {
  const artifactRoot = resolve(stateRoot, 'artifacts');
  let artifactRootMetadata;
  try {
    artifactRootMetadata = await lstat(artifactRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { artifactRootExists: false, metadataExists: false, canonicalText: '' };
    }
    throw error;
  }
  assertNoSymlink(artifactRootMetadata.isSymbolicLink(), 'artifacts');
  await assertCanonicalPathInside(artifactRoot, stateRoot, 'artifacts');
  if (!artifactRootMetadata.isDirectory()) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Session bundle artifacts root is not a directory: ${artifactRoot}`,
    );
  }

  const metadataPath = resolve(artifactRoot, 'metadata.jsonl');
  let metadata;
  try {
    metadata = await lstat(metadataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { artifactRootExists: true, metadataExists: false, canonicalText: '' };
    }
    throw error;
  }
  assertNoSymlink(metadata.isSymbolicLink(), 'artifacts/metadata.jsonl');
  await assertCanonicalPathInside(metadataPath, stateRoot, 'artifacts/metadata.jsonl');
  if (!metadata.isFile()) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Session bundle artifact metadata is not a regular file: ${metadataPath}`,
    );
  }
  return {
    artifactRootExists: true,
    metadataExists: true,
    canonicalText: await readFile(metadataPath, 'utf8'),
  };
}

async function readCanonicalSqliteArtifactMetadata(
  stateRoot: string,
  legacySource: string | undefined,
): Promise<string | undefined> {
  const databasePath = resolve(stateRoot, OPERATIONAL_STATE_DATABASE_NAME);
  let metadata;
  try {
    metadata = await lstat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  assertNoSymlink(metadata.isSymbolicLink(), OPERATIONAL_STATE_DATABASE_NAME);
  await assertCanonicalPathInside(databasePath, stateRoot, OPERATIONAL_STATE_DATABASE_NAME);
  if (!metadata.isFile()) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Session bundle runtime SQLite is not a regular file: ${databasePath}`,
    );
  }

  const Database = loadDatabaseSync();
  const database = new Database(databasePath, { readOnly: true });
  let snapshotOpen = false;
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON');
    database.exec('BEGIN');
    snapshotOpen = true;
    if (!sqliteTableExists(database, 'cutover_journal')) return undefined;
    const journal = database
      .prepare(`
        SELECT source_fingerprint, state
        FROM cutover_journal
        WHERE store_name = 'artifact_metadata'
      `)
      .get() as { source_fingerprint?: unknown; state?: unknown } | undefined;
    if (!journal) {
      if (sqliteTableExists(database, 'artifact_records')) {
        const row = database.prepare('SELECT COUNT(*) AS count FROM artifact_records').get() as {
          count?: unknown;
        };
        if (row.count !== 0) {
          throw new SessionBundleExportError(
            'unsupported_entry',
            'Artifact SQLite rows exist without a completed cutover journal',
          );
        }
      }
      return undefined;
    }
    if (journal.state !== 'completed' || typeof journal.source_fingerprint !== 'string') {
      throw new SessionBundleExportError(
        'unsupported_entry',
        'Artifact metadata cutover must complete before session bundle export',
      );
    }
    if (journal.source_fingerprint !== artifactMetadataSourceFingerprint(legacySource)) {
      throw artifactMetadataChanged();
    }
    if (!sqliteTableExists(database, 'artifact_records')) {
      throw new SessionBundleExportError(
        'unsupported_entry',
        'Completed Artifact metadata cutover is missing artifact_records',
      );
    }
    const rows = database
      .prepare(`
        SELECT record_json
        FROM artifact_records
        ORDER BY created_at, storage_key
      `)
      .all() as Array<{ record_json?: unknown }>;
    if (rows.some((row) => typeof row.record_json !== 'string')) {
      throw new SessionBundleExportError(
        'unsupported_entry',
        'Artifact SQLite metadata contains an invalid record',
      );
    }
    return rows.length > 0 ? `${rows.map((row) => row.record_json as string).join('\n')}\n` : '';
  } finally {
    try {
      if (snapshotOpen) database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  }
}

async function assertArtifactMetadataSnapshotUnchanged(
  stateRoot: string,
  snapshot: ArtifactMetadataSnapshot,
): Promise<void> {
  const current = await readArtifactMetadataSource(stateRoot);
  if (
    current.artifactRootExists !== snapshot.artifactRootExists ||
    current.metadataExists !== snapshot.metadataExists ||
    current.canonicalText !== snapshot.canonicalText
  ) {
    throw artifactMetadataChanged();
  }
}

function artifactMetadataChanged(): SessionBundleExportError {
  return new SessionBundleExportError(
    'unsupported_entry',
    'Artifact metadata changed during session bundle export',
  );
}

async function assertDirectory(
  path: string,
  role: string,
  stateRoot: string,
  relativePath: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle ${role} does not exist: ${path}`,
      { cause: error },
    );
  }
  assertNoSymlink(metadata.isSymbolicLink(), relativePath);
  await assertCanonicalPathInside(path, stateRoot, relativePath);
  if (!metadata.isDirectory()) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Session bundle ${role} is not a directory: ${path}`,
    );
  }
}

async function assertFile(
  path: string,
  role: string,
  stateRoot: string,
  relativePath: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle ${role} does not exist: ${path}`,
      { cause: error },
    );
  }
  assertNoSymlink(metadata.isSymbolicLink(), relativePath);
  await assertCanonicalPathInside(path, stateRoot, relativePath);
  if (!metadata.isFile()) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Session bundle ${role} is not a regular file: ${path}`,
    );
  }
}

async function inspectTree(
  sourcePath: string,
  relativePath: string,
  stateRoot: string,
  entries: SessionBundleExportPlanEntry[],
  source: SessionBundleExportPlanEntry['source'],
): Promise<void> {
  const metadata = await lstat(sourcePath);
  assertNoSymlink(metadata.isSymbolicLink(), relativePath);
  await assertCanonicalPathInside(sourcePath, stateRoot, relativePath);

  if (metadata.isDirectory()) {
    entries.push({ relativePath, kind: 'directory', source: 'copy' });
    for (const child of (await readdir(sourcePath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      await inspectTree(
        resolve(sourcePath, child.name),
        `${relativePath}/${child.name}`,
        stateRoot,
        entries,
        'copy',
      );
    }
    return;
  }
  if (metadata.isFile()) {
    entries.push({ relativePath, kind: 'file', source });
    return;
  }
  throw new SessionBundleExportError(
    'unsupported_entry',
    `Session bundle export cannot include special file: ${relativePath}`,
  );
}

async function copyCheckedFile(
  sourcePath: string,
  destinationPath: string,
  stateRoot: string,
  relativePath: string,
): Promise<void> {
  const metadata = await lstat(sourcePath);
  assertNoSymlink(metadata.isSymbolicLink(), relativePath);
  await assertCanonicalPathInside(sourcePath, stateRoot, relativePath);
  if (!metadata.isFile()) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Session bundle export source changed before copy: ${relativePath}`,
    );
  }
  await copyFile(sourcePath, destinationPath);
}

async function exportFilteredRuntimeSqlite(
  plan: SessionBundleExportPlan,
  entry: SessionBundleExportPlanEntry,
): Promise<void> {
  const sourcePath = resolve(plan.stateRoot, entry.relativePath);
  const destinationPath = resolve(plan.destinationRoot, entry.relativePath);
  await assertFile(sourcePath, 'runtime SQLite', plan.stateRoot, entry.relativePath);

  const source = createSqliteRuntimeStore(sourcePath);
  const filteredPath = `${destinationPath}.filtered`;
  try {
    const destination = createSqliteRuntimeStore(filteredPath);
    try {
      const eventsByRun = new Map<
        string,
        { sessionId: string; runId: string; events: RuntimeEvent[] }
      >();
      for (const event of await source.readSessionRuntimeEvents(plan.sessionId)) {
        const batch = eventsByRun.get(event.runId) ?? {
          sessionId: plan.sessionId,
          runId: event.runId,
          events: [],
        };
        batch.events.push(event);
        eventsByRun.set(event.runId, batch);
      }
      for (const batch of eventsByRun.values()) await destination.importRuntimeEventsBatch(batch);
      await destination.rebuildToolProjectionsFromRuntimeEvents();
    } finally {
      destination.close();
    }
  } finally {
    source.close();
  }
  await rename(filteredPath, destinationPath);
}

async function exportSqliteArtifactMetadata(
  destinationRoot: string,
  records: readonly ArtifactRecord[],
): Promise<void> {
  const repository = createSqliteArtifactMetadataRepository(destinationRoot);
  try {
    await repository.ready();
    repository.replaceAll(records);
    const reopened = repository.readAll();
    if (!sameArtifactRecordSet(reopened, records)) {
      throw new SessionBundleExportError(
        'unsupported_entry',
        'Exported Artifact SQLite metadata failed validation',
      );
    }
  } finally {
    repository.close();
  }
}

function sameArtifactRecordSet(
  left: readonly ArtifactRecord[],
  right: readonly ArtifactRecord[],
): boolean {
  if (left.length !== right.length) return false;
  const canonical = (records: readonly ArtifactRecord[]) =>
    records.map((record) => JSON.stringify(record)).sort((a, b) => a.localeCompare(b));
  const leftRecords = canonical(left);
  const rightRecords = canonical(right);
  return leftRecords.every((record, index) => record === rightRecords[index]);
}

async function ensureEmptyDestination(requestedPath: string, canonicalPath: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(resolve(requestedPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(resolve(requestedPath), { recursive: true });
    return;
  }
  assertNoSymlink(metadata.isSymbolicLink(), 'destination root');
  if (!metadata.isDirectory()) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle destination is not a directory: ${requestedPath}`,
    );
  }
  const entries = await readdir(canonicalPath);
  if (entries.length > 0) {
    throw new SessionBundleExportError(
      'destination_not_empty',
      `Session bundle export destination must be empty: ${requestedPath}`,
    );
  }
}

async function canonicalizeExistingRoot(path: string, role: string): Promise<string> {
  const requestedPath = resolve(path);
  let metadata;
  try {
    metadata = await lstat(requestedPath);
  } catch (error) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle ${role} root does not exist: ${requestedPath}`,
      { cause: error },
    );
  }
  assertNoSymlink(metadata.isSymbolicLink(), `${role} root`);
  if (!metadata.isDirectory()) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle ${role} root is not a directory: ${requestedPath}`,
    );
  }
  return realpath(requestedPath);
}

async function readSessionBundleRootIdentity(
  stateRoot: string,
): Promise<SessionBundleRootIdentity> {
  let metadata;
  try {
    metadata = await lstat(stateRoot, { bigint: true });
  } catch (error) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Unable to inspect session bundle state root identity: ${stateRoot}`,
      { cause: error },
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle state root identity is not a directory: ${stateRoot}`,
    );
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertSessionBundleRootIdentity(
  stateRoot: string,
  expected: SessionBundleRootIdentity,
): Promise<void> {
  const actual = await readSessionBundleRootIdentity(stateRoot);
  if (!sameSessionBundleRootIdentity(actual, expected)) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle state root changed during export: ${stateRoot}`,
    );
  }
}

function sameSessionBundleRootIdentity(
  left: SessionBundleRootIdentity,
  right: SessionBundleRootIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalizeExistingOrMissingRoot(path: string, role: string): Promise<string> {
  const requestedPath = resolve(path);
  let metadata;
  try {
    metadata = await lstat(requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SessionBundleExportError(
        'invalid_root',
        `Unable to inspect session bundle ${role} root: ${requestedPath}`,
        { cause: error },
      );
    }
    const { parent, suffix } = await nearestExistingDirectoryWithSuffix(requestedPath, role);
    return resolve(parent, ...suffix);
  }
  assertNoSymlink(metadata.isSymbolicLink(), `${role} root`);
  if (!metadata.isDirectory()) {
    throw new SessionBundleExportError(
      'invalid_root',
      `Session bundle ${role} root is not a directory: ${requestedPath}`,
    );
  }
  return realpath(requestedPath);
}

async function nearestExistingDirectoryWithSuffix(
  path: string,
  role: string,
): Promise<{ parent: string; suffix: string[] }> {
  let candidate = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const metadata = await lstat(candidate);
      assertNoSymlink(metadata.isSymbolicLink(), `${role} root parent`);
      if (!metadata.isDirectory()) {
        throw new SessionBundleExportError(
          'invalid_root',
          `Session bundle ${role} root parent is not a directory: ${candidate}`,
        );
      }
      return { parent: await realpath(candidate), suffix: suffix.reverse() };
    } catch (error) {
      if (error instanceof SessionBundleExportError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SessionBundleExportError(
          'invalid_root',
          `Unable to resolve session bundle ${role} root parent: ${candidate}`,
          { cause: error },
        );
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new SessionBundleExportError(
          'invalid_root',
          `Unable to resolve session bundle ${role} root parent: ${candidate}`,
        );
      }
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

function assertRootsDoNotOverlap(left: string, right: string, allowSame: boolean): void {
  if (left === right) {
    if (allowSame) return;
    throw new SessionBundleExportError(
      'overlapping_roots',
      `Session bundle roots overlap at ${left}`,
    );
  }
  if (isPathInside(left, right) || isPathInside(right, left)) {
    throw new SessionBundleExportError(
      'overlapping_roots',
      `Session bundle roots overlap unsafely: ${left} and ${right}`,
    );
  }
}

async function assertCanonicalPathInside(
  path: string,
  root: string,
  relativePath: string,
): Promise<void> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    throw new SessionBundleExportError(
      'path_escape',
      `Unable to resolve exported path: ${relativePath}`,
      { cause: error },
    );
  }
  if (!isPathInside(root, canonicalPath)) {
    throw new SessionBundleExportError(
      'path_escape',
      `Exported path escapes the state root: ${relativePath}`,
    );
  }
}

function assertNoSymlink(isSymlink: boolean, relativePath: string): void {
  if (isSymlink) {
    throw new SessionBundleExportError(
      'symlink',
      `Session bundle export rejects symlinks: ${relativePath}`,
    );
  }
}

function isKnownProtectedEntry(name: string): boolean {
  return (
    protectedEntries.has(name) ||
    name === 'tmp' ||
    name === 'activation-input' ||
    name.endsWith('.log')
  );
}

function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new SessionBundleExportError('invalid_root', `Invalid session id: ${sessionId}`);
  }
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}

export function isArtifactPathForSession(relativePath: string, sessionId: string): boolean {
  const parts = relativePath.split(/[\\/]+/);
  return (
    parts.length >= 2 &&
    parts[0] === sessionId &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function sqliteTableExists(database: DatabaseSync, table: string): boolean {
  return (
    database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  );
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}
