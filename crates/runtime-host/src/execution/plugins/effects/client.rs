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

use super::{Executions, Operation, Prepared, failed};
use maka_client_capability::{
    Registration,
    broker::{CallError, ToolCall},
    proxy_tool_name,
};
use maka_config::plugin_authorization::Boundary;
use maka_plugins::{
    authorization::Capability,
    call::{Identity, Scope},
    client_capability::Call,
    fiber::Context,
};
use maka_runtime::{
    capability::{Affinity, CallSource},
    tool_output::ToolOutput,
    tools::{ToolDefinition, ToolError},
};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct Selected {
    registration: Arc<Registration>,
    offer: usize,
    tool: usize,
    definition: ToolDefinition,
}

impl Executions {
    async fn resource_client_tools(
        &self,
        scope: &Scope,
    ) -> Result<BTreeMap<String, Selected>, ToolError> {
        let (has_session, ceiling) = match self.plugin_resource_target(scope).map_err(failed)? {
            super::super::ResourceTarget::Session(session) => {
                let ceiling = self
                    .log
                    .get_session::<crate::session::SessionConfiguration>(&session)
                    .await
                    .map_err(failed)?
                    .ok_or_else(|| failed("authorized Session is unavailable"))?
                    .configuration
                    .bound_tools;
                (true, ceiling)
            }
            super::super::ResourceTarget::Workspace(_) => (false, None),
        };
        let mut tools = BTreeMap::new();
        for registration in self
            .plugin_resource_clients(scope, Capability::ClientCapabilities)
            .await
            .map_err(failed)?
        {
            if !registration.available() {
                return Err(failed("pinned client provider is unavailable"));
            }
            for (offer_index, offer) in registration.manifest().offers.iter().enumerate() {
                // Independent work has no Agent Turn; a workspace grant also
                // cannot own Session-affine Client state.
                if offer.affinity == Affinity::Turn
                    || (offer.affinity == Affinity::Session && !has_session)
                {
                    continue;
                }
                for (tool_index, tool) in offer.tools.iter().enumerate() {
                    let name = proxy_tool_name(&tool.server_id, &tool.name);
                    if ceiling.as_ref().is_some_and(|names| !names.contains(&name)) {
                        continue;
                    }
                    let selected = Selected {
                        registration: registration.clone(),
                        offer: offer_index,
                        tool: tool_index,
                        definition: ToolDefinition {
                            freeform: None,
                            output_schema: None,
                            provider: None,
                            name: name.clone(),
                            description: tool.description.clone().unwrap_or_else(|| {
                                format!("Client tool {} provided by {}", tool.name, tool.server_id)
                            }),
                            input_schema: Value::Object(tool.input_schema.clone()),
                        },
                    };
                    if tools.insert(name, selected).is_some() {
                        return Err(failed("client tool selection is ambiguous"));
                    }
                }
            }
        }
        Ok(tools)
    }

    pub(crate) async fn plugin_resource_client_catalog(
        &self,
        owner: Context,
        scope: &Scope,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        let _lease = owner.admit().map_err(failed)?;
        Ok(self
            .resource_client_tools(scope)
            .await?
            .into_values()
            .map(|tool| tool.definition)
            .collect())
    }

    pub(crate) async fn plugin_resource_client(
        &self,
        owner: Context,
        scope: Scope,
        input: Call,
        cancellation: CancellationToken,
    ) -> Result<Value, ToolError> {
        let boundary = self
            .plugin_resource_boundary(&scope, Capability::ClientCapabilities)
            .await
            .map_err(failed)?;
        let (session_id, cwd) = match boundary {
            Boundary::Session { boundary, .. } => (Some(boundary.session_id), boundary.cwd),
            Boundary::Workspace { workspace, .. } => (None, workspace.host_cwd),
            Boundary::Profile | Boundary::Directory { .. } => {
                return Err(failed("client tools require a workspace"));
            }
        };
        let selected = self
            .resource_client_tools(&scope)
            .await?
            .remove(&input.name)
            .ok_or_else(|| failed("tool is not in the authorized client catalog"))?;
        jsonschema::options()
            .offline()
            .should_validate_formats(false)
            .build(&selected.definition.input_schema)
            .map_err(failed)?
            .validate(&Value::Object(input.input.clone()))
            .map_err(failed)?;
        let source = match &scope.identity {
            Identity::Remote { request_id } => CallSource::Remote {
                request_id: request_id.to_string(),
                session_id,
            },
            Identity::Background { grant } => CallSource::Background {
                grant_id: grant.0.to_string(),
                session_id,
            },
            Identity::Agent { .. } => {
                return Err(failed("Agent tools require their invocation journal"));
            }
        };
        let offer = &selected.registration.manifest().offers[selected.offer];
        let tool = &offer.tools[selected.tool];
        let tool_call_id = uuid::Uuid::new_v4().to_string();
        let operation = Operation::Client {
            input: input.clone(),
            provider: (**selected.registration.identity()).clone(),
            registration_id: selected.registration.manifest().registration_id.clone(),
            offer_id: offer.offer_id.clone(),
            tool_call_id: tool_call_id.clone(),
        };
        let pending = self
            .capabilities
            .broker
            .prepare_tool(
                selected.registration.clone(),
                ToolCall {
                    offer_id: offer.offer_id.clone(),
                    server_id: tool.server_id.clone(),
                    tool_name: tool.name.clone(),
                    arguments: input.input,
                    source,
                    tool_call_id,
                    cwd,
                },
                Duration::from_secs(150),
                cancellation.clone(),
            )
            .map_err(failed)?;
        let accepted = pending.accepted().await.map_err(failed)?;
        self.journal(
            owner,
            scope,
            Prepared {
                operation,
                capability: Capability::ClientCapabilities,
                effect: Box::new(move |_| {
                    Box::pin(async move {
                        accepted
                            .admit()
                            .await
                            .map(|result| ToolOutput::Mcp(result).into_json())
                            .map_err(|error| match error {
                                CallError::OutcomeUnknown(_) => {
                                    ToolError::CleanupUnconfirmed(error.to_string())
                                }
                                error => failed(error),
                            })
                    })
                }),
            },
            cancellation,
        )
        .await
    }
}
