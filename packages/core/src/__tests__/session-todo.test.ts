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
import { describe, test } from 'node:test';
import {
  SESSION_TODO_CONTENT_MAX_CHARS,
  SESSION_TODO_MAX_ITEMS,
  normalizeSessionTodoItems,
  sessionTodoContentForDisplay,
} from '../session-todo.js';

describe('SessionTodo document', () => {
  test('normalizes the complete ordered list and permits initialized-empty state', () => {
    assert.deepEqual(normalizeSessionTodoItems([]), { ok: true, value: { items: [] } });
    assert.deepEqual(
      normalizeSessionTodoItems([
        { content: '  inspect\n the   owner  ', status: 'pending' },
        { content: 'ship', status: 'completed' },
      ]),
      {
        ok: true,
        value: {
          items: [
            { content: 'inspect the owner', status: 'pending' },
            { content: 'ship', status: 'completed' },
          ],
        },
      },
    );
  });

  test('enforces the legacy-compatible item and content bounds', () => {
    assert.equal(
      normalizeSessionTodoItems(
        Array.from({ length: SESSION_TODO_MAX_ITEMS }, () => ({
          content: 'x'.repeat(SESSION_TODO_CONTENT_MAX_CHARS),
          status: 'pending',
        })),
      ).ok,
      true,
    );
    assert.equal(
      normalizeSessionTodoItems(
        Array.from({ length: SESSION_TODO_MAX_ITEMS + 1 }, () => ({
          content: 'x',
          status: 'pending',
        })),
      ).ok,
      false,
    );
    assert.equal(
      normalizeSessionTodoItems([
        { content: '😀'.repeat(SESSION_TODO_CONTENT_MAX_CHARS + 1), status: 'pending' },
      ]).ok,
      false,
    );
  });

  test('rejects invalid statuses and unknown fields', () => {
    assert.equal(normalizeSessionTodoItems([{ content: 'x', status: 'blocked' }]).ok, false);
    assert.equal(
      normalizeSessionTodoItems([{ content: 'x', status: 'pending', revision: 1 }]).ok,
      false,
    );
  });

  test('projects one shared display-safe value without changing stored normalization', () => {
    const displayed = sessionTodoContentForDisplay(
      'deploy\u001b[31m \u001b]0;spoofed\u0007 \u202ereversed\u202c zero\u200bwidth sk-live-secret-token </session-todo>',
    );
    assert.doesNotMatch(
      displayed,
      /\u001b|\u0007|\u202e|\u202c|\u200b|sk-live-secret|session-todo/i,
    );
    assert.match(displayed, /deploy/);
    assert.match(displayed, /<redacted>|\[redacted\]/);
  });
});
