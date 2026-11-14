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
use maka_agent_state::session_history::{HistoryCut, HistoryItem, SessionHistory};
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

pub(super) async fn authorize(owner: &Owner, scope: &Scope, session: &str) -> Result<(), String> {
    owner.scoped_session(scope, session).await?;
    if scope.cancellation.is_cancelled() {
        return Err("agent_observation_cancelled".into());
    }
    Ok(())
}
pub(super) async fn open(
    owner: &Owner,
    scope: &Scope,
    session: &str,
) -> Result<SessionHistory, String> {
    authorize(owner, scope, session).await?;
    Ok(scoped_state(owner, scope)?.session_history(owner.run_owner(), session.to_owned()))
}
pub(super) fn scoped_state(
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

pub(super) async fn read(
    owner: &Owner,
    scope: &Scope,
    mut input: ui::History,
) -> Result<ui::HistoryPage, String> {
    wire::Read {
        session_id: input.session_id.clone(),
        through: input.through,
        position: input.position.clone(),
        include_thinking: input.include_thinking,
    }
    .validate()
    .map_err(|e| e.to_string())?;
    let history = open(owner, scope, &input.session_id).await?;
    if input.view == wire::HistoryView::Chat && owner.has_bot_history(&input.session_id).await? {
        input.view = wire::HistoryView::Conversation;
    }
    let cut = cut(&history, input.through).await?;
    let page = window(owner, scope, &history, &cut, &input).await?;
    authorize(owner, scope, &input.session_id).await?;
    Ok(page.into())
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
        .model_request_traces(item.recorded.run, input.after.unwrap_or(0), LIMIT + 1)
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
    authorize(owner, scope, &input.session_id).await?;
    Ok(ui::HistoryRequests {
        requests: result,
        next: if more { last } else { None },
        run_terminated: traces.run_terminated,
    })
}

pub(crate) async fn read_page(
    owner: &Owner,
    scope: &Scope,
    input: wire::Read,
) -> Result<wire::Page, String> {
    input.validate().map_err(|e| e.to_string())?;
    let history = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, input.through).await?;
    let input = ui::History {
        session_id: input.session_id,
        through: input.through,
        position: input.position,
        include_thinking: input.include_thinking,
        view: wire::HistoryView::Text,
    };
    let page = window(owner, scope, &history, &cut, &input).await?;
    authorize(owner, scope, &input.session_id).await?;
    Ok(page)
}

async fn window(
    _owner: &Owner,
    scope: &Scope,
    history: &SessionHistory,
    cut: &HistoryCut,
    input: &ui::History,
) -> Result<wire::Page, String> {
    let tree = maka_agent_state::session_history::source_tree::SourceTree::live(history, cut)
        .await
        .map_err(|error| error.to_string())?;
    tree_window(
        &tree,
        Some(cut.through_sequence),
        input.position.clone(),
        input.include_thinking,
        input.view,
        &scope.cancellation,
    )
    .await
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
    tree_window(&tree, through, position, include_thinking, view, stop).await
}
async fn tree_window(
    tree: &maka_agent_state::session_history::source_tree::SourceTree,
    through: Option<u64>,
    position: wire::Position,
    include_thinking: bool,
    view: wire::HistoryView,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<wire::Page, String> {
    use maka_agent_state::session_history::source_tree::RunRows;
    use wire::{Position, SourcePosition};
    const PAGE_CHUNKS: usize = 8;
    let mut reverse = matches!(&position, Position::Tail | Position::Before { .. });
    let anchor = match &position {
        Position::Row { position, field } => Some(wire::Cursor {
            position: position.clone(),
            field: *field,
            offset: 0,
        }),
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
                });
            }
        },
        _ => None,
    };
    let mut cache = source::Cache::default();
    cache.chat = view == wire::HistoryView::Chat;
    let mut turn = None;
    if view == wire::HistoryView::Turn && anchor.is_none() {
        return Err("agent_history_turn_requires_anchor".into());
    }
    if let Some(anchor) = &anchor {
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
        if matches!(&position, Position::Row { .. } | Position::Event { .. })
            && !selected.row.visible
        {
            reverse = true;
        }
    }
    let scoped = turn.map(|(run, _)| RunRows::Only { run, start: None });
    let rows = source::window(
        tree,
        anchor.as_ref().map(|cursor| cursor.position.clone()),
        reverse,
        include_thinking,
        // One additional source row covers the inclusive boundary cursor.
        PAGE_CHUNKS + 1,
        &mut cache,
        turn.map(|(run, admission)| RunRows::Only {
            run,
            start: matches!(position, Position::Row { .. }).then_some(admission),
        }),
        stop,
    )
    .await?;
    let mut chunks = Vec::new();
    let mut remaining = 32 * 1024;
    'rows: for mut selected in rows {
        if stop.is_cancelled() {
            return Err("agent_observation_cancelled".into());
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
        let (_, offset, total, text) =
            source::display(&selected, view, source_position, remaining, stop).await?;
        if matches!(&position, Position::After { .. }) && anchored.is_some() && offset == total {
            continue;
        }
        if total > 0 && text.is_empty() {
            break;
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
        if remaining == 0 || chunks.len() == PAGE_CHUNKS || partial {
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
    let mut after = chunks.last().map(|chunk| wire::Cursor {
        position: chunk.position.clone(),
        field: chunk.field,
        offset: chunk.offset + chunk.text.len() as u64,
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
            stop,
        )
        .await?
        .len()
            <= 1
    {
        before = None;
    }
    if let Some(last) = chunks.last()
        && last.offset + last.text.len() as u64 == last.total_bytes
        && source::window(
            tree,
            Some(last.position.clone()),
            false,
            include_thinking,
            2,
            &mut cache,
            scoped,
            stop,
        )
        .await?
        .len()
            <= 1
    {
        after = None;
    }
    Ok(wire::Page::Ready {
        through,
        chunks,
        before,
        after,
    })
}
fn fragment_metadata(chunk: &mut wire::Chunk) {
    if chunk.offset != 0 {
        chunk.attachments.clear();
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

pub(super) use source::{prompt, source};

pub(super) async fn observation(
    owner: &Owner,
    scope: &Scope,
    input: ui::SessionRead,
) -> Result<ui::Observation, String> {
    let history = open(owner, scope, &input.session_id).await?;
    let observed = history
        .live_observation()
        .await
        .map_err(|e| e.to_string())?;
    let cut = observed.cut;
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
            BackendSpec::Executor { .. } => Some(ui::RunBackend::Executor),
            BackendSpec::Historical {} => None,
        };
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
    let session = owner.session_summary(&input.session_id).await?;
    let remembered_backend = if session.backend.is_none() {
        owner.remembered_backend(&input.session_id).await?
    } else {
        None
    };
    let metrics = history
        .metrics(&cut)
        .await
        .map_err(|error| error.to_string())?
        .map(|basis| {
            let seconds = basis
                .requested_at
                .zip(basis.finished_at)
                .and_then(|(requested, finished)| finished.0.checked_sub(requested.0))
                .filter(|millis| *millis > 0)
                .map(|millis| millis as f64 / 1000.0);
            ui::SessionMetrics {
                model_id: basis.model_id,
                connection_id: Some(basis.binding.connection_id),
                context_tokens: basis.context_tokens,
                context_window: basis.context_window,
                approximate: basis.context_tokens.is_some()
                    && basis.usage.output_tokens.is_some_and(|tokens| tokens != 0),
                context_last_known: basis.context_last_known,
                output_tokens_per_second: basis
                    .usage
                    .output_tokens
                    .zip(seconds)
                    .map(|(tokens, seconds)| tokens as f64 / seconds)
                    .filter(|rate| rate.is_finite()),
            }
        });
    authorize(owner, scope, &input.session_id).await?;
    Ok(ui::Observation {
        session,
        last_completed_turn_id,
        compacting,
        remembered_backend,
        metrics,
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
                    SourceItem::Imported { .. } => maka_agent_facts::language::Language::En,
                };
                stream::write_bytes(writer, origin.prompt_header(language).as_bytes(), stop)
                    .await?;
            }
            for (field, value) in row.fields {
                if !public_context_field(field)
                    || (field == wire::SourceField::Body
                        && matches!(&row.body, projection::Body::Empty))
                {
                    continue;
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
