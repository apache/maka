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

#[cfg(test)]
mod tests;

use super::invalid;
use crate::{EventLog, StoreError};
use maka_capabilities::storage::Data;
use maka_capabilities::storage::MAX_PAGE_BYTES;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_capabilities::storage::Record;
use maka_capabilities::storage::validate_key;
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeSet;

impl EventLog {
    pub async fn plugin_data_scan(
        &self,
        namespace: &Namespace,
        query: maka_capabilities::storage::Scan,
    ) -> Result<maka_capabilities::storage::Page, StoreError> {
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
            let mut entries: Vec<maka_capabilities::storage::Entry> = Vec::new();
            let mut next_after = None;
            for (key, revision, value, fits) in rows {
                if !key.starts_with(&query.prefix) { break; }
                if !fits {
                    next_after = Some(entries.last().ok_or_else(|| invalid("stored plugin value exceeds page budget"))?
                        .key.clone());
                    break;
                }
                entries.push(maka_capabilities::storage::Entry { key, record: decode(revision, value)? });
            }
            Ok(maka_capabilities::storage::Page { entries, next_after })
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
        let mut keys = BTreeSet::new();
        let mut encoded = Vec::new();
        for mutation in &mutations {
            mutation
                .validate()
                .map_err(|error| invalid(&error.to_string()))?;
            if !keys.insert(&mutation.key) {
                return Err(invalid("duplicate plugin data batch key"));
            }
            let value = mutation
                .data
                .value()
                .map(serde_json::to_string)
                .transpose()?;
            encoded.push(value);
        }
        let namespace = namespace.clone();
        let commits = self.commits.notice();
        self.connection.run(move |connection| {
            let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
            let mut records = Vec::new();
            for (mutation, encoded) in mutations.into_iter().zip(encoded) {
                let current = read(&tx, &namespace, &mutation.key)?;
                let actual = current.as_ref().map(|record| record.revision);
                if actual != mutation.expected_revision {
                    return Err(StoreError::RevisionConflict {
                        expected: mutation.expected_revision.map_or_else(|| "absent".into(), |revision| revision.to_string()),
                        actual: actual.map_or_else(|| "absent".into(), |revision| revision.to_string()),
                    });
                }
                let revision = actual.unwrap_or(0) + 1;
                if revision > (1 << 53) - 1 { return Err(invalid("plugin data revision exhausted")); }
                tx.execute("INSERT INTO plugin_data (package_id, scope_id, key, revision, value_json) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(package_id, scope_id, key) DO UPDATE SET revision = excluded.revision, value_json = excluded.value_json", rusqlite::params![namespace.package(), String::from(namespace.scope().clone()), &mutation.key, revision as i64, encoded])?;
                records.push(Record { revision, data: mutation.data });
            }
            tx.commit().map_err(StoreError::CommitUnknown)?;
            commits.metadata();
            Ok(records)
        }).await
    }
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
