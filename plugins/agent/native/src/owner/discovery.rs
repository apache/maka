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

//! Discovery owns a scheduler fire; the durable Agent queue owns its execution.
use super::notifications::BackgroundApproval;
use super::send::CaptureError;
use super::*;
use maka_agent_facts::{
    durable::{Fact, Terminal, UnixMillis},
    model::ModelUsage,
    tool_call::ToolRejection,
    tools::*,
};
use maka_agent_state::{
    Change, Head,
    discovery::activity::{ModelCharge, TokenAllowance},
    fold::RunView,
    queue::{MessageResolution, QueueCommand, QueueEdit, RequestId},
};
use maka_plugin_core::storage::{Data, Mutation, Store};
use maka_scheduler::{
    plan::{Fire, FireSource},
    task::{Outcome, Run},
};
use std::sync::Weak;
pub(super) const COMPLETE: &str = "DiscoveryComplete";
pub(super) const MEMORY: &str = "DiscoveryMemory";
pub(super) const UPSERT: &str = "UpsertDossier";
pub(super) const FINISH: &str = "FinishNoChange";
pub(super) const LIST: &str = "ListDossiers";
pub(super) const READ: &str = "ReadDossier";
pub(super) const STAGE: &str = "StageArtifact";
pub(super) const PREFERENCES: &str = "UpdateDiscoveryPreferences";
pub(super) const WATCH_SCOPE: &str = "UpdateWatchScope";
pub(super) const WORKSPACE_MAP: &str = "UpdateWorkspaceMap";
pub(super) const REGISTER: &str = "RegisterWatch";
pub(super) const PENDING: &str = "StagePendingAction";
pub(super) const WORKER_TOOLS: &[&str] = &[
    COMPLETE,
    UPSERT,
    FINISH,
    STAGE,
    REGISTER,
    PENDING,
    WATCH_SCOPE,
    WORKSPACE_MAP,
];
pub(super) const VISIBLE_TOOLS: &[&str] = &[
    COMPLETE,
    MEMORY,
    UPSERT,
    FINISH,
    LIST,
    READ,
    STAGE,
    REGISTER,
    PENDING,
    PREFERENCES,
    WATCH_SCOPE,
    WORKSPACE_MAP,
];
mod dossiers;
pub(super) use dossiers::ScheduleOp;
pub(super) const MODEL_ROUTE_CHANGED: &str = "background_model_route_changed";
pub(super) const APPROVED_MODEL_UNAVAILABLE: &str = "background_model_unavailable";
const RECALL_TOOLS: &[&str] = &["Recall", "RecallMore", "RecallMaterial"];
pub(super) const ACTIVE: &str = "discovery/active";
mod actions;
mod admission;
mod artifacts;
pub(in crate::owner) mod changes;
mod context;
mod preferences;
mod records;
mod roots;
mod watch_inputs;
pub(in crate::owner) mod watch_scope;
pub(in crate::owner) mod watches;
mod workspace_map;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Report {
    /// Record a quiet check and its new observations.
    NoReport {
        note: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<records::Note>,
    },
    /// Publish verified findings and source references to the plan’s dossier.
    Report {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<records::Note>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Phase {
    Investigating {
        result: Option<Report>,
    },
    Delivering,
    Converged {
        reason: driver::discovery::StopReason,
    },
    Stopping,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DiscoveryMode {
    Onboard,
    Briefing,
    FollowUp,
    Wander { sources: Vec<String> },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    mode: Option<DiscoveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allowance: Option<TokenAllowance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_charge: Option<ModelCharge>,
    fire_id: String,
    task_id: String,
    bot: String,
    worker: String,
    request: String,
    approval: BackgroundApproval,
    tools: scheduler::DiscoveryToolGrant,
    input: MessageInput,
    execution: Option<ExecutionIdentity>,
    phase: Phase,
    checkpoint: Option<records::Note>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    upserted_dossiers: bool,
}
pub(super) enum Dispatch {
    Worker(Option<Completed>),
    Skip,
    Defer(UnixMillis),
}

pub(super) fn job_token_budget(
    active: Option<maka_plugin_core::storage::Record>,
    fire_id: &str,
) -> Result<Option<u64>, String> {
    #[derive(Deserialize)]
    struct Allocation {
        fire_id: String,
        allowance: Option<TokenAllowance>,
    }
    let Some(Data::Present(value)) = active.map(|r| r.data) else {
        return Err("discovery_not_active".into());
    };
    let job: Allocation = serde_json::from_value(value).map_err(reason)?;
    if job.fire_id != fire_id {
        return Err("scheduler_original_fire_changed".into());
    }
    Ok(job.allowance.map(|a| a.tokens))
}

const RUN_TOKEN_SAFETY_BREAKER: u64 = 1_500_000;
const UNOBSERVED_WEIGHTED_CHARGE: u64 = 100_000;
const INEXACT_FALLBACK_CAP: u64 = 200_000;
const DEFAULT_INEXACT_FLOOR: u64 = 50_000;

fn weighted_usage(usage: &ModelUsage) -> Option<u64> {
    let input = usage.input_tokens?;
    let output = usage.output_tokens?;
    // Cache writes are ordinary input here. Reasoning is already in total output.
    let read = usage.cache_read_tokens.unwrap_or(0).min(input);
    Some(
        (input - read)
            .saturating_add(read / 10)
            .saturating_add(output.saturating_mul(4)),
    )
}

fn model_charge<'a>(
    raw_tokens: u64,
    admitted: impl Iterator<Item = Option<&'a ModelUsage>>,
) -> Option<ModelCharge> {
    let mut admitted = admitted.peekable();
    admitted.peek()?;
    let mut inexact = false;
    let mut weighted_sum: u64 = 0;
    for usage in admitted {
        match usage.and_then(weighted_usage) {
            Some(weighted) => weighted_sum = weighted_sum.saturating_add(weighted),
            None => inexact = true,
        }
    }
    let charged = if inexact {
        weighted_sum.max(raw_tokens.clamp(DEFAULT_INEXACT_FLOOR, INEXACT_FALLBACK_CAP))
    } else {
        weighted_sum
    };
    Some(ModelCharge::Admitted(charged))
}

impl Owner {
    async fn worker_charge(&self, view: Option<&RunView>) -> Result<Option<ModelCharge>, String> {
        let Some(view) = view else {
            return Ok(Some(ModelCharge::Unobserved(UNOBSERVED_WEIGHTED_CHARGE)));
        };
        let usages = self
            .durable
            .run_admitted_usages(view.run)
            .await
            .map_err(reason)?;
        Ok(model_charge(view.tokens, usages.iter().map(Option::as_ref)))
    }
}

impl DiscoveryMode {
    fn select_worker_tools(&self, names: &mut Vec<String>) {
        let dossiers = names.iter().any(|name| name == UPSERT);
        names.retain(|name| match name.as_str() {
            COMPLETE => !dossiers,
            WATCH_SCOPE => matches!(self, Self::Onboard),
            WORKSPACE_MAP => matches!(self, Self::Onboard | Self::Wander { .. }),
            _ => true,
        });
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct Completed {
    // Older receipts can also contain a copy of the report.
    pub(super) run: Run,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) incomplete: Option<driver::discovery::StopReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    report_generation: Option<uuid::Uuid>,
}
fn completed_key(fire: &str) -> String {
    format!(
        "discovery/completed/{}",
        hex::encode(Sha256::digest(fire.as_bytes()))
    )
}
fn authorization_revoked<T>(authorized: &Result<T, String>) -> bool {
    matches!(authorized, Err(e) if matches!(e.as_str(), "discovery_cancelled" | "scheduler_authorization_changed" | "agent_session_unavailable"))
}
fn reason(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn result_write_error(error: maka_plugin_core::storage::StoreError) -> ToolError {
    match error {
        maka_plugin_core::storage::StoreError::OutcomeUnknown(message) => {
            ToolError::OutcomeUnknown(message)
        }
        error => ToolError::Failed(error.to_string()),
    }
}
fn mutation<T: Serialize>(
    key: String,
    revision: Option<u64>,
    value: &T,
) -> Result<Mutation, String> {
    Ok(Mutation {
        key,
        expected_revision: revision,
        data: Data::Present(serde_json::to_value(value).map_err(reason)?),
    })
}
pub(super) fn permissions() -> WorkspacePermissions {
    WorkspacePermissions {
        access: WorkspaceAccess::ReadOnly,
        request_permissions: false,
    }
}

impl CaptureError {
    fn discovery_block(self) -> Result<&'static str, String> {
        match self {
            Self::ModelUnavailable => Ok(APPROVED_MODEL_UNAVAILABLE),
            Self::RouteChanged => Ok(MODEL_ROUTE_CHANGED),
            Self::AuthenticationRequired => Ok("agent_authentication_required"),
            Self::WorkspaceUnavailable => Ok("agent_workspace_unavailable"),
            Self::Other(error) => Err(error),
        }
    }
}

fn monitoring_prompt(language: Language) -> &'static str {
    match language {
        Language::ZH_CN => {
            "用 RegisterWatch 监测网页/接口状态、截止时间或文件变化。外发消息或覆写工作区文件时，用 StagePendingAction 暂存具体操作，交由用户确认。"
        }
        Language::ZH_TW => {
            "用 RegisterWatch 監測網頁/介面狀態、截止時間或檔案變更。外發訊息或覆寫工作區檔案時，用 StagePendingAction 暫存具體操作，交由使用者確認。"
        }
        _ => {
            "Use RegisterWatch to monitor web/API conditions, deadlines, or file changes. Use StagePendingAction for external sends and workspace overwrites so the user confirms the exact action."
        }
    }
}

fn investigation_prompt(
    language: Language,
    mode: &DiscoveryMode,
    direction: &str,
    memory_allowed: bool,
    history_allowed: bool,
) -> String {
    use maka_agent_facts::i18n::discovery as copy;
    let style = match mode {
        DiscoveryMode::Briefing => copy::investigation_briefing(language),
        _ => copy::investigation_alert(language),
    };
    let draft = copy::investigation_finish(language);
    let sandbox_and_tools = match language {
        Language::ZH_CN => {
            "工作区只读，Shell 无网。外部资料使用已授权的 WebSearch 或 WebFetch。在 Code Mode 中，可在 exec 内批量调用已开放的只读工具。UpsertDossier、FinishNoChange、StagePendingAction、RegisterWatch、UpdateWorkspaceMap 和 UpdateWatchScope 可用时，须在 exec 外作为顶层工具调用。"
        }
        Language::ZH_TW => {
            "工作區唯讀，Shell 無網路。外部資料請用已授權的 WebSearch 或 WebFetch。在 Code Mode 中，可在 exec 內批次呼叫已開放的唯讀工具。UpsertDossier、FinishNoChange、StagePendingAction、RegisterWatch、UpdateWorkspaceMap 和 UpdateWatchScope 可用時，須在 exec 外作為頂層工具呼叫。"
        }
        _ => {
            "The workspace is read-only and Shell is offline. Use authorized WebSearch or WebFetch for external sources. In Code Mode, you can batch available read-only tools inside exec. When available, UpsertDossier, FinishNoChange, StagePendingAction, RegisterWatch, UpdateWorkspaceMap and UpdateWatchScope must be called at the top level outside exec."
        }
    };
    let draft = format!(
        "{style}\n\n{draft} {} {sandbox_and_tools}",
        monitoring_prompt(language)
    );
    if matches!(mode, DiscoveryMode::Onboard) {
        let onboard = match language {
            Language::ZH_CN => {
                "Onboard 只调查当前已授权的工作区，从上次的地图检查点继续。前 2–4 步只梳理顶层和主要活跃目录，用 UpdateWorkspaceMap 的 upsert_sources 保存初步地图，再深入具体分支。不要用 cat 全文读取长文件或递归列出大型目录的全部内容。在 exec 中先筛选、汇总。深层或耗时分支只做一次短探测，用 record_frontier 保存原因和下次探测时间。用 recheck_hint 和 watch_mode 标注来源，watch 来源会自动监听。用 UpdateWatchScope 补充包含或排除项。主要区域查清后调用 mark_ready。将已核实的紧迫事项存入档案，以 FinishNoChange 收尾。"
            }
            Language::ZH_TW => {
                "Onboard 只調查目前已授權的工作區，從上次的地圖檢查點繼續。前 2–4 步只梳理頂層和主要活躍目錄，用 UpdateWorkspaceMap 的 upsert_sources 儲存初步地圖，再深入具體分支。不要用 cat 全文讀取長檔案或遞迴列出大型目錄的全部內容。在 exec 中先篩選、彙整。深層或耗時分支只做一次短探測，用 record_frontier 儲存原因和下次探測時間。以 recheck_hint 和 watch_mode 標註來源，watch 來源會自動監測。用 UpdateWatchScope 補充納入或排除項目。主要區域查清後呼叫 mark_ready。將已查證的緊急事項存入檔案，以 FinishNoChange 收尾。"
            }
            _ => {
                "Onboard the authorized workspace from its last map checkpoint. In the first 2–4 steps, survey the top level and main active directories and save that skeleton with UpdateWorkspaceMap (upsert_sources) before exploring any branch in depth. Avoid full-file cat and large recursive directory dumps. Filter and summarize inside exec. Give deep or slow branches one short probe, then use record_frontier to save the reason and next probe time. Set recheck_hint and watch_mode on mapped sources. Watch sources subscribe automatically. Use UpdateWatchScope for extra includes or exclusions. Call mark_ready once primary areas are covered, save urgent verified findings, and finish with FinishNoChange."
            }
        };
        return format!("{onboard}\n\n{draft}");
    }
    if matches!(mode, DiscoveryMode::Wander { .. }) {
        let wander = match language {
            Language::ZH_CN => {
                "只核查本轮到期的地图来源或待探分支，优先遵循 recheck_hint。核验后用 UpdateWorkspaceMap 的 mark_verified 记录结果，仍受阻时用 record_frontier 保存原因和下次探测时间。提交发现前调用 ListDossiers，按 entity_key 匹配并沿用 topic_id 和 revision。默认 quiet。"
            }
            Language::ZH_TW => {
                "只查核本輪到期的地圖來源或待探分支，優先遵循 recheck_hint。查證後以 UpdateWorkspaceMap 的 mark_verified 記錄結果，仍受阻時以 record_frontier 儲存原因與下次探測時間。提交發現前呼叫 ListDossiers，依 entity_key 比對並沿用 topic_id 和 revision。預設 quiet。"
            }
            _ => {
                "Check the single due source or frontier branch using its recheck_hint. After verification, use UpdateWorkspaceMap mark_verified. If blocked, record the reason and next probe time with record_frontier. Call ListDossiers before committing a finding. Match its entity_key and reuse the topic_id and revision. Default to quiet."
            }
        };
        return format!("{wander}\n\n{draft}");
    }
    let direction = direction.trim();
    let mut sections = Vec::new();
    if !direction.is_empty() {
        sections.push(format!(
            "{}\n{direction}",
            copy::investigation_focused(language)
        ));
    }
    if matches!(mode, DiscoveryMode::Briefing) {
        if memory_allowed {
            sections.push(copy::investigation_memory(language).into());
        }
        if history_allowed {
            sections.push(copy::investigation_history(language).into());
        }
        sections.push(match language {
            Language::ZH_CN => "交付本期简报时在对应的 UpsertDossier 中设置 briefing=true。按 entity_key 沿用已有档案，其他主题只在事实发生变化时更新。",
            Language::ZH_TW => "交付本期簡報時在對應的 UpsertDossier 設定 briefing=true。依 entity_key 沿用既有檔案，其他主題只在事實改變時更新。",
            _ => "Set briefing=true on the UpsertDossier delivering this edition. Match an existing dossier by entity_key. Update other topics only when their underlying facts change.",
        }.into());
    } else {
        sections.push(match language {
            Language::ZH_CN => "只核查本次触发涉及的档案、变动或监听项。用 ReadDossier 核对指定主题，按需用 ListDossiers 查找匹配的 entity_key 和当前 revision。以 quiet 为默认，无实质变化时用 FinishNoChange 记录已复核的 topic_id。",
            Language::ZH_TW => "只查核這次觸發涉及的檔案、變動或監測項目。以 ReadDossier 查證指定主題，視需要用 ListDossiers 尋找符合的 entity_key 與目前的 revision。預設 quiet，沒有實質變化時以 FinishNoChange 記錄已查核的 topic_id。",
            _ => "Check only the named topic, watch or changed sources. Use ReadDossier for the named topic and ListDossiers when you need its entity_key or current revision. Default to quiet. Use checked_topic_ids in FinishNoChange for topics reviewed without a material change.",
        }.into());
    }
    sections.push(draft);
    sections.join("\n\n")
}

impl scheduler::Scheduler {
    pub(in crate::owner) async fn discovery_status(
        &self,
        task: &str,
    ) -> Result<Option<ScheduledInvestigation>, String> {
        Ok(self
            .investigation()
            .await?
            .1
            .filter(|job| job.task_id == task)
            .and_then(|job| {
                Some(ScheduledInvestigation {
                    session_id: job.execution.as_ref()?.session_id.clone(),
                    turn_id: job.execution.as_ref()?.turn_id.clone(),
                    phase: match job.phase {
                        Phase::Investigating { .. } => InvestigationPhase::Investigating,
                        Phase::Delivering => InvestigationPhase::Delivering,
                        Phase::Stopping | Phase::Converged { .. } => InvestigationPhase::Stopping,
                    },
                })
            }))
    }
    pub(super) async fn discovery_progress(
        &self,
        view: &RunView,
    ) -> Result<Option<driver::discovery::Progress>, String> {
        let maka_agent_facts::durable::Trigger::Schedule { schedule_id } = &view.spec.trigger
        else {
            return Ok(None);
        };
        let (_, job) = self.investigation().await?;
        Ok(job
            .filter(|job| job.worker == view.spec.session_id && job.task_id == *schedule_id)
            .map(|job| {
                driver::discovery::Progress::new(match job.mode {
                    Some(DiscoveryMode::Wander { .. }) => driver::discovery::Mode::Wander,
                    Some(DiscoveryMode::Onboard) => driver::discovery::Mode::Onboard,
                    Some(DiscoveryMode::Briefing) => driver::discovery::Mode::Briefing,
                    _ => driver::discovery::Mode::FollowUp,
                })
            }))
    }
    async fn investigation(&self) -> Result<(Option<u64>, Option<Job>), String> {
        let record = self.storage.read(ACTIVE.into()).await.map_err(reason)?;
        let revision = record.as_ref().map(|r| r.revision);
        let job: Option<Job> = record
            .and_then(|r| r.data.value().cloned())
            .map(serde_json::from_value)
            .transpose()
            .map_err(reason)?;
        *self.investigation.write().unwrap() =
            job.as_ref().map(|job| scheduler::ActiveInvestigation {
                worker: job.worker.clone(),
                profile: job.tools.profile,
            });
        Ok((revision, job))
    }
    async fn save_investigation(
        &self,
        revision: Option<u64>,
        job: &Job,
    ) -> Result<u64, maka_plugin_core::storage::StoreError> {
        let records = self
            .storage
            .batch(vec![
                mutation(ACTIVE.into(), revision, job)
                    .map_err(maka_plugin_core::storage::StoreError::Unavailable)?,
            ])
            .await?;
        *self.investigation.write().unwrap() = Some(scheduler::ActiveInvestigation {
            worker: job.worker.clone(),
            profile: job.tools.profile,
        });
        self.notify_status_changed();
        Ok(records[0].revision)
    }
    async fn has_active_fire(&self, job: &Job) -> Result<bool, String> {
        let Some(saved) = self.change_basis(&job.task_id).await? else {
            return Ok(false);
        };
        let Some(fire) = saved.plan.pending.as_ref().filter(|fire| {
            saved.plan.task.status == maka_scheduler::task::Status::Active && fire.id == job.fire_id
        }) else {
            return Ok(false);
        };
        let Some(approval @ scheduler::Approval::Discovery { .. }) = &fire.authorization else {
            return Ok(false);
        };
        match approval.followup_grant() {
            Some(grant) => self.followup_is_current(grant).await,
            None => Ok(true),
        }
    }

    pub(super) fn discovery_tool(self: &Arc<Self>) -> ToolRegistration {
        ToolRegistration {
            definition: ToolDefinition {
                provider: None, name: COMPLETE.into(),
                description: "Finish an investigation captured with the legacy report tool. Record a quiet check or publish its verified report.".into(),
                input_schema: serde_json::to_value(schemars::schema_for!(Report)).expect("discovery schema"),
                output_schema: None, freeform: None,
            },
            nesting: ToolNesting::DirectOnly,
            semantics: ToolSemantics::FinishTurn,
            handler: ToolHandler::Prepared(self.clone()),
        }
    }
    pub(super) fn prepare_discovery(
        &self,
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
            let report: Report =
                serde_json::from_value(input).map_err(|e| ToolRejection::InvalidInput {
                    message: e.to_string(),
                })?;
            let (text, notes) = match &report {
                Report::NoReport { note, notes } => (note, notes),
                Report::Report { text, notes } => (text, notes),
            };
            if text.trim().is_empty() || text.len() > records::MAX_TEXT_BYTES {
                return Err(ToolRejection::InvalidInput {
                    message: "Provide a nonempty result or investigation note of at most 16384 UTF-8 bytes; reference the worker record for longer evidence".into(),
                });
            }
            records::validate_notes(notes)
                .map_err(|message| ToolRejection::InvalidInput { message })?;
            Ok(PreparedEffect::new(move |cancel| {
                Box::pin(async move {
                    if cancel.is_cancelled() {
                        return Err(ToolError::Failed("Discovery cancelled".into()));
                    }
                    // An observer cannot discard an accepted result write.
                    let captured = owner.clone();
                    let job = owner.workers.spawn(async move {
                        captured
                            .complete_discovery(context, COMPLETE, report, vec![])
                            .await
                    });
                    job.await
                        .map_err(|e| ToolError::OutcomeUnknown(e.to_string()))??;
                    Ok(serde_json::json!({"recorded":true}).into())
                })
            }))
        })
    }
}

impl Owner {
    pub(super) async fn restore_discovery(&self) -> Result<(), String> {
        self.discovery
            .recover_executing_actions(UnixMillis(now() as i64))
            .await
            .map_err(reason)?;
        let (revision, job) = self.scheduler.investigation().await?;
        let Some(mut job) = job else {
            return Ok(());
        };
        let authorized = self.discovery_authorized(&job).await;
        let pending = self.scheduler.has_active_fire(&job).await?;
        let retired = self.discovery_worker_retired(&job).await?;
        let unsafe_worker = self
            .store
            .get_session::<StoredSessionConfiguration>(&job.worker)
            .await
            .map_err(reason)?
            .is_some_and(|s| {
                s.configuration.permissions != permissions()
                    || job.tools.names.iter().any(|name| {
                        !WORKER_TOOLS.contains(&name.as_str()) && !self.permits_discovery_tool(name)
                    })
            });
        if unsafe_worker
            || matches!(job.phase, Phase::Stopping | Phase::Converged { .. })
            || !pending
            || authorization_revoked(&authorized)
            || retired
        {
            if !matches!(job.phase, Phase::Stopping)
                && (unsafe_worker || !pending || authorization_revoked(&authorized) || retired)
            {
                job.phase = Phase::Stopping;
                self.scheduler
                    .save_investigation(revision, &job)
                    .await
                    .map_err(reason)?;
            }
            // Commit cancellation before the ready queue can resume the original worker.
            if !retired
                && let MessageResolution::Delivered { run, shared: false } = self
                    .retract_discovery_request(&job.worker, &job.request)
                    .await?
            {
                let view = self
                    .session_run(&job.worker, run)
                    .await?
                    .ok_or("discovery_execution_unavailable")?;
                self.stop_discovery_run(&view, &job.phase)
                    .await
                    .map_err(reason)?;
            }
        } else {
            authorized?;
            if job.mode.is_none() && !job.input.has_content() {
                // No opening was acknowledged. Let the original pending fire pass through admission again.
                self.scheduler
                    .storage
                    .batch(vec![Mutation {
                        key: ACTIVE.into(),
                        expected_revision: revision,
                        data: Data::Deleted,
                    }])
                    .await
                    .map_err(reason)?;
                *self.scheduler.investigation.write().unwrap() = None;
            }
        }
        Ok(())
    }
    async fn discovery_worker_retired(&self, job: &Job) -> Result<bool, String> {
        match self.store.session_retirement(&job.worker).await {
            Ok(retired) => Ok(retired.is_some()),
            Err(maka_event_log::StoreError::SessionNotFound) => Ok(false),
            Err(error) => Err(reason(error)),
        }
    }
    async fn retract_discovery_request(
        &self,
        session: &str,
        request: &str,
    ) -> Result<MessageResolution, String> {
        let _ordered = self.runs.ordered(session).await;
        let queue = self.durable.queue();
        let delivery = queue
            .resolve_message(session.to_owned(), format!("m_{request}"))
            .await
            .map_err(reason)?;
        if matches!(delivery, MessageResolution::Pending) {
            let pending = queue.read(session.to_owned()).await.map_err(reason)?;
            queue
                .execute(
                    session.to_owned(),
                    QueueCommand {
                        id: maka_agent_facts::durable::FactId::new(),
                        at: UnixMillis(now() as i64),
                        expected_revision: pending.revision,
                        edit: QueueEdit::Retract {
                            request: RequestId(request.to_owned()),
                        },
                    },
                    vec![],
                )
                .await
                .map_err(reason)?;
            self.wake_notify.notify_one();
            return Ok(MessageResolution::Cancelled);
        }
        Ok(delivery)
    }
    pub(super) async fn converge_discovery(
        &self,
        view: &RunView,
        reason: driver::discovery::StopReason,
    ) -> Result<(), String> {
        let _gate = self.scheduler.gate.lock().await;
        let (revision, job) = self.scheduler.investigation().await?;
        let Some(mut job) = job.filter(|j| j.worker == view.spec.session_id) else {
            return Err("discovery_execution_changed".into());
        };
        let mut current = self
            .durable
            .frontier(view.run)
            .await
            .map_err(self::reason)?;
        if current.stopped || current.terminal.is_some() {
            return Ok(());
        }
        if matches!(job.phase, Phase::Investigating { result: None }) {
            job.phase = Phase::Converged { reason };
            self.scheduler
                .save_investigation(revision, &job)
                .await
                .map_err(self::reason)?;
        }
        loop {
            match self.stop_discovery_run(&current, &job.phase).await {
                Err(e)
                    if matches!(
                        e.underlying(),
                        maka_event_log::StoreError::RevisionConflict { .. }
                    ) =>
                {
                    current = self
                        .durable
                        .frontier(view.run)
                        .await
                        .map_err(self::reason)?;
                }
                result => {
                    result.map_err(self::reason)?;
                    break;
                }
            }
        }
        self.scheduler.wake.notify_one();
        Ok(())
    }
    async fn stop_discovery_run(
        &self,
        view: &RunView,
        phase: &Phase,
    ) -> Result<bool, maka_event_log::StoreError> {
        if view.terminal.is_some() || view.stopped {
            return Ok(false);
        }
        self.durable
            .control(
                view.run,
                Head::from(view),
                vec![Change::new(
                    Fact::StopRequested {
                        diagnostic: match phase {
                            Phase::Converged { reason } => reason.message(),
                            _ => "discovery_cancelled",
                        }
                        .into(),
                        requester: maka_agent_facts::durable::StopRequester::Internal,
                    },
                    UnixMillis(now() as i64),
                )],
                vec![],
            )
            .await?;
        self.wake_notify.notify_one();
        Ok(true)
    }
    pub(super) async fn discovery_tool_grant(
        &self,
        basis: &CapturedRun,
        target: &ScheduledTarget,
        profile: DiscoveryWorkerTools,
        selection: Option<&DiscoveryToolSelection>,
    ) -> Result<scheduler::DiscoveryToolGrant, String> {
        let source = self.session(&target.session_id).await?;
        check_target(&source, target)?;
        let catalog = match profile {
            DiscoveryWorkerTools::ReadOnly => &self.mcp_projects.base.tools,
            DiscoveryWorkerTools::Session => {
                &basis
                    .mcp_catalog
                    .as_ref()
                    .ok_or("discovery_tool_catalog_unavailable")?
                    .for_new_session()
                    .tools
            }
        };
        let editing = basis.model.as_ref().and_then(|model| model.editing_tools);
        let mut names = self
            .select_catalog_tools(
                catalog,
                None,
                source.configuration.tools.as_deref(),
                editing,
            )
            .names();
        if profile == DiscoveryWorkerTools::ReadOnly {
            names.retain(|name| self.read_only_discovery_tool(name));
        }
        names.extend(
            [MEMORY, LIST, READ]
                .into_iter()
                .filter(|name| catalog.contains(name))
                .map(str::to_owned),
        );
        names.extend(WORKER_TOOLS.iter().map(|name| (*name).to_owned()));
        names.retain(|name| name != COMPLETE);
        let names =
            self.discovery_worker_tools(&names, source.configuration.tools.as_deref(), selection);
        // Optional tools must retain their displayed category and parent approval.
        if selection.is_some_and(|selected| {
            selected.len()
                != names
                    .iter()
                    .filter(|n| !WORKER_TOOLS.contains(&n.as_str()))
                    .count()
        }) {
            return Err("scheduler_discovery_tools_changed".into());
        }
        Ok(scheduler::DiscoveryToolGrant { profile, names })
    }

    pub(super) fn discovery_tool_group(&self, name: &str) -> DiscoveryToolGroup {
        if let Some(tool) = self.tool_basis.iter().find(|tool| tool.name() == name) {
            return tool.discovery_group;
        }
        if RECALL_TOOLS.contains(&name) || matches!(name, MEMORY | LIST | READ) {
            return DiscoveryToolGroup::History;
        }
        match name {
            "ScheduledTask" | "CreateGoal" | "GetGoal" | "GoalStatus" | "todo_read"
            | "todo_write" => DiscoveryToolGroup::Sessions,
            _ => DiscoveryToolGroup::Other,
        }
    }

    pub(super) fn read_only_discovery_tool(&self, name: &str) -> bool {
        WORKER_TOOLS.contains(&name)
            || matches!(
                self.discovery_tool_group(name),
                DiscoveryToolGroup::ReadFiles | DiscoveryToolGroup::History
            )
    }

    pub(super) fn permits_discovery_tool(&self, name: &str) -> bool {
        match self.tool_basis.iter().find(|tool| tool.name() == name) {
            Some(tool) => tool.discovery_safe,
            None => {
                matches!(name, MEMORY | LIST | READ | "ScheduledTask")
                    || RECALL_TOOLS.contains(&name)
            }
        }
    }

    fn discovery_worker_tools(
        &self,
        names: &[String],
        configured: Option<&[String]>,
        selection: Option<&DiscoveryToolSelection>,
    ) -> Vec<String> {
        let mut allowed: Vec<_> = names
            .iter()
            .filter(|name| {
                !WORKER_TOOLS.contains(&name.as_str())
                    && self.permits_discovery_tool(name)
                    && (self.settings.recall || !RECALL_TOOLS.contains(&name.as_str()))
                    && configured.is_none_or(|configured| configured.contains(name))
                    && selection.is_none_or(|selected| {
                        selected.get(name.as_str()) == Some(&self.discovery_tool_group(name))
                    })
            })
            .cloned()
            .collect();
        let reads_files = self.discovery_reads_files(&allowed);
        allowed.extend(
            names
                .iter()
                .filter(|name| {
                    WORKER_TOOLS.contains(&name.as_str())
                        && (!matches!(name.as_str(), WATCH_SCOPE | WORKSPACE_MAP) || reads_files)
                })
                .cloned(),
        );
        allowed.sort_unstable();
        allowed.dedup();
        allowed
    }

    async fn discovery_authorized(
        &self,
        job: &Job,
    ) -> Result<SessionRecord<ResolvedConfiguration>, String> {
        if !self.settings.bot || !self.settings.scheduled_tasks || !self.bot.is(&job.bot) {
            return Err("discovery_cancelled".into());
        }
        let source = self.session(&job.bot).await?;
        check_target(&source, &job.approval.target)?;
        Ok(source)
    }
    async fn check_discovery_invocation(
        &self,
        context: &ToolCallContext,
        job: &Job,
    ) -> Result<u64, String> {
        if context.execution.session_id != job.worker
            || !matches!(job.phase, Phase::Investigating { .. })
        {
            return Err("discovery_wrong_execution".into());
        }
        let view = self
            .session_run(&job.worker, context.execution.run_id)
            .await?
            .ok_or("discovery_execution_unavailable")?;
        if view.spec.turn_id != context.execution.turn_id || view.stopped || view.terminal.is_some()
        {
            return Err("discovery_execution_closed".into());
        }
        if !matches!(self.durable.queue().resolve_message(job.worker.clone(), format!("m_{}",job.request)).await.map_err(reason)?, MessageResolution::Delivered {run, shared:false} if run == context.execution.run_id)
        {
            return Err("discovery_execution_changed".into());
        }
        let revision = self.discovery_authorized(job).await?.revision;
        if !self.scheduler.has_active_fire(job).await? {
            return Err("discovery_cancelled".into());
        }
        Ok(revision)
    }
    async fn complete_discovery(
        &self,
        context: ToolCallContext,
        tool: &str,
        report: Report,
        checked: Vec<TopicId>,
    ) -> Result<(), ToolError> {
        let _gate = self.scheduler.gate.lock().await;
        let (revision, job) = self
            .scheduler
            .investigation()
            .await
            .map_err(ToolError::Failed)?;
        let mut job = job.ok_or_else(|| ToolError::Failed("discovery_not_active".into()))?;
        self.check_discovery_invocation(&context, &job)
            .await
            .map_err(ToolError::Failed)?;
        if !job.tools.names.iter().any(|name| name == tool) {
            return Err(ToolError::Failed(
                "completion tool outside the worker grant".into(),
            ));
        }
        if matches!(job.mode, Some(DiscoveryMode::Wander { .. }))
            && matches!(report, Report::Report { .. })
        {
            return Err(ToolError::Failed(
                "Use ListDossiers and UpsertDossier to commit a Wander finding".into(),
            ));
        }
        let Phase::Investigating { result } = &mut job.phase else {
            unreachable!()
        };
        if let Some(previous) = result {
            return if *previous == report {
                Ok(())
            } else {
                Err(ToolError::Failed("discovery_result_conflict".into()))
            };
        }
        *result = Some(report);
        job.execution = Some(context.execution);
        if checked.is_empty() {
            self.scheduler
                .save_investigation(revision, &job)
                .await
                .map_err(result_write_error)?;
        } else {
            let state = self
                .discovery
                .touch_statement(checked, UnixMillis(now() as i64));
            let active = mutation(ACTIVE.into(), revision, &job).map_err(ToolError::Failed)?;
            self.commit_discovery_writes(state, vec![active])
                .await
                .map_err(dossiers::write_error)?;
            self.scheduler.notify_status_changed();
        }
        self.scheduler.wake.notify_one();
        Ok(())
    }
    pub(super) async fn dispatch_discovery(
        self: &Arc<Self>,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        enabled: bool,
        plan: &scheduler::Plan,
        at: UnixMillis,
    ) -> Result<Dispatch, String> {
        if let Some(record) = self
            .scheduler
            .storage
            .read(completed_key(&fire.id))
            .await
            .map_err(reason)?
            && let Some(value) = record.data.value()
        {
            return Ok(Dispatch::Worker(Some(
                serde_json::from_value::<Completed>(value.clone()).map_err(reason)?,
            )));
        }
        let (mut revision, current) = self.scheduler.investigation().await?;
        if current.as_ref().is_some_and(|j| j.fire_id != fire.id) {
            return Ok(Dispatch::Worker(None));
        }
        let new_job = current.is_none();
        let mut job = if let Some(job) = current {
            job
        } else {
            let Some(
                scheduler::Approval::Discovery {
                    approval, tools, ..
                }
                | scheduler::Approval::CancelledDiscovery { approval, tools },
            ) = &fire.authorization
            else {
                return Err("discovery_approval_missing".into());
            };
            let request = hex::encode(Sha256::digest(fire.id.as_bytes()));
            let worker = format!("{}{}", self.prefix, &request[..32]);
            Job {
                mode: None,
                allowance: None,
                model_charge: None,
                fire_id: fire.id.clone(),
                task_id: fire.task_id.clone(),
                bot: approval.target.session_id.clone(),
                worker,
                request,
                approval: approval.clone(),
                tools: tools.clone(),
                input: String::new().into(),
                execution: None,
                phase: Phase::Investigating { result: None },
                checkpoint: None,
                upserted_dossiers: false,
            }
        };
        let authorized = self.discovery_authorized(&job).await;
        let revoked = authorization_revoked(&authorized);
        if !revoked && enabled && !matches!(job.phase, Phase::Stopping) {
            let source = authorized?;
            if new_job
                && matches!(
                    fire.authorization,
                    Some(scheduler::Approval::Discovery { .. })
                )
            {
                let Some(mode) = self
                    .discovery_mode(&job, fire, at, source.configuration.tools.as_deref())
                    .await?
                else {
                    return Ok(Dispatch::Skip);
                };
                let activity = self
                    .discovery
                    .plan_activity(&job.task_id)
                    .await
                    .map_err(reason)?;
                let allowance = match mode.allowance(&activity, fire.source, at) {
                    Ok(allowance) => allowance,
                    Err(until) => return Ok(Dispatch::Defer(until)),
                };
                // Freeze the actual worker surface before its session or opening exists.
                mode.select_worker_tools(&mut job.tools.names);
                job.mode = Some(mode);
                job.allowance = Some(allowance);
            }
        }
        if new_job {
            revision = Some(
                self.scheduler
                    .save_investigation(revision, &job)
                    .await
                    .map_err(reason)?,
            );
        }
        self.dispatch_discovery_job(fire, enabled, plan, revision, job, revoked)
            .await
            .map(Dispatch::Worker)
    }

    async fn dispatch_discovery_job(
        self: &Arc<Self>,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        enabled: bool,
        plan: &scheduler::Plan,
        mut revision: Option<u64>,
        mut job: Job,
        revoked: bool,
    ) -> Result<Option<Completed>, String> {
        let retired = self.discovery_worker_retired(&job).await?;
        if retired
            || matches!(job.phase, Phase::Stopping)
            || !enabled
            || matches!(
                fire.authorization,
                Some(scheduler::Approval::CancelledDiscovery { .. })
            )
            || revoked
        {
            if retired {
                // Retirement may remove the run before its final usage can be observed.
                if job.model_charge.is_none() && job.input.has_content() {
                    let view = match self
                        .durable
                        .latest_run(job.worker.clone())
                        .await
                        .map_err(reason)?
                    {
                        Some(run) => self.durable.find_run(run).await.map_err(reason)?,
                        None => None,
                    };
                    job.model_charge = self.worker_charge(view.as_ref()).await?;
                }
                job.phase = Phase::Stopping;
                return self
                    .settle_discovery(
                        fire,
                        revision,
                        &job,
                        Outcome::Blocked,
                        "Investigation Session retired",
                    )
                    .await
                    .map(Some);
            }
            if !matches!(job.phase, Phase::Stopping) {
                job.phase = Phase::Stopping;
                revision = Some(
                    self.scheduler
                        .save_investigation(revision, &job)
                        .await
                        .map_err(reason)?,
                );
            }
        }
        if matches!(job.phase, Phase::Delivering) {
            return self.deliver_discovery_report(fire, revision, &job).await;
        }
        let queue = self.durable.queue();
        let message = format!("m_{}", job.request);
        let resolution = queue
            .resolve_message(job.worker.clone(), message.clone())
            .await
            .map_err(reason)?;
        match resolution {
            MessageResolution::Missing => {
                if matches!(job.phase, Phase::Stopping) {
                    return self
                        .settle_discovery(
                            fire,
                            revision,
                            &job,
                            Outcome::Blocked,
                            "Investigation cancelled before admission",
                        )
                        .await
                        .map(Some);
                }
                if let Err(error) = self
                    .enqueue_discovery_worker(&mut job, &mut revision, fire, plan)
                    .await
                {
                    return self
                        .settle_discovery(
                            fire,
                            revision,
                            &job,
                            Outcome::Blocked,
                            error.discovery_block()?,
                        )
                        .await
                        .map(Some);
                }
                return Ok(None);
            }
            MessageResolution::Pending => {
                if matches!(job.phase, Phase::Stopping) {
                    self.retract_discovery_request(&job.worker, &job.request)
                        .await?;
                }
                return Ok(None);
            }
            MessageResolution::Cancelled => {
                return self
                    .settle_discovery(
                        fire,
                        revision,
                        &job,
                        Outcome::Blocked,
                        "Investigation cancelled",
                    )
                    .await
                    .map(Some);
            }
            MessageResolution::Delivered { run, shared } => {
                if shared {
                    return Err("discovery_shared_execution".into());
                }
                let view = self
                    .session_run(&job.worker, run)
                    .await?
                    .ok_or("discovery_execution_unavailable")?;
                let execution = ExecutionIdentity {
                    session_id: job.worker.clone(),
                    turn_id: view.spec.turn_id.clone(),
                    run_id: run,
                };
                if job.execution.as_ref() != Some(&execution) {
                    job.execution = Some(execution);
                    revision = Some(
                        self.scheduler
                            .save_investigation(revision, &job)
                            .await
                            .map_err(reason)?,
                    );
                }
                if matches!(job.phase, Phase::Stopping | Phase::Converged { .. })
                    && self
                        .stop_discovery_run(&view, &job.phase)
                        .await
                        .map_err(reason)?
                {
                    return Ok(None);
                }
                let Some(terminal) = &view.terminal else {
                    return Ok(None);
                };
                let runs = self.runs.state().await;
                if runs
                    .controls
                    .get(&job.worker)
                    .is_some_and(|c| c.execution.run_id == run)
                    || runs
                        .preparing
                        .get(&job.worker)
                        .is_some_and(|p| p.run == run)
                    || (!runs.controls.contains_key(&job.worker)
                        && runs.retained_cleanup.contains_key(&job.worker))
                {
                    return Ok(None);
                }
                drop(runs);
                job.model_charge = self.worker_charge(Some(&view)).await?;
                if let Phase::Converged { reason } = job.phase
                    && matches!(terminal, Terminal::Completed | Terminal::Cancelled)
                {
                    return self
                        .settle_discovery(fire, revision, &job, Outcome::Ok, reason.message())
                        .await
                        .map(Some);
                }
                if terminal != &Terminal::Completed || matches!(job.phase, Phase::Stopping) {
                    return self
                        .settle_discovery(
                            fire,
                            revision,
                            &job,
                            if matches!(job.phase, Phase::Stopping) {
                                Outcome::Blocked
                            } else {
                                Outcome::Failed
                            },
                            "Investigation execution failed or was stopped",
                        )
                        .await
                        .map(Some);
                }
            }
        }
        match &job.phase {
            Phase::Investigating {
                result: Some(Report::NoReport { .. }),
            } => self
                .settle_discovery(
                    fire,
                    revision,
                    &job,
                    Outcome::Ok,
                    if job.upserted_dossiers {
                        "Dossiers updated"
                    } else {
                        "No report"
                    },
                )
                .await
                .map(Some),
            Phase::Investigating {
                result: Some(Report::Report { .. }),
            } if job.upserted_dossiers => self
                .settle_discovery(fire, revision, &job, Outcome::Ok, "Dossiers updated")
                .await
                .map(Some),
            Phase::Investigating {
                result: Some(Report::Report { .. }),
            } if job.tools.names.iter().any(|name| name == COMPLETE) => {
                // The memory record is the durable source for resumed delivery.
                let mut writes = self.scheduler.outcome_mutations(&job, &Outcome::Ok).await?;
                job.phase = Phase::Delivering;
                job.checkpoint = None;
                writes.insert(0, mutation(ACTIVE.into(), revision, &job)?);
                let staged = self.scheduler.storage.batch(writes).await.map_err(reason)?;
                self.deliver_discovery_report(fire, Some(staged[0].revision), &job)
                    .await
            }
            _ => self
                .settle_discovery(
                    fire,
                    revision,
                    &job,
                    Outcome::Failed,
                    "Investigation ended without a completion tool",
                )
                .await
                .map(Some),
        }
    }
    async fn discovery_input(
        &self,
        job: &Job,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        timezone: &str,
        mode: &DiscoveryMode,
        allowed_tools: &[String],
    ) -> Result<
        (
            MessageInput,
            maka_agent_state::discovery::changes::OpeningSources,
        ),
        String,
    > {
        let history_allowed = fire.effect.selected_discovery_tools().is_none()
            || allowed_tools
                .iter()
                .any(|name| self.discovery_tool_group(name) == DiscoveryToolGroup::History);
        let (mut prompt, sources) = self
            .discovery_opening(mode, job, fire, allowed_tools)
            .await?;
        let root = std::path::Path::new(&job.approval.target.workspace.path);
        if matches!(mode, DiscoveryMode::Onboard)
            && let Some(survey) =
                self.watch_scopes
                    .survey(root, allowed_tools, job.approval.language, now() as i64)
        {
            prompt.push_str("\n\n");
            prompt.push_str(survey);
        }
        prompt.push_str("\n\n");
        if allowed_tools.iter().any(|name| name == COMPLETE)
            && !allowed_tools.iter().any(|name| name == UPSERT)
        {
            prompt.push_str(fire.intent.body());
            prompt.push_str(match job.approval.language {
                Language::ZH_CN => "\n核实本次调查的结论后，用 DiscoveryComplete 提交报告或静默结束。",
                Language::ZH_TW => "\n查證本次調查的結論後，以 DiscoveryComplete 提交報告或靜默結束。",
                _ => "\nVerify the findings for this investigation. Finish with DiscoveryComplete to record a report or a quiet check.",
            });
        } else {
            prompt.push_str(&investigation_prompt(
                job.approval.language,
                mode,
                fire.intent.body(),
                allowed_tools.iter().any(|name| name == MEMORY),
                history_allowed,
            ));
        }
        if matches!(mode, DiscoveryMode::Wander { .. })
            && !allowed_tools.iter().any(|name| name == LIST)
        {
            prompt.push_str(match job.approval.language {
                Language::ZH_CN => "\n本轮未授权 ListDossiers，无法提交去重后的发现。用 FinishNoChange 静默收尾。",
                Language::ZH_TW => "\n此輪未授權 ListDossiers，無法提交去重後的發現。請用 FinishNoChange 安靜收尾。",
                _ => "\nThis plan does not grant ListDossiers. Finish quietly with FinishNoChange when you cannot check for duplicates.",
            });
        }
        prompt.push_str(&context::environment(
            job.approval.language,
            &job.approval.target.workspace.path,
            timezone,
        ));
        Ok((prompt.into(), sources))
    }

    async fn enqueue_discovery_worker(
        &self,
        job: &mut Job,
        revision: &mut Option<u64>,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        plan: &scheduler::Plan,
    ) -> Result<(), CaptureError> {
        let source = self.session(&job.bot).await?;
        let allowed_tools = self.discovery_worker_tools(
            &job.tools.names,
            source.configuration.tools.as_deref(),
            fire.effect.selected_discovery_tools(),
        );
        if self
            .store
            .get_session::<StoredSessionConfiguration>(&job.worker)
            .await
            .map_err(reason)?
            .is_none()
        {
            self.store
                .create_session(
                    &job.worker,
                    &job.request,
                    &StoredSessionConfiguration {
                        incognito: source.configuration.incognito,
                        parent_session_id: Some(job.bot.clone()),
                        backend: Some(BackendPreference::model(
                            job.approval.model.clone(),
                            job.approval.thinking_level,
                        )),
                        compaction_prompt: None,
                        dossier_seed: None,
                        dossier_elevated: false,
                        discovery_worker: true,
                        applied_preset: None,
                        collaboration_mode: CollaborationMode::Agent,
                        tools: Some(allowed_tools.clone()),
                        title: fire.title.clone(),
                        title_is_manual: true,
                        pinned: false,
                        labels: vec![],
                        workspace: source
                            .workspace_binding
                            .as_ref()
                            .ok_or(CaptureError::WorkspaceUnavailable)?
                            .reference(),
                        permissions: permissions(),
                        boundary_revision: 0,
                    },
                    fire.scheduled_at as u64,
                )
                .await
                .map_err(reason)?;
        }
        let native = self
            .services
            .request(
                maka_capabilities::call::Identity::Native,
                self.stop.child_token(),
            )
            .map_err(reason)?;
        let captured = self
            .capture_current_run(
                &job.worker,
                Some(BackendPreference::model(
                    job.approval.model.clone(),
                    job.approval.thinking_level,
                )),
                job.request.clone(),
                native.scope(),
            )
            .await;
        let cleanup = native.finish().await;
        let mut basis = send::finish_capture(captured, cleanup)?;
        if !job
            .approval
            .accepted_model
            .same_execution_route(basis.model.as_ref().ok_or(CaptureError::ModelUnavailable)?)
        {
            return Err(CaptureError::RouteChanged);
        }
        basis.model = Some(job.approval.accepted_model.clone());
        // Freeze the opening and acknowledge its snapshot in the same Root transaction.
        if !job.input.has_content() || allowed_tools != job.tools.names {
            let now_ms = UnixMillis((now() as i64).max(fire.scheduled_at));
            let mode = job.mode.as_ref().unwrap_or(&DiscoveryMode::FollowUp);
            let (input, sources) = self
                .discovery_input(job, fire, &plan.timezone, mode, &allowed_tools)
                .await?;
            job.input = input;
            job.tools.names.clone_from(&allowed_tools);
            let active = mutation(ACTIVE.into(), *revision, job)?;
            let records = self
                .commit_discovery_writes(
                    self.discovery.record_opening(sources, now_ms),
                    vec![active],
                )
                .await
                .map_err(reason)?;
            *revision = Some(records[0].revision);
        }
        let input = job.input.clone();
        basis.allowed_tools = Some(allowed_tools);
        basis.background = Some(job.approval.target.clone());
        basis.background_sandbox_ceiling = job.approval.sandbox_ceiling.clone();
        basis.background_kind = BackgroundKind::Schedule {
            task_id: job.task_id.clone(),
        };
        let source = RootSourceMessage {
            message: DeliveredMessage {
                message_id: format!("m_{}", job.request),
                origin: None,
                submitted_content_digest: input.content_digest().map_err(reason)?,
                content: input.clone(),
            },
            unprepared_content: input,
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        self.enqueue_background(
            &job.worker,
            source,
            &basis,
            &job.request,
            Default::default(),
            false,
        )
        .await?;
        Ok(())
    }
    async fn deliver_discovery_report(
        &self,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        revision: Option<u64>,
        job: &Job,
    ) -> Result<Option<Completed>, String> {
        let topic = TopicId(job.task_id.clone());
        let previous = self
            .discovery
            .get_dossier(topic.clone())
            .await
            .map_err(reason)?;
        if previous.as_ref().is_some_and(|record| {
            record.unfollowed || record.signal == maka_agent_facts::discovery::DossierSignal::Done
        }) {
            return self
                .settle_discovery(fire, revision, job, Outcome::Ok, "Dossier closed")
                .await
                .map(Some);
        }
        let text = self.scheduler.report_for_delivery(job).await?;
        let at = UnixMillis(now() as i64);
        let dossier = maka_agent_state::discovery::DossierUpsert {
            topic_id: topic,
            entity_key: None,
            reopen: false,
            expected_revision: Some(previous.as_ref().map_or(0, |record| record.revision)),
            title: fire.title.clone(),
            signal: maka_agent_facts::discovery::DossierSignal::Yellow,
            priority_weight: 0.0,
            summary_md: text,
            change_note: None,
            choices: vec![],
            window_at: None,
            fact_state: None,
            briefing: matches!(job.mode, Some(DiscoveryMode::Briefing)),
            evidence_md: None,
            artifacts: vec![],
            replace_artifacts: false,
            linked_task_ids: None,
        };
        self.settle_discovery_with(
            fire,
            revision,
            job,
            Outcome::Ok,
            "Report checked",
            Some((dossier, fire.title.clone(), at)),
        )
        .await
        .map(Some)
    }

    async fn settle_discovery(
        &self,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        revision: Option<u64>,
        job: &Job,
        outcome: Outcome,
        message: &str,
    ) -> Result<Completed, String> {
        self.settle_discovery_with(fire, revision, job, outcome, message, None)
            .await
    }
    async fn settle_discovery_with(
        &self,
        fire: &Fire<ScheduledEffect, scheduler::Approval>,
        revision: Option<u64>,
        job: &Job,
        outcome: Outcome,
        message: &str,
        dossier: Option<(
            maka_agent_state::discovery::DossierUpsert,
            String,
            UnixMillis,
        )>,
    ) -> Result<Completed, String> {
        let run = Run {
            id: fire.id.clone(),
            at: (now() as i64).max(fire.scheduled_at),
            outcome,
            message: message.into(),
            session_id: Some(job.worker.clone()),
            run_id: job.execution.as_ref().map(|e| e.run_id),
        };
        let mut writes = self.scheduler.outcome_mutations(job, &run.outcome).await?;
        let report_generation = if dossier.is_some() && run.outcome == Outcome::Ok {
            fire.authorization
                .as_ref()
                .and_then(scheduler::Approval::discovery_generation)
        } else {
            None
        };
        let receipt = Completed {
            run,
            report_generation,
            incomplete: match job.phase {
                Phase::Converged { reason } => Some(reason),
                _ => None,
            },
        };
        writes.extend([
            mutation(completed_key(&fire.id), None, &receipt)?,
            Mutation {
                key: ACTIVE.into(),
                expected_revision: revision,
                data: Data::Deleted,
            },
        ]);
        let charge = self.discovery.charge_statement(
            job.task_id.clone(),
            job.allowance,
            UnixMillis(receipt.run.at),
            job.model_charge,
        );
        if let Some((input, reason, at)) = dossier {
            let state = self.discovery.plan_upsert_statement(
                Some(job.task_id.clone()),
                input,
                Some(reason),
                at,
            );
            self.commit_discovery_writes(dossiers::WithStorage(state, charge), writes)
                .await
                .map_err(self::reason)?;
        } else {
            self.commit_discovery_writes(charge, writes)
                .await
                .map_err(reason)?;
        }
        *self.scheduler.investigation.write().unwrap() = None;
        self.scheduler.wake.notify_one();
        Ok(receipt)
    }
}

pub(super) fn check_target(
    session: &SessionRecord<ResolvedConfiguration>,
    target: &ScheduledTarget,
) -> Result<(), String> {
    if session.archived
        || session.configuration.workspace != target.workspace
        || session.configuration.permissions != target.permissions
        || session.configuration.boundary_revision != target.boundary_revision
        || session.configuration.binding != target.binding
    {
        Err("scheduler_authorization_changed".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(super) async fn test_store() -> (
    tempfile::TempDir,
    Arc<RootStore>,
    maka_agent_facts::durable::RunOwner,
) {
    use maka_agent_facts::durable::RunOwner;
    use maka_event_log::root::{RootNamespaces, RootOwner};
    let dir = tempfile::tempdir().unwrap();
    let state = RootOwner::create(
        &dir.path().join("state"),
        &RootNamespaces {
            ownership: dir.path().join("own"),
            control: dir.path().join("ctl"),
        },
    )
    .unwrap();
    let migrations = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect::<Vec<_>>();
    let root = Arc::new(RootStore::open(Arc::new(state), &migrations).await.unwrap());
    let owner = RunOwner {
        deployment: Uuid::new_v4(),
        namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
    };
    (dir, root, owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_weighted_usage_and_model_charge_account_for_cache_and_inexact_fallbacks() {
        let cached = ModelUsage {
            input_tokens: Some(200_000),
            cache_read_tokens: Some(180_000),
            cache_write_tokens: Some(15_000),
            output_tokens: Some(3_000),
            reasoning_tokens: Some(2_000),
        };
        let no_split = ModelUsage {
            cache_read_tokens: None,
            ..cached.clone()
        };
        let incomplete = ModelUsage {
            output_tokens: None,
            ..cached.clone()
        };
        assert_eq!(weighted_usage(&cached), Some(50_000));
        assert_eq!(weighted_usage(&no_split), Some(212_000));
        assert_eq!(
            weighted_usage(&ModelUsage {
                cache_read_tokens: Some(u64::MAX),
                ..cached.clone()
            }),
            Some(32_000)
        );
        assert_eq!(weighted_usage(&incomplete), None);
        assert_eq!(
            weighted_usage(&ModelUsage {
                input_tokens: None,
                ..cached.clone()
            }),
            None
        );
        let charge =
            |raw, usages: &[Option<&ModelUsage>]| match model_charge(raw, usages.iter().copied()) {
                Some(ModelCharge::Admitted(tokens)) => Some(tokens),
                None => None,
                _ => panic!("expected observed worker"),
            };
        assert_eq!(charge(203_000, &[Some(&cached)]), Some(50_000));
        assert_eq!(
            charge(406_000, &[Some(&cached), Some(&no_split)]),
            Some(262_000)
        );
        assert_eq!(charge(1_500_000, &[]), None);
        assert_eq!(charge(0, &[None]), Some(50_000));
        assert_eq!(charge(75_000, &[Some(&incomplete)]), Some(75_000));
        assert_eq!(charge(1_500_000, &[None, Some(&cached)]), Some(200_000));
        assert_eq!(charge(1_500_000, &[None, Some(&no_split)]), Some(212_000));
        assert!(matches!(model_charge(0, std::iter::empty()), None));
    }
}
