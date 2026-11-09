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

//! Actual ordinary-effect custody and its original immutable T2 material.
//! This is per-Scope runtime ownership; all execution/receipt truth stays in Root.
use super::*;
use maka_agent_facts::tools::EffectCustody;
use maka_event_log::StoreError;
use maka_host_runtime::application::{NativeRequest, NativeServices};
use maka_plugin_core::operation::OperationCleanup;

#[derive(Clone, PartialEq)]
pub(super) enum ReadSource {
    Intent(ToolKey),
    Operation(RecoveryRef),
}
struct RetainedReader {
    source: ReadSource,
    request: Arc<NativeRequest>,
    signal_armed: bool,
}

#[derive(Clone)]
pub(super) struct OriginalEffects {
    retained: Arc<std::sync::Mutex<Vec<Arc<Mutex<OriginalEffect>>>>>,
    state: maka_agent_state::Store,
    services: NativeServices,
    access: Arc<RunAccess>,
    readers: Arc<std::sync::Mutex<Vec<RetainedReader>>>,
}

pub(super) struct OriginalEffect {
    custody: Option<EffectCustody>,
    key: ToolKey,
    physical: PhysicalCleanup,
    batch: Option<OriginalBatch>,
    acknowledged: bool,
    observation: Option<OperationReply>,
    reader: Option<NativeRequest>,
    reader_observation: Option<OperationReply>,
    reader_signal_armed: bool,
}

enum PhysicalCleanup {
    Confirmed,
    Host(RecoveryRef),
    // The actual source supplied no physical proof. Missing metadata is not one.
    Unobservable,
}

struct OriginalBatch {
    changes: Vec<Change>,
    contents: Vec<ContentBlob>,
    artifacts: Vec<maka_agent_facts::event::ProjectionArtifactWrite>,
    fact: FactId,
    observation: Option<OperationReply>,
    attempted: std::sync::atomic::AtomicBool,
    local: Option<super::LocalCompletion>,
}
impl OriginalBatch {
    fn operation(key: &ToolKey, reply: OperationReply, at: UnixMillis) -> Self {
        let observed = Change::new(
            Fact::OperationObserved {
                tool: key.clone(),
                reply: reply.clone(),
            },
            at,
        );
        let fact = observed.id;
        Self {
            changes: vec![
                Change::new(
                    Fact::ToolOriginalBound {
                        tool: key.clone(),
                        reference: reply.reference.clone(),
                    },
                    at,
                ),
                observed,
            ],
            contents: vec![],
            artifacts: vec![],
            fact,
            observation: Some(reply),
            attempted: std::sync::atomic::AtomicBool::new(false),
            local: None,
        }
    }

    async fn publish(
        &self,
        state: &maka_agent_state::Store,
        access: &RunAccess,
    ) -> Result<(), RunError> {
        use std::sync::atomic::Ordering;
        let run = access.execution().run_id;
        let mut submit = !self.attempted.swap(true, Ordering::SeqCst);
        loop {
            if submit {
                let committed = match &self.local {
                    Some(local) => {
                        local
                            .publish(
                                state,
                                access,
                                &self.changes[0],
                                &self.contents,
                                &self.artifacts,
                            )
                            .await
                    }
                    None => {
                        state
                            .observe_artifacts(
                                run,
                                self.changes.clone(),
                                self.contents.clone(),
                                self.artifacts.clone(),
                            )
                            .await
                    }
                };
                match committed {
                    Ok(_) => return Ok(()),
                    Err(error)
                        if matches!(
                            error.underlying(),
                            StoreError::CommitUnknown(_) | StoreError::OperationUnknown
                        ) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            // One FIFO barrier and one SQL snapshot for the complete original
            // batch. Mixing individual reads could manufacture a partial view.
            let publication = state
                .publication(
                    run,
                    self.changes.iter().map(|change| change.id).collect(),
                    None,
                )
                .await?;
            if publication.facts.is_empty() {
                submit = true;
                continue;
            }
            if publication.facts.len() != self.changes.len()
                || !publication
                    .facts
                    .iter()
                    .zip(&self.changes)
                    .all(|(fact, change)| {
                        fact.id == change.id
                            && fact.run == run
                            && fact.schema_version == SCHEMA_VERSION
                            && fact.at == change.at
                            && fact.fact == change.fact
                    })
            {
                return Err(StoreError::EventConflict.into());
            }
            return Ok(());
        }
    }
}

pub(super) fn request(
    services: &NativeServices,
    access: &RunAccess,
    operation_id: Option<String>,
) -> Result<NativeRequest, RunError> {
    services
        .request_with_work(
            Identity::Agent {
                execution: access.execution().clone(),
                operation_id,
            },
            CancellationToken::new(),
            access.custody().clone(),
        )
        .and_then(|request| request.with_sandbox_floor(&access.spec().permission_ceiling.sandbox))
        .map_err(RunError::Internal)
}

impl OriginalEffects {
    #[cfg(test)]
    pub(super) async fn frozen_returns(&self) -> Vec<(ToolKey, FactId, ContentRef)> {
        let originals = self.retained.lock().unwrap().clone();
        let mut returns = Vec::new();
        for original in originals {
            let original = original.lock().await;
            if let Some(batch) = &original.batch {
                for change in &batch.changes {
                    match &change.fact {
                        Fact::LocalToolReturned { tool, result, .. }
                        | Fact::HostToolResultRecorded { tool, result, .. } => {
                            returns.push((tool.clone(), change.id, result.clone()))
                        }
                        _ => {}
                    }
                }
            }
        }
        returns
    }

    pub(super) fn new(
        state: maka_agent_state::Store,
        services: NativeServices,
        access: Arc<RunAccess>,
    ) -> Self {
        Self {
            retained: Arc::default(),
            state,
            services,
            access,
            readers: Arc::default(),
        }
    }
    pub(super) fn is_empty(&self) -> bool {
        self.retained
            .lock()
            .expect("original effect owners")
            .is_empty()
            && self
                .readers
                .lock()
                .expect("original read owners")
                .is_empty()
    }
    pub(super) async fn original_cleanup_signals(&self) -> Vec<BoxFuture<'static, ()>> {
        let mut resources = Vec::new();
        {
            let mut readers = self.readers.lock().expect("original read owners");
            for reader in readers.iter_mut().filter(|reader| !reader.signal_armed) {
                resources.push(reader.request.scope().resources.clone());
                reader.signal_armed = true;
            }
        }
        let originals = self
            .retained
            .lock()
            .expect("original effect owners")
            .clone();
        for original in originals {
            // An executing worker owns this lock. Its actual tracker wait wakes
            // the retainer; the next arm takes any newly retained reader once.
            let Ok(mut original) = original.try_lock() else {
                continue;
            };
            if !original.reader_signal_armed {
                if let Some(reader) = &original.reader {
                    resources.push(reader.scope().resources.clone());
                    original.reader_signal_armed = true;
                }
            }
        }
        resources
            .into_iter()
            .map(|resources| -> BoxFuture<'static, ()> {
                Box::pin(async move {
                    // Drain is a wakeup only. The subsequent source probe, not this
                    // Resources result or root-pin release, establishes proof.
                    let _historical_result = resources.settle().await;
                })
            })
            .collect()
    }

    pub(super) async fn finish_readers(&self, source: Option<&ReadSource>) -> Result<(), RunError> {
        let originals: Vec<_> = self
            .readers
            .lock()
            .expect("original read owners")
            .iter()
            .filter(|reader| source.is_none_or(|source| *source == reader.source))
            .map(|reader| reader.request.clone())
            .collect();
        let mut first_error = None;
        for reader in originals {
            if reader.scope().resources.has_pending() {
                first_error.get_or_insert(RunError::Tool(ToolError::CleanupUnconfirmed(
                    "Original readonly resources are still pending".into(),
                )));
                continue;
            }
            match reader.finish().await {
                Ok(()) => self
                    .readers
                    .lock()
                    .expect("original read owners")
                    .retain(|owned| !Arc::ptr_eq(&owned.request, &reader)),
                Err(error) => {
                    first_error.get_or_insert(RunError::Tool(ToolError::CleanupUnconfirmed(error)));
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn retain_reader(&self, source: ReadSource, request: NativeRequest) {
        self.readers
            .lock()
            .expect("original read owners")
            .push(RetainedReader {
                source,
                request: Arc::new(request),
                signal_armed: false,
            });
    }

    pub(super) fn own(&self, custody: EffectCustody, key: ToolKey) -> Arc<Mutex<OriginalEffect>> {
        let original = Arc::new(Mutex::new(OriginalEffect {
            custody: Some(custody),
            key,
            physical: PhysicalCleanup::Unobservable,
            batch: None,
            acknowledged: false,
            observation: None,
            reader: None,
            reader_observation: None,
            reader_signal_armed: false,
        }));
        self.retained
            .lock()
            .expect("original effect owners")
            .push(original.clone());
        original
    }
    fn release(&self, original: &Arc<Mutex<OriginalEffect>>) {
        self.retained
            .lock()
            .expect("original effect owners")
            .retain(|item| !Arc::ptr_eq(item, original));
    }
    pub(super) async fn complete(
        &self,
        original: Arc<Mutex<OriginalEffect>>,
        result: Result<ToolSuccess, ToolError>,
        local: Option<super::LocalCompletion>,
    ) -> Result<DispatchOutcome, RunError> {
        let mut material = original.lock().await;
        material.physical = match &result {
            Err(
                ToolError::OperationUnknown { observation, .. }
                | ToolError::OperationCleanupUnconfirmed { observation, .. },
            ) => PhysicalCleanup::Host(observation.reference.clone()),
            Err(
                ToolError::OutcomeUnknown(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::Persistence(_),
            ) => PhysicalCleanup::Unobservable,
            _ => PhysicalCleanup::Confirmed,
        };
        let successful = result.is_ok();
        let mut batch = prepare_result(self.access.execution(), &material.key, result).await?;
        if successful {
            batch.local = local;
        }
        if let Some(reply) = &batch.observation {
            if !cleanup_confirmed(reply) {
                material.physical = PhysicalCleanup::Host(reply.reference.clone());
            }
        }
        material.observation = batch.observation.clone();
        material.batch = Some(batch);
        self.publish_material(&mut material).await?;
        let fact = material.batch.as_ref().expect("original T2 material").fact;
        material.acknowledged = true;
        let custody = if matches!(material.physical, PhysicalCleanup::Confirmed) {
            material.custody.take()
        } else {
            None
        };
        let released = custody.is_some();
        drop(material);
        drop(custody);
        if released {
            self.release(&original);
        }
        Ok(DispatchOutcome::Recorded { fact })
    }
    async fn publish_material(&self, material: &mut OriginalEffect) -> Result<(), RunError> {
        let result = material
            .batch
            .as_ref()
            .expect("original T2 material")
            .publish(&self.state, &self.access)
            .await;
        match result {
            Err(RunError::Store(error))
                if material
                    .batch
                    .as_ref()
                    .and_then(|batch| batch.local.as_ref())
                    .is_some_and(|local| local.rejected(&error)) =>
            {
                material.batch = Some(
                    prepare_result(
                        self.access.execution(),
                        &material.key,
                        Err(ToolError::Failed(error.to_string())),
                    )
                    .await?,
                );
                material
                    .batch
                    .as_ref()
                    .expect("business failure T2")
                    .publish(&self.state, &self.access)
                    .await
            }
            result => result,
        }
    }
    pub(super) async fn settle_all(&self, cells_cleanup_confirmed: bool) -> Result<bool, RunError> {
        let originals = self
            .retained
            .lock()
            .expect("original effect owners")
            .clone();
        let mut confirmed = true;
        let mut first_error = None;
        for original in originals {
            match self.settle_one(&original, cells_cleanup_confirmed).await {
                Ok(true) => {}
                Ok(false) => confirmed = false,
                Err(error) => {
                    confirmed = false;
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Err(error) = self.finish_readers(None).await {
            first_error.get_or_insert(error);
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(confirmed && self.is_empty())
    }
    async fn settle_one(
        &self,
        original: &Arc<Mutex<OriginalEffect>>,
        cells_cleanup_confirmed: bool,
    ) -> Result<bool, RunError> {
        let mut material = original.lock().await;
        if material.batch.is_some() {
            if !material.acknowledged {
                self.publish_material(&mut material).await?;
                material.acknowledged = true;
            }
        }
        if !matches!(material.physical, PhysicalCleanup::Confirmed) {
            if let Some(reply) = material.observe(&self.services, &self.access).await? {
                if cleanup_confirmed(&reply) {
                    material.physical = PhysicalCleanup::Confirmed;
                }
                if material.observation.as_ref() != Some(&reply) {
                    // This is a new actual observation of the *same* Host
                    // operation, not replacement IDs for an uncertain batch.
                    let batch = OriginalBatch::operation(
                        &material.key,
                        reply.clone(),
                        UnixMillis(now().try_into().expect("Unix milliseconds")),
                    );
                    material.batch = Some(batch);
                    material.acknowledged = false;
                    material.observation = Some(reply.clone());
                }
                if let Some(batch) = &material.batch {
                    if !material.acknowledged {
                        batch.publish(&self.state, &self.access).await?;
                        material.acknowledged = true;
                    }
                }
            }
        }
        if cells_cleanup_confirmed
            && material.batch.is_none()
            && !matches!(material.physical, PhysicalCleanup::Confirmed)
        {
            // The actual Cell backend has joined its original VM and child cleanup.
            // Canonical closure only identifies the matching exec; it is not physical proof.
            let view = self.state.frontier(self.access.execution().run_id).await?;
            if view.tools.get(&maka_agent_state::fold::tool_key(&material.key)).is_some_and(|tool| {
                tool.admitted && tool.original.is_none() && !tool.call.provider_executed
            }) && view.cells.values().any(|cell| {
                matches!(&cell.owner, maka_agent_facts::cells::CellOwner::Agent { link, call }
                    if link.run == view.run
                        && link.attempt == material.key.attempt
                        && call == &material.key.call
                        && view.attempts.get(&link.attempt).is_some_and(|attempt| attempt.step == link.step))
                    && !matches!(cell.status, maka_agent_facts::cells::CellStatus::Running)
                    && cell.children.values().all(|child| child.known())
                    && !cell.blocks_effect_admission()
            }) {
                material.physical = PhysicalCleanup::Confirmed;
                material.acknowledged = true;
            }
        }
        let custody = if matches!(material.physical, PhysicalCleanup::Confirmed)
            && material.acknowledged
            && material.reader.is_none()
        {
            material.custody.take()
        } else {
            None
        };
        let released = custody.is_some();
        drop(material);
        drop(custody);
        if released {
            self.release(original);
        }
        Ok(released)
    }
}

fn cleanup_confirmed(reply: &OperationReply) -> bool {
    matches!(
        &reply.receipt,
        Receipt::Recorded {
            cleanup: OperationCleanup::Confirmed,
            ..
        }
    )
}
impl OriginalEffect {
    async fn observe(
        &mut self,
        services: &NativeServices,
        access: &RunAccess,
    ) -> Result<Option<OperationReply>, RunError> {
        if let Some(reader) = &self.reader {
            if reader.scope().resources.has_pending() {
                return Err(RunError::Tool(ToolError::CleanupUnconfirmed(
                    "Original readonly resources are still pending".into(),
                )));
            }
            reader
                .finish()
                .await
                .map_err(|error| RunError::Tool(ToolError::CleanupUnconfirmed(error)))?;
            self.reader = None;
            if let Some(reply) = self.reader_observation.take() {
                return Ok(Some(reply));
            }
        }
        let operation_id = format!("{}:{}", self.key.attempt, self.key.call);
        let reader = request(services, access, Some(operation_id.clone()))?;
        let reference = match &self.physical {
            PhysicalCleanup::Host(reference) => Ok(Some(reference.clone())),
            PhysicalCleanup::Unobservable => {
                let unavailable = |diagnostic| {
                    RunError::Blocked(BlockerKind::CurrentAuthorityUnavailable {
                        stage: AuthorityStage::BackendScope,
                        diagnostic,
                    })
                };
                match reader.lookup_intent(crate::tools::operation_uuid(
                    access.execution(),
                    &operation_id,
                )) {
                    Ok(original) => original
                        .await
                        .map(|intent| intent.map(|intent| intent.reference))
                        .map_err(unavailable),
                    Err(error) => Err(unavailable(error)),
                }
            }
            PhysicalCleanup::Confirmed => unreachable!("confirmed sources are not read again"),
        };
        let observation = match reference {
            Ok(Some(reference)) => {
                self.physical = PhysicalCleanup::Host(reference.clone());
                match reader.recover(reference.clone()) {
                    Ok(original) => original
                        .await
                        .map(|observation| {
                            observation.map(|observation| OperationReply {
                                reference,
                                receipt: Receipt::Recorded {
                                    outcome: observation.outcome,
                                    cleanup: observation.cleanup,
                                },
                            })
                        })
                        .map_err(RunError::Internal),
                    Err(error) => Err(RunError::Internal(error)),
                }
            }
            Ok(None) => Ok(None),
            Err(error) => Err(error),
        };
        if let Err(error) = reader.finish().await {
            self.reader_observation = observation.ok().flatten();
            self.reader = Some(reader);
            self.reader_signal_armed = false;
            return Err(RunError::Tool(ToolError::CleanupUnconfirmed(error)));
        }
        observation
    }
}

async fn prepare_result(
    execution: &ExecutionIdentity,
    key: &ToolKey,
    result: Result<ToolSuccess, ToolError>,
) -> Result<OriginalBatch, RunError> {
    use maka_agent_facts::tool_call::ToolSettlement;
    let at = UnixMillis(now().try_into().expect("Unix milliseconds"));
    let (result, settlement) = match result {
        Ok(result) => (result, ToolSettlement::Returned),
        Err(
            ToolError::OperationUnknown { observation, .. }
            | ToolError::OperationCleanupUnconfirmed { observation, .. },
        ) => return Ok(OriginalBatch::operation(key, *observation, at)),
        Err(
            error @ (ToolError::OutcomeUnknown(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::Persistence(_)),
        ) => return Err(RunError::Tool(error)),
        Err(error) => (
            ToolSuccess::from(ToolOutput::Text(error.to_string())).reporting_error(true),
            ToolSettlement::Failed,
        ),
    };
    let execution = execution.clone();
    let key = key.clone();
    // The original worker retains its physical leases across this CPU work.
    let (changes, contents, artifacts, fact, observation) =
        tokio::task::spawn_blocking(move || {
            let normalized = result
                .into_durable(
                    &format!("{}:{}:{}", execution.run_id, key.attempt, key.call),
                    SystemTime::now(),
                    &execution,
                )
                .map_err(|error| RunError::InvalidInput(error.into()))?;
            let artifacts = normalized
                .artifacts
                .iter()
                .map(|artifact| {
                    let evidence = artifact.evidence();
                    PublishedArtifact {
                        artifact: artifact.artifact().clone(),
                        payload: ContentRef {
                            digest: evidence.digest,
                            bytes: evidence.bytes,
                        },
                    }
                })
                .collect();
            let original = match &normalized.output {
                ToolOutput::Operation(reply) => Some(reply.as_ref().clone()),
                _ => None,
            };
            let blob = ContentBlob::json(&ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts,
                body: ReturnedToolResult {
                    output: normalized.output,
                    projection: normalized.projection,
                    is_error: normalized.is_error,
                    loaded_tools: normalized.loaded_tools,
                },
            })?;
            let observation = original.clone();
            let mut changes = vec![];
            if let Some(reply) = original {
                changes.push(Change::new(
                    Fact::ToolOriginalBound {
                        tool: key.clone(),
                        reference: reply.reference.clone(),
                    },
                    at,
                ));
                changes.push(Change::new(
                    Fact::OperationObserved {
                        tool: key.clone(),
                        reply: reply.clone(),
                    },
                    at,
                ));
                changes.push(Change::new(
                    Fact::HostToolResultRecorded {
                        tool: key,
                        reference: reply.reference,
                        result: blob.reference().clone(),
                        is_error: normalized.is_error,
                    },
                    at,
                ));
            } else {
                changes.push(Change::new(
                    Fact::LocalToolReturned {
                        tool: key,
                        result: blob.reference().clone(),
                        is_error: normalized.is_error,
                        settlement,
                    },
                    at,
                ));
            }
            let fact = changes.last().expect("original return evidence").id;
            Ok::<_, RunError>((changes, vec![blob], normalized.artifacts, fact, observation))
        })
        .await
        .map_err(|error| RunError::Internal(error.to_string()))??;
    Ok(OriginalBatch {
        changes,
        contents,
        artifacts,
        fact,
        observation,
        attempted: std::sync::atomic::AtomicBool::new(false),
        local: None,
    })
}
