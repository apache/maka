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
mod tools;
use super::*;
use maka_capabilities::storage::{Data, Mutation, Namespace, Store};
use maka_goal::goal::{Arm, Meter, Repository, Saved, Status};
use maka_plugin_core::operation::RecoveryRef;
use std::sync::{
    OnceLock, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

pub(super) struct Goals {
    storage: Arc<maka_host_runtime::storage::Storage>,
    repository: Repository<MessageBasis>,
    gate: Mutex<()>,
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
            repository: Repository::new(storage.clone()),
            storage,
            gate: Mutex::new(()),
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
    async fn save(&self, saved: Saved<MessageBasis>) -> Result<(), String> {
        self.repository.save(saved).await.map_err(reason)?;
        self.written();
        Ok(())
    }
    async fn receipt(&self, operation: &RecoveryRef) -> Result<Option<GoalResult>, String> {
        self.storage
            .read(receipt_key(operation))
            .await
            .map_err(reason)?
            .map(|record| {
                let receipt: Receipt = serde_json::from_value(
                    record.data.value().cloned().ok_or("goal_receipt_invalid")?,
                )
                .map_err(reason)?;
                if receipt.reference != *operation {
                    return Err("goal_receipt_conflict".into());
                }
                Ok(receipt.result)
            })
            .transpose()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    reference: RecoveryRef,
    result: GoalResult,
}
fn receipt_key(reference: &RecoveryRef) -> String {
    format!(
        "receipt/{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(reference).expect("operation reference")
        ))
    )
}
fn receipt_mutation(reference: &RecoveryRef, result: &GoalResult) -> Result<Mutation, String> {
    Ok(Mutation {
        key: receipt_key(reference),
        expected_revision: None,
        data: Data::Present(
            serde_json::to_value(Receipt {
                reference: reference.clone(),
                result: result.clone(),
            })
            .map_err(reason)?,
        ),
    })
}
fn detail(saved: Saved<MessageBasis>) -> GoalDetail {
    let goal = saved.goal;
    GoalDetail {
        id: goal.id,
        revision: saved.revision,
        objective: goal.arm.objective,
        status: goal.status,
        iterations: goal.iterations,
        max_iterations: goal.arm.max_iterations,
        token_budget: goal.arm.token_budget,
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
        Ok(GoalView {
            enabled: self.settings.goals,
            current: self
                .goals
                .repository
                .read(&input.session_id)
                .await
                .map_err(reason)?
                .map(detail),
        })
    }
    pub async fn goal_receipt(&self, input: GoalReceiptRead) -> Result<Option<GoalResult>, String> {
        let reference = input.reference;
        if reference.source.state_domain != self.data_source.state_domain
            || reference.source.deployment != self.data_source.deployment
            || reference.namespace != self.data_source.namespace
            || reference.export != crate::EXPORT
            || reference.method != "changeGoal"
        {
            return Err("goal_receipt_owner_invalid".into());
        }
        self.goals.receipt(&reference).await
    }
    async fn goal_privacy(&self) -> Result<(), String> {
        if self
            .configuration
            .runtime_policy()
            .await
            .map_err(reason)?
            .policy
            .privacy
            .incognito_active
        {
            return Err("goal_incognito".into());
        }
        Ok(())
    }
    pub(in crate::owner) async fn check_goal_background(
        &self,
        session: &str,
        id: Uuid,
    ) -> Result<(), String> {
        self.goal_privacy().await?;
        let saved = self
            .goals
            .repository
            .read(session)
            .await
            .map_err(reason)?
            .ok_or("goal_missing")?;
        if saved.goal.id != id || saved.goal.status.terminal() || saved.goal.authority_blocked {
            return Err("goal_continuation_stopped".into());
        }
        Ok(())
    }
    async fn goal_meter(&self, session: &str) -> Result<Meter, String> {
        let model = self.store.session_usage_totals(session).await.map_err(reason)?;
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
    ) -> Result<MessageBasis, String> {
        self.goal_privacy().await?;
        if approval.target.session_id != session {
            return Err("goal_approval_session_changed".into());
        }
        let basis = self
            .approve_background(
                &approval.target,
                approval.model,
                approval.thinking_level,
                BackgroundKind::Goal(id),
            )
            .await?;
        if basis
            .allowed_tools
            .as_ref()
            .is_some_and(|names| !names.iter().any(|name| name == "GoalStatus"))
        {
            return Err("goal_status_tool_unavailable".into());
        }
        Ok(basis)
    }
    async fn goal_session_idle(&self, session: &str) -> Result<bool, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Err("agent_closed".into());
        }
        if runs.controls.contains_key(session) {
            return Ok(false);
        }
        if !self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .message_queue(session)
            .await
            .map_err(reason)?
            .entries
            .is_empty()
        {
            return Ok(false);
        }
        Ok(self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .latest_turn_boundary(session)
            .await
            .map_err(reason)?
            .is_none_or(|boundary| boundary.state.terminal_outcome().is_some()))
    }
    pub async fn goal_change(
        self: &Arc<Self>,
        input: GoalChange,
        operation: RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<GoalResult, String> {
        if scope.identity.agent().is_some() {
            return Err("goal_user_approval_required".into());
        }
        let session = match &input {
            GoalChange::Create { session_id, .. } | GoalChange::Control { session_id, .. } => {
                session_id
            }
        };
        self.session(session).await?;
        let runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let owner = self.clone();
        let job = self.workers.spawn(async move {
            let _gate = owner.goals.gate.lock().await;
            if let Some(result) = owner.goals.receipt(&operation).await? {
                return Ok(result);
            }
            owner.change_goal(input, &operation).await
        });
        drop(runs);
        job.await
            .map_err(|_| "goal_operation_unknown".to_string())?
    }
    async fn reject_goal(
        &self,
        operation: &RecoveryRef,
        reason: impl ToString,
    ) -> Result<GoalResult, String> {
        let result = GoalResult::Rejected {
            reason: reason.to_string(),
        };
        self.goals
            .storage
            .batch(vec![receipt_mutation(operation, &result)?])
            .await
            .map_err(self::reason)?;
        Ok(result)
    }
    // Storage uncertainty is propagated, never persisted as a second rejection.
    async fn change_goal(
        self: &Arc<Self>,
        input: GoalChange,
        operation: &RecoveryRef,
    ) -> Result<GoalResult, String> {
        if !self.settings.goals {
            return self.reject_goal(operation, "goal_disabled").await;
        }
        let session = match &input {
            GoalChange::Create { session_id, .. } | GoalChange::Control { session_id, .. } => {
                session_id.clone()
            }
        };
        let old = self.goals.repository.read(&session).await.map_err(reason)?;
        let revision = old.as_ref().map_or(1, |saved| saved.revision + 1);
        match input {
            GoalChange::Create {
                objective,
                max_iterations,
                token_budget,
                start,
                approval,
                ..
            } => {
                if !self.goal_session_idle(&session).await? {
                    return self.reject_goal(operation, "goal_session_busy").await;
                }
                let hash = Sha256::digest(serde_json::to_vec(operation).map_err(reason)?);
                let id = Uuid::from_bytes(hash[..16].try_into().expect("SHA-256 prefix"));
                let grant = match self.goal_approval(&session, id, approval).await {
                    Ok(grant) => grant,
                    Err(error) => return self.reject_goal(operation, error).await,
                };
                let arm = Arm {
                    language: grant.language,
                    operation_id: id,
                    objective,
                    grant,
                    max_iterations,
                    token_budget,
                    start,
                };
                if let Err(error) = arm.validate() {
                    return self.reject_goal(operation, error).await;
                }
                if old.as_ref().is_some_and(|saved| {
                    !saved.goal.status.terminal() || saved.goal.pending.is_some()
                }) {
                    return self.reject_goal(operation, "goal_current_unfinished").await;
                }
                let baseline = self.goal_meter(&session).await?;
                let result = GoalResult::Committed {
                    goal_id: id,
                    revision,
                };
                self.goals
                    .repository
                    .arm_with(
                        &session,
                        arm,
                        baseline,
                        vec![receipt_mutation(operation, &result)?],
                    )
                    .await
                    .map_err(reason)?;
                self.goals.written();
                Ok(result)
            }
            GoalChange::Control {
                goal_id,
                revision: expected,
                action,
                approval,
                ..
            } => {
                let Some(mut saved) =
                    old.filter(|saved| saved.goal.id == goal_id && saved.revision == expected)
                else {
                    let actual = self
                        .goals
                        .repository
                        .read(&session)
                        .await
                        .map_err(reason)?
                        .map(|saved| saved.revision);
                    let result = GoalResult::Conflict { actual };
                    self.goals
                        .storage
                        .batch(vec![receipt_mutation(operation, &result)?])
                        .await
                        .map_err(reason)?;
                    return Ok(result);
                };
                if let Some(approval) = approval {
                    if action != GoalControl::Resume || saved.goal.pending.is_some() {
                        return self.reject_goal(operation, "goal_approval_invalid").await;
                    }
                    saved.goal.arm.grant =
                        match self.goal_approval(&session, goal_id, approval).await {
                            Ok(grant) => grant,
                            Err(error) => return self.reject_goal(operation, error).await,
                        };
                    saved.goal.arm.language = saved.goal.arm.grant.language;
                }
                if action == GoalControl::Resume {
                    if let Err(error) = self.goal_privacy().await {
                        return self.reject_goal(operation, error).await;
                    }
                    if self.store.session(&session).await.map_err(|error| error.to_string())?.latest_turn_boundary(&session).await.map_err(reason)?.is_some_and(|boundary| matches!(boundary.state,
                        maka_event_log::turns::InvocationState::Ended { outcome: maka_agent_facts::event::InvocationOutcome::HandoffPaused { .. }, .. })) {
                        return self.reject_goal(operation, "goal_resume_session_first").await;
                    }
                    saved.goal.authority_blocked = false;
                }
                if let Err(error) = saved.goal.control(action) {
                    return self.reject_goal(operation, error).await;
                }
                let result = GoalResult::Committed { goal_id, revision };
                self.goals
                    .repository
                    .save_with(saved, vec![receipt_mutation(operation, &result)?])
                    .await
                    .map_err(reason)?;
                self.goals.written();
                Ok(result)
            }
        }
    }
}
fn reason(error: impl std::fmt::Display) -> String {
    error.to_string()
}
