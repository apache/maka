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

//! Small request overlays over a fixed, already projected history view.
use maka_agent_facts::context::{PreparedContextBreakdown, measure};
use maka_model::prompt::{Message, Prompt, PromptCursor, PromptSource};
use std::sync::Arc;
mod wire;

#[derive(Clone)]
pub(super) struct PreparedPrompt {
    body: Prompt,
    wire: Option<maka_agent_facts::model::prompt_source::PreparedWire>,
    history: Option<Arc<crate::history::PreparedHistory>>,
    system: Option<Arc<Message>>,
    prefix: Arc<Vec<Message>>,
    suffix: Arc<Vec<Message>>,
}

impl PreparedPrompt {
    pub fn new(body: Prompt) -> Self {
        Self {
            body,
            wire: None,
            history: None,
            system: None,
            prefix: Arc::new(Vec::new()),
            suffix: Arc::new(Vec::new()),
        }
    }

    pub fn from_history(history: Arc<crate::history::PreparedHistory>) -> Self {
        let mut prompt = Self::new(history.prompt());
        prompt.history = Some(history);
        prompt
    }

    pub fn set_system(&mut self, system: Option<Message>) {
        self.wire = None;
        self.system = system.map(Arc::new);
    }

    pub fn prepend(&mut self, message: Message) {
        self.wire = None;
        Arc::make_mut(&mut self.prefix).insert(0, message);
    }

    pub fn push(&mut self, message: Message) {
        self.wire = None;
        Arc::make_mut(&mut self.suffix).push(message);
    }

    pub async fn compile_wire(
        &mut self,
        language: maka_agent_facts::language::Language,
        provider: &maka_model::ProviderConfig,
        options: &serde_json::Value,
        tools: &[maka_model::ToolDefinition],
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), crate::RunError> {
        wire::compile(self, language, provider, options, tools, cancellation).await
    }

    pub fn breakdown(&self) -> PreparedContextBreakdown {
        let mut result = self.body.breakdown().clone();
        if let Some(system) = &self.system {
            result.accumulate(&measure::prompt_breakdown(std::slice::from_ref(
                system.as_ref(),
            )));
        }
        result.accumulate(&measure::prompt_breakdown(&self.prefix));
        result.accumulate(&measure::prompt_breakdown(&self.suffix));
        result
    }

    pub fn model(&self) -> Prompt {
        #[derive(serde::Serialize)]
        struct Identity<'a> {
            domain: &'static str,
            body: &'a str,
            system: Option<&'a Message>,
            prefix: &'a [Message],
            suffix: &'a [Message],
        }
        let identity = crate::runner::digest(&Identity {
            domain: "maka.prepared-prompt.v2",
            body: self.body.identity(),
            system: self.system.as_deref(),
            prefix: &self.prefix,
            suffix: &self.suffix,
        })
        .expect("prepared overlays are serializable");
        let mut prompt = Prompt::new(
            Arc::new(Overlay(self.clone())),
            identity,
            self.body.len()
                + usize::from(self.system.is_some())
                + self.prefix.len()
                + self.suffix.len(),
            self.breakdown(),
        );
        if let Some(provider) = self.body.normalization() {
            prompt = prompt.with_normalization(provider.clone());
        }
        // Persisted history contains conversation roles only. All System entries
        // are captured overlays or explicit bounded summary input.
        let instructions = self
            .system
            .as_deref()
            .into_iter()
            .chain(self.prefix.iter())
            .chain(self.body.memory_messages().into_iter().flatten())
            .chain(self.suffix.iter())
            .find_map(|message| match message {
                Message::System { content, .. } if !content.trim().is_empty() => {
                    Some(content.as_str())
                }
                _ => None,
            })
            .unwrap_or("");
        prompt = prompt.with_instructions(Arc::<str>::from(instructions));
        if let Some(wire) = &self.wire {
            prompt = prompt.with_wire(
                wire.format,
                wire.codec.clone(),
                wire.identity.clone(),
                wire.source.clone(),
            );
        }
        prompt
    }

    pub fn open(&self) -> Box<dyn PromptCursor> {
        self.model().open()
    }
}

struct Overlay(PreparedPrompt);
impl PromptSource for Overlay {
    fn open(&self) -> Box<dyn PromptCursor> {
        Box::new(Cursor {
            system: self.0.system.clone(),
            prefix: self.0.prefix.clone(),
            prefix_offset: 0,
            body: self.0.body.open(),
            suffix: self.0.suffix.clone(),
            body_done: false,
            offset: 0,
        })
    }
}
struct Cursor {
    system: Option<Arc<Message>>,
    prefix: Arc<Vec<Message>>,
    prefix_offset: usize,
    body: Box<dyn PromptCursor>,
    suffix: Arc<Vec<Message>>,
    body_done: bool,
    offset: usize,
}
impl PromptCursor for Cursor {
    fn next(&mut self) -> maka_agent_facts::model::prompt_source::Next<'_> {
        Box::pin(async move {
            if let Some(system) = self.system.take() {
                return Ok(Some(system.as_ref().clone()));
            }
            if let Some(message) = self.prefix.get(self.prefix_offset) {
                self.prefix_offset += 1;
                return Ok(Some(message.clone()));
            }
            if !self.body_done {
                if let Some(message) = self.body.next().await? {
                    return Ok(Some(message));
                }
                self.body_done = true;
            }
            let message = self.suffix.get(self.offset).cloned();
            self.offset += usize::from(message.is_some());
            Ok(message)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::{
        PreparedWire, WireCursor, WireFormat, WireSource,
    };

    struct UnreadableHistory;
    impl PromptSource for UnreadableHistory {
        fn open(&self) -> Box<dyn PromptCursor> {
            panic!("request identity must not traverse history")
        }
    }
    impl WireSource for UnreadableHistory {
        fn open(&self, _: usize) -> Box<dyn WireCursor> {
            panic!("request identity must not encode body")
        }
    }

    #[test]
    fn final_request_identity_binds_wire_root_and_captures_absent_instructions_without_reads() {
        let mut prompt = PreparedPrompt::new(Prompt::new(
            Arc::new(UnreadableHistory),
            "semantic-root",
            1000,
            PreparedContextBreakdown::default(),
        ));
        prompt.wire = Some(PreparedWire {
            format: WireFormat::ChatCompletions,
            codec: "codec-one".into(),
            identity: "wire-one".into(),
            source: Arc::new(UnreadableHistory),
        });
        let first = prompt.model();
        assert_eq!(first.instructions(), Some(""));
        prompt.wire.as_mut().unwrap().identity = "wire-two".into();
        assert_ne!(
            first.identity(),
            prompt.model().identity(),
            "a changed prepared wire root changes input evidence"
        );
        prompt.wire.as_mut().unwrap().identity = "wire-one".into();
        prompt.wire.as_mut().unwrap().codec = "codec-two".into();
        assert_ne!(
            first.identity(),
            prompt.model().identity(),
            "codec revisions are part of input evidence"
        );
    }
}
