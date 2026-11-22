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
use rusqlite::params;

use crate::{EventLog, StoreError};
use serde::{Serialize, de::DeserializeOwned};

/// A metadata CAS is distinct from event-log append and delivery revisions.
pub enum SessionMutation<T> {
    Committed(Box<SessionRecord<T>>),
    RevisionConflict { expected: u64, actual: u64 },
}

pub(crate) fn preview_archived<T: DeserializeOwned>(
    connection: &rusqlite::Connection,
    id: &str,
    expected: Option<u64>,
    archived: bool,
    now: u64,
) -> Result<(SessionMutation<T>, bool), StoreError> {
    super::removal::require_mutable(connection, id)?;
    let mut record: SessionRecord<T> = read(connection, id)?.ok_or(StoreError::SessionNotFound)?;
    if let Some(expected) = expected
        && expected != record.revision
    {
        return Ok((
            SessionMutation::RevisionConflict {
                expected,
                actual: record.revision,
            },
            false,
        ));
    }
    let changed = record.archived != archived;
    if changed {
        record.revision = record
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("session revision exhausted"))?;
        record.archived = archived;
        record.updated_at = now.max(record.updated_at);
    }
    Ok((SessionMutation::Committed(Box::new(record)), changed))
}

pub(crate) fn apply_archived<T: DeserializeOwned>(
    connection: &rusqlite::Connection,
    id: &str,
    expected: Option<u64>,
    archived: bool,
    now: u64,
) -> Result<(SessionMutation<T>, bool), StoreError> {
    let (outcome, changed) = preview_archived(connection, id, expected, archived, now)?;
    if changed {
        let SessionMutation::Committed(record) = &outcome else {
            unreachable!("only a committed choice changes metadata")
        };
        if !archived {
            connection.execute("DELETE FROM session_retirements WHERE session_id=? AND remove_session=0 AND completed=1", params![id])?;
        }
        if connection.execute("UPDATE session_control SET archived=?, revision=revision+1, updated_at=? WHERE id=? AND revision<?", params![archived, record.updated_at as i64, id, MAX_SAFE_INTEGER as i64])? != 1 {
            return Err(invalid("session revision exhausted"));
        }
        advance_catalog(connection)?;
    }
    Ok((outcome, changed))
}

pub(crate) struct MetadataChange<T> {
    pub(crate) previous: SessionRecord<serde_json::Value>,
    pub(crate) record: SessionRecord<T>,
    configuration: Option<String>,
}
impl<T> MetadataChange<T> {
    pub(crate) fn requires_work_fence(&self) -> Result<bool, StoreError> {
        let next = self
            .configuration
            .as_ref()
            .map(|value| serde_json::from_str(value))
            .transpose()?;
        let next = next.as_ref().unwrap_or(&self.previous.configuration);
        let old_basis = self
            .previous
            .workspace_binding
            .as_ref()
            .map(|binding| {
                crate::workspace_bindings::effective_boundary(&self.previous.configuration, binding)
            })
            .transpose()?;
        let new_basis = self
            .record
            .workspace_binding
            .as_ref()
            .map(|binding| crate::workspace_bindings::effective_boundary(next, binding))
            .transpose()?;
        Ok(old_basis != new_basis)
    }
    pub(crate) fn binding_ids(&self) -> impl Iterator<Item = uuid::Uuid> + '_ {
        self.previous
            .workspace_binding
            .iter()
            .chain(self.record.workspace_binding.iter())
            .map(|binding| binding.id)
    }
    pub(crate) fn validate(&self, connection: &rusqlite::Connection) -> Result<(), StoreError> {
        super::removal::require_mutable(connection, &self.previous.id)?;
        let current = read::<serde_json::Value>(connection, &self.previous.id)?
            .ok_or(StoreError::SessionNotFound)?;
        if current.revision != self.previous.revision {
            return Err(StoreError::SessionRevisionConflict {
                expected: self.previous.revision,
                actual: current.revision,
            });
        }
        if current != self.previous {
            return Err(invalid("prepared Session metadata changed"));
        }
        if let Some(configuration) = &self.configuration {
            crate::workspace_bindings::require_current_reference(
                connection,
                &serde_json::from_str(configuration)?,
            )?;
        }
        Ok(())
    }
    // The caller either just produced this choice in its transaction or validated it there.
    pub(crate) fn apply(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<(SessionRecord<T>, bool), StoreError> {
        let changed = self.configuration.is_some();
        if let Some(configuration) = self.configuration {
            if connection.execute(
                "UPDATE session_control SET configuration=?,revision=? WHERE id=?",
                params![configuration, self.record.revision as i64, &self.record.id],
            )? != 1
            {
                return Err(StoreError::SessionNotFound);
            }
            advance_catalog(connection)?;
        }
        Ok((self.record, changed))
    }
}

pub(crate) fn preview_metadata<T, F>(
    connection: &rusqlite::Connection,
    id: &str,
    expected: u64,
    always_advance: bool,
    update: F,
) -> Result<MetadataChange<T>, StoreError>
where
    T: Serialize + DeserializeOwned + Clone + PartialEq,
    F: FnOnce(&mut T) -> Result<(), StoreError>,
{
    super::removal::require_mutable(connection, id)?;
    let previous = read::<serde_json::Value>(connection, id)?.ok_or(StoreError::SessionNotFound)?;
    if previous.revision != expected {
        return Err(StoreError::SessionRevisionConflict {
            expected,
            actual: previous.revision,
        });
    }
    let mut normalized = previous.configuration.clone();
    crate::workspace_bindings::normalize(&mut normalized, previous.workspace_binding.as_ref())?;
    let mut configuration: T = serde_json::from_value(normalized)?;
    let original = configuration.clone();
    update(&mut configuration)?;
    if !always_advance && configuration == original {
        let original: T = serde_json::from_value(previous.configuration.clone())?;
        let record = previous.clone().map_configuration(|_| original);
        return Ok(MetadataChange {
            previous,
            record,
            configuration: None,
        });
    }
    let value = serde_json::to_value(&configuration)?;
    crate::workspace_bindings::require_current_reference(connection, &value)?;
    let encoded = serde_json::to_string(&value)?;
    let revision = expected
        .checked_add(1)
        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("session metadata revision exhausted"))?;
    let binding = crate::workspace_bindings::resolve(connection, &value)?;
    let revision =
        crate::workspace_bindings::effective_revision(revision, &value, binding.as_ref())?;
    use sha2::{Digest, Sha256};
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(encoded.as_bytes())));
    let mut record = previous.clone().map_configuration(|_| configuration);
    record.revision = revision;
    record.workspace_binding = binding;
    record.configuration_digest = digest;
    Ok(MetadataChange {
        previous,
        record,
        configuration: Some(encoded),
    })
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
            SessionMutation::Committed(record) => Ok(*record),
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
        validate_id(id)?;
        validate_time(now)?;
        let id = id.to_owned();
        let commits = self.commits.session(&id);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let (outcome, changed) = apply_archived(&tx, &id, expected, archived, now)?;
                if changed {
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                }
                Ok(outcome)
            })
            .await
    }

    /// Mutates control metadata without changing the creation fingerprint. Compare
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
        checkpoint: Option<crate::root_store::checkpoints::restore::Commit>,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        validate_id(id)?;
        if expected == 0 || expected > MAX_SAFE_INTEGER {
            return Err(invalid("invalid expected Session revision"));
        }
        let id = id.to_owned();
        let commits = self.commits.session(&id);
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                if let Some(commit) = &checkpoint {
                    commit.validate(&tx)?;
                }
                let change = match preview_metadata(&tx, &id, expected, always_advance, update) {
                    Ok(change) => change,
                    Err(StoreError::SessionRevisionConflict { expected, actual }) => {
                        return Ok(SessionMutation::RevisionConflict { expected, actual });
                    }
                    Err(error) => return Err(error),
                };
                let (record, changed) = change.apply(&tx)?;
                if !changed {
                    return Ok(SessionMutation::Committed(Box::new(record)));
                }
                if let Some(commit) = checkpoint {
                    commit.record(&tx, record.revision)?;
                }
                tx.commit().map_err(StoreError::CommitUnknown)?;
                commits.metadata();
                Ok(SessionMutation::Committed(Box::new(record)))
            })
            .await
    }
}
