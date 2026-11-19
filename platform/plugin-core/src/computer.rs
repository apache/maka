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

//! Physical computer resource observations, never live grants.
use serde::{Deserialize, Serialize};

/// Backend-validated source of a browser lease observation.
/// The discriminator and routing string are neither ownership nor permission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserLeaseSubject {
    #[serde(rename_all = "camelCase")]
    PhysicalClaim { claim_id: String },
    #[serde(rename_all = "camelCase")]
    FixedSession { scope_id: String },
}
impl BrowserLeaseSubject {
    /// Return an observed routing identity, never a sealed proof or grant.
    pub fn routing_id(&self) -> &str {
        match self {
            Self::PhysicalClaim { claim_id } => claim_id,
            Self::FixedSession { scope_id } => scope_id,
        }
    }
}
