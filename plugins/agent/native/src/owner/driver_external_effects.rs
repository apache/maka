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

//! Actual external Host effects: original capability, one admission, immutable evidence.
use super::{Owner, RunAccess, now};
use crate::executor::external::HostEffects;
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_engine::{RunError, cleanup::Evidence};
use maka_agent_facts::{
    durable::*,
    external_effects::{
        ExternalEffectDescriptor, ExternalEffectEvent, ExternalEffectKey, ExternalReturn,
    },
    tool_call::{ToolOrigin, ToolSettlement},
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput, ToolSuccess},
    tools::{ToolCallContext, ToolError},
};
use maka_agent_state::{Change, ContentBlob, DriverClaim, Head, fold::RunView};
use maka_capabilities::call::Identity;
use maka_event_log::StoreError;
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, Receipt, RecoveryRef,
};
use maka_tools::ToolCatalog;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex},
    time::SystemTime,
};
use tokio::sync::oneshot;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

const PROTOCOL: &str = "maka.external-host-effect";

type EffectReply = oneshot::Sender<Result<ReturnedToolResult, ToolError>>;

#[derive(Clone)]
pub(super) struct NativeExternalEffects {
    owner: Arc<Owner>,
    state: maka_agent_state::Store,
    access: Arc<RunAccess>,
    claim: DriverClaim,
    cleanup: Evidence,
    workers: TaskTracker,
    observation: Arc<Mutex<Option<EffectReply>>>,
    retained: Arc<Mutex<Vec<Arc<RetainedBatch>>>>,
    calls: Arc<Mutex<Vec<Arc<tokio::sync::Mutex<OwnedCall>>>>>,
    active: Option<Arc<tokio::sync::Mutex<OwnedCall>>>,
}

struct RetainedBatch {
    changes: Vec<Change>,
    contents: Vec<ContentBlob>,
    artifacts: Vec<maka_agent_facts::event::ProjectionArtifactWrite>,
    admission: bool,
    acknowledged: std::sync::atomic::AtomicBool,
}
struct OwnedReader {
    request: Arc<maka_host_runtime::application::NativeRequest>,
    signal_armed: bool,
}
struct OwnedCall {
    key: ExternalEffectKey,
    custody: Option<Box<dyn Send>>,
    execution_owned: bool,
    observing_prior: bool,
    worker_done: bool,
    physical: bool,
    retained: Arc<Mutex<Vec<Arc<RetainedBatch>>>>,
    readers: Vec<OwnedReader>,
    host: Option<RecoveryRef>,
    observation: Option<OperationReply>,
}

impl OwnedCall {
    fn has_settlement(&self) -> bool {
        !self.execution_owned
            || self
                .retained
                .lock()
                .expect("external T2 material")
                .iter()
                .any(|batch| {
                    batch.changes.iter().any(|change| {
                        matches!(
                            &change.fact,
                            Fact::ExternalEffect {
                                event: ExternalEffectEvent::Observed { .. }
                                    | ExternalEffectEvent::Returned { .. }
                                    | ExternalEffectEvent::Rejected { .. }
                            }
                        )
                    })
                })
    }
}

impl NativeExternalEffects {
    pub(super) fn new(
        owner: Arc<Owner>,
        access: Arc<RunAccess>,
        claim: DriverClaim,
        cleanup: Evidence,
        workers: TaskTracker,
    ) -> Result<Self, RunError> {
        let writer = owner
            .store
            .data_writer_for_work(access.custody().as_ref(), &access.execution().session_id)?;
        let state = owner.durable.with_data_writer(writer)?;
        Ok(Self {
            owner,
            state,
            access,
            claim,
            cleanup,
            workers,
            observation: Arc::new(Mutex::new(None)),
            retained: Arc::new(Mutex::new(Vec::new())),
            calls: Arc::default(),
            active: None,
        })
    }

    pub(super) fn has_retained(&self) -> bool {
        !self
            .calls
            .lock()
            .expect("original external sources")
            .is_empty()
    }

    pub(super) fn belongs_to(&self, access: &Arc<RunAccess>) -> bool {
        Arc::ptr_eq(&self.access, access)
    }

    fn key(&self, context: &ToolCallContext) -> Result<ExternalEffectKey, ToolError> {
        if context.execution != *self.access.execution()
            || self.claim.run() != context.execution.run_id
            || context
                .custody
                .as_ref()
                .is_none_or(|custody| !Arc::ptr_eq(custody, self.access.custody()))
        {
            return Err(ToolError::Failed(
                "External Host call lacks original work custody".into(),
            ));
        }
        let ToolOrigin::External {
            task, operation, ..
        } = &context.call.origin
        else {
            return Err(ToolError::Failed(
                "External Host call lacks a typed task obligation".into(),
            ));
        };
        if context.operation_id != format!("external:{task}:{operation}")
            || context.call.tool_call_id != context.operation_id
        {
            return Err(ToolError::Failed(
                "External Host operation identity differs".into(),
            ));
        }
        Ok(ExternalEffectKey {
            task: *task,
            operation: *operation,
        })
    }

    async fn current(
        &self,
        context: &ToolCallContext,
        key: ExternalEffectKey,
        name: &str,
        cancellation: &CancellationToken,
    ) -> Result<RunView, ToolError> {
        self.access.check_tool(context, name).await?;
        let view = self.access.fresh().await.map_err(ToolError::Failed)?;
        let task = view
            .external
            .as_ref()
            .ok_or_else(|| ToolError::Failed("External task is missing".into()))?;
        if task.task != key.task
            || !task.admitted
            || task.closed.is_some()
            || view.stopped
            || view.terminal.is_some()
            || cancellation.is_cancelled()
        {
            return Err(ToolError::Failed(
                "External task no longer admits Host work".into(),
            ));
        }
        Ok(view)
    }

    async fn invoke_original(
        &self,
        catalog: ToolCatalog,
        context: ToolCallContext,
        name: String,
        input: Value,
        cancellation: CancellationToken,
    ) -> Result<ReturnedToolResult, ToolError> {
        let key = self.key(&context)?;
        let view = self.access.fresh().await.map_err(ToolError::Failed)?;
        let task = view
            .external
            .as_ref()
            .ok_or_else(|| ToolError::Failed("External task is missing".into()))?;
        if task.task != key.task || !task.admitted {
            return Err(ToolError::Failed(
                "External Host call has no admitted parent task".into(),
            ));
        }
        if let Some(effect) = self
            .state
            .external_effect(view.run, key)
            .await
            .map_err(persistence)?
        {
            if let Some(active) = &self.active {
                active.lock().await.observing_prior = true;
            }
            let bytes = self
                .state
                .content(self.claim.run(), effect.descriptor.clone())
                .await
                .map_err(persistence)?;
            let descriptor: ExternalEffectDescriptor =
                serde_json::from_slice(&bytes).map_err(persistence)?;
            if descriptor.schema_version != SCHEMA_VERSION || descriptor.protocol != PROTOCOL {
                self.block(key).await?;
                return Err(ToolError::OutcomeUnknown(
                    "Original external Host effect protocol is unsupported".into(),
                ));
            }
            if descriptor.key != key
                || descriptor.execution != context.execution
                || descriptor.origin != context.call.origin
                || descriptor.operation_id != context.operation_id
                || descriptor.name != name
                || descriptor.input != input
            {
                return Err(ToolError::Failed(
                    "External operation differs from its original descriptor".into(),
                ));
            }
            if let Some(rejected) = &effect.rejected {
                return Err(ToolError::Failed(rejected.diagnostic.clone()));
            }
            if let Some(output) = &effect.returned {
                return self
                    .read_return(key, &descriptor.name, output.clone())
                    .await;
            }
            if effect.admitted {
                if self.reconcile_owned_original(key).await? {
                    let original = self
                        .state
                        .external_effect(view.run, key)
                        .await
                        .map_err(persistence)?
                        .ok_or_else(|| {
                            ToolError::Persistence("Original external effect disappeared".into())
                        })?;
                    if let Some(output) = original.returned {
                        return self.read_return(key, &descriptor.name, output).await;
                    }
                    return Err(ToolError::OutcomeUnknown(
                        "The original Host effect still owns its return publication".into(),
                    ));
                }
                return self
                    .recover(key, &descriptor, effect.reference.clone())
                    .await;
            }
            // A lost prepared owner is not restored from a current handler with the same name.
            self.block(key).await?;
            return Err(ToolError::OutcomeUnknown(
                "Original prepared Host effect is unavailable".into(),
            ));
        }
        let definition = catalog
            .definitions()
            .find(|tool| tool.name == name)
            .cloned()
            .ok_or_else(|| {
                ToolError::Failed("Host tool is unavailable in the original catalog".into())
            })?;
        let descriptor = ExternalEffectDescriptor {
            schema_version: SCHEMA_VERSION,
            protocol: PROTOCOL.into(),
            execution: context.execution.clone(),
            origin: context.call.origin.clone(),
            key,
            operation_id: context.operation_id.clone(),
            name: name.clone(),
            input: input.clone(),
            definition,
            catalog_digest: catalog.digest(),
            // ServiceTool's bridge admits only JSON methods with no required resource slots.
            resources: vec![],
        };
        let blob = ContentBlob::json(&descriptor).map_err(persistence)?;
        let prepared = change(ExternalEffectEvent::Prepared {
            key,
            descriptor: blob.reference().clone(),
        });
        self.append(
            &context,
            key,
            &name,
            &cancellation,
            vec![prepared],
            vec![blob],
        )
        .await?;
        let effect = match catalog
            .prepare(name.clone(), input, context.clone(), cancellation.clone())
            .await
        {
            Ok(effect) => effect,
            Err(rejection) => {
                let diagnostic = rejection.to_string();
                self.observe(
                    vec![change(ExternalEffectEvent::Rejected {
                        key,
                        rejection_kind: rejection.kind(),
                        diagnostic: diagnostic.clone(),
                    })],
                    vec![],
                )
                .await?;
                return Err(ToolError::Failed(diagnostic));
            }
        };
        if let Err(error) = self.current(&context, key, &name, &cancellation).await {
            self.observe(
                vec![change(ExternalEffectEvent::Rejected {
                    key,
                    rejection_kind: maka_agent_facts::tool_call::RejectionKind::PreparationFailed,
                    diagnostic: error.to_string(),
                })],
                vec![],
            )
            .await?;
            return Err(error);
        }
        // The prepared effect names its exact established interaction. The T1
        // transaction consumes that grant against the original descriptor.
        let approval = effect.approval_id();
        let admitted = change(ExternalEffectEvent::Admitted { key, approval });
        let revision = self
            .append(&context, key, &name, &cancellation, vec![admitted], vec![])
            .await?;
        if cancellation.is_cancelled() {
            return self
                .settle(
                    key,
                    &name,
                    Err(ToolError::Failed(
                        "External Host call cancelled before execution".into(),
                    )),
                    ToolSettlement::Rejected,
                )
                .await;
        }
        let running = match effect.begin(revision, cancellation.clone()) {
            Ok(running) => running,
            Err(error) => {
                return self
                    .settle(key, &name, Err(error), ToolSettlement::Rejected)
                    .await;
            }
        };
        if let Err(error) = self.current(&context, key, &name, &cancellation).await {
            return self
                .settle_owned(key, &name, Err(error), ToolSettlement::Rejected, running)
                .await;
        }
        let (custody, execution) = running.execute();
        let result = AssertUnwindSafe(execution)
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(ToolError::OutcomeUnknown(
                    "External Host worker panicked".into(),
                ))
            });
        self.settle_owned(key, &name, result, ToolSettlement::Failed, custody)
            .await
    }

    async fn settle_owned<G: Send + 'static>(
        &self,
        key: ExternalEffectKey,
        name: &str,
        result: Result<ToolSuccess, ToolError>,
        failure: ToolSettlement,
        custody: G,
    ) -> Result<ReturnedToolResult, ToolError> {
        let active = self
            .active
            .as_ref()
            .expect("original invocation owns its source");
        {
            let mut source = active.lock().await;
            source.execution_owned = true;
            source.physical = !matches!(
                &result,
                Err(ToolError::OutcomeUnknown(_)
                    | ToolError::OperationUnknown { .. }
                    | ToolError::CleanupUnconfirmed(_)
                    | ToolError::OperationCleanupUnconfirmed { .. }
                    | ToolError::Persistence(_))
            );
            source.custody = Some(Box::new(custody));
        }
        // No shared-tracker task waits for its own Root settlement. The same
        // actual source and immutable T2 material stay in this Root-owned actor.
        self.settle(key, name, result, failure).await
    }

    async fn finish_request(
        &self,
        request: maka_host_runtime::application::NativeRequest,
    ) -> Result<(), ToolError> {
        if let Err(error) = request.finish().await {
            if let Some(active) = &self.active {
                active.lock().await.readers.push(OwnedReader {
                    request: Arc::new(request),
                    signal_armed: false,
                });
            }
            return Err(ToolError::CleanupUnconfirmed(error));
        }
        Ok(())
    }

    async fn original_cleanup(
        &self,
        key: ExternalEffectKey,
        reference: Option<RecoveryRef>,
    ) -> Result<bool, ToolError> {
        let operation_id = format!("external:{}:{}", key.task, key.operation);
        let request = self.request(Some(operation_id.clone()))?;
        let reference = match reference {
            Some(reference) => Ok(Some(reference)),
            None => match request.lookup_intent(crate::tools::operation_uuid(
                self.access.execution(),
                &operation_id,
            )) {
                Ok(original) => original
                    .await
                    .map(|intent| intent.map(|intent| intent.reference))
                    .map_err(ToolError::OutcomeUnknown),
                Err(error) => Err(ToolError::OutcomeUnknown(error)),
            },
        };
        let reply = match reference {
            Ok(Some(reference)) => {
                if let Some(active) = &self.active {
                    active.lock().await.host = Some(reference.clone());
                }
                match request.recover(reference.clone()) {
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
                        .map_err(ToolError::OutcomeUnknown),
                    Err(error) => Err(ToolError::OutcomeUnknown(error)),
                }
            }
            Ok(None) => Ok(None),
            Err(error) => Err(error),
        };
        self.finish_request(request).await?;
        let Some(reply) = reply? else {
            return Ok(false);
        };
        let confirmed = matches!(
            &reply.receipt,
            Receipt::Recorded {
                cleanup: OperationCleanup::Confirmed,
                ..
            }
        );
        if confirmed {
            if let Some(active) = &self.active {
                active.lock().await.physical = true;
            }
        }
        self.observe_reply(key, &reply).await?;
        Ok(confirmed)
    }

    pub(super) async fn original_cleanup_signals(&self) -> Vec<BoxFuture<'static, ()>> {
        let calls = self
            .calls
            .lock()
            .expect("original external sources")
            .clone();
        let mut signals: Vec<BoxFuture<'static, ()>> = Vec::new();
        for call in calls {
            let Ok(mut call) = call.try_lock() else {
                continue;
            };
            for reader in call
                .readers
                .iter_mut()
                .filter(|reader| !reader.signal_armed)
            {
                let resources = reader.request.scope().resources.clone();
                reader.signal_armed = true;
                signals.push(Box::pin(async move {
                    let _historical_result = resources.settle().await;
                }));
            }
        }
        signals
    }

    pub(super) async fn original_cleanup_confirmed(&self) -> Result<bool, RunError> {
        let calls = self
            .calls
            .lock()
            .expect("original external sources")
            .clone();
        let mut first_error = None;
        let mut confirmed = true;
        for call in calls {
            match self.settle_call(&call).await {
                Ok(true) => self
                    .calls
                    .lock()
                    .expect("original external sources")
                    .retain(|owned| !Arc::ptr_eq(owned, &call)),
                Ok(false) => confirmed = false,
                Err(error) => {
                    first_error.get_or_insert(RunError::Tool(error));
                    confirmed = false;
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(confirmed
            && self
                .calls
                .lock()
                .expect("original external sources")
                .is_empty())
    }

    async fn settle_call(
        &self,
        call: &Arc<tokio::sync::Mutex<OwnedCall>>,
    ) -> Result<bool, ToolError> {
        let (key, mut physical, retained, readers, host) = {
            let source = call.lock().await;
            if !source.worker_done {
                return Ok(false);
            }
            (
                source.key,
                source.physical,
                source.retained.clone(),
                source
                    .readers
                    .iter()
                    .map(|reader| reader.request.clone())
                    .collect::<Vec<_>>(),
                source.host.clone(),
            )
        };
        for reader in readers {
            if reader.scope().resources.has_pending() {
                return Ok(false);
            }
            reader
                .finish()
                .await
                .map_err(ToolError::CleanupUnconfirmed)?;
            call.lock()
                .await
                .readers
                .retain(|owned| !Arc::ptr_eq(&owned.request, &reader));
        }
        let mut actor = self.clone();
        actor.active = Some(call.clone());
        actor.retained = retained.clone();
        let batches = retained.lock().expect("external T2 material").clone();
        for batch in batches {
            actor.settle_batch(&batch).await?;
        }
        if !physical {
            physical = actor.original_cleanup(key, host).await?;
        }
        let batches = retained.lock().expect("external T2 material").clone();
        for batch in batches {
            actor.settle_batch(&batch).await?;
        }
        let custody = {
            let mut source = call.lock().await;
            if !physical || !source.readers.is_empty() || !source.has_settlement() {
                return Ok(false);
            }
            source.custody.take()
        };
        drop(custody);
        Ok(true)
    }

    async fn settle_batch(&self, batch: &RetainedBatch) -> Result<(), ToolError> {
        use std::sync::atomic::Ordering;
        if batch.acknowledged.load(Ordering::SeqCst) {
            return Ok(());
        }
        loop {
            let publication = self
                .state
                .publication(
                    self.claim.run(),
                    batch.changes.iter().map(|change| change.id).collect(),
                    None,
                )
                .await
                .map_err(persistence)?;
            if !publication.facts.is_empty() {
                if publication.facts.len() != batch.changes.len()
                    || !publication
                        .facts
                        .iter()
                        .zip(&batch.changes)
                        .all(|(fact, change)| {
                            fact.id == change.id
                                && fact.run == self.claim.run()
                                && fact.schema_version == SCHEMA_VERSION
                                && fact.at == change.at
                                && fact.fact == change.fact
                        })
                {
                    return Err(persistence(StoreError::EventConflict));
                }
                batch.acknowledged.store(true, Ordering::SeqCst);
                return Ok(());
            }
            // The original invocation has ended. Absent preparation/admission
            // cannot be revived as a fresh grant by its cleanup observer.
            if batch.admission {
                return Ok(());
            }
            match self
                .state
                .observe_artifacts(
                    self.claim.run(),
                    batch.changes.clone(),
                    batch.contents.clone(),
                    batch.artifacts.clone(),
                )
                .await
            {
                Ok(_) => {
                    batch.acknowledged.store(true, Ordering::SeqCst);
                    return Ok(());
                }
                Err(error)
                    if matches!(
                        error.underlying(),
                        StoreError::CommitUnknown(_) | StoreError::OperationUnknown
                    ) => {}
                Err(error) => return Err(persistence(error)),
            }
        }
    }

    fn retain(
        &self,
        changes: &[Change],
        contents: &[ContentBlob],
        artifacts: &[maka_agent_facts::event::ProjectionArtifactWrite],
    ) -> Arc<RetainedBatch> {
        self.retain_batch(changes, contents, artifacts, false)
    }
    fn retain_batch(
        &self,
        changes: &[Change],
        contents: &[ContentBlob],
        artifacts: &[maka_agent_facts::event::ProjectionArtifactWrite],
        admission: bool,
    ) -> Arc<RetainedBatch> {
        let batch = Arc::new(RetainedBatch {
            changes: changes.to_vec(),
            contents: contents.to_vec(),
            artifacts: artifacts.to_vec(),
            admission,
            acknowledged: std::sync::atomic::AtomicBool::new(false),
        });
        self.retained
            .lock()
            .expect("external T2 material")
            .push(batch.clone());
        batch
    }

    async fn reconcile_owned_original(&self, key: ExternalEffectKey) -> Result<bool, ToolError> {
        let calls = self
            .calls
            .lock()
            .expect("original external sources")
            .clone();
        let mut owned = false;
        for call in calls {
            if self
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &call))
            {
                continue;
            }
            let batches = {
                let source = call.lock().await;
                if source.key != key || source.observing_prior {
                    continue;
                }
                owned = true;
                let batches = source
                    .retained
                    .lock()
                    .expect("external T2 material")
                    .clone();
                batches
            };
            for batch in batches {
                self.settle_batch(&batch).await?;
            }
        }
        Ok(owned)
    }

    async fn read_return(
        &self,
        key: ExternalEffectKey,
        name: &str,
        reference: ContentRef,
    ) -> Result<ReturnedToolResult, ToolError> {
        let run = self.claim.run();
        let id = returned_fact_id(run, key);
        let original = self
            .state
            .fact_barrier(run, id)
            .await
            .map_err(persistence)?
            .ok_or_else(|| {
                ToolError::Persistence(
                    "Original canonical external return source is unavailable".into(),
                )
            })?;
        if original.run != run
            || original.id != id
            || original.schema_version != SCHEMA_VERSION
            || !matches!(&original.fact, Fact::ExternalEffect {
                event: ExternalEffectEvent::Returned { key: original_key, output }
            } if *original_key == key && *output == reference)
        {
            return Err(persistence(StoreError::EventConflict));
        }
        let bytes = self
            .state
            .content(run, reference)
            .await
            .map_err(persistence)?;
        let name = name.to_owned();
        tokio::task::spawn_blocking(move || {
            let returned = serde_json::from_slice::<ExternalReturn>(&bytes).map_err(persistence)?;
            render_return(id, key, &name, returned)
        })
        .await
        .map_err(|error| {
            ToolError::Persistence(format!("Original return reader failed: {error}"))
        })?
    }

    async fn append(
        &self,
        context: &ToolCallContext,
        key: ExternalEffectKey,
        name: &str,
        cancellation: &CancellationToken,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
    ) -> Result<u64, ToolError> {
        let batch = self.retain_batch(&changes, &contents, &[], true);
        loop {
            let view = self.current(context, key, name, cancellation).await?;
            match self
                .state
                .append(
                    &self.claim,
                    Head::from(&view),
                    changes.clone(),
                    contents.clone(),
                )
                .await
            {
                Ok(commit) => {
                    batch
                        .acknowledged
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    return Ok(commit
                        .facts
                        .last()
                        .expect("nonempty external effect transaction")
                        .revision);
                }
                Err(error) if matches!(error.underlying(), StoreError::RevisionConflict { .. }) => {
                    continue;
                }
                Err(error) => return self.reconcile(&changes, error).await,
            }
        }
    }

    async fn reconcile(&self, changes: &[Change], error: StoreError) -> Result<u64, ToolError> {
        if !matches!(
            error.underlying(),
            StoreError::CommitUnknown(_) | StoreError::OperationUnknown
        ) {
            return Err(persistence(error));
        }
        let publication = self
            .state
            .publication(
                self.claim.run(),
                changes.iter().map(|change| change.id).collect(),
                None,
            )
            .await
            .map_err(persistence)?;
        if publication.facts.is_empty() {
            return Err(ToolError::OutcomeUnknown(error.to_string()));
        }
        if publication.facts.len() != changes.len()
            || !publication.facts.iter().zip(changes).all(|(fact, change)| {
                fact.id == change.id
                    && fact.run == self.claim.run()
                    && fact.schema_version == SCHEMA_VERSION
                    && fact.at == change.at
                    && fact.fact == change.fact
            })
        {
            return Err(persistence(StoreError::EventConflict));
        }
        Ok(publication
            .facts
            .last()
            .expect("nonempty original batch")
            .revision)
    }

    fn deliver(&self, result: Result<ReturnedToolResult, ToolError>) {
        if let Some(reply) = self
            .observation
            .lock()
            .expect("external effect observation")
            .take()
        {
            let _ = reply.send(result);
        }
    }

    async fn observe(
        &self,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
    ) -> Result<(), ToolError> {
        let batch = self.retain(&changes, &contents, &[]);
        let result = match self
            .state
            .observe(self.claim.run(), changes.clone(), contents.clone())
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => self.reconcile(&changes, error).await.map(|_| ()),
        };
        if result.is_ok() {
            batch
                .acknowledged
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        result
    }

    async fn block(&self, key: ExternalEffectKey) -> Result<(), ToolError> {
        // A late producer may publish evidence, but cannot make policy for a new driver.
        let event = Change::new(
            Fact::Blocked {
                blocker: BlockerId::new(),
                reason: BlockerKind::ExternalEffectUnknown {
                    task: key.task,
                    operation: key.operation,
                },
            },
            at(),
        );
        let batch = self.retain_batch(&[event.clone()], &[], &[], true);
        loop {
            let view = match self.access.fresh().await {
                Ok(view) => view,
                Err(_) => return Ok(()),
            };
            if view.stopped
                || view.terminal.is_some()
                || view.blockers.values().any(|blocker| {
                    blocker.reason
                        == BlockerKind::ExternalEffectUnknown {
                            task: key.task,
                            operation: key.operation,
                        }
                        && blocker.decision.is_none()
                        && blocker.resolved_by.is_none()
                })
            {
                return Ok(());
            }
            match self
                .state
                .append(&self.claim, Head::from(&view), vec![event.clone()], vec![])
                .await
            {
                Ok(_) => {
                    batch
                        .acknowledged
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    return Ok(());
                }
                Err(error) if matches!(error.underlying(), StoreError::RevisionConflict { .. }) => {
                    continue;
                }
                Err(error) => return self.reconcile(&[event], error).await.map(|_| ()),
            }
        }
    }

    fn request(
        &self,
        operation: Option<String>,
    ) -> Result<maka_host_runtime::application::NativeRequest, ToolError> {
        self.owner
            .services
            .request_with_work(
                Identity::Agent {
                    execution: self.access.execution().clone(),
                    operation_id: operation,
                },
                CancellationToken::new(),
                self.access.custody().clone(),
            )
            .and_then(|request| {
                request.with_sandbox_floor(&self.access.spec().permission_ceiling.sandbox)
            })
            .map_err(ToolError::Failed)
    }

    async fn recover(
        &self,
        key: ExternalEffectKey,
        descriptor: &ExternalEffectDescriptor,
        reference: Option<RecoveryRef>,
    ) -> Result<ReturnedToolResult, ToolError> {
        let reference = match reference {
            Some(reference) => reference,
            None => {
                let request = self.request(Some(descriptor.operation_id.clone()))?;
                let operation =
                    crate::tools::operation_uuid(&descriptor.execution, &descriptor.operation_id);
                let original = match request.lookup_intent(operation) {
                    Ok(observer) => observer.await,
                    Err(error) => Err(error),
                };
                self.finish_request(request).await?;
                match original.map_err(|message| ToolError::OutcomeUnknown(message))? {
                    Some(intent) => intent.reference,
                    None => {
                        self.block(key).await?;
                        return Err(ToolError::OutcomeUnknown("Original admitted Host effect has no observable reference; it will not be reexecuted".into()));
                    }
                }
            }
        };
        self.observe(
            vec![change(ExternalEffectEvent::Bound {
                key,
                reference: reference.clone(),
            })],
            vec![],
        )
        .await?;
        let request = self.request(None)?;
        let original = match request.recover(reference.clone()) {
            Ok(observer) => observer.await,
            Err(error) => Err(error),
        };
        let finished = self.finish_request(request).await;
        let reply = OperationReply {
            reference,
            receipt: match original {
                Ok(Some(observation)) => Receipt::Recorded {
                    outcome: observation.outcome,
                    cleanup: observation.cleanup,
                },
                Ok(None) => Receipt::NotRecorded,
                Err(diagnostic) => Receipt::Unavailable { diagnostic },
            },
        };
        self.observe_reply(key, &reply).await?;
        if let Err(failure) = finished {
            let error = ToolError::OperationCleanupUnconfirmed {
                message: failure.to_string(),
                observation: Box::new(reply),
            };
            self.cleanup.observe_tool(&error);
            self.block(key).await?;
            return Err(error);
        }
        if let Some(error) = operation_return_error(&reply) {
            self.cleanup.observe_tool(&error);
            self.block(key).await?;
            return Err(error);
        }
        let original = self
            .state
            .external_effect(self.claim.run(), key)
            .await
            .map_err(persistence)?
            .ok_or_else(|| ToolError::Persistence("Original external effect disappeared".into()))?;
        if let Some(reference) = original.returned {
            return self.read_return(key, &descriptor.name, reference).await;
        }
        Err(ToolError::Persistence(
            "Original canonical external return source is unavailable; receipt observation does not republish business output".into(),
        ))
    }

    async fn observe_reply(
        &self,
        key: ExternalEffectKey,
        reply: &OperationReply,
    ) -> Result<(), ToolError> {
        if let Some(active) = &self.active {
            let mut source = active.lock().await;
            if source.observation.as_ref() == Some(reply) {
                return Ok(());
            }
            source.host = Some(reply.reference.clone());
            source.observation = Some(reply.clone());
        }
        let mut changes = vec![
            change(ExternalEffectEvent::Bound {
                key,
                reference: reply.reference.clone(),
            }),
            change(ExternalEffectEvent::Observed {
                key,
                observation: reply.clone(),
            }),
        ];
        if let Receipt::Recorded { cleanup, .. } = &reply.receipt {
            changes.push(change(ExternalEffectEvent::CleanupObserved {
                key,
                cleanup: cleanup.clone(),
            }));
        }
        self.observe(changes, vec![]).await
    }

    async fn settle(
        &self,
        key: ExternalEffectKey,
        name: &str,
        result: Result<ToolSuccess, ToolError>,
        failure: ToolSettlement,
    ) -> Result<ReturnedToolResult, ToolError> {
        match result {
            Ok(success) => {
                let execution = self.access.execution().clone();
                let run = self.claim.run();
                let id = returned_fact_id(run, key);
                let name = name.to_owned();
                let (blob, artifacts, output, is_error, projection) =
                    tokio::task::spawn_blocking(move || {
                        let normalized = success
                            .into_durable(
                                &format!("external:{}:{}", key.task, key.operation),
                                SystemTime::now(),
                                &execution,
                            )
                            .map_err(|message| ToolError::OutcomeUnknown(message.into()))?;
                        let returned = ExternalReturn::Output {
                            output: normalized.output,
                            is_error: normalized.is_error,
                            projection: normalized.projection,
                        };
                        let blob = ContentBlob::json(&returned).map_err(persistence)?;
                        let ExternalReturn::Output {
                            output,
                            is_error,
                            projection,
                        } = returned
                        else {
                            unreachable!()
                        };
                        let projection = display_projection(id, key, &name, projection);
                        Ok::<_, ToolError>((
                            blob,
                            normalized.artifacts,
                            output,
                            is_error,
                            projection,
                        ))
                    })
                    .await
                    .map_err(|error| {
                        ToolError::OutcomeUnknown(format!(
                            "Original return preparation failed: {error}"
                        ))
                    })??;
                if let ToolOutput::Operation(reply) = &output {
                    self.observe_reply(key, reply).await?;
                    if let Some(error) = operation_return_error(reply) {
                        self.cleanup.observe_tool(&error);
                        self.block(key).await?;
                        return Err(error);
                    }
                }
                self.publish_return_blob(key, blob, artifacts).await?;
                Ok(ReturnedToolResult {
                    output,
                    is_error,
                    projection: projection?,
                    loaded_tools: Default::default(),
                })
            }
            Err(
                error @ (ToolError::OperationUnknown { .. }
                | ToolError::OperationCleanupUnconfirmed { .. }),
            ) => {
                let observation = match &error {
                    ToolError::OperationUnknown { observation, .. }
                    | ToolError::OperationCleanupUnconfirmed { observation, .. } => observation,
                    _ => unreachable!(),
                };
                self.observe_reply(key, observation).await?;
                self.cleanup.observe_tool(&error);
                self.block(key).await?;
                Err(error)
            }
            Err(
                error @ (ToolError::OutcomeUnknown(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::Persistence(_)),
            ) => {
                self.cleanup.observe_tool(&error);
                if matches!(error, ToolError::OutcomeUnknown(_)) {
                    self.cleanup.observe_tool(&ToolError::CleanupUnconfirmed(
                        "External Host worker has no physical cleanup proof".into(),
                    ));
                }
                self.block(key).await?;
                Err(error)
            }
            Err(error) => {
                let (blob, error) = tokio::task::spawn_blocking(move || {
                    let returned = ExternalReturn::Failure {
                        settlement: failure,
                        diagnostic: match &error {
                            ToolError::Failed(diagnostic) => diagnostic.clone(),
                            _ => error.to_string(),
                        },
                    };
                    let blob = ContentBlob::json(&returned).map_err(persistence)?;
                    Ok::<_, ToolError>((blob, error))
                })
                .await
                .map_err(|error| {
                    ToolError::OutcomeUnknown(format!(
                        "Original failure preparation failed: {error}"
                    ))
                })??;
                self.publish_return_blob(key, blob, vec![]).await?;
                Err(error)
            }
        }
    }

    async fn publish_return_blob(
        &self,
        key: ExternalEffectKey,
        blob: ContentBlob,
        artifacts: Vec<maka_agent_facts::event::ProjectionArtifactWrite>,
    ) -> Result<(), ToolError> {
        let changes = vec![
            change(ExternalEffectEvent::CleanupObserved {
                key,
                cleanup: OperationCleanup::Confirmed,
            }),
            Change {
                id: returned_fact_id(self.claim.run(), key),
                at: at(),
                fact: Fact::ExternalEffect {
                    event: ExternalEffectEvent::Returned {
                        key,
                        output: blob.reference().clone(),
                    },
                },
            },
        ];
        let batch = self.retain(&changes, &[blob.clone()], &artifacts);
        let committed = match self
            .state
            .observe_artifacts(
                self.claim.run(),
                changes.clone(),
                vec![blob.clone()],
                artifacts.clone(),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => self.reconcile(&changes, error).await.map(|_| ()),
        };
        if committed.is_ok() {
            batch
                .acknowledged
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        drop((blob, artifacts));
        committed
    }
}

impl HostEffects for NativeExternalEffects {
    fn invoke(
        &self,
        catalog: ToolCatalog,
        context: ToolCallContext,
        name: String,
        input: Value,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Result<ReturnedToolResult, ToolError>> {
        let key = match self.key(&context) {
            Ok(key) => key,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        let mut owner = self.clone();
        let (reply, observed) = oneshot::channel();
        owner.observation = Arc::new(Mutex::new(Some(reply)));
        owner.retained = Arc::new(Mutex::new(Vec::new()));
        let call = Arc::new(tokio::sync::Mutex::new(OwnedCall {
            key,
            custody: None,
            execution_owned: false,
            observing_prior: false,
            worker_done: false,
            physical: false,
            retained: owner.retained.clone(),
            readers: vec![],
            host: None,
            observation: None,
        }));
        owner.active = Some(call.clone());
        self.calls
            .lock()
            .expect("original external sources")
            .push(call.clone());
        // Admission, execution and T2 have one owner, independent of this observer's lifetime.
        self.workers.spawn(async move {
            let result = owner
                .invoke_original(catalog, context, name, input, cancellation)
                .await;
            if let Err(error) = &result {
                owner.cleanup.observe_tool(error);
            }
            {
                let mut source = call.lock().await;
                source.worker_done = true;
                if result.is_ok() || !source.execution_owned && !source.observing_prior {
                    source.physical = true;
                }
            }
            // The common successful path already owns every T2 ACK. Release it
            // without retaining the whole successful tool history until Run end.
            let ready = {
                let source = call.lock().await;
                let acknowledged = source
                    .retained
                    .lock()
                    .expect("external T2 material")
                    .iter()
                    .all(|batch| batch.acknowledged.load(std::sync::atomic::Ordering::SeqCst));
                source.physical
                    && source.readers.is_empty()
                    && source.has_settlement()
                    && acknowledged
            };
            if ready {
                let custody = call.lock().await.custody.take();
                drop(custody);
                owner
                    .calls
                    .lock()
                    .expect("original external sources")
                    .retain(|owned| !Arc::ptr_eq(owned, &call));
            }
            owner.deliver(result);
        });
        Box::pin(async move {
            observed.await.map_err(|_| {
                ToolError::OutcomeUnknown("Original external Host observation closed".into())
            })?
        })
    }
}

fn returned_fact_id(run: RunId, key: ExternalEffectKey) -> FactId {
    let bytes = serde_json::to_vec(&("maka.external-host-return-fact.v1", run, key))
        .expect("external return identity");
    let digest = Sha256::digest(bytes);
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("SHA256 prefix");
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    FactId::try_from(Uuid::from_bytes(bytes)).expect("nonnil external return fact identity")
}

fn render_return(
    id: FactId,
    key: ExternalEffectKey,
    name: &str,
    returned: ExternalReturn,
) -> Result<ReturnedToolResult, ToolError> {
    let (output, is_error, projection) = match returned {
        ExternalReturn::Output {
            output,
            is_error,
            projection,
        } => (output, is_error, projection),
        ExternalReturn::Failure { diagnostic, .. } => return Err(ToolError::Failed(diagnostic)),
    };
    let projection = display_projection(id, key, name, projection)?;
    Ok(ReturnedToolResult {
        output,
        is_error,
        projection,
        loaded_tools: Default::default(),
    })
}

fn display_projection(
    id: FactId,
    key: ExternalEffectKey,
    name: &str,
    projection: DurableToolProjection,
) -> Result<DurableToolProjection, ToolError> {
    match maka_agent_facts::archive::ArchivedPlaceholder::prepare(
        id.to_string(),
        format!("external:{}:{}", key.task, key.operation),
        name.to_owned(),
        &projection,
    )
    .map_err(persistence)?
    {
        Some(archived) => archived.to_canonical_projection().map_err(persistence),
        None => Ok(projection),
    }
}

fn operation_return_error(reply: &OperationReply) -> Option<ToolError> {
    match &reply.receipt {
        Receipt::Recorded {
            cleanup: OperationCleanup::Unconfirmed | OperationCleanup::Failed { .. },
            ..
        } => Some(ToolError::OperationCleanupUnconfirmed {
            message: "Original Host operation cleanup is unconfirmed".into(),
            observation: Box::new(reply.clone()),
        }),
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
            cleanup: OperationCleanup::Confirmed,
        } => None,
        _ => Some(ToolError::OperationUnknown {
            message: "Original Host operation outcome is unknown".into(),
            observation: Box::new(reply.clone()),
        }),
    }
}

fn at() -> UnixMillis {
    UnixMillis(now().try_into().expect("Unix milliseconds"))
}
fn change(event: ExternalEffectEvent) -> Change {
    Change::new(Fact::ExternalEffect { event }, at())
}
fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}
