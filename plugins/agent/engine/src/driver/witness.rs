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

use super::{PendingPublication, PublicationResolution};
use crate::{
    RunError,
    ports::{ExternalObservation, RecoveryEvidence},
};
use maka_agent_facts::{
    accounting::Outcome,
    durable::{ExternalTaskId, Fact, FactId, ModelAttemptId, RunId, UnixMillis},
    external_publication::{
        ExternalPublicationEvent, ExternalPublicationKey, ExternalPublicationOutcome,
    },
    model::{ModelPart, ModelUsage},
};
use maka_agent_state::{Change, ContentBlob, DriverClaim, Head, Store};
use maka_event_log::{StoreError, root_store::DataWriter};
use maka_plugin_core::operation::{OperationCleanup, OperationReply, RecoveryRef};
use serde_json::Value;
use std::{sync::Arc, time::Duration};

/// One original source observation, frozen before its first publication attempt.
#[derive(Clone)]
pub struct ModelCleanupPublication {
    store: Store,
    publication: Arc<PendingPublication>,
}

impl ModelCleanupPublication {
    pub(super) fn claimed(
        store: Store,
        claim: DriverClaim,
        head: Head,
        attempt: ModelAttemptId,
        at: UnixMillis,
    ) -> Result<Self, RunError> {
        if claim.purpose() != maka_agent_state::DriverPurpose::LateModelCleanup {
            return Err(RunError::InvalidInput("not a model cleanup claim".into()));
        }
        Ok(Self {
            store,
            publication: Arc::new(PendingPublication {
                run: claim.run(),
                claim: Some(claim),
                head,
                changes: vec![Change::new(
                    Fact::ModelCleanupObserved {
                        attempt,
                        cleanup: OperationCleanup::Confirmed,
                    },
                    at,
                )],
                contents: vec![],
                steering: None,
            }),
        })
    }
    pub fn fact_id(&self) -> FactId {
        self.publication.changes[0].id
    }

    pub(super) async fn reconcile_claimed(&self) -> Result<FactId, RunError> {
        let result = self.publication.reconcile(&self.store).await;
        match settle_result(&self.store, &self.publication, result).await? {
            PublicationResolution::Committed(_) => Ok(self.fact_id()),
            PublicationResolution::NotCommitted => Err(RunError::Internal(
                "original model cleanup publication fenced".into(),
            )),
        }
    }

    pub async fn reconcile(&self) -> Result<FactId, RunError> {
        match self.publication.reconcile(&self.store).await? {
            PublicationResolution::Committed(_) => Ok(self.fact_id()),
            PublicationResolution::NotCommitted => Err(RunError::Internal(
                "model source cleanup observation unexpectedly fenced".into(),
            )),
        }
    }
}

impl std::fmt::Debug for ModelCleanupPublication {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelCleanupPublication")
            .field("publication", &self.publication)
            .finish()
    }
}

/// Publication capability for one admitted original model source. The source
/// owner retains this independently of the driver's notification stream and
/// keeps publication futures alive through receipt settlement, even after the
/// observer disconnects or requests cancellation.
#[derive(Clone)]
pub struct ModelWitness {
    store: Store,
    claim: DriverClaim,
    attempt: ModelAttemptId,
}

impl ModelWitness {
    pub(super) fn new(store: Store, claim: DriverClaim, attempt: ModelAttemptId) -> Self {
        Self {
            store,
            claim,
            attempt,
        }
    }

    /// Bind the source's already-admitted writer, preserving actual Root affinity.
    pub fn with_data_writer(&self, actual: DataWriter) -> Result<Self, StoreError> {
        Ok(Self {
            store: self.store.with_data_writer(actual)?,
            claim: self.claim.clone(),
            attempt: self.attempt,
        })
    }

    pub async fn part(
        &self,
        index: u64,
        part: ModelPart,
        continuation: Option<ContentBlob>,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        let proof = continuation.as_ref().map(|blob| blob.reference().clone());
        self.observe(
            vec![Change::new(
                Fact::ModelObserved {
                    attempt: self.attempt,
                    index,
                    part,
                    continuation: proof,
                },
                at,
            )],
            continuation.into_iter().collect(),
        )
        .await
    }

    /// Publish only a real upstream terminal receipt, not a local transport end,
    /// timeout, cancellation request or truncated stream.
    pub async fn closed(
        &self,
        outcome: Outcome,
        diagnostic: Option<String>,
        usage: ModelUsage,
        protocol: Value,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.closed_with_parts(vec![], outcome, diagnostic, usage, protocol, at)
            .await
    }

    /// Whole-response adapters publish their buffered calls and actual finish
    /// together. Independently accepted streaming items still use `part`.
    pub async fn closed_with_parts(
        &self,
        parts: Vec<(u64, ModelPart, Option<ContentBlob>)>,
        outcome: Outcome,
        diagnostic: Option<String>,
        usage: ModelUsage,
        protocol: Value,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.closed_material(parts, outcome, diagnostic, usage, protocol, None, at)
            .await
    }

    pub async fn closed_with_private(
        &self,
        outcome: Outcome,
        diagnostic: Option<String>,
        usage: ModelUsage,
        protocol: Value,
        partial: Option<ContentBlob>,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.closed_material(vec![], outcome, diagnostic, usage, protocol, partial, at)
            .await
    }

    /// Freeze the original partial fact and content once; its owner may retain
    /// this publication through SQL failure without replacing the observation.
    pub fn prepare_private_partial(
        &self,
        partial: ContentBlob,
        at: UnixMillis,
    ) -> ModelCleanupPublication {
        ModelCleanupPublication {
            store: self.store.clone(),
            publication: Arc::new(PendingPublication {
                run: self.claim.run(),
                claim: None,
                head: Head {
                    revision: 0,
                    control_version: 0,
                },
                changes: vec![Change::new(
                    Fact::ModelPrivatePartialCaptured {
                        attempt: self.attempt,
                        partial: partial.reference().clone(),
                    },
                    at,
                )],
                contents: vec![partial],
                steering: None,
            }),
        }
    }

    pub async fn private_partial(
        &self,
        partial: ContentBlob,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        let change = Change::new(
            Fact::ModelPrivatePartialCaptured {
                attempt: self.attempt,
                partial: partial.reference().clone(),
            },
            at,
        );
        self.observe(vec![change], vec![partial]).await
    }

    pub async fn source_failure(
        &self,
        failure: ContentBlob,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        let change = Change::new(
            Fact::ModelSourceFailureCaptured {
                attempt: self.attempt,
                failure: failure.reference().clone(),
            },
            at,
        );
        self.observe(vec![change], vec![failure]).await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Canonical closure publishes protocol, usage, partial material and original observations in one fact"
    )]
    async fn closed_material(
        &self,
        parts: Vec<(u64, ModelPart, Option<ContentBlob>)>,
        outcome: Outcome,
        diagnostic: Option<String>,
        usage: ModelUsage,
        protocol: Value,
        partial: Option<ContentBlob>,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        let tokens = usage
            .input_tokens
            .unwrap_or(0)
            .checked_add(usage.output_tokens.unwrap_or(0))
            .ok_or_else(|| RunError::Internal("model usage overflow".into()))?;
        let mut changes = Vec::with_capacity(parts.len() + 2);
        let mut contents = Vec::new();
        for (index, part, continuation) in parts {
            changes.push(Change::new(
                Fact::ModelObserved {
                    attempt: self.attempt,
                    index,
                    part,
                    continuation: continuation.as_ref().map(|blob| blob.reference().clone()),
                },
                at,
            ));
            contents.extend(continuation);
        }
        let closed = Change::new(
            Fact::ModelClosed {
                attempt: self.attempt,
                outcome,
                diagnostic,
                usage,
                protocol,
            },
            at,
        );
        let id = closed.id;
        changes.push(closed);
        if let Some(partial) = partial {
            changes.push(Change::new(
                Fact::ModelPrivatePartialCaptured {
                    attempt: self.attempt,
                    partial: partial.reference().clone(),
                },
                at,
            ));
            contents.push(partial);
        }
        changes.push(Change::new(Fact::BudgetCharged { tokens }, at));
        self.observe(changes, contents).await?;
        Ok(id)
    }

    pub fn prepare_cleanup(
        &self,
        cleanup: OperationCleanup,
        at: UnixMillis,
    ) -> ModelCleanupPublication {
        ModelCleanupPublication {
            store: self.store.clone(),
            publication: Arc::new(PendingPublication {
                run: self.claim.run(),
                claim: None,
                head: Head {
                    revision: 0,
                    control_version: 0,
                },
                changes: vec![Change::new(
                    Fact::ModelCleanupObserved {
                        attempt: self.attempt,
                        cleanup,
                    },
                    at,
                )],
                contents: vec![],
                steering: None,
            }),
        }
    }

    /// Record actual source cleanup independently of its upstream terminal receipt.
    pub async fn cleanup(
        &self,
        cleanup: OperationCleanup,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.observe(
            vec![Change::new(
                Fact::ModelCleanupObserved {
                    attempt: self.attempt,
                    cleanup,
                },
                at,
            )],
            vec![],
        )
        .await
    }

    /// Local assessment is claim/head fenced, never late source evidence.
    /// `None` means it was not recorded; keep observing the original source.
    pub async fn recovery(
        &self,
        evidence: RecoveryEvidence,
        at: UnixMillis,
    ) -> Result<Option<FactId>, RunError> {
        let head = Head::from(&self.store.frontier(self.claim.run()).await?);
        let change = Change::new(
            Fact::AttemptRecoveryRecorded {
                attempt: self.attempt,
                recovery: evidence.recovery,
            },
            at,
        );
        let id = change.id;
        let publication = PendingPublication {
            run: self.claim.run(),
            claim: Some(self.claim.clone()),
            head,
            changes: vec![change],
            contents: evidence.contents,
            steering: None,
        };
        match settle(&self.store, &publication).await? {
            PublicationResolution::Committed(_) => Ok(Some(id)),
            PublicationResolution::NotCommitted => Ok(None),
        }
    }

    async fn observe(
        &self,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
    ) -> Result<FactId, RunError> {
        let id = changes[0].id;
        let publication = PendingPublication {
            run: self.claim.run(),
            claim: None,
            // Observation submission ignores Head: genuine source evidence is
            // accepted after driver replacement and does not require a read/CAS.
            head: Head {
                revision: 0,
                control_version: 0,
            },
            changes,
            contents,
            steering: None,
        };
        match settle(&self.store, &publication).await? {
            PublicationResolution::Committed(_) => Ok(id),
            PublicationResolution::NotCommitted => Err(RunError::Internal(
                "model source observation unexpectedly fenced".into(),
            )),
        }
    }
}

/// Publication capability for one admitted original external task. Its source
/// owner keeps publication futures alive independently of notification delivery.
#[derive(Clone)]
pub struct ExternalWitness {
    store: Store,
    run: RunId,
    task: ExternalTaskId,
}

impl ExternalWitness {
    pub(super) fn new(store: Store, run: RunId, task: ExternalTaskId) -> Self {
        Self { store, run, task }
    }

    pub fn with_data_writer(&self, actual: DataWriter) -> Result<Self, StoreError> {
        Ok(Self {
            store: self.store.with_data_writer(actual)?,
            run: self.run,
            task: self.task,
        })
    }

    pub async fn record(
        &self,
        index: u64,
        observation: ExternalObservation,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        let publication = self.prepare(index, observation, at);
        match settle(&self.store, &publication).await? {
            PublicationResolution::Committed(_) => Ok(publication.changes[0].id),
            PublicationResolution::NotCommitted => Err(RunError::Internal(
                "external source observation unexpectedly fenced".into(),
            )),
        }
    }

    pub fn prepare_cleanup(
        &self,
        cleanup: OperationCleanup,
        at: UnixMillis,
    ) -> ExternalCleanupPublication {
        ExternalCleanupPublication {
            store: self.store.clone(),
            publication: self.prepare(0, ExternalObservation::Cleanup { cleanup }, at),
        }
    }

    fn prepare(
        &self,
        index: u64,
        observation: ExternalObservation,
        at: UnixMillis,
    ) -> PendingPublication {
        let task = self.task;
        let (facts, contents) = match observation {
            ExternalObservation::Bound { descriptor } => (
                vec![Fact::ExternalTaskBound {
                    task,
                    descriptor: descriptor.reference().clone(),
                }],
                vec![descriptor],
            ),
            ExternalObservation::Output(output) => (
                vec![Fact::ExternalTaskObserved {
                    task,
                    index,
                    output,
                }],
                vec![],
            ),
            ExternalObservation::Closed {
                outcome,
                diagnostic,
                final_message,
                publication,
            } => {
                let mut facts = vec![Fact::ExternalTaskClosed {
                    task,
                    outcome,
                    diagnostic,
                    final_message,
                }];
                let mut contents = vec![];
                if let Some(pending) = publication {
                    facts.push(Fact::ExternalPublication {
                        event: ExternalPublicationEvent::Pending {
                            id: pending.publication,
                            task,
                            source: pending.source.reference().clone(),
                        },
                    });
                    contents.push(pending.source);
                }
                (facts, contents)
            }
            ExternalObservation::Cleanup { cleanup } => (
                vec![Fact::ExternalTaskCleanupObserved { task, cleanup }],
                vec![],
            ),
        };
        let changes: Vec<_> = facts
            .into_iter()
            .map(|fact| Change::new(fact, at))
            .collect();
        PendingPublication {
            run: self.run,
            claim: None,
            // Late source observations do not use a driver Head/CAS.
            head: Head {
                revision: 0,
                control_version: 0,
            },
            changes,
            contents,
            steering: None,
        }
    }
}

/// One frozen source-cleanup observation and its original accepted writer.
pub struct ExternalCleanupPublication {
    store: Store,
    publication: PendingPublication,
}
impl ExternalCleanupPublication {
    pub fn fact_id(&self) -> FactId {
        self.publication.changes[0].id
    }

    pub async fn record(&self) -> Result<FactId, RunError> {
        match settle(&self.store, &self.publication).await? {
            PublicationResolution::Committed(_) => Ok(self.fact_id()),
            PublicationResolution::NotCommitted => Err(RunError::Internal(
                "external source cleanup observation unexpectedly fenced".into(),
            )),
        }
    }

    pub async fn reconcile(&self) -> Result<FactId, RunError> {
        let result = self.publication.reconcile(&self.store).await;
        match settle_result(&self.store, &self.publication, result).await? {
            PublicationResolution::Committed(_) => Ok(self.fact_id()),
            PublicationResolution::NotCommitted => Err(RunError::Internal(
                "external source cleanup observation unexpectedly fenced".into(),
            )),
        }
    }
}

#[derive(Clone)]
pub struct PublicationWitness {
    store: Store,
    run: RunId,
    key: ExternalPublicationKey,
}
impl PublicationWitness {
    pub(super) fn new(store: Store, run: RunId, key: ExternalPublicationKey) -> Self {
        Self { store, run, key }
    }
    pub fn with_data_writer(&self, actual: DataWriter) -> Result<Self, StoreError> {
        Ok(Self {
            store: self.store.with_data_writer(actual)?,
            run: self.run,
            key: self.key,
        })
    }
    pub async fn bound(&self, original: RecoveryRef, at: UnixMillis) -> Result<FactId, RunError> {
        self.record(
            ExternalPublicationEvent::Bound {
                key: self.key,
                original,
            },
            at,
        )
        .await
    }
    pub async fn observed(
        &self,
        observation: OperationReply,
        outcome: ExternalPublicationOutcome,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.record(
            ExternalPublicationEvent::Observed {
                key: self.key,
                observation,
                outcome,
            },
            at,
        )
        .await
    }
    pub async fn prevented_before_host_admission(
        &self,
        diagnostic: String,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.record(
            ExternalPublicationEvent::PreventedBeforeHostAdmission {
                key: self.key,
                diagnostic,
            },
            at,
        )
        .await
    }
    pub async fn cleanup(
        &self,
        cleanup: OperationCleanup,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.record(
            ExternalPublicationEvent::CleanupObserved {
                key: self.key,
                cleanup,
            },
            at,
        )
        .await
    }
    // Only the owner of a newly acknowledged T1 may use this before calling
    // Native dispatch. Validation allocates no per-item physical resources.
    pub(super) async fn prevented_before_dispatch(
        &self,
        diagnostic: String,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.record_all(
            vec![
                ExternalPublicationEvent::PreventedBeforeHostAdmission {
                    key: self.key,
                    diagnostic,
                },
                ExternalPublicationEvent::CleanupObserved {
                    key: self.key,
                    cleanup: OperationCleanup::Confirmed,
                },
            ],
            at,
        )
        .await
    }
    async fn record(
        &self,
        event: ExternalPublicationEvent,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        self.record_all(vec![event], at).await
    }
    async fn record_all(
        &self,
        events: Vec<ExternalPublicationEvent>,
        at: UnixMillis,
    ) -> Result<FactId, RunError> {
        let changes: Vec<_> = events
            .into_iter()
            .map(|event| Change::new(Fact::ExternalPublication { event }, at))
            .collect();
        let id = changes[0].id;
        let publication = PendingPublication {
            run: self.run,
            claim: None,
            head: Head {
                revision: 0,
                control_version: 0,
            },
            changes,
            contents: vec![],
            steering: None,
        };
        match settle(&self.store, &publication).await? {
            PublicationResolution::Committed(_) => Ok(id),
            PublicationResolution::NotCommitted => unreachable!(
                "original publication evidence is late, never a discarded policy decision"
            ),
        }
    }
}

async fn settle(
    store: &Store,
    publication: &PendingPublication,
) -> Result<PublicationResolution, RunError> {
    let result = match publication.submit(store).await {
        Ok(commit) => Ok(PublicationResolution::Committed(commit)),
        Err(source)
            if publication.claim.is_some()
                && matches!(
                    source.underlying(),
                    StoreError::RevisionConflict { .. } | StoreError::InvalidTransition(_)
                ) =>
        {
            // Only common reconciliation can prove that the original IDs
            // are absent and this claim/head is fenced. Do not infer that
            // from an InvalidTransition diagnostic.
            publication.reconcile(store).await
        }
        Err(source) => Err(source),
    };
    settle_result(store, publication, result).await
}

pub(super) async fn settle_result(
    store: &Store,
    publication: &PendingPublication,
    mut result: Result<PublicationResolution, StoreError>,
) -> Result<PublicationResolution, RunError> {
    let mut delay = Duration::from_millis(25);
    loop {
        match result {
            Ok(resolution) => return Ok(resolution),
            Err(source)
                if matches!(
                    source.underlying(),
                    StoreError::CommitUnknown(_) | StoreError::OperationUnknown
                ) =>
            {
                // Settle this exact receipt while retaining its IDs and
                // content. Never repeat source normalization or generation.
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(1));
                result = publication.reconcile(store).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        DriverExit, Engine,
        reconcile::tests::{apply_policy_fact, model_closure, policy_view},
    };
    use futures_util::FutureExt;
    use maka_agent_facts::{
        context::ModelPurpose,
        durable::*,
        input::RunInput,
        model::{ModelFinishReason, ModelToolCall, ToolInput},
    };
    use maka_agent_state::{Admission, DriverDomain, fold::tool_key};
    use maka_event_log::{
        root::{RootNamespaces, RootOwner},
        root_store::RootStore,
    };
    use std::panic::AssertUnwindSafe;
    type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
    fn at() -> UnixMillis {
        UnixMillis(1)
    }

    // Real Root/Store and original witness; typed model facts only, no provider/VM execution.
    async fn fixture(
        admit_main: bool,
    ) -> TestResult<(
        tempfile::TempDir,
        RootStore,
        Store,
        DriverClaim,
        ModelAttemptId,
        ModelWitness,
    )> {
        let temp = tempfile::tempdir()?;
        let base = temp.path().to_path_buf();
        let owner = tokio::task::spawn_blocking(move || {
            RootOwner::create(
                &base.join("root"),
                &RootNamespaces {
                    ownership: base.join("owners"),
                    control: base.join("control"),
                },
            )
        })
        .await??;
        let mut migrations = maka_event_log::ROOT_MIGRATIONS.to_vec();
        migrations.extend_from_slice(maka_agent_state::MIGRATIONS);
        let root = RootStore::open(Arc::new(owner), &migrations).await?;
        let data = root.data_writer()?;
        let store = Store::new(data.clone(), DriverDomain::new(data)?)?;
        let mut policy = policy_view(None);
        let empty = ContentBlob::new(vec![]);
        let input = ContentBlob::json(&RunInput::Message {
            content: "original provider recovery fixture".to_string().into(),
            request_fingerprint: None,
            source_messages: vec![],
        })?;
        policy.spec.input = input.reference().clone();
        let spec = ContentBlob::json(&policy.spec)?;
        apply_policy_fact(
            &mut policy,
            Fact::RunAdmitted {
                spec: spec.reference().clone(),
            },
        );
        // Reuse only its typed request; the Store below never receives that helper's closure.
        let (_, mut request, attempt) = model_closure(
            policy.clone(),
            ModelPurpose::Main,
            ModelFinishReason::Stop,
            Outcome::Success,
            false,
        );
        let admission = Admission::new(policy.spec, at(), vec![empty, input]);
        let run = admission.run();
        store.admit(admission).await?;
        let claim = store.claim(run).await?;
        let provenance = ContentBlob::json(&serde_json::json!({
            "estimatedInputTokens": 0,
            "breakdown": maka_agent_facts::context::PreparedContextBreakdown::default(),
            "modelContext": null,
            "previousCheckpointId": null,
        }))?;
        request.provenance = provenance.reference().clone();
        let encoded = ContentBlob::json(&request)?;
        let mut changes = vec![Fact::StepPrepared {
            step: request.step,
            request: encoded.reference().clone(),
            adjudications: vec![],
        }];
        if admit_main {
            changes.extend([
                Fact::ModelAttemptPrepared {
                    attempt,
                    step: request.step,
                },
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: serde_json::json!({"typed":"original-model-source"}),
                },
            ]);
        }
        append(&store, &claim, changes, vec![encoded, provenance]).await?;
        let witness = ModelWitness::new(store.clone(), claim.clone(), attempt);
        Ok((temp, root, store, claim, attempt, witness))
    }

    #[tokio::test]
    async fn deterministic_preparation_failure_closes_run_but_temporary_contention_does_not()
    -> TestResult<()> {
        let (_temp, root, store, claim, _, witness) = fixture(false).await?;
        let engine = Engine::new(store.clone());
        let run = claim.run();
        let view = store.frontier(run).await?;
        let transient = std::io::Error::from(std::io::ErrorKind::WouldBlock);
        assert!(matches!(
            engine.preparation_failure(&claim, &view, transient.into(), at()).await,
            Err(RunError::Preparation(error)) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
        assert!(store.frontier(run).await?.terminal.is_none());

        engine
            .preparation_failure(
                &claim,
                &view,
                RunError::PreparationLimit("fixture preparation limit"),
                at(),
            )
            .await?;
        assert_eq!(store.frontier(run).await?.terminal, Some(Terminal::Failed));
        drop((witness, claim, engine, store));
        root.shutdown().await?;
        Ok(())
    }

    async fn append(
        store: &Store,
        claim: &DriverClaim,
        facts: Vec<Fact>,
        contents: Vec<ContentBlob>,
    ) -> TestResult<()> {
        let view = store.frontier(claim.run()).await?;
        store
            .append(
                claim,
                (&view).into(),
                facts
                    .into_iter()
                    .map(|fact| Change::new(fact, at()))
                    .collect(),
                contents,
            )
            .await?;
        Ok(())
    }
    fn call(attempt: ModelAttemptId) -> (ToolKey, ModelPart) {
        let key = ToolKey {
            attempt,
            call: "server-side-effect".into(),
        };
        let part = ModelPart::ToolCall {
            call: ModelToolCall {
                id: key.call.clone(),
                name: "server_tool".into(),
                input: ToolInput::Json(serde_json::json!({})),
                provider_options: None,
                provider_executed: true,
            },
        };
        (key, part)
    }
    #[tokio::test]
    async fn unobservable_provider_effect_fails_without_inventing_a_result() -> TestResult<()> {
        let (_temp, root, store, claim, attempt, witness) = fixture(true).await?;
        let result = AssertUnwindSafe(async {
            let (tool, part) = call(attempt);
            witness.part(0, part, None, at()).await?;
            let blocker = BlockerId::new();
            let reason = BlockerKind::ProviderEffectUnknown {
                attempt,
                call: tool.call.clone(),
            };
            append(
                &store,
                &claim,
                vec![Fact::Blocked {
                    blocker,
                    reason: reason.clone(),
                }],
                vec![],
            )
            .await?;

            let exit = Engine::new(store.clone())
                .current_authority_unavailable(
                    claim.clone(),
                    AuthorityStage::BackendScope,
                    "provider no longer accessible".into(),
                    at(),
                )
                .await?;
            assert!(matches!(
                exit,
                DriverExit::Terminal {
                    terminal: Terminal::Failed,
                    ..
                }
            ));

            let view = store.frontier(claim.run()).await?;
            assert_eq!(view.recovery_failure(), Some(&reason));
            assert!(view.has_unsettled_recovery());
            let mut successor = view.spec.clone();
            successor.turn_id = uuid::Uuid::new_v4().to_string();
            let error = store
                .admit(Admission::new(successor, at(), vec![]))
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("previous Run has unsettled original operations")
            );
            let observed = &view.tools[&tool_key(&tool)];
            assert!(observed.provider_result.is_none() && observed.accepted.is_none());
            let history = store.history(claim.run(), 0, 32).await?;
            assert_eq!(
                history
                    .iter()
                    .filter(|f| matches!(f.fact, Fact::ModelAttemptAdmitted { .. }))
                    .count(),
                1
            );
            assert!(matches!(
                history.last().map(|f| &f.fact),
                Some(Fact::RunTerminated {
                    terminal: Terminal::Failed,
                    ..
                })
            ));
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
        })
        .catch_unwind()
        .await;
        root.shutdown().await?;
        match result {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    #[tokio::test]
    async fn deferred_compaction_reads_summary_without_reopening_protocol_blockers()
    -> TestResult<()> {
        use maka_agent_facts::context::{ModelClosureProtocol, SummaryResult, TextSummary};
        let (_temp, root, store, claim, _, _) = fixture(false).await?;
        let result = AssertUnwindSafe(async {
            let run = claim.run();
            let view = store.frontier(run).await?;
            let mut main = store
                .request(run, view.current_step.ok_or("missing Main")?)
                .await?;
            let mut summary = main.clone();
            summary.step = StepId::new();
            summary.accounting.purpose = ModelPurpose::Summary;
            let encoded = ContentBlob::json(&summary)?;
            let attempt = ModelAttemptId::new();
            let summary_result = SummaryResult::Text {
                summary: TextSummary {
                    text: "prior work".into(),
                },
            };
            append(
                &store,
                &claim,
                vec![
                    Fact::StepPrepared {
                        step: summary.step,
                        request: encoded.reference().clone(),
                        adjudications: vec![],
                    },
                    Fact::ModelAttemptPrepared {
                        attempt,
                        step: summary.step,
                    },
                    Fact::ModelAttemptAdmitted {
                        attempt,
                        upstream: serde_json::Value::Null,
                    },
                    Fact::ModelClosed {
                        attempt,
                        outcome: Outcome::Success,
                        diagnostic: None,
                        usage: Default::default(),
                        protocol: serde_json::to_value(ModelClosureProtocol {
                            finish_reason: ModelFinishReason::Stop,
                            provider_options: None,
                            response_id: None,
                            model: None,
                            timestamp: None,
                            compaction: None,
                            summary: Some(summary_result),
                        })?,
                    },
                    Fact::ModelCleanupObserved {
                        attempt,
                        cleanup: OperationCleanup::Confirmed,
                    },
                ],
                vec![encoded],
            )
            .await?;

            main.step = StepId::new();
            main.compaction_recovery = Some(attempt);
            let encoded = ContentBlob::json(&main)?;
            append(
                &store,
                &claim,
                vec![Fact::StepPrepared {
                    step: main.step,
                    request: encoded.reference().clone(),
                    adjudications: vec![],
                }],
                vec![encoded],
            )
            .await?;
            let main_attempt = ModelAttemptId::new();
            append(
                &store,
                &claim,
                vec![
                    Fact::ModelAttemptPrepared {
                        attempt: main_attempt,
                        step: main.step,
                    },
                    Fact::ModelAttemptAdmitted {
                        attempt: main_attempt,
                        upstream: serde_json::Value::Null,
                    },
                    Fact::ModelClosed {
                        attempt: main_attempt,
                        outcome: Outcome::Success,
                        diagnostic: None,
                        usage: Default::default(),
                        protocol: serde_json::to_value(ModelClosureProtocol {
                            finish_reason: ModelFinishReason::Stop,
                            provider_options: None,
                            response_id: None,
                            model: None,
                            timestamp: None,
                            compaction: None,
                            summary: None,
                        })?,
                    },
                    Fact::ModelCleanupObserved {
                        attempt: main_attempt,
                        cleanup: OperationCleanup::Confirmed,
                    },
                ],
                vec![],
            )
            .await?;

            main.step = StepId::new();
            let encoded = ContentBlob::json(&main)?;
            append(
                &store,
                &claim,
                vec![Fact::StepPrepared {
                    step: main.step,
                    request: encoded.reference().clone(),
                    adjudications: vec![],
                }],
                vec![encoded],
            )
            .await?;
            let view = store.frontier(run).await?;
            assert!(!view.attempts.contains_key(&attempt));
            let engine = Engine::new(store.clone());
            let level = engine.model_level(&view).await?;
            assert_eq!(
                level.compaction,
                crate::reconcile::CompactionLevel::Candidate {
                    summary: attempt,
                    adopt: false
                }
            );

            let blocker = BlockerId::new();
            append(
                &store,
                &claim,
                vec![Fact::Blocked {
                    blocker,
                    reason: BlockerKind::UnsupportedProtocol {
                        protocol: "compaction-budget-attempt-missing".into(),
                        version: 1,
                    },
                }],
                vec![],
            )
            .await?;
            let parked = store.frontier(run).await?;
            let evidence = ContentBlob::json(&attempt)?;
            let resolution = Fact::BlockerResolved {
                blocker,
                evidence: evidence.reference().clone(),
            };
            let error = store
                .append(
                    &claim,
                    (&parked).into(),
                    vec![Change::new(resolution.clone(), at())],
                    vec![evidence],
                )
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("requires an observation from its original source")
            );
            assert_eq!(store.frontier(run).await?.revision, parked.revision);

            let mut replay = parked.clone();
            replay.apply(&RecordedFact {
                schema_version: SCHEMA_VERSION,
                id: FactId::new(),
                run,
                revision: parked.revision + 1,
                at: at(),
                fact: resolution,
            })?;
            assert!(replay.recovery_failure().is_none());
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
        })
        .catch_unwind()
        .await;
        root.shutdown().await?;
        match result {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
}
