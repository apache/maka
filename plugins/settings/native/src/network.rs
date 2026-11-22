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

use maka_agent_facts::configuration::CredentialStatus;
use maka_agent_facts::configuration::CredentialVersionBasis;
use maka_agent_facts::configuration::policy::NetworkProxy;
use maka_agent_facts::configuration::policy::network_update;
use maka_agent_facts::configuration::policy::network_update::CredentialUpdate;
use maka_agent_facts::configuration::policy::network_update::UpdateResult;
use maka_host_runtime::application::Context;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsNetworkRead")]
pub struct Read {}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsNetworkSnapshot")]
pub struct Snapshot {
    pub revision: u64,
    pub proxy: NetworkProxy,
    pub credential: CredentialStatus,
    pub root_id: String,
    pub root_path: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsNetworkUpdate")]
pub struct Update {
    pub expected_policy_revision: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<CredentialVersionBasis>")]
    pub expected_credential: Option<CredentialVersionBasis>,
    pub network_proxy: NetworkProxy,
    pub credential: CredentialAction,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "SettingsNetworkCredentialAction")]
pub enum CredentialAction {
    Keep,
    Delete,
    Replace,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsNetworkUpdated")]
pub enum Updated {
    Applied { result: UpdateResult },
    Rejected,
}

pub(crate) async fn read(
    store: &maka_config::ConfigurationStore,
    log: &maka_event_log::RootStore,
    input: Value,
) -> Result<Value, String> {
    let _: Read = serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let root = log.owned_root().map_err(|_| "settings_root_unavailable")?;
    let policy = store
        .runtime_policy()
        .await
        .map_err(|_| "settings_store_unavailable")?;
    let credential = store
        .credential_status(network_update::locator())
        .await
        .map_err(|_| "settings_store_unavailable")?;
    let maka_agent_facts::configuration::CredentialVaultQueryResult::Status { status: credential } =
        credential
    else {
        return Err("settings_store_unavailable".into());
    };
    super::connections::encode(Snapshot {
        revision: policy.revision,
        proxy: policy.policy.network_proxy,
        credential,
        root_id: root.root_id().into(),
        root_path: root.canonical_path().to_string_lossy().into_owned(),
    })
}
pub(crate) async fn update(
    store: &maka_config::ConfigurationStore,
    input: Value,
    context: Context,
) -> Result<Value, String> {
    context.operation().ok_or("settings_mutation_required")?;
    let Ok(input) = serde_json::from_value::<Update>(input) else {
        return super::connections::encode(Updated::Rejected);
    };
    let resource = context.attachments().get("secret");
    let credential = match (input.credential, resource) {
        (CredentialAction::Keep, None) => CredentialUpdate::Keep {},
        (CredentialAction::Delete, None) => CredentialUpdate::Delete {},
        (CredentialAction::Replace, Some(resource)) => {
            let bytes = resource.bytes();
            if bytes == 0 {
                return super::connections::encode(Updated::Rejected);
            }
            let Ok(secret) = resource
                .read(0..bytes)
                .and_then(|v| String::from_utf8(v).map_err(|_| "invalid_secret".into()))
            else {
                return super::connections::encode(Updated::Rejected);
            };
            if secret.len() != bytes {
                return super::connections::encode(Updated::Rejected);
            }
            CredentialUpdate::Replace {
                secret,
                expected_target: None,
            }
        }
        _ => return super::connections::encode(Updated::Rejected),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "settings_clock_unavailable")?
        .as_secs();
    let result = store
        .update_network_proxy(
            network_update::Update {
                expected_policy_revision: input.expected_policy_revision,
                expected_credential: input.expected_credential,
                network_proxy: input.network_proxy,
                credential,
            },
            now,
        )
        .await;
    match result {
        Ok(result) => super::connections::encode(Updated::Applied { result }),
        Err(maka_config::ConfigError::Invalid(_)) => super::connections::encode(Updated::Rejected),
        Err(_) => Err("settings_effect_unknown".into()),
    }
}
