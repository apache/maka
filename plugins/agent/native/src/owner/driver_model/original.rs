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

use super::{DriverModel, Evidence, ModelAttemptId, RunError, preparation};
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use maka_agent_engine::{ModelCleanupPublication, ModelWitness, prepared_prompt::PreparedPrompt};
use maka_agent_facts::durable::{FactId, RunId, UnixMillis};
use maka_plugin_core::operation::OperationCleanup;
use std::sync::{Arc, Mutex};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio_util::{
    sync::CancellationToken,
    task::{TaskTracker, task_tracker::TaskTrackerToken},
};
type SourceClosure = Shared<BoxFuture<'static, Result<(), Arc<tokio::task::JoinError>>>>;

pub(super) struct ModelWork {
    pub(super) cancellation: CancellationToken,
    pub(super) worker: TaskTracker,
    started: AtomicBool,
}
impl ModelWork {
    pub(super) fn activate(&self) -> Result<TaskTrackerToken, RunError> {
        let token = self.worker.token();
        if self.started.swap(true, Ordering::AcqRel) {
            return Err(RunError::InvalidInput(
                "original model source was already activated".into(),
            ));
        }
        Ok(token)
    }
}

struct PendingObservation {
    publication: ModelCleanupPublication,
    retry_hint_sent: AtomicBool,
}
impl PendingObservation {
    fn new(publication: ModelCleanupPublication) -> Arc<Self> {
        Arc::new(Self {
            publication,
            retry_hint_sent: AtomicBool::new(false),
        })
    }
}
#[derive(Clone)]
struct CleanupChanges(tokio::sync::watch::Sender<()>);
impl Default for CleanupChanges {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(()).0)
    }
}

struct OwnedCleanup {
    attempt: ModelAttemptId,
    witness: ModelWitness,
    partial: Option<Arc<PendingObservation>>,
    physical_closed: Option<UnixMillis>,
    confirmed: Option<Arc<PendingObservation>>,
    first_failure: Option<Arc<RunError>>,
}
#[derive(Clone, Default)]
pub(in crate::owner) struct OriginalModelCleanup {
    pub(super) physical: Evidence,
    changes: CleanupChanges,
    reconciling: Arc<tokio::sync::Mutex<()>>,
    owned: Arc<Mutex<Vec<OwnedCleanup>>>,
    material: Arc<Mutex<Vec<PreparedPrompt>>>,
    partial_material: Arc<Mutex<Vec<Arc<maka_agent_facts::model::assembly::AttemptCut>>>>,
    runtime: Arc<Mutex<Vec<maka_model::ModelCleanupObserver>>>,
    continuations: Arc<Mutex<Vec<(ModelAttemptId, SourceClosure)>>>,
    work: Arc<Mutex<BTreeMap<ModelAttemptId, Arc<ModelWork>>>>,
    failures: Arc<Mutex<Vec<maka_model::StreamCleanupError>>>,
    #[cfg(test)]
    lose_partial_ack: Arc<AtomicBool>,
}
impl OriginalModelCleanup {
    #[cfg(test)]
    pub(in crate::owner) fn lose_next_partial_ack(&self) {
        self.lose_partial_ack.store(true, Ordering::Release);
    }
    pub(in crate::owner) fn changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.changes.0.subscribe()
    }
    pub(super) fn work(
        &self,
        attempt: ModelAttemptId,
        parent: &CancellationToken,
    ) -> Arc<ModelWork> {
        let pending: std::collections::BTreeSet<_> = self
            .owned
            .lock()
            .unwrap()
            .iter()
            .map(|owned| owned.attempt)
            .collect();
        let mut work = self.work.lock().unwrap();
        work.retain(|id, work| {
            *id == attempt
                || pending.contains(id)
                || !work.started.load(Ordering::Acquire)
                || !work.worker.is_empty()
        });
        work.entry(attempt)
            .or_insert_with(|| {
                let worker = TaskTracker::new();
                worker.close();
                Arc::new(ModelWork {
                    cancellation: parent.child_token(),
                    worker,
                    started: AtomicBool::new(false),
                })
            })
            .clone()
    }
    pub(in crate::owner) fn has_retained(&self) -> bool {
        !self.physical.confirmed()
            || !self.owned.lock().unwrap().is_empty()
            || !self.material.lock().unwrap().is_empty()
            || !self.partial_material.lock().unwrap().is_empty()
            || self
                .runtime
                .lock()
                .unwrap()
                .iter()
                .any(|observer| !matches!(observer.status(), Ok(true)))
            || self
                .work
                .lock()
                .unwrap()
                .values()
                .any(|work| !work.started.load(Ordering::Acquire) || !work.worker.is_empty())
    }

    pub(super) fn own(&self, attempt: ModelAttemptId, witness: ModelWitness) {
        self.owned.lock().unwrap().push(OwnedCleanup {
            attempt,
            witness,
            partial: None,
            physical_closed: None,
            confirmed: None,
            first_failure: None,
        });
    }
    fn acknowledged(&self, attempt: ModelAttemptId) {
        self.owned
            .lock()
            .unwrap()
            .retain(|owned| owned.attempt != attempt);
    }
    pub(super) fn retain_failure(&self, error: maka_model::StreamCleanupError) {
        self.failures.lock().unwrap().push(error);
    }
    pub(super) fn follow(
        &self,
        attempt: ModelAttemptId,
        observer: maka_model::ModelCleanupObserver,
        prompt: Option<PreparedPrompt>,
        partial: Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>,
    ) {
        self.runtime.lock().unwrap().push(observer.clone());
        let original = self.clone();
        let follow = self
            .work
            .lock()
            .unwrap()
            .get(&attempt)
            .expect("original model follow belongs to its admitted worker")
            .worker
            .token();
        let job = tokio::spawn(async move {
            if let Err(error) = observer.wait().await {
                original.retain_failure(error);
                original.physical.observe(&RunError::CleanupUnconfirmed);
                if let Some(prompt) = prompt {
                    original.retain(prompt);
                }
                if let Some(partial) = partial {
                    original.retain_partial(partial);
                }
                return;
            }
            if let Some(prompt) = prompt {
                if let Err(error) = prompt.close().await {
                    original
                        .physical
                        .observe(&RunError::PreparationCleanup(error));
                    original.retain(prompt);
                    if let Some(partial) = partial {
                        original.retain_partial(partial);
                    }
                    return;
                }
            }
            let at = match super::witnessed_at() {
                Ok(at) => at,
                Err(error) => {
                    original.remember_failure(attempt, Arc::new(error));
                    if let Some(partial) = partial {
                        original.retain_partial(partial);
                    }
                    return;
                }
            };
            let pending_partial = match partial {
                Some(partial) => {
                    let blob = match super::private_partial_blob(&partial) {
                        Ok(blob) => blob,
                        Err(error) => {
                            original.remember_failure(attempt, Arc::new(error));
                            original.retain_partial(partial);
                            return;
                        }
                    };
                    let witness = original
                        .owned
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|owned| owned.attempt == attempt)
                        .expect("original private partial witness")
                        .witness
                        .clone();
                    Some(PendingObservation::new(
                        witness.prepare_private_partial(blob, at),
                    ))
                }
                None => None,
            };
            {
                let mut owned = original.owned.lock().unwrap();
                let owned = owned
                    .iter_mut()
                    .find(|owned| owned.attempt == attempt)
                    .expect("original cleanup witness");
                owned.partial = pending_partial;
                owned.physical_closed = Some(at);
            }
            // The original pending publications now own all metadata; their ACK notifications
            // must observe an empty physical worker, not a still-held observer token.
            drop(follow);
            if let Err(error) = original.reconcile_attempt(attempt).await {
                tracing::error!(%error, "original late model cleanup publication unresolved");
            }
        });
        self.continuations.lock().unwrap().push((
            attempt,
            async move { job.await.map_err(Arc::new) }.boxed().shared(),
        ));
    }
    fn remember_failure(&self, attempt: ModelAttemptId, error: Arc<RunError>) {
        if let Some(owned) = self
            .owned
            .lock()
            .unwrap()
            .iter_mut()
            .find(|owned| owned.attempt == attempt)
        {
            if owned.first_failure.is_none() {
                owned.first_failure = Some(error);
            }
        }
    }
    pub(super) async fn publish_confirmed(
        &self,
        attempt: ModelAttemptId,
        at: UnixMillis,
    ) -> Result<FactId, Arc<RunError>> {
        let publication = {
            let mut owned = self.owned.lock().unwrap();
            let owned = owned
                .iter_mut()
                .find(|owned| owned.attempt == attempt)
                .expect("original admitted cleanup witness");
            owned
                .confirmed
                .get_or_insert_with(|| {
                    PendingObservation::new(
                        owned
                            .witness
                            .prepare_cleanup(OperationCleanup::Confirmed, at),
                    )
                })
                .clone()
        };
        self.reconcile_confirmed(attempt, publication).await
    }
    async fn reconcile_confirmed(
        &self,
        attempt: ModelAttemptId,
        publication: Arc<PendingObservation>,
    ) -> Result<FactId, Arc<RunError>> {
        match self.reconcile_observation(attempt, &publication).await {
            Ok(fact) => {
                self.acknowledged(attempt);
                Ok(fact)
            }
            Err(error) => Err(error),
        }
    }
    async fn reconcile_observation(
        &self,
        attempt: ModelAttemptId,
        pending: &PendingObservation,
    ) -> Result<FactId, Arc<RunError>> {
        match pending.publication.reconcile().await {
            Ok(fact) => Ok(fact),
            Err(error) => {
                let error = Arc::new(error);
                self.remember_failure(attempt, error.clone());
                if !pending.retry_hint_sent.swap(true, Ordering::AcqRel) {
                    self.changes.0.send_modify(|_| {});
                }
                Err(error)
            }
        }
    }
    async fn reconcile_attempt(&self, attempt: ModelAttemptId) -> Result<(), Arc<RunError>> {
        let _reconciling = self.reconciling.lock().await;
        let pending = self
            .owned
            .lock()
            .unwrap()
            .iter()
            .find(|owned| owned.attempt == attempt)
            .map(|owned| {
                (
                    owned.partial.clone(),
                    owned.physical_closed,
                    owned.confirmed.clone(),
                )
            });
        let Some((partial, closed, confirmed)) = pending else {
            return Ok(());
        };
        if let Some(partial) = partial {
            self.reconcile_observation(attempt, &partial).await?;
            #[cfg(test)]
            if self.lose_partial_ack.swap(false, Ordering::AcqRel) {
                let error = Arc::new(RunError::Internal(
                    "lost original private-partial acknowledgement after canonical commit".into(),
                ));
                self.remember_failure(attempt, error.clone());
                return Err(error);
            }
            if let Some(owned) = self
                .owned
                .lock()
                .unwrap()
                .iter_mut()
                .find(|owned| owned.attempt == attempt)
            {
                owned.partial = None;
            }
        }
        match confirmed {
            Some(confirmed) => {
                self.reconcile_confirmed(attempt, confirmed).await?;
            }
            None => {
                if let Some(at) = closed {
                    self.publish_confirmed(attempt, at).await?;
                }
            }
        }
        Ok(())
    }
    pub(in crate::owner) async fn reconcile_pending(&self) -> Result<(), Arc<RunError>> {
        let pending: Vec<_> = self
            .owned
            .lock()
            .unwrap()
            .iter()
            .filter(|owned| owned.physical_closed.is_some() || owned.confirmed.is_some())
            .map(|owned| owned.attempt)
            .collect();
        let mut failure = None;
        for attempt in pending {
            if let Err(error) = self.reconcile_attempt(attempt).await {
                failure.get_or_insert(error);
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub(super) fn retain(&self, prompt: PreparedPrompt) {
        self.material.lock().unwrap().push(prompt);
    }
    pub(super) fn retain_partial(
        &self,
        partial: Arc<maka_agent_facts::model::assembly::AttemptCut>,
    ) {
        self.partial_material.lock().unwrap().push(partial);
    }
}
impl DriverModel {
    pub(in crate::owner) async fn cancel_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
    ) -> Result<(), RunError> {
        if run != self.execution.run_id {
            return Err(RunError::InvalidInput(
                "model cancellation belongs to another execution".into(),
            ));
        }
        let view = self.state.frontier(run).await?;
        let original = view.attempts.get(&attempt).ok_or_else(|| {
            RunError::InvalidInput("model cancellation lost its original attempt".into())
        })?;
        let existing = self
            .original_cleanup
            .work
            .lock()
            .unwrap()
            .get(&attempt)
            .cloned();
        if existing.is_none() && original.cleanup == OperationCleanup::Confirmed {
            return Ok(());
        }
        let work =
            existing.unwrap_or_else(|| self.original_cleanup.work(attempt, &self.cancellation));
        work.cancellation.cancel();
        if !work.started.load(Ordering::Acquire) {
            return Err(RunError::CleanupUnconfirmed);
        }
        work.worker.wait().await;
        if view.finish_requested() {
            let conversation = self.conversation.lock().unwrap().as_ref().cloned();
            if let Some(conversation) = conversation {
                conversation.retire();
            }
        }
        let continuations: Vec<_> = self
            .original_cleanup
            .continuations
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| *id == attempt)
            .map(|(_, continuation)| continuation.clone())
            .collect();
        for continuation in continuations {
            continuation.await.map_err(|error| {
                RunError::ReconciliationRequired(format!(
                    "original model cleanup observer failed: {error}"
                ))
            })?;
        }
        let view = self.state.frontier(run).await?;
        if view
            .attempts
            .get(&attempt)
            .is_none_or(|original| original.cleanup != OperationCleanup::Confirmed)
            || self
                .original_cleanup
                .partial_material
                .lock()
                .unwrap()
                .iter()
                .any(|cut| cut.binding.attempt_id == attempt)
        {
            return Err(RunError::CleanupUnconfirmed);
        }
        Ok(())
    }
    pub(super) fn preparation_io(&self) -> Result<preparation::PreparationIo, RunError> {
        Ok(preparation::PreparationIo::new_tracked(
            &self.log,
            self.workers.clone(),
            self.original_cleanup.physical.clone(),
        )?)
    }
    pub(in crate::owner) fn original_cleanup_signals(&self) -> Vec<BoxFuture<'static, ()>> {
        self.workers.close();
        let workers = self.workers.clone();
        let original = self.original_cleanup.clone();
        let conversation = self.conversation.clone();
        vec![
            async move {
                // Only tracked main workers register follow-ups; draining seals this set.
                workers.wait().await;
                let session = conversation.lock().unwrap().as_ref().cloned();
                if let Some(session) = session {
                    session.retire();
                }
                let continuations = original.continuations.lock().unwrap().clone();
                for (_, continuation) in continuations {
                    let _joined = continuation.await;
                }
                workers.wait().await;
            }
            .boxed(),
        ]
    }
    pub(in crate::owner) async fn original_cleanup_confirmed(&self) -> Result<bool, RunError> {
        self.workers.close();
        if !self.workers.is_empty() {
            return Ok(false);
        }
        if self
            .original_cleanup
            .work
            .lock()
            .unwrap()
            .values()
            .any(|work| !work.started.load(Ordering::Acquire) || !work.worker.is_empty())
        {
            return Ok(false);
        }
        if let Err(error) = self.original_cleanup.reconcile_pending().await {
            tracing::error!(%error, "original model cleanup ACK remains unresolved");
            return Ok(false);
        }
        let conversation = self.conversation.lock().unwrap().as_ref().cloned();
        if let Some(conversation) = conversation {
            conversation.retire();
        }
        if !self.original_cleanup.physical.confirmed() {
            return Ok(false);
        }
        if !self
            .original_cleanup
            .partial_material
            .lock()
            .unwrap()
            .is_empty()
            || !self.original_cleanup.material.lock().unwrap().is_empty()
        {
            return Ok(false);
        }
        let runtime = self.original_cleanup.runtime.lock().unwrap().clone();
        for observer in runtime {
            match observer.status() {
                Ok(true) => {}
                Ok(false) | Err(_) => return Ok(false),
            }
        }
        let continuations = self.original_cleanup.continuations.lock().unwrap().clone();
        for (_, continuation) in continuations {
            if !matches!(continuation.peek(), Some(Ok(()))) {
                return Ok(false);
            }
        }
        if !self.original_cleanup.physical.confirmed() {
            return Ok(false);
        }
        let owned: Vec<_> = self
            .original_cleanup
            .owned
            .lock()
            .unwrap()
            .iter()
            .map(|owned| (owned.attempt, owned.confirmed.clone()))
            .collect();
        for (attempt, publication) in owned {
            let result = match publication {
                Some(publication) => {
                    self.original_cleanup
                        .reconcile_confirmed(attempt, publication)
                        .await
                }
                // Empty workers do not prove EOF or prompt/partial closure.
                None => return Ok(false),
            };
            if let Err(error) = result {
                tracing::error!(%error,"original model cleanup ACK remains unresolved");
                return Ok(false);
            }
        }
        Ok(!self.original_cleanup.has_retained())
    }
}
