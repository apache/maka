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

//! Exact bidirectional protocol transport. The run mutation owns the process
//! until native exit; its progress reader is neither a handle lease nor a receipt.
use super::*;
use maka_agent_facts::interaction::PermissionCommand;
use maka_agent_facts::interaction::PermissionRequest;
use maka_plugin_core::runtime::Activation;
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

#[cfg(test)]
mod tests;
mod worker;
use maka_workspace_api::protocol::{
    CHUNK_BYTES, Completion, EXPORT, Input, Launch, Progress, Run, Stream, Written, contract,
};
pub(super) fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        maka_workspace_api::protocol::IMPLEMENTATION.into(),
        Arc::new(|context, input| {
            Box::pin(async move {
                match Processes::open(context, input).await {
                    Ok(owner) => NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            EXPORT.into(),
                            maka_plugin_core::runtime::Published {
                                contract: contract(),
                                value: Arc::new(Service(owner.clone())) as Arc<dyn Handler>,
                            },
                        )])),
                        owner: Arc::new(super::Service(owner)),
                    },
                    Err(error) => NativeActivation {
                        exports: Err(error),
                        owner: Arc::new(()),
                    },
                }
            })
        }),
    )
}
struct Write {
    bytes: Option<Vec<u8>>,
    reply: oneshot::Sender<Result<Written, String>>,
}
struct Control {
    consumer: Activation,
    boundary: Boundary,
    input: mpsc::Sender<Write>,
}
enum Boundary {
    Session {
        session: String,
        configuration: Box<ResolvedConfiguration>,
        sandbox: Sandbox,
    },
    Application {
        request: Uuid,
    },
}
#[derive(Default)]
pub(super) struct Controls(Mutex<BTreeMap<Uuid, Arc<Control>>>);
struct ControlResidency<'a> {
    controls: &'a Controls,
    id: Uuid,
}
impl Drop for ControlResidency<'_> {
    fn drop(&mut self) {
        self.controls.0.lock().unwrap().remove(&self.id);
    }
}
// A dropped active worker retains unknown physical custody. Before spawning or
// after confirmed drain, cancellation of bookkeeping must release that custody.
struct ProcessCustody {
    lease: Option<maka_event_log::root_store::SessionExecutionLease>,
    phase: ProcessPhase,
}
enum ProcessPhase {
    Unstarted,
    Active,
    Drained,
}
impl Drop for ProcessCustody {
    fn drop(&mut self) {
        if !matches!(self.phase, ProcessPhase::Active)
            && let Some(lease) = self.lease.take()
        {
            lease.finish();
        }
    }
}
pub(super) struct Service(pub(super) Arc<Processes>);
impl Handler for Service {
    fn call(
        &self,
        method: String,
        value: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let owner = self.0.clone();
        Box::pin(async move {
            context.operation().ok_or("protocol_requires_mutation")?;
            let mut ticket = context
                .scope()
                .resources
                .reserve()
                .map_err(|e| e.to_string())?;
            ticket.start();
            let result = match method.as_str() {
                "run" => match (serde_json::from_value(value), tool(&context)) {
                    (Ok(input), Ok(tool)) => owner
                        .run_owned(input, tool, &context)
                        .await
                        .and_then(|v| serde_json::to_value(v).map_err(failed)),
                    (Err(error), _) => Err(failed(error)),
                    (_, Err(error)) => Err(error),
                },
                "launch" => match serde_json::from_value(value) {
                    Ok(input) => owner
                        .launch(input, &context)
                        .await
                        .and_then(|v| serde_json::to_value(v).map_err(failed)),
                    Err(error) => Err(failed(error)),
                },
                "input" => match serde_json::from_value(value) {
                    Ok(input) => owner
                        .protocol_input(input, &context)
                        .await
                        .and_then(|v| serde_json::to_value(v).map_err(failed)),
                    Err(error) => Err(failed(error)),
                },
                _ => Err(failed("protocol_method_unavailable")),
            };
            let cleanup = match &result {
                Err(ToolError::CleanupUnconfirmed(message)) => {
                    owner.drain.cancel();
                    Err(message.clone())
                }
                _ => Ok(()),
            };
            ticket.complete(cleanup);
            result.map_err(|e| e.to_string())
        })
    }
}
fn tool(context: &Context) -> Result<ToolCallContext, ToolError> {
    Ok(ToolCallContext {
        execution: context.scope().execution().cloned(),
        invocation: context
            .scope()
            .identity
            .agent()
            .ok_or_else(|| failed("protocol_requires_agent"))?
            .clone(),
        operation_id: context
            .scope()
            .identity
            .operation_id()
            .ok_or_else(|| failed("protocol_requires_operation"))?
            .into(),
    })
}
impl Processes {
    async fn run_owned(
        &self,
        input: Run,
        mut tool: ToolCallContext,
        context: &Context,
    ) -> Result<Completion, ToolError> {
        // A protocol process may outlive the prompt that launched it. Capture
        // child custody before entering any asynchronous setup or dispatch;
        // copying the parent's token would expire when that prompt finishes.
        let lease = self
            .store
            .fork_execution(
                tool.execution
                    .as_deref()
                    .ok_or_else(|| failed("protocol_requires_execution_custody"))?,
                &tool.invocation,
            )
            .map_err(persistence)?;
        tool.execution = Some(match lease.store().execution_custody() {
            Ok(custody) => custody,
            Err(error) => {
                lease.finish();
                return Err(persistence(error));
            }
        });
        let mut custody = ProcessCustody {
            lease: Some(lease),
            phase: ProcessPhase::Unstarted,
        };
        self.run(input, &tool, context, &mut custody).await
    }

    async fn run(
        &self,
        input: Run,
        tool: &ToolCallContext,
        context: &Context,
        custody: &mut ProcessCustody,
    ) -> Result<Completion, ToolError> {
        cancelled(&context.scope().cancellation)?;
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        let command = maka_capabilities::process::Command {
            executable: input.executable,
            args: input.args,
            env: input.env,
            lifetime: maka_capabilities::process::Lifetime::Invocation,
        };
        command.validate().map_err(failed)?;
        if input.additional_permissions.is_some()
            && input
                .justification
                .as_ref()
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(failed(
                "Protocol process permissions require a justification",
            ));
        }
        let configuration = maka_agent_authority::permissions::live(
            &maka_agent_authority::permissions::execution(
                &self.store,
                &tool.invocation,
                tool.execution.as_deref(),
            )?,
            &tool.invocation,
        )
        .await?;
        let requested = input
            .additional_permissions
            .map(|permissions| PermissionRequest {
                reason: input.justification.expect("validated justification"),
                command: Some(PermissionCommand {
                    command: serde_json::to_string(&(&command.executable, &command.args))
                        .expect("command"),
                    cwd: configuration.workspace.path.clone(),
                }),
                permissions,
            });
        let captured = self
            .prepare(
                tool,
                &configuration,
                requested,
                &context.scope().cancellation,
            )
            .await?;
        let sandbox = captured.executor.sandbox().clone();
        let plan = tokio::task::spawn_blocking(move || {
            captured
                .executor
                .command_program(command.executable, &command.args, &command.env)
        })
        .await
        .map_err(failed)??;
        let id = Uuid::new_v4();
        let (input, receive) = mpsc::channel(8);
        let control = Arc::new(Control {
            consumer: context.requester().clone(),
            boundary: Boundary::Session {
                session: tool.invocation.session_id.clone(),
                configuration: Box::new(configuration.clone()),
                sandbox,
            },
            input,
        });
        {
            let mut controls = self.protocol.0.lock().unwrap();
            if controls.len() >= 32 {
                return Err(failed("Protocol process capacity exhausted"));
            }
            controls.insert(id, control);
        }
        let _residency = ControlResidency {
            controls: &self.protocol,
            id,
        };
        // The same SQL transaction checks the live invocation and captured
        // configuration, and retains Session removal until actual cleanup.
        let store = maka_agent_authority::permissions::execution(
            &self.store,
            &tool.invocation,
            tool.execution.as_deref(),
        )?;
        store
            .admit_session_process_for(&tool.invocation, id, &configuration.permission_basis())
            .await
            .map_err(persistence)?;
        custody.phase = ProcessPhase::Active;
        let result = worker::run(
            self,
            context,
            id,
            plan,
            receive,
            Some((&store, &configuration)),
        )
        .await;
        if result.is_ok() {
            custody.phase = ProcessPhase::Drained;
            // The worker has physically drained. A journal failure leaves
            // recovery work, not an unknown live process; SQL owns its pins.
            store.clean_session_process(id).await.map_err(persistence)?;
        }
        result
    }
    async fn launch(&self, input: Launch, context: &Context) -> Result<Completion, ToolError> {
        cancelled(&context.scope().cancellation)?;
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        let maka_capabilities::call::Identity::Remote { request_id } = context.scope().identity
        else {
            return Err(failed("protocol_launch_requires_application_request"));
        };
        let executor = self
            .setup
            .clone()
            .ok_or_else(|| failed("protocol_setup_directory_unavailable"))?;
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(|_| failed("Process network configuration unavailable"))?;
        let route =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| failed("Process network route unavailable"))?;
        let executor = executor.with_network_route(route);
        let command = maka_capabilities::process::Command {
            executable: input.executable,
            args: input.args,
            env: input.env,
            lifetime: maka_capabilities::process::Lifetime::Invocation,
        };
        command.validate().map_err(failed)?;
        let plan = tokio::task::spawn_blocking(move || {
            executor.command_program(command.executable, &command.args, &command.env)
        })
        .await
        .map_err(failed)??;
        let id = Uuid::new_v4();
        let (input, receive) = mpsc::channel(8);
        let control = Arc::new(Control {
            consumer: context.requester().clone(),
            boundary: Boundary::Application {
                request: request_id,
            },
            input,
        });
        {
            let mut controls = self.protocol.0.lock().unwrap();
            if controls.len() >= 32 {
                return Err(failed("Protocol process capacity exhausted"));
            }
            controls.insert(id, control);
        }
        let _residency = ControlResidency {
            controls: &self.protocol,
            id,
        };
        // The original mutation owns this application process through physical
        // exit. It is not an Agent invocation and creates no Session process row.
        worker::run(self, context, id, plan, receive, None).await
    }
    async fn protocol_input(&self, input: Input, context: &Context) -> Result<Written, ToolError> {
        if input.bytes.as_ref().is_some_and(|b| b.len() > CHUNK_BYTES) {
            return Err(failed("Protocol input exceeds 8 KiB"));
        }
        let control = self
            .protocol
            .0
            .lock()
            .unwrap()
            .get(&input.id)
            .cloned()
            .ok_or_else(|| failed("Protocol process unavailable"))?;
        if &control.consumer != context.requester() {
            return Err(failed("Protocol process belongs to another caller"));
        }
        if let Boundary::Application { request } = &control.boundary
            && (!matches!(context.scope().identity, maka_capabilities::call::Identity::Remote { request_id } if request_id == *request)
                || input.additional_permissions.is_some()
                || input.justification.is_some())
        {
            return Err(failed(
                "Protocol setup input belongs to another application request",
            ));
        }
        let capacity = tokio::select! {
            biased;
            () = context.scope().cancellation.cancelled() => return Err(failed("Protocol input cancelled")),
            capacity = control.input.clone().reserve_owned() => capacity.map_err(failed)?,
        };
        match &control.boundary {
            Boundary::Application { .. } => {}
            Boundary::Session {
                session,
                configuration,
                sandbox,
            } => {
                let tool = tool(context)?;
                if session != &tool.invocation.session_id {
                    return Err(failed("Protocol process belongs to another Session"));
                }
                let current = maka_agent_authority::permissions::live(
                    &maka_agent_authority::permissions::execution(
                        &self.store,
                        &tool.invocation,
                        tool.execution.as_deref(),
                    )?,
                    &tool.invocation,
                )
                .await?;
                if current.permission_basis() != configuration.permission_basis()
                    || current.workspace != configuration.workspace
                {
                    return Err(failed("Protocol process permissions changed"));
                }
                let requested = match input.additional_permissions {
                    Some(permissions) => {
                        let reason = input
                            .justification
                            .filter(|s| !s.trim().is_empty())
                            .ok_or_else(|| {
                                failed("Protocol process permissions require a justification")
                            })?;
                        Some(PermissionRequest {
                            reason,
                            command: None,
                            permissions,
                        })
                    }
                    None => None,
                };
                let captured = self
                    .prepare(&tool, &current, requested, &context.scope().cancellation)
                    .await?;
                if !captured
                    .executor
                    .sandbox()
                    .contains(sandbox)
                    .map_err(failed)?
                {
                    return Err(failed(
                        "Protocol process launch permissions are no longer available",
                    ));
                }
                let latest = maka_agent_authority::permissions::live(
                    &maka_agent_authority::permissions::execution(
                        &self.store,
                        &tool.invocation,
                        tool.execution.as_deref(),
                    )?,
                    &tool.invocation,
                )
                .await?;
                if latest.permission_basis() != current.permission_basis()
                    || latest.workspace != current.workspace
                {
                    return Err(failed(
                        "Protocol process permissions changed during input admission",
                    ));
                }
            }
        }
        cancelled(&context.scope().cancellation)?;
        let (reply, result) = oneshot::channel();
        capacity.send(Write {
            bytes: input.bytes,
            reply,
        });
        // Once enqueued, await the writer even on cancellation: a partial native
        // write is not a safe refusal and must retain the original operation.
        result.await.map_err(failed)?.map_err(failed)
    }
}
