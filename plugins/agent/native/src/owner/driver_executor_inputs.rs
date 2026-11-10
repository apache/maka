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

//! Actual current-Run capabilities for native history and ordered steering.
use super::{Owner, access::RunAccess, now};
use crate::executor::external::Inputs;
use futures_util::future::BoxFuture;
use maka_agent_authority::permissions::Access;
use maka_agent_facts::{
    durable::*,
    external_steering::{ExternalSteeringEvent, ExternalSteeringKey},
    input::MessageInput,
    message::{RootSourceMessage, aggregate},
};
use maka_agent_ports::executor::Error;
use maka_agent_state::{
    Change, ContentBlob, DriverClaim, Head, Store,
    artifacts::{ArtifactStore, SessionScope},
    external_steering::{ExternalSteeringSource, ExternalSteeringSpec, attributed_source},
    fold::RunView,
    queue::Consume,
    session_history::{HistoryCut, SessionHistory},
};
use maka_event_log::StoreError;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};
use uuid::Uuid;

pub(super) struct NativeInputs {
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    claim: DriverClaim,
    state: Store,
    history: SessionHistory,
    cut: OnceCell<HistoryCut>,
    pending: Mutex<Option<Pending>>,
}
struct Pending {
    spec: ExternalSteeringSpec,
    changes: Vec<Change>,
    contents: Vec<ContentBlob>,
    input: MessageInput,
}
impl NativeInputs {
    pub(super) fn new(
        owner: Arc<Owner>,
        access: Arc<RunAccess>,
        claim: DriverClaim,
    ) -> Result<Self, Error> {
        let execution = access.execution();
        if execution.run_id != claim.run()
            || access.spec().owner != owner.run_owner()
            || access.spec().session_id != execution.session_id
        {
            return Err(Error::Invalid(
                "External inputs belong to another Run".into(),
            ));
        }
        let data = owner
            .store
            .data_writer_for_work(access.custody().as_ref(), &execution.session_id)
            .map_err(persistence)?;
        let state = owner.durable.with_data_writer(data).map_err(persistence)?;
        let history =
            state.session_history(access.spec().owner.clone(), execution.session_id.clone());
        Ok(Self {
            owner,
            access,
            claim,
            state,
            history,
            cut: OnceCell::new(),
            pending: Mutex::new(None),
        })
    }
    async fn stopped(&self, task: ExternalTaskId) -> Result<bool, Error> {
        let view = self
            .state
            .original_driver_frontier(&self.claim)
            .await
            .map_err(persistence)?;
        if view.run != self.access.execution().run_id || view.spec != *self.access.spec() {
            return Err(Error::Invalid("External input Run changed".into()));
        }
        let original = view.external.as_ref().ok_or(Error::Unknown)?;
        if original.task != task || !original.admitted {
            return Err(Error::Unknown);
        }
        Ok(view.stopped)
    }
    async fn current(&self, task: ExternalTaskId) -> Result<Option<RunView>, Error> {
        if self.owner.stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if let Err(error) = self.access.live_configuration().await {
            if self.stopped(task).await? {
                return Ok(None);
            }
            return Err(Error::Provider(error.to_string()));
        }
        let view = match self.state.driver_frontier(&self.claim).await {
            Ok(view) => view,
            Err(error) => {
                if self.stopped(task).await? {
                    return Ok(None);
                }
                return Err(persistence(error));
            }
        };
        if view.run != self.access.execution().run_id || view.spec != *self.access.spec() {
            return Err(Error::Invalid("External input Run changed".into()));
        }
        if view.terminal.is_some() {
            return Err(Error::Cancelled);
        }
        let original = view.external.as_ref().ok_or(Error::Unknown)?;
        if original.task != task || !original.admitted {
            return Err(Error::Unknown);
        }
        if view.stopped {
            return Ok(None);
        }
        if original.closed.is_some() {
            return Err(Error::Unknown);
        }
        if view
            .blockers
            .values()
            .any(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none())
        {
            return Err(Error::Unknown);
        }
        Ok(Some(view))
    }
    async fn freeze(&self, task: ExternalTaskId) -> Result<Option<Pending>, Error> {
        let session = &self.access.execution().session_id;
        let queue = self.state.queue();
        let prefix = queue
            .steering(session.clone(), self.claim.run())
            .await
            .map_err(persistence)?;
        if prefix.entries.is_empty() {
            return Ok(None);
        }
        let mut sources = Vec::with_capacity(prefix.entries.len());
        let mut messages = Vec::with_capacity(prefix.entries.len());
        let mut contents = Vec::new();
        for entry in &prefix.entries {
            let source_bytes = queue
                .content(
                    session.clone(),
                    entry.request.id.clone(),
                    entry.request.source.clone(),
                )
                .await
                .map_err(persistence)?;
            let source: RootSourceMessage = serde_json::from_slice(&source_bytes)
                .map_err(|error| Error::Invalid(error.to_string()))?;
            source
                .validate()
                .map_err(|error| Error::Invalid(error.into()))?;
            let resources = queue
                .content(
                    session.clone(),
                    entry.request.id.clone(),
                    entry.request.resources.clone(),
                )
                .await
                .map_err(persistence)?;
            let source_blob = ContentBlob::new(source_bytes);
            let resource_blob = ContentBlob::new(resources);
            if source_blob.reference() != &entry.request.source
                || resource_blob.reference() != &entry.request.resources
                || source.message.message_id != entry.request.message_id
            {
                return Err(Error::Invalid(
                    "Original external steering source changed".into(),
                ));
            }
            messages.push(attributed_source(source, self.access.spec().language));
            sources.push(ExternalSteeringSource {
                request: entry.request.id.clone(),
                source: entry.request.source.clone(),
                resources: entry.request.resources.clone(),
            });
            contents.extend([source_blob, resource_blob]);
        }
        let input = aggregate(messages.iter());
        let input_blob = ContentBlob::json(&input).map_err(persistence)?;
        let key = ExternalSteeringKey {
            task,
            steering: Uuid::new_v4(),
        };
        let spec = ExternalSteeringSpec {
            schema_version: SCHEMA_VERSION,
            execution: self.access.execution().clone(),
            key,
            consume: Consume {
                session: session.clone(),
                requests: prefix
                    .entries
                    .iter()
                    .map(|entry| entry.request.id.clone())
                    .collect(),
                expected_revision: prefix.revision,
            },
            sources,
            input: input_blob.reference().clone(),
        };
        let descriptor = ContentBlob::json(&spec).map_err(persistence)?;
        let at = UnixMillis(now() as i64);
        let changes = vec![
            Change::new(
                Fact::ExternalSteering {
                    event: ExternalSteeringEvent::Prepared {
                        key,
                        descriptor: descriptor.reference().clone(),
                    },
                },
                at,
            ),
            Change::new(
                Fact::ExternalSteering {
                    event: ExternalSteeringEvent::Admitted { key },
                },
                at,
            ),
        ];
        contents.extend([input_blob, descriptor]);
        Ok(Some(Pending {
            spec,
            changes,
            contents,
            input,
        }))
    }
    async fn committed(&self, pending: &Pending) -> Result<bool, Error> {
        let mut complete = true;
        for original in &pending.changes {
            match self
                .state
                .fact(self.claim.run(), original.id)
                .await
                .map_err(persistence)?
            {
                Some(recorded) if recorded.fact == original.fact && recorded.at == original.at => {}
                Some(_) => {
                    return Err(Error::Invalid(
                        "Original steering fact identity conflicts".into(),
                    ));
                }
                None => complete = false,
            }
        }
        Ok(complete)
    }
}
impl Inputs for NativeInputs {
    fn artifacts(&self) -> (ArtifactStore, SessionScope) {
        (
            self.state.artifacts(),
            SessionScope {
                owner: self.access.spec().owner.clone(),
                session: self.access.execution().session_id.clone(),
            },
        )
    }
    fn write_history<'a>(
        &'a self,
        task: ExternalTaskId,
        last_delivered: Option<RunId>,
        writer: &'a mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            if self.current(task).await?.is_none() {
                return Err(Error::Cancelled);
            }
            let cut = self
                .cut
                .get_or_try_init(|| self.history.capture_before(self.claim.run()))
                .await
                .map_err(persistence)?;
            crate::service::history::readable_context_into(
                &self.history,
                cut,
                last_delivered,
                writer,
                &self.owner.stop,
            )
            .await
            .map_err(Error::Provider)
        })
    }
    fn steering_ready(&self, task: ExternalTaskId) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let mut changes = self.state.subscribe().map_err(persistence)?;
            loop {
                changes.borrow_and_update();
                if self.current(task).await?.is_none() {
                    return std::future::pending().await;
                }
                let prefix = self
                    .state
                    .queue()
                    .steering(self.access.execution().session_id.clone(), self.claim.run())
                    .await
                    .map_err(persistence)?;
                if !prefix.entries.is_empty() {
                    return Ok(());
                }
                tokio::select! {
                    biased;
                    () = self.owner.stop.cancelled() => return Err(Error::Cancelled),
                    changed = changes.changed() => changed.map_err(persistence)?,
                }
            }
        })
    }
    fn take_steering(
        &self,
        task: ExternalTaskId,
    ) -> BoxFuture<'_, Result<Option<MessageInput>, Error>> {
        Box::pin(async move {
            let mut pending = self.pending.lock().await;
            if let Some(original) = pending.as_ref() {
                if original.spec.key.task != task {
                    return Err(Error::Unknown);
                }
                // An interrupted/uncertain original append is observation-only.
                // Even a later receipt cannot authorize another hot-steer RPC.
                let _committed = self.committed(original).await?;
                return Err(Error::Unknown);
            }
            if self.current(task).await?.is_none() {
                return Ok(None);
            }
            let Some(frozen) = self.freeze(task).await? else {
                return Ok(None);
            };
            *pending = Some(frozen);
            loop {
                let Some(view) = self.current(task).await? else {
                    // This path has not submitted, or only a rejected compare ran.
                    *pending = None;
                    return Ok(None);
                };
                let original = pending.as_ref().expect("frozen original steering");
                match self
                    .state
                    .append(
                        &self.claim,
                        Head::from(&view),
                        original.changes.clone(),
                        original.contents.clone(),
                    )
                    .await
                {
                    Ok(_) => return Ok(pending.take().map(|original| original.input)),
                    Err(error)
                        if matches!(error.underlying(), StoreError::RevisionConflict { .. }) =>
                    {
                        let prefix = self
                            .state
                            .queue()
                            .steering(self.access.execution().session_id.clone(), self.claim.run())
                            .await
                            .map_err(persistence)?;
                        if prefix.revision != original.spec.consume.expected_revision
                            || !prefix
                                .entries
                                .iter()
                                .map(|entry| &entry.request.id)
                                .eq(original.spec.consume.requests.iter())
                        {
                            // A proven rejected compare consumed nothing. A later
                            // ready/take may select the newly edited queue level.
                            *pending = None;
                            return Ok(None);
                        }
                        continue;
                    }
                    Err(error)
                        if matches!(
                            error.underlying(),
                            StoreError::CommitUnknown(_) | StoreError::OperationUnknown
                        ) =>
                    {
                        if self.committed(original).await? {
                            return Ok(pending.take().map(|original| original.input));
                        }
                        return Err(Error::Unknown);
                    }
                    Err(error)
                        if matches!(error.underlying(), StoreError::InvalidTransition(_)) =>
                    {
                        let stopped = self.stopped(task).await?;
                        *pending = None;
                        if stopped {
                            return Ok(None);
                        }
                        return Err(persistence(error));
                    }
                    Err(error) => {
                        *pending = None;
                        return Err(persistence(error));
                    }
                }
            }
        })
    }
}
fn persistence(error: impl std::fmt::Display) -> Error {
    Error::Persistence(error.to_string())
}
