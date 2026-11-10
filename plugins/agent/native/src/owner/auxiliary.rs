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

//! Auxiliary requests retain their physical worker and original usage journal.
use super::*;
mod settlement;
use maka_agent_facts::{
    accounting::{AuxiliarySource, ModelEvidence, Outcome},
    context::ModelPurpose,
    durable::{RunOwner, UnixMillis},
    model::{ModelEvent, ModelFinishReason, ModelGeneration, TextKind, error::ModelError},
    tools::ToolError,
};
use maka_agent_state::usage::{self, AuxiliarySpec, UsageStore};
use maka_event_log::root_store::{OperationWork, SessionWorkLease};
use maka_model::{ModelRequest, ModelStream};
use maka_plugin_core::work::WorkCustody;
use maka_plugin_core::work::resources::Resources;
use settlement::Journal;
pub(super) use settlement::{Cleanup, MetadataFailure, PhysicalSettlement};

pub(super) enum Error {
    Cleanup(Cleanup),
    Metadata(Arc<MetadataFailure>),
    Model(ModelError),
    Admission(ToolError),
    Tool(ToolError),
}
impl From<ToolError> for Error {
    fn from(error: ToolError) -> Self {
        Self::Tool(error)
    }
}
impl From<Error> for ToolError {
    fn from(error: Error) -> Self {
        match error {
            Error::Cleanup(error) => ToolError::CleanupUnconfirmed(error.to_string()),
            Error::Metadata(error) => persistence(error),
            Error::Model(error) if error.cleanup_unconfirmed() => {
                ToolError::CleanupUnconfirmed(error.to_string())
            }
            Error::Model(error) => failed(error),
            Error::Admission(error) | Error::Tool(error) => error,
        }
    }
}

pub(super) enum Execution {
    Work {
        custody: Arc<dyn WorkCustody>,
        session: String,
    },
    Prepared(IdleLease),
}

pub(super) enum Admission {
    Source {
        source: AuxiliarySource,
        binding: ModelBinding,
        purpose: ModelPurpose,
        execution: Execution,
    },
    Operation {
        reference: Box<maka_plugin_core::operation::RecoveryRef>,
        scope: Box<maka_event_log::applications::operations::OperationDispatchScope>,
        execution: Execution,
        binding: ModelBinding,
        purpose: ModelPurpose,
        session_id: String,
    },
}
pub(super) struct Auxiliary {
    models: ModelExecutor,
    owner: RunOwner,
    pub resources: Arc<Resources>,
}
impl Auxiliary {
    pub fn new(models: ModelExecutor, owner: RunOwner) -> Self {
        Self {
            models,
            owner,
            resources: Arc::default(),
        }
    }
    pub async fn generate(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        log: &RootStore,
        admission: Admission,
        quote: maka_agent_facts::pricing::Quote,
    ) -> Result<ModelGeneration, Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Model(ModelError::Cancelled));
        }
        let (source, binding, purpose, execution, session, operation) = match admission {
            Admission::Operation {
                reference,
                scope,
                execution,
                binding,
                purpose,
                session_id,
            } => {
                let source = AuxiliarySource::ApplicationOperation {
                    source: reference.source.clone(),
                    namespace: reference.namespace.clone(),
                    operation: reference.operation,
                    fingerprint: reference.fingerprint.clone(),
                };
                (
                    source,
                    binding,
                    purpose,
                    execution,
                    session_id,
                    Some((reference, scope)),
                )
            }
            Admission::Source {
                source,
                binding,
                purpose,
                execution,
            } => {
                let session = match &source {
                    AuxiliarySource::SessionTitle { execution }
                    | AuxiliarySource::Agent { execution, .. } => execution.session_id.clone(),
                    _ => {
                        return Err(Error::Admission(failed(
                            "Auxiliary source requires an original Session or operation claim",
                        )));
                    }
                };
                (source, binding, purpose, execution, session, None)
            }
        };
        let lease = match execution {
            Execution::Work {
                custody,
                session: selected,
            } => {
                if selected != session {
                    return Err(Error::Admission(failed("Auxiliary work Session mismatch")));
                }
                log.fork_work(custody.as_ref(), &session)
                    .map_err(admission_error)?
            }
            Execution::Prepared(mut admission) => {
                let lease = admission.0.as_ref().expect("prepared auxiliary lease");
                if lease.store().id() != session {
                    return Err(Error::Admission(failed("Auxiliary work Session mismatch")));
                }
                admission.0.take().expect("prepared auxiliary lease")
            }
        };
        // Preparation is pure. Until a provider starts this original lease may
        // be released even when a durable admission write fails or is cancelled.
        let mut pending = IdleLease(Some(lease));
        let store = pending.0.as_ref().expect("auxiliary lease").store();
        let custody = store.work_custody().map_err(admission_error)?;
        let data = log
            .data_writer_for_work(custody.as_ref(), &session)
            .map_err(admission_error)?;
        let (journal, write) = UsageStore::new(data)
            .auxiliary(
                AuxiliarySpec {
                    schema_version: 1,
                    owner: self.owner.clone(),
                    session: session.clone(),
                    source,
                    accounting: ModelEvidence {
                        binding,
                        model_id: request.provider.model.clone(),
                        purpose,
                        quote: Some(quote),
                    },
                    language: request.language,
                },
                timestamp()?,
            )
            .map_err(usage_admission_error)?;
        let retention = IdleLease(Some(
            log.fork_work(custody.as_ref(), &session)
                .map_err(admission_error)?,
        ));
        let lease = pending.0.take().expect("auxiliary lease");
        let physical = if let Some((reference, dispatch)) = operation {
            // The pending owner releases an unstarted lease if lookup fails.
            let mut pending = IdleLease(Some(lease));
            let operation = log.operation(&reference).map_err(admission_error)?;
            let lease = pending.0.take().expect("auxiliary lease");
            Physical::Operation(
                operation
                    .acquire_work(&dispatch, lease)
                    .await
                    .map_err(admission_error)?,
            )
        } else {
            Physical::Session(lease)
        };
        let mut custody = JournalCustody {
            journal: Journal::new(journal),
            physical: Some(physical),
            retention,
            phase: ProviderPhase::Unstarted,
        };
        // Retain the exact write through its result. Unknown does not authorize
        // a fresh request or a replacement accounting identity.
        custody
            .journal
            .append(write, false)
            .await
            .map_err(MetadataFailure::admission)?;
        let id = custody.journal().id();
        let model_id = request.provider.model.clone();
        let result = async {
            let stream = self
                .models
                .stream(request, cancellation.clone())
                .await
                .map_err(|error| {
                    if error.cleanup_unconfirmed() {
                        custody.phase = ProviderPhase::Active;
                    }
                    Error::Model(error)
                })?;
            custody.phase = ProviderPhase::Active;
            let generation = receive(stream, &mut custody, model_id).await?;
            if generation.finish_reason == ModelFinishReason::ToolCalls {
                return Err(failed("Auxiliary generation cannot finish with tool calls").into());
            }
            Ok(generation)
        }
        .await;
        let result = match result {
            Err(Error::Cleanup(cleanup)) => return Err(Error::Cleanup(cleanup.retain(custody))),
            result => result,
        };
        let outcome = match &result {
            Ok(_) => Outcome::Success,
            Err(Error::Cleanup(_) | Error::Metadata(_)) => return result,
            Err(Error::Model(ModelError::CleanupUnconfirmed))
            | Err(Error::Tool(
                ToolError::Persistence(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::OperationCleanupUnconfirmed { .. },
            )) => return result,
            Err(Error::Model(error)) => crate::model::inference_outcome(error),
            Err(Error::Tool(ToolError::OutcomeUnknown(_) | ToolError::OperationUnknown { .. })) => {
                Outcome::Unknown
            }
            Err(Error::Admission(_))
            | Err(Error::Tool(
                ToolError::PermissionDenied(_)
                | ToolError::Failed(_)
                | ToolError::Native(_)
                | ToolError::Io { .. },
            )) => Outcome::Error,
        };
        custody.journal().settle(outcome, timestamp()?).await.map_err(|error| {
            tracing::error!(stage = "auxiliary_model_settlement_failed", request_id = %id, %error,
                "Auxiliary model settlement failed");
            Error::Metadata(error)
        })?;
        result
    }
}
fn rejected_admission(error: &maka_event_log::StoreError) -> bool {
    matches!(
        error.underlying(),
        maka_event_log::StoreError::InvalidTransition(_)
            | maka_event_log::StoreError::EventConflict
            | maka_event_log::StoreError::SessionNotFound
            | maka_event_log::StoreError::SessionRetired
            | maka_event_log::StoreError::SessionBusy
            | maka_event_log::StoreError::PermissionRevoked
    )
}
pub(super) fn admission_error(error: maka_event_log::StoreError) -> Error {
    if rejected_admission(&error) {
        Error::Admission(failed(error))
    } else {
        Error::Tool(persistence(error))
    }
}
fn usage_admission_error(error: usage::Error) -> Error {
    match error {
        usage::Error::Store(error) => admission_error(error),
        usage::Error::Invalid(error) => Error::Admission(failed(error)),
        error @ usage::Error::SourceAlreadyAdmitted { .. } => Error::Admission(failed(error)),
    }
}
fn timestamp() -> Result<UnixMillis, ToolError> {
    Ok(UnixMillis(now().try_into().map_err(failed)?))
}

// Only unstarted or confirmed-drained providers may use this release guard.
pub(super) struct IdleLease(pub(super) Option<SessionWorkLease>);
impl IdleLease {
    pub(super) fn retain_unconfirmed(&mut self, material: impl std::marker::Send + Sync + 'static) {
        if let Some(lease) = self.0.take() {
            lease.retain_unconfirmed(material);
        }
    }
}
impl Drop for IdleLease {
    fn drop(&mut self) {
        if let Some(lease) = self.0.take() {
            lease.finish();
        }
    }
}
enum ProviderPhase {
    Unstarted,
    Active,
    Drained,
}
enum Physical {
    Session(SessionWorkLease),
    Operation(OperationWork),
}
impl Physical {
    fn finish_after_cleanup(self) {
        match self {
            Self::Session(lease) => lease.finish(),
            Self::Operation(work) => work.finish_after_cleanup(),
        }
    }
}
struct JournalCustody {
    journal: Journal,
    physical: Option<Physical>,
    phase: ProviderPhase,
    retention: IdleLease,
}
impl JournalCustody {
    fn journal(&self) -> &Journal {
        &self.journal
    }
}
impl Drop for JournalCustody {
    fn drop(&mut self) {
        if matches!(
            self.phase,
            ProviderPhase::Unstarted | ProviderPhase::Drained
        ) && self.journal.writer_settled()
            && let Some(physical) = self.physical.take()
        {
            physical.finish_after_cleanup();
        }
        // Active handles drop into the original Root/dispatch quarantine.
    }
}
async fn receive(
    mut stream: ModelStream,
    custody: &mut JournalCustody,
    model_id: String,
) -> Result<ModelGeneration, Error> {
    let observer = stream.cleanup_observer();
    let journal = custody.journal();
    let result =
        async {
            let mut parts: Vec<(String, String)> = Vec::new();
            let mut finished = None;
            while let Some(event) = stream.next().await {
                let maka_model::Emission {
                    event,
                    reservation: _reservation,
                } = event.map_err(Error::Model)?;
                match event {
                    ModelEvent::PartStarted {
                        id,
                        text_kind: TextKind::Text,
                        ..
                    } => {
                        parts.push((id, String::new()));
                    }
                    ModelEvent::PartDelta { id, text, .. } => {
                        if let Some((_, output)) = parts.iter_mut().find(|(part, _)| *part == id) {
                            output.push_str(&text);
                        }
                    }
                    ModelEvent::Finished { reason, usage, .. } => {
                        journal.observe(usage.clone(), timestamp()?).await.map_err(|error| {
                        tracing::error!(stage = "auxiliary_model_observation_failed", %error,
                            request_id = %journal.id(), "Auxiliary model usage observation failed");
                        Error::Metadata(error)
                    })?;
                        finished = Some((reason, usage));
                    }
                    ModelEvent::ToolCall(_) | ModelEvent::ProviderToolResult { .. } => {
                        return Err(failed("Auxiliary generation cannot call tools").into());
                    }
                    _ => {}
                }
            }
            let (finish_reason, usage) = finished.ok_or_else(|| {
                Error::Model(ModelError::Adapter(
                    "Auxiliary generation ended without completion".into(),
                ))
            })?;
            Ok(ModelGeneration {
                text: parts.into_iter().map(|(_, text)| text).collect(),
                model_id,
                finish_reason,
                usage,
            })
        }
        .await;
    if let Err(error) = stream.cancel_and_wait().await {
        tracing::error!(stage = "auxiliary_model_cleanup_unconfirmed", %error,
            request_id = %journal.id(), "Auxiliary model stream cleanup is unconfirmed");
        return Err(Error::Cleanup(Cleanup::new(error, observer, result)));
    }
    custody.phase = ProviderPhase::Drained;
    result
}
pub(super) fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}
pub(super) fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
