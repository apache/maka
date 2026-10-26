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

use super::ImportReceipt;
use crate::{
    StoreError,
    bundle::{
        format::{Blob, Record},
        stage,
    },
};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use serde_json::Value;
use sqlx::SqliteConnection;
use std::collections::BTreeMap;

pub(super) async fn all(
    destination: &mut SqliteConnection,
    staged: &mut SqliteConnection,
    relocated: &mut SqliteConnection,
    receipt: &ImportReceipt,
    binding_digest: &str,
    configurations: &BTreeMap<String, Value>,
    positions: &crate::bundle::relocation::Positions,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO session_bundle_imports VALUES(?,?,?)")
        .bind(&receipt.bundle_digest)
        .bind(binding_digest)
        .bind(serde_json::to_string(receipt)?)
        .execute(&mut *destination)
        .await?;
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,record_json FROM frames WHERE kind='session' AND number>? ORDER BY number LIMIT 1",
        ).bind(after).fetch_optional(&mut *staged).await?;
        let Some((number, json)) = row else { break };
        let Record::Session {
            id,
            parent,
            created_at,
            updated_at,
            archived,
            ..
        } = serde_json::from_str(&json)?
        else {
            unreachable!()
        };
        crate::sessions::insert(
            destination,
            &id,
            &receipt.bundle_digest,
            &serde_json::to_string(&configurations[&id])?,
            created_at,
        )
        .await?;
        sqlx::query("UPDATE session_control SET updated_at=?,archived=? WHERE id=?")
            .bind(updated_at as i64)
            .bind(archived)
            .bind(&id)
            .execute(&mut *destination)
            .await?;
        sqlx::query("INSERT INTO session_bundle_members VALUES(?,?,?)")
            .bind(id)
            .bind(&receipt.bundle_digest)
            .bind(parent)
            .execute(&mut *destination)
            .await?;
        after = number;
    }
    // Message openings freeze their inherited lineage at insertion. Install
    // the already-validated copy topology first, while leaving roots unpinned
    // until all source events have reached the destination.
    source_copies(destination, relocated).await?;
    events(destination, relocated, &receipt.bundle_digest).await?;
    copies(destination, relocated, &receipt.bundle_digest).await?;
    // All copied bases are installed before pinning: bundle Session IDs do not
    // encode ancestry order.
    for session in &receipt.session_ids {
        sqlx::query("SELECT context_source_pin_copy(?)")
            .bind(session)
            .execute(&mut *destination)
            .await?;
    }
    materials(destination, staged, positions).await?;
    crate::transcript::directory::index_imported_sessions(destination, &receipt.session_ids)
        .await?;
    crate::bundle::accounting::validate(staged, destination).await
}

async fn source_copies(
    destination: &mut SqliteConnection,
    relocated: &mut SqliteConnection,
) -> Result<(), StoreError> {
    let mut after = String::new();
    loop {
        let rows:Vec<(String,String,i64)>=sqlx::query_as(
            "SELECT owner,source,through_sequence FROM context_source_copies WHERE owner>? ORDER BY owner LIMIT 128")
            .bind(&after).fetch_all(&mut *relocated).await?;
        if rows.is_empty() {
            break;
        }
        for (owner, source, through) in rows {
            sqlx::query(
                "INSERT INTO context_source_copies(owner,source,through_sequence) VALUES(?,?,?)",
            )
            .bind(&owner)
            .bind(source)
            .bind(through)
            .execute(&mut *destination)
            .await?;
            after = owner;
        }
    }
    Ok(())
}

async fn events(
    destination: &mut SqliteConnection,
    relocated: &mut SqliteConnection,
    digest: &str,
) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT sequence,event_json FROM runtime_events WHERE sequence>? ORDER BY sequence LIMIT 1",
        ).bind(after).fetch_optional(&mut *relocated).await?;
        let Some((sequence, json)) = row else { break };
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        sqlx::query("INSERT INTO imported_invocations VALUES(?,?) ON CONFLICT DO NOTHING")
            .bind(&event.invocation.invocation_id)
            .bind(digest)
            .execute(&mut *destination)
            .await?;
        crate::append::ingress::insert(
            destination,
            &event,
            json,
            crate::append::ingress::Position::Imported(Some(sequence as u64)),
        )
        .await?;
        crate::message_sources::insert(destination, &event).await?;
        crate::root_store::usage_meter::append(destination, &event).await?;
        if matches!(
            event.fact,
            Fact::MessageImported { .. }
                | Fact::InvocationOpened { .. }
                | Fact::MessageSteered { .. }
                | Fact::ModelCompleted { .. }
                | Fact::ModelInterrupted { .. }
                | Fact::InvocationEnded { .. }
        ) {
            crate::sessions::project_execution(destination, sequence as u64).await?;
        }
        after = sequence;
    }
    Ok(())
}

async fn copies(
    destination: &mut SqliteConnection,
    relocated: &mut SqliteConnection,
    digest: &str,
) -> Result<(), StoreError> {
    let mut after = String::new();
    loop {
        let row: Option<CopyRow> = sqlx::query_as(
            "SELECT session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state
             FROM session_history_copies WHERE session_id>? ORDER BY session_id LIMIT 1",
        ).bind(&after).fetch_optional(&mut *relocated).await?;
        let Some(CopyRow {
            session_id: session,
            source_session_id: source,
            source_revision: revision,
            through_sequence: through,
            observed_through: observed,
            request_json: request,
            lineage_json: lineage,
            state,
        }) = row
        else {
            break;
        };
        sqlx::query("INSERT INTO session_history_copies VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(&session)
            .bind(source)
            .bind(revision)
            .bind(through)
            .bind(observed)
            .bind(request)
            .bind(lineage)
            .bind(state)
            .bind(digest)
            .execute(&mut *destination)
            .await?;
        let mut member = 0i64;
        loop {
            let rows: Vec<(i64, Option<i64>)> = sqlx::query_as(
                "SELECT sequence,archive_sequence FROM session_history_members WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128",
            ).bind(&session).bind(member).fetch_all(&mut *relocated).await?;
            if rows.is_empty() {
                break;
            }
            for (sequence, archive) in rows {
                sqlx::query("INSERT INTO session_history_members VALUES(?,?,?)")
                    .bind(&session)
                    .bind(sequence)
                    .bind(archive)
                    .execute(&mut *destination)
                    .await?;
                member = sequence;
            }
        }
        let mut member = 0i64;
        loop {
            let rows: Vec<i64> = sqlx::query_scalar(
                "SELECT sequence FROM session_revision_sources WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128",
            ).bind(&session).bind(member).fetch_all(&mut *relocated).await?;
            if rows.is_empty() {
                break;
            }
            for sequence in rows {
                sqlx::query("INSERT INTO session_revision_sources VALUES(?,?)")
                    .bind(&session)
                    .bind(sequence)
                    .execute(&mut *destination)
                    .await?;
                member = sequence;
            }
        }
        after = session;
    }
    Ok(())
}

async fn materials(
    destination: &mut SqliteConnection,
    staged: &mut SqliteConnection,
    positions: &crate::bundle::relocation::Positions,
) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,record_json FROM frames WHERE kind='blob' AND number>? ORDER BY number LIMIT 1",
        ).bind(after).fetch_optional(&mut *staged).await?;
        let Some((number, json)) = row else { break };
        let Record::Blob(blob) = serde_json::from_str(&json)? else {
            unreachable!()
        };
        let payload = stage::payload(staged, number, &blob).await?;
        match blob {
            Blob::ToolResult { event_id, .. } => {
                sqlx::query("INSERT INTO tool_result_payloads VALUES(?,?)")
                    .bind(event_id)
                    .bind(payload)
                    .execute(&mut *destination)
                    .await?;
            }
            Blob::Composition {
                event_id, digest, ..
            } => {
                sqlx::query("INSERT INTO request_compositions VALUES(?,?) ON CONFLICT DO NOTHING")
                    .bind(&digest)
                    .bind(payload)
                    .execute(&mut *destination)
                    .await?;
                sqlx::query("INSERT INTO model_request_compositions VALUES(?,?)")
                    .bind(event_id)
                    .bind(digest)
                    .execute(&mut *destination)
                    .await?;
            }
            Blob::Artifact {
                metadata,
                frozen_at,
                ..
            } => {
                let stamp = frozen_at
                    .map(|source| positions.event(source))
                    .transpose()?;
                let (session, id) = (metadata.session_id.clone(), metadata.id.clone());
                crate::artifacts::commit_in_transaction(destination, metadata, &payload).await?;
                if let Some(stamp) = stamp {
                    sqlx::query("UPDATE artifacts SET canonical_at=? WHERE session_id=? AND id=?")
                        .bind(stamp as i64)
                        .bind(session)
                        .bind(id)
                        .execute(&mut *destination)
                        .await?;
                }
            }
        }
        after = number;
    }
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,record_json FROM frames WHERE kind='history_artifact' AND number>? ORDER BY number LIMIT 1",
        ).bind(after).fetch_optional(&mut *staged).await?;
        let Some((number, json)) = row else { break };
        let Record::HistoryArtifact {
            session,
            source_session,
            source_artifact,
            artifact,
        } = serde_json::from_str(&json)?
        else {
            unreachable!()
        };
        sqlx::query("INSERT INTO session_history_artifacts VALUES(?,?,?,?)")
            .bind(session)
            .bind(source_session)
            .bind(source_artifact)
            .bind(artifact)
            .execute(&mut *destination)
            .await?;
        after = number;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct CopyRow {
    session_id: String,
    source_session_id: String,
    source_revision: i64,
    through_sequence: i64,
    observed_through: i64,
    request_json: String,
    lineage_json: String,
    state: String,
}
