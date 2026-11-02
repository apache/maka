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

/// Explicit opt-in; access tokens are read into memory only, never refreshed.
fn provider() -> ProviderConfig {
    use std::io::Read;
    let path = std::env::var_os("MAKA_CODEX_AUTH_FILE").expect("explicit auth path required");
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .unwrap()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 1024 * 1024, "auth document exceeds limit");
    let token: Value = serde_json::from_slice(&bytes).expect("invalid auth document");
    let access_token = token["tokens"]["access_token"]
        .as_str()
        .expect("subscription token required")
        .to_owned();
    let now = std::process::id();
    let mut network = maka_network::Policy::default();
    if let Ok(port) = std::env::var("MAKA_LIVE_PROXY_PORT") {
        let mut proxy =
            maka_agent_facts::configuration::policy::RuntimePolicy::default().network_proxy;
        proxy.enabled = true;
        proxy.host = "127.0.0.1".into();
        proxy.port = port.parse().expect("invalid proxy port");
        network = maka_network::Policy::from_settings(&proxy, None).unwrap();
    }
    ProviderConfig {
        image_input: None,
        adapter: Some(maka_providers::codex::ADAPTER.into()),
        capabilities: Default::default(),
        kind: ProviderKind::OpenaiResponses,
        model: "gpt-6-luna".into(),
        base_url: "https://chatgpt.com/backend-api/codex".into(),
        auth: ProviderAuth::RequestHeaders(
            maka_providers::codex::request_headers(&access_token, &format!("maka-rust-live-{now}"))
                .unwrap(),
        ),
        headers: BTreeMap::new(),
        body_overlay: None,
        network,
    }
}

/// Explicit opt-in; access tokens are read into memory only, never refreshed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MAKA_CODEX_AUTH_FILE and authorized gpt-6-luna subscription access"]
async fn live_luna_subscription_streams_and_confirms_canonical_ws_continuation() {
    let provider = provider();
    tokio::time::timeout(Duration::from_secs(140), async {
        let executor = ModelExecutor::new(Duration::from_secs(60)).unwrap();
        let lane = Conversation::default();
        let mut prompt = vec![maka_model::prompt::Message::System {
            content: "Follow the user request concisely.".into(),
            provider_options: None,
        }];
        for (index, user) in [
            "Remember the token amber-120. Reply only with READY-120.",
            "What token did I ask you to remember? Reply only with the token.",
        ]
        .into_iter()
        .enumerate()
        {
            prompt.push(maka_model::prompt::Message::user(user));
            if index == 0 {
                append_probe_images(&mut prompt);
            }
            let request = ModelRequest {
                language: maka_agent_facts::language::Language::En,
                provider: provider.clone(),
                prompt: prompt.clone().into(),
                tools: vec![],
                provider_options: json!({"openai":{"reasoningEffort":"low"}}),
                max_output_tokens: Some(128_000),
            };
            let step = generate_step(&executor, &lane, request).await;
            let text: String = step
                .parts
                .iter()
                .filter_map(|part| match part {
                    ModelPart::Text {
                        text_kind: TextKind::Text,
                        text,
                        ..
                    } => Some(text.chunks()),
                    _ => None,
                })
                .flatten()
                .collect();
            assert_eq!(
                text.trim(),
                if index == 0 { "READY-120" } else { "amber-120" }
            );
            prompt.push(
                serde_json::from_value(
                    json!({"role":"assistant","content":accepted_content(&step)}),
                )
                .unwrap(),
            );
            assert!(
                lane.needs_confirmation(),
                "HTTP completion cannot prove live WebSocket acceptance"
            );
            assert!(
                lane.confirm(&prompt.clone().into(), &[], step.response_id.as_deref())
                    .await
            );
        }
        drop(lane);
    })
    .await
    .unwrap();
}

// A locally generated PNG can exercise screenshot-rich requests without
// including any private screenshot in the test or its output.
fn append_probe_images(prompt: &mut [maka_model::prompt::Message]) {
    let Some(path) = std::env::var_os("MAKA_CODEX_IMAGE_PROBE") else {
        return;
    };
    use base64::Engine as _;
    use maka_model::prompt::{ContentPart, FileData, Message};
    let encoded = base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap());
    let Some(Message::User { content, .. }) = prompt.last_mut() else {
        unreachable!()
    };
    for _ in 0..3 {
        content.push(ContentPart::File {
            data: FileData::Data(encoded.clone()),
            media_type: "image/png".into(),
            provider_options: Some(json!({"openai":{"imageDetail":"low"}})),
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MAKA_CODEX_AUTH_FILE and authorized gpt-6-luna subscription access"]
async fn live_luna_subscription_http_decodes_the_stream_without_a_content_type_header() {
    tokio::time::timeout(Duration::from_secs(100), async {
        let models = ModelExecutor::new(Duration::from_secs(60)).unwrap();
        let mut prompt = vec![maka_model::prompt::Message::user(
            "Ignore any blank images. Reply only with HTTP-OK.",
        )];
        append_probe_images(&mut prompt);
        // No Conversation: this invocation uses the HTTP streaming path.
        let mut stream = models
            .stream(
                ModelRequest {
                    language: maka_agent_facts::language::Language::En,
                    provider: provider(),
                    prompt: prompt.into(),
                    tools: vec![],
                    provider_options: json!({"openai":{"reasoningEffort":"low"}}),
                    max_output_tokens: Some(128_000),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let mut step = StepBuilder::for_step("live-http").unwrap();
        while let Some(event) = stream.next().await {
            step.push(event.unwrap().event).unwrap();
        }
        let step = step.finish().unwrap();
        stream
            .cancel_and_wait()
            .await
            .expect("actual stream cleanup");
        let text: String = step
            .parts
            .iter()
            .filter_map(|part| match part {
                ModelPart::Text {
                    text_kind: TextKind::Text,
                    text,
                    ..
                } => Some(text.chunks()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(text.trim(), "HTTP-OK");
    })
    .await
    .unwrap();
}
