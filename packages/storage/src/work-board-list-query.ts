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
  isSafeWorkBoardId,
  type WorkBoardItem,
  type WorkBoardListQuery,
  type WorkBoardScope,
} from '@maka/core/work-board';
import { WorkBoardStoreError } from './work-board-store-error.js';

export interface WorkBoardListStatement {
  sql: string;
  params: Array<string | number>;
}

/**
 * Builds the exact list SQL executed by WorkBoardStore.list(). Internal module
 * used by the store and by the query-plan regression test so the test cannot
 * drift from the production statement.
 */
export function buildWorkBoardListStatement(
  value: WorkBoardListQuery,
  limit: number,
): WorkBoardListStatement {
  const params: Array<string | number> = [];
  let sql = `
    SELECT item_id, revision, created_at, updated_at, scope_kind, project_id, archived, record_json
    FROM workflow_work_board_items
    WHERE 1 = 1
  `;
  if (!value.includeArchived) {
    sql += ' AND archived = 0';
  }
  if (value.scope) {
    sql = appendScopePredicate(sql, params, value.scope);
  }
  if (value.cursor) {
    const cursor = decodeWorkBoardCursor(value.cursor);
    if (!cursor || cursor.filterFingerprint !== workBoardFilterFingerprint(value)) {
      throw new WorkBoardStoreError('invalid_input', 'cursor does not match the list filters');
    }
    sql += ' AND (updated_at < ? OR (updated_at = ? AND item_id < ?))';
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.itemId);
  }
  sql += ' ORDER BY updated_at DESC, item_id DESC LIMIT ?';
  params.push(limit + 1);
  return { sql, params };
}

export function workBoardFilterFingerprint(value: WorkBoardListQuery): string {
  const scope =
    value.scope === undefined
      ? 'any'
      : value.scope.kind === 'project'
        ? `project:${value.scope.projectId}`
        : 'inbox';
  return `${value.includeArchived ? 'archived-included' : 'active-only'}:${scope}`;
}

export function encodeWorkBoardCursor(item: WorkBoardItem, filterFingerprint: string): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: item.updatedAt, itemId: item.id, filterFingerprint }),
    'utf8',
  ).toString('base64url');
}

function decodeWorkBoardCursor(
  cursor: string,
): { updatedAt: number; itemId: string; filterFingerprint: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const { updatedAt, itemId, filterFingerprint } = record;
    if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      return null;
    }
    if (!isSafeWorkBoardId(itemId)) return null;
    if (
      typeof filterFingerprint !== 'string' ||
      filterFingerprint.length === 0 ||
      filterFingerprint.length > 512
    ) {
      return null;
    }
    return { updatedAt, itemId, filterFingerprint };
  } catch {
    return null;
  }
}

function appendScopePredicate(
  sql: string,
  params: Array<string | number>,
  scope: WorkBoardScope,
): string {
  if (scope.kind === 'inbox') {
    sql += ' AND scope_kind = ? AND project_id IS NULL';
    params.push('inbox');
    return sql;
  }
  sql += ' AND scope_kind = ? AND project_id = ?';
  params.push('project', scope.projectId);
  return sql;
}
