import { join } from 'node:path';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';
import {
  createSqliteSessionMetadataStore,
  type SqliteSessionMetadataStore,
} from './sqlite-session-metadata-store.js';

/**
 * Open the metadata repository owned by the operational database. Session
 * JSONL remains the transcript-body authority; graph schedule/topology/claim
 * relationships are canonical in runtime.sqlite.
 */
export function createAgentGraphControlStore(workspaceRoot: string): SqliteSessionMetadataStore {
  const databaseLease = acquireOperationalStateDatabase(workspaceRoot);
  return createSqliteSessionMetadataStore(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME), {
    databaseLease,
  });
}
