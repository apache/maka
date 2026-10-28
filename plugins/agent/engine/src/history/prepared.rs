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

//! Capture source-backed logical input without a private preparation store.
use super::{
    frozen::{FrozenDirectory, Items, MessageDescriptor},
    source_projector::{ProjectContext, ProjectedRow},
};
use crate::RunError;
use maka_agent_facts::{language::Language, model::prompt_source::source::*};
use maka_event_log::{
    context::semantic::{CapturedSource, PayloadEncoding, PayloadSource, SemanticSelection},
    root_store::SessionStore,
};
use maka_model::{ModelPreparationResources, ProviderKind, prompt::Prompt};
use std::{io, mem, ops::Range, sync::Arc};
use tokio_util::sync::CancellationToken;
mod backed;
#[cfg(test)]
mod backed_tests;

pub(crate) struct FrozenHistory {
    directory: HistoryDirectory,
    resources: ModelPreparationResources,
    provider: ProviderKind,
    arena: super::capture_arena::CaptureArena,
    resident_bytes: usize,
    preparation: Arc<super::preparation::RequestPreparation>,
}
enum HistoryDirectory {
    Resident(Arc<FrozenDirectory>),
    Backed(Arc<super::arena_directory::ArenaDirectory>),
}
impl HistoryDirectory {
    fn source(&self) -> Arc<dyn MessageSource> {
        match self {
            Self::Resident(source) => source.clone(),
            Self::Backed(source) => source.clone(),
        }
    }
    fn identity(&self) -> String {
        match self {
            Self::Resident(source) => source.identity(),
            Self::Backed(source) => source.identity().to_owned(),
        }
    }
    fn breakdown(&self) -> &maka_agent_facts::context::PreparedContextBreakdown {
        match self {
            Self::Resident(source) => source.breakdown(),
            Self::Backed(source) => source.breakdown(),
        }
    }
    fn len(&self) -> usize {
        match self {
            Self::Resident(source) => source.len(),
            Self::Backed(source) => source.len(),
        }
    }
}
struct DirectoryOwner {
    _source: CapturedSource,
    _lease: maka_model::DirectoryLease,
}
enum Plan {
    Resident {
        rows: usize,
        bytes: usize,
        backing_bytes: usize,
        chat: super::chat_source::ChatShape,
    },
    NeedsBacking {
        rows: usize,
        chat: super::chat_source::ChatShape,
    },
}
pub(super) enum MessageBuilder {
    User(Arc<dyn RecipeSource<ContentRecipe>>),
    Assistant {
        parts: Range<usize>,
        options: Option<JsonSource>,
    },
    Tool(ToolResultRecipe),
    DeferredUser {
        parts: Range<usize>,
    },
}
struct Producer {
    id: [u8; 32],
    position: usize,
}
struct AssistantGroup {
    key: u64,
    start: usize,
    options: Option<JsonSource>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn capture(
    log: &Arc<SessionStore>,
    selection: SemanticSelection,
    language: Language,
    vision: bool,
    provider: &ProviderKind,
    cancellation: &CancellationToken,
    resources: ModelPreparationResources,
    overlay_bytes: usize,
) -> Result<Arc<FrozenHistory>, RunError> {
    let captured = log.capture_source(selection).await?;
    let receipt = captured.reserve_local_resource()?;
    let provider = provider.clone();
    let cancellation = cancellation.child_token();
    let observer = cancellation.clone().drop_guard();
    let (reply, receive) = tokio::sync::oneshot::channel();
    let (delivered, acknowledged) = tokio::sync::oneshot::channel();
    let evidence = crate::cleanup::current();
    tokio::spawn(evidence.scope(async move {
        use futures_util::FutureExt;
        let result = std::panic::AssertUnwindSafe(capture_owned(
            captured,
            language,
            vision,
            &provider,
            &cancellation,
            resources,
            overlay_bytes,
        ))
        .catch_unwind()
        .await;
        let result = match result {
            Ok(result) => result,
            Err(_) => {
                receipt.finish(Err("frozen capture worker panicked".into()));
                let _ = reply.send(Err(crate::cleanup::unconfirmed()));
                return;
            }
        };
        let settled = match result {
            Ok(history) => {
                let retained = history.clone();
                if reply.send(Ok(history)).is_ok() && acknowledged.await.is_ok() {
                    Ok(())
                } else {
                    retained.close().await.map_err(|error| {
                        let reason = error.to_string();
                        let _ = crate::cleanup::preparation_failed(error);
                        reason
                    })
                }
            }
            Err(error) => {
                let unconfirmed = error.is_cleanup_unconfirmed();
                let _ = reply.send(Err(error));
                if unconfirmed {
                    Err("frozen input cleanup is unconfirmed".to_owned())
                } else {
                    Ok(())
                }
            }
        };
        receipt.finish(settled);
    }));
    let result = receive
        .await
        .map_err(|error| crate::cleanup::preparation_failed(io::Error::other(error)))?;
    if result.is_ok() && delivered.send(()).is_err() {
        if let Ok(history) = result
            && let Err(error) = history.close().await
        {
            return Err(crate::cleanup::preparation_failed(error));
        }
        return Err(crate::cleanup::unconfirmed());
    }
    observer.disarm();
    result
}

async fn capture_owned(
    captured: CapturedSource,
    language: Language,
    vision: bool,
    provider: &ProviderKind,
    cancellation: &CancellationToken,
    resources: ModelPreparationResources,
    overlay_bytes: usize,
) -> Result<Arc<FrozenHistory>, RunError> {
    let work = acquire_work(&resources, cancellation).await?;
    let budget = work.budget();
    let plan = plan(
        &captured,
        language,
        vision,
        provider,
        &budget,
        cancellation,
        resources
            .policy()
            .staging_bytes
            .checked_sub(overlay_bytes)
            .ok_or_else(|| error(io::Error::other("overlay metadata exceeds staging policy")))?,
    )
    .await
    .map_err(error)?;
    drop(budget);
    drop(work);
    let (rows, bytes, backing_bytes, chat) = match plan {
        Plan::Resident {
            rows,
            bytes,
            backing_bytes,
            chat,
        } => (rows, bytes, backing_bytes, chat),
        Plan::NeedsBacking { rows, chat } => {
            return backed::capture(
                captured,
                language,
                vision,
                provider,
                cancellation,
                resources,
                rows,
                chat,
                overlay_bytes,
            )
            .await;
        }
    };
    let resident_arena = bytes
        .checked_add(backing_bytes)
        .is_some_and(|total| total <= resources.policy().staging_bytes - overlay_bytes);
    let reserve = if resident_arena {
        bytes + backing_bytes
    } else {
        bytes
    };
    let staged = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        staged = resources.reserve_staging(reserve.checked_add(overlay_bytes).ok_or_else(|| error(io::Error::other("staging envelope overflow")))?) => staged.map_err(error)?,
    };
    let mut lease = staged.directory(reserve).map_err(error)?;
    let preparation = super::preparation::RequestPreparation::new(staged);
    let arena_lease = if resident_arena {
        Some(lease.split(backing_bytes).map_err(error)?)
    } else {
        None
    };
    let arena = super::capture_arena::CaptureArena::new(captured.clone(), arena_lease)
        .await
        .map_err(error)?;
    let result = async {
        let owner: Arc<dyn Send + Sync> = Arc::new(DirectoryOwner {
            _source: captured.clone(),
            _lease: lease,
        });
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
            payload_root: None,
            internal_arena: false,
        };
        let mut builders = Vec::with_capacity(rows);
        let mut parts = Vec::with_capacity(rows);
        let mut group = None;
        let mut after = None;
        let mut page_buffer = budget.allocate(32 * 1024).await.map_err(error)?;
        loop {
            cancelled(cancellation)?;
            let mut page = captured.metadata_page(after, page_buffer).await?;
            for index in 0..page.len() {
                cancelled(cancellation)?;
                let row = page.row(index).expect("source page declared this row");
                let metadata = raw(&captured, &captured.metadata_source(&row)?)?;
                let assistant = json::field(&metadata, &["kind", "AssistantPart"], budget.clone())
                    .await
                    .map_err(error)?
                    .is_some();
                if !assistant {
                    flush(&mut builders, &parts, &mut group);
                }
                let payload = captured.describe_payload(&row)?;
                let row_context = context.for_payload(payload.as_ref());
                let projected = match &payload {
                    Some(payload) if payload.encoding() == PayloadEncoding::TextFragments => {
                        let text = super::part_text::quoted(
                            &captured,
                            payload,
                            budget.clone(),
                            owner.clone(),
                            cancellation,
                        )
                        .await
                        .map_err(error)?;
                        let options_plan = super::source_json::text_options_footprint(
                            &captured,
                            payload,
                            budget.clone(),
                            cancellation,
                        )
                        .await
                        .map_err(error)?;
                        let options = super::source_json::text_options(
                            &captured,
                            payload,
                            &options_plan,
                            &arena,
                            budget.clone(),
                            owner.clone(),
                            cancellation,
                        )
                        .await
                        .map_err(error)?;
                        super::source_projector::project_text_part(
                            metadata,
                            text,
                            options,
                            &row_context,
                        )
                        .await
                        .map_err(error)?
                    }
                    payload => super::source_projector::project_row(
                        metadata,
                        payload
                            .as_ref()
                            .map(|payload| raw(&captured, payload))
                            .transpose()?,
                        &row_context,
                    )
                    .await
                    .map_err(error)?,
                };
                match projected {
                    ProjectedRow::User(content) => builders.push(MessageBuilder::User(content)),
                    ProjectedRow::Tool(result) => builders.push(MessageBuilder::Tool(result)),
                    ProjectedRow::Assistant(part) if !assistant => {
                        let start = parts.len();
                        parts.push(part);
                        builders.push(MessageBuilder::Assistant {
                            parts: start..parts.len(),
                            options: None,
                        });
                    }
                    ProjectedRow::Assistant(part) => {
                        ensure_group(row.order.source_sequence, &mut builders, &parts, &mut group);
                        parts.push(part);
                    }
                    ProjectedRow::AssistantMetadata { options } => {
                        ensure_group(row.order.source_sequence, &mut builders, &parts, &mut group);
                        if let Some(group) = &mut group
                            && group.options.is_none()
                        {
                            group.options = Some(options);
                        }
                    }
                    ProjectedRow::Skip => {}
                }
            }
            after = page.next;
            page_buffer = page.into_buffer();
            if after.is_none() {
                break;
            }
        }
        flush(&mut builders, &parts, &mut group);
        drop(page_buffer);
        let (builders, deferred) = if chat.media_results != 0 {
            let (builders, deferred) = super::chat_source::project(
                builders,
                chat,
                language,
                &budget,
                owner.clone(),
                cancellation,
            )
            .await
            .map_err(error)?;
            (builders, Some(deferred))
        } else {
            (builders, None)
        };
        arena.seal().await.map_err(error)?;
        if matches!(provider, ProviderKind::Anthropic) {
            freeze_mcp(&builders, &mut parts, &budget, cancellation)
                .await
                .map_err(error)?;
        }
        let parts: Arc<[AssistantRecipe]> = parts.into();
        let mut messages = Vec::with_capacity(
            rows.checked_add(chat.media_results)
                .ok_or_else(|| error(io::Error::other("Chat message count overflow")))?,
        );
        for builder in builders {
            cancelled(cancellation)?;
            let recipe = match builder {
                MessageBuilder::User(content) => MessageRecipe::User {
                    content,
                    provider_options: None,
                },
                MessageBuilder::Assistant {
                    parts: range,
                    options,
                } => MessageRecipe::Assistant {
                    content: Arc::new(Items::range(parts.clone(), range, owner.clone())),
                    provider_options: options,
                },
                MessageBuilder::DeferredUser { parts: range } => MessageRecipe::User {
                    content: Arc::new(Items::range(
                        deferred
                            .as_ref()
                            .expect("deferred Chat message owns its flat part directory")
                            .clone(),
                        range,
                        owner.clone(),
                    )),
                    provider_options: None,
                },
                MessageBuilder::Tool(result) => MessageRecipe::Tool {
                    content: Arc::new(Items::new(vec![result], owner.clone())),
                    provider_options: None,
                },
            };
            messages.push(
                super::measure_source::describe(recipe, &budget, owner.clone(), cancellation)
                    .await
                    .map_err(error)?,
            );
        }
        let directory = Arc::new(FrozenDirectory::new(messages, owner));
        drop(context);
        drop(budget);
        drop(work);
        Ok(Arc::new(FrozenHistory {
            directory: HistoryDirectory::Resident(directory),
            resources,
            provider: provider.clone(),
            arena: arena.clone(),
            resident_bytes: reserve,
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
impl FrozenHistory {
    pub fn prompt(self: &Arc<Self>) -> Prompt {
        Prompt::from_recipes(
            self.recipes(),
            self.directory.identity(),
            self.directory.len(),
            self.directory.breakdown().clone(),
        )
        .with_normalization(self.provider.clone())
    }
    pub fn recipes(&self) -> Arc<dyn MessageSource> {
        self.directory.source()
    }
    pub fn preparation(&self) -> Arc<super::preparation::RequestPreparation> {
        self.preparation.clone()
    }
    pub fn resident_bytes(&self) -> usize {
        self.resident_bytes
    }
    pub fn resources(&self) -> &ModelPreparationResources {
        &self.resources
    }
    pub async fn close(&self) -> io::Result<()> {
        self.arena.close().await
    }
    pub fn arena(&self) -> &super::capture_arena::CaptureArena {
        &self.arena
    }
}
async fn acquire_work(
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<maka_model::WorkLease, RunError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(RunError::Cancelled),
        work = resources.acquire_work() => work.map_err(error),
    }
}
fn raw(captured: &CapturedSource, payload: &PayloadSource) -> Result<JsonSource, RunError> {
    Ok(JsonSource {
        bytes: SourceBytes::Source(captured.byte_source(payload)?),
    })
}
fn error(error: io::Error) -> RunError {
    RunError::Preparation(error)
}
fn cancelled(cancellation: &CancellationToken) -> Result<(), RunError> {
    if cancellation.is_cancelled() {
        Err(RunError::Cancelled)
    } else {
        Ok(())
    }
}
fn flush(
    builders: &mut Vec<MessageBuilder>,
    parts: &[AssistantRecipe],
    group: &mut Option<AssistantGroup>,
) {
    if let Some(group) = group.take()
        && (group.start != parts.len() || group.options.is_some())
    {
        builders.push(MessageBuilder::Assistant {
            parts: group.start..parts.len(),
            options: group.options,
        });
    }
}
fn ensure_group(
    key: u64,
    builders: &mut Vec<MessageBuilder>,
    parts: &[AssistantRecipe],
    group: &mut Option<AssistantGroup>,
) {
    if group.as_ref().is_some_and(|group| group.key == key) {
        return;
    }
    flush(builders, parts, group);
    *group = Some(AssistantGroup {
        key,
        start: parts.len(),
        options: None,
    });
}
fn add(total: &mut usize, bytes: usize) -> io::Result<()> {
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| io::Error::other("frozen directory size overflows"))?;
    Ok(())
}
fn arc(size: usize) -> usize {
    2 * mem::size_of::<usize>() + size
}
fn row_slots() -> usize {
    mem::size_of::<MessageBuilder>()
        + 2 * mem::size_of::<AssistantRecipe>()
        + 2 * mem::size_of::<MessageDescriptor>()
        + 2 * mem::size_of::<[u8; 32]>()
        + 4 * mem::size_of::<IdentifiedText>()
        + 3 * arc(mem::size_of::<Items<AssistantRecipe>>())
        + arc(64)
}
#[allow(clippy::too_many_arguments)]
async fn plan(
    captured: &CapturedSource,
    language: Language,
    vision: bool,
    provider: &ProviderKind,
    budget: &Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
    resident: usize,
) -> io::Result<Plan> {
    let context = ProjectContext {
        language,
        vision,
        provider,
        replay: captured.selection().replay.as_ref(),
        budget: budget.clone(),
        directory_owner: Arc::new(()),
        captured: Some(captured),
        arena: None,
        cancellation,
        payload_root: None,
        internal_arena: false,
    };
    let mut rows = 0usize;
    let mut bytes = arc(mem::size_of::<DirectoryOwner>())
        + 2 * mem::size_of::<[u8; 32]>()
        + FrozenDirectory::fixed_metadata_bytes()
        + arc(mem::size_of::<FrozenDirectory>())
        + arc(mem::size_of::<FrozenHistory>())
        + super::capture_arena::CaptureArena::metadata_bytes()
        + super::preparation::RequestPreparation::metadata_bytes()
        + 2 * arc(mem::size_of::<Vec<crate::prepared_prompt::OwnedOverlay>>());
    let mut backing_bytes = 0usize;
    let mut chat = super::chat_source::ChatShape::default();
    let chat_policy = vision
        && matches!(
            provider,
            ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. }
        );
    let mut after = None;
    let mut page_buffer = budget.allocate(32 * 1024).await?;
    loop {
        if cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "capture cancelled",
            ));
        }
        let mut page = captured
            .metadata_page(after, page_buffer)
            .await
            .map_err(io::Error::other)?;
        for index in 0..page.len() {
            let row = page.row(index).expect("source page declared this row");
            rows = rows
                .checked_add(1)
                .ok_or_else(|| io::Error::other("frozen row count overflows"))?;
            add(&mut bytes, row_slots())?;
            if matches!(provider, ProviderKind::Anthropic) {
                add(&mut bytes, mem::size_of::<Producer>())?;
            }
            let metadata = raw(
                captured,
                &captured.metadata_source(&row).map_err(io::Error::other)?,
            )
            .map_err(io::Error::other)?;
            let payload = captured.describe_payload(&row).map_err(io::Error::other)?;
            let row_context = context.for_payload(payload.as_ref());
            match &payload {
                Some(payload) if payload.encoding() == PayloadEncoding::TextFragments => {
                    add(
                        &mut bytes,
                        text_footprint(captured, payload, &metadata, &row_context).await?,
                    )?;
                    let options_plan = super::source_json::text_options_footprint(
                        captured,
                        payload,
                        budget.clone(),
                        cancellation,
                    )
                    .await?;
                    add(&mut bytes, options_plan.metadata_bytes)?;
                    add(
                        &mut backing_bytes,
                        usize::try_from(options_plan.backing_bytes).map_err(io::Error::other)?,
                    )?;
                }
                payload => {
                    let payload = payload
                        .as_ref()
                        .map(|payload| raw(captured, payload))
                        .transpose()
                        .map_err(io::Error::other)?;
                    if chat_policy {
                        chat.accumulate(
                            super::source_projector::chat_shape_row(
                                metadata.clone(),
                                payload.clone(),
                                &row_context,
                            )
                            .await?,
                        )?;
                    }
                    add(
                        &mut backing_bytes,
                        super::source_projector::backing_bytes_row(
                            metadata.clone(),
                            payload.clone(),
                            &row_context,
                        )
                        .await?,
                    )?;
                    add(
                        &mut bytes,
                        super::source_projector::footprint_row(metadata, payload, &row_context)
                            .await?,
                    )?;
                }
            }
        }
        after = page.next;
        page_buffer = page.into_buffer();
        if after.is_none() {
            break;
        }
    }
    if chat.media_results != 0 {
        add(
            &mut bytes,
            super::chat_source::allocation_bytes(rows, chat, language)?,
        )?;
    }
    if bytes > resident {
        Ok(Plan::NeedsBacking { rows, chat })
    } else {
        Ok(Plan::Resident {
            rows,
            bytes,
            backing_bytes,
            chat,
        })
    }
}
async fn text_footprint(
    captured: &CapturedSource,
    payload: &PayloadSource,
    metadata: &JsonSource,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let mut after = None;
    let mut count = 2usize;
    let mut bytes = 0usize;
    let mut has_options = false;
    while let Some((key, fragment)) = captured
        .next_text_fragment(payload, after)
        .await
        .map_err(io::Error::other)?
    {
        if context.cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "capture cancelled",
            ));
        }
        after = Some(key);
        count = count
            .checked_add(1)
            .ok_or_else(|| io::Error::other("text fragment count overflows"))?;
        let source = captured.byte_source(&fragment).map_err(io::Error::other)?;
        add(&mut bytes, arc(mem::size_of_val(source.as_ref())))?;
        let source = JsonSource {
            bytes: SourceBytes::Source(source),
        };
        if let Some(value) = json::field(
            &source,
            &["TextDelta", "provider_options"],
            context.budget.clone(),
        )
        .await?
            && value.kind != json::JsonKind::Null
        {
            has_options = true;
            add(
                &mut bytes,
                super::source_projector::footprint_text_policy(
                    metadata,
                    Some(&value.source),
                    context,
                )
                .await?,
            )?;
        }
    }
    if !has_options {
        add(
            &mut bytes,
            super::source_projector::footprint_text_policy(metadata, None, context).await?,
        )?;
    }
    add(&mut bytes, super::joined_source::metadata_bytes(count)?)?;
    Ok(bytes)
}

async fn identifier(
    text: &TextSource,
    budget: &Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
) -> io::Result<[u8; 32]> {
    use sha2::Digest;
    let mut hash = sha2::Sha256::new();
    super::measure_source::text_bytes(text, budget, cancellation, |bytes| {
        hash.update(bytes);
        Ok(())
    })
    .await?;
    Ok(hash.finalize().into())
}

async fn freeze_mcp(
    messages: &[MessageBuilder],
    parts: &mut [AssistantRecipe],
    budget: &Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
) -> io::Result<()> {
    let mut producers = Vec::with_capacity(parts.len());
    let mut message = 0;
    while message < messages.len() {
        let MessageBuilder::Assistant { parts: range, .. } = &messages[message] else {
            message += 1;
            continue;
        };
        let start = range.start;
        let mut end = range.end;
        message += 1;
        while let Some(MessageBuilder::Assistant { parts: range, .. }) = messages.get(message) {
            end = range.end;
            message += 1;
        }
        producers.clear();
        for (position, part) in parts.iter().enumerate().take(end).skip(start) {
            if let AssistantRecipe::ToolCall {
                tool_call_id,
                provider_executed: Some(true),
                provider_options: Some(options),
                ..
            } = part
                && let Some(kind) =
                    json::field(options, &["anthropic", "type"], budget.clone()).await?
                && kind.kind == json::JsonKind::String
                && json::text_eq(&kind.text()?, "mcp-tool-use", budget.clone()).await?
            {
                producers.push(Producer {
                    id: identifier(tool_call_id, budget, cancellation).await?,
                    position,
                });
            }
        }
        producers.sort_unstable_by(|left, right| {
            left.id
                .cmp(&right.id)
                .then(left.position.cmp(&right.position))
        });
        for (position, part) in parts.iter_mut().enumerate().take(end).skip(start) {
            if let AssistantRecipe::ToolResult(result) = part {
                let id = identifier(&result.tool_call_id, budget, cancellation).await?;
                let before = producers.partition_point(|producer| {
                    producer.id < id || (producer.id == id && producer.position < position)
                });
                result.replay = if before != 0 && producers[before - 1].id == id {
                    ToolResultReplay::AnthropicMcp
                } else {
                    ToolResultReplay::Ordinary
                };
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::source::generated;
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    fn call() -> AssistantRecipe {
        AssistantRecipe::ToolCall {
            tool_call_id: generated::text("mcp-id"),
            tool_name: generated::text("search"),
            input: ToolInputRecipe::Json(generated::json(&serde_json::json!({}))),
            kind: ToolCallKind::Function,
            provider_executed: Some(true),
            provider_options: Some(generated::json(
                &serde_json::json!({"anthropic":{"type":"mcp-tool-use"}}),
            )),
        }
    }
    fn result() -> AssistantRecipe {
        AssistantRecipe::ToolResult(ToolResultRecipe {
            tool_call_id: generated::text("mcp-id"),
            tool_name: generated::text("search"),
            kind: ToolResultKind::Settled,
            call_kind: ToolCallKind::Function,
            output: ToolOutputRecipe::Text(generated::text("found")),
            parsed_error: None,
            replay: ToolResultReplay::Ordinary,
            provider_options: None,
        })
    }
    #[tokio::test]
    async fn mcp_binding_crosses_assistant_groups_and_stops_at_role_boundary() {
        let mut parts = vec![call(), result(), result()];
        let messages = vec![
            MessageBuilder::Assistant {
                parts: 0..1,
                options: None,
            },
            MessageBuilder::Assistant {
                parts: 1..2,
                options: None,
            },
            MessageBuilder::User(Arc::new(Items::new(Vec::new(), Arc::new(())))),
            MessageBuilder::Assistant {
                parts: 2..3,
                options: None,
            },
        ];
        freeze_mcp(
            &messages,
            &mut parts,
            &(Arc::new(Budget) as Arc<dyn SourceBudget>),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let AssistantRecipe::ToolResult(first) = &parts[1] else {
            panic!("first result")
        };
        let AssistantRecipe::ToolResult(later) = &parts[2] else {
            panic!("later result")
        };
        assert_eq!(first.replay, ToolResultReplay::AnthropicMcp);
        assert_eq!(later.replay, ToolResultReplay::Ordinary);
    }
}
