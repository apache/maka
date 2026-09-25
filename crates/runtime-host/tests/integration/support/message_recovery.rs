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

use super::client_probe::ClientFixture;
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use maka_config::ConfigurationStore;
use maka_runtime::configuration::*;
use maka_runtime_host::session::SessionModel;
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    task::{JoinHandle, JoinSet},
};

pub struct Provider {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<Value>>>,
    worker: JoinHandle<()>,
}

pub struct ModelRequest {
    pub body: Value,
    pub reply: oneshot::Sender<Value>,
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.worker.abort();
    }
}
impl Provider {
    pub async fn start() -> Self {
        Self::serve(None, None).await
    }

    pub async fn controlled() -> (Self, mpsc::Receiver<ModelRequest>) {
        let (send, receive) = mpsc::channel(1);
        (Self::serve(Some(send), None).await, receive)
    }

    pub async fn controlled_with_usage(
        input: u64,
        output: u64,
    ) -> (Self, mpsc::Receiver<ModelRequest>) {
        let (send, receive) = mpsc::channel(1);
        (
            Self::serve(Some(send), Some((input, output))).await,
            receive,
        )
    }

    async fn serve(control: Option<mpsc::Sender<ModelRequest>>, usage: Option<(u64, u64)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let received = requests.clone();
        let worker = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let requests = received.clone();
                        let control = control.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request: Request<Incoming>| {
                                let requests = requests.clone();
                                let control = control.clone();
                                async move {
                                    assert_eq!(request.uri().path(), "/v1/chat/completions");
                                    let body = request.into_body().collect().await.unwrap().to_bytes();
                                    let body: Value = serde_json::from_slice(&body).unwrap();
                                    requests.lock().unwrap().push(body.clone());
                                    let choice = if let Some(control) = control {
                                        let (reply, receive) = oneshot::channel();
                                        control.send(ModelRequest { body, reply }).await.unwrap();
                                        receive.await.unwrap()
                                    } else {
                                        json!({"index":0,"delta":{"content":"recovered"},"finish_reason":"stop"})
                                    };
                                    let mut chunk = json!({
                                        "id":"recovered-reply", "object":"chat.completion.chunk", "created":1,
                                        "model":"fixture-model",
                                        "choices":[choice]
                                    });
                                    if let Some((input, output)) = usage {
                                        chunk["usage"] = json!({"prompt_tokens":input,"completion_tokens":output,"total_tokens":input+output});
                                    }
                                    Ok::<_, Infallible>(Response::builder()
                                        .header("content-type", "text/event-stream")
                                        .header("connection", "close")
                                        .body(Full::new(Bytes::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))).unwrap())
                                }
                            });
                            if let Err(error) = http1::Builder::new().serve_connection(TokioIo::new(socket), service).await {
                                assert!(error.is_incomplete_message() || error.is_closed() || error.is_canceled(),
                                    "fixture HTTP connection: {error}");
                            }
                        });
                    }
                    Some(result) = connections.join_next(), if !connections.is_empty() => { result.unwrap(); }
                }
            }
        });
        Self {
            base_url,
            requests,
            worker,
        }
    }
}

pub async fn configure(fixture: &ClientFixture, base_url: &str) -> SessionModel {
    configure_provider(fixture, base_url, "openai-compatible").await
}

pub async fn configure_provider(
    fixture: &ClientFixture,
    base_url: &str,
    provider_name: &str,
) -> SessionModel {
    let owner = Arc::new(fixture.owner());
    let config = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
    let login = config.prepare_oauth_login(serde_json::from_value(json!({
        "attemptId":"fixture-login",
        "target":{"kind":"create","slug":"recovery","name":"Recovery fixture",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":provider_name},
            "configuration":{"baseUrl":base_url}},
        "authentication":{"method":"api-key","input":{"apiKey":"local-recovery-fixture"}}
    })).unwrap()).await.unwrap();
    let maka_config::oauth::enrollment::LoginPreparation::Ready(login) = login else {
        panic!("fixture login");
    };
    assert!(login.claim().await.unwrap());
    assert!(matches!(
        login
            .complete(
                maka_runtime::provider::Credential {
                    secret: "local-recovery-fixture".into(),
                    refresh_at: None,
                },
                1
            )
            .await
            .unwrap(),
        maka_config::oauth::enrollment::LoginCompletion::Committed(_)
    ));
    let row = login.connection();
    let created = config.update_connection(serde_json::from_value(json!({
        "expected":{"connectionId":row.connection_id,"revision":row.revision},
        "changes":{"name":row.name,"configuration":row.configuration,"enabled":true,"enabledModelIds":["fixture-model"],
            "modelOverrides":{"fixture-model":{"contextWindow":200000,"thinkingLevels":["off"]}}}
    })).unwrap()).await.unwrap();
    let CatalogMutationResult::Committed {
        connection: Some(connection),
        ..
    } = created
    else {
        panic!("fixture connection")
    };
    config.shutdown().await.unwrap();
    SessionModel {
        connection_id: connection.connection_id,
        connection_slug: "recovery".into(),
        model: "fixture-model".into(),
    }
}

pub async fn unknown_dispatch(
    log: &maka_event_log::EventLog,
    owner: &maka_runtime::event::Invocation,
    path: &std::path::Path,
) {
    use maka_runtime::{
        event::{EventWrite, Fact, LogScope, RuntimeEvent},
        model::{ModelEvent, ModelFinishReason, ModelPart, ModelStep, ModelToolCall, ModelUsage},
        tool_call::ToolCallIdentity,
    };
    let source = log
        .scoped_prefix(
            LogScope::Session {
                id: owner.session_id.clone(),
            },
            100,
            1024 * 1024,
        )
        .await
        .unwrap();
    let input = json!({"path":path, "content":"wrong"});
    let call = ModelToolCall {
        id: "write".into(),
        name: "Write".into(),
        input: input.clone(),
        provider_options: None,
        provider_executed: false,
    };
    let facts = [
        Fact::ModelRequested {
            effective_source_digest: None,
            purpose: maka_runtime::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "fixture-model".into(),
            source_scope: source.scope,
            source_high_water: source.high_water,
            source_digest: source.digest,
            input_digest: "fixture".into(),
            route_identity: "fixture".into(),
        },
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::ToolCall(call.clone()),
        },
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall { call }],
                finish_reason: ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
        Fact::ToolDispatched {
            operation_id: "step:write".into(),
            call: ToolCallIdentity::provider("step".into(), "write".into()),
            name: "Write".into(),
            input,
        },
    ];
    for fact in facts {
        log.append(&EventWrite::plain(RuntimeEvent::new(owner.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
}
