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

use super::{Executions, Result, failure, internal, snapshot};
use crate::session::SessionConfiguration;
use maka_agent::RunError;
use maka_protocol::{Operation, OperationErrorCode as Code, turn::*};
use maka_runtime::{continuation::RunBoundary, event::Fact, input::InvocationInput};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
pub(super) mod prepare;

pub(super) enum Selection {
    Ready(RunBoundary),
    Parked(TurnResumeParkReason),
}
fn parked(session: String, reason: TurnResumeParkReason) -> TurnResumePlan {
    TurnResumePlan::Parked {
        session_id: session,
        reason,
    }
}

impl Executions {
    pub(crate) async fn resume_query(
        &self,
        input: TurnResumeQueryInput,
        connection: Uuid,
    ) -> Result<TurnResumePlan> {
        self.ordinary_session(&input.session_id)
            .await
            .map_err(|error| failure(Code::OperationUnavailable, &error.message))?;
        let session = self.resume_session(&input.session_id).await?;
        if self
            .has_session_work(&input.session_id)
            .await
            .map_err(internal)?
        {
            return Ok(parked(input.session_id, TurnResumeParkReason::SessionBusy));
        }
        let source = match self.resume_source(&input).await? {
            Selection::Ready(source) => source,
            Selection::Parked(reason) => return Ok(parked(input.session_id, reason)),
        };
        let run = match self
            .prepare_resume(
                &session,
                source.clone(),
                Uuid::new_v4().to_string(),
                None,
                prepare::Mode::Observe(connection),
            )
            .await
        {
            Ok(run) => run,
            Err(error) if error.code == Code::OperationUnavailable => {
                return Ok(parked(
                    input.session_id,
                    TurnResumeParkReason::SafetyObservationUnavailable,
                ));
            }
            Err(error) => return Err(error),
        };
        match self.engine.check_continuation(&run, &self.shutdown).await {
            Ok(()) => Ok(TurnResumePlan::Ready {
                session_id: input.session_id,
                source_run_id: input.source_run_id.unwrap_or(source.invocation.run_id),
                source_turn_id: source.invocation.turn_id,
                source_runtime_event_high_water: source.high_water,
            }),
            Err(RunError::Cancelled) => Err(failure(Code::HostDraining, "Host is draining")),
            Err(_) => Ok(parked(
                input.session_id,
                TurnResumeParkReason::SafetyCheckFailed,
            )),
        }
    }

    pub(crate) async fn resume_start(
        self: &Arc<Self>,
        input: TurnResumeStartInput,
        connection: Uuid,
    ) -> Result<TurnResumeStartResult> {
        self.ordinary_session(&input.session_id).await?;
        let mut prepared = None;
        loop {
            let admission = self.lock_admission().await;
            if self.shutdown.is_cancelled() {
                return Err(failure(Code::HostDraining, "Host is draining"));
            }
            // Canonical identity wins even if files, tools or the model disappeared.
            if let Some(boundary) = self
                .log
                .turn_boundary(&input.session_id, &input.turn_id)
                .await
                .map_err(internal)?
            {
                let same_request = match boundary.root_input() {
                    InvocationInput::Continuation { claim, .. }
                        if claim.source.high_water == input.source_runtime_event_high_water =>
                    {
                        if claim.source.invocation.run_id == input.source_run_id {
                            true
                        } else {
                            // Resolve the recorded source, never today's Session tip.
                            self.log
                                .run_boundary(&input.session_id, &claim.source.invocation.run_id)
                                .await
                                .map_err(internal)?
                                .is_some_and(|source| {
                                    source.invocation == claim.source.invocation
                                        && source.root_invocation().run_id == input.source_run_id
                                })
                        }
                    }
                    _ => false,
                };
                if !same_request {
                    return Err(failure(
                        Code::OperationConflict,
                        "Turn identity belongs to another request",
                    ));
                }
                return Ok(TurnResumeStartResult::Started {
                    turn: snapshot::project(boundary).snapshot,
                });
            }
            let session = self.resume_session(&input.session_id).await?;
            if self
                .has_session_work(&input.session_id)
                .await
                .map_err(internal)?
            {
                return Err(failure(
                    Code::SessionBusy,
                    "Session has pending or active work",
                ));
            }
            let source = match self
                .resume_source(&TurnResumeQueryInput {
                    session_id: input.session_id.clone(),
                    source_run_id: Some(input.source_run_id.clone()),
                    expected_runtime_event_high_water: Some(input.source_runtime_event_high_water),
                })
                .await?
            {
                Selection::Ready(source) => source,
                Selection::Parked(reason) => {
                    return Ok(TurnResumeStartResult::Parked {
                        plan: parked(input.session_id, reason),
                    });
                }
            };
            let fingerprint = format!(
                "sha256:{:x}",
                Sha256::digest(
                    serde_json::to_vec(&(Operation::TurnResumeStart, &input)).map_err(internal)?
                )
            );
            let Some(candidate) = prepared.take() else {
                drop(admission);
                prepared = Some(
                    async {
                        let environment = self
                            .prepare_environment(
                                &input.session_id,
                                Some(connection),
                                maka_client_capability::BindingMode::Strict,
                                self.log
                                    .invocation_configuration(&source.invocation)
                                    .await
                                    .map_err(internal)?
                                    .map(|configuration| configuration.orchestration_mode),
                            )
                            .await?;
                        let run = self
                            .prepare_resume(
                                &session,
                                source,
                                input.turn_id.clone(),
                                Some(fingerprint),
                                prepare::Mode::Prepared(&environment),
                            )
                            .await?;
                        let run = self
                            .engine
                            .prepare_continuation(run, &self.shutdown)
                            .await
                            .map_err(|error| {
                                failure(Code::OperationUnavailable, &error.to_string())
                            })?;
                        Ok::<_, maka_protocol::OperationError>((environment, run))
                    }
                    .await,
                );
                continue;
            };
            let (candidate, run) = match candidate {
                Ok(candidate) => candidate,
                Err(error) if error.code == Code::OperationUnavailable => {
                    return Ok(TurnResumeStartResult::Parked {
                        plan: parked(input.session_id, TurnResumeParkReason::SafetyCheckFailed),
                    });
                }
                Err(error) => return Err(error),
            };
            let Some((_environment, _input_admission)) =
                candidate.commit(self, &input.session_id).await?
            else {
                continue;
            };
            let invocation = run.invocation().clone();
            let running = self
                .engine
                .start_continuation(run, self.shutdown.child_token())
                .await
                .map_err(|error| {
                    if super::requires_drain(&error) {
                        self.begin_drain();
                    }
                    super::execution_error(error)
                })?;
            self.track(running);
            return self
                .query(TurnQueryInput {
                    session_id: invocation.session_id,
                    turn_id: invocation.turn_id,
                })
                .await
                .map(|turn| TurnResumeStartResult::Started { turn })
                .map_err(|error| failure(Code::OutcomeUnknown, &error.message));
        }
    }

    pub(super) async fn resume_session(&self, id: &str) -> Result<SessionConfiguration> {
        if self.shutdown.is_cancelled() {
            return Err(failure(Code::HostDraining, "Host is draining"));
        }
        let session = self
            .log
            .get_session::<SessionConfiguration>(id)
            .await
            .map_err(internal)?
            .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
        if session.archived {
            return Err(failure(
                Code::SessionArchived,
                "Cannot resume an archived Session",
            ));
        }
        Ok(session.configuration)
    }

    pub(super) async fn resume_source(&self, input: &TurnResumeQueryInput) -> Result<Selection> {
        use TurnResumeParkReason as Reason;
        let run_id = match &input.source_run_id {
            Some(id) => {
                let Some(source) = self
                    .log
                    .run_boundary(&input.session_id, id)
                    .await
                    .map_err(internal)?
                else {
                    return Ok(Selection::Parked(Reason::ResumeCandidateMissing));
                };
                if source.root_invocation() == &source.invocation {
                    // The public root denotes the whole logical Turn. Claims still
                    // bind the exact physical terminal, including its high-water.
                    let tip = self
                        .log
                        .turn_boundary(&input.session_id, &source.invocation.turn_id)
                        .await
                        .map_err(internal)?
                        .ok_or_else(|| failure(Code::InternalFailure, "Resume Turn disappeared"))?;
                    if tip.root_invocation() != &source.invocation {
                        return Ok(Selection::Parked(Reason::SafetyCheckFailed));
                    }
                    tip.invocation.run_id
                } else {
                    id.clone()
                }
            }
            None => match self
                .log
                .latest_continuation_candidate(&input.session_id)
                .await
                .map_err(internal)?
            {
                Some(id) => id,
                None => return Ok(Selection::Parked(Reason::ResumeCandidateMissing)),
            },
        };
        if self.shells.has_session(&input.session_id)
            || self
                .log
                .has_unsettled_shells(&input.session_id)
                .await
                .map_err(internal)?
        {
            return Ok(Selection::Parked(Reason::SafetyCheckFailed));
        }
        let prefix = match self
            .log
            .run_prefix(&input.session_id, &run_id, None, 10_000, 8 * 1024 * 1024)
            .await
        {
            Ok(Some(prefix)) => prefix,
            Ok(None) => return Ok(Selection::Parked(Reason::ResumeCandidateMissing)),
            Err(maka_event_log::StoreError::PrefixTooLarge) => {
                return Ok(Selection::Parked(Reason::SourceRunUnreadable));
            }
            Err(error) => return Err(internal(error)),
        };
        if input
            .expected_runtime_event_high_water
            .is_some_and(|expected| expected != prefix.high_water)
            || !matches!(
                prefix.events.last().map(|e| &e.event.fact),
                Some(Fact::InvocationEnded { .. })
            )
        {
            return Ok(Selection::Parked(Reason::SafetyCheckFailed));
        }
        if matches!(
            prefix.events.last().map(|event| &event.event.fact),
            Some(Fact::InvocationEnded {
                outcome: maka_runtime::event::InvocationOutcome::HandoffPaused { .. }
            })
        ) {
            return Ok(Selection::Parked(Reason::SafetyCheckFailed));
        }
        if !matches!(
            prefix.events.first().map(|e| &e.event.fact),
            Some(Fact::InvocationOpened {
                input: InvocationInput::Message { .. }
                    | InvocationInput::Continuation { .. }
                    | InvocationInput::Handoff { .. },
                ..
            })
        ) {
            return Ok(Selection::Parked(Reason::SourceRunUnreadable));
        }
        let source = RunBoundary {
            invocation: prefix.invocation,
            high_water: prefix.high_water,
            digest: prefix.digest,
        };
        if self
            .log
            .continuation_for_source(&source)
            .await
            .map_err(internal)?
            .is_some()
        {
            return Ok(Selection::Parked(Reason::ContinuationAlreadyExists));
        }
        Ok(Selection::Ready(source))
    }
}
