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
    pub fn fact_id(&self) -> FactId {
        self.publication.changes[0].id
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

async fn settle_result(
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
