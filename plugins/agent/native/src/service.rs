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
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use maka_agent_api::session::{ResolvedConfiguration, StoredSessionConfiguration};
use maka_event_log::{
    observation::{StoreStreamEvent, StreamFact},
    sessions::{CatalogScope, CatalogSelection, SessionRecord},
};
use maka_host_runtime::application::{Context, Handler};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::sync::Arc;

mod diagnostics;
mod preview;

pub(crate) struct Agent(pub Arc<Owner>);
impl Handler for Agent {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let owner = self.0.clone();
        Box::pin(async move {
            match method.as_str() {
                "changeSession" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.change_session(decode(input)?).await?)
                }
                "selectBackend" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.select_backend(decode(input)?).await?)
                }
                "work" => encode(owner.work(decode(input)?).await?),
                "list" => encode(catalog_page(&owner, &decode(input)?).await?),
                "catalog" => {
                    let mut input: List = decode(input)?;
                    let mut changes = owner.store.subscribe_catalog_changes();
                    let mut revision = None;
                    loop {
                        // Observe notifications before reading so a racing commit
                        // remains available to wake the next attempt.
                        changes.borrow_and_update();
                        let unchanged = if let Some(revision) = &revision {
                            owner
                                .store
                                .catalog_revision(
                                    catalog_scope(&owner, &input).await?,
                                    catalog_filter(&input),
                                )
                                .await
                                .map_err(|_| "agent_catalog_unavailable")?
                                == *revision
                        } else {
                            false
                        };
                        if !unchanged {
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
                        }
                    }
                }
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
                "plan" => encode(owner.plan(decode(input)?).await?),
                "planHistory" => encode(owner.plan_history(decode(input)?).await?),
                "planReceipt" => encode(owner.plan_receipt(decode(input)?).await?),
                "changePlan" => {
                    let operation = context
                        .operation()
                        .ok_or("agent_mutation_required")?
                        .clone();
                    encode(
                        owner
                            .plan_change(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "watchPlan" => {
                    let input: PlanRead = decode(input)?;
                    let mut changes = owner.plan_changes();
                    let mut revision = None;
                    loop {
                        changes.borrow_and_update();
                        let page = owner.plan(input.clone()).await?;
                        if revision != Some(page.current.revision) {
                            revision = Some(page.current.revision);
                            context.emit(encode(page)?).await?;
                        }
                        tokio::select! {
                            biased;
                            _ = context.scope().cancellation.cancelled() => return Err("plan_observation_cancelled".into()),
                            result = changes.changed() => result.map_err(|_| "plan_observation_closed")?,
                        }
                    }
                }
                "goalReceipt" => encode(owner.goal_receipt(decode(input)?).await?),
                "goal" => encode(owner.goal(decode(input)?).await?),
                "changeGoal" => {
                    let operation = context
                        .operation()
                        .ok_or("agent_mutation_required")?
                        .clone();
                    encode(
                        owner
                            .goal_change(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
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
                "recap" => encode(owner.recap(decode(input)?, context.scope()).await?),
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
                "openBot" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .open_bot(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "botOutbox" => encode(owner.bot_outbox(&decode(input)?).await?),
                "watchBotOutbox" => {
                    let input: BotOutboxRead = decode(input)?;
                    let mut changes = owner.bot_changes();
                    let mut through = None;
                    loop {
                        changes.borrow_and_update();
                        let page = owner.bot_outbox(&input).await?;
                        let observed = (page.session_id.clone(), page.through);
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
                    if matches!(query, Some(ScheduleRead::Receipt { .. })) {
                        return Err("scheduler_subscription_invalid".into());
                    }
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
                "schedule" => {
                    let operation = context
                        .operation()
                        .ok_or("agent_mutation_required")?
                        .clone();
                    encode(
                        owner
                            .schedule_change(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "recall" => encode(owner.recall.query(decode(input)?, context.scope()).await?),
                "imports" => encode(owner.imports(decode(input)?, context.scope()).await?),
                "import" => {
                    let operation = context
                        .operation()
                        .ok_or("agent_mutation_required")?
                        .clone();
                    encode(
                        owner
                            .import(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "importDirectories" => encode(
                    owner
                        .import_directories(decode(input)?, context.scope())
                        .await?,
                ),
                "projects" => encode(owner.projects(decode(input)?).await?),
                "project" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.project(decode(input)?).await?)
                }
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
                    maka_workspace_support::query(owner.workspace_roots.clone(), decode(input)?)
                        .await?,
                ),
                "create" => {
                    let input: Create = decode(input)?;
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    let created = owner.create(input, operation, context.scope()).await?;
                    if let Created::Created { session } = &created {
                        owner.bot_watch(context.scope(), &session.id).await;
                    }
                    encode(created)
                }
                "fork" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .fork(decode(input)?, operation, context.scope())
                            .await?,
                    )
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
                "snapshotPatch" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .snapshot_patch(decode(input)?, context.scope())
                            .await?,
                    )
                }
                "readPatch" => encode(owner.read_patch(decode(input)?).await?),
                "markRead" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.mark_read(decode(input)?).await?)
                }
                "metadata" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.metadata(decode(input)?).await?)
                }
                "setCompactionPrompt" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.set_compaction_prompt(decode(input)?).await?)
                }
                "diagnostics" => diagnostics::query(&owner, decode(input)?, &context).await,
                "watchDiagnostics" => diagnostics::watch(&owner, decode(input)?, &context).await,
                "observe" => {
                    use maka_event_log::turns::InvocationState;
                    let input: SessionRead = decode(input)?;
                    owner.require_session(&input.session_id).await?;
                    let observed = owner
                        .scoped_store(context.scope(), &input.session_id)
                        .await?
                        .observe_session::<StoredSessionConfiguration>(&input.session_id)
                        .await
                        .map_err(|_| "agent_observation_unavailable")?
                        .ok_or("agent_session_unavailable")?;
                    let compacting = observed.compacting.map(|progress| CompactionProgress {
                        id: progress.id,
                        started_at: progress.started_at,
                    });
                    let run = observed.root_turn.and_then(|turn| {
                        let state = match turn.state {
                            InvocationState::Admitted => RunState::Admitted,
                            InvocationState::Running => RunState::Running,
                            InvocationState::WaitingForUser => RunState::WaitingForUser,
                            InvocationState::Ended { .. } => return None,
                        };
                        Some(Run {
                            invocation_id: turn.invocation.invocation_id,
                            turn_id: turn.invocation.turn_id,
                            state,
                        })
                    });
                    let session = summary(&owner, resolve_session(observed.session)?);
                    let remembered_backend = if session.backend.is_none() {
                        owner.remembered_backend(&input.session_id).await?
                    } else {
                        None
                    };
                    let metrics = match owner
                        .scoped_store(context.scope(), &input.session_id)
                        .await?
                        .context_usage(&input.session_id)
                        .await
                    {
                        Ok((
                            maka_event_log::context::LatestMainContext::Selected(basis),
                            usage,
                        )) => {
                            let backend_matches = matches!(
                                session.backend.as_ref().or(remembered_backend.as_ref()),
                                Some(BackendPreference::Model { model_id, connection_id, .. })
                                    if model_id == &basis.model_id
                                        && basis.connection_id.as_ref() == Some(connection_id)
                            );
                            let usage = usage.filter(|usage| {
                                !usage.last_known || (run.is_some() && backend_matches)
                            });
                            let seconds = basis
                                .requested_at
                                .zip(basis.finished_at)
                                .and_then(|(at, finished)| finished.duration_since(at).ok())
                                .map(|elapsed| elapsed.as_secs_f64())
                                .filter(|seconds| *seconds > 0.0);
                            Some(SessionMetrics {
                                model_id: basis.model_id,
                                connection_id: basis.connection_id,
                                context_tokens: usage.as_ref().map(|usage| usage.tokens),
                                context_window: basis
                                    .context
                                    .as_ref()
                                    .and_then(|context| context.model_context_window),
                                approximate: usage.as_ref().is_some_and(|usage| usage.approximate),
                                context_last_known: usage
                                    .as_ref()
                                    .is_some_and(|usage| usage.last_known),
                                output_tokens_per_second: basis
                                    .usage
                                    .output_tokens
                                    .zip(seconds)
                                    .map(|(tokens, seconds)| tokens as f64 / seconds)
                                    .filter(|rate| rate.is_finite()),
                            })
                        }
                        _ => None,
                    };
                    let result = encode(Observation {
                        compacting,
                        session,
                        metrics,
                        remembered_backend,
                        through: observed.through_sequence,
                        run,
                        parts: observed
                            .active_streams
                            .into_iter()
                            .map(|part| Part {
                                start_sequence: part.start_sequence,
                                message_id: part.message_id,
                                step_id: part.step_id,
                                part_id: part.part_id,
                                text_kind: part.text_kind.into(),
                            })
                            .collect(),
                        tool_seeds: observed
                            .active_tools
                            .into_iter()
                            .map(|tool| ToolSeed {
                                tool_use_id: tool.tool_use_id,
                                start_sequence: tool.start_sequence,
                            })
                            .collect(),
                    })?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_observation_unavailable")?;
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    Ok(result)
                }
                "history" => {
                    use maka_agent_ports::session::history::Page;
                    use maka_agent_ports::session::history::Read;
                    let input: History = decode(input)?;
                    owner.require_session(&input.session_id).await?;
                    let high_water = owner
                        .scoped_store(context.scope(), &input.session_id)
                        .await?
                        .committed_sequence()
                        .await
                        .map_err(|error| error.to_string())?;
                    let through = input.through.unwrap_or(high_water);
                    if through > high_water {
                        return Err("agent_cursor_invalid".into());
                    }
                    Read {
                        include_thinking: input.include_thinking,
                        session_id: input.session_id.clone(),
                        through: input.through,
                        position: input.position,
                    }
                    .validate()
                    .map_err(|_| "agent_cursor_invalid")?;
                    let result = {
                        let Page::Ready {
                            through,
                            chunks,
                            before,
                            after,
                        } = owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .history_view(
                                &input.session_id,
                                through,
                                input.position,
                                input.include_thinking,
                                input.view,
                                maka_event_log::transcript::HistoryLimits {
                                    max_bytes: 32 * 1024,
                                    max_chunks: (input.view
                                        == maka_agent_ports::session::history::HistoryView::Text)
                                        .then_some(8),
                                    max_json_bytes: 64 * 1024,
                                },
                            )
                            .await
                            .map_err(|_| "agent_history_unavailable")?;
                        HistoryPage::Ready {
                            through,
                            before,
                            after,
                            chunks: chunks
                                .into_iter()
                                .map(|chunk| HistoryChunk {
                                    model_part: chunk.model_part,
                                    has_references: chunk.has_references,
                                    final_output: chunk.final_output,
                                    model: chunk.model,
                                    origin: chunk.origin,
                                    compaction: chunk.compaction,
                                    attachments: chunk
                                        .attachments
                                        .into_iter()
                                        .map(|attachment| HistoryAttachment {
                                            name: attachment.name,
                                            mime_type: attachment.mime_type,
                                            bytes: attachment.bytes,
                                            kind: attachment.kind,
                                        })
                                        .collect(),
                                    timing: chunk.timing,
                                    field: chunk.field,
                                    message_id: chunk.message_id,
                                    turn_id: chunk.turn_id,
                                    timestamp: chunk.timestamp,
                                    role: chunk.role,
                                    position: chunk.position,
                                    offset: chunk.offset,
                                    total_bytes: chunk.total_bytes,
                                    text: chunk.text,
                                    tool: chunk.tool,
                                })
                                .collect(),
                        }
                    };
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    let result = encode(result)?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_history_unavailable")?;
                    Ok(result)
                }
                "historyLandmarks" => {
                    let input: HistoryLandmarksRead = decode(input)?;
                    owner.require_session(&input.session_id).await?;
                    if input.through
                        > owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .committed_sequence()
                            .await
                            .map_err(|error| error.to_string())?
                    {
                        return Err("agent_cursor_invalid".into());
                    }
                    let landmarks = owner
                        .scoped_store(context.scope(), &input.session_id)
                        .await?
                        .navigation_landmarks(&input.session_id, input.through, 64, None)
                        .await
                        .map_err(|_| "agent_history_unavailable")?;
                    let result = HistoryLandmarks {
                        through: input.through,
                        landmarks: landmarks
                            .into_iter()
                            .map(|landmark| HistoryLandmark {
                                turn_id: landmark.turn_id,
                                position: landmark.position,
                                last_position: landmark.last_position,
                                label: landmark.label,
                                origin: landmark.origin,
                            })
                            .collect(),
                    };
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    let result = encode(result)?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_history_unavailable")?;
                    Ok(result)
                }
                "historyPrompt" => {
                    let input: HistoryPromptRead = decode(input)?;
                    owner.require_session(&input.session_id).await?;
                    if input.through
                        > owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .committed_sequence()
                            .await
                            .map_err(|error| error.to_string())?
                    {
                        return Err("agent_cursor_invalid".into());
                    }
                    let result = owner
                        .scoped_store(context.scope(), &input.session_id)
                        .await?
                        .history_prompt(&input.session_id, input.through, input.position)
                        .await
                        .map_err(|_| "agent_history_unavailable")?;
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    encode(result)
                }
                "search" => {
                    let input: HistorySearch = decode(input)?;
                    owner.require_session(&input.session_id).await?;

                    if input.through
                        > owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .committed_sequence()
                            .await
                            .map_err(|error| error.to_string())?
                        || input.after.is_some_and(|after| {
                            after.validate().is_err() || after.source_sequence > input.through
                        })
                        || input.query.is_empty()
                    {
                        return Err("agent_search_invalid".into());
                    }
                    let page = {
                        let batch = owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .search_transcript(
                                &input.session_id,
                                maka_event_log::transcript::search::TranscriptSearch {
                                    through: input.through,
                                    after: input.after,
                                    query: input.query,
                                    case_sensitive: input.case_sensitive,
                                    whole_word: input.whole_word,
                                    include_internal: input.include_internal,
                                    max_matches: 16,
                                },
                            )
                            .await
                            .map_err(|_| "agent_history_unavailable")?;
                        HistorySearchPage::Ready {
                            through: input.through,
                            matches: batch
                                .matches
                                .into_iter()
                                .map(|found| HistoryMatch {
                                    field: found.field,
                                    position: found.position,
                                    preview: found.preview,
                                })
                                .collect(),
                            next_after: batch.next_after,
                        }
                    };
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    let result = encode(page)?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_history_unavailable")?;
                    Ok(result)
                }
                "source" => {
                    let input: HistorySourceRead = decode(input)?;
                    let session = owner
                        .scoped_session(context.scope(), &input.session_id)
                        .await?;
                    if input.through
                        > owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .committed_sequence()
                            .await
                            .map_err(|error| error.to_string())?
                    {
                        return Err("agent_cursor_invalid".into());
                    }
                    let page = {
                        let position = match input.source {
                            HistorySourceReference::Row { position } => position,
                            HistorySourceReference::ToolUse { tool_use_id } => owner
                                .scoped_store(context.scope(), &input.session_id)
                                .await?
                                .tool_source_position(
                                    &input.session_id,
                                    input.through,
                                    &tool_use_id,
                                )
                                .await
                                .map_err(|_| "agent_history_unavailable")?,
                        };
                        let source = owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .history_source(
                                &input.session_id,
                                input.through,
                                maka_event_log::transcript::SourceSelection {
                                    locator: position,
                                    field: input.field,
                                    path: input.path,
                                },
                                input.position,
                                8192,
                            )
                            .await
                            .map_err(|_| "agent_history_unavailable")?;
                        let file_path = crate::source_path::file_path(
                            &source,
                            &session.configuration.workspace.path,
                        );
                        HistorySourcePage::Ready {
                            through: input.through,
                            source: Box::new(source),
                            file_path,
                        }
                    };
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    let result = encode(page)?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_history_unavailable")?;
                    Ok(result)
                }
                "toolImage" => {
                    let input: ToolImageRead = decode(input)?;
                    owner.require_session(&input.session_id).await?;
                    if input.through
                        > owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .committed_sequence()
                            .await
                            .map_err(|error| error.to_string())?
                    {
                        return Err("agent_cursor_invalid".into());
                    }
                    let page = {
                        let image = owner
                            .scoped_store(context.scope(), &input.session_id)
                            .await?
                            .tool_image(
                                &input.session_id,
                                input.through,
                                input.position,
                                input.offset,
                                32 * 1024,
                            )
                            .await
                            .map_err(|_| "agent_image_unavailable")?;
                        ToolImagePage::Ready {
                            through: input.through,
                            position: input.position,
                            offset: input.offset,
                            total_bytes: image.total_bytes,
                            mime_type: image.mime_type,
                            digest: image.digest,
                            data: STANDARD.encode(image.bytes),
                        }
                    };
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    let result = encode(page)?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_image_unavailable")?;
                    Ok(result)
                }
                "uploadAttachment" => {
                    encode(owner.upload_attachment(decode(input)?, context).await?)
                }
                "attachmentImage" => {
                    let input: AttachmentImageRead = decode(input)?;
                    owner.require_session(&input.session_id).await?;
                    let image = match &input.source {
                        AttachmentImageSource::Uploaded { id } => {
                            owner
                                .scoped_store(context.scope(), &input.session_id)
                                .await?
                                .uploaded_image(&input.session_id, id, input.offset, 32 * 1024)
                                .await
                        }
                        AttachmentImageSource::History {
                            through,
                            position,
                            attachment_index,
                        } => {
                            if *through
                                > owner
                                    .scoped_store(context.scope(), &input.session_id)
                                    .await?
                                    .committed_sequence()
                                    .await
                                    .map_err(|error| error.to_string())?
                            {
                                return Err("agent_cursor_invalid".into());
                            }
                            owner
                                .scoped_store(context.scope(), &input.session_id)
                                .await?
                                .attachment_image(
                                    &input.session_id,
                                    *through,
                                    *position,
                                    *attachment_index,
                                    input.offset,
                                    32 * 1024,
                                )
                                .await
                        }
                    }
                    .map_err(|_| "agent_image_unavailable")?;
                    owner.require_session(&input.session_id).await?;
                    if context.scope().cancellation.is_cancelled() {
                        return Err("agent_observation_cancelled".into());
                    }
                    let result = encode(AttachmentImagePage::Ready {
                        source: input.source,
                        offset: input.offset,
                        total_bytes: image.total_bytes,
                        mime_type: image.mime_type,
                        digest: image.digest,
                        data: STANDARD.encode(image.bytes),
                    })?;
                    maka_plugin_core::json::exact_numbers(&result)
                        .map_err(|_| "agent_image_unavailable")?;
                    Ok(result)
                }
                "send" => {
                    let mut input: Send = decode(input)?;
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    owner.use_bot_model(context.scope(), &mut input.model).await;
                    if !owner
                        .may_control(context.scope(), &input.session_id)
                        .await?
                    {
                        return encode(crate::contract::SendResult::NotYourWorker {
                            session_id: input.session_id,
                        });
                    }
                    let worker = input.session_id.clone();
                    let sent = owner.send(input, operation, context.scope()).await?;
                    if matches!(sent, SendResult::Started { .. } | SendResult::Queued { .. }) {
                        owner.bot_watch(context.scope(), &worker).await;
                    }
                    encode(sent)
                }
                "executorSetup" => owner.executor_setup(decode(input)?, context).await,
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
                        executors: owner
                            .settings
                            .executors
                            .iter()
                            .map(|choice| choice.name.clone())
                            .collect(),
                    })
                }
                "execute" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .execute(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "execution" => encode(owner.execution(decode(input)?).await?),
                "resumable" => encode(
                    owner
                        .resumable(decode(input)?, &context.scope().cancellation)
                        .await?,
                ),
                "compactionPrompt" => encode(owner.compaction_prompt(decode(input)?).await?),
                "compact" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.compact(decode(input)?, operation).await?)
                }
                "resume" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.resume(decode(input)?, operation).await?)
                }
                "stop" => {
                    let input: Stop = decode(input)?;
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    if !owner
                        .may_control(context.scope(), &input.session_id)
                        .await?
                    {
                        return encode(Stopped { requested: false });
                    }
                    encode(Stopped {
                        requested: owner
                            .stop_run(&input.session_id, &input.invocation_id, operation)
                            .await?,
                    })
                }
                "computerApps" => {
                    let input: SessionRead = decode(input)?;
                    encode(owner.computer_apps(&input.session_id).await?)
                }
                "stopComputerApp" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .stop_computer_app(decode(input)?, context.scope())
                            .await?,
                    )
                }
                "queue" => {
                    let input: SessionRead = decode(input)?;
                    encode(owner.queue(&input.session_id).await?)
                }
                "queueMessage" => encode(owner.queue_message(decode(input)?).await?),
                "editQueue" => {
                    let operation = context.operation().ok_or("agent_mutation_required")?;
                    encode(
                        owner
                            .edit_queue(decode(input)?, operation, context.scope())
                            .await?,
                    )
                }
                "pendingInteractions" => {
                    let input: SessionRead = decode(input)?;
                    encode(owner.pending_interactions(&input.session_id).await?)
                }
                "interaction" => {
                    let input: InteractionRead = decode(input)?;
                    encode(
                        owner
                            .interaction(&input.session_id, &input.request_id)
                            .await?,
                    )
                }
                "respond" => {
                    context.operation().ok_or("agent_mutation_required")?;
                    encode(owner.respond(decode(input)?).await?)
                }
                "watch" => {
                    let input: Watch = decode(input)?;
                    owner.require_session(&input.session_id).await?;
                    let mut commits = owner
                        .scoped_store(context.scope(), &input.session_id)
                        .await?
                        .subscribe_commits()
                        .map_err(|error| error.to_string())?;
                    let mut preview = preview::Delivery::new(owner.preview_epoch());
                    let mut after = input.after;
                    let mut queue_revision = None;
                    let mut interactions_delivered = None;
                    let mut computer_apps_delivered = None;
                    // Previews live in memory: the store is read only for a commit
                    // notice or for committed events not delivered yet.
                    let mut stale = true;
                    loop {
                        if context.scope().cancellation.is_cancelled() {
                            return Err("agent_observation_cancelled".into());
                        }
                        if stale {
                            // Queue edits need not advance the transcript cursor. Deliver
                            // them fairly even while catching up a growing transcript.
                            let revision = owner
                                .scoped_store(context.scope(), &input.session_id)
                                .await?
                                .message_queue_revision(&input.session_id)
                                .await
                                .map_err(|_| "agent_queue_unavailable")?;
                            if queue_revision != Some(revision) {
                                let queue = owner.queue(&input.session_id).await?;
                                queue_revision = Some(queue.revision);
                                let update = encode(DeliveryPage::Queue { queue })?;
                                maka_plugin_core::json::exact_numbers(&update)
                                    .map_err(|_| "agent_queue_unavailable")?;
                                context.emit(update).await?;
                            }
                            let pending = owner.pending_interactions(&input.session_id).await?;
                            if interactions_delivered.as_ref() != Some(&pending) {
                                context
                                    .emit(encode(DeliveryPage::Interactions {
                                        pending: pending.clone(),
                                    })?)
                                    .await?;
                                interactions_delivered = Some(pending);
                            }
                            let apps = owner.computer_apps(&input.session_id).await?;
                            if computer_apps_delivered.as_ref() != Some(&apps) {
                                context
                                    .emit(encode(DeliveryPage::ComputerApps {
                                        apps: apps.clone(),
                                    })?)
                                    .await?;
                                computer_apps_delivered = Some(apps);
                            }
                            owner.require_session(&input.session_id).await?;
                        }
                        let mut reader = owner.preview_reader(&input.session_id).await;
                        let current = reader
                            .as_mut()
                            .and_then(|reader| reader.borrow_and_update().clone());
                        preview.current(current);
                        if reader
                            .as_ref()
                            .is_some_and(|reader| reader.has_changed().is_err())
                        {
                            reader = None;
                        }
                        if stale {
                            let committed = owner
                                .scoped_store(context.scope(), &input.session_id)
                                .await?
                                .committed_sequence()
                                .await
                                .map_err(|error| error.to_string())?;
                            if after > committed {
                                return Err("agent_cursor_invalid".into());
                            }
                            let through = preview
                                .initial_fence()
                                .map_or(committed, |fence| committed.min(fence.max(after)));
                            let page = owner
                                .scoped_store(context.scope(), &input.session_id)
                                .await?
                                .session_stream_events(
                                    &input.session_id,
                                    after,
                                    through,
                                    32,
                                    48 * 1024,
                                )
                                .await
                                .map_err(|_| "agent_observation_unavailable")?;
                            preview.committed(&page.events);
                            after = page.next_after.unwrap_or(page.through_sequence);
                            stale = page.next_after.is_some() || through < committed;
                            context
                                .emit(encode(DeliveryPage::Events {
                                    through: page.through_sequence,
                                    next_after: after,
                                    events: page.events.into_iter().map(delivery).collect(),
                                })?)
                                .await?;
                        }
                        let mut ready = stale;
                        if let Some(update) = preview.next(after)? {
                            context
                                .emit(encode(DeliveryPage::Preview { page: update })?)
                                .await?;
                            ready = true;
                        }
                        tokio::select! {
                            biased;
                            _ = context.scope().cancellation.cancelled() => return Err("agent_observation_cancelled".into()),
                            result = commits.changed() => {
                                result.map_err(|_| "agent_observation_closed")?;
                                stale = true;
                            },
                            () = std::future::ready(()), if ready => {},
                            _ = async {
                                match reader.as_mut() {
                                    Some(reader) => { let _ = reader.changed().await; },
                                    None => std::future::pending::<()>().await,
                                }
                            } => {},
                        }
                    }
                }
                _ => Err("agent_method_unavailable".into()),
            }
        })
    }
}
async fn catalog_scope(owner: &Owner, input: &List) -> Result<CatalogScope, String> {
    let selection = match &input.scope {
        SessionListScope::All => CatalogSelection::All,
        SessionListScope::Children { session_id } => {
            owner.require_session(session_id).await?;
            CatalogSelection::Children(session_id.clone())
        }
        SessionListScope::Project { project_id } => CatalogSelection::Project(*project_id),
        SessionListScope::Workspace { session_id } => CatalogSelection::Workspace {
            session_id: session_id.clone(),
            identity: owner
                .session(session_id)
                .await?
                .configuration
                .workspace
                .identity,
        },
    };
    Ok(CatalogScope::Owned {
        id_prefix: owner.prefix.clone(),
        selection,
        title_query: input.title_query.clone(),
    })
}

fn catalog_filter(input: &List) -> maka_event_log::sessions::CatalogFilter {
    maka_event_log::sessions::CatalogFilter {
        archived_only: matches!(input.filter, SessionFilter::Archived),
        include_archived: input.include_archived || matches!(input.filter, SessionFilter::Archived),
        pending_only: matches!(input.filter, SessionFilter::NeedsYou),
    }
}
async fn catalog_page(owner: &Owner, input: &List) -> Result<SessionPage, String> {
    use maka_event_log::sessions::SessionPosition;
    let (revision, position) = match &input.position {
        crate::contract::SessionPosition::Start => (None, SessionPosition::Start),
        crate::contract::SessionPosition::At { cursor } => (None, SessionPosition::At(cursor)),
        crate::contract::SessionPosition::After { revision, cursor } => {
            (Some(revision.as_str()), SessionPosition::After(cursor))
        }
        crate::contract::SessionPosition::Before { revision, cursor } => {
            (Some(revision.as_str()), SessionPosition::Before(cursor))
        }
    };
    if matches!(position, SessionPosition::At(cursor) | SessionPosition::After(cursor) | SessionPosition::Before(cursor) if !owner.owns(cursor))
    {
        return Err("agent_cursor_invalid".into());
    }
    let page = owner
        .store
        .scoped_sessions::<StoredSessionConfiguration>(
            catalog_scope(owner, input).await?,
            revision,
            position,
            catalog_filter(input),
        )
        .await
        .map_err(|error| match error {
            maka_event_log::StoreError::RevisionConflict { .. } => "agent_catalog_changed",
            _ => "agent_catalog_unavailable",
        })?;
    let reverse = matches!(position, SessionPosition::Before(_));
    let mut result = SessionPage {
        revision: page.revision,
        sessions: page
            .sessions
            .into_iter()
            .map(|session| resolve_session(session).map(|session| summary(owner, session)))
            .collect::<Result<Vec<_>, _>>()?,
        needs_you_count: page.pending_session_count,
        before: page.previous_cursor,
        after: page.next_cursor,
    };
    while !maka_workspace_support::fits(&result) {
        if result.sessions.len() <= 1 {
            break;
        }
        if reverse {
            result.sessions.remove(0);
            result.before = result.sessions.first().map(|session| session.id.clone());
        } else {
            result.sessions.pop();
            result.after = result.sessions.last().map(|session| session.id.clone());
        }
    }
    Ok(result)
}
fn decode<T: DeserializeOwned>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|_| "agent_input_invalid".into())
}
fn encode<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "agent_output_unavailable".into())
}
pub(crate) fn summary(owner: &Owner, session: SessionRecord<ResolvedConfiguration>) -> Session {
    summary_for(&owner.data_source, session)
}
pub(crate) fn summary_for(
    data_source: &DataSource,
    session: SessionRecord<ResolvedConfiguration>,
) -> Session {
    use maka_agent_facts::event::TerminalStatus;
    use maka_event_log::sessions::SessionExecutionState;
    let activity = if session.pending_interaction_since.is_some() {
        SessionActivity::Waiting
    } else if matches!(
        session.execution.map(|execution| execution.state),
        Some(
            SessionExecutionState::Live { .. }
                | SessionExecutionState::Ended {
                    status: TerminalStatus::Paused,
                    ..
                }
        )
    ) {
        SessionActivity::Working
    } else {
        SessionActivity::Idle
    };
    let branch = session
        .lineage
        .as_deref()
        .and_then(|lineage| lineage.branch())
        .map(|origin| SessionBranch {
            session_id: origin.parent_session_id.clone(),
            position: origin.position.clone(),
        });
    Session {
        parent_session_id: session.configuration.parent_session_id,
        branch,
        backend: session.configuration.backend,
        collaboration_mode: session.configuration.collaboration_mode,
        tools: session.configuration.tools,
        data_source: Box::new(data_source.clone()),
        permissions: session.configuration.permissions,
        boundary_revision: session.configuration.boundary_revision,
        binding: session.configuration.binding,
        activity,
        id: session.id,
        revision: session.revision,
        title: session.configuration.title,
        labels: session.configuration.labels,
        workspace: session.configuration.workspace,
        updated_at: session.updated_at,
        archived: session.archived,
        pinned: session.configuration.pinned,
        has_unread: session.read_state.has_unread,
        tail_message_id: session.last_message.map(|message| message.tail_message_id),
    }
}
fn delivery(event: StoreStreamEvent) -> Delivery {
    let tool_id = |operation: &str| {
        maka_agent_facts::tool_call::tool_use_id(&event.invocation.invocation_id, operation)
    };
    let model_tool_id = |step: &str, call: &str| tool_id(&format!("{step}:{call}"));
    let fact = match event.fact {
        StreamFact::InvocationOpened => DeliveryFact::Opened,
        StreamFact::ExecutorStarted => DeliveryFact::ExecutorStarted {
            message_id: event.id,
        },
        StreamFact::ExecutorDelta { text_kind, text } => DeliveryFact::Delta {
            step_id: event.invocation.invocation_id.clone(),
            part_id: match text_kind {
                maka_agent_facts::model::TextKind::Text => "text",
                maka_agent_facts::model::TextKind::Thinking => "thinking",
            }
            .into(),
            text,
        },
        StreamFact::ExecutorCompleted => DeliveryFact::StepEnded {
            step_id: event.invocation.invocation_id.clone(),
            completed: true,
        },
        StreamFact::ModelPartCommitted {
            step_id,
            message_id,
            ordinal,
        } => DeliveryFact::PartCommitted {
            step_id,
            message_id,
            ordinal,
        },
        StreamFact::ToolInputReady {
            step_id,
            tool_call_id,
            name,
            provider_executed,
        } => DeliveryFact::ToolInputReady {
            tool_use_id: model_tool_id(&step_id, &tool_call_id),
            step_id,
            name,
            provider_executed,
        },
        StreamFact::ProviderToolResult {
            step_id,
            tool_call_id,
            is_error,
        } => DeliveryFact::ProviderToolResult {
            tool_use_id: model_tool_id(&step_id, &tool_call_id),
            is_error,
        },
        StreamFact::ToolDispatched {
            operation_id,
            name,
            title,
        } => DeliveryFact::ToolDispatched {
            tool_use_id: tool_id(&operation_id),
            name,
            title,
        },
        StreamFact::ToolRejected { operation_id, .. } => DeliveryFact::ToolRejected {
            tool_use_id: tool_id(&operation_id),
        },
        StreamFact::ToolSettled {
            operation_id,
            outcome,
        } => {
            use maka_agent_facts::tool_call::ToolSettlement;
            DeliveryFact::ToolSettled {
                tool_use_id: tool_id(&operation_id),
                settlement: match outcome {
                    maka_event_log::observation::ToolSettlement::Succeeded => {
                        ToolSettlement::Returned
                    }
                    maka_event_log::observation::ToolSettlement::Failed => ToolSettlement::Failed,
                    maka_event_log::observation::ToolSettlement::Unknown => ToolSettlement::Unknown,
                },
            }
        }
        StreamFact::ExecutorToolStart { tool_call_id, name } => DeliveryFact::ExecutorToolStart {
            tool_use_id: tool_id(&tool_call_id),
            name,
        },
        StreamFact::ExecutorToolProgress { tool_call_id, text } => {
            DeliveryFact::ExecutorToolProgress {
                tool_use_id: tool_id(&tool_call_id),
                text,
            }
        }
        StreamFact::ExecutorToolResult {
            tool_call_id,
            is_error,
        } => DeliveryFact::ExecutorToolResult {
            tool_use_id: tool_id(&tool_call_id),
            is_error,
        },
        StreamFact::InvocationEnded { failed, .. } => DeliveryFact::Ended { failed },
        StreamFact::StepEnded {
            step_id, completed, ..
        } => DeliveryFact::StepEnded { step_id, completed },
        StreamFact::ContextChanged | StreamFact::MessageSteered => DeliveryFact::TranscriptChanged,
    };
    Delivery {
        sequence: event.sequence,
        invocation_id: event.invocation.invocation_id,
        turn_id: event.invocation.turn_id,
        fact,
    }
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
