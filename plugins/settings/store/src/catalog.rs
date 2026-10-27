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
use sqlx::SqliteConnection;
use uuid::Uuid;

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode};

impl ConfigurationStore {
    pub async fn catalog(&self) -> Result<ConnectionCatalogSnapshot> {
        self.transaction(TransactionMode::Deferred, |tx| Box::pin(read(tx)))
            .await
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
            Box::pin(async move {
                let (revision, default): (i64, Option<String>) = sqlx::query_as(
                    "SELECT revision, default_target FROM connection_catalog WHERE singleton = 1",
                )
                .fetch_one(&mut *tx)
                .await?;
                let default_target: Option<ConnectionTarget> = default
                    .map(|json| serde_json::from_str(&json))
                    .transpose()?;
                let rows: Vec<String> = sqlx::query_scalar(
                    "SELECT document FROM connections WHERE connection_id = ?",
                )
                .bind(&connection_id)
                .fetch_all(&mut *tx)
                .await?;
                let mut connections = rows.iter().map(|row| decode_entry(row)).collect::<Result<Vec<_>>>()?;
                if let Some(target) = &default_target
                    && target.connection_id != connection_id
                {
                    let document: Option<String> = sqlx::query_scalar(
                        "SELECT CASE WHEN json_type(projected, '$.modelOverrides') = 'null'
                            THEN json_remove(projected, '$.modelOverrides') ELSE projected END
                         FROM (SELECT json_set(document,
                            '$.models', (SELECT json_group_array(json(value)) FROM json_each(document, '$.models') WHERE json_extract(value, '$.id') = ?),
                            '$.enabledModelIds', (SELECT json_group_array(value) FROM json_each(document, '$.enabledModelIds') WHERE value = ?),
                            '$.modelOverrides', json(NULLIF((SELECT json_group_object(key, json(value)) FROM json_each(document, '$.modelOverrides') WHERE key = ?), '{}'))) AS projected
                         FROM connections WHERE connection_id = ?)",
                    )
                    .bind(&target.model_id)
                    .bind(&target.model_id)
                    .bind(&target.model_id)
                    .bind(&target.connection_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    if let Some(document) = document {
                        connections.push(decode_entry(&document)?);
                    }
                }
                Ok(ConnectionCatalogSnapshot {
                    revision: crate::database::unsigned(revision)?,
                    default_target,
                    connections,
                })
            })
        })
        .await
    }

    pub async fn create_connection(
        &self,
        input: CreateCatalogConnectionInput,
    ) -> Result<CreateCatalogConnectionResult> {
        let input = validation::normalize_create(input).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            Box::pin(async move {
                let current = read(tx).await?;
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
                crate::model_catalog::validate_overrides(&row)?;
                write_entry(tx, &row).await?;
                let revision =
                    advance(tx, current.revision, current.default_target.as_ref()).await?;
                Ok(CatalogMutationResult::Committed {
                    catalog_revision: revision,
                    connection: Some(basis(&row)),
                })
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
            Box::pin(async move {
                let current = read(tx).await?;
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
                let revision = advance(tx, current.revision, input.target.as_ref()).await?;
                Ok(CatalogMutationResult::Committed {
                    catalog_revision: revision,
                    connection: None,
                })
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

pub(crate) async fn read(tx: &mut SqliteConnection) -> Result<ConnectionCatalogSnapshot> {
    let (revision, default): (i64, Option<String>) = sqlx::query_as(
        "SELECT revision, default_target FROM connection_catalog WHERE singleton = 1",
    )
    .fetch_one(&mut *tx)
    .await?;
    let revision = crate::database::unsigned(revision)?;
    let rows: Vec<String> = sqlx::query_scalar("SELECT document FROM connections ORDER BY rowid")
        .fetch_all(&mut *tx)
        .await?;
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

pub(crate) async fn find(
    tx: &mut SqliteConnection,
    id: &str,
) -> Result<Option<ConnectionCatalogEntry>> {
    let document: Option<String> =
        sqlx::query_scalar("SELECT document FROM connections WHERE connection_id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    document.map(|document| decode_entry(&document)).transpose()
}

fn decode_entry(document: &str) -> Result<ConnectionCatalogEntry> {
    let row = serde_json::from_str(document)?;
    validation::catalog_entry(&row).map_err(ConfigError::Invalid)?;
    Ok(row)
}

pub(crate) async fn write_entry(
    tx: &mut SqliteConnection,
    row: &ConnectionCatalogEntry,
) -> Result<()> {
    validation::catalog_entry(row).map_err(ConfigError::Invalid)?;
    sqlx::query("INSERT INTO connections VALUES(?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET revision = excluded.revision, document = excluded.document")
        .bind(&row.connection_id).bind(&row.slug).bind(row.revision as i64)
        .bind(serde_json::to_string(row)?).execute(&mut *tx).await?;
    Ok(())
}

pub(crate) async fn advance(
    tx: &mut SqliteConnection,
    previous: u64,
    target: Option<&ConnectionTarget>,
) -> Result<u64> {
    let revision = next_revision(previous)?;
    let target = target.map(serde_json::to_string).transpose()?;
    sqlx::query(
        "UPDATE connection_catalog SET revision = ?, default_target = ? WHERE singleton = 1",
    )
    .bind(revision as i64)
    .bind(target)
    .execute(&mut *tx)
    .await?;
    Ok(revision)
}

pub(crate) fn next_revision(previous: u64) -> Result<u64> {
    previous
        .checked_add(1)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| ConfigError::Invalid("configuration revision exhausted".into()))
}
