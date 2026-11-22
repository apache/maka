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
use catalog::{
    CATALOG_REFRESH_MIN_INTERVAL, catalog_page, catalog_revision, wait_for_catalog_refresh,
};
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
fn discovery_desktop(context: &Context) -> Result<(), String> {
    if context.scope().identity.agent().is_some() {
        return Err("discovery_use_model_tools".into());
    }
    Ok(())
}
struct CallArgs {
    owner: Arc<Owner>,
    input: Value,
    context: Context,
}

impl Handler for Agent {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let mut args = Some(CallArgs {
            owner: self.0.clone(),
            input,
            context,
        });
        // Match synchronously and box each RPC behind an out-of-line helper so
        // neither dispatch nor polling accumulates unrelated method frames.
        match method.as_str() {
            // session mutations
            "send" => box_rpc(&mut args, |owner, input, context| async move {
                let input: Send = decode(input).map_err(HandlerError::from)?;
                let operation = context
                    .operation()
                    .ok_or("agent_mutation_required")
                    .map_err(HandlerError::from)?;
                owner
                    .send(input, operation, context.scope())
                    .await
                    .map_err(HandlerError::from)?
                    .complete(&context)
                    .map_err(HandlerError::from)
            }),
            "create" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .create(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "openBot" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .open_bot(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "respond" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .respond(decode(input)?, operation, &context)
                    .await?
                    .complete(&context)
            }),
            "metadata" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .metadata(decode(input)?, context.scope(), operation)
                    .await?
                    .complete(&context)
            }),
            "selectBackend" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .select_backend(decode(input)?, operation)
                    .await?
                    .complete(&context)
            }),
            "setCompactionPrompt" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .set_compaction_prompt(decode(input)?, operation)
                    .await?
                    .complete(&context)
            }),
            "import" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .import(decode(input)?, operation.clone(), context.scope())
                    .await?
                    .complete(&context)
            }),
            "restoreSessionCheckpoint" => {
                handler_rpc(&mut args, |owner, input, context| async move {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    owner
                        .restore_session_checkpoint(decode(input)?, operation, context.scope())
                        .await?
                        .complete(&context)
                })
            }
            "fork" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .fork(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "compact" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .compact(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "continueRun" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .continue_run(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "changeSession" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .change_session(decode(input)?, operation)
                    .await?
                    .complete(&context)
            }),
            "markRead" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .mark_read_canonical(decode(input)?, operation)
                    .await?
                    .complete(&context)
            }),
            "editQueue" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .edit_queue(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "sessionCreate" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .session_create_tool(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "sessionSend" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .session_send_tool(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "sessionStop" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .session_stop_tool(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "sessionManage" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .session_manage_tool(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "stop" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                let input: Stop = decode(input)?;
                if !owner
                    .may_control(context.scope(), &input.session_id)
                    .await?
                {
                    return Ok(HandlerValue::Json(encode(Stopped { requested: false })?));
                }
                owner
                    .prepare_stop_run(&input.session_id, input.run_id, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "stopComputerApp" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                let (value, change) = owner
                    .prepare_stop_computer_app(decode(input)?, context.scope(), operation)
                    .await?;
                complete_control(&context, encode(value)?, change)
            }),
            // state mutations
            "executorSetup" => handler_rpc(&mut args, |owner, input, context| async move {
                owner.executor_setup(decode(input)?, context).await
            }),
            "changeMemory" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .change_memory(
                        decode(input)?,
                        operation,
                        context.scope(),
                        context
                            .operation_scope()
                            .ok_or("agent_mutation_required")?
                            .clone(),
                    )
                    .await?
                    .complete(&context)
            }),
            "reconcileMemories" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .reconcile_memories(
                        decode(input)?,
                        operation,
                        context.scope(),
                        context
                            .operation_scope()
                            .ok_or("agent_mutation_required")?
                            .clone(),
                    )
                    .await?
                    .complete(&context)
            }),
            "createPreset" => handler_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                owner
                    .create_preset(decode(input)?, context.scope())
                    .await?
                    .complete(&context)
            }),
            "updatePreset" => handler_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                owner
                    .update_preset(decode(input)?, context.scope())
                    .await?
                    .complete(&context)
            }),
            "deletePreset" => handler_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                owner
                    .delete_preset(decode(input)?, context.scope())?
                    .complete(&context)
            }),
            "project" => handler_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                owner
                    .project(decode(input)?, context.scope())
                    .await?
                    .complete(&context)
            }),
            "changeGoal" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .goal_change(decode(input)?, operation.clone(), context.scope())
                    .await?
                    .complete(&context)
            }),
            "schedule" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .schedule_change(decode(input)?, operation.clone(), context.scope())
                    .await?
                    .complete(&context)
            }),
            "saveFile" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                encode(owner.save_file(decode(input)?, &context).await?)
            }),
            "snapshotPatch" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .snapshot_patch(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "uploadAttachment" => handler_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                owner
                    .upload_attachment(decode(input)?, &context)
                    .await?
                    .complete(&context)
            }),
            // history
            "history" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::read(&owner, context.scope(), decode(input)?).await?)
            }),
            "roomState" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.room_state(decode(input)?, context.scope()).await?)
            }),
            "roomSearch" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.room_search(decode(input)?, context.scope()).await?)
            }),
            "roomManage" => handler_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                owner
                    .room_manage(decode(input)?, operation, context.scope())
                    .await?
                    .complete(&context)
            }),
            "observe" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::observation(&owner, context.scope(), decode(input)?).await?)
            }),
            "historyLandmarks" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::landmarks(&owner, context.scope(), decode(input)?).await?)
            }),
            "historyPrompt" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::prompt(&owner, context.scope(), decode(input)?).await?)
            }),
            "historyRequests" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::requests(&owner, context.scope(), decode(input)?).await?)
            }),
            "search" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::search(&owner, context.scope(), decode(input)?).await?)
            }),
            "source" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::source(&owner, context.scope(), decode(input)?).await?)
            }),
            "toolImage" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::tool_image(&owner, context.scope(), decode(input)?).await?)
            }),
            "attachmentImage" => json_rpc(&mut args, |owner, input, context| async move {
                encode(history::attachment_image(&owner, context.scope(), decode(input)?).await?)
            }),
            "watch" => json_rpc(&mut args, |owner, input, context| async move {
                delivery::watch(&owner, decode(input)?, &context).await
            }),
            // sessions
            "presets" => json_rpc(&mut args, |owner, input, _context| async move {
                let _: maka_agent_api::preset::PresetsRead = decode(input)?;
                encode(owner.presets().await?)
            }),
            "preset" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.preset(decode(input)?).await?)
            }),
            "work" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.work(decode(input)?, context.scope()).await?)
            }),
            "workReadiness" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.work_readiness(decode(input)?).await?)
            }),
            "sessionList" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .session_list_tool(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "sessionRead" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .session_read_tool(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "list" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(catalog_page(&owner, &decode(input)?).await?)
            }),
            "catalog" => json_rpc(&mut args, |owner, input, context| async move {
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
                    let mut retry_immediately = false;
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
                                    ) =>
                            {
                                retry_immediately = true;
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    let throttle_until = (!retry_immediately)
                        .then(|| tokio::time::Instant::now() + CATALOG_REFRESH_MIN_INTERVAL);
                    wait_for_catalog_refresh(
                        &mut changes,
                        &mut physical,
                        &mut physical_changed,
                        &context.scope().cancellation,
                        throttle_until,
                    )
                    .await?;
                }
            }),
            "recall" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.recall.query(decode(input)?, context.scope()).await?)
            }),
            "imports" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.imports(decode(input)?, context.scope()).await?)
            }),
            "importDirectories" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .import_directories(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "projects" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.projects(decode(input)?).await?)
            }),
            "tools" => json_rpc(&mut args, |owner, _input, context| async move {
                encode(owner.tool_names(context.scope()).await?)
            }),
            "continuationAvailability" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .continuation_availability(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "execution" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.execution(decode(input)?, context.scope()).await?)
            }),
            "compactionPrompt" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.compaction_prompt(decode(input)?).await?)
            }),
            "computerApps" => json_rpc(&mut args, |owner, input, _context| async move {
                let input: SessionRead = decode(input)?;
                encode(owner.computer_apps(&input.session_id).await?)
            }),
            "queue" => json_rpc(&mut args, |owner, input, _context| async move {
                let input: SessionRead = decode(input)?;
                encode(owner.queue(&input.session_id).await?)
            }),
            "queueMessage" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.queue_message(decode(input)?).await?)
            }),
            "pendingInteractions" => json_rpc(&mut args, |owner, input, context| async move {
                let input: SessionRead = decode(input)?;
                owner
                    .require_interaction_access(context.scope(), &input.session_id)
                    .await?;
                encode(owner.pending_interactions(&input.session_id).await?)
            }),
            "interaction" => json_rpc(&mut args, |owner, input, context| async move {
                let input: InteractionRead = decode(input)?;
                owner
                    .require_interaction_access(context.scope(), &input.session_id)
                    .await?;
                encode(
                    owner
                        .interaction(&input.session_id, &input.request_id)
                        .await?,
                )
            }),
            "systemPermissionStatus" => json_rpc(&mut args, |owner, input, context| async move {
                let input: InteractionRead = decode(input)?;
                owner
                    .require_interaction_access(context.scope(), &input.session_id)
                    .await?;
                encode(owner.system_permission_status(input).await?)
            }),
            "requestSystemPermission" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                encode(
                    owner
                        .request_system_permission(decode(input)?, context.scope())
                        .await?,
                )
            }),
            // models
            "externalAgents" => json_rpc(&mut args, |owner, input, context| async move {
                let input: maka_agent_api::external::ExternalAgentsRead = decode(input)?;
                encode(
                    owner
                        .external_agents(input.inspect, context.scope())
                        .await?,
                )
            }),
            "externalUsageLimits" => json_rpc(&mut args, |owner, input, context| async move {
                let input: maka_agent_api::external::ExternalUsageLimitsRead = decode(input)?;
                owner
                    .external_usage_limits(input.runtime, context.scope())
                    .await
            }),
            "executors" => json_rpc(&mut args, |owner, input, _context| async move {
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
            }),
            "watchModels" => json_rpc(&mut args, |owner, input, context| async move {
                let input: maka_agent_api::contract::ModelsWatch = decode(input)?;
                let mut changes = owner.executors.external_catalog_changes();
                let root = owner
                    .store
                    .owned_root()
                    .map_err(|error| error.to_string())?;
                let mut configuration = root.capability_changes();
                loop {
                    configuration.borrow_and_update();
                    if let Some(changes) = changes.as_mut() {
                        changes.borrow_and_update();
                    }
                    context
                        .emit(encode(
                            owner
                                .models(
                                    maka_agent_api::contract::ModelsRead::Start {
                                        query: input.query.clone(),
                                    },
                                    &context.scope().cancellation,
                                )
                                .await?,
                        )?)
                        .await?;
                    tokio::select! { biased;
                        () = context.scope().cancellation.cancelled() => return Err("agent_model_observation_cancelled".into()),
                        result = configuration.changed() => result.map_err(|_| "agent_model_observation_closed")?,
                        result = async {
                            match changes.as_mut() {
                                Some(changes) => changes.changed().await.map_err(|_| "agent_model_observation_closed"),
                                None => std::future::pending().await,
                            }
                        } => result?,
                    }
                }
            }),
            "models" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .models(decode(input)?, &context.scope().cancellation)
                        .await?,
                )
            }),
            "model" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .model(decode(input)?, &context.scope().cancellation)
                        .await?,
                )
            }),
            // automation
            "memorySource" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.memory_source(decode(input)?, context.scope()).await?)
            }),
            "memoryEvidence" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .memory_evidence(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "memoryHistory" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .memory_history(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "memories" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.memories(decode(input)?, context.scope()).await?)
            }),
            "memory" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.memory(decode(input)?, context.scope()).await?)
            }),
            "pendingMemories" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .pending_memories(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "globalInstructions" => json_rpc(&mut args, |owner, input, context| async move {
                let _: GlobalInstructionsRead = decode(input)?;
                encode(owner.global_instructions(context.scope()).await?)
            }),
            "updateGlobalInstructions" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                encode(
                    owner
                        .update_global_instructions(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "skillCandidates" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .skill_candidates(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "fileCandidates" => json_rpc(&mut args, |owner, input, context| async move {
                owner.file_candidates(decode(input)?, context).await
            }),
            "goal" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.goal(decode(input)?).await?)
            }),
            "watchGoal" => json_rpc(&mut args, |owner, input, context| async move {
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
            }),
            "checklist" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.checklist(&decode(input)?).await?)
            }),
            "watchChecklist" => json_rpc(&mut args, |owner, input, context| async move {
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
            }),
            "recap" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.recap(decode(input)?, context.scope()).await?)
            }),
            "askQuickQuestion" => json_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                let (progress, mut updates) = tokio::sync::watch::channel(String::new());
                let generation = owner.ask_quick_question(
                    decode(input)?,
                    context.scope(),
                    operation,
                    context
                        .operation_scope()
                        .ok_or("agent_mutation_required")?
                        .clone(),
                    progress,
                );
                tokio::pin!(generation);
                loop {
                    tokio::select! {
                        result = &mut generation => {
                            let info = result?;
                            let answer = updates.borrow().clone();
                            context.emit(encode(answer)?).await?;
                            return encode(info);
                        }
                        Ok(()) = updates.changed() => {
                            let answer = updates.borrow_and_update().clone();
                            context.emit(encode(answer)?).await?;
                        }
                    }
                }
            }),
            "predictNextMessage" => json_rpc(&mut args, |owner, input, context| async move {
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
            }),
            "generateRecap" => json_rpc(&mut args, |owner, input, context| async move {
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
            }),
            "markBotRead" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                encode(owner.mark_bot_read(decode(input)?).await?)
            }),
            "botOutbox" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.bot_outbox(&decode(input)?).await?)
            }),
            "watchBotOutbox" => json_rpc(&mut args, |owner, input, context| async move {
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
            }),
            "dossiers" => json_rpc(&mut args, |owner, input, context| async move {
                discovery_desktop(&context)?;
                let _: DossiersRead = decode(input)?;
                encode(
                    owner
                        .discovery
                        .dossiers()
                        .await
                        .map_err(|e| e.to_string())?,
                )
            }),
            "dossier" => json_rpc(&mut args, |owner, input, context| async move {
                discovery_desktop(&context)?;
                let query: DossierRead = decode(input)?;
                encode(
                    owner
                        .discovery
                        .detail(query.topic_id)
                        .await
                        .map_err(|e| e.to_string())?,
                )
            }),
            "readDossierArtifact" => json_rpc(&mut args, |owner, input, context| async move {
                discovery_desktop(&context)?;
                encode(owner.read_dossier_artifact(decode(input)?).await?)
            }),
            "watchDossiers" => json_rpc(&mut args, |owner, input, context| async move {
                discovery_desktop(&context)?;
                let _: DossiersRead = decode(input)?;
                let mut changes = owner.discovery.subscribe();
                let previous = owner
                    .discovery
                    .latest_interrupt()
                    .await
                    .map_err(|e| e.to_string())?;
                loop {
                    let latest_interrupt = changes
                        .borrow_and_update()
                        .clone()
                        .or_else(|| previous.clone());
                    let state = owner
                        .discovery
                        .dossiers()
                        .await
                        .map_err(|e| e.to_string())?;
                    context
                        .emit(encode(DossiersUpdate {
                            state,
                            latest_interrupt,
                        })?)
                        .await?;
                    tokio::select! {
                        biased;
                        _=context.scope().cancellation.cancelled()=>return Err("discovery_observation_cancelled".into()),
                        result=changes.changed()=>result.map_err(|_|"discovery_observation_closed")?,
                    }
                }
            }),
            "setDossierMuted" => handler_rpc(&mut args, |owner, input, context| async move {
                discovery_desktop(&context)?;
                context.operation().ok_or("agent_mutation_required")?;
                let input: DossierMute = decode(input)?;
                context.complete_change(Value::Null, owner.prepare_dossier_mute(input)?)
            }),
            "setDiscoveryNotifications" => {
                handler_rpc(&mut args, |owner, input, context| async move {
                    discovery_desktop(&context)?;
                    context.operation().ok_or("agent_mutation_required")?;
                    let input: DiscoveryNotifications = decode(input)?;
                    let state = owner.discovery.preferences_statement(
                        input.enabled,
                        maka_agent_facts::durable::UnixMillis(maka_agent_authority::now() as i64),
                    );
                    context.complete_change(
                        Value::Null,
                        owner
                            .store
                            .data_writer()
                            .map_err(|e| e.to_string())?
                            .prepare(state),
                    )
                })
            }
            "dropDiscoveryLead" => handler_rpc(&mut args, |owner, input, context| async move {
                discovery_desktop(&context)?;
                owner
                    .drop_discovery_lead(
                        decode(input)?,
                        context.operation().ok_or("agent_mutation_required")?,
                        context.scope(),
                    )?
                    .complete(&context)
            }),
            "openDossierThread" => handler_rpc(&mut args, |owner, input, context| async move {
                discovery_desktop(&context)?;
                owner
                    .open_dossier_thread(
                        decode(input)?,
                        context.operation().ok_or("agent_mutation_required")?,
                        context.scope(),
                    )
                    .await?
                    .complete(&context)
            }),
            "schedules" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(owner.schedules(decode(input)?).await?)
            }),
            "watchSchedules" => json_rpc(&mut args, |owner, input, context| async move {
                let mut changes = owner.schedule_changes();
                let query: ScheduleRead = decode(input)?;
                loop {
                    changes.borrow_and_update();
                    let value = encode(owner.schedules(query.clone()).await?)?;
                    context.emit(value).await?;
                    tokio::select! {
                        biased;
                        _ = context.scope().cancellation.cancelled() => return Err("scheduler_observation_cancelled".into()),
                        result = changes.changed() => result.map_err(|_| "scheduler_observation_closed")?,
                    }
                }
            }),
            // checkpoints
            "previewHistoryCheckpoint" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .preview_history_checkpoint(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "historyCheckpointHead" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .history_checkpoint_head(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "readHistoryCheckpoint" => json_rpc(&mut args, |owner, input, context| async move {
                owner.read_history_checkpoint(decode(input)?, context).await
            }),
            "loadHistoryCheckpoint" => json_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                encode(
                    owner
                        .load_history_checkpoint(decode(input)?, operation, context.scope())
                        .await?,
                )
            }),
            "sessionCheckpointRestoreReceipt" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    encode(
                        owner
                            .session_checkpoint_restore_receipt(decode(input)?, context)
                            .await?,
                    )
                })
            }
            "publishCheckpoint" => json_rpc(&mut args, |owner, input, context| async move {
                let operation = context.operation().ok_or("agent_mutation_required")?;
                encode(
                    owner
                        .publish_checkpoint(decode(input)?, operation, context.scope())
                        .await?,
                )
            }),
            "checkpointReceipt" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.checkpoint_receipt(decode(input)?, context).await?)
            }),
            "historyCheckpointLoadReceipt" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    encode(
                        owner
                            .history_checkpoint_load_receipt(decode(input)?, context)
                            .await?,
                    )
                })
            }
            "loadedHistoryCheckpointToolImage" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    checkpoint_output(
                        owner
                            .loaded_checkpoint_tool_image(decode(input)?, context.scope())
                            .await?,
                    )
                })
            }
            "loadedHistoryCheckpointAttachmentImage" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    checkpoint_output(
                        owner
                            .loaded_checkpoint_attachment_image(decode(input)?, context.scope())
                            .await?,
                    )
                })
            }
            "loadedHistoryCheckpointSource" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    checkpoint_output(
                        owner
                            .loaded_checkpoint_source(decode(input)?, context.scope())
                            .await?,
                    )
                })
            }
            "loadedHistoryCheckpointHistory" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    checkpoint_output(
                        owner
                            .loaded_checkpoint_history(decode(input)?, context.scope())
                            .await?,
                    )
                })
            }
            "loadedHistoryCheckpointArtifacts" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    checkpoint_output(
                        owner
                            .loaded_checkpoint_artifacts(decode(input)?, context.scope())
                            .await?,
                    )
                })
            }
            "loadedHistoryCheckpointArtifact" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    owner
                        .loaded_checkpoint_artifact(decode(input)?, context)
                        .await
                })
            }
            "forkReceipt" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.fork_receipt(decode(input)?, context.scope()).await?)
            }),
            "context" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.context(decode(input)?, context.scope()).await?)
            }),
            // workspace
            "sessionMcp" => json_rpc(&mut args, |owner, input, context| async move {
                owner.session_mcp(decode(input)?, context).await
            }),
            "projectMcp" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.project_mcp(decode(input)?, context.scope()).await?)
            }),
            "trustProjectMcp" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                encode(
                    owner
                        .trust_project_mcp(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "mcpConfigurations" => json_rpc(&mut args, |owner, input, context| async move {
                if context.scope().identity.agent().is_some() {
                    return Err("agent_mcp_user_action_required".into());
                }
                encode(
                    owner
                        .mcp_configurations(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "manageMcpServer" => json_rpc(&mut args, |owner, input, context| async move {
                if context.scope().identity.agent().is_some() {
                    return Err("agent_mcp_user_action_required".into());
                }
                context.operation().ok_or("agent_mutation_required")?;
                encode(
                    owner
                        .manage_mcp_server(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "selectWorkspace" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                if context.scope().identity.agent().is_some() {
                    return Err("agent_workspace_user_action_required".into());
                }
                encode(
                    owner
                        .select_workspace(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "directories" => json_rpc(&mut args, |owner, input, _context| async move {
                encode(
                    maka_workspace_support::query(
                        owner.workspace_roots.clone(),
                        decode(input)?,
                        owner.home.as_deref(),
                    )
                    .await?,
                )
            }),
            "listFiles" => json_rpc(&mut args, |owner, input, context| async move {
                let result = encode(owner.list_files(decode(input)?, context.scope()).await?)?;
                maka_plugin_core::json::exact_numbers(&result)
                    .map_err(|_| "agent_files_output_unavailable")?;
                Ok(result)
            }),
            "watchFiles" => json_rpc(&mut args, |owner, input, context| async move {
                owner.watch_files(decode(input)?, context).await
            }),
            "resolveFileLink" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .resolve_file_link(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "readFile" => json_rpc(&mut args, |owner, input, context| async move {
                owner.read_file(decode(input)?, context).await
            }),
            "codeDefinition" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .code_definition(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "codeReferences" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .code_references(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "codeHover" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.code_hover(decode(input)?, context.scope()).await?)
            }),
            "readPatch" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.read_patch(decode(input)?, context.scope()).await?)
            }),
            "diagnostics" => json_rpc(&mut args, |owner, input, context| async move {
                diagnostics::query(&owner, decode(input)?, &context).await
            }),
            "watchDiagnostics" => json_rpc(&mut args, |owner, input, context| async move {
                diagnostics::watch(&owner, decode(input)?, &context).await
            }),
            // git github
            "gitStatus" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.git_status(decode(input)?, context.scope()).await?)
            }),
            "gitDiff" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.git_diff(decode(input)?, context.scope()).await?)
            }),
            "gitWorkspaceDiff" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .git_workspace_diff(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "gitRevisions" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.git_revisions(decode(input)?, context.scope()).await?)
            }),
            "gitCompare" => json_rpc(&mut args, |owner, input, context| async move {
                encode(owner.git_compare(decode(input)?, context.scope()).await?)
            }),
            "gitCompareDiff" => json_rpc(&mut args, |owner, input, context| async move {
                encode(
                    owner
                        .git_compare_diff(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "githubPullRequests" => json_rpc(&mut args, |owner, input, context| async move {
                if context.scope().identity.agent().is_some() {
                    return Err("agent_github_user_action_required".into());
                }
                encode(
                    owner
                        .github_pull_requests(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "githubPullRequestDetail" => json_rpc(&mut args, |owner, input, context| async move {
                if context.scope().identity.agent().is_some() {
                    return Err("agent_github_user_action_required".into());
                }
                encode(
                    owner
                        .github_pull_request_detail(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "githubPullRequestFileDiff" => {
                json_rpc(&mut args, |owner, input, context| async move {
                    if context.scope().identity.agent().is_some() {
                        return Err("agent_github_user_action_required".into());
                    }
                    encode(
                        owner
                            .github_pull_request_file_diff(decode(input)?, context.scope())
                            .await?,
                    )
                })
            }
            "githubSubmitReview" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                if context.scope().identity.agent().is_some() {
                    return Err("agent_github_user_action_required".into());
                }
                encode(
                    owner
                        .github_submit_review(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "githubReplyComment" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                if context.scope().identity.agent().is_some() {
                    return Err("agent_github_user_action_required".into());
                }
                encode(
                    owner
                        .github_reply_comment(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "githubCommentPullRequest" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                if context.scope().identity.agent().is_some() {
                    return Err("agent_github_user_action_required".into());
                }
                encode(
                    owner
                        .github_comment_pull_request(decode(input)?, context.scope())
                        .await?,
                )
            }),
            "saveGitHubToken" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                if context.scope().identity.agent().is_some() {
                    return Err("agent_github_user_action_required".into());
                }
                let key: maka_agent_api::contract::GitHubTokenKey = decode(input)?;
                let resource = context
                    .attachments()
                    .get("secret")
                    .ok_or("agent_github_token_required")?;
                if resource.bytes() == 0 {
                    return encode(maka_agent_api::contract::GitHubTokenResult::InvalidToken);
                }
                let bytes = resource
                    .read(0..resource.bytes())
                    .map_err(|_| "agent_github_token_unavailable".to_owned())?;
                let Ok(secret) = String::from_utf8(bytes) else {
                    return encode(maka_agent_api::contract::GitHubTokenResult::InvalidToken);
                };
                encode(owner.save_github_token(key, secret).await?)
            }),
            "deleteGitHubToken" => json_rpc(&mut args, |owner, input, context| async move {
                context.operation().ok_or("agent_mutation_required")?;
                if context.scope().identity.agent().is_some() {
                    return Err("agent_github_user_action_required".into());
                }
                encode(owner.delete_github_token(decode(input)?).await?)
            }),

            _ => Box::pin(std::future::ready(Err(handler_error(
                "agent_method_unavailable".into(),
            )))),
        }
    }
}

#[inline(never)]
fn box_rpc<Fut>(
    args: &mut Option<CallArgs>,
    make: impl FnOnce(Arc<Owner>, Value, Context) -> Fut + std::marker::Send + 'static,
) -> BoxFuture<'static, HandlerResult>
where
    Fut: Future<Output = HandlerResult> + std::marker::Send + 'static,
{
    let CallArgs {
        owner,
        input,
        context,
    } = args.take().expect("RPC args consumed once");
    Box::pin(async move { make(owner, input, context).await })
}
#[inline(never)]
fn handler_rpc<Fut>(
    args: &mut Option<CallArgs>,
    make: impl FnOnce(Arc<Owner>, Value, Context) -> Fut + std::marker::Send + 'static,
) -> BoxFuture<'static, HandlerResult>
where
    Fut: Future<Output = Result<HandlerValue, String>> + std::marker::Send + 'static,
{
    let CallArgs {
        owner,
        input,
        context,
    } = args.take().expect("RPC args consumed once");
    Box::pin(async move { make(owner, input, context).await.map_err(handler_error) })
}
#[inline(never)]
fn json_rpc<Fut>(
    args: &mut Option<CallArgs>,
    make: impl FnOnce(Arc<Owner>, Value, Context) -> Fut + std::marker::Send + 'static,
) -> BoxFuture<'static, HandlerResult>
where
    Fut: Future<Output = Result<Value, String>> + std::marker::Send + 'static,
{
    let CallArgs {
        owner,
        input,
        context,
    } = args.take().expect("RPC args consumed once");
    Box::pin(async move {
        make(owner, input, context)
            .await
            .map(HandlerValue::Json)
            .map_err(handler_error)
    })
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
        | "agent_project_selection_unknown" => HandlerError::Unknown { diagnostic },
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

pub(crate) async fn catalog_page_for_tool(
    owner: &Owner,
    input: &List,
) -> Result<SessionPage, String> {
    catalog_page(owner, input).await
}
pub(crate) async fn history_observation_for_tool(
    owner: &Owner,
    scope: &maka_capabilities::call::Scope,
    input: SessionRead,
) -> Result<Observation, String> {
    history::observation(owner, scope, input).await
}
