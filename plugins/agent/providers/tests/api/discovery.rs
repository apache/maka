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
use futures_util::future::BoxFuture;
use maka_agent_facts::provider::Credential;
use maka_agent_ports::model::Connect;
use maka_agent_ports::model::Error as ModelError;
use maka_agent_ports::model::Socket;
use maka_agent_ports::model::Transport;
use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Discovery;
use maka_agent_ports::provider::Error;
use maka_capabilities::http;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

struct Reply {
    bytes: Mutex<Option<Vec<u8>>>,
    cancelled: AtomicBool,
    closed: AtomicBool,
    stall: bool,
}
impl Reply {
    fn json(value: serde_json::Value) -> Arc<Self> {
        Arc::new(Self {
            bytes: Mutex::new(Some(serde_json::to_vec(&value).unwrap())),
            cancelled: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stall: false,
        })
    }
}
impl http::Body for Reply {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async {
            if self.stall {
                std::future::pending::<()>().await;
            }
            Ok(self.bytes.lock().unwrap().take())
        })
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        self.closed.store(true, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}
struct Script {
    pages: Mutex<VecDeque<(u16, Arc<Reply>)>>,
    requests: Mutex<Vec<http::Request>>,
    entered: tokio::sync::Notify,
}
impl Script {
    fn new(pages: impl IntoIterator<Item = serde_json::Value>) -> Arc<Self> {
        Arc::new(Self {
            pages: Mutex::new(
                pages
                    .into_iter()
                    .map(|value| (200, Reply::json(value)))
                    .collect(),
            ),
            requests: Mutex::new(vec![]),
            entered: tokio::sync::Notify::new(),
        })
    }
    fn context(self: &Arc<Self>) -> Context {
        Context {
            transport: self.clone(),
            cancellation: CancellationToken::new(),
            interaction: None,
        }
    }
}
impl Transport for Script {
    fn identity(&self) -> u64 {
        1
    }
    fn request(
        &self,
        request: http::Request,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
        Box::pin(async move {
            let url = request.url.clone();
            self.requests.lock().unwrap().push(request);
            let (status, body) = self
                .pages
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected extra request");
            self.entered.notify_one();
            Ok(http::Response {
                head: http::Head {
                    status,
                    url,
                    headers: vec![],
                },
                body,
            })
        })
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
        Box::pin(async { panic!("unexpected WebSocket") })
    }
}
fn input(binding: &Definition, base: &str) -> Discovery {
    let mut connection = request(binding, "future", ModelOverride::default()).connection;
    connection.configuration = json!({"baseUrl":base});
    Discovery {
        connection,
        credential: Some(Credential {
            secret: "test-key".into(),
            refresh_at: None,
        }),
        request_headers: Default::default(),
    }
}

#[tokio::test]
async fn openrouter_discovery_preserves_reported_efforts_defaults_and_explicit_policy() {
    let binding = binding("openrouter");
    let script = Script::new([json!({"data":[
        {"id":"deepseek/deepseek-v4.1-flash-1017", "reasoning":{
            "mandatory":false,"default_enabled":true,
            "supported_efforts":["max","high","low","none"],"default_effort":"high"
        }},
        {"id":"minimax/minimax-m3.1-flash:free", "reasoning":{
            "mandatory":true,"supported_efforts":["max","xhigh","high","medium","low"],
            "default_effort":"max"
        }},
        {"id":"anthropic/claude-opus-4.8", "reasoning":{
            "mandatory":false,"default_enabled":false,
            "supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"high"
        }},
        {"id":"openai/gpt-5.2", "reasoning":{
            "mandatory":false,"supported_efforts":["xhigh","high","medium","low","none"],
            "default_effort":"medium"
        }}
    ]})]);
    let models = binding
        .discover(input(&binding, "https://relay.test/v1"), script.context())
        .await
        .unwrap();
    // Persist exactly the discovered typed facts before preparing a model.
    let models: Vec<ModelInfo> =
        serde_json::from_slice(&serde_json::to_vec(&models).unwrap()).unwrap();
    for (model, levels, default) in [
        (&models[0], vec![Max, High, Low, Off], Some(High)),
        (&models[1], vec![Max, Xhigh, High, Medium, Low], Some(Max)),
        (
            &models[2],
            vec![Max, Xhigh, High, Medium, Low, Off],
            Some(Off),
        ),
        (&models[3], vec![Xhigh, High, Medium, Low, Off], None),
    ] {
        assert_eq!(model.capabilities.unwrap().reasoning, Some(true));
        assert_eq!(model.thinking_levels.as_ref(), Some(&levels));
        assert_eq!(model.default_thinking_level, default);
        let mut resolve = request(&binding, &model.id, ModelOverride::default());
        resolve.model = model.clone();
        let metadata = ApiProviders::model_metadata(
            "openrouter",
            snapshot(),
            resolve.connection.clone(),
            resolve.model.clone(),
            resolve.overrides.clone(),
        )
        .unwrap();
        assert_eq!(metadata.thinking_levels, levels);
        assert_eq!(metadata.default_thinking_level, default);
        let prepared = binding.prepare(resolve.clone()).await.unwrap();
        assert_eq!(
            prepared.provider_options["openrouter"]["reasoningEffort"],
            match default {
                Some(Off) => json!("none"),
                Some(level) => json!(level),
                None => serde_json::Value::Null,
            }
        );
        if default.is_none() {
            assert!(
                prepared.provider_options["openrouter"]
                    .get("reasoningEffort")
                    .is_none()
            );
        }
        for level in &levels {
            resolve.thinking_level = Some(*level);
            assert_eq!(
                binding
                    .prepare(resolve.clone())
                    .await
                    .unwrap()
                    .provider_options["openrouter"]["reasoningEffort"],
                if *level == Off {
                    json!("none")
                } else {
                    json!(level)
                }
            );
        }
        resolve.thinking_level = Some(maka_agent_facts::execution::ThinkingLevel::Ultra);
        assert!(matches!(
            binding.prepare(resolve).await,
            Err(Error::UnsupportedThinkingLevel)
        ));
    }
    // A user-declared connection default wins even when discovery reports off.
    let mut resolve = request(
        &binding,
        &models[2].id,
        ModelOverride {
            thinking_levels: Some(vec![Low, High]),
            default_thinking_level: Some(High),
            ..Default::default()
        },
    );
    resolve.model = models[2].clone();
    assert_eq!(
        binding
            .prepare(resolve.clone())
            .await
            .unwrap()
            .provider_options["openrouter"]["reasoningEffort"],
        "high"
    );
    resolve.thinking_level = Some(Low);
    assert_eq!(
        binding.prepare(resolve).await.unwrap().provider_options["openrouter"]["reasoningEffort"],
        "low"
    );
}

#[tokio::test]
async fn openrouter_controls_distinguish_missing_null_and_mandatory_reasoning() {
    use maka_agent_facts::execution::ThinkingLevel::Minimal;
    let binding = binding("openrouter");
    let script = Script::new([json!({"data":[
        {"id":"all", "reasoning":{"mandatory":false,"supported_efforts":null}},
        {"id":"mandatory", "reasoning":{
            "mandatory":true,"supported_efforts":null,"default_effort":"max"
        }},
        {"id":"openai/gpt-5.2", "reasoning":{"mandatory":true}},
        {"id":"toggle-only", "reasoning":{"mandatory":false,"default_enabled":false}},
        {"id":"dynamic-router", "supported_parameters":["reasoning","reasoning_effort"]},
        {"id":"forward-compatible", "reasoning":{
            "mandatory":true,"default_enabled":false,
            "supported_efforts":["none","future-effort","high","high",null],"default_effort":"high"
        }},
        {"id":"none-default", "reasoning":{
            "mandatory":false,"default_enabled":true,
            "supported_efforts":["high","none"],"default_effort":"none"
        }},
        {"id":"not-a-reasoner", "supported_parameters":["temperature"]}
    ]})]);
    let models = binding
        .discover(input(&binding, "https://relay.test/v1"), script.context())
        .await
        .unwrap();
    for (model, levels, default) in [
        (
            &models[0],
            vec![Max, Xhigh, High, Medium, Low, Minimal, Off],
            None,
        ),
        (
            &models[1],
            vec![Max, Xhigh, High, Medium, Low, Minimal],
            Some(Max),
        ),
        (&models[2], vec![], None),
        (&models[3], vec![], None),
        (&models[4], vec![], None),
        (&models[5], vec![High], Some(High)),
        (&models[6], vec![High, Off], None),
    ] {
        assert_eq!(model.thinking_levels.as_ref(), Some(&levels));
        assert_eq!(model.default_thinking_level, default);
        assert_eq!(model.capabilities.unwrap().reasoning, Some(true));
    }
    assert_eq!(models[7].capabilities.unwrap().reasoning, Some(false));
    let mut resolve = request(&binding, &models[2].id, ModelOverride::default());
    resolve.model = models[2].clone();
    let prepared = binding.prepare(resolve.clone()).await.unwrap();
    assert!(prepared.thinking_levels.is_empty());
    assert!(
        prepared.provider_options["openrouter"]
            .get("reasoningEffort")
            .is_none()
    );
    resolve.thinking_level = Some(Medium);
    assert!(matches!(
        binding.prepare(resolve).await,
        Err(Error::UnsupportedThinkingLevel)
    ));
}

#[tokio::test]
async fn public_binding_uses_declared_paths_filters_envelopes_and_model_protocols() {
    for (provider, suffix, body, expected_path, expected_id) in [
        (
            "google",
            "/v1beta/",
            json!({"models":[{"name":"models/gemini-future"}]}),
            "/v1beta/models?key=test-key",
            "gemini-future",
        ),
        (
            "ollama",
            "/v1",
            json!({"models":[{"name":"local:latest"}]}),
            "/api/tags",
            "local:latest",
        ),
        (
            "deepinfra",
            "/v1/openai",
            json!({"data":[{"id":"future"}]}),
            "/v1/models",
            "future",
        ),
        (
            "siliconflow",
            "/v1",
            json!({"data":[{"id":"future"}]}),
            "/v1/models?sub_type=chat",
            "future",
        ),
        (
            "mistral",
            "/v1",
            json!([{"id":"future"}]),
            "/v1/models",
            "future",
        ),
        (
            "vercel",
            "/v1",
            json!({"data":[{"id":"embed","type":"embedding"},{"id":"future","type":"language"}]}),
            "/v1/models",
            "future",
        ),
        (
            "huggingface",
            "/v1",
            json!({"data":[{"id":"dead","tags":["tool-use"],"providers":[]},{"id":"future","providers":[{"status":"live","supports_tools":true}]}]}),
            "/v1/models",
            "future",
        ),
        (
            "commandcode",
            "/provider/v1",
            json!({"data":[{"id":"anthropic/claude-future"}]}),
            "/provider/v1/models",
            "anthropic/claude-future",
        ),
    ] {
        let binding = binding(provider);
        let script = Script::new([body]);
        let mut discovery = input(&binding, &format!("https://relay.test{suffix}"));
        if provider == "vercel" {
            discovery.credential = None;
        }
        let models = binding.discover(discovery, script.context()).await.unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            [expected_id],
            "{provider}"
        );
        if provider == "commandcode" {
            assert_eq!(models[0].api_protocol, Some(ApiProtocol::AnthropicMessages));
        }
        let requests = script.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].url,
            format!("https://relay.test{expected_path}")
        );
        assert_eq!(
            requests[0]
                .headers
                .iter()
                .any(|(name, _)| name == "authorization"),
            !matches!(provider, "vercel" | "google")
        );
    }
}

#[tokio::test]
async fn paginated_inventories_preserve_metadata_and_reject_cycles_or_incomplete_results() {
    let cohere = binding("cohere");
    let script = Script::new([
        json!({"models":[{"name":"old","is_deprecated":true},{"name":"embed","endpoints":["embed"]}],"next_page_token":"next/+"}),
        json!({"models":[{"name":"future","endpoints":["chat"],"context_length":8192}]}),
    ]);
    let models = cohere
        .discover(input(&cohere, "https://relay.test/v2"), script.context())
        .await
        .unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].context_window, Some(8192));
    assert_eq!(
        script.requests.lock().unwrap()[1].url,
        "https://relay.test/v1/models?endpoint=chat&page_size=1000&page_token=next%2F%2B"
    );
    let cycle = Script::new([
        json!({"models":[{"name":"partial","endpoints":["chat"]}],"next_page_token":"again"}),
        json!({"models":[],"next_page_token":"again"}),
    ]);
    assert!(matches!(
        cohere
            .discover(input(&cohere, "https://relay.test/v2"), cycle.context())
            .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(cycle.requests.lock().unwrap().len(), 2);
    let oversized = Script::new([
        json!({"models":vec![json!({"name":"duplicate","endpoints":["chat"]});2049]}),
    ]);
    let models = cohere
        .discover(input(&cohere, "https://relay.test/v2"), oversized.context())
        .await
        .unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["duplicate"]
    );

    let cloudflare = binding("cloudflare-workers-ai");
    let script = Script::new([
        json!({"success":true,"result":[{"name":"@cf/future"}]}),
        json!({"success":true,"result":[{"name":"@cf/future"}]}),
        json!({"success":true,"result":[{"name":"@cf/later"}]}),
        json!({"success":true,"result":[]}),
    ]);
    let models = cloudflare
        .discover(
            input(&cloudflare, "https://relay.test/accounts/account/ai/v1"),
            script.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["@cf/future", "@cf/later"]
    );
    assert_eq!(script.requests.lock().unwrap().iter().map(|request| request.url.clone()).collect::<Vec<_>>(), (1..=4).map(|page| format!("https://relay.test/accounts/account/ai/models/search?per_page=50&task=Text+Generation&page={page}")).collect::<Vec<_>>());
    let invalid = Script::new([json!({"success":true})]);
    assert!(matches!(
        cloudflare
            .discover(
                input(&cloudflare, "https://relay.test/accounts/account/ai/v1"),
                invalid.context()
            )
            .await,
        Err(Error::Invalid(_))
    ));

    let fireworks = binding("fireworks-ai");
    let script = Script::new([
        json!({"accounts":[{"name":"accounts/owned"},{"name":"accounts/owned"}]}),
        json!({"models":[{"name":"accounts/owned/models/future","contextLength":32768,"supportsTools":true}]}),
        json!({"models":[{"name":"accounts/fireworks/models/public","supportsImageInput":true}]}),
    ]);
    let models = fireworks
        .discover(
            input(&fireworks, "https://relay.test/inference/v1"),
            script.context(),
        )
        .await
        .unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].context_window, Some(32768));
    assert_eq!(models[1].capabilities.unwrap().vision, Some(true));
    assert_eq!(
        script.requests.lock().unwrap()[0].url,
        "https://relay.test/v1/accounts?pageSize=200"
    );
    assert_eq!(script.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn discovery_cancellation_and_failures_release_the_body_without_publishing_partial_models() {
    let binding = binding("openai");
    for (status, size, stall) in [
        (401, 0, true),
        (200, 4 * 1024 * 1024 + 1, false),
        (200, 0, true),
    ] {
        let script = Script::new([]);
        let body = Arc::new(Reply {
            bytes: Mutex::new(Some(vec![b' '; size])),
            cancelled: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stall,
        });
        script
            .pages
            .lock()
            .unwrap()
            .push_back((status, body.clone()));
        let context = script.context();
        let cancel = context.cancellation.clone();
        let operation = binding.discover(input(&binding, "https://relay.test/v1"), context);
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(operation, async {
                script.entered.notified().await;
                if status == 200 && stall {
                    cancel.cancel();
                }
            })
            .0
        })
        .await
        .expect("discovery blocked on a discarded or cancelled body");
        match (status, stall) {
            (401, _) => assert!(matches!(result, Err(Error::Http(401)))),
            (200, true) => assert!(matches!(result, Err(Error::Cancelled))),
            _ => assert!(matches!(result, Err(Error::Invalid(_)))),
        }
        assert!(body.cancelled.load(Ordering::SeqCst));
        assert!(body.closed.load(Ordering::SeqCst));
    }
}
