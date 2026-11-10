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

use super::*;
use maka_agent_engine::Engine;
use maka_agent_facts::durable::{ExternalTaskId, RunId};
use maka_agent_state::{DriverClaim, DriverPurpose};

pub(super) struct DriverActivity(pub DriverClaim);

// Version 1 covers only this Host's model reader and in-process material. It
// says nothing about tools, Cells, descendants, remote jobs, or model results.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelReader {
    version: u32,
    owner: maka_agent_facts::durable::RunOwner,
    execution: maka_agent_facts::durable::ExecutionIdentity,
    step: maka_agent_facts::durable::StepId,
    attempt: maka_agent_facts::durable::ModelAttemptId,
    source: maka_agent_facts::composition::SourceRevision,
    process: maka_process::lifetime::ProcessIdentity,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelAdmission {
    request: maka_agent_facts::durable::ContentRef,
    native_reader: ModelReader,
}

pub(super) fn model_admission(
    owner: &Owner,
    execution: &maka_agent_facts::durable::ExecutionIdentity,
    attempt: maka_agent_facts::durable::ModelAttemptId,
    request: &maka_agent_facts::durable::RequestSpec,
) -> Result<serde_json::Value, maka_agent_engine::RunError> {
    serde_json::to_value(ModelAdmission {
        request: request.request.clone(),
        native_reader: ModelReader {
            version: 1,
            owner: owner.run_owner(),
            execution: execution.clone(),
            step: request.step,
            attempt,
            source: owner.revision.clone(),
            process: owner.model_reader_process.clone(),
        },
    })
    .map_err(maka_agent_engine::RunError::Json)
}

fn original_reader(
    owner: &Owner,
    original: &maka_agent_state::ModelCleanupItem,
) -> Result<ModelAdmission, maka_agent_engine::RunError> {
    let admission: ModelAdmission =
        serde_json::from_value(original.upstream.clone()).map_err(|_| unavailable_reader())?;
    let reader = &admission.native_reader;
    if reader.version != 1
        || reader.owner != original.owner
        || reader.owner != owner.run_owner()
        || reader.execution != original.execution
        || reader.step != original.step
        || reader.attempt != original.attempt
        || admission.request != original.request
        || !owner.owns(&reader.execution.session_id)
        || reader.source.kind != owner.revision.kind
        || reader.source.name != owner.revision.name
        || reader.source.package_id != owner.revision.package_id
        || reader.source.entry_id != owner.revision.entry_id
    {
        return Err(unavailable_reader());
    }
    Ok(admission)
}

fn unavailable_reader() -> maka_agent_engine::RunError {
    maka_agent_engine::RunError::ModelUnavailable
}

pub(super) fn validate_model_reader_start(
    owner: &Owner,
    view: &maka_agent_state::fold::RunView,
    attempt: maka_agent_facts::durable::ModelAttemptId,
    request: &maka_agent_facts::durable::RequestSpec,
) -> Result<(), maka_agent_engine::RunError> {
    let admitted = view
        .attempts
        .get(&attempt)
        .and_then(|attempt| attempt.admission.as_ref())
        .ok_or_else(unavailable_reader)?;
    let original = maka_agent_state::ModelCleanupItem {
        owner: view.spec.owner.clone(),
        execution: maka_agent_facts::durable::ExecutionIdentity {
            run_id: view.run,
            session_id: view.spec.session_id.clone(),
            turn_id: view.spec.turn_id.clone(),
        },
        attempt,
        step: request.step,
        request: request.request.clone(),
        upstream: admitted.upstream.clone(),
    };
    let admission = original_reader(owner, &original)?;
    if admission.native_reader.process != owner.model_reader_process
        || admission.native_reader.source != owner.revision
    {
        return Err(unavailable_reader());
    }
    Ok(())
}

struct ModelReaderCleanup {
    owner: Arc<Owner>,
}
impl maka_agent_engine::ports::ModelCleanupPorts for ModelReaderCleanup {
    fn now(&self) -> maka_agent_facts::durable::UnixMillis {
        maka_agent_facts::durable::UnixMillis(now() as i64)
    }
    fn observe<'a>(
        &'a self,
        original: &'a maka_agent_state::ModelCleanupItem,
    ) -> BoxFuture<
        'a,
        Result<maka_plugin_core::operation::OperationCleanup, maka_agent_engine::RunError>,
    > {
        Box::pin(async move {
            let reader = original_reader(&self.owner, original)?.native_reader;
            let process = reader.process;
            tokio::task::spawn_blocking(move || {
                match maka_process::lifetime::observe(&process).map_err(|_| unavailable_reader())? {
                    maka_process::lifetime::ProcessObservation::Gone(proof)
                        if proof.identity() == &process =>
                    {
                        Ok(maka_plugin_core::operation::OperationCleanup::Confirmed)
                    }
                    _ => Err(unavailable_reader()),
                }
            })
            .await
            .map_err(|_| unavailable_reader())?
        })
    }
}
impl Drop for DriverActivity {
    fn drop(&mut self) {
        self.0.deactivate();
    }
}

impl Owner {
    pub(super) async fn reconcile_model_readers(
        self: &Arc<Self>,
        cold_probe: bool,
    ) -> Result<(), String> {
        let mut after = None;
        loop {
            if self.stop.is_cancelled() {
                return Ok(());
            }
            let page = self
                .durable
                .model_reconciliation_runs(self.run_owner(), after, 64, cold_probe)
                .await
                .map_err(|_| "model_cleanup_candidates_failed".to_owned())?;
            if page.is_empty() {
                return Ok(());
            }
            for candidate in page {
                after = Some(candidate.admission_sequence);
                {
                    let runs = self.runs.state().await;
                    if runs.closing || runs.busy(&candidate.session_id) {
                        continue;
                    }
                }
                let Some(claim) = self
                    .durable
                    .reserve_driver(
                        candidate.run,
                        DriverPurpose::LateModelCleanup,
                        self.stop.clone(),
                    )
                    .await
                    .map_err(|_| "model_cleanup_claim_failed".to_owned())?
                else {
                    continue;
                };
                let activity = DriverActivity(claim.clone());
                let result = Engine::new(self.durable.clone())
                    .drive_model_cleanup(
                        claim,
                        Arc::new(ModelReaderCleanup {
                            owner: self.clone(),
                        }),
                        self.stop.clone(),
                        cold_probe,
                    )
                    .await;
                let unavailable = matches!(
                    &result,
                    Err(RunError::Blocked(
                        maka_agent_facts::durable::BlockerKind::ModelCleanupUnconfirmed { .. }
                    ))
                );
                if result.is_err() && !unavailable {
                    return Err("model_cleanup_reconciliation_failed".into());
                }
                if result.is_err() {
                    tracing::debug!(stage = "model_cleanup_source_unavailable", run_id = %candidate.run, "Original model cleanup source is unavailable");
                }
                drop(activity);
                if self.stop.is_cancelled() {
                    return Ok(());
                }
                let Some(claim) = self
                    .durable
                    .reserve_driver(candidate.run, DriverPurpose::Business, self.stop.clone())
                    .await
                    .map_err(|_| "model_settlement_claim_failed".to_owned())?
                else {
                    continue;
                };
                let activity = DriverActivity(claim.clone());
                let engine = Engine::new(self.durable.clone());
                if unavailable {
                    engine
                        .block_unavailable_model_cleanups(
                            &claim,
                            maka_agent_facts::durable::UnixMillis(now() as i64),
                        )
                        .await
                        .map_err(|_| "model_cleanup_blocker_publication_failed")?;
                }
                let result = engine
                    .settle_closed_model(claim, maka_agent_facts::durable::UnixMillis(now() as i64))
                    .await;
                drop(activity);
                if result.is_err() {
                    return Err("model_canonical_settlement_failed".into());
                }
            }
        }
    }

    pub(super) async fn wake_cleanup(
        self: &Arc<Self>,
        run: RunId,
        session: String,
        task: ExternalTaskId,
    ) -> Result<(), String> {
        {
            let runs = self.runs.state().await;
            if runs.closing {
                return Ok(());
            }
        }
        let cancellation = self.stop.child_token();
        let Some(claim) = self
            .durable
            .reserve_driver(
                run,
                DriverPurpose::LateExternalCleanup { task },
                cancellation.clone(),
            )
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(());
        };
        let current = self
            .durable
            .cleanup_frontier(&claim)
            .await
            .map_err(|error| error.to_string())?;
        if current.owner != self.run_owner() || current.session_id != session {
            claim.deactivate();
            return Err("foreign cleanup owner".into());
        }
        let runs = self.runs.state().await;
        if runs.closing {
            claim.deactivate();
            return Ok(());
        }
        let owner = self.clone();
        self.cleanup_workers.spawn(async move {
            let activity = DriverActivity(claim.clone());
            let ports = owner.cleanup_ports(claim.clone());
            let result = Engine::new(owner.durable.clone())
                .drive_cleanup(claim, ports, cancellation)
                .await;
            let changed = matches!(
                &result,
                Ok(maka_agent_engine::DriverExit::Retired { .. })
                    | Ok(maka_agent_engine::DriverExit::Waiting { due_at: None, .. })
            );
            if let Err(error) = result {
                tracing::error!(%run, %error, "Original task cleanup observer stopped");
            }
            drop(activity);
            if changed {
                owner.physical_availability_changed();
            }
        });
        drop(runs);
        Ok(())
    }
}
