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
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use maka_agent_state::usage::{AuxiliaryJournal, AuxiliaryWrite};
use maka_model::{ModelCleanupObserver, StreamCleanupError};
use std::{fmt, sync::Mutex};

pub(in crate::owner) struct MetadataFailure {
    _original: AuxiliaryWrite,
    journal: AuxiliaryJournal,
    first: usage::Error,
    recovery: Option<usage::Error>,
    fence: Option<usage::Error>,
    writer_settled: bool,
}
impl MetadataFailure {
    pub(super) fn admission(self: Arc<Self>) -> Error {
        match &self.first {
            usage::Error::SourceAlreadyAdmitted { .. } | usage::Error::Invalid(_) => {
                Error::Admission(failed(&self.first))
            }
            usage::Error::Store(error) if rejected_admission(error) => {
                Error::Admission(failed(error))
            }
            _ => Error::Metadata(self),
        }
    }
}
impl fmt::Display for MetadataFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "auxiliary {} original accounting write failed: {}",
            self.journal.id(),
            self.first
        )?;
        if let Some(error) = &self.recovery {
            write!(f, "; original metadata recovery: {error}")?;
        }
        if let Some(error) = &self.fence {
            write!(f, "; original writer disposition fence: {error}")?;
        }
        Ok(())
    }
}
impl fmt::Debug for MetadataFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for MetadataFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.first)
    }
}
#[derive(Clone)]
pub(super) struct Journal {
    original: AuxiliaryJournal,
    pending: Arc<Mutex<Option<Arc<MetadataFailure>>>>,
}
fn unknown(error: &usage::Error) -> bool {
    matches!(error,usage::Error::Store(error) if matches!(error.underlying(),maka_event_log::StoreError::CommitUnknown(_)|maka_event_log::StoreError::OperationUnknown))
}
impl Journal {
    pub(super) fn new(original: AuxiliaryJournal) -> Self {
        Self {
            original,
            pending: Arc::default(),
        }
    }
    pub(super) fn id(&self) -> Uuid {
        self.original.id()
    }
    pub(super) fn writer_settled(&self) -> bool {
        self.pending
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|pending| pending.writer_settled)
    }
    pub(super) async fn append(
        &self,
        write: AuxiliaryWrite,
        recover: bool,
    ) -> Result<(), Arc<MetadataFailure>> {
        let first = match self.original.append(write.clone()).await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        let (recovery, fence, writer_settled) = if unknown(&first) {
            match self.original.contains(&write).await {
                Ok(true) => return Ok(()),
                Ok(false) if recover => match self.original.append(write.clone()).await {
                    Ok(()) => return Ok(()),
                    Err(error) if unknown(&error) => match self.original.contains(&write).await {
                        Ok(true) => return Ok(()),
                        Ok(false) => (Some(error), None, true),
                        Err(fence) => (Some(error), Some(fence), false),
                    },
                    Err(error) => (Some(error), None, true),
                },
                Ok(false) => (None, None, true),
                Err(error) => (None, Some(error), false),
            }
        } else {
            (None, None, true)
        };
        let failure = Arc::new(MetadataFailure {
            _original: write,
            journal: self.original.clone(),
            first,
            recovery,
            fence,
            writer_settled,
        });
        *self.pending.lock().unwrap() = Some(failure.clone());
        Err(failure)
    }
    pub(super) async fn observe(
        &self,
        usage: maka_agent_facts::model::ModelUsage,
        at: UnixMillis,
    ) -> Result<(), Arc<MetadataFailure>> {
        self.append(self.original.usage(usage, at), true).await
    }
    pub(super) async fn settle(
        &self,
        outcome: Outcome,
        at: UnixMillis,
    ) -> Result<(), Arc<MetadataFailure>> {
        self.append(self.original.settlement(outcome, at), true)
            .await
    }
}

/// A known accounting failure is not a physical cleanup failure or an ACK.
#[derive(Clone)]
pub(in crate::owner) enum PhysicalSettlement {
    Acknowledged,
    MetadataFailure(Arc<MetadataFailure>),
}
type Completion = Shared<BoxFuture<'static, Result<PhysicalSettlement, Arc<str>>>>;
#[derive(Clone)]
pub(in crate::owner) struct Cleanup {
    error: StreamCleanupError,
    observer: ModelCleanupObserver,
    outcome: Outcome,
    completion: Option<Completion>,
}
impl fmt::Display for Cleanup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.error, f)
    }
}
struct Retained {
    custody: Option<JournalCustody>,
    error: StreamCleanupError,
}
impl Cleanup {
    pub(super) fn new(
        error: StreamCleanupError,
        observer: ModelCleanupObserver,
        result: Result<ModelGeneration, Error>,
    ) -> Self {
        let outcome = match result {
            Ok(_) => Outcome::Success,
            Err(Error::Model(model)) if !model.cleanup_unconfirmed() => {
                crate::model::inference_outcome(&model)
            }
            Err(
                Error::Admission(_)
                | Error::Tool(ToolError::Failed(_) | ToolError::Native(_) | ToolError::Io { .. }),
            ) => Outcome::Error,
            _ => match &error {
                StreamCleanupError::Pending {
                    cause: Some(cause), ..
                } => crate::model::inference_outcome(cause),
                StreamCleanupError::Unobservable {
                    original: Some(cause),
                    ..
                } => crate::model::inference_outcome(cause),
                _ => Outcome::Unknown,
            },
        };
        Self {
            error,
            observer,
            outcome,
            completion: None,
        }
    }
    pub(in crate::owner) fn pending(&self) -> bool {
        self.completion.is_some()
    }
    pub(in crate::owner) async fn wait_physical(&self) -> Result<PhysicalSettlement, Arc<str>> {
        match &self.completion {
            Some(completion) => completion.clone().await,
            None => Err(self.to_string().into()),
        }
    }
    pub(super) fn retain(mut self, mut custody: JournalCustody) -> Self {
        let original = custody
            .retention
            .0
            .take()
            .expect("original auxiliary cleanup custody");
        let material = Arc::new(Mutex::new(Retained {
            custody: Some(custody),
            error: self.error.clone(),
        }));
        if self.error.observer().is_none() {
            original.retain_unconfirmed(material);
            return self;
        }
        let settlement = original.retain_original_material(material.clone());
        let observer = self.observer.clone();
        let outcome = self.outcome;
        let worker = tokio::spawn(async move {
            if let Err(error) = observer.wait().await {
                let message: Arc<str> = error.to_string().into();
                material.lock().unwrap().error = error;
                return Err(message);
            }
            let journal = {
                let mut retained = material.lock().unwrap();
                let custody = retained
                    .custody
                    .as_mut()
                    .expect("original auxiliary cleanup worker");
                custody.phase = ProviderPhase::Drained;
                custody.journal.clone()
            };
            let metadata = journal.pending.lock().unwrap().clone();
            let metadata = match metadata {
                Some(failure) => Some(failure),
                None => {
                    let at = timestamp().map_err(|error| Arc::<str>::from(error.to_string()))?;
                    journal.settle(outcome, at).await.err()
                }
            };
            if !journal.writer_settled() {
                return Err(
                    "original auxiliary accounting writer has not acknowledged its disposition"
                        .into(),
                );
            }
            let mut custody = material
                .lock()
                .unwrap()
                .custody
                .take()
                .expect("settled original auxiliary worker");
            // Known metadata failure leaves canonical accounting pending. Only
            // physical custody is released; no successful ACK is manufactured.
            if let Some(physical) = custody.physical.take() {
                physical.finish_after_cleanup();
            }
            drop(custody);
            settlement.confirm_cleanup();
            Ok(metadata.map_or(
                PhysicalSettlement::Acknowledged,
                PhysicalSettlement::MetadataFailure,
            ))
        });
        self.completion = Some(
            async move {
                worker
                    .await
                    .map_err(|error| Arc::<str>::from(error.to_string()))?
            }
            .boxed()
            .shared(),
        );
        self
    }
}
