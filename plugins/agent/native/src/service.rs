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

use crate::owner::resolve_session;
use crate::{contract::*, owner::Owner};
use futures_util::future::BoxFuture;
use maka_agent_api::session::StoredSessionConfiguration;
use maka_event_log::sessions::{CatalogScope, CatalogSelection, SessionRecord};
use maka_host_runtime::application::{Context, Handler, HandlerError, HandlerResult, HandlerValue};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::sync::Arc;

mod catalog;
use catalog::{catalog_page, catalog_revision};
pub(crate) use catalog::{summary, summary_for};

mod delivery;
mod diagnostics;
pub(crate) mod history;
mod preview;

pub(crate) struct Agent(pub Arc<Owner>);
fn complete_control(
    context: &Context,
    value: Value,
    change: Option<maka_event_log::root_store::DataChange>,
) -> Result<HandlerValue, String> {
    match change {
        Some(change) => context.complete_change(value, change),
        None => Ok(HandlerValue::Json(value)),
    }
}
impl Handler for Agent {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let owner = self.0.clone();
        if method == "send" {
            return Box::pin(async move {
                let input: Send = decode(input).map_err(HandlerError::from)?;
                let operation = context
                    .operation()
                    .ok_or("agent_mutation_required")
                    .map_err(HandlerError::from)?;
                if !owner
                    .may_control(context.scope(), &input.session_id)
                    .await
                    .map_err(HandlerError::from)?
                {
                    return Ok(HandlerValue::Json(
                        encode(crate::contract::SendResult::NotYourWorker {
                            session_id: input.session_id,
                        })
                        .map_err(HandlerError::from)?,
                    ));
                }
                owner
                    .send(input, operation, context.scope())
                    .await
                    .map_err(HandlerError::from)?
                    .complete(&context)
                    .map_err(HandlerError::from)
            });
        }
        if method == "executorSetup" {
            let owner = self.0.clone();
            return Box::pin(async move {
                owner
                    .executor_setup(decode(input).map_err(HandlerError::from)?, context)
                    .await
                    .map_err(handler_error)
            });
        }
        if matches!(
            method.as_str(),
            "createPreset"
                | "updatePreset"
                | "deletePreset"
                | "markRead"
                | "stop"
                | "stopComputerApp"
                | "editQueue"
                | "uploadAttachment"
                | "snapshotPatch"
                | "fork"
                | "compact"
                | "continueRun"
                | "changeSession"
                | "import"
                | "restoreSessionCheckpoint"
                | "metadata"
                | "selectBackend"
                | "setCompactionPrompt"
                | "respond"
                | "create"
                | "openBot"
                | "changeGoal"
                | "schedule"
                | "project"
        ) {
            return Box::pin(async move {
                let result: Result<HandlerValue, String> = async {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    match method.as_str() {
                        "createPreset" => owner
                            .create_preset(decode(input)?, context.scope())
                            .await?
                            .complete(&context),
                        "updatePreset" => owner
                            .update_preset(decode(input)?, context.scope())
                            .await?
                            .complete(&context),
                        "deletePreset" => owner
                            .delete_preset(decode(input)?, context.scope())?
                            .complete(&context),
                        "project" => owner
                            .project(decode(input)?, context.scope())
                            .await?
                            .complete(&context),
                        "changeGoal" => owner
                            .goal_change(decode(input)?, operation.clone(), context.scope())
                            .await?
                            .complete(&context),
                        "schedule" => owner
                            .schedule_change(decode(input)?, operation.clone(), context.scope())
                            .await?
                            .complete(&context),
                        "create" => owner
                            .create(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "openBot" => owner
                            .open_bot(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "respond" => owner
                            .respond(decode(input)?, operation, &context)
                            .await?
                            .complete(&context),
                        "metadata" => owner
                            .metadata(decode(input)?, context.scope(), operation)
                            .await?
                            .complete(&context),
                        "selectBackend" => owner
                            .select_backend(decode(input)?, operation)
                            .await?
                            .complete(&context),
                        "setCompactionPrompt" => owner
                            .set_compaction_prompt(decode(input)?, operation)
                            .await?
                            .complete(&context),
                        "import" => owner
                            .import(decode(input)?, operation.clone(), context.scope())
                            .await?
                            .complete(&context),
                        "restoreSessionCheckpoint" => owner
                            .restore_session_checkpoint(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "fork" => owner
                            .fork(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "compact" => owner
                            .compact(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "continueRun" => owner
                            .continue_run(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "changeSession" => owner
                            .change_session(decode(input)?, operation)
                            .await?
                            .complete(&context),
                        "snapshotPatch" => owner
                            .snapshot_patch(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "uploadAttachment" => owner
                            .upload_attachment(decode(input)?, &context)
                            .await?
                            .complete(&context),
                        "markRead" => owner
                            .mark_read_canonical(decode(input)?, operation)
                            .await?
                            .complete(&context),
                        "editQueue" => owner
                            .edit_queue(decode(input)?, operation, context.scope())
                            .await?
                            .complete(&context),
                        "stop" => {
                            let input: Stop = decode(input)?;
                            if !owner
                                .may_control(context.scope(), &input.session_id)
                                .await?
                            {
                                return Ok(HandlerValue::Json(encode(Stopped {
                                    requested: false,
                                })?));
                            }
                            owner
                                .prepare_stop_run(&input.session_id, input.run_id, operation)
                                .await?
                                .complete(&context)
                        }
                        "stopComputerApp" => {
                            let (value, change) = owner
                                .prepare_stop_computer_app(
                                    decode(input)?,
                                    context.scope(),
                                    operation,
                                )
                                .await?;
                            complete_control(&context, encode(value)?, change)
                        }
                        _ => unreachable!(),
                    }
                }
                .await;
                result.map_err(handler_error)
            });
        }
        let result = async move {
            match method.as_str() {
                "presets" => {
                    let _: maka_agent_api::preset::PresetsRead = decode(input)?;
                    encode(owner.presets().await?)
                }
                "preset" => encode(owner.preset(decode(input)?).await?),
                "work" => encode(owner.work(decode(input)?).await?),
                "workReadiness" => encode(owner.work_readiness(decode(input)?).await?),
                "list" => encode(catalog_page(&owner, &decode(input)?).await?),
                "catalog" => {
                    let mut input: List = decode(input)?;
                    let mut changes = owner
                        .durable
                        .subscribe()
                        .map_err(|error| error.to_string())?;
                    let mut physical = owner.physical_changes();
                    let mut revision = None;
                    let mut physical_changed = false;
                    loop {
                        // Observe notifications before reading so a racing commit
                        // remains available to wake the next attempt.
                        changes.borrow_and_update();
                        physical_changed |= physical.borrow_and_update().has_changed();
                        let unchanged = if let Some(revision) = &revision {
                            catalog_revision(&owner, &input).await? == *revision
                        } else {
                            false
                        };
                        if !unchanged || physical_changed {
                            match catalog_page(&owner, &input).await {
                                Ok(page) => {
                                    revision = Some(page.revision.clone());
                                    if !matches!(input.position, SessionPosition::Start) {
                                        input.position = page.sessions.first().map_or(
                                            SessionPosition::Start,
                                            |session| SessionPosition::At {
                                                cursor: session.id.clone(),
                                            },
                                        );
                                    }
                                    context.emit(encode(page)?).await?;
                                    physical_changed = false;
                                }
                                // Start/At can race an internal snapshot read.
                                // After/Before require the caller's exact revision
                                // and cannot be retried after it becomes stale.
                                Err(error)
                                    if error == "agent_catalog_changed"
                                        && matches!(
                                            input.position,
                                            SessionPosition::Start | SessionPosition::At { .. }
                                        ) => {}
                                Err(error) => return Err(error),
                            }
                        }
                        tokio::select! {
                            biased;
                            _ = context.scope().cancellation.cancelled() => return Err("agent_observation_cancelled".into()),
                            result = changes.changed() => result.map_err(|_| "agent_observation_closed")?,
                            result = physical.changed() => { result.map_err(|_| "agent_observation_closed")?; physical_changed = true; },
                        }
                    }
                }
                "sessionMcp" => owner.session_mcp(decode(input)?, context).await,
                "projectMcp" => encode(owner.project_mcp(decode(input)?, context.scope()).await?),
                "trustProjectMcp" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .trust_project_mcp(decode(input)?, context.scope())
                            .await?,
                    )
                }
                "globalInstructions" => {
                    let _: GlobalInstructionsRead = decode(input)?;
                    encode(owner.global_instructions(context.scope()).await?)
                }
                "updateGlobalInstructions" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .update_global_instructions(decode(input)?, context.scope())
                            .await?,
                    )
                }
                "skillCandidates" => encode(
                    owner
                        .skill_candidates(decode(input)?, context.scope())
                        .await?,
                ),
                "fileCandidates" => owner.file_candidates(decode(input)?, context).await,
                "tools" => encode(owner.tool_names(context.scope()).await?),
                "goal" => encode(owner.goal(decode(input)?).await?),
                "watchGoal" => {
                    let input: GoalRead = decode(input)?;
                    let mut changes = owner.goal_changes();
                    let mut store_changes = owner.store.subscribe_changes();
                    let mut previous = None;
                    loop {
                        changes.borrow_and_update();
                        store_changes.borrow_and_update();
                        let page = owner.goal(input.clone()).await?;
                        let running = page
                            .current
                            .as_ref()
                            .is_some_and(|goal| goal.status == GoalStatus::Active || goal.pending);
                        let value = encode(page)?;
                        if previous.as_ref() != Some(&value) {
                            previous = Some(value.clone());
                            context.emit(value).await?;
                        }
                        tokio::select! {
                            biased;
                            _ = context.scope().cancellation.cancelled() => return Err("goal_observation_cancelled".into()),
                            result = changes.changed() => result.map_err(|_| "goal_observation_closed")?,
                            result = store_changes.changed() => result.map_err(|_| "goal_observation_closed")?,
                            _ = tokio::time::sleep(std::time::Duration::from_secs(1)), if running => {},
                        }
                    }
                }
                "checklist" => encode(owner.checklist(&decode(input)?).await?),
                "continuationAvailability" => encode(
                    owner
                        .continuation_availability(decode(input)?, context.scope())
                        .await?,
                ),
                "recap" => encode(owner.recap(decode(input)?, context.scope()).await?),
                "predictNextMessage" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .predict_next_message(
                                decode(input)?,
                                context.scope(),
                                operation,
                                context
                                    .operation_scope()
                                    .ok_or("agent_mutation_required")?
                                    .clone(),
                            )
                            .await?,
                    )
                }
                "generateRecap" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .generate_recap(
                                decode(input)?,
                                context.scope(),
                                operation,
                                context
                                    .operation_scope()
                                    .ok_or("agent_mutation_required")?
                                    .clone(),
                            )
                            .await?,
                    )
                }
                "watchChecklist" => {
                    let input: ChecklistRead = decode(input)?;
                    let mut changes = owner.checklist_changes();
                    let mut revision = None;
                    loop {
                        changes.borrow_and_update();
                        let page = owner.checklist(&input).await?;
                        if revision != Some(page.revision) {
                            revision = Some(page.revision);
                            context.emit(encode(page)?).await?;
                        }
                        tokio::select! {
                            biased;
                            _ = context.scope().cancellation.cancelled() => return Err("checklist_observation_cancelled".into()),
                            result = changes.changed() => result.map_err(|_| "checklist_observation_closed")?,
                        }
                    }
                }
                "markBotRead" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.mark_bot_read(decode(input)?).await?)
                }
                "botOutbox" => encode(owner.bot_outbox(&decode(input)?).await?),
                "watchBotOutbox" => {
                    let input: BotOutboxRead = decode(input)?;
                    let mut changes = owner.bot_changes();
                    let mut through = None;
                    loop {
                        changes.borrow_and_update();
                        let page = owner.bot_outbox(&input).await?;
                        let observed = (page.session_id.clone(), page.through, page.read_through);
                        if through.as_ref() != Some(&observed) {
                            through = Some(observed);
                            context.emit(encode(page)?).await?;
                        }
                        tokio::select! {
                            biased;
                            _ = context.scope().cancellation.cancelled() => return Err("bot_observation_cancelled".into()),
                            result = changes.changed() => result.map_err(|_| "bot_observation_closed")?,
                        }
                    }
                }
                "schedules" => encode(owner.schedules(decode(input)?).await?),
                "watchSchedules" | "scheduleAlerts" => {
                    let mut changes = owner.schedule_changes();
                    let query: Option<ScheduleRead> = if method == "watchSchedules" {
                        Some(decode(input)?)
                    } else {
                        None
                    };
                    loop {
                        changes.borrow_and_update();
                        let value = if let Some(query) = &query {
                            encode(owner.schedules(query.clone()).await?)?
                        } else {
                            encode(owner.schedule_alerts().await?)?
                        };
                        context.emit(value).await?;
                        tokio::select! {
                            biased;
                            _ = context.scope().cancellation.cancelled() => return Err("scheduler_observation_cancelled".into()),
                            result = changes.changed() => result.map_err(|_| "scheduler_observation_closed")?,
                        }
                    }
                }
                "recall" => encode(owner.recall.query(decode(input)?, context.scope()).await?),
                "imports" => encode(owner.imports(decode(input)?, context.scope()).await?),
                "importDirectories" => encode(
                    owner
                        .import_directories(decode(input)?, context.scope())
                        .await?,
                ),
                "projects" => encode(owner.projects(decode(input)?).await?),
                "mcpConfigurations" | "manageMcpServer" => {
                    if context.scope().identity.agent().is_some() {
                        return Err("agent_mcp_user_action_required".into());
                    }
                    if method == "manageMcpServer" {
                        context.operation().ok_or("agent_mutation_required")?;
                        encode(
                            owner
                                .manage_mcp_server(decode(input)?, context.scope())
                                .await?,
                        )
                    } else {
                        encode(
                            owner
                                .mcp_configurations(decode(input)?, context.scope())
                                .await?,
                        )
                    }
                }
                "selectWorkspace" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    if context.scope().identity.agent().is_some() {
                        return Err("agent_workspace_user_action_required".into());
                    }
                    encode(
                        owner
                            .select_workspace(decode(input)?, context.scope())
                            .await?,
                    )
                }
                "directories" => encode(
                    maka_workspace_support::query(
                        owner.workspace_roots.clone(),
                        decode(input)?,
                        owner.home.as_deref(),
                    )
                    .await?,
                ),
                "previewHistoryCheckpoint" => encode(
                    owner
                        .preview_history_checkpoint(decode(input)?, context.scope())
                        .await?,
                ),
                "historyCheckpointHead" => encode(
                    owner
                        .history_checkpoint_head(decode(input)?, context.scope())
                        .await?,
                ),
                "readHistoryCheckpoint" => {
                    owner.read_history_checkpoint(decode(input)?, context).await
                }
                "loadHistoryCheckpoint" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .load_history_checkpoint(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "sessionCheckpointRestoreReceipt" => encode(
                    owner
                        .session_checkpoint_restore_receipt(decode(input)?, context)
                        .await?,
                ),
                "publishCheckpoint" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .publish_checkpoint(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "checkpointReceipt" => {
                    encode(owner.checkpoint_receipt(decode(input)?, context).await?)
                }
                "historyCheckpointLoadReceipt" => encode(
                    owner
                        .history_checkpoint_load_receipt(decode(input)?, context)
                        .await?,
                ),
                "loadedHistoryCheckpointToolImage" => checkpoint_output(
                    owner
                        .loaded_checkpoint_tool_image(decode(input)?, context.scope())
                        .await?,
                ),
                "loadedHistoryCheckpointAttachmentImage" => checkpoint_output(
                    owner
                        .loaded_checkpoint_attachment_image(decode(input)?, context.scope())
                        .await?,
                ),
                "loadedHistoryCheckpointSource" => checkpoint_output(
                    owner
                        .loaded_checkpoint_source(decode(input)?, context.scope())
                        .await?,
                ),
                "loadedHistoryCheckpointHistory" => checkpoint_output(
                    owner
                        .loaded_checkpoint_history(decode(input)?, context.scope())
                        .await?,
                ),
                "loadedHistoryCheckpointArtifacts" => checkpoint_output(
                    owner
                        .loaded_checkpoint_artifacts(decode(input)?, context.scope())
                        .await?,
                ),
                "loadedHistoryCheckpointArtifact" => {
                    owner
                        .loaded_checkpoint_artifact(decode(input)?, context)
                        .await
                }
                "forkReceipt" => encode(owner.fork_receipt(decode(input)?, context.scope()).await?),
                "context" => encode(owner.context(decode(input)?, context.scope()).await?),
                "gitStatus" => encode(owner.git_status(decode(input)?, context.scope()).await?),
                "listFiles" => {
                    let result = encode(owner.list_files(decode(input)?, context.scope()).await?)?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_files_output_unavailable")?;
                    Ok(result)
                }
                "watchFiles" => owner.watch_files(decode(input)?, context).await,
                "readFile" => owner.read_file(decode(input)?, context).await,
                "gitDiff" => encode(owner.git_diff(decode(input)?, context.scope()).await?),
                "readPatch" => encode(owner.read_patch(decode(input)?, context.scope()).await?),
                "diagnostics" => diagnostics::query(&owner, decode(input)?, &context).await,
                "watchDiagnostics" => diagnostics::watch(&owner, decode(input)?, &context).await,
                "observe" => {
                    encode(history::observation(&owner, context.scope(), decode(input)?).await?)
                }
                "history" => encode(history::read(&owner, context.scope(), decode(input)?).await?),
                "historyLandmarks" => {
                    encode(history::landmarks(&owner, context.scope(), decode(input)?).await?)
                }
                "historyPrompt" => {
                    encode(history::prompt(&owner, context.scope(), decode(input)?).await?)
                }
                "historyRequests" => {
                    encode(history::requests(&owner, context.scope(), decode(input)?).await?)
                }
                "search" => encode(history::search(&owner, context.scope(), decode(input)?).await?),
                "source" => encode(history::source(&owner, context.scope(), decode(input)?).await?),
                "toolImage" => {
                    encode(history::tool_image(&owner, context.scope(), decode(input)?).await?)
                }
                "attachmentImage" => encode(
                    history::attachment_image(&owner, context.scope(), decode(input)?).await?,
                ),
                "externalAgents" => {
                    let input: maka_agent_api::external::ExternalAgentsRead = decode(input)?;
                    encode(
                        owner
                            .external_agents(input.inspect, context.scope())
                            .await?,
                    )
                }
                "externalUsageLimits" => {
                    let input: maka_agent_api::external::ExternalUsageLimitsRead = decode(input)?;
                    owner
                        .external_usage_limits(input.runtime, context.scope())
                        .await
                }
                "executors" => {
                    let _: ExecutorsRead = decode(input)?;
                    encode(Executors {
                        setup: owner
                            .settings
                            .executors
                            .iter()
                            .filter(|choice| choice.setup.is_some())
                            .map(|choice| choice.name.clone())
                            .collect(),
                        executors: owner.executors.names(),
                    })
                }
                "models" => encode(
                    owner
                        .models(decode(input)?, &context.scope().cancellation)
                        .await?,
                ),
                "model" => encode(
                    owner
                        .model(decode(input)?, &context.scope().cancellation)
                        .await?,
                ),
                "execution" => encode(owner.execution(decode(input)?).await?),
                "compactionPrompt" => encode(owner.compaction_prompt(decode(input)?).await?),
                "computerApps" => {
                    let input: SessionRead = decode(input)?;
                    encode(owner.computer_apps(&input.session_id).await?)
                }
                "queue" => {
                    let input: SessionRead = decode(input)?;
                    encode(owner.queue(&input.session_id).await?)
                }
                "queueMessage" => encode(owner.queue_message(decode(input)?).await?),
                "pendingInteractions" => {
                    let input: SessionRead = decode(input)?;
                    owner
                        .require_interaction_access(context.scope(), &input.session_id)
                        .await?;
                    encode(owner.pending_interactions(&input.session_id).await?)
                }
                "interaction" => {
                    let input: InteractionRead = decode(input)?;
                    owner
                        .require_interaction_access(context.scope(), &input.session_id)
                        .await?;
                    encode(
                        owner
                            .interaction(&input.session_id, &input.request_id)
                            .await?,
                    )
                }
                "systemPermissionStatus" => {
                    let input: InteractionRead = decode(input)?;
                    owner
                        .require_interaction_access(context.scope(), &input.session_id)
                        .await?;
                    encode(owner.system_permission_status(input).await?)
                }
                "requestSystemPermission" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .request_system_permission(decode(input)?, context.scope())
                            .await?,
                    )
                }
                "watch" => delivery::watch(&owner, decode(input)?, &context).await,
                _ => Err("agent_method_unavailable".into()),
            }
        };
        Box::pin(async move {
            let result: std::result::Result<Value, String> = result.await;
            result.map(HandlerValue::Json).map_err(handler_error)
        })
    }
}
fn decode<T: DeserializeOwned>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|_| "agent_input_invalid".into())
}
fn handler_error(diagnostic: String) -> HandlerError {
    match diagnostic.as_str() {
        "agent_fork_outcome_unknown"
        | "agent_import_unknown"
        | "agent_history_checkpoint_outcome_unknown"
        | "agent_work_unknown"
        | "agent_worktree_unknown"
        | "agent_worktree_materialization_unknown"
        | "agent_worktree_initialization_unknown"
        | "agent_project_commit_unknown"
        | "agent_project_registration_unknown"
        | "agent_project_selection_unknown"
        | "agent_workspace_initialization_failed" => HandlerError::Unknown { diagnostic },
        _ => HandlerError::Returned { diagnostic },
    }
}
fn checkpoint_output<T: Serialize>(value: T) -> Result<Value, String> {
    let value = encode(value)?;
    maka_plugin_core::json::exact_numbers(&value)
        .map_err(|_| "agent_history_checkpoint_output_unavailable")?;
    Ok(value)
}
fn encode<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "agent_output_unavailable".into())
}

impl maka_host_runtime::application::NativeOwner for Agent {
    fn activated(&self) {
        self.0.activated();
    }
    fn retiring(&self) {
        self.0.retiring();
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        self.0.prepare_retirement()
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        self.0.close()
    }
}
