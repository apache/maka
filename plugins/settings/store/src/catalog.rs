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

use maka_agent_facts::configuration::*;
use rusqlite::{Connection, OptionalExtension};
use uuid::Uuid;

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode};

impl ConfigurationStore {
    pub async fn catalog(&self) -> Result<ConnectionCatalogSnapshot> {
        self.transaction(TransactionMode::Deferred, read).await
    }

    /// Reads model choices for one connection and preserves the global default model.
    pub async fn model_catalog(
        &self,
        connection_id: Option<&str>,
    ) -> Result<ConnectionCatalogSnapshot> {
        let Some(connection_id) = connection_id else {
            return self.catalog().await;
        };
        let connection_id = connection_id.to_owned();
        self.transaction(TransactionMode::Deferred, move |tx| {
            {
                let (revision, default): (i64, Option<String>) = tx.prepare_cached("SELECT revision, default_target FROM connection_catalog WHERE singleton = 1")?.query_row(rusqlite::params![], |row| Ok((row.get(0)?, row.get(1)?,)))?;
                let default_target: Option<ConnectionTarget> = default
                    .map(|json| serde_json::from_str(&json))
                    .transpose()?;
                let rows: Vec<String> = tx.prepare_cached("SELECT document FROM connections WHERE connection_id = ?")?.query_map(rusqlite::params![&connection_id], |row| row.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
                let mut connections = rows.iter().map(|row| decode_entry(row)).collect::<Result<Vec<_>>>()?;
                if let Some(target) = &default_target
                    && target.connection_id != connection_id
                {
                    let document: Option<String> = tx.prepare_cached("SELECT CASE WHEN json_type(projected, '$.modelOverrides') = 'null'
                            THEN json_remove(projected, '$.modelOverrides') ELSE projected END
                         FROM (SELECT json_set(document,
                            '$.models', (SELECT json_group_array(json(value)) FROM json_each(document, '$.models') WHERE json_extract(value, '$.id') = ?),
                            '$.enabledModelIds', (SELECT json_group_array(value) FROM json_each(document, '$.enabledModelIds') WHERE value = ?),
                            '$.modelOverrides', json(NULLIF((SELECT json_group_object(key, json(value)) FROM json_each(document, '$.modelOverrides') WHERE key = ?), '{}'))) AS projected
                         FROM connections WHERE connection_id = ?)")?.query_row(rusqlite::params![&target.model_id, &target.model_id, &target.model_id, &target.connection_id], |row| row.get(0)).optional()?;
                    if let Some(document) = document {
                        connections.push(decode_entry(&document)?);
                    }
                }
                Ok(ConnectionCatalogSnapshot {
                    revision: crate::database::unsigned(revision)?,
                    default_target,
                    connections,
                })
            }
        })
        .await
    }

    pub async fn create_connection(
        &self,
        input: CreateCatalogConnectionInput,
    ) -> Result<CreateCatalogConnectionResult> {
        let input = validation::normalize_create(input).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            let current = read(tx)?;
            if current.revision != input.expected_catalog_revision {
                return Ok(CatalogMutationResult::RevisionConflict {
                    expected_revision: input.expected_catalog_revision,
                    actual_revision: current.revision,
                });
            }
            if current
                .connections
                .iter()
                .any(|row| row.slug == input.connection.slug)
            {
                return Ok(CatalogMutationResult::ConnectionExists {
                    slug: input.connection.slug,
                });
            }
            let draft = input.connection;
            let row = ConnectionCatalogEntry {
                connection_id: Uuid::new_v4().to_string(),
                revision: 1,
                slug: draft.slug,
                name: draft.name,
                provider: draft.provider,
                configuration: draft.configuration,
                enabled: draft.enabled,
                enabled_model_ids: draft.enabled_model_ids,
                model_overrides: draft.model_overrides,
                request_body_overlay: draft.request_body_overlay,
                models: Vec::new(),
                model_source: None,
                models_fetched_at: None,
                last_test: None,
            };
            write_entry(tx, &row)?;
            let revision = advance(tx, current.revision, current.default_target.as_ref())?;
            Ok(CatalogMutationResult::Committed {
                catalog_revision: revision,
                connection: Some(basis(&row)),
            })
        })
        .await
    }

    pub async fn set_default_target(
        &self,
        input: SetDefaultConnectionTargetInput,
    ) -> Result<SetDefaultConnectionTargetResult> {
        validation::revision(input.expected_catalog_revision, false)
            .map_err(ConfigError::Invalid)?;
        if let Some(target) = &input.target {
            validation::target(target).map_err(ConfigError::Invalid)?;
        }
        self.transaction(TransactionMode::Immediate, move |tx| {
            let current = read(tx)?;
            if current.revision != input.expected_catalog_revision {
                return Ok(CatalogMutationResult::RevisionConflict {
                    expected_revision: input.expected_catalog_revision,
                    actual_revision: current.revision,
                });
            }
            if let Some(target) = &input.target
                && !valid_target(target, &current.connections)
            {
                return Ok(CatalogMutationResult::InvalidDefaultTarget {
                    target: target.clone(),
                });
            }
            let revision = advance(tx, current.revision, input.target.as_ref())?;
            Ok(CatalogMutationResult::Committed {
                catalog_revision: revision,
                connection: None,
            })
        })
        .await
    }
}

pub(crate) fn basis(row: &ConnectionCatalogEntry) -> ConnectionVersionBasis {
    ConnectionVersionBasis {
        connection_id: row.connection_id.clone(),
        revision: row.revision,
    }
}

pub(crate) fn valid_target(target: &ConnectionTarget, rows: &[ConnectionCatalogEntry]) -> bool {
    rows.iter().any(|row| {
        row.connection_id == target.connection_id
            && row.enabled
            && row.enabled_model_ids.contains(&target.model_id)
            && row.provider.scope == maka_plugin_core::scope::Scope::Profile
    })
}

pub(crate) fn read(tx: &Connection) -> Result<ConnectionCatalogSnapshot> {
    let (revision, default): (i64, Option<String>) = tx
        .prepare_cached(
            "SELECT revision, default_target FROM connection_catalog WHERE singleton = 1",
        )?
        .query_row(rusqlite::params![], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let revision = crate::database::unsigned(revision)?;
    let rows: Vec<String> = tx
        .prepare_cached("SELECT document FROM connections ORDER BY rowid")?
        .query_map(rusqlite::params![], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let connections = rows
        .iter()
        .map(|row| decode_entry(row))
        .collect::<Result<Vec<_>>>()?;
    Ok(ConnectionCatalogSnapshot {
        revision,
        default_target: default
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        connections,
    })
}

pub(crate) fn find(tx: &Connection, id: &str) -> Result<Option<ConnectionCatalogEntry>> {
    let document: Option<String> = tx
        .prepare_cached("SELECT document FROM connections WHERE connection_id = ?")?
        .query_row(rusqlite::params![id], |row| row.get(0))
        .optional()?;
    document.map(|document| decode_entry(&document)).transpose()
}

fn decode_entry(document: &str) -> Result<ConnectionCatalogEntry> {
    let row = serde_json::from_str(document)?;
    validation::catalog_entry(&row).map_err(ConfigError::Invalid)?;
    Ok(row)
}

pub(crate) fn write_entry(tx: &Connection, row: &ConnectionCatalogEntry) -> Result<()> {
    validation::catalog_entry(row).map_err(ConfigError::Invalid)?;
    tx.execute("INSERT INTO connections VALUES(?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET revision = excluded.revision, document = excluded.document", rusqlite::params![&row.connection_id, &row.slug, row.revision as i64, serde_json::to_string(row)?])?;
    Ok(())
}

pub(crate) fn advance(
    tx: &Connection,
    previous: u64,
    target: Option<&ConnectionTarget>,
) -> Result<u64> {
    let revision = next_revision(previous)?;
    let target = target.map(serde_json::to_string).transpose()?;
    tx.execute(
        "UPDATE connection_catalog SET revision = ?, default_target = ? WHERE singleton = 1",
        rusqlite::params![revision as i64, target],
    )?;
    Ok(revision)
}

pub(crate) fn next_revision(previous: u64) -> Result<u64> {
    previous
        .checked_add(1)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| ConfigError::Invalid("configuration revision exhausted".into()))
}
