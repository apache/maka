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
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteModelCallLedger, type ModelCallLedger } from '../../model-call-ledger.js';
import { acquireOperationalStateDatabase } from '../../operational-state-store.js';

/** A realistic epoch-ms clock: a small value pushes "40 days ago" below zero. */
export const MODEL_CALL_NOW = 1_750_000_000_000;

export function modelCallAttempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    startedAt: MODEL_CALL_NOW - 1_000,
    completedAt: MODEL_CALL_NOW - 500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 100,
    outputTokens: 20,
    costBasis: 'priced',
    costUsd: 0.004,
    ...overrides,
  };
}

/** An attempt carrying the request evidence and diagnostics the ledger drops. */
export function wideModelCallAttempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return modelCallAttempt({
    promptComposition: { segments: [{ kind: 'messages', bytes: 4_096 }] },
    requestObservation: {
      schemaVersion: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: 27_817,
      segments: [
        {
          kind: 'tool_schema',
          index: 0,
          cacheable: true,
          comparison: 'exact',
          digest: `sha256:${'0'.repeat(64)}`,
          bytes: 434,
          label: 'tool-0',
        },
      ],
    },
    providerRequestId: 'req-1',
    httpStatus: 200,
    pricingRevision: 3,
    ...overrides,
  });
}

export async function withLedger(
  run: (ledger: ModelCallLedger, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-'));
  const ledger = createSqliteModelCallLedger(root);
  try {
    await run(ledger, root);
  } finally {
    await ledger.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Commits one attempt to the AgentRun authority the projection reads from.
 *
 * Tests seed through the authority rather than the ledger's table on purpose:
 * nothing in production writes a row any other way.
 */
export function appendAuthorityEvent(
  root: string,
  sequence: number,
  value: ModelCallAttempt | { readonly schemaVersion: number },
  sessionId = 'session-1',
  runId = 'run-1',
): void {
  const lease = acquireOperationalStateDatabase(root);
  try {
    lease.transaction('write', () => {
      lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_agent_runs(session_id, run_id, created_at)
          VALUES (?, ?, ?)
        `)
        .run(sessionId, runId, MODEL_CALL_NOW - 1_000);
      lease.database
        .prepare(`
          INSERT INTO core_agent_run_events(
            session_id, run_id, sequence, event_id, event_type, event_ts, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          sessionId,
          runId,
          sequence,
          `event-${sessionId}-${runId}-${sequence}`,
          MODEL_CALL_ATTEMPT_EVENT_TYPE,
          MODEL_CALL_NOW - 500 + sequence,
          JSON.stringify({
            id: `event-${sessionId}-${runId}-${sequence}`,
            type: MODEL_CALL_ATTEMPT_EVENT_TYPE,
            ts: MODEL_CALL_NOW - 500 + sequence,
            sessionId,
            runId,
            turnId: 'turn-1',
            data: value,
          }),
        );
      lease.database
        .prepare(`
          UPDATE core_agent_runs
          SET latest_model_call_sequence = ?
          WHERE session_id = ? AND run_id = ?
        `)
        .run(sequence, sessionId, runId);
    });
  } finally {
    lease.close();
  }
}

/** Projects a whole set of attempts and returns the ledger holding them. */
export async function withProjectedAttempts(
  attempts: readonly ModelCallAttempt[],
  run: (ledger: ModelCallLedger, root: string) => Promise<void>,
): Promise<void> {
  await withLedger(async (ledger, root) => {
    attempts.forEach((value, index) => {
      appendAuthorityEvent(root, index, value, value.sessionId, value.runId);
    });
    await ledger.catchUpProjection();
    await run(ledger, root);
  });
}
