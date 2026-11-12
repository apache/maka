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

pub(crate) mod files;
mod projects;
pub(crate) use projects::{Catalog, ClientGeneration, Prepared, Projects};

use crate::owner::access::RunAccess;
use maka_agent_api::{contract::WorkspaceAccess, session::ResolvedConfiguration};
use maka_agent_authority::permissions::Access;
use maka_agent_facts::{
    configuration::mcp::ServerConfiguration,
    tool_call::ToolRejection,
    tools::{
        PreparationFuture, PreparedEffect, ToolCallContext, ToolError, ToolHandler, ToolNesting,
        ToolPreparer, ToolRegistration, ToolSemantics,
    },
};
use maka_mcp::Connection;
use maka_tool_catalog::input::Projection;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct CleanupMaterial {
    _connections: Vec<Connection>,
    original: Vec<maka_mcp::CleanupMaterial>,
}
impl std::fmt::Debug for CleanupMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CleanupMaterial { original_servers: .. }")
    }
}
impl CleanupMaterial {
    /// Observe the same runtime owners; this issues neither another close nor an ACK.
    pub async fn closed(&self) -> Result<(), String> {
        futures_util::future::try_join_all(self.original.iter().map(|owner| owner.closed()))
            .await
            .map(|_| ())
    }
}
#[derive(Debug)]
pub(crate) struct StartupError {
    pub message: String,
    pub material: Option<CleanupMaterial>,
}
impl StartupError {
    fn clean(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            material: None,
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct CloseError {
    pub message: String,
    pub material: CleanupMaterial,
}
impl std::fmt::Display for StartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::fmt::Display for CloseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for StartupError {}
impl std::error::Error for CloseError {}

#[derive(Default)]
pub(crate) struct Servers {
    connections: Vec<Connection>,
    pub names: BTreeMap<String, Vec<String>>,
    pub registrations: Vec<ToolRegistration>,
    pub bindings: BTreeMap<String, Option<String>>,
    pub(super) live_bindings: Vec<LiveBinding>,
}
impl Servers {
    pub async fn open(
        configurations: &[ServerConfiguration],
        configuration: &maka_config::ConfigurationStore,
    ) -> Result<Self, StartupError> {
        Self::open_cancellable(configurations, configuration, CancellationToken::new()).await
    }
    pub async fn open_cancellable(
        configurations: &[ServerConfiguration],
        configuration: &maka_config::ConfigurationStore,
        cancellation: CancellationToken,
    ) -> Result<Self, StartupError> {
        let mut servers = Self::default();
        if configurations.is_empty() {
            return Ok(servers);
        }
        let mut names = BTreeSet::new();
        for config in configurations {
            maka_mcp::validate(config).map_err(StartupError::clean)?;
            if !names.insert(&config.name) {
                return Err(StartupError::clean("MCP server names must be unique"));
            }
        }
        let network = configuration
            .network_configuration()
            .await
            .map_err(|_| StartupError::clean("MCP network settings are unavailable"))?;
        let network =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| StartupError::clean("MCP network settings are invalid"))?;
        for config in configurations {
            let connection = match Connection::connect_cancellable(
                config.clone(),
                network.clone(),
                cancellation.clone(),
            )
            .await
            {
                Ok(connection) => connection,
                Err(error) => {
                    let mut message = format!("MCP server {}: {}", config.name, error.message);
                    let mut original: Vec<_> = error.material.into_iter().collect();
                    if let Err(cleanup) = servers.close().await {
                        message.push_str(&format!("; {}", cleanup.message));
                        original.extend(cleanup.material.original);
                    }
                    let material = (!original.is_empty()).then(|| CleanupMaterial {
                        _connections: servers.connections,
                        original,
                    });
                    return Err(StartupError { message, material });
                }
            };
            // A new external protocol session is a new authority generation.
            // Previously admitted work cannot silently acquire its replacement.
            let generation = format!("mcp:{}:{}", config.name, uuid::Uuid::new_v4());
            servers.names.insert(
                config.name.clone(),
                connection
                    .tools()
                    .iter()
                    .map(|tool| tool.definition.name.clone())
                    .collect(),
            );
            for tool in connection.tools() {
                let name = tool.definition.name.clone();
                let mut definition = tool.definition.clone();
                let (input_projection, input_schema) = Projection::project(definition.input_schema);
                definition.input_schema = input_schema;
                servers
                    .bindings
                    .insert(name.clone(), Some(generation.clone()));
                let live = LiveBinding {
                    definition,
                    binding: Binding {
                        connection: connection.clone(),
                        name,
                        remote_name: tool.remote_name.clone(),
                        server: config.name.clone(),
                        generation: generation.clone(),
                        preapproved: config.preapproved,
                        read_only: tool.read_only,
                        input_projection,
                    },
                };
                servers.registrations.push(live.declaration());
                servers.live_bindings.push(live);
            }
            servers.connections.push(connection);
        }
        Ok(servers)
    }
    pub async fn close(&self) -> Result<(), CloseError> {
        let mut message = None;
        let mut original = Vec::new();
        for connection in &self.connections {
            if let Err(cause) = connection.close().await {
                message.get_or_insert(cause.message);
                original.push(cause.material);
            }
        }
        match message {
            Some(message) => Err(CloseError {
                message,
                material: CleanupMaterial {
                    _connections: self.connections.clone(),
                    original,
                },
            }),
            None => Ok(()),
        }
    }
}
#[derive(Clone)]
pub(super) struct LiveBinding {
    definition: maka_agent_facts::tools::ToolDefinition,
    binding: Binding,
}
impl LiveBinding {
    pub(super) fn available(&self) -> bool {
        self.binding.connection.available()
    }
    pub(super) fn name(&self) -> &str {
        &self.definition.name
    }
    pub(super) fn declaration(&self) -> ToolRegistration {
        self.registration(ToolHandler::Declaration(self.definition.name.clone()))
    }
    pub(super) fn for_run(&self, access: Arc<RunAccess>) -> ToolRegistration {
        self.registration(ToolHandler::Prepared(Arc::new(RunBinding {
            binding: self.binding.clone(),
            access,
        })))
    }
    fn registration(&self, handler: ToolHandler) -> ToolRegistration {
        ToolRegistration {
            definition: self.definition.clone(),
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler,
        }
    }
}

#[derive(Clone)]
struct Binding {
    connection: Connection,
    name: String,
    remote_name: String,
    server: String,
    generation: String,
    preapproved: bool,
    read_only: bool,
    input_projection: Projection,
}
struct RunBinding {
    binding: Binding,
    access: Arc<RunAccess>,
}
pub(crate) fn require_compatible_floor(floor: &maka_sandbox::Sandbox) -> Result<(), &'static str> {
    if matches!(floor, maka_sandbox::Sandbox::Disabled) {
        Ok(())
    } else {
        Err(
            "IsolationUnavailable: this MCP server cannot prove compatibility with the Run's sandbox floor",
        )
    }
}
fn permitted(configuration: &ResolvedConfiguration, name: &str, read_only: bool) -> bool {
    configuration
        .tools
        .as_ref()
        .is_none_or(|names| names.iter().any(|allowed| allowed == name))
        && (configuration.permissions.access != WorkspaceAccess::ReadOnly || read_only)
}
impl ToolPreparer for RunBinding {
    fn names(&self) -> Vec<String> {
        vec![self.binding.name.clone()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let connection = self.binding.connection.clone();
        let access = self.access.clone();
        let expected = self.binding.name.clone();
        let remote = self.binding.remote_name.clone();
        let server = self.binding.server.clone();
        let generation = self.binding.generation.clone();
        let read_only = self.binding.read_only;
        let preapproved = self.binding.preapproved;
        let input_projection = self.binding.input_projection;
        Box::pin(async move {
            let target = access.target_for_context(&context).await.map_err(|error| {
                ToolRejection::PreparationFailed {
                    message: error.to_string(),
                }
            })?;
            if name != expected || !connection.available() {
                return Err(ToolRejection::Unavailable);
            }
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let floor = access
                .sandbox_floor(&context.call.origin)
                .await
                .map_err(|error| ToolRejection::PreparationFailed {
                    message: error.to_string(),
                })?;
            require_compatible_floor(&floor).map_err(|message| ToolRejection::PolicyDenied {
                message: message.into(),
            })?;
            let approval_input = (!preapproved).then(|| input.clone());
            let input = input_projection.decode(input)?;
            let live = access.live_configuration().await.map_err(|error| {
                ToolRejection::PreparationFailed {
                    message: error.to_string(),
                }
            })?;
            if !permitted(&live, &name, read_only) {
                return Err(ToolRejection::PolicyDenied {
                    message: "MCP tool is outside the current session permissions".into(),
                });
            }
            let approval = if !preapproved {
                let service = format!("MCP server {server}");
                let approval = if matches!(
                    target,
                    maka_agent_facts::durable::AuthorizationObligation::Tool { .. }
                ) {
                    access
                        .establish_service(
                            &context,
                            &name,
                            &remote,
                            &generation,
                            &service,
                            approval_input.as_ref().unwrap_or(&input),
                            &cancellation,
                        )
                        .await
                        .map(|(_, approval)| approval)
                } else {
                    access
                        .confirm_service(
                            &context,
                            &name,
                            &remote,
                            &generation,
                            &service,
                            approval_input.as_ref().unwrap_or(&input),
                            &cancellation,
                        )
                        .await
                }
                .map_err(|error| ToolRejection::PreparationFailed {
                    message: error.to_string(),
                })?;
                Some(approval)
            } else {
                None
            };
            let prepared = PreparedEffect::new(move |cancel| {
                Box::pin(async move {
                    access.target_for_context(&context).await?;
                    require_compatible_floor(&access.sandbox_floor(&context.call.origin).await?)
                        .map_err(|message| ToolError::Failed(message.into()))?;
                    let live = access.live_configuration().await?;
                    if !permitted(&live, &name, read_only) {
                        return Err(ToolError::Failed(
                            "MCP permissions changed before dispatch".into(),
                        ));
                    }
                    connection.call(remote, input, cancel).await
                })
            });
            Ok(match approval {
                Some(id) => prepared.requiring_approval(id),
                None => prepared,
            })
        })
    }
}
