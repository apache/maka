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
use std::collections::HashSet;

use maka_agent_facts::configuration::ApiProtocol;
use maka_agent_facts::configuration::ConnectionEffectFailureClass;
use maka_agent_facts::configuration::ModelCapabilities;
use maka_agent_facts::configuration::ModelInfo;
use serde_json::Value;

type Failure = ConnectionEffectFailureClass;

/// Provider-specific JSON ends here; catalog normalization operates on typed rows.
pub(super) fn from_rows<'a>(
    provider: &str,
    wire: ApiProtocol,
    rows: impl IntoIterator<Item = &'a Value>,
) -> Result<Vec<ModelInfo>, Failure> {
    let mut models = Vec::new();
    for row in rows {
        // Magpie includes image generators when asked for per-model search capabilities.
        if provider == "magpie" && row["kind"] == "image" {
            continue;
        }
        let Some(mut model) = model_info(provider, row)? else {
            continue;
        };
        if wire != ApiProtocol::AnthropicMessages
            && let Some(tiers) = row.get("service_tiers").filter(|tiers| !tiers.is_null())
        {
            model.service_tiers =
                serde::Deserialize::deserialize(tiers).map_err(|_| Failure::InvalidResponse)?;
        }
        if provider == "magpie" {
            model.capabilities.get_or_insert_default().web_search =
                Some(row["web_search"] == "native");
        }
        models.push(model);
    }
    normalize(models)
}

pub(super) fn normalize(models: Vec<ModelInfo>) -> Result<Vec<ModelInfo>, Failure> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for mut model in models {
        let id = model.id.trim_matches(model_whitespace);
        if id.is_empty()
            || id.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            || !seen.insert(id.to_owned())
        {
            continue;
        }
        model.id = id.to_owned();
        model.validate().map_err(|_| Failure::InvalidResponse)?;
        normalized.push(model);
    }
    Ok(normalized)
}

fn optional_array(value: Option<&Value>) -> Result<&[Value], Failure> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => Err(Failure::InvalidResponse),
    }
}

fn object_array(value: Option<&Value>) -> Result<&[Value], Failure> {
    let values = optional_array(value)?;
    if values.iter().any(|v| !v.is_object()) {
        return Err(Failure::InvalidResponse);
    }
    Ok(values)
}

fn contains(values: &[Value], expected: &str) -> bool {
    values.iter().any(|v| v.as_str() == Some(expected))
}

fn model_info(provider: &str, row: &Value) -> Result<Option<ModelInfo>, Failure> {
    let Some(id) = row
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    if provider == "openrouter" {
        return crate::catalog::openrouter::model(row)
            .map(Some)
            .map_err(|_| Failure::InvalidResponse);
    }
    let input = optional_array(row.get("input_modalities"))?;
    let output = optional_array(row.get("output_modalities"))?;
    let tags = optional_array(row.get("tags"))?;
    let providers = object_array(row.get("providers"))?;
    let mut capabilities = ModelCapabilities {
        vision: row
            .get("supports_image_in")
            .and_then(Value::as_bool)
            .or_else(|| contains(input, "image").then_some(true)),
        reasoning: row
            .get("supports_reasoning")
            .and_then(Value::as_bool)
            .or_else(|| {
                row.pointer("/capabilities/reasoning")
                    .and_then(Value::as_bool)
            }),
        ..Default::default()
    };
    if contains(tags, "vision") {
        capabilities.vision = Some(true);
    }
    if contains(tags, "reasoning") {
        capabilities.reasoning = Some(true);
    }
    if contains(tags, "tool-use") {
        capabilities.function_calling = Some(true);
    }
    if row.get("providers").is_some() {
        capabilities.function_calling = Some(providers.iter().any(|provider| {
            provider.get("status").and_then(Value::as_str) == Some("live")
                && provider.get("supports_tools").and_then(Value::as_bool) == Some(true)
        }));
    }
    let known_output = ["text", "image", "audio", "pdf", "video"]
        .iter()
        .any(|kind| contains(output, kind));
    if known_output && !contains(output, "text") {
        capabilities.chat = Some(false);
        capabilities.image_generation = contains(output, "image").then_some(true);
    }
    let mut model = ModelInfo::new(id);
    model.display_name = match row
        .get("display_name")
        .filter(|value| !value.is_null())
        .or(row.get("name"))
    {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err(Failure::InvalidResponse),
    };
    model.context_window = row
        .get("context_length")
        .and_then(token_limit)
        .or_else(|| row.get("context_window").and_then(token_limit));
    model.max_output_tokens = row.get("max_tokens").and_then(token_limit);
    if capabilities != ModelCapabilities::default() {
        model.capabilities = Some(capabilities);
    }
    Ok(Some(model))
}

fn token_limit(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| (1.0..=9_007_199_254_740_991.0).contains(n) && n.fract() == 0.0)
        .map(|n| n as u64)
}

fn model_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decode(body: &[u8]) -> Result<Vec<Value>, Failure> {
        let text = String::from_utf8_lossy(body);
        let root: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|_| Failure::InvalidResponse)?;
        if !root.is_object() && !root.is_array() {
            return Err(Failure::InvalidResponse);
        }
        super::from_rows(
            "fixture",
            ApiProtocol::OpenaiResponses,
            object_array(root.get("data"))?,
        )
        .map(|models| {
            models
                .into_iter()
                .map(|model| serde_json::to_value(model).unwrap())
                .collect()
        })
    }

    #[test]
    fn metadata_precedence_and_unknown_fields() {
        let rows = decode(
            br#"{"data":[{"id":" x ","display_name":"","name":"fallback",
            "context_length":0,"context_window":4096.0,"max_tokens":1e3,
            "input_modalities":["image"],"output_modalities":[null,"Text","image"],
            "supports_image_in":false,"capabilities":{"reasoning":true},
            "supports_reasoning":false,"tags":["reasoning","tool-use"],"providers":[],
            "unknown":true}]}"#,
        )
        .unwrap();
        assert_eq!(
            rows,
            vec![json!({"id":"x","displayName":"","contextWindow":4096,
            "maxOutputTokens":1000,"capabilities":{"vision":false,"reasoning":true,
            "functionCalling":false,"chat":false,"imageGeneration":true}})]
        );
    }

    #[test]
    fn first_duplicate_wins_and_long_ids_preserve_complete_identity() {
        let body = json!({"data":[{"id":"\u{feff}x\u{feff}","name":"first"},
            {"id":"x","name":"second"},{"id":"a\u{7f}"},{"id":"😀".repeat(257)},
            {"id":"😀".repeat(256)},{"id":"\u{85}y\u{85}"}]})
        .to_string();
        let rows = decode(body.as_bytes()).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0], json!({"id":"x","displayName":"first"}));
        assert_eq!(rows[1]["id"], "😀".repeat(257));
        assert_eq!(rows[3]["id"], "\u{85}y\u{85}");
    }

    #[test]
    fn envelope_and_metadata_structure_failures() {
        for body in [
            "null",
            "true",
            "{",
            r#"{"data":null}"#,
            r#"{"data":[1]}"#,
            r#"{"data":[{"id":"x","providers":[null]}]}"#,
            r#"{"data":[{"id":"x","tags":null}]}"#,
            r#"{"data":[{"id":"x","name":42}]}"#,
            r#"{"data":[{"id":"x"},{"id":"x","input_modalities":null}]}"#,
        ] {
            assert_eq!(
                decode(body.as_bytes()),
                Err(Failure::InvalidResponse),
                "{body}"
            );
        }
        for body in [
            "{}",
            "[]",
            r#"{"data":[{"name":"missing id","tags":null}]}"#,
        ] {
            assert!(decode(body.as_bytes()).unwrap().is_empty());
        }
    }

    #[test]
    fn complete_inventory_preserves_additional_models_after_deduplication() {
        let mut rows: Vec<Value> = (0..2048).map(|i| json!({"id":i.to_string()})).collect();
        rows.push(json!({"id":"0"}));
        assert_eq!(
            decode(json!({"data":rows}).to_string().as_bytes())
                .unwrap()
                .len(),
            2048
        );
        rows.push(json!({"id":"extra"}));
        let models = decode(json!({"data":rows}).to_string().as_bytes()).unwrap();
        assert_eq!(models.len(), 2049);
        assert_eq!(models.last().unwrap()["id"], "extra");
    }

    #[test]
    fn response_text_uses_lossy_utf8_and_strips_bom() {
        assert_eq!(
            decode(b"\xef\xbb\xbf{\"data\":[{\"id\":\"\xff\"}]}").unwrap(),
            vec![json!({"id":"\u{fffd}"})]
        );
    }
}
