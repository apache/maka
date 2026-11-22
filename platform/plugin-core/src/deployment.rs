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

//! Durable deployment source identities. These data references grant no access.
pub mod management;
use crate::{composition::Input, contract::Export, plan::RemoteCapability};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentRef {
    pub state_domain: String,
    pub deployment: Uuid,
    pub revision: u64,
}
impl DeploymentRef {
    pub fn validate(&self) -> Result<(), String> {
        if self.state_domain.len() != 64
            || !self
                .state_domain
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || self.deployment.is_nil()
            || !(1..=9_007_199_254_740_991).contains(&self.revision)
        {
            return Err("invalid deployment source reference".into());
        }
        Ok(())
    }
}

/// A static compatibility observation, never a remote registration or grant.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RemoteObservation {
    pub capability: RemoteCapability,
    pub declaration: Export,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deployment {
    pub reference: DeploymentRef,
    pub input: Input,
    pub remote_exports: Vec<RemoteObservation>,
}
