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

use crate::StoreError;
use rusqlite::{Connection, functions::FunctionFlags};
use sqlx::SqliteConnection;

/// Incremental normalization preserves whitespace across delta boundaries while
/// retaining at most 96 Unicode characters, including a truncation ellipsis.
#[derive(Default)]
struct Preview {
    text: String,
    count: usize,
    space: bool,
    full: bool,
}
impl Preview {
    fn push(&mut self, text: &str) {
        if self.full {
            return;
        }
        for ch in text.chars() {
            if matches!(ch, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
            {
                self.space = !self.text.is_empty();
                continue;
            }
            for next in self
                .space
                .then_some(' ')
                .into_iter()
                .chain(std::iter::once(ch))
            {
                if self.count == 96 {
                    self.text.pop();
                    self.text.push('…');
                    self.full = true;
                    return;
                }
                self.text.push(next);
                self.count += 1;
            }
            self.space = false;
        }
    }
    fn finish(self) -> Option<String> {
        (!self.text.is_empty()).then_some(self.text)
    }
}
pub(super) fn register_function(connection: &Connection) -> Result<(), StoreError> {
    connection.create_scalar_function(
        "catalog_preview",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let mut preview = Preview::default();
            if let Some(text) = ctx.get_raw(0).as_str_or_null()? {
                preview.push(text);
            }
            Ok(preview.finish())
        },
    )?;
    Ok(())
}

/// Only the sealed current step contributes partial messages. Nothing is added
/// to model_completed, so accepted model history retains its existing authority.
pub(super) async fn project(
    connection: &mut SqliteConnection,
    boundary: i64,
    session: &str,
    invocation: &str,
    interrupted_step: Option<&str>,
) -> Result<(), StoreError> {
    let step = if let Some(step) = interrupted_step {
        Some(step.to_owned())
    } else {
        // Failed/cancelled terminal fallback: exclude steps already sealed before
        // this boundary, including during a rebuild with later events present.
        sqlx::query_scalar::<_, String>(
            "WITH request AS (SELECT operation_id FROM event_log INDEXED BY catalog_model_boundaries
             WHERE invocation_id = ?1 AND sequence < ?2
             AND kind IN ('model_requested', 'model_completed', 'model_interrupted')
             AND kind = 'model_requested' ORDER BY sequence DESC LIMIT 1)
             SELECT operation_id FROM request WHERE NOT EXISTS (SELECT 1 FROM event_log AS result INDEXED BY operation_fact
                WHERE result.operation_id = request.operation_id
                AND result.operation_id IS NOT NULL
                AND result.invocation_id = ?1 AND result.sequence < ?2
                AND result.kind IN ('model_completed', 'model_interrupted'))
             AND EXISTS (SELECT 1 FROM runtime_events WHERE sequence = ?2
                AND json_extract(event_header, '$.fact.outcome.kind') IN ('failed', 'cancelled'))
             LIMIT 1",
        ).bind(invocation).bind(boundary).fetch_optional(&mut *connection).await?
    };
    let Some(step) = step else {
        return Ok(());
    };
    let visible: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM runtime_events request
             JOIN runtime_events opening ON opening.invocation_id = request.invocation_id
             AND opening.kind = 'invocation_opened'
             WHERE request.kind = 'model_requested' AND request.invocation_id = ?1
             AND request.operation_id = ?2
             AND json_extract(opening.event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
             AND json_extract(request.event_header, '$.fact.purpose') = 'main')",
    )
    .bind(invocation)
    .bind(&step)
    .fetch_one(&mut *connection)
    .await?;
    if !visible {
        return Ok(());
    }
    sqlx::query(
        "WITH bodies AS (
           SELECT b.ordinal,b.record,b.part,b.message_id FROM model_selected_parts s JOIN model_part_bodies b
             ON b.event_id=s.body_event_id AND b.ordinal=s.ordinal WHERE s.sequence=?1 AND s.invocation_id=?3 AND s.step_id=?4
           UNION ALL
           SELECT b.ordinal,b.record,b.part,b.message_id FROM model_part_bodies b
             WHERE b.invocation_id=?3 AND b.step_id=?4 AND b.source_kind='model_observed' AND b.source_sequence<?1
         )
         INSERT OR IGNORE INTO catalog_messages
         SELECT ?1,ordinal+1,?2,catalog_time(json_extract(record,'$.started_at')),
           CASE WHEN json_extract(part,'$.text_kind')='text' THEN catalog_preview(json_extract(part,'$.text')) END,
           message_id FROM bodies WHERE json_extract(part,'$.kind')='text' ORDER BY ordinal",
    ).bind(boundary).bind(session).bind(invocation).bind(&step).execute(connection).await?;
    Ok(())
}
