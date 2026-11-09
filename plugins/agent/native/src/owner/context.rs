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

//! Read the original prepared request without resolving today's prompt or model.
use super::*;
use maka_agent_engine::preparation::RequestSource;
use maka_agent_facts::{
    accounting::Outcome,
    context::{ModelPurpose, RequestContextEvidence},
    durable::{BackendSpec, ContentRef, Fact, ModelAttemptId, RequestSpec},
};
use maka_agent_state::session_history::{HistoryCut, HistoryItem, RunSource, SessionHistory};
use maka_capabilities::call::Scope;
use std::collections::BTreeMap;

impl Owner {
    pub async fn context(
        self: &Arc<Self>,
        input: ContextRead,
        scope: &Scope,
    ) -> Result<ContextReport, String> {
        if input
            .through
            .is_some_and(|value| value > maka_agent_facts::interaction::MAX_SAFE_INTEGER)
        {
            return Err("agent_context_input_invalid".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner.session(&input.session_id).await?;
                let history = owner
                    .durable
                    .session_history(owner.run_owner(), input.session_id.clone());
                let cut = match input.through {
                    Some(through) => history.capture_at(through).await,
                    None => history.capture().await,
                }
                .map_err(unavailable)?;
                let source = match input.run_id {
                    Some(run) => {
                        let source = history.run_source(run).await.map_err(unavailable)?;
                        if source.admission_sequence > cut.through_sequence {
                            return Err(unavailable("Run is outside the selected context fence"));
                        }
                        Some(source)
                    }
                    None => history.latest(&cut).await.map_err(unavailable)?,
                };
                let request = match source {
                    Some(source) => {
                        original_request(&history, &cut, &source, &scope.cancellation, &owner.stop)
                            .await?
                    }
                    None => None,
                };
                owner.session(&input.session_id).await?;
                check_cancelled(&scope.cancellation, &owner.stop)?;
                let report = ContextReport {
                    through: cut.through_sequence,
                    request,
                };
                report.validate()?;
                Ok(report)
            })
        })
        .await
    }
}

pub(super) async fn original_request(
    history: &SessionHistory,
    cut: &HistoryCut,
    source: &RunSource,
    cancellation: &CancellationToken,
    stop: &CancellationToken,
) -> Result<Option<ContextRequest>, String> {
    if !matches!(&source.spec.backend, BackendSpec::Model { .. }) {
        return Ok(None);
    }
    let mut before = None;
    let mut observations: BTreeMap<ModelAttemptId, (ContextRequestState, Option<u64>)> =
        BTreeMap::new();
    let mut selected: Option<(ModelAttemptId, RequestSpec)> = None;
    loop {
        check_cancelled(cancellation, stop)?;
        let page = history
            .previous_page(cut, before, 128)
            .await
            .map_err(unavailable)?;
        for item in page.items.into_iter().rev() {
            if item.sequence < source.admission_sequence {
                return no_request(selected);
            }
            if item.recorded.run != source.run {
                continue;
            }
            match &item.recorded.fact {
                Fact::ModelClosed {
                    attempt,
                    outcome,
                    usage,
                    ..
                } if selected.is_none() => {
                    observations.insert(
                        *attempt,
                        (
                            match outcome {
                                Outcome::Success => ContextRequestState::Completed,
                                Outcome::Error | Outcome::Aborted | Outcome::Unknown => {
                                    ContextRequestState::Interrupted
                                }
                            },
                            usage.input_tokens,
                        ),
                    );
                }
                Fact::ModelInterrupted { attempt, .. } if selected.is_none() => {
                    observations
                        .entry(*attempt)
                        .or_insert((ContextRequestState::Interrupted, None));
                }
                Fact::ModelAttemptPrepared { attempt, step } if selected.is_none() => {
                    let request = history
                        .request(cut, source.run, *step)
                        .await
                        .map_err(unavailable)?;
                    if request.accounting.purpose == ModelPurpose::Main {
                        selected = Some((*attempt, request));
                    }
                }
                Fact::StepPrepared { step, .. } => {
                    if let Some((attempt, request)) = &selected {
                        if request.step == *step {
                            let (state, tokens) = observations
                                .remove(attempt)
                                .unwrap_or((ContextRequestState::Requested, None));
                            return describe_request(
                                history,
                                cut,
                                source,
                                request,
                                *attempt,
                                &item,
                                (state, tokens),
                            )
                            .await
                            .map(Some);
                        }
                    } else {
                        let request = history
                            .request(cut, source.run, *step)
                            .await
                            .map_err(unavailable)?;
                        if request.accounting.purpose == ModelPurpose::Main {
                            return Err(unavailable(
                                "prepared context has no original model attempt",
                            ));
                        }
                    }
                }
                Fact::RunAdmitted { .. } => return no_request(selected),
                _ => {}
            }
        }
        match page.next {
            Some(next) => before = Some(next),
            None => return no_request(selected),
        }
    }
}

fn no_request(
    selected: Option<(ModelAttemptId, RequestSpec)>,
) -> Result<Option<ContextRequest>, String> {
    if selected.is_some() {
        Err(unavailable(
            "model context is missing its original StepPrepared fact",
        ))
    } else {
        Ok(None)
    }
}

async fn describe_request(
    history: &SessionHistory,
    cut: &HistoryCut,
    source: &RunSource,
    request: &RequestSpec,
    attempt: ModelAttemptId,
    prepared: &HistoryItem,
    observation: (ContextRequestState, Option<u64>),
) -> Result<ContextRequest, String> {
    let (state, reported_input_tokens) = observation;
    let capture: RequestSource = decode(history, cut, source.run, &request.source_capture).await?;
    let provenance: RequestContextEvidence =
        decode(history, cut, source.run, &request.provenance).await?;
    if capture.current.owner != source.spec.owner
        || capture.current.session != source.spec.session_id
        || capture.current.through_sequence >= prepared.sequence
        || capture.cut.digest != request.source_digest
    {
        return Err(unavailable(
            "original context source does not match its prepared request",
        ));
    }
    let (context_window, input_limit) = context_limits(&provenance)?;
    Ok(ContextRequest {
        execution: source.execution(),
        step_id: request.step,
        attempt_id: attempt,
        sequence: prepared.sequence,
        recorded_at: prepared.recorded.at.0 as f64,
        source_through: capture.current.through_sequence,
        model_id: request.accounting.model_id.clone(),
        context_window,
        input_limit,
        state,
        breakdown: Some(provenance.breakdown),
        reported_input_tokens,
    })
}

fn context_limits(
    provenance: &RequestContextEvidence,
) -> Result<(Option<u64>, Option<u64>), String> {
    let context = provenance
        .model_context
        .as_ref()
        .ok_or_else(|| unavailable("original request is missing model context"))?;
    context.validate().map_err(unavailable)?;
    Ok((context.model_context_window, context.context_window))
}

async fn decode<T: serde::de::DeserializeOwned + std::marker::Send + 'static>(
    history: &SessionHistory,
    cut: &HistoryCut,
    run: maka_agent_facts::durable::RunId,
    reference: &ContentRef,
) -> Result<T, String> {
    history
        .with_content(cut, run, reference, |reader| {
            Ok(serde_json::from_reader(reader))
        })
        .await
        .map_err(unavailable)?
        .map_err(unavailable)
}

fn check_cancelled(
    cancellation: &CancellationToken,
    stop: &CancellationToken,
) -> Result<(), String> {
    if cancellation.is_cancelled() || stop.is_cancelled() {
        Err("agent_context_cancelled".into())
    } else {
        Ok(())
    }
}

fn unavailable(error: impl std::fmt::Display) -> String {
    tracing::warn!(stage = "context_read", cause = %error, "Prepared context query failed");
    "agent_context_unavailable".into()
}
