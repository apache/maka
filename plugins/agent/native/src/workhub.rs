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

//! Native WorkHub owns its coordinator Agent. Worker capabilities are ordinary
//! explicit service imports, never a dependency from the Agent back to itself.
use maka_agent_api::workhub::contract;
pub mod presets;
pub(crate) mod tasks;
mod watch;
use crate::{owner::Owner, service::Agent};
use contract::{Coordinator, Resolve};
use futures_util::future::BoxFuture;
use maka_capabilities::call::Scope;
use maka_capabilities::storage::Data;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_host_runtime::application::{
    Context, Handler, NativeActivation, NativeOwner, NativeRegistry,
};
use maka_plugin_core::{operation::RecoveryRef, runtime::Published};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

use contract::configuration_schema;
use maka_agent_api::workhub::{EXPORT, IMPLEMENTATION};
pub(crate) fn prompt(language: maka_agent_facts::language::Language) -> &'static str {
    use maka_agent_facts::language::Language;
    match language {
        Language::En => {
            "You are the WorkHub coordinator, organizing work through published worker capabilities."
        }
        Language::ZhCn => "你是 WorkHub 协调者，通过已发布的工作 Agent 能力组织工作。",
        Language::ZhTw => "你是 WorkHub 協調者，透過已發布的工作 Agent 能力組織工作。",
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    operation: RecoveryRef,
    workspace: crate::contract::DirectorySelection,
}
pub(crate) struct Hub {
    agent: Agent,
    key: String,
    tasks: tasks::Tasks,
}
fn namespace() -> Namespace {
    Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile)
        .expect("built-in WorkHub namespace")
}
pub fn provide(
    registry: &mut NativeRegistry,
    catalog: Arc<maka_providers::catalog::Catalog>,
) -> Result<(), String> {
    provide_inner(
        registry,
        catalog,
        #[cfg(test)]
        None,
    )
}
#[cfg(test)]
pub(crate) fn provide_captured(
    registry: &mut NativeRegistry,
    catalog: Arc<maka_providers::catalog::Catalog>,
    capture: Arc<dyn Fn(Arc<Owner>) + Send + Sync>,
) -> Result<(), String> {
    provide_inner(registry, catalog, Some(capture))
}
fn provide_inner(
    registry: &mut NativeRegistry,
    catalog: Arc<maka_providers::catalog::Catalog>,
    #[cfg(test)] capture: Option<Arc<dyn Fn(Arc<Owner>) + Send + Sync>>,
) -> Result<(), String> {
    registry.insert(
        maka_agent_api::workhub::IMPLEMENTATION.into(),
        Arc::new(move |context, settings| {
            let catalog = catalog.clone();
            #[cfg(test)]
            let capture = capture.clone();
            Box::pin(async move {
                let prepared = tasks::prepare(&context, settings);
                let (settings, tasks, additional, link) = match prepared {
                    Ok(value) => value,
                    Err(error) => {
                        return NativeActivation {
                            exports: Err(error),
                            owner: Arc::new(()),
                        };
                    }
                };
                match Owner::open_behavior(
                    context,
                    settings,
                    Some(crate::owner::BuiltinBehavior::WorkHub),
                    additional,
                    tasks.bindings(),
                    Some(tasks.graphs.clone()),
                    catalog,
                )
                .await
                {
                    Ok(agent) => {
                        #[cfg(test)]
                        if let Some(capture) = capture {
                            capture(agent.clone());
                        }
                        let owner = Arc::new(Hub {
                            key: format!("{}coordinator", agent.prefix),
                            agent: Agent(agent),
                            tasks,
                        });
                        owner.tasks.graphs.bind(&owner.agent.0);
                        let _ = link.set(Arc::downgrade(&owner));
                        NativeActivation {
                            exports: Ok(BTreeMap::from([
                                (
                                    EXPORT.into(),
                                    Published {
                                        contract: contract(),
                                        value: owner.clone() as Arc<dyn Handler>,
                                    },
                                ),
                                (
                                    crate::EXPORT.into(),
                                    Published {
                                        contract: crate::contract(),
                                        value: Arc::new(Agent(owner.agent.0.clone()))
                                            as Arc<dyn Handler>,
                                    },
                                ),
                            ])),
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
impl Hub {
    async fn intent(&self) -> Result<Option<Intent>, String> {
        match self
            .agent
            .0
            .store
            .plugin_data(&namespace(), &self.key)
            .await
            .map_err(|_| "workhub_store_unavailable")?
        {
            None => Ok(None),
            Some(record) => match record.data {
                Data::Present(value) => {
                    let intent: Intent =
                        serde_json::from_value(value).map_err(|_| "workhub_intent_invalid")?;
                    intent
                        .operation
                        .validate()
                        .map_err(|_| "workhub_intent_invalid")?;
                    if intent.operation.source.state_domain != self.agent.0.data_source.state_domain
                        || intent.operation.source.deployment != self.agent.0.data_source.deployment
                        || intent.operation.namespace != self.agent.0.data_source.namespace
                        || intent.operation.export != EXPORT
                        || intent.operation.method != "resolve"
                        || intent.operation.contract.name != "maka.workhub.Coordinator"
                        || intent.operation.contract.version != 1
                    {
                        return Err("workhub_intent_invalid".into());
                    }
                    Ok(Some(intent))
                }
                Data::Deleted => Err("workhub_intent_removed".into()),
            },
        }
    }
    async fn observe(&self, intent: &Intent) -> Result<Coordinator, String> {
        let owner = &self.agent.0;
        let session = owner
            .store
            .get_session::<maka_agent_api::session::StoredSessionConfiguration>(
                &owner.operation_id(&intent.operation),
            )
            .await
            .map_err(|_| "workhub_store_unavailable")?;
        Ok(match session {
            Some(session) => Coordinator::Ready {
                session: Box::new(crate::service::summary(
                    owner,
                    crate::owner::resolve_session(session)?,
                )),
            },
            None => Coordinator::Pending {
                workspace: intent.workspace.clone(),
            },
        })
    }
    async fn resolve(
        &self,
        input: Resolve,
        operation: RecoveryRef,
        scope: &Scope,
    ) -> Result<Coordinator, String> {
        let intent = match self.intent().await? {
            Some(intent) => intent,
            None => {
                // Validate the selected directory before committing the immutable
                // intent. A later replacement cannot retarget this coordinator.
                let roots = self.agent.0.workspace_roots.clone();
                let page = maka_workspace_support::query(
                    roots,
                    crate::contract::Directories::Children {
                        selection: input.workspace.clone(),
                        after: None,
                    },
                )
                .await;
                if !matches!(page, Ok(crate::contract::DirectoryPage::Children { .. })) {
                    return Ok(Coordinator::Rejected {
                        reason: crate::contract::Rejection::WorkspaceUnavailable,
                    });
                }
                let candidate = Intent {
                    operation,
                    workspace: input.workspace,
                };
                if scope.cancellation.is_cancelled() {
                    return Err("workhub_call_cancelled".into());
                }
                let commit = self
                    .agent
                    .0
                    .store
                    .plugin_data_batch(
                        &namespace(),
                        vec![Mutation {
                            key: self.key.clone(),
                            expected_revision: None,
                            data: Data::Present(
                                serde_json::to_value(&candidate)
                                    .map_err(|_| "workhub_encoding_failed")?,
                            ),
                        }],
                    )
                    .await;
                match commit {
                    Ok(_) => candidate,
                    Err(maka_event_log::StoreError::RevisionConflict { .. }) => {
                        self.intent().await?.ok_or("workhub_intent_unavailable")?
                    }
                    Err(_) => return Err("workhub_creation_unknown".into()),
                }
            }
        };
        let observed = self.observe(&intent).await?;
        if matches!(observed, Coordinator::Ready { .. }) {
            return Ok(observed);
        }
        if scope.cancellation.is_cancelled() {
            return Err("workhub_call_cancelled".into());
        }
        match self
            .agent
            .0
            .create(
                crate::contract::Create {
                    automatic_title: false,
                    tools: None,
                    title: "WorkHub".into(),
                    labels: vec![],
                    workspace: crate::contract::WorkspaceSelection::Directory {
                        selection: intent.workspace,
                    },
                },
                &intent.operation,
                scope,
            )
            .await?
        {
            crate::contract::Created::Created { session } => Ok(Coordinator::Ready { session }),
            crate::contract::Created::Rejected { reason } => Ok(Coordinator::Rejected { reason }),
        }
    }
}
impl Handler for Hub {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let hub = Self {
            agent: Agent(self.agent.0.clone()),
            key: self.key.clone(),
            tasks: self.tasks.clone(),
        };
        Box::pin(async move {
            // Retain the original Call's actual ticket through every SQL response;
            // dropping a transport observer cannot acknowledge a pending commit.
            let scope = context.scope().clone();
            let mut ticket = scope
                .resources
                .reserve()
                .map_err(|_| "workhub_call_closed")?;
            tokio::spawn(async move {
                ticket.start();
                let result = async {
                    if scope.cancellation.is_cancelled() {
                        return Err("workhub_call_cancelled".into());
                    }
                    if matches!(
                        method.as_str(),
                        "graph"
                            | "watchGraph"
                            | "graphWork"
                            | "graphResult"
                            | "graphHistory"
                            | "changeGraph"
                            | "graphReceipt"
                    ) {
                        return hub.graph_api(&method, input, &context).await;
                    }
                    if method == "watchTasks" || method == "watchTask" {
                        return hub.watch(input, method == "watchTask", &context).await;
                    }
                    if method == "presets" {
                        return serde_json::to_value(hub.presets().await?)
                            .map_err(|_| "workhub_output_invalid".into());
                    }
                    if method == "savePresets" {
                        context.operation().ok_or("workhub_mutation_required")?;
                        let input =
                            serde_json::from_value(input).map_err(|_| "workhub_input_invalid")?;
                        return serde_json::to_value(hub.save_presets(input).await?)
                            .map_err(|_| "workhub_output_invalid".into());
                    }
                    if method == "controls" {
                        let input: contract::ControlsRead =
                            serde_json::from_value(input).map_err(|_| "workhub_input_invalid")?;
                        return hub.controls(input.after).await;
                    }
                    if method == "control" {
                        let input: contract::ControlRead =
                            serde_json::from_value(input).map_err(|_| "workhub_input_invalid")?;
                        return hub
                            .control(
                                &input.control_id,
                                false,
                                scope.execution().cloned(),
                                scope.cancellation.clone(),
                            )
                            .await;
                    }
                    if method == "tasks" {
                        let input: contract::TasksRead =
                            serde_json::from_value(input).map_err(|_| "workhub_input_invalid")?;
                        return hub.task_list(input.after).await;
                    }
                    if method == "task" {
                        let input: contract::TaskRead =
                            serde_json::from_value(input).map_err(|_| "workhub_input_invalid")?;
                        return hub
                            .task(
                                &input.task_id,
                                false,
                                input.cursor,
                                scope.cancellation.clone(),
                            )
                            .await;
                    }
                    let result = match method.as_str() {
                        "coordinator" => match hub.intent().await? {
                            Some(intent) => hub.observe(&intent).await?,
                            None => Coordinator::Missing,
                        },
                        "resolve" => {
                            hub.resolve(
                                serde_json::from_value(input)
                                    .map_err(|_| "workhub_input_invalid")?,
                                context
                                    .operation()
                                    .ok_or("workhub_mutation_required")?
                                    .clone(),
                                &scope,
                            )
                            .await?
                        }
                        _ => return Err("workhub_method_unavailable".into()),
                    };
                    serde_json::to_value(result).map_err(|_| "workhub_output_invalid".into())
                }
                .await;
                ticket.complete(if hub.tasks.cleanup_failed() {
                    Err("workhub_cleanup_unconfirmed".into())
                } else {
                    Ok(())
                });
                result
            })
            .await
            .map_err(|_| "workhub_observation_unknown")?
        })
    }
}
impl NativeOwner for Hub {
    fn retiring(&self) {
        self.agent.0.retiring();
    }
    fn activated(&self) {
        self.agent.0.activated();
        self.tasks.start_notifications(&self.agent.0);
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        let guard = self.agent.0.prepare_retirement()?;
        (!self.tasks.cleanup_failed()).then_some(guard)
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let agent = self.agent.0.clone();
        let tasks = self.tasks.clone();
        Box::pin(async move {
            let result = agent.close().await;
            if tasks.cleanup_failed() {
                return Err("workhub_cleanup_unconfirmed".into());
            }
            result
        })
    }
}
