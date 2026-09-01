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
  SESSION_TODO_CONTENT_MAX_CHARS,
  SESSION_TODO_MAX_ITEMS,
  SESSION_TODO_STATUSES,
  sessionTodoContentForDisplay,
  type SessionTodoSnapshot,
} from '@maka/core/session-todo';
import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';

export const TODO_READ_TOOL_NAME = 'todo_read';
export const TODO_WRITE_TOOL_NAME = 'todo_write';

export interface SessionTodoToolStore {
  read(sessionId: string): Promise<SessionTodoSnapshot>;
  replace(sessionId: string, items: unknown): Promise<SessionTodoSnapshot>;
}

export function buildSessionTodoTools(store: SessionTodoToolStore): MakaTool[] {
  return [buildTodoReadTool(store), buildTodoWriteTool(store)];
}

function buildTodoReadTool(store: SessionTodoToolStore): MakaTool<Record<string, never>, string> {
  return {
    name: TODO_READ_TOOL_NAME,
    displayName: 'Todo Read',
    description:
      'Read the complete current session Todo list. Use this when you need the latest checklist.',
    parameters: z.object({}).strict(),
    impl: async (_input, ctx) => renderTodoSnapshot(await store.read(ctx.sessionId), 'read'),
  };
}

function buildTodoWriteTool(
  store: SessionTodoToolStore,
): MakaTool<
  { todos: Array<{ content: string; status: (typeof SESSION_TODO_STATUSES)[number] }> },
  string
> {
  return {
    name: TODO_WRITE_TOOL_NAME,
    displayName: 'Todo Write',
    description:
      'Atomically replace the complete current session Todo list. Include every item that should remain. ' +
      'Completed means model-reported progress; it is not independently verified execution evidence.',
    parameters: z
      .object({
        todos: z
          .array(
            z
              .object({
                content: z
                  .string()
                  .trim()
                  .min(1)
                  .refine(
                    (content) =>
                      [...content.normalize('NFC')].length <= SESSION_TODO_CONTENT_MAX_CHARS,
                    `Todo content must be ${SESSION_TODO_CONTENT_MAX_CHARS} characters or fewer`,
                  ),
                status: z.enum(SESSION_TODO_STATUSES),
              })
              .strict(),
          )
          .max(SESSION_TODO_MAX_ITEMS),
      })
      .strict(),
    impl: async (input, ctx) =>
      renderTodoSnapshot(await store.replace(ctx.sessionId, input.todos), 'write'),
  };
}

function renderTodoSnapshot(snapshot: SessionTodoSnapshot, operation: 'read' | 'write'): string {
  if (snapshot.items.length === 0) {
    return operation === 'write' ? 'Todo list cleared.' : 'Todo list is empty.';
  }
  const lines = snapshot.items.map(
    (item, index) =>
      `${index + 1}. [${item.status}] ${JSON.stringify(sessionTodoContentForDisplay(item.content))}`,
  );
  const prefix = operation === 'write' ? 'Todo list updated' : 'Todo list';
  return `${prefix} (${snapshot.items.length} items):\n${lines.join('\n')}`;
}
