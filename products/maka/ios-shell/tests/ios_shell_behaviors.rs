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

#![cfg(not(target_os = "ios"))]

use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    host::{Configuration, Host, LifecycleMode, Options, PeerPairingOptions},
    logs,
    transport::GATEWAY,
};
use maka_ios_shell::{bridge::HostBridge, engine_config};
use maka_packages::Package;
use maka_remote_transport::{
    Relay,
    host::HostPeerTransport,
    server::{RelayServer, RelayTls},
};
use nsh_core::{
    Size,
    platform::{Environment, Os},
    prelude::px,
};
use nsh_engine::HostChannel;
use nsh_testing::Headless;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn package(id: &str, host: Value) -> Package {
    Package::new(BTreeMap::from([(
        "maka.extension.json".into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":id,"application":{"host":host}}))
            .unwrap(),
    )]))
    .unwrap()
}

async fn logs_host() -> (tempfile::TempDir, Arc<Host>) {
    let dir = tempfile::tempdir().unwrap();
    private_directory(dir.path()).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("ownership"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
    let contract = logs::contract();
    let logs = package(
        "test.logs",
        json!({
            "implementation":{"kind":"native","implementation":logs::HOST_LOGS},
            "configuration":{"type":"object"},"imports":{},
            "exports":{"HostLogs":{"contract":contract,"availability":"required"}}
        }),
    );
    let gateway = package(
        "test.gateway",
        json!({
            "implementation":{"kind":"native","implementation":GATEWAY},
            "configuration":{"type":"object"},"exports":{},
            "imports":{"hostLogs":{"contract":contract,"cardinality":{"kind":"one"}}}
        }),
    );
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    let source = store.commit_application(
        deployment, 0,
        serde_json::from_value(json!({"instances":{
            "logs":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":logs.application_ref()},"usePackage":"host"},
            "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway.application_ref()},"usePackage":"host",
                "bindings":{"hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}]}}
        }})).unwrap(),
        vec![], vec![logs, gateway],
    ).await.unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read","watch"],"recovery":false}}
        })).unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    store
        .select_committed_application_launch(source, serde_json::to_value(&configuration).unwrap())
        .await
        .unwrap();
    let host = Host::open_with_options(
        store.clone(),
        deployment,
        Default::default(),
        None,
        configuration.clone(),
        Options {
            lifecycle_mode: LifecycleMode::Ephemeral,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    (dir, host)
}

const RELAY_TOKEN: &str = "test-ephemeral-relay-bearer";

async fn https_relay() -> (RelayServer, Relay, String) {
    let tls = RelayTls::self_signed(vec!["127.0.0.1".into()]).unwrap();
    let addr = "127.0.0.1:0".parse().unwrap();
    let relay = RelayServer::bind(None, Some(addr), Some(addr), Some(&tls), Some(RELAY_TOKEN))
        .await
        .unwrap();
    let endpoint = maka_remote_pairing::RelayEndpoint {
        url: format!("https://{}", relay.https_addr().unwrap()),
        quic_port: Some(relay.quic_addr().unwrap().port()),
        cert_sha256: relay.cert_sha256().map(hex::encode),
    };
    (
        relay,
        Relay::new(&endpoint, None, Some(RELAY_TOKEN.into())).unwrap(),
        endpoint.url,
    )
}

struct Live {
    _root: tempfile::TempDir,
    host: Arc<Host>,
    uri: String,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<Result<(), String>>,
    transport: tokio::task::JoinHandle<maka_remote_transport::Result<()>>,
    handshakes: mpsc::UnboundedReceiver<(maka_host_runtime::application::host::PeerId, String)>,
}

impl Live {
    async fn start(config: &Relay, name: &str) -> Self {
        let (root, host) = logs_host().await;
        let mut transport = HostPeerTransport::bind(&host, std::slice::from_ref(config), false)
            .await
            .unwrap();
        let routes = transport.wait_for_relay().await.unwrap();
        let (send, receive) = HostPeerTransport::ingress();
        let stop = CancellationToken::new();
        let (accepted, handshakes) = mpsc::unbounded_channel();
        let transport = tokio::spawn(transport.serve(send, stop.clone(), move |peer, sas| {
            accepted
                .send((peer.clone(), sas))
                .expect("test SAS observer");
        }));
        let server = tokio::spawn({
            let host = host.clone();
            let stop = stop.clone();
            async move { host.serve_peer_streams(receive, stop).await }
        });
        let invite = host
            .prepare_peer_pairing(PeerPairingOptions {
                relays: routes,
                host_name: name.into(),
                direct_endpoints: vec![],
                label: None,
                ttl_secs: None,
            })
            .await
            .unwrap();

        Self {
            _root: root,
            host,
            uri: invite.uri,
            stop,
            server,
            transport,
            handshakes,
        }
    }

    async fn sas(&mut self) -> (maka_host_runtime::application::host::PeerId, String) {
        tokio::time::timeout(Duration::from_secs(10), self.handshakes.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn shutdown(self) {
        self.stop.cancel();
        self.server.await.unwrap().unwrap();
        self.transport.await.unwrap().unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn signed_invite_is_confirmed_on_the_live_connection_and_revocation_is_visible() {
    let (relay, config, relay_url) = https_relay().await;
    let mut first = Live::start(&config, "First test Host").await;
    let mut second = Live::start(&config, "Second test Host").await;
    let support = tempfile::tempdir().unwrap();
    let channel = HostChannel::new();
    let runtime = tokio::runtime::Handle::current();
    let bridge =
        HostBridge::attach(channel.clone(), support.path().to_owned(), runtime.clone()).unwrap();
    let mut config = engine_config(channel, runtime);
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start_with_link(config, &first.uri).unwrap();
    app.wait_for("label:Pairing URI input").unwrap();
    app.type_text("label:Relay URL", &relay_url).unwrap();
    app.type_text("label:Relay Bearer token", RELAY_TOKEN)
        .unwrap();
    app.press("label:Connect and compare").unwrap();

    let (peer, sas) = first.sas().await;
    app.wait_for(&format!("text:{sas}")).unwrap();
    assert!(first.host.list_peer_access().await.unwrap().is_empty());
    assert!(!support.path().join("hosts.json").exists());

    app.press("label:Codes match — pair").unwrap();
    app.wait_for("text:First test Host").unwrap();
    assert_eq!(first.host.list_peer_access().await.unwrap().len(), 1);
    assert!(matches!(
        first.handshakes.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));

    app.send_url_scheme(&second.uri);
    app.wait_for("label:Pairing URI input").unwrap();
    app.type_text("label:Relay URL", &relay_url).unwrap();
    app.type_text("label:Relay Bearer token", RELAY_TOKEN)
        .unwrap();
    app.press("label:Connect and compare").unwrap();
    let (_, sas) = second.sas().await;
    app.wait_for(&format!("text:{sas}")).unwrap();
    app.press("label:Codes match — pair").unwrap();
    app.wait_for("text:Second test Host").unwrap();

    app.press("label:Open drawer").unwrap();
    app.wait_for("label:Host First test Host").unwrap();
    app.press("label:Host First test Host").unwrap();
    app.wait_for("text:First test Host").unwrap();
    let (same_peer, _) = first.sas().await;
    assert_eq!(peer, same_peer);

    app.press("label:Host actions").unwrap();
    app.press("text:Check connection").unwrap();
    app.wait_for("text:Host responded").unwrap();

    drop(app);
    drop(bridge);
    let persisted = std::fs::read_to_string(support.path().join("hosts.json")).unwrap();
    assert!(!persisted.contains(RELAY_TOKEN));
    let channel = HostChannel::new();
    let runtime = tokio::runtime::Handle::current();
    let _bridge =
        HostBridge::attach(channel.clone(), support.path().to_owned(), runtime.clone()).unwrap();
    let mut config = engine_config(channel, runtime);
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.wait_for("label:Relay Bearer First test Host").unwrap();
    app.press("label:Relay Bearer First test Host").unwrap();
    app.type_text("label:Saved Host relay Bearer", RELAY_TOKEN)
        .unwrap();
    app.press("label:Connect with Bearer").unwrap();
    let (same_peer, _) = first.sas().await;
    assert_eq!(same_peer, peer);
    app.wait_for("label:Host actions").unwrap();
    assert!(first.host.revoke_peer_access(peer).await.unwrap());
    app.wait_for("text:/peer access revoked/").unwrap();
    drop(app);
    first.shutdown().await;
    second.shutdown().await;
    relay.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conversation_consumes_events_and_reconnects_from_the_last_seen_cursor() {
    let channel = HostChannel::new();
    let session = json!({
        "id":"chat","title":"Cursor test","kind":"agent","parentSessionId":null,"labels":[],
        "workspace":{"path":"/workspace"},"revision":1,"updatedAt":1,
        "archived":false,"pinned":false,"hasUnread":false,"activity":"idle",
    });
    let snapshot = |admission: &str, revision: u64| {
        json!({
            "revision": revision,
            "devicePeerId":"test","filter":{"kind":"all_computers"},
            "hosts":[{"rootId":"root","hostName":"Remote","peerId":"remote","endpoints":[],"connected":true}],
            "active":{"rootId":"root","hostName":"Remote","epoch":"same-host-process","session":admission,
                      "endpoints":["agent"],"pathSummary":{"kind":"relay","rttMs":3},"transport":"quic"},
        })
    };
    let first = snapshot("first-anchor", 1);
    let second = snapshot("next-anchor", 3);
    channel.handle("ios.bootstrap", {
        let first = first.clone();
        move |call| call.reply(Ok(first.clone()))
    });
    channel.handle("ios.connectHost", move |call| {
        call.reply(Ok(second.clone()))
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({"cancelled":true})))
    });
    let live_update = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    channel.handle("ios.hostQuery", {
        let session = session.clone();
        let live_update = live_update.clone();
        move |mut call| {
            let data = call.take_data();
            let value = match data["method"].as_str().unwrap() {
                "projects" => json!({"kind":"projects","projects":[]}),
                "directories" => json!({"kind":"roots","roots":[]}),
                "list" => json!({"revision":"1","sessions":[session],"needsYouCount":0,"after":null}),
                "observe" => json!({"session":session,"through":4,"run":null}),
                "history" => {
                    let position = &data["input"]["position"];
                    let earlier = position["kind"] == "before";
                    let live = live_update.load(std::sync::atomic::Ordering::Relaxed);
                    let (chunks, before) = if earlier && position["cursor"]["oldest"] == true {
                        assert_eq!(data["input"]["through"], 4, "old cursor retains its cut");
                        (vec![history_chunk(1, "user", "Oldest retained cursor")], Value::Null)
                    } else if earlier {
                        let mut prefix = history_chunk(2, "user", "前半段 half ");
                        prefix["totalBytes"] = json!(25);
                        let mut imported = history_chunk(1, "assistant", "Imported history");
                        imported["position"] = json!({"kind":"imported","path":["00000000-0000-4000-8000-000000000010"],
                            "snapshot":"00000000-0000-4000-8000-000000000003","messageOrdinal":0,"partOrdinal":0});
                        imported["order"]["path"] = json!([1, 0]);
                        let mut snapshot = history_chunk(1, "assistant", "Snapshot history");
                        snapshot["position"]["kind"] = json!("snapshot");
                        snapshot["position"]["path"] = json!(["00000000-0000-4000-8000-000000000011"]);
                        snapshot["position"]["snapshot"] = json!("00000000-0000-4000-8000-000000000004");
                        snapshot["order"]["path"] = json!([1, 1]);
                        (vec![imported, snapshot, prefix],json!({"oldest":true}))
                    } else if live {
                        (vec![history_chunk(6, "assistant", "New live tail message")], json!({"newTail":true}))
                    } else {
                        let mut suffix = history_chunk(2, "user", "half is visible");
                        suffix["offset"] = json!(10);
                        suffix["totalBytes"] = json!(25);
                        (vec![suffix, history_chunk(3, "user", "Live user history"),
                              history_chunk(4, "assistant", "Live assistant history")], json!({"fragment":true}))
                    };
                    json!({"kind":"ready","through":if live { 6 } else { 4 },"chunks":chunks,"before":before})
                },
                "goal" => json!({"enabled":false,"current":null}),
                "pendingInteractions" => json!({"revision":1,"entries":[
                    {"requestId":"approval","kind":"permissions","toolUseId":"tool-1"},
                    {"requestId":"future","kind":"permissions","toolUseId":"future-tool"},
                    {"requestId":"child","kind":"session_approval","toolUseId":"child-tool"},
                    {"requestId":"question","kind":"question","toolUseId":"tool-2"}
                ]}),
                "interaction" if data["input"]["requestId"] == "approval" => json!({
                    "requestId":"approval","outcome":null,
                    "request":{"kind":"permissions","toolUseId":"tool-1",
                               "request":{"reason":"Read files","command":null,"permissions":{"filesystem":[{"path":"/private/test","scope":"subtree","access":"write"}],"network":{"restricted":{"destinations":[{"host":"example.org","port":443}]}}}}}
                }),
                "interaction" if data["input"]["requestId"] == "future" => json!({
                    "requestId":"future","outcome":null,
                    "request":{"kind":"permissions","toolUseId":"future-tool",
                               "request":{"reason":"Future wire permission","command":null,"permissions":{"unknown":"new grant"}}}
                }),
                "interaction" if data["input"]["requestId"] == "child" => json!({
                    "requestId":"child","outcome":null,
                    "request":{"kind":"session_approval","sessionId":"child-session","requestId":"child-request","basis":{"path":"/child-root"},
                               "answer":{"kind":"permissions","decision":{"decision":"allow","scope":"session",
                                   "permissions":{"filesystem":[{"path":"/child-root","scope":"exact","access":"read"}],"network":"denied"}}}}
                }),
                "interaction" => json!({
                    "requestId":"question","outcome":null,"request":{"kind":"question","toolUseId":"tool-2",
                    "questions":[{"question":"Which mode?","options":[{"label":"Local"}]}]}
                }),
                "queueMessage" => json!({"kind":"ready","revision":8,"message":"Second queued",
                                       "hasAttachments":false,"quotes":[]}),
                method => panic!("unexpected query {method}"),
            };
            call.reply(Ok(json!({"value":value})));
        }
    });
    let (mutations, mut seen_mutations) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        assert_eq!(data["anchorSession"], "first-anchor");
        let value = match data["method"].as_str().unwrap() {
            "openBot" => json!({"kind":"opened","sessionId":"chat"}),
            "respond" => {
                mutations.send(data["input"].clone()).unwrap();
                json!({"kind":"recorded"})
            }
            "editQueue" => {
                mutations.send(data["input"].clone()).unwrap();
                json!({"kind":"committed","revision":8})
            }
            method => panic!("unexpected mutation {method}"),
        };
        call.reply(Ok(json!({"value":value})));
    });
    let (watches, mut seen_watches) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let id = data["subscriptionId"].as_str().unwrap().to_owned();
        let watch = data["method"] == "watch";
        call.reply(Ok(json!({"subscriptionId":id,"generation":1})));
        if watch {
            watches
                .send((id, data["input"]["after"].as_u64().unwrap()))
                .unwrap();
        }
    });

    let mut config = engine_config(channel.clone(), tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("text:Remote · Online").unwrap();
    app.press("label:Open Maka Bot").unwrap();
    app.wait_for("text:Cursor test").unwrap();
    let (id, after) = tokio::time::timeout(Duration::from_secs(5), seen_watches.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after, 4);
    app.wait_for("text:Live user history").unwrap();
    app.wait_for("text:Live assistant history").unwrap();
    app.wait_for("text:half is visible").unwrap();
    app.press("label:Load earlier messages").unwrap();
    app.wait_for("text:前半段 half is visible").unwrap();
    app.wait_for("text:Imported history").unwrap();
    app.wait_for("text:Snapshot history").unwrap();
    live_update.store(true, std::sync::atomic::Ordering::Relaxed);
    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":id,"generation":1,"item":{"kind":"events","through":6,"nextAfter":6,
        "events":[{"sequence":6,"runId":"run","turnId":"turn","fact":{"kind":"transcript_changed"}}]}
    })).unwrap();
    app.wait_for("text:New live tail message").unwrap();
    app.wait_for("text:前半段 half is visible").unwrap();
    app.wait_for("text:Imported history").unwrap();
    app.press("label:Load earlier messages").unwrap();
    app.wait_for("text:Oldest retained cursor").unwrap();
    app.wait_for("text:Live user history").unwrap();
    app.wait_for("text:Live assistant history").unwrap();

    app.wait_for("text:/Read and write.*Directory and descendants/")
        .unwrap();
    app.wait_for("text:/example.org/").unwrap();
    app.wait_for("label:Allow once").unwrap();
    app.press("label:Allow once").unwrap();
    app.wait_for("text:/Allowed once/").unwrap();
    let permission = seen_mutations.try_recv().unwrap();
    assert_eq!(permission["requestId"], "approval");
    assert_eq!(
        permission["answer"]["decision"]["permissions"]["filesystem"][0]["path"],
        "/private/test"
    );
    app.wait_for("text:/This permission shape must be reviewed on Desktop/")
        .unwrap();
    app.wait_for_gone("label:Allow once", Duration::from_secs(3))
        .unwrap();
    app.wait_for_gone("label:Allow for this turn", Duration::from_secs(3))
        .unwrap();

    app.wait_for("text:/scope: this conversation/").unwrap();
    app.wait_for("text:/Exact path.*child-root/").unwrap();
    app.press("label:Approve child decision").unwrap();
    let child = seen_mutations.try_recv().unwrap();
    assert_eq!(child["requestId"], "child");
    assert_eq!(
        child["answer"],
        json!({"kind":"session_approval","decision":"allow"})
    );

    app.wait_for("label:Question option Local").unwrap();
    app.press("label:Question option Local").unwrap();
    app.press("label:Submit question answer").unwrap();
    app.wait_for("text:/已回答/").unwrap();
    let answer = seen_mutations.try_recv().unwrap();
    assert_eq!(answer["answer"]["answers"], json!(["Local"]));

    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":id,"generation":1,"item":{"kind":"events","through":7,"nextAfter":7,
        "events":[{"sequence":7,"runId":"run","turnId":"turn","fact":{"kind":"delta","text":"Live test reply"}}]}
    })).unwrap();
    app.wait_for("text:Live test reply").unwrap();
    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":id,"generation":1,"item":{"kind":"queue","queue":{"revision":7,"entries":[
            {"messageId":"one","kind":"followup","preview":"First queued"},
            {"messageId":"two","kind":"followup","preview":"Second queued"}
        ]}}
    })).unwrap();
    app.press("label:Open queued messages").unwrap();
    app.wait_for("text:Second queued").unwrap();

    app.press("label:Queued message actions two").unwrap();
    app.press("text:Move up").unwrap();
    assert_eq!(
        seen_mutations.try_recv().unwrap()["edit"],
        json!({"kind":"reorder","messageIds":["two","one"]})
    );
    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":id,"generation":1,"item":{"kind":"queue","queue":{"revision":8,"entries":[
            {"messageId":"two","kind":"followup","preview":"Second queued"},
            {"messageId":"one","kind":"followup","preview":"First queued"}
        ]}}
    })).unwrap();
    app.press("label:Queued message actions two").unwrap();
    app.press("text:Edit").unwrap();

    app.wait_for("label:Queued message editor").unwrap();
    app.type_text("label:Queued message editor", " revised")
        .unwrap();
    app.press("label:Save queued message").unwrap();
    let edit = seen_mutations.try_recv().unwrap();
    assert_eq!(edit["expectedRevision"], 8);
    assert_eq!(edit["edit"]["messageId"], "two");
    assert!(
        edit["edit"]["message"]
            .as_str()
            .unwrap()
            .contains("revised")
    );

    let mut offline = first;
    offline["revision"] = json!(2);
    offline["active"] = Value::Null;
    offline["hosts"][0]["connected"] = json!(false);
    offline["disconnectReason"] = json!("network changed");
    offline["disconnectedRootId"] = json!("root");
    app.send_host_event("ios.hostState", offline).unwrap();
    app.wait_for("label:Reconnect").unwrap();
    app.press("label:Reconnect").unwrap();
    let (_, after) = tokio::time::timeout(Duration::from_secs(5), seen_watches.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after, 7, "new anchor catches up from the consumed cursor");
    let mut other = snapshot("other-anchor", 4);
    other["active"]["hostName"] = json!("Non-Agent Host");
    other["active"]["endpoints"] = json!(["hostLogs"]);
    app.send_host_event("ios.hostState", other).unwrap();
    app.wait_for("text:Non-Agent Host").unwrap();
    app.send_host_event("ios.hostState", snapshot("next-anchor", 3))
        .unwrap();
    app.wait_for_gone("text:/Future wire permission/", Duration::from_secs(3))
        .unwrap();
    app.wait_for_gone("text:/half is visible/", Duration::from_secs(3))
        .unwrap();
}

#[tokio::test]
async fn pairing_uses_simplified_and_traditional_device_locale() {
    for (language, label) in [("zh-CN", "连接并核对"), ("zh-TW", "連接並核對")] {
        let channel = HostChannel::new();
        channel.handle("ios.bootstrap", |call| {
            call.reply(Ok(json!({"revision":1,"devicePeerId":"fixture",
                                 "filter":{"kind":"all_computers"},"hosts":[],"active":null})));
        });
        let mut config = engine_config(channel, tokio::runtime::Handle::current());
        config.viewport = Size::new(px(390.), px(844.));
        config.environment = Environment {
            os: Os::Ios,
            locale: nsh_core::platform::Locale::parse(language).unwrap(),
            reduce_motion: true,
            ..Environment::default()
        };
        let mut app = Headless::start_with_link(config, "maka://pair/v1?payload=fixture").unwrap();
        app.wait_for(&format!("label:{label}")).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_sessions_releases_pagination_and_keeps_localized_approval_actions() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
        "revision":1,"devicePeerId":"fixture","filter":{"kind":"all_computers"},"hosts":[{"rootId":"root","hostName":"Paging Host","connected":true,"endpoints":["agent"]}],
        "active":{"rootId":"root","hostName":"Paging Host","session":"anchor","endpoints":["agent"]}
    })))
    });
    let session = |id: &str| {
        json!({
            "id":id,"title":id,"kind":"agent","parentSessionId":null,"labels":[],
            "workspace":{"path":"/workspace"},"revision":1,"updatedAt":1,
            "archived":false,"pinned":false,"hasUnread":false,"activity":"idle",
        })
    };
    let (page_calls, mut pages) = mpsc::unbounded_channel();
    let (interaction_calls, mut old_interactions) = mpsc::unbounded_channel();
    let (unexpected_tx, mut unexpected) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let id = data["input"]["sessionId"].as_str().unwrap_or_default();
        let value = match data["method"].as_str().unwrap() {
            "projects" => json!({"kind":"projects","projects":[]}),
            "directories" => json!({"kind":"roots","roots":[]}),
            "list" => json!({"revision":"1","sessions":[session("Session A"),session("Session B")],"needsYouCount":0,"after":null}),
            "observe" => json!({"session":session(id),"through":4,"run":null}),
            "history" if data["input"]["position"]["kind"] == "before" => {
                page_calls.send((id.to_owned(), call.into_reply().unwrap())).unwrap();
                return;
            }
            "history" => json!({"kind":"ready","through":4,"chunks":[{
                "position":{"kind":"live","sequence":2,"fact":"00000000-0000-4000-8000-000000000002","itemIndex":0},
                "order":{"path":[2],"itemIndex":0},"offset":0,
                "messageId":"latest","role":"user","field":"body","text":format!("Latest in {id}"),
            }],"before":{"cursor":true}}),
            "models" if data["anchorSession"] == "anchor" => json!({
                "kind":"ready","choices":[{
                    "selection":{"kind":"model","modelId":"old","thinkingLevel":null},
                    "label":"Previous Host model","sourceName":"fixture","thinkingLevels":[],"defaultThinkingLevel":null
                }]
            }),
            "schedules" if data["anchorSession"] == "replacement" => json!({
                "kind":"page","tasks":[{
                    "id":"old-schedule","sessionId":"Session B","revision":1,"title":"Previous Host task",
                    "status":"active","approved":true,"script":false,"nextFireAt":null,"pendingFire":null,"lastError":null
                }]
            }),
            "models" | "schedules" => json!({"kind":"ready","choices":[]}),
            "pendingInteractions" if data["anchorSession"] != "anchor" => json!({"revision":1,"entries":[]}),
            "pendingInteractions" if id == "Session B" => json!({"revision":1,"entries":[
                {"requestId":"old-interaction","kind":"service_approval"},
                {"requestId":"must-not-cross","kind":"service_approval"},
            ]}),
            "interaction" if data["input"]["requestId"] == "old-interaction" => {
                assert_eq!(data["anchorSession"],"anchor");
                interaction_calls.send(call.into_reply().unwrap()).unwrap();
                return;
            }
            "interaction" if data["input"]["requestId"] == "must-not-cross" => {
                unexpected_tx.send(data).unwrap();
                Value::Null
            }
            "pendingInteractions" => json!({"revision":1,"entries":[{"requestId":"service","kind":"service_approval"}]}),
            "interaction" => json!({"requestId":"service","outcome":null,
                "request":{"kind":"service_approval","toolName":"Test binding","service":"fixture","method":"read","binding":"bound"}}),
            method => panic!("unexpected query {method}"),
        };
        call.reply(Ok(json!({"value":value})));
    });
    let (responses, mut answers) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        assert_eq!(data["anchorSession"], "anchor");
        assert_eq!(data["method"], "respond");
        responses.send(data["input"].clone()).unwrap();
        call.reply(Ok(json!({"value":{"kind":"recorded"}})));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.reply(Ok(
            json!({"subscriptionId":data["subscriptionId"],"generation":1}),
        ));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({"cancelled":true})))
    });

    for (locale, approve) in [("en-US", "Allow"), ("zh-TW", "允許")] {
        let mut config = engine_config(channel.clone(), tokio::runtime::Handle::current());
        config.viewport = Size::new(px(390.), px(844.));
        config.environment = Environment {
            os: Os::Ios,
            reduce_motion: true,
            locale: nsh_core::platform::Locale::parse(locale).unwrap(),
            ..Environment::default()
        };
        let mut app = Headless::start(config).unwrap();
        app.wait_for("label:Session Session A").unwrap();
        app.press("label:Session Session A").unwrap();
        app.wait_for("text:Latest in Session A").unwrap();
        app.wait_for(&format!("text:{approve}")).unwrap();
        app.press(&format!("label:{approve}")).unwrap();
        let response = answers.try_recv().unwrap();
        assert_eq!(
            response["answer"],
            json!({"kind":"service_approval","decision":"allow"})
        );

        if locale == "zh-TW" {
            continue;
        }

        app.press("label:Load earlier messages").unwrap();
        let (id, earlier_a) = pages.try_recv().unwrap();
        assert_eq!(id, "Session A");
        app.press("label:Open drawer").unwrap();
        app.press("label:Session Session B").unwrap();
        app.wait_for("text:Latest in Session B").unwrap();
        earlier_a.resolve(older_page("Stale A page"));
        app.press("label:Load earlier messages").unwrap();
        let (id, earlier_b) = pages.try_recv().unwrap();
        assert_eq!(id, "Session B");
        earlier_b.resolve(older_page("Earlier B page"));
        app.wait_for("text:Earlier B page").unwrap();
        app.wait_for_gone("text:Stale A page", Duration::from_secs(1))
            .unwrap();

        let old_interaction = old_interactions.try_recv().unwrap();
        app.press("label:Select model and thinking").unwrap();
        app.wait_for("label:Model Previous Host model").unwrap();
        app.send_host_event("ios.hostState", switching_host(2, "replacement", true))
            .unwrap();
        app.wait_for_gone("label:Model Previous Host model", Duration::from_secs(2))
            .unwrap();
        old_interaction.resolve(json!({"value":null}));
        app.press("label:Back from model picker").unwrap();
        app.press("label:Open drawer").unwrap();
        app.press("label:Automations").unwrap();
        app.wait_for("text:Previous Host task").unwrap();
        app.send_host_event("ios.hostState", switching_host(3, "offline", false))
            .unwrap();
        app.wait_for_gone("text:Previous Host task", Duration::from_secs(2))
            .unwrap();
        assert!(matches!(
            unexpected.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
}

fn switching_host(revision: u64, anchor: &str, online: bool) -> Value {
    json!({"revision":revision,"devicePeerId":"fixture","filter":{"kind":"all_computers"},
        "hosts":[{"rootId":"root","hostName":"Replacement Host","connected":online,"endpoints":["agent"]}],
        "active":if online {json!({"rootId":"root","hostName":"Replacement Host","session":anchor,"endpoints":["agent"]})} else {Value::Null},
    })
}

fn history_chunk(sequence: u64, role: &str, text: &str) -> Value {
    json!({
        "position":{"kind":"live","sequence":sequence,"fact":format!("00000000-0000-4000-8000-{sequence:012}"),"itemIndex":0},
        "order":{"path":[sequence],"itemIndex":0},"offset":0,"totalBytes":text.len(),
        "messageId":format!("message-{sequence}"),"role":role,"field":"body","text":text,
    })
}

fn older_page(text: &str) -> Value {
    json!({"value":{"kind":"ready","through":4,"before":null,"chunks":[history_chunk(1, "user", text)]}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_during_pairing_admission_cancels_and_ignores_late_admission() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| call.reply(Ok(json!({
        "revision":1,"devicePeerId":"fixture","filter":{"kind":"all_computers"},"hosts":[],"active":null
    }))));
    channel.handle("ios.beginPairing", |call| {
        call.reply(Ok(json!({
            "pairingId":1,"hostName":"Pending Host","sasCode":"123456","pathSummary":null
        })))
    });
    let (confirm_tx, mut confirming) = mpsc::unbounded_channel();
    channel.handle("ios.confirmPairing", move |call| {
        confirm_tx.send(call.into_reply().unwrap()).unwrap()
    });
    let (cancel_tx, mut cancelled) = mpsc::unbounded_channel();
    channel.handle("ios.cancelPairing", move |call| {
        cancel_tx.send(()).unwrap();
        call.reply(Ok(json!({"cancelled":true})));
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start_with_link(config, "maka://pair/v1?payload=fixture").unwrap();
    app.wait_for("label:Connect and compare").unwrap();
    app.press("label:Connect and compare").unwrap();
    app.wait_for("text:123456").unwrap();
    app.press("label:Codes match — pair").unwrap();
    let confirm = confirming.try_recv().unwrap();
    app.press("label:Close").unwrap();
    cancelled.try_recv().unwrap();
    confirm.resolve(json!({"revision":2,"devicePeerId":"fixture","filter":{"kind":"all_computers"},
        "hosts":[],"active":{"rootId":"root","hostName":"Unexpected late Host","session":"late","endpoints":[]}}));
    app.wait_for_gone("label:Live pairing code", Duration::from_secs(1))
        .unwrap();
    app.wait_for_gone("text:Unexpected late Host", Duration::from_secs(1))
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drawer_rename_and_delete_confirmations_cannot_cross_hosts() {
    for (menu, title, answer) in [
        (
            "Rename",
            "Rename conversation",
            nsh_testing::DialogAnswer::TypeAndPress {
                text: "Not on Host B".into(),
                button: "Save".into(),
            },
        ),
        (
            "Delete",
            "Permanently delete this conversation?",
            nsh_testing::DialogAnswer::Press("Delete".into()),
        ),
    ] {
        let channel = HostChannel::new();
        channel.handle("ios.bootstrap", |call| {
            call.reply(Ok(switching_host(1, "host-A", true)))
        });
        channel.handle("ios.hostQuery", |mut call| {
            let data = call.take_data();
            let value = match data["method"].as_str().unwrap() {
                "projects" => json!({"kind":"projects","projects":[]}),
                "directories" => json!({"kind":"roots","roots":[]}),
                "list" => {
                    let sessions = if data["anchorSession"] == "host-A" {
                        vec![
                            json!({"id":"session-a","title":"Host A conversation","kind":"agent",
                            "revision":7,"workspace":{"path":"/workspace"},"labels":[]}),
                        ]
                    } else {
                        vec![]
                    };
                    json!({"revision":"1","sessions":sessions,"needsYouCount":0,"after":null})
                }
                method => panic!("unexpected query {method}"),
            };
            call.reply(Ok(json!({"value":value})));
        });
        channel.handle("ios.subscribe", |mut call| {
            let data = call.take_data();
            call.reply(Ok(
                json!({"subscriptionId":data["subscriptionId"],"generation":1}),
            ));
        });
        channel.handle("ios.unsubscribe", |call| {
            call.reply(Ok(json!({"cancelled":true})))
        });
        let (tx, mut requests) = mpsc::unbounded_channel();
        channel.handle("ios.hostMutate", move |mut call| {
            tx.send(call.take_data()).unwrap();
            call.reject("unexpected write");
        });
        let mut config = engine_config(channel, tokio::runtime::Handle::current());
        config.viewport = Size::new(px(390.), px(844.));
        config.environment = Environment {
            // Headless can drive the desktop popup, which uses the same Drawer callback.
            os: Os::MacOs,
            reduce_motion: true,
            ..Environment::default()
        };
        let mut app = Headless::start(config).unwrap();
        app.wait_for("label:Session actions Host A conversation")
            .unwrap();
        app.answer_dialogs_myself();
        app.press("label:Session actions Host A conversation")
            .unwrap();
        app.choose_menu_item(menu).unwrap();
        let dialog = app.pending_dialog().expect("menu opens confirmation");
        assert_eq!(dialog.title.as_deref(), Some(title));
        let mut next = switching_host(2, "host-B", true);
        next["active"]["hostName"] = json!("Host B");
        app.send_host_event("ios.hostState", next).unwrap();
        app.wait_for("text:Host B · Online").unwrap();
        app.answer_dialog(answer).unwrap();
        assert!(matches!(
            requests.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_reactions_round_trip_to_host_even_for_older_messages() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(switching_host(1, "room-anchor", true)))
    });
    let session = json!({"id":"room","title":"Fixture Room","kind":"room","revision":1,
        "workspace":{"path":"/workspace"},"labels":[]});
    let reacts = Arc::new(AtomicBool::new(false));
    channel.handle("ios.hostQuery", {
        let reacts = reacts.clone();
        move |mut call| {
            let data = call.take_data();
            let value = match data["method"].as_str().unwrap() {
                "projects" => json!({"kind":"projects","projects":[]}),
                "directories" => json!({"kind":"roots","roots":[]}),
                "list" => json!({"revision":"1","sessions":[session],"needsYouCount":0,"after":null}),
                "observe" => json!({"session":session,"through":2,"run":null}),
                "pendingInteractions" => json!({"entries":[]}),
                "history" => {
                    let before = data["input"]["position"]["kind"] == "before_message";
                    let around = data["input"]["position"]["kind"] == "around_message";
                    let old = before || around;
                    if around {
                        assert_eq!(data["input"]["position"]["messageId"], "older-room-message");
                    }
                    let mut reactions = vec![json!({"kind":"session","sessionId":"worker"})];
                    if reacts.load(Ordering::Relaxed) { reactions.push(json!({"kind":"human"})); }
                    json!({"kind":"room","page":{"through":2,
                        "before":if old { Value::Null } else { json!("latest-room-message") },
                        "items":[{
                        "id":if old { "older-room-message" } else { "latest-room-message" },
                        "sequence":if old { 1 } else { 2 },
                        "author":{"kind":"human"},"content":{"text":if old {"Earlier Room post"} else {"Latest Room post"}},
                        "reactions":if old {json!([{"emoji":"👍","actors":reactions}])} else {json!([])},
                    }]}})
                }
                method => panic!("unexpected query {method}"),
            };
            call.reply(Ok(json!({"value":value})));
        }
    });
    let (tx, mut mutations) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let add = data["input"]["action"]["add"].as_bool().unwrap();
        reacts.store(add, Ordering::Relaxed);
        tx.send(data).unwrap();
        call.reply(Ok(json!({"value":{"kind":"reaction_updated","messageId":"older-room-message","emoji":"👍","present":add}})));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.reply(Ok(
            json!({"subscriptionId":data["subscriptionId"],"generation":1}),
        ));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({"cancelled":true})))
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Session Fixture Room").unwrap();
    app.press("label:Session Fixture Room").unwrap();
    app.wait_for("text:Latest Room post").unwrap();
    app.press("label:Load earlier messages").unwrap();
    app.wait_for("text:Earlier Room post").unwrap();
    app.press("label:Toggle reaction 👍").unwrap();
    assert_eq!(
        mutations.try_recv().unwrap(),
        json!({"anchorSession":"room-anchor","endpoint":"agent","method":"roomManage",
        "input":{"sessionId":"room","action":{"kind":"react","messageId":"older-room-message","emoji":"👍","add":true}}})
    );
    app.wait_for("text:2").unwrap();
    app.wait_for("text:Latest Room post").unwrap();
    app.press("label:Toggle reaction 👍").unwrap();
    assert_eq!(
        mutations.try_recv().unwrap()["input"]["action"]["add"],
        false
    );
    app.wait_for_gone("text:2", Duration::from_secs(2)).unwrap();
    app.wait_for("label:Toggle reaction 👍").unwrap();
}
