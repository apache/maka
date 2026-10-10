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

import type { SessionListFilter } from '@maka/core/runtime-inputs';
import { sqliteOrdinarySessionRolePredicate } from './sqlite-session-role-scope.js';

export interface SqliteSessionCatalogCursor {
  readonly activityAt: number;
  readonly sessionId: string;
}

export interface SqliteSessionCatalogPageQuery {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

export interface SqliteSessionPredicate {
  readonly sql: string;
  readonly parameters: readonly string[];
}

/**
 * A Session row the catalog lists: ordinary, not a copy still being prepared,
 * and not a transcript-less shell. `alias` names the `session_metadata` row;
 * the caller joins `session_catalog_projection` for it.
 */
export function sqliteCatalogVisibleSessionPredicate(alias = 'metadata'): SqliteSessionPredicate {
  const role = sqliteOrdinarySessionRolePredicate(alias);
  return {
    sql: `(
      COALESCE(json_extract(${alias}.payload_json, '$.conversationCopy.state'), '') <> 'preparing'
      AND ${role.sql}
      AND COALESCE(json_extract(${alias}.payload_json, '$.transcriptLedgerVersion'), 1) <> 0
    )`,
    parameters: [...role.parameters],
  };
}

/**
 * A row of Settings › Archived tasks, as the rail derives it from the catalog:
 * an archived catalog-visible Session that is not a linked subtask of another
 * catalog-visible Session. A subtask whose parent is gone is a row of its own.
 * Revision families still collapse to one row; callers group by family.
 * Requires `metadata` joined with its `session_catalog_projection`.
 */
export function sqliteArchivedTaskRowPredicate(): SqliteSessionPredicate {
  const row = sqliteCatalogVisibleSessionPredicate('metadata');
  const parent = sqliteCatalogVisibleSessionPredicate('parent');
  return {
    sql: `(
      metadata.is_archived = 1
      AND ${row.sql}
      AND (
        metadata.subagent_parent_session_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM session_metadata parent
          JOIN session_catalog_projection parent_projection
            ON parent_projection.session_id = parent.session_id
          WHERE parent.session_id = metadata.subagent_parent_session_id
            AND ${parent.sql}
        )
      )
    )`,
    parameters: [...row.parameters, ...parent.parameters],
  };
}

export function buildSqliteSessionCatalogPageQuery(
  filter: SessionListFilter,
  cursor: SqliteSessionCatalogCursor | undefined,
): SqliteSessionCatalogPageQuery {
  const where: string[] = [];
  const parameters: Array<string | number> = [];
  const visible = sqliteCatalogVisibleSessionPredicate();
  where.push(visible.sql);
  parameters.push(...visible.parameters);
  if (filter.subagentParentSessionId !== undefined) {
    where.push('projection.subagent_parent_session_id = ?');
    parameters.push(filter.subagentParentSessionId);
  }
  if (cursor) {
    where.push('projection.activity_at <= ?');
    where.push(`
      (
        projection.activity_at < ?
        OR (
          projection.activity_at = ?
          AND projection.session_id > ?
        )
      )
    `);
    parameters.push(cursor.activityAt, cursor.activityAt, cursor.activityAt, cursor.sessionId);
  }
  return {
    sql: `
      SELECT
        metadata.session_id,
        metadata.payload_json,
        metadata.metadata_version,
        metadata.committed_at,
        metadata.archived_at,
        projection.activity_at,
        projection.last_message_preview
      FROM session_catalog_projection projection
      JOIN session_metadata metadata
        ON metadata.session_id = projection.session_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY projection.activity_at DESC, projection.session_id ASC
      LIMIT ?
    `,
    parameters,
  };
}
