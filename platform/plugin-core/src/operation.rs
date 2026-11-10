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

//! Durable operation observations, never execution or recovery grants.
use crate::{
    composition::InstanceId,
    contract::{Contract, Interface, Method, MethodMode, Transport},
    deployment::DeploymentRef,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryProtocol {
    JournalV1,
}

/// Contract identity for a journal lookup. The original request retains the
/// complete contract; a receipt carries only its digest.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryContract {
    pub name: String,
    pub version: u32,
    pub transport: Transport,
    pub digest: String,
}

impl RecoveryContract {
    /// Called after validating the original service contract at admission.
    pub fn for_method(contract: &Contract, method: &str) -> Result<Self, crate::Error> {
        use sha2::{Digest, Sha256};
        let Interface::Service { methods } = &contract.interface else {
            return Err(crate::Error::Contract(
                "operation requires a service contract".into(),
            ));
        };
        methods
            .get(method)
            .filter(|m| m.mode == MethodMode::Mutation)
            .ok_or_else(|| {
                crate::Error::Contract("operation requires a declared mutation method".into())
            })?;
        fn digest(value: &impl Serialize) -> Result<String, crate::Error> {
            let mut value =
                serde_json::to_value(value).map_err(|e| crate::Error::Contract(e.to_string()))?;
            value.sort_all_objects();
            let bytes =
                serde_json::to_vec(&value).map_err(|e| crate::Error::Contract(e.to_string()))?;
            Ok(format!("sha256-{}", hex::encode(Sha256::digest(bytes))))
        }
        Ok(Self {
            name: contract.name.clone(),
            version: contract.version,
            transport: contract.transport,
            digest: digest(contract)?,
        })
    }

    pub fn matches(&self, current: &Contract, method: &str) -> Result<bool, crate::Error> {
        Ok(self == &Self::for_method(current, method)?)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRef {
    pub source: DeploymentRef,
    pub namespace: InstanceId,
    pub export: String,
    pub method: String,
    pub operation: Uuid,
    pub fingerprint: String,
    pub contract: RecoveryContract,
    pub recovery: RecoveryProtocol,
}
impl RecoveryRef {
    pub fn validate(&self) -> Result<(), crate::Error> {
        self.source.validate().map_err(crate::Error::Composition)?;
        self.namespace.validate()?;
        if self.operation.is_nil() {
            return Err(crate::Error::Composition(
                "invalid operation identity".into(),
            ));
        }
        crate::name(&self.export)?;
        crate::name(&self.method)?;
        if !crate::content_hash(&self.fingerprint) {
            return Err(crate::Error::Composition(
                "invalid operation fingerprint".into(),
            ));
        }
        crate::name(&self.contract.name)?;
        if self.contract.version == 0 || !crate::content_hash(&self.contract.digest) {
            return Err(crate::Error::Contract(
                "invalid operation contract digest".into(),
            ));
        }
        Ok(())
    }
}

/// An observation of a provider fence, not a capability to create that fence.
/// Only the original provider may establish this proof before handler start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NotExecutedProof {
    ProviderPreventedBeforeStart,
}

/// A definite handler return. Failure does not imply absence of side effects.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationResult {
    Success { value: Value },
    Failure { diagnostic: String },
}

/// Unresolved and Unknown may advance to authoritative original evidence.
/// Returned and NotExecuted are immutable; handler errors are Returned too.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationOutcome {
    Unresolved,
    Returned { result: OperationResult },
    NotExecuted { proof: NotExecutedProof },
    Unknown { diagnostic: String },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationCleanup {
    Unconfirmed,
    Confirmed,
    Failed { diagnostic: String },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperationObservation {
    pub reference: RecoveryRef,
    pub outcome: OperationOutcome,
    pub cleanup: OperationCleanup,
}

/// A caller's receipt observation, never an execution grant. Unavailable makes
/// no claim about the journal's contents or physical cleanup.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Receipt {
    /// An authorized lookup found no row at the exact original reference.
    /// This is not proof of non-execution: the original request may arrive later.
    NotRecorded,
    Recorded {
        outcome: OperationOutcome,
        cleanup: OperationCleanup,
    },
    Unavailable {
        diagnostic: String,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperationReply {
    pub reference: RecoveryRef,
    pub receipt: Receipt,
}

/// A portable observation of the exact original journal, never a replay grant.
/// Products bind a reader independently of the current business service.
pub fn receipt_reader_contract() -> Contract {
    Contract {
        name: "maka.operations.ReceiptReader".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: std::collections::BTreeMap::from([(
                "read".into(),
                Method {
                    progress: None,
                    mode: MethodMode::Query,
                    input: serde_json::to_value(schemars::schema_for!(RecoveryRef))
                        .expect("original receipt request schema")
                        .into(),
                    output: serde_json::to_value(schemars::schema_for!(OperationReply))
                        .expect("original receipt reply schema")
                        .into(),
                    resources: std::collections::BTreeMap::new(),
                },
            )]),
        },
    }
}
