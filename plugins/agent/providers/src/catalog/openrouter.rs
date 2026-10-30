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

use super::{ModelInfo, text, token_limit};
use maka_agent_facts::configuration::{ModelCapabilities, ModelModality};
use maka_agent_facts::execution::ThinkingLevel;
use maka_agent_facts::public_catalog::PublicCatalogBody;
use serde_json::{Value, value::RawValue};
use std::collections::{BTreeMap, HashSet};

pub(super) fn parse(root: &PublicCatalogBody) -> Result<Vec<ModelInfo>, String> {
    let fields: BTreeMap<String, &RawValue> =
        serde_json::from_str(root.as_raw().get()).map_err(|_| "invalid OpenRouter catalog")?;
    let rows: Vec<&RawValue> = fields
        .get("data")
        .ok_or("invalid OpenRouter catalog")
        .and_then(|data| {
            serde_json::from_str(data.get()).map_err(|_| "invalid OpenRouter catalog")
        })?;
    let mut seen = HashSet::new();
    rows.into_iter()
        .map(|raw| {
            let row: Value =
                serde_json::from_str(raw.get()).map_err(|_| "invalid OpenRouter model")?;
            let model = model(&row)?;
            if !seen.insert(model.id.clone()) {
                return Err("duplicate OpenRouter model ID".into());
            }
            Ok(model)
        })
        .collect()
}

/// Used by both public snapshots and actual account discovery. Provider JSON is
/// decoded once here; the rest of the application sees only ModelInfo.
pub(crate) fn model(row: &Value) -> Result<ModelInfo, String> {
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or("invalid OpenRouter model ID")?;
    let modalities = super::modalities(
        row.pointer("/architecture/input_modalities"),
        row.pointer("/architecture/output_modalities"),
    )?;
    let mut capabilities = ModelCapabilities::default();
    if let Some(modalities) = &modalities {
        if row
            .pointer("/architecture/input_modalities")
            .is_some_and(Value::is_array)
        {
            capabilities.vision = Some(modalities.input.contains(&ModelModality::Image));
        }
        if row
            .pointer("/architecture/output_modalities")
            .is_some_and(Value::is_array)
        {
            capabilities.chat = Some(modalities.output.contains(&ModelModality::Text));
            capabilities.image_generation = Some(modalities.output.contains(&ModelModality::Image));
        }
    }
    let mut model = ModelInfo {
        id: id.into(),
        image_input: super::models_dev::image_input(
            row,
            row.pointer("/architecture/input_modalities"),
        )?,
        display_name: text(row.get("name"))?,
        description: text(row.get("description"))?,
        context_window: token_limit(row.get("context_length"))
            .or_else(|| token_limit(row.pointer("/top_provider/context_length"))),
        max_output_tokens: token_limit(row.pointer("/top_provider/max_completion_tokens")),
        knowledge_cutoff: text(row.get("knowledge_cutoff"))?,
        modalities,
        ..Default::default()
    };
    if let Some(parameters) = row.get("supported_parameters") {
        let parameters = array(parameters)?;
        capabilities.function_calling = Some(contains(parameters, "tools"));
        model.structured_output = Some(contains(parameters, "structured_outputs"));
    }
    if capabilities != ModelCapabilities::default() {
        model.capabilities = Some(capabilities);
    }
    reasoning(row, &mut model)?;
    model.validate()?;
    Ok(model)
}

fn array(value: &Value) -> Result<&[Value], String> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| "invalid OpenRouter supported parameters".into())
}

fn contains(values: &[Value], expected: &str) -> bool {
    values.iter().any(|value| value.as_str() == Some(expected))
}

fn reasoning(row: &Value, model: &mut ModelInfo) -> Result<(), String> {
    // ModelReasoning is absent for non-reasoners and dynamic routers. Parameter
    // support can establish reasoning support, but never an effort allowlist.
    let reasoning = match row.get("reasoning") {
        None | Some(Value::Null) => None,
        Some(Value::Object(reasoning)) => Some(reasoning),
        _ => return Err("invalid OpenRouter reasoning controls".into()),
    };
    if reasoning.is_some() {
        model.capabilities.get_or_insert_default().reasoning = Some(true);
    } else if let Some(parameters) = row.get("supported_parameters") {
        let parameters = array(parameters)?;
        model.capabilities.get_or_insert_default().reasoning =
            Some(contains(parameters, "reasoning") || contains(parameters, "reasoning_effort"));
    }
    // An omitted control is not permission to resurrect bundled effort guesses.
    let mut levels = vec![];
    if let Some(reasoning) = reasoning {
        let mandatory = reasoning.get("mandatory").and_then(Value::as_bool) == Some(true);
        match reasoning.get("supported_efforts") {
            None => {}
            // The official null allowlist accepts every gateway effort value.
            Some(Value::Null) => levels.extend([
                ThinkingLevel::Max,
                ThinkingLevel::Xhigh,
                ThinkingLevel::High,
                ThinkingLevel::Medium,
                ThinkingLevel::Low,
                ThinkingLevel::Minimal,
                ThinkingLevel::Off,
            ]),
            Some(Value::Array(efforts)) => {
                for value in efforts {
                    if let Some(level) = value.as_str().and_then(effort)
                        && !levels.contains(&level)
                    {
                        levels.push(level);
                    }
                }
            }
            _ => return Err("invalid OpenRouter reasoning controls".into()),
        }
        if mandatory {
            levels.retain(|level| *level != ThinkingLevel::Off);
        }
        let enabled = reasoning.get("default_enabled").and_then(Value::as_bool);
        model.default_thinking_level = if enabled == Some(false) && !mandatory {
            Some(ThinkingLevel::Off)
        } else if enabled == Some(true) || mandatory {
            // default_effort describes the effort *when enabled*. Without an
            // enabled-state fact it cannot establish the model's initial effort.
            reasoning
                .get("default_effort")
                .and_then(Value::as_str)
                .and_then(effort)
                .filter(|level| *level != ThinkingLevel::Off)
        } else {
            None
        }
        .filter(|level| levels.contains(level));
    }
    model.thinking_levels = Some(levels);
    Ok(())
}

pub(super) fn effort(effort: &str) -> Option<ThinkingLevel> {
    Some(match effort {
        "none" => ThinkingLevel::Off,
        "minimal" => ThinkingLevel::Minimal,
        "low" => ThinkingLevel::Low,
        "medium" => ThinkingLevel::Medium,
        "high" => ThinkingLevel::High,
        "xhigh" => ThinkingLevel::Xhigh,
        "max" => ThinkingLevel::Max,
        _ => return None,
    })
}
