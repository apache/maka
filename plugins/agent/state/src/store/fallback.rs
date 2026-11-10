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

use super::invalid;
use crate::{
    fold::{Attempt, RunView},
    sql,
};
use maka_agent_facts::{
    accounting::Outcome,
    artifact::content_digest,
    context::{
        CompactedContext, ModelClosureProtocol, ModelOperation, ModelPurpose,
        RequestContextEvidence, SummaryResult,
    },
    durable::*,
    model::ModelFinishReason,
};
use maka_event_log::{StoreError, connection::Query, root_store::DataWriter};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) async fn compaction_fallback(
    data: &DataWriter,
    run: RunId,
    summary_step: StepId,
) -> Result<Option<StepId>, StoreError> {
    data.query_barrier(ReadFallback(run, summary_step)).await
}
struct ReadFallback(RunId, StepId);
struct Scope {
    run: RunId,
    owner: String,
    session: String,
    revision: u64,
    sequence: i64,
}
struct PreparedStep {
    sequence: i64,
    reference: ContentRef,
    request: RequestSpec,
}
impl Query for ReadFallback {
    type Output = Option<StepId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        type OriginalAttemptRow = (
            String,
            String,
            u32,
            Option<String>,
            Option<String>,
            Option<u32>,
            Option<String>,
            Option<i64>,
        );
        let row:Option<OriginalAttemptRow>=c.query_row(
            "SELECT s.owner,s.session,s.schema_version,r.owner,r.session,r.schema_version,r.current_step,r.revision FROM agent_run_specs s LEFT JOIN agent_runs r ON r.run=s.run WHERE s.run=?",
            [self.0.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
        ).optional()?;
        let (owner, session, schema, r_owner, r_session, r_schema, current, revision) =
            row.ok_or_else(|| invalid("compaction fallback has no canonical Run"))?;
        if schema != SCHEMA_VERSION
            || r_schema != Some(crate::sql::HEADER_SCHEMA_VERSION)
            || r_owner.as_ref() != Some(&owner)
            || r_session.as_ref() != Some(&session)
            || current.as_deref() != Some(self.1.to_string().as_str())
        {
            return Err(invalid(
                "compaction fallback Run projection differs from its canonical source",
            ));
        }
        let revision = revision
            .filter(|r| *r > 0)
            .ok_or_else(|| invalid("compaction fallback Run projection is missing"))?;
        let tail:Option<(i64,u32)>=c.query_row("SELECT revision,schema_version FROM agent_facts INDEXED BY agent_facts_diagnostics_tail WHERE run=? ORDER BY revision DESC LIMIT 1",[self.0.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if tail != Some((revision, SCHEMA_VERSION)) {
            return Err(invalid(
                "compaction fallback Run projection is not at its canonical head",
            ));
        }
        let scope = scope(c, self.0, owner, session, revision as u64)?;
        let current = current_summary(c, &scope, self.1)?;
        check_projection(c, &scope, &current)?;
        let candidate = candidate(c, &scope, &current)?;
        if let Some(candidate) = &candidate {
            check_projection(c, &scope, candidate)?;
        }
        Ok(candidate.map(|candidate| candidate.request.step))
    }
}
fn scope(
    c: &Connection,
    run: RunId,
    owner: String,
    session: String,
    revision: u64,
) -> Result<Scope, StoreError> {
    let revision_sql = i64::try_from(revision)
        .map_err(|_| invalid("compaction fallback revision exceeds SQLite range"))?;
    let sequence: Option<i64> = c
        .query_row(
            "SELECT sequence FROM agent_facts WHERE run=? AND revision=? AND schema_version=?",
            params![run.to_string(), revision_sql, SCHEMA_VERSION],
            |r| r.get(0),
        )
        .optional()?;
    Ok(Scope {
        run,
        owner,
        session,
        revision,
        sequence: sequence
            .filter(|s| *s > 0)
            .ok_or_else(|| invalid("compaction fallback has no actual canonical prefix"))?,
    })
}
fn prepared(c: &Connection, scope: &Scope, step: StepId) -> Result<PreparedStep, StoreError> {
    type ProviderObservationRow = (
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<u32>,
    );
    let row:Option<ProviderObservationRow>=c.query_row(
        "SELECT h.sequence,h.fact_id,f.id,f.run,f.revision,f.schema_version FROM agent_session_history h INDEXED BY agent_session_history_run LEFT JOIN agent_facts f ON f.sequence=h.sequence WHERE h.owner=? AND h.session=? AND h.run=? AND h.step=? AND h.kind='step_prepared' AND h.sequence<=? ORDER BY h.sequence LIMIT 1",
        params![scope.owner,scope.session,scope.run.to_string(),step.to_string(),scope.sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)),
    ).optional()?;
    let (sequence, id, f_id, run, revision, schema) =
        row.ok_or_else(|| invalid("compaction fallback StepPrepared source/index is missing"))?;
    if sequence <= 0
        || f_id.as_ref() != Some(&id)
        || run.as_deref() != Some(scope.run.to_string().as_str())
        || schema != Some(SCHEMA_VERSION)
        || revision.is_none_or(|r| r <= 0 || r as u64 > scope.revision)
    {
        return Err(invalid(
            "compaction fallback StepPrepared membership differs",
        ));
    }
    let id: FactId = serde_json::from_value(serde_json::Value::String(id))?;
    let fact = sql::fact(c, scope.run, id)?
        .ok_or_else(|| invalid("compaction fallback original StepPrepared disappeared"))?;
    if Some(i64::try_from(fact.revision).map_err(|_| invalid("invalid StepPrepared revision"))?)
        != revision
    {
        return Err(invalid(
            "compaction fallback canonical StepPrepared revision differs",
        ));
    }
    let Fact::StepPrepared {
        step: original,
        request: reference,
        ..
    } = fact.fact
    else {
        return Err(invalid(
            "compaction fallback index does not identify StepPrepared",
        ));
    };
    if original != step {
        return Err(invalid(
            "compaction fallback original Step identity differs",
        ));
    }
    let registered:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_request_specs r JOIN contents b ON b.id=r.content_id WHERE r.run=? AND r.step=? AND b.content_sha256=? AND length(b.payload)=?)",params![scope.run.to_string(),step.to_string(),reference.digest,i64::try_from(reference.bytes).map_err(|_|invalid("invalid frozen request length"))?],|r|r.get(0))?;
    if !registered {
        return Err(invalid(
            "compaction fallback immutable request projection differs",
        ));
    }
    let bytes = sql::owned_content(c, scope.run, &reference)?;
    if content_digest(&bytes) != reference.digest {
        return Err(invalid("compaction fallback frozen request hash differs"));
    }
    let request: RequestSpec = serde_json::from_slice(&bytes)?;
    if request.schema_version != SCHEMA_VERSION || request.step != step {
        return Err(invalid(
            "compaction fallback frozen request schema/Step differs",
        ));
    }
    Ok(PreparedStep {
        sequence,
        reference,
        request,
    })
}
fn check_projection(c: &Connection, scope: &Scope, step: &PreparedStep) -> Result<(), StoreError> {
    let body: Option<String> = c
        .query_row(
            "SELECT body FROM agent_steps WHERE run=? AND key=?",
            params![scope.run.to_string(), step.request.step.to_string()],
            |r| r.get(0),
        )
        .optional()?;
    let reference: ContentRef = serde_json::from_str(
        &body.ok_or_else(|| invalid("compaction fallback Step projection is missing"))?,
    )?;
    if reference != step.reference {
        return Err(invalid(
            "compaction fallback Step projection names another frozen request",
        ));
    }
    Ok(())
}
fn current_prepared(
    c: &Connection,
    scope: &Scope,
    step: StepId,
) -> Result<PreparedStep, StoreError> {
    let current = prepared(c, scope, step)?;
    let latest:Option<(i64,String)>=c.query_row("SELECT sequence,step FROM agent_session_history INDEXED BY agent_session_history_prepared WHERE run=? AND kind='step_prepared' AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![scope.run.to_string(),scope.sequence],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if latest != Some((current.sequence, step.to_string())) {
        return Err(invalid(
            "compaction fallback source is not the current canonical Summary Step",
        ));
    }
    Ok(current)
}
fn current_summary(
    c: &Connection,
    scope: &Scope,
    step: StepId,
) -> Result<PreparedStep, StoreError> {
    let current = current_prepared(c, scope, step)?;
    if current.request.accounting.purpose != ModelPurpose::Summary {
        return Err(invalid(
            "compaction source is not an original Summary request",
        ));
    }
    Ok(current)
}
fn candidate(
    c: &Connection,
    scope: &Scope,
    current: &PreparedStep,
) -> Result<Option<PreparedStep>, StoreError> {
    let Some(main) = summary_predecessor(c, scope, current)? else {
        return Ok(None);
    };
    let attempted:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_attempt_ids INDEXED BY agent_attempt_ids_step WHERE run=? AND step=?)",params![scope.run.to_string(),main.request.step.to_string()],|r|r.get(0))?;
    Ok((!attempted).then_some(main))
}
fn summary_predecessor(
    c: &Connection,
    scope: &Scope,
    current: &PreparedStep,
) -> Result<Option<PreparedStep>, StoreError> {
    let first = if let Some(attempt) = current.request.summary_repair_of {
        let step: Option<String> = c
            .query_row(
                "SELECT step FROM agent_attempt_ids WHERE attempt=? AND run=?",
                params![attempt.to_string(), scope.run.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        let step: StepId = serde_json::from_value(serde_json::Value::String(
            step.ok_or_else(|| invalid("summary repair has no same-Run original attempt"))?,
        ))?;
        let first = prepared(c, scope, step)?;
        if first.sequence >= current.sequence
            || first.request.accounting.purpose != ModelPurpose::Summary
            || first.request.summary_repair_of.is_some()
        {
            return Err(invalid(
                "summary repair does not name its first original Summary",
            ));
        }
        first
    } else {
        return previous_main(c, scope, current.sequence);
    };
    previous_main(c, scope, first.sequence)
}
fn previous_main(
    c: &Connection,
    scope: &Scope,
    before: i64,
) -> Result<Option<PreparedStep>, StoreError> {
    let previous:Option<(i64,String)>=c.query_row("SELECT sequence,step FROM agent_session_history INDEXED BY agent_session_history_prepared WHERE run=? AND kind='step_prepared' AND sequence<? ORDER BY sequence DESC LIMIT 1",params![scope.run.to_string(),before],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((sequence, step)) = previous else {
        return Ok(None);
    };
    let step: StepId = serde_json::from_value(serde_json::Value::String(step))?;
    let previous = prepared(c, scope, step)?;
    if previous.sequence != sequence {
        return Err(invalid(
            "compaction fallback predecessor is not its original StepPrepared",
        ));
    }
    if previous.request.accounting.purpose != ModelPurpose::Main {
        return Ok(None);
    }
    Ok(Some(previous))
}
fn compacted(
    c: &Connection,
    scope: &Scope,
    view: &RunView,
    summary: StepId,
) -> Result<bool, StoreError> {
    let Some(baseline) = &view.baseline else {
        return Ok(false);
    };
    let id:Option<String>=c.query_row("SELECT fact_id FROM agent_session_history INDEXED BY agent_session_history_run WHERE owner=? AND session=? AND run=? AND step IS NULL AND kind='context_compacted' AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![scope.owner,scope.session,scope.run.to_string(),scope.sequence],|r|r.get(0)).optional()?;
    let id: FactId =
        serde_json::from_value(serde_json::Value::String(id.ok_or_else(|| {
            invalid("compaction baseline has no actual canonical checkpoint")
        })?))?;
    let original = sql::fact(c, scope.run, id)?
        .ok_or_else(|| invalid("compaction checkpoint source disappeared"))?;
    if original.revision > scope.revision
        || !matches!(&original.fact,Fact::ContextCompacted{baseline:actual} if actual==baseline)
    {
        return Err(invalid(
            "compaction baseline differs from its canonical checkpoint",
        ));
    }
    let bytes = sql::owned_content(c, scope.run, baseline)?;
    if content_digest(&bytes) != baseline.digest {
        return Err(invalid("compaction baseline hash differs"));
    }
    let material: CompactedContext = serde_json::from_slice(&bytes)?;
    material.validate().map_err(invalid)?;
    Ok(material.checkpoint.summary_step_id == summary)
}

pub(crate) fn validate_resume(
    c: &Connection,
    view: &RunView,
    incoming: &RequestSpec,
) -> Result<Option<StepId>, StoreError> {
    let summary = view
        .current_attempt
        .and_then(|id| view.attempts.get(&id))
        .ok_or_else(|| invalid("Main continuation has no original Summary attempt"))?;
    if view.current_step != Some(summary.step) {
        return Err(invalid(
            "Main continuation does not follow its current Summary",
        ));
    }
    let closed = summary
        .closed
        .as_ref()
        .ok_or_else(|| invalid("Main continuation has no known original Summary closure"))?;
    match closed.outcome {
        Outcome::Success => {
            let protocol: ModelClosureProtocol = serde_json::from_value(closed.protocol.clone())?;
            if matches!(
                &protocol.summary,
                Some(SummaryResult::ProviderEffectsUnknown { .. })
            ) {
                return Err(invalid(
                    "unknown Summary provider effects cannot continue Main work",
                ));
            }
        }
        Outcome::Error => {
            known_summary_failure(&closed.protocol, summary.semantic, summary.has_tools)?
        }
        Outcome::Unknown | Outcome::Aborted => {
            return Err(invalid(
                "unknown or aborted Summary cannot continue Main work",
            ));
        }
    }
    let scope = scope(
        c,
        view.run,
        serde_json::to_string(&view.spec.owner)?,
        view.spec.session_id.clone(),
        view.revision,
    )?;
    let current = current_summary(c, &scope, summary.step)?;
    let source = current.request.compaction_recovery.or(view.current_attempt);
    if incoming.accounting.purpose != ModelPurpose::Main
        || incoming.compaction_recovery != source
        || incoming.summary_repair_of.is_some()
    {
        return Err(invalid(
            "Main continuation changed its original Summary recovery lineage",
        ));
    }
    if compacted(c, &scope, view, summary.step)? {
        return Ok(None);
    }
    if current.request.compaction_recovery.is_some() {
        return Err(invalid(
            "failed overflow Summary cannot start another Main fallback",
        ));
    }
    let original = candidate(c, &scope, &current)?
        .ok_or_else(|| invalid("Summary has no original unattempted Main continuation"))?;
    if original.request.compaction_recovery.is_some()
        && progress_in_snapshot(c, view, original.request.step)?.is_none()
    {
        return Err(invalid(
            "Summary continuation cannot replace an old compaction budget without its original rearm progress",
        ));
    }
    if valid_summary(c, view.run, &current.request, summary)? {
        let provenance = context(c, view.run, &original.request.provenance)?;
        if provenance
            .model_context
            .as_ref()
            .and_then(|context| context.declared_window)
            .is_some_and(|window| provenance.estimated_input_tokens >= window)
        {
            return Err(invalid(
                "successful Summary at its frozen adoption threshold must be adopted before Main continuation",
            ));
        }
    }
    let fallback = original.request.step;
    let mut expected = original.request;
    expected.step = incoming.step;
    expected.compaction_recovery = source;
    expected.adjudications.clear();
    if &expected != incoming {
        return Err(invalid(
            "failed Summary fallback must preserve its original complete frozen Main request",
        ));
    }
    Ok(Some(fallback))
}

fn context(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<RequestContextEvidence, StoreError> {
    let bytes = sql::owned_content(c, run, reference)?;
    if content_digest(&bytes) != reference.digest {
        return Err(invalid("original compaction provenance hash differs"));
    }
    let context: RequestContextEvidence = serde_json::from_slice(&bytes)?;
    context.breakdown.validate().map_err(invalid)?;
    if let Some(model) = &context.model_context {
        model.validate().map_err(invalid)?;
    }
    Ok(context)
}
fn valid_summary(
    c: &Connection,
    run: RunId,
    request: &RequestSpec,
    attempt: &Attempt,
) -> Result<bool, StoreError> {
    let Some(closed) = &attempt.closed else {
        return Ok(false);
    };
    if attempt.admission.is_none()
        || attempt.has_tools
        || closed.outcome != Outcome::Success
        || closed.diagnostic.is_some()
    {
        return Ok(false);
    }
    let protocol: ModelClosureProtocol = serde_json::from_value(closed.protocol.clone())?;
    if protocol.finish_reason != ModelFinishReason::Stop
        || matches!(
            &protocol.summary,
            Some(
                SummaryResult::ProviderEffectsUnknown { .. }
                    | SummaryResult::RejectedToolContent
                    | SummaryResult::Incomplete
            )
        )
    {
        return Ok(false);
    }
    if protocol.compaction.is_none()
        && !matches!(&protocol.summary,Some(SummaryResult::Text{summary}) if !summary.text.trim().is_empty())
    {
        return Ok(false);
    }
    let provenance = context(c, run, &request.provenance)?;
    if provenance
        .model_context
        .as_ref()
        .is_some_and(|model| model.operation == ModelOperation::CodexCompaction)
    {
        return Ok(protocol.compaction.is_some()
            && provenance
                .model_context
                .as_ref()
                .and_then(|model| model.codex.as_ref())
                .is_some()
            && closed.usage.output_tokens.is_some());
    }
    Ok(protocol.compaction.is_none()
        && matches!(&protocol.summary,Some(SummaryResult::Text{summary}) if !summary.text.trim().is_empty()))
}

pub(crate) fn deferred_summary(
    c: &Connection,
    view: &RunView,
    summary_step: StepId,
    at: UnixMillis,
) -> Result<(RequestSpec, Attempt), StoreError> {
    if view.stopped
        || view.terminal.is_some()
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
            "deferred compaction cannot advance a stopped, closed or exhausted Run",
        ));
    }
    let scope = scope(
        c,
        view.run,
        serde_json::to_string(&view.spec.owner)?,
        view.spec.session_id.clone(),
        view.revision,
    )?;
    let current = current_prepared(
        c,
        &scope,
        view.current_step
            .ok_or_else(|| invalid("deferred compaction has no current Main request"))?,
    )?;
    if current.request.accounting.purpose != ModelPurpose::Main
        || current.request.summary_repair_of.is_some()
    {
        return Err(invalid(
            "deferred compaction is not continuing its actual Main request",
        ));
    }
    let marker = current
        .request
        .compaction_recovery
        .ok_or_else(|| invalid("deferred compaction has no original Summary marker"))?;
    let original_step: String = c.query_row(
        "SELECT step FROM agent_attempt_ids WHERE attempt=? AND run=?",
        params![marker.to_string(), view.run.to_string()],
        |r| r.get(0),
    )?;
    let original_step: StepId = serde_json::from_value(serde_json::Value::String(original_step))?;
    if original_step != summary_step {
        return Err(invalid(
            "deferred compaction marker names another original Summary",
        ));
    }
    let summary = prepared(c, &scope, summary_step)?;
    if summary.sequence >= current.sequence
        || summary.request.accounting.purpose != ModelPurpose::Summary
        || summary.request.compaction_recovery.is_some()
    {
        return Err(invalid(
            "deferred compaction marker is not its prior proactive Summary",
        ));
    }
    if compacted(c, &scope, view, summary_step)? {
        return Err(invalid("deferred Summary was already adopted"));
    }
    let attempt = if let Some(attempt) = view.attempts.get(&marker) {
        attempt.clone()
    } else {
        let body: String = c.query_row(
            "SELECT body FROM agent_attempts WHERE run=? AND key=?",
            params![view.run.to_string(), marker.to_string()],
            |r| r.get(0),
        )?;
        serde_json::from_str(&body)?
    };
    if attempt.step != summary_step || !valid_summary(c, view.run, &summary.request, &attempt)? {
        return Err(invalid(
            "deferred compaction requires its actual known successful private Summary",
        ));
    }
    let admitted: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_session_history h INDEXED BY agent_session_history_run JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id AND f.run=h.run WHERE h.owner=? AND h.session=? AND h.run=? AND h.step=? AND h.kind='model_attempt_admitted' AND h.attempt=? AND h.sequence>? AND h.sequence<? AND f.schema_version=?)",params![scope.owner,scope.session,view.run.to_string(),summary_step.to_string(),marker.to_string(),summary.sequence,current.sequence,SCHEMA_VERSION],|r|r.get(0))?;
    if !admitted {
        return Err(invalid(
            "deferred Summary has no actual original model admission",
        ));
    }
    let (id,schema,revision):(String,u32,i64)=c.query_row("SELECT f.id,f.schema_version,f.revision FROM agent_session_history h INDEXED BY agent_session_history_run JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id AND f.run=h.run WHERE h.owner=? AND h.session=? AND h.run=? AND h.step=? AND h.kind='model_closed' AND h.attempt=? AND h.sequence<? ORDER BY h.sequence DESC LIMIT 1",params![scope.owner,scope.session,view.run.to_string(),summary_step.to_string(),marker.to_string(),current.sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if schema != SCHEMA_VERSION || revision <= 0 || revision as u64 > scope.revision {
        return Err(invalid(
            "deferred Summary closure is outside its actual original prefix",
        ));
    }
    let id: FactId = serde_json::from_value(serde_json::Value::String(id))?;
    let original = sql::fact(c, view.run, id)?
        .ok_or_else(|| invalid("deferred Summary original closure disappeared"))?;
    let Fact::ModelClosed {
        attempt: actual,
        outcome,
        diagnostic,
        usage,
        protocol,
    } = original.fact
    else {
        return Err(invalid(
            "deferred Summary source does not identify its original closure",
        ));
    };
    let closed = attempt
        .closed
        .as_ref()
        .ok_or_else(|| invalid("deferred Summary closure is missing"))?;
    if actual != marker
        || original.revision != revision as u64
        || closed.outcome != outcome
        || closed.diagnostic != diagnostic
        || closed.usage != usage
        || closed.protocol != protocol
    {
        return Err(invalid(
            "deferred Summary projection differs from its canonical original closure",
        ));
    }
    let attempted: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_session_history INDEXED BY agent_session_history_run WHERE owner=? AND session=? AND run=? AND step=? AND kind='model_attempt_prepared' AND sequence<=?)",params![scope.owner,scope.session,view.run.to_string(),current.request.step.to_string(),scope.sequence],|r|r.get(0))?;
    if attempted {
        let main = view
            .current_attempt
            .and_then(|id| view.attempts.get(&id))
            .ok_or_else(|| invalid("deferred compaction Main has no actual current attempt"))?;
        if main.step != current.request.step
            || main.admission.is_none()
            || main.interrupted.is_none()
            || main.semantic
            || main.has_tools
            || main
                .closed
                .as_ref()
                .is_some_and(|closed| closed.outcome == Outcome::Unknown)
            || !matches!(
                main.recovery,
                Some(AttemptRecovery::ContextOverflow {
                    observed_output: false
                })
            )
        {
            return Err(invalid(
                "deferred compaction requires original recoverable no-output Main overflow",
            ));
        }
    } else {
        if view
            .current_attempt
            .and_then(|id| view.attempts.get(&id))
            .is_some_and(|attempt| attempt.step == current.request.step)
        {
            return Err(invalid(
                "unattempted deferred Main has an inconsistent current attempt",
            ));
        }
        let provenance = context(c, view.run, &current.request.provenance)?;
        if !provenance
            .model_context
            .as_ref()
            .and_then(|model| model.declared_window)
            .is_some_and(|window| provenance.estimated_input_tokens >= window)
        {
            return Err(invalid(
                "deferred compaction has not reached its original frozen adoption threshold",
            ));
        }
    }
    Ok((summary.request, attempt))
}

pub(super) async fn compaction_progress(
    data: &DataWriter,
    run: RunId,
    main: StepId,
) -> Result<Option<FactId>, StoreError> {
    data.query_barrier(ReadProgress(run, main)).await
}
struct ReadProgress(RunId, StepId);
impl Query for ReadProgress {
    type Output = Option<FactId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let view = sql::load(c, self.0, &[], false)?;
        let tail: (i64, u32) = c.query_row("SELECT revision,schema_version FROM agent_facts INDEXED BY agent_facts_diagnostics_tail WHERE run=? ORDER BY revision DESC LIMIT 1",[self.0.to_string()],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if tail.0 <= 0 || tail.0 as u64 != view.revision || tail.1 != SCHEMA_VERSION {
            return Err(invalid(
                "compaction progress projection is not at its actual canonical head",
            ));
        }
        progress_in_snapshot(c, &view, self.1)
    }
}
fn source(
    c: &Connection,
    view: &RunView,
    request: &RequestSpec,
) -> Result<maka_agent_facts::history_snapshot::RequestSource, StoreError> {
    let bytes = sql::owned_content(c, view.run, &request.source_capture)?;
    if content_digest(&bytes) != request.source_capture.digest {
        return Err(invalid("compaction progress original source hash differs"));
    }
    let source: maka_agent_facts::history_snapshot::RequestSource = serde_json::from_slice(&bytes)?;
    crate::session_history::validate_cut(c, &view.spec.owner, &view.spec.session_id, &source.cut)?;
    crate::session_history::validate_cut(
        c,
        &view.spec.owner,
        &view.spec.session_id,
        &source.current,
    )?;
    if source.cut.through_sequence > source.current.through_sequence {
        return Err(invalid(
            "compaction progress source has an invalid canonical prefix",
        ));
    }
    Ok(source)
}
fn indexed_fact(
    c: &Connection,
    scope: &Scope,
    sequence: i64,
    id: &str,
) -> Result<RecordedFact, StoreError> {
    let (actual, schema, revision): (String, u32, i64) = c.query_row(
        "SELECT id,schema_version,revision FROM agent_facts WHERE run=? AND sequence=?",
        params![scope.run.to_string(), sequence],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if actual != id || schema != SCHEMA_VERSION || revision <= 0 || revision as u64 > scope.revision
    {
        return Err(invalid(
            "compaction progress fact membership differs from its original prefix",
        ));
    }
    let id: FactId = serde_json::from_value(serde_json::Value::String(actual))?;
    let recorded = sql::fact(c, scope.run, id)?
        .ok_or_else(|| invalid("compaction progress original fact disappeared"))?;
    if recorded.revision != revision as u64 {
        return Err(invalid(
            "compaction progress original fact revision differs",
        ));
    }
    Ok(recorded)
}
pub(crate) fn progress_in_snapshot(
    c: &Connection,
    view: &RunView,
    main: StepId,
) -> Result<Option<FactId>, StoreError> {
    if view.stopped
        || view.terminal.is_some()
        || !matches!(&view.spec.origin, RunOrigin::Local)
        || view
            .spec
            .budget
            .tokens
            .is_some_and(|limit| view.tokens >= limit)
        || view.tools.values().any(crate::fold::tool_pending)
        || view
            .blockers
            .values()
            .any(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none())
        || view.attempts.values().any(|attempt| {
            attempt
                .closed
                .as_ref()
                .is_some_and(|closed| closed.outcome == Outcome::Unknown)
                || (attempt.closed.is_none() && attempt.interrupted.is_none())
        })
    {
        return Ok(None);
    }
    let scope = scope(
        c,
        view.run,
        serde_json::to_string(&view.spec.owner)?,
        view.spec.session_id.clone(),
        view.revision,
    )?;
    let current = prepared(c, &scope, main)?;
    if current.request.accounting.purpose != ModelPurpose::Main {
        return Err(invalid(
            "compaction progress is not rooted in its original Main request",
        ));
    }
    if view.current_step != Some(main) {
        let summary = current_summary(
            c,
            &scope,
            view.current_step
                .ok_or_else(|| invalid("compaction progress has no current canonical Step"))?,
        )?;
        if let Some(attempt) = view.current_attempt.and_then(|id| view.attempts.get(&id))
            && let Some(closed) = &attempt.closed
        {
            match closed.outcome {
                Outcome::Success => {
                    let protocol: ModelClosureProtocol =
                        serde_json::from_value(closed.protocol.clone())?;
                    if matches!(
                        &protocol.summary,
                        Some(SummaryResult::ProviderEffectsUnknown { .. })
                    ) {
                        return Err(invalid(
                            "unknown current Summary provider effects cannot prove rearm progress",
                        ));
                    }
                }
                Outcome::Error => {
                    known_summary_failure(&closed.protocol, attempt.semantic, attempt.has_tools)?
                }
                Outcome::Unknown | Outcome::Aborted => {
                    return Err(invalid(
                        "unknown or aborted current Summary cannot prove rearm progress",
                    ));
                }
            }
        }
        if summary.request.compaction_recovery.is_some()
            || summary_predecessor(c, &scope, &summary)?
                .as_ref()
                .map(|step| step.request.step)
                != Some(main)
        {
            return Err(invalid(
                "compaction progress does not name the exact preceding rearmed Main",
            ));
        }
    } else {
        current_prepared(c, &scope, main)?;
    }
    let Some(marker) = current.request.compaction_recovery else {
        return Ok(None);
    };
    let old_step: String = c.query_row(
        "SELECT step FROM agent_attempt_ids WHERE attempt=? AND run=?",
        params![marker.to_string(), view.run.to_string()],
        |r| r.get(0),
    )?;
    let old_step: StepId = serde_json::from_value(serde_json::Value::String(old_step))?;
    let budget = prepared(c, &scope, old_step)?;
    if budget.sequence >= current.sequence {
        return Err(invalid(
            "compaction budget marker is not from its actual prior request",
        ));
    }
    let anchor = match budget.request.accounting.purpose {
        ModelPurpose::Summary => {
            let closure: Option<(i64,String)> = c.query_row("SELECT sequence,fact_id FROM agent_session_history INDEXED BY agent_session_history_run WHERE owner=? AND session=? AND run=? AND step=? AND kind='model_closed' AND attempt=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![scope.owner,scope.session,scope.run.to_string(),old_step.to_string(),marker.to_string(),scope.sequence],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let Some((sequence, id)) = closure else {
                return Ok(None);
            };
            let recorded = indexed_fact(c, &scope, sequence, &id)?;
            let Fact::ModelClosed {
                attempt,
                outcome,
                diagnostic,
                protocol,
                ..
            } = recorded.fact
            else {
                return Err(invalid(
                    "compaction budget marker has another original closure kind",
                ));
            };
            if attempt != marker {
                return Err(invalid("compaction budget closure names another attempt"));
            }
            let good = match outcome {
                Outcome::Success => {
                    let protocol: ModelClosureProtocol = serde_json::from_value(protocol)?;
                    if matches!(
                        &protocol.summary,
                        Some(SummaryResult::ProviderEffectsUnknown { .. })
                    ) {
                        return Err(invalid(
                            "unknown Summary provider effects cannot rearm compaction",
                        ));
                    }
                    let provenance = context(c, view.run, &budget.request.provenance)?;
                    let native = provenance
                        .model_context
                        .as_ref()
                        .is_some_and(|model| model.operation == ModelOperation::CodexCompaction);
                    diagnostic.is_none()
                        && protocol.finish_reason == ModelFinishReason::Stop
                        && if native {
                            protocol.compaction.is_some()
                        } else {
                            protocol.compaction.is_none()
                                && matches!(&protocol.summary,Some(SummaryResult::Text{summary}) if !summary.text.trim().is_empty())
                        }
                }
                Outcome::Error => {
                    let (step, semantic, tools) = if let Some(attempt) = view.attempts.get(&marker)
                    {
                        (attempt.step, attempt.semantic, attempt.has_tools)
                    } else {
                        let (step,semantic,tools):(String,bool,bool)=c.query_row("SELECT json_extract(body,'$.step'),json_extract(body,'$.semantic'),json_extract(body,'$.hasTools') FROM agent_attempts WHERE run=? AND key=?",params![view.run.to_string(),marker.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
                        (
                            serde_json::from_value(serde_json::Value::String(step))?,
                            semantic,
                            tools,
                        )
                    };
                    if step != old_step {
                        return Err(invalid(
                            "failed Summary projection belongs to another original Step",
                        ));
                    }
                    known_summary_failure(&protocol, semantic, tools)?;
                    false
                }
                Outcome::Unknown | Outcome::Aborted => {
                    return Err(invalid(
                        "unknown or aborted Summary cannot rearm compaction",
                    ));
                }
            };
            if good && !compacted(c, &scope, view, old_step)? {
                return Ok(None);
            }
            summary_predecessor(c, &scope, &budget)?
                .ok_or_else(|| invalid("compaction budget has no original Frozen Main"))?
        }
        ModelPurpose::Main => {
            let row: Option<(i64,String)> = c.query_row("SELECT sequence,fact_id FROM agent_session_history INDEXED BY agent_session_history_run WHERE owner=? AND session=? AND run=? AND step=? AND kind='attempt_recovery_recorded' AND attempt=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![scope.owner,scope.session,scope.run.to_string(),old_step.to_string(),marker.to_string(),scope.sequence],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let Some((sequence, id)) = row else {
                return Ok(None);
            };
            let recovery = indexed_fact(c, &scope, sequence, &id)?;
            if !matches!(recovery.fact,Fact::AttemptRecoveryRecorded{attempt,recovery:AttemptRecovery::ContextOverflow{observed_output:false}} if attempt==marker)
            {
                return Ok(None);
            }
            let closure:Option<(String,u32,i64,Option<String>)>=c.query_row("SELECT f.id,f.schema_version,f.revision,r.outcome FROM agent_session_history h INDEXED BY agent_session_history_run JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id AND f.run=h.run LEFT JOIN agent_usage_results r ON r.request='model:'||h.run||':'||h.attempt AND r.sequence=h.sequence WHERE h.owner=? AND h.session=? AND h.run=? AND h.step=? AND h.kind='model_closed' AND h.attempt=? AND h.sequence<=? ORDER BY h.sequence DESC LIMIT 1",params![scope.owner,scope.session,scope.run.to_string(),old_step.to_string(),marker.to_string(),scope.sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            if let Some((id, schema, revision, outcome)) = closure {
                let _: FactId = serde_json::from_value(serde_json::Value::String(id))?;
                if schema != SCHEMA_VERSION || revision <= 0 || revision as u64 > scope.revision {
                    return Err(invalid(
                        "compaction budget model closure is outside its canonical prefix",
                    ));
                }
                let outcome: Outcome = serde_json::from_value(serde_json::Value::String(
                    outcome.ok_or_else(|| {
                        invalid("compaction budget model closure accounting metadata is missing")
                    })?,
                ))?;
                if outcome == Outcome::Unknown {
                    return Ok(None);
                }
            }
            budget
        }
    };
    let prior = source(c, view, &anchor.request)?;
    let captured = source(c, view, &current.request)?;
    if prior.current.through_sequence > captured.current.through_sequence
        || captured.current.through_sequence >= current.sequence as u64
    {
        return Err(invalid(
            "compaction progress does not extend its original frozen source prefix",
        ));
    }
    let through = i64::try_from(captured.current.through_sequence)
        .map_err(|_| invalid("compaction progress source exceeds SQLite range"))?;
    let mut statement=c.prepare_cached("SELECT sequence,fact_id FROM agent_session_history INDEXED BY agent_session_history_kind WHERE owner=? AND session=? AND kind='tool_result_accepted' AND run=? AND sequence>? AND sequence<=? ORDER BY sequence")?;
    let mut rows = statement.query(params![
        scope.owner,
        scope.session,
        scope.run.to_string(),
        anchor.sequence,
        through
    ])?;
    while let Some(row) = rows.next()? {
        let recorded = indexed_fact(c, &scope, row.get(0)?, &row.get::<_, String>(1)?)?;
        match recorded.fact {
            Fact::ToolResultAccepted {
                outcome:
                    AcceptedResult::Succeeded
                    | AcceptedResult::Failed
                    | AcceptedResult::CellRecovered { .. },
                ..
            } => return Ok(Some(recorded.id)),
            Fact::ToolResultAccepted { .. } => {}
            _ => {
                return Err(invalid(
                    "compaction progress result index identifies another original fact",
                ));
            }
        }
    }
    message_progress(c, &scope, &anchor, &current, through)
}
fn message_progress(
    c: &Connection,
    scope: &Scope,
    anchor: &PreparedStep,
    current: &PreparedStep,
    through: i64,
) -> Result<Option<FactId>, StoreError> {
    use crate::queue::{DeliveryTarget, Event, QueueEdit};
    let mut statement=c.prepare_cached("SELECT h.sequence,h.fact_id,h.step,q.revision,b.content_sha256,b.payload FROM agent_session_history h INDEXED BY agent_session_history_kind JOIN agent_queue_events q ON q.session=h.session AND q.id=h.fact_id JOIN contents b ON b.id=q.body_content_id WHERE h.owner=? AND h.session=? AND h.kind='step_prepared' AND h.run=? AND h.sequence>? AND (h.sequence<=? OR h.sequence=?) ORDER BY h.sequence")?;
    let mut rows = statement.query(params![
        scope.owner,
        scope.session,
        scope.run.to_string(),
        anchor.sequence,
        through,
        current.sequence
    ])?;
    while let Some(row) = rows.next()? {
        let recorded = indexed_fact(c, scope, row.get(0)?, &row.get::<_, String>(1)?)?;
        let Fact::StepPrepared { step, .. } = recorded.fact else {
            return Err(invalid(
                "compaction message progress has another original fact kind",
            ));
        };
        let indexed_step: StepId = serde_json::from_value(serde_json::Value::String(row.get(2)?))?;
        if indexed_step != step {
            return Err(invalid("compaction message progress Step identity differs"));
        }
        let revision: i64 = row.get(3)?;
        let hash: String = row.get(4)?;
        let bytes: Vec<u8> = row.get(5)?;
        if content_digest(&bytes) != hash {
            return Err(invalid("compaction message consumption hash differs"));
        }
        let Event::Consumed {
            cut,
            run,
            target: DeliveryTarget::Step { step: target },
        } = serde_json::from_slice(&bytes)?
        else {
            continue;
        };
        if run != scope.run
            || target != step
            || cut.session != scope.session
            || revision <= 0
            || cut.expected_revision.checked_add(1) != Some(revision as u64)
            || cut.requests.is_empty()
        {
            return Err(invalid("compaction message consumption scope differs"));
        }
        let delivered = prepared(c, scope, step)?;
        if delivered.request.steering.len() != cut.requests.len() {
            return Err(invalid(
                "compaction message consumption does not match its frozen steering prefix",
            ));
        }
        let mut semantic = false;
        for (position, id) in cut.requests.iter().enumerate() {
            let (event_id,actual_id,hash,body):(String,String,String,Vec<u8>)=c.query_row("SELECT i.event_id,e.id,b.content_sha256,b.payload FROM agent_history_queue_requests i JOIN agent_queue_events e ON e.session=i.session AND e.revision=i.revision JOIN contents b ON b.id=e.body_content_id WHERE i.session=? AND i.request=? AND i.revision<? ORDER BY i.revision DESC LIMIT 1",params![scope.session,id.0,revision],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            if event_id != actual_id || content_digest(&body) != hash {
                return Err(invalid(
                    "compaction message original queue request proof differs",
                ));
            }
            let Event::Command {
                edit: QueueEdit::Enqueue { request, .. } | QueueEdit::Update { request },
                ..
            } = serde_json::from_slice(&body)?
            else {
                return Err(invalid(
                    "compaction message source is not its original prepared queue request",
                ));
            };
            if request.id != *id
                || serde_json::to_string(&request.spec.owner)? != scope.owner
                || request.spec.session_id != scope.session
                || !matches!(&request.spec.origin, RunOrigin::Local)
                || delivered.request.steering.get(position) != Some(&request.source)
            {
                return Err(invalid(
                    "compaction message source differs from its exact consumed namespace/order",
                ));
            }
            if request.spec.schema_version != SCHEMA_VERSION {
                return Err(invalid(
                    "compaction message input has an unsupported original Run schema",
                ));
            }
            if !matches!(&request.spec.trigger,Trigger::Message{message_id} if message_id==&request.message_id)
                || anchor.request.steering.contains(&request.source)
            {
                continue;
            }
            request.spec.input.validate().map_err(invalid)?;
            let input: Vec<u8> = c.query_row(
                "SELECT b.payload FROM agent_queue_content_pins p JOIN contents b ON b.id=p.content_id WHERE p.session=? AND p.request=? AND b.content_sha256=? AND length(b.payload)=?",
                params![scope.session, id.0, request.spec.input.digest, i64::try_from(request.spec.input.bytes).map_err(|_|invalid("compaction message input length exceeds SQLite range"))?],
                |row| row.get(0),
            ).optional()?.ok_or_else(||invalid("compaction message input is not pinned by its original queue request"))?;
            if content_digest(&input) != request.spec.input.digest {
                return Err(invalid("compaction message original RunInput hash differs"));
            }
            let input: maka_agent_facts::input::RunInput = serde_json::from_slice(&input)?;
            if !matches!(input, maka_agent_facts::input::RunInput::Message { .. }) {
                continue;
            }
            let bytes = sql::owned_content(c, scope.run, &request.source)?;
            if content_digest(&bytes) != request.source.digest {
                return Err(invalid("compaction message original source hash differs"));
            }
            let source: maka_agent_facts::message::RootSourceMessage =
                serde_json::from_slice(&bytes)?;
            source.validate().map_err(invalid)?;
            if source.message.message_id != request.message_id {
                return Err(invalid(
                    "compaction message source has another original message identity",
                ));
            }
            if matches!(
                &source.message.origin,
                Some(
                    maka_agent_facts::message::MessageOrigin::Goal { .. }
                        | maka_agent_facts::message::MessageOrigin::BotWorker { .. }
                )
            ) {
                continue;
            }
            semantic = true;
        }
        if semantic {
            return Ok(Some(recorded.id));
        }
    }
    Ok(None)
}

pub(crate) fn rearm_in_snapshot(
    c: &Connection,
    view: &RunView,
    main: StepId,
) -> Result<bool, StoreError> {
    if view.current_step != Some(main) {
        return Ok(false);
    }
    let attempted:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_attempt_ids INDEXED BY agent_attempt_ids_step WHERE run=? AND step=?)",params![view.run.to_string(),main.to_string()],|r|r.get(0))?;
    if !attempted
        && view
            .current_attempt
            .and_then(|id| view.attempts.get(&id))
            .is_some_and(|attempt| attempt.step == main)
    {
        return Err(invalid(
            "unattempted compaction rearm Main has an inconsistent current attempt",
        ));
    }
    if attempted {
        let Some(attempt) = view.current_attempt.and_then(|id| view.attempts.get(&id)) else {
            return Ok(false);
        };
        if attempt.step != main
            || attempt.admission.is_none()
            || attempt.interrupted.is_none()
            || attempt.semantic
            || attempt.has_tools
            || attempt
                .closed
                .as_ref()
                .is_some_and(|closed| closed.outcome == Outcome::Unknown)
            || !matches!(
                attempt.recovery,
                Some(AttemptRecovery::ContextOverflow {
                    observed_output: false
                })
            )
        {
            return Ok(false);
        }
    }
    Ok(progress_in_snapshot(c, view, main)?.is_some())
}

fn known_summary_failure(
    protocol: &serde_json::Value,
    semantic: bool,
    tools: bool,
) -> Result<(), StoreError> {
    use maka_agent_facts::model::error::ModelError;
    if semantic || tools {
        return Err(invalid(
            "failed Summary with semantic or tool output cannot resume its original Main",
        ));
    }
    let protocol: maka_agent_facts::context::ModelFailureProtocol =
        serde_json::from_value(protocol.clone())?;
    let failure = protocol.failure;
    let safe = match failure {
        ModelError::ContextOverflow {
            observed_output: false,
        } => true,
        ModelError::Provider(failure) => !failure.retryable() && failure.replay_safe(),
        _ => false,
    };
    if !safe {
        return Err(invalid(
            "failed Summary does not prove a known terminal no-output provider failure",
        ));
    }
    Ok(())
}
