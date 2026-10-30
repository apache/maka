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

//! A wire envelope over one immutable prompt. Full and delta requests share the
//! same source; neither transport retains a JSON copy of conversation history.
use super::{Error, Result};
use futures_util::{Stream, StreamExt};
use maka_agent_facts::model::{
    PlaintextResponses,
    prompt_source::{Prompt, PromptCursor, WireCursor, WireFormat},
};
use maka_agent_ports::model::Request as ModelRequest;
use maka_capabilities::http;
use maka_provider_protocol::json_stream::JsonChunks;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct RequestBody {
    pub properties: Value,
    prompt: Prompt,
    pub skip: usize,
    config: Arc<Config>,
}
struct Config {
    language: maka_agent_facts::language::Language,
    options: Value,
    plaintext: Option<PlaintextResponses>,
}
impl RequestBody {
    pub fn new(
        request: &ModelRequest,
        plaintext: Option<PlaintextResponses>,
        skip: usize,
    ) -> Result<Self> {
        let codec =
            super::request::wire_codec(request.language, plaintext, &request.provider_options);
        match request.prompt.wire(WireFormat::Responses) {
            Some(wire) if wire.codec.as_ref() != codec => {
                return Err(Error::Invalid(
                    "Responses prepared wire codec does not match request".into(),
                ));
            }
            None if request.prompt.memory_messages().is_none() => {
                return Err(Error::Invalid(
                    "Responses history requires a prepared wire source".into(),
                ));
            }
            _ => {}
        }
        let mut properties = super::request::Request {
            language: request.language,
            model: &request.provider.model,
            prompt: &[],
            tools: &request.tools,
            options: &request.provider_options,
            max_output_tokens: request.max_output_tokens,
            plaintext,
        }
        .encode()?;
        if let Some(overlay) = &request.provider.body_overlay {
            for (key, value) in overlay {
                if properties.get(key).is_some() {
                    return Err(Error::Invalid(format!(
                        "Extra request body conflicts with a generated field: {key}"
                    )));
                }
                properties[key] = value.clone();
            }
        }
        properties.as_object_mut().unwrap().remove("input");
        Ok(Self {
            properties,
            prompt: request.prompt.clone(),
            skip,
            config: Arc::new(Config {
                language: request.language,
                options: request.provider_options.clone(),
                plaintext,
            }),
        })
    }
    pub fn full(mut self) -> Self {
        self.skip = 0;
        self.properties
            .as_object_mut()
            .unwrap()
            .remove("previous_response_id");
        self
    }
    pub fn chunks(
        self,
    ) -> impl Stream<Item = std::result::Result<http::Bytes, http::Error>> + Send + 'static {
        struct State {
            header: Option<std::iter::Peekable<JsonChunks>>,
            cursor: Option<Box<dyn PromptCursor>>,
            wire: Option<Box<dyn WireCursor>>,
            pending: Option<http::Bytes>,
            inside_item: bool,
            last_message: Option<usize>,
            message_count: usize,
            skip: usize,
            config: Arc<Config>,
            items: std::vec::IntoIter<Value>,
            item: Option<JsonChunks>,
            comma: bool,
            done: bool,
        }
        let wire = self
            .prompt
            .wire(WireFormat::Responses)
            .map(|wire| wire.open(self.skip));
        let cursor = wire.is_none().then(|| self.prompt.open());
        let state = State {
            header: Some(JsonChunks::new(self.properties).peekable()),
            cursor,
            wire,
            pending: None,
            inside_item: false,
            last_message: None,
            message_count: self.prompt.len(),
            skip: self.skip,
            config: self.config,
            items: Vec::new().into_iter(),
            item: None,
            comma: false,
            done: false,
        };
        futures_util::stream::try_unfold(state, |mut state| async move {
            loop {
                if let Some(header) = &mut state.header {
                    if let Some(mut bytes) = header.next() {
                        if header.peek().is_none() {
                            let closing = bytes.pop();
                            debug_assert_eq!(closing, Some(b'}'));
                            bytes.extend_from_slice(b",\"input\":[");
                            state.header = None;
                        }
                        return Ok(Some((http::Bytes::from(bytes), state)));
                    }
                    unreachable!("JSON object has a closing brace");
                }
                if let Some(bytes) = state.pending.take() {
                    return Ok(Some((bytes, state)));
                }
                if state.done {
                    return Ok(None);
                }
                if let Some(wire) = &mut state.wire {
                    let chunk = wire.next().await.map_err(source_error)?;
                    let Some(chunk) = chunk else {
                        if state.inside_item {
                            return Err(http::Error::Invalid(
                                "truncated Responses prepared wire item".into(),
                            ));
                        }
                        state.done = true;
                        return Ok(Some((http::Bytes::from_static(b"]}"), state)));
                    };
                    if chunk.bytes.is_empty() {
                        if state.inside_item
                            || !chunk.item_start
                            || !chunk.item_end
                            || chunk.metadata.is_none()
                            || chunk.message_index < state.skip
                            || chunk.message_index >= state.message_count
                            || state
                                .last_message
                                .is_some_and(|index| chunk.message_index < index)
                        {
                            return Err(http::Error::Invalid(
                                "invalid Responses prepared metadata boundary".into(),
                            ));
                        }
                        state.last_message = Some(chunk.message_index);
                        continue;
                    }
                    if chunk.message_index < state.skip
                        || chunk.message_index >= state.message_count
                        || state
                            .last_message
                            .is_some_and(|index| chunk.message_index < index)
                        || (state.inside_item && state.last_message != Some(chunk.message_index))
                        || chunk.item_start == state.inside_item
                    {
                        return Err(http::Error::Invalid(
                            "invalid Responses prepared wire boundary".into(),
                        ));
                    }
                    state.last_message = Some(chunk.message_index);
                    state.inside_item = !chunk.item_end;
                    let bytes = chunk.bytes;
                    if chunk.item_start {
                        if state.comma {
                            state.pending = Some(bytes);
                            return Ok(Some((http::Bytes::from_static(b","), state)));
                        }
                        state.comma = true;
                    }
                    return Ok(Some((bytes, state)));
                }
                if let Some(item) = &mut state.item {
                    if let Some(bytes) = item.next() {
                        return Ok(Some((http::Bytes::from(bytes), state)));
                    }
                    state.item = None;
                }
                if let Some(item) = state.items.next() {
                    state.item = Some(JsonChunks::new(item));
                    if state.comma {
                        return Ok(Some((http::Bytes::from_static(b","), state)));
                    }
                    state.comma = true;
                    continue;
                }
                if state.done {
                    return Ok(None);
                }
                let message = state
                    .cursor
                    .as_mut()
                    .expect("semantic source for explicit memory input")
                    .next()
                    .await
                    .map_err(source_error)?;
                let Some(message) = message else {
                    state.done = true;
                    return Ok(Some((http::Bytes::from_static(b"]}"), state)));
                };
                if state.skip > 0 {
                    state.skip -= 1;
                    continue;
                }
                // Explicit small inputs use the same static codec that storage
                // applies once to each dirty group. Persisted history never
                // materializes a Message on this transport path.
                state.items = super::request::encode_message(
                    &message,
                    state.config.language,
                    state.config.plaintext,
                    &state.config.options,
                )
                .map_err(|error| http::Error::Invalid(error.to_string()))?
                .into_iter();
            }
        })
    }
    pub fn http(self) -> http::RequestBody {
        http::RequestBody::replayable(move || http::RequestBody::stream(self.clone().chunks()))
    }
    pub fn websocket(mut self) -> maka_agent_ports::model::TextStream {
        let properties = self.properties.as_object_mut().unwrap();
        properties.remove("stream");
        properties.remove("background");
        properties.insert("type".into(), json!("response.create"));
        Box::pin(self.chunks().map(|chunk| {
            chunk.map_err(|error| match error {
                http::Error::CleanupUnconfirmed => {
                    maka_agent_ports::model::Error::CleanupUnconfirmed
                }
                http::Error::Denied => maka_agent_ports::model::Error::Cancelled,
                other => maka_agent_ports::model::Error::Adapter(other.to_string()),
            })
        }))
    }
}

fn source_error(error: maka_agent_ports::model::Error) -> http::Error {
    match error {
        maka_agent_ports::model::Error::CleanupUnconfirmed => http::Error::CleanupUnconfirmed,
        maka_agent_ports::model::Error::Cancelled => http::Error::Denied,
        other => http::Error::Invalid(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt::Message;
    use maka_agent_facts::model::prompt_source::{Next, PromptSource};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn body(prompt: Prompt) -> RequestBody {
        RequestBody {
            properties: json!({"model":"test", "stream":true}),
            prompt,
            skip: 0,
            config: Arc::new(Config {
                language: maka_agent_facts::language::Language::En,
                options: json!({"openai":{"store":false}}),
                plaintext: None,
            }),
        }
    }
    async fn wire(body: RequestBody) -> Value {
        let mut stream = Box::pin(body.chunks());
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.unwrap();
            assert!(chunk.len() <= 16 * 1024);
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).unwrap()
    }

    struct PreparedItems(Vec<http::Bytes>);
    struct PreparedCursor {
        items: Vec<http::Bytes>,
        index: usize,
        offset: usize,
    }
    impl maka_agent_facts::model::prompt_source::WireSource for PreparedItems {
        fn open(&self, start_message: usize) -> Box<dyn WireCursor> {
            Box::new(PreparedCursor {
                items: self.0.clone(),
                index: start_message,
                offset: 0,
            })
        }
    }
    impl WireCursor for PreparedCursor {
        fn next(&mut self) -> maka_agent_facts::model::prompt_source::NextWire<'_> {
            Box::pin(async move {
                let Some(item) = self.items.get(self.index) else {
                    return Ok(None);
                };
                let end = (self.offset + 32 * 1024).min(item.len());
                let chunk = maka_agent_facts::model::prompt_source::WireChunk {
                    bytes: item.slice(self.offset..end),
                    item_start: self.offset == 0,
                    item_end: end == item.len(),
                    message_index: self.index,
                    metadata: None,
                };
                self.offset = end;
                if chunk.item_end {
                    self.index += 1;
                    self.offset = 0;
                }
                Ok(Some(chunk))
            })
        }
    }
    struct RetainedItem {
        bytes: Vec<u8>,
        _owner: Arc<()>,
    }
    impl AsRef<[u8]> for RetainedItem {
        fn as_ref(&self) -> &[u8] {
            &self.bytes
        }
    }

    struct Generated {
        reads: Arc<AtomicUsize>,
        drops: Arc<AtomicUsize>,
    }
    struct Cursor {
        reads: Arc<AtomicUsize>,
        drops: Arc<AtomicUsize>,
        offset: usize,
    }
    impl PromptSource for Generated {
        fn open(&self) -> Box<dyn PromptCursor> {
            Box::new(Cursor {
                reads: self.reads.clone(),
                drops: self.drops.clone(),
                offset: 0,
            })
        }
    }
    impl PromptCursor for Cursor {
        fn next(&mut self) -> Next<'_> {
            Box::pin(async move {
                if self.offset == 1000 {
                    return Ok(None);
                }
                self.offset += 1;
                self.reads.fetch_add(1, Ordering::SeqCst);
                Ok(Some(Message::user("中\\\n".repeat(32 * 1024))))
            })
        }
    }
    impl Drop for Cursor {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn backpressure_and_drop_do_not_read_the_remaining_history() {
        let reads = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        let prompt = Prompt::new(
            Arc::new(Generated {
                reads: reads.clone(),
                drops: drops.clone(),
            }),
            "fixed-generated-root",
            1000,
            Default::default(),
        );
        let body = body(prompt);
        let mut stream = Box::pin(body.clone().chunks());
        let header = stream.next().await.unwrap().unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        let first = stream.next().await.unwrap().unwrap();
        assert!(first.len() <= 16 * 1024);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        drop(stream);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        let mut replay = Box::pin(body.chunks());
        assert_eq!(replay.next().await.unwrap().unwrap(), header);
        assert_eq!(replay.next().await.unwrap().unwrap(), first);
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }
}
