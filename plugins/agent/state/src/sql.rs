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

//! Agent-owned SQL. All mutations execute synchronously in the Root writer transaction.
#[path = "sql_compaction.rs"]
pub(crate) mod compaction;
#[path = "sql_model_evidence.rs"]
mod model_evidence;
use crate::{
    fold::{self, Approval, Attempt, Blocker, RunView, Tool, Wait},
    store::{Admission, Change, Commit, ContentBlob, Head, Mode, invalid},
};
use maka_agent_facts::{durable::*, model::ModelPart};
use maka_event_log::{StoreError, content};
pub(crate) use model_evidence::validate_envelope as validate_private_partial_envelope;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::collections::BTreeSet;

pub(crate) const HEADER_SCHEMA_VERSION: u32 = 2;

const AUTHORITY_BLOCKED: &str = "EXISTS(SELECT 1 FROM agent_blockers authority WHERE authority.run=r.run AND authority.pending=1
    AND json_extract(authority.body,'$.decision') IS NULL AND json_extract(authority.body,'$.resolvedBy') IS NULL
    AND json_extract(authority.body,'$.reason.kind')='current_authority_unavailable')";

// Correlated to the pending wait `w` in both ready and next_due.
const RECONCILABLE_WAIT: &str = "
    (json_extract(w.body,'$.reason.kind') IS 'approval' AND (
        EXISTS(SELECT 1 FROM agent_approvals a WHERE a.run=w.run AND a.key=json_extract(w.body,'$.reason.approval'))
        OR EXISTS(SELECT 1 FROM agent_tools t WHERE t.run=w.run AND t.pending=1 AND json_extract(t.body,'$.approvalRefusal.approval')=json_extract(w.body,'$.reason.approval'))))
    OR (w.due_at IS NULL AND json_extract(w.body,'$.reason.kind') IS 'model' AND EXISTS(
        SELECT 1 FROM agent_attempts a WHERE a.run=w.run AND a.key=json_extract(w.body,'$.reason.attempt')
        AND json_extract(a.body,'$.admission') IS NOT NULL
        AND json_extract(a.body,'$.cleanup.kind') IS 'confirmed'))
    OR (w.due_at IS NULL AND json_extract(w.body,'$.reason.kind') IS 'cell' AND EXISTS(
        SELECT 1 FROM agent_cells c WHERE c.cell=json_extract(w.body,'$.reason.cell') AND c.run=w.run
        AND json_extract(c.body,'$.status.kind') IN ('completed','interrupted')
        AND json_extract(c.body,'$.vmUncertainty') IS NULL
        AND NOT EXISTS(SELECT 1 FROM json_each(c.body,'$.children') child WHERE NOT (
            json_extract(child.value,'$.rejected') IS NOT NULL
            OR (json_extract(child.value,'$.localResult') IS NOT NULL AND json_extract(child.value,'$.localResult.settlement') IS NOT 'unknown')
            OR (json_extract(child.value,'$.reply.receipt.kind') IS 'recorded' AND json_extract(child.value,'$.reply.receipt.cleanup.kind') IS 'confirmed')))))
    OR (w.due_at IS NULL AND json_extract(w.body,'$.reason.kind') IS 'operation' AND EXISTS(
        SELECT 1 FROM agent_tools t WHERE t.run=w.run
        AND t.key=json_extract(w.body,'$.reason.tool.attempt')||':'||json_extract(w.body,'$.reason.tool.call')
        AND json_extract(t.body,'$.original') IS NOT NULL
        AND json_extract(t.body,'$.receipt.kind') IS 'recorded'
        AND (json_extract(t.body,'$.receipt.outcome.kind') IN ('returned','not_executed')
            OR (json_extract(t.body,'$.receipt.outcome.kind') IS 'unknown'
                AND json_extract(t.body,'$.accepted.outcome.kind') IS 'risk_adjudicated'
                AND EXISTS(SELECT 1 FROM agent_blockers b WHERE b.run=t.run
                    AND b.key=json_extract(t.body,'$.accepted.outcome.blocker')
                    AND json_extract(b.body,'$.decision') IS NOT NULL
                    AND json_extract(b.body,'$.decision.scope.kind') IN ('tool','model_replan'))))
        AND json_extract(t.body,'$.receipt.cleanup.kind') IS 'confirmed'))";

fn signed(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("Agent integer exceeds SQLite range"))
}
fn column_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
fn now() -> Result<UnixMillis, StoreError> {
    let value = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| invalid("clock precedes epoch"))?
        .as_millis();
    Ok(UnixMillis(
        i64::try_from(value).map_err(|_| invalid("clock exceeds supported range"))?,
    ))
}

fn version(version: u32) -> Result<(), StoreError> {
    if version != SCHEMA_VERSION {
        return Err(invalid(format!(
            "unsupported Agent schema version: {version}"
        )));
    }
    Ok(())
}
pub(crate) fn identity<T: DeserializeOwned>(value: String) -> Result<T, StoreError> {
    Ok(serde_json::from_value(serde_json::Value::String(value))?)
}
fn limit(limit: u32) -> Result<u32, StoreError> {
    if !(1..=1024).contains(&limit) {
        return Err(invalid("page size must be in 1..=1024"));
    }
    Ok(limit)
}
fn put(c: &Connection, blob: &ContentBlob) -> Result<i64, StoreError> {
    blob.store(c)
}
fn content_id(c: &Connection, reference: &ContentRef) -> Result<i64, StoreError> {
    reference.validate().map_err(invalid)?;
    c.prepare_cached("SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?")?
        .query_row(params![reference.digest, signed(reference.bytes)?], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| invalid("missing canonical content"))
}
fn pin(c: &Connection, run: RunId, reference: &ContentRef) -> Result<(), StoreError> {
    c.prepare_cached(
        "INSERT INTO agent_content_pins(run,content_id) VALUES(?,?) ON CONFLICT DO NOTHING",
    )?
    .execute(params![run.to_string(), content_id(c, reference)?])?;
    Ok(())
}
fn insert_blobs(c: &Connection, blobs: Vec<ContentBlob>) -> Result<(), StoreError> {
    for blob in blobs {
        put(c, &blob)?;
    }
    Ok(())
}
pub(super) fn decode<T: DeserializeOwned>(
    c: &Connection,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    content_id(c, reference)?;
    let bytes =
        content::read(c, &reference.digest)?.ok_or_else(|| invalid("missing canonical bytes"))?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub(crate) fn owned_content(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<Vec<u8>, StoreError> {
    with_owned_content(c, run, reference, |bytes| Ok(bytes.to_vec()))
}
pub(crate) fn verify_owned_content(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<(), StoreError> {
    reference.validate().map_err(invalid)?;
    let owns: bool = c
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM agent_run_content p JOIN contents c ON c.id=p.content_id WHERE p.run=? AND c.content_sha256=? AND length(c.payload)=?)")?
        .query_row(
            params![
                run.to_string(),
                reference.digest,
                signed(reference.bytes)?
            ],
            |r| r.get(0),
        )?;
    if !owns {
        return Err(invalid("content is not retained by this Run"));
    }
    Ok(())
}
pub(crate) fn with_owned_content<T>(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
    consume: impl FnOnce(&[u8]) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    reference.validate().map_err(invalid)?;
    let mut statement = c.prepare_cached("SELECT c.payload FROM agent_run_content p JOIN contents c ON c.id=p.content_id WHERE p.run=? AND c.content_sha256=? AND length(c.payload)=?")?;
    let mut rows = statement.query(params![
        run.to_string(),
        reference.digest,
        signed(reference.bytes)?
    ])?;
    let row = rows
        .next()?
        .ok_or_else(|| invalid("content is not retained by this Run"))?;
    let value = row.get_ref(0)?;
    let bytes = value.as_blob().map_err(|cause| {
        rusqlite::Error::FromSqlConversionFailure(0, value.data_type(), Box::new(cause))
    })?;
    consume(bytes)
}

fn spec(c: &Connection, run: RunId) -> Result<(RunSpec, ContentRef), StoreError> {
    let (v,digest,bytes):(u32,String,Vec<u8>)=c.prepare_cached("SELECT r.schema_version,c.content_sha256,c.payload FROM agent_run_specs r JOIN contents c ON c.id=r.spec_content_id WHERE r.run=?")?.query_row([run.to_string()],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||invalid("Run not found"))?;
    version(v)?;
    let value: RunSpec = serde_json::from_slice(&bytes)?;
    version(value.schema_version)?;
    Ok((
        value,
        ContentRef {
            digest,
            bytes: u64::try_from(bytes.len())
                .map_err(|_| invalid("canonical content length exceeds u64"))?,
        },
    ))
}
pub(crate) fn exists(c: &Connection, run: RunId) -> Result<bool, StoreError> {
    Ok(
        c.prepare_cached("SELECT 1 FROM agent_run_specs WHERE run=?")?
            .query_row([run.to_string()], |r| r.get::<_, i64>(0))
            .optional()?
            .is_some(),
    )
}

pub(crate) fn model_attempt(
    c: &Connection,
    run: RunId,
    attempt: ModelAttemptId,
) -> Result<Attempt, StoreError> {
    let body: String = c
        .prepare_cached("SELECT body FROM agent_attempts WHERE run=? AND key=?")?
        .query_row(params![run.to_string(), attempt.to_string()], |row| {
            row.get(0)
        })?;
    Ok(serde_json::from_str(&body)?)
}

fn projection_rows<T: DeserializeOwned>(
    c: &Connection,
    table: &str,
    run: RunId,
    keys: &BTreeSet<String>,
    all: bool,
) -> Result<Vec<(String, T)>, StoreError> {
    let query = if all {
        format!("SELECT key,body FROM {table} WHERE run=?1")
    } else {
        format!(
            "SELECT key,body FROM {table} WHERE run=?1 AND pending=1 UNION ALL SELECT key,body FROM {table} WHERE run=?1 AND key IN (SELECT value FROM json_each(?2)) AND pending=0"
        )
    };
    let mut statement = c.prepare_cached(&query)?;
    let keys = serde_json::to_string(keys)?;
    let mut rows = if all {
        statement.query(params![run.to_string()])?
    } else {
        statement.query(params![run.to_string(), keys])?
    };
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push((
            row.get(0)?,
            serde_json::from_str(&row.get::<_, String>(1)?)?,
        ));
    }
    Ok(result)
}
#[derive(Default)]
struct Targets {
    steps: BTreeSet<String>,
    attempts: BTreeSet<String>,
    tools: BTreeSet<String>,
    approvals: BTreeSet<String>,
    blockers: BTreeSet<String>,
    waits: BTreeSet<String>,
}
impl Targets {
    fn tool(&mut self, tool: &ToolKey) {
        self.tools.insert(fold::tool_key(tool));
        self.attempts.insert(tool.attempt.to_string());
    }
    fn blocker(&mut self, reason: &BlockerKind) {
        match reason {
            BlockerKind::ModelCleanupUnconfirmed { attempt, .. } => {
                self.attempts.insert(attempt.to_string());
            }
            BlockerKind::OperationUnknown { tool, .. }
            | BlockerKind::OriginalAdmissionUnknown { tool }
            | BlockerKind::ToolCleanupUnconfirmed { tool, .. }
            | BlockerKind::ResourcesUnavailable { tool } => self.tool(tool),
            BlockerKind::ProviderEffectUnknown { attempt, call } => self.tool(&ToolKey {
                attempt: *attempt,
                call: call.clone(),
            }),
            _ => {}
        }
    }
    fn risk_scope(&mut self, scope: &RiskActionScope) {
        match scope {
            RiskActionScope::Tool { tool } => self.tool(tool),
            RiskActionScope::ModelReplan { attempt, base_step } => {
                self.attempts.insert(attempt.to_string());
                self.steps.insert(base_step.to_string());
            }
            RiskActionScope::RunCancellation => {}
        }
    }
    fn fact(&mut self, fact: &Fact) {
        match fact {
            Fact::StepPrepared {
                step,
                adjudications,
                ..
            } => {
                self.steps.insert(step.to_string());
                self.blockers
                    .extend(adjudications.iter().map(ToString::to_string));
            }
            Fact::ModelAttemptPrepared { attempt, step }
            | Fact::ProactiveSummaryPrepared { attempt, step, .. } => {
                self.attempts.insert(attempt.to_string());
                self.steps.insert(step.to_string());
            }
            Fact::ModelSourceFailureCaptured { attempt, .. }
            | Fact::ModelTransportSelected { attempt, .. }
            | Fact::ModelPrivatePartialCaptured { attempt, .. }
            | Fact::ModelInterrupted { attempt, .. }
            | Fact::ModelAttemptAdmitted { attempt, .. }
            | Fact::ModelFirstTokenObserved { attempt }
            | Fact::ModelClosed { attempt, .. }
            | Fact::ModelCleanupObserved { attempt, .. }
            | Fact::AttemptRecoveryRecorded { attempt, .. }
            | Fact::RetryCharged { attempt, .. } => {
                self.attempts.insert(attempt.to_string());
            }
            Fact::ModelObserved { attempt, part, .. } => {
                self.attempts.insert(attempt.to_string());
                match part {
                    ModelPart::ToolCall { call } => self.tool(&ToolKey {
                        attempt: *attempt,
                        call: call.id.clone(),
                    }),
                    ModelPart::ToolResult { id, .. } => self.tool(&ToolKey {
                        attempt: *attempt,
                        call: id.clone(),
                    }),
                    _ => {}
                }
            }
            Fact::ToolDecided { tool, decision } => {
                self.tool(tool);
                if let ToolDecision::Approved {
                    approval: Some(approval),
                    ..
                } = decision
                {
                    self.approvals.insert(approval.to_string());
                }
            }
            Fact::ToolOriginalBound { tool, .. }
            | Fact::ToolAdmitted { tool }
            | Fact::ToolPreventedBeforeHostAdmission { tool, .. }
            | Fact::LocalToolReturned { tool, .. }
            | Fact::HostToolResultRecorded { tool, .. }
            | Fact::ToolsLoaded { tool, .. }
            | Fact::OperationObserved { tool, .. } => self.tool(tool),
            Fact::ToolResultAccepted { tool, outcome, .. } => {
                self.tool(tool);
                if let AcceptedResult::RiskAdjudicated { blocker } = outcome {
                    self.blockers.insert(blocker.to_string());
                }
            }
            Fact::ApprovalRecorded { approval, tool, .. }
            | Fact::ApprovalRefused { approval, tool, .. }
            | Fact::ApprovalConsumed { approval, tool } => {
                self.tool(tool);
                self.approvals.insert(approval.to_string());
            }
            Fact::Blocked { blocker, reason } => {
                self.blockers.insert(blocker.to_string());
                self.blocker(reason);
            }
            Fact::RiskAdjudicated { blocker, scope, .. } => {
                self.blockers.insert(blocker.to_string());
                self.risk_scope(scope);
            }
            Fact::BlockerResolved { blocker, .. } => {
                self.blockers.insert(blocker.to_string());
            }
            Fact::WaitRegistered { wait, reason, .. } => {
                self.waits.insert(wait.to_string());
                match reason {
                    WaitReason::Approval { approval } => {
                        self.approvals.insert(approval.to_string());
                    }
                    WaitReason::Retry { attempt }
                    | WaitReason::Model { attempt }
                    | WaitReason::ProviderBackoff { attempt } => {
                        self.attempts.insert(attempt.to_string());
                    }
                    WaitReason::Operation { tool } => self.tool(tool),
                    WaitReason::Blocker { blocker } => {
                        self.blockers.insert(blocker.to_string());
                    }
                    _ => {}
                }
            }
            Fact::WaitSatisfied { wait, .. } | Fact::WaitCancelled { wait, .. } => {
                self.waits.insert(wait.to_string());
            }
            _ => {}
        }
    }
}
/// Only open obligations and explicitly referenced settled entities enter the
/// mutation working set. Closed history is not scanned/copied on each callback.
pub(crate) fn load(
    c: &Connection,
    run: RunId,
    facts: &[&Fact],
    all: bool,
) -> Result<RunView, StoreError> {
    let (spec, spec_ref) = spec(c, run)?;
    let mut view = RunView::admitted(run, spec)?;
    view.spec_ref = Some(spec_ref);
    let raw=c.prepare_cached("SELECT schema_version,revision,control_version,stopped,terminal,tokens,retries,retry_due_at,retry_pending,current_step,current_attempt,cancelled_by_risk,replans,baseline,external,stop_request,stop_assessed FROM agent_runs WHERE run=?")?.query_row([run.to_string()],|r| Ok((r.get::<_,u32>(0)?,column_u64(r,1)?,column_u64(r,2)?,r.get::<_,bool>(3)?,r.get::<_,Option<String>>(4)?,column_u64(r,5)?,r.get::<_,u32>(6)?,r.get::<_,Option<i64>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,bool>(11)?,r.get::<_,String>(12)?,r.get::<_,Option<String>>(13)?,r.get::<_,Option<String>>(14)?,r.get::<_,Option<String>>(15)?,r.get::<_,Option<String>>(16)?))).optional()?.ok_or_else(||invalid("Run indexes are absent; explicit rebuild required"))?;
    if raw.0 != HEADER_SCHEMA_VERSION {
        return Err(invalid(
            "Run indexes have an old projection schema; rebuild required",
        ));
    }
    let (phase, finish, proactive_summary, output_limit_continuations, retry_streak): (
        String,
        bool,
        Option<String>,
        u32,
        String,
    ) = c.query_row(
        "SELECT retry_phase,finish_requested,proactive_summary,output_limit_continuations,retry_streak FROM agent_runs WHERE run=?",
        [run.to_string()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    view.retry_phase = identity(phase)?;
    view.finish_requested = finish;
    view.proactive_summary = proactive_summary.map(identity).transpose()?;
    view.output_limit_continuations = output_limit_continuations;
    view.retry_streak = serde_json::from_str(&retry_streak)?;
    view.revision = raw.1;
    view.control_version = raw.2;
    view.stopped = raw.3;
    view.terminal = raw.4.map(|v| serde_json::from_str(&v)).transpose()?;
    view.tokens = raw.5;
    view.retries = raw.6;
    view.retry_due_at = raw.7.map(UnixMillis);
    view.retry_pending = raw.8.map(identity).transpose()?;
    view.current_step = raw.9.map(identity).transpose()?;
    view.current_attempt = raw.10.map(identity).transpose()?;
    view.cancelled_by_risk = raw.11;
    view.replans = serde_json::from_str(&raw.12)?;
    view.baseline = raw.13.map(|body| serde_json::from_str(&body)).transpose()?;
    view.external = raw.14.map(|body| serde_json::from_str(&body)).transpose()?;
    view.stop_request = raw.15.map(identity).transpose()?;
    view.stop_assessed = raw.16.map(identity).transpose()?;
    if !all
        && !facts.is_empty()
        && facts.iter().all(|fact| {
            matches!(
                fact,
                Fact::ExternalTaskCleanupObserved { .. } | Fact::ExternalTaskCleanupDeferred { .. }
            )
        })
    {
        for (key, value) in
            projection_rows::<Blocker>(c, "agent_blockers", run, &BTreeSet::new(), false)?
        {
            view.blockers.insert(identity(key)?, value);
        }
        return Ok(view);
    }
    if let Some(task) = &mut view.external {
        task.effects = crate::external_effects::load_run(c, run, facts, all)?;
        task.publication = crate::external_publication::load_run(c, run, facts, all)?;
    }
    let mut targets = Targets::default();
    for fact in facts {
        targets.fact(fact);
    }
    // Late server calls need the actual decision/id, not just the sticky logical fence.
    if !all
        && view.cancelled_by_risk
        && facts.iter().any(|fact| {
            matches!(fact,
        Fact::ModelObserved { part: ModelPart::ToolCall { call }, .. } if call.provider_executed)
        })
    {
        let retired = c
            .prepare_cached(
                "SELECT key FROM agent_blockers WHERE run=? AND pending=0
            AND json_extract(body,'$.decision.scope.kind')='run_cancellation'",
            )?
            .query_map([run.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        targets.blockers.extend(retired);
    }
    if let Some(step) = view.current_step {
        targets.steps.insert(step.to_string());
    }
    for attempt in [
        view.current_attempt,
        view.retry_pending,
        view.proactive_summary,
    ]
    .into_iter()
    .flatten()
    {
        targets.attempts.insert(attempt.to_string());
    }
    let charged: Vec<String> = c.prepare_cached("SELECT attempt FROM agent_session_history INDEXED BY agent_session_history_kind WHERE owner=? AND session=? AND kind='retry_charged' AND run=? AND sequence>=(SELECT sequence FROM agent_facts WHERE run=? AND revision=1) AND sequence<=(SELECT sequence FROM agent_facts WHERE run=? AND revision=?) ORDER BY sequence")?.query_map(params![serde_json::to_string(&view.spec.owner)?,view.spec.session_id,run.to_string(),run.to_string(),run.to_string(),signed(view.revision)?],|r|r.get(0))?.collect::<Result<_,_>>()?;
    targets.attempts.extend(charged);
    for (id, replan) in &view.replans {
        targets.blockers.insert(id.to_string());
        targets.risk_scope(&replan.scope);
    }
    for (key, value) in
        projection_rows::<Blocker>(c, "agent_blockers", run, &targets.blockers, all)?
    {
        targets.blocker(&value.reason);
        view.blockers.insert(identity(key)?, value);
    }
    for (key, value) in projection_rows::<Wait>(c, "agent_waits", run, &targets.waits, all)? {
        view.waits.insert(identity(key)?, value);
    }
    for (key, value) in projection_rows::<Tool>(c, "agent_tools", run, &targets.tools, all)? {
        targets.attempts.insert(value.key.attempt.to_string());
        if let Some(ToolDecision::Approved {
            approval: Some(approval),
            ..
        }) = &value.decision
        {
            targets.approvals.insert(approval.to_string());
        }
        view.tools.insert(key, value);
    }
    for (key, value) in
        projection_rows::<Attempt>(c, "agent_attempts", run, &targets.attempts, all)?
    {
        targets.steps.insert(value.step.to_string());
        view.attempts.insert(identity(key)?, value);
    }
    if view
        .proactive_summary
        .is_some_and(|id| !view.attempts.contains_key(&id))
    {
        return Err(invalid("proactive Summary attempt projection is missing"));
    }
    let blocked_cells = view.recovery_failures().filter_map(|reason| match reason {
        BlockerKind::CodeCellRecoveryUnavailable { cell } => Some(cell.clone()),
        BlockerKind::OriginalAdmissionUnknown { tool } => view
            .tools
            .get(&fold::tool_key(tool))
            .and_then(|tool| view.original_cell_id(tool))
            .map(|cell| cell.to_string()),
        _ => None,
    });
    view.cells = crate::cells::load_run(c, run, facts, blocked_cells, all)?;
    if view
        .attempts
        .values()
        .filter(|attempt| attempt.retry.is_some())
        .count() as u64
        != u64::from(view.retries)
    {
        return Err(invalid("canonical retry charge projection is incomplete"));
    }
    for (key, value) in projection_rows::<ContentRef>(c, "agent_steps", run, &targets.steps, all)? {
        view.steps.insert(identity(key)?, value);
    }
    for (key, value) in
        projection_rows::<Approval>(c, "agent_approvals", run, &targets.approvals, all)?
    {
        view.approvals.insert(identity(key)?, value);
    }
    Ok(view)
}
fn upsert<T: Serialize>(
    c: &Connection,
    table: &str,
    run: RunId,
    key: impl ToString,
    pending: bool,
    value: &T,
) -> Result<(), StoreError> {
    c.prepare_cached(&format!("INSERT INTO {table}(run,key,pending,body) VALUES(?,?,?,?) ON CONFLICT(run,key) DO UPDATE SET pending=excluded.pending,body=excluded.body WHERE body<>excluded.body OR pending<>excluded.pending"))?.execute(params![run.to_string(),key.to_string(),pending,serde_json::to_string(value)?])?;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalHeader<'a> {
    task: ExternalTaskId,
    descriptor: &'a ContentRef,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    live_workspace: bool,
    admitted: bool,
    binding: &'a Option<ContentRef>,
    observed: u64,
    closed: &'a Option<fold::ExternalClosure>,
    cleanup: &'a maka_plugin_core::operation::OperationCleanup,
    cleanup_not_before: Option<UnixMillis>,
    steering: &'a Option<crate::external_steering::ExternalSteering>,
}
fn external_header(task: &fold::ExternalTask) -> Result<String, serde_json::Error> {
    serde_json::to_string(&ExternalHeader {
        task: task.task,
        descriptor: &task.descriptor,
        live_workspace: task.live_workspace,
        admitted: task.admitted,
        binding: &task.binding,
        observed: task.observed,
        closed: &task.closed,
        cleanup: &task.cleanup,
        cleanup_not_before: task.cleanup_not_before,
        steering: &task.steering,
    })
}
fn persist(c: &Connection, view: &RunView) -> Result<(), StoreError> {
    let admission_sequence: u64 = c
        .prepare_cached("SELECT sequence FROM agent_facts WHERE run=? AND revision=1")?
        .query_row([view.run.to_string()], |r| column_u64(r, 0))?;
    c.prepare_cached("INSERT INTO agent_runs(run,schema_version,owner,session,admission_sequence,local,revision,control_version,stopped,terminal,tokens,retries,retry_due_at,retry_pending,current_step,current_attempt,cancelled_by_risk,replans,baseline,external,stop_request,stop_assessed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run) DO UPDATE SET schema_version=excluded.schema_version,revision=excluded.revision,control_version=excluded.control_version,stopped=excluded.stopped,terminal=excluded.terminal,tokens=excluded.tokens,retries=excluded.retries,retry_due_at=excluded.retry_due_at,retry_pending=excluded.retry_pending,current_step=excluded.current_step,current_attempt=excluded.current_attempt,cancelled_by_risk=excluded.cancelled_by_risk,replans=excluded.replans,baseline=excluded.baseline,external=excluded.external,stop_request=excluded.stop_request,stop_assessed=excluded.stop_assessed")?.execute(params![view.run.to_string(),HEADER_SCHEMA_VERSION,serde_json::to_string(&view.spec.owner)?,view.spec.session_id,signed(admission_sequence)?,matches!(view.spec.origin,RunOrigin::Local),signed(view.revision)?,signed(view.control_version)?,view.stopped,view.terminal.as_ref().map(serde_json::to_string).transpose()?,signed(view.tokens)?,view.retries,view.retry_due_at.map(|t|t.0),view.retry_pending.map(|v|v.to_string()),view.current_step.map(|v|v.to_string()),view.current_attempt.map(|v|v.to_string()),view.cancelled_by_risk,serde_json::to_string(&view.replans)?,view.baseline.as_ref().map(serde_json::to_string).transpose()?,view.external.as_ref().map(external_header).transpose()?,view.stop_request.map(|id|id.to_string()),view.stop_assessed.map(|id|id.to_string())])?;
    c.execute(
        "UPDATE agent_runs SET retry_phase=?,finish_requested=?,proactive_summary=?,output_limit_continuations=?,retry_streak=? WHERE run=?",
        params![
            match view.retry_phase {
                maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary => "primary",
                maka_agent_facts::model::retry_transport::RetryTransportPhase::Fallback =>
                    "fallback",
            },
            view.finish_requested(),
            view.proactive_summary.map(|attempt| attempt.to_string()),
            view.output_limit_continuations,
            serde_json::to_string(&view.retry_streak)?,
            view.run.to_string()
        ],
    )?;
    for (key, value) in &view.steps {
        upsert(c, "agent_steps", view.run, key, false, value)?;
    }
    let failed = view.terminal == Some(Terminal::Failed);
    for (key, value) in &view.attempts {
        upsert(
            c,
            "agent_attempts",
            view.run,
            key,
            fold::attempt_unsettled(value)
                || (!failed && value.closed.is_none() && value.interrupted.is_none()),
            value,
        )?;
    }
    for (key, value) in &view.tools {
        upsert(
            c,
            "agent_tools",
            view.run,
            key,
            if failed {
                view.tool_unsettled(value)
            } else {
                fold::tool_pending(value)
            },
            value,
        )?;
    }
    for (key, value) in &view.approvals {
        upsert(c, "agent_approvals", view.run, key, !value.consumed, value)?;
    }
    for (key, value) in &view.blockers {
        let needed = view.tools.values().any(|tool| {
            fold::tool_pending(tool)
                && (value.decision.as_ref().is_some_and(|decision| {
                    matches!(decision.scope, RiskActionScope::RunCancellation)
                }) || fold::blocker_covers(&value.reason, tool))
        });
        upsert(
            c,
            "agent_blockers",
            view.run,
            key,
            (value.decision.is_none() && value.resolved_by.is_none()) || needed,
            value,
        )?;
    }
    for (key, value) in &view.waits {
        c.prepare_cached("INSERT INTO agent_waits(run,key,pending,due_at,body) VALUES(?,?,?,?,?) ON CONFLICT(run,key) DO UPDATE SET pending=excluded.pending,due_at=excluded.due_at,body=excluded.body WHERE body<>excluded.body")?.execute(params![view.run.to_string(),key.to_string(),value.satisfied.is_none()&&value.cancelled.is_none(),value.due_at.map(|t|t.0),serde_json::to_string(value)?])?;
    }
    crate::session_catalog::index_run(c, view)?;
    Ok(())
}
fn validate_request(
    c: &Connection,
    view: &RunView,
    step: StepId,
    reference: &ContentRef,
    adjudications: &[BlockerId],
    proactive: bool,
) -> Result<(RequestSpec, Option<StepId>), StoreError> {
    let existing: Option<(String, i64)> = c
        .prepare_cached("SELECT run,content_id FROM agent_request_specs WHERE step=?")?
        .query_row([step.to_string()], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let id = content_id(c, reference)?;
    if existing
        .as_ref()
        .is_some_and(|(run, content)| *run != view.run.to_string() || *content != id)
    {
        return Err(StoreError::EventConflict);
    }
    let request: RequestSpec = decode(c, reference)?;
    version(request.schema_version)?;
    request.accounting.validate().map_err(invalid)?;
    let surface: maka_agent_facts::composition::CompositionSurface =
        decode(c, &request.composition.surface)?;
    request.composition.validate(&surface).map_err(invalid)?;
    let fallback = if proactive {
        compaction::validate_proactive_request(c, view, &request, &surface)?;
        None
    } else {
        validate_request_lineage(c, view, &request)?
    };
    if request.step != step {
        return Err(invalid("request belongs to another logical Step"));
    }
    if request.protocol.is_empty() || request.protocol_version == 0 {
        return Err(invalid("request protocol descriptor is absent"));
    }
    if !maka_agent_facts::archive::valid_projection_digest(&request.source_digest)
        || !maka_agent_facts::archive::valid_projection_digest(&request.effective_source_digest)
    {
        return Err(invalid("invalid frozen source digest"));
    }
    if request
        .adjudications
        .iter()
        .map(|basis| basis.blocker)
        .ne(adjudications.iter().copied())
    {
        return Err(invalid(
            "request adjudication list differs from the frozen Step choice",
        ));
    }
    for basis in &request.adjudications {
        let scoped = view
            .replans
            .get(&basis.blocker)
            .ok_or_else(|| invalid("request has no active scoped human replan basis"))?;
        let RiskActionScope::ModelReplan { attempt, base_step } = &scoped.scope else {
            return Err(invalid(
                "non-model risk scope cannot authorize a prepared model request",
            ));
        };
        let original = view
            .attempts
            .get(attempt)
            .ok_or_else(|| invalid("request replan scope names an unknown original attempt"))?;
        if original.step != *base_step || view.current_step != Some(*base_step) {
            return Err(invalid(
                "request replan scope differs from the original attempt and base Step",
            ));
        }
        let evidence = match &scoped.decision {
            RiskDecision::AuthorizeReplan { evidence }
            | RiskDecision::RecordExternalObservation { evidence } => evidence,
            RiskDecision::CancelBlockedRun { .. } => {
                return Err(invalid("cancellation is not a replan basis"));
            }
        };
        if &basis.evidence != evidence || request.projection.is_some() {
            return Err(invalid(
                "human replan cannot masquerade as protocol prefix proof",
            ));
        }
    }
    for reference in request.content_refs() {
        pin(c, view.run, reference)?;
    }
    if !proactive
        && adjudications.is_empty()
        && let Some(pending) = view.retry_pending
        && let Some(AttemptRecovery::ProjectPrefixSafe { prefix, .. }) = view
            .attempts
            .get(&pending)
            .and_then(|attempt| attempt.recovery.as_ref())
        && request.projection.as_ref() != Some(prefix)
    {
        return Err(invalid(
            "projected request is not bound to the original safe prefix",
        ));
    }
    Ok((request, fallback))
}
fn validate_external_final_message(
    c: &Connection,
    view: &RunView,
    incoming: &Fact,
) -> Result<(), StoreError> {
    let Fact::ExternalTaskClosed {
        task,
        outcome,
        final_message: Some(final_message),
        ..
    } = incoming
    else {
        return Ok(());
    };
    if *outcome != Terminal::Completed {
        return Err(invalid(
            "only a completed original task may identify a final message",
        ));
    }
    let external = view
        .external
        .as_ref()
        .filter(|external| external.task == *task)
        .ok_or_else(|| invalid("final message has no original external task"))?;
    let original = fact(c, view.run, final_message.end)?
        .ok_or_else(|| invalid("final message has no original canonical MessageEnd"))?;
    if original.revision == 0 || original.revision > view.revision {
        return Err(invalid(
            "final MessageEnd is outside the original task prefix",
        ));
    }
    match original.fact {
        Fact::ExternalTaskObserved {
            task: observed_task,
            index,
            output: maka_agent_facts::executor::Output::MessageEnd { message_id },
            ..
        } if observed_task == *task
            && index < external.observed
            && message_id == final_message.message_id =>
        {
            Ok(())
        }
        _ => Err(invalid(
            "final message differs from its exact original task MessageEnd",
        )),
    }
}

fn validate_private_provider_effect(
    c: &Connection,
    view: &RunView,
    incoming: &Fact,
) -> Result<(), StoreError> {
    let Fact::Blocked {
        reason: BlockerKind::ProviderEffectUnknown { attempt, call },
        ..
    } = incoming
    else {
        return Ok(());
    };
    let tool = ToolKey {
        attempt: *attempt,
        call: call.clone(),
    };
    if view.tools.contains_key(&fold::tool_key(&tool)) {
        return Ok(());
    }
    let original = view
        .attempts
        .get(attempt)
        .ok_or_else(|| invalid("private provider effect has no original model attempt"))?;
    let (schema,step,purpose): (u32,String,String) = c.query_row(
        "SELECT json_extract(CAST(b.payload AS TEXT),'$.schemaVersion'),json_extract(CAST(b.payload AS TEXT),'$.step'),json_extract(CAST(b.payload AS TEXT),'$.accounting.purpose') FROM agent_request_specs r JOIN contents b ON b.id=r.content_id WHERE r.run=? AND r.step=?",
        params![view.run.to_string(),original.step.to_string()],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    )?;
    version(schema)?;
    if identity::<StepId>(step)? != original.step
        || identity::<maka_agent_facts::context::ModelPurpose>(purpose)?
            != maka_agent_facts::context::ModelPurpose::Summary
    {
        return Err(invalid(
            "private provider effect requires an original Summary request",
        ));
    }
    Ok(())
}

fn validate_request_lineage(
    c: &Connection,
    view: &RunView,
    incoming: &RequestSpec,
) -> Result<Option<StepId>, StoreError> {
    use maka_agent_facts::context::ModelPurpose;
    crate::store::fallback::validate_codex_fallback(c, view, incoming)?;
    let previous = view.current_step.map(|step| {
        let (schema, original, purpose, recovery): (u32, String, String, Option<String>) = c.query_row(
            "SELECT json_extract(CAST(b.payload AS TEXT),'$.schemaVersion'),json_extract(CAST(b.payload AS TEXT),'$.step'),json_extract(CAST(b.payload AS TEXT),'$.accounting.purpose'),json_extract(CAST(b.payload AS TEXT),'$.compactionRecovery') FROM agent_request_specs r JOIN contents b ON b.id=r.content_id WHERE r.run=? AND r.step=?",
            params![view.run.to_string(), step.to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        )?;
        version(schema)?;
        if identity::<StepId>(original)? != step { return Err(invalid("current request belongs to another Step")); }
        let purpose: ModelPurpose = identity(purpose)?;
        let recovery: Option<ModelAttemptId> = recovery.map(identity).transpose()?;
        Ok::<_,StoreError>((step, purpose, recovery))
    }).transpose()?;
    let fallback = if previous.is_some_and(|(_, purpose, _)| purpose == ModelPurpose::Summary)
        && incoming.accounting.purpose == ModelPurpose::Main
    {
        crate::store::fallback::validate_resume(c, view, incoming)?
    } else {
        None
    };
    let previous_recovery = previous.and_then(|(_, _, source)| source);
    match (previous_recovery, incoming.compaction_recovery) {
        (Some(_), None)
            if incoming.accounting.purpose == ModelPurpose::Summary
                && incoming.summary_repair_of.is_none()
                && previous.is_some_and(|(_, purpose, _)| purpose == ModelPurpose::Main)
                && crate::store::fallback::rearm_in_snapshot(
                    c,
                    view,
                    previous.expect("checked current Main").0,
                )? => {}
        (Some(previous_source), Some(source))
            if source != previous_source
                && incoming.accounting.purpose == ModelPurpose::Summary
                && incoming.summary_repair_of.is_none()
                && previous.is_some_and(|(_, purpose, _)| purpose == ModelPurpose::Main)
                && view.current_attempt == Some(source)
                && crate::store::fallback::rearm_in_snapshot(
                    c,
                    view,
                    previous.expect("checked current Main").0,
                )? => {}
        (Some(source), current) if current != Some(source) => {
            return Err(invalid(
                "compaction recovery lineage cannot be replaced or cleared",
            ));
        }
        (None, Some(source)) => {
            let original = view
                .current_attempt
                .filter(|attempt| *attempt == source)
                .and_then(|attempt| view.attempts.get(&attempt))
                .ok_or_else(|| invalid("compaction recovery has no current original attempt"))?;
            let resumed_summary = previous == Some((original.step, ModelPurpose::Summary, None))
                && incoming.accounting.purpose == ModelPurpose::Main;
            if !resumed_summary
                && (previous != Some((original.step, ModelPurpose::Main, None))
                    || incoming.accounting.purpose != ModelPurpose::Summary
                    || !original.compactable_overflow())
            {
                return Err(invalid(
                    "compaction recovery requires the original compactable Main overflow",
                ));
            }
        }
        _ => {}
    }
    if let Some(source) = incoming.summary_repair_of {
        let original = view
            .current_attempt
            .filter(|attempt| *attempt == source)
            .and_then(|attempt| view.attempts.get(&attempt))
            .ok_or_else(|| invalid("summary repair has no current original attempt"))?;
        if view.current_step != Some(original.step)
            || !original.closed.as_ref().is_some_and(|closed| {
                closed.outcome == maka_agent_facts::accounting::Outcome::Success
                    && closed.diagnostic.is_none()
            })
        {
            return Err(invalid(
                "summary repair requires the current successful Summary closure",
            ));
        }
        let protocol: maka_agent_facts::context::ModelClosureProtocol = serde_json::from_value(
            original
                .closed
                .as_ref()
                .expect("validated closure")
                .protocol
                .clone(),
        )?;
        if !matches!(
            protocol.summary,
            Some(maka_agent_facts::context::SummaryResult::RejectedToolContent)
        ) {
            return Err(invalid(
                "summary repair requires original rejected tool content",
            ));
        }
        let frozen = self::request(c, view.run, original.step)?;
        if frozen.accounting.purpose != ModelPurpose::Summary
            || frozen.summary_repair_of.is_some()
            || incoming.accounting.purpose != ModelPurpose::Summary
            || incoming.source_capture != frozen.source_capture
            || incoming.source_digest != frozen.source_digest
            || incoming.effective_source_digest != frozen.effective_source_digest
            || incoming.composition != frozen.composition
            || incoming.provenance != frozen.provenance
            || incoming.projection != frozen.projection
            || incoming.adjudications != frozen.adjudications
            || incoming.steering != frozen.steering
        {
            return Err(invalid(
                "summary repair must preserve its one original frozen source cut",
            ));
        }
    }
    Ok(fallback)
}
fn validate_cell_recovery(
    c: &Connection,
    view: &RunView,
    cell: maka_agent_facts::cells::CellId,
    result: &ContentRef,
) -> Result<(), StoreError> {
    use maka_agent_facts::{
        cells::CellStatus,
        tool_output::{AcceptedToolResult, CellFinalEvidence},
    };
    pin(c, view.run, result)?;
    let accepted: AcceptedToolResult = decode(c, result)?;
    let AcceptedToolResult::RecoveredCell {
        cell: original,
        evidence,
    } = accepted
    else {
        return Err(invalid(
            "Cell recovery acceptance requires the shared recovered-Cell result codec",
        ));
    };
    if original != cell {
        return Err(invalid("Cell recovery result belongs to another Cell"));
    }
    let source = view
        .cells
        .get(&cell)
        .ok_or_else(|| invalid("Cell recovery has no original terminal Cell source"))?;
    let matches_source = match (&source.status, &evidence) {
        (
            CellStatus::Completed {
                result: original, ..
            },
            CellFinalEvidence::Completed { result },
        ) => original == result,
        (
            CellStatus::Interrupted { report: original },
            CellFinalEvidence::Interrupted { report },
        ) => original == report,
        _ => false,
    };
    if !matches_source {
        return Err(invalid(
            "Cell recovery result differs from the original canonical terminal evidence",
        ));
    }
    Ok(())
}
fn record(c: &Connection, fact: &RecordedFact) -> Result<(), StoreError> {
    let body = ContentBlob::json(fact)?;
    let id = put(c, &body)?;
    c.prepare_cached("INSERT INTO agent_facts(id,run,revision,schema_version,at,body_content_id) VALUES(?,?,?,?,?,?)")?.execute(params![fact.id.to_string(),fact.run.to_string(),signed(fact.revision)?,fact.schema_version,fact.at.0,id])?;
    pin(c, fact.run, &body.reference)?;
    for reference in fact.fact.content_refs() {
        pin(c, fact.run, reference)?;
    }
    if let Fact::StepPrepared { step, request, .. }
    | Fact::ProactiveSummaryPrepared { step, request, .. } = &fact.fact
    {
        c.prepare_cached("INSERT INTO agent_request_specs(step,run,content_id) VALUES(?,?,?) ON CONFLICT(step) DO NOTHING")?.execute(params![step.to_string(),fact.run.to_string(),content_id(c,request)?])?;
    }
    if let Fact::ModelAttemptPrepared { attempt, step }
    | Fact::ProactiveSummaryPrepared { attempt, step, .. } = &fact.fact
    {
        c.prepare_cached("INSERT INTO agent_attempt_ids(attempt,run,step) VALUES(?,?,?)")?
            .execute(params![
                attempt.to_string(),
                fact.run.to_string(),
                step.to_string()
            ])?;
    }
    model_item(c, fact)?;
    answer_part(c, fact)?;
    if let Fact::ToolOriginalBound { tool, reference }
    | Fact::HostToolResultRecorded {
        tool, reference, ..
    } = &fact.fact
    {
        let key = fold::tool_key(tool);
        let encoded = serde_json::to_string(reference)?;
        let previous: Option<String> = c
            .prepare_cached(
                "SELECT reference_json FROM agent_operation_pins WHERE run=? AND tool=?",
            )?
            .query_row(params![fact.run.to_string(), key], |r| r.get(0))
            .optional()?;
        if previous.as_ref().is_some_and(|old| old != &encoded) {
            return Err(StoreError::EventConflict);
        }
        c.prepare_cached("INSERT INTO agent_operation_pins(run,tool,reference_json) VALUES(?,?,?) ON CONFLICT DO NOTHING")?.execute(params![fact.run.to_string(),key,encoded])?;
    }
    crate::session_history::index(c, fact)?;
    Ok(())
}
fn fact_sequence(c: &Connection, fact: &RecordedFact) -> Result<u64, StoreError> {
    c.prepare_cached("SELECT sequence FROM agent_facts WHERE id=? AND run=?")?
        .query_row(params![fact.id.to_string(), fact.run.to_string()], |row| {
            column_u64(row, 0)
        })
        .map_err(StoreError::from)
}

fn index_non_recall(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    crate::session_catalog::index_fact(c, spec, fact, sequence)?;
    crate::diagnostics::index_fact(c, spec, fact, sequence)?;
    Ok(())
}

fn index_recall(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    crate::recall::index_fact(c, spec, fact, sequence)?;
    crate::recall::index_sources(c, spec, sequence)?;
    Ok(())
}

fn index_derived(c: &Connection, spec: &RunSpec, fact: &RecordedFact) -> Result<(), StoreError> {
    let sequence = fact_sequence(c, fact)?;
    index_non_recall(c, spec, fact, sequence)?;
    index_recall(c, spec, fact, sequence)?;
    Ok(())
}
pub(crate) fn fact(
    c: &Connection,
    run: RunId,
    id: FactId,
) -> Result<Option<RecordedFact>, StoreError> {
    let raw:Option<(u32,Vec<u8>)>=c.prepare_cached("SELECT f.schema_version,c.payload FROM agent_facts f JOIN contents c ON c.id=f.body_content_id WHERE f.id=? AND f.run=?")?.query_row(params![id.to_string(),run.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    raw.map(|(v, bytes)| {
        version(v)?;
        let fact: RecordedFact = serde_json::from_slice(&bytes)?;
        version(fact.schema_version)?;
        if fact.id != id || fact.run != run {
            return Err(invalid("canonical fact identity mismatch"));
        }
        Ok(fact)
    })
    .transpose()
}
pub(crate) fn admit(c: &Connection, admission: Admission) -> Result<(Commit, bool), StoreError> {
    let blob = ContentBlob::json(&admission.spec)?;
    let expected = Fact::RunAdmitted {
        spec: blob.reference.clone(),
    };
    if let Some(original) = fact(c, admission.run, admission.id)? {
        if original.fact != expected {
            return Err(StoreError::EventConflict);
        }
        let view = load(c, admission.run, &[], false)?;
        if let Some(consume) = &admission.queue {
            crate::queue::consume(
                c,
                consume,
                &view.spec,
                admission.run,
                original.id,
                original.at,
            )?;
        }
        return Ok((
            Commit {
                head: Head::from(&view),
                facts: vec![original],
            },
            false,
        ));
    }
    let mut view = RunView::admitted(admission.run, admission.spec)?;
    view.spec.permission_basis.validate().map_err(invalid)?;
    if view.spec.session_id.is_empty()
        || view.spec.turn_id.is_empty()
        || view.spec.workspace.is_empty()
    {
        return Err(invalid("missing immutable Run admission basis"));
    }
    if matches!(view.spec.origin, RunOrigin::Local)
        && view.spec.budget_basis.is_some()
        && admission.guard.is_none()
    {
        return Err(invalid(
            "native budget admission basis requires its live admission guard",
        ));
    }
    if matches!(view.spec.origin, RunOrigin::Local) {
        // Late receipts and a successor admission share the same Root transaction.
        let prior: Option<String> = c.prepare_cached(
            "SELECT run FROM (SELECT run,terminal,cancelled_by_risk FROM agent_runs WHERE session=? ORDER BY admission_sequence DESC LIMIT 1)
             WHERE terminal=json_quote('failed') OR cancelled_by_risk=1",
        )?.query_row([&view.spec.session_id], |row| row.get(0)).optional()?;
        if let Some(prior) = prior
            && load(c, identity(prior)?, &[], false)?.blocks_followup()
        {
            return Err(invalid("previous Run has unsettled original operations"));
        }
    }
    if let Some(guard) = &admission.guard {
        guard.validate(c, admission.run, &view.spec)?;
    }
    insert_blobs(c, admission.contents)?;
    let id = put(c, &blob)?;
    c.prepare_cached("INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)")?.execute(params![admission.run.to_string(),SCHEMA_VERSION,serde_json::to_string(&view.spec.owner)?,view.spec.session_id,id])?;
    for reference in view.spec.content_refs() {
        pin(c, view.run, reference)?;
    }
    let recorded = RecordedFact {
        schema_version: SCHEMA_VERSION,
        id: admission.id,
        run: admission.run,
        revision: 1,
        at: admission.at,
        fact: expected,
    };
    view.apply(&recorded)?;
    record(c, &recorded)?;
    crate::artifacts::admit(c, view.run, &view.spec, recorded.id)?;
    crate::session_history::index_retained(c, &recorded)?;
    crate::session_history::admit_continuation(c, &view, &recorded)?;
    if let Some(consume) = &admission.queue {
        crate::queue::consume(
            c,
            consume,
            &view.spec,
            admission.run,
            admission.id,
            admission.at,
        )?;
    }
    let sequence = fact_sequence(c, &recorded)?;
    index_non_recall(c, &view.spec, &recorded, sequence)?;
    persist(c, &view)?;
    crate::usage::index_fact(c, &view.spec, &recorded, sequence)?;
    // A compaction or handoff continues earlier work; what waits after a user
    // Stop waits for a Run that starts new work.
    if matches!(view.spec.origin, RunOrigin::Local)
        && matches!(
            view.spec.trigger,
            Trigger::Message { .. }
                | Trigger::Goal { .. }
                | Trigger::Schedule { .. }
                | Trigger::Continuation { .. }
        )
    {
        crate::queue::deliver_held(c, &view, admission.id, admission.at)?;
    }
    // Keep Recall FTS5 writes last so preceding ON CONFLICT upserts do not
    // open implicit statement savepoints that force mid-statement fts5IndexFlush.
    index_recall(c, &view.spec, &recorded, sequence)?;
    Ok((
        Commit {
            head: Head::from(&view),
            facts: vec![recorded],
        },
        true,
    ))
}
pub(crate) struct AppendMaterial<'a> {
    pub contents: Vec<ContentBlob>,
    pub artifacts: &'a crate::artifacts::ArtifactBatch,
}

pub(crate) fn append(
    c: &Connection,
    run: RunId,
    expected: Option<Head>,
    changes: &[Change],
    material: AppendMaterial<'_>,
    mode: &Mode,
    steering: Option<&crate::queue::Consume>,
) -> Result<(Commit, bool), StoreError> {
    let AppendMaterial {
        contents,
        artifacts,
    } = material;
    if changes.is_empty() {
        return Err(invalid("empty canonical batch"));
    }
    if let Mode::Driver(claim) = mode {
        if claim.purpose() == crate::store::DriverPurpose::LateModelCleanup {
            let empty_artifacts = match artifacts {
                crate::artifacts::ArtifactBatch::Pending(items) => items.is_empty(),
                crate::artifacts::ArtifactBatch::Prepared(items) => items.is_empty(),
            };
            if !empty_artifacts || !contents.is_empty() || steering.is_some() {
                return Err(invalid(
                    "model cleanup claim cannot publish material or steering",
                ));
            }
            for change in changes {
                let Fact::ModelCleanupObserved {
                    attempt,
                    cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
                } = &change.fact
                else {
                    return Err(invalid(
                        "model cleanup claim accepts only original admitted cleanup proof",
                    ));
                };
                let admitted = c.prepare_cached("SELECT 1 FROM agent_attempts WHERE run=? AND key=? AND json_extract(body,'$.admission') IS NOT NULL")?
                    .query_row(params![run.to_string(), attempt.to_string()], |_| Ok(())).optional()?.is_some();
                if !admitted {
                    return Err(invalid("model cleanup has no original admission"));
                }
            }
        }
        if let crate::store::DriverPurpose::LateExternalCleanup { task } = claim.purpose() {
            let empty_artifacts = match artifacts {
                crate::artifacts::ArtifactBatch::Pending(items) => items.is_empty(),
                crate::artifacts::ArtifactBatch::Prepared(items) => items.is_empty(),
            };
            if !empty_artifacts {
                return Err(invalid("cleanup claim cannot publish artifacts"));
            }
            if !contents.is_empty() || steering.is_some() || changes.iter().any(|change| !matches!(&change.fact,
                Fact::ExternalTaskCleanupObserved { task: actual, cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed } if *actual == task
            ) && !matches!(&change.fact, Fact::ExternalTaskCleanupDeferred { task: actual, .. } if *actual == task)) {
                return Err(invalid("cleanup claim accepts only its original task proof or defer"));
            }
        }
    }
    if matches!(mode, Mode::Historical)
        && (changes.len() != 1
            || !matches!(
                changes[0].fact,
                Fact::RunTerminated {
                    terminal: Terminal::Completed,
                    ..
                }
            ))
    {
        return Err(invalid(
            "historical ingress only completes one installed snapshot",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut originals = Vec::new();
    for change in changes {
        if !seen.insert(change.id) {
            return Err(StoreError::EventConflict);
        }
        match mode {
            Mode::Control
                if !matches!(
                    change.fact,
                    Fact::StopRequested { .. }
                        | Fact::ApprovalRecorded { .. }
                        | Fact::ApprovalRefused { .. }
                        | Fact::Cell {
                            event: maka_agent_facts::cells::CellEvent::ChildApprovalRecorded { .. }
                        }
                ) =>
            {
                return Err(invalid("control ingress cannot admit or advance work"));
            }
            Mode::Late if !change.fact.is_late() => {
                return Err(invalid("observation ingress cannot admit or advance work"));
            }
            _ => {}
        }
        if let Some(original) = fact(c, run, change.id)? {
            if original.fact != change.fact {
                return Err(StoreError::EventConflict);
            }
            originals.push(original);
        }
    }
    for change in changes {
        if let Fact::ApprovalConsumed { approval: _, tool } = &change.fact
            && !changes.iter().any(|change| matches!(&change.fact,Fact::ToolAdmitted { tool:admitted } if admitted==tool)) {
                return Err(invalid("single-use approval consumption requires same-batch tool admission"));
            }
    }
    let targets: Vec<_> = changes.iter().map(|c| &c.fact).collect();
    let mut view = load(c, run, &targets, false)?;
    if matches!(mode, Mode::Historical)
        && (matches!(view.spec.origin, RunOrigin::Local)
            || !matches!(view.spec.backend, BackendSpec::Historical { .. }))
    {
        return Err(invalid(
            "historical ingress requires an imported or forked snapshot backend",
        ));
    }
    if originals.len() == changes.len() {
        if let Some(consume) = steering {
            let steps: Vec<_> = originals
                .iter()
                .filter_map(|recorded| match &recorded.fact {
                    Fact::StepPrepared { step, request, .. } => Some((recorded, *step, request)),
                    _ => None,
                })
                .collect();
            if steps.len() != 1 {
                return Err(invalid(
                    "steering replay requires one original StepPrepared",
                ));
            }
            let (recorded, step, request) = steps[0];
            crate::queue::consume_steering(
                c,
                consume,
                run,
                step,
                request,
                recorded.id,
                recorded.at,
            )?;
        }
        return Ok((
            Commit {
                head: Head::from(&view),
                facts: originals,
            },
            false,
        ));
    }
    if !originals.is_empty() {
        return Err(StoreError::EventConflict);
    }
    if let Some(expected) = expected {
        let actual = Head::from(&view);
        if actual != expected {
            return Err(StoreError::RevisionConflict {
                expected: serde_json::to_string(&expected)?,
                actual: serde_json::to_string(&actual)?,
            });
        }
    }
    if matches!(mode, Mode::Driver(_)) && !matches!(view.spec.origin, RunOrigin::Local) {
        return Err(invalid(
            "historical provenance cannot claim local execution",
        ));
    }
    if view.terminal.is_some()
        && matches!(mode, Mode::Driver(claim) if claim.purpose() == crate::store::DriverPurpose::Business)
    {
        return Err(invalid("terminal run has no business driver authority"));
    }
    crate::external_publication::validate_batch(&view, changes)?;
    insert_blobs(c, contents)?;
    let mut facts = Vec::new();
    let mut steering_used = false;
    for (index, change) in changes.iter().enumerate() {
        if change.fact.is_admission() {
            view.check_effect_admission()?;
        }
        model_evidence::validate_control(c, &view, &change.fact)?;
        if let Fact::BlockerResolved { blocker, .. } = &change.fact {
            view.validate_blocker_resolution(*blocker)?;
        }
        if let Fact::ContextCompacted { baseline } = &change.fact {
            // A deferred checkpoint can become visible to the next Run once
            // this same commit closes the current Run.
            let saving_for_next_run = matches!(
                &changes[index + 1..],
                [next] if next.at == change.at && compaction::ends_run(&next.fact)
            );
            compaction::validate(c, &view, baseline, change.at, saving_for_next_run)?;
        }
        if let Fact::ApprovalRecorded {
            approval,
            tool,
            input_digest,
            ..
        } = &change.fact
        {
            crate::interactions::validate_approval(c, run, *approval, tool, input_digest)?;
        }
        if let Fact::ApprovalRefused {
            approval,
            tool,
            outcome,
        } = &change.fact
        {
            crate::interactions::validate_approval_refusal(c, run, *approval, tool, outcome)?;
        }
        if matches!(
            change.fact,
            Fact::ApprovalConsumed { .. } | Fact::ToolAdmitted { .. }
        ) {
            let check = now()?;
            let approval = match &change.fact {
                Fact::ApprovalConsumed { approval, .. } => Some(*approval),
                Fact::ToolAdmitted { tool } => {
                    view.tools
                        .get(&fold::tool_key(tool))
                        .and_then(|tool| match &tool.decision {
                            Some(ToolDecision::Approved { approval, .. }) => *approval,
                            _ => None,
                        })
                }
                _ => None,
            };
            if approval
                .and_then(|id| view.approvals.get(&id))
                .is_some_and(|grant| grant.expires_at.is_some_and(|expiry| check >= expiry))
            {
                return Err(invalid("single-use approval expired at SQL admission"));
            }
        }
        if let Fact::ToolAdmitted { tool } = &change.fact
            && let Some(ToolDecision::Approved {
                input,
                resources,
                approval: Some(approval),
                ..
            }) = view
                .tools
                .get(&fold::tool_key(tool))
                .and_then(|tool| tool.decision.as_ref())
        {
            if !changes.iter().any(|change|matches!(&change.fact,Fact::ApprovalConsumed{approval:consumed,tool:target} if consumed==approval && target==tool)){
                    return Err(invalid("approved tool requires its exact same-batch consumption"));
                }
            crate::interactions::consume(c, run, tool, *approval, input, resources)?;
        }
        if let Fact::ModelAttemptPrepared { attempt, .. }
        | Fact::ProactiveSummaryPrepared { attempt, .. } = &change.fact
            && c.prepare_cached("SELECT 1 FROM agent_attempt_ids WHERE attempt=?")?
                .query_row([attempt.to_string()], |r| r.get::<_, i64>(0))
                .optional()?
                .is_some()
        {
            return Err(StoreError::EventConflict);
        }
        if matches!(change.fact, Fact::RunAdmitted { .. }) {
            return Err(invalid("Run admission is immutable"));
        }
        if let Fact::StepPrepared {
            step,
            request,
            adjudications,
        } = &change.fact
        {
            let (prepared, fallback) =
                validate_request(c, &view, *step, request, adjudications, false)?;
            if let Some(consume) = steering {
                if prepared.summary_repair_of.is_some() || fallback.is_some() {
                    return Err(invalid(
                        "summary repair/fallback cannot consume new steering input",
                    ));
                }
                if steering_used {
                    return Err(invalid("one steering consume requires one StepPrepared"));
                }
                crate::queue::consume_steering(
                    c, consume, run, *step, request, change.id, change.at,
                )?;
                steering_used = true;
            }
        }
        if let Fact::ProactiveSummaryPrepared { step, request, .. } = &change.fact {
            validate_request(c, &view, *step, request, &[], true)?;
        }
        if let Fact::ToolResultAccepted {
            result,
            outcome: AcceptedResult::CellRecovered { cell },
            ..
        } = &change.fact
        {
            validate_cell_recovery(c, &view, *cell, result)?;
        }
        validate_external_final_message(c, &view, &change.fact)?;
        validate_private_provider_effect(c, &view, &change.fact)?;
        let recorded = RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: change.id,
            run,
            revision: view
                .revision
                .checked_add(1)
                .ok_or_else(|| invalid("Run revision overflow"))?,
            at: change.at,
            fact: change.fact.clone(),
        };
        view.apply(&recorded)?;
        record(c, &recorded)?;
        match &recorded.fact {
            Fact::StopRequested { diagnostic, .. } => {
                crate::queue::stop_completions(c, &view.spec.session_id, run, recorded.at)?;
                if diagnostic == crate::queue::GOAL_CONTROL_STOP {
                    crate::queue::release_steering(c, &view.spec.session_id, run, recorded.at)?;
                }
            }
            Fact::RunTerminated { .. } if matches!(view.spec.origin, RunOrigin::Local) => {
                crate::queue::release_steering(c, &view.spec.session_id, run, recorded.at)?;
            }
            _ => {}
        }
        model_evidence::validate_partial(c, &view, &recorded)?;
        model_evidence::validate_source_failure(c, &view, &recorded)?;
        if matches!(recorded.fact, Fact::ExternalPublication { .. }) {
            crate::external_publication::persist(c, run, &recorded)?;
        }
        if matches!(recorded.fact, Fact::ExternalSteering { .. }) {
            crate::external_steering::persist(c, run, &recorded)?;
        }
        if let Fact::ExternalEffect { event } = &recorded.fact {
            crate::external_effects::persist(c, run, recorded.revision, event)?;
        }
        if matches!(&recorded.fact, Fact::Cell { .. })
            || (matches!(&recorded.fact, Fact::ContextCompacted { .. })
                && matches!(&view.spec.origin, RunOrigin::Local))
        {
            crate::cells::apply(c, &view.spec.session_id, &recorded, changes)?;
        }
        if matches!(recorded.fact, Fact::ToolsLoaded { .. }) {
            crate::cells::apply_tools_loaded(c, &view.spec.session_id, &recorded, changes)?;
        }
        facts.push(recorded);
    }
    if steering.is_some() && !steering_used {
        return Err(invalid("steering consumption requires StepPrepared"));
    }
    crate::artifacts::append(c, run, &facts, artifacts)?;
    let mut indexed = Vec::with_capacity(facts.len());
    for fact in &facts {
        crate::session_history::index_retained(c, fact)?;
        let sequence = fact_sequence(c, fact)?;
        index_non_recall(c, &view.spec, fact, sequence)?;
        indexed.push((fact, sequence));
    }
    persist(c, &view)?;
    for &(fact, sequence) in &indexed {
        crate::usage::index_fact(c, &view.spec, fact, sequence)?;
    }
    // Keep Recall FTS5 writes last so preceding ON CONFLICT / INSERT OR IGNORE
    // statements do not trigger redundant fts5SavepointMethod -> fts5IndexFlush.
    for &(fact, sequence) in &indexed {
        index_recall(c, &view.spec, fact, sequence)?;
    }
    Ok((
        Commit {
            head: Head::from(&view),
            facts,
        },
        true,
    ))
}
pub(crate) fn history(
    c: &Connection,
    run: RunId,
    after: u64,
    count: u32,
) -> Result<Vec<RecordedFact>, StoreError> {
    let mut statement=c.prepare_cached("SELECT f.schema_version,c.payload FROM agent_facts f JOIN contents c ON c.id=f.body_content_id WHERE f.run=? AND f.revision>? ORDER BY f.revision LIMIT ?")?;
    let mut rows = statement.query(params![run.to_string(), signed(after)?, limit(count)?])?;
    let mut facts = Vec::new();
    while let Some(row) = rows.next()? {
        version(row.get(0)?)?;
        let fact: RecordedFact = serde_json::from_slice(&row.get::<_, Vec<u8>>(1)?)?;
        version(fact.schema_version)?;
        if fact.run != run {
            return Err(invalid("canonical fact belongs to another Run"));
        }
        facts.push(fact);
    }
    Ok(facts)
}
pub(crate) fn tool_admission_revision(
    c: &Connection,
    run: RunId,
    tool: ToolKey,
) -> Result<Option<u64>, StoreError> {
    let locator = maka_agent_facts::tool_call::tool_use_id(run, &fold::tool_key(&tool));
    let id: Option<String> = c
        .prepare_cached(
            "SELECT h.fact_id FROM agent_run_specs s
             CROSS JOIN agent_session_history h INDEXED BY agent_session_history_tool
             WHERE s.run=?1 AND h.owner=s.owner AND h.session=s.session AND h.run=s.run
               AND h.tool_use_id=?2 AND h.kind='tool_admitted'",
        )?
        .query_row(params![run.to_string(), locator], |row| row.get(0))
        .optional()?;
    let Some(id) = id else { return Ok(None) };
    let recorded = fact(c, run, identity(id)?)?
        .ok_or_else(|| invalid("tool admission index is missing its canonical fact"))?;
    if !matches!(recorded.fact, Fact::ToolAdmitted { tool: admitted } if admitted == tool) {
        return Err(invalid("tool admission index names another fact"));
    }
    Ok(Some(recorded.revision))
}
pub(crate) fn request(c: &Connection, run: RunId, step: StepId) -> Result<RequestSpec, StoreError> {
    let bytes: Vec<u8> = c.prepare_cached("SELECT c.payload FROM agent_request_specs r JOIN contents c ON c.id=r.content_id WHERE r.run=? AND r.step=?")?
        .query_row(params![run.to_string(), step.to_string()], |row| row.get(0))?;
    let request: RequestSpec = serde_json::from_slice(&bytes)?;
    version(request.schema_version)?;
    if request.step != step {
        return Err(invalid("request Step mismatch"));
    }
    Ok(request)
}
pub(crate) fn due(
    c: &Connection,
    at: UnixMillis,
    after: Option<(UnixMillis, RunId, WaitId)>,
    count: u32,
) -> Result<Vec<(RunId, WaitId, Wait)>, StoreError> {
    let mut statement=c.prepare_cached("SELECT w.run,w.key,w.body FROM agent_waits w WHERE w.pending=1 AND w.due_at IS NOT NULL AND w.due_at<=? AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.run=w.run AND r.terminal IS NULL) AND NOT EXISTS(SELECT 1 FROM agent_blockers b WHERE b.run=w.run AND b.pending=1 AND json_extract(b.body,'$.decision') IS NULL AND json_extract(b.body,'$.resolvedBy') IS NULL) AND (? IS NULL OR (w.due_at,w.run,w.key)>(?,?,?)) ORDER BY w.due_at,w.run,w.key LIMIT ?")?;
    let mut rows = statement.query(params![
        at.0,
        after.as_ref().map(|v| v.0.0),
        after.as_ref().map(|v| v.0.0),
        after.as_ref().map(|v| v.1.to_string()),
        after.as_ref().map(|v| v.2.to_string()),
        limit(count)?
    ])?;
    let mut waits = Vec::new();
    while let Some(row) = rows.next()? {
        waits.push((
            identity(row.get(0)?)?,
            identity(row.get(1)?)?,
            serde_json::from_str(&row.get::<_, String>(2)?)?,
        ));
    }
    Ok(waits)
}
pub(crate) fn runs(
    c: &Connection,
    session: String,
    after: Option<RunId>,
    count: u32,
) -> Result<Vec<RunId>, StoreError> {
    let mut statement=c.prepare_cached("SELECT run FROM agent_runs WHERE session=? AND admission_sequence>coalesce((SELECT admission_sequence FROM agent_runs WHERE run=?),0) ORDER BY admission_sequence LIMIT ?")?;
    let mut rows = statement.query(params![
        session,
        after.map(|v| v.to_string()),
        limit(count)?
    ])?;
    let mut runs = Vec::new();
    while let Some(row) = rows.next()? {
        runs.push(identity(row.get(0)?)?);
    }
    Ok(runs)
}
pub(crate) fn ensure_headers(c: &Connection, owner: &RunOwner) -> Result<bool, StoreError> {
    let owner = serde_json::to_string(owner)?;
    let mut after = (String::new(), String::new());
    let mut changed = false;
    loop {
        let page: Vec<(String, String)> = c.prepare_cached(
            "SELECT s.session,s.run FROM agent_run_specs s LEFT JOIN agent_runs r ON r.run=s.run WHERE s.owner=?1 AND (s.session,s.run)>(?2,?3) AND (r.run IS NULL OR r.schema_version<>?4) ORDER BY s.session,s.run LIMIT 128"
        )?.query_map(params![owner, after.0, after.1, HEADER_SCHEMA_VERSION], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        if page.is_empty() {
            return Ok(changed);
        }
        for (session, run) in page {
            rebuild(c, identity(run.clone())?)?;
            after = (session, run);
            changed = true;
        }
    }
}

pub(crate) fn rebuild(c: &Connection, run: RunId) -> Result<Head, StoreError> {
    let (spec, spec_ref) = spec(c, run)?;
    for table in [
        "agent_diagnostics",
        "agent_diagnostic_coverage",
        "agent_external_publication_items",
        "agent_external_publications",
        "agent_steps",
        "agent_attempts",
        "agent_tools",
        "agent_approvals",
        "agent_blockers",
        "agent_waits",
        "agent_runs",
        "agent_answer_parts",
        "agent_model_items",
        "agent_external_effects",
        "agent_external_steering",
    ] {
        c.execute(
            &format!("DELETE FROM {table} WHERE run=?"),
            [run.to_string()],
        )?;
    }
    crate::cells::clear_run(c, run)?;
    let mut view = RunView::admitted(run, spec)?;
    let mut cursor = 0;
    loop {
        let page = history(c, run, cursor, 128)?;
        if page.is_empty() {
            break;
        }
        for recorded in page {
            if let Fact::RunAdmitted { spec: reference } = &recorded.fact
                && reference != &spec_ref
            {
                return Err(StoreError::EventConflict);
            }
            if let Fact::StepPrepared {
                step,
                request,
                adjudications,
            } = &recorded.fact
            {
                validate_request(c, &view, *step, request, adjudications, false)?;
            }
            if let Fact::ProactiveSummaryPrepared { step, request, .. } = &recorded.fact {
                validate_request(c, &view, *step, request, &[], true)?;
            }
            model_evidence::validate_control(c, &view, &recorded.fact)?;
            model_evidence::validate_partial(c, &view, &recorded)?;
            model_evidence::validate_source_failure(c, &view, &recorded)?;
            if let Fact::ContextCompacted { baseline } = &recorded.fact {
                let saving_for_next_run = history(c, run, recorded.revision, 1)?
                    .first()
                    .is_some_and(|next| next.at == recorded.at && compaction::ends_run(&next.fact));
                compaction::validate(c, &view, baseline, recorded.at, saving_for_next_run)?;
            }
            validate_external_final_message(c, &view, &recorded.fact)?;
            validate_private_provider_effect(c, &view, &recorded.fact)?;
            view.apply(&recorded)?;
            if matches!(recorded.fact, Fact::ExternalPublication { .. }) {
                crate::external_publication::replay(c, run, &recorded)?;
            }
            crate::cells::replay(c, &view, &recorded)?;
            model_item(c, &recorded)?;
            answer_part(c, &recorded)?;
            if let Fact::ExternalEffect { event } = &recorded.fact {
                crate::external_effects::replay(c, run, recorded.revision, event)?;
            }
            if matches!(recorded.fact, Fact::ExternalSteering { .. }) {
                crate::external_steering::replay(c, run, &recorded)?;
            }
            cursor = recorded.revision;
        }
    }
    if cursor == 0 {
        return Err(invalid("canonical Run has no admission fact"));
    }
    crate::cells::rebuild_run(c, run)?;
    crate::artifacts::rebuild(c, run)?;
    crate::computer::pin_run(c, run)?;
    // Session history has its own ordered rebuild; do not append its prefix again here.
    let mut after = 0;
    loop {
        let page = history(c, run, after, 128)?;
        if page.is_empty() {
            break;
        }
        for recorded in page {
            index_derived(c, &view.spec, &recorded)?;
            after = recorded.revision;
        }
    }
    persist(c, &view)?;
    crate::usage::rebuild_run(c, run)?;
    Ok(Head::from(&view))
}

fn answer_part(c: &Connection, fact: &RecordedFact) -> Result<(), StoreError> {
    let Fact::ModelObserved {
        part:
            ModelPart::Text {
                text_kind: maka_agent_facts::model::TextKind::Text,
                text,
                ..
            },
        ..
    } = &fact.fact
    else {
        return Ok(());
    };
    if text.is_empty() {
        return Ok(());
    }
    let start: u64 = c
        .prepare_cached("SELECT coalesce(max(end),0) FROM agent_answer_parts WHERE run=?")?
        .query_row([fact.run.to_string()], |r| column_u64(r, 0))?;
    let blob = ContentBlob::new(text.to_string().into_bytes());
    let end = start
        .checked_add(blob.reference.bytes)
        .filter(|end| *end <= i64::MAX as u64)
        .ok_or_else(|| invalid("answer byte offset overflow"))?;
    c.prepare_cached(
        "INSERT INTO agent_answer_parts(run,revision,start,end,content_id) VALUES(?,?,?,?,?)",
    )?
    .execute(params![
        fact.run.to_string(),
        signed(fact.revision)?,
        signed(start)?,
        signed(end)?,
        put(c, &blob)?
    ])?;
    Ok(())
}
pub(crate) fn latest(c: &Connection, session: String) -> Result<Option<RunId>, StoreError> {
    let run: Option<String> = c
        .prepare_cached(
            "SELECT run FROM agent_runs WHERE session=? ORDER BY admission_sequence DESC LIMIT 1",
        )?
        .query_row([session], |r| r.get(0))
        .optional()?;
    run.map(identity).transpose()
}
pub(crate) fn ready(
    c: &Connection,
    owner: RunOwner,
    at: UnixMillis,
    after: Option<u64>,
    count: u32,
    cause: crate::store::ReadyCause,
) -> Result<Vec<crate::store::ReadyRun>, StoreError> {
    let mut statement = c.prepare_cached(&format!("WITH business AS (
        SELECT r.run,r.admission_sequence,r.session FROM agent_runs r
        WHERE r.owner=?1 AND r.terminal IS NULL AND r.local=1 AND r.admission_sequence>?2
        AND (?5=1 OR NOT {AUTHORITY_BLOCKED} OR r.cancelled_by_risk=1 OR (r.stopped=1 AND r.stop_request IS NOT NULL AND r.stop_assessed IS NOT r.stop_request))
        AND (EXISTS (SELECT 1 FROM agent_blockers b WHERE b.run=r.run AND b.pending=1 AND json_extract(b.body,'$.decision') IS NULL AND json_extract(b.body,'$.resolvedBy') IS NULL AND json_extract(b.body,'$.reason.kind') IS NOT 'current_authority_unavailable')
        OR r.replans != '{{}}'
        OR ((r.stopped=0 OR r.stop_request IS NULL OR r.stop_assessed IS NOT r.stop_request
            OR r.cancelled_by_risk=1 OR (?5=1 AND {AUTHORITY_BLOCKED})
            OR (r.stopped=1 AND json_extract(r.external,'$.admitted')=1
                AND json_extract(r.external,'$.closed') IS NULL
                AND json_extract(r.external,'$.cleanup.kind') IN ('confirmed','failed'))
            OR EXISTS (SELECT 1 FROM agent_cells cell WHERE cell.run=r.run AND cell.pending=1 AND json_extract(cell.body,'$.status.kind')='running'))
        AND (r.stopped=1 OR r.cancelled_by_risk=1 OR r.retry_due_at IS NULL OR r.retry_due_at<=?3)
        AND (r.stopped=1 OR r.cancelled_by_risk=1 OR (?5=1 AND {AUTHORITY_BLOCKED}) OR NOT EXISTS (SELECT 1 FROM agent_waits w WHERE w.run=r.run AND w.pending=1 AND (w.due_at IS NULL OR w.due_at>?3) AND NOT (
            {RECONCILABLE_WAIT}
            OR (w.due_at IS NULL AND json_extract(w.body,'$.reason.kind') IS 'cell' AND EXISTS (
                SELECT 1 FROM agent_cells c WHERE c.run=w.run AND c.cell=json_extract(w.body,'$.reason.cell')
                AND json_extract(c.body,'$.status.kind') IS 'running'))))))))
        SELECT run,admission_sequence,session,NULL AS cleanup_task FROM business
        UNION ALL
        SELECT r.run,r.admission_sequence,r.session,json_extract(r.external,'$.task') AS cleanup_task
        FROM agent_runs r WHERE r.owner=?1 AND r.local=1 AND r.admission_sequence>?2
        AND json_extract(r.external,'$.admitted')=1 AND json_extract(r.external,'$.cleanup.kind') IS NOT 'confirmed'
        AND coalesce(json_extract(r.external,'$.cleanupNotBefore'),-9223372036854775808)<=?3
        AND NOT EXISTS(SELECT 1 FROM business b WHERE b.run=r.run)
        ORDER BY admission_sequence LIMIT ?4"))?;
    let mut rows = statement.query(params![
        serde_json::to_string(&owner)?,
        signed(after.unwrap_or(0))?,
        at.0,
        limit(count)?,
        cause == crate::store::ReadyCause::CapabilitySourceChanged
    ])?;
    let mut ready = Vec::new();
    while let Some(row) = rows.next()? {
        let task: Option<String> = row.get(3)?;
        ready.push(crate::store::ReadyRun {
            run: identity(row.get(0)?)?,
            admission_sequence: column_u64(row, 1)?,
            session_id: row.get(2)?,
            purpose: match task {
                Some(task) => crate::store::DriverPurpose::LateExternalCleanup {
                    task: identity(task)?,
                },
                None => crate::store::DriverPurpose::Business,
            },
        });
    }
    Ok(ready)
}
const MODEL_RECONCILIATION_RUNS_SQL: &str = "WITH candidates AS (
        SELECT a.run FROM agent_attempts a INDEXED BY agent_model_cleanup_pending
        WHERE json_extract(a.body,'$.admission') IS NOT NULL AND json_extract(a.body,'$.cleanup.kind') IS NOT 'confirmed'
        AND (?4=1 OR EXISTS(SELECT 1 FROM agent_runs live WHERE live.run=a.run AND live.terminal IS NULL))
        AND (?4=1 OR NOT EXISTS(SELECT 1 FROM agent_blockers b WHERE b.run=a.run AND json_extract(b.body,'$.resolvedBy') IS NULL
            AND json_extract(b.body,'$.reason.kind')='model_cleanup_unconfirmed' AND json_extract(b.body,'$.reason.attempt')=a.key))
        UNION
        SELECT r.run FROM agent_runs r INDEXED BY agent_runs_live
        JOIN agent_attempts a ON a.run=r.run AND a.key=r.current_attempt
        WHERE r.owner=?1 AND r.terminal IS NULL AND r.stopped=0
            AND json_extract(a.body,'$.closed.outcome')='success' AND json_extract(a.body,'$.closed.diagnostic') IS NULL
            AND json_extract(a.body,'$.closed.protocol.finishReason')='stop' AND json_extract(a.body,'$.hasTools')=0
            AND (?4=1 OR EXISTS(SELECT 1 FROM agent_waits w WHERE w.run=r.run AND w.pending=1 AND json_extract(w.body,'$.reason.kind')='model')
                OR (EXISTS(SELECT 1 FROM agent_blockers b WHERE b.run=r.run AND b.pending=1
                    AND json_extract(b.body,'$.decision') IS NULL AND json_extract(b.body,'$.resolvedBy') IS NULL
                    AND json_extract(b.body,'$.reason.kind')='current_authority_unavailable')
                    AND NOT EXISTS(SELECT 1 FROM agent_waits w WHERE w.run=r.run AND w.pending=1
                        AND json_extract(w.body,'$.reason.kind') IN ('child','retry','provider_backoff'))))
            AND NOT EXISTS(SELECT 1 FROM agent_blockers b WHERE b.run=r.run AND b.pending=1
                AND json_extract(b.body,'$.decision') IS NULL AND json_extract(b.body,'$.resolvedBy') IS NULL
                AND json_extract(b.body,'$.reason.kind') IS NOT 'current_authority_unavailable')
            AND NOT EXISTS(SELECT 1 FROM agent_attempts pending INDEXED BY agent_model_cleanup_pending WHERE pending.run=r.run
                AND json_extract(pending.body,'$.admission') IS NOT NULL AND json_extract(pending.body,'$.cleanup.kind') IS NOT 'confirmed')
    ) SELECT r.run,r.admission_sequence,r.session FROM candidates p CROSS JOIN agent_runs r ON r.run=p.run
        WHERE r.owner=?1 AND r.local=1 AND r.admission_sequence>?2 ORDER BY r.admission_sequence LIMIT ?3";

pub(crate) fn model_reconciliation_runs(
    c: &Connection,
    owner: RunOwner,
    after: Option<u64>,
    count: u32,
    cold_probe: bool,
) -> Result<Vec<crate::store::ReadyRun>, StoreError> {
    let mut statement = c.prepare_cached(MODEL_RECONCILIATION_RUNS_SQL)?;
    let mut rows = statement.query(params![
        serde_json::to_string(&owner)?,
        signed(after.unwrap_or(0))?,
        limit(count)?,
        cold_probe
    ])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(crate::store::ReadyRun {
            run: identity(row.get(0)?)?,
            admission_sequence: column_u64(row, 1)?,
            session_id: row.get(2)?,
            purpose: crate::store::DriverPurpose::LateModelCleanup,
        });
    }
    Ok(result)
}

pub(crate) fn model_cleanups(
    c: &Connection,
    run: RunId,
    after: Option<ModelAttemptId>,
    count: u32,
    cold_probe: bool,
) -> Result<Vec<crate::store::ModelCleanupItem>, StoreError> {
    let view = load(c, run, &[], false)?;
    if !matches!(view.spec.origin, RunOrigin::Local)
        || !matches!(view.spec.backend, BackendSpec::Model { .. })
    {
        return Err(invalid("foreign model cleanup source"));
    }
    let mut statement = c.prepare_cached("SELECT key,body FROM agent_attempts INDEXED BY agent_model_cleanup_pending
        WHERE run=? AND json_extract(body,'$.admission') IS NOT NULL AND json_extract(body,'$.cleanup.kind') IS NOT 'confirmed'
        AND (?2 IS NULL OR key>?2)
        AND (?4=1 OR NOT EXISTS(SELECT 1 FROM agent_blockers b WHERE b.run=agent_attempts.run AND json_extract(b.body,'$.resolvedBy') IS NULL
            AND json_extract(b.body,'$.reason.kind')='model_cleanup_unconfirmed' AND json_extract(b.body,'$.reason.attempt')=agent_attempts.key))
        ORDER BY key LIMIT ?3")?;
    let mut rows = statement.query(params![
        run.to_string(),
        after.map(|id| id.to_string()),
        limit(count)?,
        cold_probe
    ])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        let attempt: Attempt = serde_json::from_str(&row.get::<_, String>(1)?)?;
        let request = request(c, run, attempt.step)?;
        result.push(crate::store::ModelCleanupItem {
            owner: view.spec.owner.clone(),
            execution: ExecutionIdentity {
                run_id: run,
                session_id: view.spec.session_id.clone(),
                turn_id: view.spec.turn_id.clone(),
            },
            attempt: identity(row.get(0)?)?,
            step: attempt.step,
            request: request.request,
            upstream: attempt
                .admission
                .expect("selected admitted source")
                .upstream,
        });
    }
    Ok(result)
}

pub(crate) fn next_due(
    c: &Connection,
    owner: RunOwner,
    after: Option<UnixMillis>,
    cause: crate::store::ReadyCause,
) -> Result<Option<UnixMillis>, StoreError> {
    let next: Option<i64> = c.prepare_cached(&format!("SELECT min(due) FROM (
        SELECT max(coalesce(r.retry_due_at,0),coalesce(max(w.due_at),0)) AS due
        FROM agent_runs r LEFT JOIN agent_waits w ON w.run=r.run AND w.pending=1 AND NOT ({RECONCILABLE_WAIT})
            AND NOT (?3=1 AND w.due_at IS NULL AND {AUTHORITY_BLOCKED})
        WHERE r.owner=?1 AND r.terminal IS NULL AND r.local=1 AND r.stopped=0
        AND NOT EXISTS(SELECT 1 FROM agent_blockers b WHERE b.run=r.run AND b.pending=1 AND json_extract(b.body,'$.decision') IS NULL AND json_extract(b.body,'$.resolvedBy') IS NULL AND (?3=0 OR json_extract(b.body,'$.reason.kind') IS NOT 'current_authority_unavailable'))
        GROUP BY r.run
        HAVING sum(CASE WHEN w.key IS NOT NULL AND w.due_at IS NULL THEN 1 ELSE 0 END)=0
            AND (r.retry_due_at IS NOT NULL OR count(w.due_at)>0)
        UNION ALL
        SELECT json_extract(r.external,'$.cleanupNotBefore') AS due FROM agent_runs r
        WHERE r.owner=?1 AND r.local=1
        AND json_extract(r.external,'$.admitted')=1 AND json_extract(r.external,'$.cleanup.kind') IS NOT 'confirmed'
        AND json_extract(r.external,'$.cleanupNotBefore') IS NOT NULL
        AND coalesce(json_extract(r.external,'$.cleanupNotBefore'),-9223372036854775808)>coalesce(?2,-9223372036854775808)
    ) WHERE ?2 IS NULL OR due>?2"))?
        .query_row(params![serde_json::to_string(&owner)?, after.map(|at| at.0), cause == crate::store::ReadyCause::CapabilitySourceChanged], |row| row.get(0))?;
    Ok(next.map(UnixMillis))
}
pub(crate) fn cleanup_frontier(
    c: &Connection,
    run: RunId,
) -> Result<crate::store::CleanupFrontier, StoreError> {
    type RunHeaderRow = (
        String,
        String,
        u64,
        u64,
        bool,
        Option<String>,
        String,
        String,
        String,
        u32,
        bool,
    );
    let (owner, session, revision, control, local, external, backend_kind, backend, turn, schema, has_publication): RunHeaderRow =
        c.prepare_cached("SELECT r.owner,r.session,r.revision,r.control_version,r.local,r.external,
            json_extract(body.payload,'$.backend.kind'),json_extract(body.payload,'$.backend.descriptor'),
            json_extract(body.payload,'$.turnId'),r.schema_version,
            EXISTS(SELECT 1 FROM agent_external_publications publication WHERE publication.run=r.run)
            FROM agent_runs r JOIN agent_run_specs spec ON spec.run=r.run JOIN contents body ON body.id=spec.spec_content_id
            WHERE r.run=?")?.query_row([run.to_string()], |row| Ok((row.get(0)?,row.get(1)?,column_u64(row,2)?,column_u64(row,3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?)))?;
    if !local || backend_kind != "executor" || schema != HEADER_SCHEMA_VERSION {
        return Err(invalid(
            "cleanup requires original local executor projection",
        ));
    }
    let task: fold::ExternalTask =
        serde_json::from_str(&external.ok_or_else(|| invalid("original external task absent"))?)?;
    if !task.admitted {
        return Err(invalid("cleanup has no original task admission"));
    }
    Ok(crate::store::CleanupFrontier {
        has_creation_evidence: task.observed != 0
            || has_publication
            || task.closed.as_ref().is_some_and(|closed| {
                closed.outcome == maka_agent_facts::durable::Terminal::Completed
            }),
        run,
        head: Head {
            revision,
            control_version: control,
        },
        owner: serde_json::from_str(&owner)?,
        session_id: session,
        turn_id: turn,
        backend: serde_json::from_str(&backend)?,
        task: task.task,
        descriptor: task.descriptor,
        binding: task.binding,
        cleanup: task.cleanup,
        not_before: task.cleanup_not_before,
    })
}
// Nonempty answer parts are contiguous. The first end at or beyond the page end
// is the inclusive upper key on (run, end), even when a page cuts through a part.
const ANSWER_TEXT: &str =
    "SELECT substr(c.payload,max(?1-p.start,0)+1,min(p.end,?2)-max(p.start,?1))
    FROM agent_answer_parts p JOIN contents c ON c.id=p.content_id
    WHERE p.run=?3 AND p.end>?1
      AND p.end<=(SELECT min(end) FROM agent_answer_parts WHERE run=?3 AND end>=?2)
    ORDER BY p.end";
const ANSWER_SPANS: &str = "SELECT p.start+s.start,p.start+s.end FROM agent_answer_parts p
    CROSS JOIN agent_facts f ON f.run=p.run AND f.revision=p.revision
    CROSS JOIN agent_memory_hidden_spans s
    WHERE p.run=?1 AND p.end>?2
      AND p.end<=(SELECT min(end) FROM agent_answer_parts WHERE run=?1 AND end>=?3)
      AND s.namespace=?4 AND s.fact=f.id AND s.ordinal=0";

pub(crate) fn work(
    c: &Connection,
    run: RunId,
    offset: u64,
    count: u32,
    model_read: bool,
) -> Result<Option<crate::store::RunObservation>, StoreError> {
    if !(4..=65536).contains(&count) {
        return Err(invalid("answer page size must be in 4..=65536 bytes"));
    }
    if !exists(c, run)? {
        return Ok(None);
    }
    let view = load(c, run, &[], false)?;
    let high_water: u64 = c
        .prepare_cached("SELECT coalesce(max(end),0) FROM agent_answer_parts WHERE run=?")?
        .query_row([run.to_string()], |r| column_u64(r, 0))?;
    if offset > high_water {
        return Err(invalid("answer offset is beyond the captured prefix"));
    }
    let end = offset.saturating_add(u64::from(count)).min(high_water);
    let mut statement = c.prepare_cached(ANSWER_TEXT)?;
    let mut rows = statement.query(params![signed(offset)?, signed(end)?, run.to_string()])?;
    let mut bytes = Vec::new();
    while let Some(row) = rows.next()? {
        bytes.extend(row.get::<_, Vec<u8>>(0)?);
    }
    if let Err(error) = std::str::from_utf8(&bytes) {
        if error.error_len().is_some() {
            return Err(invalid("answer offset is not a UTF-8 boundary"));
        }
        bytes.truncate(error.valid_up_to());
    }
    let next = offset
        .checked_add(u64::try_from(bytes.len()).map_err(|_| invalid("answer length exceeds u64"))?)
        .ok_or_else(|| invalid("answer cursor overflow"))?;
    if next == offset && offset < high_water {
        return Err(invalid("answer page made no UTF-8 progress"));
    }
    let mut text =
        String::from_utf8(bytes).map_err(|_| invalid("invalid canonical answer bytes"))?;
    if model_read && !text.is_empty() {
        let mut stmt = c.prepare_cached(ANSWER_SPANS)?;
        let spans = stmt
            .query_map(
                params![
                    run.to_string(),
                    signed(offset)?,
                    signed(next)?,
                    serde_json::to_string(&view.spec.owner)?
                ],
                |row| Ok((column_u64(row, 0)?, column_u64(row, 1)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        crate::memory::recall::mask(&mut text, offset, &spans);
    }
    let pending_interactions =
        if !view.stopped && view.terminal.is_none() && matches!(view.spec.origin, RunOrigin::Local)
        {
            crate::session_history::pending_interaction_count(c, run, &view.spec.session_id)?
        } else {
            0
        };
    Ok(Some(crate::store::RunObservation {
        view,
        pending_interactions,
        answer: crate::store::AnswerPage {
            offset,
            high_water,
            text,
            next: (next < high_water).then_some(next),
        },
    }))
}

pub(crate) fn notification(
    c: &Connection,
    run: RunId,
    changed: bool,
) -> Result<maka_event_log::writeback::Notification, StoreError> {
    if !changed {
        return Ok(maka_event_log::writeback::Notification::NONE);
    }
    let session: String = c
        .prepare_cached("SELECT session FROM agent_run_specs WHERE run=?")?
        .query_row([run.to_string()], |r| r.get(0))?;
    Ok(maka_event_log::writeback::Notification::METADATA.with_sessions([session]))
}

fn model_item(c: &Connection, fact: &RecordedFact) -> Result<(), StoreError> {
    if let Fact::ModelObserved { attempt, index, .. } = &fact.fact {
        c.prepare_cached(
            "INSERT INTO agent_model_items(run,attempt,item_index,fact_id) VALUES(?,?,?,?)",
        )?
        .execute(params![
            fact.run.to_string(),
            attempt.to_string(),
            signed(*index)?,
            fact.id.to_string()
        ])?;
    }
    Ok(())
}
pub(crate) fn model_items(
    c: &Connection,
    run: RunId,
    attempt: ModelAttemptId,
    after: Option<u64>,
    count: u32,
) -> Result<Vec<RecordedFact>, StoreError> {
    let mut statement=c.prepare_cached("SELECT f.schema_version,c.payload FROM agent_model_items i JOIN agent_facts f ON f.id=i.fact_id JOIN contents c ON c.id=f.body_content_id WHERE i.run=? AND i.attempt=? AND i.item_index>? ORDER BY i.item_index LIMIT ?")?;
    let mut rows = statement.query(params![
        run.to_string(),
        attempt.to_string(),
        after.map(signed).transpose()?.unwrap_or(-1),
        limit(count)?
    ])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        version(row.get(0)?)?;
        let fact: RecordedFact = serde_json::from_slice(&row.get::<_, Vec<u8>>(1)?)?;
        version(fact.schema_version)?;
        if fact.run != run || !matches!(fact.fact,Fact::ModelObserved{attempt:id,..} if id==attempt)
        {
            return Err(invalid(
                "model item index does not match canonical identity",
            ));
        }
        result.push(fact);
    }
    Ok(result)
}

#[cfg(test)]
mod answer_page_tests {
    use super::*;
    use rusqlite::StatementStatus;

    #[test]
    fn answer_pages_visit_only_intersecting_parts() {
        let db = Connection::open_in_memory().unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        db.execute_batch(r#"
            INSERT INTO contents VALUES(1,'spec',x'7b7d'),(2,'text',CAST('A你B' AS BLOB));
            INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES('run',1,'owner','chat',1);
            INSERT INTO agent_memories VALUES('owner','personal','m',1,1,'user_recall','suppressed',0,0);
            INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition)
              VALUES('owner','personal','m',1,'sample','{}','digest','suppressed');
            INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key)
              VALUES('owner','personal','m',1,'{"kind":"conversation","reference":{"sessionId":"chat","sequence":2,"factId":"f2","itemIndex":0,"start":1,"end":4}}','address');
        "#).unwrap();
        let window = |start: i64, end: i64| {
            let mut body = db.prepare(ANSWER_TEXT).unwrap();
            let mut bytes = Vec::new();
            for chunk in body
                .query_map(params![start, end, "run"], |r| r.get::<_, Vec<u8>>(0))
                .unwrap()
            {
                bytes.extend(chunk.unwrap());
            }
            let mut evidence = db.prepare(ANSWER_SPANS).unwrap();
            let spans = evidence
                .query_map(params!["run", start, end, "owner"], |r| {
                    Ok((column_u64(r, 0)?, column_u64(r, 1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let mut text = String::from_utf8(bytes).unwrap();
            crate::memory::recall::mask(&mut text, start as u64, &spans);
            (
                text,
                body.get_status(StatementStatus::VmStep),
                evidence.get_status(StatementStatus::VmStep),
            )
        };
        let mut costs = Vec::new();
        let mut previous = 0;
        for count in [16, 2048] {
            db.execute(
                "WITH RECURSIVE n(v) AS (VALUES(?1+1) UNION ALL SELECT v+1 FROM n WHERE v<?2)
                        INSERT INTO agent_facts SELECT v,'f'||v,'run',v,1,0,1 FROM n",
                params![previous, count],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_answer_parts SELECT 'run',revision,5*(revision-1),5*revision,2
                        FROM agent_facts WHERE revision>?",
                [previous],
            )
            .unwrap();
            let early = window(4, 11);
            let late = window(5 * count - 6, 5 * count);
            assert_eq!(early.0, "BA***BA");
            assert_eq!(late.0, "BA你B");
            assert_eq!(window(5, 10).0, "A***B");
            assert_eq!(window(5 * count, 5 * count).0, "");
            costs.push([early.1, early.2, late.1, late.2]);
            previous = count;
        }
        for (small, large) in costs[0].into_iter().zip(costs[1]) {
            assert!(
                large <= small * 2,
                "fixed page cost grew from {small} to {large} VM steps"
            );
        }
    }
}

pub(crate) fn migrate_retry_streak(c: &Connection) -> Result<(), maka_event_log::StoreError> {
    let runs: Vec<String> = {
        let mut statement =
            c.prepare("SELECT run FROM agent_runs WHERE retries > 0 OR retry_phase = 'fallback'")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    if runs.is_empty() {
        return Ok(());
    }
    let mut facts = c.prepare(
        "SELECT c.payload FROM agent_facts f          JOIN contents c ON c.id = f.body_content_id          WHERE f.run = ?          ORDER BY f.revision ASC",
    )?;
    let mut update = c.prepare("UPDATE agent_runs SET retry_streak = ? WHERE run = ?")?;
    for run in runs {
        let mut current_attempt = None;
        let mut streak = fold::RetryStreak::default();
        let payloads = facts.query_map([&run], |row| row.get::<_, Vec<u8>>(0))?;
        for payload in payloads {
            let bytes = payload?;
            let recorded: RecordedFact = serde_json::from_slice(&bytes).map_err(|error| {
                maka_event_log::StoreError::Migration(format!(
                    "failed to decode agent fact for retry_streak backfill on run {run}: {error}"
                ))
            })?;
            match &recorded.fact {
                Fact::ModelAttemptPrepared { attempt, .. } => {
                    current_attempt = Some(*attempt);
                }
                Fact::ModelTransportSelected {
                    attempt,
                    phase: maka_agent_facts::model::retry_transport::RetryTransportPhase::Fallback,
                } => {
                    streak = fold::RetryStreak::FallbackTransitionPending { attempt: *attempt };
                }
                Fact::RetryCharged { attempt, .. } => {
                    streak = streak.on_retry_charged(*attempt).map_err(|error| {
                        maka_event_log::StoreError::Migration(format!(
                            "failed to replay retry_streak for run {run}: {error}"
                        ))
                    })?;
                }
                Fact::ModelClosed {
                    attempt,
                    outcome: maka_agent_facts::accounting::Outcome::Success,
                    diagnostic: None,
                    ..
                } if current_attempt == Some(*attempt) => {
                    streak = fold::RetryStreak::default();
                }
                _ => {}
            }
        }
        let encoded = serde_json::to_string(&streak).map_err(|error| {
            maka_event_log::StoreError::Migration(format!(
                "failed to encode retry_streak for run {run}: {error}"
            ))
        })?;
        update.execute(params![encoded, run])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MODEL_RECONCILIATION_RUNS_SQL;
    use rusqlite::{Connection, params};

    #[test]
    fn model_reconciliation_runs_drives_join_from_candidates_not_due_index() {
        let db = Connection::open_in_memory().unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        let mut stmt = db
            .prepare(&format!(
                "EXPLAIN QUERY PLAN {MODEL_RECONCILIATION_RUNS_SQL}"
            ))
            .unwrap();
        let plan: Vec<String> = stmt
            .query_map(params!["{}", 0i64, 64i64, false], |r| r.get(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter().all(|step| !step.contains("agent_runs_due")),
            "reconciliation query must not scan historical runs via agent_runs_due: {plan:?}"
        );
        assert!(
            plan.iter()
                .any(|step| step.contains("SEARCH r USING") && step.contains("(run=?)")),
            "outer join must probe agent_runs by run PK from candidates: {plan:?}"
        );
    }

    #[test]
    fn migration_53_backfills_retry_streak_matching_fact_replay() {
        use crate::{
            ContentBlob,
            fold::{self, RunView},
        };
        use maka_agent_facts::{
            accounting::Outcome,
            context::ModelClosureProtocol,
            durable::{
                AttemptRecovery, Fact, FactId, ModelAttemptId, RecordedFact, RunId, SCHEMA_VERSION,
                StepId, UnixMillis,
            },
            model::{ModelFinishReason, retry_transport::RetryTransportPhase},
        };
        use maka_plugin_core::operation::OperationCleanup;

        let db = Connection::open_in_memory().unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let through_52: Vec<_> = catalog
            .iter()
            .filter(|m| m.version <= 52)
            .copied()
            .collect();
        maka_event_log::migration::run(&db, &through_52).unwrap();

        let seed_run = |facts: Vec<Fact>, retries: u32, retry_phase: &str| -> (RunId, RunView) {
            let run = RunId::new();
            let (mut spec, _) = crate::store::stop_tests::spec();
            spec.session_id = format!("mig53-{run}");
            spec.budget.retries = 2;
            let spec_blob = ContentBlob::json(&spec).unwrap();
            let spec_cid = super::put(&db, &spec_blob).unwrap();
            let owner_json = serde_json::to_string(&spec.owner).unwrap();
            db.execute(
                "INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",
                params![run.to_string(), SCHEMA_VERSION, owner_json, spec.session_id, spec_cid],
            )
            .unwrap();

            let mut view = RunView::admitted(run, spec).unwrap();
            let all_facts = std::iter::once(Fact::RunAdmitted {
                spec: spec_blob.reference().clone(),
            })
            .chain(facts);
            let mut admission_seq = 0_i64;
            let mut revision = 0_u64;
            for fact in all_facts {
                revision += 1;
                let recorded = RecordedFact {
                    schema_version: SCHEMA_VERSION,
                    id: FactId::new(),
                    run,
                    revision,
                    at: UnixMillis(revision as i64),
                    fact,
                };
                view.apply(&recorded).unwrap();
                let fact_blob = ContentBlob::json(&recorded).unwrap();
                let cid = super::put(&db, &fact_blob).unwrap();
                db.execute(
                    "INSERT INTO agent_facts(id,run,revision,schema_version,at,body_content_id) VALUES(?,?,?,?,?,?)",
                    params![
                        recorded.id.to_string(),
                        run.to_string(),
                        revision as i64,
                        SCHEMA_VERSION,
                        recorded.at.0,
                        cid
                    ],
                )
                .unwrap();
                if revision == 1 {
                    admission_seq = db.last_insert_rowid();
                }
            }
            db.execute(
                "INSERT INTO agent_runs(run,schema_version,owner,session,admission_sequence,local,revision,control_version,stopped,terminal,tokens,retries,retry_due_at,retry_pending,current_step,current_attempt,cancelled_by_risk,replans,baseline,external,stop_request,stop_assessed,retry_phase,finish_requested,proactive_summary,output_limit_continuations)                  VALUES(?,?,?,?,?,?,?,?,0,NULL,0,?,NULL,NULL,NULL,NULL,0,'{}',NULL,NULL,NULL,NULL,?,0,NULL,0)",
                params![
                    run.to_string(),
                    super::HEADER_SCHEMA_VERSION,
                    owner_json,
                    format!("mig53-{run}"),
                    admission_seq,
                    1_i64,
                    revision as i64,
                    0_i64,
                    retries,
                    retry_phase,
                ],
            )
            .unwrap();
            (run, view)
        };

        let req = ContentBlob::json(&serde_json::json!({}))
            .unwrap()
            .reference()
            .clone();
        let ok_protocol = serde_json::to_value(ModelClosureProtocol {
            model_time_ms: None,
            finish_reason: ModelFinishReason::Stop,
            provider_options: None,
            cache_read_reported: None,
            response_id: None,
            model: None,
            timestamp: None,
            compaction: None,
            summary: None,
        })
        .unwrap();
        let fail_facts = |step: StepId, attempt: ModelAttemptId, prepare_step: bool| {
            let mut out = Vec::new();
            if prepare_step {
                out.push(Fact::StepPrepared {
                    step,
                    request: req.clone(),
                    adjudications: vec![],
                });
            }
            out.extend([
                Fact::ModelAttemptPrepared { attempt, step },
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: serde_json::Value::Null,
                },
                Fact::ModelInterrupted {
                    attempt,
                    diagnostic: "timed out".into(),
                },
                Fact::AttemptRecoveryRecorded {
                    attempt,
                    recovery: AttemptRecovery::FrozenRetrySafe { not_before: None },
                },
                Fact::ModelCleanupObserved {
                    attempt,
                    cleanup: OperationCleanup::Confirmed,
                },
            ]);
            out
        };
        let succeed_facts = |step: StepId, attempt: ModelAttemptId| {
            vec![
                Fact::ModelAttemptPrepared { attempt, step },
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: serde_json::Value::Null,
                },
                Fact::ModelClosed {
                    attempt,
                    outcome: Outcome::Success,
                    diagnostic: None,
                    usage: Default::default(),
                    protocol: ok_protocol.clone(),
                },
                Fact::ModelCleanupObserved {
                    attempt,
                    cleanup: OperationCleanup::Confirmed,
                },
            ]
        };

        // 1) Primary mid-streak with a succeeding background proactive summary (must NOT reset).
        let (s1, a1, bg1) = (StepId::new(), ModelAttemptId::new(), ModelAttemptId::new());
        let mut f1 = fail_facts(s1, a1, true);
        f1.push(Fact::RetryCharged {
            attempt: a1,
            phase: RetryTransportPhase::Primary,
            due_at: UnixMillis(10),
            diagnostic: "retry".into(),
        });
        f1.extend([
            Fact::ProactiveSummaryPrepared {
                step: StepId::new(),
                request: req.clone(),
                attempt: bg1,
            },
            Fact::ModelAttemptAdmitted {
                attempt: bg1,
                upstream: serde_json::Value::Null,
            },
            Fact::ModelClosed {
                attempt: bg1,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: ok_protocol.clone(),
            },
            Fact::ModelCleanupObserved {
                attempt: bg1,
                cleanup: OperationCleanup::Confirmed,
            },
        ]);
        let (run_mid_primary, view_mid_primary) = seed_run(f1, 1, "primary");

        // 2) Primary retry followed by foreground success (resets to Regular { charged: 0 }).
        let (s2, a2, a2_ok) = (StepId::new(), ModelAttemptId::new(), ModelAttemptId::new());
        let mut f2 = fail_facts(s2, a2, true);
        f2.push(Fact::RetryCharged {
            attempt: a2,
            phase: RetryTransportPhase::Primary,
            due_at: UnixMillis(1),
            diagnostic: "retry".into(),
        });
        f2.extend(succeed_facts(s2, a2_ok));
        let (run_reset_primary, view_reset_primary) = seed_run(f2, 1, "primary");

        // 3) ModelTransportSelected(Fallback) pending its transition RetryCharged.
        let (s3, a3_1, a3_2, a3_3) = (
            StepId::new(),
            ModelAttemptId::new(),
            ModelAttemptId::new(),
            ModelAttemptId::new(),
        );
        let mut f3 = fail_facts(s3, a3_1, true);
        f3.push(Fact::RetryCharged {
            attempt: a3_1,
            phase: RetryTransportPhase::Primary,
            due_at: UnixMillis(1),
            diagnostic: "r1".into(),
        });
        f3.extend(fail_facts(s3, a3_2, false));
        f3.push(Fact::RetryCharged {
            attempt: a3_2,
            phase: RetryTransportPhase::Primary,
            due_at: UnixMillis(1),
            diagnostic: "r2".into(),
        });
        f3.extend(fail_facts(s3, a3_3, false));
        f3.push(Fact::ModelTransportSelected {
            attempt: a3_3,
            phase: RetryTransportPhase::Fallback,
        });
        let (run_fallback_pending, view_fallback_pending) = seed_run(f3.clone(), 2, "fallback");

        // 4) Fallback transition + one post-transition Fallback retry -> AfterFallbackTransition { charged: 1 }.
        let a4_4 = ModelAttemptId::new();
        let mut f4 = f3.clone();
        f4.push(Fact::RetryCharged {
            attempt: a3_3,
            phase: RetryTransportPhase::Fallback,
            due_at: UnixMillis(1),
            diagnostic: "fallback-transition".into(),
        });
        f4.extend(fail_facts(s3, a4_4, false));
        f4.push(Fact::RetryCharged {
            attempt: a4_4,
            phase: RetryTransportPhase::Fallback,
            due_at: UnixMillis(1),
            diagnostic: "fallback-r1".into(),
        });
        let (run_fallback_charged, view_fallback_charged) = seed_run(f4.clone(), 4, "fallback");

        // 5) Fallback succeeded -> reset to Regular { charged: 0 }.
        let mut f5 = f4;
        f5.extend(succeed_facts(s3, ModelAttemptId::new()));
        let (run_fallback_reset, view_fallback_reset) = seed_run(f5, 4, "fallback");

        // Apply migration 53 (SQL + atomic data backfill).
        maka_event_log::migration::run(&db, &catalog).unwrap();

        let expected = [
            (
                run_mid_primary,
                view_mid_primary.retry_streak,
                fold::RetryStreak::Regular { charged: 1 },
            ),
            (
                run_reset_primary,
                view_reset_primary.retry_streak,
                fold::RetryStreak::Regular { charged: 0 },
            ),
            (
                run_fallback_pending,
                view_fallback_pending.retry_streak,
                fold::RetryStreak::FallbackTransitionPending { attempt: a3_3 },
            ),
            (
                run_fallback_charged,
                view_fallback_charged.retry_streak,
                fold::RetryStreak::AfterFallbackTransition { charged: 1 },
            ),
            (
                run_fallback_reset,
                view_fallback_reset.retry_streak,
                fold::RetryStreak::Regular { charged: 0 },
            ),
        ];
        for (run, folded, want) in expected {
            assert_eq!(folded, want, "folded streak mismatch for {run}");
            let raw: String = db
                .query_row(
                    "SELECT retry_streak FROM agent_runs WHERE run = ?",
                    [run.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            let migrated: fold::RetryStreak = serde_json::from_str(&raw).unwrap();
            assert_eq!(migrated, folded, "migrated streak mismatch for {run}");
        }
    }

    #[test]
    fn migration_55_indexes_ended_unknown_external_observations_and_bidirectional_redaction() {
        use crate::{
            ContentBlob,
            fold::RunView,
            memory::recall::{ArchiveRestriction, RestrictedArchives, indexed_spans},
        };
        use maka_agent_facts::{
            durable::{
                BackendSpec, BlockerId, BlockerKind, ExecutionIdentity, ExternalTaskId, Fact,
                FactId, RecordedFact, RunId, SCHEMA_VERSION, Terminal, UnixMillis,
            },
            executor::Selection,
            external_effects::{ExternalEffectDescriptor, ExternalEffectEvent, ExternalEffectKey},
            memory::MemorySource,
            tool_call::ToolOrigin,
            tools::ToolDefinition,
        };
        use maka_event_log::connection::Query;
        use maka_plugin_core::{
            contract::Transport,
            deployment::DeploymentRef,
            operation::{
                OperationCleanup, OperationOutcome, OperationReply, Receipt, RecoveryContract,
                RecoveryProtocol, RecoveryRef,
            },
        };
        use uuid::Uuid;

        let db = Connection::open_in_memory().unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let through_54: Vec<_> = catalog
            .iter()
            .filter(|m| m.version <= 54)
            .copied()
            .collect();
        maka_event_log::migration::run(&db, &through_54).unwrap();

        let seed_external = |session: &str,
                             diagnostic: &str,
                             initial_cleanup: OperationCleanup,
                             terminal: Terminal,
                             terminal_diag: Option<String>,
                             pre_v55_recall: bool| {
            let run = RunId::new();
            let (mut spec, _) = crate::store::stop_tests::spec();
            let task = ExternalTaskId::new();
            let key = ExternalEffectKey {
                task,
                operation: Uuid::new_v4(),
            };
            let task_source = maka_agent_facts::executor::Binding {
                executor_id: "external".to_string().try_into().unwrap(),
                package_id: "maka.agent".into(),
                entry_id: "maka.agent".into(),
                activation: "fixture".into(),
            };
            let task_blob = ContentBlob::json(&maka_agent_facts::executor::TaskDescriptor {
                protocol: maka_agent_facts::executor::NATIVE_TASK_PROTOCOL.into(),
                source: task_source,
                payload: serde_json::json!({}),
            })
            .unwrap();
            spec.session_id = session.to_owned();
            spec.backend = BackendSpec::Executor {
                selection: Selection {
                    executor: "external".into(),
                    settings: Default::default(),
                },
                descriptor: task_blob.reference().clone(),
            };
            let spec_blob = ContentBlob::json(&spec).unwrap();
            let owner_json = serde_json::to_string(&spec.owner).unwrap();
            let spec_cid = super::put(&db, &spec_blob).unwrap();
            super::put(&db, &task_blob).unwrap();
            db.execute(
                "INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",
                params![run.to_string(), SCHEMA_VERSION, owner_json, spec.session_id, spec_cid],
            )
            .unwrap();
            super::pin(&db, run, spec_blob.reference()).unwrap();
            super::pin(&db, run, task_blob.reference()).unwrap();

            let descriptor_blob = ContentBlob::json(&ExternalEffectDescriptor {
                schema_version: SCHEMA_VERSION,
                protocol: "fixture".into(),
                execution: ExecutionIdentity {
                    session_id: spec.session_id.clone(),
                    run_id: run,
                    turn_id: spec.turn_id.clone(),
                },
                key,
                origin: ToolOrigin::External {
                    task,
                    operation: key.operation,
                    package_id: "maka.agent".into(),
                    entry_id: "maka.agent".into(),
                    activation: "fixture".into(),
                },
                operation_id: format!("external:{task}:{}", key.operation),
                name: "cua_repl".into(),
                input: serde_json::json!({"code": "paste()"}),
                definition: ToolDefinition {
                    name: "cua_repl".into(),
                    description: "cua".into(),
                    input_schema: serde_json::json!({}),
                    provider: None,
                    freeform: None,
                    output_schema: None,
                },
                catalog_digest: format!("sha256:{}", "1".repeat(64)),
                resources: vec![],
            })
            .unwrap();
            super::put(&db, &descriptor_blob).unwrap();
            super::pin(&db, run, descriptor_blob.reference()).unwrap();

            let digest = format!("sha256-{}", "a".repeat(64));
            let reference = RecoveryRef {
                source: DeploymentRef {
                    state_domain: "b".repeat(64),
                    deployment: spec.owner.deployment,
                    revision: 1,
                },
                namespace: spec.owner.namespace.clone(),
                export: "computer".into(),
                method: "evaluate".into(),
                operation: Uuid::new_v4(),
                fingerprint: digest.clone(),
                contract: RecoveryContract {
                    name: "maka.workspace.Computer".into(),
                    version: 1,
                    transport: Transport::Remote,
                    digest,
                },
                recovery: RecoveryProtocol::JournalV1,
            };
            let make_obs = |cleanup| Fact::ExternalEffect {
                event: ExternalEffectEvent::Observed {
                    key,
                    observation: OperationReply {
                        reference: reference.clone(),
                        receipt: Receipt::Recorded {
                            outcome: OperationOutcome::Unknown {
                                diagnostic: diagnostic.into(),
                            },
                            cleanup,
                        },
                    },
                },
            };

            let mut facts = vec![
                Fact::RunAdmitted {
                    spec: spec_blob.reference().clone(),
                },
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor: task_blob.reference().clone(),
                    live_workspace: true,
                },
                Fact::ExternalTaskAdmitted { task },
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Prepared {
                        key,
                        descriptor: descriptor_blob.reference().clone(),
                    },
                },
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Admitted {
                        key,
                        approval: None,
                    },
                },
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Bound {
                        key,
                        reference: reference.clone(),
                    },
                },
                make_obs(initial_cleanup),
            ];
            if terminal == Terminal::Failed {
                facts.push(Fact::Blocked {
                    blocker: BlockerId::new(),
                    reason: BlockerKind::ExternalEffectUnknown {
                        task,
                        operation: key.operation,
                    },
                });
            } else {
                facts.push(Fact::ExternalTaskClosed {
                    task,
                    outcome: Terminal::Completed,
                    diagnostic: None,
                    final_message: None,
                });
            }
            facts.push(Fact::ExternalTaskCleanupObserved {
                task,
                cleanup: OperationCleanup::Confirmed,
            });
            facts.push(Fact::RunTerminated {
                terminal: terminal.clone(),
                diagnostic: terminal_diag,
            });

            let mut view = RunView::admitted(run, spec.clone()).unwrap();
            let mut recorded_facts = Vec::new();
            let mut revision = 0_u64;
            for fact in facts {
                revision += 1;
                let recorded = RecordedFact {
                    schema_version: SCHEMA_VERSION,
                    id: FactId::new(),
                    run,
                    revision,
                    at: UnixMillis(revision as i64),
                    fact,
                };
                view.apply(&recorded).unwrap();
                let fact_blob = ContentBlob::json(&recorded).unwrap();
                let cid = super::put(&db, &fact_blob).unwrap();
                db.execute(
                    "INSERT INTO agent_facts(id,run,revision,schema_version,at,body_content_id) VALUES(?,?,?,?,?,?)",
                    params![
                        recorded.id.to_string(),
                        run.to_string(),
                        revision as i64,
                        SCHEMA_VERSION,
                        recorded.at.0,
                        cid
                    ],
                )
                .unwrap();
                let seq = db.last_insert_rowid() as u64;
                if revision == 1 {
                    db.execute(
                        "INSERT INTO agent_runs(run,schema_version,owner,session,admission_sequence,local,revision,control_version,stopped,terminal,tokens,retries,retry_due_at,retry_pending,current_step,current_attempt,cancelled_by_risk,replans,baseline,external,stop_request,stop_assessed,retry_phase,finish_requested,proactive_summary,output_limit_continuations)
                         VALUES(?,?,?,?,?,?,?,0,0,?,0,0,NULL,NULL,NULL,NULL,0,'{}',NULL,NULL,NULL,NULL,'primary',0,NULL,0)",
                        params![
                            run.to_string(),
                            super::HEADER_SCHEMA_VERSION,
                            owner_json,
                            spec.session_id,
                            seq as i64,
                            1_i64,
                            revision as i64,
                            serde_json::to_string(&terminal).unwrap(),
                        ],
                    )
                    .unwrap();
                } else {
                    db.execute(
                        "UPDATE agent_runs SET revision=?, external=? WHERE run=?",
                        params![
                            revision as i64,
                            view.external
                                .as_ref()
                                .map(|t| serde_json::to_string(t).unwrap()),
                            run.to_string(),
                        ],
                    )
                    .unwrap();
                }
                if let Fact::ExternalEffect { event } = &recorded.fact {
                    crate::external_effects::replay(&db, run, revision, event).unwrap();
                }
                crate::session_history::index(&db, &recorded).unwrap();
                if !pre_v55_recall
                    || !matches!(
                        recorded.fact,
                        Fact::ExternalEffect {
                            event: ExternalEffectEvent::Observed { .. }
                        }
                    )
                {
                    crate::recall::index_fact(&db, &spec, &recorded, seq).unwrap();
                } else {
                    let digest: String = db
                        .query_row(
                            "SELECT prefix_digest FROM agent_session_history WHERE sequence=?",
                            [seq as i64],
                            |r| r.get(0),
                        )
                        .unwrap();
                    db.execute(
                        "INSERT INTO agent_recall_heads(owner,session,sequence,digest) VALUES(?,?,?,?)
                         ON CONFLICT(owner,session) DO UPDATE SET sequence=excluded.sequence,digest=excluded.digest",
                        params![owner_json, spec.session_id, seq as i64, digest],
                    )
                    .unwrap();
                }
                recorded_facts.push((seq, recorded));
            }
            (run, spec, key, reference, view, recorded_facts)
        };

        // Run A: real v54 failed external run (no ExternalTaskClosed, generic v54 RunTerminated
        // diagnostic, Observed(Unknown, Confirmed) skipped by pre-v55 Recall while head advanced).
        let diag_a = "paste-v54-secret-alpha";
        let (run_a, spec_a, _key_a, _ref_a, view_a, facts_a) = seed_external(
            "mig55-a",
            diag_a,
            OperationCleanup::Confirmed,
            Terminal::Failed,
            Some("Could not determine the outcome of an external agent operation.".into()),
            true,
        );
        let obs_a_seq = facts_a[6].0;
        let obs_a_id = facts_a[6].1.id;
        let prep_a_id = facts_a[3].1.id;
        let canonical_facts = || -> Vec<(String, String)> {
            db.prepare(
                "SELECT f.id, b.content_sha256 FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? ORDER BY f.revision",
            )
            .unwrap()
            .query_map([run_a.to_string()], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        let pre_facts_a = canonical_facts();
        let pre_count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_recall_messages WHERE sequence=?",
                [obs_a_seq as i64],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            pre_count, 0,
            "v54 must omit Observed from agent_recall_messages"
        );

        // Cold upgrade v54 -> v55 without manual Recall rebuild.
        maka_event_log::migration::run(&db, &catalog).unwrap();

        assert_eq!(
            canonical_facts(),
            pre_facts_a,
            "v55 must not rewrite canonical facts"
        );

        // 1) Run A's pre-existing Observed(Confirmed) is indexed in Recall (single Field::Result),
        // surfaces its real diagnostic, and is Quiescent despite closed == None.
        let (body_a, fields_a): (String, String) = db
            .query_row(
                "SELECT body, fields_json FROM agent_recall_messages WHERE sequence=?",
                [obs_a_seq as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            body_a,
            maka_agent_facts::tool_output::ended_unknown_message(diag_a)
        );
        let spans_a: Vec<crate::recall::FieldSpan> = serde_json::from_str(&fields_a).unwrap();
        assert_eq!(spans_a.len(), 1);
        assert_eq!(spans_a[0].field, crate::recall::Field::Result);
        let fts_hits: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM agent_recall_terms WHERE rowid=(SELECT id FROM agent_recall_messages WHERE sequence=?)",
                [obs_a_seq as i64],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            fts_hits, 1,
            "rebuilt Recall FTS must index migrated observation for {run_a}"
        );
        assert!(!view_a.blocks_followup());
        assert_eq!(
            view_a.recovery_failure_diagnostic().as_deref(),
            Some(diag_a)
        );
        assert_eq!(
            crate::store::quiescence::observe(&db, &spec_a.owner, &spec_a.session_id).unwrap(),
            crate::SessionQuiescence::Quiescent
        );

        let restrict_fact = |owner: &maka_agent_facts::durable::RunOwner,
                             session: &str,
                             fact_id: FactId,
                             seq: u64,
                             start: usize,
                             end: usize,
                             quote: &str| {
            let owner_json = serde_json::to_string(owner).unwrap();
            let mem_id = Uuid::new_v4().to_string();
            let user_src = serde_json::to_string(&MemorySource::UserOperation {
                operation_id: Uuid::new_v4(),
                observed_at: 0,
            })
            .unwrap();
            let conv_src = serde_json::json!({
                "kind": "conversation",
                "reference": {
                    "sessionId": session,
                    "sequence": seq,
                    "factId": fact_id.to_string(),
                    "itemIndex": 0,
                    "start": start,
                    "end": end,
                    "quote": quote,
                    "fingerprint": "fp"
                }
            })
            .to_string();
            db.execute(
                    "INSERT INTO agent_memories VALUES(?1,'personal',?2,1,1,'user_recall','suppressed',0,0)",
                    params![owner_json, mem_id],
                )
                .unwrap();
            db.execute(
                    "INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,digest,disposition)
                     VALUES(?1,'personal',?2,1,?3,?4,'digest','suppressed')",
                    params![owner_json, mem_id, quote, user_src],
                )
                .unwrap();
            db.execute(
                "INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key)
                     VALUES(?1,'personal',?2,1,?3,?4)",
                params![owner_json, mem_id, conv_src, format!("ev-{mem_id}")],
            )
            .unwrap();
            mem_id
        };

        let obs_a_start = body_a.find(diag_a).unwrap();
        let _mem_a = restrict_fact(
            &spec_a.owner,
            &spec_a.session_id,
            obs_a_id,
            obs_a_seq,
            obs_a_start,
            obs_a_start + diag_a.len(),
            diag_a,
        );
        assert_eq!(
            crate::session_history::recovery_diagnostic(&db, &view_a, true)
                .unwrap()
                .as_deref(),
            Some("The operation outcome is unknown.")
        );
        assert_eq!(
            RestrictedArchives {
                snapshot: None,
                owner: spec_a.owner.clone(),
                facts: vec![prep_a_id],
            }
            .execute(&db)
            .unwrap()
            .get(&prep_a_id),
            Some(&ArchiveRestriction::PairedResult)
        );

        // 2) Post-v55 failed external run (no ExternalTaskClosed, v55 RunTerminated carrying
        // unconfirmed diagnostic) before late Observed(Confirmed) arrives: quiescence reports
        // Busy(ExternalEffect) -> Quiescent, and RunTerminated <-> Observed redaction works both ways.
        let diag_b = "paste-v55-secret-beta";
        let term_diag_b =
            format!("{diag_b}. The call may still be running; its end was not confirmed.");
        let (run_b, spec_b, key_b, ref_b, mut view_b, facts_b) = seed_external(
            "mig55-b",
            diag_b,
            OperationCleanup::Unconfirmed,
            Terminal::Failed,
            Some(term_diag_b),
            false,
        );
        let prep_b_id = facts_b[3].1.id;
        let term_b_seq = facts_b.last().unwrap().0;
        let term_b_id = facts_b.last().unwrap().1.id;
        assert_eq!(
            crate::store::quiescence::observe(&db, &spec_b.owner, &spec_b.session_id).unwrap(),
            crate::SessionQuiescence::Busy(crate::SessionObligation::ExternalEffect)
        );

        let late_obs_rev = (facts_b.len() + 1) as u64;
        let late_obs = RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: FactId::new(),
            run: run_b,
            revision: late_obs_rev,
            at: UnixMillis(late_obs_rev as i64),
            fact: Fact::ExternalEffect {
                event: ExternalEffectEvent::Observed {
                    key: key_b,
                    observation: OperationReply {
                        reference: ref_b,
                        receipt: Receipt::Recorded {
                            outcome: OperationOutcome::Unknown {
                                diagnostic: diag_b.into(),
                            },
                            cleanup: OperationCleanup::Confirmed,
                        },
                    },
                },
            },
        };
        view_b.apply(&late_obs).unwrap();
        assert_eq!(
            view_b.recovery_failure_diagnostic().as_deref(),
            Some(diag_b)
        );
        let late_cid = super::put(&db, &ContentBlob::json(&late_obs).unwrap()).unwrap();
        db.execute(
            "INSERT INTO agent_facts(id,run,revision,schema_version,at,body_content_id) VALUES(?,?,?,?,?,?)",
            params![late_obs.id.to_string(), run_b.to_string(), late_obs_rev as i64, SCHEMA_VERSION, late_obs.at.0, late_cid],
        )
        .unwrap();
        let late_seq = db.last_insert_rowid() as u64;
        if let Fact::ExternalEffect { event } = &late_obs.fact {
            crate::external_effects::replay(&db, run_b, late_obs_rev, event).unwrap();
        }
        crate::session_history::index(&db, &late_obs).unwrap();
        crate::recall::index_fact(&db, &spec_b, &late_obs, late_seq).unwrap();
        assert_eq!(
            crate::store::quiescence::observe(&db, &spec_b.owner, &spec_b.session_id).unwrap(),
            crate::SessionQuiescence::Quiescent
        );

        // Direction 1: Restrict RunTerminated -> masks late Observed(Confirmed) AND recovery_diagnostic.
        let mem1 = restrict_fact(
            &spec_b.owner,
            &spec_b.session_id,
            term_b_id,
            term_b_seq,
            0,
            diag_b.len(),
            diag_b,
        );
        assert!(
            indexed_spans(&db, &spec_b.owner, &[(0, late_obs.id, 0, None)], &[])
                .unwrap()
                .contains_key(&0),
            "RunTerminated restriction must propagate to late Observed"
        );
        assert_eq!(
            crate::session_history::recovery_diagnostic(&db, &view_b, true)
                .unwrap()
                .as_deref(),
            Some("The operation outcome is unknown.")
        );
        assert_eq!(
            crate::session_history::recovery_diagnostic(&db, &view_b, false)
                .unwrap()
                .as_deref(),
            Some(diag_b)
        );

        // Direction 2: Restrict late Observed(Confirmed) -> masks RunTerminated, paired Prepared, and recovery_diagnostic.
        db.execute("DELETE FROM agent_memory_evidence WHERE id=?", [&mem1])
            .unwrap();
        db.execute("DELETE FROM agent_memory_versions WHERE id=?", [&mem1])
            .unwrap();
        db.execute("DELETE FROM agent_memories WHERE id=?", [&mem1])
            .unwrap();
        let obs_body = maka_agent_facts::tool_output::ended_unknown_message(diag_b);
        let obs_start = obs_body.find(diag_b).unwrap();
        let _mem2 = restrict_fact(
            &spec_b.owner,
            &spec_b.session_id,
            late_obs.id,
            late_seq,
            obs_start,
            obs_start + diag_b.len(),
            diag_b,
        );
        assert!(
            indexed_spans(&db, &spec_b.owner, &[(0, term_b_id, 0, None)], &[])
                .unwrap()
                .contains_key(&0),
            "Observed restriction must propagate to RunTerminated"
        );
        assert_eq!(
            RestrictedArchives {
                snapshot: None,
                owner: spec_b.owner.clone(),
                facts: vec![prep_b_id],
            }
            .execute(&db)
            .unwrap()
            .get(&prep_b_id),
            Some(&ArchiveRestriction::PairedResult)
        );
        assert_eq!(
            crate::session_history::recovery_diagnostic(&db, &view_b, true)
                .unwrap()
                .as_deref(),
            Some("The operation outcome is unknown.")
        );
    }
}
