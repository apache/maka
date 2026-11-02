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

use crate::{EventLog, StoreError};
use maka_agent_facts::event::{Fact, Invocation, RuntimeEvent, StoredEvent};
use maka_agent_facts::interaction::{InteractionOutcome, InteractionRequest};
use maka_agent_facts::native_approval::{ActivationCheckpoint, NativeApprovalPending};
use sqlx::{Connection, SqliteConnection};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParkedActivationReceipt {
    checkpoint_id: String,
    invocation: Invocation,
    revision: u64,
}
impl ParkedActivationReceipt {
    pub fn checkpoint_id(&self) -> &str {
        &self.checkpoint_id
    }
    pub fn invocation(&self) -> &Invocation {
        &self.invocation
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParkResult {
    Parked(ParkedActivationReceipt),
    Changed,
}
#[derive(Clone, Debug)]
pub struct ActivationCheckpointRecord {
    pub revoked: bool,
    pub stop_requested: bool,
    pub checkpoint: ActivationCheckpoint,
    pub receipt: ParkedActivationReceipt,
    pub pending: Vec<NativeApprovalPending>,
}
pub type NativeApprovalCheckpoint = ActivationCheckpointRecord;
pub type ModelRetryCheckpoint = ActivationCheckpointRecord;
#[derive(Clone, Debug)]
pub struct ClaimedNativeApproval {
    pub pending: NativeApprovalPending,
    pub claim: String,
    pub outcome: InteractionOutcome,
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
pub(crate) fn receipt(
    checkpoint: &ActivationCheckpoint,
    revision: i64,
) -> Result<ParkedActivationReceipt, StoreError> {
    Ok(ParkedActivationReceipt {
        checkpoint_id: checkpoint.id.clone(),
        invocation: checkpoint.invocation.clone(),
        revision: u64::try_from(revision).map_err(|_| invalid("invalid park revision"))?,
    })
}
pub(crate) async fn exact(
    tx: &mut SqliteConnection,
    checkpoint: &ActivationCheckpoint,
    pending: &[NativeApprovalPending],
) -> Result<Option<ParkedActivationReceipt>, StoreError> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT checkpoint_json,pending_json,revision FROM native_approval_checkpoints WHERE id=?",
    )
    .bind(&checkpoint.id)
    .fetch_optional(tx)
    .await?;
    row.map(|(saved, operations, revision)| {
        if serde_json::from_str::<ActivationCheckpoint>(&saved)? != *checkpoint
            || serde_json::from_str::<Vec<NativeApprovalPending>>(&operations)? != pending
        {
            return Err(StoreError::EventConflict);
        }
        receipt(checkpoint, revision)
    })
    .transpose()
}
async fn live(
    tx: &mut SqliteConnection,
    receipt: &ParkedActivationReceipt,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints WHERE id=? AND invocation_id=? AND session_id=? AND revision=? AND active=1 AND suspension_kind='native_approvals')")
      .bind(&receipt.checkpoint_id).bind(&receipt.invocation.invocation_id).bind(&receipt.invocation.session_id).bind(receipt.revision as i64).fetch_one(tx).await?)
}
pub(crate) fn validate_checkpoint(checkpoint: &ActivationCheckpoint) -> Result<(), StoreError> {
    crate::sessions::validate_id(&checkpoint.id)?;
    if checkpoint.through == 0 || checkpoint.through > 9_007_199_254_740_991 {
        return Err(invalid("invalid native approval checkpoint cut"));
    }
    Ok(())
}
pub(crate) async fn permission_current(
    tx: &mut SqliteConnection,
    invocation: &Invocation,
) -> Result<bool, StoreError> {
    let (binding,boundary):(Option<String>,Option<i64>)=sqlx::query_as("SELECT json_extract(event_header,'$.fact.configuration.workspace_binding'),json_extract(event_header,'$.fact.configuration.boundary_revision') FROM runtime_events WHERE invocation_id=? AND kind='invocation_opened'").bind(&invocation.invocation_id).fetch_one(&mut *tx).await?;
    let expected = binding
        .map(|json| -> Result<_, StoreError> {
            Ok(maka_agent_facts::workspace::PermissionBasis {
                binding: serde_json::from_str(&json)?,
                boundary_revision: u64::try_from(
                    boundary.ok_or_else(|| invalid("opening permission boundary is missing"))?,
                )
                .map_err(|_| invalid("invalid opening permission boundary"))?,
            })
        })
        .transpose()?;
    Ok(crate::workspace_bindings::permission_basis(tx, &invocation.session_id).await? == expected)
}
async fn frontier(
    tx: &mut SqliteConnection,
    checkpoint: &ActivationCheckpoint,
    pending: &[NativeApprovalPending],
    unanswered: bool,
    require_admission: bool,
) -> Result<bool, StoreError> {
    crate::recovery::require_local(tx, &checkpoint.invocation.invocation_id).await?;
    let invocation = &checkpoint.invocation;
    let current = crate::turns::read(tx, &invocation.session_id, None).await?;
    if !current.is_some_and(|turn| {
        turn.invocation == *invocation
            && !matches!(turn.state, crate::turns::InvocationState::Ended { .. })
    }) {
        return Ok(false);
    }
    if pending.is_empty() {
        return Ok(false);
    }
    if require_admission {
        let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 UNION ALL SELECT 1 FROM session_control WHERE id=?1 AND archived=1)").bind(&invocation.session_id).fetch_one(&mut *tx).await?;
        if blocked
            || crate::message_interrupts::fenced(tx, &invocation.session_id, &invocation.run_id)
                .await?
            || !permission_current(tx, invocation).await?
        {
            return Ok(false);
        }
    }
    let mut operations = HashSet::new();
    let mut interactions = HashSet::new();
    for item in pending {
        if item.invocation != *invocation
            || !operations.insert(item.operation_id.as_str())
            || !interactions.insert(item.interaction_id.as_str())
            || item.dispatch.sequence > checkpoint.through
        {
            return Ok(false);
        }
        let row:Option<(i64,String)>=sqlx::query_as("SELECT sequence,event_header FROM runtime_events WHERE event_id=? AND invocation_id=? AND operation_id=? AND kind='tool_dispatched'")
           .bind(&item.dispatch.event_id).bind(&invocation.invocation_id).bind(&item.operation_id).fetch_optional(&mut *tx).await?;
        let Some((sequence, json)) = row else {
            return Ok(false);
        };
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        let Fact::ToolDispatched { call, name, .. } = &event.fact else {
            return Ok(false);
        };
        if event.invocation != *invocation
            || u64::try_from(sequence).ok() != Some(item.dispatch.sequence)
            || !matches!(
                call.origin,
                maka_agent_facts::tool_call::ToolOrigin::Provider { .. }
            )
        {
            return Ok(false);
        }
        let maka_agent_facts::tool_call::ToolOrigin::Provider { step_id } = &call.origin else {
            return Ok(false);
        };
        let completed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND kind='model_completed' AND operation_id=? AND sequence<=?)").bind(&invocation.invocation_id).bind(step_id).bind(checkpoint.through as i64).fetch_one(&mut *tx).await?;
        if !completed {
            return Ok(false);
        }
        let record = crate::interactions::records::read_local(tx, &item.interaction_id).await?;
        let Some(record) = record else {
            return Ok(false);
        };
        if record.session_id != invocation.session_id
            || record.turn_id != invocation.turn_id
            || record.run_id != invocation.run_id
            || (unanswered && record.outcome.is_some())
        {
            return Ok(false);
        }
        let InteractionRequest::ServiceApproval {
            tool_use_id,
            through,
            tool_name,
            ..
        } = &record.request
        else {
            return Ok(false);
        };
        if *tool_use_id
            != maka_agent_facts::tool_call::tool_use_id(
                &invocation.invocation_id,
                &item.operation_id,
            )
            || tool_name != name
            || *through != item.dispatch.sequence
        {
            return Ok(false);
        }
    }
    let outstanding:Vec<(String,String)>=sqlx::query_as("SELECT kind,operation_id FROM context_obligations WHERE invocation_id=? AND kind IN ('model','tool','call')").bind(&invocation.invocation_id).fetch_all(&mut *tx).await?;
    if outstanding.len() != pending.len()
        || outstanding
            .iter()
            .any(|(kind, id)| kind != "tool" || !operations.contains(id.as_str()))
    {
        return Ok(false);
    }
    let pending_interactions:Vec<String>=sqlx::query_scalar("SELECT p.request_id FROM interaction_pending p JOIN interaction_requests r ON r.request_id=p.request_id WHERE p.session_id=?1 AND json_extract(r.record_json,'$.turnId')=?2 AND json_extract(r.record_json,'$.runId')=?3 UNION ALL SELECT p.request_id FROM root_app_pending p JOIN root_app_requests r ON r.request_id=p.request_id WHERE p.session_id=?1 AND json_extract(r.record_json,'$.turnId')=?2 AND json_extract(r.record_json,'$.runId')=?3")
        .bind(&invocation.session_id).bind(&invocation.turn_id).bind(&invocation.run_id).fetch_all(&mut *tx).await?;
    if pending_interactions
        .iter()
        .any(|id| !interactions.contains(id.as_str()))
    {
        return Ok(false);
    }
    let executor:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events e WHERE e.invocation_id=? AND e.kind='executor_started' AND NOT EXISTS(SELECT 1 FROM runtime_events done WHERE done.invocation_id=e.invocation_id AND done.kind='executor_completed'))").bind(&invocation.invocation_id).fetch_one(tx).await?;
    Ok(!executor)
}
impl EventLog {
    pub async fn park_native_approvals(
        &self,
        checkpoint: ActivationCheckpoint,
        pending: Vec<NativeApprovalPending>,
    ) -> Result<ParkResult, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&checkpoint.invocation.session_id)?;
        validate_checkpoint(&checkpoint)?;
        if !matches!(
            checkpoint.suspension,
            maka_agent_facts::native_approval::ActivationSuspension::NativeApprovals
        ) {
            return Err(invalid("native approvals require an approval suspension"));
        }
        let commits = self.commits.session(&checkpoint.invocation.session_id);
        self.connection.run(move |db| Box::pin(async move {
            let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            if let Some(receipt)=exact(&mut tx,&checkpoint,&pending).await? { return Ok(ParkResult::Parked(receipt)); }
            if !frontier(&mut tx,&checkpoint,&pending,true,true).await? { return Ok(ParkResult::Changed); }
            let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints WHERE session_id=? AND active=1)").bind(&checkpoint.invocation.session_id).fetch_one(&mut *tx).await?;
            if active { return Ok(ParkResult::Changed); }
            crate::sessions::advance_revision(&mut tx,&checkpoint.invocation.session_id).await?;
            let revision:i64=sqlx::query_scalar("SELECT revision FROM session_control WHERE id=?").bind(&checkpoint.invocation.session_id).fetch_one(&mut *tx).await?;
            sqlx::query("INSERT INTO native_approval_checkpoints(id,session_id,invocation_id,checkpoint_json,pending_json,revision,active) VALUES(?,?,?,?,?,?,1)")
              .bind(&checkpoint.id).bind(&checkpoint.invocation.session_id).bind(&checkpoint.invocation.invocation_id).bind(serde_json::to_string(&checkpoint)?).bind(serde_json::to_string(&pending)?).bind(revision).execute(&mut *tx).await?;
            for item in &pending { sqlx::query("INSERT INTO native_approval_operations(checkpoint_id,operation_id,interaction_id,phase) VALUES(?,?,?,'waiting')").bind(&checkpoint.id).bind(&item.operation_id).bind(&item.interaction_id).execute(&mut *tx).await?; }
            tx.commit().await.map_err(StoreError::CommitUnknown)?; commits.metadata();commits.activations();
            Ok(ParkResult::Parked(receipt(&checkpoint,revision)?))
        })).await
    }
    pub async fn confirm_native_approval_park(
        &self,
        checkpoint: &ActivationCheckpoint,
        pending: &[NativeApprovalPending],
    ) -> Result<Option<ParkedActivationReceipt>, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&checkpoint.invocation.session_id)?;
        let checkpoint = checkpoint.clone();
        let pending = pending.to_vec();
        self.connection
            .read(move |tx| Box::pin(async move { exact(tx, &checkpoint, &pending).await }))
            .await
    }
    pub async fn activation_checkpoint(
        &self,
        session: &str,
    ) -> Result<Option<NativeApprovalCheckpoint>, StoreError> {
        self.validate_root()?;
        self.check_bound_session(session)?;
        let session = session.to_owned();
        self.connection.read(move |db|Box::pin(async move {
            let mut tx=db.begin().await?;
            let row:Option<(String,String,i64,bool)>=sqlx::query_as("SELECT checkpoint_json,pending_json,revision,revoked FROM native_approval_checkpoints WHERE session_id=? AND active=1").bind(session).fetch_optional(&mut *tx).await?;
            let Some((json,pending,revision,revoked))=row else {return Ok(None)};
            let checkpoint:ActivationCheckpoint=serde_json::from_str(&json)?;
            let stop_requested=crate::message_interrupts::fenced(&mut tx,&checkpoint.invocation.session_id,&checkpoint.invocation.run_id).await?;
            let settled:Vec<String>=sqlx::query_scalar("SELECT operation_id FROM native_approval_operations WHERE checkpoint_id=? AND phase='settled'").bind(&checkpoint.id).fetch_all(&mut *tx).await?;
            let mut pending:Vec<NativeApprovalPending>=serde_json::from_str(&pending)?;pending.retain(|item|!settled.contains(&item.operation_id));
            tx.commit().await?;
            Ok(Some(ActivationCheckpointRecord{revoked,stop_requested,receipt:receipt(&checkpoint,revision)?,checkpoint,pending}))
        })).await
    }
    pub async fn claim_native_approvals(
        &self,
        receipt: &ParkedActivationReceipt,
        claim: &str,
        epoch: &str,
    ) -> Result<Vec<ClaimedNativeApproval>, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&receipt.invocation.session_id)?;
        let receipt = receipt.clone();
        let claim = claim.to_owned();
        let epoch = epoch.to_owned();
        self.connection.run(move |db|Box::pin(async move {
            let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            if !live(&mut tx,&receipt).await? {return Err(invalid("native approval checkpoint is no longer active"));}
            let json:String=sqlx::query_scalar("SELECT pending_json FROM native_approval_checkpoints WHERE id=?").bind(&receipt.checkpoint_id).fetch_one(&mut *tx).await?;
            let pending:Vec<NativeApprovalPending>=serde_json::from_str(&json)?;let mut ready=Vec::new();
            for item in pending {
                let Some(outcome)=crate::interactions::records::read_local(&mut tx,&item.interaction_id).await?.and_then(|r|r.outcome) else {continue};
                let changed=sqlx::query("UPDATE native_approval_operations SET phase='claimed',claim=?,host_epoch=? WHERE checkpoint_id=? AND operation_id=? AND (phase='waiting' OR (phase='claimed' AND claim=? AND host_epoch=?))").bind(&claim).bind(&epoch).bind(&receipt.checkpoint_id).bind(&item.operation_id).bind(&claim).bind(&epoch).execute(&mut *tx).await?.rows_affected();
                if changed==1 {ready.push(ClaimedNativeApproval{pending:item,claim:claim.clone(),outcome});}
            }
            tx.commit().await.map_err(StoreError::CommitUnknown)?;Ok(ready)
        })).await
    }
    pub async fn start_native_approval(
        &self,
        receipt: &ParkedActivationReceipt,
        operation: &str,
        claim: &str,
        start_id: &str,
    ) -> Result<bool, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&receipt.invocation.session_id)?;
        let receipt = receipt.clone();
        let operation = operation.to_owned();
        let claim = claim.to_owned();
        let start_id = start_id.to_owned();
        self.connection.run(move |db|Box::pin(async move {
            let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            if !live(&mut tx,&receipt).await? {return Ok(false)}
            let existing:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_operations WHERE checkpoint_id=? AND operation_id=? AND phase='started' AND claim=? AND start_id=?)").bind(&receipt.checkpoint_id).bind(&operation).bind(&claim).bind(&start_id).fetch_one(&mut *tx).await?;
            if existing {return Ok(true)}
            match crate::sessions::removal::require_accepting(&mut tx,&receipt.invocation.session_id).await {
                Ok(())=>{},
                Err(StoreError::SessionRetired)=>return Ok(false),
                Err(error)=>return Err(error),
            }
            if crate::message_interrupts::fenced(&mut tx,&receipt.invocation.session_id,&receipt.invocation.run_id).await? || !permission_current(&mut tx,&receipt.invocation).await? {return Ok(false)}
            let changed=sqlx::query("UPDATE native_approval_operations SET phase='started',start_id=? WHERE checkpoint_id=? AND operation_id=? AND phase='claimed' AND claim=? AND EXISTS(SELECT 1 FROM native_approval_checkpoints c WHERE c.id=checkpoint_id AND c.revoked=0) AND NOT EXISTS(SELECT 1 FROM session_control WHERE id=? AND archived=1) AND EXISTS(SELECT 1 FROM interaction_outcomes o WHERE o.request_id=interaction_id AND json_extract(o.outcome_json,'$.kind')='service_approval_decision' AND json_extract(o.outcome_json,'$.decision')='allow') AND NOT EXISTS(SELECT 1 FROM runtime_events e WHERE e.invocation_id=? AND e.operation_id=? AND e.kind='tool_settled')")
              .bind(start_id).bind(&receipt.checkpoint_id).bind(&operation).bind(claim).bind(&receipt.invocation.session_id).bind(&receipt.invocation.invocation_id).bind(operation).execute(&mut *tx).await?.rows_affected();
            tx.commit().await.map_err(StoreError::CommitUnknown)?;Ok(changed==1)
        })).await
    }
    pub async fn native_approvals_settled(
        &self,
        receipt: &ParkedActivationReceipt,
    ) -> Result<bool, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&receipt.invocation.session_id)?;
        let receipt = receipt.clone();
        self.connection.read(move |tx|Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints c WHERE c.id=? AND c.revision=? AND c.invocation_id=? AND c.session_id=? AND c.active=1 AND c.suspension_kind='native_approvals' AND NOT EXISTS(SELECT 1 FROM native_approval_operations o WHERE o.checkpoint_id=c.id AND o.phase!='settled'))")
                .bind(&receipt.checkpoint_id).bind(receipt.revision as i64).bind(&receipt.invocation.invocation_id).bind(&receipt.invocation.session_id).fetch_one(tx).await?)
        })).await
    }
    pub async fn stop_native_approvals(
        &self,
        invocation: &Invocation,
        now: u64,
    ) -> Result<bool, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&invocation.session_id)?;
        let invocation = invocation.clone();
        let commits = self.commits.session(&invocation.session_id);
        self.connection.run(move |db|Box::pin(async move {let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            let changed=sqlx::query("UPDATE native_approval_checkpoints SET revoked=1 WHERE invocation_id=? AND session_id=? AND active=1").bind(&invocation.invocation_id).bind(&invocation.session_id).execute(&mut *tx).await?.rows_affected();
            if changed>0 {crate::interactions::lifecycle::close_in_transaction(&mut tx,Some(&invocation),&InteractionOutcome::Closure{reason:maka_agent_facts::interaction::ClosureReason::TurnStopped,committed_at:now}).await?;}
            tx.commit().await.map_err(StoreError::CommitUnknown)?;if changed>0 {commits.metadata();commits.activations();}Ok(changed>0)
        })).await
    }
}

pub(crate) async fn require_terminal(
    tx: &mut SqliteConnection,
    invocation: &Invocation,
) -> Result<(), StoreError> {
    let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints c JOIN native_approval_operations o ON o.checkpoint_id=c.id WHERE c.invocation_id=? AND c.active=1 AND o.phase!='settled')").bind(&invocation.invocation_id).fetch_one(tx).await?;
    if pending {
        return Err(invalid(
            "cannot seal an invocation with native approval obligations",
        ));
    }
    Ok(())
}

impl EventLog {
    pub async fn repark_native_approvals(
        &self,
        previous: &ParkedActivationReceipt,
        checkpoint: ActivationCheckpoint,
        pending: Vec<NativeApprovalPending>,
    ) -> Result<ParkResult, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&checkpoint.invocation.session_id)?;
        validate_checkpoint(&checkpoint)?;
        if !matches!(
            checkpoint.suspension,
            maka_agent_facts::native_approval::ActivationSuspension::NativeApprovals
        ) {
            return Err(invalid("native approvals require an approval suspension"));
        }
        let previous = previous.clone();
        let commits = self.commits.session(&checkpoint.invocation.session_id);
        self.connection.run(move |db|Box::pin(async move {
            let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            if checkpoint.invocation!=previous.invocation {return Err(StoreError::EventConflict)}
            if let Some(receipt)=exact(&mut tx,&checkpoint,&pending).await? {return Ok(ParkResult::Parked(receipt))}
            if !live(&mut tx,&previous).await? {return Ok(ParkResult::Changed)}
            let old:String=sqlx::query_scalar("SELECT pending_json FROM native_approval_checkpoints WHERE id=?").bind(&previous.checkpoint_id).fetch_one(&mut *tx).await?;
            let mut expected:Vec<NativeApprovalPending>=serde_json::from_str(&old)?;
            let remaining:Vec<String>=sqlx::query_scalar("SELECT operation_id FROM native_approval_operations WHERE checkpoint_id=? AND phase!='settled'").bind(&previous.checkpoint_id).fetch_all(&mut *tx).await?;
            expected.retain(|item|remaining.contains(&item.operation_id));
            if expected!=pending {return Err(StoreError::EventConflict)}
            let revoked:bool=sqlx::query_scalar("SELECT revoked FROM native_approval_checkpoints WHERE id=?").bind(&previous.checkpoint_id).fetch_one(&mut *tx).await?;
            if revoked || !permission_current(&mut tx,&checkpoint.invocation).await? {
                revoke_for_session(&mut tx,&checkpoint.invocation.session_id,now_millis()?).await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)?;commits.metadata();commits.activations();
                return Ok(ParkResult::Changed);
            }
            if !frontier(&mut tx,&checkpoint,&pending,false,true).await? {return Ok(ParkResult::Changed)}
            let physical:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_operations WHERE checkpoint_id=? AND phase IN ('claimed','started'))").bind(&previous.checkpoint_id).fetch_one(&mut *tx).await?;
            if physical {return Ok(ParkResult::Changed)}
            crate::sessions::advance_revision(&mut tx,&checkpoint.invocation.session_id).await?;
            let revision:i64=sqlx::query_scalar("SELECT revision FROM session_control WHERE id=?").bind(&checkpoint.invocation.session_id).fetch_one(&mut *tx).await?;
            sqlx::query("UPDATE native_approval_checkpoints SET active=0 WHERE id=?").bind(&previous.checkpoint_id).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO native_approval_checkpoints(id,session_id,invocation_id,checkpoint_json,pending_json,revision,active,revoked) SELECT ?,session_id,invocation_id,?,?,?,1,revoked FROM native_approval_checkpoints WHERE id=?")
                .bind(&checkpoint.id).bind(serde_json::to_string(&checkpoint)?).bind(serde_json::to_string(&pending)?).bind(revision).bind(&previous.checkpoint_id).execute(&mut *tx).await?;
            for item in &pending {sqlx::query("INSERT INTO native_approval_operations(checkpoint_id,operation_id,interaction_id,phase) VALUES(?,?,?,'waiting')").bind(&checkpoint.id).bind(&item.operation_id).bind(&item.interaction_id).execute(&mut *tx).await?;}
            sqlx::query("DELETE FROM native_approval_operations WHERE checkpoint_id=?").bind(&previous.checkpoint_id).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM native_approval_checkpoints WHERE id=?").bind(&previous.checkpoint_id).execute(&mut *tx).await?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;commits.metadata();commits.activations();Ok(ParkResult::Parked(receipt(&checkpoint,revision)?))
        })).await
    }
    pub async fn ready_native_approval_sessions(&self) -> Result<Vec<String>, StoreError> {
        self.validate_root()?;
        let session = self.expected_session.clone();
        self.connection.read(move |db|Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT c.session_id FROM native_approval_checkpoints c WHERE c.active=1 AND c.suspension_kind='native_approvals' AND (?1 IS NULL OR c.session_id=?1) AND NOT EXISTS(SELECT 1 FROM session_retirements r WHERE r.session_id=c.session_id) AND (EXISTS(SELECT 1 FROM native_approval_operations o JOIN interaction_outcomes a ON a.request_id=o.interaction_id WHERE o.checkpoint_id=c.id AND o.phase='waiting') OR NOT EXISTS(SELECT 1 FROM native_approval_operations o WHERE o.checkpoint_id=c.id AND o.phase!='settled')) ORDER BY c.session_id").bind(session).fetch_all(db).await?)
        })).await
    }
    pub(crate) async fn reconcile_activation_controls(&self) -> Result<(), StoreError> {
        self.validate_root()?;
        let commits = self.commits.clone();
        self.connection.run(move |db|Box::pin(async move {
            let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            let active:Vec<(String,String)>=sqlx::query_as("SELECT session_id,json_extract(checkpoint_json,'$.invocation') FROM native_approval_checkpoints WHERE active=1 AND revoked=0 AND NOT EXISTS(SELECT 1 FROM session_retirements r WHERE r.session_id=native_approval_checkpoints.session_id)").fetch_all(&mut *tx).await?;
            let mut changed_sessions=Vec::new();
            for (session,json) in active {
                let invocation:Invocation=serde_json::from_str(&json)?;
                if !permission_current(&mut tx,&invocation).await?
                    && revoke_for_session(&mut tx,&session,now_millis()?).await?
                {changed_sessions.push(session);}
            }
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            for session in changed_sessions {commits.session(&session).metadata();commits.notice().activations();}Ok(())
        })).await
    }
    pub(crate) async fn prepare_native_approval_recovery(
        &self,
    ) -> Result<HashSet<String>, StoreError> {
        self.validate_root()?;
        let commits = self.commits.notice();
        self.connection.run(move |db|Box::pin(async move {
            let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            let checkpoints:Vec<(String,String)>=sqlx::query_as("SELECT checkpoint_json,pending_json FROM native_approval_checkpoints WHERE active=1").fetch_all(&mut *tx).await?;
            let checkpoints_empty = checkpoints.is_empty();
            let mut preserved=HashSet::new();
            for (json,pending) in checkpoints {
                let checkpoint:ActivationCheckpoint=serde_json::from_str(&json)?;
                if matches!(checkpoint.suspension, maka_agent_facts::native_approval::ActivationSuspension::ModelRetry { .. }) {
                    if crate::model_retries::frontier(&mut tx, &checkpoint, false).await? {
                        let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 UNION ALL SELECT 1 FROM session_control WHERE id=?1 AND archived=1)").bind(&checkpoint.invocation.session_id).fetch_one(&mut *tx).await?;
                        if blocked || !permission_current(&mut tx, &checkpoint.invocation).await? || crate::message_interrupts::fenced(&mut tx, &checkpoint.invocation.session_id, &checkpoint.invocation.run_id).await? {
                            revoke_for_session(&mut tx, &checkpoint.invocation.session_id, now_millis()?).await?;
                        }
                        preserved.insert(checkpoint.invocation.invocation_id);
                    } else {
                        sqlx::query("UPDATE native_approval_checkpoints SET active=0 WHERE id=?").bind(&checkpoint.id).execute(&mut *tx).await?;
                    }
                    continue;
                }
                let mut pending:Vec<NativeApprovalPending>=serde_json::from_str(&pending)?;
                sqlx::query("UPDATE native_approval_operations SET phase='settled',terminal_event_id=(SELECT event_id FROM runtime_events e WHERE e.invocation_id=? AND e.operation_id=native_approval_operations.operation_id AND e.kind='tool_settled') WHERE checkpoint_id=? AND EXISTS(SELECT 1 FROM runtime_events e WHERE e.invocation_id=? AND e.operation_id=native_approval_operations.operation_id AND e.kind='tool_settled')")
                    .bind(&checkpoint.invocation.invocation_id).bind(&checkpoint.id).bind(&checkpoint.invocation.invocation_id).execute(&mut *tx).await?;
                let settled:Vec<String>=sqlx::query_scalar("SELECT operation_id FROM native_approval_operations WHERE checkpoint_id=? AND phase='settled'").bind(&checkpoint.id).fetch_all(&mut *tx).await?;
                pending.retain(|item|!settled.contains(&item.operation_id));
                let started:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_operations WHERE checkpoint_id=? AND phase='started')").bind(&checkpoint.id).fetch_one(&mut *tx).await?;
                let advanced:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND sequence>? AND kind IN ('model_requested','executor_started','invocation_ended'))").bind(&checkpoint.invocation.invocation_id).bind(checkpoint.through as i64).fetch_one(&mut *tx).await?;
                let valid=!started && !advanced && if pending.is_empty() {
                    let unsettled:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_obligations WHERE invocation_id=? AND kind IN ('model','tool','call'))").bind(&checkpoint.invocation.invocation_id).fetch_one(&mut *tx).await?; !unsettled
                } else {frontier(&mut tx,&checkpoint,&pending,false,false).await?};
                if valid {
                    let retired:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?)").bind(&checkpoint.invocation.session_id).fetch_one(&mut *tx).await?;
                    if retired || !permission_current(&mut tx,&checkpoint.invocation).await? || crate::message_interrupts::fenced(&mut tx,&checkpoint.invocation.session_id,&checkpoint.invocation.run_id).await? {
                        revoke_for_session(&mut tx,&checkpoint.invocation.session_id,now_millis()?).await?;
                    }
                    sqlx::query("UPDATE native_approval_operations SET phase='waiting',claim=NULL,host_epoch=NULL WHERE checkpoint_id=? AND phase='claimed'").bind(&checkpoint.id).execute(&mut *tx).await?;
                    preserved.insert(checkpoint.invocation.invocation_id);
                } else {sqlx::query("UPDATE native_approval_checkpoints SET active=0 WHERE id=?").bind(&checkpoint.id).execute(&mut *tx).await?;}
            }
            tx.commit().await.map_err(StoreError::CommitUnknown)?;if !checkpoints_empty {commits.activations();}Ok(preserved)
        })).await
    }
    pub async fn native_approval_dispatch(
        &self,
        pending: &NativeApprovalPending,
    ) -> Result<StoredEvent, StoreError> {
        self.validate_root()?;
        self.check_bound_session(&pending.invocation.session_id)?;
        let pending = pending.clone();
        self.connection.read(move |db|Box::pin(async move {
            let (sequence,json):(i64,String)=sqlx::query_as("SELECT sequence,event_header FROM runtime_events WHERE event_id=? AND invocation_id=? AND operation_id=? AND kind='tool_dispatched'").bind(&pending.dispatch.event_id).bind(&pending.invocation.invocation_id).bind(&pending.operation_id).fetch_one(db).await?;
            let event:RuntimeEvent=serde_json::from_str(&json)?;
            if event.invocation!=pending.invocation || crate::sequence_number(sequence)?!=pending.dispatch.sequence {return Err(StoreError::EventConflict)}
            Ok(StoredEvent{sequence:pending.dispatch.sequence,event})
        })).await
    }
}

pub(crate) async fn retire_terminal(
    tx: &mut SqliteConnection,
    invocation: &Invocation,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM native_approval_operations WHERE checkpoint_id IN (SELECT id FROM native_approval_checkpoints WHERE invocation_id=?)").bind(&invocation.invocation_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM native_approval_checkpoints WHERE invocation_id=?")
        .bind(&invocation.invocation_id)
        .execute(tx)
        .await?;
    Ok(())
}

pub(crate) fn now_millis() -> Result<u64, StoreError> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| invalid(&error.to_string()))?;
    u64::try_from(elapsed.as_millis())
        .map_err(|_| invalid("native approval lifecycle timestamp exhausted"))
}
pub(crate) async fn revoke_for_session(
    tx: &mut SqliteConnection,
    session: &str,
    now: u64,
) -> Result<bool, StoreError> {
    let json:Option<String>=sqlx::query_scalar("SELECT json_extract(checkpoint_json,'$.invocation') FROM native_approval_checkpoints WHERE session_id=? AND active=1").bind(session).fetch_optional(&mut *tx).await?;
    let Some(json) = json else { return Ok(false) };
    let invocation: Invocation = serde_json::from_str(&json)?;
    sqlx::query("UPDATE native_approval_checkpoints SET revoked=1 WHERE session_id=? AND active=1")
        .bind(session)
        .execute(&mut *tx)
        .await?;
    let reason =
        if crate::message_interrupts::fenced(tx, &invocation.session_id, &invocation.run_id).await?
        {
            maka_agent_facts::interaction::ClosureReason::TurnStopped
        } else {
            maka_agent_facts::interaction::ClosureReason::ProducerCancelled
        };
    crate::interactions::lifecycle::close_in_transaction(
        tx,
        Some(&invocation),
        &InteractionOutcome::Closure {
            reason,
            committed_at: now,
        },
    )
    .await?;
    Ok(true)
}

/// The retirement owner holds exclusive Session Work admission through commit.
/// Only untouched waits can be settled here; resume ownership is never inferred dead.
pub(crate) async fn settle_retiring_waits(
    tx: &mut SqliteConnection,
    session: &str,
) -> Result<Option<u64>, StoreError> {
    let row:Option<(String,String)>=sqlx::query_as("SELECT checkpoint_json,pending_json FROM native_approval_checkpoints WHERE session_id=? AND active=1").bind(session).fetch_optional(&mut *tx).await?;
    let Some((json, pending)) = row else {
        return Ok(None);
    };
    let checkpoint: ActivationCheckpoint = serde_json::from_str(&json)?;
    if matches!(
        checkpoint.suspension,
        maka_agent_facts::native_approval::ActivationSuspension::ModelRetry { .. }
    ) {
        if !crate::model_retries::frontier(tx, &checkpoint, false).await? {
            return Err(StoreError::SessionBusy);
        }
        return crate::model_retries::cancel_in_transaction(tx, &checkpoint, "session_retired")
            .await
            .map(Some);
    }

    let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_operations WHERE checkpoint_id=? AND phase IN ('claimed','started'))").bind(&checkpoint.id).fetch_one(&mut *tx).await?;
    if owned {
        return Err(StoreError::SessionBusy);
    }
    let mut pending: Vec<NativeApprovalPending> = serde_json::from_str(&pending)?;
    let waiting:Vec<String>=sqlx::query_scalar("SELECT operation_id FROM native_approval_operations WHERE checkpoint_id=? AND phase='waiting'").bind(&checkpoint.id).fetch_all(&mut *tx).await?;
    pending.retain(|item| waiting.contains(&item.operation_id));
    if pending.is_empty() {
        let other:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_obligations WHERE invocation_id=? AND kind IN ('model','tool','call'))").bind(&checkpoint.invocation.invocation_id).fetch_one(&mut *tx).await?;
        if other {
            return Err(StoreError::SessionBusy);
        }
    } else if !frontier(tx, &checkpoint, &pending, false, false).await? {
        return Err(StoreError::SessionBusy);
    }
    let advanced:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND sequence>? AND kind IN ('model_requested','executor_started','invocation_ended'))").bind(&checkpoint.invocation.invocation_id).bind(checkpoint.through as i64).fetch_one(&mut *tx).await?;
    if advanced {
        return Err(StoreError::SessionBusy);
    }
    revoke_for_session(tx, session, now_millis()?).await?;
    let mut writes = Vec::new();
    for item in pending {
        let mut event = RuntimeEvent::new(
            checkpoint.invocation.clone(),
            Fact::ToolSettled {
                operation_id: item.operation_id.clone(),
                outcome: maka_agent_facts::event::ToolOutcome::Failed {
                    message: "Session retired before native approval execution.".into(),
                },
            },
        );
        event.id = format!(
            "native-approval-retired:{}:{}",
            checkpoint.invocation.invocation_id, item.operation_id
        );
        let write = maka_agent_facts::event::EventWrite::plain(event)
            .map_err(|error| invalid(&error.to_string()))?;
        EventLog::append_in_transaction(tx, &write).await?;
        writes.push(write);
    }
    let mut event = RuntimeEvent::new(
        checkpoint.invocation.clone(),
        Fact::InvocationEnded {
            outcome: maka_agent_facts::event::InvocationOutcome::Cancelled {
                source: "session_retired".into(),
            },
        },
    );
    event.id = format!(
        "native-approval-retired:{}:terminal",
        checkpoint.invocation.invocation_id
    );
    let write = maka_agent_facts::event::EventWrite::plain(event)
        .map_err(|error| invalid(&error.to_string()))?;
    let appended = EventLog::append_in_transaction(tx, &write).await?;
    writes.push(write);
    crate::context::validate_batch(tx, &writes).await?;
    let sequence = match appended {
        crate::append::AppendResult::Existing(sequence)
        | crate::append::AppendResult::Inserted(sequence)
        | crate::append::AppendResult::ActivationChanged(sequence) => sequence,
    };
    Ok(Some(sequence))
}

pub(crate) async fn append_settlement(
    tx: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<bool, StoreError> {
    let Fact::ToolSettled { operation_id, .. } = &event.fact else {
        return Ok(false);
    };
    let changed = sqlx::query("UPDATE native_approval_operations SET phase='settled',terminal_event_id=? WHERE checkpoint_id=(SELECT id FROM native_approval_checkpoints WHERE invocation_id=? AND active=1) AND operation_id=?")
        .bind(&event.id).bind(&event.invocation.invocation_id).bind(operation_id).execute(tx).await?.rows_affected();
    Ok(changed > 0)
}

impl EventLog {
    /// Return untouched approval custody to its original checkpoint. Waiting
    /// confirms a lost release receipt without granting execution authority.
    pub async fn release_native_approval_claim(
        &self,
        receipt: &ParkedActivationReceipt,
        operation: &str,
        claim: &str,
        host_epoch: &str,
    ) -> Result<bool, StoreError> {
        #[derive(sqlx::FromRow)]
        struct ClaimRow {
            phase: String,
            claim: Option<String>,
            host_epoch: Option<String>,
            start_id: Option<String>,
        }
        self.validate_root()?;
        self.check_bound_session(&receipt.invocation.session_id)?;
        let commits = self.commits.session(&receipt.invocation.session_id);
        let receipt = receipt.clone();
        let operation = operation.to_owned();
        let claim = claim.to_owned();
        let host_epoch = host_epoch.to_owned();
        self.connection.run(move |db|Box::pin(async move {
            let mut tx=db.begin_with("BEGIN IMMEDIATE").await?;
            if !live(&mut tx,&receipt).await? {return Ok(false)}
            let state=sqlx::query_as::<_,ClaimRow>("SELECT phase,claim,host_epoch,start_id FROM native_approval_operations WHERE checkpoint_id=? AND operation_id=?").bind(&receipt.checkpoint_id).bind(&operation).fetch_optional(&mut *tx).await?;
            let Some(state)=state else {return Ok(false)};
            let already_waiting=state.phase=="waiting" && state.claim.is_none() && state.host_epoch.is_none() && state.start_id.is_none();
            if !already_waiting && (state.phase!="claimed" || state.claim.as_deref()!=Some(claim.as_str()) || state.host_epoch.as_deref()!=Some(host_epoch.as_str()) || state.start_id.is_some()) {return Ok(false)}
            let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1 UNION ALL SELECT 1 FROM session_control WHERE id=?1 AND archived=1)").bind(&receipt.invocation.session_id).fetch_one(&mut *tx).await?;
            if blocked || crate::message_interrupts::fenced(&mut tx,&receipt.invocation.session_id,&receipt.invocation.run_id).await? {return Ok(false)}
            let revoked:bool=sqlx::query_scalar("SELECT revoked FROM native_approval_checkpoints WHERE id=?").bind(&receipt.checkpoint_id).fetch_one(&mut *tx).await?;
            if revoked || !permission_current(&mut tx,&receipt.invocation).await? {
                revoke_for_session(&mut tx,&receipt.invocation.session_id,now_millis()?).await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)?;commits.metadata();commits.activations();return Ok(false)
            }
            let settled:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind='tool_settled')").bind(&receipt.invocation.invocation_id).bind(&operation).fetch_one(&mut *tx).await?;
            if settled {return Ok(false)}
            if already_waiting {return Ok(true)}
            let changed=sqlx::query("UPDATE native_approval_operations SET phase='waiting',claim=NULL,host_epoch=NULL WHERE checkpoint_id=? AND operation_id=? AND phase='claimed' AND claim=? AND host_epoch=? AND start_id IS NULL")
                .bind(&receipt.checkpoint_id).bind(&operation).bind(&claim).bind(&host_epoch).execute(&mut *tx).await?.rows_affected();
            tx.commit().await.map_err(StoreError::CommitUnknown)?;if changed==1 {commits.metadata();commits.activations();}Ok(changed==1)
        })).await
    }
}

pub(crate) async fn append_model_request(
    tx: &mut SqliteConnection,
    write: &maka_agent_facts::event::EventWrite,
) -> Result<(), StoreError> {
    let event = write.event();
    if !matches!(event.fact, Fact::ModelRequested { .. }) {
        return Ok(());
    }
    crate::model_retries::consume(tx, write).await?;
    let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_checkpoints c JOIN native_approval_operations o ON o.checkpoint_id=c.id WHERE c.invocation_id=? AND c.active=1 AND o.phase!='settled')").bind(&event.invocation.invocation_id).fetch_one(&mut *tx).await?;
    if pending {
        return Err(invalid(
            "cannot advance a native approval checkpoint with unsettled tools",
        ));
    }
    sqlx::query(
        "UPDATE native_approval_checkpoints SET active=0 WHERE invocation_id=? AND active=1",
    )
    .bind(&event.invocation.invocation_id)
    .execute(tx)
    .await?;
    Ok(())
}

/// Changes to this request can make an existing parked wait runnable.
pub(crate) async fn waits_for_interaction(
    tx: &mut SqliteConnection,
    request: &str,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM native_approval_operations o JOIN native_approval_checkpoints c ON c.id=o.checkpoint_id WHERE o.interaction_id=? AND c.active=1 AND o.phase='waiting')")
        .bind(request).fetch_one(tx).await?)
}
