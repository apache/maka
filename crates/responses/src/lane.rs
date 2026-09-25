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

use maka_runtime::model::{
    prompt::Message,
    request::{ProviderKind, Request as ModelRequest},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io,
    sync::{Arc, Mutex},
};

/// The transport is only a cache. Confirmation must come from the canonical
/// projection after all local tool outcomes have committed.
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
    digest: [u8; 32],
}

impl Prefix {
    fn new(messages: &[Message]) -> Self {
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
        let mut writer = Writer(Sha256::new());
        // Message serialization cannot fail with this infallible writer.
        serde_json::to_writer(&mut writer, messages).expect("JSON value serialization");
        Self {
            length: messages.len(),
            digest: writer.0.finalize().into(),
        }
    }

    fn matches(&self, messages: &[Message]) -> bool {
        messages
            .get(..self.length)
            .is_some_and(|prefix| Self::new(prefix).digest == self.digest)
    }
}

impl Lane {
    /// No readback is needed when there is no completed, cached WS response.
    pub fn needs_confirmation(&self) -> bool {
        self.transport.response_id().is_some()
    }

    /// Call once with the post-settlement model view. A changed prefix or
    /// missing outcome disables reuse; later view changes are checked again.
    pub fn confirm(
        &self,
        replay: &[Message],
        settled_tool_call_ids: &[&str],
        response_id: Option<&str>,
    ) -> bool {
        let mut state = self.semantic.lock().unwrap();
        state.confirmed = None;
        let Some(pending) = state.pending.take() else {
            return false;
        };
        let Some(id) = self.transport.response_id() else {
            return false;
        };
        if response_id != Some(id.as_str()) {
            return false;
        }
        if !pending.matches(replay) {
            return false;
        }
        let response_end = match replay[pending.length..]
            .iter()
            .position(|message| matches!(message, Message::Tool { .. }))
        {
            Some(offset) => pending.length + offset,
            None if settled_tool_call_ids.is_empty() => replay.len(),
            None => return false,
        };
        if response_end <= pending.length {
            return false;
        }
        let mut settled = settled_tool_call_ids.iter();
        for message in &replay[response_end..] {
            let Message::Tool { content, .. } = message else {
                return false;
            };
            for part in content {
                if !part.is_notification()
                    && settled.next().copied() != Some(part.tool_call_id.as_str())
                {
                    return false;
                }
            }
        }
        if settled.next().is_some() {
            return false;
        }
        state.confirmed = Some((Prefix::new(&replay[..response_end]), id));
        true
    }

    pub(crate) fn prepare(&self, request: &mut ModelRequest) {
        let mut state = self.semantic.lock().unwrap();
        let confirmed = state.confirmed.take();
        state.pending = None;
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
            return;
        }
        state.pending = Some(Prefix::new(&request.prompt));
        let Some((prefix, id)) = confirmed else {
            return;
        };
        if self.transport.response_id().as_ref() != Some(&id)
            || request.prompt.len() <= prefix.length
            || !prefix.matches(&request.prompt)
        {
            return;
        }
        // Never replace caller-specified options with an optimization.
        let Some(options) = request.provider_options.as_object_mut() else {
            return;
        };
        let openai = options
            .entry("openai")
            .or_insert_with(|| serde_json::json!({}));
        let Some(openai) = openai.as_object_mut() else {
            return;
        };
        if openai.contains_key("previousResponseId") {
            return;
        }
        openai.insert("previousResponseId".into(), Value::String(id));
        request.prompt.drain(..prefix.length);
    }
}
