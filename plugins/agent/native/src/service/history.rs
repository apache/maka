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

//! Bounded native reads of the state owner's canonical history. UI rows are
//! disposable values, never a second execution log or a recovery authority.
use crate::{contract as ui, owner::Owner};
use maka_agent_facts::{
    context::ModelPurpose,
    durable::*,
    input::RunInput,
    model::{ModelPart, TextKind, body::TextBody},
};
use maka_agent_ports::session::history as wire;
use maka_agent_state::session_history::{
    HistoryCut, HistoryItem, SessionHistory, evidence::ProjectedField,
};
use maka_capabilities::call::Scope;
use serde::de::DeserializeOwned;
use serde_json::Value;

mod media;
mod navigation;
pub(super) use navigation::{landmarks, search};
mod data;
mod imported;
mod projection;
mod source;
mod stream;

pub(super) use media::{attachment_image, tool_image};
pub(crate) use media::{snapshot_attachment_image, snapshot_tool_image};
pub(crate) use source::snapshot_source;

pub(super) async fn authorize_session(
    owner: &Owner,
    scope: &Scope,
    session: &str,
) -> Result<(), String> {
    owner.scoped_session(scope, session).await?;
    if scope.cancellation.is_cancelled() {
        return Err("agent_observation_cancelled".into());
    }
    Ok(())
}
pub(super) async fn authorize(
    owner: &Owner,
    scope: &Scope,
    session: &str,
    before: Option<u64>,
) -> Result<Option<u64>, String> {
    authorize_session(owner, scope, session).await?;
    owner.record_history_read(scope, session, before).await
}
pub(super) async fn open(
    owner: &Owner,
    scope: &Scope,
    session: &str,
) -> Result<(SessionHistory, Option<u64>), String> {
    let before = authorize(owner, scope, session, None).await?;
    Ok((
        scoped_state(owner, scope)?.session_history(owner.run_owner(), session.to_owned()),
        before,
    ))
}
pub(crate) fn scoped_state(
    owner: &Owner,
    scope: &Scope,
) -> Result<maka_agent_state::Store, String> {
    let writer = match scope.identity.agent() {
        Some(execution) => {
            let custody = scope.work_custody().ok_or("agent_work_custody_required")?;
            owner
                .store
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
        }
        None => owner.store.data_writer(),
    }
    .map_err(|error| error.to_string())?;
    owner
        .durable
        .with_data_writer(writer)
        .map_err(|error| error.to_string())
}

async fn cut(history: &SessionHistory, through: Option<u64>) -> Result<HistoryCut, String> {
    match through {
        Some(through) => history.capture_at(through).await,
        None => history.capture().await,
    }
    .map_err(|e| e.to_string())
}

pub(crate) type RestrictedToolResultRows = std::collections::BTreeSet<wire::HistoryRowAddress>;

pub(crate) async fn read(
    owner: &Owner,
    scope: &Scope,
    input: ui::History,
) -> Result<ui::HistoryPage, String> {
    read_with_result_visibility(owner, scope, input)
        .await
        .map(|(page, _)| page)
}

pub(crate) async fn read_with_result_visibility(
    owner: &Owner,
    scope: &Scope,
    mut input: ui::History,
) -> Result<(ui::HistoryPage, RestrictedToolResultRows), String> {
    wire::Read {
        session_id: input.session_id.clone(),
        through: input.through,
        position: input.position.clone(),
        include_thinking: input.include_thinking,
    }
    .validate()
    .map_err(|e| e.to_string())?;
    if let Some(thought) = &input.thought {
        if thought.field != wire::HistoryField::Thinking {
            return Err("invalid execution request: invalid history read".into());
        }
        thought
            .validate(input.through, input.include_thinking)
            .map_err(|e| e.to_string())?;
    }
    authorize_session(owner, scope, &input.session_id).await?;
    let rooms = scoped_state(owner, scope)?.rooms(owner.run_owner());
    if rooms
        .exists(&input.session_id)
        .await
        .map_err(|error| error.to_string())?
    {
        use maka_agent_facts::room::RoomPosition;
        let position = match input.position {
            wire::Position::Start => RoomPosition::Start,
            wire::Position::Tail => RoomPosition::Tail,
            wire::Position::Message { message_id } => RoomPosition::Message { message_id },
            wire::Position::BeforeMessage { message_id } => RoomPosition::Before { message_id },
            wire::Position::AfterMessage { message_id } => RoomPosition::After { message_id },
            wire::Position::AroundMessage { message_id } => RoomPosition::Around { message_id },
            _ => return Err("agent_cursor_invalid".into()),
        };
        let page = rooms
            .page(input.session_id.clone(), input.through, position, 48)
            .await
            .map_err(|error| error.to_string())?;
        authorize_session(owner, scope, &input.session_id).await?;
        return Ok((
            ui::HistoryPage::Room { page: page.into() },
            RestrictedToolResultRows::new(),
        ));
    }
    let (history, before) = open(owner, scope, &input.session_id).await?;
    if input.view == wire::HistoryView::Chat && owner.has_bot_history(&input.session_id).await? {
        input.view = wire::HistoryView::Conversation;
    }
    let cut = cut(&history, input.through).await?;
    let (page, restricted_result_rows) = window(
        owner,
        scope,
        &history,
        &cut,
        &input,
        scope.identity.agent().is_some(),
    )
    .await?;
    authorize(owner, scope, &input.session_id, before).await?;
    Ok((page.into(), restricted_result_rows))
}
type Restrictions = std::collections::BTreeMap<wire::HistoryRowAddress, Vec<(u64, u64)>>;
fn tool_positions(tool: &wire::Tool) -> impl Iterator<Item = &wire::HistoryRowAddress> {
    tool.call
        .iter()
        .map(|call| &call.position)
        .chain(tool.result.iter().map(|result| &result.position))
}
/// A filtered result and a call awaiting its first result have distinct transcript states.
fn filter_tool(tool: &mut wire::Tool, restrictions: &Restrictions) -> bool {
    if tool
        .call
        .as_ref()
        .is_some_and(|call| restrictions.contains_key(&call.position))
    {
        tool.call = None;
    }
    if tool
        .result
        .as_ref()
        .is_some_and(|result| restrictions.contains_key(&result.position))
    {
        tool.result = None;
        return true;
    }
    false
}
async fn restrictions(
    owner: &Owner,
    scope: &Scope,
    tree: &maka_agent_state::session_history::source_tree::SourceTree,
    addresses: Vec<wire::HistoryRowAddress>,
) -> Result<Restrictions, String> {
    for address in &addresses {
        if let wire::HistoryRowAddress::Imported { path, snapshot, .. } = address {
            tree.source_for_path(path, Some(*snapshot))
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    owner
        .memory_data(scope)?
        .query(maka_agent_state::memory::recall::ReadRestrictions {
            owner: owner.run_owner(),
            addresses,
        })
        .await
        .map_err(|e| e.to_string())
}

pub(super) async fn images(
    owner: &Owner,
    scope: &Scope,
    input: ui::HistoryImagesRead,
) -> Result<ui::HistoryImages, String> {
    use maka_agent_state::session_history::source_tree::{SourceItem, SourceTree};
    const LIMIT: u32 = 24;
    let history = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, Some(input.through)).await?;
    let tree = SourceTree::live(&history, &cut)
        .await
        .map_err(|error| error.to_string())?;
    let item = tree
        .item(&input.position)
        .await
        .map_err(|error| error.to_string())?;
    let SourceItem::Canonical(item) = item else {
        authorize(owner, scope, &input.session_id).await?;
        return Ok(ui::HistoryImages {
            tools: Vec::new(),
            next: None,
        });
    };
    let data = tree
        .source_for_path(input.position.path(), source::snapshot_id(&input.position))
        .await
        .map_err(|error| error.to_string())?;
    let mut sources = data
        .image_sources(item.recorded.run, input.after.unwrap_or(0), LIMIT + 1)
        .await
        .map_err(|error| error.to_string())?;
    let next = if sources.len() > LIMIT as usize {
        sources.truncate(LIMIT as usize);
        match sources.last() {
            Some(wire::HistoryRowAddress::Live { sequence, .. }) => Some(*sequence),
            _ => return Err("agent_history_source_missing".into()),
        }
    } else {
        None
    };
    let mut cache = source::Cache::default();
    let mut tools = Vec::new();
    for position in sources {
        if scope.cancellation.is_cancelled() {
            return Err("agent_history_cancelled".into());
        }
        let selected = source::selected(&tree, &position, &mut cache, &scope.cancellation).await?;
        if let Some(tool) = selected.row.chunk.tool
            && tool
                .result
                .as_ref()
                .is_some_and(|result| result.image || result.images > 0)
        {
            tools.push(tool);
        }
    }
    if scope.identity.agent().is_some() {
        let positions = tools.iter().flat_map(tool_positions).cloned().collect();
        let restricted = restrictions(owner, scope, &tree, positions).await?;
        tools.retain_mut(|tool| !filter_tool(tool, &restricted));
    }
    authorize(owner, scope, &input.session_id).await?;
    Ok(ui::HistoryImages { tools, next })
}

pub(super) async fn requests(
    owner: &Owner,
    scope: &Scope,
    input: ui::HistoryRequestsRead,
) -> Result<ui::HistoryRequests, String> {
    use maka_agent_state::session_history::{
        ModelRequestRetry,
        source_tree::{SourceItem, SourceTree},
    };
    const LIMIT: u32 = 24;
    let (history, before) = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, Some(input.through)).await?;
    let tree = SourceTree::live(&history, &cut)
        .await
        .map_err(|error| error.to_string())?;
    let item = tree
        .item(&input.position)
        .await
        .map_err(|error| error.to_string())?;
    let SourceItem::Canonical(item) = item else {
        authorize(owner, scope, &input.session_id, before).await?;
        return Ok(ui::HistoryRequests {
            requests: Vec::new(),
            next: None,
            run_terminated: false,
        });
    };
    let qualified = tree
        .positions(Some(input.position.clone()), false, true, 1)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|row| row.address == input.position)
        .ok_or("agent_history_source_missing")?;
    let data = tree
        .source_for_path(input.position.path(), source::snapshot_id(&input.position))
        .await
        .map_err(|error| error.to_string())?;
    let traces = data
        .model_request_traces_for_reader(
            item.recorded.run,
            input.after.unwrap_or(0),
            LIMIT + 1,
            scope.identity.agent().is_some(),
            Some(&scope.cancellation),
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut path = qualified.order.path;
    let leaf = path
        .len()
        .checked_sub(1)
        .ok_or("agent_history_source_missing")?;
    let mut result = Vec::new();
    let mut last = None;
    let more = traces.requests.len() > LIMIT as usize;
    let millis =
        |value: UnixMillis| u64::try_from(value.0).map_err(|_| "agent_history_timestamp_invalid");
    for trace in traces.requests.into_iter().take(LIMIT as usize) {
        if scope.cancellation.is_cancelled() {
            return Err("agent_history_cancelled".into());
        }
        path[leaf] = trace.sequence;
        last = Some(trace.sequence);
        result.push(ui::HistoryRequest {
            order: wire::HistoryOrder {
                path: path.clone(),
                item_index: 0,
            },
            step_id: trace.step,
            attempt_id: trace.attempt,
            model_id: trace.model_id,
            purpose: trace.purpose,
            started_at: trace.started_at.map(millis).transpose()?,
            first_token_at: trace.first_token_at.map(millis).transpose()?,
            estimated_input_tokens: trace.context.estimated_input_tokens,
            context_window: trace
                .context
                .model_context
                .as_ref()
                .and_then(|model| model.model_context_window),
            input_limit: trace
                .context
                .model_context
                .and_then(|model| model.context_window),
            finished: trace
                .finished
                .map(|finished| {
                    Ok::<_, String>(ui::HistoryRequestFinished {
                        at: millis(finished.at)?,
                        outcome: finished.outcome,
                        usage: finished.usage,
                        diagnostic: finished.diagnostic,
                    })
                })
                .transpose()?,
            retry: match trace.retry {
                Some(ModelRequestRetry::Scheduled { at }) => {
                    Some(ui::HistoryRequestRetry::Scheduled { at: millis(at)? })
                }
                Some(ModelRequestRetry::Started) => Some(ui::HistoryRequestRetry::Started),
                Some(ModelRequestRetry::Cancelled) => Some(ui::HistoryRequestRetry::Cancelled),
                None => None,
            },
        });
    }
    authorize(owner, scope, &input.session_id, before).await?;
    Ok(ui::HistoryRequests {
        requests: result,
        next: if more { last } else { None },
        run_terminated: traces.run_terminated,
    })
}

pub(crate) async fn model_text_page(
    owner: &Owner,
    scope: &Scope,
    input: wire::Read,
) -> Result<wire::Page, String> {
    input.validate().map_err(|e| e.to_string())?;
    let (history, before) = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, input.through).await?;
    let input = ui::History {
        session_id: input.session_id,
        through: input.through,
        position: input.position,
        include_thinking: input.include_thinking,
        view: wire::HistoryView::Text,
        thought: None,
    };
    let (page, _) = window(owner, scope, &history, &cut, &input, true).await?;
    authorize(owner, scope, &input.session_id, before).await?;
    Ok(page)
}

fn whole_record_restricted(spans: &[(u64, u64)]) -> bool {
    spans.contains(&(0, i64::MAX as u64))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldAccess<'a> {
    Open,
    Restricted(&'a [(u64, u64)]),
    Hidden,
}

fn field_access<'a>(
    restrictions: &'a Restrictions,
    row: &wire::HistoryRowAddress,
    origin: Option<&wire::HistoryRowAddress>,
) -> FieldAccess<'a> {
    let Some(origin) = origin else {
        return FieldAccess::Hidden;
    };
    if origin != row
        && restrictions
            .get(row)
            .is_some_and(|spans| whole_record_restricted(spans))
    {
        return FieldAccess::Hidden;
    }
    match restrictions.get(origin) {
        Some(spans) if whole_record_restricted(spans) => FieldAccess::Hidden,
        Some(spans) => FieldAccess::Restricted(spans),
        None => FieldAccess::Open,
    }
}

#[derive(Default)]
struct EvidenceCoordinates {
    fields: std::collections::BTreeMap<wire::HistoryRowAddress, ProjectedField>,
    plain: std::collections::BTreeMap<wire::HistoryRowAddress, u64>,
    objectives: std::collections::BTreeMap<wire::HistoryRowAddress, u64>,
}

fn mask_goal_objective(
    origin: &mut Option<maka_agent_facts::message::MessageOrigin>,
    offset: Option<u64>,
    spans: &[(u64, u64)],
) {
    if let Some(maka_agent_facts::message::MessageOrigin::Goal { objective, .. }) = origin {
        match offset {
            Some(offset) => maka_agent_state::memory::recall::mask(objective, offset, spans),
            None => objective.clear(),
        }
    }
}

async fn window(
    owner: &Owner,
    scope: &Scope,
    history: &SessionHistory,
    cut: &HistoryCut,
    input: &ui::History,
    mask_evidence: bool,
) -> Result<(wire::Page, RestrictedToolResultRows), String> {
    let tree = maka_agent_state::session_history::source_tree::SourceTree::live(history, cut)
        .await
        .map_err(|error| error.to_string())?;
    let mut coordinates = EvidenceCoordinates::default();
    let mut page = tree_window(
        &tree,
        Some(cut.through_sequence),
        input.position.clone(),
        input.thought.as_ref(),
        input.include_thinking,
        input.view,
        mask_evidence.then_some(&mut coordinates),
        &scope.cancellation,
    )
    .await
    .inspect_err(|error| {
        if !scope.cancellation.is_cancelled() {
            tracing::warn!(session = %input.session_id, through = cut.through_sequence,
                position = ?input.position, view = ?input.view, %error, "History page read failed");
        }
    })?;
    let mut restricted_result_rows = RestrictedToolResultRows::new();
    if mask_evidence
        && let wire::Page::Ready {
            chunks,
            tail_thought,
            ..
        } = &mut page
    {
        let mut positions = std::collections::BTreeSet::new();
        for chunk in chunks.iter() {
            positions.insert(chunk.position.clone());
            if let Some(tool) = &chunk.tool {
                positions.extend(tool_positions(tool).cloned());
            }
            if let Some(work) = &chunk.work {
                positions.extend(work.last_call.iter().map(|call| call.position.clone()));
                positions.extend(
                    work.last_thought
                        .iter()
                        .map(|thought| thought.position.clone()),
                );
                positions.extend(work.images.iter().map(|image| image.position.clone()));
            }
            if let Some(work) = &chunk.folded_work {
                positions.extend(work.images.iter().map(|image| image.position.clone()));
            }
        }
        positions.extend(tail_thought.iter().map(|thought| thought.position.clone()));
        let restrictions =
            restrictions(owner, scope, &tree, positions.into_iter().collect()).await?;
        let excerpts = chunks
            .iter()
            .filter_map(|chunk| {
                let spans = restrictions.get(&chunk.position)?;
                if whole_record_restricted(spans) {
                    return None;
                }
                let field = coordinates.fields.get(&chunk.position)?;
                field.excerpt(
                    &chunk.position,
                    chunk.offset,
                    chunk.total_bytes,
                    &chunk.text,
                )
            })
            .collect();
        coordinates.plain.extend(
            history
                .excerpt_offsets(excerpts)
                .await
                .map_err(|e| e.to_string())?,
        );
        for chunk in chunks {
            if let Some(tool) = &mut chunk.tool
                && filter_tool(tool, &restrictions)
                && chunk.role == wire::Role::ToolCall
            {
                restricted_result_rows.insert(chunk.position.clone());
            }
            if let Some(work) = &mut chunk.work {
                work.last_call = work
                    .last_call
                    .take()
                    .filter(|call| !restrictions.contains_key(&call.position));
                work.last_thought = work
                    .last_thought
                    .take()
                    .filter(|thought| !restrictions.contains_key(&thought.position));
                work.images
                    .retain(|image| !restrictions.contains_key(&image.position));
            }
            if let Some(work) = &mut chunk.folded_work {
                work.images
                    .retain(|image| !restrictions.contains_key(&image.position));
            }
            if let Some(spans) = restrictions.get(&chunk.position) {
                mask_goal_objective(
                    &mut chunk.origin,
                    coordinates.objectives.get(&chunk.position).copied(),
                    spans,
                );
                let start =
                    if chunk.role == wire::Role::User && chunk.field == wire::HistoryField::Body {
                        Some(0)
                    } else {
                        coordinates.plain.get(&chunk.position).copied()
                    };
                if let Some(start) = start
                    && !whole_record_restricted(spans)
                {
                    maka_agent_state::memory::recall::mask(
                        &mut chunk.text,
                        start + chunk.offset,
                        spans,
                    );
                } else {
                    chunk.text.clear();
                }
                if chunk.role == wire::Role::ToolResult && !chunk.text.is_empty() {
                    restricted_result_rows.insert(chunk.position.clone());
                }
                chunk.quotes.clear();
                chunk.citation = None;
                chunk.citation_anchor = None;
                chunk.attachments.clear();
                chunk.tool = None;
                chunk.work = None;
                chunk.folded_work = None;
            }
        }
        *tail_thought = tail_thought
            .take()
            .filter(|thought| !restrictions.contains_key(&thought.position));
    }
    Ok((page, restricted_result_rows))
}
pub async fn snapshot_page(
    snapshot: &maka_agent_state::session_history::snapshot::Snapshot,
    position: wire::Position,
    include_thinking: bool,
    view: wire::HistoryView,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<wire::Page, String> {
    let through = match snapshot
        .manifest()
        .await
        .map_err(|error| error.to_string())?
        .origin
    {
        maka_agent_facts::history_snapshot::Origin::Canonical { cut } => Some(cut.through_sequence),
        maka_agent_facts::history_snapshot::Origin::Imported { .. } => None,
    };
    let tree = maka_agent_state::session_history::source_tree::SourceTree::snapshot(snapshot)
        .await
        .map_err(|error| error.to_string())?;
    tree_window(
        &tree,
        through,
        position,
        None,
        include_thinking,
        view,
        None,
        stop,
    )
    .await
}
#[expect(
    clippy::too_many_arguments,
    reason = "History window reading binds source tree, fence, cursor, optional active thought cursor, view, evidence coordinates and cancellation"
)]
async fn tree_window(
    tree: &maka_agent_state::session_history::source_tree::SourceTree,
    through: Option<u64>,
    position: wire::Position,
    thought: Option<&wire::Cursor>,
    include_thinking: bool,
    view: wire::HistoryView,
    mut coordinates: Option<&mut EvidenceCoordinates>,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<wire::Page, String> {
    use maka_agent_state::session_history::source_tree::RunRows;
    use wire::{Position, SourcePosition};
    if matches!(
        position,
        Position::Message { .. } | Position::BeforeMessage { .. } | Position::AfterMessage { .. }
    ) {
        return Err("agent_cursor_invalid".into());
    }
    let page_chunks = if view == wire::HistoryView::Steps {
        64
    } else {
        8
    };
    let mut reverse = matches!(
        &position,
        Position::Tail | Position::Before { .. } | Position::RowEnd { .. }
    );
    let mut anchor = match &position {
        Position::Row { position, field } | Position::RowEnd { position, field } => {
            Some(wire::Cursor {
                position: position.clone(),
                field: *field,
                offset: 0,
            })
        }
        Position::After { cursor } | Position::Before { cursor } => Some(cursor.clone()),
        Position::Event { sequence } => match tree
            .event_position(*sequence, include_thinking)
            .await
            .map_err(|error| error.to_string())?
        {
            Some(row) => Some(wire::Cursor {
                position: row.address,
                field: wire::HistoryField::Body,
                offset: 0,
            }),
            None => {
                return Ok(wire::Page::Ready {
                    through,
                    chunks: Vec::new(),
                    before: None,
                    after: None,
                    tail_thought: None,
                    resolved_anchor: None,
                });
            }
        },
        _ => None,
    };
    let mut cache = source::Cache::default();
    if coordinates.is_some() {
        cache.reader = source::Reader::ModelTool;
    }
    cache.chat = view == wire::HistoryView::Chat;
    let mut turn = None;
    if matches!(view, wire::HistoryView::Turn | wire::HistoryView::Steps) && anchor.is_none() {
        return Err("agent_history_turn_requires_anchor".into());
    }
    let mut shape = match view {
        wire::HistoryView::Chat | wire::HistoryView::Turn => source::Shape::Groups {
            cursor: matches!(position, Position::Before { .. } | Position::After { .. }),
        },
        wire::HistoryView::Steps => source::Shape::Steps,
        wire::HistoryView::Text | wire::HistoryView::Conversation => source::Shape::Rows,
    };
    let probe = if shape == source::Shape::Steps {
        shape
    } else {
        source::Shape::Rows
    };
    let mut tail_thought_candidate = None;
    let mut resolved_anchor = None;
    if let Some(anchor) = &mut anchor {
        let selected = source::unpaired(tree, &anchor.position, None, &mut cache, stop).await?;
        if view == wire::HistoryView::Turn {
            use maka_agent_state::session_history::source_tree::SourceItem;
            let (wire::HistoryRowAddress::Live { .. }, SourceItem::Canonical(item)) =
                (&anchor.position, &selected.item)
            else {
                return Err("agent_history_turn_requires_live_run".into());
            };
            turn = Some((item.recorded.run, item.admission_sequence));
        }
        if !matches!(&position, Position::Event { .. })
            && (selected.row.chunk.field != anchor.field
                || (!include_thinking && anchor.field == wire::HistoryField::Thinking))
        {
            return Err("agent_cursor_invalid".into());
        }
        if matches!(&position, Position::Row { .. }) {
            use maka_agent_facts::executor::Output;
            use maka_agent_state::session_history::source_tree::SourceItem;
            if let Some(first) = selected.row.continuation {
                anchor.position = first.clone();
                resolved_anchor = Some(first);
            } else if selected.row.visible
                && matches!(
                    &selected.item,
                    SourceItem::Canonical(item)
                        if matches!(
                            item.recorded.fact,
                            Fact::ExternalTaskObserved {
                                output: Output::OutputDelta { .. },
                                ..
                            }
                        )
                )
            {
                resolved_anchor = Some(selected.row.chunk.position.clone());
            } else if !selected.row.visible {
                reverse = true;
            }
        } else if matches!(&position, Position::RowEnd { .. } | Position::Event { .. })
            && !selected.row.visible
        {
            reverse = true;
        }
        if view == wire::HistoryView::Chat
            && matches!(&position, Position::After { .. })
            && let wire::HistoryRowAddress::Live {
                sequence: anchor_sequence,
                ..
            } = selected.row.chunk.position
            && selected
                .row
                .chunk
                .timing
                .as_ref()
                .is_some_and(|timing| timing.finished.is_none())
        {
            let mut resummarize = false;
            if selected.row.chunk.tool.is_none()
                && selected.row.chunk.field == wire::HistoryField::Thinking
                && let projection::Body::Text(body) = &selected.row.body
            {
                let total = body.len_bytes() as u64;
                if total > anchor.offset
                    && source::thought_tail(body).is_some()
                    && usize::try_from(anchor.offset)
                        .ok()
                        .and_then(|end| body.slice(0..end))
                        .is_some_and(|prefix| prefix.chunks().all(|chunk| chunk.trim().is_empty()))
                {
                    // Thought crossed from empty/whitespace into visible text; re-summarize the
                    // group once so `work.last` and `work.thoughts` include it too.
                    shape = source::Shape::Groups { cursor: false };
                    resummarize = true;
                }
            }
            if !resummarize {
                let target = thought.filter(|cursor| {
                    matches!(
                        cursor.position,
                        wire::HistoryRowAddress::Live { sequence, .. }
                            if sequence <= anchor_sequence
                    )
                });
                let candidate = if let Some(target) = target {
                    let body = if target.position == selected.row.chunk.position {
                        match &selected.row.body {
                            projection::Body::Text(body) => Some(body),
                            _ => None,
                        }
                    } else {
                        cache.executor_thinking(&target.position)
                    };
                    body.map(|body| (target.position.clone(), target.offset, body))
                } else if selected.row.chunk.tool.is_none()
                    && selected.row.chunk.field == wire::HistoryField::Thinking
                    && let projection::Body::Text(body) = &selected.row.body
                {
                    Some((selected.row.chunk.position.clone(), anchor.offset, body))
                } else {
                    None
                };
                if let Some((position, offset, body)) = candidate {
                    let total = body.len_bytes() as u64;
                    if total > offset
                        && let Some(text) = source::thought_tail(body)
                    {
                        tail_thought_candidate = Some(Box::new(wire::WorkThought {
                            position,
                            offset: total,
                            text,
                        }));
                    }
                }
            }
        }
    }
    let scoped = turn.map(|(run, _)| RunRows::Only { run, start: None });
    let rows = source::window(
        tree,
        anchor.as_ref().map(|cursor| cursor.position.clone()),
        reverse,
        include_thinking,
        // One additional source row covers the inclusive boundary cursor.
        page_chunks + 1,
        &mut cache,
        turn.map(|(run, admission)| RunRows::Only {
            run,
            start: matches!(position, Position::Row { .. }).then_some(admission),
        }),
        shape,
        stop,
    )
    .await?;
    let mut chunks = Vec::new();
    let mut remaining = 32 * 1024;
    'rows: for mut selected in rows {
        if stop.is_cancelled() {
            return Err("agent_observation_cancelled".into());
        }
        if selected.row.chunk.work.is_some() {
            if page_bytes(through, &chunks, &selected.row.chunk, reverse)? > 60 * 1024 {
                if chunks.is_empty() {
                    return Err("agent_history_metadata_exceeds_page".into());
                }
                break;
            }
            chunks.push(selected.row.chunk);
            if chunks.len() == page_chunks {
                break;
            }
            continue;
        }
        let anchored = anchor
            .as_ref()
            .filter(|cursor| cursor.position == selected.row.chunk.position);
        let source_position = match (&position, anchored) {
            (Position::Before { .. }, Some(cursor)) => {
                if cursor.offset == 0 {
                    continue;
                }
                SourcePosition::Before {
                    offset: cursor.offset,
                }
            }
            (Position::After { .. }, Some(cursor)) => SourcePosition::After {
                offset: cursor.offset,
            },
            _ if reverse => SourcePosition::Tail,
            _ => SourcePosition::Start,
        };
        source::pair(tree, &mut selected, &mut cache, stop).await?;
        let source::RenderedExcerpt {
            format,
            offset,
            total,
            text,
            indexed_field,
        } = source::display(&selected, view, source_position, remaining, stop).await?;
        if matches!(&position, Position::After { .. }) && anchored.is_some() && offset == total {
            continue;
        }
        if total > 0 && text.is_empty() {
            break;
        }
        if let Some(coordinates) = &mut coordinates {
            if let Some(start) = selected.row.evidence_text.display_offset(view) {
                coordinates
                    .plain
                    .insert(selected.row.chunk.position.clone(), start);
            } else if let Some(field) = source::display_field(&selected.row, view)
                && let Some(proof) = indexed_field.or_else(|| selected.indexed_field(field, format))
            {
                coordinates
                    .fields
                    .insert(selected.row.chunk.position.clone(), proof);
            }
            if let Some(offset) = selected.goal_objective_offset() {
                coordinates
                    .objectives
                    .insert(selected.row.chunk.position.clone(), offset);
            }
        }
        let mut chunk = selected.row.chunk;
        chunk.offset = offset;
        chunk.total_bytes = total;
        chunk.text = text;
        fragment_metadata(&mut chunk);
        loop {
            if page_bytes(through, &chunks, &chunk, reverse)? <= 60 * 1024 {
                break;
            }
            if chunk.text.is_empty() {
                if chunks.is_empty() {
                    return Err("agent_history_metadata_exceeds_page".into());
                }
                break 'rows;
            }
            let take = chunk.text.len() / 2;
            if reverse {
                let mut remove = chunk.text.len() - take;
                while !chunk.text.is_char_boundary(remove) {
                    remove += 1;
                }
                chunk.offset += remove as u64;
                chunk.text = chunk.text.split_off(remove);
            } else {
                let mut end = take;
                while !chunk.text.is_char_boundary(end) {
                    end -= 1;
                }
                chunk.text.truncate(end);
            }
            fragment_metadata(&mut chunk);
            if total > 0 && chunk.text.is_empty() {
                if chunks.is_empty() {
                    return Err("agent_history_metadata_exceeds_page".into());
                }
                break 'rows;
            }
        }
        remaining -= chunk.text.len();
        let partial = if reverse {
            chunk.offset > 0
        } else {
            chunk.offset + (chunk.text.len() as u64) < chunk.total_bytes
        };
        chunks.push(chunk);
        if remaining == 0 || chunks.len() == page_chunks || partial {
            break;
        }
    }
    if reverse {
        chunks.reverse();
    }
    let mut before = chunks.first().map(|chunk| wire::Cursor {
        position: chunk.position.clone(),
        field: chunk.field,
        offset: chunk.offset,
    });
    let mut after = chunks.last().map(|chunk| match &chunk.work {
        Some(work) => work.end.clone(),
        None => wire::Cursor {
            position: chunk.position.clone(),
            field: chunk.field,
            offset: chunk.offset + chunk.text.len() as u64,
        },
    });
    if let Some(first) = chunks.first()
        && first.offset == 0
        && source::window(
            tree,
            Some(first.position.clone()),
            true,
            include_thinking,
            2,
            &mut cache,
            scoped,
            probe,
            stop,
        )
        .await?
        .len()
            <= 1
    {
        before = None;
    }
    if let Some(last) = &after
        && chunks.last().is_some_and(|chunk| {
            chunk.work.is_some() || chunk.offset + chunk.text.len() as u64 == chunk.total_bytes
        })
        && source::window(
            tree,
            Some(last.position.clone()),
            false,
            include_thinking,
            2,
            &mut cache,
            scoped,
            probe,
            stop,
        )
        .await?
        .len()
            <= 1
    {
        after = None;
    }
    let tail_thought = if chunks.is_empty() {
        tail_thought_candidate
    } else {
        None
    };
    Ok(wire::Page::Ready {
        through,
        chunks,
        before,
        after,
        tail_thought,
        resolved_anchor,
    })
}
fn fragment_metadata(chunk: &mut wire::Chunk) {
    if chunk.offset != 0 {
        chunk.attachments.clear();
        chunk.quotes.clear();
        chunk.citation = None;
        chunk.citation_anchor = None;
        chunk.has_references = false;
    }
}
fn page_bytes(
    through: Option<u64>,
    chunks: &[wire::Chunk],
    next: &wire::Chunk,
    reverse: bool,
) -> Result<usize, String> {
    #[derive(serde::Serialize)]
    struct Cursor<'a> {
        position: &'a wire::HistoryRowAddress,
        field: wire::HistoryField,
        offset: u64,
    }
    #[derive(serde::Serialize)]
    struct Page<'a> {
        kind: &'static str,
        through: Option<u64>,
        chunks: Vec<&'a wire::Chunk>,
        before: Option<Cursor<'a>>,
        after: Option<Cursor<'a>>,
    }
    let mut chunks: Vec<_> = chunks.iter().chain(std::iter::once(next)).collect();
    if reverse {
        chunks.reverse();
    }
    let first = chunks.first().expect("candidate chunk");
    let last = chunks.last().expect("candidate chunk");
    // Include both full qualified continuation paths. Dropping an end cursor
    // later can only shrink this complete transport frame.
    let before = Some(Cursor {
        position: &first.position,
        field: first.field,
        offset: first.offset,
    });
    let after = Some(Cursor {
        position: &last.position,
        field: last.field,
        offset: last.offset + last.text.len() as u64,
    });
    encoded_bytes(&Page {
        kind: "ready",
        through,
        chunks,
        before,
        after,
    })
}
fn encoded_bytes(value: &impl serde::Serialize) -> Result<usize, String> {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).map_err(|e| e.to_string())?;
    Ok(count.0)
}

pub(super) use source::prompt;
pub(crate) use source::source;

fn output_rate(tokens: Option<u64>, millis: Option<u64>) -> Option<f64> {
    Some(tokens? as f64 * 1000.0 / millis.filter(|ms| *ms > 0)? as f64)
}

pub(super) async fn observation(
    owner: &Owner,
    scope: &Scope,
    input: ui::SessionRead,
) -> Result<ui::Observation, String> {
    authorize_session(owner, scope, &input.session_id).await?;
    let rooms = scoped_state(owner, scope)?.rooms(owner.run_owner());
    if rooms
        .exists(&input.session_id)
        .await
        .map_err(|error| error.to_string())?
    {
        let through = rooms
            .capture(&input.session_id)
            .await
            .map_err(|error| error.to_string())?;
        let session = owner
            .session_summary(&input.session_id, &scope.cancellation)
            .await?;
        authorize_session(owner, scope, &input.session_id).await?;
        return Ok(ui::Observation {
            session,
            latest_run_id: None,
            through,
            run: None,
            parts: Vec::new(),
            tool_seeds: Vec::new(),
            last_completed_turn_id: None,
            compacting: None,
            remembered_backend: None,
            metrics: None,
        });
    }
    let (history, before) = open(owner, scope, &input.session_id).await?;
    let observed = history
        .live_observation()
        .await
        .map_err(|e| e.to_string())?;
    let cut = observed.cut;
    let mut executor = None;
    let mut latest_run_id = None;
    let mut run = None;
    let mut last_completed_turn_id = None;
    let mut compacting = None;
    let mut tool_seeds = Vec::new();
    if let Some(latest) = observed.latest {
        let pending_interactions = latest.pending_interactions;
        let latest = latest.source;
        let view = history
            .view_at(&cut, latest.run)
            .await
            .map_err(|e| e.to_string())?;
        if view.terminal.is_none() {
            let progress = if matches!(view.spec.trigger, Trigger::ContextCompact) {
                Some((latest.admission.id.to_string(), latest.admission.at))
            } else if !view.stopped
                && let Some((attempt, summary)) = view.proactive_summary_attempt()
                && summary.closed.is_none()
                && summary.interrupted.is_none()
                && view.waits.values().any(|wait| {
                    wait.satisfied.is_none()
                        && wait.cancelled.is_none()
                        && matches!(wait.reason, WaitReason::Model { attempt: id } if id == attempt)
                })
            {
                let (_, prepared_at) = history
                    .request_preparation(&cut, view.run, summary.step)
                    .await
                    .map_err(|error| error.to_string())?;
                Some((summary.step.to_string(), prepared_at))
            } else if !view.stopped
                && let Some(step) = view.current_step
                && !view
                    .current_attempt
                    .and_then(|id| view.attempts.get(&id))
                    .is_some_and(|attempt| {
                        attempt.step == step
                            && (attempt.closed.is_some() || attempt.interrupted.is_some())
                    })
            {
                let (request, prepared_at) = history
                    .request_preparation(&cut, view.run, step)
                    .await
                    .map_err(|error| error.to_string())?;
                (request.accounting.purpose == ModelPurpose::Summary)
                    .then(|| (step.to_string(), prepared_at))
            } else {
                None
            };
            if let Some((id, started)) = progress {
                compacting = Some(ui::CompactionProgress {
                    id,
                    started_at: started
                        .0
                        .try_into()
                        .map_err(|_| "agent_compaction_timestamp_invalid")?,
                });
            }
        }
        let backend = match &view.spec.backend {
            BackendSpec::Model { .. } => Some(ui::RunBackend::Model),
            BackendSpec::Executor { selection, .. } => {
                let metrics = view.external.as_ref().and_then(|task| {
                    let speed = output_rate(
                        task.turn_usage
                            .as_ref()
                            .and_then(|usage| usage.tokens.output_tokens),
                        task.model_time_ms,
                    );
                    (task.context_usage.is_some() || speed.is_some()).then(|| ui::SessionMetrics {
                        model_id: task
                            .context_usage
                            .as_ref()
                            .and_then(|context| context.model.as_ref())
                            .or(selection.settings.model.as_ref())
                            .unwrap_or(&selection.executor)
                            .clone(),
                        connection_id: None,
                        context_tokens: task.context_usage.as_ref().map(|context| context.used),
                        context_window: task
                            .context_usage
                            .as_ref()
                            .map(|context| context.window.get()),
                        approximate: false,
                        context_last_known: false,
                        output_tokens_per_second: speed,
                    })
                });
                executor = Some((selection.clone(), metrics));
                Some(ui::RunBackend::Executor)
            }
            BackendSpec::Historical {} => None,
        };
        if backend.is_some() {
            latest_run_id = Some(view.run);
        }
        if backend.is_some() && view.terminal == Some(Terminal::Completed) {
            last_completed_turn_id = Some(view.spec.turn_id.clone());
        }
        if let Some(backend) = backend.filter(|_| view.terminal.is_none()) {
            let waiting = matches!(view.spec.origin, RunOrigin::Local)
                && ((!view.stopped
                    && (pending_interactions != 0
                        || view.waits.values().any(|wait| {
                            wait.satisfied.is_none()
                                && wait.cancelled.is_none()
                                && matches!(wait.reason, WaitReason::Approval { .. })
                        })))
                    || view.blockers.values().any(|blocker| {
                        blocker.decision.is_none() && blocker.resolved_by.is_none()
                    }));
            run = Some(ui::Run {
                backend,
                run_id: view.run,
                turn_id: view.spec.turn_id.clone(),
                state: if waiting {
                    ui::RunState::WaitingForUser
                } else if view.current_step.is_none() {
                    ui::RunState::Admitted
                } else {
                    ui::RunState::Running
                },
            });
            let mut active_tools: Vec<_> = view
                .tools
                .values()
                .filter(|tool| tool.accepted.is_none())
                .map(|tool| super::delivery::tool_id(view.run, &tool.key))
                .collect();
            if let Some(task) = view.external.as_ref().filter(|task| task.closed.is_none()) {
                active_tools.extend(
                    task.active_tools
                        .iter()
                        .map(|id| super::delivery::executor_tool_id(view.run, task.task, id)),
                );
            }
            for tool_use_id in active_tools {
                if let Some(position) = history
                    .tool_position(&cut, &tool_use_id)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    tool_seeds.push(ui::ToolSeed {
                        tool_use_id,
                        start_sequence: position.source_sequence,
                    });
                }
            }
        }
    }
    let session = owner
        .session_summary(&input.session_id, &scope.cancellation)
        .await?;
    let remembered_backend = if session.backend.is_none() {
        owner.remembered_backend(&input.session_id).await?
    } else {
        None
    };
    use maka_agent_facts::executor::BackendPreference;
    let preference = session.backend.as_ref().or(remembered_backend.as_ref());
    let metrics = if let Some((selection, metrics)) = executor {
        if run.is_some()
            || preference.is_none()
            || matches!(preference, Some(BackendPreference::Executor { selection: current }) if current == &selection)
        {
            metrics
        } else {
            None
        }
    } else if run.is_none() && matches!(preference, Some(BackendPreference::Executor { .. })) {
        None
    } else {
        history
            .metrics(&cut, Some(&scope.cancellation))
            .await
            .map_err(|error| error.to_string())?
            .map(|basis| ui::SessionMetrics {
                model_id: basis.model_id,
                connection_id: Some(basis.binding.connection_id),
                context_tokens: basis.context_tokens,
                context_window: basis.context_window,
                approximate: basis.context_tokens.is_some()
                    && basis.usage.output_tokens.is_some_and(|tokens| tokens != 0),
                context_last_known: basis.context_last_known,
                output_tokens_per_second: output_rate(
                    basis.usage.output_tokens,
                    basis.model_time_ms,
                ),
            })
    };
    authorize(owner, scope, &input.session_id, before).await?;
    Ok(ui::Observation {
        session,
        last_completed_turn_id,
        compacting,
        remembered_backend,
        metrics,
        latest_run_id,
        through: cut.through_sequence,
        run,
        parts: Vec::new(),
        tool_seeds,
    })
}

/// Read-only context for an external executor's exact admitted prefix. The
/// SessionHistory is the live read capability; `cut` alone grants nothing.
pub(crate) async fn readable_context_into(
    history: &SessionHistory,
    cut: &HistoryCut,
    after_run: Option<RunId>,
    writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    stop: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    use maka_agent_state::session_history::source_tree::{SourceItem, SourceTree};
    let mut tree = SourceTree::live(history, cut)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(run) = after_run {
        tree = tree
            .after_run(run)
            .await
            .map_err(|error| error.to_string())?;
    }
    let mut anchor = None;
    let mut cache = source::Cache::default();
    cache.reader = source::Reader::Conversation;
    loop {
        if stop.is_cancelled() {
            return Err("agent_history_cancelled".into());
        }
        let page = tree
            .positions(anchor.clone(), false, false, 32)
            .await
            .map_err(|error| error.to_string())?;
        if page.is_empty() {
            break;
        }
        let mut checked: std::collections::BTreeSet<_> =
            page.iter().map(|r| r.address.clone()).collect();
        let mut restricted = history
            .read_restrictions(checked.iter().cloned().collect())
            .await
            .map_err(|e| e.to_string())?;
        let mut advanced = false;
        for qualified in page {
            if anchor.as_ref() == Some(&qualified.address) {
                continue;
            }
            anchor = Some(qualified.address.clone());
            advanced = true;
            let selected = source::selected(&tree, &qualified.address, &mut cache, stop).await?;
            if matches!(&selected.item,SourceItem::Canonical(item) if matches!(item.recorded.fact,Fact::Cell{..}))
            {
                continue;
            }
            let name_origin = selected.row.field_origin(wire::SourceField::ToolName);
            if let Some(origin) = name_origin
                && origin != &qualified.address
                && checked.insert(origin.clone())
            {
                restricted.extend(
                    history
                        .read_restrictions(vec![origin.clone()])
                        .await
                        .map_err(|e| e.to_string())?,
                );
            }
            let name_access = field_access(&restricted, &qualified.address, name_origin);
            let row_access =
                field_access(&restricted, &qualified.address, Some(&qualified.address));
            let conversation_text = selected.conversation_prose();
            let source::Selected { data, item, row } = selected;
            if row.chunk.field == wire::HistoryField::Thinking {
                continue;
            }
            let role = match row.chunk.role {
                wire::Role::System => "system",
                wire::Role::Context => "context",
                wire::Role::Tool => "tool",
                wire::Role::User => "user",
                wire::Role::Assistant => "assistant",
                wire::Role::ToolCall => "tool call",
                wire::Role::ToolResult => "tool result",
                wire::Role::Compaction => "compaction",
                wire::Role::Failure => "failure",
            };
            stream::write_bytes(writer, format!("\n[{role}]\n").as_bytes(), stop).await?;
            if let Some(origin) = &row.chunk.origin {
                let language = match &item {
                    SourceItem::Canonical(item) => {
                        data.run_source(item.recorded.run)
                            .await
                            .map_err(|error| error.to_string())?
                            .spec
                            .language
                    }
                    SourceItem::Imported { .. } => maka_agent_facts::language::Language::EN,
                };
                stream::write_bytes(writer, origin.prompt_header(language).as_bytes(), stop)
                    .await?;
            }
            for (field, mut value) in row.fields {
                if !public_context_field(field)
                    || (field == wire::SourceField::Body
                        && matches!(&row.body, projection::Body::Empty))
                {
                    continue;
                }
                let access = if field == wire::SourceField::ToolName {
                    name_access
                } else {
                    row_access
                };
                match access {
                    FieldAccess::Open => {}
                    _ if conversation_text && field == wire::SourceField::Body => {}
                    FieldAccess::Restricted(spans)
                        if field == wire::SourceField::ToolName
                            && let Some(start) = row.evidence_text.source_offset(field)
                            && let projection::Field::Text(body) = &value =>
                    {
                        let mut name = body.to_string();
                        maka_agent_state::memory::recall::mask(&mut name, start, spans);
                        value = projection::Field::Text(name.into());
                    }
                    _ => continue,
                }
                stream::write_bytes(writer, format!("{field:?}: ").as_bytes(), stop).await?;
                if let (wire::SourceField::Body, projection::Body::Text(body)) = (field, &row.body)
                {
                    for chunk in body.chunks() {
                        stream::write_bytes(writer, chunk.as_bytes(), stop).await?;
                    }
                } else {
                    stream::write_field(&data, &item, value, writer, stop).await?;
                }
                stream::write_bytes(writer, b"\n", stop).await?;
            }
            if row_access != FieldAccess::Open {
                continue;
            }
            for attachment in &row.chunk.attachments {
                let reference =
                    serde_json::to_vec(attachment).map_err(|error| error.to_string())?;
                stream::write_bytes(writer, b"Attachment: ", stop).await?;
                stream::write_bytes(writer, &reference, stop).await?;
                stream::write_bytes(writer, b"\n", stop).await?;
            }
        }
        if !advanced {
            break;
        }
    }
    Ok(())
}
fn public_context_field(field: wire::SourceField) -> bool {
    !matches!(
        field,
        wire::SourceField::Thinking
            | wire::SourceField::ProviderMetadata
            | wire::SourceField::Original
    )
}

#[cfg(test)]
#[test]
fn field_access_uses_the_original_field_and_respects_whole_record_restrictions() {
    let addr = |sequence| wire::HistoryRowAddress::Live {
        sequence,
        fact: FactId::new(),
        item_index: 0,
    };
    let call = addr(1);
    let returned = addr(2);
    let mut rows = Restrictions::from([
        (call.clone(), vec![(0, 3)]),
        (returned.clone(), vec![(4, 9)]),
    ]);
    assert_eq!(
        field_access(&rows, &returned, Some(&call)),
        FieldAccess::Restricted(&[(0, 3)])
    );
    assert_eq!(
        field_access(&rows, &returned, Some(&returned)),
        FieldAccess::Restricted(&[(4, 9)])
    );
    assert_eq!(field_access(&rows, &returned, None), FieldAccess::Hidden);
    rows.insert(returned.clone(), vec![(0, i64::MAX as u64)]);
    assert_eq!(
        field_access(&rows, &returned, Some(&call)),
        FieldAccess::Hidden
    );
}
