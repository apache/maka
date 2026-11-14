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

//! Live authority for one actual driver and accepted Root work scope.
mod computer;
#[cfg(test)]
pub(super) use computer::preview_fixture;
mod model;

use super::*;
use maka_agent_authority::permissions::{Access, PermissionGrant};
use maka_agent_facts::{
    durable::*,
    external_effects::{ExternalEffectDescriptor, ExternalEffectKey},
    interaction::{Decision, InteractionOutcome, InteractionRecord, InteractionRequest},
    tools::{ToolCallContext, ToolError},
};
use maka_agent_ports::execution::Interactions;
use maka_agent_state::{
    ContentBlob, DriverClaim, Head, fold::RunView, interactions::ApprovalBinding,
};
use maka_capabilities::call::Scope;
use maka_event_log::{SessionStore, root_store::SessionWorkLease};
use maka_plugin_core::work::WorkCustody;
use maka_sandbox::workspace::PermissionBasis;
use std::sync::Weak;

pub(crate) async fn reserved_sandbox_floor(
    store: &maka_event_log::RootStore,
    workspace: &Workspace,
) -> Result<maka_sandbox::Sandbox, String> {
    use maka_sandbox::{
        Network, Sandbox,
        filesystem::{Access, Policy, Rule},
    };
    let root = store.owned_root().map_err(|error| error.to_string())?;
    let root: std::path::PathBuf =
        maka_fs_tools::workspace::project::host_path(root.canonical_path())
            .map_err(|error| error.to_string())?
            .into();
    let workspace = workspace.clone();
    tokio::task::spawn_blocking(move || {
        let namespace = maka_sandbox::native_task_namespace().map_err(|error| error.to_string())?;
        let private = maka_workspace_support::private_rules(&workspace, &root)?;
        Sandbox::Managed {
            filesystem: Policy {
                default: Access::Write,
                rules: vec![Rule::subtree(namespace, Access::Deny)],
                deny_globs: vec![],
            },
            network: Network::Allowed,
        }
        .intersect(&Sandbox::Managed {
            filesystem: Policy {
                default: Access::Write,
                rules: private,
                deny_globs: vec![],
            },
            network: Network::Allowed,
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) struct RunAccess {
    pub(super) owner: Weak<Owner>,
    execution: ExecutionIdentity,
    spec: Arc<RunSpec>,
    claim: DriverClaim,
    _work: SessionStore,
    custody: Arc<dyn WorkCustody>,
    binding_requests: tokio::sync::Mutex<Vec<BindingRequest>>,
    model_tools: std::sync::OnceLock<(
        Arc<crate::mcp::Catalog>,
        maka_agent_facts::execution::ToolMode,
    )>,
}

struct BindingRequest {
    request: Arc<maka_host_runtime::application::NativeRequest>,
    signal_armed: bool,
}

impl Owner {
    pub(super) fn run_access(
        self: &Arc<Self>,
        spec: Arc<RunSpec>,
        claim: DriverClaim,
        lease: &SessionWorkLease,
    ) -> Result<Arc<RunAccess>, String> {
        let work = lease.store();
        if work.id() != spec.session_id || spec.owner != self.run_owner() {
            return Err("agent_work_scope_mismatch".into());
        }
        let custody = work.work_custody().map_err(|error| error.to_string())?;
        self.store
            .session_for_work(custody.as_ref(), &spec.session_id)
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(RunAccess {
            owner: Arc::downgrade(self),
            execution: ExecutionIdentity {
                session_id: spec.session_id.clone(),
                turn_id: spec.turn_id.clone(),
                run_id: claim.run(),
            },
            spec,
            claim,
            _work: work,
            custody,
            binding_requests: tokio::sync::Mutex::new(Vec::new()),
            model_tools: Default::default(),
        }))
    }

    pub(crate) async fn access_for_scope(&self, scope: &Scope) -> Result<Arc<RunAccess>, String> {
        let execution = scope.identity.agent().ok_or("agent_run_access_missing")?;
        let custody = scope.work_custody().ok_or("agent_work_custody_missing")?;
        let access = self
            .runs
            .state()
            .await
            .controls
            .get(&execution.session_id)
            .and_then(|control| control.access.upgrade())
            .ok_or("agent_run_access_expired")?;
        if access.execution != *execution || !Arc::ptr_eq(custody, &access.custody) {
            return Err("agent_run_access_mismatch".into());
        }
        self.store
            .session_for_work(custody.as_ref(), &execution.session_id)
            .map_err(|error| error.to_string())?;
        access
            .live_configuration()
            .await
            .map_err(|error| error.to_string())?;
        Ok(access)
    }
}

impl RunAccess {
    pub(crate) async fn track_binding_request(
        &self,
        request: maka_host_runtime::application::NativeRequest,
    ) -> Arc<maka_host_runtime::application::NativeRequest> {
        let request = Arc::new(request);
        self.binding_requests.lock().await.push(BindingRequest {
            request: request.clone(),
            signal_armed: false,
        });
        request
    }
    pub(crate) async fn settle_binding_request(
        &self,
        request: &Arc<maka_host_runtime::application::NativeRequest>,
    ) -> Result<(), ToolError> {
        request.scope().cancellation.cancel();
        request
            .scope()
            .resources
            .settle()
            .await
            .map_err(|error| ToolError::CleanupUnconfirmed(error.to_string()))?;
        self.binding_requests
            .lock()
            .await
            .retain(|original| !Arc::ptr_eq(&original.request, request));
        Ok(())
    }
    pub(super) async fn binding_cleanup_signals(
        &self,
    ) -> Vec<futures_util::future::BoxFuture<'static, ()>> {
        self.binding_requests
            .lock()
            .await
            .iter_mut()
            .filter(|original| !original.signal_armed)
            .map(|original| {
                original.signal_armed = true;
                let request = original.request.clone();
                Box::pin(async move {
                    let _settled = request.scope().resources.settle().await;
                }) as futures_util::future::BoxFuture<'static, ()>
            })
            .collect()
    }
    pub(super) async fn binding_cleanup_confirmed(
        &self,
    ) -> Result<bool, maka_agent_engine::RunError> {
        let mut original = self.binding_requests.lock().await;
        let mut index = 0;
        while index < original.len() {
            match original[index].request.scope().resources.seal() {
                Ok(true) => {
                    original.swap_remove(index);
                }
                Ok(false) => index += 1,
                Err(error) => {
                    return Err(maka_agent_engine::RunError::Tool(
                        ToolError::CleanupUnconfirmed(error.to_string()),
                    ));
                }
            }
        }
        Ok(original.is_empty())
    }
    pub(crate) fn claim(&self) -> &maka_agent_state::DriverClaim {
        &self.claim
    }
    fn owner(&self) -> Result<Arc<Owner>, String> {
        self.owner
            .upgrade()
            .ok_or_else(|| "agent_run_owner_closed".into())
    }
    pub(crate) fn execution(&self) -> &ExecutionIdentity {
        &self.execution
    }
    pub(crate) fn custody(&self) -> &Arc<dyn WorkCustody> {
        &self.custody
    }
    pub(crate) fn data_writer(&self) -> Result<maka_event_log::root_store::DataWriter, String> {
        self.owner()?
            .store
            .data_writer_for_work(self.custody.as_ref(), &self.execution.session_id)
            .map_err(|error| error.to_string())
    }
    pub(crate) fn state_root(&self) -> Result<std::path::PathBuf, ToolError> {
        let root = self
            .owner()
            .map_err(ToolError::Failed)?
            .store
            .owned_root()
            .map_err(|error| ToolError::Persistence(error.to_string()))?;
        let path = maka_fs_tools::workspace::project::host_path(root.canonical_path())
            .map_err(|error| ToolError::Failed(error.to_string()))?;
        Ok(path.into())
    }

    pub(crate) async fn workspace_sandbox_floor(&self) -> Result<maka_sandbox::Sandbox, ToolError> {
        self.resolve_sandbox_floor(false).await
    }

    pub(crate) async fn sandbox_floor(
        &self,
        origin: &maka_agent_facts::tool_call::ToolOrigin,
    ) -> Result<maka_sandbox::Sandbox, ToolError> {
        self.resolve_sandbox_floor(matches!(
            origin,
            maka_agent_facts::tool_call::ToolOrigin::External { .. }
                | maka_agent_facts::tool_call::ToolOrigin::CodeCell {
                    owner: maka_agent_facts::cells::CellOwner::External { .. },
                    ..
                }
                | maka_agent_facts::tool_call::ToolOrigin::CodeMode {
                    owner: maka_agent_facts::cells::CellOwner::External { .. },
                    ..
                }
        ))
        .await
    }

    async fn resolve_sandbox_floor(
        &self,
        protect_external_files: bool,
    ) -> Result<maka_sandbox::Sandbox, ToolError> {
        let current = self.live_configuration().await?;
        let workspace = current.workspace;
        let mode = current.permissions.access;
        let root = self.state_root()?;
        let ceiling = self.spec.permission_ceiling.sandbox.clone();
        let policy_workspace = workspace.clone();
        let floor = tokio::task::spawn_blocking(move || {
            let (live, _) = maka_workspace_support::sandbox(&policy_workspace, mode, &root)?;
            live.intersect(&ceiling).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| ToolError::Failed(error.to_string()))?
        .map_err(ToolError::Failed)?;
        if !protect_external_files {
            return Ok(floor);
        }
        let owner = self.owner().map_err(ToolError::Failed)?;
        let reserved = reserved_sandbox_floor(&owner.store, &workspace)
            .await
            .map_err(ToolError::Failed)?;
        floor
            .intersect(&reserved)
            .map_err(|error| ToolError::Failed(error.to_string()))
    }

    pub(crate) fn spec(&self) -> &RunSpec {
        &self.spec
    }

    pub(crate) async fn content(&self, reference: ContentRef) -> Result<Vec<u8>, ToolError> {
        self.owner()
            .map_err(ToolError::Failed)?
            .durable
            .content(self.execution.run_id, reference)
            .await
            .map_err(|error| ToolError::Persistence(error.to_string()))
    }
    pub(crate) async fn fresh(&self) -> Result<RunView, String> {
        let owner = self.owner()?;
        if owner.stop.is_cancelled() {
            return Err("agent_run_owner_closed".into());
        }
        owner
            .store
            .session_for_work(self.custody.as_ref(), &self.execution.session_id)
            .map_err(|error| error.to_string())?;
        let view = owner
            .durable
            .driver_frontier(&self.claim)
            .await
            .map_err(|error| error.to_string())?;
        if view.spec != *self.spec {
            return Err("agent_run_spec_mismatch".into());
        }
        Ok(view)
    }

    pub(super) async fn observation_configuration(
        &self,
    ) -> Result<ResolvedConfiguration, ToolError> {
        let owner = self.owner().map_err(ToolError::Failed)?;
        if owner.stop.is_cancelled() {
            return Err(ToolError::Failed("agent_run_owner_closed".into()));
        }
        owner
            .store
            .session_for_work(self.custody.as_ref(), &self.execution.session_id)
            .map_err(|error| ToolError::Failed(error.to_string()))?;
        let view = owner
            .durable
            .original_driver_frontier(&self.claim)
            .await
            .map_err(|error| ToolError::Failed(error.to_string()))?;
        if view.spec != *self.spec {
            return Err(ToolError::Failed("agent_run_spec_mismatch".into()));
        }
        self.current_configuration().await
    }
    async fn current_configuration(&self) -> Result<ResolvedConfiguration, ToolError> {
        let owner = self.owner().map_err(ToolError::Failed)?;
        let session = owner
            .session(&self.execution.session_id)
            .await
            .map_err(ToolError::Failed)?;
        if session.archived {
            return Err(ToolError::Failed("Run session is archived".into()));
        }
        let mut current = session.configuration;
        if current.binding.id != self.spec.permission_basis.binding.id
            || current.workspace.path != self.spec.workspace
        {
            return Err(ToolError::Failed("Run workspace binding changed".into()));
        }
        // Access mode is current configuration; actual effects enforce the Scope's sandbox floor.
        current.tools = intersect_tools(current.tools, self.spec.allowed_tools.clone());
        // These controls are granted by the registered Bot's identity.
        if let Some(tools) = &mut current.tools
            && owner.settings.bot
            && owner.bot.is(&self.execution.session_id)
        {
            tools.extend([bot::SEND_USER.to_owned(), bot::SLEEP.to_owned()]);
        }
        current.permissions.request_permissions &= self
            .spec
            .permission_ceiling
            .approval
            .allows(maka_sandbox::ApprovalKind::Permissions);
        Ok(current)
    }

    pub(super) fn select_live_tools(
        catalog: &maka_tools::ToolCatalog,
        configuration: &ResolvedConfiguration,
        discovery: bool,
    ) -> maka_tools::ToolCatalog {
        let excluded: Vec<_> = catalog
            .definitions()
            .filter(|tool| {
                configuration
                    .tools
                    .as_ref()
                    .is_some_and(|allowed| !allowed.contains(&tool.name))
            })
            .map(|tool| tool.name.as_str())
            .collect();
        let catalog = catalog.excluding(&excluded);
        if discovery {
            catalog.with_discovery()
        } else {
            catalog
        }
    }

    pub(crate) async fn check_context(&self, context: &ToolCallContext) -> Result<(), ToolError> {
        if context.execution != self.execution
            || context
                .custody
                .as_ref()
                .is_none_or(|custody| !Arc::ptr_eq(custody, &self.custody))
        {
            return Err(ToolError::Failed(
                "Tool call does not hold this driver's original work capability".into(),
            ));
        }
        self.live_configuration().await?;
        Ok(())
    }

    pub(crate) async fn check_tool(
        &self,
        context: &ToolCallContext,
        name: &str,
    ) -> Result<(), ToolError> {
        self.check_context(context).await?;
        let configuration = self.live_configuration().await?;
        if configuration
            .tools
            .as_ref()
            .is_some_and(|allowed| !allowed.iter().any(|tool| tool == name))
        {
            return Err(ToolError::Failed(
                "Tool is outside this Run's current permission ceiling".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn target_for_context(
        &self,
        context: &ToolCallContext,
    ) -> Result<AuthorizationObligation, ToolError> {
        use maka_agent_facts::{cells::CellStatus, tool_call::ToolOrigin};
        self.check_context(context).await?;
        let view = self.fresh().await.map_err(ToolError::Failed)?;
        let target = match &context.call.origin {
            ToolOrigin::Provider { link } => {
                if link.run != self.execution.run_id
                    || view
                        .attempts
                        .get(&link.attempt)
                        .is_none_or(|attempt| attempt.step != link.step)
                {
                    return Err(ToolError::Failed("agent_tool_origin_mismatch".into()));
                }
                let tool = ToolKey {
                    attempt: link.attempt,
                    call: context.call.tool_call_id.clone(),
                };
                let original = view
                    .tools
                    .get(&maka_agent_state::fold::tool_key(&tool))
                    .ok_or_else(|| ToolError::Failed("agent_tool_obligation_missing".into()))?;
                if original.accepted.is_some()
                    || original.prohibited_before_host.is_some()
                    || matches!(original.decision, Some(ToolDecision::Rejected { .. }))
                {
                    return Err(ToolError::Failed("agent_tool_obligation_settled".into()));
                }
                AuthorizationObligation::Tool { tool }
            }
            ToolOrigin::CodeMode { cell, owner, .. } | ToolOrigin::CodeCell { cell, owner, .. } => {
                let canonical = self
                    .cells()
                    .map_err(ToolError::Failed)?
                    .read(&self.execution.session_id, *cell)
                    .await
                    .map_err(|error| ToolError::Persistence(error.to_string()))?
                    .ok_or_else(|| ToolError::Failed("agent_cell_missing".into()))?;
                if canonical.owner != *owner || owner.run() != Some(self.execution.run_id) {
                    return Err(ToolError::Failed("agent_cell_origin_mismatch".into()));
                }
                let operation = Uuid::parse_str(&context.call.tool_call_id)
                    .map_err(|_| ToolError::Failed("agent_cell_operation_invalid".into()))?;
                if operation.is_nil() {
                    return Err(ToolError::Failed("agent_cell_operation_invalid".into()));
                }
                if !matches!(canonical.status, CellStatus::Running) {
                    return Err(ToolError::Failed("agent_cell_not_running".into()));
                }
                let child = canonical
                    .children
                    .get(&operation)
                    .ok_or_else(|| ToolError::Failed("agent_cell_child_missing".into()))?;
                if child.known() {
                    return Err(ToolError::Failed("agent_cell_child_settled".into()));
                }
                AuthorizationObligation::Cell {
                    cell: *cell,
                    operation,
                }
            }
            ToolOrigin::External {
                task, operation, ..
            } => {
                let key = ExternalEffectKey {
                    task: *task,
                    operation: *operation,
                };
                let descriptor = self
                    .external_descriptor(&view, key)
                    .await
                    .map_err(ToolError::Failed)?;
                if descriptor.origin != context.call.origin {
                    return Err(ToolError::Failed("agent_external_origin_mismatch".into()));
                }
                AuthorizationObligation::External {
                    task: *task,
                    operation: *operation,
                }
            }
            ToolOrigin::HostSdk { .. } | ToolOrigin::Standalone => {
                return Err(ToolError::Failed(
                    "agent_authorization_origin_unsupported".into(),
                ));
            }
        };
        let operation = match &target {
            AuthorizationObligation::External { task, operation } => {
                format!("external:{task}:{operation}")
            }
            AuthorizationObligation::Tool { tool } => format!("{}:{}", tool.attempt, tool.call),
            AuthorizationObligation::Cell { cell, operation } => format!("cell:{cell}:{operation}"),
        };
        if context.operation_id != operation {
            return Err(ToolError::Failed(
                "agent_obligation_operation_mismatch".into(),
            ));
        }
        Ok(target)
    }

    fn cells(&self) -> Result<maka_agent_state::cells::CellsStore, String> {
        Ok(maka_agent_state::cells::CellsStore::new(
            self.owner()?
                .store
                .data_writer()
                .map_err(|error| error.to_string())?,
        ))
    }

    async fn external_descriptor(
        &self,
        view: &RunView,
        key: ExternalEffectKey,
    ) -> Result<ExternalEffectDescriptor, String> {
        let task = view
            .external
            .as_ref()
            .ok_or("agent_external_task_missing")?;
        if task.task != key.task || !task.admitted || task.closed.is_some() {
            return Err("agent_external_task_not_running".into());
        }
        let owner = self.owner()?;
        let original = owner
            .durable
            .external_effect(self.execution.run_id, key)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("agent_external_effect_missing")?;
        if original.known() {
            return Err("agent_external_effect_settled".into());
        }
        let descriptor = owner
            .durable
            .external_effect_descriptor(self.execution.run_id, key)
            .await
            .map_err(|error| error.to_string())?;
        let configuration = self
            .live_configuration()
            .await
            .map_err(|error| error.to_string())?;
        if configuration
            .tools
            .as_ref()
            .is_some_and(|allowed| !allowed.contains(&descriptor.name))
        {
            return Err("agent_external_tool_outside_permission_ceiling".into());
        }
        if let Some(diagnostic) = descriptor
            .resources
            .iter()
            .find_map(|resource| match resource {
                ResourceRecovery::Unavailable { diagnostic } => Some(diagnostic),
                ResourceRecovery::Reference { .. } => None,
            })
        {
            return Err(format!(
                "agent_approval_resources_unavailable: {diagnostic}"
            ));
        }
        Ok(descriptor)
    }

    pub(crate) async fn binding_for_target(
        &self,
        target: &AuthorizationObligation,
    ) -> Result<(ApprovalBinding, Vec<ContentBlob>), String> {
        use maka_agent_facts::cells::CellStatus;
        let view = self.fresh().await?;
        let (input, resources, contents) = match target {
            AuthorizationObligation::External { task, operation } => {
                let descriptor = self
                    .external_descriptor(
                        &view,
                        ExternalEffectKey {
                            task: *task,
                            operation: *operation,
                        },
                    )
                    .await?;
                let blob =
                    ContentBlob::json(&descriptor.input).map_err(|error| error.to_string())?;
                (blob.reference().clone(), descriptor.resources, vec![blob])
            }
            AuthorizationObligation::Tool { tool: key } => {
                let tool = view
                    .tools
                    .get(&maka_agent_state::fold::tool_key(key))
                    .ok_or("agent_tool_obligation_missing")?;
                if !view.attempts.contains_key(&key.attempt) {
                    return Err("agent_tool_attempt_missing".into());
                }
                let input = tool
                    .call
                    .input
                    .as_json()
                    .ok_or("agent_tool_input_invalid")?;
                let blob = ContentBlob::json(input).map_err(|error| error.to_string())?;
                let resources = match &tool.decision {
                    Some(ToolDecision::Approved {
                        input, resources, ..
                    }) => {
                        if input != blob.reference() {
                            return Err("agent_tool_input_changed".into());
                        }
                        resources.clone()
                    }
                    Some(ToolDecision::Rejected { .. }) => return Err("agent_tool_rejected".into()),
                    None => vec![],
                };
                (blob.reference().clone(), resources, vec![blob])
            }
            AuthorizationObligation::Cell { cell, operation } => {
                if operation.is_nil() {
                    return Err("agent_cell_operation_invalid".into());
                }
                let cell = self
                    .cells()?
                    .read(&self.execution.session_id, *cell)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("agent_cell_missing")?;
                if cell.owner.run() != Some(self.execution.run_id) {
                    return Err("agent_cell_origin_mismatch".into());
                }
                if !matches!(cell.status, CellStatus::Running) {
                    return Err("agent_cell_not_running".into());
                }
                let child = cell
                    .children
                    .get(operation)
                    .ok_or("agent_cell_child_missing")?;
                if child.known() {
                    return Err("agent_cell_child_settled".into());
                }
                (child.input.clone(), child.resources.clone(), vec![])
            }
        };
        if let Some(diagnostic) = resources.iter().find_map(|resource| match resource {
            ResourceRecovery::Unavailable { diagnostic } => Some(diagnostic),
            ResourceRecovery::Reference { .. } => None,
        }) {
            return Err(format!(
                "agent_approval_resources_unavailable: {diagnostic}"
            ));
        }
        let mut bytes: [u8; 16] = Sha256::digest(
            serde_json::to_vec(&(&self.execution, target, &input, &resources))
                .expect("approval binding"),
        )[..16]
            .try_into()
            .expect("SHA256 prefix");
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        Ok((
            ApprovalBinding {
                phase: maka_agent_state::interactions::ApprovalPhase::Preparation,
                approval: ApprovalId::try_from(Uuid::from_bytes(bytes))
                    .expect("non-nil approval identity"),
                target: target.clone(),
                input,
                resources,
            },
            contents,
        ))
    }

    pub(crate) async fn establish_for_target(
        &self,
        record: &InteractionRecord,
        target: &AuthorizationObligation,
    ) -> Result<InteractionRecord, String> {
        self.establish_with_phase(
            record,
            target,
            maka_agent_state::interactions::ApprovalPhase::Preparation,
        )
        .await
    }

    async fn establish_for_host(
        &self,
        record: &InteractionRecord,
        target: &AuthorizationObligation,
        original: &maka_plugin_core::operation::RecoveryRef,
    ) -> Result<InteractionRecord, String> {
        self.establish_with_phase(
            record,
            target,
            maka_agent_state::interactions::ApprovalPhase::Host {
                original: original.clone(),
            },
        )
        .await
    }

    async fn establish_with_phase(
        &self,
        record: &InteractionRecord,
        target: &AuthorizationObligation,
        phase: maka_agent_state::interactions::ApprovalPhase,
    ) -> Result<InteractionRecord, String> {
        let (mut binding, contents) = self.binding_for_target(target).await?;
        binding.phase = phase;
        let mut bytes: [u8; 16] = Sha256::digest(
            serde_json::to_vec(&(&record.request_id, &binding)).expect("interaction binding"),
        )[..16]
            .try_into()
            .expect("SHA256 prefix");
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        binding.approval =
            ApprovalId::try_from(Uuid::from_bytes(bytes)).expect("non-nil approval identity");
        self.publish(record, Some(binding), contents).await
    }

    async fn publish(
        &self,
        record: &InteractionRecord,
        approval: Option<ApprovalBinding>,
        contents: Vec<ContentBlob>,
    ) -> Result<InteractionRecord, String> {
        if record.execution != self.execution {
            return Err("agent_interaction_execution_mismatch".into());
        }
        let owner = self.owner()?;
        if let Some(original) = owner
            .durable
            .interactions()
            .read(&self.execution.session_id, &record.request_id)
            .await
            .map_err(|error| error.to_string())?
        {
            if original.execution != record.execution || original.request != record.request {
                return Err("agent_interaction_identity_conflict".into());
            }
            let binding = owner
                .durable
                .interactions()
                .binding(&self.execution.session_id, &record.request_id)
                .await
                .map_err(|error| error.to_string())?;
            if binding != approval {
                return Err("agent_interaction_binding_conflict".into());
            }
            return Ok(original);
        }
        loop {
            let view = self.fresh().await?;
            match owner
                .durable
                .interactions()
                .establish(
                    &self.claim,
                    Head::from(&view),
                    record.clone(),
                    approval.clone(),
                    contents.clone(),
                )
                .await
            {
                Ok(record) => return Ok(record),
                Err(maka_event_log::StoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Approval must bind the exact tool, method, binding, service, input and original call context"
    )]
    pub(crate) async fn establish_service(
        &self,
        context: &ToolCallContext,
        name: &str,
        method: &str,
        binding: &str,
        service: &str,
        input: &Value,
        cancellation: &CancellationToken,
    ) -> Result<(InteractionRecord, ApprovalId), ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed("service confirmation cancelled".into()));
        }
        let target = self.target_for_context(context).await?;
        let view = self.fresh().await.map_err(ToolError::Failed)?;
        let (mut approval_binding, contents) = self
            .binding_for_target(&target)
            .await
            .map_err(ToolError::Failed)?;
        let (original_name, original_input) = match &target {
            AuthorizationObligation::External { task, operation } => {
                let descriptor = self
                    .external_descriptor(
                        &view,
                        ExternalEffectKey {
                            task: *task,
                            operation: *operation,
                        },
                    )
                    .await
                    .map_err(ToolError::Failed)?;
                (descriptor.name, descriptor.input)
            }
            AuthorizationObligation::Tool { tool } => {
                let original = view
                    .tools
                    .get(&maka_agent_state::fold::tool_key(tool))
                    .ok_or_else(|| ToolError::Failed("agent_tool_obligation_missing".into()))?;
                (
                    original.call.name.clone(),
                    original
                        .call
                        .input
                        .as_json()
                        .cloned()
                        .ok_or_else(|| ToolError::Failed("agent_tool_input_invalid".into()))?,
                )
            }
            AuthorizationObligation::Cell { cell, operation } => {
                let cells = self.cells().map_err(ToolError::Failed)?;
                let original = cells
                    .read(&self.execution.session_id, *cell)
                    .await
                    .map_err(|error| ToolError::Persistence(error.to_string()))?
                    .ok_or_else(|| ToolError::Failed("agent_cell_missing".into()))?;
                let child = original
                    .children
                    .get(operation)
                    .ok_or_else(|| ToolError::Failed("agent_cell_child_missing".into()))?;
                let bytes = cells
                    .content(&self.execution.session_id, *cell, child.input.clone())
                    .await
                    .map_err(|error| ToolError::Persistence(error.to_string()))?;
                let input = serde_json::from_slice::<Value>(&bytes)
                    .map_err(|error| ToolError::Persistence(error.to_string()))?;
                (child.name.clone(), input)
            }
        };
        if original_name != name || original_input != *input {
            return Err(ToolError::Failed(
                "Service confirmation arguments differ from original input".into(),
            ));
        }
        let request_id = format!(
            "service_{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(&self.execution, &target, binding, &approval_binding.input))
                    .expect("tool confirmation identity")
            ))
        );
        let mut bytes: [u8; 16] = Sha256::digest(request_id.as_bytes())[..16]
            .try_into()
            .expect("SHA256 prefix");
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        let approval =
            ApprovalId::try_from(Uuid::from_bytes(bytes)).expect("non-nil approval identity");
        if let AuthorizationObligation::Tool { tool } = &target {
            let original = view
                .tools
                .get(&maka_agent_state::fold::tool_key(tool))
                .ok_or_else(|| ToolError::Failed("agent_tool_obligation_missing".into()))?;
            if let Some(ToolDecision::Approved {
                approval: expected, ..
            }) = &original.decision
                && *expected != Some(approval)
            {
                return Err(ToolError::Failed(
                    "Service confirmation differs from the original approval".into(),
                ));
            }
        }
        let mut record = InteractionRecord {
            execution: self.execution.clone(),
            request_id,
            created_at: now(),
            request: InteractionRequest::ServiceApproval {
                tool_use_id: context.tool_use_id(),
                tool_name: name.into(),
                service: service.into(),
                method: method.into(),
                binding: binding.into(),
                through: view.revision,
            },
            outcome: None,
        };
        if let Some(original) = self
            .read(&record.request_id)
            .await
            .map_err(ToolError::Persistence)?
        {
            let InteractionRequest::ServiceApproval { through, .. } = &original.request else {
                return Err(ToolError::Persistence(
                    "Original service confirmation type differs".into(),
                ));
            };
            if let InteractionRequest::ServiceApproval {
                through: current, ..
            } = &mut record.request
            {
                *current = *through;
            }
            record.created_at = original.created_at;
        }
        approval_binding.approval = approval;
        let record = self
            .publish(&record, Some(approval_binding), contents)
            .await
            .map_err(ToolError::Persistence)?;
        Ok((record, approval))
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Confirmation must match the exact tool, method, binding, service, input and original call context"
    )]
    pub(crate) async fn confirm_service(
        &self,
        context: &ToolCallContext,
        name: &str,
        method: &str,
        binding: &str,
        service: &str,
        input: &Value,
        cancellation: &CancellationToken,
    ) -> Result<ApprovalId, ToolError> {
        let (record, approval) = self
            .establish_service(context, name, method, binding, service, input, cancellation)
            .await?;
        match maka_agent_authority::interaction_wait::wait(self, &record, cancellation)
            .await
            .map_err(|error| ToolError::Failed(error.into()))?
        {
            InteractionOutcome::ServiceApprovalDecision {
                decision: Decision::Allow,
                ..
            } if !cancellation.is_cancelled() => {
                self.check_context(context).await?;
                Ok(approval)
            }
            _ => Err(ToolError::Failed("Service call was not approved".into())),
        }
    }
}

impl Access for RunAccess {
    fn permission_request_original(
        &self,
    ) -> Result<Option<&maka_plugin_core::operation::RecoveryRef>, ToolError> {
        Ok(None)
    }
    fn live_configuration(&self) -> BoxFuture<'_, Result<ResolvedConfiguration, ToolError>> {
        Box::pin(async move {
            self.fresh().await.map_err(ToolError::Failed)?;
            self.current_configuration().await
        })
    }
    fn permission_grants<'a>(
        &'a self,
        target: &'a AuthorizationObligation,
        basis: &'a PermissionBasis,
    ) -> BoxFuture<'a, Result<Vec<PermissionGrant>, ToolError>> {
        Box::pin(async move {
            let configuration = self.live_configuration().await?;
            if configuration.permission_basis() != *basis {
                return Err(ToolError::Failed("Permission boundary changed".into()));
            }
            let owner = self.owner().map_err(ToolError::Failed)?;
            let grants = owner
                .durable
                .interactions()
                .permission_grants(&self.execution, Some(target), basis)
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?;
            Ok(grants
                .into_iter()
                .map(|grant| PermissionGrant {
                    approval_id: grant.approval_id,
                    request_id: grant.request_id,
                    permissions: grant.permissions,
                    scope: grant.scope,
                })
                .collect())
        })
    }
}

impl Interactions for RunAccess {
    fn execution(&self) -> &ExecutionIdentity {
        &self.execution
    }
    fn changes(&self) -> Result<tokio::sync::watch::Receiver<()>, String> {
        self.owner()?
            .durable
            .interactions()
            .subscribe()
            .map_err(|error| error.to_string())
    }
    fn read<'a>(
        &'a self,
        request_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<InteractionRecord>, String>> {
        Box::pin(async move {
            Ok(self
                .owner()?
                .durable
                .interactions()
                .read(&self.execution.session_id, request_id)
                .await
                .map_err(|error| error.to_string())?
                .filter(|record| record.execution == self.execution))
        })
    }
    fn establish<'a>(
        &'a self,
        record: &'a InteractionRecord,
    ) -> BoxFuture<'a, Result<InteractionRecord, String>> {
        Box::pin(async move {
            if let InteractionRequest::Permissions { target, .. } = &record.request {
                self.establish_for_target(record, target).await
            } else {
                self.publish(record, None, vec![]).await
            }
        })
    }
    fn commit_outcome<'a>(
        &'a self,
        request_id: &'a str,
        outcome: InteractionOutcome,
    ) -> BoxFuture<'a, Result<InteractionRecord, String>> {
        Box::pin(async move {
            let record = self
                .read(request_id)
                .await?
                .ok_or("agent_interaction_missing")?;
            if !matches!(outcome, InteractionOutcome::Closure { .. }) {
                return Err("agent_producer_cannot_answer".into());
            }
            self.owner()?
                .durable
                .interactions()
                .commit_outcome(&record.execution.session_id, request_id, outcome)
                .await
                .map_err(|error| error.to_string())
        })
    }
}
