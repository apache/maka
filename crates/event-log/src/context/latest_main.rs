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

use super::{AcceptedMainContext, LatestMainContext, selection::Selection};
use crate::{EventLog, StoreError, sequence_number};
use futures_util::TryStreamExt;
use maka_runtime::{
    context::{ModelPurpose, ModelRequestContext},
    event::Invocation,
    model::ModelUsage,
};
use sqlx::{Connection, Row, SqliteConnection};
use std::time::SystemTime;

impl EventLog {
    pub async fn latest_main_context(
        &self,
        session: &str,
    ) -> Result<LatestMainContext, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let selected = read(&mut tx, &session).await?;
                    tx.commit().await?;
                    Ok(selected)
                })
            })
            .await
    }
}

pub(super) async fn read(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<LatestMainContext, StoreError> {
    read_through(connection, session, i64::MAX as u64).await
}

pub(super) async fn read_through(
    connection: &mut SqliteConnection,
    session: &str,
    through: u64,
) -> Result<LatestMainContext, StoreError> {
    read_selected(connection, &Selection::session(session), through).await
}

pub(super) async fn read_selected(
    connection: &mut SqliteConnection,
    selection: &Selection,
    through: u64,
) -> Result<LatestMainContext, StoreError> {
    read_selected_at(connection, selection, through, through.saturating_add(1)).await
}

pub(super) async fn read_selected_at(
    connection: &mut SqliteConnection,
    selection: &Selection,
    through: u64,
    archives_before: u64,
) -> Result<LatestMainContext, StoreError> {
    let session = selection
        .session
        .as_deref()
        .ok_or_else(|| super::invalid("context requires a Session"))?;
    let filter = Selection::predicate("e", "?3");
    let archive_filter = Selection::predicate("a", "?3");
    // LEFT JOIN deliberately retains a damaged newest completion. Only a proven
    // summary can be skipped; missing trace must not reveal an older main.
    let mut rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "WITH runtime_events AS NOT MATERIALIZED (SELECT e.* FROM main.runtime_events e WHERE e.sequence <= ?2 AND {filter})
         SELECT c.sequence, json_extract(c.event_json, '$.invocation') AS ci,
         json_extract(r.event_json, '$.invocation') AS ri, json_extract(o.event_json, '$.invocation') AS oi,
         json_extract(o.event_json, '$.fact.input.kind') AS opening_kind,
         json_extract(r.event_json, '$.fact.purpose') AS purpose,
         json_extract(c.event_json, '$.recorded_at') AS recorded_at,
         json_extract(c.event_json, '$.fact.output.usage') AS usage,
         json_extract(r.event_json, '$.fact.model_id') AS model_id,
         json_extract(r.event_json, '$.fact.route_identity') AS route_identity,
         json_extract(r.event_json, '$.fact.context') AS context,
         json_extract(r.event_json, '$.fact.checkpoint_event_id') AS checkpoint_id,
         json_extract(o.event_json, '$.fact.configuration.model.connection_id') AS connection_id,
         json_extract(c.event_json, '$.fact.step_id') AS cs,
         json_extract(r.event_json, '$.fact.step_id') AS rs,
         c.operation_id AS operation_id, r.sequence AS requested, o.sequence AS opened
         , NOT EXISTS(SELECT 1 FROM main.runtime_events a LEFT JOIN main.runtime_events target
             ON target.event_id=json_extract(a.event_json,'$.fact.placeholder.identity.runtime_event_id')
           WHERE a.kind='tool_result_archived' AND a.sequence < ?4 AND {archive_filter}
             AND json_extract(a.event_json,'$.invocation.session_id')=json_extract(c.event_json,'$.invocation.session_id')
             AND a.sequence > r.sequence AND (target.sequence IS NULL OR target.sequence <= json_extract(r.event_json,'$.fact.source_high_water'))) AS projection_current
         FROM runtime_events c LEFT JOIN runtime_events r ON r.invocation_id = c.invocation_id
           AND r.operation_id = c.operation_id AND r.kind = 'model_requested'
         LEFT JOIN runtime_events o ON o.invocation_id = c.invocation_id AND o.kind = 'invocation_opened'
         WHERE c.kind = 'model_completed' AND json_extract(c.event_json, '$.invocation.session_id') = ?1
         ORDER BY c.sequence DESC"
    ))).bind(session).bind(through as i64).bind(&selection.lineage)
        .bind(archives_before.min(i64::MAX as u64) as i64).fetch(connection);
    while let Some(row) = rows.try_next().await? {
        let selected = (|| -> Option<(ModelPurpose, Option<AcceptedMainContext>)> {
            let completion: Invocation =
                serde_json::from_str(row.try_get::<&str, _>("ci").ok()?).ok()?;
            let request: Invocation =
                serde_json::from_str(row.try_get::<&str, _>("ri").ok()?).ok()?;
            let opening: Invocation =
                serde_json::from_str(row.try_get::<&str, _>("oi").ok()?).ok()?;
            let sequence: i64 = row.try_get("sequence").ok()?;
            let requested: i64 = row.try_get("requested").ok()?;
            let opened: i64 = row.try_get("opened").ok()?;
            if completion != request
                || completion != opening
                || completion.session_id != session
                || !(opened < requested && requested < sequence)
            {
                return None;
            }
            let step: &str = row.try_get("cs").ok()?;
            if step != row.try_get::<&str, _>("rs").ok()?
                || step != row.try_get::<&str, _>("operation_id").ok()?
            {
                return None;
            }
            let kind: &str = row.try_get("opening_kind").ok()?;
            let purpose: &str = row.try_get("purpose").ok()?;
            let purpose = match (kind, purpose) {
                ("message" | "continuation" | "handoff", "main") => ModelPurpose::Main,
                ("message" | "continuation" | "handoff" | "context_compact", "summary") => {
                    ModelPurpose::Summary
                }
                _ => return None,
            };
            if purpose == ModelPurpose::Summary {
                return Some((purpose, None));
            }
            let model_id: String = row.try_get("model_id").ok()?;
            if model_id.is_empty() || model_id.encode_utf16().count() > 512 {
                return None;
            }
            let context: Option<String> = row.try_get("context").ok()?;
            let context: Option<ModelRequestContext> =
                context.map(|s| serde_json::from_str(&s)).transpose().ok()?;
            if context.as_ref().is_some_and(|c| c.validate().is_err()) {
                return None;
            }
            let usage: ModelUsage =
                serde_json::from_str(row.try_get::<&str, _>("usage").ok()?).ok()?;
            let recorded_at: SystemTime =
                serde_json::from_str(row.try_get::<&str, _>("recorded_at").ok()?).ok()?;
            Some((
                purpose,
                Some(AcceptedMainContext {
                    projection_current: row.try_get("projection_current").ok()?,
                    sequence: sequence_number(sequence).ok()?,
                    recorded_at,
                    model_id,
                    route_identity: row.try_get("route_identity").ok()?,
                    connection_id: row.try_get("connection_id").ok()?,
                    checkpoint_event_id: row.try_get("checkpoint_id").ok()?,
                    context,
                    usage,
                }),
            ))
        })();
        match selected {
            Some((ModelPurpose::Summary, _)) => continue,
            Some((ModelPurpose::Main, Some(value))) => {
                return Ok(LatestMainContext::Selected(Box::new(value)));
            }
            _ => return Ok(LatestMainContext::TraceUnavailable),
        }
    }
    Ok(LatestMainContext::NoCompletedRequest)
}
