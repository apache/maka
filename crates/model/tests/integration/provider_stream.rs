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
pub(super) fn request(kind: ProviderKind, base_url: String) -> ModelRequest {
    ModelRequest {
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
        prompt: vec![maka_model::prompt::Message::user("hello")],
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
    let mut bytes = Vec::new();
    let boundary = loop {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 64 * 1024);
        if let Some(at) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&bytes[..boundary]);
    let length: usize = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap();
    while bytes.len() < boundary + length {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
    }
    let mut request: String = bytes[..boundary].iter().copied().map(char::from).collect();
    request.push_str(std::str::from_utf8(&bytes[boundary..]).unwrap());
    request
}

fn sse(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| format!("data: {value}\n\n"))
        .collect()
}

fn fixtures(kind: ProviderKind, text: &str) -> (String, String) {
    match kind {
        ProviderKind::OpenaiChat => (
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
        ProviderKind::OpenaiResponses
        | ProviderKind::OpenResponses(_)
        | ProviderKind::OpenaiCompatible { .. } => {
            unreachable!("separate fixtures required")
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sdk_text_and_tool_streams_cross_real_http_before_response_finishes() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(1, Duration::from_secs(15)).unwrap();
        for kind in [ProviderKind::OpenaiChat, ProviderKind::Anthropic] {
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
                ("fixture_context".into(), json!({"route":"customized"})),
            ]));
            customized.provider.headers.insert("X-Custom-Route".into(), "local-route".into());
            customized.provider.headers.insert("X-Latin-1".into(), "ÿ".into());
            if matches!(kind, ProviderKind::Anthropic) {
                customized.provider.headers.insert("Anthropic-Version".into(), "2023-06-01".into());
                customized.prompt.push(serde_json::from_value(json!({"role":"user","content":[{"type":"file","mediaType":"audio/wav","data":{"type":"data","data":"YXVkaW8="}}]})).unwrap());
            }
            let mut stream = executor.stream(customized, CancellationToken::new()).await.unwrap();
            let mut events = Vec::new();
            let mut observed_text = String::new();
            let mut builder = StepBuilder::default();
            while let Some(event) = stream.next().await {
                let event = event.unwrap();
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
                maka_runtime::model::ModelPart::Text { text, .. } if text == &expected_text)));
            let tool = step.tool_calls().next().expect("tool call");
            assert_eq!(tool.id, "tool-1");
            assert_eq!(tool.name, "echo");
            assert_eq!(tool.input, json!({}));
assert_eq!(step.finish_reason, maka_runtime::model::ModelFinishReason::ToolCalls);
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
            assert_eq!(body["fixture_context"], json!({"route":"customized"}));
            if matches!(kind, ProviderKind::Anthropic) {
                assert!(body["messages"].to_string().contains("not supported by this model adapter"));
                assert!(!body["messages"].to_string().contains("YXVkaW8="));
            }
        }
    }).await.expect("provider stream must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_tool_media_follow_the_complete_parallel_result_group_on_the_wire() {
    use maka_model::prompt::{AssistantPart, ContentPart, FileData, Message, ToolOutput};

    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(1, Duration::from_secs(10)).unwrap();
        for (kind, mime) in [ProviderKind::OpenaiChat, ProviderKind::OpenaiCompatible { name: "fixture".into() }].into_iter().flat_map(|kind| ["image/png", "audio/wav"].map(|mime| (kind.clone(), mime))) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let wire = read_request(&mut socket).await;
                let (first, last) = fixtures(ProviderKind::OpenaiChat, "seen");
                let body = first + &last;
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                serde_json::from_str::<Value>(wire.split_once("\r\n\r\n").unwrap().1).unwrap()
            });
            let append_user = matches!(kind, ProviderKind::OpenaiChat);
            let mut input = request(kind, base);
            input.prompt.push(Message::Assistant {
                content: ["first", "second"].into_iter().map(|id| AssistantPart::ToolCall {
                    tool_call_id: id.into(), tool_name: "echo".into(), input: json!({}),
                    provider_executed: None, provider_options: None,
                }).collect(),
                provider_options: None,
            });
            for id in ["first", "second"] {
                input.prompt.push(Message::tool(id, "echo", ToolOutput::Content(vec![
                    ContentPart::text(format!("result-{id}")),
                    ContentPart::File { data: FileData::Data("aW1hZ2U=".into()), media_type: mime.into(), provider_options: None },
                ])));
            }
            if append_user { input.prompt.push(Message::user("compare these images")); }
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
async fn malformed_provider_tool_identity_cannot_complete_a_model_step() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let executor = ModelExecutor::new(1, Duration::from_secs(15)).unwrap();
        for (id, name) in [("x".repeat(4092), "echo".into()), ("tool-1".into(), "é".repeat(129))] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let (first, last) = fixtures(ProviderKind::OpenaiChat, "hello");
            let body = first + &last.replace("tool-1", &id).replace("echo", &name);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                let header = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(body.as_bytes()).await.unwrap();
            });
            let mut stream = executor.stream(
                request(ProviderKind::OpenaiChat, base), CancellationToken::new(),
            ).await.unwrap();
            let mut builder = StepBuilder::for_step("step").unwrap();
            let mut rejected_call = false;
            while let Some(event) = stream.next().await {
                let event = event.expect("SDK must pass the malformed identity to model acceptance");
                let is_call = matches!(&event, ModelEvent::ToolCall(_));
                if builder.push(event).is_err() {
                    assert!(is_call, "reject the tool identity at its first acceptance boundary");
                    rejected_call = true;
                    break;
                }
            }
            stream.cancel_and_wait().await;
            assert!(rejected_call);
            assert!(builder.finish().is_err());
            server.await.unwrap();
        }
    }).await.expect("malformed provider stream must terminate promptly");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_stream_outlives_idle_budget_but_silence_closes_the_socket() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let executor = ModelExecutor::new(1, Duration::from_secs(3)).unwrap();
        for silent in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let observed = Arc::new(Notify::new());
            let ready = observed.clone();
            let (first, last) = fixtures(ProviderKind::OpenaiChat, "progress");
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
            let mut stream = executor.stream(request(ProviderKind::OpenaiChat, base), CancellationToken::new()).await.unwrap();
            let mut builder = StepBuilder::default();
            let mut failure = None;
            let mut deltas = 0;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        if matches!(event, ModelEvent::PartDelta { .. }) {
                            deltas += 1;
                            observed.notify_one();
                        }
                        builder.push(event).unwrap();
                    }
                    Err(error) => { failure = Some(error); break; }
                }
            }
            stream.cancel_and_wait().await;
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
        let executor = ModelExecutor::new(1, Duration::from_secs(5)).unwrap();
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
            let mut stream = executor.stream(request(ProviderKind::OpenaiChat, base), CancellationToken::new()).await.unwrap();
            let error = loop {
                match stream.next().await.expect("failed transport must report its error") {
                    Ok(_) => {},
                    Err(error) => break error,
                }
            };
            stream.cancel_and_wait().await;
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
        let executor = ModelExecutor::new(1, Duration::from_secs(30)).unwrap();
        for _ in 0..2 {
            let mut customized = request(ProviderKind::OpenaiChat, base.clone());
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
            stream.cancel_and_wait().await;
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
        let executor = ModelExecutor::new(1, Duration::from_secs(10)).unwrap();
        for (kind, header) in [
            (ProviderKind::Anthropic, Some("Anthropic-Version")),
            (ProviderKind::Anthropic, Some("Anthropic-Beta")),
            (ProviderKind::Anthropic, None), (ProviderKind::OpenaiChat, None),
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
            stream.cancel_and_wait().await;
        }
        assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
    }).await.expect("customization conflicts must fail promptly");
}
