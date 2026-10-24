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

use super::{
    MAX_SAFE_INTEGER, SessionRecord, advance_catalog, invalid, read, validate_id, validate_time,
};
use crate::{EventLog, StoreError};
use serde::{Serialize, de::DeserializeOwned};
use sqlx::Connection;

/// A metadata CAS is distinct from event-log append and delivery revisions.
pub enum SessionMutation<T> {
    Committed(SessionRecord<T>),
    RevisionConflict { expected: u64, actual: u64 },
}

impl EventLog {
    pub async fn set_session_archived<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        archived: bool,
        now: u64,
    ) -> Result<SessionRecord<T>, StoreError> {
        match self
            .change_session_archived(id, None, archived, now)
            .await?
        {
            SessionMutation::Committed(record) => Ok(record),
            SessionMutation::RevisionConflict { .. } => unreachable!("no revision precondition"),
        }
    }

    pub async fn change_session_archived<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        expected: Option<u64>,
        archived: bool,
        now: u64,
    ) -> Result<SessionMutation<T>, StoreError> {
        self.validate_root()?;
        validate_id(id)?;
        validate_time(now)?;
        let id = id.to_owned();
        let commits = self.commits.session(&id);
        self.connection.run(move |connection| Box::pin(async move {
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        super::removal::require_mutable(&mut tx, &id).await?;
        let record: SessionRecord<T> = read(&mut tx, &id).await?.ok_or(StoreError::SessionNotFound)?;
        if let Some(expected) = expected && expected != record.revision {
            return Ok(SessionMutation::RevisionConflict { expected, actual: record.revision });
        }
        if super::has_active_invocation(&mut tx, &id).await? {
            return Err(StoreError::SessionBusy);
        }
        if record.archived == archived {
            return Ok(SessionMutation::Committed(record));
        }
        if record.revision >= MAX_SAFE_INTEGER {
            return Err(invalid("session revision exhausted"));
        }
        if !archived {
            sqlx::query("DELETE FROM session_retirements WHERE session_id=? AND remove_session=0 AND completed=1")
                .bind(&id).execute(&mut *tx).await?;
        }
        let changed = sqlx::query(
            "UPDATE session_control SET archived = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision < ?",
        ).bind(archived).bind(now.max(record.updated_at) as i64).bind(&id)
            .bind(MAX_SAFE_INTEGER as i64).execute(&mut *tx).await?.rows_affected();
        if changed != 1 { return Err(invalid("session revision exhausted")); }
        advance_catalog(&mut tx).await?;
        let record = read(&mut tx, &id).await?.ok_or(StoreError::SessionNotFound)?;
        tx.commit().await.map_err(StoreError::CommitUnknown)?;
        commits.metadata();
        Ok(SessionMutation::Committed(record))
        })).await
    }

    /// Mutates validated control metadata, including while execution is active.
    /// The creation fingerprint and all event facts remain unchanged. Compare
    /// revision before invoking the policy closure, even for a semantic no-op.
    pub async fn update_session_metadata<T, F>(
        &self,
        id: &str,
        expected: u64,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        self.mutate_session_metadata(id, expected, false, None, update)
            .await
    }

    /// Permission changes atomically retire pending requests from the old boundary.
    /// The domain closure owns the configuration and its boundary revision.
    pub async fn update_session_permissions<T, F>(
        &self,
        id: &str,
        expected: u64,
        now: u64,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        validate_time(now)?;
        self.mutate_session_metadata(id, expected, false, Some(now), update)
            .await
    }

    /// A successful replacement always advances the revision, even for identical
    /// content. Callers can use the committed choice to fence older configuration CASes.
    pub async fn replace_session_metadata<T>(
        &self,
        id: &str,
        expected: u64,
        configuration: T,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
    {
        self.mutate_session_metadata(id, expected, true, None, move |current| {
            *current = configuration;
            Ok(())
        })
        .await
    }

    pub(crate) async fn mutate_session_metadata<T, F>(
        &self,
        id: &str,
        expected: u64,
        always_advance: bool,
        permission_time: Option<u64>,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        self.validate_root()?;
        validate_id(id)?;
        if expected == 0 || expected > MAX_SAFE_INTEGER {
            return Err(invalid("invalid expected Session revision"));
        }
        let id = id.to_owned();
        let commits = self.commits.session(&id);
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    super::removal::require_mutable(&mut tx, &id).await?;
                    let record: SessionRecord<T> = read(&mut tx, &id)
                        .await?
                        .ok_or(StoreError::SessionNotFound)?;
                    if record.revision != expected {
                        return Ok(SessionMutation::RevisionConflict {
                            expected,
                            actual: record.revision,
                        });
                    }
                    let boundary = if permission_time.is_some() {
                        Some(
                            crate::workspace_bindings::permission_basis(&mut tx, &id)
                                .await?
                                .ok_or_else(|| invalid("session permission boundary is missing"))?,
                        )
                    } else {
                        None
                    };
                    let mut normalized = serde_json::to_value(&record.configuration)?;
                    crate::workspace_bindings::normalize(
                        &mut normalized,
                        record.workspace_binding.as_ref(),
                    )?;
                    let mut configuration: T = serde_json::from_value(normalized)?;
                    let previous = configuration.clone();
                    update(&mut configuration)?;
                    if !always_advance && configuration == previous {
                        return Ok(SessionMutation::Committed(record));
                    }
                    let configuration = serde_json::to_value(configuration)?;
                    crate::workspace_bindings::require_current_reference(&mut tx, &configuration)
                        .await?;
                    let configuration = serde_json::to_string(&configuration)?;
                    let next_revision = expected
                        .checked_add(1)
                        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
                        .ok_or_else(|| invalid("session metadata revision exhausted"))?;
                    // Metadata is not activity: neither timestamps nor runtime_events move.
                    if sqlx::query(
                        "UPDATE session_control SET configuration = ?, revision = ? WHERE id = ?",
                    )
                    .bind(configuration)
                    .bind(next_revision as i64)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
                        != 1
                    {
                        return Err(invalid("session metadata revision exhausted"));
                    }
                    if let (Some(old), Some(now)) = (boundary, permission_time) {
                        crate::interactions::permissions::close_previous_basis(
                            &mut tx, &id, old, now,
                        )
                        .await?;
                    }
                    advance_catalog(&mut tx).await?;
                    let record = read(&mut tx, &id)
                        .await?
                        .ok_or(StoreError::SessionNotFound)?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                    Ok(SessionMutation::Committed(record))
                })
            })
            .await
    }
}
