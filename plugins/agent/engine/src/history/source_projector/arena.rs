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
    metadata: JsonSource,
    payload: Option<JsonSource>,
    context: &ProjectContext<'_>,
    store: &ArenaRecipes,
) -> io::Result<ArenaProjectedRow> {
    let context = context.for_arena();
    let kind = lookup(&metadata, "kind", &context).await?.source;
    let user_row = json::field(&kind, &["User"], context.budget.clone()).await?;
    if let Some(row) = user_row {
        let input = lookup(payload.as_ref().ok_or_else(invalid)?, "User", &context)
            .await?
            .source;
        return user(
            &input,
            flag(&row.source, "steering", &context).await?,
            &context,
            store,
        )
        .await;
    }
    if let Some(row) = json::field(&kind, &["ToolResult"], context.budget.clone()).await? {
        let payload = payload.as_ref().ok_or_else(invalid)?;
        let fields = json::fields(payload, &["Text", "Tool"], context.budget.clone()).await?;
        if fields[0].is_none() {
            let projection = fields[1].as_ref().map_or(payload, |tool| &tool.source);
            if tagged(projection, "content", &context).await? {
                let content = tool_content(projection, &context, store).await?;
                let result = super::result(
                    &row.source,
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
        }
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
    projection: &JsonSource,
    context: &ProjectContext<'_>,
    store: &ArenaRecipes,
) -> io::Result<List> {
    let parts = lookup(projection, "parts", context).await?.source;
    let mut cursor = json::ArrayCursor::open(parts.clone(), context.budget.clone()).await?;
    let mut count = 0usize;
    while cursor.next().await?.is_some() {
        count = count.checked_add(1).ok_or_else(invalid)?;
    }
    let content = store.begin_list(count).await?;
    let mut cursor =
        located::Values::open(parts, located::tool_parts(context).await?, context).await?;
    let mut index = 0;
    while let Some(part) = cursor.next().await? {
        let part = if tagged(&part.value.source, "text", context).await? {
            ContentRecipe::Text {
                text: lookup(&part.value.source, "text", context).await?.text()?,
                provider_options: None,
            }
        } else {
            media::tool(
                &part.value.source,
                part.location.as_ref(),
                media::Mode::Capture,
                context,
            )
            .await?
            .content
            .ok_or_else(invalid)?
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
    input: &JsonSource,
    steering: bool,
    context: &ProjectContext<'_>,
    store: &ArenaRecipes,
) -> io::Result<ArenaProjectedRow> {
    let mut fields = json::fields(
        input,
        &["text", "quotes", "attachments", "directory_references"],
        context.budget.clone(),
    )
    .await?
    .into_iter();
    let (_, piece_count, content_count) = user_layout(input, steering, context).await?;
    let content = store.begin_list(content_count).await?;
    let mut content_index = 1;
    let mut pieces = TextParts::new(store, piece_count, context).await?;
    if steering {
        pieces
            .push(literal(match context.language {
                Language::En => "The user sent a message while you were working:\n<user_query>\n",
                Language::ZhCn => "用户在你工作期间发来消息：\n<user_query>\n",
                Language::ZhTw => "使用者在你工作期間傳來訊息：\n<user_query>\n",
            }))
            .await?;
    }
    pieces
        .push(required(fields.next().flatten())?.text()?)
        .await?;
    if let Some(quotes) = options(fields.next().flatten()) {
        let mut quotes = json::ArrayCursor::open(quotes, context.budget.clone()).await?;
        let mut first = true;
        while let Some(quote) = quotes.next().await? {
            pieces
                .push(literal(if first { "\n\n" } else { "\n" }))
                .await?;
            first = false;
            pieces.push(literal("<quoted_excerpt")).await?;
            let mut fields = json::fields(
                &quote.source,
                &["label", "source", "text"],
                context.budget.clone(),
            )
            .await?
            .into_iter();
            if let Some(label) = fields
                .next()
                .flatten()
                .filter(|value| value.kind != JsonKind::Null)
            {
                pieces.push(literal(" label=\"")).await?;
                pieces
                    .push(source_text::quote_label(
                        label.text()?,
                        context.budget.clone(),
                    ))
                    .await?;
                pieces.push(literal("\"")).await?;
            }
            pieces.push(literal(">\n")).await?;
            if let Some(source) = options(fields.next().flatten()) {
                pieces
                    .push(literal(match context.language {
                        Language::En => "Session snapshot provenance (display-only): ",
                        Language::ZhCn => "会话快照来源（仅供展示）：",
                        Language::ZhTw => "工作階段快照來源（僅供顯示）：",
                    }))
                    .await?;
                pieces
                    .push(source_text::html(raw_json(source), context.budget.clone()))
                    .await?;
                pieces.push(literal("\n")).await?;
            }
            pieces
                .push(required(fields.next().flatten())?.text()?)
                .await?;
            pieces.push(literal("\n</quoted_excerpt>")).await?;
        }
    }
    if let Some(attachments) = options(fields.next().flatten()) {
        let mut cursor =
            located::Values::open(attachments, located::attachments(context).await?, context)
                .await?;
        let mut first = true;
        while let Some(attachment) = cursor.next().await? {
            pieces
                .push(literal(if first { "\n\n" } else { "\n" }))
                .await?;
            first = false;
            let projected = media::attachment(
                &attachment.value.source,
                attachment.location.as_ref(),
                media::Mode::Capture,
                context,
            )
            .await?;
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
    }
    if let Some(references) = options(fields.next().flatten()) {
        let mut cursor =
            json::ArrayCursor::open(references.clone(), context.budget.clone()).await?;
        if cursor.next().await?.is_some() {
            pieces.push(literal("\n\n<directory_references>\n")).await?;
            pieces.push(literal(match context.language {Language::En=>"Live directory paths on the originating Runtime Host, accessible with Glob/Read. The project and working directory are unchanged.\n",Language::ZhCn=>"原始运行时主机上的实时目录路径，可通过 Glob/Read 访问。项目与工作目录不变。\n",Language::ZhTw=>"原始執行階段主機上的即時目錄路徑，可透過 Glob/Read 存取。專案與工作目錄不變。\n"})).await?;
            pieces
                .push(source_text::html(
                    raw_json(references),
                    context.budget.clone(),
                ))
                .await?;
            pieces.push(literal("\n</directory_references>")).await?;
        }
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
    use maka_event_log::context::semantic::SemanticSelection;
    use serde_json::json;

    fn value(value: serde_json::Value) -> JsonSource {
        JsonSource {
            bytes: SourceBytes::Inline(serde_json::to_vec(&value).unwrap().into()),
        }
    }
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
    async fn numeric_user_and_tool_arrays_preserve_projection_text_and_order() {
        let (_directory, root) = crate::test_support::root().await;
        let session = crate::test_support::session(&root, "session").await;
        let execution = session.execution_scope(None).await.unwrap().accept();
        let captured = execution
            .store()
            .capture_source(SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through: 0,
                before: 1,
                captured_through: 0,
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
        for language in [Language::En, Language::ZhCn, Language::ZhTw] {
            let context = ProjectContext {
                language,
                vision: false,
                provider: &ProviderKind::Anthropic,
                replay: None,
                captured: Some(&captured),
                payload_root: None,
                arena: Some(&arena),
                internal_arena: false,
                cancellation: &cancel,
                budget: budget.clone(),
                directory_owner: Arc::new(()),
            };
            let quotes:Vec<_>=(0..12).map(|i|json!({"label":format!("quote {i} <&\""),"source":{"sessionId":"origin","label":"显示<&>"},"text":format!("text {i} 世界\n")})).collect();
            let metadata = value(json!({"kind":{"User":{"steering":true}}}));
            let payload = value(
                json!({"User":{"text":"question 世界","quotes":quotes,"attachments":[{"kind":"file","name":"a<&>.txt","mimeType":"text/plain","ref":{"kind":"external_file","absolutePath":"/tmp/a.txt"}},{"kind":"file","name":"b.txt","mimeType":"text/plain","ref":{"kind":"workspace_file","relativePath":"b.txt"}}],"directory_references":[{"path":"src/<&>"}]}}),
            );
            let ProjectedRow::User(expected) =
                super::super::project_row(metadata.clone(), Some(payload.clone()), &context)
                    .await
                    .unwrap()
            else {
                panic!("user")
            };
            let ArenaProjectedRow::User(actual) =
                project_row(metadata, Some(payload), &context, &store)
                    .await
                    .unwrap()
            else {
                panic!("numeric user")
            };
            arena.seal().await.unwrap();
            same_content(expected, store.contents(actual), budget.clone()).await;
        }
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: Some(&captured),
            payload_root: None,
            arena: Some(&arena),
            internal_arena: false,
            cancellation: &cancel,
            budget: budget.clone(),
            directory_owner: Arc::new(()),
        };
        let mut parts: Vec<_> = (0..24)
            .map(|i| json!({"kind":"text","text":format!("part {i} 世界")}))
            .collect();
        parts.insert(9,json!({"kind":"artifact","image":{"ref":{"kind":"session_file","sessionId":"session","relativePath":"image"},"mimeType":"image/png","detail":"high"}}));
        let metadata = value(
            json!({"kind":{"ToolResult":{"call_id":"call","name":"tool","custom":false,"archived":false,"is_error":false}}}),
        );
        let payload = value(json!({"Tool":{"kind":"content","parts":parts}}));
        let ProjectedRow::Tool(expected) =
            super::super::project_row(metadata.clone(), Some(payload.clone()), &context)
                .await
                .unwrap()
        else {
            panic!("tool")
        };
        let ArenaProjectedRow::Tool(actual) =
            project_row(metadata, Some(payload), &context, &store)
                .await
                .unwrap()
        else {
            panic!("numeric tool")
        };
        let list = store.begin_list(1).await.unwrap();
        store.put(list, 0, actual).await.unwrap();
        arena.seal().await.unwrap();
        let mut results = store.results(list).open(0);
        let actual = results.next().await.unwrap().unwrap();
        let (ToolOutputRecipe::Content(expected), ToolOutputRecipe::Content(actual)) =
            (expected.output, actual.output)
        else {
            panic!("content")
        };
        same_content(expected, actual, budget.clone()).await;
        drop(results);
        arena.close().await.unwrap();
        drop(store);
        drop(arena);
        drop(captured);
        execution.finish();
    }
}
