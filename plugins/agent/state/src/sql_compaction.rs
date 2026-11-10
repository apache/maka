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

use maka_agent_facts::{
    accounting::Outcome,
    context::{
        CheckpointContent, CompactedContext, ModelClosureProtocol, ModelOperation, ModelPurpose,
        RequestContextEvidence, SummaryResult,
    },
    durable::*,
    history_snapshot::RequestSource,
    model::ModelFinishReason,
};
use maka_event_log::StoreError;
use rusqlite::Connection;
use serde::de::DeserializeOwned;

use super::{decode, owned_content, pin, request};
use crate::{fold::RunView, store::invalid};

fn original<T: DeserializeOwned>(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    Ok(serde_json::from_slice(&owned_content(c, run, reference)?)?)
}

pub(super) fn validate(
    c: &Connection,
    view: &RunView,
    reference: &ContentRef,
    at: UnixMillis,
) -> Result<(), StoreError> {
    let material: CompactedContext = decode(c, reference)?;
    material.validate().map_err(invalid)?;
    let checkpoint = &material.checkpoint;
    let deferred;
    let (request, attempt) = if view.current_step == Some(checkpoint.summary_step_id) {
        let attempt_id = view
            .current_attempt
            .ok_or_else(|| invalid("compaction has no original summary attempt"))?;
        let attempt = view
            .attempts
            .get(&attempt_id)
            .ok_or_else(|| invalid("compaction summary attempt projection is absent"))?;
        if attempt.step != checkpoint.summary_step_id || attempt.admission.is_none() {
            return Err(invalid(
                "compaction does not name the current admitted summary attempt",
            ));
        }
        (request(c, view.run, attempt.step)?, attempt)
    } else {
        deferred =
            crate::store::fallback::deferred_summary(c, view, checkpoint.summary_step_id, at)?;
        (deferred.0, &deferred.1)
    };
    let closed = attempt
        .closed
        .as_ref()
        .ok_or_else(|| invalid("compaction summary has no original provider closure"))?;
    if closed.outcome != Outcome::Success || closed.diagnostic.is_some() {
        return Err(invalid(
            "compaction requires an actual successful summary closure",
        ));
    }
    request.accounting.validate().map_err(invalid)?;
    if request.accounting.purpose != ModelPurpose::Summary {
        return Err(invalid(
            "compaction source request is not a summary request",
        ));
    }
    if material.source_capture != request.source_capture
        || checkpoint.source_digest != request.source_digest
    {
        return Err(invalid(
            "compaction differs from the original frozen summary source",
        ));
    }
    let source: RequestSource = original(c, view.run, &request.source_capture)?;
    crate::session_history::validate_cut(c, &view.spec.owner, &view.spec.session_id, &source.cut)?;
    crate::session_history::validate_cut(
        c,
        &view.spec.owner,
        &view.spec.session_id,
        &source.current,
    )?;
    if source.cut.through_sequence > source.current.through_sequence
        || checkpoint.covered_through != source.current.through_sequence
    {
        return Err(invalid(
            "compaction coverage differs from the original canonical source cut",
        ));
    }
    let provenance: RequestContextEvidence = original(c, view.run, &request.provenance)?;
    provenance.breakdown.validate().map_err(invalid)?;
    if let Some(context) = &provenance.model_context {
        context.validate().map_err(invalid)?;
    }
    if checkpoint.previous_checkpoint_id != provenance.previous_checkpoint_id {
        return Err(invalid(
            "compaction predecessor differs from the request's frozen selected marker",
        ));
    }
    if let Some(marker) = &provenance.previous_checkpoint_id {
        let marker = serde_json::from_value::<FactId>(serde_json::Value::String(marker.clone()))?;
        if !crate::session_history::snapshot::checkpoint_member(c, view, &source, marker)? {
            return Err(invalid(
                "compaction predecessor is outside its actual canonical source closure",
            ));
        }
    }
    let protocol: ModelClosureProtocol = serde_json::from_value(closed.protocol.clone())?;
    if protocol.finish_reason != ModelFinishReason::Stop {
        return Err(invalid(
            "compaction summary has an invalid original finish reason",
        ));
    }
    if matches!(
        &protocol.summary,
        Some(SummaryResult::ProviderEffectsUnknown { .. })
    ) {
        return Err(invalid(
            "compaction cannot adopt a summary with unknown provider effects",
        ));
    }
    let native_operation = provenance
        .model_context
        .as_ref()
        .is_some_and(|context| context.operation == ModelOperation::CodexCompaction);
    if native_operation {
        let native = material
            .native
            .as_ref()
            .ok_or_else(|| invalid("native compaction omitted its complete original material"))?;
        let item = protocol
            .compaction
            .as_ref()
            .ok_or_else(|| invalid("native compaction has no original provider item"))?;
        let producer = provenance
            .model_context
            .as_ref()
            .and_then(|context| context.codex.as_ref())
            .ok_or_else(|| invalid("native compaction has no original producer provenance"))?;
        let tokens = closed
            .usage
            .output_tokens
            .ok_or_else(|| invalid("native compaction has no original output-token observation"))?;
        if native.item != *item
            || native.producer != *producer
            || checkpoint.summary != CheckpointContent::native(item, tokens)
        {
            return Err(invalid(
                "native compaction differs from original item, producer or observed usage",
            ));
        }
    } else {
        if protocol.compaction.is_some() || material.native.is_some() {
            return Err(invalid(
                "text summary cannot adopt a native item without original native-operation provenance",
            ));
        }
        let CheckpointContent::Text(expected) = &checkpoint.summary else {
            return Err(invalid(
                "text compaction requires original textual summary evidence",
            ));
        };
        if expected.trim().is_empty() {
            return Err(invalid("compaction summary text is empty"));
        }
        let Some(SummaryResult::Text { summary }) = &protocol.summary else {
            return Err(invalid(
                "compaction has no original validated textual summary",
            ));
        };
        if &summary.text != expected {
            return Err(invalid(
                "compaction text differs from the original validated summary",
            ));
        }
    }
    pin(c, view.run, &material.source_capture)?;
    Ok(())
}
