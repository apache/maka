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
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RuntimeEvent } from '@maka/core';
import { exportLegacySessionTree } from './session-metadata-maintenance.js';
import { SQLITE_SESSION_METADATA_DATABASE_NAME } from './session-store.js';
import { createSqliteRuntimeStore } from './sqlite-runtime-store.js';

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
  'agent-mailbox.jsonl',
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
  '.maka',
  SQLITE_SESSION_METADATA_DATABASE_NAME,
  `${SQLITE_SESSION_METADATA_DATABASE_NAME}-wal`,
  `${SQLITE_SESSION_METADATA_DATABASE_NAME}-shm`,
  `${SQLITE_SESSION_METADATA_DATABASE_NAME}-journal`,
  'runtime.sqlite-wal',
  'runtime.sqlite-shm',
  'runtime.sqlite-journal',
] as const;

const allowedEntries = new Set<string>(SESSION_BUNDLE_STATE_ENTRIES);
const protectedEntries = new Set<string>(SESSION_BUNDLE_PROTECTED_ENTRIES);
const portableSessionDirectories = new Set<string>(SESSION_BUNDLE_PORTABLE_SESSION_DIRECTORIES);
const portableSessionFiles = new Set<string>(SESSION_BUNDLE_PORTABLE_SESSION_FILES);

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
    | 'filtered_artifact_metadata'
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
  assertSafeSessionId(input.sessionId);
  const stateRoot = await canonicalizeExistingRoot(input.stateRoot, 'state');
  const configRoot = await canonicalizeExistingOrMissingRoot(input.configRoot, 'config');
  assertRootsDoNotOverlap(stateRoot, configRoot, input.allowShared === true);

  const destinationRoot = await canonicalizeExistingOrMissingRoot(
    input.destinationRoot,
    'destination',
  );
  assertRootsDoNotOverlap(stateRoot, destinationRoot, false);
  assertRootsDoNotOverlap(configRoot, destinationRoot, false);

  const includedEntries: string[] = [];
  const excludedEntries: string[] = [];
  const entries: SessionBundleExportPlanEntry[] = [];
  let sessionsClassified = false;
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
      await planSelectedArtifactTree(
        sourcePath,
        input.sessionId,
        stateRoot,
        excludedEntries,
        entries,
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

  return {
    stateRoot,
    configRoot,
    destinationRoot,
    sessionId: input.sessionId,
    includedEntries,
    excludedEntries,
    entries,
  };
}

/**
 * Copy the planned state tree into an empty destination. This intentionally
 * does not create an archive; callers can add compression around this stable,
 * checked tree contract later without changing the policy.
 */
export async function exportSessionBundleState(
  input: SessionBundleExportInput,
): Promise<SessionBundleExportPlan> {
  const plan = await planSessionBundleExport(input);
  await ensureEmptyDestination(input.destinationRoot, plan.destinationRoot);

  const directories = plan.entries.filter((entry) => entry.kind === 'directory');
  const files = plan.entries.filter((entry) => entry.kind === 'file' && entry.source === 'copy');
  for (const entry of directories) {
    await mkdir(resolve(plan.destinationRoot, entry.relativePath), { recursive: true });
  }
  for (const entry of files) {
    const sourcePath = resolve(plan.stateRoot, entry.relativePath);
    const destinationPath = resolve(plan.destinationRoot, entry.relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyCheckedFile(sourcePath, destinationPath, plan.stateRoot, entry.relativePath);
  }
  for (const entry of plan.entries) {
    if (entry.source === 'selected_session_metadata') {
      await exportSelectedSessionMetadata(plan);
    } else if (entry.source === 'filtered_artifact_metadata') {
      await exportFilteredArtifactMetadata(plan, entry);
    } else if (entry.source === 'filtered_runtime_sqlite') {
      await exportFilteredRuntimeSqlite(plan, entry);
    }
  }
  return plan;
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
        assertNoSymlink(child.isSymbolicLink(), relativePath);
        if (child.name === 'session.jsonl') continue;
        const portablePath = resolve(childPath, child.name);
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

async function exportSelectedSessionMetadata(plan: SessionBundleExportPlan): Promise<void> {
  const stagingRoot = `${plan.destinationRoot}.selected-session-${randomUUID()}`;
  try {
    await exportLegacySessionTree({
      workspaceRoot: plan.stateRoot,
      destinationRoot: stagingRoot,
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

async function planSelectedArtifactTree(
  sourcePath: string,
  sessionId: string,
  stateRoot: string,
  excludedEntries: string[],
  entries: SessionBundleExportPlanEntry[],
): Promise<void> {
  await assertDirectory(sourcePath, 'artifacts root', stateRoot, 'artifacts');
  entries.push({ relativePath: 'artifacts', kind: 'directory', source: 'copy' });
  for (const entry of (await readdir(sourcePath, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const childPath = resolve(sourcePath, entry.name);
    assertNoSymlink(entry.isSymbolicLink(), `artifacts/${entry.name}`);
    if (entry.name === sessionId) {
      await assertDirectory(
        childPath,
        `artifacts for session ${sessionId}`,
        stateRoot,
        `artifacts/${sessionId}`,
      );
      await inspectTree(childPath, `artifacts/${sessionId}`, stateRoot, entries, 'copy');
      continue;
    }
    if (entry.name === 'metadata.jsonl') {
      await assertFile(childPath, 'artifact metadata', stateRoot, 'artifacts/metadata.jsonl');
      entries.push({
        relativePath: 'artifacts/metadata.jsonl',
        kind: 'file',
        source: 'filtered_artifact_metadata',
      });
      continue;
    }
    if (entry.isDirectory() && isSafeSessionId(entry.name)) {
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

async function exportFilteredArtifactMetadata(
  plan: SessionBundleExportPlan,
  entry: SessionBundleExportPlanEntry,
): Promise<void> {
  const sourcePath = resolve(plan.stateRoot, entry.relativePath);
  await assertCanonicalPathInside(sourcePath, plan.stateRoot, entry.relativePath);
  const metadata = await lstat(sourcePath);
  assertNoSymlink(metadata.isSymbolicLink(), entry.relativePath);
  if (!metadata.isFile()) {
    throw new SessionBundleExportError(
      'unsupported_entry',
      `Artifact metadata source changed before export: ${entry.relativePath}`,
    );
  }
  const selectedLines: string[] = [];
  for (const [index, line] of (await readFile(sourcePath, 'utf8')).split('\n').entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new SessionBundleExportError(
        'unsupported_entry',
        `Artifact metadata contains invalid JSON at line ${index + 1}`,
        { cause: error },
      );
    }
    if (!isArtifactMetadataRecord(record)) {
      throw new SessionBundleExportError(
        'unsupported_entry',
        `Artifact metadata contains an invalid record at line ${index + 1}`,
      );
    }
    if (record.sessionId !== plan.sessionId) continue;
    if (!isArtifactPathForSession(record.relativePath, plan.sessionId)) {
      throw new SessionBundleExportError(
        'path_escape',
        `Artifact metadata path does not belong to session ${plan.sessionId}: ${record.relativePath}`,
      );
    }
    selectedLines.push(line);
  }
  const destinationPath = resolve(plan.destinationRoot, entry.relativePath);
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, selectedLines.length > 0 ? `${selectedLines.join('\n')}\n` : '');
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
    name.endsWith('.log') ||
    name.startsWith('metadata.jsonl.')
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

function isArtifactMetadataRecord(
  value: unknown,
): value is { sessionId: string; relativePath: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === 'string' && typeof record.relativePath === 'string';
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
