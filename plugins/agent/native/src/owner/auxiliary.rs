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
use maka_agent_facts::{
    model::{
        ModelEvent, ModelFinishReason, ModelGeneration, ModelPart, TextKind, error::ModelError,
    },
    tools::ToolError,
};
use maka_capabilities::call::Resources;
use maka_event_log::usage::{AuxiliarySource, Outcome};
use maka_model::{ModelRequest, ModelStream, StepBuilder};

pub(super) enum Error {
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
            Error::Model(error) => failed(error),
            Error::Admission(error) | Error::Tool(error) => error,
        }
    }
}

pub(super) enum Admission {
    Source(AuxiliarySource),
    Operation {
        reference: Box<maka_plugin_core::operation::RecoveryRef>,
        scope: Box<maka_event_log::applications::operations::OperationDispatchScope>,
        execution: Option<(
            Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
            Invocation,
        )>,
        binding: ModelBinding,
        session_id: String,
    },
}
pub(super) struct Auxiliary {
    models: ModelExecutor,
    pub resources: Arc<Resources>,
}
impl Auxiliary {
    pub fn new(revision: SourceRevision) -> Result<Self, String> {
        Ok(Self {
            models: ModelExecutor::for_source(Duration::from_secs(30), revision)
                .map_err(|_| "agent_auxiliary_unavailable")?,
            resources: Arc::default(),
        })
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
        let journal = match admission {
            Admission::Operation {
                reference,
                scope,
                execution,
                binding,
                session_id,
            } => {
                let operation = log.operation(&reference).map_err(admission_error)?;
                let lease = match execution {
                    Some((custody, invocation)) => {
                        if invocation.session_id != session_id {
                            return Err(failed("Auxiliary execution Session mismatch").into());
                        }
                        log.fork_execution(custody.as_ref(), &invocation)
                            .map_err(admission_error)?
                    }
                    None => session_lease(log, &session_id).await?,
                };
                Journal::Operation(
                    operation
                        .begin_auxiliary_operation_model(
                            &scope,
                            lease,
                            binding,
                            request.language,
                            Some(quote),
                        )
                        .await
                        .map_err(admission_error)?,
                )
            }
            Admission::Source(source) => {
                let session_id = match &source {
                    AuxiliarySource::SessionTitle { invocation }
                    | AuxiliarySource::Agent { invocation, .. } => &invocation.session_id,
                    _ => {
                        return Err(failed(
                            "Auxiliary source requires an original Session or operation claim",
                        )
                        .into());
                    }
                };
                let mut admission = IdleLease(Some(session_lease(log, session_id).await?));
                let store = admission.0.as_ref().expect("admission lease").store();
                let id = match store
                    .begin_auxiliary_model(source, request.language, Some(quote))
                    .await
                {
                    Ok(id) => id,
                    Err(error) => {
                        return Err(admission_error(error));
                    }
                };
                Journal::Session {
                    store,
                    lease: admission.0.take().expect("admission lease"),
                    id,
                }
            }
        };
        let mut custody = JournalCustody {
            journal: Some(journal),
            phase: ProviderPhase::Unstarted,
        };
        let id = custody.journal().id();
        let model_id = request.provider.model.clone();
        let result = async {
            let stream = self
                .models
                .stream(request, cancellation.clone())
                .await
                .map_err(Error::Model)?;
            custody.phase = ProviderPhase::Active;
            let step = receive(stream, &mut custody).await?;
            if step.finish_reason == ModelFinishReason::ToolCalls {
                return Err(failed("Auxiliary generation cannot finish with tool calls").into());
            }
            Ok(ModelGeneration {
                text: step
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        ModelPart::Text {
                            text_kind: TextKind::Text,
                            text,
                            ..
                        } => Some(text),
                        _ => None,
                    })
                    .flat_map(|text| text.chunks())
                    .collect(),
                model_id,
                finish_reason: step.finish_reason,
                usage: step.usage,
            })
        }
        .await;
        // SQL uncertainty preserves the pending receipt. Physical custody is released
        // only by the explicit unstarted/drained phase, independently of this error.
        if matches!(
            result,
            Err(Error::Tool(
                ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_)
            ))
        ) {
            return result;
        }
        let outcome = match &result {
            Ok(_) => Outcome::Success,
            Err(_) if cancellation.is_cancelled() => Outcome::Aborted,
            Err(_) => Outcome::Error,
        };
        custody.journal.take().expect("auxiliary journal").settle(outcome)
            .await
            .map_err(|error| {
                tracing::error!(stage = "auxiliary_model_settlement_failed", cause = crate::diagnostics::store_cause(&error),
                    sql_code = crate::diagnostics::store_sql_code(&error), request_id = %id, "Auxiliary model settlement failed");
                persistence(error)
            })?;
        result
    }
}
fn rejected_admission(error: &maka_event_log::StoreError) -> bool {
    matches!(
        error,
        maka_event_log::StoreError::InvalidTransition(_)
            | maka_event_log::StoreError::EventConflict
            | maka_event_log::StoreError::SessionNotFound
            | maka_event_log::StoreError::SessionRetired
            | maka_event_log::StoreError::SessionBusy
            | maka_event_log::StoreError::PermissionRevoked
            | maka_event_log::StoreError::PrefixTooLarge
    )
}
fn admission_error(error: maka_event_log::StoreError) -> Error {
    if rejected_admission(&error) {
        Error::Admission(failed(error))
    } else {
        Error::Tool(persistence(error))
    }
}
async fn session_lease(
    log: &RootStore,
    id: &str,
) -> Result<maka_event_log::root_store::SessionExecutionLease, Error> {
    let store = log.session(id).await.map_err(admission_error)?;
    let record = store
        .get::<StoredSessionConfiguration>()
        .await
        .map_err(persistence)?
        .ok_or_else(|| failed("Auxiliary Session unavailable"))?;
    let session = resolve_session(record).map_err(failed)?;
    Ok(store
        .execution_scope(Some(session.configuration.permission_basis()))
        .await
        .map_err(admission_error)?
        .accept())
}
// Only unstarted or confirmed-drained providers may use this release guard.
// SQL actor work independently retains its own pins until completion.
struct IdleLease(Option<maka_event_log::root_store::SessionExecutionLease>);
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
struct JournalCustody {
    journal: Option<Journal>,
    phase: ProviderPhase,
}
impl JournalCustody {
    fn journal(&self) -> &Journal {
        self.journal.as_ref().expect("auxiliary journal")
    }
}
impl Drop for JournalCustody {
    fn drop(&mut self) {
        if matches!(
            self.phase,
            ProviderPhase::Unstarted | ProviderPhase::Drained
        ) && let Some(journal) = self.journal.take()
        {
            match journal {
                Journal::Session { lease, .. } => lease.finish(),
                Journal::Operation(journal) => journal.release_after_cleanup(),
            }
        }
        // Active provider custody remains retained_cleanup by the journal's Drop.
    }
}
enum Journal {
    Session {
        store: maka_event_log::root_store::SessionStore,
        lease: maka_event_log::root_store::SessionExecutionLease,
        id: Uuid,
    },
    Operation(maka_event_log::root_store::OperationAuxiliary),
}
impl Journal {
    fn id(&self) -> Uuid {
        match self {
            Self::Session { id, .. } => *id,
            Self::Operation(journal) => journal.id(),
        }
    }
    async fn observe(
        &self,
        usage: maka_agent_facts::model::ModelUsage,
    ) -> Result<(), maka_event_log::StoreError> {
        match self {
            Self::Session { store, id, .. } => store.observe_auxiliary_model(*id, usage).await,
            Self::Operation(journal) => journal.observe(usage).await,
        }
    }
    async fn settle(self, outcome: Outcome) -> Result<(), maka_event_log::StoreError> {
        match self {
            Self::Session { store, lease, id } => {
                let completion = IdleLease(Some(lease));
                let result = store.settle_auxiliary_model(id, outcome).await;
                drop(completion);
                result
            }
            Self::Operation(journal) => journal.settle(outcome).await,
        }
    }
}
async fn receive(
    mut stream: ModelStream,
    custody: &mut JournalCustody,
) -> Result<maka_agent_facts::model::ModelStep, Error> {
    let journal = custody.journal();
    let result = async {
        let mut builder = StepBuilder::default();
        let mut bytes = 0usize;
        let mut observed_usage = false;
        while let Some(event) = stream.next().await {
            let maka_model::Emission {
                event,
                reservation: _reservation,
            } = event.map_err(Error::Model)?;
            if let ModelEvent::Finished { usage, .. } = &event
                && !observed_usage
            {
                journal.observe(usage.clone())
                    .await
                    .map_err(|error| {
                        tracing::error!(stage = "auxiliary_model_observation_failed", cause = crate::diagnostics::store_cause(&error),
                            sql_code = crate::diagnostics::store_sql_code(&error), request_id = %journal.id(), "Auxiliary model usage observation failed");
                        persistence(error)
                    })?;
                observed_usage = true;
            }
            bytes = bytes.saturating_add(
                maka_agent_facts::model::budget::reservation(&event, 2 * 1024 * 1024 + 1)
                    .map_err(failed)? as usize,
            );
            if bytes > 2 * 1024 * 1024 {
                return Err(failed("Auxiliary generation exceeds 2 MiB stream limit").into());
            }
            if matches!(
                event,
                ModelEvent::ToolCall(_) | ModelEvent::ProviderToolResult { .. }
            ) {
                return Err(failed("Auxiliary generation cannot call tools").into());
            }
            builder.push(event).map_err(Error::Model)?;
        }
        builder.finish().map_err(Error::Model)
    }
    .await;
    stream
        .cancel_and_wait()
        .await
        .map_err(|error| {
            tracing::error!(stage = "auxiliary_model_cleanup_unconfirmed", cause = "cleanup_unconfirmed",
                request_id = %journal.id(), "Auxiliary model stream cleanup is unconfirmed");
            ToolError::CleanupUnconfirmed(error.to_string())
        })?;
    custody.phase = ProviderPhase::Drained;
    result
}
pub(super) fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}
pub(super) fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

#[cfg(test)]
mod tests;
