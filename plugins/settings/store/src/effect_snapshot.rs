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
    ConfigError, ConfigurationStore, Result,
    network::NetworkSnapshot,
    oauth::{self, ProviderCredential},
    vault,
};
use maka_agent_facts::configuration::*;
use rusqlite::{Connection, OptionalExtension};
use std::sync::Arc;

/// Private execution material, never a catalog or plugin projection. All fields
/// were observed in one transaction; absent credentials are valid for no-auth providers.
pub struct ConnectionObservation {
    pub connection: ConnectionCatalogEntry,
    pub credential: Option<ProviderCredential>,
    pub request_headers: std::collections::BTreeMap<String, String>,
    pub network: crate::network::NetworkConfiguration,
}

impl ConfigurationStore {
    pub async fn observe_model(
        self: &Arc<Self>,
        target: maka_agent_facts::execution::ModelBinding,
    ) -> Result<Option<ConnectionObservation>> {
        let id = target.connection_id.clone();
        self.observe_model_if(id, move |row| {
            row.slug == target.connection_slug && row.enabled_model_ids.contains(&target.model)
        })
        .await
    }

    /// Resolve the selected identity and private execution material in one snapshot.
    pub async fn observe_selected_model(
        self: &Arc<Self>,
        target: ModelSelection,
    ) -> Result<Option<ConnectionObservation>> {
        validation::entity_id(&target.connection_id).map_err(ConfigError::Invalid)?;
        validation::text(&target.model_id).map_err(ConfigError::Invalid)?;
        let id = target.connection_id.clone();
        self.observe_model_if(id, move |row| {
            row.enabled_model_ids.contains(&target.model_id)
        })
        .await
    }

    async fn observe_model_if(
        self: &Arc<Self>,
        id: String,
        selected: impl FnOnce(&ConnectionCatalogEntry) -> bool + Send + 'static,
    ) -> Result<Option<ConnectionObservation>> {
        let store = self.clone();
        self.transaction(crate::TransactionMode::Deferred, move |tx| {
            let Some(connection) = crate::catalog::find(tx, &id)? else {
                return Ok(None);
            };
            if !connection.enabled || !selected(&connection) {
                return Ok(None);
            }
            let material = EffectSnapshot::read(tx, connection)?;
            Ok(Some(ConnectionObservation {
                credential: material.provider_credential(&store)?,
                request_headers: material
                    .request_headers()
                    .map(validation::parse_headers)
                    .transpose()
                    .map_err(ConfigError::Invalid)?
                    .unwrap_or_default(),
                connection: material.connection,
                network: material.network.configuration,
            }))
        })
        .await
    }
}

/// A single SQL snapshot of connection, credential and proxy authority.
pub(crate) struct EffectSnapshot {
    pub connection: ConnectionCatalogEntry,
    pub network: NetworkSnapshot,
    credential: SecretSnapshot,
    headers: SecretSnapshot,
}

struct SecretSnapshot {
    locator: CredentialLocator,
    basis: Option<CredentialVersionBasis>,
    secret: Option<String>,
}

impl EffectSnapshot {
    pub fn read(tx: &Connection, connection: ConnectionCatalogEntry) -> Result<Self> {
        let id = &connection.connection_id;
        let credential = secret(tx, id, ConnectionCredentialKind::Provider)?;
        // Reject malformed persisted envelopes before handing out a ticket.
        if let Some(secret) = &credential.secret {
            oauth::decode(secret)?;
        }
        let headers = secret(tx, id, ConnectionCredentialKind::RequestHeaders)?;
        Ok(Self {
            network: NetworkSnapshot::read(tx)?,
            connection,
            credential,
            headers,
        })
    }

    pub fn provider_credential(
        &self,
        store: &Arc<ConfigurationStore>,
    ) -> Result<Option<ProviderCredential>> {
        let Some(basis) = self.credential.basis.clone() else {
            return Ok(None);
        };
        let secret = self
            .credential
            .secret
            .as_deref()
            .ok_or_else(|| ConfigError::Invalid("credential envelope is missing".into()))?;
        Ok(Some(ProviderCredential {
            store: store.clone(),
            basis,
            credential: Arc::new(oauth::decode(secret)?),
            network: self.network.configuration.clone(),
            target: ConnectionCredentialTarget {
                connection_id: self.connection.connection_id.clone(),
                revision: self.connection.revision,
                provider: self.connection.provider.clone(),
                slug: self.connection.slug.clone(),
                configuration: self.connection.configuration.clone(),
            },
        }))
    }

    /// Advance only to the generation actually used by the request, never to a
    /// replacement login or a credential issued by another root/provider.
    pub fn accept_credential(
        &mut self,
        store: &Arc<ConfigurationStore>,
        resolved: ProviderCredential,
    ) -> Result<()> {
        let before = self
            .provider_credential(store)?
            .ok_or_else(|| ConfigError::Invalid("effect has no provider credential".into()))?;
        if !Arc::ptr_eq(&resolved.store, store)
            || resolved.basis.locator != before.basis.locator
            || resolved.basis.credential_id != before.basis.credential_id
            || resolved.basis.revision < before.basis.revision
            || resolved.target.provider != before.target.provider
            || resolved.target.slug != before.target.slug
            || resolved.target.configuration != before.target.configuration
        {
            return Err(ConfigError::Invalid(
                "effect changed credential identity".into(),
            ));
        }
        self.credential.basis = Some(resolved.basis);
        self.credential.secret = Some(serde_json::to_string(&resolved.credential)?);
        Ok(())
    }

    pub fn request_headers(&self) -> Option<&str> {
        self.headers.secret.as_deref()
    }

    pub fn changed(
        &self,
        tx: &Connection,
        current: Option<&ConnectionCatalogEntry>,
    ) -> Result<Vec<ConnectionEffectChangedDomain>> {
        use ConnectionEffectChangedDomain as Changed;
        let mut changed = Vec::new();
        if current.is_none_or(|row| {
            !row.enabled
                || row.provider != self.connection.provider
                || row.configuration != self.connection.configuration
                || row.enabled_model_ids != self.connection.enabled_model_ids
        }) {
            changed.push(Changed::Connection);
        }
        if self.credentials_changed(tx)? {
            changed.push(Changed::Credential);
        }
        if self.network_changed(tx)? {
            changed.push(Changed::NetworkProxy);
        }
        Ok(changed)
    }

    pub fn network_changed(&self, tx: &Connection) -> Result<bool> {
        self.network.changed(tx)
    }

    pub fn credentials_changed(&self, tx: &Connection) -> Result<bool> {
        for snapshot in [&self.credential, &self.headers] {
            let current = vault::status(tx, &snapshot.locator)?;
            if vault::status_basis(&current) != snapshot.basis {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn secret(tx: &Connection, id: &str, kind: ConnectionCredentialKind) -> Result<SecretSnapshot> {
    let locator = CredentialLocator::Connection {
        connection_id: id.into(),
        kind,
    };
    let status = vault::status(tx, &locator)?;
    let secret = tx
        .prepare_cached("SELECT secret FROM credentials WHERE locator = ?")?
        .query_row(rusqlite::params![serde_json::to_string(&locator)?], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(SecretSnapshot {
        locator,
        basis: vault::status_basis(&status),
        secret,
    })
}

pub(crate) fn same_test_basis(
    before: &ConnectionCatalogEntry,
    after: &ConnectionCatalogEntry,
) -> bool {
    before.provider == after.provider
        && before.configuration == after.configuration
        && before.enabled_model_ids == after.enabled_model_ids
        && before.model_source == after.model_source
        && before.models == after.models
        && before.model_overrides == after.model_overrides
        && before.request_body_overlay == after.request_body_overlay
}
