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

use crate::{
    dynamic_tools::{call, respond_tools},
    support::context as fixture,
};
use maka_agent::RunWork;
use maka_event_log::EventLog;
use maka_plugins::{
    composition::Scope,
    contributions::{Catalog, Staged},
    fiber::Fiber,
    prompt::{DynamicContext, Section, SectionMode, Text, Variable},
};
use maka_runtime::{
    event::Fact,
    tools::{ToolExecutor, ToolFuture},
};
use maka_tools::{plugins::PluginTool, *};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncWriteExt, net::TcpListener};
use tokio_util::sync::CancellationToken;

struct Echo(Arc<AtomicUsize>);

struct Models {
    provider: maka_model::ProviderConfig,
    generation: Arc<AtomicUsize>,
    captures: Arc<AtomicUsize>,
}
impl maka_agent::ModelSource for Models {
    fn capture(
        &self,
    ) -> futures_util::future::BoxFuture<'_, Result<maka_agent::PreparedModel, maka_agent::RunError>>
    {
        self.captures.fetch_add(1, Ordering::SeqCst);
        let generation = self.generation.load(Ordering::SeqCst);
        Box::pin(async move {
            Ok(maka_agent::PreparedModel {
                provider_id: "example.provider".into(),
                provider: self.provider.clone(),
                options: json!({}),
                context: None,
                main_output_limit: Some((generation as u64 + 1) * 1000),
                supports_vision: false,
                revision: maka_runtime::composition::SourceRevision {
                    kind: maka_runtime::composition::SourceKind::ModelProvider,
                    name: "example.provider".into(),
                    package_id: "example.provider".into(),
                    entry_id: "example.provider".into(),
                    activation: format!("activation-{generation}"),
                    revision: generation.to_string(),
                },
            })
        })
    }
}
impl ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(input) })
    }
}
fn publish(catalog: &Catalog, version: &str, count: Arc<AtomicUsize>) -> Fiber {
    let fiber = Fiber::new("example", "example", Scope::Profile).unwrap();
    fiber.begin_loading().unwrap();
    let mut staged = Staged::default();
    staged
        .insert("version", Variable(Text::Literal(version.into())))
        .unwrap();
    staged
        .insert(
            "system",
            Section {
                format: Default::default(),
                order: 0,
                mode: SectionMode::Complete,
                text: Text::Literal("Plugin {{version}}".into()),
            },
        )
        .unwrap();
    staged
        .insert(
            "context",
            DynamicContext {
                format: Default::default(),
                order: 0,
                text: Text::Literal("Current {{version}}".into()),
            },
        )
        .unwrap();
    staged.insert("echo", PluginTool::new(ToolRegistration {
        definition: ToolDefinition {
            freeform: None, output_schema: None, provider: None,
            name: "echo".into(), description: format!("Echo {version}"),
            input_schema: json!({"type":"object","properties":{"version":{"const":version}},"required":["version"],"additionalProperties":false}),
        },
        nesting: ToolNesting::Nestable, semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Immediate(Arc::new(Echo(count))),
    }).unwrap()).unwrap();
    fiber.ready().unwrap();
    catalog.publish(&fiber, staged).unwrap();
    fiber
}
fn check(request: &Value, version: &str) {
    assert_eq!(
        request["max_tokens"],
        if version == "old" { 1000 } else { 2000 }
    );
    let messages = request["messages"].as_array().unwrap();
    assert_eq!(messages[0]["content"], format!("Plugin {version}"));
    assert_eq!(
        messages.last().unwrap()["content"],
        format!("Current {version}")
    );
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["content"]
                .as_str()
                .is_some_and(|text| text.starts_with("Current ")))
            .count(),
        1,
        "temporary contexts do not accumulate in history"
    );
    assert_eq!(
        request["tools"][0]["function"]["parameters"]["properties"]["version"]["const"],
        version
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_step_surface_survives_retry_changes_only_between_steps_and_reopens() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = Arc::new(EventLog::open(&path).await.unwrap());
        let catalog = Catalog::default();
        let models = Fiber::new("maka.models", "maka.models", Scope::Profile).unwrap();
        models.begin_loading().unwrap(); models.ready().unwrap();
        catalog.publish(&models, maka_model::adapters::Builtin(
            maka_js_runtime::trusted::TrustedRuntime::default()
        ).stage().unwrap()).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let first = publish(&catalog, "old", count.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server_catalog = catalog.clone();
        let server_count = count.clone();
        let generation = Arc::new(AtomicUsize::new(0));
        let captures = Arc::new(AtomicUsize::new(0));
        let server_generation = generation.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let original = fixture::read_request(&mut socket).await;
            check(&original, "old");
            first.shutdown(tokio::time::Instant::now() + Duration::from_secs(1)).await.unwrap();
            let second = publish(&server_catalog, "new", server_count.clone());
            server_generation.store(1, Ordering::SeqCst);
            socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            let retry = fixture::read_request(&mut socket).await;
            assert_eq!(retry, original, "replacement cannot change physical retries");
            respond_tools(&mut socket, vec![call("stale", "echo", json!({"version":"old"}))], 10).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let current = fixture::read_request(&mut socket).await;
            check(&current, "new");
            assert_eq!(server_count.load(Ordering::SeqCst), 0, "old call must not retarget replacement");
            respond_tools(&mut socket, vec![call("fresh", "echo", json!({"version":"new"}))], 10).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            check(&fixture::read_request(&mut socket).await, "new");
            fixture::respond(&mut socket, "done", "stop").await;
            second
        });
        let mut input = fixture::input(&base, "composition", false);
        input.model_source = Some(Arc::new(Models {
            provider: input.provider.clone(), generation, captures: captures.clone(),
        }));
        let session = input.invocation.session_id.clone();
        input.work = RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(), message: "Use echo".into(),
            tools: ToolCatalog::default()
                .with_workspace(maka_plugins::filesystem::ReadRoot::open(directory.path()).await.unwrap())
                .with_plugins(catalog, Scope::Session(session.clone()), None).unwrap(),
            max_steps: 3,
        };
        let engine = fixture::engine(log.clone());
        engine.run(input, CancellationToken::new()).await.unwrap();
        engine.drain().await;
        let second = server.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(captures.load(Ordering::SeqCst), 3, "physical retry does not recapture provider");
        let prefix = log.prefix(200, 1024 * 1024).await.unwrap();
        let requests: Vec<_> = prefix.events.iter().filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. })).map(|event| event.event.id.clone()).collect();
        assert_eq!(requests.len(), 4);
        let mut surfaces = Vec::new();
        for id in &requests {
            surfaces.push(log.request_composition(&session, id).await.unwrap().unwrap());
            assert!(log.request_composition("other-session", id).await.unwrap().is_none());
        }
        assert_eq!(surfaces[0], surfaces[1]);
        assert_eq!(surfaces[2], surfaces[3]);
        assert_ne!(surfaces[0], surfaces[2]);
        assert_eq!(surfaces[0].sources.len(), 6);
        for (surface, revision) in surfaces.iter().zip(["0", "0", "1", "1"]) {
            let providers: Vec<_> = surface.sources.iter().filter(|source| source.kind == maka_runtime::composition::SourceKind::ModelProvider).collect();
            assert_eq!(providers.len(), 1);
            assert_eq!(providers[0].revision, revision);
        }
        assert_eq!(surfaces[0].sources.iter().filter(|source| source.kind == maka_runtime::composition::SourceKind::ModelAdapter).count(), 1);
        assert_eq!(surfaces[2].system_prompt.as_deref(), Some("Plugin new"));
        second.shutdown(tokio::time::Instant::now() + Duration::from_secs(1)).await.unwrap();
        drop(engine);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        let reopened = EventLog::open(&path).await.unwrap();
        for (id, surface) in requests.iter().zip(surfaces) {
            assert_eq!(reopened.request_composition(&session, id).await.unwrap(), Some(surface));
        }
        reopened.close().await.unwrap();
    }).await.expect("plugin replacement and retry make bounded progress");
}
