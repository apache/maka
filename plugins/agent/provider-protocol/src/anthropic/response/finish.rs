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

use super::{Usage, metadata, wire};
use crate::{Error, Result, output};
use serde_json::{Value, json};

pub(crate) fn reason(raw: Option<&str>, json_answer: bool) -> output::Stop {
    match raw {
        Some("pause_turn" | "end_turn" | "stop_sequence") => output::Stop::Stop,
        Some("refusal") => output::Stop::ContentFilter,
        Some("tool_use") if json_answer => output::Stop::Stop,
        Some("tool_use") => output::Stop::ToolCalls,
        Some("max_tokens" | "model_context_window_exceeded") => output::Stop::Length,
        _ => output::Stop::Other,
    }
}
pub(crate) fn finish(
    raw: Value,
    end: wire::End,
    transformations: Option<Vec<wire::Transformation>>,
    context: Option<wire::ContextManagement>,
    json_answer: bool,
    namespace: Option<&str>,
) -> Result<output::Finish> {
    let usage: Usage = serde_json::from_value(raw.clone())
        .map_err(|e| Error::invalid(e.to_string(), raw.clone()))?;
    from_usage(
        &usage,
        raw,
        end,
        transformations,
        context,
        json_answer,
        namespace,
    )
}
pub(crate) fn from_usage(
    usage: &Usage,
    raw: Value,
    end: wire::End,
    transformations: Option<Vec<wire::Transformation>>,
    context: Option<wire::ContextManagement>,
    json_answer: bool,
    namespace: Option<&str>,
) -> Result<output::Finish> {
    let counts = usage.totals()?;
    let iterations = raw["iterations"].as_array().map(|items|items.iter().map(|item| {
        let mut value = json!({"type":item["type"],"inputTokens":item["input_tokens"],"outputTokens":item["output_tokens"]});
        if let Some(model) = item["model"].as_str() { value["model"] = json!(model); }
        for (wire, name) in [("cache_creation_input_tokens","cacheCreationInputTokens"),("cache_read_input_tokens","cacheReadInputTokens")] {
            if item[wire].as_u64().is_some_and(|v|v!=0) { value[name] = item[wire].clone(); }
        }
        value
    }).collect::<Vec<_>>());
    let container = end.container.map(|container|json!({"id":container.id,"expiresAt":container.expires_at,
        "skills":container.skills.map(|skills|skills.into_iter().map(|skill|json!({"type":skill.r#type,"skillId":skill.skill_id,"version":skill.version})).collect::<Vec<_>>())}));
    let context = context.map(|context|json!({"appliedEdits":context.applied_edits.into_iter().map(|edit|match edit {
        wire::ContextEdit::ClearTools { cleared_tool_uses, cleared_input_tokens } => json!({"type":"clear_tool_uses_20250919","clearedToolUses":cleared_tool_uses,"clearedInputTokens":cleared_input_tokens}),
        wire::ContextEdit::ClearThinking { cleared_thinking_turns, cleared_input_tokens } => json!({"type":"clear_thinking_20251015","clearedThinkingTurns":cleared_thinking_turns,"clearedInputTokens":cleared_input_tokens}),
        wire::ContextEdit::Compact => json!({"type":"compact_20260112"}),
    }).collect::<Vec<_>>()}));
    let mut details = json!({"usage":raw,"stopSequence":end.stop_sequence,"iterations":iterations,"container":container,"contextManagement":context});
    if let Some(stop) = end.stop_details {
        let mut value = json!({"type":stop.kind});
        for (key, field) in [
            ("category", stop.category),
            ("explanation", stop.explanation),
            ("recommendedModel", stop.recommended_model),
        ] {
            if let Some(field) = field {
                value[key] = json!(field);
            }
        }
        details["stopDetails"] = value;
    }
    if let Some(transformations) = transformations {
        details["inputTransformations"] = json!(transformations);
    }
    if let Some(safeguards) = end.safeguard_results {
        details["safeguardResults"] = json!(safeguards);
    }
    let mut extensions = metadata(details.clone());
    if let Some(namespace) = namespace.filter(|s| *s != "anthropic") {
        extensions
            .as_mut()
            .unwrap()
            .insert(namespace.into(), details);
    }
    Ok(output::Finish {
        reason: reason(end.stop_reason.as_deref(), json_answer),
        raw_reason: end.stop_reason,
        usage: Some(output::Usage {
            input: Some(counts.input),
            uncached_input: Some(i128::from(counts.uncached_input)),
            cache_read: usage.cache_read_input_tokens,
            cache_write: Some(counts.cache_write),
            output: Some(counts.output),
            reasoning: counts.reasoning,
            text: counts
                .reasoning
                .map(|r| i128::from(counts.output) - i128::from(r)),
            raw: Some(raw),
        }),
        extensions,
    })
}
