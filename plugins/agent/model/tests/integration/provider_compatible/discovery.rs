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
use maka_agent_ports::provider::{
    Connection, Context, Discovery, Resolve, authentication::Credential,
};
use maka_providers::{api::ApiProviders, catalog::Snapshot};

async fn serve_gateway(listener: TcpListener, provider: &str) {
    let magpie = provider == "magpie";
    let chat = provider == "openai-compatible";
    let (mut socket, _) = listener.accept().await.unwrap();
    let (head, _) = crate::http_request(&mut socket).await;
    assert!(head.starts_with("GET /v1/models "));
    assert_eq!(
        head.to_lowercase().contains("x-magpie-drawers: 1\r\n"),
        magpie
    );
    let mut rows = vec![
        json!({"id":"codex/model", "service_tiers":[{"id":"priority","name":"Fast","description":"Faster"}], "web_search":"native"}),
        json!({"id":"relay/model","web_search":"magpie"}),
        json!({"id":"no-search","service_tiers":null}),
    ];
    if magpie {
        rows.push(json!({"id":"images/draw","kind":"image"}));
    }
    let body = json!({"data":rows}).to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    for tier in [None, Some("priority")] {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (head, body) = crate::http_request(&mut socket).await;
        let path = if chat {
            "/v1/chat/completions"
        } else {
            "/v1/responses"
        };
        assert!(head.starts_with(&format!("POST {path} ")));
        assert!(!head.to_lowercase().contains("x-magpie-drawers:"));
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body.get("service_tier"),
            tier.map(|tier| json!(tier)).as_ref()
        );
        let events = if chat {
            completion(&[])
        } else {
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\",\"output\":[]}}\n\n".into()
        };
        response(&mut socket, 200, &events).await;
    }
}

#[tokio::test]
async fn compatible_connections_use_advertised_speeds_and_only_magpie_discovers_native_search() {
    let snapshot = Arc::new(Snapshot::bundled().unwrap());
    for name in ["magpie", "openai-responses-compatible", "openai-compatible"] {
        let magpie = name == "magpie";
        let binding = ApiProviders::definition(name, snapshot.clone()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_gateway(listener, name));
        let connection = Connection {
            id: "test-gateway".into(),
            revision: 1,
            configuration: binding.configure(json!({"baseUrl":url})).unwrap(),
        };
        let models = binding
            .discover(
                Discovery {
                    connection: connection.clone(),
                    credential: (!magpie).then(|| Credential {
                        secret: "test".into(),
                        refresh_at: None,
                    }),
                    request_headers: Default::default(),
                },
                Context {
                    transport: maka_model::provider_transport(&Default::default()).unwrap(),
                    cancellation: CancellationToken::new(),
                    interaction: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].service_tiers[0].name, "Fast");
        for model in &models {
            assert_eq!(
                model.capabilities.and_then(|c| c.web_search),
                magpie.then_some(model.id == "codex/model")
            );
        }
        let mut selection = Resolve {
            connection,
            model: models[0].clone(),
            overrides: None,
            thinking_level: None,
            service_tier: Some("ultrafast".into()),
        };
        assert!(matches!(binding.prepare(selection.clone()).await,
            Err(maka_agent_ports::provider::Error::Invalid(reason)) if reason.contains("ultrafast")
        ));
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        for tier in [None, Some("priority")] {
            selection.service_tier = tier.map(str::to_owned);
            let model = binding.prepare(selection.clone()).await.unwrap();
            let mut input = request(&url);
            input.provider.kind = model.protocol;
            input.provider.model = model.info.id;
            input.provider_options = model.provider_options;
            let mut stream = executor
                .stream(input, CancellationToken::new())
                .await
                .unwrap();
            while let Some(event) = stream.next().await {
                event.unwrap();
            }
            stream.cancel_and_wait().await.unwrap();
        }
        server.await.unwrap();
    }
}
