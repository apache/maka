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

//! Giant rows produce numeric records directly into the request's one arena.
use super::super::arena_recipes::{ArenaRecipes, List, Node};
use super::*;

pub(in crate::history) enum ArenaProjectedRow {
    User(List),
    Assistant(Node),
    Tool(Node),
    AssistantMetadata(JsonSource),
    Skip,
}

/// Only the intrinsic giant-directory path calls this producer.
pub(in crate::history) async fn project_row(
    metadata: &RowDirectory,
    payload: Option<&PayloadDirectory>,
    context: &ProjectContext<'_>,
    store: &ArenaRecipes,
) -> io::Result<ArenaProjectedRow> {
    let context = context.for_arena();
    if let RowDirectory::User { steering, .. } = metadata {
        return user(payload.ok_or_else(invalid)?, *steering, &context, store).await;
    }
    if let (
        RowDirectory::ToolResult { .. },
        Some(PayloadDirectory::Tool(ToolDirectory::Content { parts })),
    ) = (metadata, payload)
    {
        let content = tool_content(*parts, &context, store).await?;
        let result = super::result(
            metadata,
            ToolOutputRecipe::Content(store.internal().contents(content)),
            ToolResultKind::Settled,
            &context,
        )
        .await?;
        return Ok(ArenaProjectedRow::Tool(
            store
                .result_content(
                    result,
                    content,
                    context.budget.clone(),
                    context.cancellation,
                )
                .await?,
        ));
    }
    match super::project_row(metadata, payload, &context).await? {
        ProjectedRow::User(content) => {
            let list = store
                .content_list(
                    content.as_ref(),
                    context.budget.clone(),
                    context.cancellation,
                )
                .await?;
            Ok(ArenaProjectedRow::User(list))
        }
        ProjectedRow::Assistant(part) => Ok(ArenaProjectedRow::Assistant(
            store
                .assistant(part, context.budget.clone(), context.cancellation)
                .await?,
        )),
        ProjectedRow::Tool(result) => Ok(ArenaProjectedRow::Tool(
            store
                .result(result, context.budget.clone(), context.cancellation)
                .await?,
        )),
        ProjectedRow::AssistantMetadata { options } => {
            Ok(ArenaProjectedRow::AssistantMetadata(options))
        }
        ProjectedRow::Skip => Ok(ArenaProjectedRow::Skip),
    }
}

struct TextParts<'a, 'context> {
    store: &'a ArenaRecipes,
    list: List,
    position: usize,
    context: &'a ProjectContext<'context>,
}
impl<'a, 'context> TextParts<'a, 'context> {
    async fn new(
        store: &'a ArenaRecipes,
        len: usize,
        context: &'a ProjectContext<'context>,
    ) -> io::Result<Self> {
        Ok(Self {
            store,
            list: store.begin_list(len).await?,
            position: 0,
            context,
        })
    }
    async fn push(&mut self, text: TextSource) -> io::Result<()> {
        let node = self
            .store
            .text(text, self.context.budget.clone(), self.context.cancellation)
            .await?;
        self.store.put(self.list, self.position, node).await?;
        self.position = self.position.checked_add(1).ok_or_else(invalid)?;
        Ok(())
    }
    fn finish(self) -> io::Result<List> {
        if self.position != self.list.len {
            return Err(invalid());
        }
        Ok(self.list)
    }
}

async fn tool_content(
    count: u64,
    context: &ProjectContext<'_>,
    store: &ArenaRecipes,
) -> io::Result<List> {
    let count = usize::try_from(count).map_err(io::Error::other)?;
    let content = store.begin_list(count).await?;
    let mut cursor = Children::open(ListKind::ToolParts, count as u64, context).await?;
    let mut index = 0;
    while let Some(child) = cursor.next().await? {
        let ChildDirectory::ToolPart(part) = child else {
            return Err(invalid());
        };
        let part = match part {
            ToolPartDirectory::Text(text) => ContentRecipe::Text {
                text: located::text(text, context)?,
                provider_options: None,
            },
            part => media::tool(&part, media::Mode::Capture, context)
                .await?
                .content
                .ok_or_else(invalid)?,
        };
        let node = store
            .content(part, context.budget.clone(), context.cancellation)
            .await?;
        store.put(content, index, node).await?;
        index += 1;
    }
    if index != count {
        return Err(invalid());
    }
    Ok(content)
}

async fn user(
    input: &PayloadDirectory,
    steering: bool,
    context: &ProjectContext<'_>,
    store: &ArenaRecipes,
) -> io::Result<ArenaProjectedRow> {
    let PayloadDirectory::User {
        text,
        quotes,
        attachments,
        directory_references,
    } = input
    else {
        return Err(invalid());
    };
    let (_, piece_count, content_count) = user_layout(input, steering, context).await?;
    let content = store.begin_list(content_count).await?;
    let mut content_index = 1;
    let mut pieces = TextParts::new(store, piece_count, context).await?;
    if steering {
        pieces
            .push(literal(steering_prefix(context.language)))
            .await?;
    }
    pieces.push(located::text(*text, context)?).await?;
    let mut cursor = Children::open(ListKind::Quotes, *quotes, context).await?;
    let mut first = true;
    while let Some(quote) = cursor.next().await? {
        for piece in quote_pieces(quote, first, context)? {
            pieces.push(piece).await?;
        }
        first = false;
    }
    drop(cursor);
    let mut cursor = Children::open(ListKind::Attachments, *attachments, context).await?;
    let mut first = true;
    while let Some(child) = cursor.next().await? {
        let ChildDirectory::Attachment(attachment) = child else {
            return Err(invalid());
        };
        pieces
            .push(literal(if first { "\n\n" } else { "\n" }))
            .await?;
        first = false;
        let projected = media::attachment(&attachment, media::Mode::Capture, context).await?;
        for piece in projected.pieces {
            pieces.push(piece).await?;
        }
        if let Some(part) = projected.content {
            let part = store
                .content(part, context.budget.clone(), context.cancellation)
                .await?;
            store.put(content, content_index, part).await?;
            content_index += 1;
        }
    }
    drop(cursor);
    for piece in reference_pieces(*directory_references, context).await? {
        pieces.push(piece).await?;
    }
    if steering {
        pieces.push(literal("\n</user_query>")).await?;
    }
    let text = store
        .content_text_list(
            pieces.finish()?,
            None,
            context.budget.clone(),
            context.cancellation,
        )
        .await?;
    store.put(content, 0, text).await?;
    if content_index != content_count {
        return Err(invalid());
    }
    Ok(ArenaProjectedRow::User(content))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
    use maka_agent_facts::{
        attachment::{AttachmentKind, AttachmentRef, StorageRef},
        input::{DirectoryReference, MessageInput, QuoteRef, SessionQuoteSource},
    };
    use maka_event_log::context::semantic::SemanticSelection;

    async fn text_bytes(text: TextSource, budget: Arc<dyn SourceBudget>) -> Vec<u8> {
        let mut cursor = source_text::cursor(text, budget.clone());
        let mut buffer = budget.allocate(256).await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let read = cursor.read_chunk(buffer).await.unwrap();
            bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
            buffer = read.buffer;
            if read.eof {
                return bytes;
            }
        }
    }
    async fn same_content(
        left: Arc<dyn RecipeSource<ContentRecipe>>,
        right: Arc<dyn RecipeSource<ContentRecipe>>,
        budget: Arc<dyn SourceBudget>,
    ) {
        assert_eq!(left.len(), right.len());
        let mut left = left.open(0);
        let mut right = right.open(0);
        loop {
            match (left.next().await.unwrap(), right.next().await.unwrap()) {
                (
                    Some(ContentRecipe::Text { text: a, .. }),
                    Some(ContentRecipe::Text { text: b, .. }),
                ) => assert_eq!(
                    text_bytes(a, budget.clone()).await,
                    text_bytes(b, budget.clone()).await
                ),
                (None, None) => break,
                _ => panic!("expected identical text content kinds"),
            }
        }
    }
    #[tokio::test]
    async fn numeric_user_preserves_captured_projection_text_and_order() {
        let (_directory, root) = crate::test_support::root().await;
        let session = crate::test_support::session(&root, "session").await;
        let execution = session.execution_scope(None).await.unwrap().accept();
        let log = execution.store();
        let quotes = (0..12)
            .map(|i| QuoteRef {
                label: Some(format!("quote {i} <&\"")),
                text: format!("text {i} 世界\n"),
                source_turn_id: None,
                source: Some(SessionQuoteSource {
                    session_id: "origin".into(),
                    session_name: "显示<&>".into(),
                    captured_at: serde_json::Number::from(1).try_into().unwrap(),
                    truncated: false,
                }),
            })
            .collect();
        let content = MessageInput {
            preparation: Vec::new(),
            text: "question 世界".into(),
            display_text: None,
            quotes: Some(quotes),
            attachments: Some(vec![
                AttachmentRef {
                    kind: AttachmentKind::Other,
                    name: "a<&>.txt".into(),
                    mime_type: "text/plain".into(),
                    bytes: 1,
                    storage_ref: StorageRef::ExternalFile {
                        absolute_path: "/tmp/a.txt".into(),
                    },
                },
                AttachmentRef {
                    kind: AttachmentKind::Other,
                    name: "b.txt".into(),
                    mime_type: "text/plain".into(),
                    bytes: 1,
                    storage_ref: StorageRef::WorkspaceFile {
                        relative_path: "b.txt".into(),
                    },
                },
            ]),
            directory_references: Some(vec![DirectoryReference {
                host_id: "host".into(),
                path: "src/<&>".into(),
            }]),
            inline_references: None,
        };
        let through = log
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    Invocation {
                        session_id: "session".into(),
                        turn_id: "turn".into(),
                        run_id: "run".into(),
                        invocation_id: "invocation".into(),
                    },
                    Fact::InvocationOpened {
                        input: InvocationInput::Message {
                            content,
                            request_fingerprint: None,
                            source_messages: Vec::new(),
                        },
                        configuration: None,
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let captured = log
            .capture_source(SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through,
                before: u64::MAX,
                captured_through: through,
                replay: None,
                prior_unknown: false,
            })
            .await
            .unwrap();
        let arena = super::super::super::capture_arena::CaptureArena::new(captured.clone(), None)
            .await
            .unwrap();
        let store = ArenaRecipes::new(arena.clone(), Arc::new(()));
        let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
        let work = resources.acquire_work().await.unwrap();
        let budget = work.budget();
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut page = captured
            .directory_page(None, budget.allocate(32 * 1024).await.unwrap())
            .await
            .unwrap();
        let entry = page.next_row().unwrap().unwrap();
        let RowDirectory::User { payload, .. } = entry.directory else {
            panic!("captured user directory")
        };
        let metadata = RowDirectory::User {
            payload,
            steering: true,
        };
        let payload = entry.payload.unwrap();
        let row_root = captured.metadata_source(&entry.row).unwrap();
        let payload_root = captured.describe_payload(&entry.row).unwrap().unwrap();
        drop(page);
        for language in [Language::En, Language::ZhCn, Language::ZhTw] {
            let context = ProjectContext {
                language,
                vision: false,
                provider: &ProviderKind::Anthropic,
                replay: None,
                captured: Some(&captured),
                row_root: Some(&row_root),
                payload_root: Some(&payload_root),
                arena: Some(&arena),
                internal_arena: false,
                cancellation: &cancel,
                budget: budget.clone(),
                directory_owner: Arc::new(()),
            };
            let ProjectedRow::User(expected) =
                super::super::project_row(&metadata, Some(&payload), &context)
                    .await
                    .unwrap()
            else {
                panic!("user")
            };
            let ArenaProjectedRow::User(actual) =
                project_row(&metadata, Some(&payload), &context, &store)
                    .await
                    .unwrap()
            else {
                panic!("numeric user")
            };
            arena.seal().await.unwrap();
            same_content(expected, store.contents(actual), budget.clone()).await;
        }
        arena.close().await.unwrap();
        drop(store);
        drop(arena);
        drop(captured);
        execution.finish();
    }
}
