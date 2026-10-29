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

//! Replayable provider body encoding with pull-driven bounded JSON output.
use super::{chat_completions::Projector, media, prompt};
use crate::{
    ModelError,
    prompt::{Message, PreparedWire, Prompt, PromptCursor, WireFormat},
};
use maka_agent_facts::language::Language;
use maka_capabilities::http;
use maka_provider_protocol::{
    chat_completions::request::{self, PromptOptions},
    json_stream::JsonChunks,
};
use serde_json::Value;
use std::collections::VecDeque;

pub(super) struct ChatMessages {
    cursor: Box<dyn PromptCursor>,
    projector: Option<Projector>,
    pending: VecDeque<Message>,
    language: Language,
}
impl ChatMessages {
    pub(super) fn new(source: &Prompt, language: Language) -> Self {
        Self {
            cursor: source.open(),
            projector: Some(Projector::new(language)),
            pending: VecDeque::new(),
            language,
        }
    }
    pub(super) async fn next(&mut self) -> Result<Option<Message>, ModelError> {
        loop {
            if let Some(message) = self.pending.pop_front() {
                return Ok(Some(message));
            }
            let Some(projector) = &mut self.projector else {
                return Ok(None);
            };
            match self.cursor.next().await? {
                Some(message) => {
                    let mut messages =
                        crate::prompt::notification_fallback(vec![message], self.language);
                    media::audio_fallback(&mut messages, self.language, false);
                    for message in messages {
                        self.pending.extend(projector.push(message));
                    }
                }
                None => self
                    .pending
                    .extend(self.projector.take().expect("active projector").finish()),
            }
        }
    }
}

pub(super) async fn validate(
    source: &Prompt,
    options: &PromptOptions,
    language: Language,
) -> Result<(), ModelError> {
    let mut messages = ChatMessages::new(source, language);
    while let Some(message) = messages.next().await? {
        let message = prompt::messages(vec![message])?;
        request::messages(&message, options).map_err(super::http::failure)?;
    }
    Ok(())
}

pub(super) fn chat(
    fields: Value,
    source: Prompt,
    options: PromptOptions,
    language: Language,
) -> http::RequestBody {
    if let Some(wire) = source.wire(WireFormat::ChatCompletions) {
        return prepared(fields, wire.clone(), "messages");
    }
    struct State {
        fields: Option<std::iter::Peekable<JsonChunks>>,
        messages: ChatMessages,
        options: PromptOptions,
        pending: VecDeque<Value>,
        current: Option<JsonChunks>,
        first: bool,
        finished: bool,
    }
    let state = State {
        fields: Some(JsonChunks::new(fields).peekable()),
        messages: ChatMessages::new(&source, language),
        options,
        pending: VecDeque::new(),
        current: None,
        first: true,
        finished: false,
    };
    let stream = futures_util::stream::try_unfold(state, |mut state| async move {
        loop {
            if state.finished {
                return Ok(None);
            }
            if let Some(fields) = &mut state.fields
                && let Some(mut bytes) = fields.next()
            {
                if fields.peek().is_none() {
                    let closing = bytes.pop();
                    debug_assert_eq!(closing, Some(b'}'));
                    if bytes != b"{" {
                        bytes.push(b',');
                    }
                    bytes.extend_from_slice(b"\"messages\":[");
                    state.fields = None;
                }
                return Ok(Some((http::Bytes::from(bytes), state)));
            }

            if let Some(current) = &mut state.current {
                if let Some(bytes) = current.next() {
                    return Ok(Some((http::Bytes::from(bytes), state)));
                }
                state.current = None;
            }
            if let Some(value) = state.pending.pop_front() {
                state.current = Some(JsonChunks::new(value));
                if !state.first {
                    return Ok(Some((http::Bytes::from_static(b","), state)));
                }
                state.first = false;
                continue;
            }
            match state
                .messages
                .next()
                .await
                .map_err(super::http::upload_error)?
            {
                Some(message) => {
                    let messages =
                        prompt::messages(vec![message]).map_err(super::http::upload_error)?;
                    state.pending.extend(
                        request::messages(&messages, &state.options).map_err(|error| {
                            super::http::upload_error(super::http::failure(error))
                        })?,
                    );
                }
                None => {
                    state.finished = true;
                    return Ok(Some((http::Bytes::from_static(b"]}"), state)));
                }
            }
        }
    });
    http::RequestBody::stream(stream)
}

/// Ordinary persisted history passes through without constructing Message or Value.
pub(super) fn prepared(fields: Value, wire: PreparedWire, key: &'static str) -> http::RequestBody {
    struct State {
        fields: Option<std::iter::Peekable<JsonChunks>>,
        cursor: Box<dyn crate::prompt::WireCursor>,
        pending: Option<http::Bytes>,
        first: bool,
        finished: bool,
        key: &'static str,
    }
    let state = State {
        fields: Some(JsonChunks::new(fields).peekable()),
        cursor: wire.open(0),
        pending: None,
        first: true,
        finished: false,
        key,
    };
    http::RequestBody::stream(futures_util::stream::try_unfold(
        state,
        |mut state| async move {
            loop {
                if state.finished {
                    return Ok(None);
                }
                if let Some(bytes) = state.pending.take() {
                    return Ok(Some((bytes, state)));
                }
                if let Some(fields) = &mut state.fields
                    && let Some(mut bytes) = fields.next()
                {
                    if fields.peek().is_none() {
                        let closing = bytes.pop();
                        debug_assert_eq!(closing, Some(b'}'));
                        if bytes != b"{" {
                            bytes.push(b',');
                        }
                        bytes.extend_from_slice(
                            serde_json::to_string(state.key)
                                .expect("static array key")
                                .as_bytes(),
                        );
                        bytes.extend_from_slice(b":[");
                        state.fields = None;
                    }
                    return Ok(Some((http::Bytes::from(bytes), state)));
                }

                match state
                    .cursor
                    .next()
                    .await
                    .map_err(super::http::upload_error)?
                {
                    Some(chunk) => {
                        if chunk.bytes.is_empty() {
                            continue;
                        }
                        if chunk.item_start {
                            if !state.first {
                                state.pending = Some(chunk.bytes);
                                return Ok(Some((http::Bytes::from_static(b","), state)));
                            }
                            state.first = false;
                        }
                        return Ok(Some((chunk.bytes, state)));
                    }
                    None => {
                        state.finished = true;
                        return Ok(Some((http::Bytes::from_static(b"]}"), state)));
                    }
                }
            }
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::PromptSource;
    use futures_util::StreamExt;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    struct Generated {
        read: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
        count: usize,
    }
    struct Cursor {
        read: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
        remaining: usize,
    }
    impl PromptSource for Generated {
        fn open(&self) -> Box<dyn PromptCursor> {
            Box::new(Cursor {
                read: self.read.clone(),
                dropped: self.dropped.clone(),
                remaining: self.count,
            })
        }
    }
    impl PromptCursor for Cursor {
        fn next(&mut self) -> maka_agent_facts::model::prompt_source::Next<'_> {
            Box::pin(async move {
                if self.remaining == 0 {
                    return Ok(None);
                }
                self.remaining -= 1;
                let index = self.read.fetch_add(1, Ordering::SeqCst);
                Ok(Some(Message::user(format!("message {index}"))))
            })
        }
    }
    impl Drop for Cursor {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn options() -> PromptOptions {
        PromptOptions {
            provider_namespace: "openai".into(),
            metadata_namespace: "openai".into(),
            multipart_tool_content: false,
        }
    }

    #[tokio::test]
    async fn upload_pulls_only_demanded_messages_and_drop_releases_cursor() {
        let read = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let source = Prompt::new(
            Arc::new(Generated {
                read: read.clone(),
                dropped: dropped.clone(),
                count: 100_000,
            }),
            "fixed-root",
            100_000,
            Default::default(),
        );
        let mut stream = chat(
            serde_json::json!({"model":"test"}),
            source,
            options(),
            Language::En,
        )
        .into_stream();
        let head = stream.next().await.unwrap().unwrap();
        assert_eq!(&head[..], b"{\"model\":\"test\",\"messages\":[");
        assert_eq!(read.load(Ordering::SeqCst), 0);
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&first).unwrap(),
            serde_json::json!({"role":"user","content":"message 0"})
        );
        assert_eq!(read.load(Ordering::SeqCst), 1);
        drop(stream);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn independent_replays_encode_identical_json() {
        let source = Prompt::from_messages(vec![
            Message::user("quote \" 中文\n"),
            Message::user("second"),
        ]);
        let mut results = Vec::new();
        for _ in 0..2 {
            let mut stream = chat(
                serde_json::json!({"model":"test"}),
                source.clone(),
                options(),
                Language::En,
            )
            .into_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                bytes.extend_from_slice(&chunk.unwrap());
            }
            results.push(bytes);
        }
        assert_eq!(results[0], results[1]);
        let decoded: Value = serde_json::from_slice(&results[0]).unwrap();
        assert_eq!(decoded["messages"].as_array().unwrap().len(), 2);
        assert_eq!(decoded["messages"][0]["content"], "quote \" 中文\n");
    }
    #[tokio::test]
    async fn direct_and_prepared_uploads_emit_complete_json_in_all_build_profiles() {
        use crate::prompt::{WireChunk, WireCursor, WireSource};
        struct Source;
        struct Items(std::vec::IntoIter<WireChunk>);
        impl WireSource for Source {
            fn open(&self, start_message: usize) -> Box<dyn WireCursor> {
                Box::new(Items(
                    ["first", "second"]
                        .into_iter()
                        .enumerate()
                        .skip(start_message)
                        .map(|(message_index, text)| WireChunk {
                            bytes: serde_json::to_vec(&serde_json::json!({
                                "role": "user", "content": text
                            }))
                            .unwrap()
                            .into(),
                            item_start: true,
                            item_end: true,
                            message_index,
                            metadata: None,
                        })
                        .collect::<Vec<_>>()
                        .into_iter(),
                ))
            }
        }
        impl WireCursor for Items {
            fn next(&mut self) -> maka_agent_facts::model::prompt_source::NextWire<'_> {
                Box::pin(async { Ok(self.0.next()) })
            }
        }
        // Cover both an empty prefix object and a prefix crossing JSON chunk
        // boundaries. The terminal brace must be removed even without debug assertions.
        for fields in [
            serde_json::json!({}),
            serde_json::json!({"model": "x".repeat(32768)}),
        ] {
            let source =
                Prompt::from_messages(vec![Message::user("first"), Message::user("second")]);
            let wire = PreparedWire {
                format: WireFormat::ChatCompletions,
                codec: "test".into(),
                identity: "test".into(),
                source: Arc::new(Source),
            };
            for body in [
                chat(fields.clone(), source, options(), Language::En),
                prepared(fields.clone(), wire, "messages"),
            ] {
                let mut stream = body.into_stream();
                let mut bytes = Vec::new();
                while let Some(chunk) = stream.next().await {
                    bytes.extend_from_slice(&chunk.unwrap());
                }
                let mut expected = fields.clone();
                expected["messages"] = serde_json::json!([
                    {"role": "user", "content": "first"},
                    {"role": "user", "content": "second"}
                ]);
                assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
            }
        }
    }
}
