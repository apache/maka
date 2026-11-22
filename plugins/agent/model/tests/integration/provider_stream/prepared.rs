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

//! Prepared wire requests fail immediately if the executor opens semantic history.
use maka_model::{
    ModelRequest,
    prompt::{Message, Prompt, PromptCursor, PromptSource},
};
use std::sync::Arc;

struct FailedSource;
impl PromptSource for FailedSource {
    fn open(&self) -> Box<dyn PromptCursor> {
        panic!("prepared request must not open semantic history")
    }
}
fn resources() -> maka_model::ModelPreparationResources {
    maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy {
        staging_bytes: 8 * 1024 * 1024,
        resident_bytes: 8 * 1024 * 1024,
        progress_bytes: 256 * 1024,
        work_bytes: 256 * 1024,
    })
    .unwrap()
}

pub(crate) async fn prepare_input(input: &mut ModelRequest) {
    let messages = input
        .prompt
        .memory_messages()
        .expect("synthetic fixture input")
        .to_vec();
    let messages = maka_model::reasoning::project(messages, &input.provider.kind);
    let instructions = messages
        .iter()
        .find_map(|message| match message {
            Message::System { content, .. } if !content.trim().is_empty() => Some(content.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let logical = Prompt::from_messages(messages.clone());
    let encoding = maka_model::WireEncoding::new(
        input.language,
        &input.provider,
        &input.provider_options,
        &input.tools,
    )
    .unwrap();
    let format = encoding.format();
    let codec = encoding.codec().to_owned();
    let wire = encoding
        .prepare_source(
            Arc::new(
                maka_agent_facts::model::prompt_source::source::generated::GeneratedMessages::new(
                    &messages,
                ),
            ),
            resources(),
        )
        .await
        .unwrap();
    input.prompt = Prompt::new(
        Arc::new(FailedSource),
        logical.identity(),
        logical.len(),
        logical.breakdown().clone(),
    )
    .with_normalization(input.provider.kind.clone())
    .with_wire(format, codec, wire.identity, wire.source)
    .with_instructions(instructions);
}
