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
use maka_agent_facts::history_snapshot::SnapshotId;
use projection::Field;
use std::io::Write;
use wire::{SourceField, SourceFormat, SourcePosition, SourceSegment};

use maka_agent_state::session_history::{
    snapshot::Snapshot,
    source_tree::{SourceItem, SourceTree},
};

pub(super) struct Selected {
    pub data: data::DataSource,
    pub item: SourceItem,
    pub row: projection::Row,
}
type ToolScope = (Vec<RunId>, Option<SnapshotId>, String);
#[derive(Default)]
pub(super) struct Cache {
    key: Option<(
        Option<maka_agent_facts::history_snapshot::SnapshotId>,
        RunId,
    )>,
    source: Option<maka_agent_state::session_history::RunSource>,
    views: std::collections::BTreeMap<RunId, maka_agent_state::fold::RunView>,
    tools: std::collections::BTreeMap<ToolScope, Option<wire::Tool>>,
}
pub(super) fn snapshot_id(
    address: &wire::HistoryRowAddress,
) -> Option<maka_agent_facts::history_snapshot::SnapshotId> {
    match address {
        wire::HistoryRowAddress::Live { .. } => None,
        wire::HistoryRowAddress::Snapshot { snapshot, .. }
        | wire::HistoryRowAddress::Imported { snapshot, .. } => Some(*snapshot),
    }
}
async fn unpaired(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Selected, String> {
    if stop.is_cancelled() {
        return Err("agent_history_cancelled".into());
    }
    address.validate().map_err(str::to_owned)?;
    let data = tree
        .source_for_path(address.path(), snapshot_id(address))
        .await
        .map_err(|error| error.to_string())?;
    let item = tree
        .item(address)
        .await
        .map_err(|error| error.to_string())?;
    let qualified = tree
        .positions(Some(address.clone()), false, true, 1)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|row| row.address == *address)
        .ok_or("agent_history_source_missing")?;
    let mut row = match &item {
        SourceItem::Canonical(item) => {
            let key = (snapshot_id(address), item.recorded.run);
            if cache.key.as_ref() != Some(&key) {
                cache.source = Some(
                    data.run_source(item.recorded.run)
                        .await
                        .map_err(|error| error.to_string())?,
                );
                cache.views.clear();
                cache.key = Some(key);
            }
            projection::project(
                &data,
                item,
                cache.source.as_ref().expect("current original Run"),
                address,
                &mut cache.views,
                stop,
            )
            .await?
            .into_iter()
            .find(|row| row.chunk.position == *address)
            .ok_or("agent_history_source_missing")?
        }
        SourceItem::Imported {
            message,
            message_ordinal,
            part_ordinal,
        } => {
            let data::DataSource::Snapshot(snapshot) = &data else {
                return Err("agent_history_import_scope_invalid".into());
            };
            imported::row(
                snapshot,
                message,
                *message_ordinal,
                *part_ordinal,
                address.clone(),
                qualified.order.clone(),
                stop,
            )
            .await?
        }
    };
    if let (
        data::DataSource::Snapshot(snapshot),
        SourceItem::Imported {
            message_ordinal, ..
        },
    ) = (&data, &item)
    {
        media::describe_imported(snapshot, *message_ordinal, &mut row, stop).await?;
    }
    row.chunk.order = qualified.order;
    Ok(Selected { data, item, row })
}
pub(super) async fn visible(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<bool, String> {
    if stop.is_cancelled() {
        return Err("agent_history_cancelled".into());
    }
    Ok(
        match tree
            .item(address)
            .await
            .map_err(|error| error.to_string())?
        {
            SourceItem::Canonical(item) => projection::visible(&item.recorded.fact),
            SourceItem::Imported { .. } => true,
        },
    )
}
pub(super) async fn selected(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Selected, String> {
    let mut row = unpaired(tree, address, cache, stop).await?;
    pair(tree, &mut row, cache, stop).await?;
    Ok(row)
}
// Recall positions include inspectable receipts that are not transcript entries.
// Scan past them rather than returning an empty page before the actual history ends.
pub(super) async fn window(
    tree: &SourceTree,
    anchor: Option<wire::HistoryRowAddress>,
    reverse: bool,
    include_thinking: bool,
    limit: usize,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Vec<Selected>, String> {
    let mut bound = anchor;
    let mut exclude_anchor = false;
    let mut rows = Vec::new();
    loop {
        let positions = tree
            .positions(bound.clone(), reverse, include_thinking, 32)
            .await
            .map_err(|error| error.to_string())?;
        let full = positions.len() == 32;
        let last = positions.last().map(|row| row.address.clone());
        for qualified in positions {
            if exclude_anchor && Some(&qualified.address) == bound.as_ref() {
                continue;
            }
            let row = selected(tree, &qualified.address, cache, stop).await?;
            if !row.row.visible {
                continue;
            }
            rows.push(row);
            if rows.len() == limit {
                return Ok(rows);
            }
        }
        if !full {
            return Ok(rows);
        }
        bound = last;
        exclude_anchor = true;
    }
}
async fn pair(
    tree: &SourceTree,
    row: &mut Selected,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    let Some(tool) = &row.row.chunk.tool else {
        return Ok(());
    };
    // Imported claims have their own recorded association, not native tool locators.
    if !matches!(row.item, SourceItem::Canonical(_)) {
        return Ok(());
    }
    let address = &row.row.chunk.position;
    let key = (
        address.path().to_vec(),
        snapshot_id(address),
        tool.tool_use_id.clone(),
    );
    if let Some(paired) = cache.tools.get(&key) {
        if let Some(paired) = paired {
            row.row.chunk.tool = Some(paired.clone());
        }
        return Ok(());
    }
    let id = tool.tool_use_id.clone();
    let mut paired = tool.clone();
    let mut call_position = None;
    let mut result_rank = (false, 0);
    let mut after = None;
    loop {
        let positions = tree
            .tool_positions(&id, after.clone(), 32)
            .await
            .map_err(|error| error.to_string())?;
        if positions.is_empty() {
            break;
        }
        after = positions.last().map(|row| row.address.clone());
        for position in positions {
            if position.address.path() != address.path()
                || snapshot_id(&position.address) != snapshot_id(address)
            {
                continue;
            }
            let selected = unpaired(tree, &position.address, cache, stop).await?;
            if !selected.row.visible {
                continue;
            }
            let Some(tool) = selected.row.chunk.tool else {
                continue;
            };
            if let Some(call) = tool.call {
                if call_position
                    .as_ref()
                    .is_some_and(|position| *position != call.position)
                {
                    cache.tools.insert(key, None);
                    return Ok(());
                }
                call_position = Some(call.position.clone());
                paired.call = Some(call);
            }
            let rank = match &selected.item {
                SourceItem::Canonical(item)
                    if matches!(
                        item.recorded.fact,
                        Fact::ToolResultAccepted {
                            outcome: AcceptedResult::CellRecovered { .. },
                            ..
                        }
                    ) =>
                {
                    2
                }
                SourceItem::Canonical(item)
                    if matches!(item.recorded.fact, Fact::ToolResultAccepted { .. }) =>
                {
                    3
                }
                _ if selected
                    .row
                    .fields
                    .iter()
                    .any(|(field, _)| *field == SourceField::Result) =>
                {
                    2
                }
                _ => 1,
            };
            if let Some(result) = tool.result {
                let rank = (
                    result.settlement != Some(maka_agent_facts::tool_call::ToolSettlement::Unknown),
                    rank,
                );
                // Later uncertainty or cleanup receipts cannot replace a known return.
                if rank >= result_rank {
                    paired.result = Some(result);
                    result_rank = rank;
                }
            }
        }
    }
    row.row.chunk.tool = Some(paired.clone());
    cache.tools.insert(key, Some(paired));
    Ok(())
}
pub(super) async fn display(
    selected: &Selected,
    view: wire::HistoryView,
    position: SourcePosition,
    limit: usize,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<(SourceFormat, u64, u64, String), String> {
    let row = &selected.row;
    if view == wire::HistoryView::Conversation && row.chunk.role == wire::Role::Compaction {
        return excerpt_ref(&Field::Text(TextBody::default()), None, position, limit);
    }
    let field = if view == wire::HistoryView::Text
        && (row.chunk.role == wire::Role::ToolResult
            || row
                .chunk
                .tool
                .as_ref()
                .is_some_and(|tool| tool.result.is_some()))
    {
        [
            SourceField::Result,
            SourceField::Arguments,
            SourceField::Body,
            SourceField::Receipt,
        ]
        .into_iter()
        .find(|field| row.fields.iter().any(|(kind, _)| kind == field))
    } else if view == wire::HistoryView::Text
        && (row.chunk.role == wire::Role::ToolCall
            || row
                .chunk
                .tool
                .as_ref()
                .is_some_and(|tool| tool.call.is_some()))
    {
        [SourceField::Arguments, SourceField::ToolName]
            .into_iter()
            .find(|field| row.fields.iter().any(|(kind, _)| kind == field))
    } else {
        match &row.body {
            projection::Body::Field(field) => Some(*field),
            _ => None,
        }
    };
    if let Some(field) = field {
        let value = &row
            .fields
            .iter()
            .find(|(kind, _)| *kind == field)
            .ok_or("agent_history_display_field_missing")?
            .1;
        return stream::field_excerpt(
            &selected.data,
            &selected.item,
            value,
            None,
            position,
            limit,
            true,
            false,
            stop,
        )
        .await;
    }
    match &row.body {
        projection::Body::Text(body) => {
            excerpt_ref(&Field::Text(body.clone()), None, position, limit)
        }
        projection::Body::Empty => {
            excerpt_ref(&Field::Text(TextBody::default()), None, position, limit)
        }
        projection::Body::Field(_) => Err("agent_history_display_field_missing".into()),
    }
}

pub(crate) async fn source(
    owner: &Owner,
    scope: &Scope,
    input: ui::HistorySourceRead,
) -> Result<ui::HistorySourcePage, String> {
    let history = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, Some(input.through)).await?;
    let tree = SourceTree::live(&history, &cut)
        .await
        .map_err(|error| error.to_string())?;
    let address = match input.source {
        ui::HistorySourceReference::Row { position } => position,
        ui::HistorySourceReference::ToolUse { tool_use_id } => {
            let mut after = None;
            let mut found = None;
            let mut cache = Cache::default();
            loop {
                let page = tree
                    .tool_positions(&tool_use_id, after.clone(), 32)
                    .await
                    .map_err(|error| error.to_string())?;
                if page.is_empty() {
                    break;
                }
                for qualified in &page {
                    let row = selected(&tree, &qualified.address, &mut cache, &scope.cancellation)
                        .await?;
                    if row
                        .row
                        .fields
                        .iter()
                        .any(|(field, _)| *field == input.field)
                    {
                        found = Some(qualified.address.clone());
                    }
                }
                after = page.last().map(|row| row.address.clone());
            }
            found.ok_or("agent_history_source_missing")?
        }
    };
    let selected = selected(&tree, &address, &mut Cache::default(), &scope.cancellation).await?;
    let source = source_value(
        &selected,
        input.field,
        input.path,
        input.position,
        &scope.cancellation,
    )
    .await?;
    let file_path = match &selected.item {
        SourceItem::Canonical(item) => {
            let original = selected
                .data
                .run_source(item.recorded.run)
                .await
                .map_err(|error| error.to_string())?;
            crate::source_path::file_path(&source, &original.spec.workspace)
        }
        SourceItem::Imported { .. } => None,
    };
    authorize(owner, scope, &input.session_id).await?;
    Ok(ui::HistorySourcePage::Ready {
        through: cut.through_sequence,
        source: Box::new(source),
        file_path,
    })
}
pub(crate) async fn snapshot_source(
    snapshot: &Snapshot,
    address: wire::HistoryRowAddress,
    field: SourceField,
    path: Option<Vec<SourceSegment>>,
    position: SourcePosition,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<wire::HistorySource, String> {
    let tree = SourceTree::snapshot(snapshot)
        .await
        .map_err(|error| error.to_string())?;
    let selected = selected(&tree, &address, &mut Cache::default(), stop).await?;
    source_value(&selected, field, path, position, stop).await
}
async fn source_value(
    selected: &Selected,
    field: SourceField,
    path: Option<Vec<SourceSegment>>,
    position: SourcePosition,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<wire::HistorySource, String> {
    let row = &selected.row;
    let value = &row
        .fields
        .iter()
        .find(|(kind, _)| *kind == field)
        .ok_or("agent_history_field_invalid")?
        .1;
    let (format, offset, total_bytes, text) = stream::field_excerpt(
        &selected.data,
        &selected.item,
        value,
        path.as_deref(),
        position,
        8192,
        field == SourceField::Result,
        field == SourceField::Original,
        stop,
    )
    .await?;
    Ok(wire::HistorySource {
        model: row.chunk.model.clone(),
        origin: row.chunk.origin.clone(),
        position: row.chunk.position.clone(),
        timestamp: row.chunk.timestamp,
        role: match row.chunk.role {
            wire::Role::System => wire::SourceRole::System,
            wire::Role::Context => wire::SourceRole::Context,
            wire::Role::Tool => wire::SourceRole::Tool,
            wire::Role::User => wire::SourceRole::User,
            wire::Role::Assistant | wire::Role::Compaction => wire::SourceRole::Assistant,
            wire::Role::ToolCall => wire::SourceRole::ToolCall,
            wire::Role::ToolResult => wire::SourceRole::ToolResult,
            wire::Role::Failure => wire::SourceRole::Failure,
        },
        fields: row.fields.iter().map(|(field, _)| *field).collect(),
        field,
        path,
        format,
        offset,
        total_bytes,
        text,
        tool: row.chunk.tool.clone(),
    })
}
pub(crate) async fn prompt(
    owner: &Owner,
    scope: &Scope,
    input: ui::HistoryPromptRead,
) -> Result<Option<ui::HistoryPrompt>, String> {
    let history = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, Some(input.through)).await?;
    let tree = SourceTree::live(&history, &cut)
        .await
        .map_err(|error| error.to_string())?;
    let selected = selected(
        &tree,
        &input.position,
        &mut Cache::default(),
        &scope.cancellation,
    )
    .await?;
    let result = if selected.row.chunk.role == wire::Role::User {
        let (_, _, _, text) = display(
            &selected,
            wire::HistoryView::Text,
            SourcePosition::Start,
            4096,
            &scope.cancellation,
        )
        .await?;
        Some(ui::HistoryPrompt {
            position: input.position,
            text,
        })
    } else {
        None
    };
    authorize(owner, scope, &input.session_id).await?;
    Ok(result)
}

pub(super) fn excerpt_ref(
    field: &Field,
    path: Option<&[SourceSegment]>,
    position: SourcePosition,
    limit: usize,
) -> Result<(SourceFormat, u64, u64, String), String> {
    enum ValueRef<'a> {
        Text(&'a TextBody),
        String(&'a str),
        Json(&'a Value),
    }
    let value = match field {
        Field::Text(body) if path.is_none_or(|path| path.is_empty()) => ValueRef::Text(body),
        Field::Json(value) => {
            let mut value = value;
            for segment in path.unwrap_or_default() {
                value = match segment {
                    SourceSegment::Key(key) => value.get(key),
                    SourceSegment::Index(index) => value
                        .get(usize::try_from(*index).map_err(|_| "agent_history_path_invalid")?),
                }
                .ok_or("agent_history_path_invalid")?;
            }
            match value {
                Value::String(text) => ValueRef::String(text),
                value => ValueRef::Json(value),
            }
        }
        _ => return Err("agent_history_unresolved_content".into()),
    };
    let (format, total) = match value {
        ValueRef::Text(body) => (SourceFormat::Text, body.len_bytes() as u64),
        ValueRef::String(text) => (SourceFormat::Text, text.len() as u64),
        ValueRef::Json(value) => {
            let mut count = Window::new(0, 0);
            serde_json::to_writer(&mut count, value).map_err(|error| error.to_string())?;
            (SourceFormat::Json, count.total)
        }
    };
    let (start, end) = match position {
        SourcePosition::Start => (0, total.min(limit as u64)),
        SourcePosition::Tail => (total.saturating_sub(limit as u64), total),
        SourcePosition::After { offset } => {
            (offset, total.min(offset.saturating_add(limit as u64)))
        }
        SourcePosition::Before { offset } => (offset.saturating_sub(limit as u64), offset),
    };
    if start > end || end > total {
        return Err("agent_cursor_invalid".into());
    }
    let mut window = Window::new(start, end);
    match value {
        ValueRef::Text(body) => {
            for chunk in body.chunks() {
                window
                    .write_all(chunk.as_bytes())
                    .map_err(|error| error.to_string())?;
            }
        }
        ValueRef::String(text) => window
            .write_all(text.as_bytes())
            .map_err(|error| error.to_string())?,
        ValueRef::Json(value) => {
            serde_json::to_writer(&mut window, value).map_err(|error| error.to_string())?
        }
    }
    finish(format, start, total, window.bytes, position)
}

pub(super) fn finish(
    format: SourceFormat,
    start: u64,
    total: u64,
    mut bytes: Vec<u8>,
    position: SourcePosition,
) -> Result<(SourceFormat, u64, u64, String), String> {
    let mut offset = start;
    if matches!(
        position,
        SourcePosition::Tail | SourcePosition::Before { .. }
    ) {
        while bytes.first().is_some_and(|b| b & 0xc0 == 0x80) {
            bytes.remove(0);
            offset += 1;
        }
    }
    loop {
        match std::str::from_utf8(&bytes) {
            Ok(_) => break,
            Err(error)
                if error.error_len().is_none()
                    && !matches!(position, SourcePosition::Before { .. }) =>
            {
                bytes.truncate(error.valid_up_to());
            }
            Err(_) => return Err("agent_cursor_invalid".into()),
        }
    }
    Ok((
        format,
        offset,
        total,
        String::from_utf8(bytes).map_err(|_| "agent_cursor_invalid")?,
    ))
}
pub(super) struct Window {
    start: u64,
    end: u64,
    pub(super) total: u64,
    pub(super) bytes: Vec<u8>,
}
impl Window {
    pub(super) fn new(start: u64, end: u64) -> Self {
        Self {
            start,
            end,
            total: 0,
            bytes: Vec::new(),
        }
    }
}
impl Write for Window {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let start = self
            .start
            .saturating_sub(self.total)
            .min(bytes.len() as u64) as usize;
        let end = self.end.saturating_sub(self.total).min(bytes.len() as u64) as usize;
        if start < end {
            self.bytes.extend_from_slice(&bytes[start..end]);
        }
        self.total += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
