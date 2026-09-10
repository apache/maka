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

import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactRecord } from '@maka/core/artifacts';
import { decodeArtifactRecordJsons } from './artifact-metadata-codec.js';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import {
  withOfflineContextSnapshot,
  copyContextSnapshot,
  validateContextSnapshot,
  planContextSnapshotFiles,
} from './context-offload-snapshot.js';
import {
  CONTEXT_OFFLOAD_DATABASE_NAME,
  CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
} from './sqlite-context-offload-store.js';
import {
  acquireOperationalStateDatabase,
  inspectOperationalStateSchema,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';
import { TERMINAL_RUNTIME_EVENT_SQL } from './runtime-transcript-query.js';
import { isSafeStorageId } from './storage-id.js';

export const SESSION_BUNDLE_STATE_ENTRIES = [
  'artifacts',
  OPERATIONAL_STATE_DATABASE_NAME,
  CONTEXT_OFFLOAD_DATABASE_NAME,
  CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
] as const;
export const SESSION_BUNDLE_PROTECTED_ENTRIES = [] as const;

export type SessionBundleExportErrorCode =
  | 'invalid_root'
  | 'overlapping_roots'
  | 'symlink'
  | 'path_escape'
  | 'unknown_entry'
  | 'unsupported_entry'
  | 'destination_not_empty'
  /** The source database registers a schema this build does not read. */
  /** A planned entry names a file the state root does not have. */
  | 'missing_entry'
  | 'schema_unsupported'
  /** The Session, or one of its descendants, is mid-turn. */
  | 'session_active';

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
  allowShared?: boolean;
}

export interface SessionBundleExportPlanEntry {
  relativePath: string;
  kind: 'file' | 'directory';
  source: 'copy' | 'filtered_runtime_sqlite' | 'context_snapshot';
}

export interface SessionBundleExportPlan {
  stateRoot: string;
  configRoot: string;
  destinationRoot: string;
  sessionId: string;
  /**
   * The exported Session and its subagent descendants, root first.
   *
   * A child Session holds the result of a tool call its parent made, so a
   * bundle carrying only the named Session is a conversation with a hole where
   * that result should be.
   */
  sessionIds: string[];
  /** Schema versions the SOURCE database registers, not this build's constants. */
  sourceSchema: Record<string, number>;
  /**
   * How the exported Session reaches a provider, by name only.
   *
   * An importer resolves the slug against its own catalog. No key is carried:
   * a bundle is shared, and this is the one failure here that cannot be undone.
   */
  connection: { llmConnectionSlug: string; model: string };
  includedEntries: string[];
  excludedEntries: string[];
  entries: SessionBundleExportPlanEntry[];
}

export interface SessionBundleExportInput extends SessionBundleRootLayoutInput {
  destinationRoot: string;
  sessionId: string;
  /**
   * The database to plan against. `exportSessionBundleState` passes the private
   * copy it has already taken, so the plan and the database that ships describe
   * the same moment. Defaults to the live file for a plan-only caller.
   */
  databasePath?: string;
  /**
   * Refuse a Session that is mid-turn.
   *
   * A bundle meant to be carried elsewhere cannot hold half a turn, but a
   * backup of a running Session is exactly what a backup is for.
   */
  requireQuiescent?: boolean;
  /**
   * Carry the subagent Sessions spawned under this one.
   *
   * A child holds the result of a tool call its parent made, so a portable
   * bundle needs the subtree. A snapshot of one Session does not, and adding
   * children to it would silently change what that snapshot contains.
   */
  includeSubtree?: boolean;
  /**
   * Drop the operational rows that describe a request rather than the
   * conversation.
   *
   * They are the large majority of `core_agent_run_events` and none of them
   * reach the model, so a bundle meant for another machine can leave them.
   * A snapshot or backup keeps them: incompleteness is not a property anyone
   * asks a backup for.
   */
  omitDiagnostics?: boolean;

  // Every option above defaults to the behaviour this function had before it
  // learned to make portable bundles, so its existing callers are unchanged.
}

export async function assertSessionBundleRootLayout(
  input: SessionBundleRootLayoutInput,
): Promise<void> {
  const stateRoot = await canonicalRoot(input.stateRoot, 'state');
  const configRoot = await canonicalRoot(input.configRoot, 'config', true);
  assertRootsSeparate(stateRoot, configRoot, input.allowShared === true);
}

export async function planSessionBundleExport(
  input: SessionBundleExportInput,
): Promise<SessionBundleExportPlan> {
  assertSafeSessionId(input.sessionId);
  const stateRoot = await canonicalRoot(input.stateRoot, 'state');
  const configRoot = await canonicalRoot(input.configRoot, 'config', true);
  const destinationRoot = resolve(input.destinationRoot);
  assertRootsSeparate(stateRoot, configRoot, input.allowShared === true);
  assertRootsSeparate(stateRoot, destinationRoot, false);
  assertRootsSeparate(configRoot, destinationRoot, false);

  // Everything below is derived from `input.databasePath` -- the private copy
  // the caller has already taken -- and never from the live database. The
  // artifact and context locks do not fence ordinary Session and runtime
  // writers, so a subtree, an artifact list and a manifest read from the live
  // file would describe a different moment than the database that ships.
  const databasePath = input.databasePath ?? resolve(stateRoot, OPERATIONAL_STATE_DATABASE_NAME);
  await assertRegularFile(databasePath, OPERATIONAL_STATE_DATABASE_NAME);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let artifacts: ArtifactRecord[];
  let sessionIds: string[];
  let sourceSchema: Record<string, number>;
  let connection: { llmConnectionSlug: string; model: string };
  try {
    const session = database
      .prepare('SELECT 1 AS present FROM session_metadata WHERE session_id = ?')
      .get(input.sessionId);
    if (!session) {
      throw new SessionBundleExportError(
        'invalid_root',
        `Session bundle session does not exist: ${input.sessionId}`,
      );
    }
    sourceSchema = assertPortableSourceSchema(database);
    sessionIds =
      input.includeSubtree === true
        ? collectSubagentSessionTree(database, input.sessionId)
        : [input.sessionId];

    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT record_json FROM artifact_records WHERE session_id IN (${placeholders}) ORDER BY created_at, artifact_id`,
      )
      .all(...sessionIds) as Array<{ record_json?: unknown }>;
    artifacts = decodeArtifactRecordJsons(rows.map((row) => row.record_json));
    const route = database
      .prepare('SELECT llm_connection_slug, model FROM session_metadata WHERE session_id = ?')
      .get(input.sessionId) as { llm_connection_slug?: unknown; model?: unknown };
    connection = {
      llmConnectionSlug: String(route?.llm_connection_slug ?? ''),
      model: String(route?.model ?? ''),
    };
  } finally {
    database.close();
  }

  const entries: SessionBundleExportPlanEntry[] = [
    {
      relativePath: OPERATIONAL_STATE_DATABASE_NAME,
      kind: 'file',
      source: 'filtered_runtime_sqlite',
    },
  ];
  const includedEntries = [OPERATIONAL_STATE_DATABASE_NAME];
  if (artifacts.length > 0) {
    entries.push({ relativePath: 'artifacts', kind: 'directory', source: 'copy' });
    for (const artifact of artifacts) {
      if (!sessionIds.some((id) => isArtifactPathForSession(artifact.relativePath, id))) {
        throw new SessionBundleExportError(
          'path_escape',
          `Artifact path does not belong to the exported subtree: ${artifact.relativePath}`,
        );
      }
      const relativePath = `artifacts/${artifact.relativePath}`;
      // A record naming bytes the workspace does not have would produce a
      // bundle whose own metadata points at nothing. Reported apart from a
      // missing state root, which is a different mistake entirely.
      await assertRegularFile(resolve(stateRoot, relativePath), relativePath).catch(
        (error: unknown) => {
          if (error instanceof SessionBundleExportError && error.code === 'invalid_root') {
            throw new SessionBundleExportError('missing_entry', error.message, { cause: error });
          }
          throw error;
        },
      );
      entries.push({ relativePath, kind: 'file', source: 'copy' });
    }
    includedEntries.push('artifacts');
  }
  const contextFiles = await planContextSnapshotFiles(stateRoot, sessionIds);
  for (const relativePath of contextFiles) {
    entries.push({ relativePath, kind: 'file', source: 'context_snapshot' });
  }
  if (contextFiles.length > 0) includedEntries.push(CONTEXT_OFFLOAD_DATABASE_NAME);
  if (contextFiles.length > 1) includedEntries.push(CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME);
  const allowed = new Set<string>([...SESSION_BUNDLE_STATE_ENTRIES]);
  const excludedEntries = (await readdir(stateRoot)).filter((entry) => !allowed.has(entry)).sort();
  return {
    stateRoot,
    configRoot,
    destinationRoot,
    sessionId: input.sessionId,
    sessionIds,
    sourceSchema,
    connection,
    includedEntries,
    excludedEntries,
    entries,
  };
}

export async function exportSessionBundleState(
  input: SessionBundleExportInput,
): Promise<SessionBundleExportPlan> {
  return withOfflineContextSnapshot(input.stateRoot, (contextLocked) =>
    withArtifactWriterLock(input.stateRoot, async (stateRoot) => {
      const destinationRoot = resolve(input.destinationRoot);
      await assertDestinationMissing(destinationRoot);
      const stagingRoot = `${destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        // Take the private copy BEFORE anything is read. `lease.backup()` is
        // what freezes the content; every decision after this -- schema, the
        // subtree, the artifact list, quiescence, the manifest -- is made
        // against this one file, so the bundle cannot describe two moments.
        const databasePath = resolveInside(stagingRoot, OPERATIONAL_STATE_DATABASE_NAME);
        await backupOperationalState(stateRoot, databasePath);
        const plan = await planSessionBundleExport({ ...input, stateRoot, databasePath });
        for (const entry of plan.entries) {
          if (entry.source === 'context_snapshot' || entry.source === 'filtered_runtime_sqlite') {
            continue;
          }
          const destination = resolveInside(stagingRoot, entry.relativePath);
          if (entry.kind === 'directory') {
            await mkdir(destination, { recursive: true });
            continue;
          }
          await mkdir(dirname(destination), { recursive: true });
          await copyArtifactFile(plan.stateRoot, entry.relativePath, destination);
        }
        await filterBackedUpDatabase(databasePath, plan.sessionIds, {
          omitDiagnostics: input.omitDiagnostics === true,
          requireQuiescent: input.requireQuiescent === true,
        });
        await copyContextSnapshot(stateRoot, stagingRoot, contextLocked, plan.sessionIds);
        await validateContextSnapshot(stagingRoot);
        await mkdir(dirname(plan.destinationRoot), { recursive: true });
        await rename(stagingRoot, plan.destinationRoot);
        return plan;
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }),
  );
}

/**
 * Take the private copy the whole export is derived from.
 *
 * `require_current` because an export must not migrate what it reads: opening
 * the live database the ordinary way upgrades it in place, which turns a
 * read-only operation into a write to someone else's workspace and leaves the
 * manifest describing a version the source no longer has.
 */
/**
 * Copy one artifact without leaving the state root.
 *
 * Checking the final component is not enough: `artifacts/<sessionId>` can
 * itself be a symlink, and `copyFile` follows ancestors — an artifact record
 * that decodes perfectly can then pull in a file from outside the workspace.
 * Every segment is checked, the final open refuses to follow a link, and the
 * bytes are read from that descriptor rather than from the name.
 *
 * Node has no `openat`, so a segment swapped between its check and the open is
 * not closed here. That window is narrowed, not eliminated; closing it needs a
 * directory-relative open this runtime does not expose.
 */
async function copyArtifactFile(
  stateRoot: string,
  relativePath: string,
  destination: string,
): Promise<void> {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0);
  let walked = stateRoot;
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new SessionBundleExportError('path_escape', `Artifact path segment is not safe`);
    }
    walked = resolveInside(walked, segment);
    const metadata = await lstat(walked).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) {
      throw new SessionBundleExportError('missing_entry', `Missing ${relativePath}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new SessionBundleExportError(
        'symlink',
        `Artifact path crosses a symlink at ${segment}`,
      );
    }
  }

  const handle = await open(walked, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new SessionBundleExportError(
        'unsupported_entry',
        `${relativePath} is not a regular file`,
      );
    }
    await writeFile(destination, handle.createReadStream());
  } finally {
    await handle.close().catch(() => {});
  }
}

async function backupOperationalState(stateRoot: string, destinationPath: string): Promise<void> {
  // A directory with no state database is not a workspace, which is a different
  // mistake from a workspace whose schema this build cannot read.
  await assertRegularFile(
    resolveInside(stateRoot, OPERATIONAL_STATE_DATABASE_NAME),
    OPERATIONAL_STATE_DATABASE_NAME,
  );
  let lease: ReturnType<typeof acquireOperationalStateDatabase>;
  try {
    lease = acquireOperationalStateDatabase(stateRoot, { schemaMigration: 'require_current' });
  } catch (error) {
    throw new SessionBundleExportError(
      'schema_unsupported',
      'Session bundle source is not at the current schema',
      { cause: error },
    );
  }
  try {
    await lease.backup(destinationPath);
  } finally {
    lease.close();
  }
}

async function filterBackedUpDatabase(
  destinationPath: string,
  sessionIds: readonly string[],
  options: { omitDiagnostics: boolean; requireQuiescent: boolean },
): Promise<void> {
  const database = new DatabaseSync(destinationPath);
  try {
    // Quiescence is asserted here, on the copy, not on the live database.
    // `lease.backup()` is what freezes the content; a check made before it
    // describes a state the bundle may no longer carry, and the artifact and
    // context locks held around this do not keep a turn from starting. This is
    // the only place where "what was checked" and "what ships" are the same
    // bytes.
    if (options.requireQuiescent) {
      for (const sessionId of sessionIds) assertSessionQuiescent(database, sessionId);
    }
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name?: unknown }>;
    for (const row of tables) {
      if (typeof row.name !== 'string' || PORTABLE_GLOBAL_TABLES.has(row.name)) continue;
      const columns = database
        .prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`)
        .all() as Array<{ name?: unknown }>;
      const names = new Set(
        columns
          .map((column) => column.name)
          .filter((name): name is string => typeof name === 'string'),
      );
      const sessionColumns = names.has(SESSION_ROW_OWNER_COLUMN)
        ? [SESSION_ROW_OWNER_COLUMN]
        : SESSION_LINK_COLUMNS.filter((name) => names.has(name));
      if (sessionColumns.length > 0) {
        // Delete what the subtree does not own, keeping the original
        // predicate's shape: a row survives only when EVERY session column it
        // has names an exported Session. A link table row with one end outside
        // the bundle would otherwise arrive pointing at a Session that is not
        // there -- the reference is what makes it a link.
        const placeholders = sessionIds.map(() => '?').join(', ');
        const predicate = sessionColumns
          .map((name) =>
            name === SESSION_ROW_OWNER_COLUMN
              ? // An owner that is NULL owns nothing. Such a row cannot be
                // attributed to any Session, so it is not this bundle's to
                // carry -- keeping it shipped an unattributed usage row.
                `(${quoteIdentifier(name)} IS NULL OR ${quoteIdentifier(name)} NOT IN (${placeholders}))`
              : // A link endpoint that is NULL names no counterpart, which is
                // not the same as naming one outside the bundle.
                `(${quoteIdentifier(name)} IS NOT NULL AND ${quoteIdentifier(name)} NOT IN (${placeholders}))`,
          )
          .join(' OR ');
        database
          .prepare(`DELETE FROM ${quoteIdentifier(row.name)} WHERE ${predicate}`)
          .run(...sessionColumns.flatMap(() => sessionIds));
      } else if (!PORTABLE_DERIVED_TABLES.has(row.name)) {
        database.exec(`DELETE FROM ${quoteIdentifier(row.name)}`);
      }
    }
    // Operational rows that describe a REQUEST rather than the conversation.
    // None of them reach the model, and in a real Session they are the large
    // majority of this table. The two record kinds that do decide what the
    // model reads -- history_compact_checkpoint_recorded and
    // model_projection_transition_recorded -- are deliberately not here.
    if (options.omitDiagnostics) {
      database
        .prepare(`
        DELETE FROM core_agent_run_events
        WHERE event_type IN (${SESSION_BUNDLE_OMITTED_EVENT_TYPES.map(() => '?').join(', ')})
      `)
        .run(...SESSION_BUNDLE_OMITTED_EVENT_TYPES);
    }
    database
      .prepare(`
      DELETE FROM tool_journal_events
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_events
        WHERE runtime_events.invocation_id = tool_journal_events.invocation_id
      )
    `)
      .run();
    database
      .prepare(`
      DELETE FROM runtime_partial_segments
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_partial_snapshots
        WHERE runtime_partial_snapshots.stream_key = runtime_partial_segments.stream_key
      )
    `)
      .run();
    database
      .prepare(`
      DELETE FROM tool_operations
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_events
        WHERE runtime_events.invocation_id = tool_operations.invocation_id
      )
    `)
      .run();
    database
      .prepare(`
      DELETE FROM core_interaction_outcomes
      WHERE NOT EXISTS (
        SELECT 1 FROM core_interaction_requests
        WHERE core_interaction_requests.request_id = core_interaction_outcomes.request_id
      )
    `)
      .run();
    database.exec('COMMIT');
    const foreignKeyViolation = database.prepare('PRAGMA foreign_key_check').get();
    if (foreignKeyViolation) throw new Error('Filtered session database has dangling references');
    // DELETE frees pages, it does not erase them. Without this the bundle ships
    // a file whose freelist still holds the excluded Sessions' bytes -- readable
    // by anyone who opens it with something other than SQL.
    database.exec('VACUUM');
    for (const sessionId of sessionIds) {
      const session = database
        .prepare('SELECT 1 AS present FROM session_metadata WHERE session_id = ?')
        .get(sessionId);
      if (!session) throw new Error(`Filtered session is missing: ${sessionId}`);
    }
    database.exec('PRAGMA journal_mode = DELETE');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

/**
 * `core_agent_run_events` types the bundle drops.
 *
 * They record how a request was shaped and how a stream behaved -- diagnostics
 * for the machine that produced them, not the conversation. Any type absent
 * from this list is carried, including one a later build introduces: an export
 * moves rows, it does not interpret them.
 */
export const SESSION_BUNDLE_OMITTED_EVENT_TYPES = [
  'provider_request_attempt_recorded',
  'provider_request_captured',
  'model_call_attempt_recorded',
  'model_stream_started',
  'model_stream_completed',
  'model_stream_failed',
  'send_diagnostics_recorded',
  'plan_context_resolved',
  'skill_catalog_built',
  'skill_searched',
  'skill_loaded',
  'skill_load_failed',
  'tool_searched',
  'request_composition_resolved',
  'trace_write_failed',
] as const;

/**
 * Ownership, which is not the same thing as naming a Session.
 *
 * `session_id` says whose row this is. Everything else in this list is a
 * Session column only on tables that have no `session_id` -- link tables, whose
 * whole content is the pair they join, and which are meaningless when one end
 * is outside the bundle.
 *
 * Keeping the two apart matters. `session_metadata.parent_session_id` is a
 * lineage POINTER, not ownership: treating it as ownership deleted the very
 * Session being exported whenever its branch source lay outside the subtree.
 * And a link table whose columns are spelled `parent_session_id` /
 * `child_session_id` -- `subagent_spawns`, the record of which tool call
 * spawned each child -- looked Session-less and was emptied wholesale.
 *
 * Nullable columns count only when set, so a row that names no counterpart is
 * not deleted for failing to name one.
 */
const SESSION_ROW_OWNER_COLUMN = 'session_id';
const SESSION_LINK_COLUMNS = [
  'source_session_id',
  'target_session_id',
  'parent_session_id',
  'child_session_id',
  'root_session_id',
] as const;

const PORTABLE_GLOBAL_TABLES = new Set([
  'operational_schema_migrations',
  'session_metadata_schema',
  'runtime_capabilities',
  'session_catalog_state',
]);

const PORTABLE_DERIVED_TABLES = new Set([
  'tool_journal_events',
  'tool_operations',
  'runtime_partial_segments',
  'core_interaction_outcomes',
]);

/**
 * The Session and its subagent descendants, root first, siblings by id.
 *
 * `subagent_parent_session_id` is an ordinary column, not a constrained tree:
 * nothing stops a row naming itself or an ancestor. Membership is tracked
 * rather than assumed, so a cycle ends the walk instead of hanging it, and a
 * Session reachable twice is exported once.
 */
/**
 * Refuse a source whose schema this build does not read.
 *
 * The filter runs `DELETE` over whatever tables the database happens to have,
 * so a schema this build cannot read produces a bundle whose shape will not
 * match what its manifest claims. The operational store is the authority on
 * what "current" means -- a private list here went stale the moment a scope was
 * added, and reported versions the source did not have.
 */
function assertPortableSourceSchema(database: DatabaseSync): Record<string, number> {
  // The inspector validates every scope and says whether a migration is owed.
  // It reports only some of them, so the manifest's numbers come from the
  // registry the database keeps -- validated by the authority, reported from
  // the source, and neither of them this build's constants.
  const inspection = inspectOperationalStateSchema(database);
  if (inspection.status !== 'current') {
    throw new SessionBundleExportError(
      'schema_unsupported',
      'Session bundle source schema is not current',
    );
  }
  const registered: Record<string, number> = {};
  for (const row of database
    .prepare('SELECT scope, version FROM operational_schema_migrations ORDER BY scope')
    .all() as Array<{ scope?: unknown; version?: unknown }>) {
    if (typeof row.scope === 'string' && typeof row.version === 'number') {
      registered[row.scope] = row.version;
    }
  }
  return registered;
}

/**
 * Refuse a Session that is mid-turn.
 *
 * The writer locks around this export keep other writers out from here on, but
 * they say nothing about work that was already in flight when it started. A
 * partial stream snapshot, a tool dispatched without a settled result, or an
 * invocation that never reached a terminal event each mean the bundle would
 * carry half of something -- and half a turn is not a Session.
 */
function assertSessionQuiescent(database: DatabaseSync, sessionId: string): void {
  const partials = database
    .prepare('SELECT COUNT(*) AS count FROM runtime_partial_snapshots WHERE session_id = ?')
    .get(sessionId) as { count?: unknown };
  if (Number(partials.count ?? 0) > 0) {
    throw new SessionBundleExportError(
      'session_active',
      `Session has a partial stream snapshot: ${sessionId}`,
    );
  }
  // A tool that crossed the dispatch boundary and never settled. Its
  // invocation can carry a terminal event -- the run failed -- while the
  // operation itself is still prepared, so an invocation check does not see it.
  // Same predicate the runtime store uses, so "unsettled" means one thing.
  const unsettledOperations = database
    .prepare(`
      SELECT COUNT(*) AS count FROM tool_operations
      WHERE current_state = 'prepared'
        AND result_event_id IS NULL
        AND dispatch_event_id IS NOT NULL
        AND call_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
    `)
    .get(sessionId) as { count?: unknown };
  if (Number(unsettledOperations.count ?? 0) > 0) {
    throw new SessionBundleExportError(
      'session_active',
      `Session has an unsettled tool operation: ${sessionId}`,
    );
  }
  const openInvocations = database
    .prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT DISTINCT invocation_id FROM runtime_events AS invocations
        WHERE session_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM runtime_events AS terminal
            WHERE terminal.invocation_id = invocations.invocation_id
              AND ${TERMINAL_RUNTIME_EVENT_SQL}
          )
      )
    `)
    .get(sessionId) as { count?: unknown };
  if (Number(openInvocations.count ?? 0) > 0) {
    throw new SessionBundleExportError(
      'session_active',
      `Session has an invocation with no terminal event: ${sessionId}`,
    );
  }
}

function collectSubagentSessionTree(database: DatabaseSync, rootSessionId: string): string[] {
  const ordered: string[] = [];
  const seen = new Set([rootSessionId]);
  const queue = [rootSessionId];
  const children = database.prepare(
    'SELECT session_id FROM session_metadata WHERE subagent_parent_session_id = ? ORDER BY session_id',
  );
  while (queue.length > 0) {
    const sessionId = queue.shift() as string;
    ordered.push(sessionId);
    for (const row of children.all(sessionId) as Array<{ session_id?: unknown }>) {
      const childId = row.session_id;
      if (typeof childId !== 'string' || seen.has(childId)) continue;
      seen.add(childId);
      queue.push(childId);
    }
  }
  return ordered;
}

export function isArtifactPathForSession(relativePath: string, sessionId: string): boolean {
  const parts = relativePath.split(/[\\/]+/);
  return (
    parts.length >= 2 &&
    parts[0] === sessionId &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

async function canonicalRoot(path: string, role: string, allowMissing = false): Promise<string> {
  const requested = resolve(path);
  try {
    const metadata = await lstat(requested);
    if (metadata.isSymbolicLink()) {
      throw new SessionBundleExportError('symlink', `${role} root cannot be a symlink`);
    }
    if (!metadata.isDirectory()) {
      throw new SessionBundleExportError('invalid_root', `${role} root is not a directory`);
    }
    return realpath(requested);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return requested;
    if (error instanceof SessionBundleExportError) throw error;
    throw new SessionBundleExportError('invalid_root', `${role} root does not exist`, {
      cause: error,
    });
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch((error) => {
    throw new SessionBundleExportError('invalid_root', `Missing ${label}`, { cause: error });
  });
  if (metadata.isSymbolicLink()) {
    throw new SessionBundleExportError('symlink', `${label} cannot be a symlink`);
  }
  if (!metadata.isFile()) {
    throw new SessionBundleExportError('unsupported_entry', `${label} is not a regular file`);
  }
}

async function assertDestinationMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new SessionBundleExportError(
    'destination_not_empty',
    `Session bundle destination already exists: ${path}`,
  );
}

function resolveInside(root: string, path: string): string {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SessionBundleExportError('path_escape', `Path escapes bundle root: ${path}`);
  }
  return candidate;
}

function assertRootsSeparate(left: string, right: string, allowSame: boolean): void {
  if (left === right) {
    if (allowSame) return;
    throw new SessionBundleExportError('overlapping_roots', 'Session bundle roots overlap');
  }
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  if (
    (!leftToRight.startsWith('..') && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !isAbsolute(rightToLeft))
  ) {
    throw new SessionBundleExportError('overlapping_roots', 'Session bundle roots overlap');
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!isSafeStorageId(sessionId)) {
    throw new SessionBundleExportError('invalid_root', `Invalid session id: ${sessionId}`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
