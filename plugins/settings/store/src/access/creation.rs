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

use super::{AccessChange, AccessCreateMode, AccessCredential, CredentialState, record::*};
use crate::{ConfigurationStore, Result, TransactionMode};
use maka_agent_facts::access::CapabilityOwnerIdentity;
use maka_agent_facts::access::ManagedPrincipalKind;

impl ConfigurationStore {
    pub async fn create_access_credential(
        &self,
        mut credential: AccessCredential,
        mode: AccessCreateMode,
        owner_credential_id: Option<String>,
    ) -> Result<AccessChange<AccessCredential>> {
        validate(&credential)?;
        if credential.capability_owner.is_some() {
            return Err(invalid(
                "capability owner must be resolved from an active credential",
            ));
        }
        if !matches!(
            (&mode, &credential.state),
            (AccessCreateMode::Prepare, CredentialState::Pending { .. })
                | (
                    AccessCreateMode::Issue | AccessCreateMode::Replace,
                    CredentialState::Active {
                        client_instance_id: None
                    }
                )
        ) {
            return Err(invalid("credential state does not match creation mode"));
        }
        self.transaction(TransactionMode::Immediate, move |tx| {
            let mut records = load(tx)?;
            if records.iter().any(|c| {
                c.credential_id == credential.credential_id
                    || c.credential_hash == credential.credential_hash
            }) {
                return Err(invalid("duplicate access credential identity or hash"));
            }
            if let Some(id) = owner_credential_id {
                let owner = records
                    .iter()
                    .find(|c| {
                        c.credential_id == id
                            && c.principal_kind == ManagedPrincipalKind::RemoteOwner
                            && c.client_instance_id().is_some()
                    })
                    .ok_or_else(|| {
                        invalid("capability owner must be an active bound remote owner")
                    })?;
                credential.capability_owner = Some(CapabilityOwnerIdentity {
                    principal_id: owner.principal_id.clone(),
                    client_instance_id: owner.client_instance_id().unwrap().into(),
                });
            }
            validate(&credential)?;
            let mut revoked = Vec::new();
            records.retain(|c| {
                let remove = same_principal(c, &credential)
                    && match mode {
                        AccessCreateMode::Issue => false,
                        AccessCreateMode::Replace => {
                            !matches!(c.state, CredentialState::Revoked { .. })
                        }
                        AccessCreateMode::Prepare => {
                            matches!(c.state, CredentialState::Pending { .. })
                        }
                    };
                if remove {
                    revoked.push(c.credential_id.clone());
                }
                !remove
            });
            records.push(credential.clone());
            save(tx, &records)?;
            Ok(AccessChange {
                value: credential,
                revoked,
            })
        })
        .await
    }
}
