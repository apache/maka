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
use maka_plugins::{
    composition::Scope,
    execution::{Progress, Submit},
    fiber::Fiber,
};
use maka_runtime::event::InvocationOutcome;
use maka_runtime_host::server::{Host, HostOptions, local::LocalListener};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

const SERVICE: &str = r#"
export default async function(ctx) {
    await ctx.prompt.variable('shared-proof', async (_request, call) => {
        const page = await call.workspace.read({path:'native-proof.txt', limit:6});
        if (new TextDecoder().decode(page.bytes) !== 'native') throw new Error('shared VM has no read view');
        return 'shared';
    });
    if (await ctx.credentials.read('test-token') !== null) throw new Error('credential leaked across packages');
    await ctx.services.provide('example.echo', async (value, call) => value.inspect
        ? {invocation:call.invocation, operationId:call.operationId ?? null}
        : { echoed: value });
}
"#;
const CONSUMER: &str = include_str!("../fixtures/host-plugin.mjs");
mod background;
mod metering;
mod provider_tools;
mod services;
pub(super) fn package(
    root: &Path,
    id: &str,
    mode: &str,
    source: &str,
    dependency: bool,
) -> std::path::PathBuf {
    let path = root.join(id);
    std::fs::create_dir(&path).unwrap();
    let dependencies = if dependency {
        json!([{"id":"example.service"}])
    } else {
        json!([])
    };
    std::fs::write(
        path.join("maka.extension.json"),
        serde_json::to_vec(&json!({
            "schemaVersion":1, "id":id, "dependencies":dependencies,
            "runtime":{"entry":"index.mjs","sdkVersion":1,"vm":mode},
            "composition":{"patch":"maka.composition.yml"}
        }))
        .unwrap(),
    )
    .unwrap();
    let inject = if dependency {
        "    inject: [example.echo]\n"
    } else {
        ""
    };
    std::fs::write(
        path.join("maka.composition.yml"),
        format!("- type: insert\n  entry:\n    id: {id}\n    packageId: {id}\n{inject}"),
    )
    .unwrap();
    std::fs::write(path.join("index.mjs"), source).unwrap();
    path
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn external_shared_and_dedicated_plugins_route_services_persist_data_and_drain_on_disable() {
    if std::env::var_os("MAKA_PLUGIN_PROTOCOL_TEST_CHILD").is_some() {
        use std::io::{BufRead, IsTerminal, Write};
        if std::env::var_os("MAKA_PLUGIN_SANDBOX_TEST_CHILD").is_some() {
            assert!(std::fs::write(".agents", "must be blocked").is_err());
            std::fs::write("managed-plugin-proof", "workspace write allowed").unwrap();
            let private = std::path::PathBuf::from(
                std::env::var_os("MAKA_PLUGIN_PRIVATE_DATA_TEST_PATH").unwrap(),
            );
            assert_eq!(
                std::fs::read(private.join("state.bin")).unwrap(),
                "持久状态🦀".as_bytes()
            );
            std::fs::write(private.join("state.bin"), "持久状态🦀".as_bytes()).unwrap();
        }
        if std::env::var_os("MAKA_PLUGIN_PTY_TEST_CHILD").is_some() {
            assert!(std::io::stdin().is_terminal());
            assert!(std::io::stdout().is_terminal());
            assert!(std::io::stderr().is_terminal());
        }
        for line in std::io::stdin().lock().lines() {
            let line = line.unwrap();
            if line == "quit" {
                return;
            }
            println!("protocol:{line}");
            std::io::stdout().flush().unwrap();
        }
        return;
    }
    tokio::time::timeout(Duration::from_secs(40), async {
        let fixture = ClientFixture::new("maka-js-plugin-");
        std::fs::write(fixture.workspace.join("native-proof.txt"), "native and JS share authority\n").unwrap();
        std::fs::write(fixture.workspace.join("binary-page"), vec![255; 1024 * 1024]).unwrap();
        std::fs::write(fixture.workspace.join("unshared.txt"), "not granted").unwrap();
        let service = package(&fixture.workspace, "example.service", "shared", SERVICE, false);
        let source = CONSUMER.replace("'__PROTOCOL_EXECUTABLE__'", &serde_json::to_string(&std::env::current_exe().unwrap()).unwrap())
            .replace("__MANAGED_SANDBOX__", if cfg!(any(target_os = "macos", target_os = "linux")) { "supported" } else { "unsupported" })
            .replace("'example.echo'", "'example.native'");
        let consumer = package(&fixture.workspace, "example.consumer", "dedicated", &source, true);
        let (provider, mut requests) = Provider::controlled_with_usage(3, 5).await;
        let model = configure(&fixture, &provider.base_url).await;
        for reopened in [false, true] {
            let host = Host::open_with_options(fixture.owner(), None, HostOptions {
                input_roots: maka_plugins::filesystem::ReadRoots(std::collections::BTreeMap::from([(
                    "public-notes".into(),
                    maka_plugins::filesystem::ReadRoot::open(&fixture.workspace).await.unwrap()
                        .select(["native-proof.txt".into(), "binary-page".into()].into()).unwrap(),
                )])),
                plugins: services::setup(), ..Default::default()
            }).await.unwrap();
            #[cfg(unix)]
            let endpoint = fixture.workspace.parent().unwrap().join("javascript.sock");
            #[cfg(windows)]
            let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-js-{}", uuid::Uuid::new_v4()));
            let stop = CancellationToken::new();
            let cleanup = stop.clone().drop_guard();
            let server = tokio::spawn(LocalListener::bind(&endpoint).unwrap().serve(host.clone(), stop.clone()));
            let mut peer = Peer::new(host.clone(), "javascript-plugin").await;
            ready(&mut peer).await;
            if !reopened {
                for source in [&service, &consumer] {
                    let result = peer.rpc("plugin.package.install", json!({"sourcePath":source})).await;
                    assert_eq!(result["ok"], true, "{result}");
                    ready(&mut peer).await;
                }
                let result = peer.rpc("session.create", json!({
                    "sessionId":"js-session", "workspace":{"kind":"host_path","path":fixture.workspace},
                    "sandboxMode":"workspace-write",
                    "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
                })).await;
                assert_eq!(result["ok"], true, "{result}");
                let external = peer.rpc("session.create", json!({
                    "sessionId":"executor-session", "workspace":{"kind":"host_path","path":fixture.workspace},
                    "executorId":"example.external", "sandboxMode":"danger-full-access",
                    "executorSettings":{"model":"initial-model", "thinkingLevel":"high"}
                })).await;
                assert_eq!(external["ok"], true, "{external}");
                assert_eq!(external["result"]["backend"], "plugin-executor", "{external}");
                assert_eq!(external["result"]["executorId"], "example.external", "{external}");
                assert_eq!(external["result"]["model"], "initial-model");
                assert_eq!(external["result"]["thinkingLevel"], "high");
                let native = peer.rpc("session.configuration.update", json!({
                    "sessionId":"executor-session", "expectedRevision":external["result"]["revision"],
                    "patch":{"modelTarget":{"kind":"explicit", "connectionId":model.connection_id, "connectionSlug":model.connection_slug, "model":model.model}}
                })).await;
                assert_eq!(native["ok"], true, "{native}");
                assert_eq!(native["result"]["session"]["backend"], "ai-sdk", "{native}");
                assert!(native["result"]["session"].get("executorSettings").is_none());
                let configured = peer.rpc("session.configuration.update", json!({
                    "sessionId":"executor-session", "expectedRevision":native["result"]["session"]["revision"],
                    "patch":{"executorTarget":{"executorId":"example.external", "settings":{"model":"host-model", "thinkingLevel":"max"}}}
                })).await;
                assert_eq!(configured["ok"], true, "{configured}");
                assert_eq!(configured["result"]["session"]["model"], "host-model", "{configured}");
                let parent = peer.rpc("session.create", json!({
                    "sessionId":"executor-parent", "workspace":{"kind":"host_path","path":fixture.workspace},
                    "sandboxMode":"danger-full-access",
                    "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
                })).await;
                assert_eq!(parent["ok"], true, "{parent}");
            }
            let driver = Fiber::new("driver", "driver", Scope::Profile).unwrap();
            driver.begin_loading().unwrap();
            let commands = host.authorize_plugin_execution(driver.context(), &["js-session".into(), "executor-parent".into()]).await.unwrap();
            driver.ready().unwrap(); driver.publish().unwrap();
            let child_request = maka_plugins::execution::CreateChild {
                workspace: None,
                operation_id: "external-child".into(), parent_session_id: "executor-parent".into(), name: "External worker".into(),
                sandbox_mode: None, bound_tools: None, instructions: Some("Executor child instructions".into()),
                target: Some(maka_plugins::execution::Target::Executor { executor_id: "example.external".to_owned().try_into().unwrap(), settings: maka_runtime::executor::Settings { model:Some("child-model".into()), thinking_level:Some(maka_runtime::execution::ThinkingLevel::Low) } }),
            };
            let external_child = commands.create_child(child_request.clone()).await.unwrap();
            assert_eq!(commands.create_child(child_request).await.unwrap(), external_child);
            if !reopened {
                let session = commands.session(external_child.session_id.clone()).await.unwrap();
                let configured = commands.configure(maka_plugins::execution::Configure {
                    session_id:session.session_id, expected_revision:session.revision,
                    target:maka_plugins::execution::Target::Executor {
                        executor_id:"example.external".to_owned().try_into().unwrap(),
                        settings:maka_runtime::executor::Settings { model:Some("plugin-model".into()), thinking_level:Some(maka_runtime::execution::ThinkingLevel::Medium) },
                    }
                }).await.unwrap();
                assert!(matches!(configured, maka_plugins::execution::Configured::Committed { .. }));
            }
            let inspector = Fiber::new("example.consumer", "inspector", Scope::Profile).unwrap();
            inspector.begin_loading().unwrap();
            let storage = host.plugin_storage(inspector.context()).unwrap();
            for waiting in if reopened { vec![false] } else { vec![false, true] } {
                std::fs::write(fixture.workspace.join("binding-proof.txt"), "before").unwrap();
                let operation = format!("request-{reopened}-{waiting}");
                commands.submit(Submit { orchestration_mode: Some("example.behavior".to_owned().try_into().unwrap()), operation_id:operation.clone(), session_id:"js-session".into(), content:"Use PluginEcho".into() }).await.unwrap();
                let search = tokio::time::timeout(Duration::from_secs(5), requests.recv()).await.unwrap().unwrap();
                assert!(search.body.to_string().contains("JavaScript plugin acceptance"));
                assert!(search.body.to_string().contains("External behavior instructions"));
                assert!(!search.body.to_string().contains("nested answer"));
                search.reply.send(tool("search", "tool_search", json!({"query":"PluginEcho"}))).unwrap();
                let invoke = tokio::time::timeout(Duration::from_secs(5), requests.recv()).await.unwrap().unwrap();
                assert!(invoke.body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "PluginEcho"));
                assert!(invoke.body.to_string().contains("binding proof: before"));
                std::fs::write(fixture.workspace.join("binding-proof.txt"), "after").unwrap();
                invoke.reply.send(tool("echo", "PluginEcho", json!({"wait":waiting}))).unwrap();
                if !waiting {
                    let nested = tokio::time::timeout(Duration::from_secs(5), requests.recv()).await.unwrap().unwrap();
                    assert_eq!(nested.body["messages"], json!([
                        {"role":"system","content":"Auxiliary only"},
                        {"role":"user","content":"nested prompt"}
                    ]));
                    assert!(nested.body.get("tools").is_none());
                    nested.reply.send(json!({"index":0,"delta":{"content":"nested answer"},"finish_reason":"stop"})).unwrap();
                }
                if waiting {
                    let pending = tokio::time::timeout(Duration::from_secs(5), requests.recv()).await.unwrap().unwrap();
                    assert_eq!(pending.body["messages"], json!([{"role":"user","content":"cancel this"}]));
                    loop {
                        if storage.read("waiting".into()).await.unwrap().is_some() { break; }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    toggle(&mut peer, true).await;
                    let _ = pending.reply.send(json!({"index":0,"delta":{"content":"too late"},"finish_reason":"stop"}));
                }
                loop {
                    if let Ok(unexpected) = requests.try_recv() {
                        panic!("finishing plugin tool requested another model step: {}", unexpected.body);
                    }
                    match commands.query(operation.clone()).await.unwrap().progress {
                        Progress::Ended { outcome } => { assert_eq!(outcome, InvocationOutcome::Completed); break; }
                        _ => tokio::time::sleep(Duration::from_millis(10)).await,
                    }
                }
                if waiting {
                    ready(&mut peer).await;
                    toggle(&mut peer, false).await;
                    ready(&mut peer).await;
                }
            }
            let count = storage.read("count".into()).await.unwrap().unwrap();
            assert_eq!(storage.read("bound-proof".into()).await.unwrap().unwrap().data.value(), Some(&json!("before")));
            assert_eq!(count.data.value(), Some(&json!(if reopened { 2 } else { 1 })));
            let executors = peer.rpc("plugin.platform.query", json!({"view":"executors"})).await;
            assert_eq!(executors["ok"], true, "{executors}");
            assert!(executors["result"]["items"].as_array().unwrap().iter().any(|executor| executor["id"] == "example.external"));
            let choices = peer.rpc("executor.catalog.query", json!({"query":"external acceptance"})).await;
            assert_eq!(choices["ok"], true, "{choices}");
            assert_eq!(choices["result"]["executors"], json!([{"id":"example.external","displayName":"External acceptance",
                "capabilities":{"thinking":true,"toolActivity":true,"attachments":false,"historyCopy":false}}]));
            assert_eq!(choices["result"]["complete"], true);
            let mut external_runs = vec![("executor-session", false), (external_child.session_id.as_str(), false)];
            if !reopened { external_runs.push((external_child.session_id.as_str(), true)); }
            for (session_id, waiting) in external_runs {
                let turn = format!("external-{reopened}-{waiting}");
                let rejected = peer.rpc("turn.start", json!({"sessionId":session_id,"turnId":format!("rejected-{turn}"),
                    "content":{"text":"review"},"inputSelections":{"example.review":["missing"]}})).await;
                assert_eq!(rejected["result"]["kind"], "blocked", "{rejected}");
                assert_eq!(rejected["result"]["message"], "Review document is unavailable");
                assert_eq!(rejected["result"]["preparation"][0]["source"]["packageId"], "example.consumer");
                let started = peer.rpc("turn.start", json!({"sessionId":session_id, "turnId":turn,
                    "content":{"text":if waiting {"wait"} else {"complete"}},
                    "inputSelections":{"example.review":["project/report.md"]}})).await;
                assert_eq!(started["ok"], true, "{started}");
                assert_eq!(started["result"]["preparation"][0]["receipt"]["document"], "project/report.md");
                if waiting {
                    while storage.read("executor-waiting".into()).await.unwrap().is_none() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    toggle(&mut peer, true).await;
                }
                loop {
                    let state = peer.rpc("turn.query", json!({"sessionId":session_id, "turnId":turn})).await;
                    assert_eq!(state["ok"], true, "{state}");
                    if !matches!(state["result"]["status"].as_str(), Some("admitted" | "created" | "running")) {
                        assert_eq!(state["result"]["status"], if waiting { "cancelled" } else { "completed" }, "{state}");
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                if waiting {
                    ready(&mut peer).await;
                    toggle(&mut peer, false).await;
                    ready(&mut peer).await;
                }
            }
            driver.shutdown(tokio::time::Instant::now() + Duration::from_secs(1)).await.unwrap();
            inspector.shutdown(tokio::time::Instant::now() + Duration::from_secs(1)).await.unwrap();
            peer.close().await;
            stop.cancel();
            tokio::time::timeout(Duration::from_secs(10), server).await.unwrap().unwrap().unwrap();
            cleanup.disarm();
            drop(host);
            let log = fixture.log().await;
            metering::verify(&log, if reopened { 2 } else { 1 }).await;
            for session in ["executor-session", external_child.session_id.as_str()] {
                assert!(!log.has_unsettled_shells(session).await.unwrap(), "plugin retirement left a live or unknown PTY");
                assert!(log.query_shell_resources(session, None, 0).await.unwrap().total >= 2);
            }
            assert_eq!(log.recover_shell_runs(100).await.unwrap(), 0, "clean shutdown must need no guessed PTY recovery");
            log.close().await.unwrap();
        }
        assert_eq!(provider.requests.lock().unwrap().len(), 9);
    }).await.expect("external plugin lifecycle must make bounded progress");
}
pub(super) async fn ready(peer: &mut Peer) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let status = peer
            .rpc("plugin.platform.query", json!({"view":"status"}))
            .await;
        assert_eq!(status["ok"], true, "{status}");
        if status["result"]["convergence"] == "converged" {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            let entries = peer
                .rpc("plugin.platform.query", json!({"view":"failures"}))
                .await;
            panic!("{status}; {entries}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn toggle(peer: &mut Peer, disabled: bool) {
    let result = peer.rpc("plugin.composition.apply", json!({
        "operations":[{"type":"update","entryId":"example.consumer","patch":{"disabled":disabled}}]
    })).await;
    assert_eq!(result["ok"], true, "{result}");
}
fn tool(id: &str, name: &str, input: Value) -> Value {
    json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"})
}
