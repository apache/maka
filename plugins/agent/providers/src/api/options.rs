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

use super::Wire;
use super::{Selection, route::Route};
use crate::facts::{ProviderFacts, ThinkingOffBehavior};
use maka_agent_facts::execution::ThinkingLevel;
use maka_agent_ports::model::ProviderKind;
use maka_agent_ports::provider::Error;
use serde_json::{Value, json};
use std::borrow::Cow;

mod compatible;
mod relay;

/// Compose protocol options from the same public request as routing.
/// SDKs encode the wire; this is Maka's explicit execution policy.
pub(super) fn resolve(
    row: &Selection<'_>,
    facts: &ProviderFacts,
    thinking_levels: &[ThinkingLevel],
    thinking_level: Option<ThinkingLevel>,
    route: &Route,
) -> Result<Value, Error> {
    let wire = route.wire;
    let parallel = row
        .model
        .capabilities
        .and_then(|caps| caps.parallel_tool_calls);
    match &route.kind {
        ProviderKind::Anthropic => Ok(anthropic(
            facts,
            row.model,
            thinking_levels,
            thinking_level,
            parallel,
        )),
        ProviderKind::OpenaiResponses if row.provider == "openai-responses-compatible" => {
            relay::responses(row, thinking_level, parallel.unwrap_or(true))
        }
        ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiResponses => {
            // An explicit account capability can opt out; it never gates rendering.
            let summary = row.model.supports_reasoning_summary.unwrap_or(false);
            Ok(openai(
                wire,
                thinking_level,
                summary,
                parallel.unwrap_or(true),
            ))
        }
        ProviderKind::OpenaiCompatible { name } => {
            let mut options = compatible::chat_completions(name, thinking_level, parallel);
            if let crate::facts::adapter::AdapterKind::OpenaiCompatible {
                include_usage,
                replay_assistant_reasoning_as,
                ..
            } = &route.adapter.kind
            {
                if let Some(include) = include_usage {
                    options["maka"]["includeUsage"] = json!(include);
                }
                if let Some(crate::facts::adapter::ReasoningField::Reasoning) =
                    replay_assistant_reasoning_as
                {
                    options["maka"]["openAiChatReasoningField"] = json!("reasoning");
                }
            }
            Ok(options)
        }
        ProviderKind::OpenResponses(contract) => {
            if parallel == Some(false) {
                return Err(Error::UnsupportedParallelPolicy);
            }
            let mut options = json!({});
            if let Some(level) = thinking_level {
                options["reasoningEffort"] = if level == ThinkingLevel::Off {
                    json!("none")
                } else {
                    json!(level)
                };
            }
            if contract.reasoning_replay
                == maka_agent_facts::model::PlaintextReasoningReplay::PlaintextSummary
                && thinking_level != Some(ThinkingLevel::Off)
            {
                options["reasoningSummary"] = json!("auto");
            }
            Ok(json!({"openResponses":options}))
        }
    }
}

fn openai(wire: Wire, level: Option<ThinkingLevel>, summary: bool, parallel: bool) -> Value {
    let mut options = json!({"store": false, "parallelToolCalls": parallel});
    if let Some(level) = level {
        options["reasoningEffort"] = match level {
            ThinkingLevel::Off => json!("none"),
            level => json!(level),
        };
    }
    if wire == Wire::OpenaiResponses && summary && level != Some(ThinkingLevel::Off) {
        options["reasoningSummary"] = json!("auto");
    }
    json!({"openai": options})
}

fn anthropic(
    facts: &ProviderFacts,
    model: &maka_agent_facts::configuration::ModelInfo,
    levels: &[ThinkingLevel],
    level: Option<ThinkingLevel>,
    parallel: Option<bool>,
) -> Value {
    let family = claude_family(&model.id);
    let known = facts.models.get(&model.id);
    let family_facts = facts.models.get(family.as_ref());
    let metadata = known.map(|item| &item.metadata);
    let family_metadata = family_facts.map(|item| &item.metadata);
    // The SDK's off encoding and adaptive wire support remain compiled policy.
    let off_behavior = metadata
        .and_then(|metadata| metadata.thinking_options.as_ref())
        .and_then(|thinking| thinking.off_behavior)
        .or_else(|| {
            family_metadata
                .and_then(|metadata| metadata.thinking_options.as_ref())
                .and_then(|thinking| thinking.off_behavior)
        });
    let bare_legacy = matches!(family.as_ref(), "claude-opus-4" | "claude-sonnet-4");
    let visible = family.starts_with("claude-")
        && (model.capabilities.and_then(|caps| caps.reasoning) == Some(true)
            || levels.iter().any(|level| *level != ThinkingLevel::Off));
    let mut options = json!({"cacheControl":{"type":"ephemeral"}});
    if parallel == Some(false) {
        options["disableParallelToolUse"] = json!(true);
    }
    if level == Some(ThinkingLevel::Off)
        && off_behavior == Some(ThinkingOffBehavior::AnthropicThinkingDisabled)
    {
        options["thinking"] = json!({"type":"disabled"});
    } else if visible {
        let adaptive = !bare_legacy
            && known
                .or(family_facts)
                .is_some_and(|item| item.anthropic_adaptive_thinking == Some(true));
        options["thinking"] = if adaptive {
            json!({"type":"adaptive", "display":"summarized"})
        } else {
            json!({"type":"enabled", "budgetTokens":1024})
        };
        if let Some(level) = level {
            options["effort"] = json!(level);
        }
    } else if let Some(level) = level.filter(|level| *level != ThinkingLevel::Off) {
        options["effort"] = json!(level);
    }
    json!({"anthropic": options})
}

fn claude_family(model: &str) -> Cow<'_, str> {
    let family = model.rsplit('/').next().unwrap_or(model);
    for prefix in ["claude-haiku-", "claude-opus-", "claude-sonnet-"] {
        let Some((major, rest)) = family
            .strip_prefix(prefix)
            .and_then(|tail| tail.split_once('.'))
        else {
            continue;
        };
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        if !major.is_empty()
            && major.bytes().all(|c| c.is_ascii_digit())
            && end > 0
            && (end == rest.len() || rest[end..].starts_with('-'))
        {
            return Cow::Owned(format!("{prefix}{major}-{rest}"));
        }
    }
    Cow::Borrowed(family)
}
