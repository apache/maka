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

use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use maka_agent_facts::configuration::*;
use maka_config::ConfigurationStore;
use maka_event_log::root::RootOwner;
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    task::{JoinHandle, JoinSet},
};

pub struct Provider {
    pub base_url: String,
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
    pub async fn controlled() -> (Self, mpsc::Receiver<ModelRequest>) {
        let (send, receive) = mpsc::channel(1);
        (Self::serve(Some(send), None).await, receive)
    }

    async fn serve(control: Option<mpsc::Sender<ModelRequest>>, usage: Option<(u64, u64)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let worker = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let control = control.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request: Request<Incoming>| {
                                let control = control.clone();
                                async move {
                                    assert_eq!(request.uri().path(), "/v1/chat/completions");
                                    let body = request.into_body().collect().await.unwrap().to_bytes();
                                    let body: Value = serde_json::from_slice(&body).unwrap();
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
        Self { base_url, worker }
    }
}

pub async fn configure(owner: RootOwner, base_url: &str, mut model: ModelOverride) {
    model.context_window.get_or_insert(200000);
    model
        .thinking_levels
        .get_or_insert_with(|| vec![maka_agent_facts::execution::ThinkingLevel::Off]);
    let provider_name = "openai-compatible";
    let owner = Arc::new(owner);
    let config = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
    let login = config.prepare_oauth_login(serde_json::from_value(json!({
        "attemptId":"fixture-login",
        "target":{"kind":"create","slug":"recovery","name":"Recovery fixture",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":provider_name},
            "configuration":{"baseUrl":base_url}},
        "expectedCredential":null,"authentication":{"method":"api-key","input":{"apiKey":"local-recovery-fixture"}}
    })).unwrap()).await.unwrap();
    let maka_config::oauth::enrollment::LoginPreparation::Ready(login) = login else {
        panic!("fixture login");
    };
    assert!(login.claim().await.unwrap());
    assert!(matches!(
        login
            .complete(
                maka_agent_facts::provider::Credential {
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
            "modelOverrides":{"fixture-model":model}}
    })).unwrap()).await.unwrap();
    let CatalogMutationResult::Committed {
        connection: Some(connection),
        ..
    } = created
    else {
        panic!("fixture connection")
    };
    assert!(matches!(
        config
            .set_default_target(SetDefaultConnectionTargetInput {
                expected_catalog_revision: config.catalog().await.unwrap().revision,
                target: Some(ConnectionTarget {
                    connection_id: connection.connection_id,
                    model_id: "fixture-model".into()
                }),
            })
            .await
            .unwrap(),
        CatalogMutationResult::Committed { .. }
    ));
    config.shutdown().await.unwrap();
}
