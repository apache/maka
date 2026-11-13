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

//! Task-group admission scheduler, phase-scoped deadline authority, bounded
//! retry policy, canonical attempt selection, and crash recovery loop.

use crate::contract::{
    AttemptPhase, CleanupState, ContractError, CriticalArtifactsState, EgressAuditState,
    EvalResultStatus, ExecutionOutcome, ExperimentCell, ExperimentSpec, SchemaVersion, SubjectKind,
    V1CellAttempt, V2AttemptRecord, VerifierOutcome, expand_experiment, select_cell_result,
};
use crate::environment::{
    ExecutorPreparationCode, IndeterminateCause, TrialEnvironment, TrialEnvironmentOutcome,
    harbor_trial_name_for_attempt,
};
use crate::measurement::MeteringState;
use crate::store::{FileAttemptStore, StoreError, UnsettledAttempt};
use crate::subject::SubjectAdapter;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("Contract error: {0}")]
    Contract(#[from] ContractError),
    #[error("Store error: {0}")]
    Store(#[from] StoreError),
    #[error("{0}")]
    Execution(String),
}

/// Retry policy governing automatic retries within a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Maximum automatic retries for `infra_failed` attempts within a single run (`0` = single try per invocation).
    pub max_infra_retries: u32,
    /// Stop in-run retries for indeterminate outcomes even when cleanup was confirmed.
    /// Unconfirmed cleanup always blocks admission, including in later runs.
    pub block_automatic_retry_on_indeterminate: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_infra_retries: 0,
            block_automatic_retry_on_indeterminate: true,
        }
    }
}

/// Probe used during crash recovery to verify whether a tagged resource from an
/// interrupted run has been cleaned up.
pub trait ResourceCleanupProbe: Send + Sync {
    fn confirm_cleaned_up(&self, resource_kind: &str, resource_id: &str) -> bool;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ConservativeCleanupProbe;

impl ResourceCleanupProbe for ConservativeCleanupProbe {
    fn confirm_cleaned_up(&self, _resource_kind: &str, _resource_id: &str) -> bool {
        false
    }
}

/// Recovers unsettled attempts left behind by a previous crashed process before
/// admitting new work.
pub fn recover_unsettled_attempts(
    store: &FileAttemptStore,
    probe: &dyn ResourceCleanupProbe,
    now_ms: u64,
) -> Result<Vec<V2AttemptRecord>, RunnerError> {
    let state = store.reconstruct_state()?;
    let mut recovered = Vec::new();

    for ((cell_id, sequence), unsettled) in state.unsettled {
        let record = settle_interrupted_attempt(&unsettled, probe, now_ms);
        store.append_v2(&record)?;
        store.record_post_hoc_recovery(
            &cell_id,
            sequence,
            now_ms,
            record.usage.clone(),
            record.metering_state,
            matches!(record.cleanup_state, CleanupState::Confirmed),
            record.failure_reason.clone(),
        )?;
        recovered.push(record);
    }

    Ok(recovered)
}

fn settle_interrupted_attempt(
    unsettled: &UnsettledAttempt,
    probe: &dyn ResourceCleanupProbe,
    now_ms: u64,
) -> V2AttemptRecord {
    let duration_ms = now_ms.saturating_sub(unsettled.started_at);
    match (&unsettled.resource_kind, &unsettled.resource_id) {
        (None, None) => {
            // Crashed after LaunchIntent but before any external resource or Host operation was created.
            V2AttemptRecord {
                schema_version: SchemaVersion::V2,
                cell_id: unsettled.cell_id.clone(),
                sequence: unsettled.sequence,
                started_at: unsettled.started_at,
                completed_at: now_ms,
                duration_ms,
                phase: AttemptPhase::Recovered,
                execution_outcome: ExecutionOutcome::InfraFailed,
                verifier_outcome: VerifierOutcome::Skipped,
                usage: unsettled.latest_usage.clone(),
                metering_state: unsettled.latest_metering_state,
                pricing: None,
                cleanup_state: CleanupState::Confirmed,
                audit_state: EgressAuditState::NotRequired,
                critical_artifacts_state: CriticalArtifactsState::Present,
                cancelled_after_verification: false,
                recovered_post_hoc: true,
                failure_reason: Some("attempt interrupted before resource creation".into()),
                artifacts: Vec::new(),
            }
        }
        (Some(kind), Some(id)) => {
            let confirmed = probe.confirm_cleaned_up(kind, id);
            V2AttemptRecord {
                schema_version: SchemaVersion::V2,
                cell_id: unsettled.cell_id.clone(),
                sequence: unsettled.sequence,
                started_at: unsettled.started_at,
                completed_at: now_ms,
                duration_ms,
                phase: AttemptPhase::Recovered,
                execution_outcome: if confirmed {
                    ExecutionOutcome::InfraFailed
                } else {
                    ExecutionOutcome::Indeterminate
                },
                verifier_outcome: VerifierOutcome::Skipped,
                usage: unsettled.latest_usage.clone(),
                metering_state: unsettled.latest_metering_state,
                pricing: None,
                cleanup_state: if confirmed {
                    CleanupState::Confirmed
                } else {
                    CleanupState::Unconfirmed {
                        reason: "executor cleanup did not settle".into(),
                    }
                },
                audit_state: EgressAuditState::NotRequired,
                critical_artifacts_state: CriticalArtifactsState::Present,
                cancelled_after_verification: false,
                recovered_post_hoc: true,
                failure_reason: Some(if confirmed {
                    "attempt interrupted and resource cleanup confirmed".into()
                } else {
                    "executor cleanup did not settle".into()
                }),
                artifacts: Vec::new(),
            }
        }
        _ => V2AttemptRecord {
            schema_version: SchemaVersion::V2,
            cell_id: unsettled.cell_id.clone(),
            sequence: unsettled.sequence,
            started_at: unsettled.started_at,
            completed_at: now_ms,
            duration_ms,
            phase: AttemptPhase::Recovered,
            execution_outcome: ExecutionOutcome::Indeterminate,
            verifier_outcome: VerifierOutcome::Skipped,
            usage: unsettled.latest_usage.clone(),
            metering_state: unsettled.latest_metering_state,
            pricing: None,
            cleanup_state: CleanupState::Unconfirmed {
                reason: "executor cleanup did not settle".into(),
            },
            audit_state: EgressAuditState::NotRequired,
            critical_artifacts_state: CriticalArtifactsState::Present,
            cancelled_after_verification: false,
            recovered_post_hoc: true,
            failure_reason: Some("executor cleanup did not settle".into()),
            artifacts: Vec::new(),
        },
    }
}

/// Groups expanded cells by `(task.id, repetition)` in deterministic declaration order.
pub fn group_task_cells(cells: &[ExperimentCell]) -> Vec<Vec<ExperimentCell>> {
    let mut index_by_key: HashMap<(String, u32), usize> = HashMap::new();
    let mut groups: Vec<Vec<ExperimentCell>> = Vec::new();
    for cell in cells {
        let key = (cell.task.id.clone(), cell.repetition);
        if let Some(&idx) = index_by_key.get(&key) {
            groups[idx].push(cell.clone());
        } else {
            let idx = groups.len();
            index_by_key.insert(key, idx);
            groups.push(vec![cell.clone()]);
        }
    }
    groups
}

pub struct RunExperimentInput<'a> {
    pub spec: &'a ExperimentSpec,
    pub store: &'a FileAttemptStore,
    pub environment: Arc<dyn TrialEnvironment>,
    pub subjects: Vec<Arc<dyn SubjectAdapter>>,
    pub cell_ids: Option<Vec<String>>,
    pub retry_policy: RetryPolicy,
    pub cancel: CancellationToken,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl<'a> RunExperimentInput<'a> {
    pub fn new(
        spec: &'a ExperimentSpec,
        store: &'a FileAttemptStore,
        environment: Arc<dyn TrialEnvironment>,
        subjects: Vec<Arc<dyn SubjectAdapter>>,
    ) -> Self {
        Self {
            spec,
            store,
            environment,
            subjects,
            cell_ids: None,
            retry_policy: RetryPolicy::default(),
            cancel: CancellationToken::new(),
            now_ms: Arc::new(default_now_ms),
        }
    }
}

pub fn default_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub async fn run_experiment(
    input: RunExperimentInput<'_>,
) -> Result<BTreeMap<String, V1CellAttempt>, RunnerError> {
    let _writer_guard = input.store.acquire_writer()?;

    let all_cells = expand_experiment(input.spec);
    let selected_cells = select_cells(&all_cells, input.cell_ids.as_deref())?;

    if input.environment.kind() != input.spec.executor.kind {
        return Err(RunnerError::Execution("executor kind mismatch".into()));
    }

    let mut subjects_by_kind: HashMap<SubjectKind, Arc<dyn SubjectAdapter>> = HashMap::new();
    for adapter in &input.subjects {
        subjects_by_kind.insert(adapter.kind(), adapter.clone());
    }

    let credential_names: Vec<String> = {
        let mut set = BTreeSet::new();
        for s in &input.spec.subjects {
            for c in &s.credentials {
                set.insert(c.clone());
            }
        }
        set.into_iter().collect()
    };

    for cell in &selected_cells {
        input.environment.validate(cell)?;
        let Some(subject) = subjects_by_kind.get(&cell.subject.kind) else {
            return Err(RunnerError::Execution(format!(
                "missing subject adapter: {:?}",
                cell.subject.kind
            )));
        };
        subject.validate(cell)?;
    }

    recover_unsettled_attempts(input.store, &ConservativeCleanupProbe, (input.now_ms)())?;

    input
        .environment
        .preflight(&credential_names, input.cancel.clone())
        .await?;

    let groups = group_task_cells(&selected_cells);
    let max_concurrent = input.spec.execution.max_concurrent_task_groups.max(1);
    let semaphore = Arc::new(Semaphore::new(max_concurrent));
    let store_lock = Arc::new(Mutex::new(()));
    let first_error: Arc<Mutex<Option<RunnerError>>> = Arc::new(Mutex::new(None));

    let mut group_handles = Vec::with_capacity(groups.len());
    for group in groups {
        let sem = semaphore.clone();
        let env = input.environment.clone();
        let subjects_map = subjects_by_kind.clone();
        let creds = credential_names.clone();
        let cancel = input.cancel.clone();
        let now_fn = input.now_ms.clone();
        let store = input.store.clone();
        let store_mutex = store_lock.clone();
        let err_slot = first_error.clone();
        let retry_policy = input.retry_policy;

        group_handles.push(tokio::spawn(async move {
            let Ok(_permit) = sem.acquire_owned().await else {
                return;
            };
            if cancel.is_cancelled() || err_slot.lock().await.is_some() {
                return;
            }

            let mut arm_handles = Vec::with_capacity(group.len());
            for cell in group {
                let env = env.clone();
                let subject = subjects_map.get(&cell.subject.kind).unwrap().clone();
                let creds = creds.clone();
                let cancel = cancel.clone();
                let now_fn = now_fn.clone();
                let store = store.clone();
                let store_mutex = store_mutex.clone();
                let err_slot = err_slot.clone();

                arm_handles.push(tokio::spawn(async move {
                    let mut retries_used = 0u32;
                    loop {
                        if cancel.is_cancelled() {
                            return;
                        }
                        let (should_run, next_seq, started_at) = {
                            let _g = store_mutex.lock().await;
                            let mut state = match store.reconstruct_state() {
                                Ok(state) => state,
                                Err(e) => {
                                    let mut slot = err_slot.lock().await;
                                    if slot.is_none() {
                                        *slot = Some(RunnerError::Store(e));
                                    }
                                    return;
                                }
                            };
                            if cancel.is_cancelled() {
                                return;
                            }
                            if state.settled_v2.get(&cell.id).is_some_and(|records| {
                                records.iter().any(|record| {
                                    matches!(record.cleanup_state, CleanupState::Unconfirmed { .. })
                                })
                            }) {
                                return;
                            }
                            let attempts = state.settled_v1.remove(&cell.id).unwrap_or_default();
                            if select_cell_result(&attempts).is_some() {
                                (false, 0, 0)
                            } else {
                                let seq = attempts.last().map_or(1, |a| a.sequence + 1);
                                let started = now_fn();
                                let intent_id = Uuid::new_v4().to_string();
                                if let Err(e) =
                                    store.record_launch_intent(&cell.id, seq, started, &intent_id)
                                {
                                    let mut slot = err_slot.lock().await;
                                    if slot.is_none() {
                                        *slot = Some(RunnerError::Store(e));
                                    }
                                    return;
                                }
                                let trial_id = harbor_trial_name_for_attempt(&cell.id, seq);
                                if let Err(e) = store.record_resource_tagged(
                                    &cell.id,
                                    seq,
                                    env.kind(),
                                    &trial_id,
                                    None,
                                    None,
                                ) {
                                    let mut slot = err_slot.lock().await;
                                    if slot.is_none() {
                                        *slot = Some(RunnerError::Store(e));
                                    }
                                    return;
                                }
                                (true, seq, started)
                            }
                        };

                        if !should_run {
                            return;
                        }

                        let mut record = execute_cell_v2(
                            env.as_ref(),
                            subject.clone(),
                            &cell,
                            next_seq,
                            started_at,
                            &creds,
                            cancel.clone(),
                            now_fn.as_ref(),
                        )
                        .await;
                        record.completed_at = now_fn();

                        let append_res = {
                            let _g = store_mutex.lock().await;
                            store.append_v2(&record)
                        };
                        let v1 = match append_res {
                            Ok(v1) => v1,
                            Err(e) => {
                                let mut slot = err_slot.lock().await;
                                if slot.is_none() {
                                    *slot = Some(RunnerError::Store(e));
                                }
                                return;
                            }
                        };

                        match v1.result.status {
                            EvalResultStatus::Completed | EvalResultStatus::SubjectFailed => {
                                return;
                            }
                            EvalResultStatus::Indeterminate
                                if retry_policy.block_automatic_retry_on_indeterminate =>
                            {
                                return;
                            }
                            EvalResultStatus::InfraFailed | EvalResultStatus::Indeterminate => {
                                if retries_used >= retry_policy.max_infra_retries {
                                    return;
                                }
                                retries_used += 1;
                            }
                        }
                    }
                }));
            }

            for handle in arm_handles {
                let _ = handle.await;
            }
        }));
    }

    for handle in group_handles {
        let _ = handle.await;
    }

    if let Some(err) = first_error.lock().await.take() {
        return Err(err);
    }

    let mut canonical_results = BTreeMap::new();
    for cell in &all_cells {
        let attempts = input.store.list_v1(&cell.id)?;
        if let Some(selected) = select_cell_result(&attempts) {
            canonical_results.insert(cell.id.clone(), selected.clone());
        }
    }

    Ok(canonical_results)
}

#[allow(clippy::too_many_arguments)]
async fn execute_cell_v2(
    environment: &dyn TrialEnvironment,
    subject: Arc<dyn SubjectAdapter>,
    cell: &ExperimentCell,
    sequence: u32,
    started_at: u64,
    subject_credential_names: &[String],
    cancel: CancellationToken,
    now_ms: &(dyn Fn() -> u64 + Send + Sync),
) -> V2AttemptRecord {
    let cell_id = cell.id.clone();
    let cell_for_inner = cell.clone();
    let cancel_for_inner = cancel.clone();

    let env_res = environment
        .run_attempt(
            cell,
            sequence,
            subject_credential_names,
            cancel.clone(),
            Box::new(move |active_attempt| {
                Box::pin(async move {
                    let mut ctx = active_attempt.context();
                    ctx.cancel = cancel_for_inner.clone();
                    let subject_exec = subject.execute(&cell_for_inner, ctx).await;
                    let pricing = match cell_for_inner.subject.kind {
                        SubjectKind::Maka => cell_for_inner
                            .subject
                            .config
                            .get("model")
                            .and_then(serde_json::Value::as_str)
                            .map(|model| crate::contract::PricingEvidence::Model {
                                model: model.to_owned(),
                                cost_usd: subject_exec.cost_usd,
                            }),
                        SubjectKind::External => subject_exec.cost_usd.map(|cost_usd| {
                            crate::contract::PricingEvidence::SubjectReported { cost_usd }
                        }),
                    };

                    if cancel_for_inner.is_cancelled()
                        || matches!(
                            subject_exec.outcome,
                            ExecutionOutcome::InfraFailed | ExecutionOutcome::Indeterminate
                        )
                    {
                        let outcome = if cancel_for_inner.is_cancelled() {
                            ExecutionOutcome::Cancelled
                        } else {
                            subject_exec.outcome
                        };
                        return V2AttemptRecord {
                            schema_version: SchemaVersion::V2,
                            cell_id: cell_for_inner.id.clone(),
                            sequence,
                            started_at,
                            completed_at: 0,
                            duration_ms: subject_exec.duration_ms,
                            phase: AttemptPhase::AgentFinished,
                            execution_outcome: outcome,
                            verifier_outcome: VerifierOutcome::Skipped,
                            usage: subject_exec.usage,
                            metering_state: subject_exec.metering_state,
                            pricing: pricing.clone(),
                            cleanup_state: CleanupState::Confirmed,
                            audit_state: EgressAuditState::NotRequired,
                            critical_artifacts_state: CriticalArtifactsState::Present,
                            cancelled_after_verification: false,
                            recovered_post_hoc: false,
                            failure_reason: subject_exec.failure_reason,
                            artifacts: subject_exec.artifacts,
                        };
                    }

                    let verify_res = active_attempt.verify().await;
                    let (audit_state, audit_evidence) = active_attempt.read_audit().await;

                    let mut artifacts = subject_exec.artifacts;
                    match verify_res {
                        Ok(verified) => {
                            let verifier_outcome = verified.to_verifier_outcome();
                            artifacts.extend(verified.artifacts);
                            artifacts.extend(audit_evidence.artifacts);

                            let failure_reason = if verified.status == EvalResultStatus::InfraFailed
                                || verified.missing_reward
                            {
                                verified.failure_reason.or(audit_evidence.failure_reason)
                            } else {
                                subject_exec
                                    .failure_reason
                                    .or(verified.failure_reason)
                                    .or(audit_evidence.failure_reason)
                            };

                            V2AttemptRecord {
                                schema_version: SchemaVersion::V2,
                                cell_id: cell_for_inner.id.clone(),
                                sequence,
                                started_at,
                                completed_at: 0,
                                duration_ms: subject_exec.duration_ms,
                                phase: AttemptPhase::Verified,
                                execution_outcome: subject_exec.outcome,
                                verifier_outcome,
                                usage: subject_exec.usage,
                                metering_state: subject_exec.metering_state,
                                pricing: pricing.clone(),
                                cleanup_state: CleanupState::Confirmed,
                                audit_state,
                                critical_artifacts_state: CriticalArtifactsState::Present,
                                // Verification already completed; any late cancellation from here
                                // on is post-verification and must not erase the verified score!
                                cancelled_after_verification: true,
                                recovered_post_hoc: false,
                                failure_reason,
                                artifacts,
                            }
                        }
                        Err(_) => V2AttemptRecord {
                            schema_version: SchemaVersion::V2,
                            cell_id: cell_for_inner.id.clone(),
                            sequence,
                            started_at,
                            completed_at: 0,
                            duration_ms: subject_exec.duration_ms,
                            phase: AttemptPhase::AgentFinished,
                            execution_outcome: subject_exec.outcome,
                            verifier_outcome: VerifierOutcome::VerifierInfraFailed {
                                reason: "verification failed".into(),
                            },
                            usage: subject_exec.usage,
                            metering_state: subject_exec.metering_state,
                            pricing: pricing.clone(),
                            cleanup_state: CleanupState::Confirmed,
                            audit_state,
                            critical_artifacts_state: CriticalArtifactsState::Present,
                            cancelled_after_verification: false,
                            recovered_post_hoc: false,
                            failure_reason: Some("verification failed".into()),
                            artifacts,
                        },
                    }
                })
            }),
        )
        .await;

    let completed_at = now_ms();
    match env_res {
        Ok(TrialEnvironmentOutcome::Settled(mut rec)) => {
            rec.phase = AttemptPhase::Settled;
            rec.completed_at = completed_at;
            rec
        }
        Ok(TrialEnvironmentOutcome::NotStarted { code, artifacts }) => {
            let cancelled = code == ExecutorPreparationCode::Cancelled;
            V2AttemptRecord {
                schema_version: SchemaVersion::V2,
                cell_id,
                sequence,
                started_at,
                completed_at,
                duration_ms: 0,
                phase: AttemptPhase::Prepared,
                execution_outcome: if cancelled {
                    ExecutionOutcome::Cancelled
                } else {
                    ExecutionOutcome::InfraFailed
                },
                verifier_outcome: VerifierOutcome::Skipped,
                usage: None,
                metering_state: MeteringState::Unknown,
                pricing: None,
                cleanup_state: CleanupState::Confirmed,
                audit_state: EgressAuditState::NotRequired,
                critical_artifacts_state: CriticalArtifactsState::Present,
                cancelled_after_verification: false,
                recovered_post_hoc: false,
                failure_reason: Some(if cancelled {
                    "executor preparation cancelled".into()
                } else {
                    "executor preparation failed".into()
                }),
                artifacts,
            }
        }
        Ok(TrialEnvironmentOutcome::Indeterminate { cause, partial }) => {
            let reason = match cause {
                IndeterminateCause::HostCancelled => {
                    "executor cancelled before verification completed"
                }
                IndeterminateCause::CleanupUnconfirmed => "executor cleanup did not settle",
            };
            if let Some(mut rec) = partial {
                rec.completed_at = completed_at;
                if cause == IndeterminateCause::CleanupUnconfirmed {
                    rec.cleanup_state = CleanupState::Unconfirmed {
                        reason: reason.into(),
                    };
                } else {
                    rec.execution_outcome = ExecutionOutcome::Cancelled;
                    rec.cancelled_after_verification = false;
                    rec.failure_reason = Some(reason.into());
                }
                rec
            } else {
                V2AttemptRecord {
                    schema_version: SchemaVersion::V2,
                    cell_id,
                    sequence,
                    started_at,
                    completed_at,
                    duration_ms: 0,
                    phase: AttemptPhase::Settled,
                    execution_outcome: ExecutionOutcome::Indeterminate,
                    verifier_outcome: VerifierOutcome::Skipped,
                    usage: None,
                    metering_state: MeteringState::Unknown,
                    pricing: None,
                    cleanup_state: if cause == IndeterminateCause::CleanupUnconfirmed {
                        CleanupState::Unconfirmed {
                            reason: reason.into(),
                        }
                    } else {
                        CleanupState::Confirmed
                    },
                    audit_state: EgressAuditState::NotRequired,
                    critical_artifacts_state: CriticalArtifactsState::Present,
                    cancelled_after_verification: false,
                    recovered_post_hoc: false,
                    failure_reason: Some(reason.into()),
                    artifacts: Vec::new(),
                }
            }
        }
        Err(_) => V2AttemptRecord {
            schema_version: SchemaVersion::V2,
            cell_id,
            sequence,
            started_at,
            completed_at,
            duration_ms: 0,
            phase: AttemptPhase::Prepared,
            execution_outcome: ExecutionOutcome::InfraFailed,
            verifier_outcome: VerifierOutcome::Skipped,
            usage: None,
            metering_state: MeteringState::Unknown,
            pricing: None,
            cleanup_state: CleanupState::Confirmed,
            audit_state: EgressAuditState::NotRequired,
            critical_artifacts_state: CriticalArtifactsState::Present,
            cancelled_after_verification: false,
            recovered_post_hoc: false,
            failure_reason: Some("executor preparation failed".into()),
            artifacts: Vec::new(),
        },
    }
}

fn select_cells(
    cells: &[ExperimentCell],
    selected_ids: Option<&[String]>,
) -> Result<Vec<ExperimentCell>, ContractError> {
    let Some(ids) = selected_ids else {
        return Ok(cells.to_vec());
    };
    let known: BTreeSet<&str> = cells.iter().map(|c| c.id.as_str()).collect();
    let mut filter = BTreeSet::new();
    for id in ids {
        if !known.contains(id.as_str()) {
            return Err(ContractError::Invalid(format!(
                "unknown experiment cell: {id}"
            )));
        }
        filter.insert(id.as_str());
    }
    Ok(cells
        .iter()
        .filter(|c| filter.contains(c.id.as_str()))
        .cloned()
        .collect())
}
