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

//! Intrinsically large selected directories use numeric records in one arena.
use super::*;
use crate::history::{
    arena_directory,
    arena_recipes::{ArenaRecipes, List, Node},
    source_projector::arena::ArenaProjectedRow,
};
use maka_agent_facts::model::prompt_source::source::generated;

struct Group {
    key: u64,
    start: usize,
    options: Option<JsonSource>,
}
struct Output {
    list: List,
    used: usize,
}
impl Output {
    async fn push(&mut self, store: &ArenaRecipes, node: Node) -> io::Result<()> {
        store.put(self.list, self.used, node).await?;
        self.used += 1;
        Ok(())
    }
}
async fn flush_group(
    group: &mut Option<Group>,
    parts: List,
    part_count: usize,
    out: &mut Output,
    store: &ArenaRecipes,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    if let Some(group) = group.take()
        && (group.start != part_count || group.options.is_some())
    {
        let message = store
            .message_list(
                MessageRole::Assistant,
                parts.range(group.start..part_count)?,
                group.options,
                budget,
                cancel,
            )
            .await?;
        out.push(store, message).await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn capture(
    captured: CapturedSource,
    language: Language,
    vision: bool,
    provider: &ProviderKind,
    cancellation: &CancellationToken,
    resources: ModelPreparationResources,
    rows: usize,
    chat: super::super::chat_source::ChatShape,
    overlay_bytes: usize,
) -> Result<Arc<FrozenHistory>, RunError> {
    let bytes = metadata_bytes();
    let staged = tokio::select! {
        biased;
        _=cancellation.cancelled()=>return Err(RunError::Cancelled),
        staged=resources.reserve_staging(bytes.checked_add(overlay_bytes).ok_or_else(||error(io::Error::other("backed staging envelope overflow")))?)=>staged.map_err(error)?,
    };
    let lease = staged.directory(bytes).map_err(error)?;
    let preparation = super::super::preparation::RequestPreparation::new(staged);
    let arena = super::super::capture_arena::CaptureArena::new(captured.clone(), None)
        .await
        .map_err(error)?;
    let result = async {
        let owner: Arc<dyn Send + Sync> = Arc::new(DirectoryOwner {
            _source: captured.clone(),
            _lease: lease,
        });
        let store = ArenaRecipes::cancellable(arena.clone(), owner.clone(), cancellation);
        let internal = store.internal();
        let work = acquire_work(&resources, cancellation).await?;
        let budget = work.budget();
        let context = ProjectContext {
            language,
            vision,
            provider,
            replay: captured.selection().replay.as_ref(),
            budget: budget.clone(),
            directory_owner: owner.clone(),
            captured: Some(&captured),
            arena: Some(&arena),
            cancellation,
            row_root: None,
            payload_root: None,
            internal_arena: true,
        };
        let parts = store.begin_list(rows).await.map_err(error)?;
        let mut part_count = 0;
        let mut out = Output {
            list: store.begin_list(rows).await.map_err(error)?,
            used: 0,
        };
        let mut group: Option<Group> = None;
        let mut after = None;
        let mut page_buffer = budget.allocate(32 * 1024).await.map_err(error)?;
        loop {
            cancelled(cancellation)?;
            let mut page = captured.directory_page(after, page_buffer).await?;
            while let Some(entry) = page.next_row()? {
                cancelled(cancellation)?;
                let row = entry.row;
                let metadata = entry.directory;
                let assistant = matches!(metadata, RowDirectory::AssistantPart { .. });
                if !assistant {
                    flush_group(
                        &mut group,
                        parts,
                        part_count,
                        &mut out,
                        &store,
                        budget.clone(),
                        cancellation,
                    )
                    .await
                    .map_err(error)?;
                }
                let payload = captured.describe_payload(&row)?;
                let row_root = captured.metadata_source(&row)?;
                let row_context = context.for_row(&row_root, payload.as_ref());
                let projected = super::super::source_projector::arena::project_row(
                    &metadata,
                    entry.payload.as_ref(),
                    &row_context,
                    &store,
                )
                .await
                .map_err(error)?;

                match projected {
                    ArenaProjectedRow::User(content) => {
                        let message = store
                            .message_list(
                                MessageRole::User,
                                content,
                                None,
                                budget.clone(),
                                cancellation,
                            )
                            .await
                            .map_err(error)?;
                        out.push(&store, message).await.map_err(error)?;
                    }
                    ArenaProjectedRow::Tool(result) => {
                        let list = store.begin_list(1).await.map_err(error)?;
                        store.put(list, 0, result).await.map_err(error)?;
                        let message = store
                            .message_list(
                                MessageRole::Tool,
                                list,
                                None,
                                budget.clone(),
                                cancellation,
                            )
                            .await
                            .map_err(error)?;
                        out.push(&store, message).await.map_err(error)?;
                    }
                    ArenaProjectedRow::Assistant(part) => {
                        if !assistant {
                            let list = store.begin_list(1).await.map_err(error)?;
                            store.put(list, 0, part).await.map_err(error)?;
                            let message = store
                                .message_list(
                                    MessageRole::Assistant,
                                    list,
                                    None,
                                    budget.clone(),
                                    cancellation,
                                )
                                .await
                                .map_err(error)?;
                            out.push(&store, message).await.map_err(error)?;
                        } else {
                            if group
                                .as_ref()
                                .is_some_and(|g| g.key != row.order.source_sequence)
                            {
                                flush_group(
                                    &mut group,
                                    parts,
                                    part_count,
                                    &mut out,
                                    &store,
                                    budget.clone(),
                                    cancellation,
                                )
                                .await
                                .map_err(error)?;
                            }
                            group.get_or_insert(Group {
                                key: row.order.source_sequence,
                                start: part_count,
                                options: None,
                            });
                            store.put(parts, part_count, part).await.map_err(error)?;
                            part_count += 1;
                        }
                    }
                    ArenaProjectedRow::AssistantMetadata(options) => {
                        if group
                            .as_ref()
                            .is_some_and(|g| g.key != row.order.source_sequence)
                        {
                            flush_group(
                                &mut group,
                                parts,
                                part_count,
                                &mut out,
                                &store,
                                budget.clone(),
                                cancellation,
                            )
                            .await
                            .map_err(error)?;
                        }
                        let g = group.get_or_insert(Group {
                            key: row.order.source_sequence,
                            start: part_count,
                            options: None,
                        });
                        if g.options.is_none() {
                            g.options = Some(options);
                        }
                    }
                    ArenaProjectedRow::Skip => {}
                }
            }
            after = page.next;
            page_buffer = page.into_buffer();
            if after.is_none() {
                break;
            }
        }
        flush_group(
            &mut group,
            parts,
            part_count,
            &mut out,
            &store,
            budget.clone(),
            cancellation,
        )
        .await
        .map_err(error)?;
        drop(page_buffer);
        let messages = out.list.range(0..out.used).map_err(error)?;
        let messages = project_chat(
            messages,
            chat,
            &store,
            &internal,
            &arena,
            language,
            &budget,
            owner.clone(),
            cancellation,
        )
        .await
        .map_err(error)?;
        if matches!(provider, ProviderKind::Anthropic) {
            freeze_mcp(
                messages,
                rows,
                &store,
                &internal,
                &arena,
                &budget,
                cancellation,
            )
            .await
            .map_err(error)?;
        }
        let mut directory = arena_directory::Builder::new(store.clone(), messages.len)
            .await
            .map_err(error)?;
        for index in 0..messages.len {
            cancelled(cancellation)?;
            let node = store
                .get(messages, index)
                .await
                .map_err(error)?
                .expect("filled message table");
            let recipe = internal.read_message(node).await.map_err(error)?;
            let descriptor = super::super::measure_source::describe_arena(
                recipe,
                &budget,
                owner.clone(),
                cancellation,
                &internal,
            )
            .await
            .map_err(error)?;
            let metadata = MessageMetadata {
                message_index: index,
                logical_identity: descriptor.logical_identity,
                role: descriptor.role,
                last_is_tool_result: descriptor.last_is_tool_result,
                local_tool_names: descriptor.local_tool_names,
                settled_tool_call_ids: descriptor.settled_tool_call_ids,
            };
            directory
                .push(
                    node,
                    metadata,
                    &descriptor.breakdown,
                    descriptor.commitment,
                    budget.clone(),
                    cancellation,
                )
                .await
                .map_err(error)?;
        }
        let directory = directory.finish().map_err(error)?;
        arena.seal().await.map_err(error)?;
        drop(context);
        drop(budget);
        drop(work);
        Ok(Arc::new(FrozenHistory {
            directory: HistoryDirectory::Backed(Arc::new(directory)),
            resources,
            provider: provider.clone(),
            arena: arena.clone(),
            resident_bytes: bytes,
            preparation,
        }))
    }
    .await;
    if result.is_err()
        && let Err(error) = arena.close().await
    {
        return Err(crate::cleanup::preparation_failed(error));
    }
    result
}
pub(super) fn metadata_bytes() -> usize {
    arc(mem::size_of::<DirectoryOwner>())
        + arc(mem::size_of::<FrozenHistory>())
        + super::super::capture_arena::CaptureArena::metadata_bytes()
        + super::super::preparation::RequestPreparation::metadata_bytes()
        + super::super::arena_recipes::ArenaRecipes::metadata_bytes()
        + super::super::arena_directory::ArenaDirectory::metadata_bytes()
        + arc(mem::size_of::<super::super::arena_directory::ArenaDirectory>())
        + 2 * arc(mem::size_of::<Vec<crate::prepared_prompt::OwnedOverlay>>())
}

#[allow(clippy::too_many_arguments)]
async fn project_chat(
    messages: List,
    shape: super::super::chat_source::ChatShape,
    store: &ArenaRecipes,
    internal: &ArenaRecipes,
    _arena: &super::super::capture_arena::CaptureArena,
    language: Language,
    budget: &Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancel: &CancellationToken,
) -> io::Result<List> {
    if shape.media_results == 0 {
        return Ok(messages);
    }
    let maximum = messages
        .len
        .checked_add(shape.media_results)
        .ok_or_else(|| io::Error::other("Chat message count overflow"))?;
    let mut out = Output {
        list: store.begin_list(maximum).await?,
        used: 0,
    };
    let deferred = store
        .begin_list(
            shape
                .media_parts
                .checked_add(shape.media_results)
                .ok_or_else(|| io::Error::other("Chat deferred count overflow"))?,
        )
        .await?;
    let mut deferred_used = 0;
    let mut batch_start = 0;
    for index in 0..messages.len {
        let node = store
            .get(messages, index)
            .await?
            .expect("filled message table");
        let recipe = internal.read_message(node).await?;
        let MessageRecipe::Tool {
            content,
            provider_options,
        } = recipe
        else {
            flush_deferred(
                &mut out,
                store,
                deferred,
                batch_start,
                deferred_used,
                budget.clone(),
                cancel,
            )
            .await?;
            batch_start = deferred_used;
            out.push(store, node).await?;
            continue;
        };
        let outer = store.read(node).await?;
        let results = store.read_list(Node(outer[2])).await?;
        let rewritten = store.begin_list(results.len).await?;
        let mut cursor = content.open(0);
        for result_index in 0..results.len {
            let result_node = store
                .get(results, result_index)
                .await?
                .expect("filled result table");
            let mut result = cursor
                .next()
                .await?
                .ok_or_else(|| io::Error::other("missing frozen result"))?;
            let ToolOutputRecipe::Content(parts) = &result.output else {
                store.put(rewritten, result_index, result_node).await?;
                continue;
            };
            let mut probe = parts.open(0);
            let mut media_count = 0;
            let mut has_audio = false;
            while let Some(part) = probe.next().await? {
                if let Some(audio) = super::super::chat_source::class(&part, budget, cancel).await?
                {
                    media_count += 1;
                    has_audio |= audio;
                }
            }
            if media_count == 0 {
                store.put(rewritten, result_index, result_node).await?;
                continue;
            }
            let result_record = store.read(result_node).await?;
            let original = store.read_list(Node(result_record[4])).await?;
            let kept = store
                .begin_list(
                    original
                        .len
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("Chat kept count overflow"))?,
                )
                .await?;
            let mut kept_used = 0;
            let label = super::super::chat_source::label(
                &result,
                has_audio,
                language,
                budget,
                owner.clone(),
                cancel,
            )
            .await?;
            let label = store
                .content(
                    ContentRecipe::Text {
                        text: label,
                        provider_options: None,
                    },
                    budget.clone(),
                    cancel,
                )
                .await?;
            store.put(deferred, deferred_used, label).await?;
            deferred_used += 1;
            let mut parts_cursor = parts.open(0);
            for part_index in 0..original.len {
                let part = parts_cursor
                    .next()
                    .await?
                    .ok_or_else(|| io::Error::other("missing frozen tool part"))?;
                let part_node = store
                    .get(original, part_index)
                    .await?
                    .expect("filled tool part table");
                if super::super::chat_source::class(&part, budget, cancel)
                    .await?
                    .is_some()
                {
                    store.put(deferred, deferred_used, part_node).await?;
                    deferred_used += 1;
                } else {
                    store.put(kept, kept_used, part_node).await?;
                    kept_used += 1;
                }
            }
            if kept_used == 0 {
                let fallback = store
                    .content(
                        ContentRecipe::Text {
                            text: generated::text(super::super::chat_source::fallback(
                                language, has_audio,
                            )),
                            provider_options: None,
                        },
                        budget.clone(),
                        cancel,
                    )
                    .await?;
                store.put(kept, 0, fallback).await?;
                kept_used = 1;
            }
            let kept = kept.range(0..kept_used)?;
            result.output = ToolOutputRecipe::Content(internal.contents(kept));
            let result = store
                .result_content(result, kept, budget.clone(), cancel)
                .await?;
            store.put(rewritten, result_index, result).await?;
        }
        let message = store
            .message_list(
                MessageRole::Tool,
                rewritten,
                provider_options,
                budget.clone(),
                cancel,
            )
            .await?;
        out.push(store, message).await?;
    }
    flush_deferred(
        &mut out,
        store,
        deferred,
        batch_start,
        deferred_used,
        budget.clone(),
        cancel,
    )
    .await?;
    out.list.range(0..out.used)
}
async fn flush_deferred(
    out: &mut Output,
    store: &ArenaRecipes,
    deferred: List,
    start: usize,
    end: usize,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    if start != end {
        let message = store
            .message_list(
                MessageRole::User,
                deferred.range(start..end)?,
                None,
                budget,
                cancel,
            )
            .await?;
        out.push(store, message).await?;
    }
    Ok(())
}

struct Producers {
    arena: super::super::capture_arena::CaptureArena,
    table: u64,
    capacity: u64,
    epoch: u64,
}
impl Producers {
    async fn new(
        arena: &super::super::capture_arena::CaptureArena,
        store: &ArenaRecipes,
        rows: usize,
    ) -> io::Result<Self> {
        let capacity = rows
            .checked_mul(2)
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| io::Error::other("MCP producer count overflow"))?;
        let table = store
            .begin_list(
                capacity
                    .checked_mul(5)
                    .ok_or_else(|| io::Error::other("MCP table size overflow"))?,
            )
            .await?;
        Ok(Self {
            arena: arena.clone(),
            table: table.table,
            capacity: capacity as u64,
            epoch: 1,
        })
    }
    fn reset(&mut self) -> io::Result<()> {
        self.epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| io::Error::other("MCP run count overflow"))?;
        Ok(())
    }
    async fn lookup(&self, id: [u8; 32], insert: bool) -> io::Result<bool> {
        let table = self.table;
        let capacity = self.capacity;
        let epoch = self.epoch;
        self.arena
            .with_writer(move |writer| {
                let mut slot =
                    u64::from_le_bytes(id[..8].try_into().expect("digest prefix")) % capacity;
                for _ in 0..capacity {
                    let offset = table
                        .checked_add(
                            slot.checked_mul(40)
                                .ok_or_else(|| io::Error::other("MCP slot overflow"))?,
                        )
                        .ok_or_else(|| io::Error::other("MCP slot overflow"))?;
                    let mut record = [0; 40];
                    writer.read_exact_at(offset, &mut record)?;
                    if u64::from_le_bytes(record[..8].try_into().expect("epoch word")) != epoch {
                        if insert {
                            record[..8].copy_from_slice(&epoch.to_le_bytes());
                            record[8..].copy_from_slice(&id);
                            writer.write_at(offset, &record)?;
                        }
                        return Ok(false);
                    }
                    if record[8..] == id {
                        return Ok(true);
                    }
                    slot = (slot + 1) % capacity;
                }
                Err(io::Error::other(
                    "captured MCP producer table exceeded its counted capacity",
                ))
            })
            .await
    }
}
async fn freeze_mcp(
    messages: List,
    rows: usize,
    store: &ArenaRecipes,
    internal: &ArenaRecipes,
    arena: &super::super::capture_arena::CaptureArena,
    budget: &Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    let mut producers = Producers::new(arena, store, rows).await?;
    for index in 0..messages.len {
        let node = store
            .get(messages, index)
            .await?
            .expect("filled message table");
        let recipe = internal.read_message(node).await?;
        let MessageRecipe::Assistant { content, .. } = recipe else {
            producers.reset()?;
            continue;
        };
        let fields = store.read(node).await?;
        let list = store.read_list(Node(fields[2])).await?;
        let mut cursor = content.open(0);
        for part_index in 0..list.len {
            let part = cursor
                .next()
                .await?
                .ok_or_else(|| io::Error::other("missing captured assistant part"))?;
            match part {
                AssistantRecipe::ToolCall {
                    tool_call_id,
                    provider_executed: Some(true),
                    provider_options: Some(options),
                    ..
                } => {
                    if let Some(kind) =
                        json::field(&options, &["anthropic", "type"], budget.clone()).await?
                        && kind.kind == json::JsonKind::String
                        && json::text_eq(&kind.text()?, "mcp-tool-use", budget.clone()).await?
                    {
                        producers
                            .lookup(identifier(&tool_call_id, budget, cancel).await?, true)
                            .await?;
                    }
                }
                AssistantRecipe::ToolResult(result) => {
                    let replay = if producers
                        .lookup(
                            identifier(&result.tool_call_id, budget, cancel).await?,
                            false,
                        )
                        .await?
                    {
                        ToolResultReplay::AnthropicMcp
                    } else {
                        ToolResultReplay::Ordinary
                    };
                    store
                        .set_assistant_replay(
                            store
                                .get(list, part_index)
                                .await?
                                .expect("filled assistant table"),
                            replay,
                        )
                        .await?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}
