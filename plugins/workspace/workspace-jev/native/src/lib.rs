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

//! Endpoint-bound structured decisions, using the original Jev engine and repository.
use maka_workspace_api::jev as contract;
mod network;
use contract::*;
use contract::{EXPORT, IMPLEMENTATION, contract};
use futures_util::future::BoxFuture;
use maka_capabilities::call::Resources;
use maka_capabilities::storage::Namespace;
use maka_capabilities::storage::StoreError;
use maka_config::ConfigurationStore;
use maka_host_runtime::application::{
    Context, Handler, NativeActivation, NativeContext, NativeOwner, NativeRegistry,
};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

struct Jev {
    configuration: Arc<ConfigurationStore>,
    repository: maka_jev::settings::Repository,
    storage: Arc<maka_host_runtime::storage::Storage>,
    network: maka_sandbox::Network,
    resources: Arc<Resources>,
    stopping: CancellationToken,
}
pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        maka_workspace_api::jev::IMPLEMENTATION.into(),
        Arc::new(|context, input| {
            Box::pin(async move {
                match Jev::open(context, input).await {
                    Ok(owner) => {
                        let service = Arc::new(Service(owner));
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                EXPORT.into(),
                                maka_plugin_core::runtime::Published {
                                    contract: contract(),
                                    value: service.clone() as Arc<dyn Handler>,
                                },
                            )])),
                            owner: service,
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
impl Jev {
    async fn open(context: NativeContext, input: Value) -> Result<Arc<Self>, String> {
        let input: Configuration = serde_json::from_value(input).map_err(message)?;
        let persistence = context.persistence().ok_or("jev_requires_persistence")?;
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
        let credentials = Arc::new(maka_host_runtime::credentials::Credentials {
            configuration: configuration.clone(),
            namespace,
            prefix,
            resources: resources.clone(),
            stopping: stopping.clone(),
        });
        Ok(Arc::new(Self {
            configuration,
            repository: maka_jev::settings::Repository {
                store: storage.clone(),
                credentials,
            },
            storage,
            network: input.network,
            resources,
            stopping,
        }))
    }
    async fn updated(&self) -> Result<Value, String> {
        encode(Update::Updated {
            snapshot: self.repository.snapshot().await.map_err(message)?,
        })
    }
}
struct Service(Arc<Jev>);
impl Handler for Service {
    fn call(
        &self,
        name: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let owner = self.0.clone();
        Box::pin(async move {
            if owner.stopping.is_cancelled() || context.scope().cancellation.is_cancelled() {
                return Err("jev_closed".into());
            }
            if name != "snapshot" && context.operation().is_none() {
                return Err("jev_mutation_required".into());
            }
            match name.as_str() {
                "snapshot" => encode(owner.repository.snapshot().await.map_err(message)?),
                "save" => {
                    let input: Set = serde_json::from_value(input).map_err(message)?;
                    if input.settings.validate().is_err() {
                        return encode(Update::Invalid);
                    }
                    match owner.repository.save(input.revision, input.settings).await {
                        Ok(()) => owner.updated().await,
                        Err(StoreError::Conflict { .. }) => encode(Update::Changed),
                        Err(error) => Err(message(error)),
                    }
                }
                "credential" => {
                    use maka_jev::settings::{HeaderPatch, SecretChange, SecretsPatch};
                    let input: Credential = serde_json::from_value(input).map_err(message)?;
                    // The endpoint in the intent identifies the credential owner even if
                    // another editor changes the active endpoint during this operation.
                    if (Settings {
                        url: input.url.clone(),
                        ..Settings::default()
                    })
                    .validate()
                    .is_err()
                    {
                        return encode(Update::Invalid);
                    }
                    let change = match input.change {
                        CredentialChange::Remove => SecretChange::Remove,
                        CredentialChange::Replace => {
                            let secret = context
                                .attachments()
                                .get("secret")
                                .ok_or("jev_secret_required")?;
                            let Ok(value) = String::from_utf8(secret.read(0..secret.bytes())?)
                            else {
                                return encode(Update::Invalid);
                            };
                            SecretChange::Replace { value }
                        }
                    };
                    let patch = match input.target {
                        CredentialTarget::ApiKey => SecretsPatch {
                            api_key: change,
                            headers: vec![],
                        },
                        CredentialTarget::Header { name } => SecretsPatch {
                            api_key: SecretChange::Keep,
                            headers: vec![HeaderPatch { name, change }],
                        },
                    };
                    // Validate against the stored key as well, for Authorization conflicts.
                    let result = owner
                        .repository
                        .patch_credentials(input.url, input.revision, patch)
                        .await;
                    match result {
                        Ok(maka_capabilities::credentials::WriteResult::Written { .. }) => {
                            owner.updated().await
                        }
                        Ok(maka_capabilities::credentials::WriteResult::Conflict { .. }) => {
                            encode(Update::Changed)
                        }
                        Err(StoreError::Unavailable(message))
                            if message.starts_with("Invalid Jev") =>
                        {
                            encode(Update::Invalid)
                        }
                        Err(error) => Err(message(error)),
                    }
                }
                "evaluate" => {
                    let input: Evaluation = serde_json::from_value(input).map_err(message)?;
                    let snapshot = owner.repository.snapshot().await.map_err(message)?;
                    let authority =
                        network::Access::new(owner.clone(), context.scope().clone(), &snapshot)?;
                    let engine = maka_jev::decision::Jev {
                        settings: owner.repository.clone(),
                        http: Arc::new(maka_host_runtime::http::Http::new(Arc::new(authority))),
                        preferences: Arc::new(network::Preferences(owner.configuration.clone())),
                    };
                    match engine
                        .configured(context.scope(), input, snapshot.settings)
                        .await
                    {
                        Ok(value) => encode(ResultValue::Completed { value }),
                        Err(error) if error.outcome_unknown() => {
                            if matches!(error, maka_jev::decision::Error::Settlement) {
                                owner.stopping.cancel();
                            }
                            Err(message(error))
                        }
                        Err(error) => encode(ResultValue::Failed {
                            message: message(error),
                        }),
                    }
                }
                _ => Err("jev_method_unavailable".into()),
            }
        })
    }
}
impl NativeOwner for Service {
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        (!self.0.resources.has_pending()).then(|| Box::new(()) as _)
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        self.0.stopping.cancel();
        let owner = self.0.clone();
        Box::pin(async move {
            let network = owner.resources.finish().await.map_err(message);
            let storage = owner.storage.finish().await;
            let configuration = owner.configuration.shutdown().await.map_err(message);
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
