import type { SessionListFilter } from '@maka/core/runtime-inputs';

export interface SqliteSessionCatalogCursor {
  readonly activityAt: number;
  readonly sessionId: string;
}

export interface SqliteSessionCatalogPageQuery {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

export function buildSqliteSessionCatalogPageQuery(
  filter: SessionListFilter,
  cursor: SqliteSessionCatalogCursor | undefined,
): SqliteSessionCatalogPageQuery {
  const where: string[] = [];
  const parameters: Array<string | number> = [];
  where.push(
    "COALESCE(json_extract(metadata.payload_json, '$.conversationCopy.state'), '') <> 'preparing'",
  );
  where.push("COALESCE(json_extract(metadata.payload_json, '$.transcriptLedgerVersion'), 1) <> 0");
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
