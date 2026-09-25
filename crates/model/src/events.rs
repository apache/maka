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

use crate::ModelError;
use maka_runtime::model::{ModelEvent, ModelFinishReason, ModelToolCall, ModelUsage, TextKind};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(crate) fn invalid(message: impl Into<String>) -> ModelError {
    ModelError::Adapter(message.into())
}
pub(crate) use maka_runtime::model::merge_provider_options as merge;
fn string(value: &Value, key: &str) -> Result<String, ModelError> {
    value[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("missing or invalid {key}")))
}
fn metadata(value: &Value) -> Result<Option<Value>, ModelError> {
    match value.get("providerMetadata") {
        None | Some(Value::Null) => Ok(None),
        Some(v) if v.is_object() => Ok(Some(v.clone())),
        _ => Err(invalid("invalid provider metadata")),
    }
}
fn optional_bool(value: &Value, key: &str) -> Result<bool, ModelError> {
    // SDK flags are optional booleans; serde_v8 omits undefined object fields.
    match value.get(key) {
        None => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        _ => Err(invalid(format!("invalid {key}"))),
    }
}
#[derive(Default)]
pub(crate) struct Normalizer {
    open: HashMap<String, TextKind>,
    seen: HashSet<String>,
    tool_input: HashMap<String, Option<Value>>,
    finished: bool,
}
impl Normalizer {
    pub fn end(&self) -> Result<(), ModelError> {
        if self.finished {
            Ok(())
        } else {
            Err(invalid("model stream ended without finish"))
        }
    }
    pub fn push(&mut self, value: Value) -> Result<Option<ModelEvent>, ModelError> {
        if self.finished {
            return Err(invalid("event after model finish"));
        }
        let kind = string(&value, "type")?;
        let options = metadata(&value)?;
        let event = match kind.as_str() {
            "text-start" | "reasoning-start" => {
                let id = string(&value, "id")?;
                if !self.seen.insert(id.clone()) {
                    return Err(invalid("duplicate part id"));
                }
                let text_kind = if kind == "text-start" {
                    TextKind::Text
                } else {
                    TextKind::Thinking
                };
                self.open.insert(id.clone(), text_kind);
                ModelEvent::PartStarted {
                    id,
                    text_kind,
                    provider_options: options,
                }
            }
            "text-delta" | "reasoning-delta" | "text-end" | "reasoning-end" => {
                let id = string(&value, "id")?;
                let expected = if kind.starts_with("text") {
                    TextKind::Text
                } else {
                    TextKind::Thinking
                };
                if self.open.get(&id) != Some(&expected) {
                    return Err(invalid("unknown or mismatched text part"));
                }
                if kind.ends_with("delta") {
                    ModelEvent::PartDelta {
                        id,
                        text: string(&value, "delta")?,
                        provider_options: options,
                    }
                } else {
                    self.open.remove(&id);
                    ModelEvent::PartFinished {
                        id,
                        provider_options: options,
                    }
                }
            }
            "tool-input-start" => {
                let id = string(&value, "id")?;
                if self.tool_input.insert(id, options).is_some() {
                    return Err(invalid("duplicate tool input"));
                }
                return Ok(None);
            }
            "tool-input-delta" | "tool-input-end" => {
                let id = string(&value, "id")?;
                let pending = self
                    .tool_input
                    .get_mut(&id)
                    .ok_or_else(|| invalid("unknown tool input"))?;
                merge(pending, options);
                return Ok(None);
            }
            "tool-call" => {
                let provider_executed = optional_bool(&value, "providerExecuted")?;
                let id = string(&value, "toolCallId")?;
                let mut provider_options = self.tool_input.remove(&id).flatten();
                merge(&mut provider_options, options);
                ModelEvent::ToolCall(ModelToolCall {
                    id,
                    name: string(&value, "toolName")?,
                    input: serde_json::from_str(&string(&value, "input")?)
                        .map_err(|_| invalid("invalid tool call JSON"))?,
                    provider_options,
                    provider_executed,
                })
            }
            "source" => {
                use maka_runtime::model::ModelSource;
                let source = match string(&value, "sourceType")?.as_str() {
                    "url" => ModelSource::Url {
                        id: string(&value, "id")?,
                        url: string(&value, "url")?,
                        title: value["title"].as_str().map(str::to_owned),
                        provider_options: options,
                    },
                    "document" => ModelSource::Document {
                        id: string(&value, "id")?,
                        media_type: string(&value, "mediaType")?,
                        title: string(&value, "title")?,
                        filename: value["filename"].as_str().map(str::to_owned),
                        provider_options: options,
                    },
                    _ => return Err(invalid("unsupported model source kind")),
                };
                ModelEvent::Source(source)
            }
            "tool-result" => {
                if optional_bool(&value, "preliminary")? {
                    return Err(invalid("unsupported preliminary provider tool-result"));
                }
                ModelEvent::ProviderToolResult {
                    id: string(&value, "toolCallId")?,
                    name: string(&value, "toolName")?,
                    output: value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| invalid("missing tool result"))?,
                    is_error: optional_bool(&value, "isError")?,
                    provider_options: options,
                }
            }
            "response-metadata" => ModelEvent::ResponseMetadata {
                id: value["id"].as_str().map(str::to_owned),
                model: value["modelId"].as_str().map(str::to_owned),
                timestamp: value["timestamp"].as_str().map(str::to_owned),
            },
            "finish" => {
                if !self.open.is_empty() || !self.tool_input.is_empty() {
                    return Err(invalid("finish with incomplete model parts"));
                }
                let reason = if value["finishReason"]["raw"] == "model_context_window_exceeded" {
                    "length".to_owned()
                } else {
                    string(&value["finishReason"], "unified")?
                };
                let reason = match reason.as_str() {
                    "stop" => ModelFinishReason::Stop,
                    "tool-calls" => ModelFinishReason::ToolCalls,
                    "length" => ModelFinishReason::Length,
                    _ => return Err(invalid(format!("model did not complete: {reason}"))),
                };
                let usage = &value["usage"];
                if !usage.is_object() {
                    return Err(invalid("missing model usage"));
                }
                let count = |group: &str, key: &str| -> Result<Option<u64>, ModelError> {
                    match &usage[group][key] {
                        Value::Null => Ok(None),
                        v => v
                            .as_u64()
                            .map(Some)
                            .ok_or_else(|| invalid("invalid token usage")),
                    }
                };
                let usage = ModelUsage {
                    input_tokens: count("inputTokens", "total")?,
                    output_tokens: count("outputTokens", "total")?,
                    cache_read_tokens: count("inputTokens", "cacheRead")?,
                    cache_write_tokens: count("inputTokens", "cacheWrite")?,
                    reasoning_tokens: count("outputTokens", "reasoning")?,
                };
                self.finished = true;
                ModelEvent::Finished {
                    reason,
                    usage,
                    provider_options: options,
                }
            }
            // Transport diagnostics carry no generated or replayable model content.
            "stream-start" | "raw" => return Ok(None),
            "error" => {
                #[derive(serde::Deserialize)]
                #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
                enum Failure {
                    ContextOverflow {
                        #[serde(rename = "observedOutput")]
                        observed_output: bool,
                    },
                    Provider(crate::ProviderFailure),
                }
                let failure = serde_json::from_value(value["error"].clone())
                    .map_err(|_| invalid("invalid provider error envelope"))?;
                return Err(match failure {
                    Failure::ContextOverflow { observed_output } => {
                        ModelError::ContextOverflow { observed_output }
                    }
                    Failure::Provider(failure) => {
                        failure.validate()?;
                        ModelError::Provider(failure)
                    }
                });
            }
            _ => return Err(invalid(format!("unsupported provider event: {kind}"))),
        };
        Ok(Some(event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_error_requires_exact_kind_and_boolean() {
        use serde_json::json;
        for value in [
            json!(null),
            json!({"kind":"context_overflow"}),
            json!({"kind":"context_overflow","observedOutput":"false"}),
            json!({"kind":"unknown","observedOutput":false}),
            json!({"kind":"context_overflow","observedOutput":false,"extra":true}),
        ] {
            assert!(matches!(
                Normalizer::default().push(json!({"type":"error","error":value})),
                Err(ModelError::Adapter(_))
            ));
        }
        for observed in [false, true] {
            assert!(
                matches!(Normalizer::default().push(json!({"type":"error","error":{"kind":"context_overflow","observedOutput":observed}})),Err(ModelError::ContextOverflow{observed_output}) if observed_output == observed)
            );
        }
    }
    use serde_json::json;

    fn tool(kind: &str) -> Value {
        json!({"type": kind, "toolCallId": "call", "toolName": "tool",
            "input": "{}", "result": {}})
    }

    #[test]
    fn malformed_flags_cannot_become_local_calls_or_successful_results() {
        for (kind, flag) in [
            ("tool-call", "providerExecuted"),
            ("tool-result", "isError"),
            ("tool-result", "preliminary"),
        ] {
            for malformed in [json!(null), json!("false"), json!(0), json!({}), json!([])] {
                let mut event = tool(kind);
                event[flag] = malformed;
                assert!(Normalizer::default().push(event).is_err(), "{flag}");
            }
        }
    }

    #[test]
    fn optional_flags_preserve_sdk_defaults_and_true_values() {
        for flag in [None, Some(false), Some(true)] {
            let mut call = tool("tool-call");
            let mut result = tool("tool-result");
            if let Some(flag) = flag {
                call["providerExecuted"] = json!(flag);
                result["isError"] = json!(flag);
                result["preliminary"] = json!(false);
            }
            let Some(ModelEvent::ToolCall(call)) = Normalizer::default().push(call).unwrap() else {
                panic!("expected tool call");
            };
            assert_eq!(call.provider_executed, flag.unwrap_or(false));
            let Some(ModelEvent::ProviderToolResult { is_error, .. }) =
                Normalizer::default().push(result).unwrap()
            else {
                panic!("expected provider result");
            };
            assert_eq!(is_error, flag.unwrap_or(false));
        }
        let mut result = tool("tool-result");
        result["preliminary"] = json!(true);
        assert!(Normalizer::default().push(result).is_err());
    }

    #[test]
    fn rejected_usage_does_not_finish_stream() {
        let valid = json!({"type": "finish", "finishReason": {"unified": "stop"},
            "usage": {"inputTokens": {"total": 1, "cacheRead": 0, "cacheWrite": 0},
                "outputTokens": {"total": 2, "reasoning": 1}}});
        for (group, key) in [
            ("inputTokens", "total"),
            ("outputTokens", "total"),
            ("inputTokens", "cacheRead"),
            ("inputTokens", "cacheWrite"),
            ("outputTokens", "reasoning"),
        ] {
            for malformed in [json!(-1), json!(1.5), json!("2")] {
                let mut normalizer = Normalizer::default();
                let mut event = valid.clone();
                event["usage"][group][key] = malformed;
                assert!(normalizer.push(event).is_err());
                assert!(normalizer.end().is_err());
                assert!(normalizer.push(valid.clone()).is_ok());
                assert!(normalizer.end().is_ok());
            }
        }
    }

    #[test]
    fn provider_replay_evidence_survives_filtering_and_rejects_malformed_envelopes() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/provider-errors.mjs");
        let output = std::process::Command::new("node")
            .arg(fixture)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let events: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(events.len(), 7);
        for (index, event) in events.iter().enumerate() {
            let Err(ModelError::Provider(failure)) = Normalizer::default().push(event.clone())
            else {
                panic!("lost provider failure evidence");
            };
            assert_eq!(failure.replay_safe(), index < 3);
            assert_eq!(
                failure.reason(),
                crate::ProviderFailureReason::ProviderUnavailable
            );
        }
        for (field, value) in [
            ("replaySafe", json!("true")),
            ("retryAfterMs", json!(2_147_483_648u64)),
            ("reason", json!("unknown")),
        ] {
            let mut event = events[0].clone();
            event["error"][field] = value;
            assert!(matches!(
                Normalizer::default().push(event),
                Err(ModelError::Adapter(_))
            ));
        }
    }
}
