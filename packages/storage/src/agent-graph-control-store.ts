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
 * Open the graph-control repository owned by the operational database.
 * Session messages and graph state share runtime.sqlite as one authority.
 */
export function createAgentGraphControlStore(workspaceRoot: string): SqliteSessionMetadataStore {
  const databaseLease = acquireOperationalStateDatabase(workspaceRoot);
  return createSqliteSessionMetadataStore(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME), {
    databaseLease,
  });
}
