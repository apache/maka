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

use super::support::{client_probe::ClientFixture, peer::Peer};
use maka_plugins::{composition::Scope, storage::Namespace};
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
mod native;
mod pricing;
mod usage;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn external_background_consent_recovers_and_revokes_without_losing_accepted_work() {
    tokio::time::timeout(Duration::from_secs(40), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/resource", listener.local_addr().unwrap());
    let http_stop = CancellationToken::new();
    let _http_cleanup = http_stop.clone().drop_guard();
    let http = tokio::spawn({
        let stop = http_stop.clone();
        async move {
            loop {
                let (mut socket, _) = tokio::select! {
                    _ = stop.cancelled() => return,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                    assert!(request.len() < 16384);
                }
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nauthorized").await.unwrap();
            }
        }
    });
    let fixture = ClientFixture::new("maka-background-");
    let model_server = super::support::message_recovery::Provider::start().await;
    let model = super::support::message_recovery::configure(&fixture, &model_server.base_url).await;
    let configuration =
        maka_config::ConfigurationStore::for_root(std::sync::Arc::new(fixture.owner()))
            .await
            .unwrap();
    let revision = configuration.catalog().await.unwrap().revision;
    let result = configuration
        .set_default_target(
            serde_json::from_value(json!({
                "expectedCatalogRevision": revision,
                "target": {"connectionId": model.connection_id, "modelId": model.model}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(
        result,
        maka_runtime::configuration::CatalogMutationResult::Committed { .. }
    ));
    configuration.close().await.unwrap();
    use base64::Engine;
    std::fs::write(fixture.workspace.join("proof.png"), base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc0AAAAASUVORK5CYII=").unwrap()).unwrap();
    let package = fixture.workspace.join("package");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!("../fixtures/background-plugin.mjs")
            .replace(
                "'__PROTOCOL_EXECUTABLE__'",
                &serde_json::to_string(&std::env::current_exe().unwrap()).unwrap(),
            )
            .replace("'__RESOURCE_URL__'", &serde_json::to_string(&url).unwrap()),
    )
    .unwrap();
    std::fs::write(package.join("client.js"), "immutable consent client").unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        serde_json::to_vec(&json!({
            "schemaVersion":1,"id":"example.background",
            "runtime":{"entry":"host.mjs","sdkVersion":2,"vm":"shared"},
            "client":{"entry":"client.js","sdkVersion":1}
        }))
        .unwrap(),
    )
    .unwrap();
    let mut grant = Value::Null;
    let mut accepted = Value::Null;
    let mut root_grant = Value::Null;
    let mut root_result = Value::Null;
    let mut network_grant = Value::Null;
    let mut material_copy = Value::Null;
    let mut usage = usage::Probe::default();
    let mut pricing = pricing::Probe::default();
    for reopened in [false, true] {
        let host = Host::open(fixture.owner()).await.unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("background.sock");
        #[cfg(windows)]
        let endpoint = std::path::PathBuf::from(format!(
            r"\\.\pipe\maka-background-{}",
            uuid::Uuid::new_v4()
        ));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop.clone()),
        );
        let mut peer = Peer::new(host.clone(), "background-client").await;
        if !reopened {
            success(
                peer.rpc("plugin.package.install", json!({"sourcePath":package}))
                    .await,
            );
            success(peer.rpc("plugin.composition.apply", json!({"operations":[
                {"type":"insert","rootId":"profile","entry":{"id":"background-host","packageId":"example.background"}},
                {"type":"insert","rootId":"desktop-ui","entry":{"id":"background-ui","packageId":"example.background"}}
            ]})).await);
        }
        ready(&mut peer).await;
        let page = success(
            peer.rpc("plugin.client.query", json!({"kind":"snapshot"}))
                .await,
        );
        let entry = page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["entryId"] == "background-ui")
            .unwrap();
        let client = json!({"entryId":entry["entryId"],"extensionId":entry["extensionId"],"activation":entry["activation"],"contentDigest":entry["contentDigest"],"clientDigest":entry["clientDigest"]});
        let document = success(
            peer.rpc("plugin.remote", json!({"kind":"open_document"}))
                .await,
        )["document"]
            .clone();
        if !reopened {
            success(peer.rpc("session.create", json!({"sessionId":"background-session", "workspace":{"kind":"host_path","path":fixture.workspace}, "executorId":"example.background","sandboxMode":"danger-full-access"})).await);
            success(peer.rpc("artifact.ingest", json!({"kind":"begin","sessionId":"background-session","uploadId":"history-material","name":"evidence.txt","mimeType":"text/plain","totalBytes":1,"contentSha256":maka_runtime::artifact::content_digest(b"x")})).await);
            success(peer.rpc("artifact.ingest", json!({"kind":"chunk","sessionId":"background-session","uploadId":"history-material","offset":0,"chunkBase64":"eA=="})).await);
            success(peer.rpc("artifact.ingest", json!({"kind":"commit","sessionId":"background-session","uploadId":"history-material"})).await);
        }
        let mut publication = super::plugin_clients::publication("desktop", "inspect");
        let mut scoped = publication.clone();
        scoped["sessionId"] = json!("background-session");
        publication["registrationId"] = json!("global-services");
        publication["offers"] = json!([]);
        publication["services"] = json!([{"serviceId":"maka_notifications","version":"1"}]);
        let mut turn_only =
            super::plugin_clients::publication("desktop-turn", "turn_only")["offers"][0].clone();
        turn_only["affinity"] = json!("turn");
        publication["offers"]
            .as_array_mut()
            .unwrap()
            .push(turn_only);
        success(peer.rpc("client.capability.replace", publication).await);
        success(peer.rpc("client.capability.replace", scoped).await);
        let mut unrelated = super::plugin_clients::publication("other-session", "unexpected");
        unrelated["sessionId"] = json!("unrelated-session");
        success(peer.rpc("client.capability.replace", unrelated).await);
        let mut foreign = Peer::new(host.clone(), "another-client").await;
        success(
            foreign
                .rpc(
                    "client.capability.replace",
                    super::plugin_clients::publication("foreign", "unexpected"),
                )
                .await,
        );
        let client_grant = success(peer.rpc("plugin.authorization", json!({"client":client,"scope":"profile","command":{"kind":"approve","request":{
            "operationId":"9d8b0ab1-200d-41c4-b05f-590471670d43", "title":"Use my Client", "target":{"kind":"session","sessionId":"background-session"}, "capabilities":["client_capabilities"]
        }}})).await)["grant"].clone();
        client_call(&mut peer, &client, &document, &client_grant).await;
        let notification_grant = success(peer.rpc("plugin.authorization", json!({"client":client,"scope":"profile","command":{"kind":"approve","request":{
            "operationId":"d20f56d8-cccd-45f0-ae1c-d5766680b70e", "title":"Read sessions and notify me", "target":{"kind":"profile"}, "capabilities":["notifications","read_sessions"]
        }}})).await)["grant"].clone();
        notification_call(&mut peer, &client, &document, &notification_grant).await;
        foreign.close().await;
        if !reopened {
            network_grant = success(peer.rpc("plugin.authorization", json!({
                "client":client,"scope":"profile","command":{"kind":"approve","request":{
                    "operationId":uuid::Uuid::new_v4(),"title":"HTTP without file or process access",
                    "target":{"kind":"plugin_workspace","sandboxMode":"read-only"},
                    "capabilities":["network"]
                }}
            })).await)["grant"].clone();
        }
        let network_input = json!({"grant":network_grant["id"],"operation":"network-only"});
        assert_eq!(
            remote(
                &mut peer,
                &client,
                &document,
                "network",
                network_input.clone()
            )
            .await,
            true
        );
        if reopened {
            success(peer.rpc("plugin.authorization", json!({
                "client":client,"scope":"profile","command":{"kind":"revoke","id":network_grant["id"]}
            })).await);
            assert_eq!(
                remote(&mut peer, &client, &document, "network", network_input).await,
                false
            );
        }
        if !reopened {
            assert_eq!(
                remote(
                    &mut peer,
                    &client,
                    &document,
                    "resources",
                    json!({
                        "operationId":uuid::Uuid::new_v4(), "title":"Use current Remote authority",
                        "target":{"kind":"session","sessionId":"background-session"},
                        "capabilities":["processes","network"]
                    })
                )
                .await,
                json!(true)
            );
            // No Session entry or implicit grant exists for this profile plugin.
            remote(
                &mut peer,
                &client,
                &document,
                "queue",
                json!({"grant":uuid::Uuid::new_v4(),"operation":"unapproved"}),
            )
            .await;
            assert_eq!(
                state(&mut peer, &client, &document).await,
                json!({"error":"revoked"})
            );
            let proposal = json!({"client":client,"scope":"profile","command":{"kind":"approve","request":{
                "operationId":uuid::Uuid::new_v4(),"title":"Run background acceptance","target":{"kind":"session","sessionId":"background-session"},"capabilities":["executions","processes","network","read_files","write_files","models"]
            }}});
            grant =
                success(peer.rpc("plugin.authorization", proposal.clone()).await)["grant"].clone();
            assert_eq!(
                success(peer.rpc("plugin.authorization", proposal).await)["grant"],
                grant
            );
            remote(
                &mut peer,
                &client,
                &document,
                "queue",
                json!({"grant":grant["id"],"operation":"once"}),
            )
            .await;
        }
        let result = state(&mut peer, &client, &document).await;
        assert_eq!(result["progress"]["state"], "ended", "{result}");
        let sources = success(peer.rpc("session.sources.query", json!({
            "sessionId":"background-session", "turnId":result["receipt"]["invocation"]["turn_id"]
        })).await);
        assert_eq!(
            sources["messages"][0]["content"]["quotes"][0]["text"],
            "q".repeat(40_000)
        );
        assert_eq!(
            result["progress"]["outcome"]["kind"], "completed",
            "{result}"
        );
        if !reopened {
            root_grant = success(peer.rpc("plugin.authorization", json!({
                "client":client,"scope":"profile","command":{"kind":"approve","request":{
                    "operationId":uuid::Uuid::new_v4(),"title":"Create independent Sessions",
                    "target":{"kind":"plugin_workspace","sandboxMode":"read-only"},
                    "capabilities":["executions"]
                }}
            })).await)["grant"].clone();
        }
        let created = remote(
            &mut peer,
            &client,
            &document,
            "root",
            json!({
                "grant":root_grant["id"],"operation":"workspace-root"
            }),
        )
        .await;
        let history = remote(&mut peer, &client, &document, "history", json!({"grant":grant["id"],"operation":maka_runtime::artifact::upload_artifact_id("background-session", "history-material")})).await;
        assert_eq!(history["original"], "Run authorized work", "{history}");
        assert!(
            history["text"]
                .as_str()
                .unwrap()
                .contains("Run authorized work"),
            "{history}"
        );
        assert_eq!(
            history["material"]["ref"]["sessionId"],
            "background-session"
        );
        if reopened {
            assert_eq!(history["material"], material_copy);
        } else {
            material_copy = history["material"].clone();
        }
        let managed = success(
            peer.rpc(
                "session.catalog.query",
                json!({
                    "kind":"get", "sessionId":created["root"]["sessionId"]
                }),
            )
            .await,
        )["session"]
            .clone();
        let private_workspace =
            std::path::Path::new(managed["workspace"]["hostCwd"].as_str().unwrap());
        assert!(
            private_workspace.starts_with(
                fixture
                    .workspace
                    .parent()
                    .unwrap()
                    .join("root")
                    .canonicalize()
                    .unwrap()
                    .join("plugin-workspaces")
            )
        );
        assert_ne!(private_workspace, fixture.workspace.canonicalize().unwrap());
        let ordinary = peer.rpc("session.configuration.update", json!({
            "sessionId":created["root"]["sessionId"], "expectedRevision":managed["revision"],
            "patch":{"sandboxMode":"danger-full-access"}
        })).await;
        assert_eq!(ordinary["ok"], false, "{ordinary}");
        let foreign_copy = peer.rpc("session.revision.create", json!({
            "sourceSessionId":created["root"]["sessionId"], "targetSessionId":"native-cannot-copy-managed",
            "sourceTurnId":created["receipt"]["invocation"]["turn_id"], "expectedSourceRevision":managed["revision"]
        })).await;
        assert_eq!(
            foreign_copy["error"]["code"], "operation_conflict",
            "{foreign_copy}"
        );
        let foreign_receipt = peer
            .rpc(
                "session.copy.query",
                json!({"targetSessionId":created["draft"]}),
            )
            .await;
        assert_eq!(
            foreign_receipt["error"]["code"], "operation_conflict",
            "{foreign_receipt}"
        );
        let foreign_sources = peer.rpc("session.sources.query", json!({
            "sessionId":created["root"]["sessionId"], "turnId":created["receipt"]["invocation"]["turn_id"]
        })).await;
        assert_eq!(
            foreign_sources["error"]["code"], "operation_conflict",
            "{foreign_sources}"
        );
        // Draft removal closes only its own ready subscription, not another
        // Session on the same connection. Reopening replays the tombstone.
        let mut observer = Peer::new(host.clone(), "revision-observer").await;
        let mut draft_subscription = Value::Null;
        if !reopened {
            let live = success(
                observer
                    .rpc(
                        "subscription.open",
                        json!({
                            "sessionId":created["root"]["sessionId"], "transcript":{"kind":"none"}
                        }),
                    )
                    .await,
            );
            success(
                observer
                    .rpc(
                        "subscription.ready",
                        json!({"subscriptionId":live["subscriptionId"]}),
                    )
                    .await,
            );
            draft_subscription = success(
                observer
                    .rpc(
                        "subscription.open",
                        json!({
                            "sessionId":created["draft"], "transcript":{"kind":"none"}
                        }),
                    )
                    .await,
            );
            success(
                observer
                    .rpc(
                        "subscription.ready",
                        json!({"subscriptionId":draft_subscription["subscriptionId"]}),
                    )
                    .await,
            );
        }
        for _ in 0..2 {
            let abandoned = remote(
                &mut peer,
                &client,
                &document,
                "abandon-revision",
                json!({
                    "grant":root_grant["id"], "operation":"unused-revision"
                }),
            )
            .await;
            assert_eq!(abandoned, "abandoned");
        }
        if !reopened {
            loop {
                let frame = observer.frame().await;
                if frame["kind"] != "subscription.closed" {
                    continue;
                }
                assert_eq!(
                    frame["subscriptionId"],
                    draft_subscription["subscriptionId"]
                );
                assert_eq!(frame["reason"], "session_removed");
                assert_eq!(frame["sequence"], draft_subscription["nextSequence"]);
                break;
            }
        }
        let surviving = success(
            observer
                .rpc(
                    "session.catalog.query",
                    json!({
                        "kind":"get", "sessionId":created["root"]["sessionId"]
                    }),
                )
                .await,
        );
        assert_eq!(surviving["session"]["id"], created["root"]["sessionId"]);
        observer.close().await;
        if reopened {
            assert_eq!(created, root_result);
        } else {
            root_result = created;
        }
        if reopened {
            assert_eq!(result["receipt"], accepted);
            success(peer.rpc("plugin.authorization", json!({"client":client,"scope":"profile","command":{"kind":"revoke","id":grant["id"]}})).await);
            // The worker keeps its already-restored capability: revocation must
            // invalidate its next call, not merely prevent another restore.
            remote(
                &mut peer,
                &client,
                &document,
                "queue",
                json!({"grant":grant["id"],"operation":"after-revoke"}),
            )
            .await;
            assert_eq!(
                state(&mut peer, &client, &document).await,
                json!({"error":"revoked"})
            );
            let session = success(
                peer.rpc(
                    "session.catalog.query",
                    json!({"kind":"get","sessionId":"background-session"}),
                )
                .await,
            );
            success(peer.rpc("session.configuration.update", json!({
                "sessionId":"background-session", "expectedRevision":session["session"]["revision"],
                "patch":{"sandboxMode":"workspace-write"}
            })).await);
            // An approval reply is an inert receipt, not renewed authority. A
            // lost-reply retry must survive revocation and target narrowing.
            let replay = success(peer.rpc("plugin.authorization", json!({
                "client":client,"scope":"profile","command":{"kind":"approve","request":grant["request"]}
            })).await);
            let mut revoked = grant.clone();
            revoked["revoked"] = json!(true);
            assert_eq!(replay["grant"], revoked);
            let mut changed = grant["request"].clone();
            changed["title"] = json!("Different proposal");
            let conflict = peer.rpc("plugin.authorization", json!({
                "client":client,"scope":"profile","command":{"kind":"approve","request":changed}
            })).await;
            assert_eq!(
                conflict["error"]["code"], "operation_conflict",
                "{conflict}"
            );
        } else {
            accepted = result["receipt"].clone();
        }
        usage.check(&mut peer, &client, &document, reopened).await;
        pricing
            .check(&host, &mut peer, &client, &document, &usage.grant, reopened)
            .await;
        peer.close().await;
        stop.cancel();
        server.await.unwrap().unwrap();
        cleanup.disarm();
        drop(host);
    }
    let log = fixture.log().await;
    assert!(!fixture.workspace.parent().unwrap().join("outside").exists());
    assert!(
        !log.has_unsettled_shells("background-session")
            .await
            .unwrap()
    );
    let namespace = Namespace::new("example.background", Scope::Profile).unwrap();
    let receipt = log
        .plugin_execution_receipt(&namespace, "once")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_value(receipt).unwrap(), accepted);
    assert!(
        log.plugin_execution_receipt(&namespace, "after-revoke")
            .await
            .unwrap()
            .is_none()
    );
    let usage = log
        .model_attempts(
            maka_event_log::usage::Query {
                from: 0.0,
                to: f64::MAX,
                session_id: Some("background-session".into()),
                through: None,
            },
            0,
            100,
        )
        .await
        .unwrap();
    assert_eq!(
        usage.total, 3,
        "count actual model requests, not successful tool payloads twice"
    );
    // This fixture uses a plugin executor, not the Agent model loop: all three
    // requests come from authorized Remote/background SDK resource calls.
    assert!(usage.attempts.iter().all(|attempt| matches!(
        attempt.origin,
        maka_event_log::usage::Origin::Auxiliary { .. }
    )));
    assert!(
        usage
            .attempts
            .iter()
            .all(|attempt| attempt.outcome == maka_event_log::usage::Outcome::Success)
    );
    log.close().await.unwrap();
    assert_eq!(
        model_server.requests.lock().unwrap().len(),
        3,
        "no request may start without consent or after revocation"
    );
    http_stop.cancel();
    http.await.unwrap();
}
async fn notification_call(peer: &mut Peer, client: &Value, document: &Value, grant: &Value) {
    let binding = json!({"client":client,"method":"notify","sessionId":null});
    let target = success(
        peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
            .await,
    )["target"]
        .clone();
    peer.send_rpc(
        "notification",
        "plugin.remote",
        json!({
            "kind":"call","binding":binding,"target":target,"document":document,
            "input":{"grant":grant["id"],"operation":"notification"}
        }),
    );
    let mut invocation = None;
    let mut admitted = false;
    loop {
        let frame = peer.frame().await;
        match frame["kind"].as_str() {
            Some("client.capability.service_call") => {
                assert!(invocation.is_none(), "notification replayed");
                assert_eq!(frame["serviceId"], "maka_notifications");
                assert_eq!(frame["method"], "send");
                assert_eq!(frame["input"]["packageId"], "example.background");
                assert_eq!(
                    frame["input"]["notification"]["destination"]["kind"],
                    "local"
                );
                assert!(frame.get("sessionId").is_none());
                invocation = Some(frame["invocationId"].clone());
                peer.send_frame(json!({"kind":"client.capability.accepted","invocationId":frame["invocationId"],"admissionEvidence":{"kind":"none"}}));
            }
            Some("client.capability.admitted") => {
                assert!(!admitted);
                assert_eq!(Some(&frame["invocationId"]), invocation.as_ref());
                admitted = true;
                peer.send_frame(json!({"kind":"client.capability.result","invocationId":frame["invocationId"],"result":{"content":[],"structuredContent":{"ok":true}}}));
            }
            _ if frame["requestId"] == "notification" => {
                assert_eq!(success(frame)["value"], true);
                assert!(admitted);
                break;
            }
            _ => assert!(frame.get("requestId").is_none(), "{frame}"),
        }
    }
}

async fn client_call(peer: &mut Peer, client: &Value, document: &Value, grant: &Value) {
    let binding = json!({"client":client,"method":"clients","sessionId":"background-session"});
    let target = success(
        peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
            .await,
    )["target"]
        .clone();
    for (source, input) in [
        ("remote", json!({"operationId":uuid::Uuid::new_v4()})),
        ("background", json!({"grant":grant["id"]})),
    ] {
        peer.send_rpc("client-call", "plugin.remote", json!({"kind":"call", "binding":binding,"target":target,"document":document,"input":input}));
        let mut invocation = None;
        let mut admitted = false;
        loop {
            let frame = peer.frame().await;
            match frame["kind"].as_str() {
                Some("client.capability.call") => {
                    assert!(invocation.is_none(), "duplicate client effect");
                    assert_eq!(frame["source"]["kind"], source);
                    assert_eq!(frame["source"]["sessionId"], "background-session");
                    assert!(frame["source"].get("turnId").is_none());
                    assert!(frame.get("cwd").is_none());
                    assert_eq!(frame["serverId"], "desktop");
                    invocation = Some(frame["invocationId"].clone());
                    peer.send_frame(json!({"kind":"client.capability.accepted","invocationId":frame["invocationId"],"admissionEvidence":{"kind":"none"}}));
                }
                Some("client.capability.admitted") => {
                    assert_eq!(Some(&frame["invocationId"]), invocation.as_ref());
                    assert!(!admitted);
                    admitted = true;
                    peer.send_frame(json!({"kind":"client.capability.result","invocationId":frame["invocationId"],"result":{"content":[],"structuredContent":{"inspected":true}}}));
                }
                _ if frame["requestId"] == "client-call" => {
                    let result = success(frame);
                    assert_eq!(result["value"]["structuredContent"]["inspected"], true);
                    assert!(admitted);
                    break;
                }
                _ => assert!(frame.get("requestId").is_none(), "{frame}"),
            }
        }
    }
}

async fn ready(peer: &mut Peer) {
    loop {
        let result = success(
            peer.rpc("plugin.platform.query", json!({"view":"status"}))
                .await,
        );
        if result["convergence"] == "converged" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn remote(
    peer: &mut Peer,
    client: &Value,
    document: &Value,
    method: &str,
    input: Value,
) -> Value {
    let binding = json!({"client":client,"method":method,"sessionId":if method == "resources" { Some("background-session") } else { None }});
    let target = success(
        peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
            .await,
    )["target"]
        .clone();
    success(peer.rpc("plugin.remote", json!({"kind":"call","binding":binding,"target":target,"document":document,"input":input})).await)["value"].clone()
}
async fn state(peer: &mut Peer, client: &Value, document: &Value) -> Value {
    loop {
        let state = remote(peer, client, document, "state", Value::Null).await;
        if !state.is_null() {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
fn success(value: Value) -> Value {
    assert_eq!(value["ok"], true, "{value}");
    value["result"].clone()
}
