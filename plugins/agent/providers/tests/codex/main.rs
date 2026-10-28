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

use futures_util::{StreamExt, future::BoxFuture};
use maka_agent_ports::model::Connect;
use maka_agent_ports::model::Credentials;
use maka_agent_ports::model::Error as ModelError;
use maka_agent_ports::model::Socket;
use maka_agent_ports::model::Transport;
use maka_agent_ports::provider::Connection;
use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Error;
use maka_agent_ports::provider::Provider;
use maka_agent_ports::provider::Resolve;
use maka_agent_ports::provider::authentication::Credential;
use maka_capabilities::http;
use maka_providers::codex::Codex;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

mod inventory;

struct CapturedRequest {
    url: String,
    body: Vec<u8>,
}
impl CapturedRequest {
    async fn read(request: http::Request) -> Self {
        let mut chunks = request.body.into_stream();
        let mut body = Vec::new();
        while let Some(chunk) = chunks.next().await {
            body.extend_from_slice(&chunk.unwrap());
        }
        Self {
            url: request.url,
            body,
        }
    }
}
struct Exchange {
    started: Notify,
    release: Notify,
    requests: Mutex<Vec<CapturedRequest>>,
    fail: bool,
    response: serde_json::Value,
    status: u16,
}
impl Transport for Exchange {
    fn identity(&self) -> u64 {
        1
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
        Box::pin(async move {
            let request = CapturedRequest::read(request).await;
            self.requests.lock().unwrap().push(request);
            self.started.notify_one();
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
                _ = self.release.notified() => {}
            }
            if self.fail {
                return Err(ModelError::Adapter("reply lost".into()));
            }
            Ok(http::Response {
                head: http::Head {
                    status: self.status,
                    url: "https://auth.openai.com/oauth/token".into(),
                    headers: vec![],
                },
                body: Arc::new(Body(Mutex::new(Some(
                    serde_json::to_vec(&self.response).unwrap(),
                )))),
            })
        })
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
        Box::pin(async { Err(ModelError::Adapter("unexpected WebSocket".into())) })
    }
}
struct Body(Mutex<Option<Vec<u8>>>);
impl http::Body for Body {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async { Ok(self.0.lock().unwrap().take()) })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async { Ok(()) })
    }
}
fn connection() -> Connection {
    Connection {
        id: "connection".into(),
        revision: 1,
        configuration: json!({"baseUrl":"https://chatgpt.com/backend-api/codex"}),
    }
}
fn credential() -> Credential {
    Credential {
        secret: json!({
            "access_token":"old-access","refresh_token":"old+refresh/= &value","expires_at":1,"id_token":null,
        }).to_string(),
        refresh_at: Some(0),
    }
}

struct UnexpectedPresentation;
impl maka_agent_ports::provider::authentication::Interaction for UnexpectedPresentation {
    fn open_external(&self, _: String, _: Option<String>) -> BoxFuture<'_, Result<(), Error>> {
        panic!("a rejected device-code request must not open authorization")
    }
}

#[tokio::test]
async fn device_login_preserves_region_and_http_failures_without_echoing_response_secrets() {
    for (status, code) in [
        (403, "unsupported_country_region_territory"),
        (403, "access_denied"),
        (429, "rate_limit_exceeded"),
        (503, "unavailable"),
    ] {
        let transport = Arc::new(Exchange {
            started: Notify::new(),
            release: Notify::new(),
            requests: Mutex::new(vec![]),
            fail: false,
            status,
            response: json!({"error":{
                "code":code,
                "message":"do-not-echo-secret\u{1b}[2J",
                "refresh_token":"do-not-echo-secret"
            }}),
        });
        transport.release.notify_one();
        let error = Codex
            .authenticate(
                maka_agent_ports::provider::authentication::Authenticate {
                    connection: connection(),
                    method: "chatgpt".into(),
                    input: json!({}),
                },
                Context {
                    transport: transport.clone(),
                    cancellation: CancellationToken::new(),
                    interaction: Some(Arc::new(UnexpectedPresentation)),
                },
            )
            .await
            .err()
            .expect("the login service rejected the request");
        assert!(matches!(&error, Error::Rejected(message) if message.contains("ChatGPT")));
        if code == "unsupported_country_region_territory" {
            assert!(error.to_string().contains(code));
        }
        assert!(error.to_string().contains(&status.to_string()));
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("do-not-echo")
        );
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn sent_refresh_settles_after_cancellation_and_unknown_reply_is_never_retried() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for fail in [false, true] {
            let binding = Codex.definition().unwrap();
            let transport = Arc::new(Exchange {
                started: Notify::new(),
                release: Notify::new(),
                requests: Mutex::new(vec![]),
                fail,
                status: 200,
                response: json!({
                    "access_token": "replacement-access",
                    "refresh_token": "replacement-refresh",
                    "expires_in": 3600,
                }),
            });
            let cancellation = CancellationToken::new();
            let context = Context {
                transport: transport.clone(),
                cancellation: cancellation.clone(),
                interaction: None,
            };
            let running = binding.prepare_refresh(connection(), credential()).unwrap();
            let refresh = tokio::spawn(async move { running.run(context).await });
            transport.started.notified().await;
            cancellation.cancel();
            transport.release.notify_one();
            let result = refresh.await.unwrap();
            if fail {
                assert!(matches!(result, Err(Error::OutcomeUnknown)));
            } else {
                let replacement = result.unwrap();
                assert!(replacement.refresh_at.is_some_and(|at| at > 0));
                let secret: serde_json::Value = serde_json::from_str(&replacement.secret).unwrap();
                assert_eq!(secret["refresh_token"], "replacement-refresh");
                let Credentials::RequestHeaders(headers) = binding
                    .authorize(connection(), Some(replacement), "session".into())
                    .await
                    .unwrap()
                else {
                    panic!("provider must prepare protocol-neutral credentials")
                };
                assert_eq!(headers["authorization"], "Bearer replacement-access");
                assert_eq!(headers["session_id"], "session");
            }
            let requests = transport.requests.lock().unwrap();
            assert_eq!(
                requests.len(),
                1,
                "uncertain rotating grants cannot be retried"
            );
            assert_eq!(requests[0].url, "https://auth.openai.com/oauth/token");
            let form: std::collections::HashMap<_, _> =
                url::form_urlencoded::parse(&requests[0].body)
                    .into_owned()
                    .collect();
            assert_eq!(form["grant_type"], "refresh_token");
            assert_eq!(form["refresh_token"], "old+refresh/= &value");
        }
    })
    .await
    .unwrap();
}
