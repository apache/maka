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

use super::{AccessChange, CredentialState, record::*};
use crate::{ConfigurationStore, Result, TransactionMode};
use maka_agent_facts::access::AccessCredentialFinalizeResult;

impl ConfigurationStore {
    pub async fn revoke_access_credential(
        &self,
        id: String,
        revoked_at: String,
    ) -> Result<AccessChange<bool>> {
        self.transaction(TransactionMode::Immediate, move |tx| {
            let mut records = load(tx)?;
            let Some(current) = records
                .iter()
                .find(|c| {
                    c.credential_id == id && !matches!(c.state, CredentialState::Revoked { .. })
                })
                .cloned()
            else {
                return Ok(AccessChange {
                    value: false,
                    revoked: vec![],
                });
            };
            let active = matches!(current.state, CredentialState::Active { .. });
            let mut revoked = vec![id.clone()];
            records.retain_mut(|c| {
                if c.credential_id == id {
                    if active {
                        c.state = CredentialState::Revoked {
                            revoked_at: revoked_at.clone(),
                        };
                        return true;
                    }
                    return false;
                }
                if active
                    && same_principal(c, &current)
                    && matches!(c.state, CredentialState::Pending { .. })
                {
                    revoked.push(c.credential_id.clone());
                    return false;
                }
                true
            });
            save(tx, &records)?;
            Ok(AccessChange {
                value: true,
                revoked,
            })
        })
        .await
    }
    pub async fn finalize_access_credential(
        &self,
        id: String,
        client: String,
        connection_bound: Option<String>,
        now_ms: u64,
    ) -> Result<AccessChange<AccessCredentialFinalizeResult>> {
        if !valid_client(&client) {
            return Err(invalid("invalid client instance identity"));
        }
        self.transaction(TransactionMode::Immediate, move |tx| {
            let mut records = load(tx)?;
            let current = records
                .iter()
                .find(|c| c.credential_id == id)
                .cloned()
                .ok_or_else(|| invalid("credential no longer active"))?;
            let bind = match &current.state {
                CredentialState::Revoked { .. } => {
                    return Err(invalid("credential no longer active"));
                }
                CredentialState::Active { client_instance_id } => {
                    if client_instance_id
                        .as_ref()
                        .is_some_and(|bound| bound != &client)
                    {
                        return Err(invalid("pairing candidate claimed by another client"));
                    }
                    return Ok(AccessChange {
                        value: AccessCredentialFinalizeResult {
                            reconnect_required: client_instance_id.is_some()
                                && connection_bound.as_ref() != Some(&client),
                        },
                        revoked: vec![],
                    });
                }
                CredentialState::Pending {
                    expires_at,
                    bind_client_instance,
                } => {
                    if *expires_at <= now_ms {
                        return Err(invalid("pairing candidate expired"));
                    }
                    *bind_client_instance
                }
            };
            let mut revoked = Vec::new();
            records.retain_mut(|c| {
                if c.credential_id == id {
                    c.state = CredentialState::Active {
                        client_instance_id: bind.then(|| client.clone()),
                    };
                    return true;
                }
                if same_principal(c, &current) && matches!(c.state, CredentialState::Active { .. })
                {
                    revoked.push(c.credential_id.clone());
                    return false;
                }
                true
            });
            save(tx, &records)?;
            Ok(AccessChange {
                value: AccessCredentialFinalizeResult {
                    reconnect_required: bind,
                },
                revoked,
            })
        })
        .await
    }
    pub async fn expire_access_credentials(&self, now_ms: u64) -> Result<Vec<String>> {
        self.transaction(TransactionMode::Immediate, move |tx| {
            let mut records = load(tx)?;
            let mut revoked = Vec::new();
            records.retain(|c| {
                let expired = matches!(c.state, CredentialState::Pending { expires_at, .. } if expires_at <= now_ms);
                if expired { revoked.push(c.credential_id.clone()); }
                !expired
            });
            if !revoked.is_empty() { save(tx, &records)?; }
            Ok(revoked)
        }).await
    }
}
