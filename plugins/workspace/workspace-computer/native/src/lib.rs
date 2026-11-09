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
mod system_permission;

use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_facts::tools::ToolError;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation, NativeContext,
    NativeOwner, NativeRegistry,
};
use maka_plugin_core::work::resources::Resources;
use maka_workspace_api::computer::{self as api, Configuration, ReplState, ResultValue};
use serde_json::Value;
use std::{collections::BTreeMap, panic::AssertUnwindSafe, sync::Arc};
use tokio_util::sync::CancellationToken;

/// The Host-validated native capability travels with the same in-process call.
/// Public identity remains an observation and cannot reconstruct this value.
#[derive(Clone)]
struct Call {
    scope: maka_capabilities::call::Scope,
    authority: Arc<dyn maka_agent_authority::computer::ComputerAccess>,
    operation: Option<maka_plugin_core::operation::RecoveryRef>,
}

struct Computer {
    store: Arc<maka_event_log::RootStore>,
    configuration: Configuration,
    sessions: sessions::Sessions,
    resources: Arc<Resources>,
    stopping: CancellationToken,
    tasks: tokio_util::task::TaskTracker,
    popup_provenance: Option<Arc<browser_popup::Provenance>>,
}
// The settlement tokens stay outside their retained Computer material.
struct Service(
    Arc<Computer>,
    Arc<std::sync::Mutex<Vec<maka_event_log::root_store::RetainedWorkSettlement>>>,
);

pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        api::IMPLEMENTATION.into(),
        Arc::new(|context, input| {
            Box::pin(async move {
                match Computer::open(context, input) {
                    Ok(owner) => {
                        let owner = Arc::new(Service(owner, Arc::default()));
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
        });
        sessions::watch(&owner);
        Ok(owner)
    }
    async fn call(
        self: &Arc<Self>,
        name: &str,
        input: Value,
        context: Context,
    ) -> Result<HandlerValue, ToolError> {
        let authority = context
            .native_context::<maka_agent_authority::computer::NativeCallContext>()
            .and_then(|context| context.computer())
            .ok_or_else(|| failed("Computer Use requires its original native call capability"))?;
        let invocation = authority.call().execution.clone();
        self.store
            .session_for_work(
                context
                    .work_custody()
                    .ok_or_else(|| failed("Computer Use requires original Root work custody"))?
                    .as_ref(),
                &invocation.session_id,
            )
            .map_err(failed)?;
        if context.scope().identity.agent() != Some(&invocation) {
            return Err(failed("Computer capability belongs to another execution"));
        }
        let original = if name == "state" {
            None
        } else {
            Some(authority.bind_original(&context).await?)
        };
        let call = Call {
            scope: context.scope().clone(),
            authority,
            operation: original,
        };
        #[cfg(test)]
        if let Some((value, change)) = browser_access::tests::capture(self, &call).await {
            return context.complete_change(value, change).map_err(failed);
        }
        if name == "state" {
            access::current(self, &call, "cua_repl").await?;
            return serde_json::to_value(self.sessions.state(&invocation.session_id).await)
                .map(HandlerValue::Json)
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
        let (configuration, _) = access::current(self, &call, tool).await?;
        let cancellation = context.scope().cancellation.child_token();
        let execute = async {
            if name == "evaluate" {
                access::resource_boundary(call.scope.sandbox_floor())?;
                access::approve(self, &call, &configuration, &cancellation).await?;
            }
            let interaction = self.sessions.get(&invocation.session_id)?;
            let result = self.evaluate(
                name,
                input,
                evaluate::EvaluationScope::new(call.clone(), context.resource_capturer()),
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
            Ok((value, change)) => context
                .complete_change(serde_json::to_value(value).map_err(failed)?, change)
                .map_err(failed),
            Err(ToolError::Failed(message)) => serde_json::to_value(ResultValue::Failed {
                message,
                state: self.sessions.state(&invocation.session_id).await,
            })
            .map(HandlerValue::Json)
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
    ) -> BoxFuture<'static, HandlerResult> {
        let owner = self.0.clone();
        Box::pin(async move {
            if owner.stopping.is_cancelled() || context.scope().cancellation.is_cancelled() {
                return Err(HandlerError::from("computer_closed".to_owned()));
            }
            let mut owned = owner
                .resources
                .reserve()
                .map_err(|error| HandlerError::from(message(error)))?;
            let mut caller = context
                .scope()
                .resources
                .reserve()
                .map_err(|error| HandlerError::from(message(error)))?;
            // The original accepted worker retains both cleanup fences if its observer disappears.
            tokio::spawn(async move {
                owned.start();
                caller.start();
                let result = AssertUnwindSafe(owner.call(&name, input, context))
                    .catch_unwind()
                    .await;
                let cleanup = if matches!(
                    result,
                    Err(_)
                        | Ok(Err(ToolError::Persistence(_)
                            | ToolError::CleanupUnconfirmed(_)
                            | ToolError::OperationCleanupUnconfirmed { .. }))
                ) {
                    Err("Computer cleanup unconfirmed".into())
                } else {
                    Ok(())
                };
                owned.complete(cleanup.clone());
                caller.complete(cleanup);
                result
                    .map_err(|_| HandlerError::Unknown {
                        diagnostic: "Computer worker panicked".into(),
                    })?
                    .map_err(|error| match error {
                        ToolError::OutcomeUnknown(_)
                        | ToolError::OperationUnknown { .. }
                        | ToolError::Persistence(_)
                        | ToolError::CleanupUnconfirmed(_)
                        | ToolError::OperationCleanupUnconfirmed { .. } => HandlerError::Unknown {
                            diagnostic: message(error),
                        },
                        error => HandlerError::from(message(error)),
                    })
            })
            .await
            .map_err(|error| HandlerError::Unknown {
                diagnostic: message(error),
            })?
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
        (!self.0.resources.has_pending()).then(|| Box::new(()) as _)
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let owner = self.0.clone();
        let retained = self.1.clone();
        owner.stopping.cancel();
        owner.tasks.close();
        Box::pin(async move {
            let native = owner.sessions.close().await.map_err(message);
            if native.is_err() {
                retained
                    .lock()
                    .unwrap()
                    .extend(sessions::retain_sources(&owner));
            }
            let work = owner.resources.settle().await.map_err(message);
            owner.tasks.wait().await;
            let result = work.and(native);
            if result.is_ok() {
                let confirmed = std::mem::take(&mut *retained.lock().unwrap());
                for original in confirmed {
                    original.confirm_cleanup();
                }
            } else {
                retained
                    .lock()
                    .unwrap()
                    .extend(sessions::retain_sources(&owner));
            }
            result
        })
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.0.stopping.cancel();
        self.0.tasks.close();
        self.1
            .lock()
            .unwrap()
            .extend(sessions::retain_sources(&self.0));
        // Dropping an unconfirmed token deliberately leaves its original material retained.
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(message(error))
}
