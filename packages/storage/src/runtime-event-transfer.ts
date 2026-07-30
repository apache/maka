import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePersistedRuntimeEvent, type RuntimeEvent, type RuntimeEventStore } from '@maka/core';
import { createRuntimeEventStore } from './agent-run-store.js';
import type { SqliteRuntimeStore } from './sqlite-runtime-store.js';
import { createSqliteRuntimeStore } from './sqlite-runtime-store.js';

export const SQLITE_RUNTIME_DATABASE_NAME = 'runtime.sqlite';
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type RuntimeEventPersistence = {
  kind: 'jsonl' | 'sqlite';
  runtimeEventStore: RuntimeEventStore;
  runtimeCommitStore?: SqliteRuntimeStore;
  importReport?: LegacyRuntimeEventImportReport;
  close(): void;
};

export interface RuntimeEventImportReport {
  eventsRead: number;
  eventsImported: number;
  eventsExisting: number;
}

export interface LegacyRuntimeEventImportReport extends RuntimeEventImportReport {
  filesScanned: number;
}

export async function openRuntimeEventPersistence(input: {
  workspaceRoot: string;
  sqliteCanonical: boolean;
}): Promise<RuntimeEventPersistence> {
  const databasePath = join(input.workspaceRoot, SQLITE_RUNTIME_DATABASE_NAME);
  if (!input.sqliteCanonical && !(await pathExists(databasePath))) {
    return {
      kind: 'jsonl',
      runtimeEventStore: createRuntimeEventStore(input.workspaceRoot),
      close: () => {},
    };
  }
  const store = createSqliteRuntimeStore(databasePath);
  try {
    const importReport = await importLegacyRuntimeEventJsonlTree({
      workspaceRoot: input.workspaceRoot,
      destination: store,
    });
    return {
      kind: 'sqlite',
      runtimeEventStore: store,
      runtimeCommitStore: store,
      importReport,
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function exportRuntimeEventsToJsonl(
  source: RuntimeEventStore,
  sessionId: string,
  runId: string,
): Promise<string> {
  const events = source.readImmutableRuntimeEvents
    ? await source.readImmutableRuntimeEvents(sessionId, runId)
    : await source.readRuntimeEvents(sessionId, runId);
  return events.length === 0 ? '' : `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

export async function importRuntimeEventsFromJsonl(input: {
  jsonl: string;
  sessionId: string;
  runId: string;
  destination: SqliteRuntimeStore;
}): Promise<RuntimeEventImportReport> {
  const events = parseRuntimeEventJsonl(input.jsonl, input.sessionId, input.runId);
  return importRuntimeEvents(events, input.sessionId, input.runId, input.destination);
}

export async function importLegacyRuntimeEventJsonlTree(input: {
  workspaceRoot: string;
  destination: SqliteRuntimeStore;
}): Promise<LegacyRuntimeEventImportReport> {
  const sessionsRoot = join(input.workspaceRoot, 'sessions');
  const report: LegacyRuntimeEventImportReport = {
    filesScanned: 0,
    eventsRead: 0,
    eventsImported: 0,
    eventsExisting: 0,
  };
  for (const session of await directoryNames(sessionsRoot)) {
    const runsRoot = join(sessionsRoot, session, 'runs');
    for (const run of await directoryNames(runsRoot)) {
      const sourcePath = join(runsRoot, run, 'runtime-events.jsonl');
      const sourceStat = await stat(sourcePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!sourceStat) continue;
      const fingerprint = `${sourceStat.size}:${sourceStat.mtimeMs}`;
      if (await input.destination.isRuntimeImportSourceCurrent(sourcePath, fingerprint)) continue;
      const events = parseLegacyRuntimeEventJsonl(await readFile(sourcePath, 'utf8'), session, run);
      report.filesScanned += 1;
      const imported = await importRuntimeEvents(events, session, run, input.destination, {
        path: sourcePath,
        fingerprint,
      });
      report.eventsRead += imported.eventsRead;
      report.eventsImported += imported.eventsImported;
      report.eventsExisting += imported.eventsExisting;
    }
  }
  return report;
}

async function importRuntimeEvents(
  events: readonly RuntimeEvent[],
  sessionId: string,
  runId: string,
  destination: SqliteRuntimeStore,
  source?: { path: string; fingerprint: string },
): Promise<RuntimeEventImportReport> {
  const report: RuntimeEventImportReport = {
    eventsRead: events.length,
    eventsImported: 0,
    eventsExisting: 0,
  };
  for (const event of events) {
    assertRuntimeEventImportIdentity(event, sessionId, runId);
  }
  const imported = await destination.importRuntimeEventsBatch({
    sessionId,
    runId,
    events,
    ...(source ? { source } : {}),
  });
  for (const created of imported.created) {
    if (created) report.eventsImported += 1;
    else report.eventsExisting += 1;
  }
  return report;
}

function parseRuntimeEventJsonl(jsonl: string, sessionId: string, runId: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const lines = jsonl.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let event: RuntimeEvent;
    try {
      event = JSON.parse(line) as RuntimeEvent;
    } catch (error) {
      throw new Error(`Invalid RuntimeEvent JSONL line ${index + 1} for run ${runId}`, {
        cause: error,
      });
    }
    assertRuntimeEventImportIdentity(event, sessionId, runId);
    if (event.partial === true) {
      throw new Error(`Partial RuntimeEvent ${event.id} cannot be imported as immutable JSONL`);
    }
    events.push(event);
  }
  return events;
}

function parseLegacyRuntimeEventJsonl(
  jsonl: string,
  sessionId: string,
  runId: string,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const lines = jsonl.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let event: RuntimeEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLegacyStreamPartialSnapshot(parsed)) continue;
      event = decodePersistedRuntimeEvent(parsed);
    } catch (error) {
      throw new Error(`Invalid legacy RuntimeEvent JSONL line ${index + 1} for run ${runId}`, {
        cause: error,
      });
    }
    assertRuntimeEventImportIdentity(event, sessionId, runId);
    events.push(event);
  }
  return events;
}

function assertRuntimeEventImportIdentity(
  event: RuntimeEvent,
  sessionId: string,
  runId: string,
): void {
  if (
    !event ||
    typeof event !== 'object' ||
    event.sessionId !== sessionId ||
    event.runId !== runId
  ) {
    throw new Error(`RuntimeEvent import identity mismatch for session ${sessionId}, run ${runId}`);
  }
}

// Legacy JSONL logs may physically contain stream partial snapshots written by
// older versions. They are mutable projection state, not immutable facts: a
// completed stream leaves a separate durable final event, and a dangling
// partial is already handled by the replay boundary gates. Legacy tree import
// skips them; the strict importRuntimeEventsFromJsonl API still rejects them.
function isLegacyStreamPartialSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return event.partial === true && event.status === undefined && event.actions === undefined;
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
