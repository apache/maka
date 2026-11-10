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
    Returned {
        envelope: JsonSource,
        body: JsonSource,
    },
    External {
        body: JsonSource,
    },
    Direct(JsonSource),
}
pub struct ImportedToolResult {
    pub call_id: pull::TextSource,
    pub name: pull::TextSource,
    pub result: ToolResultSource,
}
impl ToolResultSource {
    pub fn returned(self) -> Option<JsonSource> {
        match self {
            Self::Returned { envelope, .. } => Some(envelope),
            Self::External { .. } | Self::Direct(_) => None,
        }
    }
    pub async fn value(self, budget: Arc<dyn SourceBudget>) -> io::Result<JsonSource> {
        match self {
            Self::Returned { body, .. } | Self::External { body } => {
                Ok(required(&body, &["output", "value"], &budget).await?.source)
            }
            Self::Direct(source) => Ok(source),
        }
    }
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
            if json::text_eq(&kind, "local", budget.clone()).await? {
                let reference = reference_value(present(result)?, &budget).await?;
                source = self.source(&reference).await?;
                returned = true;
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
                // Original CellObservation/report, never a fabricated ToolReturn
                // or a projection inferred from its child outputs.
                source = self.source(&reference).await?;
            } else if !json::text_eq(&kind, "risk_adjudicated", budget.clone()).await? {
                return Err(invalid("unsupported canonical accepted tool result"));
            }
        }
        if returned {
            return Self::returned(source, budget).await;
        }
        Ok(ToolResultSource::Direct(source))
    }
    /// Decode an already scoped ToolReturn, including an imported part with no
    /// execution Fact. This never invents a Run or resolves a bare reference.
    pub async fn returned(
        envelope: JsonSource,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<ToolResultSource> {
        let body = Self::returned_body(&envelope, budget).await?;
        Ok(ToolResultSource::Returned { envelope, body })
    }
    async fn returned_body(
        envelope: &JsonSource,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<JsonSource> {
        let mut fields = json::fields(envelope, &["schemaVersion", "body"], budget.clone())
            .await?
            .into_iter();
        let version = present(fields.next().flatten())?;
        if json::u64_value(&version.source, budget).await? != u64::from(SCHEMA_VERSION) {
            return Err(invalid("unsupported canonical ToolReturn schema"));
        }
        Ok(present(fields.next().flatten())?.source)
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
