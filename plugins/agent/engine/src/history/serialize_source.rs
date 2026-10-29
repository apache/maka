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

//! Logical message JSON emitted directly from immutable typed recipes.
use maka_agent_facts::model::prompt_source::source::*;
use maka_provider_protocol::json_stream::pull::{JsonEscape, Transform};
use std::{future::Future, io, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

mod arena;
pub(crate) use arena::ArenaEmit;

pub(crate) trait AsyncEmit: Send {
    fn write<'a>(
        &'a mut self,
        bytes: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'a>>;
}
type MediaLabel<'a> = dyn FnMut(usize, &ContentRecipe) -> io::Result<TextSource> + Send + 'a;
struct SyncEmit<'a, F>(&'a mut F);
impl<F: FnMut(&[u8]) -> io::Result<()> + Send> AsyncEmit for SyncEmit<'_, F> {
    fn write<'a>(
        &'a mut self,
        bytes: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'a>> {
        Box::pin(async move { (self.0)(bytes) })
    }
}
pub(crate) async fn message(
    message: &MessageRecipe,
    budget: &Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
    emit: &mut (impl FnMut(&[u8]) -> io::Result<()> + Send),
    media: &mut (impl FnMut(usize, &ContentRecipe) -> io::Result<TextSource> + Send),
) -> io::Result<()> {
    message_async(message, budget, cancellation, &mut SyncEmit(emit), media).await
}
pub(crate) async fn message_async<'a>(
    message: &'a MessageRecipe,
    budget: &'a Arc<dyn SourceBudget>,
    cancellation: &'a CancellationToken,
    emit: &'a mut dyn AsyncEmit,
    media: &'a mut MediaLabel<'a>,
) -> io::Result<()> {
    Encoder {
        budget,
        cancellation,
        emit,
        media,
    }
    .message(message)
    .await
}
struct Encoder<'a> {
    budget: &'a Arc<dyn SourceBudget>,
    cancellation: &'a CancellationToken,
    emit: &'a mut dyn AsyncEmit,
    media: &'a mut MediaLabel<'a>,
}
impl Encoder<'_> {
    async fn literal(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(crate::preparation_cancelled(
                "logical serialization cancelled",
            ));
        }
        self.emit.write(bytes).await
    }
    async fn transformed(
        &mut self,
        source: SourceBytes,
        mut transform: impl Transform + Send,
    ) -> io::Result<()> {
        let mut cursor = source.open(self.budget.clone());
        let mut input = self.budget.allocate(4096).await?;
        let mut output = self.budget.allocate(4096).await?;
        loop {
            if self.cancellation.is_cancelled() {
                return Err(crate::preparation_cancelled(
                    "logical serialization cancelled",
                ));
            }
            let read = cursor.read_chunk(input).await?;
            input = read.buffer;
            if read.bytes_read == 0 && !read.eof {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "logical transform source made no progress",
                ));
            }
            let mut used = 0usize;
            loop {
                let progress = transform.transform(
                    &input.as_ref()[used..read.bytes_read],
                    read.eof,
                    output.as_mut(),
                )?;
                used += progress.consumed;
                if progress.written != 0 {
                    self.literal(&output.as_ref()[..progress.written]).await?;
                }
                if progress.finished {
                    if !read.eof || used != read.bytes_read {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "logical transform finished before its source",
                        ));
                    }
                    return Ok(());
                }
                if progress.consumed == 0 && progress.written == 0 {
                    if used == read.bytes_read && !read.eof {
                        break;
                    }
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "logical transform made no progress",
                    ));
                }
            }
        }
    }
    async fn text(&mut self, source: &TextSource) -> io::Result<()> {
        self.literal(b"\"").await?;
        self.transformed(
            text::bytes(source.clone(), self.budget.clone()),
            JsonEscape::new(),
        )
        .await?;
        self.literal(b"\"").await
    }
    async fn json(&mut self, source: &JsonSource) -> io::Result<()> {
        let mut cursor = source.bytes().open(self.budget.clone());
        let mut buffer = self.budget.allocate(4096).await?;
        loop {
            let read = cursor.read_chunk(buffer).await?;
            self.literal(&read.buffer.as_ref()[..read.bytes_read])
                .await?;
            buffer = read.buffer;
            if read.eof {
                return Ok(());
            }
            if read.bytes_read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "logical JSON source made no progress",
                ));
            }
        }
    }
    async fn options(&mut self, source: &Option<JsonSource>) -> io::Result<()> {
        if let Some(source) = source {
            self.literal(b",\"providerOptions\":").await?;
            self.json(source).await?;
        }
        Ok(())
    }
    async fn contents(&mut self, source: &Arc<dyn RecipeSource<ContentRecipe>>) -> io::Result<()> {
        self.literal(b"[").await?;
        let mut cursor = source.open(0);
        let mut index = 0;
        while let Some(part) = cursor.next().await? {
            if index != 0 {
                self.literal(b",").await?;
            }
            self.literal(b"{\"type\":\"text\",\"text\":").await?;
            match &part {
                ContentRecipe::Text {
                    text,
                    provider_options,
                } => {
                    self.text(text).await?;
                    self.options(provider_options).await?;
                }
                ContentRecipe::Media { .. } => {
                    let label = (self.media)(index, &part)?;
                    self.text(&label).await?;
                }
            }
            self.literal(b"}").await?;
            index += 1;
        }
        self.literal(b"]").await
    }
    async fn output(&mut self, source: &ToolOutputRecipe) -> io::Result<()> {
        let kind: &[u8] = match source {
            ToolOutputRecipe::Text(_) => b"text",
            ToolOutputRecipe::ErrorText(_) => b"error-text",
            ToolOutputRecipe::Json(_) => b"json",
            ToolOutputRecipe::ErrorJson(_) => b"error-json",
            ToolOutputRecipe::Content(_) => b"content",
        };
        self.literal(b"{\"type\":\"").await?;
        self.literal(kind).await?;
        self.literal(b"\",\"value\":").await?;
        match source {
            ToolOutputRecipe::Text(text) | ToolOutputRecipe::ErrorText(text) => {
                self.text(text).await?
            }
            ToolOutputRecipe::Json(json) | ToolOutputRecipe::ErrorJson(json) => {
                self.json(json).await?
            }
            ToolOutputRecipe::Content(content) => self.contents(content).await?,
        }
        self.literal(b"}").await
    }
    async fn result(&mut self, result: &ToolResultRecipe) -> io::Result<()> {
        self.literal(b"{\"type\":\"tool-result\",\"toolCallId\":")
            .await?;
        self.text(&result.tool_call_id).await?;
        self.literal(b",\"toolName\":").await?;
        self.text(&result.tool_name).await?;
        self.literal(b",\"output\":").await?;
        self.output(&result.output).await?;
        self.options(&result.provider_options).await?;
        self.literal(b"}").await
    }
    async fn assistant(&mut self, part: &AssistantRecipe) -> io::Result<()> {
        match part {
            AssistantRecipe::Text {
                text,
                provider_options,
            }
            | AssistantRecipe::Reasoning {
                text,
                provider_options,
            } => {
                self.literal(if matches!(part, AssistantRecipe::Text { .. }) {
                    b"{\"type\":\"text\",\"text\":"
                } else {
                    b"{\"type\":\"reasoning\",\"text\":"
                })
                .await?;
                self.text(text).await?;
                self.options(provider_options).await?;
                self.literal(b"}").await
            }
            AssistantRecipe::ToolResult(result) => self.result(result).await,
            AssistantRecipe::ToolCall {
                tool_call_id,
                tool_name,
                input,
                provider_executed,
                provider_options,
                ..
            } => {
                self.literal(b"{\"type\":\"tool-call\",\"toolCallId\":")
                    .await?;
                self.text(tool_call_id).await?;
                self.literal(b",\"toolName\":").await?;
                self.text(tool_name).await?;
                self.literal(b",\"input\":").await?;
                match input {
                    ToolInputRecipe::Text(text) => {
                        self.literal(b"{\"kind\":\"invalid_json\",\"data\":{\"raw\":")
                            .await?;
                        self.text(text).await?;
                        self.literal(b"}}").await?;
                    }
                    ToolInputRecipe::Json(json) => {
                        self.literal(b"{\"kind\":\"json\",\"data\":").await?;
                        self.json(json).await?;
                        self.literal(b"}").await?;
                    }
                }
                if let Some(value) = provider_executed {
                    self.literal(if *value {
                        b",\"providerExecuted\":true"
                    } else {
                        b",\"providerExecuted\":false"
                    })
                    .await?;
                }
                self.options(provider_options).await?;
                self.literal(b"}").await
            }
        }
    }
    async fn message(&mut self, source: &MessageRecipe) -> io::Result<()> {
        let options = match source {
            MessageRecipe::System {
                content,
                provider_options,
            } => {
                self.literal(b"{\"role\":\"system\",\"content\":").await?;
                self.text(content).await?;
                provider_options
            }
            MessageRecipe::User {
                content,
                provider_options,
            } => {
                self.literal(b"{\"role\":\"user\",\"content\":").await?;
                self.contents(content).await?;
                provider_options
            }
            MessageRecipe::Assistant {
                content,
                provider_options,
            } => {
                self.literal(b"{\"role\":\"assistant\",\"content\":[")
                    .await?;
                let mut cursor = content.open(0);
                let mut first = true;
                while let Some(part) = cursor.next().await? {
                    if !first {
                        self.literal(b",").await?;
                    }
                    first = false;
                    self.assistant(&part).await?;
                }
                self.literal(b"]").await?;
                provider_options
            }
            MessageRecipe::Tool {
                content,
                provider_options,
            } => {
                self.literal(b"{\"role\":\"tool\",\"content\":[").await?;
                let mut cursor = content.open(0);
                let mut first = true;
                while let Some(part) = cursor.next().await? {
                    if !first {
                        self.literal(b",").await?;
                    }
                    first = false;
                    self.result(&part).await?;
                }
                self.literal(b"]").await?;
                provider_options
            }
        };
        self.options(options).await?;
        self.literal(b"}").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::{
        prompt::Message,
        prompt_source::{Prompt, source::generated},
    };

    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    #[tokio::test]
    async fn logical_recipe_json_matches_owned_serializer_without_media() {
        let messages: Vec<Message> = serde_json::from_value(serde_json::json!([
            {"role":"system","content":"quote \" 😀\n"},
            {"role":"user","content":[{"type":"text","text":"想\\好"}]},
            {"role":"assistant","content":[
                {"type":"reasoning","text":"reason","providerOptions":{"signature":"opaque"}},
                {"type":"tool-call","toolCallId":"id","toolName":"Read","input":{"kind":"invalid_json","data":{"raw":"{bad"}},"providerExecuted":false}
            ]},
            {"role":"tool","content":[{"type":"tool-result","toolCallId":"id","toolName":"Read","output":{"type":"error-json","value":{"z":1,"a":"x"}}}]}
        ])).unwrap();
        let prompt = Prompt::from_messages(messages.clone());
        let mut cursor = prompt.recipes().unwrap().open(0);
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        for expected in messages {
            let recipe = cursor.next().await.unwrap().unwrap();
            let mut output = Vec::new();
            message(
                &recipe,
                &budget,
                &CancellationToken::new(),
                &mut |bytes| {
                    output.extend_from_slice(bytes);
                    Ok(())
                },
                &mut |_, _| Ok(generated::text("unexpected media")),
            )
            .await
            .unwrap();
            assert_eq!(output, serde_json::to_vec(&expected).unwrap());
        }
    }
}
