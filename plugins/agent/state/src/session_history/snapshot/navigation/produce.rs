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
//! Deterministic document rendering; source bytes stay behind the shared reader.
use super::*;
use crate::{
    recall::document::{self, Rule},
    session_history::tool_result_source::{
        ToolProjectionSource, ToolResultFields, ToolResultReader, ToolResultSource,
    },
};
use maka_agent_facts::{
    cells::{CellEvent, CellId},
    executor::Output,
    history_snapshot::ImportedMessage,
    model::ModelPart,
    model::prompt_source::source::{
        self as pull, ChargedBuffer, JsonSource, SourceBudget, SourceBytes,
        json::{self, JsonKind, JsonStructureEvent, JsonValue},
    },
};
use serde::de::DeserializeOwned;
use std::{io, sync::Arc};

struct Budget(Arc<tokio::sync::Semaphore>);
impl SourceBudget for Budget {
    fn allocate(&self, n: usize) -> pull::Allocate<'_> {
        Box::pin(async move {
            let permit = self
                .0
                .clone()
                .try_acquire_many_owned(u32::try_from(n).map_err(io::Error::other)?)
                .map_err(|_| io::Error::other("navigation source work budget exhausted"))?;
            Ok(ChargedBuffer::new(vec![0; n], permit))
        })
    }
}
pub(super) struct Producer {
    snapshot: Snapshot,
    stop: CancellationToken,
    budget: Arc<dyn SourceBudget>,
    run: Option<RunSource>,
    imported: Option<(u64, ImportedMessage)>,
    catalog: CatalogBuilder,
    imported_preview: Option<String>,
    imported_after: Option<u64>,
    imported_page: std::vec::IntoIter<(u64, ImportedMessage)>,
    imported_eof: bool,
    imported_source: bool,
    model_start: Option<u64>,
}
impl Producer {
    pub async fn new(snapshot: Snapshot, stop: CancellationToken) -> Result<Self, StoreError> {
        let catalog = CatalogBuilder::new(&snapshot).await?;
        let header = snapshot.data.query(read::Header(snapshot.clone())).await?;
        Ok(Self {
            snapshot,
            stop,
            budget: Arc::new(Budget(Arc::new(tokio::sync::Semaphore::new(
                2 * 1024 * 1024,
            )))),
            run: None,
            imported: None,
            catalog,
            imported_preview: None,
            imported_after: None,
            imported_page: Vec::new().into_iter(),
            imported_eof: false,
            model_start: match &header.origin {
                Origin::Imported { model_start, .. } => *model_start,
                _ => None,
            },
            imported_source: matches!(header.origin, Origin::Imported { .. }),
        })
    }
    fn flush_imported(&mut self) -> Result<(), StoreError> {
        if let Some((ordinal, message)) = self.imported.take() {
            if self.model_start == Some(ordinal)
                && message.role == maka_agent_facts::history_snapshot::HistoricalRole::Context
            {
                self.imported_preview = None;
                return Ok(());
            }
            self.catalog
                .observe_imported(&message, self.imported_preview.take())?;
        }
        Ok(())
    }
    async fn next_imported(&mut self) -> Result<Option<(u64, ImportedMessage)>, StoreError> {
        loop {
            check(&self.stop)?;
            if let Some(item) = self.imported_page.next() {
                return Ok(Some(item));
            }
            if self.imported_eof {
                return Ok(None);
            }
            let page = self.snapshot.imported(self.imported_after, 256).await?;
            self.imported_eof = page.next.is_none();
            self.imported_after = page.next;
            self.imported_page = page.items.into_iter();
        }
    }
    async fn imported_message(&mut self, ordinal: u64) -> Result<(), StoreError> {
        self.flush_imported()?;
        while let Some((n, message)) = self.next_imported().await? {
            if n == ordinal {
                self.imported = Some((n, message));
                return Ok(());
            }
            if n > ordinal || !message.parts.is_empty() {
                return Err(invalid(
                    "imported message positions do not match original headers",
                ));
            }
            self.catalog.observe_imported(&message, None)?;
        }
        Err(invalid("original imported header unavailable"))
    }
    pub async fn finish(mut self) -> Result<CatalogBuilder, StoreError> {
        self.flush_imported()?;
        if self.imported_source {
            while let Some((_, message)) = self.next_imported().await? {
                if !message.parts.is_empty() {
                    return Err(invalid("imported message has no indexed original parts"));
                }
                self.catalog.observe_imported(&message, None)?;
            }
        }
        Ok(self.catalog)
    }
    pub async fn document(&mut self, row: &SnapshotPosition) -> Result<(), StoreError> {
        check(&self.stop)?;
        match row {
            SnapshotPosition::Canonical {
                run,
                sequence,
                fact,
                item_index,
                ..
            } => {
                if self.run.as_ref().is_none_or(|s| s.run != *run) {
                    self.run = Some(self.snapshot.run_source(*run).await?);
                }
                let spec = &self.run.as_ref().expect("original Run source loaded").spec;
                let item = self
                    .snapshot
                    .item(*sequence)
                    .await?
                    .ok_or_else(|| invalid("navigation original fact is unavailable"))?;
                if item.recorded.id != *fact || item.recorded.run != *run {
                    return Err(StoreError::EventConflict);
                }
                self.catalog.observe_canonical(spec, &item)?;
                let rule = document::rule(&item.recorded.fact)
                    .ok_or_else(|| invalid("source position has no Recall document rule"))?;
                let reader = ToolResultReader::snapshot(&self.snapshot, *run, &self.stop);
                let mut metadata = Metadata {
                    turn: Some(spec.turn_id.clone()),
                    imported_turn: None,
                    role: AuthorRole::Canonical(Role::Assistant),
                    origin: None,
                };
                if matches!(
                    rule,
                    Rule::Admission | Rule::Steering { .. } | Rule::ExternalSources
                ) {
                    let page = self
                        .snapshot
                        .sources(*sequence, item_index.checked_sub(1), 1)
                        .await?;
                    if let Some(source) =
                        page.sources.into_iter().find(|s| s.position == *item_index)
                    {
                        let json = reader.source(&source.source).await.map_err(io_error)?;
                        let origin = json::field(&json, &["origin"], self.budget.clone())
                            .await
                            .map_err(io_error)?;
                        metadata.role = AuthorRole::Canonical(Role::User);
                        metadata.origin = match origin {
                            Some(v) if v.kind != JsonKind::Null => {
                                Some(small(v, &self.budget).await?)
                            }
                            _ => None,
                        };
                        let mut doc =
                            Document::new(&self.snapshot, row, metadata, &self.stop).await?;
                        input(
                            &mut doc,
                            required(&json, &["content"], &self.budget).await?.source,
                            &self.budget,
                        )
                        .await?;
                        return doc.finish().await;
                    }
                    let input_source = match &rule {
                        Rule::Admission => {
                            let original = reader.source(&spec.input).await.map_err(io_error)?;
                            let kind = required(&original, &["kind"], &self.budget).await?;
                            if eq(&kind, "message", &self.budget).await? {
                                match json::field(
                                    &original,
                                    &["source_messages"],
                                    self.budget.clone(),
                                )
                                .await
                                .map_err(io_error)?
                                {
                                    Some(sources) => {
                                        array_item(sources.source, *item_index, &self.budget)
                                            .await?
                                    }
                                    None => None,
                                }
                            } else {
                                None
                            }
                        }
                        Rule::Steering { step, request } => {
                            let prepared = reader.source(request).await.map_err(io_error)?;
                            let actual: StepId = small(
                                required(&prepared, &["step"], &self.budget).await?,
                                &self.budget,
                            )
                            .await?;
                            if &actual != *step {
                                return Err(StoreError::EventConflict);
                            }
                            let item = array_item(
                                required(&prepared, &["steering"], &self.budget)
                                    .await?
                                    .source,
                                *item_index,
                                &self.budget,
                            )
                            .await?
                            .ok_or_else(|| invalid("frozen steering source missing"))?;
                            let reference: ContentRef = small(item, &self.budget).await?;
                            let original = reader.source(&reference).await.map_err(io_error)?;
                            Some(
                                json::inspect(&original, self.budget.clone())
                                    .await
                                    .map_err(io_error)?,
                            )
                        }
                        Rule::ExternalSources => {
                            return Err(invalid(
                                "consumed external source position has no frozen input",
                            ));
                        }
                        _ => unreachable!("input classifier already matched"),
                    };
                    if let Some(source) = input_source {
                        metadata.role = AuthorRole::Canonical(Role::User);
                        metadata.origin =
                            match json::field(&source.source, &["origin"], self.budget.clone())
                                .await
                                .map_err(io_error)?
                                .filter(|v| v.kind != JsonKind::Null)
                            {
                                Some(value) => Some(small(value, &self.budget).await?),
                                None => None,
                            };
                        let mut doc =
                            Document::new(&self.snapshot, row, metadata, &self.stop).await?;
                        input(
                            &mut doc,
                            required(&source.source, &["content"], &self.budget)
                                .await?
                                .source,
                            &self.budget,
                        )
                        .await?;
                        return doc.finish().await;
                    }
                }
                match &rule {
                    Rule::Admission => metadata.role = AuthorRole::Canonical(Role::User),
                    Rule::Returned { .. }
                    | Rule::ExternalReturned(_)
                    | Rule::Accepted(_)
                    | Rule::Cell(_)
                    | Rule::Receipt(_) => metadata.role = AuthorRole::Canonical(Role::ToolResult),
                    Rule::Failure(_) => metadata.role = AuthorRole::Canonical(Role::Failure),
                    Rule::Compaction(_) => metadata.role = AuthorRole::Canonical(Role::Compaction),
                    Rule::ExternalPrepared { .. } => {
                        metadata.role = AuthorRole::Canonical(Role::ToolCall)
                    }
                    Rule::Model(ModelPart::ToolCall { .. }) => {
                        metadata.role = AuthorRole::Canonical(Role::ToolCall)
                    }
                    Rule::Model(ModelPart::ToolResult { .. }) => {
                        metadata.role = AuthorRole::Canonical(Role::ToolResult)
                    }
                    Rule::External(Output::ToolStart { .. }) => {
                        metadata.role = AuthorRole::Canonical(Role::ToolCall)
                    }
                    Rule::External(Output::ToolProgress { .. } | Output::ToolResult { .. }) => {
                        metadata.role = AuthorRole::Canonical(Role::ToolResult)
                    }
                    _ => {}
                }
                let body = self
                    .snapshot
                    .data
                    .query(FactBody(self.snapshot.clone(), *sequence, *fact))
                    .await?;
                let raw = reader.source(&body).await.map_err(io_error)?;
                let mut doc = Document::new(&self.snapshot, row, metadata, &self.stop).await?;
                match rule {
                    Rule::Admission => {
                        let original = reader.source(&spec.input).await.map_err(io_error)?;
                        let kind = required(&original, &["kind"], &self.budget).await?;
                        if eq(&kind, "message", &self.budget).await? {
                            input(
                                &mut doc,
                                required(&original, &["content"], &self.budget)
                                    .await?
                                    .source,
                                &self.budget,
                            )
                            .await?;
                        } else if eq(&kind, "code", &self.budget).await? {
                            text_field(
                                &mut doc,
                                Field::Body,
                                false,
                                required(&original, &["source"], &self.budget).await?,
                                &self.budget,
                            )
                            .await?;
                        } else {
                            return Err(invalid(
                                "historical source marker cannot produce an input document",
                            ));
                        }
                    }
                    Rule::Model(part) => {
                        model(
                            &mut doc,
                            part,
                            required(&raw, &["fact", "part"], &self.budget)
                                .await?
                                .source,
                            &self.budget,
                        )
                        .await?
                    }
                    Rule::ExternalPrepared { descriptor, .. } => {
                        let source = reader.source(descriptor).await.map_err(io_error)?;
                        text_field(
                            &mut doc,
                            Field::ToolName,
                            false,
                            required(&source, &["name"], &self.budget).await?,
                            &self.budget,
                        )
                        .await?;
                        raw_field(
                            &mut doc,
                            Field::Arguments,
                            required(&source, &["input"], &self.budget).await?.source,
                            &self.budget,
                        )
                        .await?;
                    }
                    Rule::ExternalReturned(output) => {
                        let selected = reader
                            .result(&item.recorded.fact, output, self.budget.clone())
                            .await
                            .map_err(io_error)?;
                        match selected {
                            ToolResultSource::External { .. } => {
                                returned(&mut doc, selected, &self.budget, false).await?;
                            }
                            ToolResultSource::Direct(source) => {
                                let value = json::inspect(&source, self.budget.clone())
                                    .await
                                    .map_err(io_error)?;
                                text_field(&mut doc, Field::Result, false, value, &self.budget)
                                    .await?;
                            }
                            ToolResultSource::Returned(_) => {
                                return Err(invalid(
                                    "External return is not a ToolReturn envelope",
                                ));
                            }
                        }
                    }
                    Rule::Returned { result, receipt } => {
                        let selected = reader
                            .result(&item.recorded.fact, result, self.budget.clone())
                            .await
                            .map_err(io_error)?;
                        returned(&mut doc, selected, &self.budget, false).await?;
                        if let Some(receipt) = receipt {
                            literal(&mut doc, Field::Receipt, &serde_json::to_string(receipt)?)
                                .await?;
                        }
                    }
                    Rule::Accepted(result) => {
                        let original = reader.source(result).await.map_err(io_error)?;
                        let kind = required(&original, &["kind"], &self.budget).await?;
                        let selected = reader
                            .result(&item.recorded.fact, result, self.budget.clone())
                            .await
                            .map_err(io_error)?;
                        if eq(&kind, "operation", &self.budget).await? {
                            raw_field(
                                &mut doc,
                                Field::Result,
                                required(&original, &["reply"], &self.budget).await?.source,
                                &self.budget,
                            )
                            .await?;
                            if matches!(selected, ToolResultSource::Returned(_)) {
                                returned(&mut doc, selected, &self.budget, false).await?;
                            }
                        } else if let ToolResultSource::Returned(selected) = selected {
                            let fields = selected
                                .fields(self.budget.clone())
                                .await
                                .map_err(io_error)?;
                            if eq(&kind, "host", &self.budget).await? {
                                raw_field(
                                    &mut doc,
                                    Field::Result,
                                    fields.value(self.budget.clone()).await.map_err(io_error)?,
                                    &self.budget,
                                )
                                .await?;
                            }
                            returned_projection(&mut doc, &fields, &self.budget, false).await?;
                        } else if eq(&kind, "provider", &self.budget).await?
                            || eq(&kind, "observed_operation", &self.budget).await?
                        {
                            raw_field(
                                &mut doc,
                                Field::Result,
                                selected
                                    .value(self.budget.clone())
                                    .await
                                    .map_err(io_error)?,
                                &self.budget,
                            )
                            .await?;
                        } else if eq(&kind, "rejected", &self.budget).await? {
                            let source = selected
                                .value(self.budget.clone())
                                .await
                                .map_err(io_error)?;
                            text_field(
                                &mut doc,
                                Field::Result,
                                false,
                                json::inspect(&source, self.budget.clone())
                                    .await
                                    .map_err(io_error)?,
                                &self.budget,
                            )
                            .await?;
                        } else if eq(&kind, "recovered_cell", &self.budget).await? {
                            let cell: CellId = small(
                                required(&original, &["cell"], &self.budget).await?,
                                &self.budget,
                            )
                            .await?;
                            let source = selected
                                .value(self.budget.clone())
                                .await
                                .map_err(io_error)?;
                            let evidence =
                                required(&original, &["evidence", "kind"], &self.budget).await?;
                            final_cell(
                                &mut doc,
                                cell,
                                source,
                                eq(&evidence, "completed", &self.budget).await?,
                                &self.budget,
                            )
                            .await?;
                        }
                    }
                    Rule::Cell(event) => {
                        raw_field(
                            &mut doc,
                            Field::Receipt,
                            required(&raw, &["fact", "event"], &self.budget)
                                .await?
                                .source,
                            &self.budget,
                        )
                        .await?;
                        match event {
                            CellEvent::LocalChildReturned { result, .. }
                            | CellEvent::ChildResultRecorded { result, .. } => {
                                returned(
                                    &mut doc,
                                    reader
                                        .result(&item.recorded.fact, result, self.budget.clone())
                                        .await
                                        .map_err(io_error)?,
                                    &self.budget,
                                    true,
                                )
                                .await?
                            }
                            CellEvent::Started { source, .. } => {
                                let mut field = doc.field(Field::Body, false).await?;
                                append(
                                    &mut field,
                                    reader.source(source).await.map_err(io_error)?.into_bytes(),
                                    &self.budget,
                                )
                                .await?;
                                field.finish().await?;
                            }
                            CellEvent::ChildPrepared { input, .. }
                            | CellEvent::ChildApprovalRecorded { input, .. } => {
                                flatten_field(
                                    &mut doc,
                                    Field::Arguments,
                                    reader.source(input).await.map_err(io_error)?,
                                    &self.budget,
                                )
                                .await?
                            }
                            CellEvent::Completed { cell, result, .. } => {
                                final_cell(
                                    &mut doc,
                                    *cell,
                                    reader.source(result).await.map_err(io_error)?,
                                    true,
                                    &self.budget,
                                )
                                .await?
                            }
                            CellEvent::Interrupted { cell, report } => {
                                final_cell(
                                    &mut doc,
                                    *cell,
                                    reader.source(report).await.map_err(io_error)?,
                                    false,
                                    &self.budget,
                                )
                                .await?
                            }
                            CellEvent::SessionValuePublished { value, .. } => {
                                flatten_field(
                                    &mut doc,
                                    Field::Result,
                                    reader.source(value).await.map_err(io_error)?,
                                    &self.budget,
                                )
                                .await?
                            }
                            CellEvent::NotificationQueued { content, .. } => {
                                flatten_field(
                                    &mut doc,
                                    Field::Body,
                                    reader.source(content).await.map_err(io_error)?,
                                    &self.budget,
                                )
                                .await?
                            }
                            _ => {}
                        }
                    }
                    Rule::External(output) => match output {
                        Output::OutputDelta { text, .. } | Output::ThinkingDelta { text, .. } => {
                            let thinking = matches!(output, Output::ThinkingDelta { .. });
                            let mut field = doc
                                .field(
                                    if thinking {
                                        Field::Thinking
                                    } else {
                                        Field::Body
                                    },
                                    thinking,
                                )
                                .await?;
                            field.push(text.as_bytes()).await?;
                            field.finish().await?;
                        }
                        Output::ToolStart { name, .. } => {
                            literal(&mut doc, Field::ToolName, name).await?;
                            raw_field(
                                &mut doc,
                                Field::Arguments,
                                required(&raw, &["fact", "output", "input"], &self.budget)
                                    .await?
                                    .source,
                                &self.budget,
                            )
                            .await?;
                        }
                        Output::ToolProgress { text, .. } | Output::ToolResult { text, .. } => {
                            literal(&mut doc, Field::Result, text).await?
                        }
                        _ => return Err(invalid("external position has no document")),
                    },
                    Rule::Receipt(reply) => {
                        let source = required(&raw, &["fact", "reply"], &self.budget)
                            .await?
                            .source;
                        let source =
                            if maka_agent_facts::operation::result_reference(reply).is_some() {
                                reader
                                    .operation_source(source, &self.budget)
                                    .await
                                    .map_err(io_error)?
                                    .0
                            } else {
                                source
                            };
                        raw_field(&mut doc, Field::Receipt, source, &self.budget).await?
                    }
                    Rule::Failure(text) => literal(&mut doc, Field::FailureMessage, text).await?,
                    Rule::Compaction(baseline) => {
                        let compact = reader.source(baseline).await.map_err(io_error)?;
                        let summary =
                            required(&compact, &["checkpoint", "summary"], &self.budget).await?;
                        if let Some(text) =
                            json::field(&summary.source, &["text"], self.budget.clone())
                                .await
                                .map_err(io_error)?
                        {
                            text_field(&mut doc, Field::Body, false, text, &self.budget).await?;
                        }
                    }
                    Rule::Steering { .. } | Rule::ExternalSources => {
                        unreachable!("input source was handled before document construction")
                    }
                }
                doc.finish().await
            }
            SnapshotPosition::Imported {
                message_ordinal,
                part_ordinal,
                ..
            } => {
                if self
                    .imported
                    .as_ref()
                    .is_none_or(|(n, _)| n != message_ordinal)
                {
                    self.imported_message(*message_ordinal).await?;
                }
                let message = &self
                    .imported
                    .as_ref()
                    .expect("original imported header loaded")
                    .1;
                let reference = message
                    .parts
                    .get(
                        usize::try_from(*part_ordinal)
                            .map_err(|_| invalid("imported part ordinal overflow"))?,
                    )
                    .ok_or_else(|| invalid("imported navigation part unavailable"))?;
                let reader =
                    ToolResultReader::imported(&self.snapshot, *message_ordinal, &self.stop);
                let source = reader.source(reference).await.map_err(io_error)?;
                let kind = required(&source, &["kind"], &self.budget).await?;
                let metadata = Metadata {
                    turn: message.source_turn_id.clone(),
                    imported_turn: Some(message.turn_ordinal),
                    role: AuthorRole::Imported(message.role),
                    origin: None,
                };
                let mut doc = Document::new(&self.snapshot, row, metadata, &self.stop).await?;
                doc.preview_requested = true;
                if eq(&kind, "input", &self.budget).await? {
                    input(
                        &mut doc,
                        required(&source, &["content"], &self.budget).await?.source,
                        &self.budget,
                    )
                    .await?;
                } else if eq(&kind, "tool_return", &self.budget).await? {
                    returned(
                        &mut doc,
                        ToolResultReader::returned(
                            required(&source, &["result"], &self.budget).await?.source,
                            self.budget.clone(),
                        )
                        .await
                        .map_err(io_error)?,
                        &self.budget,
                        false,
                    )
                    .await?;
                } else if eq(&kind, "model", &self.budget).await? {
                    model_source(
                        &mut doc,
                        required(&source, &["part"], &self.budget).await?.source,
                        &self.budget,
                    )
                    .await?;
                } else {
                    return Err(invalid("unsupported normalized imported document kind"));
                }
                if let Some(preview) = doc.preview.take().filter(|s| !s.is_empty()) {
                    let pending = self.imported_preview.get_or_insert_with(String::new);
                    if !pending.is_empty() && pending.chars().count() < 160 {
                        pending.push('\n');
                    }
                    let left = 160usize.saturating_sub(pending.chars().count());
                    pending.extend(preview.chars().take(left));
                }
                doc.finish().await
            }
        }
    }
}
fn io_error(error: io::Error) -> StoreError {
    invalid(error.to_string())
}
async fn required(
    source: &JsonSource,
    path: &[&str],
    budget: &Arc<dyn SourceBudget>,
) -> Result<JsonValue, StoreError> {
    json::field(source, path, budget.clone())
        .await
        .map_err(io_error)?
        .ok_or_else(|| invalid("document source field missing"))
}
async fn eq(
    value: &JsonValue,
    text: &str,
    budget: &Arc<dyn SourceBudget>,
) -> Result<bool, StoreError> {
    json::text_eq(&value.text().map_err(io_error)?, text, budget.clone())
        .await
        .map_err(io_error)
}
async fn small<T: DeserializeOwned>(
    value: JsonValue,
    budget: &Arc<dyn SourceBudget>,
) -> Result<T, StoreError> {
    let mut cursor = value.source.into_bytes().open(budget.clone());
    let mut buffer = budget.allocate(CHUNK_BYTES).await.map_err(io_error)?;
    let mut bytes = Vec::new();
    loop {
        let read = cursor.read_chunk(buffer).await.map_err(io_error)?;
        bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
    }
    Ok(serde_json::from_slice(&bytes)?)
}
async fn append(
    field: &mut FieldWriter<'_>,
    source: SourceBytes,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(CHUNK_BYTES).await.map_err(io_error)?;
    loop {
        let read = cursor.read_chunk(buffer).await.map_err(io_error)?;
        field.push(&read.buffer.as_ref()[..read.bytes_read]).await?;
        buffer = read.buffer;
        if read.eof {
            return Ok(());
        }
    }
}
async fn literal(doc: &mut Document, kind: Field, text: &str) -> Result<(), StoreError> {
    let mut field = doc.field(kind, false).await?;
    field.push(text.as_bytes()).await?;
    field.finish().await
}
async fn raw_field(
    doc: &mut Document,
    kind: Field,
    source: JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    let mut field = doc.field(kind, false).await?;
    append(&mut field, source.into_bytes(), budget).await?;
    field.finish().await
}
async fn text_field(
    doc: &mut Document,
    kind: Field,
    internal: bool,
    text: JsonValue,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    let mut field = doc.field(kind, internal).await?;
    append(
        &mut field,
        pull::text::bytes(text.text().map_err(io_error)?, budget.clone()),
        budget,
    )
    .await?;
    field.finish().await
}
async fn flatten_field(
    doc: &mut Document,
    kind: Field,
    source: JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    let mut field = doc.field(kind, false).await?;
    flatten(&mut field, source, budget).await?;
    field.finish().await
}
async fn flatten(
    field: &mut FieldWriter<'_>,
    source: JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    let mut cursor = json::StructureCursor::open(source.clone(), budget.clone())
        .await
        .map_err(io_error)?;
    while let Some(event) = cursor.next().await.map_err(io_error)? {
        if let JsonStructureEvent::Value(value) = event {
            if let Some(range) = value.key_range {
                if field.bytes() > 0 {
                    field.push(b"\n").await?;
                }
                let text = JsonValue {
                    source: source.slice(range).map_err(io_error)?,
                    kind: JsonKind::String,
                };
                append(
                    field,
                    pull::text::bytes(text.text().map_err(io_error)?, budget.clone()),
                    budget,
                )
                .await?;
            }
            if let Some(end) = value.end {
                if value.kind == JsonKind::Null {
                    continue;
                }
                if field.bytes() > 0 {
                    field.push(b"\n").await?;
                }
                let source = source.slice(value.start..end).map_err(io_error)?;
                if value.kind == JsonKind::String {
                    let text = JsonValue {
                        source,
                        kind: JsonKind::String,
                    };
                    append(
                        field,
                        pull::text::bytes(text.text().map_err(io_error)?, budget.clone()),
                        budget,
                    )
                    .await?;
                } else {
                    append(field, source.into_bytes(), budget).await?;
                }
            }
        }
    }
    Ok(())
}
async fn input(
    doc: &mut Document,
    source: JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    if doc.preview_requested {
        doc.preview = Some(String::new());
    }
    let mut fields = json::fields(&source, &["display_text", "text"], budget.clone())
        .await
        .map_err(io_error)?
        .into_iter();
    let display = fields.next().flatten();
    let text = fields.next().flatten();
    let value = display
        .filter(|v| v.kind != JsonKind::Null)
        .or(text)
        .ok_or_else(|| invalid("input display text missing"))?;
    text_field(doc, Field::Body, false, value, budget).await?;
    // These are presentation-only tails: they were never searchable Body spans.
    for name in ["attachments", "directory_references"] {
        if doc.label_closed || doc.label.len() >= 96 {
            break;
        }
        let Some(items) = json::field(&source, &[name], budget.clone())
            .await
            .map_err(io_error)?
            .filter(|v| v.kind != JsonKind::Null)
        else {
            continue;
        };
        let mut cursor = json::ArrayCursor::open(items.source, budget.clone())
            .await
            .map_err(io_error)?;
        while !doc.label_closed && doc.label.len() < 96 {
            let Some(item) = cursor.next().await.map_err(io_error)? else {
                break;
            };
            let label = if name == "attachments" {
                #[derive(Deserialize)]
                struct AttachmentLabel {
                    name: String,
                    bytes: u64,
                }
                let value: AttachmentLabel = small(item, budget).await?;
                document::attachment_label(&value.name, value.bytes)
            } else {
                #[derive(Deserialize)]
                struct DirectoryLabel {
                    path: String,
                }
                let value: DirectoryLabel = small(item, budget).await?;
                document::directory_label(&value.path)
            };
            if doc.body_nonempty {
                doc.label_bytes("\n");
            }
            doc.label_bytes(&label);
        }
    }
    Ok(())
}
async fn model(
    doc: &mut Document,
    _part: &ModelPart,
    source: JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    model_source(doc, source, budget).await
}
async fn model_source(
    doc: &mut Document,
    source: JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    let kind = required(&source, &["kind"], budget).await?;
    if eq(&kind, "text", budget).await? {
        let thinking = eq(
            &required(&source, &["text_kind"], budget).await?,
            "thinking",
            budget,
        )
        .await?;
        if doc.preview_requested && !thinking {
            doc.preview = Some(String::new());
        }
        text_field(
            doc,
            if thinking {
                Field::Thinking
            } else {
                Field::Body
            },
            thinking,
            required(&source, &["text"], budget).await?,
            budget,
        )
        .await?;
    } else if eq(&kind, "tool_call", budget).await? {
        let call = required(&source, &["call"], budget).await?.source;
        text_field(
            doc,
            Field::ToolName,
            false,
            required(&call, &["name"], budget).await?,
            budget,
        )
        .await?;
        let input = required(&call, &["input"], budget).await?.source;
        let kind = required(&input, &["kind"], budget).await?;
        if eq(&kind, "json", budget).await? {
            raw_field(
                doc,
                Field::Arguments,
                required(&input, &["data"], budget).await?.source,
                budget,
            )
            .await?;
        } else if eq(&kind, "invalid_json", budget).await? {
            text_field(
                doc,
                Field::Arguments,
                false,
                required(&input, &["data", "raw"], budget).await?,
                budget,
            )
            .await?;
        } else {
            return Err(invalid("unsupported original tool input kind"));
        }
    } else if eq(&kind, "tool_result", budget).await? {
        raw_field(
            doc,
            Field::Result,
            required(&source, &["output"], budget).await?.source,
            budget,
        )
        .await?;
    } else if eq(&kind, "source", budget).await? {
        let original = required(&source, &["source"], budget).await?.source;
        let value: maka_agent_facts::model::ModelSource = small(
            json::inspect(&original, budget.clone())
                .await
                .map_err(io_error)?,
            budget,
        )
        .await?;
        let text = match value {
            maka_agent_facts::model::ModelSource::Url { url, title, .. } => {
                title.map_or_else(|| url.clone(), |title| format!("[{title}]({url})"))
            }
            maka_agent_facts::model::ModelSource::Document {
                title, filename, ..
            } => filename.map_or_else(|| title.clone(), |file| format!("{title} ({file})")),
        };
        literal(doc, Field::Body, &text).await?;
    } else {
        return Err(invalid("unsupported model document kind"));
    }
    Ok(())
}
async fn returned(
    doc: &mut Document,
    source: ToolResultSource,
    budget: &Arc<dyn SourceBudget>,
    child_output: bool,
) -> Result<(), StoreError> {
    let fields = source
        .fields(budget.clone())
        .await
        .map_err(io_error)?
        .ok_or_else(|| invalid("original returned document lacks a projection body"))?;
    returned_projection(doc, &fields, budget, child_output).await
}
async fn returned_projection(
    doc: &mut Document,
    fields: &ToolResultFields,
    budget: &Arc<dyn SourceBudget>,
    child_output: bool,
) -> Result<(), StoreError> {
    match fields.projection(budget.clone()).await.map_err(io_error)? {
        Some(ToolProjectionSource::Text(text)) => {
            text_field(doc, Field::Result, false, text, budget).await?
        }
        Some(ToolProjectionSource::Json(value)) => {
            flatten_field(
                doc,
                Field::Result,
                value.value(budget.clone()).await.map_err(io_error)?,
                budget,
            )
            .await?
        }
        Some(ToolProjectionSource::Content(parts)) => {
            let mut cursor = json::ArrayCursor::open(parts, budget.clone())
                .await
                .map_err(io_error)?;
            let mut field = doc.field(Field::Result, false).await?;
            let mut first = true;
            while let Some(part) = cursor.next().await.map_err(io_error)? {
                if eq(
                    &required(&part.source, &["kind"], budget).await?,
                    "text",
                    budget,
                )
                .await?
                {
                    if !first {
                        field.push(b"\n").await?;
                    }
                    first = false;
                    let text = required(&part.source, &["text"], budget).await?;
                    append(
                        &mut field,
                        pull::text::bytes(text.text().map_err(io_error)?, budget.clone()),
                        budget,
                    )
                    .await?;
                }
            }
            field.finish().await?;
        }
        Some(ToolProjectionSource::Failure) => {
            literal(
                doc,
                Field::Result,
                maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE,
            )
            .await?
        }
        None if child_output => {
            let output = fields
                .inline_output()
                .ok_or_else(|| invalid("Cell return has no inline output"))?;
            let format = required(output, &["format"], budget).await?;
            if eq(&format, "text", budget).await? {
                text_field(
                    doc,
                    Field::Result,
                    false,
                    required(output, &["value"], budget).await?,
                    budget,
                )
                .await?;
            } else if eq(&format, "json", budget).await? {
                raw_field(
                    doc,
                    Field::Result,
                    required(output, &["value"], budget).await?.source,
                    budget,
                )
                .await?;
            }
        }
        None => return Err(invalid("ordinary ToolReturn projection is missing or null")),
    }
    Ok(())
}
async fn final_cell(
    doc: &mut Document,
    cell: CellId,
    source: JsonSource,
    completed: bool,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    if completed {
        let id: CellId = small(required(&source, &["cell_id"], budget).await?, budget).await?;
        if id != cell {
            return Err(StoreError::EventConflict);
        }
        let content = required(&source, &["content"], budget).await?.source;
        cell_text(doc, content, budget).await?;
        flatten_field(
            doc,
            Field::Result,
            required(&source, &["result"], budget).await?.source,
            budget,
        )
        .await?;
    } else {
        let id: CellId = small(required(&source, &["cell"], budget).await?, budget).await?;
        if id != cell {
            return Err(StoreError::EventConflict);
        }
        text_field(
            doc,
            Field::Result,
            false,
            required(&source, &["diagnostic"], budget).await?,
            budget,
        )
        .await?;
        if let Some(prior) = json::field(&source, &["priorOutput"], budget.clone())
            .await
            .map_err(io_error)?
            .filter(|v| v.kind != JsonKind::Null)
        {
            cell_text(
                doc,
                required(&prior.source, &["content"], budget).await?.source,
                budget,
            )
            .await?;
        }
    }
    Ok(())
}
async fn cell_text(
    doc: &mut Document,
    source: JsonSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), StoreError> {
    let mut cursor = json::ArrayCursor::open(source, budget.clone())
        .await
        .map_err(io_error)?;
    let mut field = doc.field(Field::Result, false).await?;
    let mut first = true;
    while let Some(part) = cursor.next().await.map_err(io_error)? {
        if eq(
            &required(&part.source, &["kind"], budget).await?,
            "text",
            budget,
        )
        .await?
        {
            if !first {
                field.push(b"\n").await?;
            }
            first = false;
            let text = required(&part.source, &["text"], budget).await?;
            append(
                &mut field,
                pull::text::bytes(text.text().map_err(io_error)?, budget.clone()),
                budget,
            )
            .await?;
        }
    }
    field.finish().await
}
struct FactBody(Snapshot, u64, FactId);
impl Query for FactBody {
    type Output = ContentRef;
    fn execute(self, c: &Connection) -> Result<ContentRef, StoreError> {
        read::Header(self.0.clone()).execute(c)?;
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND sequence=?",params![self.0.id.to_string(),bind_u64(self.1)?],|r|r.get(0))?;
        let Entry::Fact { id, body, .. } = serde_json::from_str(&raw)? else {
            return Err(invalid("original fact entry kind differs"));
        };
        if id != self.2 {
            return Err(StoreError::EventConflict);
        }
        Ok(body)
    }
}

async fn array_item(
    source: JsonSource,
    ordinal: u64,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Option<JsonValue>, StoreError> {
    let mut cursor = json::ArrayCursor::open(source, budget.clone())
        .await
        .map_err(io_error)?;
    let mut index = 0u64;
    while let Some(value) = cursor.next().await.map_err(io_error)? {
        if index == ordinal {
            return Ok(Some(value));
        }
        index = index
            .checked_add(1)
            .ok_or_else(|| invalid("document source ordinal overflow"))?;
    }
    Ok(None)
}
