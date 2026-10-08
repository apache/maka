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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { createSessionStore } from '../session-store.js';
import {
  exportSessionBundleState,
  listSessionBundleMergeTables,
} from '../session-bundle-policy.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

test('exports one Session as filtered SQLite', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-'));
  const stateRoot = join(base, 'state');
  const configRoot = join(base, 'config');
  const destinationRoot = join(base, 'bundle');
  await mkdir(configRoot, { recursive: true });
  const sessions = createSessionStore(stateRoot);
  try {
    const selected = await sessions.create(input('Selected'));
    const excluded = await sessions.create(input('Excluded'));
    await sessions.appendMessage(selected.id, message('selected-message'));
    await sessions.appendMessage(excluded.id, message('excluded-message'));
    await sessions.close?.();
    const sourceDatabase = new DatabaseSync(join(stateRoot, 'runtime.sqlite'));
    sourceDatabase
      .prepare('INSERT INTO usage_pricing_overrides(model_key, record_json) VALUES (?, ?)')
      .run('private-model', '{}');
    sourceDatabase.close();

    const plan = await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: selected.id,
    });
    assert.deepEqual(plan.includedEntries, ['runtime.sqlite']);
    const database = new DatabaseSync(join(destinationRoot, 'runtime.sqlite'), { readOnly: true });
    try {
      const ids = database
        .prepare('SELECT session_id FROM session_metadata ORDER BY session_id')
        .all()
        .map((row) => (row as { session_id: string }).session_id);
      assert.deepEqual(ids, [selected.id]);
      assert.equal(
        (
          database.prepare('SELECT COUNT(*) AS count FROM session_messages').get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.equal(
        (
          database.prepare('SELECT COUNT(*) AS count FROM usage_pricing_overrides').get() as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('retains only the selected Session partial stream segments', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-partials-'));
  const stateRoot = join(base, 'state');
  const configRoot = join(base, 'config');
  const destinationRoot = join(base, 'bundle');
  const databasePath = join(stateRoot, 'runtime.sqlite');
  await mkdir(configRoot, { recursive: true });
  const sessions = createSessionStore(stateRoot);
  try {
    const selected = await sessions.create(input('Selected'));
    const excluded = await sessions.create(input('Excluded'));
    await sessions.close?.();

    const runtime = createSqliteRuntimeStore(databasePath);
    try {
      await runtime.appendRuntimeEvent(
        selected.id,
        'selected-run',
        partialEvent(selected.id, 'selected-run', 'selected', 1, 'a'),
      );
      await runtime.appendRuntimeEvent(
        selected.id,
        'selected-run',
        partialEvent(selected.id, 'selected-run', 'selected', 2, 'b'),
      );
      await runtime.appendRuntimeEvent(
        excluded.id,
        'excluded-run',
        partialEvent(excluded.id, 'excluded-run', 'excluded', 3, 'secret'),
      );
    } finally {
      runtime.close();
    }

    await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: selected.id,
    });

    const bundledDatabasePath = join(destinationRoot, 'runtime.sqlite');
    const bundledRuntime = createSqliteRuntimeStore(bundledDatabasePath, { readOnly: true });
    try {
      const selectedEvents = await bundledRuntime.readRuntimeEvents(selected.id, 'selected-run');
      assert.equal(selectedEvents.length, 1);
      assert.equal(
        selectedEvents[0]?.content?.kind === 'text' ? selectedEvents[0].content.text : undefined,
        'ab',
      );
      assert.deepEqual(await bundledRuntime.readRuntimeEvents(excluded.id, 'excluded-run'), []);
    } finally {
      bundledRuntime.close();
    }
    const bundledDatabase = new DatabaseSync(bundledDatabasePath, { readOnly: true });
    try {
      assert.deepEqual(
        bundledDatabase
          .prepare('SELECT text_content FROM runtime_partial_segments ORDER BY segment_seq')
          .all()
          .map((row) => (row as { text_content: string }).text_content),
        ['ab'],
      );
    } finally {
      bundledDatabase.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * Copied Session tables whose single INTEGER key is a portable value, so the
 * import keeps it instead of letting the target allocate one. Each entry needs
 * a one-line reason. Empty: every such key in the current schema is a
 * database-local rowid, and those belong in `LOCAL_SEQUENCE_COLUMNS`.
 */
const PORTABLE_INTEGER_KEYS = new Map<string, string>([]);

test('reallocates every database-local INTEGER key an import copies', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-keys-'));
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  const configRoot = join(base, 'config');
  const destinationRoot = join(base, 'bundle');
  await mkdir(configRoot, { recursive: true });
  try {
    // A real export, so the attached tables are the ones an import sees.
    const sessions = createSessionStore(sourceRoot);
    const session = await sessions.create(input('Exported'));
    await sessions.close?.();
    await exportSessionBundleState({
      stateRoot: sourceRoot,
      configRoot,
      destinationRoot,
      sessionId: session.id,
    });

    // Opened and migrated the way the import opens its target.
    const lease = acquireOperationalStateDatabase(targetRoot);
    const target = lease.database;
    const bundlePath = join(destinationRoot, 'runtime.sqlite');
    target.exec(`ATTACH DATABASE '${bundlePath.replaceAll("'", "''")}' AS bundle`);
    try {
      const merged = listSessionBundleMergeTables(target);
      assert.ok(merged.some((table) => table.name === 'session_metadata'));
      const unclassified: string[] = [];
      for (const { name, localSequenceColumn } of merged) {
        const key = singleIntegerKey(target, name);
        if (localSequenceColumn !== undefined) {
          assert.equal(
            key,
            localSequenceColumn,
            `${name}.${localSequenceColumn} is reallocated but is not the table's single INTEGER key`,
          );
        } else if (key !== undefined && PORTABLE_INTEGER_KEYS.get(name) !== key) {
          unclassified.push(`${name}.${key}`);
        }
      }
      assert.deepEqual(
        unclassified,
        [],
        'An import copies these single INTEGER keys verbatim, so they collide in a populated ' +
          'workspace: add each to LOCAL_SEQUENCE_COLUMNS, or to PORTABLE_INTEGER_KEYS with a reason',
      );
    } finally {
      target.exec('DETACH DATABASE bundle');
      lease.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/** The table's primary key column when it is exactly one INTEGER column. */
function singleIntegerKey(database: DatabaseSync, table: string): string | undefined {
  const [key, ...rest] = (
    database.prepare(`PRAGMA main.table_info("${table.replaceAll('"', '""')}")`).all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>
  ).filter((column) => column.pk > 0);
  return key && rest.length === 0 && key.type.toUpperCase() === 'INTEGER' ? key.name : undefined;
}

function input(name: string): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
    name,
    labels: [],
  };
}

function message(id: string) {
  return { type: 'user' as const, id, turnId: 'turn-1', ts: 1, text: id };
}

function partialEvent(
  sessionId: string,
  runId: string,
  prefix: string,
  ts: number,
  text: string,
): RuntimeEvent {
  return {
    id: `${prefix}-partial-${ts}`,
    invocationId: `${prefix}-invocation`,
    runId,
    sessionId,
    turnId: `${prefix}-turn`,
    ts,
    partial: true,
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text },
    refs: { providerEventId: `${prefix}-message` },
  };
}
