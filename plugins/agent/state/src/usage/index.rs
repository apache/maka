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
    accounting::{Origin, Outcome},
    model::ModelUsage,
    tool_call::{RejectionKind, ToolCallIdentity, ToolOrigin, ToolSettlement},
};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use uuid::Uuid;
mod cells;
mod external;
pub(crate) use cells::index_cell;

fn execution(spec: &RunSpec, run: RunId) -> ExecutionIdentity {
    ExecutionIdentity {
        session_id: spec.session_id.clone(),
        turn_id: spec.turn_id.clone(),
        run_id: run,
    }
}
fn model_id(run: RunId, attempt: ModelAttemptId) -> String {
    format!("model:{run}:{attempt}")
}
fn tool_id(run: RunId, tool: &ToolKey) -> String {
    format!("tool:{run}:{}:{}", tool.attempt, tool.call)
}
fn json<T: Serialize>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(Into::into)
}
fn decode<T: DeserializeOwned>(c: &Connection, reference: &ContentRef) -> Result<T, StoreError> {
    let bytes = maka_event_log::content::read(c, &reference.digest)?
        .ok_or_else(|| invalid("canonical usage source content is missing"))?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn evidence(
    c: &Connection,
    run: RunId,
    attempt: ModelAttemptId,
) -> Result<(StepId, ModelEvidence), StoreError> {
    let (step,body):(String,String)=c.query_row("SELECT a.step,json_extract(CAST(b.payload AS TEXT),'$.accounting') FROM agent_attempt_ids a JOIN agent_request_specs r ON r.step=a.step AND r.run=a.run JOIN contents b ON b.id=r.content_id WHERE a.run=? AND a.attempt=?",params![run.to_string(),attempt.to_string()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    Ok((
        StepId::try_from(Uuid::parse_str(&step).map_err(|e| invalid(e.to_string()))?)
            .map_err(invalid)?,
        serde_json::from_str(&body)?,
    ))
}
fn insert_model(
    c: &Connection,
    id: &str,
    source: &str,
    owner: &RunOwner,
    session: &str,
    run: Option<RunId>,
    sequence: u64,
    at: UnixMillis,
    evidence: &ModelEvidence,
    origin: &Origin,
) -> Result<(), StoreError> {
    c.execute("INSERT INTO agent_usage_calls(request,source,kind,owner,session,run,admission_sequence,started_at,model_id,provider_id,purpose,binding_json,quote_json,origin_json) VALUES(?,?,'model',?,?,?,?,?,?,?,?,?,?,?)",params![id,source,json(owner)?,session,run.map(|r|r.to_string()),integer(sequence)?,at.0,evidence.model_id,evidence.quote.as_ref().map(|q|q.provider_id.as_str()),json(&evidence.purpose)?,json(&evidence.binding)?,evidence.quote.as_ref().map(json).transpose()?,json(origin)?])?;
    Ok(())
}
fn insert_tool(
    c: &Connection,
    id: &str,
    source: &str,
    owner: Option<&RunOwner>,
    session: &str,
    run: Option<RunId>,
    sequence: u64,
    at: UnixMillis,
    name: &str,
    binding: Option<&maka_agent_facts::execution::ModelBinding>,
    origin: &ToolUsageSource,
) -> Result<(), StoreError> {
    c.execute("INSERT INTO agent_usage_calls(request,source,kind,owner,session,run,admission_sequence,started_at,name,binding_json,origin_json) VALUES(?,?,'tool',?,?,?,?,?,?,?,?) ON CONFLICT(request) DO NOTHING",params![id,source,owner.map(json).transpose()?,session,run.map(|r|r.to_string()),integer(sequence)?,at.0,name,binding.map(json).transpose()?,json(origin)?])?;
    Ok(())
}
#[derive(Default)]
struct ResultVersion {
    completed_at: Option<i64>,
    outcome: Option<String>,
    rejection: Option<String>,
    usage: ModelUsage,
    cost: Option<f64>,
    cleanup: Option<OperationCleanup>,
}
fn previous(c: &Connection, id: &str) -> Result<ResultVersion, StoreError> {
    let raw:Option<(Option<i64>,Option<String>,Option<String>,Option<i64>,Option<i64>,Option<i64>,Option<i64>,Option<i64>,Option<f64>,Option<String>)>=c.query_row("SELECT completed_at,outcome,rejection,input,output,cache_read,cache_write,reasoning,cost_usd,cleanup_json FROM agent_usage_results WHERE request=? ORDER BY sequence DESC LIMIT 1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional()?;
    raw.map(|r| {
        Ok(ResultVersion {
            completed_at: r.0,
            outcome: r.1,
            rejection: r.2,
            usage: ModelUsage {
                input_tokens: r.3.map(unsigned).transpose()?,
                output_tokens: r.4.map(unsigned).transpose()?,
                cache_read_tokens: r.5.map(unsigned).transpose()?,
                cache_write_tokens: r.6.map(unsigned).transpose()?,
                reasoning_tokens: r.7.map(unsigned).transpose()?,
            },
            cost: r.8,
            cleanup: r.9.map(|body| serde_json::from_str(&body)).transpose()?,
        })
    })
    .transpose()
    .map(|v| v.unwrap_or_default())
}
fn version(
    c: &Connection,
    id: &str,
    sequence: u64,
    mut result: ResultVersion,
) -> Result<(), StoreError> {
    let quote: Option<String> = c.query_row(
        "SELECT quote_json FROM agent_usage_calls WHERE request=?",
        [id],
        |r| r.get(0),
    )?;
    result.cost = quote
        .map(|body| serde_json::from_str::<maka_agent_facts::pricing::Quote>(&body))
        .transpose()?
        .map(|quote| quote.estimate(&result.usage).map_err(invalid))
        .transpose()?
        .flatten();
    c.execute("INSERT INTO agent_usage_results(request,sequence,completed_at,outcome,rejection,input,output,cache_read,cache_write,reasoning,cost_usd,cleanup_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",params![id,integer(sequence)?,result.completed_at,result.outcome,result.rejection,result.usage.input_tokens.map(integer).transpose()?,result.usage.output_tokens.map(integer).transpose()?,result.usage.cache_read_tokens.map(integer).transpose()?,result.usage.cache_write_tokens.map(integer).transpose()?,result.usage.reasoning_tokens.map(integer).transpose()?,result.cost,result.cleanup.as_ref().map(json).transpose()?])?;
    Ok(())
}
fn outcome(value: Outcome) -> &'static str {
    match value {
        Outcome::Success => "success",
        Outcome::Error => "error",
        Outcome::Aborted => "aborted",
        Outcome::Unknown => "unknown",
    }
}
fn settle(
    c: &Connection,
    id: &str,
    sequence: u64,
    at: UnixMillis,
    settlement: ToolSettlement,
    is_error: bool,
    reason: Option<RejectionKind>,
) -> Result<(), StoreError> {
    let mut result = previous(c, id)?;
    result.completed_at = Some(at.0);
    result.outcome = Some(
        match settlement {
            ToolSettlement::Returned if !is_error => "success",
            ToolSettlement::Returned | ToolSettlement::Failed => "error",
            ToolSettlement::Unknown => "unknown",
            ToolSettlement::Rejected => "rejected",
        }
        .into(),
    );
    result.rejection = reason.as_ref().map(json).transpose()?;
    version(c, id, sequence, result)
}
fn host_returned(
    c: &Connection,
    id: &str,
    sequence: u64,
    at: UnixMillis,
    is_error: bool,
) -> Result<(), StoreError> {
    let mut result = previous(c, id)?;
    result.outcome = Some(
        match result.outcome.as_deref() {
            Some("error") => "error",
            Some("success") if is_error => "error",
            Some("success") => "success",
            Some("rejected") => "rejected",
            _ => "unknown",
        }
        .into(),
    );
    result.completed_at = Some(at.0);
    version(c, id, sequence, result)
}
fn observe_cleanup(
    c: &Connection,
    id: &str,
    sequence: u64,
    cleanup: Option<&OperationCleanup>,
) -> Result<(), StoreError> {
    if !c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_usage_calls WHERE request=?)",
        [id],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    let mut result = previous(c, id)?;
    if let Some(cleanup) = cleanup {
        result.cleanup = Some(match (&result.cleanup, cleanup) {
            (Some(OperationCleanup::Confirmed), _) => OperationCleanup::Confirmed,
            (Some(old @ OperationCleanup::Failed { .. }), OperationCleanup::Unconfirmed) => {
                old.clone()
            }
            _ => cleanup.clone(),
        });
    }
    version(c, id, sequence, result)
}
fn observe_receipt(
    c: &Connection,
    id: &str,
    sequence: u64,
    at: UnixMillis,
    reply: &maka_plugin_core::operation::OperationReply,
) -> Result<(), StoreError> {
    observe_returned_receipt_inner(c, id, sequence, at, reply, None)
}
fn observe_returned_receipt(
    c: &Connection,
    id: &str,
    sequence: u64,
    at: UnixMillis,
    reply: &maka_plugin_core::operation::OperationReply,
    is_error: bool,
) -> Result<(), StoreError> {
    observe_returned_receipt_inner(c, id, sequence, at, reply, Some(is_error))
}
fn observe_returned_receipt_inner(
    c: &Connection,
    id: &str,
    sequence: u64,
    at: UnixMillis,
    reply: &maka_plugin_core::operation::OperationReply,
    is_error: Option<bool>,
) -> Result<(), StoreError> {
    if !c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_usage_calls WHERE request=?)",
        [id],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    let mut result = previous(c, id)?;
    if let Receipt::Recorded { outcome, cleanup } = &reply.receipt {
        if is_error.is_some()
            || !matches!(
                result.outcome.as_deref(),
                Some("success" | "error" | "rejected")
            )
        {
            let status = match outcome {
                OperationOutcome::Returned {
                    result: maka_plugin_core::operation::OperationResult::Success { .. },
                } => Some(if is_error == Some(true) {
                    "error"
                } else {
                    "success"
                }),
                OperationOutcome::Returned {
                    result: maka_plugin_core::operation::OperationResult::Failure { .. },
                } => Some("error"),
                OperationOutcome::NotExecuted { .. } => Some("rejected"),
                OperationOutcome::Unknown { .. } => Some("unknown"),
                OperationOutcome::Unresolved => None,
            };
            if let Some(status) = status {
                result.completed_at = Some(at.0);
                result.outcome = Some(status.into());
            }
        }
        result.cleanup = Some(match (&result.cleanup, cleanup) {
            (Some(OperationCleanup::Confirmed), _) => OperationCleanup::Confirmed,
            (Some(old @ OperationCleanup::Failed { .. }), OperationCleanup::Unconfirmed) => {
                old.clone()
            }
            _ => cleanup.clone(),
        });
    }
    version(c, id, sequence, result)
}
fn provider_tool(
    c: &Connection,
    spec: &RunSpec,
    run: RunId,
    key: &ToolKey,
    sequence: u64,
    at: UnixMillis,
) -> Result<String, StoreError> {
    let id = tool_id(run, key);
    let name: String = c.query_row(
        "SELECT json_extract(body,'$.call.name') FROM agent_tools WHERE run=? AND key=?",
        params![run.to_string(), crate::fold::tool_key(key)],
        |r| r.get(0),
    )?;
    let (step, model) = evidence(c, run, key.attempt)?;
    let origin = ToolUsageSource::Agent {
        execution: execution(spec, run),
        call: ToolCallIdentity {
            tool_call_id: key.call.clone(),
            origin: ToolOrigin::Provider {
                link: AgentStepLink {
                    run,
                    step,
                    attempt: key.attempt,
                },
            },
        },
    };
    insert_tool(
        c,
        &id,
        "fact",
        Some(&spec.owner),
        &spec.session_id,
        Some(run),
        sequence,
        at,
        &name,
        Some(&model.binding),
        &origin,
    )?;
    Ok(id)
}
/// Called after core, Cell and External projections are persisted in this same
/// transaction. Only immutable metadata is read from those projections.
pub(crate) fn index_fact(
    c: &Connection,
    spec: &RunSpec,
    record: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    if !matches!(spec.origin, RunOrigin::Local) {
        return Ok(());
    }
    let run = record.run;
    match &record.fact {
        Fact::ModelAttemptPrepared { attempt, .. } => {
            let (step, model) = evidence(c, run, *attempt)?;
            insert_model(
                c,
                &model_id(run, *attempt),
                "fact",
                &spec.owner,
                &spec.session_id,
                Some(run),
                sequence,
                record.at,
                &model,
                &Origin::Agent {
                    execution: execution(spec, run),
                    link: AgentStepLink {
                        run,
                        step,
                        attempt: *attempt,
                    },
                    purpose: model.purpose,
                },
            )?;
        }
        Fact::ModelClosed {
            attempt,
            outcome: status,
            usage,
            ..
        } => {
            version(
                c,
                &model_id(run, *attempt),
                sequence,
                ResultVersion {
                    completed_at: Some(record.at.0),
                    outcome: Some(outcome(*status).into()),
                    usage: usage.clone(),
                    ..Default::default()
                },
            )?;
        }
        Fact::ToolAdmitted { tool } => {
            provider_tool(c, spec, run, tool, sequence, record.at)?;
        }
        Fact::ToolDecided {
            tool,
            decision: ToolDecision::Rejected { rejection, .. },
        }
        | Fact::ToolPreventedBeforeHostAdmission {
            tool, rejection, ..
        } => {
            let id = provider_tool(c, spec, run, tool, sequence, record.at)?;
            settle(
                c,
                &id,
                sequence,
                record.at,
                ToolSettlement::Rejected,
                true,
                Some(rejection.kind()),
            )?;
        }
        Fact::LocalToolReturned {
            tool,
            settlement,
            is_error,
            ..
        } => {
            settle(
                c,
                &tool_id(run, tool),
                sequence,
                record.at,
                *settlement,
                *is_error,
                None,
            )?;
        }
        Fact::HostToolResultRecorded { tool, is_error, .. } => {
            host_returned(c, &tool_id(run, tool), sequence, record.at, *is_error)?;
        }

        Fact::OperationObserved { tool, reply } => {
            observe_receipt(c, &tool_id(run, tool), sequence, record.at, reply)?
        }
        Fact::Cell { event } => index_cell(
            c,
            "fact",
            Some(&spec.owner),
            &spec.session_id,
            Some(run),
            sequence,
            record.at,
            event,
        )?,
        Fact::ExternalEffect { event } => external::index(c, spec, record, sequence, event)?,
        _ => {}
    }
    Ok(())
}
pub(super) fn index_auxiliary(
    c: &Connection,
    request: Uuid,
    sequence: u64,
    at: UnixMillis,
    event: &AuxiliaryEvent,
    spec: &AuxiliarySpec,
) -> Result<(), StoreError> {
    let id = format!("auxiliary:{request}");
    match event {
        AuxiliaryEvent::Started { .. } => insert_model(
            c,
            &id,
            "auxiliary",
            &spec.owner,
            &spec.session,
            None,
            sequence,
            at,
            &spec.accounting,
            &Origin::Auxiliary {
                source: spec.source.clone(),
            },
        )?,
        AuxiliaryEvent::UsageObserved { usage } => {
            let mut value = previous(c, &id)?;
            value.usage = usage.clone();
            version(c, &id, sequence, value)?;
        }
        AuxiliaryEvent::Settled { outcome: status } => {
            let mut value = previous(c, &id)?;
            value.completed_at = Some(at.0);
            value.outcome = Some(outcome(*status).into());
            version(c, &id, sequence, value)?;
        }
    }
    Ok(())
}
pub(crate) fn rebuild_run(c: &Connection, run: RunId) -> Result<(), StoreError> {
    c.execute(
        "DELETE FROM agent_usage_calls WHERE run=? AND source='fact'",
        [run.to_string()],
    )?;
    let spec:RunSpec=c.query_row("SELECT b.payload FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id WHERE s.run=?",[run.to_string()],|r|r.get::<_,Vec<u8>>(0)).map(|bytes|serde_json::from_slice(&bytes))??;
    let mut after = 0i64;
    loop {
        let page:Vec<(i64,Vec<u8>)>=c.prepare_cached("SELECT f.sequence,b.payload FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? AND f.sequence>? ORDER BY f.sequence LIMIT 128")?.query_map(params![run.to_string(),after],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<_,_>>()?;
        if page.is_empty() {
            break;
        }
        for (sequence, body) in page {
            let record: RecordedFact = serde_json::from_slice(&body)?;
            index_fact(c, &spec, &record, unsigned(sequence)?)?;
            after = sequence;
        }
    }
    Ok(())
}
