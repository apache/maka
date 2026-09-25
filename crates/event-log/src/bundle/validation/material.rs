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

use super::invalid;
use crate::{
    StoreError,
    bundle::{
        format::{Blob, Record},
        stage::payload,
    },
};
use maka_runtime::{
    composition::RequestComposition,
    event::{Fact, RuntimeEvent, ToolOutcome},
    tool_output::decode_raw_tool_result,
};
use sqlx::SqliteConnection;

pub(super) async fn tool(
    staged: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<Option<Vec<u8>>, StoreError> {
    let Some((number, descriptor)) = descriptor(staged, &event.id, "tool_result").await? else {
        return Ok(None);
    };
    let Fact::ToolSettled {
        outcome: ToolOutcome::Succeeded { raw, .. },
        ..
    } = &event.fact
    else {
        return Err(invalid("tool blob belongs to a non-success event"));
    };
    if raw.bytes != descriptor.bytes() || raw.digest != descriptor.digest() {
        return Err(invalid("tool blob differs from its original event"));
    }
    let payload = payload(staged, number, &descriptor).await?;
    decode_raw_tool_result(&payload, raw).map_err(invalid)?;
    Ok(Some(payload))
}

pub(super) async fn composition(
    staged: &mut SqliteConnection,
    db: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let material = descriptor(staged, &event.id, "composition").await?;
    crate::composition::validate_retry(
        db,
        event,
        material.as_ref().map(|(_, descriptor)| descriptor.digest()),
    )
    .await?;
    let Some((number, descriptor)) = material else {
        return Ok(());
    };
    if !matches!(event.fact, Fact::ModelRequested { .. }) {
        return Err(invalid("composition belongs to a non-request event"));
    }
    let bytes = payload(staged, number, &descriptor).await?;
    let surface: RequestComposition = serde_json::from_slice(&bytes)?;
    if surface.freeze().map_err(invalid)?.digest() != descriptor.digest() {
        return Err(invalid("composition is not the frozen request surface"));
    }
    sqlx::query("INSERT INTO request_compositions(digest,surface) VALUES(?,?) ON CONFLICT(digest) DO NOTHING")
        .bind(descriptor.digest()).bind(bytes).execute(&mut *db).await?;
    sqlx::query("INSERT INTO model_request_compositions(event_id,digest) VALUES(?,?)")
        .bind(&event.id)
        .bind(descriptor.digest())
        .execute(db)
        .await?;
    Ok(())
}

async fn descriptor(
    staged: &mut SqliteConnection,
    event: &str,
    resource: &str,
) -> Result<Option<(i64, Blob)>, StoreError> {
    let row: Option<(i64,String)> = sqlx::query_as(
        "SELECT number,record_json FROM frames WHERE kind='blob' AND json_extract(record_json,'$.resource')=?
         AND json_extract(record_json,'$.event_id')=?"
    ).bind(resource).bind(event).fetch_optional(staged).await?;
    row.map(|(number, json)| {
        let Record::Blob(blob) = serde_json::from_str(&json)? else {
            unreachable!()
        };
        Ok((number, blob))
    })
    .transpose()
}

pub(super) async fn check_bindings(
    staged: &mut SqliteConnection,
    db: &mut SqliteConnection,
) -> Result<(), StoreError> {
    let expected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM frames WHERE kind='blob' AND json_extract(record_json,'$.resource') IN ('tool_result','composition')"
    ).fetch_one(&mut *staged).await?;
    let installed: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM tool_result_payloads)+(SELECT COUNT(*) FROM model_request_compositions)"
    ).fetch_one(&mut *db).await?;
    if expected != installed {
        return Err(invalid("bundle contains unbound event payloads"));
    }
    let expected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM frames WHERE kind IN ('member','revision_source')",
    )
    .fetch_one(staged)
    .await?;
    let installed: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM session_history_members)+(SELECT COUNT(*) FROM session_revision_sources)"
    ).fetch_one(&mut *db).await?;
    if expected != installed {
        return Err(invalid("bundle contains history without its copy"));
    }
    let invalid_pin: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_history_members h JOIN runtime_events t ON t.sequence=h.sequence
         LEFT JOIN runtime_events a ON a.sequence=h.archive_sequence
         WHERE t.event_session=h.session_id OR (h.archive_sequence IS NOT NULL AND
           (a.kind IS NOT 'tool_result_archived' OR a.sequence<=t.sequence OR
            json_extract(a.event_json,'$.fact.placeholder.identity.runtime_event_id') IS NOT t.event_id)))"
    ).fetch_one(&mut *db).await?;
    if invalid_pin {
        return Err(invalid("copy has a self member or mismatched archive pin"));
    }
    let changed_projection: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_history_members h
         JOIN session_history_copies c ON c.session_id=h.session_id
         JOIN runtime_events target ON target.sequence=h.sequence
         LEFT JOIN session_history_members parent ON parent.session_id=c.source_session_id AND parent.sequence=h.sequence
         WHERE h.archive_sequence IS NOT COALESCE(
            (SELECT a.sequence FROM runtime_events a WHERE a.kind='tool_result_archived'
             AND a.event_session=c.source_session_id AND a.sequence<=c.observed_through
             AND json_extract(a.event_json,'$.fact.placeholder.identity.runtime_event_id')=target.event_id),
            parent.archive_sequence))"
    ).fetch_one(&mut *db).await?;
    if changed_projection {
        return Err(invalid(
            "copy archive pin differs from its source projection",
        ));
    }
    let premature: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_history_copies c JOIN runtime_events e ON e.event_session=c.session_id
         WHERE e.sequence<=c.observed_through OR c.state!='committed')"
    ).fetch_one(db).await?;
    if premature {
        return Err(invalid("copy has work before its creation or retention"));
    }
    Ok(())
}
