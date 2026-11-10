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
use crate::{EventLog, StoreError};
use maka_plugin_core::storage::Data;
use maka_plugin_core::storage::MAX_PAGE_BYTES;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::storage::Record;
use maka_plugin_core::storage::validate_key;
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeSet;

impl EventLog {
    /// Read only within an already-owned Root transaction; never opens another connection.
    pub fn read_plugin_data_in_transaction(
        connection: &Connection,
        namespace: &Namespace,
        key: &str,
    ) -> Result<Option<Record>, StoreError> {
        validate_key(key).map_err(|error| invalid(&error.to_string()))?;
        read(connection, namespace, key)
    }
    pub async fn plugin_data_scan(
        &self,
        namespace: &Namespace,
        query: maka_plugin_core::storage::Scan,
    ) -> Result<maka_plugin_core::storage::Page, StoreError> {
        query
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        let namespace = namespace.clone();
        self.connection.read(move |connection| {
            // Select key/size first: the page budget must bound decoding and
            // allocation as well as the serialized reply. Keep one overflow key.
            let rows: Vec<(String, i64, Option<String>, bool)> = connection.prepare_cached("WITH candidates AS (
                    SELECT key, COALESCE(length(CAST(value_json AS BLOB)), 0) + length(CAST(key AS BLOB)) + 128 AS bytes
                    FROM plugin_data WHERE package_id = ?1 AND scope_id = ?2
                      AND key >= ?3 AND key > ?4 ORDER BY key LIMIT 65
                 ), bounded AS (
                    SELECT key, ROW_NUMBER() OVER (ORDER BY key) AS position,
                        SUM(bytes) OVER (ORDER BY key) AS total FROM candidates
                 ) SELECT data.key, data.revision,
                    CASE WHEN bounded.position = 1 OR (bounded.position <= 64 AND bounded.total <= ?5) THEN data.value_json END,
                    bounded.position = 1 OR (bounded.position <= 64 AND bounded.total <= ?5)
                 FROM bounded JOIN plugin_data AS data
                   ON data.package_id = ?1 AND data.scope_id = ?2 AND data.key = bounded.key
                 ORDER BY data.key")?.query_map(rusqlite::params![namespace.package(), String::from(namespace.scope().clone()), &query.prefix, query.after.as_deref().unwrap_or(""), MAX_PAGE_BYTES as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?.collect::<Result<Vec<_>, _>>()?;
            let mut entries: Vec<maka_plugin_core::storage::Entry> = Vec::new();
            let mut next_after = None;
            for (key, revision, value, fits) in rows {
                if !key.starts_with(&query.prefix) { break; }
                if !fits {
                    next_after = Some(entries.last().ok_or_else(|| invalid("stored plugin value exceeds page budget"))?
                        .key.clone());
                    break;
                }
                entries.push(maka_plugin_core::storage::Entry { key, record: decode(revision, value)? });
            }
            Ok(maka_plugin_core::storage::Page { entries, next_after })
        }).await
    }
    /// Current live values only; tombstone synchronization uses plugin_data_scan.
    pub(crate) async fn plugin_data_live_scan(
        &self,
        namespace: &Namespace,
        query: maka_plugin_core::storage::Scan,
    ) -> Result<maka_plugin_core::storage::Page, StoreError> {
        query
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        let namespace = namespace.clone();
        self.connection.read(move |connection| {
            // Select key/size first: the page budget must bound decoding and
            // allocation as well as the serialized reply. Keep one overflow key.
            let rows: Vec<(String, i64, Option<String>, bool)> = connection.prepare_cached("WITH candidates AS (
                    SELECT key, COALESCE(length(CAST(value_json AS BLOB)), 0) + length(CAST(key AS BLOB)) + 128 AS bytes
                    FROM plugin_data INDEXED BY plugin_data_live_keys
                    WHERE package_id = ?1 AND scope_id = ?2 AND value_json IS NOT NULL
                      AND key >= ?3 AND key > ?4 ORDER BY key LIMIT 65
                 ), bounded AS (
                    SELECT key, ROW_NUMBER() OVER (ORDER BY key) AS position,
                        SUM(bytes) OVER (ORDER BY key) AS total FROM candidates
                 ) SELECT data.key, data.revision,
                    CASE WHEN bounded.position = 1 OR (bounded.position <= 64 AND bounded.total <= ?5) THEN data.value_json END,
                    bounded.position = 1 OR (bounded.position <= 64 AND bounded.total <= ?5)
                 FROM bounded JOIN plugin_data AS data
                   ON data.package_id = ?1 AND data.scope_id = ?2 AND data.key = bounded.key
                 ORDER BY data.key")?.query_map(rusqlite::params![namespace.package(), String::from(namespace.scope().clone()), &query.prefix, query.after.as_deref().unwrap_or(""), MAX_PAGE_BYTES as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?.collect::<Result<Vec<_>, _>>()?;
            let mut entries: Vec<maka_plugin_core::storage::Entry> = Vec::new();
            let mut next_after = None;
            for (key, revision, value, fits) in rows {
                if !key.starts_with(&query.prefix) { break; }
                if !fits {
                    next_after = Some(entries.last().ok_or_else(|| invalid("stored plugin value exceeds page budget"))?
                        .key.clone());
                    break;
                }
                entries.push(maka_plugin_core::storage::Entry { key, record: decode(revision, value)? });
            }
            Ok(maka_plugin_core::storage::Page { entries, next_after })
        }).await
    }
    pub async fn plugin_data(
        &self,
        namespace: &Namespace,
        key: &str,
    ) -> Result<Option<Record>, StoreError> {
        validate_key(key).map_err(|error| invalid(&error.to_string()))?;
        let namespace = namespace.clone();
        let key = key.to_owned();
        self.connection
            .read(move |connection| read(connection, &namespace, &key))
            .await
    }

    /// All compares and writes commit atomically within one package/scope.
    pub async fn plugin_data_batch(
        &self,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
    ) -> Result<Vec<Record>, StoreError> {
        if mutations.is_empty() {
            return Err(invalid("plugin data batch must not be empty"));
        }
        let batch = DataBatch::prepare(namespace, mutations)?;
        self.connection
            .write(
                WritePluginData {
                    batch,
                    require_session_visible: false,
                },
                self.commits.notice(),
            )
            .await
    }

    /// Commits pure provider state and its original result in one transaction.
    /// The original live claim must belong to this exact Root partition.
    pub async fn commit_operation_data(
        &self,
        claim: &crate::applications::operations::DispatchClaim,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
        result: maka_plugin_core::operation::OperationResult,
    ) -> Result<maka_plugin_core::operation::OperationObservation, StoreError> {
        let batch = DataBatch::prepare(namespace, mutations)?;
        self.commit_statement(
            claim,
            WritePluginData {
                batch,
                require_session_visible: true,
            },
            result,
        )
        .await
    }
}

#[derive(Clone)]
struct DataBatch {
    namespace: Namespace,
    mutations: Vec<(Mutation, Option<String>)>,
}
impl DataBatch {
    fn prepare(namespace: &Namespace, mutations: Vec<Mutation>) -> Result<Self, StoreError> {
        let mut keys = BTreeSet::new();
        let mut prepared = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            mutation
                .validate()
                .map_err(|error| invalid(&error.to_string()))?;
            if !keys.insert(mutation.key.clone()) {
                return Err(invalid("duplicate plugin data batch key"));
            }
            let encoded = mutation
                .data
                .value()
                .map(serde_json::to_string)
                .transpose()?;
            prepared.push((mutation, encoded));
        }
        Ok(Self {
            namespace: namespace.clone(),
            mutations: prepared,
        })
    }
    fn execute(self, connection: &Connection) -> Result<Vec<Record>, StoreError> {
        let mut records = Vec::with_capacity(self.mutations.len());
        for (mutation, encoded) in self.mutations {
            let current = read(connection, &self.namespace, &mutation.key)?;
            let actual = current.as_ref().map(|record| record.revision);
            if actual != mutation.expected_revision {
                return Err(StoreError::RevisionConflict {
                    expected: mutation
                        .expected_revision
                        .map_or_else(|| "absent".into(), |revision| revision.to_string()),
                    actual: actual.map_or_else(|| "absent".into(), |revision| revision.to_string()),
                });
            }
            let revision = actual.unwrap_or(0) + 1;
            if revision > (1 << 53) - 1 {
                return Err(invalid("plugin data revision exhausted"));
            }
            connection.execute("INSERT INTO plugin_data (package_id, scope_id, key, revision, value_json) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(package_id, scope_id, key) DO UPDATE SET revision = excluded.revision, value_json = excluded.value_json", rusqlite::params![self.namespace.package(), String::from(self.namespace.scope().clone()), &mutation.key, revision as i64, encoded])?;
            records.push(Record {
                revision,
                data: mutation.data,
            });
        }
        Ok(records)
    }
}

#[derive(Clone)]
pub(crate) struct WritePluginData {
    batch: DataBatch,
    require_session_visible: bool,
}
impl WritePluginData {
    pub(crate) fn for_completion(
        namespace: &Namespace,
        mutations: Vec<Mutation>,
    ) -> Result<(Vec<Record>, Self), StoreError> {
        if mutations.is_empty() {
            return Err(invalid("plugin data batch must not be empty"));
        }
        let batch = DataBatch::prepare(namespace, mutations)?;
        let records = batch
            .mutations
            .iter()
            .map(|(mutation, _)| {
                let revision = mutation
                    .expected_revision
                    .unwrap_or(0)
                    .checked_add(1)
                    .filter(|revision| *revision < (1 << 53))
                    .ok_or_else(|| invalid("plugin data revision exhausted"))?;
                Ok(Record {
                    revision,
                    data: mutation.data.clone(),
                })
            })
            .collect::<Result<_, StoreError>>()?;
        Ok((
            records,
            Self {
                batch,
                require_session_visible: true,
            },
        ))
    }
}
impl crate::writeback::Statement for WritePluginData {
    type Value = Vec<Record>;
    type Output = Vec<Record>;
    fn execute(
        self,
        connection: &Connection,
    ) -> Result<crate::writeback::Prepared<Self::Value>, StoreError> {
        if self.require_session_visible
            && let maka_plugin_core::scope::Scope::Session(session) = self.batch.namespace.scope()
        {
            let available: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_creations c JOIN session_control s ON s.id=c.session_id WHERE c.session_id=? AND c.ready=1 AND c.visible=1 AND NOT EXISTS(SELECT 1 FROM session_retirements r WHERE r.session_id=c.session_id))",
                    [session], |row| row.get(0),
                )?;
            if !available {
                return Err(StoreError::SessionNotFound);
            }
        }
        let records = self.batch.execute(connection)?;
        Ok(crate::writeback::Prepared {
            changed: !records.is_empty(),
            value: records,
            notification: crate::writeback::Notification::METADATA,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        data_rejection(error)
    }
}

fn data_rejection(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::RevisionConflict { .. }
            | StoreError::SessionNotFound
            | StoreError::EventConflict
            | StoreError::InvalidTransition(_)
    )
}

fn read(
    connection: &Connection,
    namespace: &Namespace,
    key: &str,
) -> Result<Option<Record>, StoreError> {
    let row: Option<(i64, Option<String>)> = connection.query_row("SELECT revision, value_json FROM plugin_data WHERE package_id = ? AND scope_id = ? AND key = ?", rusqlite::params![namespace.package(), String::from(namespace.scope().clone()), key], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
    row.map(|(revision, value)| decode(revision, value))
        .transpose()
}
fn decode(revision: i64, value: Option<String>) -> Result<Record, StoreError> {
    let revision =
        u64::try_from(revision).map_err(|_| invalid("invalid stored plugin data revision"))?;
    if revision == 0 || revision > (1 << 53) - 1 {
        return Err(invalid("invalid stored plugin data revision"));
    }
    Ok(Record {
        revision,
        data: match value {
            Some(value) => Data::Present(serde_json::from_str(&value)?),
            None => Data::Deleted,
        },
    })
}
