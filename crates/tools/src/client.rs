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

mod interactions;
use crate::{
    PreparationFuture, PreparedEffect, ToolCallContext, ToolDefinition, ToolHandler, ToolNesting,
    ToolPreparer, ToolRegistration, ToolSemantics,
};
use interactions::BoundForms;
pub use interactions::{ApprovalFuture, ClientInteractions, PermissionFuture};
use maka_client_capability::{
    Registry, Snapshot,
    broker::{Broker, CallError, ToolCall},
    proxy_tool_name,
};
use maka_runtime::{
    execution::SandboxMode, tool_call::ToolRejection, tool_output::ToolOutput, tools::ToolError,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// A run-owned capability snapshot; permission is captured separately per call.
/// Registry access is synchronous; no policy wait holds its mutation gate.
#[derive(Clone)]
pub struct ClientTools {
    permission_ceiling: Option<SandboxMode>,
    snapshot: Arc<Snapshot>,
    registry: Arc<Mutex<Registry>>,
    broker: Arc<Broker>,
    cwd: String,
    tools: BTreeMap<String, (usize, usize)>,
    interactions: Arc<dyn ClientInteractions>,
}
impl ClientTools {
    pub fn new(
        snapshot: Snapshot,
        registry: Arc<Mutex<Registry>>,
        broker: Arc<Broker>,
        cwd: String,
        interactions: Arc<dyn ClientInteractions>,
    ) -> Arc<Self> {
        let tools = snapshot
            .offers()
            .iter()
            .enumerate()
            .flat_map(|(offer_index, offer)| {
                offer
                    .offer()
                    .tools
                    .iter()
                    .enumerate()
                    .map(move |(tool_index, tool)| {
                        (
                            proxy_tool_name(&tool.server_id, &tool.name),
                            (offer_index, tool_index),
                        )
                    })
            })
            .collect();
        Arc::new(Self {
            permission_ceiling: None,
            snapshot: Arc::new(snapshot),
            registry,
            broker,
            cwd,
            tools,
            interactions,
        })
    }

    pub fn registrations(self: &Arc<Self>) -> Vec<ToolRegistration> {
        self.tools
            .iter()
            .map(|(name, (offer, tool))| {
                let descriptor = &self.snapshot.offers()[*offer].offer().tools[*tool];
                ToolRegistration {
                    definition: ToolDefinition {
                        freeform: None,
                        output_schema: None,
                        provider: None,
                        name: name.clone(),
                        description: descriptor
                            .description
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                format!(
                                    "MCP tool {} provided by {}",
                                    descriptor.name, descriptor.server_id
                                )
                            }),
                        input_schema: Value::Object(descriptor.input_schema.clone()),
                    },
                    nesting: ToolNesting::Nestable,
                    semantics: ToolSemantics::Parallel,
                    handler: ToolHandler::Prepared(self.clone()),
                }
            })
            .collect()
    }

    /// Invocation-bound SDK calls cannot widen their originally admitted mode.
    pub fn with_permission_ceiling(mut self: Arc<Self>, mode: SandboxMode) -> Arc<Self> {
        Arc::make_mut(&mut self).permission_ceiling = Some(mode);
        self
    }
}
impl ToolPreparer for ClientTools {
    fn names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let pending = (|| {
            let (offer_index, tool_index) =
                self.tools.get(&name).ok_or(ToolRejection::Unavailable)?;
            let offer = &self.snapshot.offers()[*offer_index];
            let descriptor = &offer.offer().tools[*tool_index];
            let Value::Object(arguments) = input else {
                return Err(ToolRejection::InvalidInput {
                    message: "Client Capability arguments must be an object".into(),
                });
            };
            let registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            let tool_call_id = context.tool_use_id();
            let registration =
                offer
                    .resolve(&registry)
                    .map_err(|error| ToolRejection::PreparationFailed {
                        message: error.to_string(),
                    })?;
            self.broker
                .prepare_tool(
                    registration.clone(),
                    ToolCall {
                        offer_id: offer.offer().offer_id.clone(),
                        server_id: descriptor.server_id.clone(),
                        tool_name: descriptor.name.clone(),
                        arguments,
                        source: maka_runtime::capability::CallSource::Agent {
                            session_id: context.invocation.session_id.clone(),
                            turn_id: context.invocation.turn_id.clone(),
                        },
                        tool_call_id,
                        cwd: self.cwd.clone(),
                    },
                    Duration::from_secs(150),
                    cancellation.clone(),
                )
                .map(|pending| (pending, registration, *offer_index, *tool_index))
                .map_err(rejected)
        })();
        let permission = self.interactions.sandbox_mode(context.clone());
        let ceiling = self.permission_ceiling;
        let snapshot = self.snapshot.clone();
        let interactions = self.interactions.clone();
        Box::pin(async move {
            let mode = match (permission.await?, ceiling) {
                (SandboxMode::ReadOnly, _) | (_, Some(SandboxMode::ReadOnly)) => {
                    SandboxMode::ReadOnly
                }
                (SandboxMode::WorkspaceWrite, _) | (_, Some(SandboxMode::WorkspaceWrite)) => {
                    SandboxMode::WorkspaceWrite
                }
                (mode, _) => mode,
            };
            let (pending, registration, offer_index, tool_index) = pending?;
            let accepted = pending.accepted().await.map_err(rejected)?;
            match mode {
                SandboxMode::ReadOnly => {
                    return Err(ToolRejection::PolicyDenied {
                        message: "Explore mode does not allow Client Capability tools".into(),
                    });
                }
                SandboxMode::DangerFullAccess => {}
                SandboxMode::WorkspaceWrite => {
                    let offer = &snapshot.offers()[offer_index];
                    let tool = &offer.offer().tools[tool_index];
                    let target = offer
                        .managed_target(
                            &registration,
                            &tool.server_id,
                            &tool.name,
                            accepted.evidence(),
                        )
                        .map_err(|error| ToolRejection::PolicyDenied {
                            message: error.to_string(),
                        })?;
                    if let Some(target) = target {
                        interactions
                            .approve(
                                target,
                                context.clone(),
                                cancellation,
                                accepted.provider_signal(),
                            )
                            .await?;
                    }
                }
            }
            let forms = Arc::new(BoundForms {
                interactions,
                context,
            });
            let effect: PreparedEffect = PreparedEffect::new(move |_| {
                Box::pin(async move {
                    let result = accepted.admit_with_interactions(forms).await.map_err(
                        |error| match error {
                            CallError::OutcomeUnknown(_) => {
                                ToolError::CleanupUnconfirmed(error.to_string())
                            }
                            _ => ToolError::Failed(error.to_string()),
                        },
                    )?;
                    Ok(ToolOutput::Mcp(result).into())
                })
            });
            Ok(effect)
        })
    }
}
fn rejected(error: CallError) -> ToolRejection {
    match error {
        CallError::Cancelled => ToolRejection::Cancelled,
        error => ToolRejection::PreparationFailed {
            message: error.to_string(),
        },
    }
}
