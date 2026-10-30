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
use futures_util::{StreamExt, future::BoxFuture};
use maka_agent_ports::model::{Connect, Credentials, Events, Provider, Socket, Transport};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};

struct NoEvents;
impl Events for NoEvents {
    fn emit(&self, _: Emission) -> BoxFuture<'_, Result<(), ModelError>> {
        Box::pin(async { panic!("a rejected request must not emit model output") })
    }
}
struct FixtureBody {
    bytes: Mutex<Option<Vec<u8>>>,
    closed: AtomicBool,
}
impl http::Body for FixtureBody {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async { Ok(self.bytes.lock().unwrap().take()) })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
}
struct QuotaTransport {
    body: Arc<FixtureBody>,
    attempts: AtomicUsize,
    advice: bool,
}
impl Transport for QuotaTransport {
    fn identity(&self) -> u64 {
        1
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
        Box::pin(async { panic!("HTTP quota fixture must not open a WebSocket") })
    }
    fn request(
        &self,
        request: http::Request,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
        Box::pin(async move {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            let mut source = request.body.into_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = source.next().await {
                bytes.extend_from_slice(&chunk.unwrap());
            }
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["model"], "quota-fixture");
            let mut headers = vec![("content-type".into(), b"application/json".to_vec())];
            if self.advice {
                headers.push(("retry-after".into(), b"18000".to_vec()));
            }
            Ok(http::Response {
                head: http::Head {
                    status: 429,
                    url: request.url,
                    headers,
                },
                body: self.body.clone(),
            })
        })
    }
}

#[tokio::test(start_paused = true)]
async fn compatible_gateway_quota_and_throttle_semantics_do_not_depend_on_origin() {
    use crate::{ProviderFailureReason, ProviderKind};
    use serde_json::json;
    for (base, kind) in [
        (
            "https://gateway.fixture.invalid/team",
            ProviderKind::OpenaiCompatible {
                name: "provider".into(),
            },
        ),
        (
            "https://another.fixture.invalid/messages",
            ProviderKind::Anthropic,
        ),
    ] {
        for (code, message, reason) in [
            (
                "insufficient_quota",
                "account capacity exhausted; reset time is unspecified",
                ProviderFailureReason::QuotaExhausted,
            ),
            (
                "1308",
                "Usage limit reached for tokens per minute",
                ProviderFailureReason::RateLimit,
            ),
            (
                "token_quota_exceeded",
                "Usage limit for this short window; try again",
                ProviderFailureReason::RateLimit,
            ),
            (
                "quota_exceeded",
                "token-per-minute quota exceeded",
                ProviderFailureReason::RateLimit,
            ),
        ] {
            for advice in [false, true] {
                let before = crate::ProviderFailure::now_unix_ms();
                let body = Arc::new(FixtureBody {
                    bytes: Mutex::new(Some(
                        json!({"error":{"type":"rate_limit_error","code":code,"message":message}})
                            .to_string()
                            .into_bytes(),
                    )),
                    closed: AtomicBool::new(false),
                });
                let transport = Arc::new(QuotaTransport {
                    body: body.clone(),
                    attempts: AtomicUsize::new(0),
                    advice,
                });
                let context = Context {
                    transport: transport.clone(),
                    events: Arc::new(NoEvents),
                    cancellation: CancellationToken::new(),
                    idle_timeout: Duration::from_secs(10),
                };
                let start = tokio::time::Instant::now();
                let error = run(
                    Request {
                        language: Default::default(),
                        provider: Provider {
                            kind: kind.clone(),
                            model: "quota-fixture".into(),
                            base_url: base.into(),
                            auth: Credentials::ApiKey("fixture-key".into()),
                            headers: BTreeMap::new(),
                            body_overlay: None,
                        },
                        prompt: vec![crate::prompt::Message::user("hello")].into(),
                        tools: vec![],
                        provider_options: json!({}),
                        max_output_tokens: None,
                    },
                    &context,
                    Arc::new(Shared::default()),
                )
                .await
                .unwrap_err();
                let after = crate::ProviderFailure::now_unix_ms();
                let ModelError::Provider(failure) = error else {
                    panic!("provider classification lost: {error}")
                };
                assert_eq!(failure.reason(), reason);
                assert_eq!(failure.message(), message);
                assert_eq!(failure.code(), Some(code));
                assert_eq!(failure.status(), Some(429));
                match failure.retry_at_unix_ms() {
                    Some(at) => {
                        assert!(advice);
                        assert!((before + 18_000_000..=after + 18_000_000).contains(&at));
                    }
                    None => assert!(!advice),
                }
                assert_eq!(
                    failure.retryable(),
                    reason == ProviderFailureReason::RateLimit
                );
                assert_eq!(transport.attempts.load(Ordering::SeqCst), 1);
                assert!(
                    body.closed.load(Ordering::SeqCst),
                    "error response must release its transport"
                );
                assert_eq!(
                    start.elapsed(),
                    Duration::ZERO,
                    "classification must not sleep until reset"
                );
            }
        }
    }
}
