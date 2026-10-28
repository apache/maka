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

//! A frozen instruction view sharing the allocation that already owns its text.
use super::Message;
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone)]
enum Text {
    Empty,
    Shared(Arc<str>),
    Owned(Arc<String>),
    Generated {
        messages: Arc<Vec<Message>>,
        index: usize,
    },
}
#[derive(Clone)]
pub struct PromptInstructions {
    text: Text,
    commitment: [u8; 32],
    _owner: Option<Arc<dyn Send + Sync>>,
}
impl PromptInstructions {
    pub fn empty() -> Self {
        Self {
            text: Text::Empty,
            commitment: Sha256::digest(b"").into(),
            _owner: None,
        }
    }
    pub fn shared(text: Arc<str>) -> Self {
        let commitment = Sha256::digest(text.as_bytes()).into();
        Self {
            text: Text::Shared(text),
            commitment,
            _owner: None,
        }
    }
    pub fn owned(text: Arc<String>) -> Self {
        let commitment = Sha256::digest(text.as_bytes()).into();
        Self {
            text: Text::Owned(text),
            commitment,
            _owner: None,
        }
    }
    pub(super) fn generated(messages: Arc<Vec<Message>>, index: usize) -> Self {
        let Message::System { content, .. } = &messages[index] else {
            unreachable!("captured generated System instruction");
        };
        let commitment = Sha256::digest(content.as_bytes()).into();
        Self {
            text: Text::Generated { messages, index },
            commitment,
            _owner: None,
        }
    }
    pub fn as_str(&self) -> &str {
        match &self.text {
            Text::Empty => "",
            Text::Shared(text) => text,
            Text::Owned(text) => text.as_str(),
            Text::Generated { messages, index } => match &messages[*index] {
                Message::System { content, .. } => content,
                _ => unreachable!("frozen generated System instruction"),
            },
        }
    }
    pub fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }
    /// Bind one logical request's accounting without changing its text or commitment.
    pub fn with_owner(mut self, owner: Arc<dyn Send + Sync>) -> Self {
        self._owner = Some(owner);
        self
    }
}
impl std::fmt::Debug for PromptInstructions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromptInstructions")
            .field("bytes", &self.as_str().len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::prompt_source::Prompt;
    #[test]
    fn generated_system_instructions_borrow_the_original_message_allocation() {
        let prompt = Prompt::from_messages(vec![
            Message::System {
                content: "  ".into(),
                provider_options: None,
            },
            Message::System {
                content: "first real instruction 中文".repeat(1024),
                provider_options: None,
            },
        ]);
        let Message::System { content, .. } = &prompt.memory_messages().unwrap()[1] else {
            panic!("expected generated System");
        };
        assert_eq!(prompt.instructions().unwrap().as_ptr(), content.as_ptr());
        let copy = prompt.clone();
        assert_eq!(copy.instructions().unwrap().as_ptr(), content.as_ptr());
    }
    #[test]
    fn equal_instruction_text_has_the_same_commitment_across_owner_types() {
        let owned = PromptInstructions::owned(Arc::new("same text 中文".into()));
        let shared = PromptInstructions::shared(Arc::from("same text 中文"));
        assert_eq!(owned.commitment(), shared.commitment());
    }
}
