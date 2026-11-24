/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::*;
use maka_agent_state::discovery::{
    DiscoveryCommit, DiscoveryStore, DossierUpsert, DossierUpsertOutcome,
};
use maka_event_log::{
    StoreError,
    root_store::DataWriter,
    writeback::{Prepared, Statement},
};
use schemars::JsonSchema;

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::owner) enum ScheduleOp {
    Update {
        task_id: String,
        intent_body: String,
    },
    Cancel {
        task_id: String,
    },
}
impl ScheduleOp {
    pub(in crate::owner) fn task_id(&self) -> &str {
        match self {
            Self::Update { task_id, .. } | Self::Cancel { task_id } => task_id,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum NotifyIntent {
    Quiet,
    Interrupt { reason: String },
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Upsert {
    #[serde(flatten)]
    dossier: DossierUpsert,
    #[serde(default)]
    schedule_ops: Vec<ScheduleOp>,
    notify_intent: NotifyIntent,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Finish {
    note: String,
    #[serde(default)]
    checked_topic_ids: Vec<TopicId>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReadTopic {
    topic_id: TopicId,
}

enum Call {
    Upsert { input: Upsert, fingerprint: String },
    Finish(Finish),
    Stage(artifacts::StageArtifact),
    Register(watches::RegisterWatch),
    Pending(actions::StagePendingAction),
    Preferences(preferences::Update),
    WatchScope(watch_scope::Update),
    WorkspaceMap(workspace_map::Update),
    List,
    Read(ReadTopic),
}

impl scheduler::Scheduler {
    pub(in crate::owner) fn dossier_tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        [
            (UPSERT,
             "Save one topic with expected_revision (0 for creation). title must concisely name the project/subject and core problem (16-32 chars, e.g. 'ETF 轮动明早开跑：缺 4 只 CSV 与 pandas'); NEVER start title with timestamps, rev numbers, or correction words ('更正'/'撤回'/'补坑'/'上一版'). Omit title on updates (expected_revision>0) to keep the existing stable title unless the core subject changed; put what changed into change_note (1 short line). Write summary_md as a self-contained current-state brief without internal revision archaeology. Existing staged artifacts are preserved and merged by path unless replace_artifacts is true. When asking the user to pick concrete actions, populate choices (2-3 clickable options with key, label, detail, recommended, resolves, instruction). schedule_ops can revise linked once tasks or cancel them. Use interrupt only when the user needs to act now.",
             schemars::schema_for!(Upsert), ToolSemantics::ExclusiveStep, ToolNesting::DirectOnly),
            (STAGE, "Prepare a ready-to-use UTF-8 draft, diff, checklist or brief in this topic’s isolated staging directory. Workers pass the receipt verbatim in UpsertDossier.artifacts. In a dossier thread the draft attaches to that topic automatically. input_paths are source files in the authorized workspace.",
             schemars::schema_for!(artifacts::StageArtifact), ToolSemantics::ExclusiveStep, ToolNesting::Nestable),
            (REGISTER, "Monitor an existing topic without a model. Pass predicate as a JSON object matching kind: file_hash -> {expected_hash: null|sha256}; deadline -> {trigger_at_ms: <unix_ms>}; http_check -> {status_code?, contains_text?, not_contains_text?, json_pointer_equals?}. HTTP intervals are in seconds.",
             schemars::schema_for!(watches::RegisterWatch), ToolSemantics::ExclusiveStep, ToolNesting::Nestable),
            (PENDING, "Stage an exact connector mutation for desktop confirmation and finish this turn. Include every source file, staged input and overwrite destination. Use workspace paths or staging/<topic_id>/<path> for staged files.",
             schemars::schema_for!(actions::StagePendingAction), ToolSemantics::FinishTurn, ToolNesting::DirectOnly),
            (WATCH_SCOPE, "Inspect or adjust this workspace’s discovery watch scope. Use concrete content directories and a brief reason for each. mark_surveyed can add includes and exclusions together.",
             schemars::schema_for!(watch_scope::Update), ToolSemantics::ExclusiveStep, ToolNesting::Nestable),
            (WORKSPACE_MAP, "Inspect or update the durable workspace semantic map (sources, recheck_hints, unfinished frontier, and onboarding readiness). Independent of WatchScope's 16-root limit. Use upsert_sources / record_frontier during onboarding and mark_ready once primary areas are mapped; use mark_verified after checking a mapped source.",
             schemars::schema_for!(workspace_map::Update), ToolSemantics::ExclusiveStep, ToolNesting::Nestable),
            (PREFERENCES, "Save an explicit user instruction for future discovery. Append a concise natural-language rule, or replace the rules for one scope. The host records the date.",
             schemars::schema_for!(preferences::Update), ToolSemantics::ExclusiveStep, ToolNesting::Nestable),
            (FINISH,
             "End the investigation turn cleanly after saving all UpsertDossier updates (or when nothing material changed). Pass checked_topic_ids for topics reviewed without further material changes.",
             schemars::schema_for!(Finish), ToolSemantics::FinishTurn, ToolNesting::DirectOnly),
            (LIST, "List compact discovery topics and user leads in urgency order.",
             schemars::schema_for!(DossiersRead), ToolSemantics::Parallel, ToolNesting::Nestable),
            (READ, "Read one topic with its summary, artifacts, linked reminders, watches and pending actions.",
             schemars::schema_for!(ReadTopic), ToolSemantics::Parallel, ToolNesting::Nestable),
        ].into_iter().map(|(name, description, schema, semantics, nesting)| ToolRegistration {
            definition: ToolDefinition {
                provider: None,
                name: name.into(),
                description: description.into(),
                input_schema: schema.into(),
                output_schema: None,
                freeform: None,
            },
            nesting,
            semantics,
            handler: ToolHandler::Prepared(self.clone()),
        }).collect()
    }
    pub(in crate::owner) fn prepare_dossier_tool(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.link.get().and_then(Weak::upgrade);
        Box::pin(async move {
            let owner = owner.ok_or(ToolRejection::Unavailable)?;
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let call = match name.as_str() {
                UPSERT => {
                    let fingerprint = hex::encode(Sha256::digest(
                        serde_json::to_vec(&input).expect("JSON tool input"),
                    ));
                    serde_json::from_value(input).map(|input| Call::Upsert { input, fingerprint })
                }
                REGISTER => serde_json::from_value(input).map(Call::Register),
                PENDING => serde_json::from_value(input).map(Call::Pending),
                STAGE => serde_json::from_value(input).map(Call::Stage),
                WATCH_SCOPE => serde_json::from_value(input).map(Call::WatchScope),
                WORKSPACE_MAP => serde_json::from_value(input).map(Call::WorkspaceMap),
                PREFERENCES => serde_json::from_value(input).map(Call::Preferences),
                FINISH => serde_json::from_value(input).map(Call::Finish),
                LIST => serde_json::from_value::<DossiersRead>(input).map(|_| Call::List),
                READ => serde_json::from_value(input).map(Call::Read),
                _ => return Err(ToolRejection::Unavailable),
            }
            .map_err(|e| ToolRejection::InvalidInput {
                message: e.to_string(),
            })?;
            Ok(PreparedEffect::new(move |cancel| {
                Box::pin(async move {
                    if cancel.is_cancelled() {
                        return Err(ToolError::Failed("discovery_cancelled".into()));
                    }
                    let captured = owner.clone();
                    let value = owner
                        .workers
                        .spawn(async move { captured.dossier_call(call, context, cancel).await })
                        .await
                        .map_err(|e| ToolError::OutcomeUnknown(e.to_string()))??;
                    Ok(value.into())
                })
            }))
        })
    }
}

pub(super) fn write_error(e: StoreError) -> ToolError {
    let mut cause = &e;
    while let StoreError::Shared(inner) = cause {
        cause = inner;
    }
    match cause {
        StoreError::CommitUnknown(_)
        | StoreError::OperationUnknown
        | StoreError::RollbackFailed { .. } => ToolError::OutcomeUnknown(e.to_string()),
        _ => ToolError::Failed(e.to_string()),
    }
}

impl Owner {
    async fn dossier_call(
        &self,
        call: Call,
        context: ToolCallContext,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        match call {
            Call::Register(input) => self.register_watch(&context, input, cancel).await,
            Call::Pending(input) => self.stage_pending_action(&context, input, cancel).await,
            Call::Stage(stage) => self.stage_artifact(&context, stage, cancel).await,
            Call::WatchScope(update) => self.update_watch_scope(&context, update).await,
            Call::WorkspaceMap(update) => self.update_workspace_map(&context, update).await,
            Call::Preferences(update) => self.update_discovery_preferences(&context, update).await,
            Call::Finish(input) => {
                if input.note.trim().is_empty() || input.note.len() > records::MAX_TEXT_BYTES {
                    return Err(ToolError::Failed(
                        "provide a concise investigation note".into(),
                    ));
                }
                self.complete_discovery(
                    context,
                    Report::NoReport {
                        note: input.note,
                        notes: vec![],
                    },
                    input.checked_topic_ids,
                )
                .await?;
                Ok(serde_json::json!({"recorded":true}))
            }
            Call::Upsert { input, fingerprint } => {
                if !input.dossier.title.trim().is_empty() {
                    validate_stable_title(&input.dossier.title)?;
                }
                let mut paths = BTreeSet::new();
                for artifact in &input.dossier.artifacts {
                    artifacts::validate_path(&input.dossier.topic_id, &artifact.path)
                        .map_err(|e| ToolError::Failed(reason(e)))?;
                    if !paths.insert(&artifact.path)
                        || artifact.sha256.len() != 64
                        || !artifact
                            .sha256
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        return Err(ToolError::Failed(
                            "attach distinct StageArtifact receipts".into(),
                        ));
                    }
                }
                let _gate = self.scheduler.gate.lock().await;
                let (_, job) = self
                    .scheduler
                    .investigation()
                    .await
                    .map_err(ToolError::Failed)?;
                let job = job.ok_or_else(|| ToolError::Failed("discovery_not_active".into()))?;
                let source_revision = self
                    .check_discovery_invocation(&context, &job)
                    .await
                    .map_err(ToolError::Failed)?;
                if !matches!(job.phase, Phase::Investigating { result: None }) {
                    return Err(ToolError::Failed("discovery_already_finished".into()));
                }
                if input.dossier.expected_revision.is_none() {
                    return Err(ToolError::Failed("expected_revision is required".into()));
                }
                let custody = context
                    .custody
                    .as_deref()
                    .ok_or_else(|| ToolError::Failed("agent_work_custody_unavailable".into()))?;
                let writer = self
                    .store
                    .data_writer_for_work(custody, &job.worker)
                    .map_err(write_error)?;
                let guard = self
                    .store
                    .session(&job.bot)
                    .await
                    .map_err(write_error)?
                    .revision_guard(&writer, source_revision)
                    .map_err(write_error)?;
                let op = DossierMutation {
                    wander: matches!(job.mode, Some(DiscoveryMode::Wander { .. })),
                    call_id: context.tool_use_id(),
                    caller: maka_agent_state::CallerFence {
                        execution: context.execution,
                        expected_basis: None,
                    },
                    fingerprint,
                    source: guard,
                    worker: job.worker,
                    target: job.approval.target,
                    scheduler: self.scheduler.clone(),
                    discovery: self.discovery.clone(),
                    writer: writer.clone(),
                    input,
                    at: UnixMillis(now() as i64),
                };
                writer.write(op).await.map_err(write_error)
            }
            Call::List | Call::Read(_) => {
                if self.bot.is(&context.execution.session_id) {
                    self.check_bot_invocation(&context)
                        .await
                        .map_err(ToolError::Failed)?;
                } else {
                    let (_, job) = self
                        .scheduler
                        .investigation()
                        .await
                        .map_err(ToolError::Failed)?;
                    self.check_discovery_invocation(
                        &context,
                        &job.ok_or_else(|| ToolError::Failed("discovery_not_active".into()))?,
                    )
                    .await
                    .map_err(ToolError::Failed)?;
                }
                Ok(match call {
                    Call::List => Value::Array(
                        self.discovery
                            .list_dossiers()
                            .await
                            .map_err(write_error)?
                            .into_iter()
                            .map(model_summary)
                            .collect(),
                    ),
                    Call::Read(input) => self
                        .discovery
                        .detail(input.topic_id)
                        .await
                        .map_err(write_error)?
                        .map_or(Value::Null, model_detail),
                    _ => unreachable!(),
                })
            }
        }
    }

    pub(super) async fn commit_discovery_writes<S: Statement>(
        &self,
        dossier: S,
        writes: Vec<Mutation>,
    ) -> Result<Vec<maka_plugin_core::storage::Record>, StoreError> {
        let writer = self.store.data_writer()?;
        let storage = self.scheduler.storage.prepare_statement(writes, &writer)?;
        writer.write(WithStorage(dossier, storage)).await
    }
}
fn starts_with_clock_or_rev(s: &str) -> bool {
    let bytes = s.as_bytes();
    // HH:MM...
    if bytes.len() >= 5
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[2] == b':'
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
    {
        return true;
    }
    // rev1 / rev 1 / v2 / v2:
    let lower = s.to_ascii_lowercase();
    for prefix in ["rev", "v"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim_start();
            if rest.as_bytes().first().is_some_and(u8::is_ascii_digit) {
                return true;
            }
        }
    }
    false
}

pub(super) fn validate_stable_title(title: &str) -> Result<(), ToolError> {
    let trimmed = title.trim();
    let trimmed_unquoted = trimmed.trim_start_matches(['[', '【', '(', '（']);
    let lower = trimmed_unquoted.to_ascii_lowercase();
    const FORBIDDEN_PREFIXES: &[&str] = &[
        "更正",
        "撤回",
        "补一个坑",
        "补坑",
        "修正",
        "纠正",
        "纠偏",
        "上一版",
        "上版",
        "更新：",
        "更新:",
        "correction:",
        "correction ",
        "retract:",
        "retracted:",
        "update:",
        "fix:",
    ];
    if starts_with_clock_or_rev(trimmed_unquoted)
        || FORBIDDEN_PREFIXES
            .iter()
            .any(|p| trimmed_unquoted.starts_with(p) || lower.starts_with(p))
    {
        return Err(ToolError::Failed(
            "title must concisely name the project/subject and core problem (e.g. 'ETF 轮动明早开跑：缺 4 只 CSV 与 pandas'), not a timestamp, revision number, or correction prefix. Put what changed into change_note, or omit title on updates to preserve the existing stable title.".into(),
        ));
    }
    Ok(())
}

fn model_summary(row: maka_agent_facts::discovery::DossierSummary) -> Value {
    serde_json::json!({
        "topic_id": row.topic_id, "title": row.title, "signal": row.signal, "window_at": row.window_at,
        "revision": row.revision, "last_material_change_at": row.last_material_change_at,
        "muted": row.muted, "artifact_count": row.artifact_count,
        "last_notified_revision": row.last_notified_revision, "last_interrupt_reason": row.last_interrupt_reason,
        "last_interrupt_at": row.last_interrupt_at,
    })
}

fn model_detail(detail: DossierDetail) -> Value {
    let dossier = detail.dossier;
    serde_json::json!({
        "topic_id": dossier.topic_id, "title": dossier.title, "signal": dossier.signal,
        "revision": dossier.revision, "priority_weight": dossier.priority_weight, "window_at": dossier.window_at,
        "summary_md": dossier.summary_md, "linked_task_ids": dossier.linked_task_ids,
        "thread_session_id": dossier.thread_session_id, "muted": dossier.muted,
        "last_checked_at": dossier.last_checked_at, "last_material_change_at": dossier.last_material_change_at,
        "last_notified_revision": dossier.last_notified_revision, "last_interrupt_reason": dossier.last_interrupt_reason,
        "last_interrupt_at": dossier.last_interrupt_at, "created_at": dossier.created_at, "updated_at": dossier.updated_at,
        "artifacts": dossier.artifacts.into_iter().map(|artifact| serde_json::json!({
            "path": artifact.path, "sha256": artifact.sha256, "purpose": artifact.purpose, "input_hashes": artifact.input_hashes,
        })).collect::<Vec<_>>(),
        "watches": detail.watches.into_iter().map(|watch| serde_json::json!({
            "watch_id": watch.watch_id, "topic_id": watch.topic_id, "kind": watch.kind, "target": watch.target, "predicate": watch.predicate,
            "on_trigger": watch.on_trigger, "last_state_hash": watch.last_state_hash, "expires_at": watch.expires_at,
            "created_at": watch.created_at, "updated_at": watch.updated_at,
        })).collect::<Vec<_>>(),
        "pending_actions": detail.pending_actions.into_iter().map(|action| serde_json::json!({
            "action_id": action.action_id, "topic_id": action.topic_id, "connector_tool": action.connector_tool, "params": action.params,
            "input_hashes": action.input_hashes, "idempotency_key": action.idempotency_key,
            "status": action.status, "receipt": action.receipt, "expires_at": action.expires_at,
            "created_at": action.created_at, "updated_at": action.updated_at,
        })).collect::<Vec<_>>(),
    })
}

struct WithStorage<A, B>(A, B);
impl<A: Statement, B: Statement> Statement for WithStorage<A, B> {
    type Value = (A::Value, B::Value);
    type Output = B::Output;
    const PREPARE_OFF_THREAD: bool = A::PREPARE_OFF_THREAD || B::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        let mut held = self.0.retain();
        held.extend(self.1.retain());
        held
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self(self.0.prepare()?, self.1.prepare()?))
    }
    fn execute(self, c: &rusqlite::Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let a = self.0.execute(c)?;
        let b = self.1.execute(c)?;
        Ok(Prepared {
            value: (a.value, b.value),
            changed: a.changed || b.changed,
            notification: a.notification.combine(b.notification),
        })
    }
    fn committed((a, b): Self::Value) -> Self::Output {
        let records = B::committed(b);
        A::committed(a);
        records
    }
    fn isolated_rejection(e: &StoreError) -> bool {
        A::isolated_rejection(e) || B::isolated_rejection(e)
    }
}

struct DossierMutation {
    wander: bool,
    caller: maka_agent_state::CallerFence,
    source: maka_event_log::root_store::SessionRevisionGuard,
    call_id: String,
    fingerprint: String,
    worker: String,
    target: ScheduledTarget,
    scheduler: Arc<scheduler::Scheduler>,
    discovery: DiscoveryStore,
    writer: DataWriter,
    input: Upsert,
    at: UnixMillis,
}
const LAST_UPSERT: &str = "discovery/last-upsert";
#[derive(Serialize, Deserialize)]
struct UpsertReceipt {
    call_id: String,
    fingerprint: String,
    result: Value,
}
impl Statement for DossierMutation {
    type Value = (
        Value,
        Option<DiscoveryCommit<DossierUpsertOutcome>>,
        Option<Arc<scheduler::Scheduler>>,
    );
    type Output = Value;
    fn execute(self, c: &rusqlite::Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let invalid = |s: &str| StoreError::InvalidTransition(s.into());
        if self.caller.status(c)? != maka_agent_state::CallerStatus::Current {
            return Err(invalid("discovery_execution_closed"));
        }
        self.source.validate(c)?;
        let storage = &self.scheduler.storage;
        let last = storage.read_in_transaction(c, LAST_UPSERT, &self.writer)?;
        if let Some(receipt) = last.as_ref().and_then(|r| r.data.value()) {
            let receipt: UpsertReceipt = serde_json::from_value(receipt.clone())?;
            if receipt.call_id == self.call_id {
                if receipt.fingerprint != self.fingerprint {
                    return Err(invalid("discovery_dossier_call_conflict"));
                }
                return Ok(Prepared {
                    value: (receipt.result, None, None),
                    changed: false,
                    notification: maka_event_log::writeback::Notification::NONE,
                });
            }
        }
        if self.wander && !self.caller.completed_local_tool(c, LIST)? {
            return Err(invalid(
                "Call ListDossiers before committing a Wander finding",
            ));
        }
        let Upsert {
            mut dossier,
            schedule_ops,
            notify_intent,
        } = self.input;
        let mut writes = Vec::new();
        if dossier.linked_task_ids.is_some() || !schedule_ops.is_empty() {
            let prior = self
                .discovery
                .linked_tasks_in_transaction(c, &dossier.topic_id)?;
            let links = dossier.linked_task_ids.get_or_insert_with(|| prior.clone());
            links.sort_unstable();
            links.dedup();
            writes = self.scheduler.dossier_schedule_ops(
                c,
                &self.writer,
                &self.target,
                &self.worker,
                &prior,
                links,
                schedule_ops,
                self.at.0,
            )?;
        }
        let scheduled = !writes.is_empty();
        let reason = match notify_intent {
            NotifyIntent::Quiet => None,
            NotifyIntent::Interrupt { reason } => Some(reason),
        };
        let dossier = self
            .discovery
            .upsert_statement(dossier, reason, self.at)
            .execute(c)?;
        let result = serde_json::to_value(&dossier.value.result)?;
        let receipt = UpsertReceipt {
            call_id: self.call_id,
            fingerprint: self.fingerprint,
            result: result.clone(),
        };
        writes.push(Mutation {
            key: LAST_UPSERT.into(),
            expected_revision: last.map(|r| r.revision),
            data: Data::Present(serde_json::to_value(receipt)?),
        });
        if let Some(active) = storage.read_in_transaction(c, ACTIVE, &self.writer)?
            && let Some(value) = active.data.value()
        {
            let mut job: Job = serde_json::from_value(value.clone())?;
            if !job.upserted_dossiers {
                job.upserted_dossiers = true;
                writes.push(Mutation {
                    key: ACTIVE.into(),
                    expected_revision: Some(active.revision),
                    data: Data::Present(serde_json::to_value(&job)?),
                });
            }
        }
        let storage = storage
            .prepare_statement(writes, &self.writer)?
            .execute(c)?;
        Ok(Prepared {
            value: (
                result,
                Some(dossier.value),
                scheduled.then_some(self.scheduler),
            ),
            changed: true,
            notification: dossier.notification.combine(storage.notification),
        })
    }
    fn committed((result, state, scheduler): Self::Value) -> Value {
        if let Some(state) = state {
            state.publish();
        }
        if let Some(scheduler) = scheduler {
            scheduler.notify_status_changed();
            scheduler.wake.notify_one();
        }
        result
    }
    fn isolated_rejection(e: &StoreError) -> bool {
        matches!(
            e.underlying(),
            StoreError::RevisionConflict { .. }
                | StoreError::SessionRevisionConflict { .. }
                | StoreError::InvalidTransition(_)
                | StoreError::SessionNotFound
                | StoreError::StatementRejected { .. }
        )
    }
}

impl Owner {
    pub(crate) fn drop_discovery_lead(
        &self,
        input: DiscoveryLead,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<DossierRead>, String> {
        let mut summary = input.text.trim().to_owned();
        let paths: Vec<_> = input
            .paths
            .into_iter()
            .filter(|p| !p.trim().is_empty())
            .collect();
        let title = summary
            .lines()
            .next()
            .filter(|s| !s.is_empty())
            .or_else(|| paths.first().map(String::as_str))
            .ok_or("discovery_lead_empty")?
            .chars()
            .filter(|c| !c.is_control())
            .take(96)
            .collect::<String>();
        for path in paths {
            if !summary.is_empty() {
                summary.push('\n');
            }
            summary.push_str(&path);
        }
        let topic_id = TopicId(format!("lead-{}", self.operation_id(operation)));
        let state = self.discovery.upsert_statement(
            DossierUpsert {
                topic_id: topic_id.clone(),
                expected_revision: Some(0),
                title,
                signal: maka_agent_facts::discovery::DossierSignal::Yellow,
                priority_weight: 100.,
                window_at: None,
                summary_md: summary,
                change_note: None,
                choices: vec![],
                artifacts: vec![],
                replace_artifacts: false,
                linked_task_ids: None,
            },
            None,
            UnixMillis(now() as i64),
        );
        Ok(NativeMutation::Commit {
            value: DossierRead { topic_id },
            change: self.message_writer(scope)?.prepare(state),
        })
    }
    pub(crate) async fn open_dossier_thread(
        self: &Arc<Self>,
        query: DossierRead,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<DossierThread>, String> {
        let dossier = self
            .discovery
            .get_dossier(query.topic_id)
            .await
            .map_err(reason)?
            .ok_or("discovery_topic_missing")?;
        if let Some(session_id) = dossier.thread_session_id {
            return Ok(NativeMutation::Returned(DossierThread { session_id }));
        }
        let (workspace, backend, incognito) = if let Some(session_id) = self.bot.session() {
            let session = self.session(&session_id).await?;
            (
                WorkspaceSelection::Session { session_id },
                session.configuration.backend,
                session.configuration.incognito,
            )
        } else {
            (
                self.default_bot_workspace()
                    .await?
                    .ok_or("discovery_thread_workspace_unavailable")?,
                None,
                false,
            )
        };
        let create = Create {
            incognito,
            kind: SessionKind::Agent,
            preset_id: None,
            backend,
            automatic_title: false,
            tools: None,
            title: dossier.title,
            labels: vec![],
            workspace,
        };
        let purpose = creation::Purpose::Dossier {
            topic: dossier.topic_id,
            revision: dossier.revision,
            summary: dossier.summary_md,
        };
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                match owner
                    .create_inner(create, &operation, &scope, purpose)
                    .await?
                {
                    creation::PreparedCreation::Ready(change) => {
                        Ok(NativeMutation::Computed { change })
                    }
                    creation::PreparedCreation::Rejected(reason) => {
                        Err(format!("dossier thread creation rejected: {reason:?}"))
                    }
                }
            })
        })
        .await
    }
}

impl Owner {
    pub(in crate::owner) async fn seed_dossier_input(
        &self,
        session: &str,
        request: &mut maka_agent_state::queue::PreparedRequest,
        summary: String,
        contents: &mut Vec<maka_agent_state::ContentBlob>,
    ) -> Result<(), String> {
        use maka_agent_facts::input::{QuoteRef, RunInput};
        use maka_agent_state::ContentBlob;
        let bytes = self
            .durable
            .queue()
            .content(
                session.into(),
                request.id.clone(),
                request.spec.input.clone(),
            )
            .await
            .map_err(reason)?;
        let mut input: RunInput = serde_json::from_slice(&bytes).map_err(reason)?;
        let RunInput::Message {
            content,
            source_messages,
            ..
        } = &mut input
        else {
            return Err("discovery_thread_message_required".into());
        };
        let [source] = source_messages.as_mut_slice() else {
            return Err("discovery_thread_source_missing".into());
        };
        let topic = self
            .discovery
            .thread_topic(session.to_owned())
            .await
            .map_err(reason)?
            .ok_or("discovery_thread_unbound")?;
        let quote = QuoteRef {
            text: format!(
                "topic_id: {}\n\n{summary}\n\n{}",
                topic.0,
                monitoring_prompt(request.spec.language)
            ),
            label: None,
            source_message_id: None,
            source_turn_id: None,
            source: None,
        };
        let quotes = content.quotes.get_or_insert_default();
        if quotes.first() == Some(&quote) {
            return Ok(());
        }
        quotes.insert(0, quote);
        source.message.content = content.clone();
        let source = ContentBlob::json(source).map_err(reason)?;
        let input = ContentBlob::json(&input).map_err(reason)?;
        request.source = source.reference().clone();
        request.spec.input = input.reference().clone();
        contents.extend([source, input]);
        Ok(())
    }
}
