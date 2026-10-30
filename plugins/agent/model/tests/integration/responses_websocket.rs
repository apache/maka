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

use futures_util::{FutureExt, SinkExt, StreamExt};
use maka_agent_facts::configuration::policy::NetworkProxy;
use maka_agent_facts::configuration::policy::ProxyProtocol;
use maka_model::{
    Conversation, ModelExecutor, ModelRequest, ProviderConfig, ProviderKind, StepBuilder,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};
use tokio_util::sync::CancellationToken;
mod codex;
mod continuation;
mod failures;
mod prepared;
fn request(base_url: &str, text: &str) -> ModelRequest {
    ModelRequest {
        language: maka_agent_facts::language::Language::En,
        provider: ProviderConfig {
            image_input: None,
            adapter: None,
            capabilities: Default::default(),
            kind: ProviderKind::OpenaiResponses,
            model: "test-responses".into(),
            base_url: base_url.into(),
            auth: maka_model::ProviderAuth::ApiKey("fixture-key".into()),
            headers: BTreeMap::new(),
            network: Default::default(),
            body_overlay: None,
        },
        prompt: vec![maka_model::prompt::Message::user(text)].into(),
        tools: vec![],
        provider_options: json!({"openai":{"store":false}}),
        max_output_tokens: Some(32),
    }
}
fn events(id: &str, text: &str) -> Vec<Value> {
    vec![
        json!({"type":"response.created","response":{"id":id,"created_at":1,"model":"test-responses"}}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}),
        json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":text}),
        json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}}),
        json!({"type":"response.completed","response":{"id":id,"output":[],"usage":{"input_tokens":2,"output_tokens":1}}}),
    ]
}

fn proxied_request(port: u16, text: &str) -> ModelRequest {
    let mut request = request("http://models.maka.invalid/v1", text);
    request.provider.network = maka_network::Policy::from_settings(
        &NetworkProxy {
            enabled: true,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".into(),
            port,
            auth_enabled: true,
            username: "user".into(),
            bypass_list: vec![],
            auto_bypass_domains: vec![],
        },
        Some("secret"),
    )
    .unwrap();
    request
}

#[expect(
    clippy::result_large_err,
    reason = "tungstenite fixes the handshake callback error type"
)]
async fn accept(listener: &TcpListener) -> WebSocketStream<TcpStream> {
    let (socket, _) = listener.accept().await.unwrap();
    accept_hdr_async(socket, |request: &Request, response: Response| {
        assert_eq!(request.uri().path(), "/v1/responses");
        assert_eq!(request.headers()["authorization"], "Bearer fixture-key");
        if let Some(host) = request.uri().host() {
            assert_eq!(host, "models.maka.invalid");
            assert_eq!(
                request.headers()["proxy-authorization"],
                "Basic dXNlcjpzZWNyZXQ="
            );
        } else {
            assert!(!request.headers().contains_key("proxy-authorization"));
        }
        assert_eq!(
            request.headers()["openai-beta"],
            "responses_websockets=2026-02-06"
        );
        assert!(
            !request
                .headers()
                .contains_key("x-maka-openai-responses-lane")
        );
        Ok(response)
    })
    .await
    .unwrap()
}

async fn reject_upgrade(listener: &TcpListener) -> reqwest::header::HeaderMap {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.unwrap());
        assert!(head.len() < 64 * 1024);
    }
    let head = String::from_utf8(head).unwrap();
    assert!(head.starts_with("GET "));
    socket
        .write_all(
            b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    head.lines()
        .skip(1)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (
                reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                reqwest::header::HeaderValue::from_str(value.trim()).unwrap(),
            )
        })
        .collect()
}

async fn wire(socket: &mut WebSocketStream<TcpStream>, text: &str) -> Value {
    let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
    let body: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(body["type"], "response.create");
    assert_eq!(body["model"], "test-responses");
    assert_eq!(body["store"], false);
    assert!(body.get("stream").is_none());
    assert!(body.get("background").is_none());
    assert!(body.get("previous_response_id").is_none());
    assert!(body["input"].to_string().contains(text));
    body
}

async fn finish(socket: &mut WebSocketStream<TcpStream>, id: &str) {
    for event in events(id, "OK") {
        socket
            .send(Message::Text(event.to_string().into()))
            .await
            .unwrap();
    }
}

async fn generate_step(
    executor: &ModelExecutor,
    lane: &Conversation,
    request: ModelRequest,
) -> maka_agent_facts::model::ModelStep {
    let mut stream = executor
        .stream_in_conversation(request, CancellationToken::new(), Some(lane.clone()))
        .await
        .unwrap();
    let mut builder = StepBuilder::for_step("test-step").unwrap();
    while let Some(event) = stream.next().await {
        builder.push(event.unwrap().event).unwrap();
    }
    let output = builder.finish().unwrap();
    stream
        .cancel_and_wait()
        .await
        .expect("actual stream cleanup");
    output
}

async fn generate(executor: &ModelExecutor, lane: &Conversation, request: ModelRequest) {
    let output = generate_step(executor, lane, request).await;
    assert_eq!(
        output.finish_reason,
        maka_agent_facts::model::ModelFinishReason::Stop
    );
    assert!(serde_json::to_string(&output).unwrap().contains("OK"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_reuses_socket_and_drops_it_after_native_cleanup() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            // Recovery on the fifth retry must still use WS, then reuse it.
            for _ in 0..5 {
                reject_upgrade(&listener).await;
            }
            let mut socket = accept(&listener).await;
            wire(&mut socket, "first").await;
            finish(&mut socket, "resp_1").await;
            wire(&mut socket, "second").await;
            finish(&mut socket, "resp_2").await;
            assert!(
                socket
                    .next()
                    .await
                    .is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_))))
            );
            assert!(listener.accept().now_or_never().is_none());
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let lane = Conversation::default();
        generate(&executor, &lane, proxied_request(proxy_port, "first")).await;
        generate(&executor, &lane, proxied_request(proxy_port, "second")).await;
        drop(lane);
        server.await.unwrap();
    })
    .await
    .unwrap();
}
