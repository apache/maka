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

use super::{provider_compatible::body as read_body, provider_stream::request};
use maka_model::{ModelError, ModelExecutor, ProviderKind};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpListener};
use tokio_util::sync::CancellationToken;

async fn failure(kind: ProviderKind, status: u16, content_type: &str, body: String) -> ModelError {
    failure_with_headers(kind, status, content_type, body, &[]).await
}

async fn failure_with_headers(
    kind: ProviderKind,
    status: u16,
    content_type: &str,
    body: String,
    extra_headers: &[(&str, &str)],
) -> ModelError {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let extra_headers: String = extra_headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let content_type = if content_type.is_empty() {
        String::new()
    } else {
        format!("Content-Type: {content_type}\r\n")
    };
    let headers = format!(
        "HTTP/1.1 {status} Fixture\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n",
        body.len()
    );
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_body(&mut socket).await;
        socket.write_all(headers.as_bytes()).await.unwrap();
        socket.write_all(body.as_bytes()).await.unwrap();
        listener
    });
    let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
    let mut stream = executor
        .stream(request(kind, base), CancellationToken::new())
        .await
        .unwrap();
    let error = loop {
        match stream.next().await {
            Some(Ok(_)) => {}
            Some(Err(error)) => break error,
            None => panic!("provider failure was lost"),
        }
    };
    stream
        .cancel_and_wait()
        .await
        .expect("actual stream cleanup");
    let listener = server.await.unwrap();
    // No retry belongs to this boundary, even for a recoverable rejection.
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    error
}

fn sse(parts: &[Value]) -> String {
    parts
        .iter()
        .map(|part| format!("data: {part}\n\n"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_unexpected_http_body_preserves_diagnostics_without_replaying() {
    for (status, content_type, body, detail) in [
        (
            200,
            "",
            json!({"error":{"message":"untyped response"}}).to_string(),
            "missing Content-Type",
        ),
        (
            200,
            "application/json",
            json!({"detail":"gateway rejected the request body"}).to_string(),
            "gateway rejected the request body",
        ),
        (
            200,
            "text/html",
            "<html>private-page-content</html>".into(),
            "text/html",
        ),
        (
            400,
            "application/json",
            json!({"detail":"PRIVATE_PROVIDER_BODY_SENTINEL"}).to_string(),
            "PRIVATE_PROVIDER_BODY_SENTINEL",
        ),
        (
            700,
            "application/json",
            json!({"detail":"PRIVATE_PROVIDER_BODY_SENTINEL"}).to_string(),
            "invalid model HTTP failure status",
        ),
    ] {
        let error = failure(ProviderKind::OpenaiResponses, status, content_type, body).await;
        if status == 400 {
            assert!(matches!(&error, ModelError::Http { status: 400, .. }));
            assert!(!error.to_string().contains(detail));
            continue;
        }
        let ModelError::Adapter(message) = error else {
            panic!("unexpected response must remain a terminal protocol failure");
        };
        if status == 700 {
            assert_eq!(message, detail);
            continue;
        }
        assert!(message.contains(&format!("HTTP {status}")), "{message}");
        assert!(message.contains(detail), "{message}");
        assert!(!message.contains("private-page-content"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_and_sse_failures_preserve_typed_evidence_across_native_families() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiResponses,
            ProviderKind::OpenaiCompatible { name: "fixture".into() }, ProviderKind::Anthropic] {
            let anthropic = matches!(kind, ProviderKind::Anthropic);
            let error = if anthropic {
                json!({"type":"invalid_request_error","message":"prompt is too long: 200001 tokens > 200000 maximum"})
            } else {
                json!({"type":"invalid_request_error","code":"context_length_exceeded","message":"input rejected"})
            };
            let http = json!({"type":"error","error":error});
            assert!(matches!(failure(kind.clone(),400,"application/json",http.to_string()).await,
                ModelError::ContextOverflow { observed_output: false }));
            let frame = if matches!(kind, ProviderKind::OpenaiResponses) {
                json!({"type":"response.failed","sequence_number":0,"response":{"error":{"code":"context_length_exceeded","message":"input rejected"}}})
            } else { http };
            assert!(matches!(failure(kind,200,"text/event-stream",sse(&[frame])).await,
                ModelError::ContextOverflow { observed_output: false }));
        }
        for body in [json!({"error":{"message":"context length rejected"}}).to_string(), String::new()] {
            assert!(matches!(failure(ProviderKind::OpenaiChatCompletions,413,"application/json",body).await,ModelError::Http { status: 413, .. }));
        }
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiResponses,
            ProviderKind::OpenaiCompatible { name: "fixture".into() }, ProviderKind::Anthropic] {
        for (status, header, reason) in [
            (503, None, Some(maka_model::ProviderFailureReason::ProviderUnavailable)),
            (503, Some("invalid"), Some(maka_model::ProviderFailureReason::ProviderUnavailable)),
            (429, None, Some(maka_model::ProviderFailureReason::RateLimit)),
            (429, Some("0.01"), Some(maka_model::ProviderFailureReason::RateLimit)),
            (401, Some("0.01"), None),
        ] {
            let headers: Vec<_> = header.map(|value| ("Retry-After", value)).into_iter().collect();
            let before = maka_model::ProviderFailure::now_unix_ms();
            let result = failure_with_headers(kind.clone(), status, "application/json",
                json!({"error":{"message":"temporary fixture"}}).to_string(), &headers).await;
            match (reason, result) {
                (Some(reason), ModelError::Provider(failure)) => {
                    assert_eq!(failure.reason(), reason);
                    assert_eq!(failure.message(), "temporary fixture");
                    assert!(failure.replay_safe());
                    match failure.retry_at_unix_ms() {
                        Some(at) => { assert_eq!(header, Some("0.01")); assert!((before + 10..=maka_model::ProviderFailure::now_unix_ms() + 10).contains(&at)); },
                        None => assert_ne!(header, Some("0.01")),
                    }
                }
                (None, ModelError::Http { status: 401, .. }) => {}
                (_, result) => panic!("unexpected failure classification: {result}"),
            }
        }
        }
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiCompatible { name: "fixture".into() }] {
            let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model",
                "choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]});
            let error = failure(kind, 200, "text/event-stream", sse(&[chunk])).await;
            assert!(matches!(error, ModelError::Provider(failure)
                if failure.reason() == maka_model::ProviderFailureReason::StreamTruncated && failure.replay_safe()));
        }
    }).await.expect("bounded adapter error classification");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn text_and_unfinished_tool_input_make_overflow_non_replayable() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for (kind, delta) in [
            (ProviderKind::OpenaiChatCompletions,json!({"role":"assistant","content":"already visible"})),
            (ProviderKind::OpenaiCompatible{name:"fixture".into()},json!({"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"echo","arguments":"{"}}]})),
        ] {
            let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
            let error = json!({"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"input rejected"}});
            assert!(matches!(failure(kind,200,"text/event-stream",sse(&[chunk,error])).await,
                ModelError::ContextOverflow { observed_output: true }));
        }
    }).await.expect("partial output must retain its failure classification");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_diagnostics_preserve_only_structured_messages_across_native_families() {
    for kind in [
        ProviderKind::OpenaiChatCompletions,
        ProviderKind::OpenaiResponses,
        ProviderKind::OpenaiCompatible {
            name: "fixture".into(),
        },
        ProviderKind::Anthropic,
    ] {
        for (body, expected_message) in [
            (json!({"error":{"type":"invalid_request_error","message":"unsupported tool choice"}, "private":"raw body sentinel"}).to_string(), Some("unsupported tool choice")),
            (json!({"message":"invalid model parameter"}).to_string(), Some("invalid model parameter")),
            (json!({"detail":"raw body sentinel"}).to_string(), None),
            ("<html>raw body sentinel</html>".into(), None),
        ] {
            let error = failure(kind.clone(), 400, "application/json", body).await;
            assert_eq!(error.failure_cause(), Some(maka_agent_facts::model::error::ModelFailureCause::Http { status: 400 }));
            let expected = expected_message.map_or_else(|| "model HTTP request failed (status 400)".to_owned(), |message| format!("model HTTP request failed (status 400): {message}"));
            assert_eq!(error.to_string(), expected, "{kind:?}");
            let ModelError::Http { message, .. } = error else { panic!("HTTP rejection must remain terminal") };
            assert_eq!(message.as_deref(), expected_message);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn anthropic_stream_rejection_keeps_its_structured_message_with_extension_data() {
    let error = failure(
        ProviderKind::Anthropic,
        200,
        "text/event-stream",
        sse(&[json!({"type":"error","error":{"type":"invalid_request_error","message":"unsupported tool choice","data":null}})]),
    ).await;
    assert_eq!(
        error.to_string(),
        "model adapter failed: unsupported tool choice"
    );
    assert_eq!(
        error.failure_cause(),
        Some(maka_agent_facts::model::error::ModelFailureCause::Adapter)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_advice_survives_all_http_adapter_families() {
    for kind in [
        ProviderKind::OpenaiChatCompletions,
        ProviderKind::OpenaiResponses,
        ProviderKind::OpenaiCompatible {
            name: "fixture".into(),
        },
        ProviderKind::Anthropic,
    ] {
        for (name, value, expected) in [
            ("Retry-After", "18000", Duration::from_secs(18_000)),
            ("Retry-After-Ms", "18000000", Duration::from_secs(18_000)),
            ("Retry-After", "2592000", Duration::from_secs(2_592_000)),
        ] {
            let before = maka_model::ProviderFailure::now_unix_ms();
            let error = failure_with_headers(
                kind.clone(),
                429,
                "application/json",
                json!({"error":{"message":"quota reset is later"}}).to_string(),
                &[(name, value)],
            )
            .await;
            let ModelError::Provider(failure) = error else {
                panic!("rate-limit evidence lost: {error}")
            };
            assert_eq!(
                failure.reason(),
                maka_model::ProviderFailureReason::RateLimit
            );
            let at = failure.retry_at_unix_ms().expect("known advice preserved");
            let delay = expected.as_millis() as u64;
            assert!(
                (before + delay..=maka_model::ProviderFailure::now_unix_ms() + delay).contains(&at)
            );
            assert_eq!(failure.message(), "quota reset is later");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_rate_limit_body_cannot_erase_retry_advice() {
    use tokio::io::AsyncReadExt;
    tokio::time::timeout(Duration::from_secs(10), async {
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiResponses,
            ProviderKind::OpenaiCompatible { name: "fixture".into() }, ProviderKind::Anthropic] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_body(&mut socket).await;
                socket.write_all(b"HTTP/1.1 429 Fixture\r\nContent-Type: application/json\r\nRetry-After: 18000\r\nContent-Length: 100\r\nConnection: close\r\n\r\n").await.unwrap();
                assert_eq!(socket.read(&mut [0; 1]).await.unwrap(), 0, "idle timeout closes rejected HTTP transport");
            });
            let executor = ModelExecutor::new(Duration::from_millis(150)).unwrap();
            let before = maka_model::ProviderFailure::now_unix_ms();
            let mut stream = executor.stream(request(kind, base), CancellationToken::new()).await.unwrap();
            let error = loop {
                match stream.next().await.expect("rejection must produce a terminal error") {
                    Ok(_) => {}, Err(error) => break error,
                }
            };
            stream.cancel_and_wait().await.unwrap();
            server.await.unwrap();
            let ModelError::Provider(failure) = error else { panic!("explicit 429 was lost: {error}") };
            assert_eq!(failure.reason(), maka_model::ProviderFailureReason::RateLimit);
            let at = failure.retry_at_unix_ms().expect("known header deadline preserved");
            assert!((before + 18_000_000..=maka_model::ProviderFailure::now_unix_ms() + 18_000_000).contains(&at));
        }
    }).await.expect("all stalled rejections must settle and physically close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn equivalent_http_and_sse_errors_share_categories_without_promoting_transport_status() {
    use maka_model::ProviderFailureReason;
    for kind in [
        ProviderKind::OpenaiChatCompletions,
        ProviderKind::OpenaiResponses,
        ProviderKind::OpenaiCompatible {
            name: "arbitrary-gateway".into(),
        },
        ProviderKind::Anthropic,
    ] {
        for (code, message, reason) in [
            (
                "insufficient_quota",
                "account quota exhausted; reset timezone unspecified",
                ProviderFailureReason::QuotaExhausted,
            ),
            (
                "rate_limit_exceeded",
                "short-window tokens/minute usage limit",
                ProviderFailureReason::RateLimit,
            ),
            (
                "1308",
                "private code collision: short-window usage limit",
                ProviderFailureReason::RateLimit,
            ),
        ] {
            for sse_response in [false, true] {
                let body = json!({"type":"error","error":{"type":"rate_limit_error","code":code,"message":message,"isRetryable":true}});
                let body = if sse_response && matches!(kind, ProviderKind::OpenaiResponses) {
                    sse(&[json!({"type":"response.failed","response":{"error":body["error"]}})])
                } else if sse_response {
                    sse(&[body])
                } else {
                    body.to_string()
                };
                let before = maka_model::ProviderFailure::now_unix_ms();
                let error = failure_with_headers(
                    kind.clone(),
                    if sse_response { 200 } else { 429 },
                    if sse_response {
                        "text/event-stream"
                    } else {
                        "application/json"
                    },
                    body,
                    &[("Retry-After", "18000")],
                )
                .await;
                let ModelError::Provider(failure) = error else {
                    panic!("shared category lost: {error}")
                };
                assert_eq!(failure.reason(), reason);
                assert_eq!(failure.message(), message);
                assert_eq!(failure.code(), Some(code));
                assert_eq!(
                    failure.status(),
                    if sse_response { None } else { Some(429) }
                );
                assert_eq!(
                    failure.retryable(),
                    reason == ProviderFailureReason::RateLimit
                );
                assert!(failure.replay_safe());
                let at = failure
                    .retry_at_unix_ms()
                    .expect("HTTP advice survives application error envelope");
                assert!(
                    (before + 18_000_000..=maka_model::ProviderFailure::now_unix_ms() + 18_000_000)
                        .contains(&at)
                );
            }
        }
        for code in [
            "request_too_large",
            "invalid_image",
            "unrecognized_gateway_code",
        ] {
            let error = failure(
                kind.clone(),
                400,
                "application/json",
                json!({"error":{"code":code,"message":"unsupported request or image"}}).to_string(),
            )
            .await;
            assert!(
                match &error {
                    ModelError::ImageInputRejected {
                        status: Some(400),
                        code: Some(actual),
                        ..
                    } => code == "invalid_image" && actual == code,
                    ModelError::Http { status: 400, .. } => code != "invalid_image",
                    _ => false,
                },
                "payload/image evidence cannot authorize token compaction: {error}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn json_error_envelopes_classify_independently_of_success_or_payment_transport_status() {
    use maka_model::ProviderFailureReason;
    for kind in [
        ProviderKind::OpenaiChatCompletions,
        ProviderKind::OpenaiResponses,
        ProviderKind::OpenaiCompatible {
            name: "proxy".into(),
        },
        ProviderKind::Anthropic,
    ] {
        for status in [200, 402] {
            for code in ["insufficient_quota", "insufficient_balance"] {
                let before = maka_model::ProviderFailure::now_unix_ms();
                let error = failure_with_headers(kind.clone(), status, "application/json",
                    json!({"error":{"code":code,"message":"account quota exhausted; reset timezone unspecified"}}).to_string(),
                    &[("Retry-After", "18000")]).await;
                let ModelError::Provider(failure) = error else {
                    panic!("positive quota envelope was lost: {error}")
                };
                assert_eq!(failure.reason(), ProviderFailureReason::QuotaExhausted);
                assert_eq!(failure.code(), Some(code));
                assert_eq!(failure.status(), Some(status));
                assert!(!failure.retryable());
                let at = failure
                    .retry_at_unix_ms()
                    .expect("known timing must remain independent");
                assert!(
                    (before + 18_000_000..=maka_model::ProviderFailure::now_unix_ms() + 18_000_000)
                        .contains(&at)
                );
            }
        }
        for code in [
            None,
            Some("rate_limit_error"),
            Some("rate_limit_exceeded"),
            Some("server_error"),
        ] {
            let error = failure_with_headers(
                kind.clone(),
                402,
                "application/json",
                json!({"error":{"code":code,"message":"payment required"}}).to_string(),
                &[("Retry-After", "18000")],
            )
            .await;
            assert!(
                matches!(error, ModelError::Http { status: 402, message: Some(ref message) } if message == "payment required"),
                "ordinary 402 must stay terminal despite transient code {code:?}: {error}"
            );
        }
        for status in [401, 403] {
            let error = failure(
                kind.clone(),
                status,
                "application/json",
                json!({"error":{"code":"insufficient_quota","message":"authorization refused"}})
                    .to_string(),
            )
            .await;
            assert!(
                matches!(error, ModelError::Http { status: actual, message: Some(ref message) } if actual == status && message == "authorization refused")
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sse_retry_deadline_survives_eof_network_reset_and_idle_timeout() {
    use futures_util::FutureExt;
    use maka_model::ProviderFailureReason;
    use tokio::io::AsyncReadExt;
    tokio::time::timeout(Duration::from_secs(15), async {
        for kind in [ProviderKind::OpenaiChatCompletions, ProviderKind::OpenaiResponses,
            ProviderKind::OpenaiCompatible { name: "proxy".into() }, ProviderKind::Anthropic] {
            for (mode, reason) in [("eof", ProviderFailureReason::StreamTruncated),
                ("reset", ProviderFailureReason::Network), ("idle", ProviderFailureReason::TimedOut)] {
                let start = if matches!(kind, ProviderKind::OpenaiResponses) {
                    json!({"type":"response.created","response":{"id":"sse-deadline"}})
                } else if matches!(kind, ProviderKind::Anthropic) {
                    json!({"type":"message_start","message":{"id":"sse-deadline","type":"message","role":"assistant","model":"test-model","content":[],"usage":{"input_tokens":1,"output_tokens":0}}})
                } else {
                    json!({"id":"sse-deadline","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":null}]})
                };
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}/v1", listener.local_addr().unwrap());
                let (accepted, application_observed) = tokio::sync::oneshot::channel();
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    read_body(&mut socket).await;
                    socket.write_all(b"HTTP/1.1 200 Fixture\r\nContent-Type: text/event-stream\r\nRetry-After: Tue, 01 Jan 2030 05:00:00 GMT\r\nConnection: close\r\n\r\n").await.unwrap();
                    socket.write_all(sse(&[start]).as_bytes()).await.unwrap();
                    application_observed.await.unwrap();
                    if mode == "reset" { socket.set_zero_linger().unwrap(); }
                    if mode == "idle" {
                        assert_eq!(socket.read(&mut [0; 1]).await.unwrap(), 0, "idle cancellation physically closes the stream");
                    }
                    drop(socket);
                    listener
                });
                let executor = ModelExecutor::new(Duration::from_millis(150)).unwrap();
                let mut stream = executor.stream(request(kind.clone(), base), CancellationToken::new()).await.unwrap();
                let first = stream.next().await.expect("metadata before failure").expect("peer waits for metadata delivery");
                assert!(matches!(first.event, maka_model::ModelEvent::ResponseMetadata { .. }));
                accepted.send(()).unwrap();
                let error = loop { match stream.next().await.expect("SSE failure must settle") { Ok(_) => {}, Err(error) => break error } };
                stream.cancel_and_wait().await.unwrap();
                let listener = server.await.unwrap();
                assert!(listener.accept().now_or_never().is_none(), "adapter must not send hidden retries");
                let ModelError::Provider(failure) = error else { panic!("retryable stream failure lost: {error}") };
                assert_eq!(failure.reason(), reason, "{kind:?}/{mode}");
                assert_eq!(failure.retry_at_unix_ms(), Some(1_893_474_000_000), "all stream exits must preserve the received deadline");
                assert!(failure.retryable());
            }
        }
    }).await.expect("stream interruptions must settle without waiting until their retry deadline");
}
