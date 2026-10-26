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
mod live;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::TextKind;
use maka_model::{ModelError, ProviderAuth};

struct BoundSubscription(ProviderAuth);
impl maka_model::AuthResolver for BoundSubscription {
    fn resolve(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ProviderAuth, ModelError>> + Send + '_>,
    > {
        Box::pin(async { Ok(self.0.clone()) })
    }
}

fn codex_request(port: u16, token: &str) -> ModelRequest {
    let mut request = proxied_request(port, "first");
    request.provider.adapter = Some(maka_providers::codex::ADAPTER.into());
    let auth = ProviderAuth::RequestHeaders(
        maka_providers::codex::request_headers(token, "codex-session").unwrap(),
    );
    request.provider.auth = ProviderAuth::Bound {
        identity: "root-bound-subscription".into(),
        resolver: std::sync::Arc::new(BoundSubscription(auth)),
    };
    assert!(
        !serde_json::to_value(&request.provider)
            .unwrap()
            .to_string()
            .contains(token)
    );
    crate::edit_prompt(&mut request.prompt, |messages| {
        messages.insert(
            0,
            maka_model::prompt::Message::System {
                content: "Keep this system instruction.".into(),
                provider_options: None,
            },
        )
    });
    // The subscription profile must enforce store:false and supply verbosity.
    request.provider_options = json!({"openai":{"store":true}});
    assert!(request.max_output_tokens.is_some());
    request
}

fn check_headers(actual: &reqwest::header::HeaderMap, expected: &Value) {
    for name in [
        "authorization",
        "chatgpt-account-id",
        "originator",
        "session_id",
        "x-client-request-id",
        "openai-beta",
    ] {
        assert_eq!(
            actual.get(name).map(|value| value.to_str().unwrap()),
            expected[name].as_str(),
            "{name}"
        );
    }
    assert_eq!(actual["proxy-authorization"], "Basic dXNlcjpzZWNyZXQ=");
    // Native Responses identifies itself without an AI adapter runtime suffix.
    assert_eq!(actual["user-agent"], "codex_cli_rs/0.0.0 (Maka)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::result_large_err,
    reason = "tungstenite fixes the handshake callback error type"
)]
async fn subscription_profile_survives_proxy_ws_continuation_and_http_fallback() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        let profiles: Vec<Value> = [
            (json!({"https://api.openai.com/auth":{"chatgpt_account_id":"nested-account"},"sub":"not-an-account"}), Some("nested-account")),
            (json!({"chatgpt_account_id":"primary-account","organizations":[{"id":"secondary-account"}]}), Some("primary-account")),
            (json!({"organizations":[null,{"id":" "},{"id":" organization-account "}]}), Some("organization-account")),
            (json!({"sub":"not-an-account"}), None),
            (Value::Null, None),
        ].into_iter().map(|(claims, account)| {
            let token = if claims.is_null() { "opaque-token".into() } else {
                format!("fixture.{}.signature", URL_SAFE_NO_PAD.encode(claims.to_string()))
            };
            let mut headers = json!({"authorization":format!("Bearer {token}"),
                "originator":"codex_cli_rs","session_id":"codex-session",
                "x-client-request-id":"codex-session","openai-beta":"responses=experimental"});
            if let Some(account) = account { headers["chatgpt-account-id"] = json!(account); }
            json!({"token":token,"headers":headers})
        }).collect();
        let expected = profiles.clone();
        let server = tokio::spawn(async move {
            for (index, expected) in expected.into_iter().enumerate() {
                if index == 1 {
                    // An actual rejected WS upgrade must retain subscription
                    // routing and mandatory fields through authenticated HTTP.
                    for _ in 0..6 {
                        check_headers(&reject_upgrade(&listener).await, &expected["headers"]);
                    }
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request = crate::provider_stream::read_request(&mut socket).await;
                    let (head, body) = request.split_once("\r\n\r\n").unwrap();
                    assert!(head.starts_with("POST http://models.maka.invalid/v1/responses "));
                    let headers: reqwest::header::HeaderMap = head.lines().skip(1).map(|line| {
                        let (name, value) = line.split_once(':').unwrap();
                        (reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                         reqwest::header::HeaderValue::from_str(value.trim()).unwrap())
                    }).collect();
                    check_headers(&headers, &expected["headers"]);
                    check_body(&serde_json::from_str::<Value>(body).unwrap());
                    let body: String = events("resp_http", "OK").iter().map(|event| format!("data: {event}\n\n")).collect();
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                    continue;
                }
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = accept_hdr_async(socket, |request: &Request, response: Response| {
                    check_headers(request.headers(), &expected["headers"]);
                    Ok(response)
                }).await.unwrap();
                let mut first = continuation::body(&mut socket).await;
                assert_eq!(first["type"], "response.create");
                first.as_object_mut().unwrap().remove("type");
                first["stream"] = json!(true);
                check_body(&first);
                finish(&mut socket, "resp_1").await;
                if index == 0 {
                    let next = continuation::body(&mut socket).await;
                    assert_eq!(next["previous_response_id"], "resp_1");
                    assert_eq!(next["input"].as_array().unwrap().len(), 1);
                    assert_eq!(next["input"][0]["content"][0]["text"], "second");
                    assert_eq!(next["instructions"], "Keep this system instruction.");
                    assert_eq!(next["store"], false);
                    assert_eq!(next["text"]["verbosity"], "medium");
                    assert!(next.get("max_output_tokens").is_none());
                    finish(&mut socket, "resp_2").await;
                }
                assert!(socket.next().await.is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_)))));
            }
        });
        let executor = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        for (index, profile) in profiles.into_iter().enumerate() {
            let lane = Conversation::default();
            let token = profile["token"].as_str().unwrap();
            let mut next = codex_request(port, token);
            let step = generate_step(&executor, &lane, codex_request(port, token)).await;
            assert!(matches!(&step.parts[..], [ModelPart::Text {text, ..}] if text == "OK"));
            if index == 0 {
                let content = accepted_content(&step);
                crate::edit_prompt(&mut next.prompt, |messages| messages.push(serde_json::from_value(json!({"role":"assistant","content":content})).unwrap()));
                assert!(lane.needs_confirmation());
                assert!(lane.confirm(&next.prompt, &[], step.response_id.as_deref()).await);
                crate::edit_prompt(&mut next.prompt, |messages| messages.push(serde_json::from_value(json!({"role":"user","content":[{"type":"text","text":"second"}]})).unwrap()));
                generate(&executor, &lane, next).await;
            }
            drop(lane);
        }
        server.await.unwrap();
        let mut wrong_wire = codex_request(port, "unused");
        wrong_wire.provider.kind = ProviderKind::Anthropic;
        let mut rejected = executor.stream(wrong_wire, CancellationToken::new()).await.unwrap();
        assert!(matches!(rejected.next().await, Some(Err(ModelError::Adapter(message)))
            if message == "subscription requires the Responses protocol"));
    }).await.unwrap();
}

fn accepted_content(step: &maka_agent_facts::model::ModelStep) -> Vec<Value> {
    step.parts
        .iter()
        .map(|part| match part {
            ModelPart::Text {
                text_kind,
                text,
                provider_options,
            } => json!({"type":if *text_kind == TextKind::Thinking {"reasoning"} else {"text"},
                "text":text,"providerOptions":provider_options}),
            _ => panic!("text-only subscription probe returned a tool"),
        })
        .collect()
}

fn check_body(body: &Value) {
    assert_eq!(body["model"], "test-responses");
    assert_eq!(body["stream"], true);
    assert_eq!(body["store"], false);
    assert_eq!(body["instructions"], "Keep this system instruction.");
    assert_eq!(body["text"]["verbosity"], "medium");
    assert!(body.get("max_output_tokens").is_none());
    assert!(
        body["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["role"] == "user" && item["content"][0]["text"] == "first")
    );
}
