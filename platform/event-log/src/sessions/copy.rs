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

use super::SessionRecord;
use crate::{
    EventLog, StoreError,
    context::{HistoryCut, history, safety},
};
use maka_agent_facts::session::{BranchOrigin, CopyPurpose, CopyState, ForkPosition, Lineage};
use serde::{Serialize, de::DeserializeOwned};
use sqlx::Connection;

pub use maka_agent_facts::session::CopyRequest as SessionCopy;
mod lifecycle;
pub use lifecycle::AbandonRevision;
pub(crate) use lifecycle::retain;

#[derive(Debug)]
pub enum SessionCopyResult<T> {
    Committed(Box<SessionRecord<T>>),
    SourceRevisionConflict { expected: u64, actual: u64 },
}

impl EventLog {
    /// Recover the original request before re-reading a changed or deleted source.
    /// Absence is not a reservation: a concurrent copy may still commit this ID.
    pub async fn session_copy_receipt(
        &self,
        target: &str,
    ) -> Result<Option<maka_agent_facts::session::CopyReceipt>, StoreError> {
        self.validate_root()?;
        super::validate_id(target)?;
        let target = target.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let row: Option<(String, String)> = sqlx::query_as(
                        "SELECT request_json, state FROM session_history_copies WHERE session_id=? AND bundle_digest IS NULL",
                    )
                    .bind(target)
                    .fetch_optional(connection)
                    .await?;
                    row.map(|(request, state)| {
                        Ok(maka_agent_facts::session::CopyReceipt {
                            request: serde_json::from_str(&request)?,
                            state: state.parse().map_err(super::invalid)?,
                        })
                    })
                    .transpose()
                })
            })
            .await
    }

    /// Host-authorized history copy. The caller validates destination configuration
    /// against the captured source revision; no execution or workspace is cloned.
    /// Exact retries precede source CAS, including after a lost commit response.
    pub async fn copy_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        request: SessionCopy,
        configuration: &T,
        now: u64,
    ) -> Result<SessionCopyResult<T>, StoreError> {
        self.copy_session_owned(request, configuration, now, None)
            .await
    }

    /// The Host binds source access and destination creation authority separately.
    /// Ownership, the complete creation fingerprint and history commit together.
    pub async fn copy_plugin_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        request: SessionCopy,
        configuration: &T,
        now: u64,
        origin: super::PluginSession,
    ) -> Result<SessionCopyResult<T>, StoreError> {
        origin.validate()?;
        if origin.session_id != request.target_session_id {
            return Err(super::invalid(
                "copy target differs from its creation owner",
            ));
        }
        self.copy_session_owned(request, configuration, now, Some(origin))
            .await
    }

    async fn copy_session_owned<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        request: SessionCopy,
        configuration: &T,
        now: u64,
        origin: Option<super::PluginSession>,
    ) -> Result<SessionCopyResult<T>, StoreError> {
        self.validate_root()?;
        super::validate_id(&request.source_session_id)?;
        super::validate_id(&request.target_session_id)?;
        super::validate_time(now)?;
        if request.source_session_id == request.target_session_id
            || request.expected_source_revision == 0
            || request.expected_source_revision > super::MAX_SAFE_INTEGER
        {
            return Err(super::invalid("invalid Session copy identity or revision"));
        }
        let cut = match &request.purpose {
            CopyPurpose::Branch { position, .. } => match position {
                ForkPosition::Start => HistoryCut::Empty,
                ForkPosition::End => HistoryCut::End,
                ForkPosition::ThroughTurn { turn_id } => HistoryCut::ThroughTurn(turn_id.clone()),
                ForkPosition::BeforeTurn { turn_id } => HistoryCut::BeforeTurn(turn_id.clone()),
            },
            CopyPurpose::EmptySideConversation => HistoryCut::Empty,
            CopyPurpose::Revision { turn_id } => HistoryCut::BeforeTurn(turn_id.clone()),
        };
        if let HistoryCut::BeforeTurn(turn) | HistoryCut::ThroughTurn(turn) = &cut {
            super::validate_id(turn)?;
        }
        let configuration = serde_json::to_string(configuration)?;
        let encoded = serde_json::to_string(&request)?;
        let fingerprint = origin.as_ref().map_or_else(
            || maka_agent_facts::artifact::content_digest(encoded.as_bytes()),
            |origin| origin.fingerprint.clone(),
        );
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let previous: Option<(String, Option<String>)> = sqlx::query_as(
                "SELECT request_json,bundle_digest FROM session_history_copies WHERE session_id = ?",
            ).bind(&request.target_session_id).fetch_optional(&mut *tx).await?;
            if let Some((previous, bundle_digest)) = previous {
                if bundle_digest.is_some() { return Err(StoreError::SessionConflict); }
                if previous != encoded { return Err(StoreError::SessionConflict); }
                super::removal::require_mutable(&mut tx, &request.target_session_id).await?;
                super::origin::check(&mut tx, &request.target_session_id, origin.as_ref()).await?;
                let session = super::read(&mut tx, &request.target_session_id).await?
                    .ok_or(StoreError::SessionNotFound)?;
                return Ok(SessionCopyResult::Committed(Box::new(session)));
            }
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)",
            ).bind(&request.target_session_id).fetch_one(&mut *tx).await?;
            if exists { return Err(StoreError::SessionConflict); }
            let actual = crate::workspace_bindings::current_session_revision(&mut tx, &request.source_session_id)
                .await?.ok_or(StoreError::SessionNotFound)?;
            if actual != request.expected_source_revision {
                return Ok(SessionCopyResult::SourceRevisionConflict {
                    expected: request.expected_source_revision, actual,
                });
            }
            let manager: Option<(String, String)> = sqlx::query_as(
                "SELECT package_id, scope_id FROM plugin_sessions WHERE session_id = ? AND managed = 1",
            ).bind(&request.source_session_id).fetch_optional(&mut *tx).await?;
            if manager.is_some_and(|(package, scope)| origin.as_ref().is_none_or(|origin|
                origin.creator.package() != package || String::from(origin.creator.scope().clone()) != scope
            )) {
                return Err(StoreError::ManagedSession);
            }
            let observed: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM event_log")
                .fetch_one(&mut *tx).await?;
            let through = history::resolve_cut(&mut tx, &request.source_session_id, &cut, observed).await?;
            safety::require_safe_through(&mut tx, &request.source_session_id, None, through).await?;
            let lineage = lineage(&mut tx, &request).await?;
            if let Some(origin) = &origin {
                super::origin::insert(&mut tx, origin).await?;
            }
            super::insert(&mut tx, &request.target_session_id, &fingerprint, &configuration, now).await?;
            let state = match request.purpose {
                CopyPurpose::Revision { .. } => CopyState::Preparing,
                _ => CopyState::Committed,
            };
            sqlx::query("INSERT INTO session_history_copies(session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(&request.target_session_id).bind(&request.source_session_id)
                .bind(actual as i64).bind(through as i64).bind(observed).bind(encoded).bind(serde_json::to_string(&lineage)?)
                .bind(state.as_str())
                .execute(&mut *tx).await?;
            // Freeze the parent's current projection: its own archives over raw
            // history, or an already inherited pin. Later pruning cannot change it.
            let target = request.target_session_id.clone();
            let source = request.source_session_id.clone();
            crate::connection::worker_query(&mut tx, move |worker| Box::pin(async move {
                sqlx::query(
                "INSERT INTO session_history_members
                 SELECT ?1, e.sequence,
                     COALESCE((SELECT a.sequence FROM runtime_events a WHERE a.kind = 'tool_result_archived'
                      AND CAST(json_extract(a.event_json,'$.fact.placeholder.identity.runtime_event_id') AS TEXT) = e.event_id
                      AND json_extract(a.event_json,'$.invocation.session_id') = e.owner_session_id
                      AND a.sequence < ?2), e.archive_sequence)
                 FROM session_history_events e WHERE e.owner_session_id = ?3 AND e.sequence <= ?4",
            ).bind(&target).bind(observed.saturating_add(1))
                .bind(&source).bind(through as i64).execute(&mut *worker).await?;
                let mut after = 0i64;
                loop {
                    let members: Vec<(i64, Option<i64>)> = sqlx::query_as(
                        "SELECT sequence,archive_sequence FROM session_history_members
                         WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128",
                    ).bind(&target).bind(after).fetch_all(&mut *worker).await?;
                    if members.is_empty() { break; }
                    for (sequence, archive) in members {
                        crate::context::semantic::copy_member(worker, &target, sequence, archive).await?;
                        after = sequence;
                    }
                }
                Ok(())
            })).await?;
            sqlx::query("SELECT context_source_pin_copy(?)")
                .bind(&request.target_session_id).execute(&mut *tx).await?;
            crate::artifacts::history::retain(&mut tx, &request.source_session_id, &request.target_session_id, now).await?;
            crate::transcript::directory::copy(&mut tx, &request.source_session_id, &request.target_session_id, through).await?;
            if let CopyPurpose::Revision { turn_id } = &request.purpose {
                let retained = sqlx::query(
                    "INSERT INTO session_revision_sources
                     SELECT ?1, sequence FROM session_history_events
                     WHERE owner_session_id = ?2 AND sequence <= ?3
                       AND json_extract(event_json, '$.invocation.turn_id') = ?4
                       AND ((kind = 'invocation_opened'
                         AND json_extract(event_json, '$.fact.input.kind') = 'message'
                         AND json_array_length(event_json, '$.fact.input.source_messages') > 0)
                         OR kind = 'message_steered')"
                ).bind(&request.target_session_id).bind(&request.source_session_id).bind(observed)
                    .bind(turn_id).execute(&mut *tx).await?;
                if retained.rows_affected() == 0 { return Err(super::invalid("revision Turn has no editable input")); }
                crate::artifacts::history::retain_revision(&mut tx, &request.source_session_id, &request.target_session_id, now).await?;
            }
            // History ownership is not execution admission: a fully archived
            // source can seed a branch without becoming executable again.
            super::removal::require_mutable(&mut tx, &request.source_session_id).await?;
            retain(&mut tx, &request.source_session_id).await?;
            let session = super::read(&mut tx, &request.target_session_id).await?
                .ok_or(StoreError::SessionNotFound)?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            Ok(SessionCopyResult::Committed(Box::new(session)))
        })).await
    }
}

async fn lineage(
    connection: &mut sqlx::SqliteConnection,
    request: &SessionCopy,
) -> Result<Lineage, StoreError> {
    let turn_id = match &request.purpose {
        CopyPurpose::Branch { position, .. } => {
            return Ok(Lineage::Branch {
                origin: BranchOrigin {
                    parent_session_id: request.source_session_id.clone(),
                    position: position.clone(),
                },
            });
        }
        CopyPurpose::EmptySideConversation => {
            return Ok(Lineage::Branch {
                origin: BranchOrigin {
                    parent_session_id: request.source_session_id.clone(),
                    position: ForkPosition::Start,
                },
            });
        }
        CopyPurpose::Revision { turn_id } => turn_id,
    };
    let source: Option<String> =
        sqlx::query_scalar("SELECT lineage_json FROM session_history_copies WHERE session_id = ?")
            .bind(&request.source_session_id)
            .fetch_optional(&mut *connection)
            .await?;
    let source: Option<Lineage> = source.map(|json| serde_json::from_str(&json)).transpose()?;
    let root = match &source {
        Some(Lineage::Revision {
            root_session_id, ..
        }) => root_session_id.clone(),
        _ => request.source_session_id.clone(),
    };
    let index: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(CAST(json_extract(lineage_json, '$.index') AS INTEGER)), 1) + 1
         FROM session_history_copies WHERE json_extract(lineage_json, '$.kind') = 'revision'
         AND CAST(json_extract(lineage_json, '$.root_session_id') AS TEXT) = ?",
    )
    .bind(&root)
    .fetch_one(connection)
    .await?;
    if index as u64 > super::MAX_SAFE_INTEGER {
        return Err(super::invalid("revision family exhausted"));
    }
    Ok(Lineage::Revision {
        root_session_id: root,
        parent_session_id: request.source_session_id.clone(),
        turn_id: turn_id.clone(),
        index: index as u64,
        branch: source.as_ref().and_then(Lineage::branch).cloned(),
    })
}
