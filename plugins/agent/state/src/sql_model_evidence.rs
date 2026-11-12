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
use maka_agent_facts::{
    artifact::content_digest,
    composition::SourceKind,
    context::{ModelFailureProtocol, ModelPurpose},
    model::{
        assembly::AttemptBinding,
        recorded::{CompletionPart, PrivateModelPartial, RecordedPartRef},
        retry_transport::RetryTransportPhase,
    },
};
use std::collections::BTreeSet;

fn original_request(
    c: &Connection,
    view: &RunView,
    attempt: ModelAttemptId,
) -> Result<RequestSpec, StoreError> {
    let original = view
        .attempts
        .get(&attempt)
        .ok_or_else(|| invalid("model evidence has no original attempt"))?;
    let actual_step: String = c.query_row(
        "SELECT step FROM agent_attempt_ids WHERE run=? AND attempt=?",
        params![view.run.to_string(), attempt.to_string()],
        |r| r.get(0),
    )?;
    if identity::<StepId>(actual_step)? != original.step {
        return Err(invalid(
            "model evidence attempt differs from its immutable original Step",
        ));
    }
    let (digest,bytes):(String,i64)=c.query_row("SELECT b.content_sha256,length(b.payload) FROM agent_request_specs r JOIN contents b ON b.id=r.content_id WHERE r.run=? AND r.step=?",params![view.run.to_string(),original.step.to_string()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let reference = ContentRef {
        digest,
        bytes: u64::try_from(bytes)
            .map_err(|_| invalid("invalid original model request length"))?,
    };
    let request: RequestSpec = owned(c, view.run, &reference)?;
    if request.schema_version != SCHEMA_VERSION || request.step != original.step {
        return Err(invalid(
            "model evidence original request schema/Step differs",
        ));
    }
    request.accounting.validate().map_err(invalid)?;
    Ok(request)
}
fn owned<T: DeserializeOwned>(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    let bytes = owned_content(c, run, reference)?;
    if content_digest(&bytes) != reference.digest {
        return Err(invalid("model evidence original metadata hash differs"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub(super) fn validate_control(
    c: &Connection,
    view: &RunView,
    fact: &Fact,
) -> Result<(), StoreError> {
    match fact {
        Fact::ModelFirstTokenObserved { attempt } => {
            let seen: bool = c
                .prepare_cached(
                    "SELECT EXISTS(
                        SELECT 1 FROM agent_attempt_ids a
                        JOIN agent_session_history h INDEXED BY agent_session_history_run
                          ON h.run=a.run AND h.step=a.step AND h.attempt=a.attempt
                        JOIN agent_facts f ON f.sequence=h.sequence AND f.run=h.run
                        WHERE h.owner=? AND h.session=? AND h.run=? AND a.attempt=?
                          AND h.kind='model_first_token_observed' AND f.revision<=?
                    )",
                )?
                .query_row(
                    params![
                        serde_json::to_string(&view.spec.owner)?,
                        view.spec.session_id,
                        view.run.to_string(),
                        attempt.to_string(),
                        signed(view.revision)?,
                    ],
                    |row| row.get(0),
                )?;
            if seen {
                return Err(StoreError::EventConflict);
            }
        }
        Fact::ModelTransportSelected { attempt, .. } => {
            let request = original_request(c, view, *attempt)?;
            if request.accounting.purpose != ModelPurpose::Main
                || view.current_step != Some(request.step)
            {
                return Err(invalid(
                    "transport selection must name its original current Main request",
                ));
            }
            let provenance: serde_json::Value = owned(c, view.run, &request.provenance)?;
            let route = provenance
                .get("routeIdentity")
                .and_then(|value| value.as_str())
                .ok_or_else(|| invalid("transport selection has no frozen route identity"))?;
            if route.is_empty() || request.protocol.is_empty() || request.protocol_version == 0 {
                return Err(invalid(
                    "transport selection has no original frozen adapter contract",
                ));
            }
            let original = view
                .attempts
                .get(attempt)
                .ok_or_else(|| invalid("transport selection has no original failed Main"))?;
            let failure: ModelFailureProtocol = if let Some(reference) = &original.source_failure {
                if original.closed.as_ref().is_some_and(|closed| {
                    closed.outcome == maka_agent_facts::accounting::Outcome::Error
                        || closed
                            .protocol
                            .get("failure")
                            .is_some_and(|value| !value.is_null())
                }) {
                    return Err(StoreError::EventConflict);
                }
                owned(c, view.run, reference)?
            } else {
                let closed = original
                    .closed
                    .as_ref()
                    .filter(|closed| closed.outcome == maka_agent_facts::accounting::Outcome::Error)
                    .ok_or_else(|| {
                        invalid("transport fallback requires its actual original source failure")
                    })?;
                serde_json::from_value(closed.protocol.clone())?
            };
            let transport = failure.transport.as_ref().ok_or_else(|| {
                invalid("transport fallback has no original warm Primary route evidence")
            })?;
            if transport.fallback
                != maka_agent_facts::model::retry_transport::FallbackAvailability::WarmIdlePrimary
                || transport.adapter.kind != SourceKind::ModelAdapter
                || !request
                    .composition
                    .sources
                    .iter()
                    .any(|source| source == &transport.adapter)
                || transport.route_identity != route
            {
                return Err(invalid(
                    "transport fallback evidence differs from its original captured adapter/route or is unavailable",
                ));
            }
            if !matches!(&failure.failure,maka_agent_facts::model::error::ModelError::Provider(failure) if failure.retryable() && failure.replay_safe())
            {
                return Err(invalid(
                    "transport fallback lacks its original replay-safe provider failure",
                ));
            }
            let context: maka_agent_facts::context::RequestContextEvidence =
                serde_json::from_value(provenance)?;
            context.breakdown.validate().map_err(invalid)?;
            if let Some(model) = &context.model_context {
                model.validate().map_err(invalid)?;
            }
            let bytes = owned_content(c, view.run, &request.recovery_contract)?;
            if content_digest(&bytes) != request.recovery_contract.digest {
                return Err(invalid(
                    "transport selection recovery contract hash differs",
                ));
            }
        }
        Fact::RetryCharged { attempt, phase, .. } => {
            let request = original_request(c, view, *attempt)?;
            let expected = if request.accounting.purpose == ModelPurpose::Main {
                view.retry_phase
            } else {
                RetryTransportPhase::Primary
            };
            if *phase != expected {
                return Err(invalid(
                    "retry charge phase differs from its original Main or Summary lane",
                ));
            }
        }
        Fact::ModelObserved { attempt, .. }
            if view.retry_phase == RetryTransportPhase::Fallback =>
        {
            let original = view
                .attempts
                .get(attempt)
                .ok_or_else(|| invalid("model output has no original prepared attempt"))?;
            let selected: i64 = c.query_row("SELECT h.sequence FROM agent_session_history h INDEXED BY agent_session_history_kind JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id AND f.run=h.run WHERE h.owner=? AND h.session=? AND h.kind='model_transport_selected' AND h.run=? AND f.revision<=? ORDER BY h.sequence DESC LIMIT 1",params![serde_json::to_string(&view.spec.owner)?,view.spec.session_id,view.run.to_string(),signed(view.revision)?],|r|r.get(0))?;
            let prepared: i64 = c.query_row("SELECT sequence FROM agent_session_history INDEXED BY agent_session_history_run WHERE owner=? AND session=? AND run=? AND step=? AND kind='model_attempt_prepared' AND attempt=?",params![serde_json::to_string(&view.spec.owner)?,view.spec.session_id,view.run.to_string(),original.step.to_string(),attempt.to_string()],|r|r.get(0))?;
            if prepared < selected
                && original_request(c, view, *attempt)?.accounting.purpose == ModelPurpose::Main
            {
                return Err(invalid(
                    "late Primary model output must remain private sealed evidence after Fallback selection",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_envelope(
    value: &PrivateModelPartial,
    expected: &AttemptBinding,
    captured_sequence: u64,
    mut referenced: impl FnMut(&RecordedPartRef) -> Result<(u64, RecordedFact), StoreError>,
) -> Result<(), StoreError> {
    if &value.binding != expected || value.binding.purpose != ModelPurpose::Main {
        return Err(invalid(
            "private partial differs from its original Main writer binding",
        ));
    }
    if value.depends_on >= captured_sequence {
        return Err(invalid(
            "private partial depends on a future canonical watermark",
        ));
    }
    let mut ordinals = BTreeSet::new();
    let mut previous = None;
    for part in &value.partial.parts {
        let ordinal = match part {
            CompletionPart::Own(part) => {
                if part.message_id.is_empty() {
                    return Err(invalid(
                        "private partial own part lost its original message identity",
                    ));
                }
                part.ordinal
            }
            CompletionPart::Ref(reference) => {
                let (sequence, record) = referenced(reference)?;
                if record.schema_version != SCHEMA_VERSION
                    || record.run != expected.execution.run_id
                    || record.id.to_string() != reference.event_id
                    || sequence > value.depends_on
                {
                    return Err(invalid(
                        "private partial part receipt is outside its original canonical source",
                    ));
                }
                if !matches!(record.fact, Fact::ModelObserved { attempt, index, .. } if attempt == expected.attempt_id && index == reference.ordinal)
                {
                    return Err(invalid(
                        "private partial receipt does not name its exact original attempt/ordinal/part",
                    ));
                }
                reference.ordinal
            }
        };
        if !ordinals.insert(ordinal) || previous.is_some_and(|prior| prior >= ordinal) {
            return Err(invalid("private partial changed its original part order"));
        }
        previous = Some(ordinal);
    }
    let mut inputs = BTreeSet::new();
    for input in &value.partial.tool_inputs {
        if input.id.is_empty() || input.message_id.is_empty() || !inputs.insert(&input.id) {
            return Err(invalid(
                "private partial tool input identity is missing or duplicated",
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_partial(
    c: &Connection,
    view: &RunView,
    record: &RecordedFact,
) -> Result<(), StoreError> {
    let Fact::ModelPrivatePartialCaptured { attempt, partial } = &record.fact else {
        return Ok(());
    };
    let request = original_request(c, view, *attempt)?;
    if request.accounting.purpose != ModelPurpose::Main {
        return Err(invalid(
            "Summary cannot publish private Main partial evidence",
        ));
    }
    let value: PrivateModelPartial = owned(c, view.run, partial)?;
    let captured: i64 = c.query_row(
        "SELECT sequence FROM agent_facts WHERE run=? AND id=? AND revision=? AND schema_version=?",
        params![
            view.run.to_string(),
            record.id.to_string(),
            signed(record.revision)?,
            SCHEMA_VERSION
        ],
        |r| r.get(0),
    )?;
    let captured = u64::try_from(captured)
        .map_err(|_| invalid("invalid private partial canonical sequence"))?;
    if value.depends_on > 0 {
        let within: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_facts f JOIN agent_run_specs s ON s.run=f.run WHERE f.sequence=? AND s.owner=? AND s.session=? AND f.schema_version=? AND s.schema_version=?)",params![signed(value.depends_on)?,serde_json::to_string(&view.spec.owner)?,view.spec.session_id,SCHEMA_VERSION,SCHEMA_VERSION],|r|r.get(0))?;
        if !within {
            return Err(invalid(
                "private partial watermark is outside its original session canonical namespace",
            ));
        }
    }
    let expected = AttemptBinding {
        execution: ExecutionIdentity {
            session_id: view.spec.session_id.clone(),
            turn_id: view.spec.turn_id.clone(),
            run_id: view.run,
        },
        step_id: request.step,
        attempt_id: *attempt,
        purpose: ModelPurpose::Main,
    };
    validate_envelope(&value, &expected, captured, |reference| {
        let id: FactId = identity(reference.event_id.clone())?;
        let original = super::fact(c, view.run, id)?
            .ok_or_else(|| invalid("private partial original part receipt disappeared"))?;
        let sequence: i64 = c.query_row(
            "SELECT sequence FROM agent_facts WHERE run=? AND id=?",
            params![view.run.to_string(), id.to_string()],
            |r| r.get(0),
        )?;
        Ok((
            u64::try_from(sequence)
                .map_err(|_| invalid("invalid private partial part receipt sequence"))?,
            original,
        ))
    })
}

pub(super) fn validate_source_failure(
    c: &Connection,
    view: &RunView,
    record: &RecordedFact,
) -> Result<(), StoreError> {
    let Fact::ModelSourceFailureCaptured { attempt, failure } = &record.fact else {
        return Ok(());
    };
    let original = view
        .attempts
        .get(attempt)
        .ok_or_else(|| invalid("source failure has no original admitted model"))?;
    if original.admission.is_none() {
        return Err(invalid(
            "source error knowledge has no original model source admission",
        ));
    }
    let request = original_request(c, view, *attempt)?;
    let value: ModelFailureProtocol = owned(c, view.run, failure)?;
    if matches!(
        &value.failure,
        maka_agent_facts::model::error::ModelError::Cancelled
            | maka_agent_facts::model::error::ModelError::CleanupUnconfirmed
            | maka_agent_facts::model::error::ModelError::LocalAuthorization(_)
    ) {
        return Err(invalid(
            "local cancellation or cleanup control is not a model source failure",
        ));
    }
    if let Some(transport) = &value.transport {
        if request.accounting.purpose != ModelPurpose::Main
            || transport.route_identity.is_empty()
            || transport.adapter.kind != SourceKind::ModelAdapter
            || !request
                .composition
                .sources
                .iter()
                .any(|source| source == &transport.adapter)
        {
            return Err(invalid(
                "source failure transport evidence is not from its actual Main adapter",
            ));
        }
        let provenance: serde_json::Value = owned(c, view.run, &request.provenance)?;
        if provenance
            .get("routeIdentity")
            .and_then(|value| value.as_str())
            != Some(transport.route_identity.as_str())
        {
            return Err(invalid(
                "source failure transport evidence belongs to another original route",
            ));
        }
    }
    let contract = owned_content(c, view.run, &request.recovery_contract)?;
    if content_digest(&contract) != request.recovery_contract.digest {
        return Err(invalid("source failure recovery contract hash differs"));
    }
    Ok(())
}
