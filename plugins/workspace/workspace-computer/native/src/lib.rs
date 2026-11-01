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

//! Session-owned Computer Use through the ordinary Host mutation lifecycle.
mod access;
mod admission;
mod app_access;
mod browser_access;
mod browser_files;
mod browser_popup;
mod evaluate;
mod native_monitor;
mod sessions;

use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_facts::{tool_call::ToolOrigin, tools::ToolError};
use maka_capabilities::call::Resources;
use maka_host_runtime::application::{
    Context, Handler, NativeActivation, NativeContext, NativeOwner, NativeRegistry,
};
use maka_workspace_api::computer::{self as api, Configuration, ReplState, ResultValue};
use serde_json::Value;
use std::{collections::BTreeMap, panic::AssertUnwindSafe, sync::Arc};
use tokio_util::sync::CancellationToken;

struct Computer {
    store: Arc<maka_event_log::RootStore>,
    configuration: Configuration,
    sessions: sessions::Sessions,
    resources: Arc<Resources>,
    stopping: CancellationToken,
    tasks: tokio_util::task::TaskTracker,
    origin: ToolOrigin,
    popup_provenance: Option<Arc<browser_popup::Provenance>>,
}
struct Service(Arc<Computer>);

pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        api::IMPLEMENTATION.into(),
        Arc::new(|context, input| {
            Box::pin(async move {
                match Computer::open(context, input) {
                    Ok(owner) => {
                        let owner = Arc::new(Service(owner));
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                api::EXPORT.into(),
                                maka_plugin_core::runtime::Published {
                                    contract: api::contract(),
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
impl Computer {
    fn open(context: NativeContext, input: Value) -> Result<Arc<Self>, String> {
        if !jsonschema::validator_for(&api::configuration_schema())
            .expect("Computer schema")
            .is_valid(&input)
        {
            return Err("computer_configuration_invalid".into());
        }
        let configuration: Configuration = serde_json::from_value(input).map_err(message)?;
        let tasks = tokio_util::task::TaskTracker::new();
        let sessions = sessions::Sessions::with_audio(configuration.audio, tasks.clone());
        let persistence = context
            .persistence()
            .ok_or("computer_requires_persistence")?;
        let owner = Arc::new(Self {
            store: persistence.store().clone(),
            popup_provenance: Some(Arc::new(browser_popup::Provenance::capture(&context)?)),
            configuration,
            sessions,
            resources: Arc::new(Resources::default()),
            stopping: CancellationToken::new(),
            tasks,
            origin: ToolOrigin::HostSdk {
                package_id: context.package().id.clone(),
                entry_id: serde_json::to_string(context.activation().instance())
                    .map_err(message)?,
                activation: context.activation().epoch().to_string(),
                parent: None,
            },
        });
        sessions::watch(&owner);
        Ok(owner)
    }
    async fn call(
        self: &Arc<Self>,
        name: &str,
        input: Value,
        context: Context,
    ) -> Result<Value, ToolError> {
        let invocation = context
            .scope()
            .identity
            .agent()
            .ok_or_else(|| failed("Computer Use requires an Agent invocation"))?
            .clone();
        if name == "state" {
            maka_agent_authority::permissions::live(
                &maka_agent_authority::permissions::execution(
                    &self.store,
                    &invocation,
                    context.scope().execution().map(|token| token.as_ref()),
                )?,
                &invocation,
            )
            .await?;
            return serde_json::to_value(self.sessions.state(&invocation.session_id).await)
                .map_err(failed);
        }
        if context.operation().is_none() {
            return Err(failed("Computer Use requires an original mutation"));
        }
        let tool = match name {
            "evaluate" => "cua_repl",
            "reset" => "cua_reset",
            _ => return Err(failed("Computer method unavailable")),
        };
        api::validate(tool, &input).map_err(failed)?;
        let (configuration, _) = access::current(self, context.scope(), tool).await?;
        let cancellation = context.scope().cancellation.child_token();
        let execute = async {
            if name == "evaluate" {
                access::approve(self, context.scope(), &configuration, &cancellation).await?;
            }
            let interaction = self.sessions.get(&invocation.session_id)?;
            let result = self.evaluate(
                name,
                input,
                context.resource_capturer().into(),
                configuration.permission_basis(),
                interaction.clone(),
                cancellation.clone(),
            );
            tokio::pin!(result);
            tokio::select! {
                result = &mut result => result,
                () = interaction.retiring.cancelled() => { cancellation.cancel(); result.await },
            }
        };
        tokio::pin!(execute);
        let result = tokio::select! {
            result = &mut execute => result,
            () = self.stopping.cancelled() => { cancellation.cancel(); execute.await },
        };
        match result {
            Ok(value) => serde_json::to_value(value).map_err(failed),
            Err(ToolError::Failed(message)) => serde_json::to_value(ResultValue::Failed {
                message,
                state: self.sessions.state(&invocation.session_id).await,
            })
            .map_err(failed),
            Err(error) => Err(error),
        }
    }
}
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
                return Err("computer_closed".into());
            }
            let mut owned = owner.resources.reserve().map_err(message)?;
            let mut caller = context.scope().resources.reserve().map_err(message)?;
            // The original accepted worker retains both cleanup fences if its observer disappears.
            tokio::spawn(async move {
                owned.start();
                caller.start();
                let result = AssertUnwindSafe(owner.call(&name, input, context))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(ToolError::CleanupUnconfirmed(
                            "Computer worker panicked".into(),
                        ))
                    });
                let cleanup = if matches!(
                    result,
                    Err(ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))
                ) {
                    Err("Computer cleanup unconfirmed".into())
                } else {
                    Ok(())
                };
                owned.complete(cleanup.clone());
                caller.complete(cleanup);
                result.map_err(message)
            })
            .await
            .map_err(message)?
        })
    }
}
impl NativeOwner for Service {
    fn execution_basis(&self) -> Option<Value> {
        // Grants and output artifacts belong to this Root; device selection is
        // captured configuration. REPL state belongs to actual tool calls.
        let root = self.0.store.owned_root().ok()?;
        serde_json::to_value((root.root_id(), &self.0.configuration)).ok()
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        self.0.resources.is_idle().then(|| Box::new(()) as _)
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let owner = self.0.clone();
        owner.stopping.cancel();
        owner.tasks.close();
        Box::pin(async move {
            let native = owner.sessions.close().await.map_err(message);
            let work = owner.resources.settle().await.map_err(message);
            owner.tasks.wait().await;
            work.and(native)
        })
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(message(error))
}
