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

//! Private credential authority, independent of catalog and execution facts.
mod creation;
mod lifecycle;
mod record;
use crate::{ConfigurationStore, Result, TransactionMode};
use record::load;
pub use record::{AccessChange, AccessCreateMode, AccessCredential, CredentialState};

impl ConfigurationStore {
    pub async fn active_access_credentials(&self) -> Result<Vec<AccessCredential>> {
        self.transaction(TransactionMode::Deferred, |tx| {
            {
                Ok(load(tx)?
                    .into_iter()
                    .filter(|c| matches!(c.state, CredentialState::Active { .. }))
                    .collect())
            }
        })
        .await
    }
    pub async fn authenticate_access_credential(
        &self,
        hash: String,
        now_ms: u64,
    ) -> Result<Option<AccessCredential>> {
        self.transaction(TransactionMode::Deferred, move |tx| {
            {
                Ok(load(tx)?.into_iter().find(|c| {
                    c.credential_hash == hash
                        && match c.state {
                            CredentialState::Active { .. } => true,
                            CredentialState::Pending { expires_at, .. } => expires_at > now_ms,
                            CredentialState::Revoked { .. } => false,
                        }
                }))
            }
        })
        .await
    }
    pub async fn has_active_bound_client_identity(
        &self,
        principal: String,
        client: String,
    ) -> Result<bool> {
        Ok(self.active_access_credentials().await?.iter().any(|c| {
            c.principal_kind == maka_agent_facts::access::ManagedPrincipalKind::RemoteOwner
                && c.principal_id == principal
                && c.client_instance_id() == Some(client.as_str())
        }))
    }
    pub async fn next_access_credential_expiry(&self) -> Result<Option<u64>> {
        self.transaction(TransactionMode::Deferred, |tx| {
            {
                Ok(load(tx)?
                    .iter()
                    .filter_map(|c| match c.state {
                        CredentialState::Pending { expires_at, .. } => Some(expires_at),
                        _ => None,
                    })
                    .min())
            }
        })
        .await
    }
}
