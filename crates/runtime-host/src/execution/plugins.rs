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

mod admission;
mod attachment;
pub(super) use admission::AgentAdmission;
mod authority;
mod children;
mod client;
mod configure;
mod effects;
mod filesystem;
mod interactions;
mod llm;
mod messages;
mod network;
mod removal;
mod resume;
mod root;
mod submit;
use root::RootGrant;
mod catalog;
mod history;
mod import;
mod scopes;
mod usage;
pub(crate) use scopes::ResourceTarget;
mod workspace;

use super::Executions;
use crate::session::SessionConfiguration;
use futures_util::future::BoxFuture;
use maka_event_log::StoreError;
use maka_plugins::{
    composition::Scope,
    execution::{
        ChildSession, CommandError as Error, Commands, CreateChild, EventPage, Observation,
        Receipt, Submit,
    },
    fiber::Context,
    storage::Namespace,
};
use maka_runtime::{
    event::{EventWrite, Fact, InvocationInput, InvocationOutcome, RuntimeEvent},
    execution::SandboxMode,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

#[derive(Clone)]
struct Grant {
    workspace_origin: maka_runtime::execution::WorkspaceOrigin,
    boundary_revision: u64,
    sandbox_mode: SandboxMode,
    approval_policy: maka_runtime::execution::ApprovalPolicy,
    cwd: String,
}

/// Only Host can construct this capability; the caller supplies an explicit
/// Session allowlist. Empty grants confer no execution authority.
#[derive(Clone)]
struct BoundCommands {
    executions: Weak<Executions>,
    context: Context,
    namespace: Namespace,
    grants: Arc<Mutex<BTreeMap<String, Grant>>>,
    root_id: String,
    submission_stop: tokio_util::sync::CancellationToken,
    root_grant: Option<RootGrant>,
    consent: Option<maka_plugins::authorization::Id>,
    call: Option<maka_plugins::call::Scope>,
}

pub(crate) struct ProcessAdmission {
    pub cwd: String,
    pub command: maka_process::Command,
    pub gate: tokio::sync::OwnedMutexGuard<()>,
    pub boundary: maka_plugins::authorization::Boundary,
    pub sandbox: maka_sandbox::Sandbox,
}

impl Executions {
    pub(crate) async fn admit_plugin_process(
        &self,
        scope: &maka_plugins::call::Scope,
        input: &maka_plugins::process::Command,
        private_data: &std::path::Path,
    ) -> Result<ProcessAdmission, Error> {
        use maka_plugins::authorization::Boundary;
        input
            .validate()
            .map_err(|error| Error::Invalid(error.to_string()))?;
        let boundary = self.plugin_process_boundary(scope).await?;
        let cwd = match &boundary {
            Boundary::Session { boundary, .. } => boundary.cwd.clone(),
            Boundary::Workspace { workspace, .. } => workspace.host_cwd.clone(),
            Boundary::Profile | Boundary::Directory { .. } => return Err(Error::Denied),
        };
        let sandbox = self
            .plugin_process_sandbox(scope, &boundary, private_data)
            .await?;
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(|error| Error::Host(error.to_string()))?;
        let route =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|error| Error::Host(error.to_string()))?;
        let location = cwd.clone();
        let input = input.clone();
        #[cfg(windows)]
        let backend = Arc::new(crate::sandbox::windows::Backend::new(
            &self.paths.state_root,
            &std::env::current_exe().map_err(|error| Error::Host(error.to_string()))?,
        ));
        let (command, sandbox) = tokio::task::spawn_blocking(move || {
            let mut command = maka_process::Command::new(input.executable, &location);
            command.args(input.args);
            for (key, value) in input.env {
                command.env(key, value);
            }
            #[cfg(windows)]
            let command = command.with_backend(backend);
            #[cfg(target_os = "linux")]
            let command = command.with_network_helper(
                std::env::current_exe().map_err(|error| Error::Host(error.to_string()))?,
            );
            command
                .network_route(route)
                .sandbox(&sandbox)
                .map(|command| (command, sandbox))
                .map_err(|error| Error::Invalid(error.to_string()))
        })
        .await
        .map_err(|error| Error::Host(error.to_string()))??;
        // Pin this boundary through native preparation and spawn. The captured
        // command has no native resources before the accepted worker starts it.
        let gate = tokio::select! {
            biased;
            _ = scope.cancellation.cancelled() => return Err(Error::Revoked),
            gate = self.interactions.own_admission() => gate,
        };
        if self.plugin_process_boundary(scope).await? != boundary {
            return Err(Error::Denied);
        }
        Ok(ProcessAdmission {
            cwd,
            command,
            gate,
            boundary,
            sandbox,
        })
    }

    pub(crate) async fn plugin_process_sandbox(
        &self,
        scope: &maka_plugins::call::Scope,
        boundary: &maka_plugins::authorization::Boundary,
        private_data: &std::path::Path,
    ) -> Result<maka_sandbox::Sandbox, Error> {
        self.plugin_sandbox(scope, boundary, Some(private_data))
            .await
    }

    async fn plugin_sandbox(
        &self,
        scope: &maka_plugins::call::Scope,
        boundary: &maka_plugins::authorization::Boundary,
        private_data: Option<&std::path::Path>,
    ) -> Result<maka_sandbox::Sandbox, Error> {
        use maka_plugins::authorization::Boundary;
        let (cwd, mode, origin) = match boundary {
            Boundary::Session { boundary, .. } => (
                boundary.cwd.clone(),
                boundary.sandbox_mode,
                boundary.workspace_origin,
            ),
            Boundary::Workspace {
                workspace,
                sandbox_mode,
                origin,
                ..
            } => (workspace.host_cwd.clone(), *sandbox_mode, *origin),
            _ => return Err(Error::Denied),
        };
        let grants = match boundary {
            Boundary::Session { boundary, .. } if scope.identity.agent().is_some() => {
                self.plugin_permission_grants(scope, boundary.boundary_revision)
                    .await?
            }
            _ => Vec::new(),
        };
        let state_root = self.paths.state_root.clone();
        let private_data = private_data.map(std::path::Path::to_owned);
        tokio::task::spawn_blocking(move || {
            let cwd = std::path::Path::new(&cwd);
            let (mut sandbox, ceiling) = match private_data {
                Some(private_data) => super::permissions::resolve_plugin(
                    mode,
                    cwd,
                    &state_root,
                    origin,
                    &private_data,
                ),
                None => super::permissions::resolve(mode, cwd, &state_root, origin),
            }
            .map_err(|error| Error::Invalid(error.to_string()))?;
            for grant in grants {
                sandbox = sandbox
                    .with_grant(&grant.permissions, &ceiling)
                    .map_err(|error| Error::Invalid(error.to_string()))?;
            }
            Ok(sandbox)
        })
        .await
        .map_err(|error| Error::Host(error.to_string()))?
    }

    pub(crate) async fn plugin_process_boundary(
        &self,
        scope: &maka_plugins::call::Scope,
    ) -> Result<maka_plugins::authorization::Boundary, Error> {
        if scope.identity.agent().is_some() {
            self.plugin_execution_boundary(scope).await
        } else {
            self.plugin_resource_boundary(scope, maka_plugins::authorization::Capability::Processes)
                .await
        }
    }

    pub(crate) fn executor_binding(
        &self,
        session_id: &str,
        id: &maka_runtime::executor::ExecutorId,
    ) -> super::Result<maka_plugins::executor::Binding> {
        let contribution = self
            .plugin_catalog
            .snapshot::<maka_plugins::executor::Executor>(&Scope::Session(session_id.into()))
            .entries
            .remove(id.as_str())
            .ok_or_else(|| {
                super::failure(super::Code::OperationUnavailable, "Executor is not active")
            })?;
        maka_plugins::executor::Binding::new(session_id.into(), contribution)
            .map(|binding| binding.with_calls(self.plugin_calls.clone()))
            .map_err(super::internal)
    }

    pub(crate) fn plugin_store(
        self: &Arc<Self>,
        context: Context,
    ) -> Result<Arc<crate::plugins::storage::BoundStore>, maka_plugins::Error> {
        Ok(Arc::new(crate::plugins::storage::BoundStore::new(
            self.log.clone(),
            self.configuration.clone(),
            context,
            self.workers.clone(),
            self.shutdown.clone(),
        )?))
    }

    async fn observe_plugin(&self, receipt: Receipt) -> Result<Observation, Error> {
        self.log
            .plugin_execution_progress(receipt)
            .await
            .map_err(storage)
    }

    async fn cancel_plugin(self: &Arc<Self>, receipt: Receipt) -> Result<Observation, Error> {
        let admission = self.lock_admission().await;
        if !self.accepting() {
            return Err(Error::Draining);
        }
        let invocation = &receipt.invocation;
        if let Some(pending) = self
            .log
            .message_admission(&invocation.session_id, &receipt.message_id)
            .await
            .map_err(storage)?
        {
            if pending.invocation != *invocation {
                return Err(Error::Conflict);
            }
            // Initial root work is not a mutable queue entry. Settle its accepted
            // identity canonically before releasing admission; no model is started.
            let facts = [
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        content: pending.source.message.content.clone(),
                        request_fingerprint: None,
                        source_messages: vec![pending.source],
                    },
                },
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Cancelled {
                        source: "plugin_cancellation".into(),
                    },
                },
            ];
            let writes = facts
                .into_iter()
                .map(|fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| Error::Host(e.to_string()))?;
            self.log.append_batch(&writes).await.map_err(|e| {
                self.begin_drain();
                Error::OutcomeUnknown(e.to_string())
            })?;
        } else {
            drop(admission);
            self.stop(maka_protocol::turn::TurnStopInput {
                session_id: invocation.session_id.clone(),
                turn_id: invocation.turn_id.clone(),
                run_id: invocation.run_id.clone(),
            })
            .await
            .map_err(|e| Error::Host(e.message))?;
        }
        self.observe_plugin(receipt).await
    }
}

fn protocol(error: maka_protocol::OperationError) -> Error {
    use maka_protocol::OperationErrorCode as Code;
    match error.code {
        Code::SessionBusy => Error::Busy,
        Code::OperationConflict | Code::AlreadyResolved => Error::Conflict,
        Code::CommitOutcomeUnknown | Code::OutcomeUnknown => Error::OutcomeUnknown(error.message),
        Code::HostDraining => Error::Draining,
        Code::NotFound => Error::NotFound,
        Code::Unauthorized => Error::Denied,
        Code::InvalidRequest => Error::Invalid(error.message),
        Code::OperationUnavailable => Error::Unavailable(error.message),
        _ => Error::Host(error.message),
    }
}

impl BoundCommands {
    fn executions(&self) -> Result<Arc<Executions>, Error> {
        self.executions
            .upgrade()
            .filter(|host| host.accepting())
            .ok_or(Error::Draining)
    }

    async fn authorize(&self, host: &Executions, session: &str) -> Result<(), Error> {
        let current = self.authorize_session_control(host, session).await?;
        if host
            .log
            .session_retirement(session)
            .await
            .map_err(storage)?
            .is_some()
        {
            return Err(Error::Revoked);
        }
        if current.archived {
            return Err(Error::Denied);
        }
        Ok(())
    }

    /// Lifecycle control may inspect archived Sessions, but grants no execution.
    async fn authorize_session_control(
        &self,
        host: &Executions,
        session: &str,
    ) -> Result<maka_event_log::sessions::SessionRecord<SessionConfiguration>, Error> {
        self.authorize_origin(host).await?;
        if host
            .log
            .session_manager(session)
            .await
            .map_err(storage)?
            .is_some_and(|manager| manager != self.namespace)
        {
            return Err(Error::Denied);
        }
        let grant = self
            .grants
            .lock()
            .unwrap()
            .get(session)
            .cloned()
            .ok_or(Error::Denied)?;
        let current = host
            .log
            .get_session::<SessionConfiguration>(session)
            .await
            .map_err(storage)?
            .ok_or(Error::NotFound)?;
        if current.configuration.boundary_revision != grant.boundary_revision
            || current.configuration.sandbox_mode != grant.sandbox_mode
            || current.configuration.approval_policy != grant.approval_policy
            || current.configuration.workspace.host_cwd != grant.cwd
            || current.configuration.workspace_origin != grant.workspace_origin
        {
            return Err(Error::Denied);
        }
        Ok(current)
    }

    async fn receipt(&self, host: &Executions, operation: &str) -> Result<Receipt, Error> {
        let receipt = host
            .log
            .plugin_execution_receipt(&self.namespace, operation)
            .await
            .map_err(storage)?
            .ok_or(Error::NotFound)?;
        self.authorize(host, &receipt.invocation.session_id).await?;
        Ok(receipt)
    }
}

impl Commands for BoundCommands {
    fn remove_session(
        &self,
        request: maka_plugins::execution::RemoveSession,
    ) -> BoxFuture<'_, Result<maka_plugins::execution::RemovedSession, Error>> {
        Box::pin(self.remove(request))
    }
    fn removal_receipt(
        &self,
        session_id: String,
    ) -> BoxFuture<'_, Result<Option<maka_plugins::execution::RemovalReceipt>, Error>> {
        Box::pin(self.read_removal_receipt(session_id))
    }
    fn preview_removal(&self, session_id: String) -> BoxFuture<'_, Result<u64, Error>> {
        Box::pin(self.preview_session_removal(session_id))
    }
    fn copy_attachment(
        &self,
        source: Arc<dyn Commands>,
        request: maka_plugins::execution::CopyAttachment,
    ) -> BoxFuture<'_, Result<maka_runtime::attachment::AttachmentRef, Error>> {
        Box::pin(self.copy_attachment_from(source, request))
    }

    fn input(
        &self,
        invocation: maka_runtime::event::Invocation,
    ) -> BoxFuture<'_, Result<Option<maka_runtime::input::MessageInput>, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            self.authorize(&host, &invocation.session_id).await?;
            let boundary = host
                .log
                .run_boundary(&invocation.session_id, &invocation.run_id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?;
            if boundary.invocation != invocation {
                return Err(Error::NotFound);
            }
            Ok(match boundary.root_input() {
                maka_runtime::input::InvocationInput::Message { content, .. } => {
                    Some(content.clone())
                }
                _ => None,
            })
        })
    }

    fn resume(
        &self,
        request: maka_plugins::execution::Resume,
    ) -> BoxFuture<'_, Result<maka_runtime::event::Invocation, Error>> {
        Box::pin(async move {
            request
                .validate()
                .map_err(|error| Error::Invalid(error.to_string()))?;
            let host = self.executions()?;
            let lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let commands = self.clone();
            let (send, receive) = tokio::sync::oneshot::channel();
            host.workers.spawn(async move {
                let result = commands.resume_owned(request).await;
                drop(lease);
                let _ = send.send(result);
            });
            receive
                .await
                .map_err(|_| Error::OutcomeUnknown("continuation owner disappeared".into()))?
        })
    }

    fn configure(
        &self,
        input: maka_plugins::execution::Configure,
    ) -> BoxFuture<'_, Result<maka_plugins::execution::Configured, Error>> {
        Box::pin(BoundCommands::configure(self, input))
    }

    fn read_message(
        &self,
        message: maka_plugins::execution::SessionMessage,
    ) -> BoxFuture<'_, Result<Option<maka_plugins::execution::MessageState>, Error>> {
        Box::pin(BoundCommands::read_message(self, message))
    }

    fn enqueue(
        &self,
        request: maka_plugins::execution::Enqueue,
    ) -> BoxFuture<'_, Result<maka_plugins::execution::MessageReceipt, Error>> {
        Box::pin(self.enqueue_message(request))
    }
    fn message(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, maka_plugins::execution::MessageResult> {
        Box::pin(self.observe_message(operation_id))
    }
    fn retract(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, maka_plugins::execution::MessageResult> {
        Box::pin(self.retract_message(operation_id))
    }

    fn offer_interaction(
        &self,
        request: maka_plugins::execution::OfferInteraction,
    ) -> BoxFuture<'_, Result<maka_runtime::interaction::InteractionRecord, Error>> {
        Box::pin(self.offer(request))
    }
    fn interaction(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, Result<Option<maka_runtime::interaction::InteractionRecord>, Error>> {
        Box::pin(self.read_interaction(operation_id))
    }
    fn wait_interaction(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, Result<maka_runtime::interaction::InteractionOutcome, Error>> {
        Box::pin(self.wait_for_interaction(operation_id))
    }
    fn close_interaction(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, Result<maka_runtime::interaction::InteractionRecord, Error>> {
        Box::pin(self.withdraw_interaction(operation_id))
    }

    fn session(
        &self,
        session_id: String,
    ) -> BoxFuture<'_, Result<maka_plugins::session::View, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            // Observation grants no execution authority. Binding providers may
            // query it while the Host is admitting an already prepared run.
            // Mutating operations revalidate authorization under admission.
            self.authorize(&host, &session_id).await?;
            let record = host
                .log
                .get_session::<SessionConfiguration>(&session_id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?;
            Ok(record.configuration.plugin_view(record.id, record.revision))
        })
    }
    fn capabilities(
        &self,
        session_id: String,
    ) -> BoxFuture<'_, Result<maka_plugins::execution::SessionCapabilities, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let _gate = host.lock_admission().await;
            self.authorize(&host, &session_id).await?;
            let record = host
                .log
                .get_session::<SessionConfiguration>(&session_id)
                .await
                .map_err(storage)?
                .ok_or(Error::NotFound)?;
            let scope = maka_plugins::composition::Scope::Session(session_id);
            let tools = host
                .plugin_catalog
                .snapshot::<maka_tools::plugins::PluginTool>(&scope)
                .entries
                .into_keys()
                .filter(|name| {
                    record
                        .configuration
                        .bound_tools
                        .as_ref()
                        .is_none_or(|ceiling| ceiling.contains(name))
                })
                .collect();
            let executors = if record.configuration.bound_tools.is_none()
                && record.configuration.tool_profile.is_none()
            {
                host.plugin_catalog
                    .snapshot::<maka_plugins::executor::Executor>(&scope)
                    .entries
                    .into_keys()
                    .map(|name| {
                        name.try_into()
                            .map_err(|error: &'static str| Error::Invalid(error.to_string()))
                    })
                    .collect::<Result<_, _>>()?
            } else {
                Default::default()
            };
            Ok(maka_plugins::execution::SessionCapabilities { tools, executors })
        })
    }

    fn activity(
        &self,
        session_id: String,
    ) -> BoxFuture<'_, Result<maka_plugins::execution::Activity, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let _gate = host.lock_admission().await;
            self.authorize(&host, &session_id).await?;
            let boundary = match host.active_session_owner(&session_id) {
                Some(owner) => host
                    .log
                    .run_boundary(&session_id, &owner.run_id)
                    .await
                    .map_err(storage)?,
                None => host
                    .log
                    .latest_turn_boundary(&session_id)
                    .await
                    .map_err(storage)?,
            };
            let execution = match boundary {
                Some(boundary) => {
                    use maka_event_log::turns::InvocationState;
                    use maka_plugins::execution::{CurrentExecution, Progress};
                    let behavior = host
                        .log
                        .invocation_configuration(&boundary.invocation)
                        .await
                        .map_err(storage)?
                        .map(|configuration| configuration.orchestration_mode);
                    let progress = match boundary.state {
                        InvocationState::Admitted => Progress::Pending,
                        InvocationState::Running => Progress::Running,
                        InvocationState::WaitingForUser => Progress::WaitingForUser,
                        InvocationState::Ended {
                            outcome: InvocationOutcome::HandoffPaused { .. },
                            ..
                        } => Progress::Paused,
                        InvocationState::Ended { outcome, .. } => Progress::Ended { outcome },
                    };
                    Some(CurrentExecution {
                        invocation: boundary.invocation,
                        behavior,
                        progress,
                    })
                }
                None => None,
            };
            Ok(maka_plugins::execution::Activity {
                execution,
                busy: host.has_session_work(&session_id).await.map_err(storage)?,
            })
        })
    }

    fn stop(
        &self,
        invocation: maka_runtime::event::Invocation,
    ) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let gate = host.interactions.own_admission().await;
            let lease = self.context.admit().map_err(|_| Error::Revoked)?;
            self.authorize(&host, &invocation.session_id).await?;
            if !host.accepting() {
                return Err(Error::Draining);
            }
            let (send, receive) = tokio::sync::oneshot::channel();
            let worker = host.clone();
            // Retirement cannot detach an admitted control from its settlement.
            host.workers.spawn(async move {
                let result = worker
                    .retire_owner(&invocation)
                    .await
                    .map(|_| ())
                    .map_err(|error| match error.code {
                        maka_protocol::OperationErrorCode::CommitOutcomeUnknown => {
                            Error::OutcomeUnknown(error.message)
                        }
                        maka_protocol::OperationErrorCode::NotFound => Error::NotFound,
                        maka_protocol::OperationErrorCode::OperationConflict => Error::Conflict,
                        _ => Error::Host(error.message),
                    });
                drop(gate);
                drop(lease);
                let _ = send.send(result);
            });
            receive
                .await
                .map_err(|_| Error::OutcomeUnknown("execution control owner disappeared".into()))?
        })
    }

    fn validate_authority(&self) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            self.authorize_origin(&host).await?;
            let sessions = self
                .grants
                .lock()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            for session in sessions {
                self.authorize(&host, &session).await?;
            }
            Ok(())
        })
    }
    fn create_root(
        &self,
        request: maka_plugins::execution::CreateRoot,
    ) -> BoxFuture<'_, Result<ChildSession, Error>> {
        Box::pin(self.root(request))
    }
    fn restore_root(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, Result<Option<ChildSession>, Error>> {
        Box::pin(self.restore_created_root(operation_id))
    }
    fn import_session(
        &self,
        command: maka_plugins::session::import::Command,
    ) -> BoxFuture<'_, Result<maka_plugins::session::import::Receipt, Error>> {
        Box::pin(self.import_session_command(command))
    }
    fn abandon_revision(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, Result<maka_plugins::execution::RevisionDisposition, Error>> {
        Box::pin(self.abandon_created_revision(operation_id))
    }
    fn boundaries(&self) -> Result<Vec<maka_plugins::execution::SessionBoundary>, Error> {
        let _lease = self.context.resource_call().map_err(|_| Error::Revoked)?;
        Ok(self
            .grants
            .lock()
            .unwrap()
            .iter()
            .map(|(id, grant)| maka_plugins::execution::SessionBoundary {
                workspace_origin: grant.workspace_origin,
                session_id: id.clone(),
                boundary_revision: grant.boundary_revision,
                sandbox_mode: grant.sandbox_mode,
                approval_policy: grant.approval_policy,
                cwd: grant.cwd.clone(),
            })
            .collect())
    }
    fn workspace_patch(
        &self,
        operation_id: String,
    ) -> BoxFuture<'_, Result<Option<maka_plugins::execution::WorkspacePatch>, Error>> {
        Box::pin(self.export_workspace(operation_id))
    }
    fn artifact(
        &self,
        request: maka_plugins::execution::ReadArtifact,
    ) -> BoxFuture<'_, Result<Option<maka_plugins::execution::ArtifactChunk>, Error>> {
        Box::pin(async move {
            request
                .validate()
                .map_err(|e| Error::Invalid(e.to_string()))?;
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let receipt = self.receipt(&host, &request.operation_id).await?;
            Ok(host
                .log
                .execution_artifact(
                    &receipt.invocation,
                    &request.artifact_id,
                    request.offset,
                    request.limit,
                )
                .await
                .map_err(storage)?
                .map(|chunk| maka_plugins::execution::ArtifactChunk {
                    bytes: chunk.bytes,
                    total_bytes: chunk.total_bytes,
                }))
        })
    }
    fn event(
        &self,
        operation_id: String,
        event_id: String,
        through: u64,
    ) -> BoxFuture<'_, Result<Option<maka_runtime::event::StoredEvent>, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let receipt = self.receipt(&host, &operation_id).await?;
            host.log
                .execution_event(&receipt.invocation, &event_id, through)
                .await
                .map_err(storage)
        })
    }

    fn changes(&self) -> Result<tokio::sync::watch::Receiver<u64>, Error> {
        let host = self.executions()?;
        let _lease = self.context.resource_call().map_err(|_| Error::Revoked)?;
        Ok(host.log.subscribe_commits())
    }

    fn events(
        &self,
        operation_id: String,
        after: u64,
        through: u64,
    ) -> BoxFuture<'_, Result<EventPage, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let receipt = self.receipt(&host, &operation_id).await?;
            let page = host
                .log
                .session_events(
                    &receipt.invocation.session_id,
                    after,
                    through,
                    128,
                    1024 * 1024,
                )
                .await
                .map_err(storage)?;
            Ok(EventPage {
                // A logical Turn includes handoff successors, not unrelated
                // later work in the same child Session. Cursor still advances
                // over skipped records and never reinterprets a physical Run.
                events: page
                    .events
                    .into_iter()
                    .filter(|row| row.event.invocation.turn_id == receipt.invocation.turn_id)
                    .collect(),
                through_sequence: page.through_sequence,
                next_after: page.next_after,
            })
        })
    }

    fn restore_child(
        &self,
        request: CreateChild,
    ) -> BoxFuture<'_, Result<Option<ChildSession>, Error>> {
        Box::pin(BoundCommands::restore_child(self, request))
    }

    fn create_child(&self, request: CreateChild) -> BoxFuture<'_, Result<ChildSession, Error>> {
        Box::pin(self.child(request))
    }

    fn submit(&self, request: Submit) -> BoxFuture<'_, Result<Receipt, Error>> {
        Box::pin(self.submit_message(request))
    }

    fn query(&self, operation_id: String) -> BoxFuture<'_, Result<Observation, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let _lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let receipt = self.receipt(&host, &operation_id).await?;
            host.observe_plugin(receipt).await
        })
    }

    fn cancel(&self, operation_id: String) -> BoxFuture<'_, Result<Observation, Error>> {
        Box::pin(async move {
            let host = self.executions()?;
            let lease = self.context.admit().map_err(|_| Error::Revoked)?;
            let receipt = self.receipt(&host, &operation_id).await?;
            let (send, receive) = tokio::sync::oneshot::channel();
            let worker = host.clone();
            host.workers.spawn(async move {
                let result = worker.cancel_plugin(receipt).await;
                drop(lease);
                let _ = send.send(result);
            });
            receive
                .await
                .map_err(|_| Error::OutcomeUnknown("Host cancellation owner disappeared".into()))?
        })
    }
}

fn storage(error: StoreError) -> Error {
    match error {
        StoreError::EventConflict | StoreError::SessionConflict => Error::Conflict,
        StoreError::SessionBusy => Error::Busy,
        StoreError::SessionNotFound => Error::NotFound,
        StoreError::SessionRetired => Error::Revoked,
        StoreError::CommitUnknown(_) | StoreError::OperationUnknown => {
            Error::OutcomeUnknown(error.to_string())
        }
        _ => Error::Host(error.to_string()),
    }
}
