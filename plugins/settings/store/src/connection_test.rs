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

pub enum ConnectionTestPreparation {
    Ready(Box<PreparedConnectionTest>),
    Rejected(ConnectionEffectRejectionReason),
}

pub struct PreparedConnectionTest {
    store: Arc<ConfigurationStore>,
    material: EffectSnapshot,
    model_id: Option<String>,
}

impl ConfigurationStore {
    pub async fn prepare_connection_test(
        self: &Arc<Self>,
        input: ConnectionTestRunInput,
    ) -> Result<ConnectionTestPreparation> {
        validation::entity_id(&input.connection_id).map_err(ConfigError::Invalid)?;
        if let Some(id) = &input.model_id {
            validation::text(id).map_err(ConfigError::Invalid)?;
        }
        let store = Arc::clone(self);
        self.transaction(TransactionMode::Deferred, move |tx| {
            use ConnectionEffectRejectionReason as Rejected;
            use ConnectionTestPreparation as Preparation;
            let Some(connection) = catalog::find(tx, &input.connection_id)? else {
                return Ok(Preparation::Rejected(Rejected::ConnectionNotFound));
            };
            if !connection.enabled {
                return Ok(Preparation::Rejected(Rejected::ConnectionDisabled));
            }
            let material = EffectSnapshot::read(tx, connection)?;
            if let Some(id) = &input.model_id
                && !material.connection.enabled_model_ids.contains(id)
                && !material
                    .connection
                    .models
                    .iter()
                    .any(|model| model.id == *id)
                && !material
                    .connection
                    .model_overrides
                    .as_ref()
                    .is_some_and(|values| values.contains_key(id))
            {
                return Err(ConfigError::Invalid(
                    "connection test model is not in the canonical model set".into(),
                ));
            }
            Ok(Preparation::Ready(Box::new(PreparedConnectionTest {
                store,
                material,
                model_id: input.model_id,
            })))
        })
        .await
    }
}

impl PreparedConnectionTest {
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
    pub fn model_id(&self) -> Option<&str> {
        self.model_id.as_deref()
    }

    /// Both success and failure are durable connection-test observations.
    pub async fn complete(self, test: ConnectionTestProjection) -> Result<ConnectionTestRunResult> {
        let summary = summary(&test);
        validation::text(&summary.checked_at).map_err(ConfigError::Invalid)?;
        let material = self.material;
        self.store
            .transaction(TransactionMode::Immediate, move |tx| {
                use ConnectionEffectChangedDomain as Changed;
                let catalog = catalog::read(tx)?;
                let current = catalog
                    .connections
                    .into_iter()
                    .find(|row| row.connection_id == material.connection.connection_id);
                let mut changed = material.changed(tx, current.as_ref())?;
                if current.as_ref().is_some_and(|row| {
                    !same_test_basis(row, &material.connection)
                        || row.request_body_overlay != material.connection.request_body_overlay
                }) && !changed.contains(&Changed::Connection)
                {
                    changed.insert(0, Changed::Connection);
                }
                if !changed.is_empty() {
                    return Ok(ConnectionTestRunResult::Superseded { changed });
                }
                let mut row = current.expect("unchanged connection exists");
                row.revision = catalog::next_revision(row.revision)?;
                row.last_test = Some(summary);
                catalog::write_entry(tx, &row)?;
                let catalog_revision =
                    catalog::advance(tx, catalog.revision, catalog.default_target.as_ref())?;
                Ok(ConnectionTestRunResult::Committed {
                    catalog_revision,
                    connection: catalog::basis(&row),
                    test,
                })
            })
            .await
    }
}

fn summary(test: &ConnectionTestProjection) -> ConnectionTestSummary {
    match test {
        ConnectionTestProjection::Verified { checked_at, .. } => ConnectionTestSummary {
            status: ConnectionTestStatus::Verified,
            checked_at: checked_at.clone(),
            error_class: None,
        },
        ConnectionTestProjection::Failed {
            checked_at,
            error_class,
            ..
        } => ConnectionTestSummary {
            status: if *error_class == ConnectionEffectFailureClass::Auth {
                ConnectionTestStatus::NeedsReauth
            } else {
                ConnectionTestStatus::Error
            },
            checked_at: checked_at.clone(),
            error_class: Some(match error_class {
                ConnectionEffectFailureClass::Auth => ConnectionTestErrorClass::Auth,
                ConnectionEffectFailureClass::Timeout => ConnectionTestErrorClass::Timeout,
                ConnectionEffectFailureClass::ProviderUnavailable => {
                    ConnectionTestErrorClass::ProviderUnavailable
                }
                ConnectionEffectFailureClass::Network => ConnectionTestErrorClass::Network,
                ConnectionEffectFailureClass::InvalidResponse
                | ConnectionEffectFailureClass::Unknown => ConnectionTestErrorClass::Unknown,
            }),
        },
    }
}
