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
