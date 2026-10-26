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
      // Workspace projection rows that reference this session's tool data must
      // be deleted before their parents are, or the whole purge rolls back on
      // `FOREIGN KEY constraint failed` with no recovery path.
      //
      // An unsettled managed mutation reservation (crash before settlement)
      // references its prepared `tool_operations` row, so it is deleted with
      // the same session scope as the operation delete below. Reservations are
      // re-derived from dispatch events by the workspace authority scan, so
      // deleting the projection keeps it consistent with the surviving ledger.
      database
        .prepare(
          `
          DELETE FROM runtime_managed_mutation_reservations
          WHERE operation_id IN (
            SELECT operation_id FROM tool_operations
            WHERE call_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
              OR dispatch_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
              OR result_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
          )
          OR dispatch_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
        `,
        )
        .run(sessionId, sessionId, sessionId, sessionId);
      // A settled workspace successor version row cannot keep its
      // conversation-scoped evidence: the table's CHECK constraint requires
      // `dispatch_event_id`/`outcome_event_id` to stay NOT NULL on
      // `tool_mutation` rows, so the row (and the head pointing at it, through
      // the composite foreign key) is deleted rather than trimmed. Accepted
      // facts are only ever written to the workspace authority stream
      // (`accepted_event_id` never belongs to a purgeable conversation), but
      // the `accepted_event_id` predicate keeps that invariant enforced here
      // instead of assumed.
      database
        .prepare(
          `
          DELETE FROM runtime_workspace_heads
          WHERE (workspace_id, workspace_epoch_id, workspace_version_id, accepted_event_id) IN (
            SELECT workspace_id, workspace_epoch_id, workspace_version_id, accepted_event_id
            FROM runtime_workspace_versions
            WHERE dispatch_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
              OR outcome_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
              OR accepted_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
          )
        `,
        )
        .run(sessionId, sessionId, sessionId);
      database
        .prepare(
          `
          DELETE FROM runtime_workspace_versions
          WHERE dispatch_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
            OR outcome_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
            OR accepted_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)
        `,
        )
        .run(sessionId, sessionId, sessionId);
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
        .prepare('DELETE FROM runtime_session_turn_extents WHERE session_id = ?')
        .run(sessionId);
      database
        .prepare('DELETE FROM core_agent_run_projections WHERE session_id = ?')
        .run(sessionId);
      database.prepare('DELETE FROM core_root_turn_admissions WHERE session_id = ?').run(sessionId);
      database
        .prepare('DELETE FROM core_root_turn_start_rejections WHERE session_id = ?')
        .run(sessionId);
      // Cascades this run's events and the Usage projection's checkpoints.
      // `usage_model_call_attempts` is deliberately absent from this list:
      // deleting a conversation must not erase its spend from all-time Usage
      // totals, so those rows outlive the authority they were projected from.
      database.prepare('DELETE FROM core_agent_runs WHERE session_id = ?').run(sessionId);
      database
        .prepare('DELETE FROM core_client_capability_session_grants WHERE session_id = ?')
        .run(sessionId);
      database.prepare('DELETE FROM workflow_goal_authority WHERE session_id = ?').run(sessionId);
      database.prepare('DELETE FROM workflow_event_waits WHERE session_id = ?').run(sessionId);
    });
  }

  close(): void {
    this.#lease.close();
  }
}
