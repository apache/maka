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

use super::{BackgroundKind, CapturedRun, Owner, notifications::BackgroundApproval};
use maka_agent_facts::durable::{
    BackendSpec, Budget, RunId, RunOwner, RunSpec, Trigger, UnixMillis,
};
use maka_agent_state::{AdmissionGuard, ContentBlob};
use maka_event_log::StoreError;
use maka_goal::goal::{Meter, Pending, Status};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(super) struct CaptureBudget {
    pub budget: Budget,
    pub basis: Option<ContentBlob>,
    pub _guard: Option<Arc<dyn AdmissionGuard>>,
}

/// Observed domain policy for the admission transaction, never execution authority.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum BudgetBasis {
    Interactive,
    Goal {
        goal_id: Uuid,
        message_id: String,
        revision: u64,
        approved_tokens: Option<u64>,
        baseline: Meter,
        meter: Meter,
        approval: BackgroundApproval,
    },
    Schedule(ScheduleBudget),
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScheduleBudget {
    pub task_id: String,
    pub message_id: String,
    pub revision: u64,
    pub fire_id: String,
    pub expires_at: Option<UnixMillis>,
    pub approval: BackgroundApproval,
}

pub(super) fn check_approval(
    basis: &CapturedRun,
    approval: &BackgroundApproval,
) -> Result<(), String> {
    let Some(model) = &basis.model else {
        return Err("background_approval_changed".into());
    };
    if basis.background.as_ref() != Some(&approval.target)
        || basis.executor.is_some()
        || model.binding.connection_id != approval.model.connection_id
        || model.binding.model != approval.model.model_id
        || model.thinking_level != approval.thinking_level
        || model != &approval.accepted_model
    {
        return Err("background_approval_changed".into());
    }
    Ok(())
}

impl Owner {
    /// Caller keeps the domain admission order. This read does not substitute
    /// for checking the returned revision and meter in the admission transaction.
    pub(super) async fn capture_budget(
        &self,
        session: &str,
        basis: &CapturedRun,
        trigger: &Trigger,
        message_id: &str,
    ) -> Result<CaptureBudget, String> {
        let mut budget = Budget {
            tokens: None,
            retries: 9,
            deadline: None,
        };
        let observed = match (&basis.background_kind, trigger) {
            (
                BackgroundKind::Interactive,
                Trigger::Continuation { .. } | Trigger::ContextCompact,
            ) if basis.background.is_none() => BudgetBasis::Interactive,
            (BackgroundKind::Interactive, Trigger::Message { message_id: source })
                if basis.background.is_none() && source == message_id =>
            {
                BudgetBasis::Interactive
            }
            (BackgroundKind::Goal(id), Trigger::Goal { goal_id })
                if id == goal_id && basis.background.is_some() =>
            {
                let saved = self
                    .goals
                    .repository
                    .read(session)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("goal_missing")?;
                let goal = &saved.goal;
                check_goal(goal, *id, session, message_id)?;
                check_approval(basis, &goal.arm.grant)?;
                let meter = self.goal_meter(session).await?;
                budget.tokens = goal_tokens(goal, &meter)?;
                BudgetBasis::Goal {
                    goal_id: *id,
                    message_id: message_id.into(),
                    revision: saved.revision,
                    approved_tokens: goal.arm.token_budget,
                    baseline: goal.baseline.clone(),
                    meter,
                    approval: goal.arm.grant.clone(),
                }
            }
            (BackgroundKind::Schedule { task_id }, Trigger::Schedule { schedule_id })
                if task_id == schedule_id && basis.background.is_some() =>
            {
                let current = self.scheduler.capture_budget(task_id, message_id).await?;
                check_approval(basis, &current.approval)?;
                budget.deadline = current.expires_at;
                BudgetBasis::Schedule(current)
            }
            _ => return Err("background_budget_source_changed".into()),
        };
        if matches!(observed, BudgetBasis::Interactive) {
            return Ok(CaptureBudget {
                budget,
                basis: None,
                _guard: None,
            });
        }
        let blob = ContentBlob::json(&observed).map_err(|error| error.to_string())?;
        let guard = self.bound_budget_guard(session, budget.clone(), observed, blob.clone())?;
        Ok(CaptureBudget {
            budget,
            basis: Some(blob),
            _guard: Some(guard),
        })
    }

    pub(super) fn restore_budget_guard(
        &self,
        spec: &RunSpec,
        bytes: Option<Vec<u8>>,
        message_id: &str,
    ) -> Result<Option<Arc<dyn AdmissionGuard>>, String> {
        match (&spec.budget_basis, bytes) {
            (None, None)
                if matches!(
                    spec.trigger,
                    Trigger::Message { .. }
                        | Trigger::Continuation { .. }
                        | Trigger::ContextCompact
                ) =>
            {
                Ok(None)
            }
            (Some(reference), Some(bytes)) => {
                let source: BudgetBasis =
                    serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
                let blob = ContentBlob::new(bytes);
                if blob.reference() != reference {
                    return Err("budget_basis_content_changed".into());
                }
                check_source(&source, spec, message_id)?;
                self.bound_budget_guard(&spec.session_id, spec.budget.clone(), source, blob)
                    .map(Some)
            }
            _ => Err("background_budget_basis_missing".into()),
        }
    }

    fn bound_budget_guard(
        &self,
        session: &str,
        budget: Budget,
        source: BudgetBasis,
        blob: ContentBlob,
    ) -> Result<Arc<dyn AdmissionGuard>, String> {
        let storage = match &source {
            BudgetBasis::Goal { .. } if self.settings.goals => self.goals.storage.clone(),
            BudgetBasis::Schedule(_) if self.settings.scheduled_tasks => {
                self.scheduler.budget_storage()
            }
            _ => return Err("background_budget_source_unavailable".into()),
        };
        let data = self
            .store
            .data_writer()
            .map_err(|error| error.to_string())?;
        self.durable
            .validate_root(&data)
            .map_err(|error| error.to_string())?;
        storage
            .validate_root(&data)
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(BudgetGuard {
            storage,
            data,
            usage: self.durable.usage(),
            owner: self.run_owner(),
            session: session.into(),
            issuer: self.stop.clone(),
            source,
            blob,
            budget,
        }))
    }
}

fn check_goal(
    goal: &maka_goal::goal::Goal<BackgroundApproval>,
    id: Uuid,
    session: &str,
    message_id: &str,
) -> Result<(), String> {
    if goal.id != id
        || goal.session_id != session
        || goal.status != Status::Active
        || goal.authority_blocked
    {
        return Err("goal_authorization_changed".into());
    }
    if !matches!(&goal.pending, Some(Pending::Dispatch { request }) if format!("m_{}", request.operation_id) == message_id)
    {
        return Err("goal_original_request_changed".into());
    }
    Ok(())
}
fn goal_tokens(
    goal: &maka_goal::goal::Goal<BackgroundApproval>,
    meter: &Meter,
) -> Result<Option<u64>, String> {
    let Some(ceiling) = goal.arm.token_budget else {
        return Ok(None);
    };
    if meter.missing != 0 {
        return Err("goal_budget_inexact".into());
    }
    let consumed = meter
        .known
        .checked_sub(goal.baseline.known)
        .ok_or("goal_meter_regressed")?
        .max(goal.consumed.known);
    ceiling
        .checked_sub(consumed)
        .filter(|remaining| *remaining != 0)
        .map(Some)
        .ok_or_else(|| "goal_budget_exhausted".into())
}
fn check_source(source: &BudgetBasis, spec: &RunSpec, message_id: &str) -> Result<(), String> {
    let approval = match (source, &spec.trigger) {
        (
            BudgetBasis::Goal {
                goal_id,
                message_id: original,
                approval,
                ..
            },
            Trigger::Goal { goal_id: id },
        ) if goal_id == id && original == message_id => approval,
        (BudgetBasis::Schedule(current), Trigger::Schedule { schedule_id })
            if &current.task_id == schedule_id && current.message_id == message_id =>
        {
            &current.approval
        }
        _ => return Err("background_budget_source_changed".into()),
    };
    if !matches!(&spec.backend, BackendSpec::Model { binding, .. } if binding.connection_id == approval.model.connection_id && binding.model == approval.model.model_id)
    {
        return Err("background_approval_changed".into());
    }
    Ok(())
}
fn invalid(cause: impl std::fmt::Display) -> StoreError {
    StoreError::InvalidTransition(cause.to_string())
}

struct BudgetGuard {
    storage: Arc<maka_host_runtime::storage::Storage>,
    data: maka_event_log::root_store::DataWriter,
    usage: maka_agent_state::usage::UsageStore,
    owner: RunOwner,
    session: String,
    issuer: CancellationToken,
    source: BudgetBasis,
    blob: ContentBlob,
    budget: Budget,
}
impl AdmissionGuard for BudgetGuard {
    fn validate(
        &self,
        connection: &rusqlite::Connection,
        _run: RunId,
        spec: &RunSpec,
    ) -> Result<(), StoreError> {
        if self.issuer.is_cancelled()
            || spec.owner != self.owner
            || spec.session_id != self.session
            || spec.budget != self.budget
            || spec.budget_basis.as_ref() != Some(self.blob.reference())
        {
            return Err(invalid("budget admission source or actual issuer changed"));
        }
        match &self.source {
            BudgetBasis::Goal {
                goal_id,
                message_id,
                revision,
                approved_tokens,
                baseline,
                meter,
                approval,
            } => {
                check_source(&self.source, spec, message_id).map_err(invalid)?;
                let record = self
                    .storage
                    .read_in_transaction(
                        connection,
                        &maka_goal::goal::record_key(&self.session),
                        &self.data,
                    )?
                    .ok_or_else(|| invalid("goal_missing"))?;
                if record.revision != *revision {
                    return Err(invalid("goal_revision_changed"));
                }
                let goal: maka_goal::goal::Goal<BackgroundApproval> = serde_json::from_value(
                    record
                        .data
                        .value()
                        .cloned()
                        .ok_or_else(|| invalid("goal_removed"))?,
                )?;
                check_goal(&goal, *goal_id, &self.session, message_id).map_err(invalid)?;
                if goal.arm.token_budget != *approved_tokens
                    || goal.baseline != *baseline
                    || serde_json::to_value(&goal.arm.grant)? != serde_json::to_value(approval)?
                {
                    return Err(invalid("goal_budget_source_changed"));
                }
                let usage = self.usage.session_totals_in_transaction(
                    connection,
                    self.owner.clone(),
                    &self.session,
                )?;
                let current = Meter {
                    known: usage
                        .input
                        .known
                        .checked_add(usage.output.known)
                        .ok_or_else(|| invalid("goal_usage_overflow"))?,
                    missing: usage
                        .input
                        .missing
                        .checked_add(usage.output.missing)
                        .ok_or_else(|| invalid("goal_missing_overflow"))?,
                };
                if current != *meter
                    || goal_tokens(&goal, &current).map_err(invalid)? != self.budget.tokens
                {
                    return Err(invalid("goal_meter_changed"));
                }
            }
            BudgetBasis::Schedule(source) => {
                check_source(&self.source, spec, &source.message_id).map_err(invalid)?;
                let current = super::scheduler::Scheduler::budget_in_transaction(
                    &self.storage,
                    connection,
                    &source.task_id,
                    &source.message_id,
                    &self.data,
                )?;
                if serde_json::to_value(&current)? != serde_json::to_value(source)?
                    || self.budget.deadline != source.expires_at
                    || self.budget.tokens.is_some()
                {
                    return Err(invalid("scheduler_budget_source_changed"));
                }
            }
            BudgetBasis::Interactive => {
                return Err(invalid(
                    "interactive source cannot acquire a background budget guard",
                ));
            }
        }
        Ok(())
    }
}
