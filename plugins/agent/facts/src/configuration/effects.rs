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

use super::{ConnectionVersionBasis, ModelDiscoverySource};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionEffectRejectionReason {
    ConnectionNotFound,
    ConnectionDisabled,
    ProviderActionUnavailable,
    CredentialNotConfigured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionEffectChangedDomain {
    Connection,
    Credential,
    NetworkProxy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionEffectFailureClass {
    Auth,
    Timeout,
    ProviderUnavailable,
    Network,
    InvalidResponse,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionModelFetchInput {
    pub connection_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConnectionModelFetchResult {
    Committed {
        catalog_revision: u64,
        connection: ConnectionVersionBasis,
        model_count: u64,
        source: ModelDiscoverySource,
        fetched_at: u64,
    },
    Rejected {
        reason: ConnectionEffectRejectionReason,
    },
    Superseded {
        changed: Vec<ConnectionEffectChangedDomain>,
    },
    Failed {
        error_class: ConnectionEffectFailureClass,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionTestRunInput {
    pub connection_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConnectionTestProjection {
    Verified {
        checked_at: String,
        model_id: String,
        latency_ms: u64,
    },
    Failed {
        checked_at: String,
        #[serde(deserialize_with = "Option::deserialize")]
        model_id: Option<String>,
        #[serde(deserialize_with = "Option::deserialize")]
        latency_ms: Option<u64>,
        #[serde(deserialize_with = "Option::deserialize")]
        status_code: Option<u64>,
        error_class: ConnectionEffectFailureClass,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConnectionTestRunResult {
    Committed {
        catalog_revision: u64,
        connection: ConnectionVersionBasis,
        test: ConnectionTestProjection,
    },
    Rejected {
        reason: ConnectionEffectRejectionReason,
    },
    Superseded {
        changed: Vec<ConnectionEffectChangedDomain>,
    },
}
