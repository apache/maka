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
