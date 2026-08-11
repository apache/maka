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
  const usesLabel = filter.labelSlug !== undefined;
  const orderBy = usesLabel ? 'selected_label' : 'projection';
  const where: string[] = [];
  const parameters: Array<string | number> = [];
  where.push(
    "COALESCE(json_extract(metadata.payload_json, '$.conversationCopy.state'), '') <> 'preparing'",
  );
  where.push("COALESCE(json_extract(metadata.payload_json, '$.transcriptLedgerVersion'), 1) <> 0");
  if (filter.labelSlug !== undefined) {
    where.push('selected_label.label = ?');
    parameters.push(filter.labelSlug);
  }
  if (filter.isArchived !== undefined) {
    where.push('projection.is_archived = ?');
    parameters.push(filter.isArchived ? 1 : 0);
  }
  if (filter.isFlagged !== undefined) {
    where.push('projection.is_flagged = ?');
    parameters.push(filter.isFlagged ? 1 : 0);
  }
  if (filter.subagentParentSessionId !== undefined) {
    where.push('projection.subagent_parent_session_id = ?');
    parameters.push(filter.subagentParentSessionId);
  }
  if (cursor) {
    where.push(`${orderBy}.activity_at <= ?`);
    where.push(`
      (
        ${orderBy}.activity_at < ?
        OR (
          ${orderBy}.activity_at = ?
          AND ${orderBy}.session_id > ?
        )
      )
    `);
    parameters.push(cursor.activityAt, cursor.activityAt, cursor.activityAt, cursor.sessionId);
  }
  const from = usesLabel
    ? `
      FROM session_catalog_label_projection selected_label
      JOIN session_catalog_projection projection
        ON projection.session_id = selected_label.session_id
      JOIN session_metadata metadata
        ON metadata.session_id = projection.session_id
    `
    : `
      FROM session_catalog_projection projection
      JOIN session_metadata metadata
        ON metadata.session_id = projection.session_id
    `;
  return {
    sql: `
      SELECT
        metadata.session_id,
        metadata.payload_json,
        metadata.metadata_version,
        metadata.committed_at,
        projection.last_message_preview
      ${from}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderBy}.activity_at DESC, ${orderBy}.session_id ASC
      LIMIT ?
    `,
    parameters,
  };
}
