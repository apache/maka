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

use super::support::client_probe::ClientFixture;
use maka_runtime::execution::{SandboxMode, ToolMode};
use maka_runtime_host::session::SessionConfiguration;
use serde_json::Value;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_tool_preferences_freeze_each_run_and_survive_reopen() {
    use super::support::{
        message_recovery::{Provider, configure},
        peer::Peer,
    };
    use maka_runtime::{event::Fact, execution::EditingTools};
    use maka_runtime_host::server::{Host, local::LocalListener};
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    let fixture = ClientFixture::new("maka-model-tools-");
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    let mut expected = Vec::new();
    for reopened in [false, true] {
        let host = Host::open(fixture.owner()).await.unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("policy.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-policy-{}", uuid::Uuid::new_v4()));
        let cancel = CancellationToken::new();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), cancel.clone()),
        );
        let mut peer = Peer::new(host.clone(), "model-tools").await;
        let created = peer
            .rpc(
                "session.create",
                json!({
                    "sessionId":"tools", "workspace":{"kind":"host_path","path":fixture.workspace},
                    "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                        "connectionSlug":model.connection_slug,"model":model.model}
                }),
            )
            .await;
        assert_eq!(created["ok"], true, "{created}");
        if !reopened {
            set_model_tools(
                &mut peer,
                &model.connection_id,
                &provider.base_url,
                2,
                true,
                false,
            )
            .await;
        }
        for index in 0..if reopened { 1 } else { 2 } {
            let code = !reopened && index == 0;
            let turn = format!("{reopened}-{index}");
            let started = peer.rpc("turn.start",json!({"sessionId":"tools","turnId":turn,"content":{"text":"hello"},"maxSteps":2})).await;
            assert_eq!(started["ok"], true, "{started}");
            let request = tokio::time::timeout(std::time::Duration::from_secs(10), requests.recv())
                .await
                .unwrap()
                .unwrap();
            let names = |body: &Value| {
                body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            };
            let surface = names(&request.body);
            assert_eq!(surface.contains(&"exec".to_owned()), code);
            if code {
                let prompt = request.body["tools"].to_string();
                assert!(prompt.contains("Write"));
                assert!(!prompt.contains("apply_patch"));
                // Change both preferences while the first model request is still in flight.
                set_model_tools(
                    &mut peer,
                    &model.connection_id,
                    &provider.base_url,
                    3,
                    false,
                    true,
                )
                .await;
                request.reply.send(json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":"cell","type":"function","function":{"name":"exec","arguments":"{\"code\":\"return 1;\"}"}}]},"finish_reason":"tool_calls"})).unwrap();
                let next =
                    tokio::time::timeout(std::time::Duration::from_secs(10), requests.recv())
                        .await
                        .unwrap()
                        .unwrap();
                assert_eq!(names(&next.body), surface);
                assert!(!next.body["tools"].to_string().contains("apply_patch"));
                next.reply
                    .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"}))
                    .unwrap();
            } else {
                assert!(surface.contains(&"apply_patch".to_owned()));
                assert!(!surface.contains(&"Write".to_owned()));
                assert!(!surface.contains(&"Edit".to_owned()));
                assert!(surface.contains(&"Read".to_owned()));
                request
                    .reply
                    .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"}))
                    .unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    let state = peer
                        .rpc("turn.query", json!({"sessionId":"tools","turnId":turn}))
                        .await;
                    if state["result"]["status"] == "completed" {
                        break;
                    }
                    assert_ne!(state["result"]["status"], "failed", "{state}");
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            expected.push((
                if code {
                    ToolMode::CodeMode
                } else {
                    ToolMode::Direct
                },
                if code {
                    EditingTools::Structured
                } else {
                    EditingTools::ApplyPatch
                },
            ));
        }
        peer.close().await;
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(10), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop(host);
        let log = fixture.log().await;
        let prefix = log.prefix(100, 1024 * 1024).await.unwrap();
        let actual = prefix
            .events
            .iter()
            .filter_map(|event| match &event.event.fact {
                Fact::InvocationOpened {
                    configuration: Some(config),
                    ..
                } => Some((
                    config.tool_mode,
                    config.tool_composition.as_ref().unwrap().editing_tools,
                )),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            actual, expected,
            "later edits must not rewrite admitted choices"
        );
        log.close().await.unwrap();
    }
}

async fn set_model_tools(
    peer: &mut super::support::peer::Peer,
    connection: &str,
    endpoint: &str,
    revision: u64,
    code: bool,
    patch: bool,
) {
    let updated = peer.rpc("connection.catalog.update",serde_json::json!({
        "expected":{"connectionId":connection,"revision":revision},
        "changes":{"name":"Recovery fixture","configuration":{"baseUrl":endpoint},"enabled":true,"enabledModelIds":["fixture-model"],
            "modelOverrides":{"fixture-model":{"contextWindow":200000,"codeMode":code,"applyPatch":patch}}}
    })).await;
    assert_eq!(updated["result"]["kind"], "committed", "{updated}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_thinking_default_is_frozen_at_creation_not_replay() {
    use super::support::{message_recovery::configure, peer::Peer};
    use maka_runtime::execution::ThinkingLevel;
    use maka_runtime_host::server::{Host, local::LocalListener};
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    let fixture = ClientFixture::new("maka-thinking-default-");
    let endpoint = "http://127.0.0.1:9/v1";
    let model = configure(&fixture, endpoint).await;
    for reopened in [false, true] {
        let host = Host::open(fixture.owner()).await.unwrap();
        #[cfg(unix)]
        let endpoint_path = fixture.workspace.parent().unwrap().join("thinking.sock");
        #[cfg(windows)]
        let endpoint_path =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-thinking-{}", uuid::Uuid::new_v4()));
        let cancel = CancellationToken::new();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint_path)
                .unwrap()
                .serve(host.clone(), cancel.clone()),
        );
        let mut peer = Peer::new(host.clone(), "thinking-default").await;
        for (revision, default) in if reopened {
            vec![(4, "low")]
        } else {
            vec![(2, "high"), (3, "low")]
        } {
            let updated = peer
                .rpc(
                    "connection.catalog.update",
                    json!({
                        "expected":{"connectionId":model.connection_id,"revision":revision},
                        "changes":{"name":"Recovery fixture","configuration":{"baseUrl":endpoint},"enabled":true,
                            "enabledModelIds":["fixture-model"],"modelOverrides":{"fixture-model":{"contextWindow":200000,
                                "thinkingLevels":["low","high"],"defaultThinkingLevel":default
                            }}}
                    }),
                )
                .await;
            assert_eq!(updated["result"]["kind"], "committed", "{updated}");
            let fresh_id = format!("fresh-{revision}");
            for (id, explicit, expected) in [
                ("inherited", None, Some(ThinkingLevel::High)),
                ("provider", Some(Value::Null), None),
                ("explicit", Some(json!("low")), Some(ThinkingLevel::Low)),
                (
                    fresh_id.as_str(),
                    None,
                    Some(if default == "high" {
                        ThinkingLevel::High
                    } else {
                        ThinkingLevel::Low
                    }),
                ),
            ] {
                let mut input = json!({"sessionId":id,
                    "workspace":{"kind":"host_path","path":fixture.workspace},
                    "modelTarget":{"kind":"explicit","connectionId":model.connection_id,
                        "connectionSlug":model.connection_slug,"model":model.model}});
                if let Some(level) = explicit {
                    input["thinkingLevel"] = level;
                }
                let created = peer.rpc("session.create", input.clone()).await;
                assert_eq!(created["ok"], true, "{created}");
                assert_eq!(
                    created["result"]["thinkingLevel"],
                    json!(expected),
                    "{created}"
                );
                if id == "inherited" {
                    input["thinkingLevel"] = Value::Null;
                    let conflict = peer.rpc("session.create", input).await;
                    assert_eq!(conflict["ok"], false, "{conflict}");
                    assert_eq!(
                        conflict["error"]["code"], "operation_conflict",
                        "{conflict}"
                    );
                }
            }
        }
        peer.close().await;
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(10), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop(host);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_client_settings_cas_preserves_session_defaults_and_exact_reopen() {
    let fixture = ClientFixture::new("maka-runtime-policy-");
    fixture
        .run("--runtime-policy-workspace", false, "runtime-policy-passed")
        .await;
    let saved: Value = serde_json::from_slice(
        &std::fs::read(fixture.workspace.join("runtime-policy-fixture.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["finalSettings"]["policy"]["revision"], 4);
    let log = fixture.log().await;
    assert!(log.prefix(8, 4096).await.unwrap().events.is_empty());
    let mut records = Vec::new();
    for (id, permission) in [
        ("runtime-policy-old", SandboxMode::WorkspaceWrite),
        ("runtime-policy-inherited", SandboxMode::DangerFullAccess),
        ("runtime-policy-explicit", SandboxMode::WorkspaceWrite),
    ] {
        let record = log
            .get_session::<SessionConfiguration>(id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.configuration.sandbox_mode, permission);
        assert_eq!(record.configuration.thinking_level, None);
        records.push(record);
    }
    log.close().await.unwrap();
    fixture
        .run(
            "--runtime-policy-workspace",
            true,
            "runtime-policy-reopened",
        )
        .await;
    let reopened = fixture.log().await;
    assert!(reopened.prefix(8, 4096).await.unwrap().events.is_empty());
    for record in records {
        let after = reopened
            .get_session::<SessionConfiguration>(&record.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after, record);
    }
    reopened.close().await.unwrap();
}
