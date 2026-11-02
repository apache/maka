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

use maka_agent_facts::configuration::ModelCapabilities;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_ports::provider::Error;
use serde::{Deserialize, Deserializer};
use std::collections::HashSet;

#[derive(Deserialize)]
struct Inventory {
    models: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    slug: Option<String>,
    visibility: Option<String>,
    priority: Option<f64>,
    display_name: Option<String>,
    context_window: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    supported_reasoning_levels: Option<Vec<Reasoning>>,
    supports_reasoning_summary_parameter: Option<bool>,
    supports_reasoning_summaries: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    input_modalities: Option<Vec<String>>,
    supports_parallel_tool_calls: Option<bool>,
}

#[derive(Deserialize)]
struct Reasoning {
    effort: String,
}

// An omitted declaration is unknown; null is not an advertised empty list.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// Decode account facts once for discovery and provider request preparation.
pub fn decode_model_inventory(bytes: &[u8]) -> Result<Vec<ModelInfo>, Error> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut inventory: Inventory = serde_json::from_str(text).map_err(|_| invalid())?;
    inventory.models.sort_by(|a, b| {
        a.priority
            .unwrap_or(10_000.0)
            .total_cmp(&b.priority.unwrap_or(10_000.0))
    });
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for row in inventory.models {
        let Some(id) = row.slug.as_deref().map(|id| id.trim_matches(whitespace)) else {
            continue;
        };
        if id.is_empty()
            || id.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            || row.visibility.as_deref().is_some_and(|value| {
                matches!(
                    value.trim_matches(whitespace).to_ascii_lowercase().as_str(),
                    "hide" | "hidden"
                )
            })
            || !seen.insert(id.to_owned())
        {
            continue;
        }
        let mut info = ModelInfo::new(id);
        info.max_output_tokens = output_capacity(id)?;
        info.display_name = row.display_name;
        info.context_window = row
            .context_window
            .filter(|n| (1.0..=9_007_199_254_740_991.0).contains(n) && n.fract() == 0.0)
            .map(|n| n as u64);
        if let Some(advertised) = row.supported_reasoning_levels {
            use maka_agent_facts::execution::ThinkingLevel::*;
            info.thinking_levels = Some(
                [
                    (Off, "none"),
                    (Minimal, "minimal"),
                    (Low, "low"),
                    (Medium, "medium"),
                    (High, "high"),
                    (Xhigh, "xhigh"),
                    (Max, "max"),
                    (Ultra, "ultra"),
                ]
                .into_iter()
                .filter_map(|(level, name)| {
                    advertised
                        .iter()
                        .any(|entry| {
                            entry.effort == name || (level == Off && entry.effort == "off")
                        })
                        .then_some(level)
                })
                .collect(),
            );
        }
        info.supports_reasoning_summary = row
            .supports_reasoning_summary_parameter
            .or(row.supports_reasoning_summaries);
        let capabilities = ModelCapabilities {
            reasoning: info
                .thinking_levels
                .as_ref()
                .map(|levels| !levels.is_empty()),
            vision: row
                .input_modalities
                .as_ref()
                .map(|input| input.iter().any(|kind| kind == "image")),
            parallel_tool_calls: row.supports_parallel_tool_calls,
            ..Default::default()
        };
        if capabilities != ModelCapabilities::default() {
            info.capabilities = Some(capabilities);
        }
        info.validate().map_err(|_| invalid())?;
        models.push(info);
    }
    Ok(models)
}

// Account inventory currently omits output capacity. Keep the model's known
// capacity for Host budgeting without turning it into a subscription parameter.
pub(super) fn output_capacity(id: &str) -> Result<Option<u64>, Error> {
    Ok(crate::facts::provider_facts("openai-codex")?
        .models
        .get(id)
        .and_then(|model| model.metadata.max_output_tokens))
}

fn invalid() -> Error {
    Error::Invalid("invalid subscription inventory".into())
}

fn whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
