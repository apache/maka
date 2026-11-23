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
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, MockAiBuilder, ModelEntry, Protocol, TurnPlan,
};
use maka_providers::{api::ApiProviders, catalog::Snapshot};

#[tokio::test]
async fn compatible_connections_use_advertised_speeds_and_only_magpie_discovers_native_search() {
    let snapshot = Arc::new(Snapshot::bundled().unwrap());
    for name in ["magpie", "openai-responses-compatible", "openai-compatible"] {
        let magpie = name == "magpie";
        let chat = name == "openai-compatible";
        let binding = ApiProviders::definition(name, snapshot.clone()).unwrap();

        let mut models_list = vec![
            ModelEntry::simple("codex/model")
                .with_extra(
                    "service_tiers",
                    json!([{"id":"priority","name":"Fast","description":"Faster"}]),
                )
                .with_extra("web_search", json!("native")),
            ModelEntry::simple("relay/model").with_extra("web_search", json!("magpie")),
            ModelEntry::simple("no-search").with_extra("service_tiers", Value::Null),
        ];
        if magpie {
            models_list.push(ModelEntry::simple("images/draw").with_extra("kind", json!("image")));
        }

        let server = MockAiBuilder::new()
            .control(ControlPlaneConfig {
                models: models_list,
                ..Default::default()
            })
            .handler_fn(move |req, ctx| {
                let (expected_proto, expected_path) = if chat {
                    (Protocol::OpenaiChatCompletions, "/v1/chat/completions")
                } else {
                    (Protocol::OpenaiResponsesHttp, "/v1/responses")
                };
                assert_eq!(req.protocol, expected_proto);
                assert_eq!(req.path, expected_path);
                assert!(!req.headers.contains_key("x-magpie-drawers"));
                let expected_tier = match ctx.global_turn {
                    1 => None,
                    2 => Some(json!("priority")),
                    other => panic!("unexpected turn {other}"),
                };
                assert_eq!(req.raw_body.get("service_tier"), expected_tier.as_ref());
                TurnPlan::new().finish(FinishReason::Stop)
            })
            .start()
            .await
            .unwrap();
        let url = server.base_url();

        let connection = Connection {
            id: "test-gateway".into(),
            revision: 1,
            configuration: binding.configure(json!({"baseUrl": url})).unwrap(),
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
        let control_reqs = server.control_plane_requests();
        assert_eq!(control_reqs.len(), 1);
        assert_eq!(control_reqs[0].method, "GET");
        assert_eq!(control_reqs[0].path, "/v1/models");
        assert_eq!(
            control_reqs[0]
                .headers
                .get("x-magpie-drawers")
                .map(String::as_str)
                == Some("1"),
            magpie
        );

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
        assert!(matches!(
            binding.prepare(selection.clone()).await,
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
        assert_eq!(server.request_count(), 2);
        server.shutdown().await;
    }
}
