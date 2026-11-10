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
use super::document::{self, Rule, cell_text, field, input_message, json_text, projection};
use super::*;
use maka_agent_facts::{
    artifact::ToolReturn,
    executor::Output,
    input::RunInput,
    model::{ModelPart, TextKind, ToolInput},
    tool_output::{AcceptedToolResult, CellFinalEvidence, ReturnedToolResult, StoredToolResult},
};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

fn exact(c: &Connection, run: RunId, reference: &ContentRef) -> Result<Vec<u8>, StoreError> {
    crate::sql::owned_content(c, run, reference)
}
fn tool_return(
    c: &Connection,
    run: RunId,
    reference: &ContentRef,
) -> Result<ToolReturn<ReturnedToolResult>, StoreError> {
    let returned: ToolReturn<StoredToolResult> =
        serde_json::from_slice(&exact(c, run, reference)?)?;
    returned.validate().map_err(invalid)?;
    let body = match returned.body {
        StoredToolResult::Inline(body) => body,
        StoredToolResult::Operation(body) => {
            let reply = crate::operation::read_reply(c, run, &body.operation)?;
            body.resolve(reply).map_err(invalid)?
        }
    };
    Ok(ToolReturn {
        schema_version: returned.schema_version,
        artifacts: returned.artifacts,
        body,
    })
}

fn cell_final(
    c: &Connection,
    run: RunId,
    cell: maka_agent_facts::cells::CellId,
    evidence: CellFinalEvidence,
    message: &mut Message,
) -> Result<(), StoreError> {
    match evidence {
        CellFinalEvidence::Completed { result } => {
            let observation: maka_agent_facts::cells::CellObservation =
                serde_json::from_slice(&exact(c, run, &result)?)?;
            let maka_agent_facts::cells::CellObservation::Completed {
                cell_id,
                content,
                result,
            } = observation
            else {
                return Err(invalid(
                    "Cell completed reference is not its complete result",
                ));
            };
            if cell_id != cell {
                return Err(StoreError::EventConflict);
            }
            field(message, Field::Result, &cell_text(content), false);
            field(message, Field::Result, &json_text(&result), false);
        }
        CellFinalEvidence::Interrupted { report } => {
            let report: maka_agent_facts::cells::CellInterruption =
                serde_json::from_slice(&exact(c, run, &report)?)?;
            if report.cell != cell {
                return Err(StoreError::EventConflict);
            }
            field(message, Field::Result, &report.diagnostic, false);
            if let Some(prior) = report.prior_output {
                field(message, Field::Result, &cell_text(prior.content), false);
            }
        }
    }
    Ok(())
}

fn insert(c: &Connection, spec: &RunSpec, mut message: Message) -> Result<(), StoreError> {
    if message.fields.is_empty() {
        message.fields.push(FieldSpan {
            field: match message.role {
                Role::ToolResult => Field::Result,
                Role::Failure => Field::FailureMessage,
                _ => Field::Body,
            },
            start: 0,
            end: message.body.len(),
            internal: false,
        });
    }
    let owner = serde_json::to_string(&spec.owner)?;
    let seq = number(message.position.source_sequence)?;
    let ordinal = number(message.position.item_index)?;
    let previous:Option<i64>=c.query_row("SELECT id FROM agent_recall_messages WHERE owner=? AND session=? AND sequence=? AND ordinal=?",params![owner,spec.session_id,seq,ordinal],|r|r.get(0)).optional()?;
    let folded = fold(&message.body);
    if let Some(id) = previous {
        c.execute("DELETE FROM agent_recall_terms WHERE rowid=?", [id])?;
    }
    c.execute("INSERT INTO agent_recall_messages(owner,session,sequence,ordinal,run,turn,message,at,role,body,folded,attachments,references_json,fields_json,origin_json,internal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,session,sequence,ordinal) DO UPDATE SET message=excluded.message,body=excluded.body,folded=excluded.folded,attachments=excluded.attachments,references_json=excluded.references_json,fields_json=excluded.fields_json,origin_json=excluded.origin_json,internal=excluded.internal",params![owner,spec.session_id,seq,ordinal,message.run.to_string(),message.turn_id,message.message_id,number(message.timestamp)?,serde_json::to_string(&message.role)?,message.body,folded,serde_json::to_string(&message.attachments)?,serde_json::to_string(&message.references)?,serde_json::to_string(&message.fields)?,message.origin.map(|o|serde_json::to_string(&o)).transpose()?,message.fields.iter().all(|f|f.internal)])?;
    let id:i64=c.query_row("SELECT id FROM agent_recall_messages WHERE owner=? AND session=? AND sequence=? AND ordinal=?",params![owner,spec.session_id,seq,ordinal],|r|r.get(0))?;
    c.execute(
        "INSERT INTO agent_recall_terms(rowid,grams) VALUES(?,?)",
        params![id, terms::grams(&folded)],
    )?;
    Ok(())
}
fn project(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    if spec.schema_version != SCHEMA_VERSION
        || fact.schema_version != SCHEMA_VERSION
        || fact.at.0 < 0
    {
        return Err(invalid("unsupported Recall fact schema/time"));
    }
    let reference:ContentRef=c.query_row("SELECT x.content_sha256,length(x.payload) FROM agent_facts f JOIN contents x ON x.id=f.body_content_id WHERE f.id=? AND f.run=?",params![fact.id.to_string(),fact.run.to_string()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))) .map(|(digest,bytes)|Ok::<_,StoreError>(ContentRef{digest,bytes:unsigned(bytes)?}))??;
    let mut message = Message {
        message_id: fact.id.to_string(),
        position: RowPosition {
            source_sequence: sequence,
            item_index: 0,
        },
        run: fact.run,
        turn_id: spec.turn_id.clone(),
        timestamp: unsigned(fact.at.0)?,
        role: Role::Assistant,
        body: String::new(),
        attachments: vec![],
        references: vec![reference],
        fields: vec![],
        origin: None,
    };
    let Some(rule) = document::rule(&fact.fact) else {
        return Ok(());
    };
    match rule {
        Rule::Admission => {
            let input: RunInput = serde_json::from_slice(&exact(c, fact.run, &spec.input)?)?;
            match input {
                RunInput::Message {
                    content,
                    source_messages,
                    ..
                } => {
                    if source_messages.is_empty() {
                        let message_id = match &spec.trigger {
                            Trigger::Message { message_id } => message_id.clone(),
                            _ => fact.id.to_string(),
                        };
                        insert(
                            c,
                            spec,
                            input_message(
                                spec,
                                fact,
                                sequence,
                                0,
                                message_id.clone(),
                                content,
                                spec.input.clone(),
                            ),
                        )?;
                    } else {
                        for (ordinal, source) in source_messages.into_iter().enumerate() {
                            source.validate().map_err(invalid)?;
                            let mut indexed = input_message(
                                spec,
                                fact,
                                sequence,
                                u64::try_from(ordinal)
                                    .map_err(|_| invalid("Recall source ordinal overflow"))?,
                                source.message.message_id,
                                source.message.content,
                                spec.input.clone(),
                            );
                            indexed.origin = source.message.origin;
                            insert(c, spec, indexed)?;
                        }
                    }
                }
                RunInput::Code { source } => {
                    let mut row = message;
                    row.role = Role::User;
                    row.body = source;
                    row.references.push(spec.input.clone());
                    insert(c, spec, row)?;
                }
                RunInput::Continuation { .. }
                | RunInput::ContextCompact { .. }
                | RunInput::HistorySource { .. } => {}
            }
            return Ok(());
        }
        Rule::Steering { step, request } => {
            let request: RequestSpec = serde_json::from_slice(&exact(c, fact.run, request)?)?;
            if request.step != *step {
                return Err(StoreError::EventConflict);
            }
            for (ordinal, reference) in request.steering.into_iter().enumerate() {
                let source: maka_agent_facts::message::RootSourceMessage =
                    serde_json::from_slice(&exact(c, fact.run, &reference)?)?;
                source.validate().map_err(invalid)?;
                let mut row = input_message(
                    spec,
                    fact,
                    sequence,
                    u64::try_from(ordinal)
                        .map_err(|_| invalid("Recall steering ordinal overflow"))?,
                    source.message.message_id,
                    source.message.content,
                    reference,
                );
                row.origin = source.message.origin;
                insert(c, spec, row)?;
            }
            return Ok(());
        }
        Rule::Model(part) => match part {
            ModelPart::Text {
                text_kind, text, ..
            } => {
                message.body = text.to_string();
                message.fields.push(FieldSpan {
                    field: if *text_kind == TextKind::Thinking {
                        Field::Thinking
                    } else {
                        Field::Body
                    },
                    start: 0,
                    end: message.body.len(),
                    internal: *text_kind == TextKind::Thinking,
                });
            }
            ModelPart::Source { source } => {
                message.body = match source {
                    maka_agent_facts::model::ModelSource::Url { url, title, .. } => title
                        .as_ref()
                        .map_or_else(|| url.clone(), |title| format!("[{title}]({url})")),
                    maka_agent_facts::model::ModelSource::Document {
                        title, filename, ..
                    } => filename
                        .as_ref()
                        .map_or_else(|| title.clone(), |file| format!("{title} ({file})")),
                };
            }
            ModelPart::ToolCall { call } => {
                message.role = Role::ToolCall;
                field(&mut message, Field::ToolName, &call.name, false);
                let input = match &call.input {
                    ToolInput::Json(v) => serde_json::to_string(v)?,
                    ToolInput::InvalidJson { raw } => raw.clone(),
                };
                field(&mut message, Field::Arguments, &input, false);
            }
            ModelPart::ToolResult { output, .. } => {
                message.role = Role::ToolResult;
                message.body = serde_json::to_string(output)?
            }
        },
        Rule::ExternalPrepared { key, descriptor } => {
            message.role = Role::ToolCall;
            crate::sql::with_owned_content(c, fact.run, descriptor, |bytes| {
                document::external_prepared(bytes, fact.run, key, &mut message)
            })?;
            message.references.push(descriptor.clone());
        }
        Rule::ExternalReturned(output) => {
            message.role = Role::ToolResult;
            crate::sql::with_owned_content(c, fact.run, output, |bytes| {
                document::external_returned(bytes, &mut message)
            })?;
            message.references.push(output.clone());
        }
        Rule::Returned { result, receipt } => {
            let returned = tool_return(c, fact.run, result)?;
            message.role = Role::ToolResult;
            let text = projection(returned.body.projection);
            field(&mut message, Field::Result, &text, false);
            if let Some(reference) = receipt {
                field(
                    &mut message,
                    Field::Receipt,
                    &serde_json::to_string(reference)?,
                    false,
                );
            }
            message.references.push(result.clone());
            message
                .references
                .extend(returned.artifacts.into_iter().map(|a| a.payload));
        }
        Rule::Accepted(result) => {
            message.role = Role::ToolResult;
            message.references.push(result.clone());
            let accepted: AcceptedToolResult =
                serde_json::from_slice(&exact(c, fact.run, result)?)?;
            match accepted {
                AcceptedToolResult::RecoveredCell { cell, evidence } => {
                    message.references.push(match &evidence {
                        CellFinalEvidence::Completed { result } => result.clone(),
                        CellFinalEvidence::Interrupted { report } => report.clone(),
                    });
                    cell_final(c, fact.run, cell, evidence, &mut message)?;
                }
                AcceptedToolResult::Local { result } => {
                    let returned = tool_return(c, fact.run, &result)?;
                    returned
                        .body
                        .projection
                        .validate(&spec.session_id)
                        .map_err(invalid)?;
                    message.body = projection(returned.body.projection);
                    message.references.push(result);
                    message
                        .references
                        .extend(returned.artifacts.into_iter().map(|a| a.payload));
                }
                AcceptedToolResult::Provider { output, .. } => {
                    message.body = serde_json::to_string(&output)?
                }
                AcceptedToolResult::Rejected { diagnostic } => message.body = diagnostic,
                AcceptedToolResult::Host { result } => {
                    let returned = tool_return(c, fact.run, &result)?;
                    let maka_agent_facts::tool_output::ToolOutput::Operation(reply) =
                        returned.body.output
                    else {
                        return Err(invalid(
                            "host tool result has no original operation receipt",
                        ));
                    };
                    returned
                        .body
                        .projection
                        .validate(&spec.session_id)
                        .map_err(invalid)?;
                    field(
                        &mut message,
                        Field::Result,
                        &serde_json::to_string(&reply)?,
                        false,
                    );
                    field(
                        &mut message,
                        Field::Result,
                        &projection(returned.body.projection),
                        false,
                    );
                    message.references.push(result);
                    message
                        .references
                        .extend(returned.artifacts.into_iter().map(|a| a.payload));
                }
                AcceptedToolResult::ObservedOperation { reply } => {
                    let reply = crate::operation::read_reply(c, fact.run, &reply)?;
                    field(
                        &mut message,
                        Field::Result,
                        &serde_json::to_string(&reply)?,
                        false,
                    );
                }
                AcceptedToolResult::Operation { reply, result } => {
                    field(
                        &mut message,
                        Field::Result,
                        &serde_json::to_string(&reply)?,
                        false,
                    );
                    if let Some(result) = result {
                        let returned = tool_return(c, fact.run, &result)?;
                        returned
                            .body
                            .projection
                            .validate(&spec.session_id)
                            .map_err(invalid)?;
                        field(
                            &mut message,
                            Field::Result,
                            &projection(returned.body.projection),
                            false,
                        );
                        message.references.push(result);
                        message
                            .references
                            .extend(returned.artifacts.into_iter().map(|a| a.payload));
                    }
                }
                AcceptedToolResult::RiskAdjudicated { .. } => {}
            }
        }
        Rule::External(output) => match output {
            Output::OutputDelta { text, .. } | Output::ThinkingDelta { text, .. } => {
                message.body = text.clone();
                let thinking = matches!(output, Output::ThinkingDelta { .. });
                message.fields.push(FieldSpan {
                    field: if thinking {
                        Field::Thinking
                    } else {
                        Field::Body
                    },
                    start: 0,
                    end: message.body.len(),
                    internal: thinking,
                });
            }
            Output::ToolStart { name, input, .. } => {
                message.role = Role::ToolCall;
                field(&mut message, Field::ToolName, name, false);
                field(
                    &mut message,
                    Field::Arguments,
                    &serde_json::to_string(input)?,
                    false,
                )
            }
            Output::ToolProgress { text, .. } | Output::ToolResult { text, .. } => {
                message.role = Role::ToolResult;
                message.body = text.clone()
            }
            _ => return Ok(()),
        },
        Rule::Cell(event) => {
            message.role = Role::ToolResult;
            field(
                &mut message,
                Field::Receipt,
                &serde_json::to_string(event)?,
                false,
            );
            message
                .references
                .extend(event.content_refs().into_iter().cloned());
            match event {
                maka_agent_facts::cells::CellEvent::LocalChildReturned { result, .. }
                | maka_agent_facts::cells::CellEvent::ChildResultRecorded { result, .. } => {
                    let returned: ToolReturn<maka_agent_facts::cells::CellReturnedResult> =
                        serde_json::from_slice(&exact(c, fact.run, result)?)?;
                    returned.validate().map_err(invalid)?;
                    if let Some(value) = returned.body.projection {
                        value.validate(&spec.session_id).map_err(invalid)?;
                        field(&mut message, Field::Result, &projection(value), false);
                    } else {
                        match returned.body.output {
                            maka_agent_facts::tool_output::ToolOutput::Text(text) => {
                                field(&mut message, Field::Result, &text, false)
                            }
                            maka_agent_facts::tool_output::ToolOutput::Json(value) => field(
                                &mut message,
                                Field::Result,
                                &serde_json::to_string(&value)?,
                                false,
                            ),
                            _ => {}
                        }
                    }
                    message
                        .references
                        .extend(returned.artifacts.into_iter().map(|a| a.payload));
                }
                maka_agent_facts::cells::CellEvent::Started { source, .. } => {
                    let source = String::from_utf8(exact(c, fact.run, source)?)
                        .map_err(|error| invalid(format!("Cell source is not UTF-8: {error}")))?;
                    field(&mut message, Field::Body, &source, false);
                }
                maka_agent_facts::cells::CellEvent::ChildPrepared { input, .. }
                | maka_agent_facts::cells::CellEvent::ChildApprovalRecorded { input, .. } => {
                    let input: Value = serde_json::from_slice(&exact(c, fact.run, input)?)?;
                    field(&mut message, Field::Arguments, &json_text(&input), false);
                }
                maka_agent_facts::cells::CellEvent::Completed { cell, result, .. } => {
                    cell_final(
                        c,
                        fact.run,
                        *cell,
                        CellFinalEvidence::Completed {
                            result: result.clone(),
                        },
                        &mut message,
                    )?;
                }
                maka_agent_facts::cells::CellEvent::Interrupted { cell, report } => {
                    cell_final(
                        c,
                        fact.run,
                        *cell,
                        CellFinalEvidence::Interrupted {
                            report: report.clone(),
                        },
                        &mut message,
                    )?;
                }
                maka_agent_facts::cells::CellEvent::SessionValuePublished { value, .. } => {
                    let value: Value = serde_json::from_slice(&exact(c, fact.run, value)?)?;
                    field(&mut message, Field::Result, &json_text(&value), false);
                }
                maka_agent_facts::cells::CellEvent::NotificationQueued { content, .. } => {
                    let value: Value = serde_json::from_slice(&exact(c, fact.run, content)?)?;
                    field(&mut message, Field::Body, &json_text(&value), false);
                }
                _ => {}
            }
        }
        Rule::Receipt(reply) => {
            message.role = Role::ToolResult;
            let reply = crate::operation::read_reply(c, fact.run, reply)?;
            field(
                &mut message,
                Field::Receipt,
                &serde_json::to_string(&reply)?,
                false,
            );
        }
        Rule::Failure(diagnostic) => {
            message.role = Role::Failure;
            message.body = diagnostic.to_owned()
        }
        Rule::Compaction(baseline) => {
            let compact: maka_agent_facts::context::CompactedContext =
                serde_json::from_slice(&exact(c, fact.run, baseline)?)?;
            compact.validate().map_err(invalid)?;
            message.role = Role::Compaction;
            message.references.push(baseline.clone());
            message.references.push(compact.source_capture);
            if let maka_agent_facts::context::CheckpointContent::Text(text) =
                compact.checkpoint.summary
            {
                message.body = text;
            }
        }
        Rule::ExternalSources => return Ok(()),
    }
    insert(c, spec, message)
}
fn head(c: &Connection, spec: &RunSpec, sequence: u64) -> Result<(), StoreError> {
    let owner = serde_json::to_string(&spec.owner)?;
    let digest:String=c.query_row("SELECT prefix_digest FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",params![owner,spec.session_id,number(sequence)?],|r|r.get(0))?;
    c.execute("INSERT INTO agent_recall_heads(owner,session,sequence,digest) VALUES(?,?,?,?) ON CONFLICT(owner,session) DO UPDATE SET sequence=excluded.sequence,digest=excluded.digest WHERE excluded.sequence>=agent_recall_heads.sequence",params![owner,spec.session_id,number(sequence)?,digest])?;
    Ok(())
}
pub(crate) fn index_fact(
    c: &Connection,
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
) -> Result<(), StoreError> {
    match project(c, spec, fact, sequence) {
        Ok(()) => {}
        Err(error)
            if matches!(
                error,
                StoreError::Json(_) | StoreError::InvalidTransition(_)
            ) =>
        {
            c.execute("INSERT INTO agent_recall_gaps(owner,session,sequence,reason) VALUES(?,?,?,?) ON CONFLICT(owner,session,sequence) DO UPDATE SET reason=excluded.reason",params![serde_json::to_string(&spec.owner)?,spec.session_id,number(sequence)?,error.to_string()])?;
        }
        Err(e) => return Err(e),
    }
    head(c, spec, sequence)
}
pub(crate) fn index_sources(
    c: &Connection,
    spec: &RunSpec,
    sequence: u64,
) -> Result<(), StoreError> {
    let kind: String = c.query_row(
        "SELECT kind FROM agent_session_history WHERE owner=? AND session=? AND sequence=?",
        params![
            serde_json::to_string(&spec.owner)?,
            spec.session_id,
            number(sequence)?
        ],
        |r| r.get(0),
    )?;
    if !matches!(
        kind.as_str(),
        "run_admitted" | "step_prepared" | "external_task_prepared"
    ) {
        return Ok(());
    }
    let cut = crate::session_history::capture_at(c, &spec.owner, &spec.session_id, Some(sequence))?;
    let bytes:Vec<u8>=c.query_row("SELECT x.payload FROM agent_facts f JOIN contents x ON x.id=f.body_content_id WHERE f.sequence=?",[number(sequence)?],|r|r.get(0))?;
    let fact: RecordedFact = serde_json::from_slice(&bytes)?;
    let mut after = None;
    loop {
        let page = crate::session_history::sources_at(
            c,
            &spec.owner,
            &spec.session_id,
            &cut,
            sequence,
            after,
            128,
        )?;
        for source in page.sources {
            let reference = source.request.source.clone();
            let bytes = crate::session_history::source_content_at(
                c,
                &spec.owner,
                &spec.session_id,
                &cut,
                sequence,
                source.position,
                &reference,
            )?;
            let message: maka_agent_facts::message::RootSourceMessage =
                serde_json::from_slice(&bytes)?;
            message.validate().map_err(invalid)?;
            let mut indexed = input_message(
                spec,
                &fact,
                sequence,
                source.position,
                message.message.message_id,
                message.message.content,
                reference,
            );
            indexed.origin = message.message.origin;
            insert(c, spec, indexed)?;
        }
        if let Some(next) = page.next {
            after = Some(next);
        } else {
            break;
        }
    }
    head(c, spec, sequence)
}
pub(super) fn rebuild(
    c: &Connection,
    store: &RecallStore,
    session: &str,
) -> Result<(), StoreError> {
    store.session(session)?;
    let owner = store.key()?;
    c.execute("DELETE FROM agent_recall_terms WHERE rowid IN(SELECT id FROM agent_recall_messages WHERE owner=? AND session=?)",params![owner,session])?;
    for table in [
        "agent_recall_messages",
        "agent_recall_heads",
        "agent_recall_gaps",
    ] {
        c.execute(
            &format!("DELETE FROM {table} WHERE owner=? AND session=?"),
            params![owner, session],
        )?;
    }
    let mut after = 0i64;
    let mut cached_spec: Option<(i64, RunSpec)> = None;
    loop {
        let headers:Vec<(i64,i64,i64)>=c.prepare_cached("SELECT f.sequence,f.body_content_id,r.spec_content_id FROM agent_facts f JOIN agent_run_specs r ON r.run=f.run WHERE r.owner=? AND r.session=? AND f.sequence>? ORDER BY f.sequence LIMIT 128")?.query_map(params![owner,session,after],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
        if headers.is_empty() {
            break;
        }
        for (sequence, body, spec_id) in headers {
            if cached_spec.as_ref().is_none_or(|(id, _)| *id != spec_id) {
                let bytes: Vec<u8> =
                    c.query_row("SELECT payload FROM contents WHERE id=?", [spec_id], |r| {
                        r.get(0)
                    })?;
                let spec: RunSpec = serde_json::from_slice(&bytes)?;
                if spec.owner != store.owner || spec.session_id != session {
                    return Err(StoreError::EventConflict);
                }
                cached_spec = Some((spec_id, spec));
            }
            let spec = &cached_spec.as_ref().expect("loaded canonical RunSpec").1;
            let bytes: Vec<u8> =
                c.query_row("SELECT payload FROM contents WHERE id=?", [body], |r| {
                    r.get(0)
                })?;
            let fact: RecordedFact = serde_json::from_slice(&bytes)?;
            index_fact(c, spec, &fact, unsigned(sequence)?)?;
            index_sources(c, spec, unsigned(sequence)?)?;
            after = sequence;
        }
    }
    Ok(())
}
