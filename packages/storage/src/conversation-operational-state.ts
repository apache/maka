import { WORKSPACE_AUTHORITY_SESSION_ID } from '@maka/core/workspace-version-authority';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import { isRuntimeStorageSafeId } from './runtime-event-invariants.js';

export interface ConversationOperationalStateStore {
  purge(sessionId: string): Promise<void>;
  close(): void;
}

export function createConversationOperationalStateStore(
  workspaceRoot: string,
): ConversationOperationalStateStore {
  return new SqliteConversationOperationalStateStore(workspaceRoot);
}

class SqliteConversationOperationalStateStore implements ConversationOperationalStateStore {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(workspaceRoot);
  }

  async purge(sessionId: string): Promise<void> {
    if (!isRuntimeStorageSafeId(sessionId)) throw new Error('Invalid session id');
    if (sessionId === WORKSPACE_AUTHORITY_SESSION_ID) {
      throw new Error('Workspace authority control-plane state cannot be purged as a conversation');
    }
    this.#lease.transaction('write', () => {
      const database = this.#lease.database;
      database
        .prepare(
          `
          DELETE FROM tool_journal_events
          WHERE runtime_event_id IN (
            SELECT event_id FROM runtime_events WHERE session_id = ?
          )
          OR operation_id IN (
            SELECT operation_id
            FROM tool_operations
            WHERE call_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
              OR dispatch_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
              OR result_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
          )
        `,
        )
        .run(sessionId, sessionId, sessionId, sessionId);
      database
        .prepare(
          `
          DELETE FROM tool_operations
          WHERE call_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
            OR dispatch_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
            OR result_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
        `,
        )
        .run(sessionId, sessionId, sessionId);
      database.prepare('DELETE FROM runtime_partial_snapshots WHERE session_id = ?').run(sessionId);
      database.prepare('DELETE FROM runtime_events WHERE session_id = ?').run(sessionId);
      database
        .prepare('DELETE FROM core_agent_run_projections WHERE session_id = ?')
        .run(sessionId);
      database.prepare('DELETE FROM core_root_turn_admissions WHERE session_id = ?').run(sessionId);
      database
        .prepare('DELETE FROM core_root_turn_start_rejections WHERE session_id = ?')
        .run(sessionId);
      database.prepare('DELETE FROM core_agent_runs WHERE session_id = ?').run(sessionId);
      database.prepare('DELETE FROM workflow_goal_authority WHERE session_id = ?').run(sessionId);
    });
  }

  close(): void {
    this.#lease.close();
  }
}
