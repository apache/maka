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
        assert!(matches!(failure(ProviderKind::OpenaiChatCompletions,413,"application/json",
            json!({"error":{"message":"context length rejected"}}).to_string()).await,ModelError::Http { status: 413, .. }));
        for status in [400, 413] {
            assert!(matches!(failure(ProviderKind::OpenaiChatCompletions,status,"application/json",String::new()).await,
                ModelError::ContextOverflow { observed_output: false }));
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
        let empty_auth = failure(kind.clone(), 401, "application/json", String::new()).await;
        assert_eq!(
            empty_auth.to_string(),
            "model HTTP request failed (status 401)"
        );
        assert!(matches!(
            empty_auth,
            ModelError::Http {
                status: 401,
                message: None
            }
        ));
    }
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
async fn compatible_provider_evidence_recovers_overflow_without_mistaking_throttling_or_parameters()
{
    for body in [
        json!({"error":{"message":"Input token count 200001 exceeds the maximum 200000"}})
            .to_string(),
        json!({"error":{"type":"api_error","message":"prompt is too long: 205000 tokens > 200000 maximum"}})
            .to_string(),
        json!({"error":{"message":"upstream rejected", "metadata":{"raw":"Prompt 超长"}}})
            .to_string(),
        json!({"response":{"error":{"type":"model_context_window_exceeded"}}}).to_string(),
        json!({"error":{"innererror":{"code":"context_length_exceeded"}}}).to_string(),
        json!({"error":{"message":"prompt is too long"},"metadata":"x".repeat(70_000)}).to_string(),
    ] {
        let error = failure(
            ProviderKind::OpenaiCompatible {
                name: "fixture".into(),
            },
            400,
            "application/json",
            body,
        )
        .await;
        assert!(
            matches!(
                error,
                ModelError::ContextOverflow {
                    observed_output: false
                }
            ),
            "{error}"
        );
    }
    for kind in [
        ProviderKind::OpenaiCompatible {
            name: "fixture".into(),
        },
        ProviderKind::OpenaiResponses,
    ] {
        let envelope =
            json!({"error":{"message":"Input token count 200001 exceeds the maximum 200000"}})
                .to_string();
        assert!(matches!(
            failure(kind.clone(), 200, "application/json", envelope).await,
            ModelError::ContextOverflow {
                observed_output: false
            }
        ));
        let non_error = json!({"id":"reply","error":null,"choices":[{"message":{"role":"assistant","content":"prompt is too long"}}]}).to_string();
        assert!(matches!(
            failure(kind, 200, "application/json", non_error).await,
            ModelError::Adapter(_)
        ));
    }
    let sse_rate_limit = failure(
        ProviderKind::Anthropic,
        200,
        "text/event-stream",
        sse(&[json!({"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your token limit (too many tokens)."}})]),
    )
    .await;
    assert!(
        matches!(sse_rate_limit, ModelError::Provider(ref failure) if failure.reason() == maka_model::ProviderFailureReason::RateLimit),
        "{sse_rate_limit}"
    );
    let image = failure(
        ProviderKind::OpenaiCompatible {
            name: "fixture".into(),
        },
        400,
        "application/json",
        json!({"error":{"innererror":{"code":"image_size_exceeded"},"message":"Image exceeds the limit of 5242880 bytes"}}).to_string(),
    )
    .await;
    assert!(
        matches!(image, ModelError::ImageInputRejected { code: Some(ref code), .. } if code == "image_size_exceeded"),
        "{image}"
    );
    let quota = failure(
        ProviderKind::OpenaiCompatible {
            name: "fixture".into(),
        },
        400,
        "application/json",
        json!({"error":{"code":"insufficient_quota","message":"Billing quota: token limit exceeded"}}).to_string(),
    )
    .await;
    assert!(
        matches!(quota, ModelError::Provider(ref failure) if failure.reason() == maka_model::ProviderFailureReason::QuotaExhausted),
        "{quota}"
    );
    for (status, body, throttled) in [
        (
            429,
            json!({"error":{"message":"too many tokens per day, please wait"}}),
            true,
        ),
        (
            400,
            json!({"__type":"aws#ThrottlingException", "message":"too many tokens"}),
            true,
        ),
        (
            400,
            json!({"error":{"message":"max_tokens must be less than 8192"}}),
            false,
        ),
        (
            400,
            json!({"error":{"message":"invalid request parameter"}}),
            false,
        ),
    ] {
        let error = failure(
            ProviderKind::OpenaiChatCompletions,
            status,
            "application/json",
            body.to_string(),
        )
        .await;
        if throttled {
            assert!(
                matches!(error, ModelError::Provider(ref failure) if failure.reason() == maka_model::ProviderFailureReason::RateLimit),
                "{error}"
            );
        } else {
            assert!(
                matches!(error, ModelError::Http { status: 400, .. }),
                "{error}"
            );
        }
    }
}
