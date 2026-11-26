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
use futures_util::future::BoxFuture;
use maka_agent_facts::{
    executor::{Selection, TurnUsage},
    history_snapshot::SnapshotId,
    model::PromptCacheUsage,
};
use projection::Field;
use std::io::Write;
use wire::{SourceField, SourceFormat, SourcePosition, SourceSegment};

use maka_agent_state::session_history::{
    snapshot::Snapshot,
    source_tree::{CompletedWork, QualifiedRow, RunRows, SourceItem, SourceTree},
};

pub(super) struct RenderedExcerpt {
    pub format: SourceFormat,
    pub offset: u64,
    pub total: u64,
    pub text: String,
    pub indexed_field: Option<ProjectedField>,
}

pub(super) struct Selected {
    pub data: data::DataSource,
    pub item: SourceItem,
    pub row: projection::Row,
}
impl Selected {
    pub(super) fn indexed_field(
        &self,
        field: SourceField,
        format: SourceFormat,
    ) -> Option<ProjectedField> {
        use maka_agent_state::recall::Field;
        let SourceItem::Canonical(item) = &self.item else {
            return None;
        };
        use maka_agent_facts::{cells::CellEvent, external_effects::ExternalEffectEvent};
        let last_text = match &item.recorded.fact {
            Fact::LocalToolReturned { .. }
            | Fact::Cell {
                event: CellEvent::LocalChildReturned { .. } | CellEvent::ChildResultRecorded { .. },
            }
            | Fact::HostToolResultRecorded { .. }
            | Fact::ToolResultAccepted { .. }
            | Fact::ExternalEffect {
                event: ExternalEffectEvent::Returned { .. },
            } => Some(SourceField::Result),
            Fact::Cell {
                event: CellEvent::Started { .. },
            } => Some(SourceField::Body),
            _ => None,
        };
        let index = match field {
            SourceField::Body => Field::Body,
            SourceField::Result => Field::Result,
            SourceField::Arguments => Field::Arguments,
            SourceField::Receipt => Field::Receipt,
            _ => return None,
        };
        if format == SourceFormat::Text
            && matches!(field, SourceField::Arguments | SourceField::Result)
            && self.row.fields.iter().any(|(kind, value)| {
                *kind == field && matches!(value, projection::Field::Json(Value::String(_)))
            })
        {
            Some(ProjectedField::json_value(index, true))
        } else if format == SourceFormat::Text && last_text == Some(field) {
            Some(ProjectedField::Last(index))
        } else {
            Some(ProjectedField::Complete(index))
        }
    }

    pub(super) fn goal_objective_offset(&self) -> Option<u64> {
        let maka_agent_facts::message::MessageOrigin::Goal { objective, .. } =
            self.row.chunk.origin.as_ref()?
        else {
            return None;
        };
        let projection::Body::Text(body) = &self.row.body else {
            return None;
        };
        // Goal::reserve places the objective between the first newline and a blank line
        // in every locale. Verify its bytes against the whole row before paging.
        let mut bytes = body.chunks().flat_map(str::bytes);
        let offset = bytes.position(|b| b == b'\n')? + 1;
        objective
            .bytes()
            .chain(*b"\n\n")
            .all(|b| bytes.next() == Some(b))
            .then_some(offset as u64)
    }

    pub(super) fn conversation_prose(&self) -> bool {
        if self.row.chunk.role == wire::Role::User {
            return true;
        }
        matches!(&self.item, SourceItem::Canonical(item) if matches!(item.recorded.fact,
            Fact::ModelObserved {part: ModelPart::Text { text_kind: TextKind::Text, .. }, ..}
            | Fact::ExternalTaskObserved { output: maka_agent_facts::executor::Output::OutputDelta { .. }, .. }
        ))
    }
}
type ToolScope = (Vec<RunId>, Option<SnapshotId>, String);
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum Reader {
    #[default]
    Original,
    ModelTool,
    Conversation,
}
#[derive(Default)]
pub(super) struct Cache {
    key: Option<(
        Option<maka_agent_facts::history_snapshot::SnapshotId>,
        RunId,
    )>,
    source: Option<maka_agent_state::session_history::RunSource>,
    timing: Option<wire::TurnTiming>,
    final_attempt: Option<maka_agent_facts::durable::ModelAttemptId>,
    executor: Option<maka_agent_state::session_history::ExecutorTranscript>,
    views: std::collections::BTreeMap<RunId, maka_agent_state::fold::RunView>,
    tools: std::collections::BTreeMap<ToolScope, Option<wire::Tool>>,
    completed: std::collections::BTreeMap<RunId, Option<CompletedWork>>,
    folded_work: std::collections::BTreeMap<RunId, wire::FoldedWork>,
    pub chat: bool,
    pub reader: Reader,
}
impl Cache {
    pub(super) fn executor_thinking(&self, address: &wire::HistoryRowAddress) -> Option<&TextBody> {
        let wire::HistoryRowAddress::Live {
            sequence,
            fact,
            item_index: 0,
        } = address
        else {
            return None;
        };
        self.executor.as_ref()?.thinking_at(*sequence, *fact)
    }
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
async fn completed_work(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    run: RunId,
    cache: &mut Cache,
) -> Result<Option<CompletedWork>, String> {
    if !cache.chat || !matches!(address, wire::HistoryRowAddress::Live { .. }) {
        return Ok(None);
    }
    if let std::collections::btree_map::Entry::Vacant(entry) = cache.completed.entry(run) {
        let source = tree
            .source_for_path(address.path(), None)
            .await
            .map_err(|error| error.to_string())?;
        let original = source
            .run_source(run)
            .await
            .map_err(|error| error.to_string())?;
        entry.insert(
            if matches!(original.spec.backend, BackendSpec::Model { .. }) {
                source
                    .completed_work(run, &original.spec.turn_id)
                    .await
                    .map_err(|error| error.to_string())?
            } else {
                None
            },
        );
    }
    Ok(cache.completed[&run].clone())
}

pub(super) async fn unpaired(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    order: Option<wire::HistoryOrder>,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Selected, String> {
    if stop.is_cancelled() {
        return Err("agent_history_cancelled".into());
    }
    address.validate().map_err(str::to_owned)?;
    let item = tree
        .item(address)
        .await
        .map_err(|error| error.to_string())?;
    let order = if let Some(order) = order {
        order
    } else {
        tree.positions(Some(address.clone()), false, true, 1)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|row| row.address == *address)
            .ok_or("agent_history_source_missing")?
            .order
    };
    project_item(tree, address, order, item, cache, stop).await
}
async fn project_item(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    order: wire::HistoryOrder,
    item: SourceItem,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Selected, String> {
    let data = tree
        .source_for_path(address.path(), snapshot_id(address))
        .await
        .map_err(|error| error.to_string())?;
    let mut row = match &item {
        SourceItem::Canonical(item) => {
            let completed = completed_work(tree, address, item.recorded.run, cache).await?;
            let key = (snapshot_id(address), item.recorded.run);
            if cache.key.as_ref() != Some(&key) {
                let source = data
                    .run_source(item.recorded.run)
                    .await
                    .map_err(|error| error.to_string())?;
                let mut timing = timing(&data, &source, stop).await?;
                cache.views.clear();
                cache.executor = None;
                if let BackendSpec::Executor { selection, .. } = &source.spec.backend {
                    let (view, transcript) = data
                        .executor_view(source.run, cache.reader == Reader::ModelTool)
                        .await
                        .map_err(|error| error.to_string())?;
                    timing.executor_usage = view
                        .external
                        .as_ref()
                        .and_then(|task| task.turn_usage.clone())
                        .map(Box::new);
                    if let Some(usage) = timing.executor_usage.as_deref_mut()
                        && let Some(cache) = executor_prompt_cache(selection, usage)
                    {
                        usage.tokens.input_tokens = Some(cache.input_tokens);
                        timing.prompt_cache = Some(cache);
                    }
                    cache.views.insert(source.run, view);
                    cache.executor = Some(transcript);
                }
                cache.final_attempt = if let Some(work) = completed.as_ref() {
                    Some(work.attempt)
                } else if timing
                    .finished
                    .as_ref()
                    .is_some_and(|finished| finished.outcome == wire::TurnOutcome::Completed)
                    && matches!(&source.spec.backend, BackendSpec::Model { .. })
                {
                    data.final_attempt(source.run)
                        .await
                        .map_err(|error| error.to_string())?
                } else {
                    None
                };
                cache.timing = Some(timing);
                cache.source = Some(source);
                cache.key = Some(key);
            }
            let mut row = projection::project(
                &data,
                item,
                address,
                &mut cache.views,
                projection::RunProjection {
                    source: cache.source.as_ref().expect("current original Run"),
                    executor: cache.executor.as_ref(),
                    final_attempt: cache.final_attempt,
                    terminated: cache
                        .timing
                        .as_ref()
                        .is_some_and(|timing| timing.finished.is_some()),
                },
                cache.reader != Reader::Original,
                stop,
            )
            .await?
            .into_iter()
            .find(|row| row.chunk.position == *address)
            .ok_or("agent_history_source_missing")?;
            row.chunk.timing = cache.timing.clone();
            if let Some(work) = completed {
                let run = item.recorded.run;
                if let std::collections::btree_map::Entry::Vacant(entry) =
                    cache.folded_work.entry(run)
                {
                    let mut images = Vec::new();
                    for position in work.image_sources {
                        let SourceItem::Canonical(image) = tree
                            .item(&position)
                            .await
                            .map_err(|error| error.to_string())?
                        else {
                            continue;
                        };
                        if let Some((content, count, _)) =
                            stream::media_metadata_from(&data, &image, stop).await?
                        {
                            if content {
                                images.push(wire::WorkImage {
                                    position: position.clone(),
                                    image: None,
                                });
                            }
                            images.extend((count.saturating_sub(4)..count).map(|index| {
                                wire::WorkImage {
                                    position: position.clone(),
                                    image: Some(index),
                                }
                            }));
                        }
                    }
                    let retained = images.len().saturating_sub(4);
                    images.drain(..retained);
                    entry.insert(wire::FoldedWork {
                        thoughts: work.thoughts,
                        messages: work.messages,
                        tools: work.tools,
                        image_count: work.image_count,
                        images,
                    });
                }
                row.chunk.folded_work = Some(cache.folded_work[&run].clone());
            }
            row
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
                order.clone(),
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
    // Material titles can reveal the original attachment filename.
    if cache.reader != Reader::Original
        && let Some(call) = row.chunk.tool.as_mut().and_then(|tool| tool.call.as_mut())
        && call.presentation.as_deref() == Some(crate::tools::title::RECALL_MATERIAL_PRESENTATION)
    {
        call.title = None;
    }
    row.chunk.order = order;
    Ok(Selected { data, item, row })
}
/// A Turn is one Run: it starts at admission and ends at termination.
async fn timing(
    data: &data::DataSource,
    source: &maka_agent_state::session_history::RunSource,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<wire::TurnTiming, String> {
    let millis =
        |at: UnixMillis| u64::try_from(at.0).map_err(|_| "agent_history_timestamp_invalid");
    let finished = data
        .terminated(source.run, Some(stop))
        .await
        .map_err(|error| error.to_string())?
        .map(|(at, terminal)| {
            Ok::<_, String>(wire::TurnFinished {
                at: millis(at)?,
                outcome: match terminal {
                    Terminal::Completed => wire::TurnOutcome::Completed,
                    Terminal::Failed => wire::TurnOutcome::Failed,
                    Terminal::Cancelled => wire::TurnOutcome::Aborted,
                },
            })
        })
        .transpose()?;
    let (model_tokens, prompt_cache) =
        if finished.is_some() && matches!(&source.spec.backend, BackendSpec::Model { .. }) {
            data.main_model_usage(source.run)
                .await
                .map_err(|error| error.to_string())?
        } else {
            (None, None)
        };
    Ok(wire::TurnTiming {
        model_tokens,
        prompt_cache,
        started_at: millis(source.admission.at)?,
        finished,
        executor_usage: None,
    })
}
fn executor_prompt_cache(selection: &Selection, usage: &TurnUsage) -> Option<PromptCacheUsage> {
    let read = usage.tokens.cache_read_tokens?;
    let input = usage.tokens.input_tokens?;
    let total = match (
        selection.executor.as_str(),
        selection.settings.runtime.as_deref(),
    ) {
        ("external", Some("antigravity" | "claude")) => input
            .checked_add(read)?
            .checked_add(usage.tokens.cache_write_tokens?)?,
        _ => input,
    };
    PromptCacheUsage::new(total, read)
}
pub(super) async fn search_anchor(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    order: wire::HistoryOrder,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Option<(wire::HistoryRowAddress, wire::HistoryOrder)>, String> {
    if stop.is_cancelled() {
        return Err("agent_history_cancelled".into());
    }
    match tree
        .item(address)
        .await
        .map_err(|error| error.to_string())?
    {
        SourceItem::Canonical(item) => {
            use maka_agent_facts::executor::Output;
            if !matches!(
                item.recorded.fact,
                Fact::ExternalTaskObserved {
                    output: Output::OutputDelta { .. } | Output::ThinkingDelta { .. },
                    ..
                }
            ) {
                return Ok(
                    projection::visible(&item.recorded.fact).then(|| (address.clone(), order))
                );
            }
        }
        SourceItem::Imported { .. } => return Ok(Some((address.clone(), order))),
    }
    let row = unpaired(tree, address, Some(order), cache, stop).await?.row;
    if row.visible {
        return Ok(Some((row.chunk.position, row.chunk.order)));
    }
    if let Some(position) = row.continuation {
        let first = unpaired(tree, &position, None, cache, stop).await?.row;
        return Ok(Some((first.chunk.position, first.chunk.order)));
    }
    Ok(None)
}
pub(super) async fn selected(
    tree: &SourceTree,
    address: &wire::HistoryRowAddress,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Selected, String> {
    let mut row = unpaired(tree, address, None, cache, stop).await?;
    pair(tree, &mut row, cache, stop).await?;
    Ok(row)
}
// Recall positions include inspectable receipts that are not transcript entries.
// Scan past them rather than returning an empty page before the actual history ends.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Shape {
    Rows,
    /// With `cursor`, a step at the anchor belongs to a group already returned.
    Groups {
        cursor: bool,
    },
    Steps,
}
#[expect(
    clippy::too_many_arguments,
    reason = "Window scanning binds source tree, cursor direction, view shape, turn scope, cache and cancellation"
)]
pub(super) fn window<'a>(
    tree: &'a SourceTree,
    anchor: Option<wire::HistoryRowAddress>,
    reverse: bool,
    include_thinking: bool,
    limit: usize,
    cache: &'a mut Cache,
    turn: Option<RunRows>,
    shape: Shape,
    stop: &'a tokio_util::sync::CancellationToken,
) -> BoxFuture<'a, Result<Vec<Selected>, String>> {
    // Group backfill polls a second scan while the first is suspended. Keep
    // each scan's state out of its caller's future.
    Box::pin(scan_window(
        tree,
        anchor,
        reverse,
        include_thinking,
        limit,
        cache,
        turn,
        shape,
        stop,
    ))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Window scanning binds source tree, cursor direction, view shape, turn scope, cache and cancellation"
)]
async fn scan_window(
    tree: &SourceTree,
    anchor: Option<wire::HistoryRowAddress>,
    reverse: bool,
    include_thinking: bool,
    limit: usize,
    cache: &mut Cache,
    turn: Option<RunRows>,
    shape: Shape,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Vec<Selected>, String> {
    let origin = anchor.clone();
    let mut bound = anchor;
    let mut exclude_anchor = false;
    let mut rows = Vec::new();
    let mut folded = None;
    let mut first = true;
    let mut may_backfill = origin.is_some();
    let mut steps_turn = None;
    let mut skip_turn: Option<Option<TurnKey>> = None;
    let mut pending: Option<(Option<TurnKey>, Vec<Selected>, bool)> = None;
    loop {
        let filter = match turn {
            Some(RunRows::Only { run, start }) => Some(RunRows::Only {
                run,
                start: if first { start } else { None },
            }),
            Some(selection) => Some(selection),
            None => folded.map(|(run, attempt)| RunRows::Folded { run, attempt }),
        };
        let page_size = match shape {
            Shape::Groups { .. } => 32,
            _ => limit.saturating_add(1).min(32) as u32,
        };
        let mut positions = tree
            .transcript_positions(bound.clone(), reverse, include_thinking, page_size, filter)
            .await
            .map_err(|error| error.to_string())?;
        first = false;
        let full = positions.len() == page_size as usize;
        let last = positions.last().map(|row| row.address.clone());
        if exclude_anchor
            && positions
                .first()
                .is_some_and(|row| Some(&row.address) == bound.as_ref())
        {
            positions.remove(0);
        }
        let mut seek = None;
        if cache.chat {
            for (index, row) in positions.iter().enumerate() {
                let Some(run) = row.run else { continue };
                if let Some(work) = completed_work(tree, &row.address, run, cache).await?
                    && Some((run, work.attempt)) != folded
                {
                    seek = Some((index, row.address.clone(), (run, work.attempt)));
                    break;
                }
            }
            if let Some((index, ..)) = &seek {
                positions.truncate(*index);
            }
        }
        let live_sequence = |row: &QualifiedRow| match row.address {
            wire::HistoryRowAddress::Live { sequence, .. } => Some(sequence),
            _ => None,
        };
        let mut sequences: Vec<_> = positions.iter().filter_map(live_sequence).collect();
        sequences.dedup();
        let mut live = if sequences.is_empty() {
            Default::default()
        } else {
            let data::DataSource::Live { history, cut } = tree
                .source_for_path(&[], None)
                .await
                .map_err(|e| e.to_string())?
            else {
                return Err("agent_history_live_source_missing".into());
            };
            history
                .items(&cut, sequences)
                .await
                .map_err(|e| e.to_string())?
        };
        let mut positions = positions.into_iter().peekable();
        while let Some(qualified) = positions.next() {
            if stop.is_cancelled() {
                return Err("agent_history_cancelled".into());
            }
            let item = match &qualified.address {
                wire::HistoryRowAddress::Live { sequence, fact, .. } => {
                    let item = if positions.peek().and_then(live_sequence) == Some(*sequence) {
                        live.get(sequence).cloned()
                    } else {
                        live.remove(sequence)
                    };
                    SourceItem::Canonical(
                        item.filter(|item| item.recorded.id == *fact)
                            .ok_or("agent_history_source_missing")?,
                    )
                }
                address => tree.item(address).await.map_err(|e| e.to_string())?,
            };
            if let SourceItem::Canonical(item) = &item
                && !projection::visible(&item.recorded.fact)
            {
                continue;
            }
            let row =
                project_item(tree, &qualified.address, qualified.order, item, cache, stop).await?;
            if !row.row.visible
                || (!include_thinking && row.row.chunk.field == wire::HistoryField::Thinking)
                || (matches!(qualified.address, wire::HistoryRowAddress::Live { .. })
                    && folded.is_some_and(|(run, _)| qualified.run == Some(run))
                    && row.row.chunk.role == wire::Role::Assistant
                    && !row.row.chunk.final_output)
            {
                continue;
            }
            let step = step(&row.row.chunk);
            match shape {
                Shape::Rows => rows.push(row),
                Shape::Steps => {
                    let key = turn_key(&row.row.chunk);
                    if !step || *steps_turn.get_or_insert_with(|| key.clone()) != key {
                        return Ok(rows);
                    }
                    rows.push(row);
                }
                Shape::Groups { cursor } => {
                    if step {
                        let key = turn_key(&row.row.chunk);
                        if cursor {
                            if origin.as_ref() == Some(&row.row.chunk.position) {
                                if reverse {
                                    skip_turn = Some(key);
                                }
                                continue;
                            }
                            if skip_turn.as_ref().is_some_and(|turn| *turn == key) {
                                continue;
                            }
                        }
                        skip_turn = None;
                        if pending.as_ref().is_some_and(|(turn, ..)| *turn != key) {
                            let (_, members, extend) = pending.take().expect("pending group");
                            rows.extend(
                                group(
                                    tree,
                                    members,
                                    reverse,
                                    extend,
                                    include_thinking,
                                    cache,
                                    stop,
                                )
                                .await?,
                            );
                            if rows.len() >= limit {
                                return Ok(rows);
                            }
                        }
                        pending
                            .get_or_insert_with(|| (key, Vec::new(), may_backfill))
                            .1
                            .push(row);
                        may_backfill = false;
                        continue;
                    }
                    skip_turn = None;
                    if let Some((_, members, extend)) = pending.take() {
                        rows.extend(
                            group(
                                tree,
                                members,
                                reverse,
                                extend,
                                include_thinking,
                                cache,
                                stop,
                            )
                            .await?,
                        );
                        if rows.len() >= limit {
                            return Ok(rows);
                        }
                    }
                    rows.push(row);
                }
            }
            may_backfill = false;
            if rows.len() >= limit {
                return Ok(rows);
            }
        }
        if let Some((_, address, work)) = seek {
            bound = Some(address);
            exclude_anchor = false;
            folded = Some(work);
            continue;
        }
        if !full {
            if let Some((_, members, extend)) = pending.take() {
                rows.extend(
                    group(
                        tree,
                        members,
                        reverse,
                        extend,
                        include_thinking,
                        cache,
                        stop,
                    )
                    .await?,
                );
            }
            return Ok(rows);
        }
        bound = last;
        exclude_anchor = true;
    }
}
type TurnKey = (
    Vec<RunId>,
    Option<SnapshotId>,
    Option<String>,
    Option<maka_agent_facts::history_snapshot::ImportedTurnOrdinal>,
);
fn turn_key(chunk: &wire::Chunk) -> Option<TurnKey> {
    let position = &chunk.position;
    let path = position.path().to_vec();
    match position {
        wire::HistoryRowAddress::Imported { .. } => chunk
            .imported_turn
            .map(|turn| (path, snapshot_id(position), None, Some(turn))),
        _ => chunk
            .turn_id
            .clone()
            .map(|turn| (path, snapshot_id(position), Some(turn), None)),
    }
}
fn step(chunk: &wire::Chunk) -> bool {
    use maka_agent_facts::message::MessageOrigin;
    if turn_key(chunk).is_none() {
        return false;
    }
    if chunk.tool.is_some() {
        return true;
    }
    match chunk.role {
        wire::Role::Failure | wire::Role::Compaction => false,
        wire::Role::Assistant => chunk.field == wire::HistoryField::Thinking,
        wire::Role::User => chunk
            .origin
            .as_ref()
            .is_some_and(|origin| !matches!(origin, MessageOrigin::Goal { .. })),
        _ => true,
    }
}
/// A scan that began inside a group also reads the group's rows behind its origin.
async fn group(
    tree: &SourceTree,
    mut members: Vec<Selected>,
    reverse: bool,
    extend: bool,
    include_thinking: bool,
    cache: &mut Cache,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Option<Selected>, String> {
    if extend {
        let from = members[0].row.chunk.position.clone();
        let mut more = window(
            tree,
            Some(from.clone()),
            !reverse,
            include_thinking,
            usize::MAX,
            cache,
            None,
            Shape::Steps,
            stop,
        )
        .await?;
        if more
            .first()
            .is_some_and(|row| row.row.chunk.position == from)
        {
            more.remove(0);
        }
        more.reverse();
        more.extend(members);
        members = more;
        if reverse {
            members.reverse();
        }
    } else if reverse {
        members.reverse();
    }
    let returned: std::collections::BTreeSet<String> = members
        .iter()
        .filter_map(|member| member.row.chunk.tool.as_ref())
        .filter(|tool| tool.result.is_some())
        .map(|tool| tool.tool_use_id.clone())
        .collect();
    for member in &mut members {
        if member
            .row
            .chunk
            .tool
            .as_ref()
            .is_some_and(|tool| tool.call.is_some() && !returned.contains(&tool.tool_use_id))
        {
            pair(tree, member, cache, stop).await?;
        }
        if member.row.chunk.field == wire::HistoryField::Thinking
            && matches!(member.row.body, projection::Body::Field(_))
        {
            let RenderedExcerpt {
                offset,
                total,
                text,
                ..
            } = display(
                member,
                wire::HistoryView::Chat,
                SourcePosition::Start,
                4096,
                stop,
            )
            .await?;
            if offset + text.len() as u64 >= total && text.trim().is_empty() {
                member.row.body = projection::Body::Empty;
            }
        }
    }
    Ok(summarize(members))
}
pub(super) fn thought_tail(body: &TextBody) -> Option<String> {
    const LAST_THOUGHT_TAIL_BYTES: usize = 3072;
    let total = body.len_bytes();
    let mut start = total.saturating_sub(LAST_THOUGHT_TAIL_BYTES);
    let slice = loop {
        if let Some(slice) = body.slice(start..total) {
            break slice;
        }
        start += 1;
    };
    let mut text = slice.to_string();
    text.truncate(text.trim_end().len());
    (!text.is_empty()).then_some(text)
}
fn summarize(members: Vec<Selected>) -> Option<Selected> {
    enum Seat {
        Tool(usize),
        Thought,
        Message,
        Other,
    }
    let mut seats = Vec::new();
    let mut tools: Vec<(wire::Tool, Pairing)> = Vec::new();
    let mut tool_indices = std::collections::HashMap::<&str, usize>::new();
    for (member, selected) in members.iter().enumerate() {
        let chunk = &selected.row.chunk;
        if let Some(tool) = &chunk.tool {
            match tool_indices.get(tool.tool_use_id.as_str()).copied() {
                Some(index) => {
                    let (paired, pairing) = &mut tools[index];
                    pairing.absorb(paired, selected);
                }
                None => {
                    let mut paired = wire::Tool {
                        tool_use_id: tool.tool_use_id.clone(),
                        call: None,
                        result: None,
                    };
                    let mut pairing = Pairing::default();
                    pairing.absorb(&mut paired, selected);
                    tool_indices.insert(tool.tool_use_id.as_str(), tools.len());
                    seats.push((member, Seat::Tool(tools.len())));
                    tools.push((paired, pairing));
                }
            }
        } else if chunk.field == wire::HistoryField::Thinking {
            if !matches!(&selected.row.body, projection::Body::Text(body)
                if body.chunks().all(|text| text.trim().is_empty()))
                && !matches!(selected.row.body, projection::Body::Empty)
            {
                seats.push((member, Seat::Thought));
            }
        } else if chunk.role == wire::Role::User {
            seats.push((member, Seat::Message));
        } else {
            seats.push((member, Seat::Other));
        }
    }
    let callers: std::collections::BTreeSet<&str> = tools
        .iter()
        .filter_map(|(tool, _)| tool.call.as_ref())
        .filter(|call| call.origin == wire::ToolCallOrigin::CodeMode)
        .flat_map(|call| call.ancestor_tool_use_ids.iter().map(String::as_str))
        .collect();
    let shown: Vec<&(usize, Seat)> = seats
        .iter()
        .filter(|(_, seat)| match seat {
            // A return whose call is outside the group belongs to the call's group.
            Seat::Tool(index) => {
                let tool = &tools[*index].0;
                tool.call.is_some()
                    && (!callers.contains(tool.tool_use_id.as_str())
                        || tool.result.as_ref().is_some_and(|result| result.is_error))
            }
            _ => true,
        })
        .collect();
    let kind = |seat: &Seat| match seat {
        Seat::Tool(index) => Some(wire::WorkKind::Tool {
            presentation: tools[*index]
                .0
                .call
                .as_ref()
                .and_then(|call| call.presentation.clone()),
        }),
        Seat::Thought => Some(wire::WorkKind::Thought),
        Seat::Message => Some(wire::WorkKind::Message),
        Seat::Other => None,
    };
    let first = seats
        .iter()
        .find(|(_, seat)| !matches!(seat, Seat::Tool(index) if tools[*index].0.call.is_none()))?
        .0;
    let (_, last) = shown.last()?;
    let mut kinds = Vec::new();
    for kind in shown.iter().filter_map(|(_, seat)| kind(seat)) {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    let mut images = Vec::new();
    let mut tool_count = 0;
    for (_, seat) in &shown {
        let Seat::Tool(index) = seat else { continue };
        tool_count += 1;
        let Some(result) = &tools[*index].0.result else {
            continue;
        };
        if result.image {
            images.push(wire::WorkImage {
                position: result.position.clone(),
                image: None,
            });
        }
        images.extend((0..result.images).map(|image| wire::WorkImage {
            position: result.position.clone(),
            image: Some(image),
        }));
    }
    let image_count = images.len() as u64;
    images.drain(..images.len().saturating_sub(4));
    let end_member = members.last()?;
    let end = &end_member.row.chunk;
    let unfinished = matches!(end.position, wire::HistoryRowAddress::Live { .. })
        && end
            .timing
            .as_ref()
            .is_some_and(|timing| timing.finished.is_none());
    let last_thought = unfinished
        .then(|| {
            seats.iter().rev().find_map(|(index, seat)| {
                matches!(seat, Seat::Thought)
                    .then(|| &members[*index].row)
                    .and_then(|row| {
                        let projection::Body::Text(body) = &row.body else {
                            return None;
                        };
                        Some(Box::new(wire::WorkThought {
                            position: row.chunk.position.clone(),
                            offset: body.len_bytes() as u64,
                            text: thought_tail(body)?,
                        }))
                    })
            })
        })
        .flatten();
    let end_offset =
        if unfinished && end.tool.is_none() && end.field == wire::HistoryField::Thinking {
            match &end_member.row.body {
                projection::Body::Text(body) => body.len_bytes() as u64,
                _ => 0,
            }
        } else {
            0
        };
    let work = wire::WorkGroup {
        end: wire::Cursor {
            field: end.field,
            position: end.position.clone(),
            offset: end_offset,
        },
        last: kind(last).unwrap_or(wire::WorkKind::Message),
        first_tool_use_id: members[first]
            .row
            .chunk
            .tool
            .as_ref()
            .map(|tool| tool.tool_use_id.clone()),
        last_call: match last {
            Seat::Tool(index) => tools[*index].0.call.clone().map(Box::new),
            _ => None,
        },
        last_thought,
        kinds,
        thoughts: shown
            .iter()
            .filter(|(_, seat)| matches!(seat, Seat::Thought))
            .count() as u64,
        tools: tool_count,
        messages: shown
            .iter()
            .filter(|(_, seat)| matches!(seat, Seat::Message))
            .count() as u64,
        image_count,
        images,
    };
    let first = members.into_iter().nth(first)?;
    let mut chunk = first.row.chunk;
    chunk.text.clear();
    chunk.offset = 0;
    chunk.total_bytes = 0;
    chunk.tool = None;
    chunk.attachments.clear();
    chunk.has_references = false;
    chunk.message_id = None;
    chunk.work = Some(Box::new(work));
    Some(Selected {
        data: first.data,
        item: first.item,
        row: projection::Row {
            chunk,
            visible: true,
            continuation: None,
            evidence_text: projection::EvidenceText::Unmapped,
            body: projection::Body::Empty,
            fields: Vec::new(),
        },
    })
}
#[derive(Default)]
struct Pairing {
    call: Option<wire::RowPosition>,
    rank: (bool, u8),
}
impl Pairing {
    fn absorb(&mut self, paired: &mut wire::Tool, selected: &Selected) -> bool {
        let Some(tool) = &selected.row.chunk.tool else {
            return true;
        };
        if let Some(call) = &tool.call {
            if self
                .call
                .as_ref()
                .is_some_and(|position| *position != call.position)
            {
                return false;
            }
            self.call = Some(call.position.clone());
            paired.call = Some(call.clone());
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
        if let Some(result) = &tool.result {
            let rank = (
                result.settlement != Some(maka_agent_facts::tool_call::ToolSettlement::Unknown),
                rank,
            );
            // Later uncertainty or cleanup receipts cannot replace a known return.
            if rank >= self.rank {
                paired.result = Some(result.clone());
                self.rank = rank;
            }
        }
        true
    }
}
pub(super) async fn pair(
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
    let mut pairing = Pairing::default();
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
            let selected =
                unpaired(tree, &position.address, Some(position.order), cache, stop).await?;
            if !selected.row.visible {
                continue;
            }
            if !pairing.absorb(&mut paired, &selected) {
                cache.tools.insert(key, None);
                return Ok(());
            }
        }
    }
    row.row.chunk.tool = Some(paired.clone());
    cache.tools.insert(key, Some(paired));
    Ok(())
}
pub(super) fn display_field(row: &projection::Row, view: wire::HistoryView) -> Option<SourceField> {
    if view == wire::HistoryView::Text
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
    }
}
pub(super) async fn display(
    selected: &Selected,
    view: wire::HistoryView,
    position: SourcePosition,
    limit: usize,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<RenderedExcerpt, String> {
    let row = &selected.row;
    if view != wire::HistoryView::Text && row.chunk.role == wire::Role::Compaction {
        return excerpt_ref(&Field::Text(TextBody::default()), None, position, limit);
    }
    if let Some(field) = display_field(row, view) {
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
    let mut cache = Cache::default();
    if scope.identity.agent().is_some() {
        cache.reader = Reader::ModelTool;
    }
    let selected = selected(&tree, &address, &mut cache, &scope.cancellation).await?;
    if scope.identity.agent().is_some()
        && input.field == SourceField::Original
        && let (data::DataSource::Snapshot(snapshot), SourceItem::Imported { message, .. }) =
            (&selected.data, &selected.item)
        && snapshot
            .restricted_original(message)
            .await
            .map_err(|e| e.to_string())?
    {
        return Err("Restricted memory source".into());
    }
    let (mut source, indexed_field) = source_value(
        &selected,
        input.field,
        input.path,
        input.position,
        &scope.cancellation,
    )
    .await?;
    if scope.identity.agent().is_some() {
        let mut positions = std::collections::BTreeSet::from([address.clone()]);
        if let Some(tool) = &source.tool {
            positions.extend(tool_positions(tool).cloned());
        }
        let rows = restrictions(owner, scope, &tree, positions.into_iter().collect()).await?;
        if let Some(tool) = &mut source.tool {
            filter_tool(tool, &rows);
        }
        if let Some(spans) = rows.get(&address) {
            mask_goal_objective(&mut source.origin, selected.goal_objective_offset(), spans);
        }
        let origin = selected.row.field_origin(source.field);
        match field_access(&rows, &address, origin) {
            FieldAccess::Hidden => return Err("Restricted memory source".into()),
            FieldAccess::Open => {}
            FieldAccess::Restricted(spans) => {
                if source.path.as_ref().is_some_and(|path| !path.is_empty()) {
                    return Err("Restricted memory source".into());
                }
                let start = if source.role == wire::SourceRole::User
                    && source.field == SourceField::Body
                {
                    Some(0)
                } else if let Some(start) = selected.row.evidence_text.source_offset(source.field) {
                    Some(start)
                } else if let Some(field) =
                    indexed_field.or_else(|| selected.indexed_field(source.field, source.format))
                    && let Some(excerpt) =
                        field.excerpt(&address, source.offset, source.total_bytes, &source.text)
                {
                    history
                        .excerpt_offsets(vec![excerpt])
                        .await
                        .map_err(|e| e.to_string())?
                        .get(&address)
                        .copied()
                } else {
                    None
                };
                let start = start.ok_or("Restricted memory source")?;
                maka_agent_state::memory::recall::mask(
                    &mut source.text,
                    start + source.offset,
                    spans,
                );
            }
        }
    }
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
    source_value(&selected, field, path, position, stop)
        .await
        .map(|(source, _)| source)
}
async fn source_value(
    selected: &Selected,
    field: SourceField,
    path: Option<Vec<SourceSegment>>,
    position: SourcePosition,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<(wire::HistorySource, Option<ProjectedField>), String> {
    let row = &selected.row;
    let value = &row
        .fields
        .iter()
        .find(|(kind, _)| *kind == field)
        .ok_or("agent_history_field_invalid")?
        .1;
    let RenderedExcerpt {
        format,
        offset,
        total: total_bytes,
        text,
        indexed_field,
    } = stream::field_excerpt(
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
    let source = wire::HistorySource {
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
    };
    Ok((source, indexed_field))
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
        let RenderedExcerpt {
            offset, mut text, ..
        } = display(
            &selected,
            wire::HistoryView::Text,
            SourcePosition::Start,
            4096,
            &scope.cancellation,
        )
        .await?;
        if scope.identity.agent().is_some() {
            let rows = restrictions(owner, scope, &tree, vec![input.position.clone()]).await?;
            if let Some(spans) = rows.get(&input.position) {
                maka_agent_state::memory::recall::mask(&mut text, offset, spans);
            }
        }
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
) -> Result<RenderedExcerpt, String> {
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
) -> Result<RenderedExcerpt, String> {
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
    Ok(RenderedExcerpt {
        format,
        offset,
        total,
        text: String::from_utf8(bytes).map_err(|_| "agent_cursor_invalid")?,
        indexed_field: None,
    })
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
