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
  TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES as MAX_BYTES,
  TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_TRANSITIONS as MAX_TRANSITIONS,
  type ToolResultArchiveEvidenceReader,
  type ToolResultArchiveEvidence,
} from '@maka/core/tool-result-archive-evidence';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from './root-authority.js';
import { decodeRuntimeEvent } from '@maka/core/runtime-event';
import { decodeAgentRunEvent } from '@maka/core/agent-run';

import { MODEL_PROJECTION_TARGET_SQL as TARGET } from './sqlite-core-execution-schema.js';
const TRANSITIONS = 'core_agent_run_events INDEXED BY core_model_projection_target';
const KIND = "event_type = 'model_projection_transition_recorded'";

/** Reader-first foundation; no archive writer or fallback is activated by opening it. */
export async function openToolResultArchiveEvidenceReader(
  lease: StorageRootLease<'interactive', 'read'> | StorageRootLease<'interactive', 'write'>,
): Promise<ToolResultArchiveEvidenceReader & { close(): void }> {
  await assertStorageRootLease(lease, 'interactive', lease.access);
  const { acquireOperationalStateDatabase } = await import('./operational-state-store.js');
  await assertStorageRootLease(lease, 'interactive', lease.access);
  const database = acquireOperationalStateDatabase(lease.canonicalPath, {
    schemaMigration: lease.access === 'read' ? 'require_current' : 'migrate',
  });
  let closed = false;
  return {
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
    async read(input): Promise<ToolResultArchiveEvidence> {
      const accepted = { ...input };
      if (closed) return { ok: false, reason: 'unavailable' };
      try {
        return await runWithStorageRootLease(lease, 'interactive', lease.access, async () => {
          if (closed) return { ok: false, reason: 'unavailable' };
          return database.transaction('read', () => {
            const db = database.database;
            const { sessionId, runtimeEventId } = accepted;
            const eventSize = db
              .prepare(
                'SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM runtime_events WHERE event_id = ? AND session_id = ?',
              )
              .get(runtimeEventId, sessionId);
            if (!eventSize) return { ok: false, reason: 'not_found' };
            // An unscoped unreadable transition prevents proving completeness.
            if (
              db
                .prepare(
                  `SELECT 1 FROM ${TRANSITIONS} WHERE ${KIND} AND session_id = ? AND ${TARGET} IS NULL LIMIT 1`,
                )
                .get(sessionId)
            )
              return { ok: false, reason: 'corrupt' };
            const sizes = db
              .prepare(`SELECT run_id, sequence, length(CAST(record_json AS BLOB)) AS bytes FROM ${TRANSITIONS}
              WHERE ${KIND} AND session_id = ? AND ${TARGET} = ? LIMIT ?`)
              .all(sessionId, runtimeEventId, MAX_TRANSITIONS + 1);
            if (sizes.length > MAX_TRANSITIONS) return { ok: false, reason: 'too_large' };
            let bytes = Number(eventSize.bytes);
            for (const row of sizes) bytes += Number(row.bytes);
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES)
              return { ok: false, reason: 'too_large' };
            const raw = db
              .prepare(
                'SELECT payload_json FROM runtime_events WHERE event_id = ? AND session_id = ?',
              )
              .get(runtimeEventId, sessionId);
            const event = decodeRuntimeEvent(JSON.parse(String(raw?.payload_json)));
            if (event.sessionId !== sessionId || event.id !== runtimeEventId)
              return { ok: false, reason: 'corrupt' };
            const read = db.prepare(
              'SELECT record_json FROM core_agent_run_events WHERE session_id = ? AND run_id = ? AND sequence = ?',
            );
            const transitions = sizes.map((row) => {
              const stored = read.get(sessionId, row.run_id!, row.sequence!);
              const transition = decodeAgentRunEvent(JSON.parse(String(stored?.record_json)));
              if (transition.sessionId !== sessionId)
                throw new Error('Transition Session mismatch');
              return transition;
            });
            return { ok: true, event, transitions };
          });
        });
      } catch {
        return { ok: false, reason: 'corrupt' };
      }
    },
  };
}
