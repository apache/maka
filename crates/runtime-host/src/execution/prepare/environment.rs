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

use super::{Executions, Result, SessionConfiguration, failure, internal, tools};
use maka_client_capability::{BindingMode, PreparedBindings};
use maka_protocol::OperationErrorCode as Code;
use maka_runtime::execution::SystemPrompt;

/// Candidate input, never execution authority. Files and schemas are prepared
/// without the admission gate; commit rechecks the mutable control basis.
pub(crate) struct Environment {
    session_id: String,
    digest: String,
    pub session: SessionConfiguration,
    pub backend: Backend,
    pub prompt: Option<SystemPrompt>,
    policy_revision: Option<u64>,
    prompt_capture: Option<maka_plugins::contributions::Captured>,
    pub composition: maka_runtime::execution::ToolComposition,
    bindings: Option<PreparedBindings>,
    directory: maka_fs_tools::workspace::directory::PublishedDirectory,
    input_catalog: maka_plugins::contributions::Catalog,
    workspace: maka_plugins::filesystem::ReadRoot,
    prepared_inputs: Vec<maka_plugins::input::Prepared>,
    cancellation: tokio_util::sync::CancellationToken,
}
pub(crate) enum Backend {
    Model(Box<ModelEnvironment>),
    Executor(maka_plugins::executor::Binding),
}
pub(crate) struct ModelEnvironment {
    behavior: Option<BehaviorBasis>,
    pub tools: maka_tools::ToolCatalog,
}

pub(crate) struct Admission {
    _inputs: Vec<maka_plugins::input::Admission>,
    _behavior: Option<maka_plugins::fiber::CallGuard>,
    _behavior_revision: Option<tokio::sync::OwnedRwLockReadGuard<u64>>,
    _prompt: Vec<maka_plugins::fiber::CallGuard>,
}

struct BehaviorBasis {
    source: maka_plugins::contributions::Contribution<maka_plugins::session::SessionBehavior>,
    revision: Option<maka_plugins::revision::Basis>,
}

impl Executions {
    pub(crate) async fn prepare_environment(
        &self,
        session_id: &str,
        connection: Option<uuid::Uuid>,
        mode: BindingMode,
        orchestration: Option<maka_runtime::execution::BehaviorId>,
    ) -> Result<Environment> {
        let record = self
            .log
            .get_session::<SessionConfiguration>(session_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
        self.prepare_environment_for(record, connection, mode, orchestration)
            .await
    }

    pub(in crate::execution) async fn prepare_environment_for(
        &self,
        record: maka_event_log::sessions::SessionRecord<SessionConfiguration>,
        connection: Option<uuid::Uuid>,
        mode: BindingMode,
        orchestration: Option<maka_runtime::execution::BehaviorId>,
    ) -> Result<Environment> {
        let session_id = &record.id;
        let mut session = record.configuration;
        if let Some(mode) = &orchestration {
            session.orchestration_mode = mode.clone();
        } else {
            session.orchestration_mode = session
                .orchestration_mode
                .for_collaboration(session.collaboration_mode)
                .map_err(internal)?;
        }
        if record.archived {
            return Err(failure(Code::SessionArchived, "Session is archived"));
        }
        self.prepare_worktree(&session).await?;
        let cwd = session.workspace.host_cwd.clone();
        let sandbox_mode = session.sandbox_mode;
        let origin = session.workspace_origin;
        let state_root = self.paths.state_root.clone();
        let workspace = tokio::task::spawn_blocking(move || {
            super::super::permissions::read_root(
                sandbox_mode,
                std::path::Path::new(&cwd),
                &state_root,
                origin,
            )
        })
        .await
        .map_err(internal)?
        .map_err(internal)?;
        use maka_protocol::session::CollaborationMode;
        if let crate::session::SessionTarget::Executor { executor_id, .. } = &session.target {
            if session.collaboration_mode != CollaborationMode::Agent {
                return Err(failure(
                    Code::OperationUnavailable,
                    "Executor does not support native collaboration modes",
                ));
            }
            let (bindings, _) = self
                .capabilities
                .prepare_tools(
                    session_id,
                    connection,
                    mode,
                    session.workspace.host_cwd.clone(),
                    self.interactions.clone(),
                )
                .map_err(binding_error)?;
            if orchestration.is_some() {
                return Err(failure(
                    Code::OperationUnavailable,
                    "Executor does not support native Turn orchestration",
                ));
            }
            let binding = self.executor_binding(session_id, executor_id)?;
            let policy = self
                .configuration
                .runtime_policy()
                .await
                .map_err(crate::server::configuration::failure)?;
            let captured = self
                .plugin_catalog
                .capture(&maka_plugins::composition::Scope::Session(
                    session_id.clone(),
                ));
            let base = session.initial_prompt("").map_err(internal)?;
            let resolved = maka_plugins::prompt::resolve(
                Some(&captured),
                base.as_ref().map(|prompt| prompt.text.as_str()),
                maka_plugins::prompt::Request {
                    target: maka_plugins::prompt::Target::Session {
                        session_id: session_id.clone(),
                        cwd: session.workspace.host_cwd.clone(),
                    },
                    cancellation: self.shutdown.child_token(),
                },
                Some(&workspace),
            )
            .await
            .map_err(internal)?;
            let prompt = resolved.system.map(|text| SystemPrompt {
                text,
                policy_revision: policy.revision,
                sources: resolved.sources,
            });
            let cwd = session.workspace.host_cwd.clone();
            let directory = tokio::task::spawn_blocking(move || {
                maka_fs_tools::workspace::directory::PublishedDirectory::open(std::path::Path::new(
                    &cwd,
                ))
            })
            .await
            .map_err(internal)?
            .map_err(internal)?;
            return Ok(Environment {
                session_id: session_id.clone(),
                composition: maka_runtime::execution::ToolComposition {
                    clients: bindings.composition(),
                    native_tools: Default::default(),
                    editing_tools: Default::default(),
                    private_clients: Default::default(),
                    bound_tools: session.bound_tools.clone(),
                },
                bindings: Some(bindings),
                digest: record.configuration_digest,
                session,
                backend: Backend::Executor(binding),
                policy_revision: Some(policy.revision),
                prompt_capture: Some(captured),
                prompt,
                directory,
                input_catalog: self.plugin_catalog.clone(),
                workspace,
                prepared_inputs: Vec::new(),
                cancellation: self.shutdown.child_token(),
            });
        }
        let (behavior, basis) = {
            let snapshot = self
                .plugin_catalog
                .capture(&maka_plugins::composition::Scope::Session(
                    session_id.clone(),
                ))
                .typed::<maka_plugins::session::SessionBehavior>();
            let behavior = snapshot
                .entries
                .get(session.orchestration_mode.as_str())
                .ok_or_else(|| {
                    failure(
                        Code::OperationUnavailable,
                        "Selected behavior is not active",
                    )
                })?;
            let _lease = behavior.admit().map_err(internal)?;
            let cancellation = self.shutdown.child_token();
            let _cancel = cancellation.clone().drop_guard();
            let stopping = behavior.owner.stopping().map_err(internal)?;
            let prepare = behavior
                .value
                .behavior
                .prepare(maka_plugins::session::Request {
                    session: session.plugin_view(session_id.clone(), record.revision),
                    cancellation: cancellation.clone(),
                });
            let preparation = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(failure(Code::HostDraining, "Host is draining")),
                _ = stopping.cancelled() => return Err(failure(Code::OperationUnavailable, "Session behavior retired")),
                result = tokio::time::timeout(std::time::Duration::from_secs(10), prepare) =>
                    result.map_err(|_| failure(Code::OperationUnavailable, "Session behavior preparation timed out"))?
                        .map_err(internal)?,
            };
            preparation.validate().map_err(internal)?;
            let basis = BehaviorBasis {
                source: behavior.clone(),
                revision: preparation.basis.clone(),
            };
            (preparation, Some(basis))
        };
        let (bindings, mut additional) = match &behavior.required_clients {
            Some(clients) => self.capabilities.prepare_required_tools(
                session_id,
                connection,
                &clients
                    .required
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                &clients
                    .optional
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                session.workspace.host_cwd.clone(),
                self.interactions.clone(),
            ),
            None => self.capabilities.prepare_tools(
                session_id,
                connection,
                mode,
                session.workspace.host_cwd.clone(),
                self.interactions.clone(),
            ),
        }
        .map_err(binding_error)?;
        let private_clients = behavior
            .required_clients
            .as_ref()
            .map(|clients| clients.private.clone())
            .unwrap_or_default();
        for name in &private_clients {
            self.plugin_catalog
                .reserve::<maka_tools::plugins::PluginTool>(name)
                .map_err(internal)?;
        }
        additional.retain(|tool| !private_clients.contains(&tool.definition.name));
        additional.push(self.interactions.question_tool());
        let prompt = session
            .initial_prompt(&behavior.instructions)
            .map_err(internal)?;
        let mut native = self
            .native_tools(
                &session.workspace.host_cwd,
                session.tool_profile,
                session.workspace_origin,
            )
            .await?;
        native.set = behavior.native_tools;
        let ceiling = session.tool_ceiling(behavior.tool_ceiling);
        let native_ceiling = ceiling.clone();
        let mode = session.sandbox_mode;
        let (directory, tools) = tokio::task::spawn_blocking(move || {
            let directory = maka_fs_tools::workspace::directory::PublishedDirectory::open(
                std::path::Path::new(&native.cwd),
            )
            .map_err(internal)?;
            let tools = tools::catalog(native, mode, additional, native_ceiling.as_ref())?;
            Ok::<_, maka_protocol::OperationError>((directory, tools))
        })
        .await
        .map_err(internal)??;
        let tools = tools
            .with_plugins(
                self.plugin_catalog.clone(),
                maka_plugins::composition::Scope::Session(session_id.clone()),
                ceiling.clone(),
            )
            .map_err(internal)?;
        Ok(Environment {
            session_id: session_id.clone(),
            composition: maka_runtime::execution::ToolComposition {
                clients: bindings.composition(),
                native_tools: behavior.native_tools,
                editing_tools: Default::default(),
                private_clients,
                bound_tools: ceiling,
            },
            bindings: Some(bindings),
            backend: Backend::Model(Box::new(ModelEnvironment {
                behavior: basis,
                tools,
            })),
            digest: record.configuration_digest,
            session,
            prompt,
            policy_revision: None,
            prompt_capture: None,
            directory,
            input_catalog: self.plugin_catalog.clone(),
            workspace,
            prepared_inputs: Vec::new(),
            cancellation: self.shutdown.child_token(),
        })
    }
}

impl Environment {
    pub(in crate::execution) fn behavior_registration(&self) -> Option<uuid::Uuid> {
        match &self.backend {
            Backend::Model(model) => model
                .behavior
                .as_ref()
                .map(|basis| basis.source.registration_id()),
            Backend::Executor(_) => None,
        }
    }

    pub(in crate::execution) async fn expand(
        mut self,
        content: maka_runtime::input::MessageInput,
        selections: maka_runtime::input::Selections,
    ) -> Result<(
        Self,
        maka_runtime::input::MessageInput,
        super::super::input::Outcome,
    )> {
        let tools = match &self.backend {
            Backend::Model(model) => model
                .tools
                .resolve_plugins()
                .map_err(internal)?
                .names()
                .into_iter()
                .collect(),
            Backend::Executor(_) => Default::default(),
        };
        let (prepared, selection) = super::super::input::prepare(
            &self.input_catalog,
            maka_plugins::input::Request {
                session_id: self.session_id.clone(),
                cwd: self.session.workspace.host_cwd.clone(),
                content,
                selections,
                tools,
                cancellation: self.cancellation.clone(),
            },
            &self.workspace,
        )
        .await?;
        let content = prepared.content.clone();
        self.prepared_inputs.push(prepared);
        Ok((self, content, selection))
    }
    /// Caller has repeated canonical replay/active/queue checks under admission.
    /// None requests a fresh preparation; it has performed no binding effect.
    pub(crate) async fn commit(
        mut self,
        executions: &Executions,
        session_id: &str,
    ) -> Result<Option<(Self, Admission)>> {
        let record = executions
            .log
            .get_session::<SessionConfiguration>(session_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
        if record.archived {
            return Err(failure(Code::SessionArchived, "Session is archived"));
        }
        if record.configuration_digest != self.digest {
            return Ok(None);
        }
        if let Some(revision) = self.policy_revision
            && executions
                .configuration
                .runtime_policy()
                .await
                .map_err(crate::server::configuration::failure)?
                .revision
                != revision
        {
            return Ok(None);
        }
        if executions.retiring() {
            return Err(failure(Code::HostDraining, "Host is draining"));
        }
        self.directory
            .validate(std::path::Path::new(&self.session.workspace.host_cwd))
            .map_err(internal)?;
        match &mut self.backend {
            Backend::Model(model) => {
                if model
                    .behavior
                    .as_ref()
                    .is_some_and(|basis| !basis.source.is_effective())
                {
                    return Err(failure(
                        Code::OperationUnavailable,
                        "Prepared Session behavior has retired",
                    ));
                }
            }
            Backend::Executor(binding) if !binding.is_effective() => {
                return Err(failure(Code::OperationUnavailable, "Executor was retired"));
            }
            Backend::Executor(_) => {}
        }
        let mut admission = Admission {
            _inputs: Vec::new(),
            _behavior: None,
            _behavior_revision: None,
            _prompt: Vec::new(),
        };
        if let (Some(captured), Some(prompt)) = (&self.prompt_capture, &self.prompt) {
            admission._prompt = maka_plugins::prompt::admit(captured, &prompt.sources)
                .map_err(|e| failure(Code::OperationUnavailable, &e.to_string()))?;
        }
        if let Backend::Model(model) = &self.backend
            && let Some(basis) = &model.behavior
        {
            admission._behavior = Some(basis.source.admit().map_err(internal)?);
            if let Some(revision) = &basis.revision {
                admission._behavior_revision = Some(revision.admit().ok_or_else(|| {
                    failure(
                        Code::OperationUnavailable,
                        "Prepared Session behavior changed",
                    )
                })?);
            }
        }
        for prepared in &self.prepared_inputs {
            let Some(guard) = prepared.admit().map_err(internal)? else {
                return Ok(None);
            };
            admission._inputs.push(guard);
        }
        if !executions
            .capabilities
            .commit_tools(self.bindings.take().expect("candidate binding"))
            .map_err(binding_error)?
        {
            return Ok(None);
        }
        Ok(Some((self, admission)))
    }
}

fn binding_error(error: maka_client_capability::BindingError) -> maka_protocol::OperationError {
    failure(
        if matches!(error, maka_client_capability::BindingError::Draining) {
            Code::HostDraining
        } else if matches!(
            error,
            maka_client_capability::BindingError::RequiredProvider
        ) {
            Code::OperationUnavailable
        } else {
            Code::OperationConflict
        },
        &error.to_string(),
    )
}
