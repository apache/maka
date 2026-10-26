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

use maka_agent_facts::configuration::CatalogMutationResult;
use maka_agent_facts::configuration::ModelSelection;
use maka_agent_facts::configuration::SetDefaultConnectionTargetInput;
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsModelsRead")]
pub enum ModelsRead {
    Start {
        #[serde(default)]
        query: String,
    },
    Continue {
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        revision: u64,
        cursor: ModelCursor,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsModelCursor")]
pub struct ModelCursor {
    pub query: String,
    pub connection: usize,
    pub model: usize,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsModelChoice")]
pub struct ModelChoice {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<ModelToolPreferences>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<ModelLimitSettings>,
    pub selection: ModelSelection,
    pub connection_name: String,
    pub label: String,
    #[schemars(length(max = 8))]
    pub thinking_levels: Vec<maka_agent_facts::execution::ThinkingLevel>,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::execution::ThinkingLevel>"
    )]
    pub default_thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
}
#[derive(Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsModelToolPreferences")]
pub struct ModelToolPreferences {
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<bool>")]
    pub code_mode: Option<bool>,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::execution::CodeLanguage>"
    )]
    pub code_mode_language: Option<maka_agent_facts::execution::CodeLanguage>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<bool>")]
    pub apply_patch: Option<bool>,
}
#[derive(Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsModelLimits")]
pub struct ModelLimits {
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub context_window: Option<u64>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub input_limit: Option<u64>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub max_output_tokens: Option<u64>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub compaction_threshold: Option<u64>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsModelLimitSettings")]
pub struct ModelLimitSettings {
    pub overrides: ModelLimits,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub context_window: Option<u64>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub input_limit: Option<u64>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub max_output_tokens: Option<u64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsUpdateModelSettings")]
pub struct UpdateModelSettings {
    pub selection: ModelSelection,
    pub tools: ModelToolPreferences,
    pub limits: ModelLimits,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsDefaultModel")]
pub enum DefaultModel {
    None,
    Unavailable {
        target: maka_agent_facts::configuration::ConnectionTarget,
    },
    Ready {
        choice: ModelChoice,
    },
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsModelsPage")]
pub enum ModelsPage {
    Changed {
        revision: u64,
    },
    Ready {
        revision: u64,
        #[schemars(length(max = 16))]
        choices: Vec<ModelChoice>,
        #[serde(rename = "defaultModel")]
        default_model: Box<DefaultModel>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ModelCursor>")]
        next: Option<ModelCursor>,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsConnectionsRead")]
pub enum ConnectionsRead {
    Start,
    Continue { revision: u64, offset: usize },
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsConnectionSummary")]
pub struct ConnectionSummary {
    /// Editing controls implemented by this Settings service for the provider.
    pub editable: bool,
    pub basis: maka_agent_facts::configuration::ConnectionVersionBasis,
    pub slug: String,
    pub name: String,
    pub provider: maka_agent_facts::provider::Identity,
    pub enabled: bool,
    pub enabled_model_count: usize,
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "SettingsConnectionsPage")]
pub enum ConnectionsPage {
    Changed {
        revision: u64,
    },
    Ready {
        revision: u64,
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::configuration::ConnectionTarget>"
        )]
        default_target: Option<maka_agent_facts::configuration::ConnectionTarget>,
        #[schemars(length(max = 16))]
        connections: Vec<ConnectionSummary>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<usize>")]
        next: Option<usize>,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsConnectionRead")]
pub struct ConnectionRead {
    pub connection_id: String,
    pub revision: u64,
    /// Opt in to the complete editing projection; credential reads stay narrow.
    #[serde(default)]
    pub include_editing_facts: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsConnectionEditingFacts")]
pub struct ConnectionEditingFacts {
    pub enabled_model_ids: Vec<String>,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<BTreeMap<String, maka_agent_facts::configuration::ModelOverride>>"
    )]
    pub model_overrides: Option<BTreeMap<String, maka_agent_facts::configuration::ModelOverride>>,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<BTreeMap<String, serde_json::Value>>"
    )]
    pub request_body_overlay: Option<serde_json::Value>,
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "SettingsConnectionDetail")]
pub enum ConnectionDetail {
    Stale {
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::configuration::ConnectionVersionBasis>"
        )]
        actual: Option<maka_agent_facts::configuration::ConnectionVersionBasis>,
    },
    Ready {
        target: Box<maka_agent_facts::configuration::ConnectionCredentialTarget>,
        name: String,
        enabled: bool,
        enabled_model_count: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "ConnectionEditingFacts")]
        editing: Option<ConnectionEditingFacts>,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsProvidersRead")]
pub struct ProvidersRead {
    pub offset: usize,
}
#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsProvider")]
pub struct Provider {
    pub identity: maka_agent_facts::provider::Identity,
    pub descriptor: maka_agent_ports::provider::Descriptor,
}
#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsProviderAuthenticationSummary")]
pub struct ProviderAuthenticationSummary {
    pub label: String,
    pub interactive: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsProviderSummary")]
pub struct ProviderSummary {
    pub identity: maka_agent_facts::provider::Identity,
    pub label: String,
    pub authentication: Vec<ProviderAuthenticationSummary>,
}
#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsProvidersPage")]
pub struct ProvidersPage {
    pub providers: Vec<ProviderSummary>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<usize>")]
    pub next: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsSaveCredential")]
pub struct SaveCredential {
    pub expected: maka_agent_facts::configuration::ConnectionCredentialTarget,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::configuration::CredentialVersionBasis>"
    )]
    pub expected_credential: Option<maka_agent_facts::configuration::CredentialVersionBasis>,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsCredentialSaveResult")]
pub enum CredentialSaveResult {
    Saved {
        connection: maka_agent_facts::oauth::ConnectionIdentity,
    },
    Rejected {
        reason: CredentialRejection,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "SettingsCredentialRejection")]
pub enum CredentialRejection {
    InvalidInput,
    InvalidSecret,
    SecretUnavailable,
    ProviderUnavailable,
    AuthenticationUnavailable,
    AttemptConflict,
    ConnectionChanged,
    CredentialChanged,
    SlugTaken,
    Authentication,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsCredentialLogin")]
pub struct LoginCredential {
    pub expected: maka_agent_facts::configuration::ConnectionCredentialTarget,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_facts::configuration::CredentialVersionBasis>"
    )]
    pub expected_credential: Option<maka_agent_facts::configuration::CredentialVersionBasis>,
    pub method: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsLoginPrompt")]
pub struct LoginPrompt {
    pub url: String,
    pub user_code: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsCredentialLoginResult")]
pub enum CredentialLoginResult {
    Saved {
        connection: maka_agent_facts::oauth::ConnectionIdentity,
    },
    Rejected {
        reason: CredentialRejection,
    },
    Failed {
        reason: LoginFailure,
        message: String,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "SettingsLoginFailure")]
pub enum LoginFailure {
    Cancelled,
    Expired,
    Transport,
    Authentication,
}
fn schema<T: JsonSchema>(contract: schemars::generate::Contract) -> serde_json::Value {
    let settings =
        schemars::generate::SchemaSettings::default().with(|settings| settings.contract = contract);
    serde_json::to_value(settings.into_generator().into_root_schema_for::<T>())
        .expect("settings schema")
}
fn method<I: JsonSchema, O: JsonSchema>(mode: MethodMode) -> Method {
    Method {
        progress: None,
        mode,
        input: schema::<I>(schemars::generate::Contract::Deserialize).into(),
        output: schema::<O>(schemars::generate::Contract::Serialize).into(),
        resources: BTreeMap::new(),
    }
}
pub fn authentication_contract() -> Contract {
    Contract {
        name: "maka.settings.Authentication".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "provider".into(),
                    method::<maka_agent_facts::provider::Identity, Provider>(MethodMode::Query),
                ),
                (
                    "loginCredential".into(),
                    Method {
                        progress: Some(
                            schema::<LoginPrompt>(schemars::generate::Contract::Serialize).into(),
                        ),
                        ..method::<LoginCredential, CredentialLoginResult>(MethodMode::Mutation)
                    },
                ),
            ]),
        },
    }
}

pub fn contract() -> Contract {
    Contract {
        name: "maka.settings.Settings".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "network".into(),
                    method::<crate::network::Read, crate::network::Snapshot>(MethodMode::Query),
                ),
                (
                    "workspaceLocations".into(),
                    method::<
                        super::workspace_locations::Read,
                        Option<super::workspace_locations::Snapshot>,
                    >(MethodMode::Query),
                ),
                (
                    "updateWorkspaceLocations".into(),
                    method::<
                        super::workspace_locations::Update,
                        maka_plugin_core::deployment::management::ManagementResult<
                            super::workspace_locations::Snapshot,
                        >,
                    >(MethodMode::Mutation),
                ),
                (
                    "updateNetwork".into(),
                    Method {
                        resources: BTreeMap::from([(
                            "secret".into(),
                            maka_plugin_core::contract::ResourceType {
                                name: "maka.text.utf8".into(),
                                version: 1,
                            }
                            .optional(),
                        )]),
                        ..method::<crate::network::Update, crate::network::Updated>(
                            MethodMode::Mutation,
                        )
                    },
                ),
                (
                    "usage".into(),
                    method::<crate::usage::Read, crate::usage::Page>(MethodMode::Query),
                ),
                (
                    "usageSummary".into(),
                    method::<crate::usage::SummaryRead, crate::usage::Report>(MethodMode::Query),
                ),
                (
                    "prices".into(),
                    method::<maka_agent_facts::pricing::Query, maka_agent_facts::pricing::Page>(
                        MethodMode::Query,
                    ),
                ),
                (
                    "updatePrice".into(),
                    method::<maka_agent_facts::pricing::Update, crate::usage::PricingResult>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "assistantPreferences".into(),
                    method::<crate::preferences::Read, crate::preferences::Preferences>(
                        MethodMode::Query,
                    ),
                ),
                (
                    "updateAssistantPreferences".into(),
                    method::<crate::preferences::Update, crate::preferences::Updated>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "connections".into(),
                    method::<ConnectionsRead, ConnectionsPage>(MethodMode::Query),
                ),
                (
                    "connection".into(),
                    method::<ConnectionRead, ConnectionDetail>(MethodMode::Query),
                ),
                (
                    "providers".into(),
                    method::<ProvidersRead, ProvidersPage>(MethodMode::Query),
                ),
                (
                    "create".into(),
                    method::<
                        maka_agent_facts::configuration::CreateCatalogConnectionInput,
                        CatalogMutationResult,
                    >(MethodMode::Mutation),
                ),
                (
                    "update".into(),
                    method::<
                        maka_agent_facts::configuration::UpdateCatalogConnectionInput,
                        CatalogMutationResult,
                    >(MethodMode::Mutation),
                ),
                (
                    "remove".into(),
                    method::<
                        maka_agent_facts::configuration::RemoveCatalogConnectionInput,
                        CatalogMutationResult,
                    >(MethodMode::Mutation),
                ),
                (
                    "credentialStatus".into(),
                    method::<
                        maka_agent_facts::configuration::CredentialVaultQueryInput,
                        maka_agent_facts::configuration::CredentialVaultQueryResult,
                    >(MethodMode::Query),
                ),
                (
                    "deleteCredential".into(),
                    method::<
                        maka_agent_facts::configuration::DeleteCredentialInput,
                        maka_agent_facts::configuration::CredentialMutationResult,
                    >(MethodMode::Mutation),
                ),
                (
                    "saveCredential".into(),
                    Method {
                        progress: None,
                        resources: BTreeMap::from([(
                            "secret".into(),
                            maka_plugin_core::contract::ResourceType {
                                name: "maka.text.utf8".into(),
                                version: 1,
                            }
                            .required(),
                        )]),
                        ..method::<SaveCredential, CredentialSaveResult>(MethodMode::Mutation)
                    },
                ),
                (
                    "models".into(),
                    method::<ModelsRead, ModelsPage>(MethodMode::Query),
                ),
                (
                    "updateModelSettings".into(),
                    method::<UpdateModelSettings, CatalogMutationResult>(MethodMode::Mutation),
                ),
                (
                    "resolveModel".into(),
                    method::<maka_agent_facts::configuration::ConnectionTarget, DefaultModel>(
                        MethodMode::Query,
                    ),
                ),
                (
                    "setDefault".into(),
                    method::<SetDefaultConnectionTargetInput, CatalogMutationResult>(
                        MethodMode::Mutation,
                    ),
                ),
            ]),
        },
    }
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsSetupResult")]
pub enum SetupResult {
    Ready {
        connection: maka_agent_facts::configuration::ConnectionVersionBasis,
    },
    Failed,
    Superseded,
}
pub fn setup_contract() -> Contract {
    Contract {
        name: "maka.settings.Setup".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "discoverModels".into(),
                method::<maka_agent_facts::configuration::ConnectionCredentialTarget, SetupResult>(
                    MethodMode::Mutation,
                ),
            )]),
        },
    }
}
