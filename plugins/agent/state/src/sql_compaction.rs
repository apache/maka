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
        RequestContextEvidence, SummaryOrigin, SummaryResult,
    },
    durable::*,
    history_snapshot::RequestSource,
    model::ModelFinishReason,
};
use maka_event_log::{StoreError, connection::Query};
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;

use super::{decode, identity, model_attempt, owned_content, pin, request};
use crate::{
    fold::{Attempt, RunView},
    store::{fallback::valid_summary, invalid},
};

pub(super) fn ends_run(fact: &Fact) -> bool {
    matches!(
        fact,
        Fact::RunTerminated {
            terminal: Terminal::Completed | Terminal::Cancelled,
            ..
        }
    )
}

fn original<T: DeserializeOwned>(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    Ok(serde_json::from_slice(&owned_content(c, run, reference)?)?)
}

pub(super) fn validate_proactive_request(
    c: &Connection,
    view: &RunView,
    summary: &RequestSpec,
) -> Result<(), StoreError> {
    let main = view
        .current_step
        .ok_or_else(|| invalid("proactive Summary has no original Main Step"))?;
    let main = request(c, view.run, main)?;
    if main.accounting.purpose != ModelPurpose::Main
        || summary.accounting.purpose != ModelPurpose::Summary
        || summary.compaction_recovery.is_some()
        || summary.summary_repair_of.is_some()
        || !summary.steering.is_empty()
        || !summary.composition.tools.is_empty()
        || !matches!(view.spec.origin, RunOrigin::Local)
    {
        return Err(invalid("invalid proactive Summary request"));
    }
    Ok(())
}

pub(crate) struct PreviousProactiveSummary(pub RunId, pub StepId);

impl Query for PreviousProactiveSummary {
    type Output = Option<SummaryOrigin>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        previous_proactive_summary(c, self.0, self.1)
    }
}

fn previous_proactive_summary(
    c: &Connection,
    run: RunId,
    step: StepId,
) -> Result<Option<SummaryOrigin>, StoreError> {
    let candidate: Option<(String, String)> = c
        .query_row(
            "SELECT r.run,r.proactive_summary FROM agent_runs current
         JOIN agent_runs r ON r.owner=current.owner AND r.session=current.session
         JOIN agent_attempts a ON a.run=r.run AND a.key=r.proactive_summary
         WHERE current.run=? AND r.admission_sequence<current.admission_sequence
           AND r.local=1 AND r.cancelled_by_risk=0 AND r.proactive_summary IS NOT NULL
           AND json_extract(r.terminal,'$') IN ('completed','cancelled')
           AND json_extract(a.body,'$.closed.outcome')='success'
           AND json_extract(a.body,'$.cleanup.kind')='confirmed'
         ORDER BY r.admission_sequence DESC LIMIT 1",
            [run.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((origin_run, attempt)) = candidate else {
        return Ok(None);
    };
    let origin = SummaryOrigin {
        run: identity(origin_run)?,
        attempt: identity(attempt)?,
    };
    let attempt = model_attempt(c, origin.run, origin.attempt)?;
    let summary = request(c, origin.run, attempt.step)?;
    let main = request(c, run, step)?;
    if !valid_summary(c, origin.run, &summary, &attempt)?
        || !extends_summary(c, origin.run, &summary, run, &main)?
    {
        return Ok(None);
    }
    Ok(Some(origin))
}

fn extends_summary(
    c: &Connection,
    producer: RunId,
    summary: &RequestSpec,
    run: RunId,
    main: &RequestSpec,
) -> Result<bool, StoreError> {
    if main.accounting.purpose != ModelPurpose::Main
        || summary.accounting.purpose != ModelPurpose::Summary
    {
        return Ok(false);
    }
    let summary_context: RequestContextEvidence = original(c, producer, &summary.provenance)?;
    let main_context: RequestContextEvidence = original(c, run, &main.provenance)?;
    if summary_context.previous_checkpoint_id != main_context.previous_checkpoint_id {
        return Ok(false);
    }
    if producer != run {
        let prefix: RequestSource = original(c, producer, &summary.source_capture)?;
        let pending: RequestSource = original(c, run, &main.source_capture)?;
        return Ok(prefix.current.through_sequence <= pending.current.through_sequence);
    }
    // The same-Run Summary may include the pending Main's StepPrepared fact,
    // after the Main froze its input. Replay checks their logical message prefix.
    Ok(true)
}

fn proactive_summary(
    c: &Connection,
    view: &RunView,
    material: &CompactedContext,
    at: UnixMillis,
) -> Result<Option<(RunId, RequestSpec, Attempt)>, StoreError> {
    let step = material.checkpoint.summary_step_id;
    let (producer, attempt) = if let Some(origin) = material.summary_origin {
        let earlier: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_run_specs current
             JOIN agent_facts admitted ON admitted.run=current.run AND admitted.revision=1
             JOIN agent_runs r ON r.owner=current.owner AND r.session=current.session
             WHERE current.run=? AND r.run=? AND r.admission_sequence<admitted.sequence
               AND r.local=1 AND r.cancelled_by_risk=0 AND r.proactive_summary=?
               AND json_extract(r.terminal,'$') IN ('completed','cancelled'))",
            params![
                view.run.to_string(),
                origin.run.to_string(),
                origin.attempt.to_string()
            ],
            |row| row.get(0),
        )?;
        if !earlier {
            return Err(invalid(
                "compaction does not name an earlier proactive Summary in this Session",
            ));
        }
        (origin.run, model_attempt(c, origin.run, origin.attempt)?)
    } else if let Some((_, attempt)) = view.proactive_summary_attempt()
        && attempt.step == step
    {
        (view.run, attempt.clone())
    } else {
        return Ok(None);
    };
    let summary = request(c, producer, step)?;
    if attempt.step != step
        || attempt.cleanup != maka_plugin_core::operation::OperationCleanup::Confirmed
        || !valid_summary(c, producer, &summary, &attempt)?
    {
        return Err(invalid(
            "compaction requires its successful proactive Summary and cleanup",
        ));
    }
    let main = view
        .current_step
        .ok_or_else(|| invalid("proactive adoption has no pending Main"))?;
    let main = request(c, view.run, main)?;
    if !extends_summary(c, producer, &summary, view.run, &main)? {
        return Err(invalid(
            "proactive Summary has another checkpoint predecessor or source",
        ));
    }
    let adopt = if let Some(id) = view.current_attempt
        && let Some(attempt) = view.attempts.get(&id)
        && attempt.step == main.step
    {
        attempt.admission.is_some()
            && attempt.interrupted.is_some()
            && !attempt.semantic
            && !attempt.has_tools
            && matches!(
                attempt.recovery,
                Some(AttemptRecovery::ContextOverflow {
                    observed_output: false
                })
            )
            && !attempt
                .closed
                .as_ref()
                .is_some_and(|closed| closed.outcome == Outcome::Unknown)
    } else {
        let evidence: RequestContextEvidence = original(c, view.run, &main.provenance)?;
        evidence
            .model_context
            .and_then(|context| context.declared_window)
            .is_some_and(|window| evidence.estimated_input_tokens >= window)
    };
    if !adopt
        || view
            .spec
            .budget
            .deadline
            .is_some_and(|deadline| at >= deadline)
        || view
            .spec
            .budget
            .tokens
            .is_some_and(|limit| view.tokens >= limit)
    {
        return Err(invalid(
            "proactive adoption has not reached the frozen threshold or no-output overflow",
        ));
    }
    Ok(Some((producer, summary, attempt)))
}

pub(super) fn validate(
    c: &Connection,
    view: &RunView,
    reference: &ContentRef,
    at: UnixMillis,
    saving_for_next_run: bool,
) -> Result<(), StoreError> {
    if view.stopped && !saving_for_next_run {
        return Err(invalid(
            "stopped Run can only save compaction for the next Run",
        ));
    }
    let material: CompactedContext = decode(c, reference)?;
    material.validate().map_err(invalid)?;
    let checkpoint = &material.checkpoint;
    let deferred;
    let proactive;
    let (producer, request, attempt) =
        if let Some(candidate) = proactive_summary(c, view, &material, at)? {
            proactive = candidate;
            (proactive.0, proactive.1, &proactive.2)
        } else if view.current_step == Some(checkpoint.summary_step_id) {
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
            (view.run, request(c, view.run, attempt.step)?, attempt)
        } else {
            deferred = crate::store::fallback::deferred_summary(
                c,
                view,
                checkpoint.summary_step_id,
                at,
                saving_for_next_run,
            )?;
            (view.run, deferred.0, &deferred.1)
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
    let source: RequestSource = original(c, producer, &request.source_capture)?;
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
    let provenance: RequestContextEvidence = original(c, producer, &request.provenance)?;
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
