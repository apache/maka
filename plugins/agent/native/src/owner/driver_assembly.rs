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
use maka_agent_engine::{DriverExit, cleanup::Evidence};
use maka_agent_facts::durable::*;
use maka_agent_state::fold::RunView;
use serde::de::DeserializeOwned;

#[derive(Debug)]
pub(super) struct RestorationError {
    pub(super) stage: AuthorityStage,
    pub(super) cause: RunError,
}
impl From<RunError> for RestorationError {
    fn from(cause: RunError) -> Self {
        Self {
            stage: AuthorityStage::InputCodec,
            cause,
        }
    }
}
impl From<maka_event_log::StoreError> for RestorationError {
    fn from(cause: maka_event_log::StoreError) -> Self {
        RunError::from(cause).into()
    }
}

impl Owner {
    pub(super) async fn run_content<T: DeserializeOwned>(
        &self,
        run: RunId,
        reference: &ContentRef,
    ) -> Result<T, RunError> {
        let bytes = self.durable.content(run, reference.clone()).await?;
        serde_json::from_slice(&bytes).map_err(|error| RunError::InvalidInput(error.to_string()))
    }

    /// Rehydrate data, then bind it to independently acquired current capabilities.
    pub(super) async fn restored_data(
        &self,
        view: &RunView,
    ) -> Result<(CapturedRun, crate::tools::SelectionSnapshot), RestorationError> {
        let current = self
            .mutable_session(&view.spec.session_id)
            .await
            .map_err(|error| RestorationError {
                stage: AuthorityStage::CurrentSession,
                cause: RunError::InvalidInput(error),
            })?;
        let selection: crate::tools::SelectionSnapshot = self
            .run_content(view.run, &view.spec.tool_selection)
            .await?;
        let system: Option<SystemPrompt> =
            self.run_content(view.run, &view.spec.system_prompt).await?;
        let (model, executor) = match &view.spec.backend {
            BackendSpec::Model { descriptor, .. } => {
                let bytes = self.durable.content(view.run, descriptor.clone()).await?;
                (
                    Some(crate::model::AcceptedModel::from_backend(
                        &view.spec.backend,
                        &bytes,
                    )?),
                    None,
                )
            }
            BackendSpec::Executor { descriptor, .. } => {
                (None, Some(self.run_content(view.run, descriptor).await?))
            }
            BackendSpec::Historical { .. } => {
                return Err(RunError::InvalidInput(
                    "Static history cannot obtain a live backend".into(),
                )
                .into());
            }
        };
        let discovery = self.scheduler.investigation.read().unwrap().as_deref()
            == Some(view.spec.session_id.as_str());
        let catalog = if executor.is_some() || discovery {
            self.mcp_projects.base.clone()
        } else {
            let floor = self
                .capture_sandbox(
                    &current.configuration,
                    &view.spec.permission_ceiling.sandbox,
                )
                .await
                .map_err(|error| RestorationError {
                    stage: AuthorityStage::WorkspaceScope,
                    cause: RunError::InvalidInput(error),
                })?;
            self.mcp_projects
                .capture(&current.configuration.workspace, &floor)
                .await
                .map_err(|error| RestorationError {
                    stage: AuthorityStage::ToolBindings,
                    cause: RunError::InvalidInput(error),
                })?
        };
        let catalog = if model.is_some() && !discovery {
            self.mcp_projects
                .with_client(&view.spec.session_id, catalog)
                .map_err(|error| RestorationError {
                    stage: AuthorityStage::ToolBindings,
                    cause: RunError::InvalidInput(error),
                })?
        } else {
            catalog
        };
        let compaction_prompt = match &view.spec.compaction_prompt {
            Some(reference) => Some(self.run_content(view.run, reference).await?),
            None => None,
        };
        let input: maka_agent_facts::input::RunInput =
            self.run_content(view.run, &view.spec.input).await?;
        let fingerprint = match input {
            maka_agent_facts::input::RunInput::Message {
                request_fingerprint,
                ..
            } => request_fingerprint.unwrap_or_default(),
            _ => String::new(),
        };
        let basis = CapturedRun {
            mcp_catalog: Some(catalog.clone()),
            mcp_revision: view.spec.mcp_revision.clone(),
            client_mcp: catalog.client_mcp,
            compaction_prompt,
            collaboration_mode: view.spec.collaboration,
            language: view.spec.language,
            background_kind: match &view.spec.trigger {
                Trigger::HistorySource => {
                    return Err(RunError::InvalidInput(
                        "Historical source is not executable".into(),
                    )
                    .into());
                }
                Trigger::Goal { goal_id } => BackgroundKind::Goal(*goal_id),
                Trigger::Schedule { schedule_id } => BackgroundKind::Schedule {
                    task_id: schedule_id.clone(),
                },
                Trigger::Message { .. }
                | Trigger::Continuation { .. }
                | Trigger::ContextCompact => BackgroundKind::Interactive,
            },
            tool_discovery: view.spec.tool_discovery,
            allowed_tools: view.spec.allowed_tools.clone(),
            background: None,
            internal_tools: Arc::new(selection.definitions.clone()),
            internal_bindings: Arc::new(selection.internal_bindings.clone()),
            behavior: system,
            model,
            executor,
            workspace: current.configuration.workspace,
            binding: current.configuration.binding,
            fingerprint,
        };
        Ok((basis, selection))
    }

    pub(super) fn run_catalog(
        &self,
        access: Arc<RunAccess>,
        mcp: &crate::mcp::Catalog,
        frozen: &crate::tools::SelectionSnapshot,
    ) -> Result<maka_tools::ToolCatalog, RunError> {
        let mut live = crate::tools::catalog_for_run(
            self.services.clone(),
            self.configuration.clone(),
            &self.settings.tools,
            self.internal_registrations.clone(),
            self.workers.clone(),
            access.clone(),
        )
        .map_err(RunError::InvalidInput)?;
        if self.settings.goals {
            live.tools = live
                .tools
                .with_always_visible(super::goal::tools::NAMES)
                .map_err(|error| RunError::InvalidInput(error.to_string()))?;
        }
        let live_tools = mcp
            .for_run(access, live.tools)
            .map_err(RunError::InvalidInput)?;
        // Keep the admitted tool declarations across Host activations.
        let direct_only: std::collections::BTreeSet<_> =
            live_tools.direct_only().names().into_iter().collect();
        let excluded: Vec<_> = live_tools
            .definitions()
            .filter(|definition| {
                !frozen.definitions.iter().any(|original| {
                    original.name == definition.name
                        && super::driver::same_tool_contract(original, definition)
                }) || (direct_only.contains(&definition.name)
                    != frozen.direct_only.contains(&definition.name))
                    || !frozen.matches_service(&definition.name, &live.basis)
                    || frozen.internal_bindings.get(&definition.name)
                        != mcp.bindings.get(&definition.name)
            })
            .map(|definition| definition.name.as_str())
            .collect();
        let catalog = live_tools.excluding(&excluded);
        let always_visible: Vec<_> = [bot::SEND_USER, bot::SLEEP]
            .into_iter()
            .chain(discovery::VISIBLE_TOOLS.iter().copied())
            .filter(|name| catalog.contains(name))
            .collect();
        catalog
            .with_always_visible(&always_visible)
            .map_err(|error| RunError::InvalidInput(error.to_string()))
    }

    async fn unavailable_current(
        &self,
        state: maka_agent_state::Store,
        claim: maka_agent_state::DriverClaim,
        stage: AuthorityStage,
        diagnostic: String,
    ) -> Result<DriverExit, RunError> {
        let engine = Engine::new(state.clone());
        loop {
            match engine
                .current_authority_unavailable(
                    claim.clone(),
                    stage.clone(),
                    diagnostic.clone(),
                    UnixMillis(now().try_into().expect("Unix milliseconds")),
                )
                .await
            {
                Err(RunError::PublicationUncertain { publication, .. }) => {
                    publication.reconcile(&state).await?;
                }
                result => return result,
            }
        }
    }

    pub(super) async fn run_with_capabilities(
        self: &Arc<Self>,
        view: RunView,
        claim: maka_agent_state::DriverClaim,
        cancellation: CancellationToken,
    ) -> (
        Result<DriverExit, RunError>,
        maka_plugin_core::operation::OperationCleanup,
    ) {
        let mut scope_cleanup = maka_plugin_core::operation::OperationCleanup::Confirmed;
        let result: Result<DriverExit, RunError> = async {
            if claim.run() != view.run || claim.purpose() != maka_agent_state::DriverPurpose::Business {
                return Err(RunError::InvalidInput("not the admitted business driver claim".into()));
            }
            let current = match self.mutable_session(&view.spec.session_id).await {
                Ok(current) => current,
                Err(error) => {
                    return self.unavailable_current(self.durable.clone(), claim, AuthorityStage::CurrentSession, error)
                        .await;
                }
            };
            let scope = match self
                .current_work_scope(&view.spec.session_id, &current.configuration)
                .await
            {
                Ok(scope) => scope,
                Err(error) => {
                    return self.unavailable_current(self.durable.clone(), claim, AuthorityStage::WorkspaceScope, error.to_string())
                        .await;
                }
            };
            let (lease, effects) = scope.accept(cancellation.clone());
            scope_cleanup = maka_plugin_core::operation::OperationCleanup::Unconfirmed;
            let mut original_driver = None;
            let mut cleanup_confirmed = false;
            let mut preflight_stage = Some(AuthorityStage::WorkspaceScope);
            let mut publication_store = self.durable.clone();
            // Preserve the physical lease even if data preparation fails before the driver starts.
            let result = async {
                let access = self.run_access(Arc::new(view.spec.clone()), claim.clone(), &lease).map_err(RunError::InvalidInput)?;
                let writer = self.store.data_writer_for_work(access.custody().as_ref(), &view.spec.session_id)?;
                let state = self.durable.with_data_writer(writer)?;
                publication_store = state.clone();
                preflight_stage = Some(AuthorityStage::InputCodec);
                let (basis, selection) = self.restored_data(&view).await.map_err(|failure| { preflight_stage = Some(failure.stage); failure.cause })?;
                preflight_stage = Some(AuthorityStage::ToolBindings);
                let catalog = self.run_catalog(access.clone(), basis.mcp_catalog.as_ref().ok_or_else(|| RunError::InvalidInput("current MCP capability is unavailable".into()))?, &selection)?;
                preflight_stage = Some(AuthorityStage::BackendScope);
                let cleanup = Evidence::default();
                let workers = TaskTracker::new();
                let (preview_sender, preview) = tokio::sync::watch::channel(None);
                let mut original_external_effects = None;
                let work_cancellation = cancellation.child_token();
                let backend = match (&basis.model, &basis.executor) {
                    (Some(accepted), None) => {
                        let cells = if accepted.tool_mode == maka_agent_facts::execution::ToolMode::CodeMode {
                            Some(driver_cells::RunCells::new(self.clone(), access.clone(), self.code_executor.clone().with_language(accepted.code_language), workers.clone(), cleanup.clone()).map_err(RunError::Tool)?)
                        } else { None };
                        let source = crate::model::Source::restore(
                            self.configuration.clone(),
                            self.credentials.clone(),
                            accepted.clone(),
                            view.spec.session_id.clone(),
                            self.revision.clone(),
                        )?;
                        let source = if let Some(pricing) = &self.pricing {
                            source.with_pricing(pricing.clone())
                        } else { source };
                        let model = driver_model::DriverModel {
                        state: state.clone(),
                        log: Arc::new(lease.store()),
                        source: Arc::new(source),
                        executor: self.credentials.executor.clone(),
                        resources: self.services.model_preparation_resources(),
                        execution: access.execution().clone(),
                        cancellation: work_cancellation.clone(),
                        cleanup: cleanup.clone(),
                        workers: workers.clone(),
                        original_cleanup: Default::default(),
                        conversation: Default::default(),
                        preview: preview_sender,
                        };
                        driver::NativeBackend::Model { model, cells }
                    }
                    (None, Some(accepted)) => {
                        let mut backend = self.executors.restore(accepted).map_err(RunError::InvalidInput)?;
                        let effects = driver_external_effects::NativeExternalEffects::new(self.clone(), access.clone(), claim.clone(), cleanup.clone(), workers.clone())?;
                        original_external_effects = Some(effects.clone());
                        backend.bind_host_tools(crate::executor::external::HostTools { catalog: self.external_catalog(catalog.clone()), resource_reads: self.resource_reads.clone(), effects: Arc::new(effects) });
                        let inputs = driver_executor_inputs::NativeInputs::new(self.clone(), access.clone(), claim.clone()).map_err(|error| RunError::InvalidInput(error.to_string()))?;
                        let instructions: Option<SystemPrompt> = self.run_content(view.run, &view.spec.system_prompt).await?;
                        let state_root = self.store.owned_root()?.canonical_path().to_path_buf();
                        driver::NativeBackend::Executor(Arc::new(driver_executor::DriverExecutor { state: state.clone(), backend, access: access.clone(), inputs: Arc::new(inputs), instructions: instructions.map(|prompt| prompt.text), cancellation: work_cancellation.clone(), root_observation: cancellation.child_token(), cleanup: cleanup.clone(), workers: workers.clone(), retained: Arc::default(), state_root, prepared_private: Default::default(), candidate_capture: Default::default(), publication: Default::default() }))
                    }
                    _ => return Err(RunError::InvalidInput("Run has no unique current backend".into())),
                };
                let driver = Arc::new(driver::NativeDriver::new(
                    self.clone(),
                    state.clone(),
                    access.clone(),
                    catalog,
                    basis.mcp_catalog.as_ref().ok_or_else(|| RunError::InvalidInput("current MCP capability is unavailable".into()))?.clone(),
                    backend,
                    work_cancellation,
                    cleanup.clone(),
                    workers,
                ));
                original_driver = Some(driver.clone());
                if let Some(effects) = original_external_effects { driver.attach_external_effects(effects)?; }
                self.runs.state().await.controls.insert(
                    view.spec.session_id.clone(),
                    Control {
                        compacting: false,
                        preview,
                        execution: access.execution().clone(),
                        access: Arc::downgrade(&access),
                        basis: Arc::new(basis),
                        cancellation: cancellation.clone(),
                    },
                );
                self.runs.state().await.preparing.remove(&view.spec.session_id);
                self.title_after_message(access.execution().clone(), access.custody().clone());
                preflight_stage = None;
                let engine = Engine::new(state.clone());
                let mut changes = state.subscribe()?;
                let mut model_changes = match &driver.backend {
                    driver::NativeBackend::Model { model, .. } => Some(model.original_cleanup.changes()),
                    _ => None,
                };
                let mut cell_changes = match &driver.backend {
                    driver::NativeBackend::Model { cells: Some(cells), .. } => Some(cells.physical_changes()),
                    _ => None,
                };
                let mut observed_revision = view.revision;
                let driven = loop {
                    changes.borrow_and_update();
                    if let Some(changes) = model_changes.as_mut() { changes.borrow_and_update(); }
                    if let Some((javascript, python, coordinator)) = cell_changes.as_mut() {
                        javascript.borrow_and_update();
                        python.borrow_and_update();
                        coordinator.borrow_and_update();
                    }
                    let cells_live_before = matches!(&driver.backend, driver::NativeBackend::Model { cells: Some(cells), .. } if !cells.coordinator.is_idle());
                    if let driver::NativeBackend::Model { model, .. } = &driver.backend
                        && let Err(error) = model.original_cleanup.reconcile_pending().await {
                            tracing::error!(run = %view.run, %error, "Original model cleanup publication remains unresolved");
                        }
                    let driven = engine.drive(claim.clone(), driver.clone(), cancellation.clone()).await;
                    match driven {
                        Err(RunError::PublicationUncertain { publication, .. }) => {
                            if let Err(source) = publication.reconcile(&state).await {
                                break match source.underlying() {
                                    maka_event_log::StoreError::EventConflict
                                    | maka_event_log::StoreError::InvalidTransition(_) => Err(source.into()),
                                    _ => Err(RunError::PublicationUncertain { publication, source }),
                                };
                            }
                        }
                        Ok(exit @ (DriverExit::Waiting { due_at, .. } | DriverExit::Blocked { due_at, .. })) => {
                            let resources_live = driver.has_live_resources();
                            let cells_live = matches!(&driver.backend, driver::NativeBackend::Model { cells: Some(cells), .. } if !cells.coordinator.is_idle());
                            let pending_cell = {
                                let current = state.frontier(view.run).await?;
                                if current.blockers.values().any(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none()) {
                                    break Ok(exit);
                                }
                                if current.revision != observed_revision {
                                    observed_revision = current.revision;
                                    continue;
                                }
                                current.cells.values().any(|cell| matches!(cell.status, maka_agent_facts::cells::CellStatus::Running))
                            };
                            // The level can become idle before its physical notice is sent.
                            // Let the same driver observe that final transition once.
                            if pending_cell && cells_live_before && !cells_live {
                                continue;
                            }
                            if !resources_live && !cells_live {
                                break Ok(exit);
                            }
                            let deadline = async {
                                match due_at {
                                    Some(at) => tokio::time::sleep(Duration::from_millis(at.0.saturating_sub(now() as i64).max(0) as u64)).await,
                                    None => std::future::pending::<()>().await,
                                }
                            };
                            tokio::select! {
                                biased;
                                _ = cancellation.cancelled() => {},
                                _ = async {
                                    match model_changes.as_mut() {
                                        Some(changes) => { let _ = changes.changed().await; }
                                        None => std::future::pending::<()>().await,
                                    }
                                } => {},
                                _ = async {
                                    match cell_changes.as_mut() {
                                        Some((javascript, python, coordinator)) => {
                                            tokio::select! {
                                                _ = javascript.changed() => {},
                                                _ = python.changed() => {},
                                                _ = coordinator.changed() => {},
                                            }
                                        }
                                        None => std::future::pending::<()>().await,
                                    }
                                } => {},
                                changed = changes.changed() => if changed.is_err() { break Ok(exit); },
                                _ = deadline => {},
                            }
                        }
                        result => break result,
                    }
                };
                claim.deactivate();
                if matches!(&driven, Ok(DriverExit::Terminal { .. })) {
                    let mut runs = self.runs.state().await;
                    if runs.controls.get(&view.spec.session_id).is_some_and(|control| control.execution.run_id == view.run) {
                        runs.controls.remove(&view.spec.session_id);
                    }
                    drop(runs);
                    self.wake_notify.notify_one();
                }
                let cleaned = driver.finish().await;
                cleanup_confirmed = cleaned.is_ok();
                // Preserve an uncertain original batch alongside its cleanup state.
                if !matches!(&driven, Err(RunError::PublicationUncertain { .. })) {
                    cleaned?;
                }
                driven
            }
            .await;
            let result = match (result, preflight_stage) {
                (Err(error), Some(stage)) if !error.is_cleanup_unconfirmed() => {
                    self.unavailable_current(publication_store.clone(), claim, stage, error.to_string())
                        .await
                }
                (result, _) => result,
            };
            // Constructors before NativeDriver only assemble ports; none dispatch Run-owned work.
            // A pending canonical batch still owns its original payload independently of that proof.
            if original_driver.is_none() && !matches!(&result, Err(RunError::PublicationUncertain { .. })) { cleanup_confirmed = true; }
            let pending = match &result { Err(RunError::PublicationUncertain { publication, .. }) => Some(publication.as_ref().clone()), _ => None };
            if !cleanup_confirmed || pending.is_some() {
                let _historical_failure = effects.seal();
                self.retain_original_scope(
                    view.spec.session_id.clone(),
                    lease,
                    driver_cleanup::OriginalScope::Driver {
                        driver: original_driver,
                        effects,
                        state: publication_store,
                        pending,
                    },
                )
                .await;
                return result.and(Err(RunError::CleanupUnconfirmed));
            }
            if let Err(error) = effects.settle().await {
                self.retain_original_scope(view.spec.session_id.clone(), lease, driver_cleanup::OriginalScope::Driver { driver: original_driver, effects, state: publication_store, pending: None }).await;
                return result.and(Err(RunError::Store(error)));
            }
            lease.finish();
            scope_cleanup = maka_plugin_core::operation::OperationCleanup::Confirmed;
            result
        }.await;
        (result, scope_cleanup)
    }
}
