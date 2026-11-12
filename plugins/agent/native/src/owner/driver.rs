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

use super::{Owner, RunAccess, driver_model::DriverModel, now};
#[path = "driver_effects.rs"]
mod effects;
#[cfg(test)]
mod tests;
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_authority::permissions::Access;
use maka_agent_engine::{PreparedModel, RunError, cleanup::Evidence, ports::*};
use maka_agent_facts::{
    artifact::{PublishedArtifact, ToolReturn},
    durable::*,
    tool_call::{ToolCallIdentity, ToolRejection},
    tool_output::{ReturnedToolResult, ToolOutput, ToolSuccess},
    tools::{PreparedEffect, ToolCallContext, ToolError, ToolSemantics},
};
use maka_agent_state::{
    Change, ContentBlob,
    fold::{RunView, Tool, tool_key},
};
use maka_capabilities::call::Identity;
use maka_plugin_core::operation::{OperationReply, Receipt, RecoveryRef};
use serde::de::DeserializeOwned;
use std::{collections::BTreeMap, panic::AssertUnwindSafe, sync::Arc, time::SystemTime};
use tokio::sync::{Mutex, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

/// These are actual activation capabilities. No constructor accepts a serialized Scope.
pub(super) struct NativeDriver {
    pub(super) owner: Arc<Owner>,
    pub(super) state: maka_agent_state::Store,
    pub(super) access: Arc<RunAccess>,
    pub(super) catalog: maka_tools::ToolCatalog,
    pub(super) backend: NativeBackend,
    pub(super) cancellation: CancellationToken,
    pub(super) cleanup: Evidence,
    pub(super) workers: TaskTracker,
    prepared: Mutex<BTreeMap<String, PreparedDispatch>>,
    step_tools: std::sync::Mutex<Option<(StepId, maka_tools::ToolCatalog)>>,
    original_effects: effects::OriginalEffects,
    cleanup_signals_armed: std::sync::OnceLock<()>,
    external_effects: std::sync::OnceLock<super::driver_external_effects::NativeExternalEffects>,
}

#[expect(
    clippy::large_enum_variant,
    reason = "A local result owns its prepared publication directly; avoid another allocation per result"
)]
pub(super) enum LocalCompletion {
    Todo(super::todo::Replacement),
    Copy(maka_agent_state::artifacts::CopyArtifact),
}
impl LocalCompletion {
    pub(super) async fn publish(
        &self,
        state: &maka_agent_state::Store,
        access: &RunAccess,
        original: &Change,
        contents: &[ContentBlob],
        artifacts: &[maka_agent_facts::event::ProjectionArtifactWrite],
    ) -> Result<maka_agent_state::Commit, maka_event_log::StoreError> {
        match self {
            Self::Todo(todo) => todo.publish(original, contents).await,
            Self::Copy(copy) => {
                let writer = access
                    .data_writer()
                    .map_err(maka_event_log::StoreError::InvalidTransition)?;
                loop {
                    let view = state.frontier(access.execution().run_id).await?;
                    match state
                        .append_local_copy(
                            access.claim(),
                            maka_agent_state::LocalResult {
                                head: (&view).into(),
                                original: original.clone(),
                                contents: contents.to_vec(),
                                normalized_artifacts: artifacts.to_vec(),
                            },
                            copy.clone(),
                            &writer,
                        )
                        .await
                    {
                        Err(error)
                            if matches!(
                                Self::statement_cause(&error),
                                maka_event_log::StoreError::RevisionConflict { .. }
                            ) =>
                        {
                            continue;
                        }
                        result => return result,
                    }
                }
            }
        }
    }
    fn statement_cause(error: &maka_event_log::StoreError) -> &maka_event_log::StoreError {
        match error {
            maka_event_log::StoreError::Shared(cause) => Self::statement_cause(cause),
            error => error,
        }
    }
    pub(super) fn rejected(&self, error: &maka_event_log::StoreError) -> bool {
        if matches!(Self::statement_cause(error), maka_event_log::StoreError::StatementRejected { diagnostic, .. }
            if diagnostic == maka_agent_state::Store::LOCAL_ADMISSION_FENCED)
        {
            return true;
        }
        match self {
            Self::Todo(_) => super::todo::business_failure(error),
            Self::Copy(_) => {
                matches!(Self::statement_cause(error), maka_event_log::StoreError::StatementRejected { diagnostic, .. }
                if diagnostic == maka_agent_state::artifacts::COPY_REJECTED)
            }
        }
    }
}

pub(super) enum DispatchSource {
    Ordinary,
    CellWait(super::driver_cells::OwnedCellWait),
}
struct PreparedDispatch {
    tool: PreparedTool,
    source: DispatchSource,
}
impl PreparedDispatch {
    fn ordinary(tool: PreparedTool) -> Self {
        Self {
            tool,
            source: DispatchSource::Ordinary,
        }
    }
}

pub(super) struct PreparedTool {
    pub(super) semantics: ToolSemantics,
    pub(super) effect: PreparedEffect,
    pub(super) local: Option<LocalCompletion>,
}
impl PreparedTool {
    fn regular(effect: PreparedEffect, semantics: ToolSemantics) -> Self {
        Self {
            effect,
            semantics,
            local: None,
        }
    }
    pub(super) fn approval_id(&self) -> Option<ApprovalId> {
        self.effect.approval_id()
    }
    pub(super) fn display(&self, locale: &str) -> ToolDisplay {
        self.effect.display(locale)
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Local tool preparation keeps the original access, catalog, call context, cancellation and semantics explicit"
    )]
    pub(super) async fn prepare(
        owner: &Arc<Owner>,
        access: &Arc<RunAccess>,
        catalog: &maka_tools::ToolCatalog,
        name: String,
        input: serde_json::Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
        semantics: ToolSemantics,
    ) -> Result<Self, ToolRejection> {
        let todo: Arc<dyn maka_agent_facts::tools::ToolPreparer> = owner.todo.clone();
        if catalog.is_prepared_by(&name, &todo) {
            catalog.validate(&name, &input)?;
            let prepared = owner
                .todo
                .prepare_native(
                    name,
                    input,
                    context,
                    cancellation.clone(),
                    Some(access.clone()),
                    semantics,
                )
                .await?;
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            Ok(prepared)
        } else if catalog.is_prepared_by(
            &name,
            &(owner.recall.clone() as Arc<dyn maka_agent_facts::tools::ToolPreparer>),
        ) {
            catalog.validate(&name, &input)?;
            owner
                .recall
                .prepare_native(
                    name,
                    input,
                    context,
                    cancellation,
                    access.clone(),
                    semantics,
                )
                .await
        } else {
            catalog
                .prepare(name, input, context, cancellation)
                .await
                .map(|effect| Self::regular(effect, semantics))
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("source authority changed: {0}")]
pub(super) struct SourceAuthorityChanged(String);

pub(super) fn source_authority_changed(message: impl Into<String>) -> RunError {
    RunError::Preparation(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        SourceAuthorityChanged(message.into()),
    ))
}

pub(super) fn validate_tool_digest(request: &RequestSpec) -> Result<(), RunError> {
    if maka_agent_engine::digest(&request.composition.tools)?
        != request.composition.tool_catalog_digest
    {
        return Err(RunError::InvalidInput(
            "frozen selected tool definitions differ from their digest".into(),
        ));
    }
    Ok(())
}

pub(super) fn tool_contract_digest(
    tool: &maka_agent_facts::tools::ToolDefinition,
) -> Result<String, RunError> {
    maka_agent_engine::digest(&(
        &tool.input_schema,
        &tool.output_schema,
        &tool.provider,
        &tool.freeform,
    ))
}

pub(super) fn same_tool_contract(
    original: &maka_agent_facts::tools::ToolDefinition,
    current: &maka_agent_facts::tools::ToolDefinition,
) -> bool {
    original.input_schema == current.input_schema
        && original.output_schema == current.output_schema
        && original.provider == current.provider
        && original.freeform == current.freeform
}

pub(super) struct BoundStepTools {
    pub(super) definitions: Vec<maka_agent_facts::tools::ToolDefinition>,
    pub(super) catalog: maka_tools::ToolCatalog,
}

#[expect(
    clippy::large_enum_variant,
    reason = "A driver owns one selected backend; keep the backend value inline"
)]
pub(super) enum NativeBackend {
    Model {
        model: DriverModel,
        cells: Option<Arc<super::driver_cells::RunCells>>,
    },
    Executor(Arc<super::driver_executor::DriverExecutor>),
}
impl NativeDriver {
    #[expect(
        clippy::too_many_arguments,
        reason = "Driver construction transfers distinct execution, backend, cleanup and worker owners together"
    )]
    pub(super) fn new(
        owner: Arc<Owner>,
        state: maka_agent_state::Store,
        access: Arc<RunAccess>,
        catalog: maka_tools::ToolCatalog,
        mcp: Arc<crate::mcp::Catalog>,
        backend: NativeBackend,
        cancellation: CancellationToken,
        cleanup: Evidence,
        workers: TaskTracker,
    ) -> Self {
        let mode = if matches!(&backend, NativeBackend::Model { cells: Some(_), .. }) {
            maka_agent_facts::execution::ToolMode::CodeMode
        } else {
            maka_agent_facts::execution::ToolMode::Direct
        };
        access.bind_model_tools(mcp, mode);
        let original_effects =
            effects::OriginalEffects::new(state.clone(), owner.services.clone(), access.clone());
        Self {
            owner,
            state,
            access,
            catalog,
            backend,
            cancellation,
            cleanup,
            workers,
            prepared: Mutex::new(BTreeMap::new()),
            step_tools: std::sync::Mutex::new(None),
            original_effects,
            cleanup_signals_armed: std::sync::OnceLock::new(),
            external_effects: std::sync::OnceLock::new(),
        }
    }
    pub(super) fn attach_external_effects(
        &self,
        effects: super::driver_external_effects::NativeExternalEffects,
    ) -> Result<(), RunError> {
        if !effects.belongs_to(&self.access) {
            return Err(RunError::InvalidInput(
                "foreign external effect owner".into(),
            ));
        }
        self.external_effects
            .set(effects)
            .map_err(|_| RunError::InvalidInput("external effect owner already attached".into()))
    }
    fn model(&self) -> Result<&DriverModel, RunError> {
        match &self.backend {
            NativeBackend::Model { model, .. } => Ok(model),
            NativeBackend::Executor(_) => Err(RunError::InvalidInput(
                "model port used for a non-model backend".into(),
            )),
        }
    }
    async fn decode<T: DeserializeOwned>(&self, reference: &ContentRef) -> Result<T, RunError> {
        let bytes = self
            .state
            .content(self.access.execution().run_id, reference.clone())
            .await?;
        serde_json::from_slice(&bytes).map_err(|error| RunError::InvalidInput(error.to_string()))
    }
    fn context(&self, view: &RunView, key: &ToolKey) -> Result<ToolCallContext, RunError> {
        if view.run != self.access.execution().run_id {
            return Err(RunError::InvalidInput("foreign tool run".into()));
        }
        let attempt = view
            .attempts
            .get(&key.attempt)
            .ok_or_else(|| RunError::InvalidInput("tool has no original model attempt".into()))?;
        Ok(ToolCallContext {
            execution: self.access.execution().clone(),
            operation_id: format!("{}:{}", key.attempt, key.call),
            call: ToolCallIdentity::provider(
                AgentStepLink {
                    run: view.run,
                    step: attempt.step,
                    attempt: key.attempt,
                },
                key.call.clone(),
            ),
            custody: Some(self.access.custody().clone()),
        })
    }
    fn availability(
        &self,
        catalog: maka_tools::ToolCatalog,
    ) -> maka_tools::availability::Availability {
        maka_tools::availability::Availability::new(
            catalog,
            maka_tools::availability::LoadedTools::new(self.state.cells().reader(
                self.access.execution().session_id.clone(),
                tokio::runtime::Handle::current(),
            )),
        )
    }

    pub(super) async fn bind_step_tools(
        &self,
        view: &RunView,
        model: &PreparedModel,
        reset_loaded_tools: bool,
    ) -> Result<BoundStepTools, RunError> {
        let current = self.access.live_configuration().await?;
        let excluded: Vec<_> = self
            .catalog
            .definitions()
            .filter(|tool| {
                current
                    .tools
                    .as_ref()
                    .is_some_and(|allowed| !allowed.contains(&tool.name))
            })
            .map(|tool| tool.name.as_str())
            .collect();
        let catalog = self.catalog.excluding(&excluded);
        let catalog = if view.spec.tool_discovery {
            catalog.with_discovery()
        } else {
            catalog
        };
        let availability = self.availability(catalog);
        let model = model.provider.tool_context();
        let execution = self.access.execution().clone();
        let custody = self.access.custody().clone();
        let cancellation = self.cancellation.clone();
        let cwd = current.workspace.path;
        let original = self.workers.spawn(async move {
            availability
                .capture(Some(model), execution, Some(custody), cwd, cancellation)
                .await
        });
        let bound = original
            .await
            .map_err(|error| RunError::Internal(error.to_string()))?
            .map_err(RunError::Tool)?;
        self.access.live_configuration().await?;
        let definitions = match &self.backend {
            NativeBackend::Model {
                cells: Some(cells), ..
            } => cells.coordinator.definitions(&bound),
            NativeBackend::Model { cells: None, .. } => {
                let visible = if reset_loaded_tools {
                    bound.select(&Default::default())
                } else {
                    bound.snapshot().await.map_err(RunError::Tool)?
                };
                let mut definitions: Vec<_> = visible.definitions().cloned().collect();
                if let Some(search) = bound.definition() {
                    definitions.push(search);
                }
                definitions
            }
            NativeBackend::Executor(_) => {
                return Err(RunError::InvalidInput(
                    "model tools requested for executor".into(),
                ));
            }
        };
        Ok(BoundStepTools {
            definitions,
            catalog: bound.all(),
        })
    }

    pub(super) fn install_step_tools(
        &self,
        step: StepId,
        catalog: maka_tools::ToolCatalog,
    ) -> Result<(), RunError> {
        *self
            .step_tools
            .lock()
            .map_err(|_| RunError::Internal("bound step tools lock poisoned".into()))? =
            Some((step, catalog));
        Ok(())
    }

    pub(super) fn tool_contracts(
        &self,
        catalog: &maka_tools::ToolCatalog,
        definitions: &[Arc<maka_agent_facts::tools::ToolDefinition>],
    ) -> Result<BTreeMap<String, String>, RunError> {
        let code = matches!(&self.backend, NativeBackend::Model { cells: Some(_), .. });
        let names: std::collections::BTreeSet<_> =
            definitions.iter().map(|tool| tool.name.as_str()).collect();
        catalog
            .definitions()
            .filter(|tool| code || names.contains(tool.name.as_str()))
            .map(|tool| tool_contract_digest(tool).map(|digest| (tool.name.clone(), digest)))
            .collect()
    }

    async fn catalog_for_request(
        &self,
        view: &RunView,
        request: &RequestSpec,
    ) -> Result<maka_tools::ToolCatalog, RunError> {
        validate_tool_digest(request)?;
        let model = self.model()?.step_tool_model(view, request).await?;
        let bound = self.bind_step_tools(view, &model, false).await?;
        let code = matches!(&self.backend, NativeBackend::Model { cells: Some(_), .. });
        let current = self.access.live_configuration().await?;
        let (mcp, mode) = self.access.current_model_tools(&current.workspace)?;
        self.access
            .validate_model_tools(request, &self.catalog, &bound.catalog, &mcp, mode)
            .await?;
        for original in &request.composition.tools {
            if code || original.name == maka_tools::availability::SEARCH {
                let actual = bound
                    .definitions
                    .iter()
                    .find(|tool| tool.name == original.name)
                    .ok_or_else(|| {
                        source_authority_changed(format!(
                            "selected control {} is unavailable",
                            original.name
                        ))
                    })?;
                if !same_tool_contract(original, actual) {
                    return Err(source_authority_changed(format!(
                        "selected control {} contract changed",
                        original.name
                    )));
                }
            }
        }
        Ok(bound.catalog)
    }

    async fn catalog_for_step(
        &self,
        view: &RunView,
        step: StepId,
    ) -> Result<maka_tools::ToolCatalog, RunError> {
        if let Some((_, catalog)) = self
            .step_tools
            .lock()
            .map_err(|_| RunError::Internal("bound step tools lock poisoned".into()))?
            .as_ref()
            .filter(|(original, _)| *original == step)
        {
            return Ok(catalog.clone());
        }
        let history = self
            .state
            .session_history(view.spec.owner.clone(), view.spec.session_id.clone());
        let cut = history.capture().await?;
        let request = history.request(&cut, view.run, step).await?;
        let catalog = self.catalog_for_request(view, &request).await?;
        self.install_step_tools(step, catalog.clone())?;
        Ok(catalog)
    }

    pub(super) async fn reuse_step_tools(
        &self,
        view: &RunView,
        original: StepId,
        new: StepId,
    ) -> Result<(), RunError> {
        let request = self.state.request(view.run, original).await?;
        let catalog = self.catalog_for_request(view, &request).await?;
        self.install_step_tools(new, catalog)
    }

    async fn catalog_for_tool(
        &self,
        view: &RunView,
        tool: &Tool,
    ) -> Result<maka_tools::ToolCatalog, RunError> {
        let attempt = view
            .attempts
            .get(&tool.key.attempt)
            .ok_or_else(|| RunError::InvalidInput("tool has no original model attempt".into()))?;
        self.catalog_for_step(view, attempt.step).await
    }

    async fn advertised_tool(&self, view: &RunView, tool: &Tool) -> Result<bool, RunError> {
        let attempt = view
            .attempts
            .get(&tool.key.attempt)
            .ok_or_else(|| RunError::InvalidInput("tool has no original model attempt".into()))?;
        let history = self
            .state
            .session_history(view.spec.owner.clone(), view.spec.session_id.clone());
        let cut = history.capture().await?;
        let request = history.request(&cut, view.run, attempt.step).await?;
        Ok(request
            .composition
            .tools
            .iter()
            .any(|definition| definition.name == tool.call.name))
    }

    async fn prepare_tool(
        &self,
        view: &RunView,
        tool: &Tool,
        catalog: maka_tools::ToolCatalog,
    ) -> Result<PreparedDispatch, ToolRejection> {
        let configuration = self.access.live_configuration().await.map_err(|error| {
            ToolRejection::PolicyDenied {
                message: error.to_string(),
            }
        })?;
        let virtual_cell = matches!(tool.call.name.as_str(), "exec" | "wait")
            && matches!(&self.backend, NativeBackend::Model { cells: Some(_), .. });
        let discovery = view.spec.tool_discovery
            && tool.call.name == maka_tools::availability::SEARCH
            && matches!(&self.backend, NativeBackend::Model { cells: None, .. });
        if !virtual_cell
            && !discovery
            && configuration
                .tools
                .as_ref()
                .is_some_and(|names| !names.contains(&tool.call.name))
        {
            return Err(ToolRejection::PolicyDenied {
                message: "tool is outside current selection".into(),
            });
        }
        let input = tool
            .call
            .input
            .as_json()
            .ok_or_else(|| ToolRejection::InvalidInput {
                message: "tool arguments are not valid JSON".into(),
            })?;
        let context =
            self.context(view, &tool.key)
                .map_err(|error| ToolRejection::PreparationFailed {
                    message: error.to_string(),
                })?;
        if discovery {
            return self
                .availability(catalog)
                .prepare_search(input)
                .map(|effect| {
                    PreparedDispatch::ordinary(PreparedTool::regular(
                        effect,
                        ToolSemantics::Parallel,
                    ))
                });
        }
        if matches!(tool.call.name.as_str(), "exec" | "wait") {
            return match &self.backend {
                NativeBackend::Model {
                    cells: Some(cells), ..
                } => {
                    cells
                        .prepare(
                            context,
                            &tool.call.name,
                            input,
                            catalog,
                            self.cancellation.clone(),
                            self.cancellation.child_token(),
                        )
                        .await
                }
                _ => Err(ToolRejection::Unavailable),
            }
            .map(|(effect, source)| PreparedDispatch {
                tool: PreparedTool::regular(effect, ToolSemantics::Parallel),
                source,
            });
        }
        if matches!(&self.backend, NativeBackend::Model { cells: Some(_), .. })
            && !catalog.direct_only().names().contains(&tool.call.name)
        {
            return Err(ToolRejection::Unavailable);
        }
        let semantics = catalog.semantics(&tool.call.name)?;
        PreparedTool::prepare(
            &self.owner,
            &self.access,
            &catalog,
            tool.call.name.clone(),
            input.clone(),
            context,
            self.cancellation.clone(),
            semantics,
        )
        .await
        .map(PreparedDispatch::ordinary)
    }
    pub(super) async fn finish(&self) -> Result<(), RunError> {
        if !self.original_cleanup_confirmed().await? {
            return Err(RunError::CleanupUnconfirmed);
        }
        if !self.cleanup.confirmed() {
            tracing::warn!("Original sources settled after historical cleanup errors");
        }
        Ok(())
    }

    pub(super) async fn original_cleanup_signals(&self) -> Vec<BoxFuture<'static, ()>> {
        let mut signals = self.original_effects.original_cleanup_signals().await;
        signals.extend(self.access.binding_cleanup_signals().await);
        if let Some(external) = self.external_effects.get() {
            signals.extend(external.original_cleanup_signals().await);
        }
        if self.cleanup_signals_armed.set(()).is_ok() {
            let workers = self.workers.clone();
            workers.close();
            signals.push(Box::pin(async move {
                workers.wait().await;
            }));
            match &self.backend {
                NativeBackend::Model { model, .. } => {
                    signals.extend(model.original_cleanup_signals());
                }
                NativeBackend::Executor(executor) => {
                    executor.workers.close();
                    signals.extend(executor.original_cleanup_signals().await);
                }
            }
        }
        signals
    }
    pub(super) async fn original_cleanup_confirmed(&self) -> Result<bool, RunError> {
        self.prepared.lock().await.clear();
        match &self.backend {
            NativeBackend::Model {
                cells: Some(cells), ..
            } => {
                cells.coordinator.cancel();
            }
            NativeBackend::Executor(executor) => executor.retire_root_observation().await?,
            _ => {}
        }
        self.workers.close();
        if !self.workers.is_empty() {
            return Ok(false);
        }
        let binding = self.access.binding_cleanup_confirmed().await;
        let external = match self.external_effects.get() {
            Some(external) => external.original_cleanup_confirmed().await,
            None => Ok(true),
        };
        let (backend, cells_cleanup_confirmed) = match &self.backend {
            NativeBackend::Model { model, cells } => {
                model.workers.close();
                let model = if model.workers.is_empty() {
                    model.original_cleanup_confirmed().await
                } else {
                    Ok(false)
                };
                let has_cells = cells.is_some();
                let cells = match cells {
                    Some(cells) if cells.coordinator.is_idle() && !cells.has_original_workers() => {
                        cells.original_cleanup_confirmed().await
                    }
                    Some(_) => Ok(false),
                    None => Ok(true),
                };
                let cells_cleanup_confirmed = has_cells && matches!(&cells, Ok(true));
                let backend = match (model, cells) {
                    (Ok(model), Ok(cells)) => Ok(model && cells),
                    (Err(error), _) | (_, Err(error)) => Err(error),
                };
                (backend, cells_cleanup_confirmed)
            }
            NativeBackend::Executor(executor) => {
                executor.workers.close();
                (executor.original_cleanup_confirmed().await, false)
            }
        };
        let ordinary = self
            .original_effects
            .settle_all(cells_cleanup_confirmed)
            .await;
        // Global Evidence records historical errors. Only these source-owned
        // physical and canonical ACK proofs release this particular Scope.
        let binding = binding?;
        let ordinary = ordinary?;
        let external = external?;
        let backend = backend?;
        Ok(binding
            && ordinary
            && external
            && backend
            && self.prepared.lock().await.is_empty()
            && self.workers.is_empty())
    }
    pub(super) fn has_live_resources(&self) -> bool {
        !self.original_effects.is_empty()
            || self
                .external_effects
                .get()
                .is_some_and(|external| external.has_retained())
            || matches!(&self.backend, NativeBackend::Model { model, .. } if model.original_cleanup.has_retained())
            || matches!(&self.backend, NativeBackend::Model { cells: Some(cells), .. } if !cells.coordinator.is_idle())
    }
}

impl DriverPorts for NativeDriver {
    fn external(&self) -> Option<Arc<dyn ExternalPorts>> {
        match &self.backend {
            NativeBackend::Executor(executor) => Some(executor.clone()),
            _ => None,
        }
    }
    fn publication(&self) -> Option<Arc<dyn ExternalPublicationPorts>> {
        match &self.backend {
            NativeBackend::Executor(executor) => Some(executor.clone()),
            NativeBackend::Model { .. } => None,
        }
    }
    fn cells(&self) -> Option<Arc<dyn CellPorts>> {
        match &self.backend {
            NativeBackend::Model {
                cells: Some(cells), ..
            } => Some(cells.clone()),
            _ => None,
        }
    }
    fn now(&self) -> UnixMillis {
        UnixMillis(now().try_into().expect("Unix milliseconds"))
    }
    fn prepare_step<'a>(
        &'a self,
        view: &'a RunView,
        mode: Preparation,
    ) -> BoxFuture<'a, Result<PreparedStep, RunError>> {
        Box::pin(async move {
            self.access.live_configuration().await?;
            self.model()?.prepare_step(view, mode, self).await
        })
    }
    fn assess_recovery<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        request: RequestSpec,
    ) -> BoxFuture<'a, Result<RecoveryEvidence, RunError>> {
        Box::pin(async move { self.model()?.assess_recovery(view, attempt, request).await })
    }
    fn validate_transport_selection<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        phase: maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ) -> BoxFuture<'a, Result<(), RunError>> {
        Box::pin(async move {
            let original = view.attempts.get(&attempt).ok_or_else(|| {
                RunError::InvalidInput("transport selection lost its original attempt".into())
            })?;
            let request = self.state.request(view.run, original.step).await?;
            self.catalog_for_request(view, &request).await?;
            self.model()?
                .validate_transport_selection(view, attempt, phase)
        })
    }

    fn model_admission(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        request: &RequestSpec,
    ) -> Result<serde_json::Value, RunError> {
        self.model()?;
        if run != self.access.execution().run_id {
            return Err(RunError::InvalidInput("foreign model admission".into()));
        }
        super::cleanup_driver::model_admission(
            &self.owner,
            self.access.execution(),
            attempt,
            request,
        )
    }

    fn start_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        request: RequestSpec,
        bytes: Vec<u8>,
        witness: maka_agent_engine::ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        Box::pin(async move {
            let view = self.state.frontier(run).await?;
            super::cleanup_driver::validate_model_reader_start(
                &self.owner,
                &view,
                attempt,
                &request,
            )?;
            self.catalog_for_request(&view, &request).await?;
            let writer = self.owner.store.data_writer_for_work(
                self.access.custody().as_ref(),
                &self.access.execution().session_id,
            )?;
            let witness = witness.with_data_writer(writer)?;
            self.model()?
                .start_model(run, attempt, request, bytes, witness, self.access.clone())
                .await
        })
    }
    fn observe_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        descriptor: ContentRef,
        after_index: u64,
        witness: maka_agent_engine::ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        Box::pin(async move {
            let writer = self.owner.store.data_writer_for_work(
                self.access.custody().as_ref(),
                &self.access.execution().session_id,
            )?;
            let witness = witness.with_data_writer(writer)?;
            self.model()?
                .observe_model(run, attempt, descriptor, after_index, witness)
                .await
        })
    }
    fn cancel_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
    ) -> BoxFuture<'_, Result<(), RunError>> {
        Box::pin(async move { self.model()?.cancel_model(run, attempt).await })
    }
    fn decide_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<PreparedDecision, RunError>> {
        Box::pin(async move {
            if !self.advertised_tool(view, tool).await? {
                return Ok(PreparedDecision {
                    decision: ToolDecision::Rejected {
                        rejection: ToolRejection::Unavailable,
                        display: Default::default(),
                    },
                    contents: vec![],
                });
            }
            let input = match tool.call.input.as_json() {
                Some(input) => ContentBlob::json(input)?,
                None => {
                    return Ok(PreparedDecision {
                        decision: ToolDecision::Rejected {
                            display: tool
                                .decision
                                .as_ref()
                                .map(|decision| decision.display().clone())
                                .unwrap_or_default(),
                            rejection: ToolRejection::InvalidInput {
                                message: "invalid tool arguments".into(),
                            },
                        },
                        contents: vec![],
                    });
                }
            };
            let catalog = self.catalog_for_tool(view, tool).await?;
            let prepared = match self.prepare_tool(view, tool, catalog).await {
                Ok(prepared) => prepared,
                Err(rejection) => {
                    return Ok(PreparedDecision {
                        decision: ToolDecision::Rejected {
                            rejection,
                            display: tool
                                .decision
                                .as_ref()
                                .map(|decision| decision.display().clone())
                                .unwrap_or_default(),
                        },
                        contents: vec![],
                    });
                }
            };
            let approval = prepared.tool.approval_id();
            let display = prepared.tool.display(match view.spec.language {
                maka_agent_facts::language::Language::En => "en",
                maka_agent_facts::language::Language::ZhCn => "zh-CN",
                maka_agent_facts::language::Language::ZhTw => "zh-TW",
            });
            let semantics = prepared.tool.semantics;
            self.prepared
                .lock()
                .await
                .insert(tool_key(&tool.key), prepared);
            Ok(PreparedDecision {
                decision: ToolDecision::Approved {
                    semantics,
                    input: input.reference().clone(),
                    resources: vec![],
                    approval,
                    display,
                },
                contents: vec![input],
            })
        })
    }
    fn validate_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<ToolValidation, RunError>> {
        Box::pin(async move {
            let configuration = match self.access.live_configuration().await {
                Ok(configuration) => configuration,
                Err(error) => {
                    return Ok(ToolValidation::Denied {
                        rejection: ToolRejection::PolicyDenied {
                            message: error.to_string(),
                        },
                    });
                }
            };
            let virtual_cell = matches!(tool.call.name.as_str(), "exec" | "wait")
                && matches!(&self.backend, NativeBackend::Model { cells: Some(_), .. });
            let discovery = view.spec.tool_discovery
                && tool.call.name == maka_tools::availability::SEARCH
                && matches!(&self.backend, NativeBackend::Model { cells: None, .. });
            if !virtual_cell
                && !discovery
                && configuration
                    .tools
                    .as_ref()
                    .is_some_and(|names| !names.contains(&tool.call.name))
            {
                return Ok(ToolValidation::Denied {
                    rejection: ToolRejection::PolicyDenied {
                        message: "tool is outside current selection".into(),
                    },
                });
            }
            let Some(ToolDecision::Approved {
                input,
                resources,
                approval,
                semantics,
                ..
            }) = &tool.decision
            else {
                return Ok(ToolValidation::Denied {
                    rejection: ToolRejection::PolicyDenied {
                        message: "tool has no original approval".into(),
                    },
                });
            };
            if resources
                .iter()
                .any(|resource| matches!(resource, ResourceRecovery::Unavailable { .. }))
            {
                return Ok(ToolValidation::Blocked(BlockerKind::ResourcesUnavailable {
                    tool: tool.key.clone(),
                }));
            }
            let saved: serde_json::Value = self.decode(input).await?;
            if tool.call.input.as_json() != Some(&saved) {
                return Ok(ToolValidation::Denied {
                    rejection: ToolRejection::PolicyDenied {
                        message: "tool input differs from its decided input".into(),
                    },
                });
            }
            if !self
                .prepared
                .lock()
                .await
                .contains_key(&tool_key(&tool.key))
            {
                let catalog = self.catalog_for_tool(view, tool).await?;
                let prepared = match self.prepare_tool(view, tool, catalog).await {
                    Ok(prepared) => prepared,
                    Err(rejection) => return Ok(ToolValidation::Denied { rejection }),
                };
                if prepared.tool.semantics != *semantics {
                    return Ok(ToolValidation::Denied {
                        rejection: ToolRejection::PolicyDenied {
                            message: "tool semantics changed during original preparation".into(),
                        },
                    });
                }
                if prepared.tool.approval_id() != *approval {
                    return Ok(ToolValidation::Denied {
                        rejection: ToolRejection::PolicyDenied {
                            message: "tool approval changed during original preparation".into(),
                        },
                    });
                }
                self.prepared
                    .lock()
                    .await
                    .insert(tool_key(&tool.key), prepared);
            }
            Ok(ToolValidation::Allowed)
        })
    }
    fn lookup_original(
        &self,
        run: RunId,
        key: ToolKey,
    ) -> BoxFuture<'_, Result<OriginalLookup, RunError>> {
        Box::pin(async move {
            if run != self.access.execution().run_id {
                return Err(RunError::InvalidInput("foreign original lookup".into()));
            }
            let source = effects::ReadSource::Intent(key);
            let Some((reference, request)) = self
                .original_effects
                .recovery_request(&source, None, None)
                .await?
            else {
                return Ok(OriginalLookup::Absent);
            };
            if let Err(error) = request.finish().await {
                self.original_effects.retain_reader(source, request);
                return Err(RunError::Tool(ToolError::CleanupUnconfirmed(error)));
            }
            Ok(OriginalLookup::Found(reference))
        })
    }
    fn dispatch_tool(
        &self,
        run: RunId,
        tool: Tool,
    ) -> BoxFuture<'_, Result<DispatchOutcome, RunError>> {
        Box::pin(async move {
            let view = self.access.fresh().await.map_err(RunError::Internal)?;
            let original = view
                .tools
                .get(&tool_key(&tool.key))
                .ok_or_else(|| RunError::InvalidInput("missing original tool".into()))?;
            if run != view.run || !original.admitted || original.call != tool.call {
                return Err(RunError::InvalidInput(
                    "tool has no original committed admission".into(),
                ));
            }
            let sequence = self
                .state
                .tool_admission_revision(run, tool.key.clone())
                .await?
                .ok_or_else(|| {
                    RunError::InvalidInput("tool admission receipt is unavailable".into())
                })?;
            // Cache loss is not a license to repeat an admitted call.
            let selected = self
                .original_effects
                .selected_for_tool(&tool.call.name)
                .await?;
            let effect = self
                .prepared
                .lock()
                .await
                .remove(&tool_key(&tool.key))
                .ok_or_else(|| {
                    RunError::from(BlockerKind::OriginalAdmissionUnknown {
                        tool: tool.key.clone(),
                    })
                })?;
            let PreparedDispatch {
                tool: PreparedTool { effect, local, .. },
                source,
            } = effect;
            let running = match effect.begin(sequence, self.cancellation.clone()) {
                Ok(running) => running,
                Err(error) => {
                    return Ok(DispatchOutcome::Prevented {
                        rejection: ToolRejection::PolicyDenied {
                            message: error.to_string(),
                        },
                    });
                }
            };
            let effects = self.original_effects.clone();
            let (custody, future) = running.execute();
            let original = effects.own(custody, tool.key, selected, source);
            let cleanup = self.cleanup.clone();
            let (reply, observation) = oneshot::channel();
            self.workers.spawn(async move {
                let result = AssertUnwindSafe(future).catch_unwind().await;
                let result = match result {
                    Ok(result) => result,
                    Err(_) => Err(ToolError::OutcomeUnknown("tool worker panicked".into())),
                };
                if let Err(error) = &result {
                    cleanup.observe_tool(error);
                }
                let result = effects.complete(original, result, local).await;
                let _ = reply.send(result);
            });
            observation
                .await
                .map_err(|_| RunError::Internal("original tool observation closed".into()))?
        })
    }
    fn observe_operation(
        &self,
        reference: RecoveryRef,
    ) -> BoxFuture<'_, Result<OperationReply, RunError>> {
        Box::pin(async move {
            let source = effects::ReadSource::Operation(reference.clone());
            let (_, request) = self
                .original_effects
                .recovery_request(&source, None, None)
                .await?
                .ok_or_else(|| {
                    RunError::from(BlockerKind::CurrentAuthorityUnavailable {
                        stage: AuthorityStage::BackendScope,
                        diagnostic: "original caller intent is unavailable".into(),
                    })
                })?;
            let original = match request.recover(reference.clone()) {
                Ok(original) => original.await,
                Err(error) => Err(error),
            };
            let reply = OperationReply {
                reference,
                receipt: match original {
                    Ok(Some(observation)) => Receipt::Recorded {
                        outcome: observation.outcome,
                        cleanup: observation.cleanup,
                    },
                    Ok(None) => Receipt::NotRecorded,
                    Err(diagnostic) => Receipt::Unavailable { diagnostic },
                },
            };
            if let Err(message) = request.finish().await {
                self.original_effects.retain_reader(source, request);
                return Err(RunError::Tool(ToolError::OperationCleanupUnconfirmed {
                    message,
                    observation: Box::new(reply),
                }));
            }
            Ok(reply)
        })
    }
    fn cancel_live(&self, run: RunId) {
        if run == self.access.execution().run_id {
            self.cancellation.cancel();
            if let NativeBackend::Model {
                cells: Some(cells), ..
            } = &self.backend
            {
                cells.coordinator.cancel();
            }
        }
    }
}
