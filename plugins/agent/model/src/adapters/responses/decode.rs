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

use super::Result;
use maka_agent_facts::model::{
    ModelEvent, ModelFinishReason, ModelSource, ModelToolCall, ModelUsage, PlaintextResponses,
    TextKind, ToolInput,
};
use maka_agent_facts::tools::ToolDefinition;
use maka_provider_protocol::{
    output::{Stop, TextKind as WireTextKind},
    responses::{self as wire, Event, ItemMetadata, PartMetadata},
};
use serde_json::{Value, json};

pub struct Decoder {
    inner: wire::decode::Decoder,
    plaintext: Option<PlaintextResponses>,
    pub observed_output: bool,
    pub replay_safe: bool,
}

impl Decoder {
    pub fn new(plaintext: Option<PlaintextResponses>, tools: &[ToolDefinition]) -> Self {
        let search_name = tools
            .iter()
            .find(|tool| {
                tool.provider.as_ref().is_some_and(|provider| {
                    matches!(
                        provider.id.as_str(),
                        "openai.web_search" | "openai.web_search_preview"
                    )
                })
            })
            .map(|tool| tool.name.clone());
        Self {
            inner: wire::decode::Decoder::new(
                super::request::reasoning_mode(plaintext),
                search_name,
            ),
            plaintext,
            observed_output: false,
            replay_safe: true,
        }
    }

    pub fn finished(&self) -> bool {
        self.inner.finished()
    }

    pub fn end(&self) -> Result<()> {
        self.inner.end().map_err(Into::into)
    }

    pub fn retained_output_safe(&self) -> bool {
        self.inner.retained_output_safe()
    }

    pub fn push(&mut self, value: Value) -> Result<Vec<ModelEvent>> {
        let events = self.inner.push(value);
        self.observed_output = self.inner.observed_output;
        self.replay_safe = self.inner.replay_safe;
        events.map_err(Into::into).map(|events| {
            events
                .into_iter()
                .map(|event| self.project(event))
                .collect()
        })
    }

    fn project(&self, event: Event) -> ModelEvent {
        match event {
            Event::ResponseMetadata {
                id,
                model,
                created_at_unix_seconds,
            } => ModelEvent::ResponseMetadata {
                id,
                model,
                timestamp: created_at_unix_seconds
                    .filter(|seconds| {
                        seconds.is_finite() && seconds.abs() <= 8_640_000_000_000.0
                    })
                    .and_then(|seconds| {
                        jiff::Timestamp::from_millisecond((seconds * 1000.0) as i64).ok()
                    })
                    .map(|value| format!("{value:.3}")),
            },
            Event::PartStarted { id, kind } => ModelEvent::PartStarted {
                id,
                text_kind: match kind {
                    WireTextKind::Text => TextKind::Text,
                    WireTextKind::Reasoning => TextKind::Thinking,
                },
                provider_options: None,
            },
            Event::PartDelta { id, text } => ModelEvent::PartDelta {
                id,
                text,
                provider_options: None,
            },
            Event::PartFinished { id, metadata } => ModelEvent::PartFinished {
                id,
                provider_options: metadata.map(|metadata| match metadata {
                    PartMetadata::Item(metadata) => item_options(metadata),
                    PartMetadata::PlaintextSummary {
                        item_id,
                        summary_part_lengths,
                    } => json!({
                        "makaResponses": {
                            "version": 1,
                            "profile": self.plaintext.expect("plaintext summary contract").profile(),
                            "itemId": item_id,
                            "summaryPartLengths": summary_part_lengths,
                        }
                    }),
                }),
            },
            Event::ToolInputStarted { id, name } => ModelEvent::ToolInputStarted {
                id,
                name: super::request::local_name(&name).into(),
                provider_executed: false,
            },
            Event::ToolInputDelta { id, text } => ModelEvent::ToolInputDelta { id, text },
            Event::ToolInputFinished { id } => ModelEvent::ToolInputFinished { id },
            Event::ToolCall {
                id,
                name,
                input,
                provider_executed,
                metadata,
            } => {
                let mut options = item_options(metadata);
                let input = match input {
                    wire::ToolInput::Function(input) => ToolInput::from_json(input),
                    wire::ToolInput::Custom(input) => {
                        options["openai"]["toolKind"] = json!("custom");
                        ToolInput::Json(json!(input))
                    }
                };
                ModelEvent::ToolCall(ModelToolCall {
                    id,
                    name: if provider_executed {
                        name
                    } else {
                        super::request::local_name(&name).into()
                    },
                    input,
                    provider_executed,
                    provider_options: Some(options),
                })
            }
            Event::ToolResult {
                id,
                name,
                action,
                is_error,
                metadata,
            } => ModelEvent::ProviderToolResult {
                id,
                name,
                output: json!({"action": action}),
                is_error,
                provider_options: Some(item_options(metadata)),
            },
            Event::Citation(citation) => ModelEvent::Source(ModelSource::Url {
                id: citation.id,
                url: citation.url,
                title: citation.title,
                provider_options: Some(json!({"openai": {
                    "startIndex": citation.start_index,
                    "endIndex": citation.end_index,
                }})),
            }),
            Event::Finished {
                reason,
                usage,
                response_id,
            } => ModelEvent::Finished {
                reason: match reason {
                    Stop::Stop => ModelFinishReason::Stop,
                    Stop::Length => ModelFinishReason::Length,
                    Stop::ToolCalls => ModelFinishReason::ToolCalls,
                    _ => unreachable!("Responses decoder finish reason"),
                },
                usage: ModelUsage {
                    input_tokens: usage.input,
                    output_tokens: usage.output,
                    cache_read_tokens: usage.cache_read,
                    cache_write_tokens: usage.cache_write,
                    reasoning_tokens: usage.reasoning,
                },
                provider_options: response_id.map(|id| json!({"openai": {"responseId": id}})),
            },
        }
    }
}

fn item_options(metadata: ItemMetadata) -> Value {
    let mut options = json!({"openai": {"itemId": metadata.id}});
    if let Some(replay) = metadata.replay {
        options["openai"]["responsesReplay"] = json!(replay);
    }
    if let Some(encrypted) = metadata.encrypted_content {
        options["openai"]["reasoningEncryptedContent"] = json!(encrypted);
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_summary_keeps_profile_identity_and_utf16_part_lengths() {
        let contract = PlaintextResponses {
            reasoning_replay: maka_agent_facts::model::PlaintextReasoningReplay::PlaintextSummary,
            compatibility: None,
        };
        let events = Decoder::new(Some(contract), &[])
            .push(json!({"type":"response.output_item.done","item":{
                "type":"reasoning","id":"reasoning-item",
                "summary":[
                    {"type":"summary_text","text":"A💡"},
                    {"type":"summary_text","text":"B"}
                ]
            }}))
            .unwrap();
        assert!(matches!(
            &events[0],
            ModelEvent::PartStarted {
                text_kind: TextKind::Thinking,
                ..
            }
        ));
        let ModelEvent::PartDelta { text, .. } = &events[1] else {
            panic!("missing summary text")
        };
        assert_eq!(text, "A💡B");
        let ModelEvent::PartFinished {
            provider_options, ..
        } = &events[2]
        else {
            panic!("missing summary metadata")
        };
        assert_eq!(
            provider_options,
            &Some(json!({"makaResponses":{
                "version":1,
                "profile":"plaintext-summary:standard",
                "itemId":"reasoning-item",
                "summaryPartLengths":[3,1]
            }}))
        );
    }

    #[test]
    fn function_arguments_and_true_custom_calls_keep_their_historical_kind() {
        use maka_agent_facts::model::prompt::{AssistantPart, Message, ToolOutput};
        let source = "text('same source');";
        let raw = " {\"n\":\n";
        let definitions = [ToolDefinition {
            name: "exec".into(),
            description: "JavaScript".into(),
            provider: None,
            input_schema: json!({"type":"object"}),
            output_schema: None,
            freeform: Some(maka_agent_facts::tools::FreeformGrammar::Lark {
                definition: "start: /[\\s\\S]+/".into(),
            }),
        }];
        let items = [
            json!({"type":"function_call","id":"f","call_id":"function","name":"exec","arguments":json!(source).to_string()}),
            json!({"type":"custom_tool_call","id":"c","call_id":"custom","name":"exec","input":source}),
            json!({"type":"function_call","id":"b","call_id":"broken","name":"exec","arguments":raw}),
            json!({"type":"function_call","id":"s","call_id":"string","name":"echo","arguments":"\"abc\""}),
        ];
        let mut decoder = Decoder::new(None, &definitions);
        let mut prompt = Vec::new();
        let mut calls = Vec::new();
        for item in items {
            let events = decoder
                .push(json!({"type":"response.output_item.done","item":item}))
                .unwrap();
            let ModelEvent::ToolCall(call) = &events[0] else {
                panic!("expected call")
            };
            calls.push(call.clone());
            prompt.push(Message::Assistant {
                content: vec![AssistantPart::ToolCall {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    input: call.input.clone(),
                    provider_executed: None,
                    provider_options: call.provider_options.clone(),
                }],
                provider_options: None,
            });
            let mut result = Message::tool(
                &call.id,
                &call.name,
                ToolOutput::ErrorText("refused".into()),
            );
            if call
                .provider_options
                .as_ref()
                .is_some_and(|options| options["openai"]["toolKind"] == "custom")
                && let Message::Tool { content, .. } = &mut result
            {
                content[0].provider_options = Some(json!({"openai":{"toolKind":"custom"}}));
            }
            prompt.push(result);
        }
        assert_eq!(calls[0].input, ToolInput::Json(json!(source)));
        assert_eq!(calls[1].input, ToolInput::Json(json!(source)));
        assert_eq!(calls[2].input, ToolInput::InvalidJson { raw: raw.into() });
        assert_eq!(calls[3].input, ToolInput::Json(json!("abc")));
        let options = json!({"openai":{"store":false}});
        let request = super::super::request::Request {
            language: maka_agent_facts::language::Language::En,
            model: "fixture",
            prompt: &prompt,
            tools: &definitions,
            options: &options,
            max_output_tokens: None,
            plaintext: None,
        };
        let encoded = request.encode().unwrap();
        assert_eq!(
            encoded["input"],
            json!([
                {"type":"function_call","id":"f","call_id":"function","name":"exec","arguments":json!(source).to_string()},
                {"type":"function_call_output","call_id":"function","output":"refused"},
                {"type":"custom_tool_call","id":"c","call_id":"custom","name":"exec","input":source},
                {"type":"custom_tool_call_output","call_id":"custom","output":"refused"},
                {"type":"function_call","id":"b","call_id":"broken","name":"exec","arguments":raw},
                {"type":"function_call_output","call_id":"broken","output":"refused"},
                {"type":"function_call","id":"s","call_id":"string","name":"echo","arguments":"\"abc\""},
                {"type":"function_call_output","call_id":"string","output":"refused"}
            ])
        );
        let fallback = super::super::request::Request {
            language: maka_agent_facts::language::Language::En,
            plaintext: Some(maka_agent_facts::model::PlaintextResponses {
                reasoning_replay:
                    maka_agent_facts::model::PlaintextReasoningReplay::PlaintextContent,
                compatibility: None,
            }),
            ..request
        }
        .encode()
        .unwrap();
        assert_eq!(fallback["input"][0]["arguments"], json!(source).to_string());
        assert_eq!(
            fallback["input"][2]["arguments"],
            json!({"code":source}).to_string()
        );
        assert_eq!(fallback["input"][4]["arguments"], raw);
        assert_eq!(fallback["input"][6]["arguments"], "\"abc\"");
    }

    #[test]
    fn repeated_call_ids_keep_each_historical_call_and_result_kind() {
        use maka_agent_facts::model::prompt::{AssistantPart, Message, ToolOutput};
        let raw = " {\"n\":\n";
        let source = "text('custom');";
        for custom_first in [true, false] {
            let mut prompt = Vec::new();
            let mut expected = Vec::new();
            for custom in [custom_first, !custom_first] {
                let item = if custom {
                    json!({"type":"custom_tool_call","id":"custom-item","call_id":"call","name":"exec","input":source})
                } else {
                    json!({"type":"function_call","id":"function-item","call_id":"call","name":"exec","arguments":raw})
                };
                // IDs are scoped to a model step, so each step has its own decoder.
                let events = Decoder::new(None, &[])
                    .push(json!({"type":"response.output_item.done","item":item}))
                    .unwrap();
                let ModelEvent::ToolCall(call) = &events[0] else {
                    panic!("expected call")
                };
                prompt.push(Message::Assistant {
                    content: vec![AssistantPart::ToolCall {
                        tool_call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        input: call.input.clone(),
                        provider_executed: None,
                        provider_options: call.provider_options.clone(),
                    }],
                    provider_options: None,
                });
                let mut result =
                    Message::tool("call", "exec", ToolOutput::ErrorText("refused".into()));
                if custom && let Message::Tool { content, .. } = &mut result {
                    content[0].provider_options = Some(json!({"openai":{"toolKind":"custom"}}));
                }
                prompt.push(result);
                expected.extend(if custom {
                    vec![json!({"type":"custom_tool_call","id":"custom-item","call_id":"call","name":"exec","input":source}),
                        json!({"type":"custom_tool_call_output","call_id":"call","output":"refused"})]
                } else {
                    vec![json!({"type":"function_call","id":"function-item","call_id":"call","name":"exec","arguments":raw}),
                        json!({"type":"function_call_output","call_id":"call","output":"refused"})]
                });
            }
            let options = json!({"openai":{"store":false}});
            let request = super::super::request::Request {
                language: maka_agent_facts::language::Language::En,
                model: "fixture",
                prompt: &prompt,
                tools: &[],
                options: &options,
                max_output_tokens: None,
                plaintext: None,
            };
            assert_eq!(request.encode().unwrap()["input"], json!(expected));
            let fallback = super::super::request::Request {
                language: maka_agent_facts::language::Language::En,
                plaintext: Some(maka_agent_facts::model::PlaintextResponses {
                    reasoning_replay:
                        maka_agent_facts::model::PlaintextReasoningReplay::PlaintextContent,
                    compatibility: None,
                }),
                ..request
            }
            .encode()
            .unwrap();
            for (index, custom) in [custom_first, !custom_first].into_iter().enumerate() {
                assert_eq!(
                    fallback["input"][index * 2],
                    json!({"type":"function_call","call_id":"call","name":"exec",
                    "arguments":if custom {json!({"code":source}).to_string()} else {raw.into()}})
                );
                assert_eq!(
                    fallback["input"][index * 2 + 1],
                    json!({"type":"function_call_output","call_id":"call","output":"refused"})
                );
            }
        }
    }
}
