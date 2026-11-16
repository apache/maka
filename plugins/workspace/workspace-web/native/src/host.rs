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

//! Web retrieval uses the original HTTP worker, Root settings and permission facts.
mod check;
use maka_host_runtime::credentials;
use maka_web_api::contract;
mod network;
use contract::configuration_schema;
use contract::*;
use futures_util::future::BoxFuture;
use maka_config::ConfigurationStore;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation, NativeContext,
    NativeOwner, NativeRegistry,
};
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::work::resources::Resources;
use maka_web_api::{EXPORT, IMPLEMENTATION};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

struct Web {
    log: Arc<maka_event_log::RootStore>,
    configuration: Arc<ConfigurationStore>,
    repository: crate::settings::Repository,
    storage: Arc<maka_host_runtime::storage::Storage>,
    network: maka_sandbox::Network,
    resources: Arc<Resources>,
    stopping: CancellationToken,
}
pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        maka_web_api::IMPLEMENTATION.into(),
        Arc::new(|context, input| {
            Box::pin(async move {
                match Web::open(context, input).await {
                    Ok(owner) => {
                        let owner = Arc::new(Service(owner));
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                EXPORT.into(),
                                maka_plugin_core::runtime::Published {
                                    contract: contract(),
                                    value: owner.clone() as Arc<dyn Handler>,
                                },
                            )])),
                            owner,
                        }
                    }
                    Err(error) => NativeActivation {
                        exports: Err(error),
                        owner: Arc::new(()),
                    },
                }
            })
        }),
    )
}
impl Web {
    async fn open(context: NativeContext, input: Value) -> Result<Arc<Self>, String> {
        if !jsonschema::validator_for(&configuration_schema())
            .expect("Web schema")
            .is_valid(&input)
        {
            return Err("web_configuration_invalid".into());
        }
        let input: Configuration = serde_json::from_value(input).map_err(message)?;
        let persistence = context.persistence().ok_or("web_requires_persistence")?;
        let root = persistence.store().owned_root().map_err(message)?;
        let configuration = Arc::new(ConfigurationStore::for_root(root).await.map_err(message)?);
        let prefix = maka_host_runtime::storage::instance_prefix(
            &persistence.source().state_domain,
            persistence.source().deployment,
            context.activation().instance(),
        );
        let namespace = Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile)
            .map_err(message)?;
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(
            persistence.store().clone(),
            prefix.clone(),
            namespace.clone(),
        ));
        let resources = Arc::new(Resources::default());
        let stopping = CancellationToken::new();
        let credentials = Arc::new(credentials::Credentials {
            configuration: configuration.clone(),
            namespace,
            prefix,
            resources: resources.clone(),
            stopping: stopping.clone(),
        });
        Ok(Arc::new(Self {
            log: persistence.store().clone(),
            configuration,
            repository: crate::settings::Repository {
                store: storage.clone(),
                credentials,
            },
            storage,
            network: input.network,
            resources,
            stopping,
        }))
    }
    async fn capture(&self) -> Result<Capture, String> {
        let current = self.repository.search_settings().await.map_err(message)?;
        Ok(Capture {
            basis: Basis {
                revision: current.revision,
                credential_revision: current.credential_revision(),
            },
            available: current.settings.enabled,
            source: current.settings.source,
            custom_available: current.available(),
        })
    }
    async fn fetch_is_current(&self, basis: &Basis) -> Result<bool, String> {
        let (revision, settings) = self.repository.settings().await.map_err(message)?;
        Ok(settings.enabled && revision == basis.revision)
    }
}
struct Service(Arc<Web>);
impl Handler for Service {
    fn call(
        &self,
        name: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let owner = self.0.clone();
        let failure = network::Failure::default();
        let observed_failure = failure.clone();
        let result = async move {
            if owner.stopping.is_cancelled() || context.scope().cancellation.is_cancelled() {
                return Err("web_closed".into());
            }
            match name.as_str() {
                "capture" => return encode(owner.capture().await?),
                "snapshot" => {
                    return encode(owner.repository.snapshot().await.map_err(message)?);
                }
                _ => {}
            }
            if context.operation().is_none() {
                return Err("web_mutation_required".into());
            }
            let native = network::native_call(&owner, &context, &failure).await?;
            match name.as_str() {
                "save" => {
                    let input: Set = serde_json::from_value(input).map_err(message)?;
                    if let Err(message) =
                        crate::search::SearchEndpoint::resolve(&input.settings.backend)
                    {
                        return encode(Update::InvalidSettings {
                            message: message.into(),
                        });
                    }
                    match owner.repository.save(input.revision, input.settings).await {
                        Ok(_) => encode(Update::Updated {
                            snapshot: owner.repository.snapshot().await.map_err(message)?,
                        }),
                        Err(maka_plugin_core::storage::StoreError::Conflict { .. }) => {
                            encode(Update::Changed)
                        }
                        Err(error) => Err(message(error)),
                    }
                }
                "checkKey" => check::run(owner, input, context, failure).await,
                "probe" => {
                    let input: maka_web_api::probe::Input =
                        serde_json::from_value(input).map_err(message)?;
                    let authority = network::Access::health(
                        owner,
                        context.scope(),
                        native.ok_or("web_requires_native_call")?,
                        failure.clone(),
                    )?;
                    let client = Arc::new(maka_host_runtime::http::Http::new(Arc::new(authority)));
                    match crate::probe::probe(client, context.scope(), input).await {
                        Ok(endpoint) => encode(ResultValue::Completed {
                            value: serde_json::to_value(endpoint).map_err(message)?,
                        }),
                        Err(maka_agent_facts::tools::ToolError::Failed(message)) => {
                            if failure.is_uncertain() {
                                Err(message)
                            } else {
                                encode(ResultValue::Failed { message })
                            }
                        }
                        Err(error) => {
                            failure.observe(&error);
                            Err(message(error))
                        }
                    }
                }
                "saveKey" | "deleteKey" => {
                    let input: Key = serde_json::from_value(input).map_err(message)?;
                    let current = owner.repository.search_settings().await.map_err(message)?;
                    if current.revision != input.settings_revision
                        || current.credential_revision() != input.revision
                    {
                        return encode(Update::Changed);
                    }
                    let Some(key) = current.key else {
                        return encode(Update::InvalidKey);
                    };
                    let secret = if name == "saveKey" {
                        let resource = context
                            .attachments()
                            .get("secret")
                            .ok_or("web_key_required")?;
                        if resource.bytes() == 0 {
                            return encode(Update::InvalidKey);
                        }
                        let bytes = resource.read(0..resource.bytes())?;
                        let Ok(secret) = String::from_utf8(bytes) else {
                            return encode(Update::InvalidKey);
                        };
                        let secret = secret.trim().to_owned();
                        if secret.is_empty() || secret.chars().any(char::is_control) {
                            return encode(Update::InvalidKey);
                        }
                        Some(secret)
                    } else {
                        None
                    };
                    match owner
                        .repository
                        .credentials
                        .write(maka_capabilities::credentials::Write {
                            key,
                            expected_revision: input.revision,
                            secret,
                        })
                        .await
                        .map_err(message)?
                    {
                        maka_capabilities::credentials::WriteResult::Written { .. } => {
                            encode(Update::Updated {
                                snapshot: owner.repository.snapshot().await.map_err(message)?,
                            })
                        }
                        maka_capabilities::credentials::WriteResult::Conflict { .. } => {
                            encode(Update::Changed)
                        }
                    }
                }
                "fetch" | "search" => {
                    let call: Call<Value> = serde_json::from_value(input).map_err(message)?;
                    let (purpose, search) = if name == "search" {
                        let current = owner.repository.search_settings().await.map_err(message)?;
                        if !current.matches(&call.basis) {
                            return encode(ResultValue::Failed { message: "Web settings changed or access is disabled; request a new model step".into() });
                        }
                        (
                            network::Purpose::Search {
                                basis: call.basis,
                                key: current.key.clone(),
                            },
                            Some(current),
                        )
                    } else {
                        if !owner.fetch_is_current(&call.basis).await? {
                            return encode(ResultValue::Failed { message: "Web settings changed or access is disabled; request a new model step".into() });
                        }
                        (network::Purpose::Fetch { basis: call.basis }, None)
                    };
                    let authority = network::Access::new(
                        owner.clone(),
                        context.scope(),
                        native.ok_or("web_requires_native_call")?,
                        purpose,
                        failure.clone(),
                    )?;
                    let client = Arc::new(maka_host_runtime::http::Http::new(Arc::new(authority)));
                    let result = if let Some(current) = search {
                        let input: maka_web_api::search::Query =
                            serde_json::from_value(call.input).map_err(message)?;
                        crate::search::Search::new(client)
                            .query(context.scope(), &current.endpoint, current.secret(), &input)
                            .await
                            .map(|results| {
                                serde_json::to_value(results).expect("Web search results")
                            })
                            .map_err(|error| match error {
                                crate::search::Error::Settlement(error) => error,
                                error => maka_agent_facts::tools::ToolError::Failed(message(error)),
                            })
                    } else {
                        let input: Fetch = serde_json::from_value(call.input).map_err(message)?;
                        crate::fetch::Fetcher::new(client)
                            .fetch(context.scope(), &input.url)
                            .await
                            .map(|page| serde_json::to_value(page).expect("Web page"))
                            .map_err(|error| match error {
                                crate::fetch::Error::Settlement(error) => error,
                                crate::fetch::Error::Http(
                                    maka_capabilities::http::Error::CleanupUnconfirmed,
                                ) => maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
                                    "Web HTTP cleanup unconfirmed".into(),
                                ),
                                error => maka_agent_facts::tools::ToolError::Failed(message(error)),
                            })
                    };
                    if let Err(error) = &result {
                        failure.observe(error);
                    }
                    match result {
                        Ok(value) => encode(ResultValue::Completed { value }),
                        Err(maka_agent_facts::tools::ToolError::Failed(message)) => {
                            if failure.is_uncertain() {
                                Err(message)
                            } else {
                                encode(ResultValue::Failed { message })
                            }
                        }
                        Err(error) => Err(message(error)),
                    }
                }
                _ => Err("web_method_unavailable".into()),
            }
        };
        Box::pin(async move {
            let result: std::result::Result<Value, String> = result.await;
            result
                .map(HandlerValue::Json)
                .map_err(|diagnostic| observed_failure.returned(diagnostic))
        })
    }
}
impl NativeOwner for Service {
    fn execution_basis(&self) -> Option<Value> {
        // Settings and credentials share this Root and instance namespace.
        self.0.storage.execution_basis()
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        (!self.0.resources.has_pending()).then(|| Box::new(()) as _)
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        self.0.stopping.cancel();
        let resources = self.0.resources.clone();
        let storage = self.0.storage.clone();
        let configuration = self.0.configuration.clone();
        Box::pin(async move {
            let network = resources.finish().await.map_err(message);
            let storage = storage.finish().await;
            let configuration = configuration.shutdown().await.map_err(message);
            network.and(storage).and(configuration)
        })
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn encode(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(message)
}
