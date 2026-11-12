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

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode, catalog, vault};
use maka_agent_facts::configuration::*;

impl ConfigurationStore {
    pub async fn update_connection(
        &self,
        input: UpdateCatalogConnectionInput,
    ) -> Result<UpdateCatalogConnectionResult> {
        validation::basis(&input.expected).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            let current = catalog::read(tx)?;
            let Some(mut row) = catalog::find(tx, &input.expected.connection_id)? else {
                return Ok(CatalogMutationResult::ConnectionStale {
                    expected: input.expected,
                    actual: None,
                });
            };
            if row.revision != input.expected.revision {
                return Ok(CatalogMutationResult::ConnectionStale {
                    expected: input.expected,
                    actual: Some(catalog::basis(&row)),
                });
            }
            let mut changes = input.changes;
            validation::normalize_update(&mut changes).map_err(ConfigError::Invalid)?;
            let configuration_changed = changes
                .configuration
                .as_ref()
                .is_some_and(|value| row.configuration != *value);
            let overlay_changed = match &changes.request_body_overlay {
                Patch::Keep => false,
                Patch::Clear => row.request_body_overlay.is_some(),
                Patch::Set(value) => row.request_body_overlay.as_ref() != Some(value),
            };
            let previous = row.clone();
            let mut test_changed = configuration_changed
                || changes.enabled.is_some_and(|value| row.enabled != value)
                || changes
                    .enabled_model_ids
                    .as_ref()
                    .is_some_and(|value| row.enabled_model_ids != *value)
                || overlay_changed;
            row.revision = catalog::next_revision(row.revision)?;
            if let Some(value) = changes.name {
                row.name = value;
            }
            if let Some(value) = changes.configuration {
                row.configuration = value;
            }
            if let Some(value) = changes.enabled {
                row.enabled = value;
            }
            if let Some(value) = changes.enabled_model_ids {
                row.enabled_model_ids = value;
            }
            row.model_overrides = match changes.model_overrides {
                Patch::Set(profiles) => Some(profiles),
                Patch::Clear => None,
                Patch::Keep if configuration_changed => None,
                Patch::Keep => row.model_overrides,
            };
            row.request_body_overlay = match changes.request_body_overlay {
                Patch::Keep => row.request_body_overlay,
                Patch::Clear => None,
                Patch::Set(value) => Some(value),
            };
            if configuration_changed {
                row.models.clear();
                row.model_source = None;
                row.models_fetched_at = None;
            }
            test_changed |= !crate::effect_snapshot::same_test_basis(&previous, &row);
            if test_changed {
                row.last_test = None;
            }
            catalog::write_entry(tx, &row)?;
            let rows = catalog::read(tx)?.connections;
            let target = current
                .default_target
                .filter(|target| catalog::valid_target(target, &rows));
            Ok(CatalogMutationResult::Committed {
                catalog_revision: catalog::advance(tx, current.revision, target.as_ref())?,
                connection: Some(catalog::basis(&row)),
            })
        })
        .await
    }

    /// Catalog deletion and credential cleanup share one durable transaction.
    /// Repeating a removal of an absent connection is a successful no-op.
    pub async fn remove_connection(
        &self,
        input: RemoveCatalogConnectionInput,
    ) -> Result<RemoveCatalogConnectionResult> {
        validation::basis(&input.expected).map_err(ConfigError::Invalid)?;
        self.transaction(TransactionMode::Immediate, move |tx| {
            let current = catalog::read(tx)?;
            let existing = catalog::find(tx, &input.expected.connection_id)?;
            if let Some(row) = &existing
                && row.revision != input.expected.revision
            {
                return Ok(CatalogMutationResult::ConnectionStale {
                    expected: input.expected,
                    actual: Some(catalog::basis(row)),
                });
            }
            let removed = tx.execute(
                "DELETE FROM credentials WHERE json_extract(locator, '$.scope') = 'connection'
                    AND json_extract(locator, '$.connectionId') = ?",
                rusqlite::params![&input.expected.connection_id],
            )?;
            if removed > 0 {
                vault::advance(tx)?;
            }
            let revision = if existing.is_some() {
                tx.execute(
                    "DELETE FROM connections WHERE connection_id = ?",
                    rusqlite::params![&input.expected.connection_id],
                )?;
                let target = current
                    .default_target
                    .filter(|target| target.connection_id != input.expected.connection_id);
                catalog::advance(tx, current.revision, target.as_ref())?
            } else {
                current.revision
            };
            Ok(CatalogMutationResult::Committed {
                catalog_revision: revision,
                connection: None,
            })
        })
        .await
    }
}
