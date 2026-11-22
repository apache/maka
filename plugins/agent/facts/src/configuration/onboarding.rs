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

use super::{ConnectionEffectFailureClass, ConnectionVersionBasis, ModelInfo};
use serde::{Deserialize, Serialize};

/// Authentication is settled through the login receipt before discovery.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardingInput {
    pub target: crate::oauth::Target,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingRejection {
    ProviderUnsupported,
    ConnectionNotFound,
    CredentialNotConfigured,
    BaseUrlNotConfigured,
    SlugTaken,
    ModelUnavailable,
    Superseded,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OnboardingVerifyResult {
    Verified {
        models: Vec<ModelInfo>,
    },
    Rejected {
        reason: OnboardingRejection,
    },
    Failed {
        error_class: ConnectionEffectFailureClass,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardedConnection {
    pub connection_id: String,
    pub revision: u64,
    pub slug: String,
    pub provider: crate::provider::Identity,
}
impl OnboardedConnection {
    pub fn basis(&self) -> ConnectionVersionBasis {
        ConnectionVersionBasis {
            connection_id: self.connection_id.clone(),
            revision: self.revision,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OnboardingSaveResult {
    Saved {
        connection: OnboardedConnection,
    },
    Rejected {
        reason: OnboardingRejection,
    },
    Failed {
        error_class: ConnectionEffectFailureClass,
    },
}
