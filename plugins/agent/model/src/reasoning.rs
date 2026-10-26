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

use crate::{
    ProviderKind,
    prompt::{AssistantPart, Message},
};
use maka_agent_facts::model::PlaintextReasoningReplay;
use maka_agent_facts::model::PlaintextResponses;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Host-earned metadata contains boundaries, not a second copy of reasoning text.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SummaryState {
    version: u8,
    profile: String,
    item_id: String,
    summary_part_lengths: Vec<usize>,
}

fn summary(options: &Value, text: &str, contract: PlaintextResponses) -> Option<Value> {
    let state: SummaryState = serde_json::from_value(options.get("makaResponses")?.clone()).ok()?;
    if state.version != 1
        || state.profile != contract.profile()
        || state.item_id.is_empty()
        || state.item_id.bytes().any(|byte| byte.is_ascii_control())
    {
        return None;
    }
    // Persisted summary lengths use UTF-16 units; never split a Unicode scalar.
    let mut remaining = text;
    let mut parts = Vec::with_capacity(state.summary_part_lengths.len());
    for length in &state.summary_part_lengths {
        let mut units = 0;
        let mut bytes = 0;
        for ch in remaining.chars() {
            if units >= *length {
                break;
            }
            units += ch.len_utf16();
            bytes += ch.len_utf8();
        }
        if units != *length {
            return None;
        }
        parts.push(json!({"type":"summary_text","text":&remaining[..bytes]}));
        remaining = &remaining[bytes..];
    }
    if !remaining.is_empty() {
        return None;
    }
    Some(json!({
        "makaResponses": state,
        "openResponses": {"itemId":state.item_id,"reasoningSummary":parts,"reasoningContent":null}
    }))
}

/// Persisted views are normalized and measured once by their projection owner.
/// Small explicit requests normalize eagerly; a mismatched persisted policy must
/// be recaptured rather than silently changing its exact count and metering.
pub fn normalize(
    prompt: crate::prompt::Prompt,
    provider: &ProviderKind,
) -> Result<crate::prompt::Prompt, crate::ModelError> {
    if !matches!(provider, ProviderKind::OpenResponses(_))
        || prompt.normalization() == Some(provider)
    {
        return Ok(prompt);
    }
    let messages = prompt.memory_messages().ok_or_else(|| {
        crate::ModelError::Adapter(
            "prompt reasoning policy does not match captured provider".into(),
        )
    })?;
    Ok(
        crate::prompt::Prompt::from_messages(project(messages.to_vec(), provider))
            .with_normalization(provider.clone()),
    )
}

/// Project before recording the request digest. This is idempotent so direct model
/// callers also receive the same contract enforcement at the adapter boundary.
pub fn project(mut messages: Vec<Message>, provider: &ProviderKind) -> Vec<Message> {
    let ProviderKind::OpenResponses(contract) = provider else {
        return messages;
    };
    for message in &mut messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        content.retain_mut(|part| {
            let AssistantPart::Reasoning {
                text,
                provider_options,
            } = part
            else {
                return true;
            };
            match contract.reasoning_replay {
                PlaintextReasoningReplay::PlaintextContent => {
                    *provider_options = None;
                    !text.is_empty()
                }
                PlaintextReasoningReplay::PlaintextSummary => {
                    let Some(options) = provider_options
                        .as_ref()
                        .and_then(|value| summary(value, text, *contract))
                    else {
                        return false;
                    };
                    *provider_options = Some(options);
                    true
                }
            }
        });
    }
    messages.retain(
        |message| !matches!(message, Message::Assistant { content, .. } if content.is_empty()),
    );
    messages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_boundaries_are_unicode_safe_profile_bound_and_idempotent() {
        let contract = PlaintextResponses {
            reasoning_replay: PlaintextReasoningReplay::PlaintextSummary,
            compatibility: None,
        };
        let state = json!({"version":1,"profile":contract.profile(),"itemId":"rs_1","summaryPartLengths":[3,0,1]});
        let message = |state: Value| {
            serde_json::from_value(json!({
            "role":"assistant","content":[{"type":"reasoning","text":"想😀好","providerOptions":{"makaResponses":state}}]
        })).unwrap()
        };
        let provider = ProviderKind::OpenResponses(contract);
        let projected = project(vec![message(state.clone())], &provider);
        let value = serde_json::to_value(&projected).unwrap();
        assert_eq!(
            value[0]["content"][0]["providerOptions"]["openResponses"]["reasoningSummary"],
            json!([{"type":"summary_text","text":"想😀"},{"type":"summary_text","text":""},{"type":"summary_text","text":"好"}])
        );
        assert!(
            value[0]["content"][0]["providerOptions"]["openResponses"]["reasoningContent"]
                .is_null()
        );
        assert_eq!(project(projected.clone(), &provider), projected);
        for (key, value) in [
            ("summaryPartLengths", json!([2, 2])),
            ("summaryPartLengths", json!([3])),
            ("version", json!(2)),
            ("profile", json!("other")),
            ("itemId", json!("\u{0}")),
        ] {
            let mut bad = state.clone();
            bad[key] = value;
            assert!(project(vec![message(bad)], &provider).is_empty());
        }
    }
}
