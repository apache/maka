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
use auxiliary::{failed, persistence};
use futures_util::FutureExt;
use maka_agent_facts::{
    diagnostics::TitleFailureCause,
    event::{Fact, InvocationInput},
    model::{ModelFinishReason, error::ModelFailureCause},
    tools::ToolError,
};
use maka_agent_ports::session::title::Policy;
use maka_event_log::usage::AuxiliarySource;
use maka_model::{ModelRequest, prompt::Message};
use tracing::Instrument;

#[derive(Default)]
pub(super) struct Registry {
    active: Arc<std::sync::Mutex<BTreeMap<String, Arc<Work>>>>,
}
struct Work {
    cancellation: CancellationToken,
    completed: tokio::sync::watch::Sender<Option<bool>>,
}
struct Worker {
    active: Arc<std::sync::Mutex<BTreeMap<String, Arc<Work>>>>,
    session: String,
    work: Arc<Work>,
    reported: bool,
}
impl Registry {
    fn start(&self, session: &str, cancellation: CancellationToken) -> Option<Worker> {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(session) {
            return None;
        }
        let (completed, _) = tokio::sync::watch::channel(None);
        let work = Arc::new(Work {
            cancellation,
            completed,
        });
        active.insert(session.to_owned(), work.clone());
        Some(Worker {
            active: self.active.clone(),
            session: session.to_owned(),
            work,
            reported: false,
        })
    }

    // Called under the lifecycle gate, which excludes new title admission.
    pub(super) async fn cancel_and_wait(&self, session: &str) -> Result<(), ()> {
        let work = self.active.lock().unwrap().get(session).cloned();
        let Some(work) = work else {
            return Ok(());
        };
        let mut completed = work.completed.subscribe();
        work.cancellation.cancel();
        loop {
            if let Some(success) = *completed.borrow_and_update() {
                return success.then_some(()).ok_or(());
            }
            completed.changed().await.map_err(|_| ())?;
        }
    }
}
impl Worker {
    fn complete(&mut self, success: bool) {
        self.reported = true;
        self.work.completed.send_replace(Some(success));
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.session);
        if !self.reported {
            self.work.completed.send_replace(Some(false));
        }
    }
}

#[cfg(test)]
pub(super) struct WriteGate {
    pub(super) entered: tokio::sync::Semaphore,
    pub(super) release: tokio::sync::Semaphore,
}

enum GenerationError {
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

impl Owner {
    // Called under the original run admission gate; its TaskTracker owns the work through cleanup.
    pub(super) fn title_after_message(
        self: &Arc<Self>,
        invocation: Invocation,
        model: crate::model::AcceptedModel,
    ) {
        if !self.settings.automatic_titles || self.stop.is_cancelled() {
            return;
        }
        let Ok(mut ticket) = self.auxiliary.resources.reserve() else {
            return;
        };
        let Some(mut worker) = self
            .titles
            .start(&invocation.session_id, self.stop.child_token())
        else {
            return;
        };
        let cancellation = worker.work.cancellation.clone();
        let owner = self.clone();
        let span = tracing::error_span!("agent_title_worker", session_id = %invocation.session_id,
            turn_id = %invocation.turn_id, run_id = %invocation.run_id,
            invocation_id = %invocation.invocation_id, activation = %self.revision.activation);
        self.workers.spawn(
            async move {
                ticket.start();
                let completion = std::panic::AssertUnwindSafe(owner.generate_title_with(
                    invocation,
                    model,
                    cancellation,
                ))
                .catch_unwind()
                .await;
                let fatal = match &completion {
                    Err(_) => Some(("title_worker_panicked", "worker_panicked")),
                    Ok(Err(ToolError::Persistence(_))) => {
                        Some(("title_worker_persistence_failed", "persistence_failed"))
                    }
                    Ok(Err(ToolError::CleanupUnconfirmed(_))) => {
                        Some(("title_worker_cleanup_unconfirmed", "cleanup_unconfirmed"))
                    }
                    _ => None,
                };
                let result = completion.unwrap_or_else(|_| {
                    Err(ToolError::CleanupUnconfirmed(
                        "Auxiliary title worker disappeared".into(),
                    ))
                });
                let cleanup = match &result {
                    Err(ToolError::CleanupUnconfirmed(error)) => Err(error.clone()),
                    _ => Ok(()),
                };
                ticket.complete(cleanup);
                // Physical completion precedes owner-state publication: an
                // archive may be waiting while it holds that lifecycle gate.
                worker.complete(fatal.is_none());
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
    #[cfg(test)]
    pub(super) async fn generate_title(
        &self,
        invocation: Invocation,
        model: crate::model::AcceptedModel,
    ) -> Result<(), ToolError> {
        self.generate_title_with(invocation, model, self.stop.child_token())
            .await
    }

    async fn generate_title_with(
        &self,
        invocation: Invocation,
        model: crate::model::AcceptedModel,
        cancellation: CancellationToken,
    ) -> Result<(), ToolError> {
        if cancellation.is_cancelled() {
            return Ok(());
        }
        let Some(session) = self
            .store
            .get_session::<StoredSessionConfiguration>(&invocation.session_id)
            .await
            .map_err(persistence)?
        else {
            return Ok(());
        };
        if session.configuration.title_is_manual
            || session.archived
            || self
                .store
                .session(&invocation.session_id)
                .await
                .map_err(persistence)?
                .session_manager(&invocation.session_id)
                .await
                .map_err(persistence)?
                .is_some()
        {
            return Ok(());
        }
        let Some(opening) = self
            .store
            .session(&invocation.session_id)
            .await
            .map_err(persistence)?
            .first_message_opening(&invocation.session_id)
            .await
            .map_err(|error| match error {
                maka_event_log::StoreError::PrefixTooLarge => failed(error),
                other => persistence(other),
            })?
        else {
            return Ok(());
        };
        if opening.event.invocation != invocation {
            return Ok(());
        }
        let Fact::InvocationOpened {
            input:
                InvocationInput::Message {
                    content,
                    source_messages,
                    ..
                },
            configuration: Some(configuration),
            ..
        } = opening.event.fact
        else {
            return Ok(());
        };
        if configuration.model.as_ref() != Some(&model.binding) {
            return Ok(());
        }
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
                invocation.session_id.clone(),
                self.revision.clone(),
            )
            .map_err(|_| GenerationError::Failure(TitleFailureCause::Preparation))?;
            let prepared = source
                .capture_auxiliary()
                .await
                .map_err(|_| GenerationError::Failure(TitleFailureCause::Preparation))?;
            let requested = input.max_output_tokens.unwrap_or(2048).min(2048);
            let quote = self
                .configuration
                .quote_model(prepared.provider_id, source.accepted.binding.model.clone())
                .await
                .map_err(persistence)?;
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
                        language: input.language,
                        provider: prepared.provider,
                        prompt: prompt.into(),
                        tools: Vec::new(),
                        provider_options: prepared.options,
                        max_output_tokens: Some(
                            prepared
                                .main_output_limit
                                .map_or(requested, |limit| limit.min(requested)),
                        ),
                    },
                    cancellation.clone(),
                    &self.store,
                    auxiliary::Admission::Source(AuxiliarySource::SessionTitle {
                        invocation: invocation.clone(),
                    }),
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
            Err(GenerationError::Operation(error)) => return Err(error),
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
                self.store
                    .session(&invocation.session_id)
                    .await
                    .map_err(persistence)?
                    .record_title_failure(invocation.clone(), cause)
                    .await
                    .map_err(persistence)?;
                return Ok(());
            }
        };
        // Main execution also moves the public revision. Retry metadata only;
        // each attempt gives queued manual changes and shutdown a turn at the gate.
        loop {
            let runs = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Ok(()),
                runs = self.runs.lock() => runs,
            };
            if runs.closing || self.stop.is_cancelled() {
                return Ok(());
            }
            let Some(current) = self
                .store
                .get_session::<StoredSessionConfiguration>(&invocation.session_id)
                .await
                .map_err(persistence)?
            else {
                return Ok(());
            };
            if current.archived
                || current.configuration.title_is_manual
                || current.configuration.title != session.configuration.title
                || self
                    .store
                    .session(&invocation.session_id)
                    .await
                    .map_err(persistence)?
                    .session_manager(&invocation.session_id)
                    .await
                    .map_err(persistence)?
                    .is_some()
            {
                return Ok(());
            }
            #[cfg(test)]
            {
                let gate = self.title_write_gate.lock().unwrap().take();
                if let Some(gate) = gate {
                    gate.entered.add_permits(1);
                    gate.release.acquire().await.unwrap().forget();
                }
            }
            let title = title.clone();
            match self
                .store
                .update_session_metadata(
                    &invocation.session_id,
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
                Err(error) => return Err(persistence(error)),
            }
        }
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    #[tokio::test]
    async fn archive_waits_for_acknowledged_title_cleanup_and_releases_finished_entries() {
        let registry = Registry::default();
        for id in 0..64 {
            let session = format!("title-{id}");
            let mut worker = registry.start(&session, CancellationToken::new()).unwrap();
            let mut waiting = Box::pin(registry.cancel_and_wait(&session));
            assert!(futures_util::poll!(&mut waiting).is_pending());
            assert!(worker.work.cancellation.is_cancelled());
            worker.complete(true);
            waiting.await.unwrap();
            drop(worker);
            assert!(registry.active.lock().unwrap().is_empty());
        }
        let worker = registry.start("lost", CancellationToken::new()).unwrap();
        let mut waiting = Box::pin(registry.cancel_and_wait("lost"));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        drop(worker);
        assert!(
            waiting.await.is_err(),
            "a disappeared worker cannot confirm cleanup"
        );
        assert!(registry.active.lock().unwrap().is_empty());
    }
}
