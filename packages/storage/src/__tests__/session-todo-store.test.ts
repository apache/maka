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

const SESSION_ID = 'session-todo';

describe('SQLite SessionTodo store', () => {
  test('persists an initialized-empty document on the first read', async () => {
    await withRoot(async (root) => {
      const todos = createSqliteSessionTodoStore(root);
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), { items: [] });
      assert.deepEqual(await todos.readOrBootstrap(SESSION_ID), { items: [] });
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

  test('serializes a first explicit replacement ahead of a following bootstrap read', async () => {
    await withRoot(async (root) => {
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

  test('writes an explicit empty copy marker when the copy skips current state', async () => {
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
      todos.close();

      // The copy must persist the marker itself: reading it back would return an
      // empty document either way, so only the stored row separates "wrote an
      // explicit empty copy" from "wrote nothing at all".
      const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          database
            .prepare(
              'SELECT COUNT(*) AS count FROM workflow_session_todo_documents WHERE session_id = ?',
            )
            .get('historical-target')!.count,
          1,
        );
      } finally {
        database.close();
      }
    });
  });

  test('copies an uninitialized source as empty without initializing the source', async () => {
    await withRoot(async (root) => {
      const todos = createSqliteSessionTodoStore(root);
      const input = { sourceSessionId: 'source', targetSessionId: 'target', copyCurrent: true };
      assert.deepEqual(await todos.initializeCopy(input), { items: [] });
      assert.deepEqual(await todos.initializeCopy(input), { items: [] });
      todos.close();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        const rows = database
          .prepare('SELECT session_id FROM workflow_session_todo_documents ORDER BY session_id')
          .all() as Array<{ session_id: string }>;
        assert.deepEqual(
          rows.map((row) => row.session_id),
          ['target'],
        );
      } finally {
        database.close();
      }
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
