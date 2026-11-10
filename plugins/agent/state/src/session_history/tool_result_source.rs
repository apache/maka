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

//! Original scoped tool-result bytes and the canonical Accepted/ToolReturn boundary.
use super::{HistoryCut, SessionHistory, snapshot::Snapshot};
use maka_agent_facts::{
    cells::CellEvent,
    durable::{ContentRef, Fact, RunId, SCHEMA_VERSION},
    external_effects::ExternalEffectEvent,
    model::prompt_source::source::{
        self as pull, ByteCursor, ByteSource, ChargedBuffer, JsonSource, SourceBudget, SourceBytes,
        json::{self, JsonKind, JsonValue},
    },
};
use sha2::{Digest, Sha256};
use std::{io, ops::Range, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
enum Access {
    Live {
        history: SessionHistory,
        cut: HistoryCut,
        run: RunId,
    },
    Snapshot {
        snapshot: Snapshot,
        run: RunId,
    },
    Imported {
        snapshot: Snapshot,
        message_ordinal: u64,
    },
}
/// A native-authorized Root reader, not a capability reconstructed from a ref.
#[derive(Clone)]
pub struct ToolResultReader {
    access: Access,
    stop: CancellationToken,
}
pub enum ToolResultSource {
    Returned(ReturnedToolSource),
    External { body: JsonSource },
    Direct(JsonSource),
}
pub struct ReturnedToolSource {
    body: JsonSource,
    reader: Option<ToolResultReader>,
}
pub struct ImportedToolResult {
    pub call_id: pull::TextSource,
    pub name: pull::TextSource,
    pub result: ToolResultSource,
}

enum OutputSource {
    Inline(JsonSource),
    Operation {
        reply: JsonSource,
        reader: ToolResultReader,
    },
}

pub struct ToolResultFields {
    output: OutputSource,
    projection: Option<JsonValue>,
    is_error: Option<JsonValue>,
    cell_reader: Option<ToolResultReader>,
}

pub enum ToolProjectionSource {
    Text(JsonValue),
    Json(JsonProjectionSource),
    Content(JsonSource),
    Failure,
}

pub struct JsonProjectionSource(JsonProjection);

enum JsonProjection {
    Inline(JsonSource),
    FromOutput(JsonSource),
    FromOperation {
        reply: JsonSource,
        reader: ToolResultReader,
        part: OperationProjectionPart,
    },
}

enum OperationProjectionPart {
    Result,
    Receipt,
}

impl JsonProjectionSource {
    pub async fn value(self, budget: Arc<dyn SourceBudget>) -> io::Result<JsonSource> {
        match self.0 {
            JsonProjection::Inline(value) => Ok(value),
            JsonProjection::FromOutput(output) => {
                let (format, value) = output_fields(&output, &budget).await?;
                if json::text_eq(&format, "json", budget.clone()).await? {
                    Ok(value)
                } else if json::text_eq(&format, "operation", budget.clone()).await? {
                    Ok(
                        required(&value, &["receipt", "outcome", "result", "value"], &budget)
                            .await?
                            .source,
                    )
                } else {
                    Err(invalid("shared projection requires a returned JSON value"))
                }
            }
            JsonProjection::FromOperation {
                reply,
                reader,
                part,
            } => {
                let (reply, result) = reader.operation_source(reply, &budget).await?;
                match part {
                    OperationProjectionPart::Receipt => Ok(reply),
                    OperationProjectionPart::Result => {
                        let result = result.ok_or_else(|| {
                            invalid("shared projection has no original success value")
                        })?;
                        Ok(required(&result, &["value"], &budget).await?.source)
                    }
                }
            }
        }
    }
}

impl ToolProjectionSource {
    /// The archive codec consumes a tagged projection, never the return body.
    pub async fn into_json(self, budget: Arc<dyn SourceBudget>) -> io::Result<JsonSource> {
        let (prefix, value): (&'static [u8], _) = match self {
            Self::Text(value) => (b"{\"kind\":\"text\",\"text\":", value.source),
            Self::Json(value) => (b"{\"kind\":\"json\",\"value\":", value.value(budget).await?),
            Self::Content(parts) => (b"{\"kind\":\"content\",\"parts\":", parts),
            Self::Failure => return Ok(JsonSource::new(literal(b"{\"kind\":\"failure\"}"))),
        };
        joined_json(vec![literal(prefix), value.into_bytes(), literal(b"}")])
    }
}

impl ToolResultSource {
    pub async fn fields(
        &self,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<Option<ToolResultFields>> {
        match self {
            Self::Returned(returned) => Ok(Some(returned.fields(budget).await?)),
            Self::External { body } => Ok(Some(ToolResultFields::read(body, None, budget).await?)),
            Self::Direct(_) => Ok(None),
        }
    }

    pub async fn value(self, budget: Arc<dyn SourceBudget>) -> io::Result<JsonSource> {
        match self {
            Self::Direct(source) => Ok(source),
            source => {
                source
                    .fields(budget.clone())
                    .await?
                    .expect("returned result")
                    .value(budget)
                    .await
            }
        }
    }
}

impl ReturnedToolSource {
    pub async fn fields(&self, budget: Arc<dyn SourceBudget>) -> io::Result<ToolResultFields> {
        ToolResultFields::read(&self.body, self.reader.as_ref(), budget).await
    }
}

impl ToolResultFields {
    async fn read(
        body: &JsonSource,
        reader: Option<&ToolResultReader>,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<Self> {
        let [output, operation, projection, is_error, cell_error] = json::fields(
            body,
            &["output", "operation", "projection", "is_error", "isError"],
            budget,
        )
        .await?
        .try_into()
        .expect("one field per requested name");
        let output = match operation {
            Some(reply) => OutputSource::Operation {
                reply: reply.source,
                reader: reader
                    .cloned()
                    .ok_or_else(|| invalid("shared operation return has no original Run scope"))?,
            },
            None => OutputSource::Inline(present(output)?.source),
        };
        Ok(Self {
            output,
            projection: projection.filter(|value| value.kind != JsonKind::Null),
            is_error: is_error.or(cell_error),
            cell_reader: reader.cloned(),
        })
    }

    pub fn inline_output(&self) -> Option<&JsonSource> {
        match &self.output {
            OutputSource::Inline(output) => Some(output),
            OutputSource::Operation { .. } => None,
        }
    }

    pub async fn is_error(&self, budget: Arc<dyn SourceBudget>) -> io::Result<bool> {
        let value = self
            .is_error
            .as_ref()
            .ok_or_else(|| invalid("canonical tool result has no error flag"))?;
        json::bool_value(&value.source, budget).await
    }

    pub async fn projection(
        &self,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<Option<ToolProjectionSource>> {
        let Some(projection) = &self.projection else {
            return Ok(None);
        };
        let mut source = projection.source.clone();
        if let OutputSource::Operation { reply, reader } = &self.output {
            let [kind, inline] = json::fields(&source, &["kind", "projection"], budget.clone())
                .await?
                .try_into()
                .expect("one field per requested name");
            let kind = present(kind)?.text()?;
            if json::text_eq(&kind, "inline", budget.clone()).await? {
                source = present(inline)?.source;
            } else {
                let part = if json::text_eq(&kind, "result", budget.clone()).await? {
                    OperationProjectionPart::Result
                } else if json::text_eq(&kind, "receipt", budget.clone()).await? {
                    OperationProjectionPart::Receipt
                } else {
                    return Err(invalid("unsupported shared operation projection"));
                };
                return Ok(Some(ToolProjectionSource::Json(JsonProjectionSource(
                    JsonProjection::FromOperation {
                        reply: reply.clone(),
                        reader: reader.clone(),
                        part,
                    },
                ))));
            }
        }
        let [kind, text, value, parts] =
            json::fields(&source, &["kind", "text", "value", "parts"], budget.clone())
                .await?
                .try_into()
                .expect("one field per requested name");
        let kind = present(kind)?.text()?;
        let projection = if json::text_eq(&kind, "text", budget.clone()).await? {
            ToolProjectionSource::Text(present(text)?)
        } else if json::text_eq(&kind, "json", budget.clone()).await? {
            ToolProjectionSource::Json(JsonProjectionSource(JsonProjection::Inline(
                present(value)?.source,
            )))
        } else if json::text_eq(&kind, "content", budget.clone()).await? {
            ToolProjectionSource::Content(present(parts)?.source)
        } else if json::text_eq(&kind, "failure", budget.clone()).await? {
            ToolProjectionSource::Failure
        } else if json::text_eq(&kind, "from_output", budget.clone()).await? {
            let output = self
                .inline_output()
                .ok_or_else(|| invalid("shared projection requires an inline output"))?;
            ToolProjectionSource::Json(JsonProjectionSource(JsonProjection::FromOutput(
                output.clone(),
            )))
        } else {
            return Err(invalid("unsupported durable projection kind"));
        };
        Ok(Some(projection))
    }

    pub async fn value(&self, budget: Arc<dyn SourceBudget>) -> io::Result<JsonSource> {
        let output = match &self.output {
            OutputSource::Operation { reply, reader } => {
                return Ok(reader.operation_source(reply.clone(), &budget).await?.0);
            }
            OutputSource::Inline(output) => output,
        };
        let (format, value) = output_fields(output, &budget).await?;
        let Some(reader) = &self.cell_reader else {
            return Ok(value);
        };
        if !json::text_eq(&format, "cell", budget.clone()).await? {
            return Ok(value);
        }
        let [observation, state] = json::fields(&value, &["observation", "state"], budget.clone())
            .await?
            .try_into()
            .expect("one field per requested name");
        if observation.is_some() {
            return Ok(value);
        }
        let state = present(state)?.source;
        let kind = required(&state, &["kind"], &budget).await?.text()?;
        let observation = if json::text_eq(&kind, "completed", budget.clone()).await? {
            let reference =
                reference_value(required(&state, &["result"], &budget).await?, &budget).await?;
            reader.source(&reference).await?
        } else if json::text_eq(&kind, "interrupted", budget.clone()).await? {
            let reference =
                reference_value(required(&state, &["report"], &budget).await?, &budget).await?;
            let report = reader.cell_report(&reference, budget.clone()).await?;
            let cell = required(&value, &["cell"], &budget).await?.source;
            joined_json(vec![
                literal(b"{\"state\":\"interrupted\",\"cell_id\":"),
                cell.into_bytes(),
                literal(b",\"report\":"),
                report.into_bytes(),
                literal(b"}"),
            ])?
        } else {
            return Err(invalid("Cell result has no original observation"));
        };
        let end = value
            .bytes()
            .len()
            .and_then(|size| size.checked_sub(1))
            .ok_or_else(|| invalid("Cell reply has no bounded object bytes"))?;
        joined_json(vec![
            value.bytes().slice(0..end)?,
            literal(b",\"observation\":"),
            observation.into_bytes(),
            literal(b"}"),
        ])
    }
}
async fn output_fields(
    output: &JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> io::Result<(pull::TextSource, JsonSource)> {
    let [format, value] = json::fields(output, &["format", "value"], budget.clone())
        .await?
        .try_into()
        .expect("one field per requested name");
    Ok((present(format)?.text()?, present(value)?.source))
}

impl ToolResultReader {
    pub fn live(
        history: &SessionHistory,
        cut: &HistoryCut,
        run: RunId,
        stop: &CancellationToken,
    ) -> Self {
        Self {
            access: Access::Live {
                history: history.clone(),
                cut: cut.clone(),
                run,
            },
            stop: stop.clone(),
        }
    }
    pub fn snapshot(snapshot: &Snapshot, run: RunId, stop: &CancellationToken) -> Self {
        Self {
            access: Access::Snapshot {
                snapshot: snapshot.clone(),
                run,
            },
            stop: stop.clone(),
        }
    }
    pub fn imported(snapshot: &Snapshot, message_ordinal: u64, stop: &CancellationToken) -> Self {
        Self {
            access: Access::Imported {
                snapshot: snapshot.clone(),
                message_ordinal,
            },
            stop: stop.clone(),
        }
    }
    pub async fn source(&self, reference: &ContentRef) -> io::Result<JsonSource> {
        self.cancelled()?;
        // Prove exact Run or imported-message membership before exposing any
        // slice, including an empty source. Snapshot::chunk is closure-scoped.
        match &self.access {
            Access::Live { history, cut, run } => {
                history.with_content(cut, *run, reference, |_| Ok(())).await
            }
            Access::Snapshot { snapshot, run } => {
                snapshot.with_content(*run, reference, |_| Ok(())).await
            }
            Access::Imported {
                snapshot,
                message_ordinal,
            } => {
                snapshot
                    .with_imported_content(*message_ordinal, reference, |_| Ok(()))
                    .await
            }
        }
        .map_err(io::Error::other)?;
        Ok(self.scoped_source(reference))
    }
    fn scoped_source(&self, reference: &ContentRef) -> JsonSource {
        JsonSource::new(SourceBytes::Source(Arc::new(ScopedByteSource {
            reader: self.clone(),
            reference: reference.clone(),
            range: 0..reference.bytes,
        })))
    }
    pub async fn operation_reply(
        &self,
        reply: &maka_agent_facts::operation::RecordedOperationReply,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<JsonSource> {
        let encoded = serde_json::to_vec(reply).map_err(io::Error::other)?;
        let reply_source = JsonSource::new(SourceBytes::Inline(encoded.into()));
        if maka_agent_facts::operation::result_reference(reply).is_none() {
            return Ok(reply_source);
        }
        Ok(self.operation_source(reply_source, &budget).await?.0)
    }

    pub async fn cell_report(
        &self,
        reference: &ContentRef,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<JsonSource> {
        let report = self.source(reference).await?;
        let children_range = member_range(&report, "children", &budget)
            .await?
            .ok_or_else(|| invalid("Cell report has no children"))?;
        let children = report.slice(children_range.clone())?;
        let mut cursor = json::ObjectCursor::open(children.clone(), budget.clone()).await?;
        let mut parts = Vec::new();
        let mut position = 0;
        while let Some(entry) = cursor.next_spans().await? {
            let child = children.slice(entry.value_range.clone())?;
            let Some(reply_range) = member_range(&child, "reply", &budget).await? else {
                continue;
            };
            let reply = child.slice(reply_range.clone())?;
            let Some(result) = json::field(
                &reply,
                &["receipt", "outcome", "result", "kind"],
                budget.clone(),
            )
            .await?
            else {
                continue;
            };
            if !json::text_eq(&result.text()?, "referenced", budget.clone()).await? {
                continue;
            }
            let start = entry.value_range.start + reply_range.start;
            let end = entry.value_range.start + reply_range.end;
            parts.push(children.bytes().slice(position..start)?);
            parts.push(self.operation_source(reply, &budget).await?.0.into_bytes());
            position = end;
        }
        if parts.is_empty() {
            return Ok(report);
        }
        let children_len = children
            .bytes()
            .len()
            .ok_or_else(|| invalid("unbounded Cell children"))?;
        parts.push(children.bytes().slice(position..children_len)?);
        let report_len = report
            .bytes()
            .len()
            .ok_or_else(|| invalid("unbounded Cell report"))?;
        joined_json(vec![
            report.bytes().slice(0..children_range.start)?,
            joined_json(parts)?.into_bytes(),
            report.bytes().slice(children_range.end..report_len)?,
        ])
    }

    pub async fn cell_child_receipt(
        &self,
        cell: maka_agent_facts::cells::CellId,
        operation: uuid::Uuid,
        reply: &maka_agent_facts::operation::RecordedOperationReply,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<JsonSource> {
        let reply = self.operation_reply(reply, budget).await?;
        joined_json(vec![
            literal(b"{\"kind\":\"child_observed\",\"cell\":"),
            SourceBytes::Inline(serde_json::to_vec(&cell).map_err(io::Error::other)?.into()),
            literal(b",\"operation\":"),
            SourceBytes::Inline(
                serde_json::to_vec(&operation)
                    .map_err(io::Error::other)?
                    .into(),
            ),
            literal(b",\"reply\":"),
            reply.into_bytes(),
            literal(b"}"),
        ])
    }

    pub(super) async fn operation_source(
        &self,
        reply: JsonSource,
        budget: &Arc<dyn SourceBudget>,
    ) -> io::Result<(JsonSource, Option<JsonSource>)> {
        let Some(result) =
            json::field(&reply, &["receipt", "outcome", "result"], budget.clone()).await?
        else {
            return Ok((reply, None));
        };
        let kind = required(&result.source, &["kind"], budget).await?.text()?;
        if !json::text_eq(&kind, "referenced", budget.clone()).await? {
            return Ok((reply, Some(result.source)));
        }
        let reference = reference_value(
            required(&result.source, &["content"], budget).await?,
            budget,
        )
        .await?;
        let is_error = json::bool_value(
            &required(&result.source, &["is_error"], budget)
                .await?
                .source,
            budget.clone(),
        )
        .await?;
        let original = self.source(&reference).await?;
        let mut fields = json::ObjectCursor::open(original.clone(), budget.clone()).await?;
        let Some((kind, Some(0))) = fields.next_named(["kind"].into_iter()).await? else {
            return Err(invalid("original operation result has no kind"));
        };
        drop(fields);
        let expected = if is_error { "failure" } else { "success" };
        if !json::text_eq(&kind.value.text()?, expected, budget.clone()).await? {
            return Err(invalid(
                "original operation result differs from its receipt",
            ));
        }
        let reference = required(&reply, &["reference"], budget).await?.source;
        let cleanup = required(&reply, &["receipt", "cleanup"], budget)
            .await?
            .source;
        let literal = |bytes: &'static [u8]| SourceBytes::Inline(bytes.into());
        let parts = vec![
            literal(b"{\"reference\":"),
            reference.into_bytes(),
            literal(b",\"receipt\":{\"kind\":\"recorded\",\"outcome\":{\"kind\":\"returned\",\"result\":"),
            original.bytes().clone(),
            literal(b"},\"cleanup\":"),
            cleanup.into_bytes(),
            literal(b"}}"),
        ];
        Ok((joined_json(parts)?, Some(original)))
    }
    pub(in crate::session_history) async fn imported_result(
        snapshot: &Snapshot,
        message_ordinal: u64,
        part_ordinal: u64,
        budget: Arc<dyn SourceBudget>,
        stop: &CancellationToken,
    ) -> io::Result<ImportedToolResult> {
        let reader = Self::imported(snapshot, message_ordinal, stop);
        reader.cancelled()?;
        let reference = snapshot
            .imported_reference(message_ordinal)
            .await
            .map_err(io::Error::other)?;
        // This exact PK establishes the message; the authenticated parts array
        // establishes its part. A closure pin alone does not establish either.
        let message = reader.scoped_source(&reference);
        checked_hash(&message, &reference, budget.clone()).await?;
        let parts = required(&message, &["parts"], &budget).await?;
        let mut parts = json::ArrayCursor::open(parts.source, budget.clone()).await?;
        let mut index = 0u64;
        let reference = loop {
            let part = parts
                .next()
                .await?
                .ok_or_else(|| invalid("original imported part ordinal is absent"))?;
            if index == part_ordinal {
                break reference_value(part, &budget).await?;
            }
            index = index
                .checked_add(1)
                .ok_or_else(|| invalid("original imported part ordinal overflow"))?;
        };
        drop(parts);
        let part = reader.scoped_source(&reference);
        checked_hash(&part, &reference, budget.clone()).await?;
        let mut fields = json::fields(
            &part,
            &["kind", "call_id", "name", "result"],
            budget.clone(),
        )
        .await?
        .into_iter();
        let kind = present(fields.next().flatten())?.text()?;
        if !json::text_eq(&kind, "tool_return", budget.clone()).await? {
            return Err(invalid("original imported part is not a ToolReturn"));
        }
        let call_id = present(fields.next().flatten())?.text()?;
        let name = present(fields.next().flatten())?.text()?;
        let envelope = present(fields.next().flatten())?.source;
        Ok(ImportedToolResult {
            call_id,
            name,
            result: Self::returned(envelope, budget).await?,
        })
    }
    pub async fn result(
        &self,
        fact: &Fact,
        reference: &ContentRef,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<ToolResultSource> {
        let mut source = self.source(reference).await?;
        let mut returned = matches!(
            fact,
            Fact::LocalToolReturned { .. }
                | Fact::HostToolResultRecorded { .. }
                | Fact::Cell {
                    event: CellEvent::ChildResultRecorded { .. }
                        | CellEvent::LocalChildReturned { .. }
                }
        );
        if matches!(
            fact,
            Fact::ExternalEffect {
                event: ExternalEffectEvent::Returned { .. }
            }
        ) {
            let mut fields = json::fields(
                &source,
                &["kind", "diagnostic", "projection"],
                budget.clone(),
            )
            .await?
            .into_iter();
            let kind = present(fields.next().flatten())?.text()?;
            let diagnostic = fields.next().flatten();
            let projection = fields.next().flatten();
            if json::text_eq(&kind, "output", budget.clone()).await? {
                if present(projection)?.kind != JsonKind::Object {
                    return Err(invalid("canonical external output projection is invalid"));
                }
                return Ok(ToolResultSource::External { body: source });
            }
            if json::text_eq(&kind, "failure", budget).await? {
                let diagnostic = present(diagnostic)?;
                if diagnostic.kind != JsonKind::String {
                    return Err(invalid("canonical external failure diagnostic is invalid"));
                }
                return Ok(ToolResultSource::Direct(diagnostic.source));
            }
            return Err(invalid("unsupported canonical external return"));
        }
        if matches!(
            fact,
            Fact::Cell {
                event: CellEvent::Interrupted { .. }
            }
        ) {
            return Ok(ToolResultSource::Direct(
                self.cell_report(reference, budget).await?,
            ));
        }
        if matches!(fact, Fact::ToolResultAccepted { .. }) {
            let mut fields = json::fields(
                &source,
                &[
                    "kind",
                    "result",
                    "reply",
                    "output",
                    "diagnostic",
                    "evidence",
                ],
                budget.clone(),
            )
            .await?
            .into_iter();
            let kind = present(fields.next().flatten())?;
            let result = fields.next().flatten();
            let reply = fields.next().flatten();
            let output = fields.next().flatten();
            let diagnostic = fields.next().flatten();
            let evidence = fields.next().flatten();
            let kind = kind.text()?;
            if json::text_eq(&kind, "local", budget.clone()).await?
                || json::text_eq(&kind, "host", budget.clone()).await?
            {
                let reference = reference_value(present(result)?, &budget).await?;
                source = self.source(&reference).await?;
                returned = true;
            } else if json::text_eq(&kind, "observed_operation", budget.clone()).await? {
                source = self
                    .operation_source(present(reply)?.source, &budget)
                    .await?
                    .0;
            } else if json::text_eq(&kind, "operation", budget.clone()).await? {
                let result = present(result)?;
                if result.kind == JsonKind::Null {
                    source = present(reply)?.source;
                } else {
                    let reference = reference_value(result, &budget).await?;
                    source = self.source(&reference).await?;
                    returned = true;
                }
            } else if json::text_eq(&kind, "provider", budget.clone()).await? {
                source = present(output)?.source;
            } else if json::text_eq(&kind, "rejected", budget.clone()).await? {
                source = present(diagnostic)?.source;
            } else if json::text_eq(&kind, "recovered_cell", budget.clone()).await? {
                let evidence = present(evidence)?;
                let mut fields = json::fields(
                    &evidence.source,
                    &["kind", "result", "report"],
                    budget.clone(),
                )
                .await?
                .into_iter();
                let kind = present(fields.next().flatten())?.text()?;
                let result = fields.next().flatten();
                let report = fields.next().flatten();
                let reference = if json::text_eq(&kind, "completed", budget.clone()).await? {
                    reference_value(present(result)?, &budget).await?
                } else if json::text_eq(&kind, "interrupted", budget.clone()).await? {
                    reference_value(present(report)?, &budget).await?
                } else {
                    return Err(invalid("unsupported canonical recovered Cell evidence"));
                };
                source = if json::text_eq(&kind, "interrupted", budget.clone()).await? {
                    self.cell_report(&reference, budget.clone()).await?
                } else {
                    self.source(&reference).await?
                };
            } else if !json::text_eq(&kind, "risk_adjudicated", budget.clone()).await? {
                return Err(invalid("unsupported canonical accepted tool result"));
            }
        }
        if returned {
            return Self::read_return(source, Some(self.clone()), budget).await;
        }
        Ok(ToolResultSource::Direct(source))
    }

    /// Decode an already scoped ToolReturn without inventing a Run.
    pub async fn returned(
        envelope: JsonSource,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<ToolResultSource> {
        Self::read_return(envelope, None, budget).await
    }

    async fn read_return(
        envelope: JsonSource,
        reader: Option<Self>,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<ToolResultSource> {
        let [version, body] = json::fields(&envelope, &["schemaVersion", "body"], budget.clone())
            .await?
            .try_into()
            .expect("one field per requested name");
        if json::u64_value(&present(version)?.source, budget).await? != u64::from(SCHEMA_VERSION) {
            return Err(invalid("unsupported canonical ToolReturn schema"));
        }
        Ok(ToolResultSource::Returned(ReturnedToolSource {
            body: present(body)?.source,
            reader,
        }))
    }

    fn cancelled(&self) -> io::Result<()> {
        if self.stop.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "original source read cancelled",
            ));
        }
        Ok(())
    }
}
async fn checked_hash(
    source: &JsonSource,
    reference: &ContentRef,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<()> {
    reference.validate().map_err(invalid)?;
    let mut cursor = source.bytes().open(budget.clone());
    let mut buffer = budget.allocate(32 * 1024).await?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    loop {
        let read = cursor.read_chunk(buffer).await?;
        count = count
            .checked_add(read.bytes_read as u64)
            .ok_or_else(|| invalid("original imported source length overflow"))?;
        hash.update(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
    }
    if count != reference.bytes
        || format!("sha256:{}", hex::encode(hash.finalize())) != reference.digest
    {
        return Err(invalid("original imported source hash or length differs"));
    }
    Ok(())
}
fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
fn present(value: Option<JsonValue>) -> io::Result<JsonValue> {
    value.ok_or_else(|| invalid("canonical tool result field is missing"))
}
async fn required(
    source: &JsonSource,
    path: &[&str],
    budget: &Arc<dyn SourceBudget>,
) -> io::Result<JsonValue> {
    present(json::field(source, path, budget.clone()).await?)
}
async fn reference_value(
    value: JsonValue,
    budget: &Arc<dyn SourceBudget>,
) -> io::Result<ContentRef> {
    let mut fields = json::fields(&value.source, &["digest", "bytes"], budget.clone())
        .await?
        .into_iter();
    let digest = present(fields.next().flatten())?;
    let bytes = present(fields.next().flatten())?;
    let mut cursor = pull::text::bytes(digest.text()?, budget.clone()).open(budget.clone());
    let mut buffer = budget.allocate(71).await?;
    let mut digest = Vec::with_capacity(71);
    loop {
        let read = cursor.read_chunk(buffer).await?;
        // ContentRef's SHA-256 representation, not a generic JSON size limit.
        if digest.len() + read.bytes_read > 71 {
            return Err(invalid("invalid ContentRef SHA-256 digest length"));
        }
        digest.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
    }
    let reference = ContentRef {
        digest: String::from_utf8(digest).map_err(io::Error::other)?,
        bytes: json::u64_value(&bytes.source, budget.clone()).await?,
    };
    reference.validate().map_err(invalid)?;
    Ok(reference)
}
async fn member_range(
    source: &JsonSource,
    name: &str,
    budget: &Arc<dyn SourceBudget>,
) -> io::Result<Option<Range<u64>>> {
    let mut cursor = json::ObjectCursor::open(source.clone(), budget.clone()).await?;
    let mut range = None;
    while let Some((field, selected)) = cursor.next_named_spans([name].into_iter()).await? {
        if selected.is_some() {
            range = Some(field.value_range);
        }
    }
    Ok(range)
}

fn literal(bytes: &'static [u8]) -> SourceBytes {
    SourceBytes::Inline(bytes.into())
}

fn joined_json(parts: Vec<SourceBytes>) -> io::Result<JsonSource> {
    Ok(JsonSource::new(SourceBytes::Source(Arc::new(
        JoinedJson::new(parts)?,
    ))))
}

struct JoinedJson {
    parts: Vec<SourceBytes>,
    len: u64,
}
impl JoinedJson {
    fn new(parts: Vec<SourceBytes>) -> io::Result<Self> {
        let len = parts
            .iter()
            .try_fold(0u64, |len, part| len.checked_add(part.len()?))
            .ok_or_else(|| invalid("joined JSON length is unknown or overflows"))?;
        Ok(Self { parts, len })
    }
}
impl ByteSource for JoinedJson {
    fn len(&self) -> Option<u64> {
        Some(self.len)
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(JoinedCursor {
            parts: self.parts.clone().into_iter(),
            budget,
            active: None,
        })
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > self.len {
            return Err(invalid("joined JSON range exceeds original"));
        }
        let mut parts = Vec::new();
        let mut start = 0;
        for part in &self.parts {
            let end = start + part.len().expect("known reply component length");
            let lower = range.start.max(start);
            let upper = range.end.min(end);
            if lower < upper {
                parts.push(part.slice(lower - start..upper - start)?);
            }
            start = end;
        }
        Ok(Arc::new(Self {
            parts,
            len: range.end - range.start,
        }))
    }
}
struct JoinedCursor {
    parts: std::vec::IntoIter<SourceBytes>,
    budget: Arc<dyn SourceBudget>,
    active: Option<Box<dyn ByteCursor>>,
}
impl ByteCursor for JoinedCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> pull::ReadSource<'_> {
        Box::pin(async move {
            loop {
                let cursor = match &mut self.active {
                    Some(cursor) => cursor,
                    None => match self.parts.next() {
                        Some(part) => self.active.insert(part.open(self.budget.clone())),
                        None => {
                            return Ok(pull::SourceRead {
                                buffer,
                                bytes_read: 0,
                                eof: true,
                            });
                        }
                    },
                };
                let mut read = cursor.read_chunk(buffer).await?;
                if read.eof {
                    self.active = None;
                } else if read.bytes_read == 0 {
                    return Err(invalid("joined JSON component made no progress"));
                }
                if read.bytes_read != 0 {
                    read.eof = self.active.is_none() && self.parts.len() == 0;
                    return Ok(read);
                }
                buffer = read.buffer;
            }
        })
    }
}
#[derive(Clone)]
struct ScopedByteSource {
    reader: ToolResultReader,
    reference: ContentRef,
    range: Range<u64>,
}
impl ByteSource for ScopedByteSource {
    fn len(&self) -> Option<u64> {
        Some(self.range.end - self.range.start)
    }
    fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            source: self.clone(),
            offset: self.range.start,
        })
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > self.range.end - self.range.start {
            return Err(invalid("source range exceeds original"));
        }
        let mut source = self.clone();
        source.range = self.range.start + range.start..self.range.start + range.end;
        Ok(Arc::new(source))
    }
}
struct Cursor {
    source: ScopedByteSource,
    offset: u64,
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> pull::ReadSource<'_> {
        Box::pin(async move {
            self.source.reader.cancelled()?;
            let count = (self.source.range.end - self.offset)
                .min(buffer.as_ref().len() as u64)
                .min(u64::from(u32::MAX)) as u32;
            if count == 0 && self.offset < self.source.range.end {
                return Err(invalid("empty source work buffer"));
            }
            let bytes = if count == 0 {
                Vec::new()
            } else {
                match &self.source.reader.access {
                    Access::Live { history, cut, run } => {
                        history
                            .chunk(cut, *run, &self.source.reference, self.offset, count)
                            .await
                    }
                    Access::Snapshot { snapshot, .. } | Access::Imported { snapshot, .. } => {
                        snapshot
                            .chunk(&self.source.reference, self.offset, count)
                            .await
                    }
                }
                .map_err(io::Error::other)?
            };
            if bytes.len() != count as usize {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "original source length changed",
                ));
            }
            buffer.as_mut()[..bytes.len()].copy_from_slice(&bytes);
            self.offset += bytes.len() as u64;
            Ok(pull::SourceRead {
                buffer,
                bytes_read: bytes.len(),
                eof: self.offset == self.source.range.end,
            })
        })
    }
}
