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
    selected: Option<(crate::tools::SelectedTool, NativeServices)>,
    source: DispatchSource,
    physical: PhysicalCleanup,
    batch: Option<OriginalBatch>,
    acknowledged: bool,
    observation: Option<OperationReply>,
    reader: Option<NativeRequest>,
    reader_observation: Option<OperationReply>,
    reader_signal_armed: bool,
}

#[expect(
    clippy::large_enum_variant,
    reason = "Cleanup observation keeps the original physical outcome inline without a separate handoff allocation"
)]
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
    async fn operation(
        key: &ToolKey,
        reply: OperationReply,
        at: UnixMillis,
    ) -> Result<Self, RunError> {
        let (stored, content) = maka_agent_state::operation::prepare_reply(reply.clone()).await?;
        let observed = Change::new(
            Fact::OperationObserved {
                tool: key.clone(),
                reply: stored,
            },
            at,
        );
        let fact = observed.id;
        Ok(Self {
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
            contents: content.into_iter().collect(),
            artifacts: vec![],
            fact,
            observation: Some(reply),
            attempted: std::sync::atomic::AtomicBool::new(false),
            local: None,
        })
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

fn recovery_unavailable(diagnostic: impl Into<String>) -> RunError {
    RunError::from(BlockerKind::CurrentAuthorityUnavailable {
        stage: AuthorityStage::BackendScope,
        diagnostic: diagnostic.into(),
    })
}

impl OriginalEffects {
    async fn selection(&self) -> Result<crate::tools::SelectionSnapshot, RunError> {
        let bytes = self
            .state
            .content(
                self.access.execution().run_id,
                self.access.spec().tool_selection.clone(),
            )
            .await?;
        serde_json::from_slice(&bytes).map_err(|error| {
            recovery_unavailable(format!("original tool selection is unavailable: {error}"))
        })
    }
    pub(super) async fn selected_for_tool(
        &self,
        name: &str,
    ) -> Result<Option<(crate::tools::SelectedTool, NativeServices)>, RunError> {
        let owner = self
            .access
            .owner
            .upgrade()
            .ok_or_else(|| recovery_unavailable("original native owner is unavailable"))?;
        self.selection()
            .await?
            .selected_service(&self.services, &owner.tool_basis, name)
            .map_err(recovery_unavailable)
    }
    async fn canonical_tool(&self, source: &ReadSource) -> Result<Tool, RunError> {
        let execution = self.access.execution();
        let mut view = self.state.frontier(execution.run_id).await?;
        if view.run != execution.run_id
            || view.spec != *self.access.spec()
            || view.spec.session_id != execution.session_id
            || view.spec.turn_id != execution.turn_id
        {
            return Err(recovery_unavailable(
                "original recovery Run differs from actual execution",
            ));
        }
        let key = match source {
            ReadSource::Intent(key) => key.clone(),
            ReadSource::Operation(reference) => {
                let mut originals = view.tools.values().filter(|tool| {
                    !tool.call.provider_executed
                        && tool.admitted
                        && tool.original.as_ref() == Some(reference)
                });
                let tool = originals.next().ok_or_else(|| {
                    recovery_unavailable("original operation has no canonical tool binding")
                })?;
                if originals.next().is_some() {
                    return Err(recovery_unavailable(
                        "original operation has ambiguous canonical tool bindings",
                    ));
                }
                tool.key.clone()
            }
        };
        let tool = view
            .tools
            .remove(&tool_key(&key))
            .ok_or_else(|| recovery_unavailable("original canonical tool is unavailable"))?;
        if tool.key != key || tool.call.provider_executed {
            return Err(recovery_unavailable(
                "original tool is not a canonical Host tool",
            ));
        }
        match source {
            ReadSource::Intent(_) => {
                if !tool.admitted && !matches!(&tool.decision, Some(ToolDecision::Approved { .. }))
                {
                    return Err(recovery_unavailable(
                        "original tool has no approval or admission",
                    ));
                }
            }
            ReadSource::Operation(reference) => {
                let operation = crate::tools::operation_uuid(
                    execution,
                    &format!("{}:{}", key.attempt, key.call),
                );
                if !tool.admitted
                    || reference.operation != operation
                    || tool.original.as_ref() != Some(reference)
                {
                    return Err(recovery_unavailable(
                        "original operation differs from its canonical tool",
                    ));
                }
            }
        }
        Ok(tool)
    }
    pub(super) async fn recovery_request(
        &self,
        source: &ReadSource,
        pinned: Option<&(crate::tools::SelectedTool, NativeServices)>,
        expected: Option<&RecoveryRef>,
    ) -> Result<Option<(RecoveryRef, NativeRequest)>, RunError> {
        self.finish_readers(Some(source)).await?;
        let tool = self.canonical_tool(source).await?;
        let owner = self
            .access
            .owner
            .upgrade()
            .ok_or_else(|| recovery_unavailable("original native owner is unavailable"))?;
        let selection = self.selection().await?;
        let selected = selection
            .selected_service(&self.services, &owner.tool_basis, &tool.call.name)
            .map_err(recovery_unavailable)?;
        let selected = match (pinned, selected) {
            (Some(pinned), Some(selected)) if pinned.0 == selected.0 => Some(pinned.clone()),
            (Some(_), _) => {
                return Err(recovery_unavailable(
                    "retained native scope differs from canonical tool",
                ));
            }
            (None, selected) => selected,
        };
        let operation_id = format!("{}:{}", tool.key.attempt, tool.key.call);
        let operation = crate::tools::operation_uuid(self.access.execution(), &operation_id);
        if expected.is_some_and(|reference| {
            reference.operation != operation
                || tool
                    .original
                    .as_ref()
                    .is_some_and(|original| original != reference)
        }) {
            return Err(recovery_unavailable(
                "expected operation differs from canonical tool",
            ));
        }
        if selected.is_none() && matches!(source, ReadSource::Operation(_)) {
            return Err(recovery_unavailable(
                "original operation has no selected native service",
            ));
        }
        // Non-service tools may observe intent absence; disclosure of any Some
        // still passes the Host's independent original-receipt policy gate.
        let lookup = request(
            selected
                .as_ref()
                .map_or(&self.services, |selected| &selected.1),
            &self.access,
            Some(operation_id.clone()),
        )?;
        let intent = match lookup.lookup_intent(operation) {
            Ok(observer) => observer.await,
            Err(error) => Err(error),
        };
        let validated = (|| {
            let intent = intent.map_err(recovery_unavailable)?;
            let Some(intent) = intent else {
                return if expected.is_some()
                    || tool.original.is_some()
                    || matches!(source, ReadSource::Operation(_))
                {
                    Err(recovery_unavailable(
                        "original caller intent is unavailable",
                    ))
                } else {
                    Ok(None)
                };
            };
            if intent.reference.operation != operation
                || expected.is_some_and(|reference| reference != &intent.reference)
                || tool
                    .original
                    .as_ref()
                    .is_some_and(|reference| reference != &intent.reference)
                || matches!(source, ReadSource::Operation(reference) if reference != &intent.reference)
            {
                return Err(recovery_unavailable(
                    "caller intent differs from canonical original operation",
                ));
            }
            let selected = selected.as_ref().ok_or_else(|| {
                recovery_unavailable("non-service tool has an unexpected Host caller intent")
            })?;
            selection
                .validate_recovery_service(
                    &self.services,
                    &owner.tool_basis,
                    &intent,
                    self.access.execution(),
                    &operation_id,
                    selected,
                )
                .map_err(recovery_unavailable)?;
            Ok(Some(intent.reference))
        })();
        match validated {
            Ok(Some(reference)) => Ok(Some((reference, lookup))),
            result => {
                if let Err(error) = lookup.finish().await {
                    self.retain_reader(source.clone(), lookup);
                    return Err(RunError::Tool(ToolError::CleanupUnconfirmed(error)));
                }
                result.map(|_| None)
            }
        }
    }
}
impl OriginalEffects {
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
            if !original.reader_signal_armed
                && let Some(reader) = &original.reader
            {
                resources.push(reader.scope().resources.clone());
                original.reader_signal_armed = true;
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

    pub(super) fn own(
        &self,
        custody: EffectCustody,
        key: ToolKey,
        selected: Option<(crate::tools::SelectedTool, NativeServices)>,
        source: DispatchSource,
    ) -> Arc<Mutex<OriginalEffect>> {
        let original = Arc::new(Mutex::new(OriginalEffect {
            custody: Some(custody),
            key,
            selected,
            source,
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
        let result = if matches!(&material.source, DispatchSource::CellWait(_)) {
            match result {
                Err(
                    error @ (ToolError::OutcomeUnknown(_)
                    | ToolError::CleanupUnconfirmed(_)
                    | ToolError::Persistence(_)
                    | ToolError::OperationUnknown { .. }
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                ) => {
                    // The control callback failed; its original Cell still owns
                    // uncertainty. Keep this batch private until source closure.
                    let diagnostic = error.to_string();
                    material.batch = Some(
                        prepare_local_result(
                            self.access.execution(),
                            &material.key,
                            ToolSuccess::from(ToolOutput::Text(diagnostic.clone()))
                                .reporting_error(true),
                            maka_agent_facts::tool_call::ToolSettlement::Unknown,
                        )
                        .await?,
                    );
                    return Err(RunError::Tool(ToolError::OutcomeUnknown(diagnostic)));
                }
                result => result,
            }
        } else {
            result
        };
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
        if let Some(reply) = &batch.observation
            && !cleanup_confirmed(reply)
        {
            material.physical = PhysicalCleanup::Host(reply.reference.clone());
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
        if !matches!(material.physical, PhysicalCleanup::Confirmed)
            && let DispatchSource::CellWait(source) = &material.source
        {
            let Some(settlement) = source
                .settlement(&self.access, &material.key, cells_cleanup_confirmed)
                .await?
            else {
                return Ok(false);
            };
            let batch = material.batch.as_mut().ok_or_else(|| {
                RunError::Internal("Cell wait callback has not supplied its original result".into())
            })?;
            let Some(Change {
                fact:
                    Fact::LocalToolReturned {
                        settlement: original,
                        ..
                    },
                ..
            }) = batch.changes.first_mut()
            else {
                return Err(RunError::Internal(
                    "Cell wait lost its local result material".into(),
                ));
            };
            // Classify once, before any SQL attempt. Publication retries retain
            // these exact facts even if logical knowledge subsequently advances.
            *original = settlement;
            material.physical = PhysicalCleanup::Confirmed;
        }
        if material.batch.is_some() && !material.acknowledged {
            self.publish_material(&mut material).await?;
            material.acknowledged = true;
        }
        if matches!(&material.source, DispatchSource::Ordinary)
            && !matches!(material.physical, PhysicalCleanup::Confirmed)
            && let Some(reply) = material.observe(self).await?
        {
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
                )
                .await?;
                material.batch = Some(batch);
                material.acknowledged = false;
                material.observation = Some(reply.clone());
            }
            if let Some(batch) = &material.batch
                && !material.acknowledged
            {
                batch.publish(&self.state, &self.access).await?;
                material.acknowledged = true;
            }
        }
        if cells_cleanup_confirmed
            && matches!(&material.source, DispatchSource::Ordinary)
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
        effects: &OriginalEffects,
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
            if let Some(reply) = self.reader_observation.take().filter(cleanup_confirmed) {
                return Ok(Some(reply));
            }
        }
        let expected = match &self.physical {
            PhysicalCleanup::Host(reference) => Some(reference),
            PhysicalCleanup::Unobservable => None,
            PhysicalCleanup::Confirmed => unreachable!("confirmed sources are not read again"),
        };
        let source = ReadSource::Intent(self.key.clone());
        let Some((reference, reader)) = effects
            .recovery_request(&source, self.selected.as_ref(), expected)
            .await?
        else {
            return Ok(None);
        };
        self.physical = PhysicalCleanup::Host(reference.clone());
        let observation = match reader.recover(reference.clone()) {
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
                .map_err(recovery_unavailable),
            Err(error) => Err(recovery_unavailable(error)),
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
        ) => return OriginalBatch::operation(key, *observation, at).await,
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
    prepare_local_result(execution, key, result, settlement).await
}

#[cfg(test)]
pub(super) async fn publish_return_for_test(
    state: &maka_agent_state::Store,
    access: &RunAccess,
    key: &ToolKey,
    result: ToolSuccess,
    original_evidence: Option<ContentBlob>,
) -> Result<Fact, RunError> {
    let mut batch = prepare_local_result(
        access.execution(),
        key,
        result,
        maka_agent_facts::tool_call::ToolSettlement::Returned,
    )
    .await?;
    batch.contents.extend(original_evidence);
    batch.publish(state, access).await?;
    Ok(batch.changes.pop().expect("published return").fact)
}

async fn prepare_local_result(
    execution: &ExecutionIdentity,
    key: &ToolKey,
    result: ToolSuccess,
    settlement: maka_agent_facts::tool_call::ToolSettlement,
) -> Result<OriginalBatch, RunError> {
    let at = UnixMillis(now().try_into().expect("Unix milliseconds"));
    let execution = execution.clone();
    let key = key.clone();
    // The original worker retains its physical leases across this CPU work.
    let (changes, contents, artifacts, fact, observation) =
        tokio::task::spawn_blocking(move || {
            let mut normalized = result
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
            let cell_observation = match &mut normalized.output {
                ToolOutput::Cell(reply) => match &reply.state {
                    maka_agent_facts::cells::CellReplyState::Completed { result }
                    | maka_agent_facts::cells::CellReplyState::Interrupted { report: result } => {
                        reply.observation = serde_json::Value::Null;
                        Some(result.clone())
                    }
                    _ => None,
                },
                _ => None,
            };
            use maka_agent_facts::tool_output::{
                OperationProjection, StoredOperationReturn, StoredToolResult,
            };
            let (body, observation, stored, content) = match normalized.output {
                ToolOutput::Operation(reply) => {
                    let (stored, content) =
                        maka_agent_state::operation::record_reply((*reply).clone())?;
                    let body = StoredToolResult::Operation(Box::new(StoredOperationReturn {
                        operation: stored.clone(),
                        projection: OperationProjection::record(&reply, normalized.projection)
                            .map_err(RunError::Json)?,
                        is_error: normalized.is_error,
                        loaded_tools: normalized.loaded_tools,
                    }));
                    (body, Some(*reply), Some(stored), content)
                }
                output => (
                    StoredToolResult::Inline(ReturnedToolResult {
                        output,
                        projection: normalized.projection,
                        is_error: normalized.is_error,
                        loaded_tools: normalized.loaded_tools,
                    }),
                    None,
                    None,
                    None,
                ),
            };
            let blob = ContentBlob::json(&ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts,
                body,
            })?;
            let mut changes = vec![];
            if let Some(reply) = stored {
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
                        cell_observation,
                    },
                    at,
                ));
            }
            let fact = changes.last().expect("original return evidence").id;
            let contents = std::iter::once(blob).chain(content).collect();
            Ok::<_, RunError>((changes, contents, normalized.artifacts, fact, observation))
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
