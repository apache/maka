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

use super::*;
use maka_agent_api::{contract::WorkspaceAccess, session::ResolvedConfiguration};
use maka_agent_authority::computer::{
    ComputerAccess, ComputerAppObservation, ComputerAppStatus, NativeCallAccess, NativeCallContext,
};
use maka_agent_facts::{
    artifact::Artifact,
    interaction::{ComputerAppActivity, SessionGrant, SystemPermissionGrant},
};
use maka_agent_state::{
    artifacts::{ArtifactStore, SessionArtifactWrite, SessionScope},
    computer::{self, Consent},
};
use maka_host_runtime::application::Context;
use maka_plugin_core::{
    authorization::{Boundary, SessionBoundary},
    operation::RecoveryRef,
};
use tokio_util::sync::CancellationToken;

struct BoundCall {
    access: Arc<RunAccess>,
    call: ToolCallContext,
    target: AuthorizationObligation,
    tool: String,
    cancellation: CancellationToken,
    host_original: std::sync::OnceLock<RecoveryRef>,
}
impl RunAccess {
    pub(crate) async fn native_call(
        self: &Arc<Self>,
        call: ToolCallContext,
        tool: String,
        cancellation: CancellationToken,
        computer: bool,
    ) -> Result<Arc<NativeCallContext>, ToolError> {
        let target = self.target_for_context(&call).await?;
        self.check_tool(&call, &tool).await?;
        let bound = Arc::new(BoundCall {
            access: self.clone(),
            call,
            target,
            tool,
            cancellation,
            host_original: Default::default(),
        });
        Ok(Arc::new(if computer {
            NativeCallContext::Computer(bound)
        } else {
            NativeCallContext::Agent(bound)
        }))
    }
    pub(crate) async fn computer_output(&self, id: String) -> Result<Option<Vec<u8>>, ToolError> {
        let owner = self.owner().map_err(ToolError::Failed)?;
        let turn = self.execution.turn_id.clone();
        ArtifactStore::new(
            owner
                .store
                .data_writer_for_work(self.custody.as_ref(), &self.execution.session_id)
                .map_err(|e| ToolError::Persistence(e.to_string()))?,
        )
        .with_content(
            SessionScope {
                owner: self.spec.owner.clone(),
                session: self.execution.session_id.clone(),
            },
            id,
            move |record, reader| {
                use maka_agent_facts::artifact::{ArtifactKind, ArtifactSource};
                if record.turn_id != turn
                    || record.source != ArtifactSource::SessionEffect
                    || record.kind != ArtifactKind::File
                    || record.mime_type.as_deref() != Some("application/json")
                {
                    return Err(ToolError::Failed(
                        "Computer output differs from original producer".into(),
                    ));
                }
                let mut bytes = Vec::new();
                reader
                    .read_to_end(&mut bytes)
                    .map_err(|e| ToolError::Failed(e.to_string()))?;
                Ok(bytes)
            },
        )
        .await
        .map_err(|e| ToolError::Persistence(e.to_string()))?
        .transpose()
    }
}
impl BoundCall {
    fn id(&self, action: &str, operation: &str) -> FactId {
        let digest = Sha256::digest(
            serde_json::to_vec(&(&self.call.execution, &self.target, action, operation))
                .expect("native computer identity"),
        );
        let mut bytes: [u8; 16] = digest[..16].try_into().expect("SHA256 prefix");
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        FactId::try_from(Uuid::from_bytes(bytes)).expect("nonnil native computer fact")
    }
    fn native_binding_id(&self, epoch: &str, generation: &str, operation: &str) -> FactId {
        self.id(
            "native_binding",
            &serde_json::to_string(&(epoch, generation, operation))
                .expect("native binding identity"),
        )
    }
    fn time() -> UnixMillis {
        UnixMillis(now().try_into().expect("Unix milliseconds"))
    }
    fn store(&self) -> Result<computer::ComputerStore, ToolError> {
        let owner = self.access.owner().map_err(ToolError::Failed)?;
        let data = owner
            .store
            .data_writer_for_work(
                self.access.custody.as_ref(),
                &self.call.execution.session_id,
            )
            .map_err(|e| ToolError::Persistence(e.to_string()))?;
        Ok(computer::ComputerStore::new(data))
    }
    async fn original(&self, reference: &RecoveryRef) -> Result<(), ToolError> {
        self.current().await?;
        let operation_id = match &self.target {
            AuthorizationObligation::Tool { tool } => format!("{}:{}", tool.attempt, tool.call),
            AuthorizationObligation::Cell { cell, operation } => format!("cell:{cell}:{operation}"),
            AuthorizationObligation::External { task, operation } => {
                format!("external:{task}:{operation}")
            }
        };
        let operation = crate::tools::operation_uuid(&self.call.execution, &operation_id);
        if self.call.operation_id != operation_id || reference.operation != operation {
            return Err(ToolError::Failed(
                "Native original differs from actual call obligation".into(),
            ));
        }
        let owner = self.access.owner().map_err(ToolError::Failed)?;
        let selection: crate::tools::SelectionSnapshot = owner
            .run_content(self.call.execution.run_id, &self.access.spec.tool_selection)
            .await
            .map_err(|error| ToolError::Persistence(error.to_string()))?;
        let selected = selection
            .selected_service(&owner.services, &owner.tool_basis, &self.tool)
            .map_err(ToolError::Failed)?
            .ok_or_else(|| {
                ToolError::Failed("Native original has no captured service selection".into())
            })?;
        let request = selected
            .1
            .request_with_work(
                maka_capabilities::call::Identity::Agent {
                    execution: self.call.execution.clone(),
                    operation_id: Some(operation_id.clone()),
                },
                self.cancellation.child_token(),
                self.access.custody.clone(),
            )
            .map_err(ToolError::Failed)?;
        let request = self.access.track_binding_request(request).await;
        let lookup = match request.lookup_intent(operation) {
            Ok(observer) => observer.await.map_err(ToolError::Failed),
            Err(error) => Err(ToolError::Failed(error)),
        };
        self.access.settle_binding_request(&request).await?;
        let intent = lookup?
            .filter(|intent| intent.reference == *reference)
            .ok_or_else(|| ToolError::Failed("Native original caller intent differs".into()))?;
        selection
            .validate_recovery_service(
                &owner.services,
                &owner.tool_basis,
                &intent,
                &self.call.execution,
                &operation_id,
                &selected,
            )
            .map_err(ToolError::Failed)
    }
    async fn subject(&self, operation: &str) -> Result<computer::Subject, ToolError> {
        let subject = self
            .store()?
            .subject(&self.call.execution.session_id, operation)
            .await
            .map_err(|e| ToolError::Persistence(e.to_string()))?
            .ok_or_else(|| ToolError::Failed("Computer source was not observed".into()))?;
        if subject.activity.execution != self.call.execution || subject.target != self.target {
            return Err(ToolError::Failed(
                "Computer source belongs to another call".into(),
            ));
        }
        Ok(subject)
    }
    fn status(value: computer::Status) -> ComputerAppStatus {
        ComputerAppStatus {
            stopped: value.stopped,
            granted: !matches!(value.consent, Consent::Absent),
            authority_revision: value.authority_revision,
        }
    }
}
impl Interactions for BoundCall {
    fn execution(&self) -> &ExecutionIdentity {
        &self.call.execution
    }
    fn changes(&self) -> Result<tokio::sync::watch::Receiver<()>, String> {
        self.access.changes()
    }
    fn read<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<InteractionRecord>, String>> {
        self.access.read(id)
    }
    fn establish<'a>(
        &'a self,
        record: &'a InteractionRecord,
    ) -> BoxFuture<'a, Result<InteractionRecord, String>> {
        Box::pin(async move {
            self.current().await.map_err(|e| e.to_string())?;
            match &record.request {
                InteractionRequest::Permissions { target, .. } => {
                    if target != &self.target {
                        return Err("permission target differs from actual native call".into());
                    }
                    let original = self
                        .host_original
                        .get()
                        .ok_or("Native permissions require their actual bound Host context")?;
                    self.access
                        .establish_for_host(record, &self.target, original)
                        .await
                }
                InteractionRequest::ClientCapability { .. }
                | InteractionRequest::SessionApproval { .. } => {
                    let original = self
                        .host_original
                        .get()
                        .ok_or("Native approval requires its actual bound Host context")?;
                    self.access
                        .establish_for_host(record, &self.target, original)
                        .await
                }
                InteractionRequest::ServiceApproval { .. } => {
                    self.access.establish_for_target(record, &self.target).await
                }
                _ => self.access.establish(record).await,
            }
        })
    }
    fn commit_outcome<'a>(
        &'a self,
        id: &'a str,
        outcome: InteractionOutcome,
    ) -> BoxFuture<'a, Result<InteractionRecord, String>> {
        self.access.commit_outcome(id, outcome)
    }
}
impl Access for BoundCall {
    fn permission_request_original(&self) -> Result<Option<&RecoveryRef>, ToolError> {
        self.host_original.get().map(Some).ok_or_else(|| {
            ToolError::Failed("Native permissions require their actual bound Host context".into())
        })
    }
    fn live_configuration(&self) -> BoxFuture<'_, Result<ResolvedConfiguration, ToolError>> {
        self.current()
    }
    fn permission_grants<'a>(
        &'a self,
        target: &'a AuthorizationObligation,
        basis: &'a PermissionBasis,
    ) -> BoxFuture<'a, Result<Vec<PermissionGrant>, ToolError>> {
        Box::pin(async move {
            if target != &self.target {
                return Err(ToolError::Failed(
                    "Permission target differs from actual native call".into(),
                ));
            }
            self.access.permission_grants(target, basis).await
        })
    }
}
impl NativeCallAccess for BoundCall {
    fn call(&self) -> &ToolCallContext {
        &self.call
    }
    fn run_owner(&self) -> &maka_agent_facts::durable::RunOwner {
        &self.access.spec.owner
    }
    fn target(&self) -> &AuthorizationObligation {
        &self.target
    }
    fn language(&self) -> maka_agent_facts::language::Language {
        self.access.spec.language
    }
    fn current(&self) -> BoxFuture<'_, Result<ResolvedConfiguration, ToolError>> {
        Box::pin(async move {
            self.access.check_tool(&self.call, &self.tool).await?;
            if self.access.target_for_context(&self.call).await? != self.target {
                return Err(ToolError::Failed("Native source changed".into()));
            }
            self.access.live_configuration().await
        })
    }
    fn bind_original<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<RecoveryRef, ToolError>> {
        Box::pin(async move {
            self.current().await?;
            let capsule = context
                .native_context::<NativeCallContext>()
                .ok_or_else(|| ToolError::Failed("Native caller context unavailable".into()))?;
            if !std::ptr::addr_eq(capsule.access(), self as &dyn NativeCallAccess)
                || context
                    .work_custody()
                    .is_none_or(|c| !Arc::ptr_eq(c, &self.access.custody))
            {
                return Err(ToolError::Failed(
                    "Native dispatch has different actual custody".into(),
                ));
            }
            let reference = context.operation().cloned().ok_or_else(|| {
                ToolError::Failed("Computer requires an original Host mutation".into())
            })?;
            if context
                .operation_scope()
                .is_none_or(|scope| scope.reference() != &reference)
            {
                return Err(ToolError::Failed(
                    "Original native dispatch proof unavailable".into(),
                ));
            }
            self.original(&reference).await?;
            let fact = match &self.target {
                AuthorizationObligation::Tool { tool } => Fact::ToolOriginalBound {
                    tool: tool.clone(),
                    reference: reference.clone(),
                },
                AuthorizationObligation::Cell { cell, operation } => Fact::Cell {
                    event: maka_agent_facts::cells::CellEvent::ChildBound {
                        cell: *cell,
                        operation: *operation,
                        reference: reference.clone(),
                    },
                },
                AuthorizationObligation::External { task, operation } => Fact::ExternalEffect {
                    event: maka_agent_facts::external_effects::ExternalEffectEvent::Bound {
                        key: maka_agent_facts::external_effects::ExternalEffectKey {
                            task: *task,
                            operation: *operation,
                        },
                        reference: reference.clone(),
                    },
                },
            };
            self.access
                .owner()
                .map_err(ToolError::Failed)?
                .durable
                .observe(
                    self.call.execution.run_id,
                    vec![maka_agent_state::Change {
                        id: self.id("native_original", &self.call.operation_id),
                        at: Self::time(),
                        fact,
                    }],
                    vec![],
                )
                .await
                .map_err(|e| ToolError::Persistence(e.to_string()))?;
            if self.host_original.get_or_init(|| reference.clone()) != &reference {
                return Err(ToolError::Failed(
                    "Native Host source changed its original reference".into(),
                ));
            }
            Ok(reference)
        })
    }
}
struct RetainedAudioPolicy {
    session: maka_event_log::root_store::SessionStore,
    basis: PermissionBasis,
    ceiling: maka_sandbox::Sandbox,
    stopping: CancellationToken,
}
impl maka_agent_authority::computer::SessionAudioRetention for RetainedAudioPolicy {
    fn current(&self) -> BoxFuture<'_, Result<bool, ToolError>> {
        Box::pin(async move {
            if self.stopping.is_cancelled()
                || !matches!(self.ceiling, maka_sandbox::Sandbox::Disabled)
            {
                return Ok(false);
            }
            let session = match self
                .session
                .get::<maka_agent_api::session::StoredSessionConfiguration>()
                .await
            {
                Ok(Some(session)) if !session.archived => session,
                Ok(_) | Err(maka_event_log::StoreError::ConnectionClosed) => return Ok(false),
                Err(error) => return Err(ToolError::Persistence(error.to_string())),
            };
            if self
                .session
                .session_retirement(self.session.id())
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?
                .is_some()
            {
                return Ok(false);
            }
            let configuration = maka_agent_authority::permissions::resolve_session(session)
                .map_err(|error| ToolError::Persistence(error.to_string()))?
                .configuration;
            // Current constrained native resources have no compatible isolation.
            // A prior Disabled floor cannot widen a tightened Session policy.
            Ok(configuration.permission_basis() == self.basis
                && configuration.permissions.access == WorkspaceAccess::DangerFullAccess
                && configuration
                    .tools
                    .as_ref()
                    .is_none_or(|tools| tools.iter().any(|tool| tool == "cua_repl")))
        })
    }
}
impl ComputerAccess for BoundCall {
    fn session_audio_retention<'a>(
        &'a self,
        basis: &'a PermissionBasis,
    ) -> BoxFuture<
        'a,
        Result<Arc<dyn maka_agent_authority::computer::SessionAudioRetention>, ToolError>,
    > {
        Box::pin(async move {
            let current = self.current().await?;
            if current.permission_basis() != *basis || self.host_original.get().is_none() {
                return Err(ToolError::Failed(
                    "Audio output lost its admitted original permission boundary".into(),
                ));
            }
            let owner = self.access.owner().map_err(ToolError::Failed)?;
            let session = owner
                .store
                .session(&self.call.execution.session_id)
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?;
            // This handle is deliberately not derived from the Run work lease.
            let retained: Arc<dyn maka_agent_authority::computer::SessionAudioRetention> =
                Arc::new(RetainedAudioPolicy {
                    session,
                    basis: *basis,
                    ceiling: self.access.spec.permission_ceiling.sandbox.clone(),
                    stopping: owner.stop.clone(),
                });
            Ok(retained)
        })
    }
    fn native_bound<'a>(
        &'a self,
        original: &'a RecoveryRef,
        source: maka_computer_use::NativeBindingSource,
        source_writer: maka_event_log::root_store::DataWriter,
    ) -> BoxFuture<'a, Result<maka_agent_authority::computer::NativeInterruptionSink, ToolError>>
    {
        Box::pin(async move {
            self.current().await?;
            self.native_admission().await?;
            if source.session() != self.call.execution.session_id
                || source.turn() != self.call.execution.turn_id
                || source.execution_correlation().as_str() != self.call.execution.run_id.to_string()
                || !self.store()?.same_root(&source_writer)
            {
                return Err(ToolError::Failed(
                    "Native binding belongs to another execution or Root".into(),
                ));
            }
            self.original(original).await?;
            let binding = self.native_binding_id(
                source.native_epoch(),
                source.generation(),
                source.operation_id(),
            );
            let store = computer::ComputerStore::new(source_writer);
            let change = computer::Change {
                id: binding,
                at: Self::time(),
                fact: computer::Fact::NativeSourceBound {
                    source: computer::NativeSource {
                        execution: self.call.execution.clone(),
                        target: self.target.clone(),
                        original: original.clone(),
                        native_epoch: source.native_epoch().into(),
                        generation: source.generation().into(),
                        operation: source.operation_id().into(),
                    },
                },
            };
            loop {
                let view = self.access.fresh().await.map_err(ToolError::Failed)?;
                match store
                    .append(
                        &self.access.claim,
                        Head::from(&view),
                        change.clone(),
                        vec![],
                    )
                    .await
                {
                    Ok(_) => break,
                    Err(maka_event_log::StoreError::RevisionConflict { .. }) => continue,
                    Err(error) => return Err(ToolError::Persistence(error.to_string())),
                }
            }
            let execution = self.call.execution.clone();
            let interruption = self.id("native_interrupted", &binding.to_string());
            let sink: maka_agent_authority::computer::NativeInterruptionSink =
                Arc::new(move |observed| {
                    let source = source.clone();
                    let store = store.clone();
                    let execution = execution.clone();
                    Box::pin(async move {
                        if observed.session() != source.session()
                            || observed.turn() != source.turn()
                            || observed.execution_correlation() != source.execution_correlation()
                            || observed.native_epoch() != source.native_epoch()
                            || observed.generation() != source.generation()
                            || observed.operation_id() != source.operation_id()
                        {
                            return Err(ToolError::Failed(
                                "Native interruption differs from its actual bound producer".into(),
                            ));
                        }
                        store
                            .native_interrupted(&execution, binding, interruption, Self::time())
                            .await
                            .map_err(|e| ToolError::Persistence(e.to_string()))?;
                        Ok(())
                    })
                });
            Ok(sink)
        })
    }
    fn native_admission(&self) -> BoxFuture<'_, Result<(), ToolError>> {
        Box::pin(async move {
            if self
                .store()?
                .native_turn_interrupted(&self.call.execution)
                .await
                .map_err(|e| ToolError::Persistence(e.to_string()))?
            {
                return Err(ToolError::Failed(
                    "Native input was physically interrupted in this turn".into(),
                ));
            }
            Ok(())
        })
    }
    fn boundary(&self) -> BoxFuture<'_, Result<Boundary, ToolError>> {
        Box::pin(async move {
            let current = self.current().await?;
            let origin = if current.workspace.worktree.is_some() {
                maka_sandbox::workspace::WorkspaceOrigin::Allocated
            } else {
                maka_sandbox::workspace::WorkspaceOrigin::Selected
            };
            let mode = match current.permissions.access {
                WorkspaceAccess::ReadOnly => maka_sandbox::Mode::ReadOnly,
                WorkspaceAccess::WorkspaceWrite => maka_sandbox::Mode::WorkspaceWrite,
                WorkspaceAccess::DangerFullAccess => maka_sandbox::Mode::DangerFullAccess,
            };
            Ok(Boundary::Session {
                boundary: SessionBoundary {
                    workspace_origin: origin,
                    session_id: self.call.execution.session_id.clone(),
                    boundary_revision: current.boundary_revision,
                    sandbox_mode: mode,
                    approval_policy: if current.permissions.request_permissions {
                        maka_sandbox::Approval::OnRequest
                    } else {
                        maka_sandbox::Approval::Never
                    },
                    cwd: current.workspace.path,
                },
                workspace_identity: current.workspace.identity,
            })
        })
    }
    fn client_grant<'a>(
        &'a self,
        target: &'a maka_agent_facts::interaction::GrantTarget,
    ) -> BoxFuture<'a, Result<Option<SessionGrant>, ToolError>> {
        Box::pin(async move {
            self.current().await?;
            self.access
                .owner()
                .map_err(ToolError::Failed)?
                .durable
                .interactions()
                .client_capability_grant(&self.call.execution.session_id, target)
                .await
                .map_err(|e| ToolError::Persistence(e.to_string()))
        })
    }
    fn observe_app<'a>(
        &'a self,
        original: &'a RecoveryRef,
        observation: ComputerAppObservation,
    ) -> BoxFuture<'a, Result<ComputerAppStatus, ToolError>> {
        Box::pin(async move {
            let current = self.current().await?;
            self.original(original).await?;
            if current.permissions.access == WorkspaceAccess::ReadOnly {
                return Err(ToolError::Failed(
                    "Read-only policy does not permit Computer Use".into(),
                ));
            }
            let capture = ContentBlob::json(&observation.capture)
                .map_err(|e| ToolError::Persistence(e.to_string()))?;
            let subject = computer::Subject {
                activity: ComputerAppActivity {
                    execution: self.call.execution.clone(),
                    operation_id: observation.native_operation_id.clone(),
                    target: observation.target,
                    display: observation.display,
                },
                basis: current.permission_basis(),
                allow_always: observation.allow_always,
                target: self.target.clone(),
                operation: original.clone(),
                capture: capture.reference().clone(),
            };
            let change = computer::Change {
                id: self.id("subject_observed", &observation.native_operation_id),
                at: Self::time(),
                fact: computer::Fact::SubjectObserved { subject },
            };
            loop {
                let view = self.access.fresh().await.map_err(ToolError::Failed)?;
                match self
                    .store()?
                    .append(
                        &self.access.claim,
                        Head::from(&view),
                        change.clone(),
                        vec![capture.clone()],
                    )
                    .await
                {
                    Ok(_) => break,
                    Err(maka_event_log::StoreError::RevisionConflict { .. }) => continue,
                    Err(e) => return Err(ToolError::Persistence(e.to_string())),
                }
            }
            self.app_status(&observation.native_operation_id).await
        })
    }
    fn app_status<'a>(
        &'a self,
        operation: &'a str,
    ) -> BoxFuture<'a, Result<ComputerAppStatus, ToolError>> {
        Box::pin(async move {
            self.current().await?;
            self.subject(operation).await?;
            self.store()?
                .status(&self.call.execution.session_id, operation)
                .await
                .map(Self::status)
                .map_err(|e| ToolError::Persistence(e.to_string()))
        })
    }
    fn request_app<'a>(
        &'a self,
        operation: &'a str,
    ) -> BoxFuture<'a, Result<InteractionRecord, ToolError>> {
        Box::pin(async move {
            let current = self.current().await?;
            if !current.permissions.request_permissions {
                return Err(ToolError::Failed(
                    "Current policy does not allow requesting app access".into(),
                ));
            }
            let subject = self.subject(operation).await?;
            let status = self.app_status(operation).await?;
            if status.stopped {
                return Err(ToolError::Failed("Computer application was stopped".into()));
            }
            let record = InteractionRecord {
                execution: self.call.execution.clone(),
                request_id: format!(
                    "computer_app_{}",
                    self.id(
                        "app_consent",
                        &format!("{operation}:{}", status.authority_revision)
                    )
                ),
                created_at: now(),
                outcome: None,
                request: InteractionRequest::ComputerApp {
                    tool_use_id: self.call.tool_use_id(),
                    native_operation_id: operation.into(),
                    target: subject.activity.target,
                    basis: subject.basis,
                    display: subject.activity.display,
                    allow_always: subject.allow_always,
                    authority_revision: status.authority_revision,
                },
            };
            self.access
                .publish(&record, None, vec![])
                .await
                .map_err(ToolError::Persistence)
        })
    }
    fn authorize_app<'a>(&'a self, operation: &'a str) -> BoxFuture<'a, Result<bool, ToolError>> {
        Box::pin(async move {
            self.current().await?;
            let subject = self.subject(operation).await?;
            let status = self
                .store()?
                .status(&self.call.execution.session_id, operation)
                .await
                .map_err(|e| ToolError::Persistence(e.to_string()))?;
            if status.stopped {
                return Err(ToolError::Failed("Computer application was stopped".into()));
            }
            let request = match status.consent {
                Consent::Absent => {
                    return Err(ToolError::Failed("Computer app consent is missing".into()));
                }
                Consent::FullAccess => None,
                Consent::Once { request }
                | Consent::Session { request }
                | Consent::Profile { request } => Some(request),
            };
            let change = computer::Change {
                id: self.id("app_authorized", operation),
                at: Self::time(),
                fact: computer::Fact::AppAuthorized {
                    source_operation: operation.into(),
                    request,
                    basis: subject.basis,
                },
            };
            loop {
                let view = self.access.fresh().await.map_err(ToolError::Failed)?;
                match self
                    .store()?
                    .append(
                        &self.access.claim,
                        Head::from(&view),
                        change.clone(),
                        vec![],
                    )
                    .await
                {
                    Ok(inserted) => return Ok(inserted),
                    Err(maka_event_log::StoreError::RevisionConflict { .. }) => continue,
                    Err(e) => return Err(ToolError::Persistence(e.to_string())),
                }
            }
        })
    }
    fn system_permission_observed<'a>(
        &'a self,
        request: &'a str,
        grants: Vec<SystemPermissionGrant>,
    ) -> BoxFuture<'a, Result<InteractionRecord, ToolError>> {
        Box::pin(async move {
            let record = self
                .read(request)
                .await
                .map_err(ToolError::Persistence)?
                .ok_or_else(|| ToolError::Failed("System permission request missing".into()))?;
            let InteractionRequest::SystemPermission {
                tool_use_id,
                grants: expected,
                ..
            } = &record.request
            else {
                return Err(ToolError::Failed("Not a system permission request".into()));
            };
            if *tool_use_id != self.call.tool_use_id()
                || expected.len() != grants.len()
                || !expected.iter().all(|g| grants.contains(g))
            {
                return Err(ToolError::Failed(
                    "System permission observation differs from original request".into(),
                ));
            }
            self.access
                .owner()
                .map_err(ToolError::Failed)?
                .durable
                .interactions()
                .commit_outcome(
                    &self.call.execution.session_id,
                    request,
                    InteractionOutcome::SystemPermissionGranted {
                        committed_at: now(),
                    },
                )
                .await
                .map_err(|e| ToolError::Persistence(e.to_string()))
        })
    }
    fn prepare_artifact<'a>(
        &'a self,
        original: &'a RecoveryRef,
        artifact: Artifact,
        bytes: Vec<u8>,
    ) -> BoxFuture<'a, Result<maka_event_log::root_store::DataChange, ToolError>> {
        Box::pin(async move {
            if artifact.session_id != self.call.execution.session_id
                || artifact.turn_id != self.call.execution.turn_id
            {
                return Err(ToolError::Failed(
                    "Computer artifact differs from original producer".into(),
                ));
            }
            let provenance=ContentBlob::json(&serde_json::json!({"kind":"computer_output","execution":self.call.execution,"call":self.call.call,"operationId":self.call.operation_id,"original":original})).map_err(|e|ToolError::Persistence(e.to_string()))?;
            let owner = self.access.owner().map_err(ToolError::Failed)?;
            Ok(ArtifactStore::new(
                owner
                    .store
                    .data_writer_for_work(
                        self.access.custody.as_ref(),
                        &self.call.execution.session_id,
                    )
                    .map_err(|e| ToolError::Persistence(e.to_string()))?,
            )
            .prepare_register(SessionArtifactWrite::new(
                SessionScope {
                    owner: self.access.spec.owner.clone(),
                    session: self.call.execution.session_id.clone(),
                },
                owner.operation_id(original),
                artifact,
                bytes,
                provenance,
            )))
        })
    }
}
