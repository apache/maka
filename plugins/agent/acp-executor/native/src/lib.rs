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

//! Ordinary ACP Executor, with explicit imported process, file and form services.
use futures_util::future::BoxFuture;
use maka_agent_ports::executor;
use maka_agent_ports::executor::Provider as _;
use maka_capabilities::call::Identity;
use maka_capabilities::call::Issuer;
use maka_host_runtime::application::{
    Context, Handler, NativeActivation, NativeContext, NativeOwner, NativeRegistry,
};
use maka_plugin_core::runtime::Published;
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

mod calls;
mod processes;
mod setup;
use maka_host_runtime::storage;

use maka_agent_api::acp::{Configuration, EXPORT, IMPLEMENTATION, SETUP};
pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        maka_agent_api::acp::IMPLEMENTATION.into(),
        Arc::new(|context, input| {
            Box::pin(async move {
                match Owner::open(context, input) {
                    Ok(owner) => {
                        let service = Arc::new(Service(Arc::new(owner)));
                        NativeActivation {
                            exports: Ok(BTreeMap::from([
                                (
                                    EXPORT.into(),
                                    Published {
                                        contract: maka_agent_api::executor::contract(),
                                        value: service.clone() as Arc<dyn Handler>,
                                    },
                                ),
                                (
                                    SETUP.into(),
                                    Published {
                                        contract: maka_agent_api::executor::setup::contract(),
                                        value: service.clone() as Arc<dyn Handler>,
                                    },
                                ),
                            ])),
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
struct Owner {
    provider: maka_external_agent::Provider,
    agent: maka_external_agent::Agent,
    calls: Arc<calls::Calls>,
    processes: Arc<processes::Processes>,
    storage: Arc<storage::Storage>,
    store: Arc<maka_event_log::RootStore>,
    namespace: String,
}
impl Owner {
    fn open(context: NativeContext, input: Value) -> Result<Self, String> {
        let configuration: Configuration =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        configuration.agent.validate().map_err(|e| e.to_string())?;
        if let Some(permissions) = &configuration.permissions {
            permissions.validate().map_err(|e| e.to_string())?;
        }
        let services = context.services();
        for (name, contract) in [
            ("processes", maka_workspace_api::protocol::contract()),
            ("files", maka_workspace_api::files::contract()),
            ("forms", maka_interactions_api::forms::contract()),
        ] {
            let bindings = services
                .imports()
                .find(|(n, _)| *n == name)
                .map(|(_, b)| b)
                .ok_or_else(|| format!("ACP requires {name} import"))?;
            if bindings.len() != 1 || bindings[0].contract() != &contract {
                return Err(format!("ACP {name} contract is invalid"));
            }
        }
        let persistence = context.persistence().ok_or("ACP requires persistence")?;
        let namespace = format!(
            "{}/",
            calls::digest(&(
                &persistence.source().state_domain,
                persistence.source().deployment,
                context.activation().instance()
            ))
        );
        let store = persistence.store().clone();
        let calls = Arc::new(calls::Calls {
            services,
            issuer: Issuer::default(),
        });
        let processes = Arc::new(processes::Processes::new(
            calls.clone(),
            configuration.clone(),
        ));
        let storage = Arc::new(storage::Storage::new(
            store.clone(),
            namespace.clone(),
            maka_capabilities::storage::Namespace::new(
                IMPLEMENTATION,
                maka_plugin_core::scope::Scope::Profile,
            )
            .expect("ACP storage namespace"),
        ));
        let provider = maka_external_agent::Provider::new(
            configuration.agent.clone(),
            maka_external_agent::ports::Ports {
                processes: processes.clone(),
                storage: storage.clone(),
                callbacks: calls.clone(),
            },
        );
        Ok(Self {
            provider,
            agent: configuration.agent,
            calls,
            processes,
            storage,
            store,
            namespace,
        })
    }
}
struct Service(Arc<Owner>);
impl Handler for Service {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let owner = self.0.clone();
        let context = Arc::new(context);
        Box::pin(async move {
            if method == "setup" {
                return setup::run(owner, input, context).await;
            }
            if method != "execute" {
                return Err("ACP method unavailable".into());
            }
            context.operation().ok_or("ACP requires a mutation")?;
            let invocation = context
                .scope()
                .identity
                .agent()
                .ok_or("ACP requires an Agent invocation")?
                .clone();
            let input: maka_agent_api::executor::Execute =
                serde_json::from_value(input).map_err(|e| e.to_string())?;
            let store = owner
                .store
                .session_for_execution(
                    context
                        .execution_custody()
                        .ok_or("ACP requires execution custody")?
                        .as_ref(),
                    &invocation,
                )
                .map_err(|error| error.to_string())?;
            let configuration = maka_agent_authority::permissions::live(&store, &invocation)
                .await
                .map_err(|e| e.to_string())?;
            if input.invocation != invocation || input.cwd != configuration.workspace.path {
                return Err("ACP input does not match its admitted Session".into());
            }
            input.settings.validate().map_err(str::to_owned)?;
            // Wire conversation keys are observations. Only the real caller and
            // admitted Session select the durable external conversation.
            let conversation_key = calls::digest(&(
                &owner.namespace,
                context.requester().instance(),
                &invocation.session_id,
            ));
            let scope = owner
                .calls
                .issuer
                .issue_with(
                    context.scope().identity.clone(),
                    context.clone(),
                    context.scope().cancellation.clone(),
                )
                .map_err(|e| e.to_string())?;
            let mut ticket = context
                .scope()
                .resources
                .reserve()
                .map_err(|e| e.to_string())?;
            ticket.start();
            let result = owner
                .provider
                .execute(
                    executor::Request {
                        language: input.language,
                        invocation,
                        conversation_key,
                        content: input.message.into(),
                        cwd: configuration.workspace.path,
                        instructions: input.instructions,
                        settings: input.settings,
                    },
                    executor::Context {
                        cancellation: scope.cancellation.clone(),
                        output: Arc::new(Output(context)),
                        call: Some(scope.clone()),
                    },
                )
                .await;
            let mut cleanup = scope.finish().await.map_err(|e| e.to_string());
            if matches!(result, Err(executor::Error::CleanupUnconfirmed)) {
                cleanup = Err("ACP cleanup unconfirmed".into());
            }
            ticket.complete(cleanup.clone());
            cleanup?;
            serde_json::to_value(result.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
    }
}
struct Output(Arc<Context>);
impl executor::OutputSink for Output {
    fn emit(
        &self,
        output: maka_agent_facts::executor::Output,
    ) -> BoxFuture<'_, Result<(), executor::Error>> {
        Box::pin(async move {
            self.0
                .emit(
                    serde_json::to_value(output)
                        .map_err(|e| executor::Error::Invalid(e.to_string()))?,
                )
                .await
                .map_err(executor::Error::Provider)
        })
    }
}
impl NativeOwner for Service {
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        self.0.processes.is_idle().then(|| Box::new(()) as _)
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let owner = self.0.clone();
        Box::pin(async move {
            let provider = owner.provider.close().await.map_err(|e| e.to_string());
            let processes = owner.processes.close_all().await;
            let storage = owner.storage.finish().await;
            provider.and(processes).and(storage)
        })
    }
}
