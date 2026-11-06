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

//! Durable no-progress retry ownership; timers never grant request admission.
use crate::native_approvals::{ActivationCheckpointRecord, ParkResult, ParkedActivationReceipt};
use crate::{EventLog, StoreError};
use maka_agent_facts::{
    event::{EventWrite, Fact, ModelInterruption, RuntimeEvent},
    model_retry::RetryPlan,
    native_approval::{ActivationCheckpoint, ActivationSuspension},
};
use rusqlite::{Connection, OptionalExtension};

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
fn plan(checkpoint: &ActivationCheckpoint) -> Result<&RetryPlan, StoreError> {
    match &checkpoint.suspension {
        ActivationSuspension::ModelRetry { plan } => Ok(plan),
        ActivationSuspension::NativeApprovals => {
            Err(invalid("model retry requires a retry suspension"))
        }
    }
}

/// Admission proof shared by first park, restart, and request consumption.
pub(crate) fn frontier(
    tx: &Connection,
    checkpoint: &ActivationCheckpoint,
    admission: bool,
) -> Result<bool, StoreError> {
    let plan = plan(checkpoint)?;
    let invocation = &checkpoint.invocation;
    crate::recovery::require_local(tx, &invocation.invocation_id)?;
    let committed: i64 = tx.query_row(
        "SELECT coalesce(max(sequence),0) FROM event_log",
        rusqlite::params![],
        |row| row.get(0),
    )?;
    if checkpoint.through
        > u64::try_from(committed).map_err(|_| invalid("invalid activation frontier"))?
    {
        return Ok(false);
    }

    if !crate::turns::read(tx, &invocation.session_id, None)?.is_some_and(|turn| {
        turn.invocation == *invocation
            && !matches!(turn.state, crate::turns::InvocationState::Ended { .. })
    }) {
        return Ok(false);
    }
    let row: Option<(i64,String)> = tx.query_row("SELECT sequence,event_header FROM runtime_events WHERE event_id=? AND invocation_id=? AND kind='model_interrupted'", rusqlite::params![&plan.failure_event_id, &invocation.invocation_id], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
    let Some((sequence, json)) = row else {
        return Ok(false);
    };
    if crate::sequence_number(sequence)? > checkpoint.through {
        return Ok(false);
    }
    let failure: RuntimeEvent = serde_json::from_str(&json)?;
    let Fact::ModelInterrupted {
        step_id,
        status: ModelInterruption::RetryableFailure,
        model_failure: Some(cause),
        ..
    } = &failure.fact
    else {
        return Ok(false);
    };
    if failure.invocation != *invocation {
        return Ok(false);
    }
    // RetryableFailure is trusted ingress replay evidence. Only explicit provider
    // advice can transfer a long wait to durable ownership.
    let maka_agent_facts::model::error::ModelFailureCause::Provider {
        reason,
        retry_at_unix_ms: Some(provider_deadline),
    } = cause
    else {
        return Ok(false);
    };
    if matches!(
        reason,
        maka_agent_facts::model::error::ProviderFailureReason::QuotaExhausted
    ) || plan.not_before_unix_ms < *provider_deadline
    {
        return Ok(false);
    }
    let row: Option<(i64,String)> = tx.query_row("SELECT sequence,event_header FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind='model_requested'", rusqlite::params![&invocation.invocation_id, step_id], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
    let Some((requested, json)) = row else {
        return Ok(false);
    };
    let request: RuntimeEvent = serde_json::from_str(&json)?;
    let Fact::ModelRequested {
        item_acceptance,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        ..
    } = &request.fact
    else {
        return Ok(false);
    };
    if request.invocation != *invocation || requested >= sequence {
        return Ok(false);
    }
    let advanced: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM runtime_events e WHERE e.invocation_id=? AND e.sequence>? AND (e.kind IN ('executor_started','invocation_ended','tool_dispatched','tool_rejected','tool_notified','message_steered') OR (e.kind='model_requested' AND json_extract(e.event_header,'$.fact.purpose')='main') OR (e.kind='model_completed' AND EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id AND r.kind='model_requested' AND r.operation_id=e.operation_id AND json_extract(r.event_header,'$.fact.purpose')='main'))))", rusqlite::params![&invocation.invocation_id, requested], |row| row.get(0))?;
    let obligations: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM context_obligations WHERE invocation_id=? AND kind IN ('model','tool','call','completed_provider','interrupted_provider'))", rusqlite::params![&invocation.invocation_id], |row| row.get(0))?;
    let terminals: i64 = tx.query_row("SELECT count(*) FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind IN ('model_interrupted','model_completed')", rusqlite::params![&invocation.invocation_id, step_id], |row| row.get(0))?;
    if advanced || obligations || terminals != 1 {
        return Ok(false);
    }
    if *item_acceptance {
        let accepted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind='model_observed' AND json_extract(event_header,'$.fact.event.kind')='part')", rusqlite::params![&invocation.invocation_id, step_id], |row| row.get(0))?;
        if accepted {
            return Ok(false);
        }
    }
    let waiting_interaction: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM interaction_pending p JOIN interaction_requests r ON r.request_id=p.request_id WHERE p.session_id=?1 AND json_extract(r.record_json,'$.turnId')=?2 AND json_extract(r.record_json,'$.runId')=?3)", rusqlite::params![&invocation.session_id, &invocation.turn_id, &invocation.run_id], |row| row.get(0))?;
    if waiting_interaction {
        return Ok(false);
    }
    if admission {
        let blocked: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 UNION ALL SELECT 1 FROM session_control WHERE id=?1 AND archived=1)", rusqlite::params![&invocation.session_id], |row| row.get(0))?;
        if blocked
            || crate::message_interrupts::fenced(tx, &invocation.session_id, &invocation.run_id)?
            || !crate::native_approvals::permission_current(tx, invocation)?
        {
            return Ok(false);
        }
    }
    crate::context::frozen_request::read_in_transaction(tx, invocation, &plan.failure_event_id)?;
    Ok(true)
}

impl EventLog {
    /// Confirm the same retry request publication without reauthorizing execution.
    pub async fn confirm_model_retry_request(
        &self,
        write: &EventWrite,
    ) -> Result<Option<u64>, StoreError> {
        self.check_bound_session(&write.event().invocation.session_id)?;
        if !matches!(write.event().fact, Fact::ModelRequested { .. })
            || write.model_retry_consumption().is_none()
        {
            return Err(invalid(
                "retry request confirmation requires its exact consumption submission",
            ));
        }
        let write = write.clone();
        self.connection
            .read(move |db| {
                let tx = rusqlite::Transaction::new_unchecked(
                    db,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let stored: Option<(i64, String)> = tx
                    .query_row(
                        "SELECT sequence,event_header FROM runtime_events WHERE event_id=?",
                        rusqlite::params![&write.event().id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((sequence, json)) = stored else {
                    return Ok(None);
                };
                if json != serde_json::to_string(write.event())? {
                    return Err(StoreError::EventConflict);
                }
                crate::composition::verify_replay(&tx, &write)?;
                Ok(Some(crate::sequence_number(sequence)?))
            })
            .await
    }
    /// Settle only an exact untouched retry checkpoint fenced by current controls.
    pub async fn settle_controlled_model_retry(
        &self,
        receipt: &ParkedActivationReceipt,
    ) -> Result<bool, StoreError> {
        self.check_bound_session(&receipt.invocation().session_id)?;
        let receipt = receipt.clone();
        let commits = self.commits.session(&receipt.invocation().session_id);
        self.connection.run(move |db| {
            let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
            let row: Option<(String,bool)> = tx.query_row("SELECT checkpoint_json,revoked FROM native_approval_checkpoints WHERE id=? AND invocation_id=? AND session_id=? AND revision=? AND active=1 AND suspension_kind='model_retry'", rusqlite::params![receipt.checkpoint_id(), &receipt.invocation().invocation_id, &receipt.invocation().session_id, receipt.revision() as i64], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
            let Some((json, revoked)) = row else {
                return cancellation_confirmed(&tx, &receipt);
            };
            let checkpoint: ActivationCheckpoint = serde_json::from_str(&json)?;
            let invocation = &checkpoint.invocation;
            let blocked: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 UNION ALL SELECT 1 FROM session_control WHERE id=?1 AND archived=1)", rusqlite::params![&invocation.session_id], |row| row.get(0))?;
            let stop = crate::message_interrupts::fenced(&tx, &invocation.session_id, &invocation.run_id)?;
            let permission = crate::native_approvals::permission_current(&tx, invocation)?;
            if !revoked && !blocked && !stop && permission { return Ok(false); }
            let sequence = cancel_in_transaction(&tx, &checkpoint, if stop { "turn_stopped" } else { "activation_revoked" })?;
            tx.commit().map_err(StoreError::CommitUnknown)?;
            commits.publish(sequence);
            commits.activations();
            Ok(true)
        }).await
    }

    pub async fn park_model_retry(
        &self,
        checkpoint: ActivationCheckpoint,
    ) -> Result<ParkResult, StoreError> {
        self.check_bound_session(&checkpoint.invocation.session_id)?;
        crate::native_approvals::validate_checkpoint(&checkpoint)?;
        let retry = plan(&checkpoint)?;
        crate::sessions::validate_id(&retry.failure_event_id)?;
        let deadline = i64::try_from(retry.not_before_unix_ms)
            .map_err(|_| invalid("retry deadline exhausted"))?;
        let commits = self.commits.session(&checkpoint.invocation.session_id);
        self.connection.run(move |db| {
            let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
            if let Some(receipt) = crate::native_approvals::exact(&tx, &checkpoint, &[])? { return Ok(ParkResult::Parked(receipt)); }
            if !frontier(&tx, &checkpoint, true)? { return Ok(ParkResult::Changed); }
            let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints WHERE session_id=? AND active=1)", rusqlite::params![&checkpoint.invocation.session_id], |row| row.get(0))?;
            if active { return Ok(ParkResult::Changed); }
            crate::sessions::advance_revision(&tx, &checkpoint.invocation.session_id)?;
            let revision: i64 = tx.query_row("SELECT revision FROM session_control WHERE id=?", rusqlite::params![&checkpoint.invocation.session_id], |row| row.get(0))?;
            tx.execute("INSERT INTO native_approval_checkpoints(id,session_id,invocation_id,checkpoint_json,pending_json,revision,active,suspension_kind,not_before_unix_ms) VALUES(?,?,?,?,'[]',?,1,'model_retry',?)", rusqlite::params![&checkpoint.id, &checkpoint.invocation.session_id, &checkpoint.invocation.invocation_id, serde_json::to_string(&checkpoint)?, revision, deadline])?;
            tx.commit().map_err(StoreError::CommitUnknown)?;
            commits.metadata();
            commits.activations();
            Ok(ParkResult::Parked(crate::native_approvals::receipt(&checkpoint, revision)?))
        }).await
    }
    pub async fn confirm_model_retry_park(
        &self,
        checkpoint: &ActivationCheckpoint,
    ) -> Result<Option<ParkedActivationReceipt>, StoreError> {
        plan(checkpoint)?;
        self.confirm_native_approval_park(checkpoint, &[]).await
    }
    pub async fn native_approval_checkpoint(
        &self,
        session: &str,
    ) -> Result<Option<ActivationCheckpointRecord>, StoreError> {
        Ok(self.activation_checkpoint(session).await?.filter(|record| {
            matches!(
                record.checkpoint.suspension,
                ActivationSuspension::NativeApprovals
            )
        }))
    }
    pub async fn model_retry_checkpoint(
        &self,
        session: &str,
    ) -> Result<Option<ActivationCheckpointRecord>, StoreError> {
        Ok(self.activation_checkpoint(session).await?.filter(|record| {
            matches!(
                record.checkpoint.suspension,
                ActivationSuspension::ModelRetry { .. }
            )
        }))
    }
    pub async fn due_model_retry_sessions(
        &self,
        now_unix_ms: u64,
    ) -> Result<Vec<String>, StoreError> {
        Ok(self
            .due_model_retry_candidates(now_unix_ms)
            .await?
            .into_iter()
            .map(|(_, _, session)| session)
            .collect())
    }
    pub(crate) async fn due_model_retry_candidates(
        &self,
        now_unix_ms: u64,
    ) -> Result<Vec<(i64, String, String)>, StoreError> {
        let session = self.expected_session.clone();
        let now = i64::try_from(now_unix_ms).map_err(|_| invalid("retry clock exhausted"))?;
        self.connection.read(move |db| {
            Ok(db.prepare_cached("SELECT not_before_unix_ms,id,session_id FROM native_approval_checkpoints WHERE active=1 AND suspension_kind='model_retry' AND not_before_unix_ms<=?2 AND (?1 IS NULL OR session_id=?1) UNION SELECT not_before_unix_ms,id,session_id FROM native_approval_checkpoints WHERE active=1 AND suspension_kind='model_retry' AND revoked=1 AND (?1 IS NULL OR session_id=?1) ORDER BY not_before_unix_ms,id")?.query_map(rusqlite::params![session, now], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?.collect::<Result<Vec<_>, _>>()?)
        }).await
    }
    pub async fn next_model_retry_deadline(
        &self,
        now_unix_ms: u64,
    ) -> Result<Option<u64>, StoreError> {
        let session = self.expected_session.clone();
        let now = i64::try_from(now_unix_ms).map_err(|_| invalid("retry clock exhausted"))?;
        self.connection.read(move |db| {
            let deadline: Option<i64> = db.query_row("SELECT min(not_before_unix_ms) FROM native_approval_checkpoints WHERE active=1 AND suspension_kind='model_retry' AND revoked=0 AND not_before_unix_ms>? AND (? IS NULL OR session_id=?)", rusqlite::params![now, &session, &session], |row| row.get(0))?;
            deadline.map(crate::sequence_number).transpose()
        }).await
    }
}

pub(crate) fn consume(tx: &Connection, write: &EventWrite) -> Result<(), StoreError> {
    let event = write.event();
    let row: Option<(String,i64,bool)> = tx.query_row("SELECT checkpoint_json,revision,revoked FROM native_approval_checkpoints WHERE invocation_id=? AND active=1 AND suspension_kind='model_retry'", rusqlite::params![&event.invocation.invocation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?;
    let Some((json, revision, revoked)) = row else {
        if write.model_retry_consumption().is_some() {
            return Err(invalid("retry checkpoint is no longer active"));
        }
        return Ok(());
    };
    let evidence = write
        .model_retry_consumption()
        .ok_or_else(|| invalid("active retry requires exact checkpoint consumption"))?;
    let checkpoint: ActivationCheckpoint = serde_json::from_str(&json)?;
    let retry = plan(&checkpoint)?;
    if revoked
        || checkpoint.invocation != event.invocation
        || checkpoint.id != evidence.checkpoint_id
        || crate::sequence_number(revision)? != evidence.revision
        || retry != &evidence.plan
        || crate::native_approvals::now_millis()? < retry.not_before_unix_ms
        || !frontier(tx, &checkpoint, true)?
    {
        return Err(invalid("retry checkpoint consumption is not authorized"));
    }
    let frozen = crate::context::frozen_request::read_in_transaction(
        tx,
        &checkpoint.invocation,
        &retry.failure_event_id,
    )?;
    let mut original = serde_json::to_value(&frozen.request.event.fact)?;
    let mut next = serde_json::to_value(&event.fact)?;
    original
        .as_object_mut()
        .ok_or_else(|| invalid("invalid frozen request"))?
        .remove("step_id");
    next.as_object_mut()
        .ok_or_else(|| invalid("invalid retry request"))?
        .remove("step_id");
    if original != next
        || write.composition().map(|value| value.digest())
            != Some(frozen.composition_digest.as_str())
    {
        return Err(invalid("retry changed frozen request or composition"));
    }
    tx.execute(
        "UPDATE native_approval_checkpoints SET active=0 WHERE id=? AND active=1",
        rusqlite::params![&checkpoint.id],
    )?;
    Ok(())
}

fn cancellation_confirmed(
    tx: &Connection,
    receipt: &ParkedActivationReceipt,
) -> Result<bool, StoreError> {
    let row: Option<String> = tx.query_row("SELECT event_header FROM runtime_events WHERE event_id=? AND invocation_id=? AND kind='invocation_ended'", rusqlite::params![format!("model-retry-cancel:{}", receipt.checkpoint_id()), &receipt.invocation().invocation_id], |row| row.get(0)).optional()?;
    row.map(|json| -> Result<bool, StoreError> {
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        Ok(event.invocation == *receipt.invocation()
            && matches!(
                event.fact,
                Fact::InvocationEnded {
                    outcome: maka_agent_facts::event::InvocationOutcome::Cancelled { .. }
                }
            ))
    })
    .transpose()
    .map(|confirmed| confirmed.unwrap_or(false))
}

/// Retirement and controlled cancellation share the same terminal identity and proof.
pub(crate) fn cancel_in_transaction(
    tx: &Connection,
    checkpoint: &ActivationCheckpoint,
    source: &str,
) -> Result<u64, StoreError> {
    let outstanding: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM context_obligations WHERE invocation_id=? AND kind IN ('model','tool','call'))", rusqlite::params![&checkpoint.invocation.invocation_id], |row| row.get(0))?;
    if outstanding {
        return Err(StoreError::SessionBusy);
    }
    crate::native_approvals::revoke_for_session(
        tx,
        &checkpoint.invocation.session_id,
        crate::native_approvals::now_millis()?,
    )?;
    let mut event = RuntimeEvent::new(
        checkpoint.invocation.clone(),
        Fact::InvocationEnded {
            outcome: maka_agent_facts::event::InvocationOutcome::Cancelled {
                source: source.into(),
            },
        },
    );
    event.id = format!("model-retry-cancel:{}", checkpoint.id);
    let write = EventWrite::plain(event).map_err(|error| invalid(&error.to_string()))?;
    let appended = EventLog::append_in_transaction(tx, &write)?;
    crate::context::validate_batch(tx, &[write])?;
    let (crate::append::AppendResult::Existing(sequence)
    | crate::append::AppendResult::Inserted(sequence)
    | crate::append::AppendResult::ActivationChanged(sequence)) = appended;
    Ok(sequence)
}
