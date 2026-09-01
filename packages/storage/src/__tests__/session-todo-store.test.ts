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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSessionTodoStore } from '../session-todo-store.js';
import { createSqliteTaskLedgerStore } from '../task-ledger-store.js';

const SESSION_ID = 'session-todo';

describe('SQLite SessionTodo store', () => {
  test('bootstraps active legacy Tasks once and persists the document', async () => {
    await withRoot(async (root) => {
      const tasks = createSqliteTaskLedgerStore(root);
      const created = await tasks.create(SESSION_ID, [
        { subject: 'pending legacy work' },
        { subject: 'completed legacy work' },
      ]);
      await tasks.update(SESSION_ID, created.created[1]!.id, { status: 'in_progress' });
      await tasks.update(SESSION_ID, created.created[1]!.id, {
        status: 'completed',
        completionEvidence: 'done',
      });
      tasks.close();

      const todos = createSqliteSessionTodoStore(root);
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), {
        items: [{ content: 'pending legacy work', status: 'pending' }],
      });
      todos.close();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          database
            .prepare(
              'SELECT COUNT(*) AS count FROM workflow_session_todo_documents WHERE session_id = ?',
            )
            .get(SESSION_ID)!.count,
          1,
        );
      } finally {
        database.close();
      }
    });
  });

  test('keeps a blocked legacy Task visible as pending without importing workflow metadata', async () => {
    await withRoot(async (root) => {
      const tasks = createSqliteTaskLedgerStore(root);
      const created = await tasks.create(SESSION_ID, [{ subject: 'waiting for approval' }]);
      const taskId = created.created[0]!.id;
      await tasks.update(SESSION_ID, taskId, { status: 'in_progress' });
      await tasks.update(SESSION_ID, taskId, {
        status: 'blocked',
        blockedReason: 'approval has not arrived',
      });
      tasks.close();

      const todos = createSqliteSessionTodoStore(root);
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), {
        items: [{ content: 'waiting for approval', status: 'pending' }],
      });
      todos.close();
    });
  });

  test('persists initialized-empty and never revives later legacy Tasks', async () => {
    await withRoot(async (root) => {
      const todos = createSqliteSessionTodoStore(root);
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), { items: [] });

      const tasks = createSqliteTaskLedgerStore(root);
      await tasks.create(SESSION_ID, [{ subject: 'too late for bootstrap' }]);
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), { items: [] });
      tasks.close();
      todos.close();
    });
  });

  test('lets the first explicit replacement win without reading legacy state', async () => {
    await withRoot(async (root) => {
      const tasks = createSqliteTaskLedgerStore(root);
      await tasks.create(SESSION_ID, [{ subject: 'legacy work' }]);
      tasks.close();

      const todos = createSqliteSessionTodoStore(root);
      assert.deepEqual(await todos.replaceAll(SESSION_ID, []), { items: [] });
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), { items: [] });
      todos.close();
    });
  });

  test('serializes a first explicit replacement ahead of a following bootstrap read', async () => {
    await withRoot(async (root) => {
      const tasks = createSqliteTaskLedgerStore(root);
      await tasks.create(SESSION_ID, [{ subject: 'legacy work' }]);
      tasks.close();

      const todos = createSqliteSessionTodoStore(root);
      const [written, read] = await Promise.all([
        todos.replaceAll(SESSION_ID, [{ content: 'explicit work', status: 'in_progress' }]),
        todos.readOrBootstrap(SESSION_ID),
      ]);
      assert.deepEqual(written, {
        items: [{ content: 'explicit work', status: 'in_progress' }],
      });
      assert.deepEqual(read, written);
      todos.close();
    });
  });

  test('persists replacement order across reopen and purge restores uninitialized state', async () => {
    await withRoot(async (root) => {
      const first = createSqliteSessionTodoStore(root);
      await first.replaceAll(SESSION_ID, [
        { content: 'second', status: 'in_progress' },
        { content: 'first', status: 'pending' },
      ]);
      first.close();

      const reopened = createSqliteSessionTodoStore(root);
      assert.deepEqual(await reopened.readOrBootstrap(SESSION_ID), {
        items: [
          { content: 'second', status: 'in_progress' },
          { content: 'first', status: 'pending' },
        ],
      });
      await reopened.purgeSessionState(SESSION_ID);
      assert.deepEqual(await reopened.readOrBootstrap(SESSION_ID), { items: [] });
      reopened.close();
    });
  });

  test('fails closed on corrupt legacy events without writing an initialized marker', async () => {
    await withRoot(async (root) => {
      createSqliteTaskLedgerStore(root).close();
      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database
          .prepare(`
            INSERT INTO workflow_task_ledger_events(session_id, sequence, event_id, record_json)
            VALUES (?, 0, 'bad-event', '{not-json')
          `)
          .run(SESSION_ID);
      } finally {
        database.close();
      }

      const todos = createSqliteSessionTodoStore(root);
      await assert.rejects(
        () => todos.readOrBootstrap(SESSION_ID),
        /Invalid legacy Task event JSON/,
      );
      todos.close();

      const verified = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          verified
            .prepare(
              'SELECT COUNT(*) AS count FROM workflow_session_todo_documents WHERE session_id = ?',
            )
            .get(SESSION_ID)!.count,
          0,
        );
      } finally {
        verified.close();
      }
    });
  });

  test('explicit replacement recovers without decoding corrupt legacy state', async () => {
    await withRoot(async (root) => {
      createSqliteTaskLedgerStore(root).close();
      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database
          .prepare(`
            INSERT INTO workflow_task_ledger_events(session_id, sequence, event_id, record_json)
            VALUES (?, 0, 'bad-event', '{not-json')
          `)
          .run(SESSION_ID);
      } finally {
        database.close();
      }

      const todos = createSqliteSessionTodoStore(root);
      assert.deepEqual(
        await todos.replaceAll(SESSION_ID, [{ content: 'explicit recovery', status: 'pending' }]),
        { items: [{ content: 'explicit recovery', status: 'pending' }] },
      );
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), {
        items: [{ content: 'explicit recovery', status: 'pending' }],
      });
      todos.close();
    });
  });

  test('fails closed on a corrupt current document but permits explicit replacement recovery', async () => {
    await withRoot(async (root) => {
      const initialized = createSqliteSessionTodoStore(root);
      await initialized.replaceAll(SESSION_ID, []);
      initialized.close();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database
          .prepare(
            'UPDATE workflow_session_todo_documents SET record_json = ? WHERE session_id = ?',
          )
          .run('{not-json', SESSION_ID);
      } finally {
        database.close();
      }

      const todos = createSqliteSessionTodoStore(root);
      await assert.rejects(() => todos.readOrBootstrap(SESSION_ID), /Invalid SessionTodo document/);
      assert.deepEqual(
        await todos.replaceAll(SESSION_ID, [{ content: 'recovered', status: 'pending' }]),
        { items: [{ content: 'recovered', status: 'pending' }] },
      );
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), {
        items: [{ content: 'recovered', status: 'pending' }],
      });
      todos.close();
    });
  });

  test('initializes latest copies atomically and accepts only an identical retry', async () => {
    await withRoot(async (root) => {
      const todos = createSqliteSessionTodoStore(root);
      await todos.replaceAll('source', [{ content: 'current work', status: 'in_progress' }]);
      const input = { sourceSessionId: 'source', targetSessionId: 'target', copyCurrent: true };
      const expected = { items: [{ content: 'current work', status: 'in_progress' as const }] };
      assert.deepEqual(await todos.initializeCopy(input), expected);
      assert.deepEqual(await todos.initializeCopy(input), expected);
      await todos.replaceAll('target', [{ content: 'different', status: 'pending' }]);
      await assert.rejects(() => todos.initializeCopy(input), /different state/);
      todos.close();
    });
  });

  test('fails closed when a copy source or target document is corrupt', async () => {
    await withRoot(async (root) => {
      const todos = createSqliteSessionTodoStore(root);
      await todos.replaceAll('source', [{ content: 'current work', status: 'pending' }]);
      await todos.replaceAll('corrupt-target', []);

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database
          .prepare(
            'UPDATE workflow_session_todo_documents SET record_json = ? WHERE session_id = ?',
          )
          .run('{not-json', 'corrupt-target');
      } finally {
        database.close();
      }

      await assert.rejects(
        () =>
          todos.initializeCopy({
            sourceSessionId: 'source',
            targetSessionId: 'corrupt-target',
            copyCurrent: true,
          }),
        /Invalid SessionTodo document JSON/,
      );

      const corruptSource = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        corruptSource
          .prepare(
            'UPDATE workflow_session_todo_documents SET record_json = ? WHERE session_id = ?',
          )
          .run('{not-json', 'source');
      } finally {
        corruptSource.close();
      }
      await assert.rejects(
        () =>
          todos.initializeCopy({
            sourceSessionId: 'source',
            targetSessionId: 'new-target',
            copyCurrent: true,
          }),
        /Invalid SessionTodo document JSON/,
      );

      const verified = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          verified
            .prepare(
              'SELECT COUNT(*) AS count FROM workflow_session_todo_documents WHERE session_id = ?',
            )
            .get('new-target')!.count,
          0,
        );
      } finally {
        verified.close();
      }
      todos.close();
    });
  });

  test('writes an explicit empty copy marker that later legacy events cannot revive', async () => {
    await withRoot(async (root) => {
      const todos = createSqliteSessionTodoStore(root);
      assert.deepEqual(
        await todos.initializeCopy({
          sourceSessionId: 'source',
          targetSessionId: 'historical-target',
          copyCurrent: false,
        }),
        { items: [] },
      );
      const tasks = createSqliteTaskLedgerStore(root);
      await tasks.create('historical-target', [{ subject: 'must not revive' }]);
      tasks.close();
      assert.deepEqual(await todos.readOrBootstrap('historical-target'), { items: [] });
      todos.close();
    });
  });

  test('purges Todo and legacy bootstrap rows in one lifecycle operation', async () => {
    await withRoot(async (root) => {
      const tasks = createSqliteTaskLedgerStore(root);
      await tasks.create(SESSION_ID, [{ subject: 'legacy' }]);
      tasks.close();
      const todos = createSqliteSessionTodoStore(root);
      await todos.replaceAll(SESSION_ID, [{ content: 'current', status: 'pending' }]);
      await todos.purgeSessionState(SESSION_ID);
      const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          database
            .prepare(
              'SELECT COUNT(*) AS count FROM workflow_session_todo_documents WHERE session_id = ?',
            )
            .get(SESSION_ID)!.count,
          0,
        );
        assert.equal(
          database
            .prepare(
              'SELECT COUNT(*) AS count FROM workflow_task_ledger_events WHERE session_id = ?',
            )
            .get(SESSION_ID)!.count,
          0,
        );
      } finally {
        database.close();
      }
      todos.close();
    });
  });

  test('linearizes concurrent whole-document replacements', async () => {
    await withRoot(async (root) => {
      const todos = createSqliteSessionTodoStore(root);
      const writes = Array.from({ length: 128 }, (_, index) =>
        todos.replaceAll(SESSION_ID, [{ content: `write ${index}`, status: 'pending' }]),
      );
      await Promise.all(writes);
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), {
        items: [{ content: 'write 127', status: 'pending' }],
      });
      todos.close();
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-todo-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
