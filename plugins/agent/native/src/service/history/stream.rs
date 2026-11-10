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

//! Read the original scoped BLOB through the shared pull-JSON source adapters.
use super::*;
use maka_agent_facts::model::prompt_source::source::{
    self as pull, ChargedBuffer, JsonSource, SourceBudget, SourceBytes,
    json::{self, JsonKind, JsonValue},
};
use maka_agent_state::session_history::tool_result_source::ToolResultReader;
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

struct Budget(Arc<tokio::sync::Semaphore>);
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> pull::Allocate<'_> {
        Box::pin(async move {
            let count = u32::try_from(minimum).map_err(io::Error::other)?;
            let permit = self
                .0
                .clone()
                .try_acquire_many_owned(count)
                .map_err(|_| io::Error::other("history source work budget exhausted"))?;
            Ok(ChargedBuffer::new(vec![0; minimum], permit))
        })
    }
}
async fn required(
    source: &JsonSource,
    path: &[&str],
    budget: &Arc<dyn SourceBudget>,
) -> Result<JsonValue, String> {
    json::field(source, path, budget.clone())
        .await
        .map_err(|e| e.to_string())?
        .ok_or("agent_history_field_invalid".into())
}
async fn small<T: DeserializeOwned>(
    value: JsonValue,
    budget: &Arc<dyn SourceBudget>,
) -> Result<T, String> {
    let bytes = collect(value.source.into_bytes(), budget, 1024).await?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
async fn collect(
    source: SourceBytes,
    budget: &Arc<dyn SourceBudget>,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut reader = source.open(budget.clone());
    let mut buffer = budget
        .allocate(32 * 1024)
        .await
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    loop {
        let read = reader.read_chunk(buffer).await.map_err(|e| e.to_string())?;
        if bytes.len() + read.bytes_read > maximum {
            return Err("agent_history_descriptor_too_large".into());
        }
        bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            return Ok(bytes);
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Source reading binds immutable content identity, presentation mode, cancellation and source budget"
)]
async fn content_source(
    data: &data::DataSource,
    run: RunId,
    fact: &Fact,
    reference: &ContentRef,
    path: Option<&[wire::SourceSegment]>,
    display: bool,
    stop: &CancellationToken,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(wire::SourceFormat, SourceBytes), String> {
    let reader = data::tool_reader(data, run, stop);
    if matches!(
        fact,
        Fact::Cell {
            event: maka_agent_facts::cells::CellEvent::Started { .. }
        }
    ) {
        if path.is_some_and(|path| !path.is_empty()) {
            return Err("agent_history_path_invalid".into());
        }
        return Ok((
            wire::SourceFormat::Text,
            reader
                .source(reference)
                .await
                .map_err(|e| e.to_string())?
                .into_bytes(),
        ));
    }
    let selected = reader
        .result(fact, reference, budget.clone())
        .await
        .map_err(|error| error.to_string())?;
    let source = result_value(
        selected,
        display,
        matches!(
            fact,
            Fact::Cell {
                event: maka_agent_facts::cells::CellEvent::LocalChildReturned { .. }
                    | maka_agent_facts::cells::CellEvent::ChildResultRecorded { .. }
            }
        ),
        budget,
    )
    .await?;
    selected_json(source, path, budget).await
}

pub(super) async fn result_value(
    selected: maka_agent_state::session_history::tool_result_source::ToolResultSource,
    display: bool,
    optional_projection: bool,
    budget: &Arc<dyn SourceBudget>,
) -> Result<JsonSource, String> {
    use maka_agent_state::session_history::tool_result_source::ToolResultSource;
    if display
        && let ToolResultSource::Returned { body, .. } | ToolResultSource::External { body } =
            &selected
    {
        let projection = json::field(body, &["projection"], budget.clone())
            .await
            .map_err(|error| error.to_string())?;
        match projection {
            Some(projection) if projection.kind != JsonKind::Null => {
                let kind: String = small(
                    required(&projection.source, &["kind"], budget).await?,
                    budget,
                )
                .await?;
                return match kind.as_str() {
                    "text" => Ok(required(&projection.source, &["text"], budget)
                        .await?
                        .source),
                    "json" => Ok(required(&projection.source, &["value"], budget)
                        .await?
                        .source),
                    "content" => Ok(required(&projection.source, &["parts"], budget)
                        .await?
                        .source),
                    "failure" => Ok(JsonSource::new(SourceBytes::Inline(
                        serde_json::to_vec(
                            maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE,
                        )
                        .map_err(|error| error.to_string())?
                        .into(),
                    ))),
                    _ => Err("agent_history_projection_codec_invalid".into()),
                };
            }
            _ if optional_projection => {}
            _ => return Err("agent_history_projection_missing".into()),
        }
    }
    selected
        .value(budget.clone())
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn selected_json(
    source: JsonSource,
    path: Option<&[wire::SourceSegment]>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(wire::SourceFormat, SourceBytes), String> {
    let mut value = json::inspect(&source, budget.clone())
        .await
        .map_err(|e| e.to_string())?;
    for segment in path.unwrap_or_default() {
        value = match segment {
            wire::SourceSegment::Key(key) => {
                required(&value.source, &[key.as_str()], budget).await?
            }
            wire::SourceSegment::Index(index) => {
                if value.kind != JsonKind::Array {
                    return Err("agent_history_path_invalid".into());
                }
                let mut cursor = json::ArrayCursor::open(value.source, budget.clone())
                    .await
                    .map_err(|e| e.to_string())?;
                let mut selected = None;
                for _ in 0..=*index {
                    selected = cursor.next().await.map_err(|e| e.to_string())?;
                    if selected.is_none() {
                        break;
                    }
                }
                selected.ok_or("agent_history_path_invalid")?
            }
        };
    }
    let (format, bytes) = if value.kind == JsonKind::String {
        (
            wire::SourceFormat::Text,
            pull::text::bytes(value.text().map_err(|e| e.to_string())?, budget.clone()),
        )
    } else {
        (wire::SourceFormat::Json, value.source.into_bytes())
    };
    Ok((format, bytes))
}

pub(super) async fn write_bytes(
    writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    bytes: &[u8],
    stop: &CancellationToken,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    for chunk in bytes.chunks(32 * 1024) {
        tokio::select! {
            biased;
            () = stop.cancelled() => return Err("agent_history_cancelled".into()),
            result = writer.write_all(chunk) => result.map_err(|e| e.to_string())?,
        }
    }
    Ok(())
}

pub(super) async fn write_json(
    value: Value,
    writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    stop: &CancellationToken,
) -> Result<(), String> {
    struct Chunks {
        send: tokio::sync::mpsc::Sender<Vec<u8>>,
        buffer: Vec<u8>,
    }
    impl io::Write for Chunks {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let count = bytes.len().min(32 * 1024 - self.buffer.len());
            self.buffer.extend_from_slice(&bytes[..count]);
            if self.buffer.len() == 32 * 1024 {
                io::Write::flush(self)?;
            }
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            if !self.buffer.is_empty() {
                let bytes = std::mem::replace(&mut self.buffer, Vec::with_capacity(32 * 1024));
                self.send.blocking_send(bytes).map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "history sink closed")
                })?;
            }
            Ok(())
        }
    }
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    let worker = tokio::task::spawn_blocking(move || {
        let mut chunks = Chunks {
            send,
            buffer: Vec::with_capacity(32 * 1024),
        };
        serde_json::to_writer(&mut chunks, &value).map_err(|e| e.to_string())?;
        io::Write::flush(&mut chunks).map_err(|e| e.to_string())
    });
    let written = async {
        loop {
            let chunk = tokio::select! {
                biased;
                () = stop.cancelled() => return Err("agent_history_cancelled".to_owned()),
                chunk = receive.recv() => chunk,
            };
            let Some(chunk) = chunk else {
                return Ok(());
            };
            write_bytes(writer, &chunk, stop).await?;
        }
    }
    .await;
    drop(receive);
    let encoded = worker.await.map_err(|e| e.to_string())?;
    written?;
    encoded
}

pub(super) async fn read_window(
    bytes: SourceBytes,
    format: wire::SourceFormat,
    position: wire::SourcePosition,
    limit: usize,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(wire::SourceFormat, u64, u64, String), String> {
    let total = measure(&bytes, budget).await?;
    let (start, end) = match position {
        wire::SourcePosition::Start => (0, total.min(limit as u64)),
        wire::SourcePosition::Tail => (total.saturating_sub(limit as u64), total),
        wire::SourcePosition::After { offset } => {
            (offset, total.min(offset.saturating_add(limit as u64)))
        }
        wire::SourcePosition::Before { offset } => (offset.saturating_sub(limit as u64), offset),
    };
    if start > end || end > total {
        return Err("agent_cursor_invalid".into());
    }
    if bytes.len().is_some() {
        let slice = bytes.slice(start..end).map_err(|e| e.to_string())?;
        let selected = collect(slice, budget, limit).await?;
        return super::source::finish(format, start, total, selected, position);
    }
    let mut cursor = bytes.open(budget.clone());
    let mut buffer = budget
        .allocate(32 * 1024)
        .await
        .map_err(|e| e.to_string())?;
    let mut window = super::source::Window::new(start, end);
    use std::io::Write;
    loop {
        let read = cursor.read_chunk(buffer).await.map_err(|e| e.to_string())?;
        window
            .write_all(&read.buffer.as_ref()[..read.bytes_read])
            .map_err(|e| e.to_string())?;
        buffer = read.buffer;
        if read.eof || window.total >= end {
            break;
        }
    }
    super::source::finish(format, start, total, window.bytes, position)
}
async fn measure(source: &SourceBytes, budget: &Arc<dyn SourceBudget>) -> Result<u64, String> {
    if let Some(length) = source.len() {
        return Ok(length);
    }
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget
        .allocate(32 * 1024)
        .await
        .map_err(|e| e.to_string())?;
    let mut total = 0;
    loop {
        let read = cursor.read_chunk(buffer).await.map_err(|e| e.to_string())?;
        total += read.bytes_read as u64;
        buffer = read.buffer;
        if read.eof {
            return Ok(total);
        }
    }
}

pub(super) fn budget() -> Arc<dyn SourceBudget> {
    Arc::new(Budget(Arc::new(tokio::sync::Semaphore::new(
        2 * 1024 * 1024,
    ))))
}
fn result_body(
    source: maka_agent_state::session_history::tool_result_source::ToolResultSource,
) -> Option<JsonSource> {
    use maka_agent_state::session_history::tool_result_source::ToolResultSource;
    match source {
        ToolResultSource::Returned { body, .. } | ToolResultSource::External { body } => Some(body),
        ToolResultSource::Direct(_) => None,
    }
}
async fn returned_source(
    data: &data::DataSource,
    item: &HistoryItem,
    budget: &Arc<dyn SourceBudget>,
    stop: &CancellationToken,
) -> Result<Option<JsonSource>, String> {
    let reference = match &item.recorded.fact {
        Fact::LocalToolReturned { result, .. }
        | Fact::HostToolResultRecorded { result, .. }
        | Fact::ToolResultAccepted { result, .. } => result,
        Fact::ExternalEffect {
            event: maka_agent_facts::external_effects::ExternalEffectEvent::Returned { output, .. },
        } => output,
        Fact::Cell {
            event:
                maka_agent_facts::cells::CellEvent::LocalChildReturned { result, .. }
                | maka_agent_facts::cells::CellEvent::ChildResultRecorded { result, .. },
        } => result,
        _ => return Ok(None),
    };
    let source = data::tool_reader(data, item.recorded.run, stop)
        .result(&item.recorded.fact, reference, budget.clone())
        .await
        .map_err(|error| error.to_string())?;
    Ok(result_body(source))
}

pub(super) async fn external_result_metadata(
    data: &data::DataSource,
    run: RunId,
    reference: &ContentRef,
    stop: &CancellationToken,
) -> Result<(bool, maka_agent_facts::tool_call::ToolSettlement), String> {
    use maka_agent_facts::tool_call::ToolSettlement;
    let budget = budget();
    let body = data::tool_reader(data, run, stop)
        .source(reference)
        .await
        .map_err(|error| error.to_string())?;
    let kind: String = small(required(&body, &["kind"], &budget).await?, &budget).await?;
    match kind.as_str() {
        "output" => Ok((
            small(required(&body, &["is_error"], &budget).await?, &budget).await?,
            ToolSettlement::Returned,
        )),
        "failure" => Ok((
            true,
            small(required(&body, &["settlement"], &budget).await?, &budget).await?,
        )),
        _ => Err("agent_history_external_return_codec_invalid".into()),
    }
}

pub(super) async fn media_metadata_from(
    data: &data::DataSource,
    item: &HistoryItem,
    stop: &CancellationToken,
) -> Result<Option<(bool, u32, bool)>, String> {
    let budget = budget();
    let Some(source) = returned_source(data, item, &budget, stop).await? else {
        return Ok(None);
    };
    let error_key = if matches!(item.recorded.fact, Fact::Cell { .. }) {
        "isError"
    } else {
        "is_error"
    };
    media_metadata_value(&source, error_key, &budget)
        .await
        .map(Some)
}
pub(super) async fn media_metadata_value(
    source: &JsonSource,
    error_key: &str,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(bool, u32, bool), String> {
    let is_error: bool = small(required(source, &[error_key], budget).await?, budget).await?;
    let format: String = small(
        required(source, &["output", "format"], budget).await?,
        budget,
    )
    .await?;
    let projection = json::field(source, &["projection"], budget.clone())
        .await
        .map_err(|error| error.to_string())?;
    let kind = match projection {
        Some(value) if value.kind != JsonKind::Null => {
            Some(small::<String>(required(&value.source, &["kind"], budget).await?, budget).await?)
        }
        _ if error_key == "isError" => None,
        _ => return Err("agent_history_projection_missing".into()),
    };
    let mut images = 0u32;
    if kind.as_deref() == Some("content") {
        let parts = required(source, &["projection", "parts"], budget).await?;
        let mut cursor = json::ArrayCursor::open(parts.source, budget.clone())
            .await
            .map_err(|e| e.to_string())?;
        while let Some(part) = cursor.next().await.map_err(|e| e.to_string())? {
            let kind: String =
                small(required(&part.source, &["kind"], budget).await?, budget).await?;
            if kind == "artifact" {
                images = images.checked_add(1).ok_or("agent_image_count_overflow")?;
            }
        }
    }
    Ok((format == "image", images, is_error))
}

pub(super) async fn image_reference_from(
    data: &data::DataSource,
    item: &HistoryItem,
    index: Option<u32>,
    stop: &CancellationToken,
) -> Result<maka_agent_facts::attachment::StorageRef, String> {
    let budget = budget();
    let source = returned_source(data, item, &budget, stop)
        .await?
        .ok_or("agent_image_source_invalid")?;
    image_reference_value(&source, index, &budget).await
}
async fn image_reference_value(
    source: &JsonSource,
    index: Option<u32>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<maka_agent_facts::attachment::StorageRef, String> {
    if let Some(mut index) = index {
        let parts = required(source, &["projection", "parts"], budget).await?;
        let mut cursor = json::ArrayCursor::open(parts.source, budget.clone())
            .await
            .map_err(|e| e.to_string())?;
        while let Some(part) = cursor.next().await.map_err(|e| e.to_string())? {
            let kind: String =
                small(required(&part.source, &["kind"], budget).await?, budget).await?;
            if kind == "artifact" {
                if index == 0 {
                    return small(
                        required(&part.source, &["image", "ref"], budget).await?,
                        budget,
                    )
                    .await;
                }
                index -= 1;
            }
        }
        Err("agent_image_source_invalid".into())
    } else {
        let format: String = small(
            required(source, &["output", "format"], budget).await?,
            budget,
        )
        .await?;
        if format != "image" {
            return Err("agent_image_source_invalid".into());
        }
        small(
            required(source, &["output", "value", "ref"], budget).await?,
            budget,
        )
        .await
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Field reading binds the exact history item, path, presentation mode, cancellation and source budget"
)]
pub(super) async fn field_source(
    data: &data::DataSource,
    item: &maka_agent_state::session_history::source_tree::SourceItem,
    field: &projection::Field,
    path: Option<&[wire::SourceSegment]>,
    display: bool,
    raw: bool,
    stop: &CancellationToken,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(wire::SourceFormat, SourceBytes), String> {
    use maka_agent_state::session_history::source_tree::SourceItem;
    match (field, item, data) {
        (projection::Field::Receipt(reply), SourceItem::Canonical(item), _) => {
            let receipt = data::tool_reader(data, item.recorded.run, stop)
                .operation_reply(reply, budget.clone())
                .await
                .map_err(|error| error.to_string())?;
            selected_json(receipt, path, budget).await
        }
        (projection::Field::Content(reference), SourceItem::Canonical(item), _) => {
            content_source(
                data,
                item.recorded.run,
                &item.recorded.fact,
                reference,
                path,
                display,
                stop,
                budget,
            )
            .await
        }
        (
            projection::Field::Imported {
                reference,
                selectors,
                returned,
            },
            SourceItem::Imported {
                message_ordinal, ..
            },
            data::DataSource::Snapshot(snapshot),
        ) => {
            let mut source = ToolResultReader::imported(snapshot, *message_ordinal, stop)
                .source(reference)
                .await
                .map_err(|error| error.to_string())?;
            if raw {
                if path.is_some_and(|path| !path.is_empty()) {
                    return Err("agent_history_path_invalid".into());
                }
                return Ok((wire::SourceFormat::Text, source.into_bytes()));
            }
            if !selectors.is_empty() {
                let keys: Vec<_> = selectors.iter().map(String::as_str).collect();
                source = required(&source, &keys, budget).await?.source;
            }
            if *returned {
                source = result_value(
                    ToolResultReader::returned(source, budget.clone())
                        .await
                        .map_err(|error| error.to_string())?,
                    display,
                    false,
                    budget,
                )
                .await?;
            }
            selected_json(source, path, budget).await
        }
        _ => Err("agent_history_field_source_mismatch".into()),
    }
}
#[expect(
    clippy::too_many_arguments,
    reason = "Excerpt reading binds the exact item, path, cursor, presentation mode and cancellation"
)]
pub(super) async fn field_excerpt(
    data: &data::DataSource,
    item: &maka_agent_state::session_history::source_tree::SourceItem,
    field: &projection::Field,
    path: Option<&[wire::SourceSegment]>,
    position: wire::SourcePosition,
    limit: usize,
    display: bool,
    raw: bool,
    stop: &CancellationToken,
) -> Result<(wire::SourceFormat, u64, u64, String), String> {
    if matches!(
        field,
        projection::Field::Text(_) | projection::Field::Json(_)
    ) {
        return source::excerpt_ref(field, path, position, limit);
    }
    let budget = budget();
    let (format, bytes) =
        field_source(data, item, field, path, display, raw, stop, &budget).await?;
    read_window(bytes, format, position, limit, &budget).await
}
pub(super) async fn write_field(
    data: &data::DataSource,
    item: &maka_agent_state::session_history::source_tree::SourceItem,
    field: projection::Field,
    writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    stop: &CancellationToken,
) -> Result<(), String> {
    match field {
        projection::Field::Text(body) => {
            for chunk in body.chunks() {
                write_bytes(writer, chunk.as_bytes(), stop).await?;
            }
            Ok(())
        }
        projection::Field::Json(value) => write_json(value, writer, stop).await,
        field => {
            let budget = budget();
            let (_, bytes) =
                field_source(data, item, &field, None, true, false, stop, &budget).await?;
            let mut cursor = bytes.open(budget.clone());
            let mut buffer = budget
                .allocate(32 * 1024)
                .await
                .map_err(|error| error.to_string())?;
            loop {
                if stop.is_cancelled() {
                    return Err("agent_history_cancelled".into());
                }
                let read = cursor
                    .read_chunk(buffer)
                    .await
                    .map_err(|error| error.to_string())?;
                write_bytes(writer, &read.buffer.as_ref()[..read.bytes_read], stop).await?;
                buffer = read.buffer;
                if read.eof {
                    return Ok(());
                }
            }
        }
    }
}

async fn imported_returned(
    snapshot: &maka_agent_state::session_history::snapshot::Snapshot,
    ordinal: u64,
    field: &projection::Field,
    stop: &CancellationToken,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Option<JsonSource>, String> {
    let projection::Field::Imported {
        reference,
        selectors,
        returned: true,
    } = field
    else {
        return Ok(None);
    };
    let mut source = ToolResultReader::imported(snapshot, ordinal, stop)
        .source(reference)
        .await
        .map_err(|error| error.to_string())?;
    let keys: Vec<_> = selectors.iter().map(String::as_str).collect();
    if !keys.is_empty() {
        source = required(&source, &keys, budget).await?.source;
    }
    let source = ToolResultReader::returned(source, budget.clone())
        .await
        .map_err(|error| error.to_string())?;
    Ok(result_body(source))
}
pub(super) async fn imported_media(
    snapshot: &maka_agent_state::session_history::snapshot::Snapshot,
    ordinal: u64,
    row: &projection::Row,
    stop: &CancellationToken,
) -> Result<Option<(bool, u32, bool)>, String> {
    let Some((_, field)) = row
        .fields
        .iter()
        .find(|(field, _)| *field == wire::SourceField::Result)
    else {
        return Ok(None);
    };
    let budget = budget();
    let Some(source) = imported_returned(snapshot, ordinal, field, stop, &budget).await? else {
        return Ok(None);
    };
    media_metadata_value(&source, "is_error", &budget)
        .await
        .map(Some)
}
pub(super) async fn selected_image(
    selected: &source::Selected,
    index: Option<u32>,
    stop: &CancellationToken,
) -> Result<maka_agent_facts::attachment::StorageRef, String> {
    use maka_agent_state::session_history::source_tree::SourceItem;
    match (&selected.data, &selected.item) {
        (_, SourceItem::Canonical(item)) => {
            image_reference_from(&selected.data, item, index, stop).await
        }
        (
            data::DataSource::Snapshot(snapshot),
            SourceItem::Imported {
                message_ordinal, ..
            },
        ) => {
            let field = &selected
                .row
                .fields
                .iter()
                .find(|(field, _)| *field == wire::SourceField::Result)
                .ok_or("agent_image_source_invalid")?
                .1;
            let budget = budget();
            let source = imported_returned(snapshot, *message_ordinal, field, stop, &budget)
                .await?
                .ok_or("agent_image_source_invalid")?;
            image_reference_value(&source, index, &budget).await
        }
        _ => Err("agent_image_source_invalid".into()),
    }
}
