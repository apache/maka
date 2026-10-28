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

use maka_agent_facts::model::prompt::Message;
use maka_agent_facts::model::prompt_source::{Prompt, WireFormat};
use maka_agent_facts::model::request::{ProviderKind, Request as ModelRequest};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub struct Lane {
    pub(crate) transport: crate::transport::ResponsesLane,
    semantic: Arc<Mutex<Semantic>>,
}
#[derive(Default)]
struct Semantic {
    pending: Option<Prefix>,
    confirmed: Option<(Prefix, String)>,
}
struct Prefix {
    length: usize,
    identity: Identity,
}
#[derive(PartialEq, Eq)]
enum Identity {
    Prepared { codec: Arc<str>, root: String },
    Memory([u8; 32]),
}
struct Writer(Sha256);
impl io::Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Prefix {
    async fn new(prompt: &Prompt, length: usize) -> Option<Self> {
        if length > prompt.len() {
            return None;
        }
        let identity = if let Some(wire) = prompt.wire(WireFormat::Responses) {
            Identity::Prepared {
                codec: wire.codec.clone(),
                root: wire.source.prefix_identity(length).await.ok()??,
            }
        } else {
            // Only explicitly small generated/test input has an in-memory path.
            // Missing persisted metadata disables reuse instead of hashing P.
            let messages = prompt.memory_messages()?.get(..length)?;
            let mut writer = Writer(Sha256::new());
            serde_json::to_writer(&mut writer, messages).ok()?;
            Identity::Memory(writer.0.finalize().into())
        };
        Some(Self { length, identity })
    }
    async fn matches(&self, prompt: &Prompt) -> bool {
        Self::new(prompt, self.length)
            .await
            .is_some_and(|prefix| prefix.identity == self.identity)
    }
}
impl Lane {
    pub fn needs_confirmation(&self) -> bool {
        self.transport.response_id().is_some()
    }

    pub async fn confirm(
        &self,
        replay: &Prompt,
        settled_tool_call_ids: &[&str],
        response_id: Option<&str>,
    ) -> bool {
        let pending = {
            let mut state = self.semantic.lock().unwrap();
            state.confirmed = None;
            state.pending.take()
        };
        let Some(pending) = pending else {
            return false;
        };
        let Some(id) = self.transport.response_id() else {
            return false;
        };
        if response_id != Some(id.as_str()) || !pending.matches(replay).await {
            return false;
        }
        let mut next = pending.length;
        let mut response_end = None;
        let mut settled = settled_tool_call_ids.iter();
        if let Some(wire) = replay.wire(WireFormat::Responses) {
            let Some(mut cursor) = wire.source.open_metadata(pending.length) else {
                return false;
            };
            loop {
                let row = match cursor.next().await {
                    Ok(Some(row)) => row,
                    Ok(None) => break,
                    Err(_) => return false,
                };
                use maka_agent_facts::model::prompt_source::{
                    WireItemMetadata, source::MessageRole,
                };
                let WireItemMetadata::Message(metadata) = row.metadata else {
                    return false;
                };
                if row.message_index != next {
                    return false;
                }
                next += 1;
                match metadata.role {
                    MessageRole::Tool => {
                        response_end.get_or_insert(row.message_index);
                        let mut ids = metadata.settled_tool_call_ids.open(0);
                        loop {
                            let id = match ids.next().await {
                                Ok(Some(id)) => id,
                                Ok(None) => break,
                                Err(_) => return false,
                            };
                            let Some(expected) = settled.next() else {
                                return false;
                            };
                            let identity: [u8; 32] = Sha256::digest(expected.as_bytes()).into();
                            if id.identity != identity {
                                return false;
                            }
                        }
                    }
                    MessageRole::Assistant if response_end.is_none() => {}
                    _ => return false,
                }
            }
        } else {
            // A local closure consumes only current-message identifiers; none are
            // retained after their indexed metadata row is released.
            let mut check = |index: usize, role: &str, ids: &[String]| {
                if index != next {
                    return false;
                }
                next += 1;
                if role == "tool" {
                    response_end.get_or_insert(index);
                    for tool_id in ids {
                        if settled.next().copied() != Some(tool_id.as_str()) {
                            return false;
                        }
                    }
                } else if role != "assistant" || response_end.is_some() {
                    return false;
                }
                true
            };
            let Some(messages) = replay.memory_messages() else {
                return false;
            };
            for (index, message) in messages.iter().enumerate().skip(pending.length) {
                let (role, ids) = match message {
                    Message::Assistant { .. } => ("assistant", Vec::new()),
                    Message::Tool { content, .. } => (
                        "tool",
                        content
                            .iter()
                            .filter(|part| !part.is_notification())
                            .map(|part| part.tool_call_id.clone())
                            .collect(),
                    ),
                    Message::System { .. } => ("system", Vec::new()),
                    Message::User { .. } => ("user", Vec::new()),
                };
                if !check(index, role, &ids) {
                    return false;
                }
            }
        }
        let length = response_end.unwrap_or(next);
        if next != replay.len() || length <= pending.length || settled.next().is_some() {
            return false;
        }
        let Some(prefix) = Prefix::new(replay, length).await else {
            return false;
        };
        if self.transport.response_id().as_ref() != Some(&id) {
            return false;
        }
        self.semantic.lock().unwrap().confirmed = Some((prefix, id));
        true
    }

    /// The original prompt remains intact. Only a live confirmed connection may
    /// omit a prefix, and that comparison uses structural prefix metadata.
    pub(crate) async fn prepare(&self, request: &mut ModelRequest) -> usize {
        let confirmed = {
            let mut state = self.semantic.lock().unwrap();
            state.pending = None;
            state.confirmed.take()
        };
        if !matches!(
            request.provider.kind,
            ProviderKind::OpenaiResponses | ProviderKind::OpenResponses(_)
        ) || !request.provider.headers.is_empty()
            || request
                .provider
                .body_overlay
                .as_ref()
                .is_some_and(|body| !body.is_empty())
        {
            return 0;
        }
        let pending = Prefix::new(&request.prompt, request.prompt.len()).await;
        self.semantic.lock().unwrap().pending = pending;
        let Some((prefix, id)) = confirmed else {
            return 0;
        };
        if self.transport.response_id().as_ref() != Some(&id)
            || request.prompt.len() <= prefix.length
            || !prefix.matches(&request.prompt).await
        {
            return 0;
        }
        let namespace = if matches!(request.provider.kind, ProviderKind::OpenResponses(_)) {
            "openResponses"
        } else {
            "openai"
        };
        let Some(options) = request.provider_options.as_object_mut() else {
            return 0;
        };
        let options = options
            .entry(namespace)
            .or_insert_with(|| serde_json::json!({}));
        let Some(options) = options.as_object_mut() else {
            return 0;
        };
        if options.contains_key("previousResponseId") {
            return 0;
        }
        options.insert("previousResponseId".into(), Value::String(id));
        prefix.length
    }
}
