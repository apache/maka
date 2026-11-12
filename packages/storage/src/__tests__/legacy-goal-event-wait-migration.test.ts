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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { decodeRuntimeEvent } from '@maka/core/runtime-event';
import { localExecutionPersistenceProvider } from '../local-execution-persistence.js';
import { createMemoryExecutionPersistenceProvider } from '../test-only/memory-execution-persistence.js';
import { normalizeRootExecutionDescriptor } from '../agent-run-store-contract.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from '../sqlite-workflow-schema.js';

type Rows = Record<string, Array<Record<string, SQLInputValue>>>;
const fixture = JSON.parse(
  readFileSync(
    new URL('../../src/__tests__/fixtures/legacy-goal-event-waits.json', import.meta.url),
    'utf8',
  ),
) as {
  schema: string[];
  [state: string]: unknown;
};

for (const version of [15, 16]) {
  for (const state of [
    'registered',
    'unsettled',
    'waiting',
    'queued',
    'admitted',
    'completed',
    'suppressed',
  ]) {
    test(`workflow ${version}: retires released ${state} wait without rewriting execution history`, async () => {
      await withLegacyRoot(state, version, async (root, sessionId, rows) => {
        const stores = await open(root);
        try {
          const goal = (await stores.goalStore.read(sessionId))!.record;
          const old = JSON.parse(String(rows.workflow_goal_authority![0]!.record_json));
          if (old.activeEventWait) {
            assert.equal(goal.goal.status, 'paused');
            assert.match(goal.goal.lastReason!, /retired during upgrade/);
            assert.equal(goal.controlLease.generation, old.controlLease.generation + 1);
            assert.equal(goal.pendingContinuation, null);
            assert.deepEqual(goal.currentExecution, old.currentExecution);
            assert.equal(Boolean(goal.legacyEventWaitSettlement), !old.activeEventWait.settled);
          } else assert.deepEqual(goal, old);
          assert.deepEqual(await stores.eventWaitStore.listSession({ sessionId, limit: 100 }), {
            items: [],
            nextCursor: null,
          });
          const admissions =
            await stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId);
          assert.equal(admissions.length, rows.core_root_turn_admissions!.length);
          for (const event of rows.runtime_events!)
            decodeRuntimeEvent(JSON.parse(String(event.payload_json)));
          if (state === 'completed') {
            const next = await stores.runtimeEventStore.readRunInvocation(sessionId, 'next-run');
            assert.equal(next!.opening.root.kind, 'goal');
            assert.equal(next!.terminalEvent!.status, 'completed');
            // An old successor remains part of the chain for later ordinary work.
            assert.equal(
              (
                await stores.agentRunStore.admitRootTurn({
                  sessionId,
                  turnId: 'later',
                  proposedRunId: 'later-run',
                  proposedUserMessageId: 'later-message',
                  execution: { kind: 'external_message' },
                  previousRootTurnId: 'next',
                  normalizedInput: { text: 'later' },
                  sourceMessages: [],
                  admittedAt: 130,
                })
              ).kind,
              'admitted',
            );
            const oldAdmission = admissions[1]!;
            await assert.rejects(
              () =>
                stores.agentRunStore.admitRootTurn({
                  sessionId,
                  turnId: 'forbidden',
                  proposedRunId: 'forbidden-run',
                  proposedUserMessageId: 'forbidden-message',
                  execution: oldAdmission.execution,
                  previousRootTurnId: 'later',
                  normalizedInput: { text: 'replay' },
                  sourceMessages: [],
                  admittedAt: 140,
                }),
              /retired Goal event wait/,
            );
          }
          const db = new DatabaseSync(join(root, 'runtime.sqlite'));
          assert.deepEqual(
            db
              .prepare('SELECT * FROM runtime_events')
              .all()
              .map((r) => ({ ...r })),
            rows.runtime_events,
          );
          assert.equal(
            db
              .prepare("SELECT version FROM operational_schema_migrations WHERE scope='workflow'")
              .get()!.version,
            SQLITE_WORKFLOW_SCHEMA_VERSION,
          );
          const before = db.prepare('SELECT * FROM workflow_goal_authority').all();
          db.close();
          await stores.close();
          const reopened = await open(root);
          await reopened.close();
          const check = new DatabaseSync(join(root, 'runtime.sqlite'));
          assert.deepEqual(check.prepare('SELECT * FROM workflow_goal_authority').all(), before);
          check.close();
        } finally {
          await stores.close();
        }
      });
    });
  }
}

test('legacy migration rolls back all changes for an unknown record and preserves neutral observations', async () => {
  await withLegacyRoot('waiting', 16, async (root, sessionId, rows) => {
    const db = new DatabaseSync(join(root, 'runtime.sqlite'));
    const row = rows.workflow_event_waits![0]!;
    const old = JSON.parse(String(row.record_json));
    const { goalControlLease: _lease, ...neutral } = old;
    const insert = db.prepare('INSERT INTO workflow_event_waits VALUES (?, ?, ?, ?, ?, ?, ?)');
    const unrelated = { ...neutral, waitId: 'neutral', deliveryKey: 'event-wait/neutral' };
    insert.run(
      'neutral',
      sessionId,
      0,
      'waiting',
      unrelated.deliveryKey,
      unrelated.deadlineAt,
      JSON.stringify(unrelated),
    );
    insert.run(
      'z-unknown',
      sessionId,
      0,
      'waiting',
      'event-wait/z-unknown',
      old.deadlineAt,
      JSON.stringify({
        ...old,
        waitId: 'z-unknown',
        deliveryKey: 'event-wait/z-unknown',
        unexpected: true,
      }),
    );
    const before = db.prepare('SELECT * FROM workflow_goal_authority').all();
    await assert.rejects(() => open(root));
    assert.deepEqual(db.prepare('SELECT * FROM workflow_goal_authority').all(), before);
    assert.equal(
      db.prepare("SELECT version FROM operational_schema_migrations WHERE scope='workflow'").get()!
        .version,
      16,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM workflow_event_waits').get()!.n, 3);
    db.prepare("DELETE FROM workflow_event_waits WHERE wait_id='z-unknown'").run();
    db.close();
    const stores = await open(root);
    try {
      assert.deepEqual(
        (await stores.eventWaitStore.read({ sessionId, waitId: 'neutral' }))!.record,
        unrelated,
      );
      assert.equal(
        (await stores.eventWaitStore.listSession({ sessionId, limit: 100 })).items.length,
        1,
      );
    } finally {
      await stores.close();
    }
  });
});

async function withLegacyRoot(
  state: string,
  version: number,
  run: (root: string, sessionId: string, rows: Rows) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-legacy-goal-'));
  try {
    const stores = await open(root);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await stores.close();
    const data = JSON.parse(
      JSON.stringify(fixture[state])
        .replaceAll('legacy-session', session.id)
        .replaceAll('/legacy-root', root),
    ) as { rows: Rows };
    const db = new DatabaseSync(join(root, 'runtime.sqlite'));
    if (version === 15) {
      db.exec('DROP TABLE workflow_event_waits');
      for (const sql of fixture.schema) db.exec(sql);
    }
    for (const [table, rows] of Object.entries(data.rows))
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(
          `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        ).run(...Object.values(row));
      }
    db.prepare("UPDATE operational_schema_migrations SET version=? WHERE scope='workflow'").run(
      version,
    );
    db.close();
    await run(root, session.id, data.rows);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function open(root: string) {
  return localExecutionPersistenceProvider.open({ rootId: 'test-root', canonicalPath: root });
}

test('Memory also refuses a new admission from historical Goal event-wait provenance', async () => {
  const stores = await createMemoryExecutionPersistenceProvider().open({
    rootId: 'memory',
    canonicalPath: '/memory',
  });
  try {
    const data = fixture.completed as { rows: Rows };
    const old = JSON.parse(String(data.rows.core_root_turn_admissions![1]!.record_json));
    const session = await stores.sessionStore.create({
      cwd: '/memory',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await assert.rejects(
      () =>
        stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'new',
          proposedRunId: 'new-run',
          proposedUserMessageId: 'new-message',
          execution: normalizeRootExecutionDescriptor(old.execution),
          previousRootTurnId: null,
          normalizedInput: { text: 'replay' },
          sourceMessages: [],
          admittedAt: 1,
        }),
      /retired Goal event wait/,
    );
    assert.deepEqual(await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id), []);
  } finally {
    await stores.close();
  }
});
