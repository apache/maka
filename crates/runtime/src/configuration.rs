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
//! Public configuration facts. Secret-bearing input is isolated in vault.
mod catalog_wire;
mod credential_validation;
mod effects;
pub mod headers;
pub mod onboarding;
pub use catalog_wire::*;
pub use effects::*;
mod model_catalog;
mod model_info;
mod model_override;
pub use model_catalog::ModelCatalogEntry;
pub use model_info::{ModelCapabilities, ModelInfo};
mod model_validation;
pub mod policy;
pub use model_override::{
    ApiProtocol, ModelModalities, ModelModality, ModelOverride, ModelOverrideCapabilities,
    RelayServiceTier,
};
pub mod validation;
mod vault;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
pub use vault::*;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Patch<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}
impl<T> Patch<T> {
    pub fn is_keep(&self) -> bool {
        matches!(self, Self::Keep)
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(d)? {
            None => Self::Clear,
            Some(v) => Self::Set(v),
        })
    }
}
impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Set(v) => v.serialize(s),
            _ => s.serialize_none(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionVersionBasis {
    pub connection_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionTarget {
    pub connection_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCredentialTarget {
    pub connection_id: String,
    pub revision: u64,
    pub slug: String,
    pub provider: crate::provider::Identity,
    pub configuration: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionTestSummary {
    pub status: ConnectionTestStatus,
    pub checked_at: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub error_class: Option<ConnectionTestErrorClass>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionTestStatus {
    Verified,
    NeedsReauth,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionTestErrorClass {
    Auth,
    Timeout,
    ProviderUnavailable,
    Network,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelDiscoverySource {
    Fetched,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCatalogEntryDraft {
    pub slug: String,
    pub name: String,
    pub provider: crate::provider::Identity,
    pub configuration: Value,
    pub enabled: bool,
    pub enabled_model_ids: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub model_overrides: Option<BTreeMap<String, ModelOverride>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub request_body_overlay: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCatalogEntryUpdate {
    pub name: String,
    pub configuration: Value,
    pub enabled: bool,
    pub enabled_model_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Patch::is_keep")]
    pub model_overrides: Patch<BTreeMap<String, ModelOverride>>,
    #[serde(default, skip_serializing_if = "Patch::is_keep")]
    pub request_body_overlay: Patch<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCatalogEntry {
    pub connection_id: String,
    pub revision: u64,
    pub slug: String,
    pub name: String,
    pub provider: crate::provider::Identity,
    pub configuration: Value,
    pub enabled: bool,
    pub enabled_model_ids: Vec<String>,
    pub models: Vec<ModelInfo>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub model_overrides: Option<BTreeMap<String, ModelOverride>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub request_body_overlay: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub model_source: Option<ModelDiscoverySource>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub models_fetched_at: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub last_test: Option<ConnectionTestSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCatalogSnapshot {
    pub revision: u64,
    pub default_target: Option<ConnectionTarget>,
    pub connections: Vec<ConnectionCatalogEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCatalogConnectionInput {
    pub expected_catalog_revision: u64,
    pub connection: ConnectionCatalogEntryDraft,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCatalogConnectionInput {
    pub expected: ConnectionVersionBasis,
    pub changes: ConnectionCatalogEntryUpdate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveCatalogConnectionInput {
    pub expected: ConnectionVersionBasis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetDefaultConnectionTargetInput {
    pub expected_catalog_revision: u64,
    pub target: Option<ConnectionTarget>,
}
