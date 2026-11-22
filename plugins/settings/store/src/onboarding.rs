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

//! Discovery preparation and atomic connection publication.
mod commit;
use crate::{
    ConfigError, ConfigurationStore, Result, TransactionMode, catalog,
    effect_snapshot::EffectSnapshot, vault,
};
use maka_agent_facts::configuration::onboarding::*;
use maka_agent_facts::configuration::*;
use maka_agent_facts::oauth::Target;
use std::sync::Arc;
use uuid::Uuid;

pub enum OnboardingPreparation {
    Ready(Box<PreparedOnboarding>),
    Rejected(OnboardingRejection),
}

/// Store-bound discovery ticket. Authentication has its own durable receipts.
pub struct PreparedOnboarding {
    store: Arc<ConfigurationStore>,
    material: EffectSnapshot,
    original_revision: Option<u64>,
}

impl ConfigurationStore {
    pub async fn prepare_onboarding(
        self: &Arc<Self>,
        target: Target,
    ) -> Result<OnboardingPreparation> {
        target
            .validate_create_identity()
            .map_err(ConfigError::Invalid)?;
        let store = Arc::clone(self);
        self.transaction(TransactionMode::Deferred, move |tx| {
            use OnboardingPreparation as P;
            use OnboardingRejection as R;
            let catalog = catalog::read(tx)?;
            let (row, original_revision) = match target {
                Target::Existing {
                    expected,
                    configuration,
                } => {
                    let Some(mut row) = catalog
                        .connections
                        .iter()
                        .find(|r| r.connection_id == expected.connection_id)
                        .cloned()
                    else {
                        return Ok(P::Rejected(R::ConnectionNotFound));
                    };
                    let locator = CredentialLocator::Connection {
                        connection_id: row.connection_id.clone(),
                        kind: ConnectionCredentialKind::Provider,
                    };
                    if vault::connection_conflict(tx, &locator, Some(&expected))?.is_some() {
                        return Ok(P::Rejected(R::Superseded));
                    }
                    let revision = row.revision;
                    row.configuration = configuration;
                    (row, Some(revision))
                }
                Target::Create {
                    provider,
                    configuration,
                    slug,
                    name,
                } => {
                    if catalog.connections.iter().any(|r| r.slug == slug) {
                        return Ok(P::Rejected(R::SlugTaken));
                    }
                    (
                        ConnectionCatalogEntry {
                            connection_id: Uuid::new_v4().to_string(),
                            revision: 1,
                            slug,
                            name,
                            provider,
                            configuration,
                            enabled: true,
                            enabled_model_ids: vec![],
                            model_overrides: None,
                            request_body_overlay: None,
                            models: vec![],
                            model_source: None,
                            models_fetched_at: None,
                            last_test: None,
                        },
                        None,
                    )
                }
            };
            let material = EffectSnapshot::read(tx, row)?;
            Ok(P::Ready(Box::new(PreparedOnboarding {
                store,
                material,
                original_revision,
            })))
        })
        .await
    }
}

impl PreparedOnboarding {
    pub fn network_configuration(&self) -> &crate::network::NetworkConfiguration {
        &self.material.network.configuration
    }
    pub fn connection(&self) -> &ConnectionCatalogEntry {
        &self.material.connection
    }
    pub fn provider_credential(&self) -> Result<Option<crate::oauth::ProviderCredential>> {
        self.material.provider_credential(&self.store)
    }
    pub fn accept_credential(&mut self, resolved: crate::oauth::ProviderCredential) -> Result<()> {
        self.material.accept_credential(&self.store, resolved)
    }
    pub fn request_headers(&self) -> Option<&str> {
        self.material.request_headers()
    }
}
