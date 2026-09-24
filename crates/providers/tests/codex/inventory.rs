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

#[tokio::test]
async fn discovery_and_preparation_share_account_facts_and_explicit_policy() {
    use maka_runtime::{
        configuration::{ModelInfo, ModelOverride},
        execution::ThinkingLevel::*,
    };
    let transport = Arc::new(Exchange {
        started: Notify::new(),
        release: Notify::new(),
        requests: Mutex::new(vec![]),
        fail: false,
        response: json!({"models":[{
            "slug":"future-model", "context_window":272000,
            "supported_reasoning_levels":[{"effort":"medium"},{"effort":"high"},{"effort":"max"},{"effort":"ultra"}],
            "supports_reasoning_summary_parameter":false,
            "input_modalities":["text"], "supports_parallel_tool_calls":false
        }]}),
    });
    transport.release.notify_one();
    let provider = Codex::default();
    use base64::Engine;
    let access = format!(
        "header.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&json!({"chatgpt_account_id":"account-a"})).unwrap())
    );
    let credential = Credential {
        secret: json!({
            "access_token":access,"refresh_token":"refresh","expires_at":1,"id_token":null
        })
        .to_string(),
        refresh_at: None,
    };
    let inventory = provider
        .discover(
            maka_plugins::provider::Discovery {
                connection: connection(),
                credential: Some(credential.clone()),
                request_headers: [("ChatGPT-Account-ID".into(), "account-a".into())].into(),
            },
            Context {
                transport: transport.clone(),
                cancellation: CancellationToken::new(),
                interaction: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(inventory.len(), 1);
    assert!(matches!(
        provider
            .discover(
                maka_plugins::provider::Discovery {
                    connection: connection(),
                    credential: Some(credential),
                    request_headers: [("ChatGPT-Account-ID".into(), "account-b".into())].into(),
                },
                Context {
                    transport: transport.clone(),
                    cancellation: CancellationToken::new(),
                    interaction: None
                }
            )
            .await,
        Err(Error::Invalid(_))
    ));
    let request = Resolve {
        connection: connection(),
        model: inventory[0].clone(),
        overrides: None,
        thinking_level: None,
    };
    let model = provider.resolve(request.clone()).await.unwrap();
    assert_eq!(model.thinking_levels, vec![Medium, High, Max, Ultra]);
    assert_eq!(model.info.context_window, Some(272000));
    assert_eq!(model.info.capabilities.unwrap().vision, Some(false));
    assert_eq!(
        model.provider_options["openai"],
        json!({"store":false,"parallelToolCalls":false})
    );

    let mut declared = request.clone();
    declared.overrides = Some(ModelOverride {
        default_thinking_level: Some(Ultra),
        ..Default::default()
    });
    let model = provider.resolve(declared.clone()).await.unwrap();
    assert_eq!(model.provider_options["openai"]["reasoningEffort"], "ultra");
    assert!(
        model.provider_options["openai"]
            .get("reasoningSummary")
            .is_none()
    );
    assert_eq!(wire(&model)["reasoning"], json!({"effort":"ultra"}));
    declared.thinking_level = Some(High);
    assert_eq!(
        provider
            .resolve(declared.clone())
            .await
            .unwrap()
            .provider_options["openai"]["reasoningEffort"],
        "high"
    );
    declared.thinking_level = Some(Low);
    assert!(matches!(
        provider.resolve(declared.clone()).await,
        Err(Error::Invalid(_))
    ));

    declared.thinking_level = None;
    declared.overrides = Some(ModelOverride {
        thinking_levels: Some(vec![Off, Low]),
        default_thinking_level: Some(Off),
        ..Default::default()
    });
    declared.model.supports_reasoning_summary = Some(true);
    let model = provider.resolve(declared).await.unwrap();
    assert_eq!(model.thinking_levels, vec![Off, Low]);
    assert_eq!(model.provider_options["openai"]["reasoningEffort"], "none");
    assert!(
        model.provider_options["openai"]
            .get("reasoningSummary")
            .is_none()
    );

    let model = provider
        .resolve(Resolve {
            model: ModelInfo::new("unadvertised"),
            ..request
        })
        .await
        .unwrap();
    assert!(model.thinking_levels.is_empty());
    assert!(
        model.provider_options["openai"]
            .get("reasoningEffort")
            .is_none()
    );
    assert_eq!(model.provider_options["openai"]["reasoningSummary"], "auto");
    assert_eq!(wire(&model)["reasoning"], json!({"summary":"auto"}));
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].url.ends_with("/models?client_version=1.0.0"));
}

fn wire(model: &maka_plugins::provider::Model) -> serde_json::Value {
    maka_responses::request::Request {
        model: &model.info.id,
        prompt: &[],
        tools: &[],
        options: &model.provider_options,
        max_output_tokens: None,
        plaintext: None,
    }
    .encode()
    .unwrap()
}
