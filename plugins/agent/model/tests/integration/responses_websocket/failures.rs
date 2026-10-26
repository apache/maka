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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn screenshot_requests_are_reassembled_from_bounded_transport_fragments() {
    use maka_agent_facts::model::prompt::ContentPart;
    use maka_agent_facts::model::prompt::FileData;
    use maka_agent_facts::model::prompt::Message as Prompt;
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async_with_config(
                socket,
                Some(
                    tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                        .max_frame_size(Some(16 * 1024))
                        .max_message_size(Some(64 * 1024 * 1024)),
                ),
            )
            .await
            .unwrap();
            let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(frame.len() > 32 * 1024 * 1024);
            let body: Value = serde_json::from_str(&frame).unwrap();
            assert_eq!(body["input"][0]["content"][0]["type"], "input_image");
            finish(&mut socket, "large-screenshot").await;
        });
        let mut input = request(&base, "unused");
        input.prompt = vec![Prompt::User {
            content: vec![ContentPart::File {
                data: FileData::Data("A".repeat(33 * 1024 * 1024)),
                media_type: "image/png".into(),
                provider_options: None,
            }],
            provider_options: None,
        }]
        .into();
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        generate(&executor, &Conversation::default(), input).await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_and_bad_frames_do_not_replay_or_poison_other_lanes() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (dispatched, received) = tokio::sync::oneshot::channel();
        let (retry_started, retry_received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            reject_upgrade(&listener).await;
            let (mut retry, _) = listener.accept().await.unwrap();
            retry_started.send(()).unwrap();
            let mut pending = [0; 4096];
            while retry.read(&mut pending).await.unwrap() != 0 {}
            // Cancellation of a retry must release its socket, not defer this
            // route or allow a later timer to reconnect behind the caller.
            let mut stalled = accept(&listener).await;
            wire(&mut stalled, "cancel").await;
            dispatched.send(()).unwrap();
            let mut healthy = accept(&listener).await;
            wire(&mut healthy, "healthy").await;
            for event in events("resp_ok", "OK") {
                healthy
                    .send(Message::Text(
                        serde_json::to_string_pretty(&event).unwrap().into(),
                    ))
                    .await
                    .unwrap();
            }
            assert!(
                stalled
                    .next()
                    .await
                    .is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_))))
            );
            let mut incomplete = accept(&listener).await;
            wire(&mut incomplete, "incomplete").await;
            incomplete
                .send(Message::Text(
                    json!({"type":"response.incomplete",
                "response":{"incomplete_details":{"reason":"content_filter"}}})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            let _ = incomplete.next().await;
            let mut bad = Vec::new();
            for _ in 0..3 {
                let mut socket = accept(&listener).await;
                wire(&mut socket, "bad").await;
                bad.push(socket);
            }
            for (mut socket, frame) in bad.into_iter().zip([
                Message::Binary(vec![1, 2].into()),
                Message::Text("{bad".into()),
                Message::Text("x".repeat(8 * 1024 * 1024 + 1).into()),
            ]) {
                let _ = socket.send(frame).await;
                let _ = socket.next().await;
            }
            wire(&mut healthy, "still healthy").await;
            finish(&mut healthy, "resp_healthy_again").await;
            let body = http_ok(&listener).await;
            assert!(
                body["input"]
                    .to_string()
                    .contains("after transport failure")
            );
            assert!(listener.accept().now_or_never().is_none());
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let connecting_cancel = CancellationToken::new();
        let connecting = executor
            .stream_in_conversation(
                request(&base, "cancel during retry"),
                connecting_cancel.clone(),
                Some(Conversation::default()),
            )
            .await
            .unwrap();
        retry_received.await.unwrap();
        connecting_cancel.cancel();
        connecting
            .cancel_and_wait()
            .await
            .expect("actual stream cleanup");
        let healthy_lane = Conversation::default();
        let cancel = CancellationToken::new();
        let mut stalled = executor
            .stream_in_conversation(
                request(&base, "cancel"),
                cancel.clone(),
                Some(Conversation::default()),
            )
            .await
            .unwrap();
        received.await.unwrap();
        generate(&executor, &healthy_lane, request(&base, "healthy")).await;
        cancel.cancel();
        while let Some(event) = stalled.next().await {
            if event.is_err() {
                break;
            }
        }
        stalled
            .cancel_and_wait()
            .await
            .expect("actual stream cleanup");
        let incomplete = executor
            .stream_in_conversation(
                request(&base, "incomplete"),
                CancellationToken::new(),
                Some(Conversation::default()),
            )
            .await
            .unwrap();
        assert_failed(incomplete).await;
        let mut streams = Vec::new();
        for _ in 0..3 {
            let stream = executor
                .stream_in_conversation(
                    request(&base, "bad"),
                    CancellationToken::new(),
                    Some(Conversation::default()),
                )
                .await
                .unwrap();
            streams.push(stream);
        }
        for stream in streams {
            assert_failed(stream).await;
        }
        generate(&executor, &healthy_lane, request(&base, "still healthy")).await;
        generate(
            &executor,
            &Conversation::default(),
            request(&base, "after transport failure"),
        )
        .await;
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_upgrade_falls_back_before_dispatch_and_stays_http() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut attempts = Vec::new();
            for expected in ["GET"; 6].into_iter().chain(["POST"; 3]) {
                let (mut socket, _) = listener.accept().await.unwrap();
                if expected == "GET" { attempts.push(std::time::Instant::now()); }
                let mut bytes = Vec::new();
                let boundary = loop {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(index) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") { break index + 4; }
                };
                let head = String::from_utf8_lossy(&bytes[..boundary]);
                assert!(head.starts_with(&format!("{expected} http://models.maka.invalid/v1/responses ")));
                assert!(head.to_ascii_lowercase().contains("\r\nproxy-authorization: basic dxnlcjpzzwnyzxq=\r\n"));
                if expected == "GET" {
                    socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                } else {
                    let body = crate::http_body(&mut socket, &head, bytes[boundary..].to_vec()).await;
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(body["stream"], true);
                    assert!(body.get("type").is_none());
                    let response: String = events("resp_http", "OK").iter().map(|event| format!("data: {event}\n\n")).collect();
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
                }
            }
            for (index, pair) in attempts.windows(2).enumerate() {
                assert!(pair[1].duration_since(pair[0]) >= Duration::from_millis(100 << index),
                    "retry {index} must wait its exponential interval");
            }
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let lane = Conversation::default();
        generate(&executor, &lane, proxied_request(proxy_port, "first")).await;
        generate(&executor, &lane, proxied_request(proxy_port, "second")).await;
        drop(lane);
        generate(&executor, &Conversation::default(), proxied_request(proxy_port, "new Turn")).await;
        server.await.unwrap();
    }).await.unwrap();
}

async fn assert_failed(mut stream: maka_model::ModelStream) {
    let mut failed = false;
    while let Some(event) = stream.next().await {
        if event.is_err() {
            failed = true;
            break;
        }
    }
    assert!(failed);
    stream
        .cancel_and_wait()
        .await
        .expect("actual stream cleanup");
}

async fn http_ok(listener: &TcpListener) -> Value {
    let (mut socket, _) = listener.accept().await.unwrap();
    let (head, bytes) = crate::http_request(&mut socket).await;
    assert!(head.starts_with("POST /v1/responses "));
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["stream"], true);
    assert!(body.get("previous_response_id").is_none());
    let response: String = events("resp_http", "OK")
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
    body
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_reads_preserve_diagnostics_and_decoder_replay_safety() {
    use maka_agent_facts::model::error::ModelError;
    use maka_agent_facts::model::error::ProviderFailureReason;
    use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
    tokio::time::timeout(Duration::from_secs(15), async {
        for (mode, idle) in [
            ("empty", false), ("text", false), ("final_text", false), ("local_intent", false),
            ("provider_effect", false), ("policy", false), ("size", false), ("reset", false),
            ("empty", true), ("text", true), ("final_text", true), ("local_intent", true), ("provider_effect", true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let mut socket = accept(&listener).await;
                wire(&mut socket, "interrupted").await;
                match mode {
                    "text" | "final_text" => {
                        for event in events("partial", "partial text").into_iter().take(if mode == "text" {3} else {4}) {
                            socket.send(Message::Text(event.to_string().into())).await.unwrap();
                        }
                    }
                    "local_intent" => {
                        socket.send(Message::Text(json!({"type":"response.output_item.done","item":{"type":"function_call","id":"intent","call_id":"unaccepted","name":"echo","arguments":"{}"}}).to_string().into())).await.unwrap();
                    }
                    "provider_effect" => {
                        socket.send(Message::Text(json!({"type":"response.future_call.in_progress"}).to_string().into())).await.unwrap();
                    }
                    _ => {}
                }
                if idle {
                    assert!(socket.next().await.is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_)))), "timeout must release the original socket");
                    assert!(listener.accept().now_or_never().is_none(), "transport itself never replays");
                    return;
                }
                if mode == "reset" {
                    socket.get_ref().set_zero_linger().unwrap();
                    return;
                }
                socket.send(Message::Close(Some(CloseFrame {
                    code: match mode { "policy" => CloseCode::Policy, "size" => CloseCode::Size, _ => CloseCode::Restart },
                    reason: if mode == "policy" { "request refused" } else { "provider restarting" }.into(),
                }))).await.unwrap();
                let _ = socket.next().await;
                if mode == "size" {
                    http_ok(&listener).await;
                    http_ok(&listener).await;
                } else {
                    assert!(listener.accept().now_or_never().is_none(), "transport itself never replays");
                }
            });
            let executor = ModelExecutor::new(if idle { Duration::from_millis(150) } else { Duration::from_secs(5) }).unwrap();
            let lane = Conversation::default();
            assert!(!lane.try_switch_fallback_transport());
            let input = || {
                let mut input = request(&base, "interrupted");
                if mode == "size" || idle { input.provider.adapter = Some(maka_providers::codex::ADAPTER.into()); }
                input
            };
            let mut stream = executor.stream_in_conversation(input(), CancellationToken::new(), Some(lane.clone())).await.unwrap();
            let mut failure = None;
            while let Some(event) = stream.next().await {
                if let Err(error) = event { failure = Some(error); break; }
            }
            stream.cancel_and_wait().await.expect("actual stream cleanup");
            let failure = failure.expect("interrupted request must not fabricate completion");
            if mode == "policy" {
                assert!(matches!(&failure, ModelError::Adapter(message) if message.contains("1008") && message.contains("request refused")), "{failure}");
            } else {
                let ModelError::Provider(failure) = failure else { panic!("{failure}"); };
                assert_eq!(failure.reason(), if idle { ProviderFailureReason::TimedOut } else { ProviderFailureReason::StreamTruncated });
                assert_eq!(failure.replay_safe(), matches!(mode, "empty" | "text" | "size" | "reset"));
                assert_eq!(failure.retained_output_safe(), mode != "provider_effect");
                if idle {
                    assert!(failure.message().contains("idle timeout"));
                } else if mode != "reset" {
                    assert!(failure.to_string().contains(if mode == "size" {"1009"} else {"1012"}) && failure.to_string().contains("provider restarting"), "{failure}");
                }
            }
            if mode == "size" {
                // The retry owner chooses fallback, including through the
                // subscription wrapper. Selection is one-way and route scoped.
                assert!(lane.try_switch_fallback_transport());
                assert!(!lane.try_switch_fallback_transport());
                generate(&executor, &lane, input()).await;
                generate(&executor, &Conversation::default(), input()).await;
            }
            server.await.unwrap();
        }
    }).await.unwrap();
}
