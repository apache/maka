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

// Build first: npx tsc -b packages/core packages/storage packages/runtime
// Run: node packages/runtime/scripts/benchmark-recall.mjs [turns=20000] [samples=7]
// Synthetic in-memory ledger, one opening/user/terminal per Turn; ten hits.
// Timings cover Core Recall + SQLite + projection, excluding IPC and UI.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runRecall } from '@maka/core/recall';
import { SqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { RuntimeReadModel } from '../dist/runtime-read-model.js';

const turns = Number(process.argv[2] ?? 20000);
const samples = Number(process.argv[3] ?? 7);
assert.ok(Number.isSafeInteger(turns) && turns > 0);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const store = new SqliteRuntimeStore(':memory:');
try {
  // Seed beneath the writer so write-path work is not part of this read benchmark.
  const db = store.db;
  const insert = db.prepare(`INSERT INTO runtime_events
    (event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind, payload_json, committed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ordinal = db.prepare('INSERT INTO runtime_session_event_ordinals VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let index = 0; index < turns; index += 1) {
    const base = {
      sessionId: 'session',
      invocationId: `inv-${index}`,
      runId: `run-${index}`,
      turnId: `turn-${index}`,
      partial: false,
    };
    const events = [
      {
        ...base,
        id: `opening-${index}`,
        ts: index * 3 + 1,
        role: 'system',
        author: 'system',
        modelVisibility: 'hidden',
        content: {
          kind: 'invocation_opened',
          protocol: 'invocation_opened_v1',
          route: {
            provenance: 'runtime',
            backendKind: 'fake',
            llmConnectionId: 'fake-connection',
            llmConnectionSlug: 'fake',
            modelId: 'fake-model',
          },
          configuration: {
            cwd: '/tmp',
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
            orchestrationSource: 'session',
            toolMode: 'direct',
          },
          root: { kind: 'user' },
          source: { kind: 'fresh' },
        },
      },
      {
        ...base,
        id: `user-${index}`,
        ts: index * 3 + 2,
        role: 'user',
        author: 'user',
        content: {
          kind: 'text',
          text: index < 10 ? 'deploy target' : 'ordinary unrelated content',
        },
      },
      {
        ...base,
        id: `terminal-${index}`,
        ts: index * 3 + 3,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      },
    ];
    for (const [offset, event] of events.entries()) {
      insert.run(
        event.id,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        offset + 1,
        event.content?.kind ?? 'invocation_end',
        JSON.stringify(event),
        event.ts,
      );
      ordinal.run(event.sessionId, index * 3 + offset + 1, event.id);
    }
  }
  db.exec('COMMIT');

  const unbatched = new Proxy(store, {
    get(target, key) {
      if (key === 'readSessionRuntimeSnapshot') return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const lanes = [unbatched, store].map((runtimeEventStore, index) => {
    const model = new RuntimeReadModel({ runtimeEventStore });
    return {
      name: index === 0 ? 'individual-reads' : 'batch-snapshot',
      model,
      timings: [],
      query: () =>
        runRecall(
          { terms: ['deploy'], limit: 10 },
          {
            listSessions: async () => [
              {
                id: 'session',
                name: 'session',
                backend: 'runtime-host',
                isArchived: false,
                isFlagged: false,
                lastMessageAt: 1,
              },
            ],
            readMessages: (id) => model.getSessionMessages(id),
            listCandidateSessions: ({ sessionIds, terms }) =>
              store.listSessionsWithRuntimeEventText(sessionIds, terms),
            countSearchableMessages: ({ sessionIds }) =>
              store.countRuntimeEventMessages(sessionIds),
            getPrivacyContext: async () => ({ incognitoActive: false }),
          },
        ),
    };
  });
  const expected = await lanes[0].query();
  assert.ok(expected.ok);
  assert.equal(expected.passages.length, Math.min(turns, 10));
  assert.deepEqual(await lanes[1].query(), expected);
  // Alternate order to reduce systematic warm-cache bias. No probes in timed runs.
  for (let sample = 0; sample < samples; sample += 1) {
    for (const lane of sample % 2 ? [...lanes].reverse() : lanes) {
      const start = performance.now();
      const result = await lane.query();
      lane.timings.push(performance.now() - start);
      assert.deepEqual(result, expected);
    }
  }
  console.log(
    JSON.stringify({
      node: process.version,
      turns,
      samples,
      returnedPassages: expected.passages.length,
    }),
  );
  for (const lane of lanes) {
    const prepare = db.prepare;
    const parse = JSON.parse;
    let statements = 0;
    let parses = 0;
    db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (['all', 'get', 'iterate'].includes(key)) statements += 1;
            return Reflect.apply(value, target, args);
          };
        },
      });
    };
    JSON.parse = (...args) => {
      parses += 1;
      return parse(...args);
    };
    try {
      await lane.model.getSessionMessages('session');
    } finally {
      db.prepare = prepare;
      JSON.parse = parse;
    }
    if (lane.name === 'batch-snapshot') {
      assert.equal(statements, 5);
      assert.equal(parses, turns * 3);
    }
    const sorted = [...lane.timings].sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        lane: lane.name,
        medianQueryMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        readModelStatements: statements,
        readModelJsonParses: parses,
        querySamplesMs: lane.timings.map((ms) => +ms.toFixed(2)),
      }),
    );
  }
} finally {
  store.close();
}
