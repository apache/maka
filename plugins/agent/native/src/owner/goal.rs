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

//! Goal owns its objective and outbox; the original Agent queue owns every execution.
mod dispatch;
mod stop;
pub(super) mod tools;
use super::*;
use maka_event_log::{
    StoreError,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use maka_goal::goal::{Arm, Meter, Pending, Repository, Saved, Status};
use maka_plugin_core::operation::RecoveryRef;
use maka_plugin_core::storage::{Mutation, Namespace};
use std::sync::{
    OnceLock, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

pub(super) struct Goals {
    pub(super) admissions: Arc<runs::Registry>,
    pub(super) storage: Arc<maka_host_runtime::storage::Storage>,
    pub(super) repository: Repository<super::notifications::BackgroundApproval>,
    pub(super) gate: Arc<Mutex<()>>,
    wake: Notify,
    changed: tokio::sync::watch::Sender<()>,
    owner: OnceLock<Weak<Owner>>,
    // Retirement hint only. Refreshed from the canonical repository under the
    // producer gate; uncertainty keeps the Host available for reconciliation.
    awake: AtomicBool,
}
impl Goals {
    pub fn new(store: Arc<RootStore>, prefix: String) -> Self {
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(
            store,
            prefix,
            Namespace::new("maka.agent.goal", maka_plugin_core::scope::Scope::Profile)
                .expect("goal namespace"),
        ));
        Self {
            admissions: Arc::new(runs::Registry::default()),
            repository: Repository::new(storage.clone()),
            storage,
            gate: Arc::new(Mutex::new(())),
            wake: Notify::new(),
            changed: tokio::sync::watch::channel(()).0,
            owner: OnceLock::new(),
            awake: AtomicBool::new(true),
        }
    }
    pub fn bind(&self, owner: &Arc<Owner>) {
        self.owner
            .set(Arc::downgrade(owner))
            .expect("goal bound once");
    }
    pub fn keeps_host_awake(&self) -> bool {
        self.awake.load(Ordering::Acquire)
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.storage.finish().await
    }
    pub fn execution_changed(&self) {
        self.wake.notify_one();
    }
    fn written(&self) {
        self.awake.store(true, Ordering::Release);
        self.changed.send_modify(|_| {});
        self.wake.notify_one();
    }
    pub(super) async fn save(
        &self,
        saved: Saved<super::notifications::BackgroundApproval>,
    ) -> Result<(), String> {
        self.repository.save(saved).await.map_err(reason)?;
        self.written();
        Ok(())
    }
}
fn detail(saved: Saved<super::notifications::BackgroundApproval>) -> GoalDetail {
    let goal = saved.goal;
    GoalDetail {
        id: goal.id,
        revision: saved.revision,
        objective: goal.arm.objective,
        status: goal.status,
        iterations: goal.iterations,
        token_budget: goal.arm.token_budget,
        remaining_tokens: goal
            .arm
            .token_budget
            .filter(|_| goal.consumed.missing == 0)
            .map(|budget| budget.saturating_sub(goal.consumed.known)),
        elapsed_seconds: (goal.elapsed_ms
            + goal
                .active_since
                .map_or(0, |start| maka_goal::goal::now_ms().saturating_sub(start)))
            / 1000,
        created_at: goal.created_at,
        retry_at: goal.retry_at,
        consumed: goal.consumed,
        pending: goal.pending.is_some(),
        report: goal.report,
        note: goal.note,
    }
}
impl Owner {
    pub fn goal_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.goals.changed.subscribe()
    }
    pub async fn goal(&self, input: GoalRead) -> Result<GoalView, String> {
        self.session(&input.session_id).await?;
        let mut current = self
            .goals
            .repository
            .read(&input.session_id)
            .await
            .map_err(reason)?;
        if let Some(saved) = current.as_mut()
            && (!saved.goal.status.terminal() || saved.goal.pending.is_some())
            && let Ok(total) = self.goal_meter(&input.session_id).await
        {
            saved.goal.consumed = saved.goal.observed_usage(total);
        }
        Ok(GoalView {
            enabled: self.settings.goals,
            current: current.map(detail),
        })
    }
    pub(in crate::owner) async fn check_goal_background(
        &self,
        session: &str,
        id: Uuid,
    ) -> Result<(), String> {
        let saved = self
            .goals
            .repository
            .read(session)
            .await
            .map_err(reason)?
            .ok_or("goal_missing")?;
        if saved.goal.id != id
            || saved.goal.status != Status::Active
            || saved.goal.authority_blocked
        {
            return Err("goal_continuation_stopped".into());
        }
        Ok(())
    }
    pub(super) async fn goal_meter(&self, session: &str) -> Result<Meter, String> {
        let model = self
            .durable
            .usage()
            .session_totals(
                maka_agent_facts::durable::RunOwner {
                    deployment: self.data_source.deployment,
                    namespace: self.data_source.namespace.clone(),
                },
                session,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(Meter {
            known: model.input.known.saturating_add(model.output.known),
            missing: model.input.missing.saturating_add(model.output.missing),
        })
    }
    async fn goal_approval(
        &self,
        session: &str,
        id: Uuid,
        approval: GoalApproval,
    ) -> Result<super::notifications::BackgroundApproval, String> {
        if approval.target.session_id != session {
            return Err("goal_approval_session_changed".into());
        }
        let basis = self
            .approve_background(
                &approval.target,
                approval.model.clone(),
                approval.thinking_level,
                BackgroundKind::Goal(id),
            )
            .await?;
        self.check_goal_tools(&basis)?;
        Ok(super::notifications::BackgroundApproval {
            target: approval.target,
            model: approval.model,
            accepted_model: basis.model.clone().ok_or("goal_model_unavailable")?,
            thinking_level: approval.thinking_level,
            language: basis.language,
        })
    }
    pub(super) fn check_goal_tools(&self, basis: &CapturedRun) -> Result<(), String> {
        if basis
            .allowed_tools
            .as_ref()
            .is_some_and(|names| !names.iter().any(|name| name == "GoalStatus"))
        {
            return Err("goal_status_tool_unavailable".into());
        }
        Ok(())
    }
    async fn goal_session_idle(&self, session: &str) -> Result<bool, String> {
        let runs = self.runs.state().await;
        if runs.closing {
            return Err("agent_closed".into());
        }
        if runs.busy(session) {
            return Ok(false);
        }
        drop(runs);
        Ok(self
            .durable
            .session_quiescence(self.run_owner(), session.to_owned())
            .await
            .map_err(reason)?
            .is_quiescent())
    }

    pub async fn goal_change(
        self: &Arc<Self>,
        input: GoalChange,
        operation: RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<GoalResult>, String> {
        if scope.identity.agent().is_some() {
            return Err("goal_user_approval_required".into());
        }
        let owner = self.clone();
        let job = self.workers.spawn(async move {
            let session = match &input {
                GoalChange::Create { session_id, .. } | GoalChange::Control { session_id, .. } => {
                    session_id.clone()
                }
            };
            let current = owner.mutable_session(&session).await?;
            {
                let runs = owner.runs.state().await;
                if runs.closing || owner.stop.is_cancelled() {
                    return Err("agent_closed".into());
                }
            }
            let writer = owner.store.data_writer().map_err(reason)?;
            let metadata = owner
                .store
                .session(&session)
                .await
                .map_err(reason)?
                .revision_guard(&writer, current.revision)
                .map_err(reason)?;
            let approval = match &input {
                GoalChange::Create { approval, .. } if owner.settings.goals => {
                    let hash = Sha256::digest(serde_json::to_vec(&operation).map_err(reason)?);
                    let id = Uuid::from_bytes(hash[..16].try_into().expect("SHA-256 prefix"));
                    owner
                        .goal_approval(&session, id, approval.clone())
                        .await
                        .map(Some)
                }
                GoalChange::Control {
                    goal_id,
                    action,
                    approval: Some(approval),
                    ..
                } if owner.settings.goals && *action == GoalControl::Resume => owner
                    .goal_approval(&session, *goal_id, approval.clone())
                    .await
                    .map(Some),
                _ => Ok(None),
            };
            let gate = Arc::new(owner.goals.gate.clone().lock_owned().await);
            let admission = Arc::new(owner.goals.admissions.ordered(&session).await);
            let schedule = owner
                .goals
                .repository
                .schedule_snapshot()
                .await
                .map_err(reason)?;
            let change = writer
                .prepare_result(|writer| {
                    Ok(GoalMutation {
                        goals: owner.goals.clone(),
                        gate,
                        admission,
                        writer,
                        metadata,
                        input,
                        session,
                        operation,
                        approval,
                        enabled: owner.settings.goals,
                        schedule,
                        usage: owner.durable.usage(),
                        owner: owner.run_owner(),
                    })
                })
                .map_err(reason)?;
            Ok(NativeMutation::Computed { change })
        });
        job.await
            .map_err(|_| "goal_operation_unknown".to_string())?
    }
}

struct GoalMutation {
    goals: Arc<Goals>,
    gate: Arc<tokio::sync::OwnedMutexGuard<()>>,
    admission: Arc<runs::Ordered>,
    writer: DataWriter,
    metadata: maka_event_log::root_store::SessionRevisionGuard,
    input: GoalChange,
    session: String,
    operation: RecoveryRef,
    approval: Result<Option<super::notifications::BackgroundApproval>, String>,
    enabled: bool,
    schedule: (Option<u64>, maka_goal::goal::ScheduleIndex),
    usage: maka_agent_state::usage::UsageStore,
    owner: maka_agent_facts::durable::RunOwner,
}
impl GoalMutation {
    fn schedule(
        &self,
        connection: &rusqlite::Connection,
    ) -> Result<(Option<u64>, maka_goal::goal::ScheduleIndex), StoreError> {
        let record =
            self.goals
                .storage
                .read_in_transaction(connection, "schedule", &self.writer)?;
        let revision = record.as_ref().map(|record| record.revision);
        if let Some(value) = record.as_ref().and_then(|record| record.data.value()) {
            return Ok((revision, serde_json::from_value(value.clone())?));
        }
        // Every Goal write also writes this index. A missing-index rebuild is
        // usable only while its original revision is still current.
        if revision != self.schedule.0 {
            return Err(StoreError::InvalidTransition(
                "goal_schedule_changed".into(),
            ));
        }
        Ok((revision, self.schedule.1.clone()))
    }
    fn apply(
        &self,
        connection: &rusqlite::Connection,
        old: Option<Saved<super::notifications::BackgroundApproval>>,
    ) -> Result<(GoalResult, Vec<Mutation>), StoreError> {
        let rejected = |reason: String| (GoalResult::Rejected { reason }, vec![]);
        if !self.enabled {
            return Ok(rejected("goal_disabled".into()));
        }
        match self.metadata.validate(connection) {
            Ok(()) => {}
            Err(
                StoreError::SessionRevisionConflict { .. }
                | StoreError::SessionNotFound
                | StoreError::SessionRetired,
            ) => return Ok(rejected("goal_authorization_changed".into())),
            Err(error) => return Err(error),
        }
        let revision = old.as_ref().map_or(1, |saved| saved.revision + 1);
        match &self.input {
            GoalChange::Create {
                objective,
                token_budget,
                start,
                ..
            } => {
                let grant = match &self.approval {
                    Ok(Some(grant)) => grant.clone(),
                    Err(error) => return Ok(rejected(error.clone())),
                    Ok(None) => {
                        return Err(StoreError::InvalidTransition(
                            "goal_approval_missing".into(),
                        ));
                    }
                };
                let hash = Sha256::digest(serde_json::to_vec(&self.operation)?);
                let id = Uuid::from_bytes(hash[..16].try_into().expect("SHA-256 prefix"));
                let arm = Arm {
                    language: grant.language,
                    operation_id: id,
                    objective: objective.clone(),
                    grant,
                    token_budget: *token_budget,
                    start: *start,
                };
                if let Err(error) = arm.validate() {
                    return Ok(rejected(reason(error)));
                }
                if old.as_ref().is_some_and(|saved| {
                    !saved.goal.status.terminal() || saved.goal.pending.is_some()
                }) {
                    return Ok(rejected("goal_current_unfinished".into()));
                }
                let usage = self.usage.session_totals_in_transaction(
                    connection,
                    self.owner.clone(),
                    &self.session,
                )?;
                let baseline = Meter {
                    known: usage.input.known.saturating_add(usage.output.known),
                    missing: usage.input.missing.saturating_add(usage.output.missing),
                };
                let (index_revision, index) = self.schedule(connection)?;
                let (_, mutations) = Repository::prepare_arm(
                    &self.session,
                    arm,
                    baseline,
                    None,
                    old,
                    index_revision,
                    index,
                )
                .map_err(|error| StoreError::InvalidTransition(reason(error)))?;
                Ok((
                    GoalResult::Committed {
                        goal_id: id,
                        revision,
                    },
                    mutations,
                ))
            }
            GoalChange::Control {
                goal_id,
                revision: expected,
                action,
                budget,
                approval,
                ..
            } => {
                let actual = old.as_ref().map(|saved| saved.revision);
                let Some(mut saved) =
                    old.filter(|saved| saved.goal.id == *goal_id && saved.revision == *expected)
                else {
                    return Ok((GoalResult::Conflict { actual }, vec![]));
                };
                if approval.is_some() {
                    if *action != GoalControl::Resume || saved.goal.pending.is_some() {
                        return Ok(rejected("goal_approval_invalid".into()));
                    }
                    let grant = match &self.approval {
                        Ok(Some(grant)) => grant.clone(),
                        Err(error) => return Ok(rejected(error.clone())),
                        Ok(None) => {
                            return Err(StoreError::InvalidTransition(
                                "goal_approval_missing".into(),
                            ));
                        }
                    };
                    if saved.goal.arm.grant.model != grant.model
                        || !saved
                            .goal
                            .arm
                            .grant
                            .accepted_model
                            .same_execution_route(&grant.accepted_model)
                    {
                        saved.goal.retry_at = None;
                    }
                    saved.goal.arm.grant = grant;
                    saved.goal.arm.language = saved.goal.arm.grant.language;
                }
                if let Some(budget) = budget {
                    if budget.token_budget == Some(0) {
                        return Ok(rejected("goal_budget_invalid".into()));
                    }
                    saved.goal.arm.token_budget = budget.token_budget;
                }
                if *action == GoalControl::Resume {
                    saved.goal.authority_blocked = false;
                }
                if let Err(error) = saved.goal.control(*action) {
                    return Ok(rejected(reason(error)));
                }
                let (index_revision, index) = self.schedule(connection)?;
                let mutations = Repository::prepare_save(saved, index_revision, index)
                    .map_err(|error| StoreError::InvalidTransition(reason(error)))?;
                Ok((
                    GoalResult::Committed {
                        goal_id: *goal_id,
                        revision,
                    },
                    mutations,
                ))
            }
        }
    }
}
#[derive(Serialize)]
#[serde(transparent)]
struct GoalCompletion {
    result: GoalResult,
    #[serde(skip)]
    goals: Arc<Goals>,
}
impl Statement for GoalMutation {
    type Value = GoalCompletion;
    type Output = GoalResult;
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        vec![self.admission.clone(), self.gate.clone()]
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<GoalCompletion>, StoreError> {
        let old =
            self.goals
                .storage
                .read_in_transaction(
                    connection,
                    &maka_goal::goal::record_key(&self.session),
                    &self.writer,
                )?
                .map(|record| {
                    let goal =
                        serde_json::from_value(record.data.value().cloned().ok_or_else(|| {
                            StoreError::InvalidTransition("goal_removed".into())
                        })?)?;
                    Ok::<_, StoreError>(Saved {
                        revision: record.revision,
                        goal,
                    })
                })
                .transpose()?;
        let (result, mutations) = self.apply(connection, old)?;
        let (changed, notification) = if mutations.is_empty() {
            (false, Notification::NONE)
        } else {
            let prepared = self
                .goals
                .storage
                .prepare_statement(mutations, &self.writer)?
                .execute(connection)?;
            (prepared.changed, prepared.notification)
        };
        Ok(Prepared {
            value: GoalCompletion {
                result,
                goals: self.goals,
            },
            changed,
            notification,
        })
    }
    fn committed(value: GoalCompletion) -> GoalResult {
        if matches!(&value.result, GoalResult::Committed { .. }) {
            value.goals.written();
        }
        value.result
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error.underlying(),
            StoreError::StatementRejected { .. }
                | StoreError::RevisionConflict { .. }
                | StoreError::InvalidTransition(_)
                | StoreError::SessionNotFound
                | StoreError::EventConflict
        )
    }
}
fn reason(error: impl std::fmt::Display) -> String {
    error.to_string()
}
