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

use super::support::{
    client_probe::ClientFixture,
    message_recovery::{Provider, configure},
    peer::Peer,
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    input,
    kernel::{Definition, Plugin, PluginContext},
    session,
};
use maka_runtime::event::Fact;
use maka_runtime_host::{
    plugins::Setup,
    server::{Host, HostOptions, local::LocalListener},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

mod batch;
mod managed;

#[derive(Clone, Default)]
struct Business(Arc<AtomicUsize>);

impl Plugin for Business {
    fn activate(&self, _: PluginContext, _: Value) -> BoxFuture<'static, Result<Staged, String>> {
        let business = Arc::new(self.clone());
        Box::pin(async move {
            let mut staged = Staged::default();
            staged
                .insert(
                    "example.review",
                    session::SessionBehavior::new(business.clone()),
                )
                .map_err(|e| e.to_string())?;
            staged
                .insert("example.prepare", input::InputPreparation(business))
                .map_err(|e| e.to_string())?;
            Ok(staged)
        })
    }
}
impl session::Behavior for Business {
    fn prepare(&self, _: session::Request) -> BoxFuture<'_, Result<session::Preparation, String>> {
        Box::pin(async {
            Ok(session::Preparation {
                instructions: "Follow the example review workflow.".into(),
                ..Default::default()
            })
        })
    }
}
impl input::Provider for Business {
    fn prepare(
        &self,
        mut request: input::Request,
        _workspace: maka_plugins::filesystem::ReadDirectory,
    ) -> BoxFuture<'static, Result<input::Outcome, maka_plugins::Error>> {
        let count = self.0.clone();
        Box::pin(async move {
            if !request.content.text.starts_with("ticket:") {
                return Ok(input::Outcome::Unchanged);
            }
            count.fetch_add(1, Ordering::SeqCst);
            request.content.text = format!("Prepared business request: {}", request.content.text);
            Ok(input::Outcome::Ready {
                content: request.content,
                receipt: json!({"ticket":42}),
                required_tools: Default::default(),
                basis: None,
            })
        })
    }
}
fn setup(business: &Business) -> Setup {
    Setup {
        builtins: BTreeMap::from([(
            "example".into(),
            Arc::new(Definition {
                id: "example".into(),
                revision: "binary".into(),
                dependencies: vec![],
                inject: vec![],
                plugin: Arc::new(business.clone()),
            }),
        )]),
        layers: BTreeMap::from([(
            "example".into(),
            serde_json::from_value(json!([
                {"type":"insert","rootId":"profile","entry":{"id":"example","packageId":"example"}}
            ]))
            .unwrap(),
        )]),
        ..Default::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn third_party_behavior_and_prepared_input_survive_replay_without_host_business_branches() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    let fixture = ClientFixture::new("maka-input-plugin-");
    let provider = Provider::start().await;
    let model = configure(&fixture, &provider.base_url).await;
    let business = Business::default();
    let javascript = super::javascript_plugins::package(
        &fixture.workspace,
        "example.javascript",
        "shared",
        r#"
export default async function(ctx) {
    await ctx.input.prepare('example.transform', request => {
        if (!request.content.text.startsWith('Prepared business request:')) return { kind: 'unchanged' };
        if (request.sessionId !== 'business' || request.signal.aborted) throw new Error('invalid preparation context');
        if (request.preparation.length !== 1 || request.preparation[0].receipt.ticket !== 42)
            throw new Error('prior provider receipt is unavailable');
        return { kind: 'ready', content: { ...request.content, text: request.content.text + ' [JavaScript prepared]' }, receipt: { transformed: true } };
    });
}
"#,
        false,
    );
    let original = json!({"sessionId":"business","turnId":"ticket","content":{"text":"ticket:42"}});
    for reopened in [false, true] {
        let host = Host::open_with_options(
            fixture.owner(),
            None,
            HostOptions {
                plugins: setup(&business),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("input.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-input-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop),
        );
        let mut peer = Peer::new(host.clone(), "input-plugin").await;
        super::skills_plugin::converged(&mut peer).await;
        if !reopened {
            let installed = peer
                .rpc("plugin.package.install", json!({"sourcePath":javascript}))
                .await;
            assert_eq!(installed["ok"], true, "{installed}");
            super::skills_plugin::converged(&mut peer).await;
            let created = peer.rpc("session.create", json!({
                "sessionId":"business", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model},
                "orchestrationMode":"example.review"
            })).await;
            assert_eq!(created["ok"], true, "{created}");
        }
        let started = peer.rpc("turn.start", original.clone()).await;
        assert_eq!(started["result"]["kind"], "started", "{started}");
        loop {
            let turn = peer
                .rpc(
                    "turn.query",
                    json!({"sessionId":"business","turnId":"ticket"}),
                )
                .await;
            match turn["result"]["status"].as_str() {
                Some("completed") => break,
                Some("failed" | "cancelled") => panic!("{turn}"),
                _ => tokio::task::yield_now().await,
            }
        }
        if !reopened {
            let disabled = peer.rpc("plugin.composition.apply", json!({
                "operations":[{"type":"update","entryId":"maka.assistant","patch":{"disabled":true}}]
            })).await;
            assert_eq!(disabled["ok"], true, "{disabled}");
            super::skills_plugin::converged(&mut peer).await;
            let next = peer.rpc("turn.start", json!({
                "sessionId":"business", "turnId":"no-assistant", "content":{"text":"plain custom workflow"}
            })).await;
            assert_eq!(next["result"]["kind"], "started", "{next}");
            loop {
                let turn = peer
                    .rpc(
                        "turn.query",
                        json!({"sessionId":"business","turnId":"no-assistant"}),
                    )
                    .await;
                match turn["result"]["status"].as_str() {
                    Some("completed") => break,
                    Some("failed" | "cancelled") => panic!("{turn}"),
                    _ => tokio::task::yield_now().await,
                }
            }
            let disabled = peer.rpc("plugin.composition.apply", json!({
                "operations":[
                    {"type":"update","entryId":"example","patch":{"disabled":true}},
                    {"type":"update","entryId":"example.javascript","patch":{"disabled":true}}
                ]
            })).await;
            assert_eq!(disabled["ok"], true, "{disabled}");
            super::skills_plugin::converged(&mut peer).await;
        }
        let rejected = peer
            .rpc(
                "turn.start",
                json!({
                    "sessionId":"business","turnId":"unavailable","content":{"text":"ticket:43"}
                }),
            )
            .await;
        assert_eq!(
            rejected["error"]["code"], "operation_unavailable",
            "{rejected}"
        );
        peer.close().await;
        drop(cleanup);
        server.await.unwrap().unwrap();
        drop(host);
    }
    assert_eq!(
        business.0.load(Ordering::SeqCst),
        1,
        "replay and retirement do not prepare again"
    );
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let without_assistant = requests[1]["messages"].as_array().unwrap();
        assert_eq!(
            without_assistant
                .iter()
                .filter(|m| m["role"] == "system")
                .map(|m| &m["content"])
                .collect::<Vec<_>>(),
            vec![&json!("Follow the example review workflow.")]
        );
        let messages = requests[0]["messages"].as_array().unwrap();
        assert!(messages.iter().any(|m| {
            m["role"] == "system"
                && m["content"]
                    .as_str()
                    .unwrap()
                    .contains("example review workflow")
        }));
        assert!(messages.iter().any(|m| m["role"] == "user"
            && m["content"] == "Prepared business request: ticket:42 [JavaScript prepared]"));
    }
    let log = fixture.log().await;
    let prefix = log.prefix(1000, 1024 * 1024).await.unwrap();
    let content = prefix
        .events
        .iter()
        .find_map(|event| match &event.event.fact {
            Fact::InvocationOpened {
                input: maka_runtime::input::InvocationInput::Message { content, .. },
                ..
            } => Some(content),
            _ => None,
        })
        .unwrap();
    assert_eq!(content.preparation.len(), 2);
    assert_eq!(content.preparation[0].source.package_id, "example");
    assert_eq!(content.preparation[0].receipt, json!({"ticket":42}));
    assert_eq!(
        content.preparation[1].source.package_id,
        "example.javascript"
    );
    assert_eq!(content.preparation[1].receipt, json!({"transformed":true}));
    let source = prefix
        .events
        .iter()
        .find_map(|event| match &event.event.fact {
            Fact::InvocationOpened {
                input:
                    maka_runtime::input::InvocationInput::Message {
                        source_messages, ..
                    },
                ..
            } if event.event.invocation.turn_id == "ticket" => source_messages.first(),
            _ => None,
        })
        .unwrap();
    let editable = log
        .editable_message("business", "ticket", &source.message.message_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        editable.content.text, "ticket:42",
        "editing must not reverse either plugin's transformation"
    );
    assert!(editable.content.preparation.is_empty());
    log.shutdown().await.unwrap();
}
