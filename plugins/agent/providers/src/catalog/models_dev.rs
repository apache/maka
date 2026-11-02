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
use maka_agent_facts::configuration::{ImageInput, ModelCapabilities};
use maka_agent_facts::execution::ThinkingLevel;
use maka_agent_facts::public_catalog::PublicCatalogBody;
use serde_json::{Value, value::RawValue};
use std::collections::BTreeMap;

pub(super) struct Entry {
    pub provider: String,
    pub model: ModelInfo,
    pub canonical: Option<String>,
}

pub(super) fn parse(root: &PublicCatalogBody) -> Result<Vec<Entry>, String> {
    let providers: BTreeMap<String, &RawValue> =
        serde_json::from_str(root.as_raw().get()).map_err(|_| "invalid models.dev catalog")?;
    let mut entries = vec![];
    for (provider, raw) in providers {
        let fields: BTreeMap<String, &RawValue> = serde_json::from_str(raw.get())
            .map_err(|_| "models.dev provider ID differs from its catalog key")?;
        let provider_id: Option<String> = fields
            .get("id")
            .and_then(|id| serde_json::from_str(id.get()).ok());
        if provider_id.as_deref() != Some(provider.as_str()) {
            return Err("models.dev provider ID differs from its catalog key".into());
        }
        let models: BTreeMap<String, &RawValue> = fields
            .get("models")
            .ok_or("invalid models.dev models")
            .and_then(|models| {
                serde_json::from_str(models.get()).map_err(|_| "invalid models.dev models")
            })?;
        for (id, raw) in models {
            let row: Value =
                serde_json::from_str(raw.get()).map_err(|_| "invalid models.dev model")?;
            if row.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                return Err("models.dev model ID differs from its catalog key".into());
            }
            let canonical = text(
                row.get("canonical_model_id")
                    .or_else(|| row.get("canonical_id")),
            )?;
            if canonical.as_ref().is_some_and(|id| id.trim().is_empty()) {
                return Err("invalid models.dev canonical model ID".into());
            }
            entries.push(Entry {
                provider: provider.clone(),
                model: model(&provider, &row)?,
                canonical,
            });
        }
    }
    Ok(entries)
}

fn model(provider: &str, row: &Value) -> Result<ModelInfo, String> {
    let id = row["id"].as_str().expect("catalog key already checked");
    let modalities = super::modalities(
        row.pointer("/modalities/input"),
        row.pointer("/modalities/output"),
    )?;
    let mut capabilities = ModelCapabilities {
        reasoning: row
            .get("reasoning")
            .or_else(|| row.pointer("/capabilities/reasoning/supported"))
            .and_then(Value::as_bool),
        function_calling: row
            .get("tool_call")
            .or_else(|| row.pointer("/capabilities/tools/supported"))
            .and_then(Value::as_bool),
        ..Default::default()
    };
    if let Some(modalities) = &modalities {
        use maka_agent_facts::configuration::ModelModality::{Image, Text};
        if row
            .pointer("/modalities/input")
            .is_some_and(Value::is_array)
        {
            capabilities.vision = Some(modalities.input.contains(&Image));
        }
        if row
            .pointer("/modalities/output")
            .is_some_and(Value::is_array)
        {
            capabilities.image_generation = Some(modalities.output.contains(&Image));
            if !modalities.output.contains(&Text) {
                capabilities.chat = Some(false);
            }
        }
    }
    let mut levels = vec![];
    if let Some(options) = row.get("reasoning_options") {
        for option in options
            .as_array()
            .ok_or("invalid models.dev reasoning controls")?
        {
            match option.get("type").and_then(Value::as_str) {
                Some("effort") => {
                    if let Some(values) = option.get("values") {
                        for value in values
                            .as_array()
                            .ok_or("invalid models.dev effort values")?
                        {
                            let level = match value.as_str() {
                                Some("ultra") => Some(ThinkingLevel::Ultra),
                                Some(value) => super::openrouter::effort(value),
                                None => None,
                            };
                            if let Some(level) = level
                                && !levels.contains(&level)
                            {
                                levels.push(level);
                            }
                        }
                    }
                }
                Some("toggle") if toggle_off(provider) && !levels.contains(&ThinkingLevel::Off) => {
                    levels.push(ThinkingLevel::Off);
                }
                _ => {} // Budgets and future controls are not effort levels.
            }
        }
    }
    if capabilities.reasoning == Some(false) {
        levels.clear();
    }
    let model = ModelInfo {
        id: id.into(),
        display_name: text(row.get("name"))?,
        description: text(row.get("description"))?,
        context_window: token_limit(row.pointer("/limit/context")),
        input_limit: token_limit(row.pointer("/limit/input")),
        max_output_tokens: token_limit(row.pointer("/limit/output")),
        thinking_levels: Some(levels),
        knowledge_cutoff: text(row.get("knowledge"))?,
        structured_output: row.get("structured_output").and_then(Value::as_bool),
        last_updated: text(row.get("last_updated"))?,
        capabilities: Some(capabilities),
        image_input: image_input(row, row.pointer("/modalities/input"))?,
        modalities,
        ..Default::default()
    };
    model.validate()?;
    Ok(model)
}

pub(super) fn image_input(
    row: &Value,
    input: Option<&Value>,
) -> Result<Option<ImageInput>, String> {
    let mut image = ImageInput::default();
    if let Some(values) = input.and_then(Value::as_array)
        && !values.iter().any(|value| value.as_str() == Some("image"))
    {
        let types = values
            .iter()
            .filter_map(Value::as_str)
            .filter(|value| value.starts_with("image/"))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !types.is_empty() {
            image.mime_types = Some(types);
        }
    }
    fn number(value: Option<&Value>) -> Result<Option<u64>, String> {
        value
            .map(|value| {
                value
                    .as_f64()
                    .filter(|value| {
                        *value >= 0.0
                            && value.fract() == 0.0
                            && *value
                                <= maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER
                                    as f64
                    })
                    .map(|value| value as u64)
                    .ok_or_else(|| "invalid models.dev image limit".to_owned())
            })
            .transpose()
    }
    image.request_bytes = number(row.pointer("/limit/request_bytes"))?;
    if let Some(limits) = row.pointer("/limit/image") {
        let limits = limits
            .as_object()
            .ok_or("invalid models.dev image limits")?;
        image.max_per_message = number(limits.get("max_per_message"))?;
        image.max_per_request = number(limits.get("max_per_request"))?;
        image.max_bytes = number(limits.get("max_bytes"))?;
        let dimension = |name| -> Result<Option<u32>, String> {
            number(limits.get(name))?
                .map(|value| {
                    u32::try_from(value).map_err(|_| {
                        "models.dev image dimension exceeds supported range".to_owned()
                    })
                })
                .transpose()
        };
        image.min_width = dimension("min_width")?;
        image.min_height = dimension("min_height")?;
        image.max_width = dimension("max_width")?;
        image.max_height = dimension("max_height")?;
    }
    image.validate()?;
    Ok((image != ImageInput::default()).then_some(image))
}

fn toggle_off(provider: &str) -> bool {
    // These encoders expose the standardized `none` effort. A native vendor's
    // separate thinking switch is not interchangeable with compatible effort.
    matches!(provider, "openrouter" | "openai")
}
