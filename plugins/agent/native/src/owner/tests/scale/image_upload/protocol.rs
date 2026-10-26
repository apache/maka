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

use super::*;
use maka_agent_facts::configuration::{ApiProtocol, headers::*};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Protocol {
    Compatible,
    ChatCompletions,
    Anthropic,
    Responses,
}

#[derive(Clone, Copy)]
pub(super) struct Options {
    pub protocol: Protocol,
    pub retry: bool,
}

impl Options {
    pub const DEFAULT: Self = Self {
        protocol: Protocol::Compatible,
        retry: false,
    };
    pub fn environment() -> Self {
        let protocol = match std::env::var("MAKA_IMAGE_PROTOCOL")
            .as_deref()
            .unwrap_or("openai-compatible")
        {
            "openai-compatible" => Protocol::Compatible,
            "openai-chat-completions" => Protocol::ChatCompletions,
            "anthropic" => Protocol::Anthropic,
            "responses" => Protocol::Responses,
            _ => panic!("unknown MAKA_IMAGE_PROTOCOL"),
        };
        let retry =
            std::env::var("MAKA_IMAGE_RETRY").is_ok_and(|value| value.parse::<bool>().unwrap());
        assert!(
            !retry || protocol == Protocol::Compatible,
            "stream_options retry applies only to Compatible"
        );
        Self { protocol, retry }
    }
    pub fn customized(self) -> bool {
        self.protocol != Protocol::Compatible || self.retry
    }
    pub fn name(self) -> &'static str {
        match self.protocol {
            Protocol::Compatible => "openai-compatible",
            Protocol::ChatCompletions => "openai-chat-completions",
            Protocol::Anthropic => "anthropic",
            Protocol::Responses => "responses",
        }
    }
    pub fn provider(self) -> &'static str {
        match self.protocol {
            Protocol::Compatible => "openai-compatible",
            Protocol::ChatCompletions => "openai",
            Protocol::Anthropic => "anthropic",
            Protocol::Responses => "openai-responses-compatible",
        }
    }
    pub async fn configure(self, fixture: &Fixture) {
        if !self.customized() {
            images::enable_vision(fixture).await;
            return;
        }
        selection::edit(fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([(
                "fixture-model".into(),
                ModelOverride {
                    vision: Some(true),
                    api_protocol: Some(match self.protocol {
                        Protocol::Anthropic => ApiProtocol::AnthropicMessages,
                        Protocol::Responses => ApiProtocol::OpenaiResponses,
                        _ => ApiProtocol::OpenaiChatCompletions,
                    }),
                    ..Default::default()
                },
            )]));
            // temperature is an absent SDK option, not a generated value to replace.
            changes.request_body_overlay = Patch::Set(
                json!({"temperature":0.25,"k49_fixture":{"marker":"original images 中"}}),
            );
        })
        .await;
        let row = fixture
            .config
            .catalog()
            .await
            .unwrap()
            .connections
            .remove(0);
        let RequestHeadersQueryResult::Found { basis, .. } = fixture
            .config
            .request_headers(row.connection_id)
            .await
            .unwrap()
        else {
            panic!("header basis")
        };
        assert!(matches!(
            fixture
                .config
                .replace_request_headers(
                    RequestHeadersReplace {
                        expected: basis,
                        headers: vec![RequestHeaderUpdate {
                            name: "x-maka-image-fixture".into(),
                            value: Some("original-images".into())
                        }],
                    },
                    now()
                )
                .await
                .unwrap(),
            RequestHeadersReplaceResult::Committed { .. }
        ));
    }
    pub fn parts(self, sent: &Value) -> Vec<&Value> {
        let messages = if self.protocol == Protocol::Responses {
            &sent["input"]
        } else {
            &sent["messages"]
        };
        messages
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_array())
            .flatten()
            .collect()
    }
    pub fn image(self, part: &Value) -> Option<&str> {
        match self.protocol {
            Protocol::Compatible | Protocol::ChatCompletions if part["type"] == "image_url" => {
                Some(
                    part["image_url"]["url"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("data:image/png;base64,")
                        .expect("structured PNG image"),
                )
            }
            Protocol::Anthropic if part["type"] == "image" => {
                assert_eq!(part["source"]["type"], "base64");
                assert_eq!(part["source"]["media_type"], "image/png");
                Some(part["source"]["data"].as_str().unwrap())
            }
            Protocol::Responses if part["type"] == "input_image" => Some(
                part["image_url"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("data:image/png;base64,")
                    .expect("Responses structured PNG image"),
            ),
            _ => None,
        }
    }
    // Local reader adds protocol-specific auth and explicit custom-header proof;
    // no request body is logged, and body bytes are parsed directly as JSON.
    pub async fn request(self, socket: &mut TcpStream) -> Value {
        let (headers, sent) = crate::owner::tests::http_fixture::read_request(socket).await;
        let header = |name: &str| {
            headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.trim())
        };
        let path = match self.protocol {
            Protocol::Anthropic => "/v1/messages",
            Protocol::Responses => "/v1/responses",
            _ => "/v1/chat/completions",
        };
        assert!(
            headers
                .lines()
                .next()
                .unwrap()
                .starts_with(&format!("POST {path} ")),
            "actual protocol endpoint"
        );
        if self.protocol == Protocol::Anthropic {
            assert_eq!(header("x-api-key"), Some("private-fixture-key"));
            assert_eq!(header("anthropic-version"), Some("2023-06-01"));
        } else {
            assert_eq!(header("authorization"), Some("Bearer private-fixture-key"));
        }
        if self.customized() {
            assert_eq!(header("x-maka-image-fixture"), Some("original-images"));
        }
        if self.customized() {
            assert_eq!(sent["temperature"], 0.25);
            assert_eq!(sent["k49_fixture"], json!({"marker":"original images 中"}));
        }
        sent
    }
    pub async fn reject_stream_options(self, socket: &mut TcpStream) {
        let body = r#"{"error":{"message":"stream_options is not supported","type":"invalid_request_error","param":"stream_options"}}"#;
        socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    }
    pub async fn response(self, socket: &mut TcpStream) {
        if self.protocol == Protocol::Compatible {
            response_with_text(socket, ANSWER).await;
            return;
        }
        let events = match self.protocol {
            Protocol::ChatCompletions => vec![
                json!({"id":"image-reply","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":ANSWER},"finish_reason":null}]}),
                json!({"id":"image-reply","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}),
            ],
            Protocol::Anthropic => vec![
                json!({"type":"message_start","message":{"id":"image-reply","type":"message","role":"assistant","model":"fixture-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":ANSWER}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}),
                json!({"type":"message_stop"}),
            ],
            Protocol::Responses => vec![
                json!({"type":"response.created","response":{"id":"resp_image","created_at":1,"model":"fixture-model"}}),
                json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_image","role":"assistant","content":[]}}),
                json!({"type":"response.output_text.delta","item_id":"msg_image","output_index":0,"content_index":0,"delta":ANSWER}),
                json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_image","role":"assistant","content":[{"type":"output_text","text":ANSWER,"annotations":[]}]}}),
                json!({"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}}),
            ],
            Protocol::Compatible => unreachable!(),
        };
        let mut body = String::new();
        for event in events {
            if let Some(kind) = event["type"].as_str() {
                body.push_str(&format!("event: {kind}\n"));
            }
            body.push_str(&format!("data: {event}\n\n"));
        }
        if self.protocol == Protocol::ChatCompletions {
            body.push_str("data: [DONE]\n\n");
        }
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    }
}
