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
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation, NativeContext,
    NativeOwner, NativeRegistry,
};
use maka_plugin_core::runtime::Published;
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

mod calls;
mod journal;
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
    agent: maka_external_agent::Agent,
    calls: Arc<calls::Calls>,
    processes: Arc<processes::Processes>,
    storage: Arc<storage::Storage>,
    namespace: String,
    journal: Arc<journal::Journal>,
    tasks: Arc<maka_plugin_core::work::resources::Resources>,
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
            source: persistence.source().clone(),
        });
        let processes = Arc::new(processes::Processes::new(
            calls.clone(),
            configuration.clone(),
        ));
        let storage = Arc::new(storage::Storage::new(
            store.clone(),
            namespace.clone(),
            maka_plugin_core::storage::Namespace::new(
                IMPLEMENTATION,
                maka_plugin_core::scope::Scope::Profile,
            )
            .expect("ACP storage namespace"),
        ));
        let journal = Arc::new(journal::Journal::new(
            storage.clone(),
            store.data_writer().map_err(|e| e.to_string())?,
        ));
        Ok(Self {
            agent: configuration.agent,
            calls,
            processes,
            storage,
            namespace,
            journal,
            tasks: Arc::default(),
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
    ) -> BoxFuture<'static, HandlerResult> {
        let owner = self.0.clone();
        let context = Arc::new(context);
        Box::pin(async move {
            match method.as_str() {
                "setup" => setup::run(owner, input, context)
                    .await
                    .map(HandlerValue::Json)
                    .map_err(HandlerError::from),
                "observe" => {
                    let input: maka_agent_api::executor::Observe =
                        serde_json::from_value(input).map_err(|e| e.to_string())?;
                    owner
                        .journal
                        .observe(
                            &context,
                            input.task_id,
                            input.after_index,
                            None,
                            &owner.calls,
                        )
                        .await
                }
                "execute" => execute(owner, input, context).await,
                _ => Err("ACP method unavailable".into()),
            }
        })
    }
}
async fn frozen_input(
    input: &maka_agent_api::executor::Execute,
    context: &Context,
) -> Result<Value, String> {
    let attachments = context.attachments().clone();
    let resources = tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        let mut descriptors = BTreeMap::new();
        for (slot, resource) in attachments {
            let mut digest = Sha256::new();
            for start in (0..resource.bytes()).step_by(64 * 1024) {
                digest.update(resource.read(start..(start + 64 * 1024).min(resource.bytes()))?);
            }
            descriptors.insert(
                slot,
                serde_json::json!({
                    "type": resource.resource_type(), "encoding": resource.encoding(),
                    "bytes": resource.bytes(), "metadata": resource.metadata(),
                    "digest": hex::encode(digest.finalize()),
                }),
            );
        }
        Ok::<_, String>(descriptors)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({"input": input, "resources": resources}))
}
async fn execute(owner: Arc<Owner>, value: Value, context: Arc<Context>) -> HandlerResult {
    eprintln!("acp native: stage=execute_enter");
    context.operation().ok_or("ACP requires a mutation")?;
    let authority = context
        .native_context::<maka_agent_authority::executor::ExecutorCallContext>()
        .ok_or_else(|| {
            executor::Error::IsolationUnavailable(
                "ACP requires its original native ExecutorCallContext".into(),
            )
            .to_string()
        })?;
    authority
        .0
        .validate(&context)
        .await
        .map_err(|e| e.to_string())?;
    let execution = context
        .scope()
        .identity
        .agent()
        .ok_or("ACP requires an Agent execution")?
        .clone();
    let input: maka_agent_api::executor::Execute =
        serde_json::from_value(value).map_err(|e| e.to_string())?;
    if input.task_id != authority.0.task_id() || &input.execution != authority.0.execution() {
        return Err("ACP input differs from its actual original task capability".into());
    }
    input.settings.validate().map_err(str::to_owned)?;
    let frozen = frozen_input(&input, &context).await?;
    let task_id = input.task_id;
    let key = journal::Journal::key(&context, task_id)?;
    let conversation_key = calls::digest(&(
        &owner.namespace,
        context.requester().instance(),
        &execution.session_id,
        task_id,
    ));
    let mut scope = owner
        .calls
        .issuer
        .issue_with(
            context.scope().identity.clone(),
            Arc::new(calls::Issued {
                origin: context.clone(),
                role: calls::Role::Runtime {
                    authority: authority.clone(),
                    journal: owner.journal.clone(),
                    key: key.clone(),
                },
                process: std::sync::Mutex::new(calls::ProcessSlot::Available),
            }),
            CancellationToken::new(),
        )
        .map_err(|e| e.to_string())?;
    scope
        .restrict_sandbox(context.scope().sandbox_floor())
        .map_err(|error| error.to_string())?;
    let mut ticket = context
        .scope()
        .resources
        .reserve()
        .map_err(|e| e.to_string())?;
    let mut worker = owner.tasks.reserve().map_err(|e| e.to_string())?;
    let (admitted, admission) = tokio::sync::oneshot::channel();
    let (finished, completion) = tokio::sync::oneshot::channel();
    let journal = owner.journal.clone();
    let origin = context.clone();
    let observer = journal.clone();
    let observer_calls = owner.calls.clone();
    tokio::spawn(async move {
        ticket.start();
        worker.start();
        let claim = journal.begin(&key, frozen, origin.clone()).await;
        let claimed = match claim {
            Ok(claimed) => {
                eprintln!("acp native: stage=journal_begin_return claimed={claimed}");
                let _ = admitted.send(Ok(()));
                claimed
            }
            Err(error) => {
                eprintln!("acp native: stage=journal_begin_failed");
                let _ = admitted.send(Err(error));
                let cleanup = scope.finish().await.map_err(|e| e.to_string());
                ticket.complete(cleanup.clone());
                worker.complete(cleanup);
                return;
            }
        };
        if !claimed {
            let cleanup = scope.finish().await.map_err(|e| e.to_string());
            ticket.complete(cleanup.clone());
            worker.complete(cleanup);
            let _ = finished.send(Ok(()));
            return;
        }
        let provider = maka_external_agent::Provider::new(
            owner.agent.clone(),
            maka_external_agent::ports::Ports {
                processes: owner.processes.clone(),
                storage: owner.storage.clone(),
                callbacks: owner.calls.clone(),
            },
        );
        let retired = authority.0.observation_retired();
        let (result, cancelled) = {
            let execution_future = provider.execute(
                executor::Request {
                    task_id,
                    language: input.language,
                    execution,
                    conversation_key,
                    content: input.message.into(),
                    cwd: input.cwd,
                    instructions: input.instructions,
                    settings: input.settings,
                },
                executor::Context {
                    cancellation: CancellationToken::new(),
                    output: Arc::new(journal::Output {
                        journal: journal.clone(),
                        key: key.clone(),
                        serial: tokio::sync::Mutex::new(()),
                    }),
                    call: Some(scope.clone()),
                },
            );
            tokio::pin!(execution_future);
            tokio::select! {
                biased;
                () = retired.cancelled() => {
                    eprintln!("acp native: stage=provider_select source=Retired");
                    (Err(executor::Error::Unknown), true)
                },
                () = origin.scope().cancellation.cancelled() => {
                    eprintln!("acp native: stage=provider_select source=OriginCancelled");
                    (Err(executor::Error::Unknown), true)
                },
                result = &mut execution_future => {
                    eprintln!("acp native: stage=provider_select source=ProviderReturned");
                    (result, false)
                },
            }
        };
        {
            let error_kind = match &result {
                Ok(_) => "None",
                Err(executor::Error::ObservationRetired) => "ObservationRetired",
                Err(executor::Error::Blocked { .. }) => "Blocked",
                Err(executor::Error::IsolationUnavailable(_)) => "IsolationUnavailable",
                Err(executor::Error::Unknown) => "Unknown",
                Err(executor::Error::Retired) => "Retired",
                Err(executor::Error::Cancelled) => "Cancelled",
                Err(executor::Error::CleanupUnconfirmed) => "CleanupUnconfirmed",
                Err(executor::Error::Invalid(_)) => "Invalid",
                Err(executor::Error::Persistence(_)) => "Persistence",
                Err(executor::Error::Provider(_)) => "Provider",
            };
            eprintln!(
                "acp native: stage=provider_return error_kind={error_kind} cancelled={cancelled}"
            );
        }
        let state = match &result {
            Ok(outcome) => maka_agent_api::executor::TaskState::Closed {
                outcome: outcome.clone(),
            },
            Err(error) => maka_agent_api::executor::TaskState::Unknown {
                diagnostic: error.to_string(),
            },
        };
        let business = journal.state(&key, state).await;
        let _ = finished.send(business.clone());
        let closing = if cancelled
            || matches!(
                &result,
                Err(executor::Error::ObservationRetired | executor::Error::Retired)
            ) {
            match authority.0.stop_requested().await {
                Ok(true) => owner.processes.close_task(&scope).await,
                Ok(false) => Ok(()),
                Err(error) => Err(format!("ACP Stop observation unavailable: {error}")),
            }
        } else {
            provider.close().await.map_err(|e| e.to_string())
        };
        // Retirement cancels Root I/O observation, never the private job itself.
        scope.cancellation.cancel();
        let physical = owner.processes.task_cleanup(&scope);
        let recorded = match physical {
            Ok(physical) => journal.cleanup(&key, physical).await,
            Err(error) => Err(error),
        };
        let callbacks = scope.resources.settle().await.map_err(|e| e.to_string());
        let process_root = owner.processes.settle_task(&scope).await;
        let cleanup = match (callbacks, process_root) {
            (Err(callback), Err(process)) => Err(format!(
                "ACP callback Root: {callback}; process Root: {process}"
            )),
            (Err(error), _) | (_, Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        };
        let recorded = recorded.and(match owner.processes.task_cleanup(&scope) {
            Ok(physical) => journal.cleanup(&key, physical).await,
            Err(error) => Err(error),
        });
        // Keep Root custody until callbacks and the original process have settled.
        if let Err(error) = &cleanup {
            ticket.unconfirmed(error.clone(), (origin, scope));
        } else {
            journal.root_settled(&key);
            ticket.complete(Ok(()));
        }
        // Logical observation failures are reported, not physical Root leases.
        eprintln!(
            "acp native: stage=worker_finish business_ok={} recorded_ok={} closing_ok={} cleanup_ok={}",
            business.is_ok(),
            recorded.is_ok(),
            closing.is_ok(),
            cleanup.is_ok()
        );
        worker.complete(cleanup);
    });
    admission.await.map_err(|_| HandlerError::Unknown {
        diagnostic: "ACP admission worker disappeared".into(),
    })??;
    observer
        .observe(
            &context,
            task_id,
            Some(0),
            Some(completion),
            &observer_calls,
        )
        .await
}
impl NativeOwner for Service {
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        (self.0.processes.is_idle() && self.0.journal.is_idle() && self.0.tasks.is_idle())
            .then(|| Box::new(()) as _)
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let owner = self.0.clone();
        Box::pin(async move {
            let processes = owner.processes.close_all().await;
            let tasks = owner.tasks.settle().await.map_err(|e| e.to_string());
            let storage = owner.storage.finish().await;
            processes.and(tasks).and(storage)
        })
    }
}
