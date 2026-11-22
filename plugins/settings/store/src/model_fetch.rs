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

use crate::{
    ConfigError, ConfigurationStore, Result, TransactionMode, catalog,
    effect_snapshot::{EffectSnapshot, same_test_basis},
};
use maka_agent_facts::configuration::*;
use std::sync::Arc;

/// The successful preparation is bound to its issuing store and consumed once.
pub enum ModelFetchPreparation {
    Ready(Box<PreparedModelFetch>),
    Rejected(ConnectionEffectRejectionReason),
}

pub struct PreparedModelFetch {
    store: Arc<ConfigurationStore>,
    material: EffectSnapshot,
}

impl ConfigurationStore {
    pub async fn prepare_model_fetch(
        self: &Arc<Self>,
        connection_id: &str,
    ) -> Result<ModelFetchPreparation> {
        validation::entity_id(connection_id).map_err(ConfigError::Invalid)?;
        let id = connection_id.to_owned();
        let store = Arc::clone(self);
        self.transaction(TransactionMode::Deferred, move |tx| {
            use ConnectionEffectRejectionReason as Rejected;
            use ModelFetchPreparation as Preparation;
            let Some(connection) = catalog::find(tx, &id)? else {
                return Ok(Preparation::Rejected(Rejected::ConnectionNotFound));
            };
            if !connection.enabled {
                return Ok(Preparation::Rejected(Rejected::ConnectionDisabled));
            }
            let material = EffectSnapshot::read(tx, connection)?;
            Ok(Preparation::Ready(Box::new(PreparedModelFetch {
                store,
                material,
            })))
        })
        .await
    }
}

impl PreparedModelFetch {
    pub fn provider_credential(&self) -> Result<Option<crate::oauth::ProviderCredential>> {
        self.material.provider_credential(&self.store)
    }

    pub fn accept_credential(&mut self, resolved: crate::oauth::ProviderCredential) -> Result<()> {
        self.material.accept_credential(&self.store, resolved)
    }

    pub fn network_configuration(&self) -> &crate::network::NetworkConfiguration {
        &self.material.network.configuration
    }
    pub fn connection(&self) -> &ConnectionCatalogEntry {
        &self.material.connection
    }

    pub fn request_headers(&self) -> Option<&str> {
        self.material.request_headers()
    }

    /// Network discovery has completed. Recheck only facts that determined it;
    /// unrelated catalog edits survive and do not invalidate this observation.
    pub async fn complete(
        self,
        models: Vec<ModelInfo>,
        fetched_at: u64,
    ) -> Result<ConnectionModelFetchResult> {
        validation::revision(fetched_at, false).map_err(ConfigError::Invalid)?;
        if models.is_empty() {
            return Err(ConfigError::Invalid(
                "discovery requires at least one model".into(),
            ));
        }
        for model in &models {
            model.validate().map_err(ConfigError::Invalid)?;
        }
        let material = self.material;
        self.store
            .transaction(TransactionMode::Immediate, move |tx| {
                let catalog = catalog::read(tx)?;
                let current = catalog
                    .connections
                    .into_iter()
                    .find(|row| row.connection_id == material.connection.connection_id);
                let changed = material.changed(tx, current.as_ref())?;
                if !changed.is_empty() {
                    return Ok(ConnectionModelFetchResult::Superseded { changed });
                }
                let mut row = current.expect("unchanged connection exists");
                let previous = row.clone();
                let selected_default = catalog
                    .default_target
                    .as_ref()
                    .filter(|target| target.connection_id == row.connection_id)
                    .map(|target| target.model_id.as_str())
                    .or_else(|| row.enabled_model_ids.first().map(String::as_str));
                if row.models.is_empty()
                    && row.enabled_model_ids.is_empty()
                    && selected_default.is_none_or(str::is_empty)
                {
                    row.enabled_model_ids.push(models[0].id.clone());
                }
                row.models = models;
                row.model_source = Some(ModelDiscoverySource::Fetched);
                row.models_fetched_at = Some(fetched_at);
                row.revision = catalog::next_revision(row.revision)?;
                if !same_test_basis(&previous, &row) {
                    row.last_test = None;
                }
                catalog::write_entry(tx, &row)?;
                let catalog_revision =
                    catalog::advance(tx, catalog.revision, catalog.default_target.as_ref())?;
                Ok(ConnectionModelFetchResult::Committed {
                    catalog_revision,
                    connection: catalog::basis(&row),
                    model_count: row.models.len() as u64,
                    source: ModelDiscoverySource::Fetched,
                    fetched_at,
                })
            })
            .await
    }
}
