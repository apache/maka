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

//! Root-owned settings as an ordinary compiled capability, activated only by composition.
mod connections;
pub mod contract;
mod credential;
pub mod network;
pub mod preferences;
mod service;
mod setup;
pub mod usage;
pub mod workspace_locations;
use futures_util::future::BoxFuture;
use maka_agent_facts::language::LanguagePreference;
use maka_host_runtime::application::{NativeActivation, NativeOwner, NativeRegistry};
use schemars::JsonSchema;
use serde::Deserialize;
use std::sync::Arc;
#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    #[serde(default)]
    locale: String,
    #[serde(default)]
    workspace_locations: Option<workspace_locations::Configuration>,
}

fn configuration_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Configuration))
        .expect("settings configuration schema is serializable")
}

pub const IMPLEMENTATION: &str = "maka.settings";
pub const EXPORT: &str = "Settings";
pub fn provide(
    registry: &mut NativeRegistry,
    catalog: Arc<maka_providers::catalog::Catalog>,
) -> Result<(), String> {
    for (implementation, export, contract) in [
        (IMPLEMENTATION, EXPORT, contract::contract()),
        ("maka.settings.setup", "Setup", contract::setup_contract()),
        (
            "maka.settings.authentication",
            "Authentication",
            contract::authentication_contract(),
        ),
    ] {
        let catalog = catalog.clone();
        registry.insert(
            implementation.into(),
            Arc::new(move |context, input| {
                let contract = contract.clone();
                let catalog = catalog.clone();
                Box::pin(async move {
                    let opened = async {
                        let configuration: Configuration = serde_json::from_value(input)
                            .map_err(|_| "settings_configuration_invalid".to_owned())?;
                        let native_language = maka_config::language::native_language();
                        let persistence = context
                            .persistence()
                            .ok_or("settings_requires_persistence")?;
                        let root = persistence
                            .store()
                            .owned_root()
                            .map_err(|_| "settings_root_unavailable")?;
                        let store = maka_config::ConfigurationStore::for_root(root)
                            .await
                            .map_err(|_| "settings_store_unavailable")?;
                        Ok::<_, String>(Arc::new(service::Settings {
                            source: persistence.source().clone(),
                            workspace_locations: configuration.workspace_locations,
                            catalog,
                            configuration: Arc::new(store),
                            log: persistence.store().clone(),
                            configured_locale: LanguagePreference::from_locale(
                                &configuration.locale,
                            ),
                            native_language,
                        }))
                    }
                    .await;
                    match opened {
                        Ok(owner) => NativeActivation {
                            exports: Ok(std::collections::BTreeMap::from([(
                                export.into(),
                                maka_plugin_core::runtime::Published {
                                    contract,
                                    value: owner.clone()
                                        as Arc<dyn maka_host_runtime::application::Handler>,
                                },
                            )])),
                            owner,
                        },
                        Err(error) => NativeActivation {
                            exports: Err(error),
                            owner: Arc::new(Uninitialized),
                        },
                    }
                })
            }),
        )?;
    }
    Ok(())
}
struct Uninitialized;
impl NativeOwner for Uninitialized {
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        configuration_schema(),
        [(EXPORT, contract::contract())],
    )
}

pub fn native_authentication() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        "maka.settings.authentication",
        configuration_schema(),
        [("Authentication", contract::authentication_contract())],
    )
}

pub fn native_setup() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        "maka.settings.setup",
        configuration_schema(),
        [("Setup", contract::setup_contract())],
    )
}
