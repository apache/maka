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

use super::{ContextEvent, invalid, selection::Selection};
use crate::{StoreError, sequence_number};
use maka_agent_facts::event::StoredEvent;
use sqlx::{Row, SqliteConnection};

pub(super) async fn read(
    connection: &mut SqliteConnection,
    selection: &Selection,
    after: u64,
    through: u64,
    before: u64,
    max_events: usize,
    max_bytes: usize,
) -> Result<Vec<ContextEvent>, StoreError> {
    let session = selection
        .session
        .as_deref()
        .ok_or_else(|| invalid("context requires a Session"))?;
    let filter = Selection::predicate("t", "?5");
    let archive_filter = Selection::archive_predicate("t", "a", "?4", "?5");
    let items = "t.kind IN ('model_completed','model_interrupted') AND EXISTS(SELECT 1 FROM runtime_events r
        WHERE r.invocation_id=t.invocation_id AND r.operation_id=t.operation_id AND r.kind='model_requested'
        AND json_extract(r.event_header,'$.fact.item_acceptance')=1)";
    macro_rules! selected { ($prefix:literal, $suffix:literal) => { concat!($prefix,
        " FROM session_history_events t LEFT JOIN runtime_events a ON a.kind='tool_result_archived'
           AND CAST(json_extract(a.event_header,'$.fact.placeholder.identity.runtime_event_id') AS TEXT)=t.event_id AND {archive_filter}
         {material_join}
         WHERE t.sequence > ?1 AND t.sequence <= ?2 AND t.owner_session_id=?3
           AND {filter} AND t.kind NOT IN ('model_observed','context_checkpoint_recorded','tool_result_archived')
           AND NOT EXISTS(SELECT 1 FROM runtime_events o WHERE o.invocation_id=t.invocation_id
             AND o.kind='invocation_opened' AND json_extract(o.event_header,'$.fact.input.kind')='context_compact')
           AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=t.invocation_id
             AND r.kind='model_requested' AND r.operation_id=t.operation_id AND json_extract(r.event_header,'$.fact.purpose')='summary')",
        $suffix) }; }
    let (count, bytes): (i64,i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(selected!(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN a.sequence IS NULL AND NOT ({items}) THEN t.canonical_bytes ELSE 0 END),0)", ""
    ), filter=filter, archive_filter=archive_filter, items=items, material_join=""))).bind(after as i64).bind(through as i64).bind(session).bind(before as i64).bind(&selection.lineage).fetch_one(&mut *connection).await?;
    if sequence_number(count)? > max_events as u64 || sequence_number(bytes)? > max_bytes as u64 {
        return Err(StoreError::PrefixTooLarge);
    }
    // Archived base bodies are NULL here, never retained with the returned tail.
    let material_join = format!(
        "LEFT JOIN event_log e ON e.sequence=t.sequence AND a.sequence IS NULL AND NOT ({items}) {}",
        crate::canonical::JOINS
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(selected!(
        "SELECT t.sequence,t.event_id,json_extract(a.event_header,'$.invocation.session_id') AS archive_writer,
         a.sequence + 1 AS archives_before,
         e.event_header,{columns},
         CASE WHEN {items} THEN t.operation_id END AS model_step,
         CASE WHEN {items} THEN json_extract(t.event_header,'$.invocation') END AS model_invocation", " ORDER BY t.sequence"
    ), filter=filter, archive_filter=archive_filter, items=items, columns=crate::canonical::COLUMNS,
        material_join=material_join))).bind(after as i64).bind(through as i64).bind(session).bind(before as i64).bind(&selection.lineage).fetch_all(&mut *connection).await?;
    let mut used = bytes as usize;
    let mut result = Vec::with_capacity(count as usize);
    for row in rows {
        if let Some(step) = row.try_get::<Option<String>, _>("model_step")? {
            let projected = crate::model_items::project(
                connection,
                serde_json::from_str(row.try_get("model_invocation")?)?,
                step,
                sequence_number(row.try_get("sequence")?)?,
                row.try_get("event_id")?,
                max_bytes,
            )
            .await?;
            used = used
                .checked_add(serde_json::to_vec(&projected)?.len())
                .ok_or(StoreError::PrefixTooLarge)?;
            if used > max_bytes {
                return Err(StoreError::PrefixTooLarge);
            }
            result.push(ContextEvent::ModelItems(Box::new(projected)));
        } else if row.try_get::<Option<&str>, _>("event_header")?.is_some() {
            let event = serde_json::from_str(&crate::canonical::json(&row)?)?;
            result.push(ContextEvent::Canonical(Box::new(StoredEvent {
                sequence: sequence_number(row.try_get("sequence")?)?,
                event,
            })));
        } else {
            let archived = crate::archive::archived(
                connection,
                row.try_get("archive_writer")?,
                row.try_get("event_id")?,
                sequence_number(row.try_get("archives_before")?)?,
            )
            .await?
            .ok_or_else(|| invalid("missing accepted archive replacement"))?;
            let bytes = serde_json::to_vec(&(
                &archived.event_id,
                &archived.invocation,
                &archived.operation_id,
                &archived.replacement,
                archived.is_error,
            ))?
            .len();
            used = used.checked_add(bytes).ok_or(StoreError::PrefixTooLarge)?;
            if used > max_bytes {
                return Err(StoreError::PrefixTooLarge);
            }
            result.push(ContextEvent::Archived(Box::new(archived)));
        }
    }
    Ok(result)
}
