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
use asyncband::completion::{self, Completer, Completion};
use auxiliary::{failed, persistence};
use futures_util::FutureExt;
use maka_agent_facts::{
    accounting::AuxiliarySource,
    durable::{BackendSpec, ExecutionIdentity, Fact, RunId, UnixMillis},
};
use maka_agent_facts::{
    diagnostics::TitleFailureCause,
    model::{ModelFinishReason, error::ModelFailureCause},
    tools::ToolError,
};
use maka_agent_ports::session::title::Policy;
use maka_agent_state::session_history::SessionHistory;
use maka_model::{ModelRequest, prompt::Message};
use maka_plugin_core::work::WorkCustody;
use tracing::Instrument;

#[derive(Default)]
pub(super) struct Registry {
    active: Arc<std::sync::Mutex<BTreeMap<String, Arc<Work>>>>,
}
struct Work {
    cancellation: CancellationToken,
    completed: Completion<bool>,
}
struct Worker {
    active: Arc<std::sync::Mutex<BTreeMap<String, Arc<Work>>>>,
    session: String,
    work: Arc<Work>,
    completion: Option<Completer<bool>>,
}
impl Registry {
    fn start(&self, session: &str, cancellation: CancellationToken) -> Option<Worker> {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(session) {
            return None;
        }
        let (completion, completed) = completion::new();
        let work = Arc::new(Work {
            cancellation,
            completed,
        });
        active.insert(session.to_owned(), work.clone());
        Some(Worker {
            active: self.active.clone(),
            session: session.to_owned(),
            work,
            completion: Some(completion),
        })
    }

    // Called under the lifecycle gate, which excludes new title admission.
    pub(super) async fn cancel_and_wait(&self, session: &str) -> Result<(), ()> {
        let work = self.active.lock().unwrap().get(session).cloned();
        let Some(work) = work else {
            return Ok(());
        };
        work.cancellation.cancel();
        work.completed
            .wait()
            .await
            .map_err(|_| ())?
            .then_some(())
            .ok_or(())
    }
}
impl Worker {
    fn complete(&mut self, success: bool) {
        let completion = self.completion.take().expect("title worker completes once");
        let _ = completion.complete(success);
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.session);
    }
}

enum GenerationError {
    Metadata(Arc<auxiliary::MetadataFailure>),
    Cleanup(auxiliary::Cleanup),
    Failure(TitleFailureCause),
    Operation(ToolError),
    Skipped,
}
impl From<ToolError> for GenerationError {
    fn from(error: ToolError) -> Self {
        Self::Operation(error)
    }
}
impl From<auxiliary::Error> for GenerationError {
    fn from(error: auxiliary::Error) -> Self {
        match error {
            auxiliary::Error::Metadata(error) => Self::Metadata(error),
            auxiliary::Error::Cleanup(error) => Self::Cleanup(error),
            auxiliary::Error::Model(error) if error.cleanup_unconfirmed() => {
                Self::Operation(ToolError::CleanupUnconfirmed(error.to_string()))
            }
            auxiliary::Error::Model(error) => {
                error.failure_cause().map_or(Self::Skipped, |cause| {
                    Self::Failure(TitleFailureCause::Model { cause })
                })
            }
            auxiliary::Error::Admission(_) => Self::Skipped,
            auxiliary::Error::Tool(ToolError::Failed(_)) => {
                Self::Failure(TitleFailureCause::InvalidOutput)
            }
            auxiliary::Error::Tool(error) => Self::Operation(error),
        }
    }
}

enum TitleWorkError {
    Tool(ToolError),
    Observation(Arc<TitleObservationFailure>),
    Metadata(Arc<auxiliary::MetadataFailure>),
    Cleanup(auxiliary::Cleanup),
}
impl From<ToolError> for TitleWorkError {
    fn from(error: ToolError) -> Self {
        Self::Tool(error)
    }
}
impl From<TitleWorkError> for ToolError {
    fn from(error: TitleWorkError) -> Self {
        match error {
            TitleWorkError::Tool(error) => error,
            TitleWorkError::Observation(error) => persistence(error),
            TitleWorkError::Metadata(error) => persistence(error),
            TitleWorkError::Cleanup(error) => ToolError::CleanupUnconfirmed(error.to_string()),
        }
    }
}

struct TitleObservationFailure {
    _state: maka_agent_state::Store,
    run: RunId,
    original: maka_agent_state::Change,
    first: maka_event_log::StoreError,
    recovery: Option<maka_event_log::StoreError>,
    fence: Option<maka_event_log::StoreError>,
    writer_settled: bool,
}
impl std::fmt::Display for TitleObservationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "title failure fact {} for {} was not acknowledged: {}",
            self.original.id, self.run, self.first
        )?;
        if let Some(error) = &self.recovery {
            write!(f, "; original metadata recovery: {error}")?;
        }
        if let Some(error) = &self.fence {
            write!(f, "; original writer fence: {error}")?;
        }
        Ok(())
    }
}
impl std::fmt::Debug for TitleObservationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for TitleObservationFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.first)
    }
}
async fn publish_title_failure(
    state: maka_agent_state::Store,
    run: RunId,
    original: maka_agent_state::Change,
) -> Result<(), Arc<TitleObservationFailure>> {
    let mut failure = None;
    // Only a FIFO-proven absent original fact permits one metadata resubmission.
    for attempt in 0..2 {
        let error = match state.observe(run, vec![original.clone()], vec![]).await {
            Ok(_) => return Ok(()),
            Err(error) => error,
        };
        let unknown = matches!(
            error.underlying(),
            maka_event_log::StoreError::CommitUnknown(_)
                | maka_event_log::StoreError::OperationUnknown
        );
        if attempt == 0 {
            failure = Some(TitleObservationFailure {
                _state: state.clone(),
                run,
                original: original.clone(),
                first: error,
                recovery: None,
                fence: None,
                writer_settled: true,
            });
        } else {
            failure
                .as_mut()
                .expect("original title observation failed")
                .recovery = Some(error);
        }
        let failed = failure.as_mut().expect("original title observation failed");
        if !unknown {
            return Err(Arc::new(
                failure.expect("original title observation failed"),
            ));
        }
        match state.fact_barrier(run, original.id).await {
            Ok(Some(recorded))
                if recorded.run == run
                    && recorded.id == original.id
                    && recorded.at == original.at
                    && recorded.fact == original.fact =>
            {
                return Ok(());
            }
            Ok(Some(_)) => {
                failed.fence = Some(maka_event_log::StoreError::EventConflict);
                return Err(Arc::new(
                    failure.expect("original title observation failed"),
                ));
            }
            Ok(None) => {}
            Err(error) => {
                failed.fence = Some(error);
                failed.writer_settled = false;
                return Err(Arc::new(
                    failure.expect("original title observation failed"),
                ));
            }
        }
    }
    Err(Arc::new(
        failure.expect("original title observation failed"),
    ))
}

impl Owner {
    // Called under the original run admission gate; its TaskTracker owns the work through cleanup.
    pub(super) fn title_after_message(
        self: &Arc<Self>,
        execution: ExecutionIdentity,
        custody: Arc<dyn WorkCustody>,
    ) {
        if !self.settings.automatic_titles || self.stop.is_cancelled() {
            return;
        }
        let Ok(mut ticket) = self.auxiliary.resources.reserve() else {
            return;
        };
        let Some(mut worker) = self
            .titles
            .start(&execution.session_id, self.stop.child_token())
        else {
            return;
        };
        let lease = match self
            .store
            .fork_work(custody.as_ref(), &execution.session_id)
        {
            Ok(lease) => auxiliary::IdleLease(Some(lease)),
            Err(error) => {
                tracing::error!(stage = "title_work_admission_failed", cause = %error,
                    session_id = %execution.session_id, "Title work admission failed");
                worker.complete(true);
                return;
            }
        };
        let cancellation = worker.work.cancellation.clone();
        let owner = self.clone();
        let span = tracing::error_span!("agent_title_worker", session_id = %execution.session_id,
            turn_id = %execution.turn_id, run_id = %execution.run_id, activation = %self.revision.activation);
        self.workers.spawn(
            async move {
                ticket.start();
                let completion = std::panic::AssertUnwindSafe(owner.generate_title_with(
                    execution,
                    lease,
                    cancellation,
                ))
                .catch_unwind()
                .await;
                let fatal = match &completion {
                    Err(_) => Some(("title_worker_panicked", "worker_panicked")),
                    Ok(Err(
                        TitleWorkError::Metadata(_)
                        | TitleWorkError::Observation(_)
                        | TitleWorkError::Tool(ToolError::Persistence(_)),
                    )) => Some(("title_worker_persistence_failed", "persistence_failed")),
                    Ok(Err(
                        TitleWorkError::Cleanup(_)
                        | TitleWorkError::Tool(ToolError::CleanupUnconfirmed(_)),
                    )) => Some(("title_worker_cleanup_unconfirmed", "cleanup_unconfirmed")),
                    _ => None,
                };
                let result = completion.unwrap_or_else(|_| {
                    Err(
                        ToolError::CleanupUnconfirmed("Auxiliary title worker disappeared".into())
                            .into(),
                    )
                });
                let physical_confirmed = match &result {
                    Err(TitleWorkError::Observation(error)) => {
                        ticket.unconfirmed(error.to_string(), error.clone());
                        false
                    }
                    Err(TitleWorkError::Metadata(error)) => {
                        ticket.unconfirmed(error.to_string(), error.clone());
                        false
                    }
                    Err(TitleWorkError::Cleanup(error)) => {
                        let message = error.to_string();
                        match error.wait_physical().await {
                            Ok(auxiliary::PhysicalSettlement::Acknowledged) => {
                                ticket.complete(Ok(()));
                                true
                            }
                            Ok(auxiliary::PhysicalSettlement::MetadataFailure(failure)) => {
                                ticket.unconfirmed(failure.to_string(), failure);
                                false
                            }
                            Err(_) => {
                                ticket.unconfirmed(message, error.clone());
                                false
                            }
                        }
                    }
                    Err(TitleWorkError::Tool(ToolError::CleanupUnconfirmed(error))) => {
                        ticket.complete(Err(error.clone()));
                        false
                    }
                    _ => {
                        ticket.complete(Ok(()));
                        fatal.is_none()
                    }
                };
                // Physical completion precedes owner-state publication: an
                // archive may be waiting while it holds that lifecycle gate.
                worker.complete(physical_confirmed);
                if let Some((stage, cause)) = fatal {
                    tracing::error!(
                        stage,
                        cause,
                        consequence = "title_failed",
                        "Agent title worker failed"
                    );
                }
            }
            .instrument(span),
        );
    }

    async fn generate_title_with(
        &self,
        execution: ExecutionIdentity,
        mut lease: auxiliary::IdleLease,
        cancellation: CancellationToken,
    ) -> Result<(), TitleWorkError> {
        if cancellation.is_cancelled() {
            return Ok(());
        }
        let work = lease.0.as_ref().expect("title work lease").store();
        let Some(session) = work
            .get::<StoredSessionConfiguration>()
            .await
            .map_err(persistence)?
        else {
            return Ok(());
        };
        if session.configuration.title_is_manual
            || session.archived
            || work
                .session_manager(&execution.session_id)
                .await
                .map_err(persistence)?
                .is_some()
        {
            return Ok(());
        }
        let custody = work.work_custody().map_err(persistence)?;
        let history = SessionHistory::new(
            self.store
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
                .map_err(persistence)?,
            self.run_owner(),
            execution.session_id.clone(),
        );
        let cut = history.capture().await.map_err(persistence)?;
        let Some(first) = history.first_message(&cut).await.map_err(persistence)? else {
            return Ok(());
        };
        if first.execution() != execution {
            return Ok(());
        }
        let BackendSpec::Model { descriptor, .. } = &first.spec.backend else {
            return Ok(());
        };
        let descriptor = history
            .content(first.run, descriptor)
            .await
            .map_err(persistence)?;
        let model = crate::model::AcceptedModel::from_backend(&first.spec.backend, &descriptor)
            .map_err(failed)?;
        let input = history
            .content(first.run, &first.spec.input)
            .await
            .map_err(persistence)?;
        let maka_agent_facts::input::RunInput::Message {
            content,
            source_messages,
            ..
        } = serde_json::from_slice(&input).map_err(persistence)?
        else {
            return Err(
                persistence("first consumed message has no canonical Message input").into(),
            );
        };
        let text = source_messages
            .first()
            .map_or(content.text.as_str(), |source| {
                source.unprepared_content.text.as_str()
            });
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(persistence)?;
        let language = self.resolve_language(&snapshot);
        let Some(input) = maka_session_title::Title.prepare(text, language) else {
            return Ok(());
        };
        let _cancel = cancellation.clone().drop_guard();
        let operation = async {
            input
                .validate()
                .map_err(|_| GenerationError::Failure(TitleFailureCause::Preparation))?;
            let source = crate::model::Source::restore(
                self.configuration.clone(),
                self.credentials.clone(),
                model,
                execution.session_id.clone(),
                self.revision.clone(),
            )
            .map_err(|_| GenerationError::Failure(TitleFailureCause::Preparation))?;
            let source = match &self.pricing {
                Some(pricing) => source.with_pricing(Arc::clone(pricing)),
                None => source,
            };
            let prepared = source
                .capture_auxiliary()
                .await
                .map_err(|_| GenerationError::Failure(TitleFailureCause::Preparation))?;
            let requested = input.max_output_tokens.unwrap_or(2048).min(2048);
            let quote = source.quote(&prepared).await.map_err(persistence)?;
            let mut prompt = Vec::new();
            if let Some(content) = input.system {
                prompt.push(Message::System {
                    content,
                    provider_options: None,
                });
            }
            prompt.push(Message::user(input.prompt));
            self.auxiliary
                .generate(
                    ModelRequest {
                        operation: maka_agent_facts::context::ModelOperation::Inference,
                        language: input.language,
                        provider: prepared.provider,
                        prompt: prompt.into(),
                        tools: Vec::new(),
                        tool_choice: Default::default(),
                        provider_options: prepared.options,
                        max_output_tokens: Some(
                            prepared
                                .main_output_limit
                                .map_or(requested, |limit| limit.min(requested)),
                        ),
                    },
                    cancellation.clone(),
                    &self.store,
                    auxiliary::Admission::Source {
                        source: AuxiliarySource::SessionTitle {
                            execution: execution.clone(),
                        },
                        binding: source.accepted.binding.clone(),
                        purpose: maka_agent_facts::context::ModelPurpose::Main,
                        execution: auxiliary::Execution::Work {
                            custody: custody.clone(),
                            session: execution.session_id.clone(),
                        },
                    },
                    quote,
                )
                .await
                .map_err(GenerationError::from)
        };
        tokio::pin!(operation);
        let (result, timed_out) = tokio::select! {
            biased;
            _ = tokio::time::sleep(Duration::from_secs(30)) => { cancellation.cancel(); (operation.await, true) },
            result = &mut operation => (result, false),
        };
        // Uncertain persistence or physical cleanup outranks the logical deadline.
        let result = match result {
            Err(GenerationError::Operation(error)) => return Err(error.into()),
            Err(GenerationError::Metadata(error)) => return Err(TitleWorkError::Metadata(error)),
            Err(GenerationError::Cleanup(error)) => return Err(TitleWorkError::Cleanup(error)),
            _ if self.stop.is_cancelled() || (cancellation.is_cancelled() && !timed_out) => {
                return Ok(());
            }
            _ if timed_out => Err(TitleFailureCause::Model {
                cause: ModelFailureCause::TimedOut,
            }),
            Err(GenerationError::Skipped) => return Ok(()),
            Err(GenerationError::Failure(cause)) => Err(cause),
            Ok(generated) if generated.finish_reason == ModelFinishReason::Length => {
                Err(TitleFailureCause::OutputLimit)
            }
            Ok(generated) if generated.finish_reason != ModelFinishReason::Stop => {
                Err(TitleFailureCause::InvalidOutput)
            }
            Ok(generated) => {
                maka_session_title::normalize(&generated.text).ok_or(TitleFailureCause::EmptyOutput)
            }
        };
        let title = match result {
            Ok(title) => title,
            Err(cause) => {
                tracing::warn!(stage = "title_generation_failed", cause = ?cause,
                    session_id = %execution.session_id, run_id = %execution.run_id,
                    "Automatic title generation failed");
                let writer = self
                    .store
                    .data_writer_for_work(custody.as_ref(), &execution.session_id)
                    .map_err(persistence)?;
                let state = self.durable.with_data_writer(writer).map_err(persistence)?;
                let original = maka_agent_state::Change::new(
                    Fact::SessionTitleFailed { cause },
                    UnixMillis(now().try_into().map_err(persistence)?),
                );
                if let Err(error) = publish_title_failure(state, first.run, original).await {
                    if !error.writer_settled {
                        lease.retain_unconfirmed(error.clone());
                    }
                    return Err(TitleWorkError::Observation(error));
                }
                return Ok(());
            }
        };
        // Main execution also moves the public revision. Retry metadata only;
        // each attempt gives queued manual changes and shutdown a turn at the gate.
        loop {
            let _admission = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Ok(()),
                admission = self.runs.ordered(&execution.session_id) => admission,
            };
            let runs = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Ok(()),
                runs = self.runs.state() => runs,
            };
            if runs.closing || self.stop.is_cancelled() {
                return Ok(());
            }
            let Some(current) = work
                .get::<StoredSessionConfiguration>()
                .await
                .map_err(persistence)?
            else {
                return Ok(());
            };
            if current.archived
                || current.configuration.title_is_manual
                || current.configuration.title != session.configuration.title
                || work
                    .session_manager(&execution.session_id)
                    .await
                    .map_err(persistence)?
                    .is_some()
            {
                return Ok(());
            }
            let title = title.clone();
            match work
                .update_session_metadata(
                    &execution.session_id,
                    current.revision,
                    move |configuration: &mut StoredSessionConfiguration| {
                        if !configuration.title_is_manual {
                            configuration.title = title;
                        }
                        Ok(())
                    },
                )
                .await
            {
                Ok(maka_event_log::sessions::SessionMutation::Committed(_)) => return Ok(()),
                Ok(maka_event_log::sessions::SessionMutation::RevisionConflict { .. }) => continue,
                Err(
                    maka_event_log::StoreError::SessionNotFound
                    | maka_event_log::StoreError::SessionRetired
                    | maka_event_log::StoreError::SessionBusy,
                ) => return Ok(()),
                Err(error) => return Err(persistence(error).into()),
            }
        }
    }
}
