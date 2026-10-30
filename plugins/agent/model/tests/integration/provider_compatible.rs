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

use std::{sync::Arc, time::Duration};

use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::TextKind;
use maka_model::{ModelExecutor, ModelRequest, ProviderConfig, ProviderKind, StepBuilder};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

fn request(base_url: &str) -> ModelRequest {
    ModelRequest {
        language: maka_agent_facts::language::Language::En,
        provider: ProviderConfig {
            image_input: None,
            adapter: None,
            capabilities: Default::default(),
            kind: ProviderKind::OpenaiCompatible {
                name: "local-gateway".into(),
            },
            model: "fixture".into(),
            base_url: base_url.into(),
            auth: maka_model::ProviderAuth::ApiKey("test".into()),
            headers: Default::default(),
            network: Default::default(),
            body_overlay: None,
        },
        prompt: vec![maka_model::prompt::Message::user("hello")].into(),
        tools: vec![],
        provider_options: json!({}),
        max_output_tokens: Some(32),
    }
}

pub(super) async fn body(socket: &mut TcpStream) -> Value {
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        headers.push(socket.read_u8().await.unwrap());
        assert!(headers.len() < 8192);
    }
    let headers = String::from_utf8(headers).unwrap();
    let length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().unwrap())
    });
    let mut bytes = Vec::new();
    if let Some(length) = length {
        assert!(length < 64 * 1024);
        bytes.resize(length, 0);
        socket.read_exact(&mut bytes).await.unwrap();
    } else {
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("transfer-encoding: chunked")
        );
        loop {
            let mut line = Vec::new();
            while !line.ends_with(b"\r\n") {
                line.push(socket.read_u8().await.unwrap());
            }
            let length =
                usize::from_str_radix(String::from_utf8(line).unwrap().trim(), 16).unwrap();
            assert!(bytes.len() + length < 64 * 1024);
            let offset = bytes.len();
            bytes.resize(offset + length, 0);
            socket.read_exact(&mut bytes[offset..]).await.unwrap();
            assert_eq!(socket.read_u16().await.unwrap(), 0x0d0a);
            if length == 0 {
                break;
            }
        }
    }
    serde_json::from_slice(&bytes).unwrap()
}

async fn response(socket: &mut TcpStream, status: u16, content: &str) {
    let mime = if status == 200 {
        "text/event-stream"
    } else {
        "text/plain"
    };
    socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}", content.len()).as_bytes()).await.unwrap();
}

async fn assert_closed(socket: &mut TcpStream) {
    let closed = socket.read(&mut [0]).await;
    assert!(
        matches!(closed, Ok(0))
            || matches!(closed, Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset)
    );
}

fn completion(deltas: &[Value]) -> String {
    let mut data = String::new();
    for delta in deltas {
        let chunk = json!({"id":"reply","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        data.push_str(&format!("data: {chunk}\n\n"));
    }
    let finish = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}});
    data + &format!("data: {finish}\n\ndata: [DONE]\n\n")
}

async fn collect(executor: &ModelExecutor, url: &str) -> Result<ModelStep, String> {
    let mut stream = executor
        .stream(request(url), CancellationToken::new())
        .await
        .unwrap();
    let mut builder = StepBuilder::default();
    while let Some(event) = stream.next().await {
        match event {
            Ok(event) => builder.push(event.event).unwrap(),
            Err(error) => {
                stream
                    .cancel_and_wait()
                    .await
                    .expect("actual stream cleanup");
                return Err(error.to_string());
            }
        }
    }
    stream
        .cancel_and_wait()
        .await
        .expect("actual stream cleanup");
    Ok(builder.finish().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordered_raw_reasoning_preserves_empty_fields_and_reopened_parts() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let wire = body(&mut socket).await;
            // One HTTP write intentionally allows fetch to read ahead through every field.
            response(
                &mut socket,
                200,
                &completion(&[
                    json!({"reasoning_content":""}),
                    json!({"content":"A"}),
                    json!({"reasoning":"why","reasoning_details":[{"type":"reasoning.text","text":"why","index":0,"format":"unknown"}]}),
                    json!({"content":"B"}),
                    json!({"reasoning_content":"last","reasoning":"ignored"}),
                    json!({"content":"C"}),
                    json!({"reasoning":""}),
                ]),
            )
            .await;
            wire
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let step = collect(&executor, &url).await.unwrap();
        let expected = [
            (TextKind::Thinking, "", Some("reasoning_content")),
            (TextKind::Text, "A", None),
            (TextKind::Thinking, "why", Some("reasoning")),
            (TextKind::Text, "B", None),
            (TextKind::Thinking, "last", Some("reasoning_content")),
            (TextKind::Text, "C", None),
            (TextKind::Thinking, "", Some("reasoning")),
        ];
        assert_eq!(step.parts.len(), expected.len());
        for (part, (kind, text, field)) in step.parts.iter().zip(expected) {
            let ModelPart::Text {
                text_kind,
                text: actual,
                provider_options,
            } = part
            else {
                panic!("text part")
            };
            assert_eq!(*text_kind, kind);
            assert!(actual.chunks().flat_map(str::bytes).eq(text.bytes()));
            assert_eq!(
                provider_options
                    .as_ref()
                    .and_then(|v| v["maka"]["openAiChatReasoningField"].as_str()),
                field
            );
        }
        assert_eq!(step.usage.input_tokens, Some(4));
        assert_eq!(step.usage.output_tokens, Some(6));
        assert_eq!(
            server.await.unwrap()["stream_options"],
            json!({"include_usage":true})
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_retreat_is_exact_once_and_shared_only_with_executor_clones() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let ok = completion(&[json!({"content":"ok"})]);
        let server = tokio::spawn(async move {
            for (options, status, text) in [
                (true, 400, "unknown INCLUDE_USAGE"),
                (false, 400, "stream_options still rejected"),
                (false, 200, ok.as_str()), // clone remembers even when the one retry failed
                (true, 401, "stream_options"), // another endpoint is independent; never retry 401
                (true, 400, "invalid model"), // never retry an unrelated 400
                (true, 400, "stream_options"),
                (false, 200, ok.as_str()), // fresh executor forgets
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let wire = body(&mut socket).await;
                assert_eq!(wire.get("stream_options").is_some(), options);
                response(&mut socket, status, text).await;
            }
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        assert!(collect(&executor, &url).await.is_err());
        assert!(collect(&executor.clone(), &url).await.is_ok());
        let other = format!("{url}/other");
        assert!(collect(&executor, &other).await.is_err());
        assert!(collect(&executor, &other).await.is_err());
        let fresh = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        assert!(collect(&fresh, &url).await.is_ok());
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_drains_failure_body_and_retry_without_poisoning_capacity() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let (ready, mut received) = tokio::sync::mpsc::channel(2);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(body(&mut socket).await.get("stream_options").is_some());
            socket.write_all(b"HTTP/1.1 400 Test\r\nContent-Length: 1000\r\nConnection: close\r\n\r\nstream_options").await.unwrap();
            ready.send(()).await.unwrap();
            assert_closed(&mut socket).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(body(&mut socket).await.get("stream_options").is_some());
            response(&mut socket, 400, "stream_options").await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(body(&mut socket).await.get("stream_options").is_none());
            ready.send(()).await.unwrap();
            assert_closed(&mut socket).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(body(&mut socket).await.get("stream_options").is_none());
            response(&mut socket, 200, &completion(&[json!({"content":"ok"})])).await;
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        for limit in [0, 9_007_199_254_740_992, u64::MAX] {
            let mut invalid = request(&url);
            invalid.max_output_tokens = Some(limit);
            let result = executor.stream(invalid, CancellationToken::new()).await;
            assert!(matches!(result, Err(maka_model::ModelError::Adapter(message))
                if message == "maxOutputTokens must be a positive JavaScript safe integer"));
        }
        for _ in 0..2 {
            let stream = executor.stream(request(&url), CancellationToken::new()).await.unwrap();
            received.recv().await.unwrap();
            stream.cancel_and_wait().await.expect("actual stream cleanup");
        }
        assert!(collect(&executor.clone(), &url).await.is_ok());
        server.await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn captured_language_reaches_native_notifications_without_becoming_provider_parameter() {
    use maka_agent_facts::language::Language;
    use maka_model::prompt::Message;

    tokio::time::timeout(Duration::from_secs(20), async {
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        for (language, expected) in [
            (
                Language::ZhCn,
                "[来自 exec call-原文 的通知]\nworker result: Keep 原文",
            ),
            (
                Language::ZhTw,
                "[來自 exec call-原文 的通知]\nworker result: Keep 原文",
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let wire = body(&mut socket).await;
                response(&mut socket, 200, &completion(&[json!({"content":"seen"})])).await;
                wire
            });
            let mut input = request(&url);
            input.language = language;
            input.prompt = vec![Message::notification(
                "call-原文",
                "worker result: Keep 原文",
            )]
            .into();
            let mut stream = executor
                .stream(input, CancellationToken::new())
                .await
                .unwrap();
            while let Some(event) = stream.next().await {
                event.unwrap();
            }
            stream.cancel_and_wait().await.unwrap();
            let wire = server.await.unwrap();
            assert_eq!(wire["messages"][0]["role"], "user");
            assert_eq!(wire["messages"][0]["content"], expected);
            assert_eq!(wire.get("language"), None);
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn full_request_byte_count_matches_upload_and_stops_oversized_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let mut input = request(&url);
    input.provider.body_overlay = Some(serde_json::Map::from_iter([(
        "fixture".into(),
        json!("quoted \" and Unicode 图片"),
    )]));
    input.tools.push(Arc::new(maka_model::ToolDefinition {
        provider: None,
        name: "read_fixture".into(),
        description: "read an image region".into(),
        input_schema: json!({"type":"object","properties":{"path":{"type":"string"}}}),
        freeform: None,
        output_schema: None,
    }));
    let bytes = input.encoded_request_bytes().await.unwrap();
    input.provider.image_input = Some(maka_agent_facts::configuration::ImageInput {
        request_bytes: Some(bytes - 1),
        ..Default::default()
    });
    let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
    let error = match executor.stream(input, CancellationToken::new()).await {
        Ok(_) => panic!("oversized full request must fail before upload"),
        Err(error) => error,
    };
    assert!(
        matches!(error, maka_model::ModelError::ImageInputPayloadTooLarge { bytes: actual, limit } if actual == bytes && limit == bytes - 1)
    );
    {
        use futures_util::FutureExt;
        assert!(listener.accept().now_or_never().is_none());
    }

    let mut input = request(&url);
    input.provider.body_overlay = Some(serde_json::Map::from_iter([(
        "fixture".into(),
        json!("quoted \" and Unicode 图片"),
    )]));
    let bytes = input.encoded_request_bytes().await.unwrap();
    input.provider.image_input = Some(maka_agent_facts::configuration::ImageInput {
        request_bytes: Some(bytes),
        ..Default::default()
    });
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let wire = body(&mut socket).await;
        response(&mut socket, 200, &completion(&[])).await;
        serde_json::to_vec(&wire).unwrap().len() as u64
    });
    let mut stream = executor
        .stream(input, CancellationToken::new())
        .await
        .unwrap();
    while let Some(event) = stream.next().await {
        event.unwrap();
    }
    stream.cancel_and_wait().await.unwrap();
    assert_eq!(
        server.await.unwrap(),
        bytes,
        "count covers actual model/options/messages/overlay envelope"
    );
}
