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

use maka_model::{
    ProviderKind,
    prompt::{AssistantPart, Message},
};
use serde_json::Value;

/// The compatible SDK otherwise concatenates reasoning parts into
/// `reasoning_content`. Message metadata preserves the committed field, even
/// for empty reasoning, without depending on a previous JS isolate.
pub(crate) fn project(mut messages: Vec<Message>, provider: &ProviderKind) -> Vec<Message> {
    if !matches!(provider, ProviderKind::OpenaiCompatible { .. }) {
        return messages;
    }
    for message in &mut messages {
        project_message(message);
    }
    messages
}

pub(super) fn project_message(message: &mut Message) {
    let Message::Assistant {
        content,
        provider_options,
    } = message
    else {
        return;
    };
    let mut reasoning = None;
    content.retain(|part| {
        let AssistantPart::Reasoning {
            text,
            provider_options,
        } = part
        else {
            return true;
        };
        let Some(field) = reasoning_field(provider_options.as_ref()) else {
            return true;
        };
        // The first tagged block owns message metadata, including empty text.
        if reasoning.is_none() {
            reasoning = Some((field, text.clone()));
        }
        false
    });
    if let Some((field, text)) = reasoning {
        let options = provider_options.get_or_insert_with(|| serde_json::json!({}));
        options["openaiCompatible"][field] = Value::String(text);
    }
}

fn reasoning_field(options: Option<&Value>) -> Option<&'static str> {
    let field = &options?["maka"]["openAiChatReasoningField"];
    match field.as_str()? {
        "reasoning" => Some("reasoning"),
        "reasoning_content" => Some("reasoning_content"),
        _ => None,
    }
}
