import { join } from 'node:path';
import { SQLITE_SESSION_METADATA_DATABASE_NAME } from './session-store.js';
import {
  createSqliteSessionMetadataStore,
  type SqliteSessionMetadataStore,
} from './sqlite-session-metadata-store.js';

/**
 * Open the SQLite metadata control plane used by one host-owned agent graph
 * coordinator. Session JSONL remains the transcript authority; graph
 * schedule/topology/claim relationships are queried from SQLite.
 */
export function createAgentGraphControlStore(workspaceRoot: string): SqliteSessionMetadataStore {
  return createSqliteSessionMetadataStore(
    join(workspaceRoot, SQLITE_SESSION_METADATA_DATABASE_NAME),
  );
}
