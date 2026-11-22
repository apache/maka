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
use crate::access::CapabilityOwnerIdentity;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalKind {
    LocalOwner,
    RemoteOwner,
    CapabilityProvider,
}

/// Authentication-derived identity. A saved identity is a comparison proof,
/// never a credential or permission to restore a disconnected publication.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub principal_kind: PrincipalKind,
    pub principal_id: String,
    pub client_instance_id: String,
    pub credential_bound_client_instance_id: Option<String>,
    pub capability_owner: Option<CapabilityOwnerIdentity>,
}

impl Identity {
    pub fn provider_id(&self) -> String {
        let value = serde_json::to_vec(&(
            "maka.client-capability-provider.v1",
            self.principal_kind,
            &self.principal_id,
            &self.client_instance_id,
        ))
        .expect("identity contains only strings");
        format!("cc_{}", URL_SAFE_NO_PAD.encode(Sha256::digest(value)))
    }

    pub fn trusted(&self) -> bool {
        self.principal_kind != PrincipalKind::RemoteOwner
    }
}
