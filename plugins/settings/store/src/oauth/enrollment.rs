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

mod commit;
mod receipt;

use super::*;
use crate::model_catalog;
use maka_agent_facts::oauth::ConnectionIdentity;
use maka_agent_facts::oauth::LoginStart;
use maka_agent_facts::oauth::Phase;
use maka_agent_facts::oauth::Target;
pub use receipt::LoginReceipt;

pub enum LoginPreparation {
    Ready(Box<PreparedLogin>),
    Finished(Box<LoginReceipt>),
    OutcomeUnknown(Box<LoginReceipt>),
    Rejected(LoginRejection),
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoginRejection {
    AttemptConflict,
    ConnectionNotFound,
    ConnectionChanged,
    CredentialChanged,
    SlugTaken,
}

#[derive(Debug, PartialEq)]
pub enum LoginCompletion {
    Committed(Box<LoginReceipt>),
    ConnectionChanged,
    CredentialChanged,
    AttemptConflict,
    SlugTaken,
}

/// Store-issued ticket. Persistence may be retried with the received replacement;
/// neither a lost reply nor an uncertain commit authorizes a second exchange.
#[derive(Clone)]
pub struct PreparedLogin {
    store: Arc<ConfigurationStore>,
    input: LoginStart,
    before: Option<ConnectionCatalogEntry>,
    after: ConnectionCatalogEntry,
    identity: ConnectionIdentity,
    credential: Option<CredentialVersionBasis>,
    network: NetworkConfiguration,
    catalog_revision: u64,
}

impl ConfigurationStore {
    pub async fn prepare_oauth_login(
        self: &Arc<Self>,
        input: LoginStart,
    ) -> Result<LoginPreparation> {
        input.validate().map_err(ConfigError::Invalid)?;
        let store = Arc::clone(self);
        self.transaction(TransactionMode::Deferred, move |tx| {
            {
                use LoginPreparation as P;
                use LoginRejection as R;
                if let Some(saved) = receipt::read(tx, &input.attempt_id)? {
                    return Ok(if saved.matches(&input) {
                        match saved.phase {
                            Phase::Exchanging => P::OutcomeUnknown(Box::new(saved)),
                            _ => P::Finished(Box::new(saved)),
                        }
                    } else {
                        P::Rejected(R::AttemptConflict)
                    });
                }
                let catalog = catalog::read(tx)?;
                let (before, mut after) = match &input.target {
                    Target::Create {
                        provider,
                        configuration,
                        slug,
                        name,
                    } => {
                        if catalog.connections.iter().any(|row| row.slug == *slug) {
                            return Ok(P::Rejected(R::SlugTaken));
                        }
                        (
                            None,
                            ConnectionCatalogEntry {
                                connection_id: uuid::Uuid::new_v4().to_string(),
                                revision: 1,
                                slug: slug.clone(),
                                name: name.clone(),
                                provider: provider.clone(),
                                configuration: configuration.clone(),
                                enabled: true,
                                enabled_model_ids: vec![],
                                model_overrides: None,
                                request_body_overlay: None,
                                models: vec![],
                                model_source: None,
                                models_fetched_at: None,
                                last_test: None,
                            },
                        )
                    }
                    Target::Existing {
                        expected,
                        configuration,
                    } => {
                        let Some(row) = catalog
                            .connections
                            .iter()
                            .find(|row| row.connection_id == expected.connection_id)
                            .cloned()
                        else {
                            return Ok(P::Rejected(R::ConnectionNotFound));
                        };
                        if vault::connection_conflict(tx, &locator(&row), Some(expected))?.is_some()
                        {
                            return Ok(P::Rejected(R::ConnectionChanged));
                        }
                        let before = row.clone();
                        let mut row = row;
                        if row.configuration != *configuration {
                            row.configuration = configuration.clone();
                            row.models.clear();
                            row.model_source = None;
                            row.models_fetched_at = None;
                            row.model_overrides = None;
                        }
                        (Some(before), row)
                    }
                };
                if before.is_some() {
                    // Every reauthentication invalidates verification, even if
                    // the provider returns the same secret bytes.
                    after.revision = catalog::next_revision(after.revision)?;
                    after.enabled = true;
                    after.last_test = None;
                }
                let identity = ConnectionIdentity {
                    connection_id: after.connection_id.clone(),
                    slug: after.slug.clone(),
                    provider: after.provider.clone(),
                };
                let credential = vault::status_basis(&vault::status(tx, &locator(&after))?);
                if credential != input.expected_credential {
                    return Ok(P::Rejected(R::CredentialChanged));
                }
                let network = NetworkSnapshot::read(tx)?.configuration;
                Ok(P::Ready(Box::new(PreparedLogin {
                    store,
                    input,
                    before,
                    after,
                    identity,
                    credential,
                    network,
                    catalog_revision: catalog.revision,
                })))
            }
        })
        .await
    }

    pub async fn oauth_login_receipt(&self, attempt_id: String) -> Result<Option<LoginReceipt>> {
        receipt::validate_attempt(&attempt_id)?;
        self.transaction(TransactionMode::Deferred, move |tx| {
            receipt::read(tx, &attempt_id)
        })
        .await
    }
}

impl PreparedLogin {
    /// Defaults are materialized by the pinned provider exactly once. Keep the
    /// caller's original request unchanged so retries still match its receipt.
    pub fn configure_creation(&mut self, configuration: serde_json::Value) -> Result<()> {
        if self.before.is_some() {
            return Err(ConfigError::Invalid(
                "existing connections do not acquire new defaults".into(),
            ));
        }
        validation::provider_configuration(&configuration).map_err(ConfigError::Invalid)?;
        self.after.configuration = configuration;
        Ok(())
    }

    /// Publish discovered facts with login, preserving existing user choices.
    pub fn discovered_models(&mut self, models: Vec<ModelInfo>, now: u64) -> Result<()> {
        validation::revision(now, false).map_err(ConfigError::Invalid)?;
        if models.is_empty() {
            return Err(ConfigError::Invalid(
                "discovery requires at least one model".into(),
            ));
        }
        for model in &models {
            model.validate().map_err(ConfigError::Invalid)?;
        }
        let mut after = self.after.clone();
        after.models = models;
        after.model_source = Some(ModelDiscoverySource::Fetched);
        after.models_fetched_at = Some(now);
        if self.before.is_none() {
            after.enabled_model_ids = model_catalog::resolve(&after, None)?
                .into_iter()
                .filter(|model| model.can_use_as_chat_default)
                .map(|model| model.id)
                .collect();
        } else if self
            .before
            .as_ref()
            .is_some_and(|before| before.revision == after.revision)
        {
            after.revision = catalog::next_revision(after.revision)?;
        }
        self.after = after;
        Ok(())
    }

    pub fn identity(&self) -> &ConnectionIdentity {
        &self.identity
    }
    pub fn connection(&self) -> &ConnectionCatalogEntry {
        &self.after
    }
    pub fn network_configuration(&self) -> &NetworkConfiguration {
        &self.network
    }
}

fn locator(row: &ConnectionCatalogEntry) -> CredentialLocator {
    CredentialLocator::Connection {
        connection_id: row.connection_id.clone(),
        kind: ConnectionCredentialKind::Provider,
    }
}
