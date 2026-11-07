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
    network::{NetworkConfiguration, NetworkSnapshot},
    vault,
};
use maka_agent_facts::configuration::*;
use maka_agent_facts::provider::Credential;
use std::sync::Arc;

pub mod enrollment;

/// An immutable, root-bound provider generation. Secret material never enters a
/// public projection. Clones share ownership, not an independent credential cache.
#[derive(Clone)]
pub struct ProviderCredential {
    pub(crate) store: Arc<ConfigurationStore>,
    pub(crate) target: ConnectionCredentialTarget,
    pub(crate) basis: CredentialVersionBasis,
    pub(crate) credential: Arc<Credential>,
    pub(crate) network: NetworkConfiguration,
}

impl ConfigurationStore {
    /// Pin credential identity, raw material and refresh routing in one SQL
    /// snapshot. None means the requested execution binding is no longer usable.
    pub async fn provider_credential(
        self: &Arc<Self>,
        target: ConnectionCredentialTarget,
    ) -> Result<Option<ProviderCredential>> {
        validation::credential_target(&target).map_err(ConfigError::Invalid)?;
        let store = Arc::clone(self);
        self.transaction(TransactionMode::Deferred, move |tx| {
            let locator = CredentialLocator::Connection {
                connection_id: target.connection_id.clone(),
                kind: ConnectionCredentialKind::Provider,
            };
            if vault::connection_conflict(tx, &locator, Some(&target))?.is_some()
                || catalog::find(tx, &target.connection_id)?.is_none_or(|row| !row.enabled)
            {
                return Ok(None);
            }
            let Some(basis) = vault::status_basis(&vault::status(tx, &locator)?) else {
                return Ok(None);
            };
            let secret: String = tx
                .prepare_cached("SELECT secret FROM credentials WHERE locator = ?")?
                .query_row(rusqlite::params![serde_json::to_string(&locator)?], |row| {
                    row.get(0)
                })?;
            Ok(Some(ProviderCredential {
                store,
                target,
                basis,
                credential: Arc::new(decode(&secret)?),
                network: NetworkSnapshot::read(tx)?.configuration,
            }))
        })
        .await
    }
}

impl ProviderCredential {
    /// Durable single-flight boundary before sending a possibly single-use grant.
    /// False means superseded or already claimed; neither permits another exchange.
    pub async fn claim_refresh(&self) -> Result<bool> {
        let expected = self.basis.clone();
        let target = self.target.clone();
        self.store
            .transaction(TransactionMode::Immediate, move |tx| {
                let Some(row) = catalog::find(tx, &target.connection_id)? else {
                    return Ok(false);
                };
                if row.provider != target.provider
                    || row.slug != target.slug
                    || vault::status_basis(&vault::status(tx, &expected.locator)?).as_ref()
                        != Some(&expected)
                {
                    return Ok(false);
                }
                Ok(tx.execute(
                    "INSERT INTO credential_refresh_claims VALUES (?, ?) ON CONFLICT DO NOTHING",
                    rusqlite::params![&expected.credential_id, expected.revision as i64],
                )? == 1)
            })
            .await
    }

    /// Reconcile this credential identity without treating metadata edits or a
    /// disabled connection as revocation of an already-spent refresh grant.
    /// A replacement login, logout or removed connection returns None.
    pub async fn current_generation(&self) -> Result<Option<Self>> {
        let snapshot = self.clone();
        self.store
            .transaction(TransactionMode::Deferred, move |tx| {
                let Some(row) = catalog::find(tx, &snapshot.target.connection_id)? else {
                    return Ok(None);
                };
                let Some(basis) = vault::status_basis(&vault::status(tx, &snapshot.basis.locator)?)
                else {
                    return Ok(None);
                };
                if row.provider != snapshot.target.provider
                    || row.slug != snapshot.target.slug
                    || basis.credential_id != snapshot.basis.credential_id
                {
                    return Ok(None);
                }
                let secret: String = tx
                    .prepare_cached("SELECT secret FROM credentials WHERE locator = ?")?
                    .query_row(
                        rusqlite::params![serde_json::to_string(&basis.locator)?],
                        |row| row.get(0),
                    )?;
                Ok(Some(Self {
                    basis,
                    credential: Arc::new(decode(&secret)?),
                    ..snapshot
                }))
            })
            .await
    }

    pub fn target(&self) -> &ConnectionCredentialTarget {
        &self.target
    }

    pub fn basis(&self) -> &CredentialVersionBasis {
        &self.basis
    }

    pub fn credential(&self) -> &Credential {
        &self.credential
    }

    pub fn network_configuration(&self) -> &NetworkConfiguration {
        &self.network
    }

    /// Commit only against this connection identity and credential generation.
    /// Metadata changes and disabling execution do not revoke a spent grant;
    /// logout, re-login and connection removal supersede its generation.
    /// A caller must retain a received replacement until this settles: cancellation
    /// of its waiter does not undo an accepted database job or a spent refresh grant.
    ///
    /// None is supersession (including logout); it never creates a credential.
    /// CommitUnknown remains unknown. Re-read the canonical snapshot and compare
    /// credential ID, next revision and exact replacement before using the result;
    /// do not refresh again with the old grant to resolve a persistence ambiguity.
    pub async fn commit_refresh(
        &self,
        credential: Credential,
        now: u64,
    ) -> Result<Option<CredentialVersionBasis>> {
        credential.validate().map_err(ConfigError::Invalid)?;
        let secret = serde_json::to_string(&credential)?;
        validation::revision(now, false).map_err(ConfigError::Invalid)?;
        let expected = self.basis.clone();
        let target = self.target.clone();
        self.store
            .transaction(TransactionMode::Immediate, move |tx| {
                {
                    let Some(row) = catalog::find(tx, &target.connection_id)? else {
                        return Ok(None);
                    };
                    if row.provider != target.provider
                        || row.slug != target.slug
                        || vault::status_basis(&vault::status(tx, &expected.locator)?)
                            .as_ref()
                            != Some(&expected)
                    {
                        return Ok(None);
                    }
                    // Provider token rotation does not change the connection's user
                    // configuration or invalidate its verification, unlike re-login.
                    vault::write_secret(tx, &expected.locator, &secret, now)?;
                    tx.execute("DELETE FROM credential_refresh_claims WHERE credential_id = ? AND revision = ?", rusqlite::params![&expected.credential_id, expected.revision as i64])?;
                    vault::advance(tx)?;
                    Ok(vault::status_basis(
                        &vault::status(tx, &expected.locator)?,
                    ))
                }
            })
            .await
    }
}

pub(crate) fn decode(secret: &str) -> Result<Credential> {
    let credential: Credential = serde_json::from_str(secret)?;
    credential.validate().map_err(ConfigError::Invalid)?;
    Ok(credential)
}
