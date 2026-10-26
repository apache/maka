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
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { connectClient, withExecutionRoot } from './fixtures/execution-host-suite.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../storage/src/__tests__/fixtures/legacy-goal-event-waits.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
for (const state of [
  'registered',
  'unsettled',
  'waiting',
  'queued',
  'admitted',
  'completed',
  'suppressed',
]) {
  test(`Host upgrades released ${state} Goal wait without replay and reopens its history`, {
    timeout: 30_000,
  }, async () => {
    await withExecutionRoot(async (f) => {
      const { rows } = JSON.parse(
        JSON.stringify(fixture[state])
          .replaceAll('legacy-session', f.sessionId)
          .replaceAll('/legacy-root', f.root),
      ) as { rows: Record<string, Array<Record<string, SQLInputValue>>> };
      const db = new DatabaseSync(join(f.root, 'runtime.sqlite'));
      db.exec('DROP TABLE workflow_event_waits');
      for (const sql of fixture.schema) db.exec(sql);
      for (const [table, entries] of Object.entries(rows))
        for (const row of entries) {
          const columns = Object.keys(row);
          db.prepare(
            `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          ).run(...Object.values(row));
        }
      db.prepare(
        "UPDATE operational_schema_migrations SET version=15 WHERE scope='workflow'",
      ).run();
      db.close();
      const host = await f.startHost();
      const client = await connectClient(f.root);
      try {
        const { goal } = await client.request('goal.query', { sessionId: f.sessionId });
        assert.ok(goal);
        if (state === 'completed') assert.equal(goal.status, 'achieved');
        else assert.equal(goal.status, 'paused');
        if (['unsettled', 'waiting', 'queued'].includes(state)) {
          assert.equal(goal.iterations, 1);
        }
        if (state === 'registered') assert.equal(goal.iterations, 0);
        const current = new DatabaseSync(join(f.root, 'runtime.sqlite'), { readOnly: true });
        const record = JSON.parse(
          String(
            current.prepare('SELECT record_json FROM workflow_goal_authority').get()!.record_json,
          ),
        );
        if (['unsettled', 'waiting', 'queued'].includes(state))
          assert.equal(record.goal.tokensNow, 12);
        assert.equal(record.legacyEventWaitSettlement, undefined);
        assert.equal(record.currentExecution, null);
        assert.equal(current.prepare('SELECT count(*) AS n FROM workflow_event_waits').get()!.n, 0);
        assert.equal(
          current.prepare('SELECT count(*) AS n FROM core_root_turn_admissions').get()!.n,
          rows.core_root_turn_admissions!.length,
        );
        // Every original immutable fact survives byte-for-byte; Runtime may only append closure facts.
        for (const event of rows.runtime_events!)
          assert.equal(
            current
              .prepare('SELECT payload_json FROM runtime_events WHERE event_id=?')
              .get(event.event_id!)!.payload_json,
            event.payload_json,
          );
        if (state === 'completed') {
          assert.equal(
            current.prepare('SELECT count(*) AS n FROM runtime_events').get()!.n,
            rows.runtime_events!.length,
          );
        }
        const after = String(
          current.prepare('SELECT record_json FROM workflow_goal_authority').get()!.record_json,
        );
        current.close();
        client.close();
        await f.stopHost(host);
        if (state === 'completed') {
          const turn = await f.readTurn('next');
          assert.equal(turn.runs[0]!.terminalEvent!.status, 'completed');
          assert.equal(turn.userMessages[0]!.origin?.kind, 'goal');
        }
        const restarted = await f.startHost();
        const again = new DatabaseSync(join(f.root, 'runtime.sqlite'), { readOnly: true });
        assert.equal(
          again.prepare('SELECT record_json FROM workflow_goal_authority').get()!.record_json,
          after,
          'reopening cannot repeat accounting',
        );
        again.close();
        await f.stopHost(restarted);
      } finally {
        client.close();
      }
    });
  });
}
