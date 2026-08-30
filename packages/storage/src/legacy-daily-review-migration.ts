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

import { createHash } from 'node:crypto';
import { readFile, readdir, rm, rmdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import type { StoredMessage } from '@maka/core/session';
import type { InteractiveArtifactStoreWriter } from './artifact-stores.js';
import type { ExecutionSessionWriter } from './execution-stores.js';
import { acquireOperationalStateDatabase } from './operational-state-store.js';
import { assertReleasedDailyReviewMigrationShape } from './operational-target-schema.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from './root-authority.js';
import type { RuntimePolicyStoresWriter } from './runtime-policy-stores.js';
import type { InteractiveScheduledTaskStoreWriter } from './scheduled-task-store.js';

export const DAILY_REVIEW_SYSTEM_TASK_ID = 'system-daily-review';

export const DAILY_REVIEW_SCHEDULED_TASK_INTENT = `Review the previous local day of Maka work using ordinary Session history. Identify completed work, unfinished or missed follow-ups, and useful patterns. Write a concise Markdown report and save it as a normal Session artifact. Do not use a dedicated Daily Review store or archive.`;

const LEGACY_REQUIRED_TABLES = [
  'workflow_daily_review_state',
  'workflow_daily_review_archives',
] as const;

const LEGACY_TABLES = [...LEGACY_REQUIRED_TABLES, 'workflow_daily_review_authority_state'] as const;
const LEGACY_FILE_ARCHIVE_ID = /^\d{4}-\d{2}-\d{2}-(?:1d|7d|30d|daily|deep)$/u;

export interface LegacyDailyReviewConfig {
  readonly enabled: boolean;
  readonly executeTime: string;
  readonly modelKey: string;
}

export interface LegacyDailyReviewArchive {
  readonly id: string;
  readonly day: { readonly fromMs: number; readonly toMs: number };
  readonly range: 1 | 7 | 30;
  readonly status: 'ok' | 'no_model' | 'no_data' | 'failed' | 'skipped';
  readonly generatedAt: number;
  readonly trigger: 'cron' | 'manual';
  readonly modelKey: string;
  readonly sections: Readonly<{
    summary?: string;
    gaps?: string;
    usage?: string;
    code?: string;
  }>;
  readonly totals: Readonly<{
    sessionCount: number;
    requestCount: number;
    totalTokens: number;
    costUsd: number;
    errorCount: number;
  }>;
  readonly errorMessage?: string;
}

export interface LegacyDailyReviewMigrationSnapshot {
  readonly token: `sha256:${string}`;
  readonly config: LegacyDailyReviewConfig;
  readonly archives: readonly LegacyDailyReviewArchive[];
}

export interface LegacyDailyReviewMigrationWriter {
  read(): Promise<LegacyDailyReviewMigrationSnapshot | null>;
  retireArchives(token: LegacyDailyReviewMigrationSnapshot['token']): Promise<boolean>;
  retire(token: LegacyDailyReviewMigrationSnapshot['token']): Promise<boolean>;
  close(): void;
}

export async function migrateLegacyDailyReview(input: {
  readonly legacy: LegacyDailyReviewMigrationWriter;
  readonly scheduledTasks: InteractiveScheduledTaskStoreWriter;
  readonly sessions: Pick<
    ExecutionSessionWriter,
    'createStableSession' | 'readMessagesSnapshot' | 'appendMessage'
  >;
  readonly artifacts: InteractiveArtifactStoreWriter;
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly workspaceRoot: string;
  readonly now?: () => number;
}): Promise<boolean> {
  const snapshot = await input.legacy.read();
  if (snapshot === null) return false;
  const now = input.now?.() ?? Date.now();
  for (const archive of snapshot.archives) {
    await migrateArchive(input, archive);
  }
  let retirementToken = snapshot.token;
  if (snapshot.archives.length > 0) {
    if (!(await input.legacy.retireArchives(snapshot.token))) {
      throw new Error('Legacy Daily Review state disappeared during migration');
    }
    const remainder = await input.legacy.read();
    if (remainder === null) return true;
    retirementToken = remainder.token;
  }
  if (!snapshot.config.enabled) {
    if (!(await input.legacy.retire(retirementToken))) {
      throw new Error('Legacy Daily Review state disappeared during migration');
    }
    return true;
  }
  const existingTask = findExistingDailyReviewTask(await input.scheduledTasks.list());
  if (existingTask && !isCompatibleDailyReviewReplacement(existingTask)) return false;
  const task = existingTask ?? (await createSystemDailyReviewTask(input, snapshot, now));
  // The legacy scheduler accepted an enabled configuration before a model was
  // configured. Keep that inert configuration as the one-shot source until a
  // canonical replacement can be installed.
  if (task === undefined) return false;
  if (task.status === 'active' && needsLegacyCatchUp(snapshot, now)) {
    await input.scheduledTasks.makeDueNow(task.id, now);
  }
  if (!(await input.legacy.retire(retirementToken))) {
    throw new Error('Legacy Daily Review state disappeared during migration');
  }
  return true;
}

function findExistingDailyReviewTask(tasks: readonly ScheduledTask[]): ScheduledTask | undefined {
  return (
    tasks.find((task) => task.id === DAILY_REVIEW_SYSTEM_TASK_ID) ??
    tasks.find((task) => task.presetId === 'daily-review')
  );
}

function isCompatibleDailyReviewReplacement(task: ScheduledTask): boolean {
  if (task.id === DAILY_REVIEW_SYSTEM_TASK_ID && task.createdBy.kind !== 'system') return false;
  return (
    (task.status === 'active' || task.status === 'paused') &&
    task.effect.kind === 'agent_run' &&
    Boolean(task.effect.execution.llmConnectionId)
  );
}

async function createSystemDailyReviewTask(
  input: Parameters<typeof migrateLegacyDailyReview>[0],
  snapshot: LegacyDailyReviewMigrationSnapshot,
  now: number,
): Promise<ScheduledTask | undefined> {
  const target = await resolveExecutionTarget(snapshot.config.modelKey, input.runtimePolicy);
  if (target === undefined) return undefined;
  return input.scheduledTasks.ensureSystemTask(
    DAILY_REVIEW_SYSTEM_TASK_ID,
    {
      title: 'Daily Review',
      presetId: 'daily-review',
      intentBody: DAILY_REVIEW_SCHEDULED_TASK_INTENT,
      schedule: {
        kind: 'calendar',
        recurrence: 'daily',
        anchorAt: localAnchorAt(now, snapshot.config.executeTime),
        catchUp: 'once',
      },
      effect: {
        kind: 'agent_run',
        execution: {
          cwd: input.workspaceRoot,
          projectId: null,
          llmConnectionId: target.connectionId,
          llmConnectionSlug: target.connectionSlug,
          model: target.model,
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
      createdBy: { kind: 'system' },
    },
    now,
  );
}

export async function openLegacyDailyReviewMigrationForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<LegacyDailyReviewMigrationWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  let closed = false;
  const run = <T>(operation: (root: string) => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Legacy Daily Review migration is closed'));
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const read = async (root: string): Promise<LegacyDailyReviewMigrationSources | null> => {
    const database = acquireOperationalStateDatabase(root);
    try {
      const databaseSnapshot = database.transaction('read', () =>
        readDatabaseSnapshot(database.database),
      );
      const fileSnapshot = await readFileSnapshot(root);
      if (databaseSnapshot === null && fileSnapshot === null) return null;
      const archives = new Map<string, LegacyDailyReviewArchive>();
      for (const archive of fileSnapshot?.snapshot.archives ?? [])
        archives.set(archive.id, archive);
      for (const archive of databaseSnapshot?.archives ?? []) archives.set(archive.id, archive);
      const snapshot: LegacyDailyReviewMigrationSnapshot = {
        token: sha256(
          JSON.stringify({
            database: databaseSnapshot?.token ?? null,
            files: fileSnapshot?.snapshot.token ?? null,
          }),
        ),
        config:
          databaseSnapshot?.config ?? fileSnapshot?.snapshot.config ?? decodeConfig(undefined),
        archives: [...archives.values()].sort((left, right) => left.id.localeCompare(right.id)),
      };
      return { snapshot, fileSnapshot };
    } finally {
      database.close();
    }
  };
  return Object.freeze({
    read: () => run(async (root) => (await read(root))?.snapshot ?? null),
    retireArchives: (token: LegacyDailyReviewMigrationSnapshot['token']) =>
      run(async (root) => {
        const current = await read(root);
        if (current === null) return false;
        if (current.snapshot.token !== token) {
          throw new Error('Legacy Daily Review state changed during migration');
        }
        const database = acquireOperationalStateDatabase(root);
        try {
          database.transaction('write', () => {
            if (tableExists(database.database, 'workflow_daily_review_archives')) {
              database.database.exec('DELETE FROM workflow_daily_review_archives;');
            }
          });
        } finally {
          database.close();
        }
        if (current.fileSnapshot) await retireFileArchives(root, current.fileSnapshot);
        return true;
      }),
    retire: (token: LegacyDailyReviewMigrationSnapshot['token']) =>
      run(async (root) => {
        const current = await read(root);
        if (current === null) return false;
        if (current.snapshot.token !== token) {
          throw new Error('Legacy Daily Review state changed during migration');
        }
        const database = acquireOperationalStateDatabase(root);
        try {
          database.transaction('write', () => {
            database.database.exec(`
              DROP INDEX IF EXISTS workflow_daily_review_archives_order;
              DROP TABLE IF EXISTS workflow_daily_review_archives;
              DROP TABLE IF EXISTS workflow_daily_review_authority_state;
              DROP TABLE IF EXISTS workflow_daily_review_state;
            `);
          });
        } finally {
          database.close();
        }
        if (current.fileSnapshot) await retireFileSnapshot(root, current.fileSnapshot);
        return true;
      }),
    close: () => {
      closed = true;
    },
  });
}

interface LegacyDailyReviewMigrationSources {
  readonly snapshot: LegacyDailyReviewMigrationSnapshot;
  readonly fileSnapshot: LegacyDailyReviewFileSnapshot | null;
}

interface LegacyDailyReviewFileSnapshot {
  readonly snapshot: LegacyDailyReviewMigrationSnapshot;
  readonly hasConfig: boolean;
  readonly archiveFileNames: readonly string[];
}

async function readFileSnapshot(root: string): Promise<LegacyDailyReviewFileSnapshot | null> {
  const dailyReviewRoot = join(root, 'daily-reviews');
  const configPath = join(dailyReviewRoot, 'config.json');
  let configJson: string | undefined;
  try {
    configJson = await readFile(configPath, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const archiveRoot = join(dailyReviewRoot, 'archive');
  let archiveFileNames: string[] = [];
  try {
    archiveFileNames = (await readdir(archiveRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .filter((name) => LEGACY_FILE_ARCHIVE_ID.test(name.slice(0, -'.json'.length)))
      .sort();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const archiveRecords = await Promise.all(
    archiveFileNames.map(async (name) => ({
      name,
      raw: await readFile(join(archiveRoot, name), 'utf8'),
    })),
  );
  const readableArchives: Array<{
    readonly name: string;
    readonly raw: string;
    readonly archive: LegacyDailyReviewArchive;
  }> = [];
  for (const record of archiveRecords) {
    try {
      readableArchives.push({
        ...record,
        archive: decodeArchiveFile(record.name.slice(0, -'.json'.length), record.raw),
      });
    } catch {
      // Released file stores treated an invalid archive as missing. Keep the
      // unreadable file in place while allowing healthy siblings to migrate.
    }
  }
  if (configJson === undefined && readableArchives.length === 0) return null;
  return {
    snapshot: {
      token: sha256(JSON.stringify({ configJson: configJson ?? null, archives: readableArchives })),
      config: decodeConfig(configJson),
      archives: readableArchives.map(({ archive }) => archive),
    },
    hasConfig: configJson !== undefined,
    archiveFileNames: readableArchives.map(({ name }) => name),
  };
}

async function retireFileSnapshot(
  root: string,
  snapshot: LegacyDailyReviewFileSnapshot,
): Promise<void> {
  const dailyReviewRoot = join(root, 'daily-reviews');
  const archiveRoot = join(dailyReviewRoot, 'archive');
  if (snapshot.hasConfig) await rm(join(dailyReviewRoot, 'config.json'), { force: true });
  await retireFileArchives(root, snapshot);
  await rmdir(dailyReviewRoot).catch(ignoreMissingOrNonEmptyDirectory);
}

async function retireFileArchives(
  root: string,
  snapshot: LegacyDailyReviewFileSnapshot,
): Promise<void> {
  const archiveRoot = join(root, 'daily-reviews', 'archive');
  await Promise.all(
    snapshot.archiveFileNames.map((name) => rm(join(archiveRoot, name), { force: true })),
  );
  await rmdir(archiveRoot).catch(ignoreMissingOrNonEmptyDirectory);
}

function ignoreMissingOrNonEmptyDirectory(error: unknown): void {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')
  ) {
    return;
  }
  throw error;
}

function decodeArchiveFile(id: string, raw: string): LegacyDailyReviewArchive {
  const input = JSON.parse(raw) as unknown;
  if (!isRecord(input) || !isRecord(input.day)) {
    throw new Error(`Legacy Daily Review archive ${id} is invalid`);
  }
  return decodeArchiveRow({
    archiveId: id,
    generatedAt: input.generatedAt,
    dayFromMs: input.day.fromMs,
    recordJson: raw,
  });
}

function readDatabaseSnapshot(database: DatabaseSync): LegacyDailyReviewMigrationSnapshot | null {
  return readSnapshot(database);
}

function readSnapshot(database: DatabaseSync): LegacyDailyReviewMigrationSnapshot | null {
  const present = LEGACY_TABLES.filter((table) => tableExists(database, table));
  if (present.length === 0) return null;
  if (LEGACY_REQUIRED_TABLES.some((table) => !present.includes(table))) {
    throw new Error('Legacy Daily Review tables are incomplete');
  }
  assertReleasedDailyReviewMigrationShape(database);

  const configRow = database
    .prepare(
      'SELECT config_json AS configJson FROM workflow_daily_review_state WHERE singleton = 1',
    )
    .get() as { configJson?: unknown } | undefined;
  const revisionRow = present.includes('workflow_daily_review_authority_state')
    ? (database
        .prepare('SELECT revision FROM workflow_daily_review_authority_state WHERE singleton = 1')
        .get() as { revision?: unknown } | undefined)
    : undefined;
  const archiveRows = database
    .prepare(
      `SELECT archive_id AS archiveId, generated_at AS generatedAt,
        day_from_ms AS dayFromMs, record_json AS recordJson
      FROM workflow_daily_review_archives
      ORDER BY archive_id`,
    )
    .all() as Array<{
    archiveId?: unknown;
    generatedAt?: unknown;
    dayFromMs?: unknown;
    recordJson?: unknown;
  }>;
  if (configRow !== undefined && typeof configRow.configJson !== 'string') {
    throw new Error('Legacy Daily Review config is invalid');
  }
  if (
    revisionRow !== undefined &&
    (!Number.isSafeInteger(revisionRow.revision) || (revisionRow.revision as number) < 0)
  ) {
    throw new Error('Legacy Daily Review revision is invalid');
  }
  const config = decodeConfig(configRow?.configJson);
  const archives = archiveRows.map(decodeArchiveRow);
  const tokenInput = JSON.stringify({
    configJson: configRow?.configJson ?? null,
    revision: revisionRow?.revision ?? null,
    archives: archiveRows,
  });
  return {
    token: `sha256:${createHash('sha256').update(tokenInput).digest('hex')}`,
    config,
    archives,
  };
}

async function migrateArchive(
  input: Parameters<typeof migrateLegacyDailyReview>[0],
  archive: LegacyDailyReviewArchive,
): Promise<void> {
  const sessionId = `daily-review-archive-${archive.id}`;
  const turnId = `legacy-daily-review-${archive.id}`;
  const report = renderArchiveMarkdown(archive);
  const fingerprint = sha256(
    JSON.stringify({
      kind: 'legacy-daily-review-archive',
      archive,
      workspace: input.workspaceRoot,
    }),
  );
  // Archive provenance is immutable. In particular, do not backfill a report
  // that used the legacy default with whichever Connection happens to exist on
  // a later retry: that would make the same migration identity change shape.
  const archiveTarget = parseModelKey(archive.modelKey) ?? {
    connectionSlug: 'legacy-daily-review-unconfigured',
    model: 'legacy-daily-review-unconfigured',
  };
  const created = await input.sessions.createStableSession({
    sessionId,
    requestFingerprint: fingerprint,
    input: {
      cwd: input.workspaceRoot,
      projectId: null,
      name: archiveTitle(archive),
      labels: ['migrated:daily-review'],
      llmConnectionSlug: archiveTarget.connectionSlug,
      model: archiveTarget.model,
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    },
  });
  if (created.kind === 'conflict') {
    throw new Error(`Legacy Daily Review Session identity conflicts: ${sessionId}`);
  }
  const messageId = `daily-review-message-${archive.id}`;
  const messages = await input.sessions.readMessagesSnapshot(sessionId);
  const existing = messages.find((message) => message.id === messageId);
  const message: StoredMessage = {
    type: 'assistant',
    id: messageId,
    turnId,
    ts: archive.generatedAt,
    text: report,
    modelId: archiveTarget.model,
  };
  if (existing === undefined) await input.sessions.appendMessage(sessionId, message);
  else if (!isDeepStrictEqual(existing, message)) {
    throw new Error(`Legacy Daily Review transcript identity conflicts: ${messageId}`);
  }
  await input.artifacts.create({
    id: `daily-review-report-${archive.id}`,
    sessionId,
    turnId,
    name: `daily-review-${archive.id}.md`,
    kind: 'file',
    content: report,
    mimeType: 'text/markdown',
    source: 'snapshot',
    summary: 'Migrated Daily Review report',
    now: archive.generatedAt,
  });
}

async function resolveExecutionTarget(
  modelKey: string,
  runtimePolicy: RuntimePolicyStoresWriter,
): Promise<
  | {
      readonly connectionId: string;
      readonly connectionSlug: string;
      readonly model: string;
    }
  | undefined
> {
  const explicit = parseModelKey(modelKey);
  const catalog = await runtimePolicy.connectionCatalog.getSnapshot();
  const selected = explicit
    ? (() => {
        const connection = catalog.connections.find(
          (candidate) => candidate.slug === explicit.connectionSlug,
        );
        return connection
          ? {
              connectionId: connection.connectionId,
              connectionSlug: connection.slug,
              model: explicit.model,
            }
          : undefined;
      })()
    : (() => {
        const target = catalog.defaultTarget;
        const connection = target
          ? catalog.connections.find((candidate) => candidate.connectionId === target.connectionId)
          : undefined;
        return target && connection
          ? {
              connectionId: connection.connectionId,
              connectionSlug: connection.slug,
              model: target.modelId,
            }
          : undefined;
      })();
  if (!selected) return undefined;
  const resolved = await runtimePolicy.operations.resolveExecutionConnection({
    kind: 'bound',
    connectionId: selected.connectionId,
    connectionSlug: selected.connectionSlug,
  });
  if (resolved.kind !== 'ready' || !resolved.connection.enabledModelIds.includes(selected.model)) {
    return undefined;
  }
  return selected;
}

function parseModelKey(
  value: string,
): { readonly connectionSlug: string; readonly model: string } | undefined {
  const separator = value.indexOf('::');
  if (separator <= 0 || separator >= value.length - 2) return undefined;
  const connectionSlug = value.slice(0, separator).trim();
  const model = value.slice(separator + 2).trim();
  return connectionSlug && model ? { connectionSlug, model } : undefined;
}

function localAnchorAt(now: number, executeTime: string): number {
  const [hours, minutes] = executeTime.split(':').map(Number);
  const anchor = new Date(now);
  anchor.setHours(hours ?? 8, minutes ?? 0, 0, 0);
  return anchor.getTime();
}

function needsLegacyCatchUp(snapshot: LegacyDailyReviewMigrationSnapshot, now: number): boolean {
  if (!snapshot.config.enabled || !scheduledTimeHasPassed(now, snapshot.config.executeTime)) {
    return false;
  }
  const previousDay = new Date(now);
  previousDay.setHours(0, 0, 0, 0);
  previousDay.setDate(previousDay.getDate() - 1);
  const archiveId = `${previousDay.getFullYear()}-${String(previousDay.getMonth() + 1).padStart(2, '0')}-${String(previousDay.getDate()).padStart(2, '0')}-1d`;
  return !snapshot.archives.some((archive) => archive.id === archiveId);
}

function scheduledTimeHasPassed(now: number, executeTime: string): boolean {
  const current = new Date(now);
  const [hours, minutes] = executeTime.split(':').map(Number);
  return current.getHours() * 60 + current.getMinutes() >= (hours ?? 0) * 60 + (minutes ?? 0);
}

function archiveTitle(archive: LegacyDailyReviewArchive): string {
  const localDate = archive.id.replace(/-(?:1|7|30)d$/u, '');
  return `Daily Review · ${localDate} · ${archive.range}d`;
}

function renderArchiveMarkdown(archive: LegacyDailyReviewArchive): string {
  const headings = {
    summary: 'Summary',
    gaps: 'Gaps and follow-ups',
    usage: 'Usage',
    code: 'Code',
  } as const;
  const sections = Object.entries(headings).flatMap(([key, heading]) => {
    const content = archive.sections[key as keyof LegacyDailyReviewArchive['sections']];
    return content?.trim() ? [`## ${heading}\n\n${content.trim()}`] : [];
  });
  const metadata = [
    `- Archive ID: ${archive.id}`,
    `- Day from: ${archive.day.fromMs}`,
    `- Day to: ${archive.day.toMs}`,
    `- Generated at: ${archive.generatedAt}`,
    `- Trigger: ${archive.trigger}`,
    `- Model: ${archive.modelKey || '(default)'}`,
    `- Status: ${archive.status}`,
    `- Range: ${archive.range} day${archive.range === 1 ? '' : 's'}`,
    `- Sessions: ${archive.totals.sessionCount}`,
    `- Requests: ${archive.totals.requestCount}`,
    `- Tokens: ${archive.totals.totalTokens}`,
    `- Cost: $${archive.totals.costUsd}`,
    `- Errors: ${archive.totals.errorCount}`,
    ...(archive.errorMessage ? [`- Error: ${archive.errorMessage}`] : []),
  ];
  return [`# ${archiveTitle(archive)}`, metadata.join('\n'), ...sections].join('\n\n') + '\n';
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function decodeConfig(value: unknown): LegacyDailyReviewConfig {
  if (value === undefined) return { enabled: false, executeTime: '08:00', modelKey: '' };
  const input = JSON.parse(value as string) as unknown;
  if (!isRecord(input)) throw new Error('Legacy Daily Review config is invalid');
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : false,
    executeTime:
      typeof input.executeTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(input.executeTime)
        ? input.executeTime
        : '08:00',
    modelKey: typeof input.modelKey === 'string' ? input.modelKey : '',
  };
}

function decodeArchiveRow(row: {
  archiveId?: unknown;
  generatedAt?: unknown;
  dayFromMs?: unknown;
  recordJson?: unknown;
}): LegacyDailyReviewArchive {
  if (
    typeof row.archiveId !== 'string' ||
    !isFiniteNumber(row.generatedAt) ||
    !isFiniteNumber(row.dayFromMs) ||
    typeof row.recordJson !== 'string'
  ) {
    throw new Error('Legacy Daily Review archive row is invalid');
  }
  const input = JSON.parse(row.recordJson) as unknown;
  if (!isRecord(input)) throw new Error(`Legacy Daily Review archive ${row.archiveId} is invalid`);
  const range =
    input.range === 1 || input.range === 7 || input.range === 30
      ? input.range
      : input.mode === 'daily'
        ? 1
        : input.mode === 'deep'
          ? 7
          : null;
  if (
    input.id !== row.archiveId ||
    range === null ||
    !isRecord(input.day) ||
    !isFiniteNumber(input.day.fromMs) ||
    !isFiniteNumber(input.day.toMs) ||
    input.day.fromMs !== row.dayFromMs ||
    input.day.toMs <= input.day.fromMs ||
    input.generatedAt !== row.generatedAt ||
    !['ok', 'no_model', 'no_data', 'failed', 'skipped'].includes(String(input.status)) ||
    (input.trigger !== 'cron' && input.trigger !== 'manual') ||
    typeof input.modelKey !== 'string' ||
    !isRecord(input.sections) ||
    !isRecord(input.totals)
  ) {
    throw new Error(`Legacy Daily Review archive ${row.archiveId} is invalid`);
  }
  const sections: Record<string, string> = {};
  for (const key of ['summary', 'gaps', 'usage', 'code']) {
    const section = input.sections[key];
    if (section === undefined) continue;
    if (typeof section !== 'string') {
      throw new Error(`Legacy Daily Review archive ${row.archiveId} is invalid`);
    }
    sections[key] = section;
  }
  const totals = decodeTotals(input.totals, row.archiveId);
  if (input.errorMessage !== undefined && typeof input.errorMessage !== 'string') {
    throw new Error(`Legacy Daily Review archive ${row.archiveId} is invalid`);
  }
  return {
    id: row.archiveId,
    day: { fromMs: input.day.fromMs, toMs: input.day.toMs },
    range,
    status: input.status as LegacyDailyReviewArchive['status'],
    generatedAt: row.generatedAt,
    trigger: input.trigger,
    modelKey: input.modelKey,
    sections,
    totals,
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
  };
}

function decodeTotals(
  input: Record<string, unknown>,
  archiveId: string,
): LegacyDailyReviewArchive['totals'] {
  const integerKeys = ['sessionCount', 'requestCount', 'totalTokens', 'errorCount'] as const;
  if (
    integerKeys.some((key) => !Number.isSafeInteger(input[key]) || (input[key] as number) < 0) ||
    !isFiniteNumber(input.costUsd) ||
    input.costUsd < 0
  ) {
    throw new Error(`Legacy Daily Review archive ${archiveId} is invalid`);
  }
  return {
    sessionCount: input.sessionCount as number,
    requestCount: input.requestCount as number,
    totalTokens: input.totalTokens as number,
    costUsd: input.costUsd,
    errorCount: input.errorCount as number,
  };
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
