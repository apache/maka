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

use maka_model::{
    ModelEvent, ModelExecutor, ModelRequest, ProviderConfig, ProviderKind, StepBuilder,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
mod prepared;
pub(super) use prepared::prepare_input;

pub(super) fn request(kind: ProviderKind, base_url: String) -> ModelRequest {
    ModelRequest {
        language: maka_agent_facts::language::Language::En,
        provider: ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            kind,
            model: "test-model".into(),
            base_url,
            auth: maka_model::ProviderAuth::ApiKey("local-test-key".into()),
            headers: BTreeMap::new(),
            network: Default::default(),
            body_overlay: None,
        },
        prompt: vec![maka_model::prompt::Message::user("hello")].into(),
        tools: vec![maka_model::ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: "echo".into(),
            description: "echo".into(),
            input_schema: json!({"type":"object","properties":{}}),
        }],
        provider_options: json!({}),
        max_output_tokens: Some(128),
    }
}

pub(super) async fn read_request(socket: &mut TcpStream) -> String {
    let (mut head, bytes) = crate::http_request(socket).await;
    head.push_str(std::str::from_utf8(&bytes).unwrap());
    head
}

fn sse(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| format!("data: {value}\n\n"))
        .collect()
}

fn fixtures(kind: ProviderKind, text: &str) -> (String, String) {
    match kind {
        ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. } => (
            sse(&[
                json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]}),
            ]),
            sse(&[
                json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":null}]}),
                json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}),
            ]) + "data: [DONE]\n\n",
        ),
        ProviderKind::Anthropic => (
            sse(&[
                json!({"type":"message_start","message":{"id":"reply","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":0}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
            ]),
            sse(&[
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"echo","input":{}}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
                json!({"type":"content_block_stop","index":1}),
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}),
                json!({"type":"message_stop"}),
            ]),
        ),
        ProviderKind::OpenaiResponses | ProviderKind::OpenResponses(_) => {
            unreachable!("separate fixtures required")
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_native_requests_have_no_artificial_body_size_cap() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for large in [true, false] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                assert_eq!(request.len() > 32 * 1024 * 1024, large);
                let (first, last) = fixtures(ProviderKind::OpenaiChatCompletions, "large request accepted");
                let body = first + &last;
                socket.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()
                ).as_bytes()).await.unwrap();
            }
        });
        let models = ModelExecutor::new(Duration::from_secs(20)).unwrap();
        for large in [true, false] {
            let mut input = request(ProviderKind::OpenaiChatCompletions, base.clone());
            if large {
                input.prompt = vec![maka_model::prompt::Message::user("x".repeat(33 * 1024 * 1024))].into();
            }
            let mut stream = models.stream(input, CancellationToken::new()).await.unwrap();
            let mut output = StepBuilder::for_step("large-adapter-request").unwrap();
            while let Some(event) = stream.next().await { output.push(event.unwrap().event).unwrap(); }
            assert!(serde_json::to_string(&output.finish().unwrap()).unwrap().contains("large request accepted"));
            stream.cancel_and_wait().await.expect("actual stream cleanup");
        }
        server.await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_text_and_tool_streams_cross_real_http_before_response_finishes() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(Duration::from_secs(15)).unwrap();
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiCompatible { name: "fixture".into() }, ProviderKind::Anthropic] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let gate = Arc::new(Notify::new());
            let release = gate.clone();
            let expected_text = "hello😀".repeat(2048);
            let (first, last) = fixtures(kind.clone(), &expected_text);
            let keep_open = matches!(kind, ProviderKind::Anthropic);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                let length = if keep_open {
                    String::new()
                } else {
                    format!("Content-Length: {}\r\n", first.len() + last.len())
                };
                let header = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n{length}Connection: close\r\nX-Latin-1: ÿ\r\n\r\n");
                let header: Vec<u8> = header.chars().map(|ch| u8::try_from(ch).unwrap()).collect();
                socket.write_all(&header).await.unwrap();
                socket.write_all(first.as_bytes()).await.unwrap();
                release.notified().await;
                socket.write_all(last.as_bytes()).await.unwrap();
                if keep_open {
                    let mut byte = [0];
                    let closed = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
                        .await
                        .expect("provider finish must release HTTP without waiting for idle timeout")
                        .unwrap();
                    assert_eq!(closed, 0);
                }
                request
            });
            let mut customized = request(kind.clone(), base);
            customized.max_output_tokens = Some(10_000_000_000);
            customized.provider.body_overlay = Some(serde_json::Map::from_iter([
                ("fixture_context".into(), json!({"route":"customized","text":"中文😀\0\"\\\n","values":[null,true,-1,0.25]})),
                // Optional fields may be absent on the provider wire.
                ("temperature".into(), json!(0.25)),
            ]));
            customized.provider.headers.insert("X-Custom-Route".into(), "local-route".into());
            customized.provider.headers.insert("X-Latin-1".into(), "ÿ".into());
            if matches!(kind, ProviderKind::Anthropic) {
                customized.provider.headers.insert("Anthropic-Version".into(), "2023-06-01".into());
                crate::edit_prompt(&mut customized.prompt, |messages| messages.push(serde_json::from_value(json!({"role":"user","content":[{"type":"file","mediaType":"audio/wav","data":{"type":"data","data":"YXVkaW8="}}]})).unwrap()));
            }
            let mut stream = executor.stream(customized, CancellationToken::new()).await.unwrap();
            let mut events = Vec::new();
            let mut observed_text = String::new();
            let mut builder = StepBuilder::default();
            while let Some(event) = stream.next().await {
                let event = event.unwrap().event;
                if let ModelEvent::PartDelta { text, .. } = &event {
                    assert!(text.len() <= 8 * 1024);
                    observed_text.push_str(text);
                    gate.notify_one();
                }
                builder.push(event.clone()).unwrap();
                events.push(event);
            }
            assert!(events.iter().any(|event| matches!(event, ModelEvent::PartDelta { .. })));
            let step = builder.finish().unwrap();
            assert_eq!(observed_text, expected_text);
            assert!(step.parts.iter().any(|part| matches!(part,
                maka_agent_facts::model::ModelPart::Text { text, .. } if text == &expected_text)));
            let tool = step.tool_calls().next().expect("tool call");
            assert_eq!(tool.id, "tool-1");
            assert_eq!(tool.name, "echo");
            assert_eq!(tool.input, maka_agent_facts::model::ToolInput::Json(json!({})));
assert_eq!(step.finish_reason, maka_agent_facts::model::ModelFinishReason::ToolCalls);
            assert_eq!(step.usage.input_tokens, Some(2));
            assert_eq!(step.usage.output_tokens, Some(3));
            assert!(matches!(events.last(), Some(ModelEvent::Finished { .. })));
            let wire = server.await.unwrap();
            assert!(wire.contains("local-test-key"));
            assert!(wire.to_ascii_lowercase().contains("\r\nx-custom-route: local-route\r\n"));
            assert!(wire.to_ascii_lowercase().contains("\r\nx-latin-1: ÿ\r\n"));
            let body: Value = serde_json::from_str(wire.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body["model"], "test-model");
            assert_eq!(body["stream"], true);
            assert_eq!(body["max_tokens"], 10_000_000_000u64);
            assert_eq!(body["fixture_context"], json!({"route":"customized","text":"中文😀\0\"\\\n","values":[null,true,-1,0.25]}));
            assert_eq!(body["temperature"], 0.25);
            if matches!(kind, ProviderKind::Anthropic) {
                assert!(body["messages"].to_string().contains("not supported by this model adapter"));
                assert!(!body["messages"].to_string().contains("YXVkaW8="));
            }
        }
    }).await.expect("provider stream must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_tool_argument_prefix_is_observed_before_completion_and_chunked_at_utf8_boundaries()
{
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(Duration::from_secs(15)).unwrap();
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiCompatible { name: "fixture".into() }, ProviderKind::Anthropic] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let gate = Arc::new(Notify::new());
            let release = gate.clone();
            let path = format!("src/{}文", "中😀".repeat(1800));
            let prefix = format!("{{\"path\":\"src/{}", "中😀".repeat(1800));
            let suffix = "文\"}";
            let (first, last) = match &kind {
                ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. } => (
                    sse(&[json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"name":"echo","arguments":prefix}}]},"finish_reason":null}]})]),
                    sse(&[
                        json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":suffix}}]},"finish_reason":null}]}),
                        json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}),
                    ]) + "data: [DONE]\n\n",
                ),
                ProviderKind::Anthropic => (
                    sse(&[
                        json!({"type":"message_start","message":{"id":"reply","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":0}}}),
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"echo","input":{}}}),
                        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":prefix}}),
                    ]),
                    sse(&[
                        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":suffix}}),
                        json!({"type":"content_block_stop","index":0}),
                        json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}),
                        json!({"type":"message_stop"}),
                    ]),
                ),
                _ => unreachable!("native Responses has its own stream test"),
            };
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{first}", first.len() + last.len()).as_bytes()).await.unwrap();
                release.notified().await;
                socket.write_all(last.as_bytes()).await.unwrap();
            });
            let mut stream = executor.stream(request(kind, base), CancellationToken::new()).await.unwrap();
            let mut builder = StepBuilder::for_step("arguments").unwrap();
            let mut observed = String::new();
            let mut started = false;
            let mut finished = false;
            let mut released = false;
            while let Some(event) = stream.next().await {
                let event = event.unwrap().event;
                match &event {
                    ModelEvent::ToolInputStarted { id, name, provider_executed } => {
                        assert!(!started);
                        assert_eq!(id, "tool-1");
                        assert_eq!(name, "echo");
                        assert!(!provider_executed);
                        started = true;
                    }
                    ModelEvent::ToolInputDelta { id, text } => {
                        assert_eq!(id, "tool-1");
                        assert!(started && !finished);
                        assert!(text.len() <= 8 * 1024);
                        observed.push_str(text);
                    }
                    ModelEvent::ToolInputFinished { id } => {
                        assert_eq!(id, "tool-1");
                        assert!(released && !finished);
                        finished = true;
                    }
                    ModelEvent::ToolCall(_) => assert!(released && finished),
                    _ => {}
                }
                builder.push(event).unwrap();
                if !released && observed == prefix {
                    assert!(started);
                    assert!(builder.accepted_item().is_none());
                    assert_eq!(builder.accepted_parts().count(), 0);
                    released = true;
                    gate.notify_one();
                }
            }
            assert!(released && finished);
            assert_eq!(observed, format!("{prefix}{suffix}"));
            let step = builder.finish().unwrap();
            assert_eq!(step.parts.len(), 1);
            let call = step.tool_calls().next().unwrap();
            assert_eq!(call.id, "tool-1");
            assert_eq!(call.input, maka_agent_facts::model::ToolInput::Json(json!({"path":path})));
            stream.cancel_and_wait().await.expect("actual stream cleanup");
            server.await.unwrap();
        }
    }).await.expect("tool prefix must cross actual HTTP before the server releases final arguments");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_tool_media_follow_the_complete_parallel_result_group_on_the_wire() {
    use maka_model::prompt::{AssistantPart, ContentPart, FileData, Message, ToolOutput};

    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        for (kind, mime) in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiCompatible { name: "fixture".into() }].into_iter().flat_map(|kind| ["image/png", "audio/wav"].map(|mime| (kind.clone(), mime))) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let wire = read_request(&mut socket).await;
                let (first, last) = fixtures(ProviderKind::OpenaiChatCompletions, "seen");
                let body = first + &last;
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                serde_json::from_str::<Value>(wire.split_once("\r\n\r\n").unwrap().1).unwrap()
            });
            let append_user = matches!(kind, ProviderKind::OpenaiChatCompletions);
            let mut input = request(kind, base);
            crate::edit_prompt(&mut input.prompt, |messages| messages.push(Message::Assistant {
                content: ["first", "second"].into_iter().map(|id| AssistantPart::ToolCall {
                    tool_call_id: id.into(), tool_name: "echo".into(), input: maka_agent_facts::model::ToolInput::Json(json!({})),
                    provider_executed: None, provider_options: None,
                }).collect(),
                provider_options: None,
            }));
            for id in ["first", "second"] {
                crate::edit_prompt(&mut input.prompt, |messages| messages.push(Message::tool(id, "echo", ToolOutput::Content(vec![
                    ContentPart::text(format!("result-{id}")),
                    ContentPart::File { data: FileData::Data("aW1hZ2U=".into()), media_type: mime.into(), provider_options: None },
                ]))));
            }
            if append_user { crate::edit_prompt(&mut input.prompt, |messages| messages.push(Message::user("compare these images"))); }
            let mut stream = executor.stream(input, CancellationToken::new()).await.unwrap();
            while let Some(event) = stream.next().await { event.unwrap(); }
            let body = server.await.unwrap();
            let messages = body["messages"].as_array().unwrap();
            let mut roles = vec!["user", "assistant", "tool", "tool", "user"];
            if append_user { roles.push("user"); }
            assert_eq!(messages.iter().map(|message| message["role"].as_str().unwrap()).collect::<Vec<_>>(), roles);
            for (index, id) in [(2, "first"), (3, "second")] {
                assert_eq!(messages[index]["tool_call_id"], id);
                let text = messages[index]["content"].as_str().unwrap();
                assert!(text.contains(&format!("result-{id}")));
                assert!(!text.contains("aW1hZ2U="));
                assert!(!text.contains("image/png"));
            }
            let images = messages[4]["content"].as_array().unwrap();
            assert_eq!(images.len(), 4);
            for (index, id) in [(0, "first"), (2, "second")] {
                assert_eq!(images[index]["text"], format!("{} from tool echo ({id}):", if mime.starts_with("audio/") { "Audio" } else { "Image" }));
                if mime.starts_with("audio/") {
                    assert_eq!(images[index + 1], json!({"type":"input_audio","input_audio":{"data":"aW1hZ2U=","format":"wav"}}));
                } else {
                    assert_eq!(images[index + 1]["type"], "image_url");
                    assert_eq!(images[index + 1]["image_url"]["url"], "data:image/png;base64,aW1hZ2U=");
                }
            }
        }
    }).await.expect("Chat image projection must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_tool_deltas_keep_arguments_separate_when_gateways_omit_or_reuse_ids() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let cases = [
            vec![
                json!({"type":"function","function":{"name":"echo","arguments":"{\"value\":"}}),
                json!({"function":{"arguments":"\"first\"}"}}),
                json!({"id":" ","type":"function","function":{"name":"echo","arguments":"{\"value\":\"second\"}"}}),
            ],
            vec![
                json!({"index":1,"id":"shared","type":"function","function":{"name":"echo","arguments":"{\"value\":"}}),
                json!({"index":0,"id":"shared","type":"function","function":{"name":"echo","arguments":"{\"value\":"}}),
                json!({"index":0,"function":{"arguments":"\"first\"}"}}),
                json!({"index":1,"function":{"arguments":"\"second\"}"}}),
            ],
            vec![
                json!({"index":0,"id":"first","type":"function","function":{"name":"echo","arguments":"{\"value\":"}}),
                json!({"index":0,"id":"second","type":"function","function":{"name":"echo","arguments":"{\"value\":"}}),
                json!({"index":0,"id":"first","function":{"arguments":"\"first\"}"}}),
                json!({"index":0,"id":"second","function":{"arguments":"\"second\"}"}}),
            ],
        ];
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiCompatible { name: "fixture".into() }] {
            for deltas in &cases {
                // OpenAI requires indices; compatible gateways may omit them.
                if matches!(kind, ProviderKind::OpenaiChatCompletions) && deltas.iter().any(|delta| delta.get("index").is_none()) {
                    continue;
                }
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}/v1", listener.local_addr().unwrap());
                let mut chunks: Vec<_> = deltas.iter().map(|delta| json!({"id":"reply","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[delta]},"finish_reason":null}]})).collect();
                chunks.push(json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}));
                let body = sse(&chunks) + "data: [DONE]\n\n";
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    read_request(&mut socket).await;
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                });
                let mut stream = executor.stream(request(kind.clone(), base), CancellationToken::new()).await.unwrap();
                let mut builder = StepBuilder::default();
                while let Some(event) = stream.next().await {
                    builder.push(event.unwrap().event).unwrap();
                }
                stream.cancel_and_wait().await.expect("actual stream cleanup");
                let step = builder.finish().unwrap();
                let calls: Vec<_> = step.tool_calls().collect();
                assert_eq!(calls.len(), 2, "{kind:?}: {deltas:?}");
                assert_ne!(calls[0].id, calls[1].id);
                assert!(calls.iter().all(|call| !call.id.trim().is_empty() && call.name == "echo"));
                let mut values: Vec<_> = calls.iter().map(|call| call.input.as_json().unwrap()["value"].as_str().unwrap()).collect();
                values.sort_unstable();
                assert_eq!(values, ["first", "second"], "{kind:?}: {deltas:?}");
                assert_eq!(step.finish_reason, maka_agent_facts::model::ModelFinishReason::ToolCalls);
                server.await.unwrap();
            }
        }
    }).await.expect("gateway tool streams must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_provider_tool_identities_preserve_original_values_over_http() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(Duration::from_secs(15)).unwrap();
        for (id, name) in [("x".repeat(4092), "echo".into()), ("tool-1".into(), "é".repeat(129))] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let (first, last) = fixtures(ProviderKind::OpenaiChatCompletions, "hello");
            let body = first + &last.replace("tool-1", &id).replace("echo", &name);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                let header = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(body.as_bytes()).await.unwrap();
            });
            let mut stream = executor.stream(
                request(ProviderKind::OpenaiChatCompletions, base), CancellationToken::new(),
            ).await.unwrap();
            let mut builder = StepBuilder::for_step("step").unwrap();
            let mut starts = Vec::new();
            while let Some(event) = stream.next().await {
                let event = event.expect("complete provider identities must survive the adapter").event;
                if let ModelEvent::ToolInputStarted { id, name, .. } = &event {
                    starts.push((id.clone(), name.clone()));
                }
                builder.push(event).unwrap();
            }
            stream.cancel_and_wait().await.expect("actual stream cleanup");
            server.await.unwrap();
            assert_eq!(starts, [(id.clone(), name.clone())]);
            let step = builder.finish().unwrap();
            let calls: Vec<_> = step.tool_calls().collect();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].id, id);
            assert_eq!(calls[0].name, name);
            assert_eq!(calls[0].input.as_json().unwrap(), &json!({}));
            assert_eq!(step.finish_reason, maka_agent_facts::model::ModelFinishReason::ToolCalls);
        }
    }).await.expect("complete provider identities must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_provider_tool_identity_cannot_complete_a_model_step() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(Duration::from_secs(15)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (first, _) = fixtures(ProviderKind::OpenaiChatCompletions, "hello");
        // A missing function name violates the provider grammar independently of size.
        let body = first + &sse(&[
            json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"arguments":"{}"}}]},"finish_reason":null}]}),
            json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        ]) + "data: [DONE]\n\n";
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let header = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        });
        let mut stream = executor.stream(
            request(ProviderKind::OpenaiChatCompletions, base), CancellationToken::new(),
        ).await.unwrap();
        let mut builder = StepBuilder::for_step("step").unwrap();
        let mut rejected = false;
        let mut admitted_calls = 0;
        while let Some(event) = stream.next().await {
            match event {
                Err(_) => {
                    rejected = true;
                    break;
                }
                Ok(event) => {
                    if matches!(&event.event, ModelEvent::ToolInputStarted { .. } | ModelEvent::ToolCall(_)) {
                        admitted_calls += 1;
                    }
                    builder.push(event.event).unwrap();
                }
            }
        }
        stream.cancel_and_wait().await.expect("actual stream cleanup");
        server.await.unwrap();
        assert!(rejected, "the adapter must reject a missing function name");
        assert_eq!(admitted_calls, 0);
        assert!(builder.finish().is_err());
    }).await.expect("malformed provider stream must terminate promptly");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_stream_outlives_idle_budget_but_silence_closes_the_socket() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let executor = ModelExecutor::new(Duration::from_secs(3)).unwrap();
        for silent in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let observed = Arc::new(Notify::new());
            let ready = observed.clone();
            let (first, last) = fixtures(ProviderKind::OpenaiChatCompletions, "progress");
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                socket.write_all(first.as_bytes()).await.unwrap();
                ready.notified().await;
                if silent {
                    let mut byte = [0];
                    assert_eq!(socket.read(&mut byte).await.unwrap(), 0, "idle timeout must close the transport");
                } else {
                    // Heartbeats are wire progress, not canonical text. They
                    // must keep a live provider from hitting the idle deadline.
                    for _ in 0..4 {
                        tokio::time::sleep(Duration::from_millis(900)).await;
                        socket.write_all(b": keep-alive\n\n").await.unwrap();
                    }
                    socket.write_all(last.as_bytes()).await.unwrap();
                }
            });
            let mut stream = executor.stream(request(ProviderKind::OpenaiChatCompletions, base), CancellationToken::new()).await.unwrap();
            let mut builder = StepBuilder::default();
            let mut failure = None;
            let mut deltas = 0;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        let event = event.event;
                        if matches!(event, ModelEvent::PartDelta { .. }) {
                            deltas += 1;
                            observed.notify_one();
                        }
                        builder.push(event).unwrap();
                    }
                    Err(error) => { failure = Some(error); break; }
                }
            }
            stream.cancel_and_wait().await.expect("actual stream cleanup");
            if silent {
                assert!(matches!(failure, Some(maka_model::ModelError::TimedOut)), "{failure:?}");
            } else {
                assert!(failure.is_none(), "{failure:?}");
                assert_eq!(deltas, 1);
                builder.finish().unwrap();
            }
            server.await.unwrap();
        }
    }).await.expect("stream activity and idle cleanup must settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_connect_failure_is_retryable_but_invalid_http_is_not() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let executor = ModelExecutor::new(Duration::from_secs(5)).unwrap();
        for connect_failure in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = if connect_failure {
                drop(listener);
                None
            } else {
                Some(tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    read_request(&mut socket).await;
                    socket.write_all(b"not an HTTP response\r\n\r\n").await.unwrap();
                }))
            };
            let mut stream = executor.stream(request(ProviderKind::OpenaiChatCompletions, base), CancellationToken::new()).await.unwrap();
            let error = loop {
                match stream.next().await.expect("failed transport must report its error") {
                    Ok(_) => {},
                    Err(error) => break error,
                }
            };
            stream.cancel_and_wait().await.expect("actual stream cleanup");
            if connect_failure {
                assert!(matches!(error, maka_model::ModelError::Provider(ref failure)
                    if failure.reason() == maka_model::ProviderFailureReason::Network && failure.replay_safe()), "{error:?}");
            } else {
                assert!(matches!(error, maka_model::ModelError::Adapter(_)), "{error:?}");
            }
            if let Some(server) = server { server.await.unwrap(); }
        }
    }).await.expect("transport classification must settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_closes_pending_fetch_and_releases_model_capacity() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let received = Arc::new(Notify::new());
        let ready = received.clone();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                ready.notify_one();
                let mut byte = [0];
                assert_eq!(
                    socket.read(&mut byte).await.unwrap(),
                    0,
                    "cancelled fetch closes socket"
                );
            }
        });
        let executor = ModelExecutor::new(Duration::from_secs(30)).unwrap();
        for _ in 0..2 {
            let mut customized = request(ProviderKind::OpenaiChatCompletions, base.clone());
            customized.provider.body_overlay = Some(serde_json::Map::from_iter([(
                "fixture_context".into(),
                json!({"cancel":true}),
            )]));
            let mut stream = executor
                .stream(customized, CancellationToken::new())
                .await
                .unwrap();
            tokio::select! {
                _ = received.notified() => {},
                result = stream.next() => panic!("model failed before HTTP request: {result:?}"),
            }
            stream
                .cancel_and_wait()
                .await
                .expect("actual stream cleanup");
        }
        server.await.unwrap();
    })
    .await
    .expect("cancellation must complete without waiting for response");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn customization_cannot_replace_generated_headers_or_body_fields() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        for (kind, header) in [
            (ProviderKind::Anthropic, Some("Anthropic-Version")),
            (ProviderKind::Anthropic, Some("Anthropic-Beta")),
            (ProviderKind::Anthropic, None), (ProviderKind::OpenaiChatCompletions, None),
            (ProviderKind::OpenaiCompatible { name: "fixture".into() }, None),
            (ProviderKind::OpenaiResponses, None),
        ] {
            let mut customized = request(kind, base.clone());
            let expected = if let Some(name) = header {
                customized.provider.headers.insert(name.into(), "private-conflict".into());
                format!("Custom request header conflicts with a generated header: {name}")
            } else {
                customized.provider.body_overlay = Some(serde_json::Map::from_iter([("stream".into(), json!(true))]));
                "Extra request body conflicts with a generated field: stream".into()
            };
            let mut stream = executor.stream(customized, CancellationToken::new()).await.unwrap();
            let error = tokio::select! {
                _ = listener.accept() => panic!("conflicting customization reached the network"),
                event = stream.next() => event.expect("adapter failure").expect_err("customization conflict").to_string(),
            };
            assert!(error.contains(&expected), "expected {expected}, got {error}");
            assert!(!error.contains("private-conflict"));
            stream.cancel_and_wait().await.expect("actual stream cleanup");
        }
        assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
    }).await.expect("customization conflicts must fail promptly");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_tool_history_projects_invalid_json_and_unwraps_valid_arguments_on_the_wire() {
    use maka_agent_facts::model::ToolInput;
    use maka_model::prompt::{AssistantPart, Message, ToolOutput};
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiCompatible { name: "fixture".into() }, ProviderKind::Anthropic] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let response_kind = if matches!(kind, ProviderKind::Anthropic) { ProviderKind::Anthropic } else { ProviderKind::OpenaiChatCompletions };
            let (first, last) = fixtures(response_kind, "done");
            let body = first + &last;
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let wire = read_request(&mut socket).await;
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                serde_json::from_str::<Value>(wire.split_once("\r\n\r\n").unwrap().1).unwrap()
            });
            let raw = " {\"n\":\n";
            let diagnostic = format!("Invalid JSON tool arguments: EOF while parsing a value; original arguments: {}", json!(raw));
            let mut input = request(kind.clone(), base);
            crate::edit_prompt(&mut input.prompt, |messages| messages.push(Message::Assistant { content: vec![
                AssistantPart::ToolCall { tool_call_id:"broken".into(), tool_name:"echo".into(), input:ToolInput::InvalidJson {raw:raw.into()}, provider_executed:Some(false), provider_options:None },
                AssistantPart::ToolCall { tool_call_id:"normal".into(), tool_name:"echo".into(), input:ToolInput::Json(json!({"text":"original","n":7})), provider_executed:None, provider_options:None },
            ], provider_options:None }));
            crate::edit_prompt(&mut input.prompt, |messages| messages.push(Message::tool("broken", "echo", ToolOutput::ErrorText(diagnostic.clone()))));
            crate::edit_prompt(&mut input.prompt, |messages| messages.push(Message::tool("normal", "echo", ToolOutput::Json(json!({"text":"original","n":7})))));
            let mut stream = executor.stream(input, CancellationToken::new()).await.unwrap();
            let mut builder = StepBuilder::default();
            while let Some(event) = stream.next().await { builder.push(event.unwrap().event).unwrap(); }
            stream.cancel_and_wait().await.unwrap();
            assert_eq!(builder.finish().unwrap().finish_reason, maka_agent_facts::model::ModelFinishReason::ToolCalls);
            let wire = server.await.unwrap();
            let messages = wire["messages"].as_array().unwrap();
            if matches!(kind, ProviderKind::Anthropic) {
                assert_eq!(messages[1]["content"][0], json!({"type":"tool_use","id":"broken","name":"echo","input":{}}));
                assert_eq!(messages[1]["content"][1], json!({"type":"tool_use","id":"normal","name":"echo","input":{"text":"original","n":7}}));
                assert_eq!(messages[2]["content"][0]["tool_use_id"], "broken");
                assert_eq!(messages[2]["content"][0]["is_error"], true);
                assert_eq!(messages[2]["content"][0]["content"], diagnostic);
            } else {
                assert_eq!(messages[1]["tool_calls"][0], json!({"type":"function","id":"broken","function":{"name":"echo","arguments":"{}"}}));
                assert_eq!(messages[1]["tool_calls"][1]["id"], "normal");
                assert_eq!(serde_json::from_str::<Value>(messages[1]["tool_calls"][1]["function"]["arguments"].as_str().unwrap()).unwrap(), json!({"text":"original","n":7}));
                assert_eq!(messages[2]["tool_call_id"], "broken");
                assert_eq!(messages[2]["content"], diagnostic);
            }
        }
    }).await.expect("adapter wire projection must finish");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepared_messages_wire_preserves_the_exact_tool_receipt_and_call_identity() {
    use maka_model::prompt::{AssistantPart, Message, ToolOutput};

    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (first, last) = fixtures(ProviderKind::Anthropic, "done");
        let response = first + &last;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let wire = read_request(&mut socket).await;
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len(),
            ).as_bytes()).await.unwrap();
            wire
        });
        let mut input = request(ProviderKind::Anthropic, base);
        crate::edit_prompt(&mut input.prompt, |messages| {
            messages.push(Message::Assistant {
                content: vec![AssistantPart::ToolCall {
                    tool_call_id: "echo-call-73".into(),
                    tool_name: "echo".into(),
                    input: maka_agent_facts::model::ToolInput::Json(json!({"token":"amber-native-42"})),
                    provider_executed: Some(false),
                    provider_options: None,
                }],
                provider_options: None,
            });
            messages.push(Message::tool(
                "echo-call-73",
                "echo",
                ToolOutput::Text("cobalt-tool-receipt-73".into()),
            ));
        });
        let reads = prepare_input(&mut input);
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let mut stream = executor.stream(input, CancellationToken::new()).await.unwrap();
        let mut builder = StepBuilder::default();
        while let Some(event) = stream.next().await {
            builder.push(event.unwrap().event).unwrap();
        }
        builder.finish().unwrap();
        stream.cancel_and_wait().await.unwrap();
        reads.assert_wire_only();

        let wire = server.await.unwrap();
        let (headers, body) = wire.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("POST /v1/messages HTTP/1.1\r\n"));
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["messages"], json!([
            {"role":"user","content":[{"type":"text","text":"hello"}]},
            {"role":"assistant","content":[{
                "type":"tool_use","id":"echo-call-73","name":"echo",
                "input":{"token":"amber-native-42"}
            }]},
            {"role":"user","content":[{
                "type":"tool_result","tool_use_id":"echo-call-73",
                "content":"cobalt-tool-receipt-73"
            }]}
        ]));
    }).await.expect("prepared Messages receipt must reach the HTTP receiver");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_http_error_body_cannot_authorize_provider_replay() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiCompatible { name: "fixture".into() }, ProviderKind::Anthropic] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\ninvalid-chunk-size\r\n{}").await.unwrap();
            });
            let models = ModelExecutor::new(Duration::from_secs(5)).unwrap();
            let mut stream = models.stream(request(kind, base), CancellationToken::new()).await.unwrap();
            let error = stream.next().await.unwrap().unwrap_err();
            assert!(matches!(error, maka_model::ModelError::Adapter(_)), "invalid HTTP framing became a retryable provider response: {error:?}");
            stream.cancel_and_wait().await.unwrap();
            server.await.unwrap();
        }
    }).await.expect("invalid error-body framing settles");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn error_body_deadlines_and_network_loss_keep_distinct_causes() {
    use maka_model::{ModelError, ProviderFailureReason};
    tokio::time::timeout(Duration::from_secs(15), async {
        for status in [400, 401, 429, 503] {
            for silent in [false, true] {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}/v1", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    read_request(&mut socket).await;
                    socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    if silent {
                        assert_eq!(socket.read(&mut [0]).await.unwrap(), 0, "deadline closes the original body");
                    }
                });
                let models = ModelExecutor::new(Duration::from_millis(200)).unwrap();
                let mut stream = models.stream(request(ProviderKind::Anthropic, base), CancellationToken::new()).await.unwrap();
                let error = stream.next().await.unwrap().unwrap_err();
                if silent {
                    assert!(matches!(error, ModelError::TimedOut), "headers must not hide the actual deadline: {error:?}");
                } else {
                    match (status, error) {
                        (400 | 401, ModelError::Http { status: actual }) => assert_eq!(actual, status),
                        (429 | 503, ModelError::Provider(failure)) => assert_eq!(failure.reason(), if status == 429 { ProviderFailureReason::RateLimit } else { ProviderFailureReason::ProviderUnavailable }),
                        (_, error) => panic!("network body loss discarded status evidence: {error:?}"),
                    }
                }
                stream.cancel_and_wait().await.unwrap();
                server.await.unwrap();
            }
        }
    }).await.expect("body errors preserve the actual failure cause");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_single_large_provider_delta_is_split_without_a_response_size_cap() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let expected = "x".repeat(33 * 1024 * 1024) + "中文🙂";
        let (first, last) = fixtures(ProviderKind::OpenaiChatCompletions, &expected);
        let body = first + &last;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        });
        let models = ModelExecutor::new(Duration::from_secs(30)).unwrap();
        let mut stream = models.stream(request(ProviderKind::OpenaiChatCompletions,base),CancellationToken::new()).await.unwrap();
        let mut actual=String::new();
        let mut step=StepBuilder::default();
        while let Some(event)=stream.next().await {
            let event=event.unwrap().event;
            if let ModelEvent::PartDelta {text,..}=&event {
                assert!(text.len()<=8*1024, "journal observations stay bounded");
                actual.push_str(text);
            }
            step.push(event).unwrap();
        }
        assert_eq!(actual,expected);
        step.finish().unwrap();
        stream.cancel_and_wait().await.unwrap();
        server.await.unwrap();
    }).await.expect("one large atomic delta is consumed and cleaned up");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepared_native_upload_never_opens_semantic_history() {
    use maka_model::prompt::Message;

    for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::Anthropic] {
        tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let response_kind = kind.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let wire = read_request(&mut socket).await;
            let first_body = wire.split_once("\r\n\r\n").unwrap().1.to_owned();
            socket.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /v1/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            let replay = read_request(&mut socket).await;
            assert_eq!(replay.split_once("\r\n\r\n").unwrap().1, first_body, "redirect must replay the identical captured wire view");
            let body: Value = serde_json::from_str(&first_body).unwrap();
            let (first, last) = fixtures(response_kind, "OK");
            let response = first + &last;
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
            body
        });
        let mut input = request(kind.clone(), base);
        input.provider_options = json!({"openai":{"temperature":0.25}});
        input.provider.body_overlay = Some(serde_json::from_value(json!({"routing":"captured"})).unwrap());
        let messages = vec![Message::System { content: "captured instructions".into(), provider_options: None }, Message::user("persisted 中文\n\"body\""), Message::user("complete suffix")];
        input.prompt = messages.into();
        let reads = prepare_input(&mut input);
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let mut stream = executor.stream(input, CancellationToken::new()).await.unwrap();
        while let Some(event) = stream.next().await { event.unwrap(); }
        let body = server.await.unwrap();
        reads.assert_wire_only();
        if matches!(kind, ProviderKind::Anthropic) {
            assert_eq!(body["system"], json!([{"type":"text","text":"captured instructions"}]));
            assert_eq!(body["messages"], json!([{"role":"user","content":[
                {"type":"text","text":"persisted 中文\n\"body\""},
                {"type":"text","text":"complete suffix"}
            ]}]));
            assert_eq!(body["tools"][0]["name"], "echo");
        } else {
            assert_eq!(body["messages"], json!([
                {"role":"system","content":"captured instructions"},
                {"role":"user","content":"persisted 中文\n\"body\""},
                {"role":"user","content":"complete suffix"}
            ]));
            assert_eq!(body["temperature"], 0.25);
            assert_eq!(body["tools"][0]["function"]["name"], "echo");
        }
        assert_eq!(body["routing"], "captured");
        assert_eq!(body["max_tokens"], 128);
    }).await.unwrap();
    }
}
