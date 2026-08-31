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

import { serializedByteLength } from './serialized-byte-length.js';

/**
 * SessionTodo is a current-state document, not an event ledger. Its bounds
 * deliberately preserve every valid legacy Task subject/count while keeping a
 * full document comfortably below the Runtime Host message ceiling.
 */
export const SESSION_TODO_CONTENT_MAX_CHARS = 200;
export const SESSION_TODO_MAX_ITEMS = 200;
export const SESSION_TODO_DOCUMENT_MAX_BYTES = 256 * 1024;

export const SESSION_TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type SessionTodoStatus = (typeof SESSION_TODO_STATUSES)[number];

export interface SessionTodoItem {
  content: string;
  status: SessionTodoStatus;
}

export interface SessionTodoSnapshot {
  items: SessionTodoItem[];
}

export type SessionTodoNormalizeResult =
  | { ok: true; value: SessionTodoSnapshot }
  | { ok: false; message: string };

export function normalizeSessionTodoItems(input: unknown): SessionTodoNormalizeResult {
  if (!Array.isArray(input)) return invalid('Todo items must be an array');
  if (input.length > SESSION_TODO_MAX_ITEMS) {
    return invalid(`Todo list may contain at most ${SESSION_TODO_MAX_ITEMS} items`);
  }

  const items: SessionTodoItem[] = [];
  for (const [index, raw] of input.entries()) {
    if (!isPlainRecord(raw)) {
      return invalid(`Todo item ${index + 1} must be an object`);
    }
    const item = raw;
    if (!hasExactKeys(item, ['content', 'status'])) {
      return invalid(`Todo item ${index + 1} must contain only content and status`);
    }
    if (typeof item.content !== 'string') {
      return invalid(`Todo item ${index + 1} content must be a string`);
    }
    const content = item.content.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (content.length === 0) return invalid(`Todo item ${index + 1} content cannot be empty`);
    if ([...content].length > SESSION_TODO_CONTENT_MAX_CHARS) {
      return invalid(
        `Todo item ${index + 1} content must be ${SESSION_TODO_CONTENT_MAX_CHARS} characters or fewer`,
      );
    }
    if (!isSessionTodoStatus(item.status)) {
      return invalid(
        `Todo item ${index + 1} status must be one of ${SESSION_TODO_STATUSES.join(', ')}`,
      );
    }
    items.push({ content, status: item.status });
  }

  const value = { items };
  if (
    serializedByteLength(value, SESSION_TODO_DOCUMENT_MAX_BYTES) > SESSION_TODO_DOCUMENT_MAX_BYTES
  ) {
    return invalid(`Todo document exceeds ${SESSION_TODO_DOCUMENT_MAX_BYTES} encoded bytes`);
  }
  return { ok: true, value };
}

export function isSessionTodoStatus(value: unknown): value is SessionTodoStatus {
  return typeof value === 'string' && (SESSION_TODO_STATUSES as readonly string[]).includes(value);
}

function invalid(message: string): SessionTodoNormalizeResult {
  return { ok: false, message };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
