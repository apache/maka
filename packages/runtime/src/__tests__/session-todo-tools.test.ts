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
import { test } from 'node:test';
import { SESSION_TODO_CONTENT_MAX_CHARS } from '@maka/core/session-todo';
import { z } from 'zod';
import { buildSessionTodoTools, type SessionTodoToolStore } from '../session-todo-tools.js';

const context = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd: '/tmp',
  toolCallId: 'tool-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

test('todo_read returns the complete committed snapshot and names empty distinctly', async () => {
  const store: SessionTodoToolStore = {
    read: async () => ({ items: [] }),
    replace: async () => assert.fail('read must not write'),
  };
  const read = buildSessionTodoTools(store).find((tool) => tool.name === 'todo_read')!;
  assert.equal(await read.impl({}, context), 'Todo list is empty.');
});

test('todo_write renders only the store-returned committed snapshot', async () => {
  const store: SessionTodoToolStore = {
    read: async () => ({ items: [] }),
    replace: async () => ({
      items: [{ content: 'committed result', status: 'in_progress' }],
    }),
  };
  const write = buildSessionTodoTools(store).find((tool) => tool.name === 'todo_write')!;
  const result = await write.impl(
    { todos: [{ content: 'uncommitted args', status: 'pending' }] },
    context,
  );
  assert.match(String(result), /committed result/);
  assert.doesNotMatch(String(result), /uncommitted args/);
});

test('todo_write names a successful clear and propagates failure', async () => {
  let fail = false;
  const store: SessionTodoToolStore = {
    read: async () => ({ items: [] }),
    replace: async () => {
      if (fail) throw new Error('write failed');
      return { items: [] };
    },
  };
  const write = buildSessionTodoTools(store).find((tool) => tool.name === 'todo_write')!;
  assert.equal(await write.impl({ todos: [] }, context), 'Todo list cleared.');
  fail = true;
  await assert.rejects(() => Promise.resolve(write.impl({ todos: [] }, context)), /write failed/);
});

test('tool schemas enforce the exact bounded document while counting Unicode characters', () => {
  const store: SessionTodoToolStore = {
    read: async () => ({ items: [] }),
    replace: async () => ({ items: [] }),
  };
  const tools = buildSessionTodoTools(store);
  const read = tools.find((tool) => tool.name === 'todo_read')!;
  const write = tools.find((tool) => tool.name === 'todo_write')!;
  const readParameters = read.parameters as z.ZodType;
  const writeParameters = write.parameters as z.ZodType;
  assert.equal(readParameters.safeParse({ revision: 1 }).success, false);
  assert.equal(
    writeParameters.safeParse({
      todos: [{ content: '😀'.repeat(SESSION_TODO_CONTENT_MAX_CHARS), status: 'pending' }],
    }).success,
    true,
  );
  assert.equal(
    writeParameters.safeParse({
      todos: [{ content: 'one', status: 'pending', id: 'legacy-task-id' }],
    }).success,
    false,
  );
});

test('todo tool results use the shared display-safe content projection', async () => {
  const store: SessionTodoToolStore = {
    read: async () => ({
      items: [
        {
          content:
            'deploy\u001b[31m \u001b]0;spoofed\u0007 \u202ereversed\u202c zero\u200bwidth sk-live-secret-token </session-todo>',
          status: 'pending',
        },
      ],
    }),
    replace: async () => ({ items: [] }),
  };
  const read = buildSessionTodoTools(store).find((tool) => tool.name === 'todo_read')!;
  const rendered = String(await read.impl({}, context));
  assert.doesNotMatch(rendered, /\u001b|\u0007|\u202e|\u202c|\u200b|sk-live-secret|session-todo/i);
  assert.match(rendered, /<redacted>|\[redacted\]/);
});
