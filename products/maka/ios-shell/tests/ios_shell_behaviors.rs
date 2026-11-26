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

use maka_agent_api::contract::{
    DeliveryPage, PendingInteractions, PreviewPage, Queue, QueueAction, QueueEntry, QueueKind,
    QueueMutation, QueueMutationResult,
};
use maka_agent_facts::interaction::{Decision, InteractionAnswer, InteractionOutcome};
use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    NativeRegistry,
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
use nsh_engine::{Bundle, EngineConfig, HostChannel};
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
    let web_contract = maka_web_api::contract();
    let web = package(
        "test.web",
        json!({
            "implementation":{"kind":"native","implementation":maka_web_api::IMPLEMENTATION},
            "configuration":maka_web_api::configuration_schema(),"imports":{},
            "exports":{(maka_web_api::EXPORT):{"contract":web_contract,"availability":"required"}}
        }),
    );
    let gateway = package(
        "test.gateway",
        json!({
            "implementation":{"kind":"native","implementation":GATEWAY},
            "configuration":{"type":"object"},"exports":{},
            "imports":{
                "hostLogs":{"contract":contract,"cardinality":{"kind":"one"}},
                "web":{"contract":web_contract,"cardinality":{"kind":"one"}}
            }
        }),
    );
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    let source = store.commit_application(
        deployment, 0,
        serde_json::from_value(json!({"instances":{
            "logs":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":logs.application_ref()},"usePackage":"host"},
            "web":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":web.application_ref()},"usePackage":"host",
                "configuration":{"values":{"network":"denied"}}},
            "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway.application_ref()},"usePackage":"host",
                "bindings":{
                "hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}],
                "web":[{"kind":"instance","path":["web"],"export":maka_web_api::EXPORT}]
            }}
        }})).unwrap(),
        vec![], vec![logs, web, gateway],
    ).await.unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read","watch"],"recovery":false}},
            "web":{"consumer":[consumer],"import":"web","grant":{"methods":["snapshot","save","saveKey"],"recovery":false}}
        })).unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    store
        .select_committed_application_launch(source, serde_json::to_value(&configuration).unwrap())
        .await
        .unwrap();
    let mut native = NativeRegistry::default();
    maka_web::provide(&mut native).unwrap();
    let host = Host::open_with_options(
        store.clone(),
        deployment,
        native,
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
        let transport = HostPeerTransport::bind(&host, std::slice::from_ref(config), false)
            .await
            .unwrap();
        transport.wait_for_relay().await.unwrap();
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
                host_name: name.into(),
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
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start_with_link(config, &first.uri).unwrap();
    app.wait_for("label:Pairing URI input").unwrap();
    app.press("label:Custom relay or WebSocket").unwrap();
    app.type_text("label:Relay URL", &relay_url).unwrap();
    app.type_text("label:Relay Bearer token", RELAY_TOKEN)
        .unwrap();
    app.press("label:Connect and compare").unwrap();

    let (peer, sas) = first.sas().await;
    app.wait_for(&format!("text:{sas}")).unwrap();
    assert!(first.host.list_peer_access().await.unwrap().is_empty());
    assert!(!support.path().join("hosts.json").exists());

    app.press("label:Confirm & Connect").unwrap();
    app.wait_for("text:First test Host · Online").unwrap();
    assert_eq!(first.host.list_peer_access().await.unwrap().len(), 1);
    assert!(matches!(
        first.handshakes.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));

    app.send_url_scheme(&second.uri);
    app.wait_for("label:Pairing URI input").unwrap();
    app.press("label:Custom relay or WebSocket").unwrap();
    app.type_text("label:Relay URL", &relay_url).unwrap();
    app.type_text("label:Relay Bearer token", RELAY_TOKEN)
        .unwrap();
    app.press("label:Connect and compare").unwrap();
    let (_, sas) = second.sas().await;
    app.wait_for(&format!("text:{sas}")).unwrap();
    app.press("label:Confirm & Connect").unwrap();
    app.wait_for("text:Second test Host").unwrap();

    // Open Tab 3 Settings -> First test Host detail -> Check connection.
    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: First test Host").unwrap();
    app.press("label:Computer: First test Host").unwrap();
    app.wait_for("label:Check connection").unwrap();
    app.press("label:Check connection").unwrap();
    app.wait_for("text:Computer responded").unwrap();

    drop(app);
    drop(bridge);
    let persisted = std::fs::read_to_string(support.path().join("hosts.json")).unwrap();
    assert!(!persisted.contains(RELAY_TOKEN));

    // Cold restart: reconnect First test Host with relay Bearer token and verify live revocation notice.
    let channel = HostChannel::new();
    let runtime = tokio::runtime::Handle::current();
    let _bridge =
        HostBridge::attach(channel.clone(), support.path().to_owned(), runtime.clone()).unwrap();
    let mut config = engine_config(channel, runtime);
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: First test Host").unwrap();
    app.press("label:Computer: First test Host").unwrap();
    app.wait_for("label:Relay Bearer for First test Host")
        .unwrap();
    app.press("label:Relay Bearer for First test Host").unwrap();
    app.type_text("label:Saved Host relay Bearer token", RELAY_TOKEN)
        .unwrap();
    app.press("label:Connect with Bearer token").unwrap();
    let (same_peer, _) = first.sas().await;
    assert_eq!(same_peer, peer);
    app.wait_for("label:Check connection").unwrap();
    assert!(first.host.revoke_peer_access(peer).await.unwrap());
    app.wait_for("text:/peer access revoked/").unwrap();
    drop(app);
    first.shutdown().await;
    second.shutdown().await;
    relay.shutdown().await.unwrap();
}

struct RpcDriver {
    channel: HostChannel,
    replies: mpsc::UnboundedReceiver<Value>,
}

impl RpcDriver {
    async fn batch(&mut self, requests: Value) -> Value {
        self.channel.send("test.rpc", requests).unwrap();
        self.replies.recv().await.unwrap()
    }

    async fn call(&mut self, name: &str, data: Value) -> Value {
        let result = self.batch(json!([[name, data]])).await;
        assert!(
            result[0].get("ok").is_some(),
            "{name}: {}",
            result[0]["error"]
        );
        result[0]["ok"].clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn root_routed_calls_and_subscriptions_survive_other_host_reconnection_and_revocation() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (relay, config, relay_url) = https_relay().await;
        let mut a = Live::start(&config, "Host A").await;
        let mut b = Live::start(&config, "Host B").await;
        let support = tempfile::tempdir().unwrap();
        let channel = HostChannel::new();
        let runtime = tokio::runtime::Handle::current();
        let _bridge = HostBridge::attach(channel.clone(), support.path().into(), runtime.clone()).unwrap();
        let (reply, replies) = mpsc::unbounded_channel();
        let (item, mut items) = mpsc::unbounded_channel();
        let (state, mut states) = mpsc::unbounded_channel();
        for (name, send) in [("test.reply", reply), ("test.item", item), ("test.state", state)] {
            channel.handle(name, move |mut call| { send.send(call.take_data()).unwrap(); });
        }
        let bundle = Bundle::source(r#"
            import { host } from 'nsh';
            host.on('test.rpc', async (requests) => {
              const replies = await Promise.all(requests.map(async ([name, data]) => {
                try { return { ok: await host.call(name, data) }; }
                catch (error) { return { error: String(error) }; }
              }));
              host.post('test.reply', replies);
            });
            host.on('ios.subscriptionItem', data => host.post('test.item', data));
            host.on('ios.hostState', data => host.post('test.state', data));
        "#.to_owned()).with_capabilities_json(Some(r#"{"host":true}"#)).unwrap();
        let mut engine = EngineConfig::new(bundle);
        engine.host = channel.clone();
        engine.runtime = Some(runtime);
        let app = Headless::start(engine).unwrap();
        let mut driver = RpcDriver { channel, replies };
        let mut peers = Vec::new();
        for host in [&mut a, &mut b] {
            let ticket = driver.call("ios.beginPairing", json!({
                "uri":host.uri,"relayUrl":relay_url,"relayToken":RELAY_TOKEN
            })).await;
            let (peer, sas) = host.sas().await;
            let paired = driver.call("ios.confirmPairing", json!({"pairingId":ticket["pairingId"],"sas":sas})).await;
            assert_eq!(paired["connections"][host.host.root_id()]["status"], "connected");
            peers.push(peer);
        }

        let a_id = a.host.root_id().to_owned();
        let b_id = b.host.root_id().to_owned();
        let state = driver.call("ios.bootstrap", json!({})).await;
        let b_session = state["connections"][&b_id]["connection"]["session"].clone();
        assert_eq!(state["connections"][&a_id]["status"], "connected");
        assert_eq!(state["active"]["rootId"], b_id);

        let save = |root: &str| json!({
            "rootId":root, "generation":state["connections"][root]["connection"]["generation"],
            "endpoint":"web", "method":"save",
            "input":{"revision":null,"settings":{"enabled":true,"source":"custom","backend":{"kind":"tavily"}}}
        });
        let watch = |root: &str| json!({
            "rootId":root, "endpoint":"hostLogs", "method":"watch",
            "subscriptionId":"shared", "input":{"position":{"kind":"tail"}}
        });
        let query = |root: &str| json!({
            "rootId":root, "endpoint":"web", "method":"snapshot", "input":{}
        });
        // Same subscription ID on both Hosts must not replace the other stream.
        let replies = driver.batch(json!([
            ["ios.hostMutate", save(&a_id)], ["ios.hostMutate", save(&b_id)],
            ["ios.subscribe", watch(&a_id)], ["ios.subscribe", watch(&b_id)],
        ])).await;
        for reply in &replies.as_array().unwrap()[..2] {
            assert_eq!(reply["ok"]["value"]["kind"], "updated", "{reply}");
        }
        let snapshots = driver.batch(json!([
            ["ios.hostQuery", query(&a_id)], ["ios.hostQuery", query(&b_id)],
        ])).await;
        for snapshot in snapshots.as_array().unwrap() {
            assert_eq!(snapshot["ok"]["value"]["settings"]["source"], "custom");
            assert_eq!(snapshot["ok"]["value"]["credential"]["configured"], false);
        }
        let a_handle = replies[2]["ok"].clone();
        let b_watch = replies[3]["ok"]["generation"].clone();
        assert_eq!(a_handle["rootId"], a_id);
        assert_eq!(replies[3]["ok"]["rootId"], b_id);
        assert_ne!(b_watch, replies[2]["ok"]["generation"]);
        let mut watched_roots = [items.recv().await.unwrap(), items.recv().await.unwrap()];
        watched_roots.sort_by(|a, b| a["rootId"].as_str().cmp(&b["rootId"].as_str()));
        let mut expected = [a_id.as_str(), b_id.as_str()];
        expected.sort();
        assert_eq!(watched_roots.iter().map(|item| item["rootId"].as_str().unwrap()).collect::<Vec<_>>(), expected);
        assert!(watched_roots.iter().all(|item| item["item"]["kind"] == "missing"));

        let secret = "test-key-密文";
        let rejected = driver.batch(json!([["ios.hostMutate", {
            "rootId":b_id, "endpoint":"web","method":"save","input":{}, "secret":secret
        }]])).await;
        assert!(rejected[0]["error"].as_str().unwrap().contains("does not accept a secret"));
        let saved = driver.call("ios.hostMutate", json!({
            "rootId":b_id, "generation":state["connections"][&b_id]["connection"]["generation"],
            "endpoint":"web", "method":"saveKey", "secret":secret,
            "input":{"settingsRevision":snapshots[1]["ok"]["value"]["revision"],"revision":null}
        })).await;
        assert_eq!(saved["value"]["kind"], "updated");
        assert_eq!(saved["value"]["snapshot"]["credential"]["configured"], true);

        let state = driver.call("ios.disconnectHost", json!({"rootId":a_id})).await;
        assert_eq!(state["connections"][&a_id]["status"], "offline");
        assert_eq!(state["connections"][&b_id]["connection"]["session"], b_session);
        driver.call("ios.connectHost", json!({"rootId":a_id})).await;
        assert_eq!(a.sas().await.0, peers[0]);
        let a_new = driver.call("ios.subscribe", watch(&a_id)).await;
        let mut unpinned = save(&a_id);
        unpinned.as_object_mut().unwrap().remove("generation");
        let rejected = driver.batch(json!([["ios.hostMutate", unpinned]])).await;
        assert!(rejected[0]["error"].as_str().unwrap().contains("require a connection generation"));
        let rejected = driver.batch(json!([["ios.hostMutate", save(&a_id)]])).await;
        assert!(rejected[0]["error"].as_str().unwrap().contains("anchor no longer matches UI"));

        assert_eq!(driver.call("ios.unsubscribe", a_handle.clone()).await["cancelled"], false);
        assert_eq!(items.recv().await.unwrap()["rootId"], a_id);
        assert_eq!(driver.call("ios.unsubscribe", a_new).await["cancelled"], true);
        assert!(a.host.revoke_peer_access(peers.remove(0)).await.unwrap());
        loop {
            let state = states.recv().await.unwrap();
            if state["connections"][&a_id]["status"] == "error" {
                assert_eq!(state["connections"][&b_id]["connection"]["session"], b_session);
                break;
            }
        }
        let removed = driver.call("ios.removeHost", json!({"rootId":a_id})).await;
        assert!(removed["connections"].get(&a_id).is_none());
        assert_eq!(driver.call("ios.unsubscribe", a_handle).await["cancelled"], false);
        let missing_root = driver.batch(json!([["ios.unsubscribe", {
            "subscriptionId":"shared","generation":b_watch
        }]])).await;
        assert!(missing_root[0]["error"].as_str().unwrap().contains("rootId"));
        let saved = driver.call("ios.hostQuery", query(&b_id)).await;
        assert_eq!(saved["value"]["credential"]["configured"], true);
        assert!(!std::fs::read_to_string(support.path().join("hosts.json")).unwrap().contains(secret));

        // Same stream, without resubscribing, sees new data after A's disconnect.
        use std::io::Write;
        let source = maka_host_runtime::logs::Source::for_root(&b_id, &RootNamespaces {
            ownership:b._root.path().join("ownership"), control:b._root.path().join("control"),
        }).unwrap();
        source.open_capture().unwrap().write_all(b"still online\n").unwrap();
        let item = items.recv().await.unwrap();
        assert_eq!(item["rootId"], b_id);
        assert_eq!(item["generation"], b_watch);
        assert_eq!(item["item"]["kind"], "data");

        drop(app);
        a.shutdown().await;
        b.shutdown().await;
        relay.shutdown().await.unwrap();
    }).await.expect("multi-Host bridge test timed out");
}

#[tokio::test]
async fn pairing_uses_simplified_and_traditional_device_locale() {
    for (language, label) in [("zh-CN", "连接并核对"), ("zh-TW", "連接並核對")] {
        let channel = HostChannel::new();
        channel.handle("ios.bootstrap", |call| {
            call.reply(Ok(json!({
                "revision": 1,
                "devicePeerId": "fixture",
                "filter": { "kind": "all_computers" },
                "hosts": [],
                "active": null,
            })));
        });
        let mut config = engine_config(channel, tokio::runtime::Handle::current());
        config.viewport = Size::new(px(390.), px(844.));
        let mut locale_settings = nsh_core::platform::LocaleSettings::default();
        locale_settings.languages = nsh_core::platform::Languages::parse([language]).unwrap();
        config.environment = Environment {
            os: Os::MacOs,
            locale_settings,
            reduce_motion: true,
            ..Environment::default()
        };
        let mut app = Headless::start_with_link(config, "maka://pair/v1?payload=fixture").unwrap();
        app.wait_for(&format!("label:{label}")).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirming_a_pairing_disables_cancel_and_forwards_the_device_label() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
            "revision": 1,
            "devicePeerId": "fixture",
            "filter": { "kind": "all_computers" },
            "hosts": [],
            "active": null,
        })));
    });
    channel.handle("ios.beginPairing", |call| {
        call.reply(Ok(json!({
            "pairingId": 1,
            "rootId": "late-root",
            "hostName": "Pending Host",
            "peerId": "late-peer",
            "sasCode": "123456",
            "devicePeerId": "fixture",
            "pathSummary": null,
        })));
    });
    let (confirm_tx, mut confirming) = mpsc::unbounded_channel();
    channel.handle("ios.confirmPairing", move |mut call| {
        let data = call.take_data();
        confirm_tx.send((data, call.into_reply())).unwrap();
    });
    let (cancel_tx, mut cancelled) = mpsc::unbounded_channel();
    channel.handle("ios.cancelPairing", move |call| {
        cancel_tx.send(()).unwrap();
        call.reply(Ok(json!({ "cancelled": true })));
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start_with_link(config, "maka://pair/v1?payload=fixture").unwrap();
    app.wait_for("label:Connect and compare").unwrap();
    app.set_clipboard(Some("maka://pair/v1?payload=from-clipboard".into()));
    app.press("label:Paste from Clipboard").unwrap();
    app.wait_for("text:maka://pair/v1?payload=from-clipboard")
        .unwrap();
    app.press("label:Connect and compare").unwrap();
    app.wait_for("text:123456").unwrap();
    app.press("label:Verification code").unwrap();
    assert_eq!(app.screen().clipboard(), Some("123456"));
    app.clear("label:Device name").unwrap();
    app.type_text("label:Device name", &"\u{754c}".repeat(43))
        .unwrap();
    app.press("label:Confirm & Connect").unwrap();
    app.wait_for("text:Device name must be 128 UTF-8 bytes or fewer.")
        .unwrap();
    assert!(confirming.try_recv().is_err());
    app.clear("label:Device name").unwrap();
    app.type_text("label:Device name", "Field iPhone").unwrap();
    app.press("label:Confirm & Connect").unwrap();
    let (input, confirm) = confirming.try_recv().unwrap();
    assert_eq!(input["deviceLabel"], "Field iPhone");
    assert!(app.press("label:Cancel").is_err());
    assert!(cancelled.try_recv().is_err());
    confirm.unwrap().resolve(json!({
        "revision": 2,
        "devicePeerId": "fixture",
        "filter": { "kind": "all_computers" },
        "hosts": [{
            "rootId": "late-root",
            "hostName": "Newly paired Host",
            "peerId": "late-peer",
            "connected": true,
            "endpoints": []
        }],
        "active": {
            "rootId": "late-root",
            "hostName": "Newly paired Host",
            "epoch": "e1",
            "session": "late",
            "generation": 1,
            "endpoints": [],
            "pathSummary": null,
            "transport": "quic"
        }
    }));
    app.wait_for_gone("text:123456", Duration::from_secs(1))
        .unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: Newly paired Host").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multi_host_tab_shell_isolates_scopes_and_routes_inbox_approval_by_root() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
            "revision": 1,
            "devicePeerId": "ios-device",
            "filter": { "kind": "all_computers" },
            "hosts": [
                { "rootId": "root-a", "hostName": "MacBook Pro", "peerId": "peer-a", "connected": true, "endpoints": ["agent", "settings"] },
                { "rootId": "root-b", "hostName": "Linux Workstation", "peerId": "peer-b", "connected": true, "endpoints": ["agent", "settings"] }
            ],
            "active": {
                "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent", "settings"], "pathSummary": null, "transport": "quic"
            },
            "connections": {
                "root-a": { "status": "connected", "connection": { "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent", "settings"], "pathSummary": null, "transport": "quic" } },
                "root-b": { "status": "connected", "connection": { "rootId": "root-b", "hostName": "Linux Workstation", "epoch": "eb", "session": "sb", "generation": 2, "endpoints": ["agent", "settings"], "pathSummary": null, "transport": "quic" } }
            }
        })));
    });
    let (filter_tx, mut filter_rx) = mpsc::unbounded_channel();
    channel.handle("ios.setFilter", move |mut call| {
        filter_tx.send(call.take_data()).unwrap();
        call.resolve(Value::Null);
    });
    let (models_tx, mut models_rx) = mpsc::unbounded_channel();
    channel.handle("ios.ackMutationProgress", |_| {});
    let approved = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let approved_q = approved.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let root = data["rootId"].as_str().unwrap_or("");
        let method = data["method"].as_str().unwrap();
        let is_approved = approved_q.load(std::sync::atomic::Ordering::SeqCst);
        let value = match (root, method) {
            ("root-a" | "root-b", "botOutbox") => json!({
                "sessionId": null, "isBot": false, "through": 0, "readThrough": 0, "preview": "", "messages": []
            }),
            ("root-b", "projects") if data["input"]["cursor"].is_null() => json!({
                "kind":"projects","revision":"projects-b","next":{"revision":"projects-b","after":"unavailable"},
                "projects":[
                    {"reference":{"id":"archived"},"name":"Archived workspace","path":"/archive","archived":true,"available":true},
                    {"reference":{"id":"unavailable"},"name":"Unavailable workspace","path":"/old","archived":false,"available":false},
                    {"reference":{"id":"no-path"},"name":"Missing path","path":null,"archived":false,"available":true}
                ]
            }),
            ("root-a" | "root-b", "projects") => json!({
                "kind": "projects", "next":null, "projects": [{
                    "reference": {"id": "same-project-id"}, "name": if root == "root-a" { "Apple workspace" } else { "Linux workspace" },
                    "path": if root == "root-a" { "/apple" } else { "/linux" }, "archived":false, "available":true
                }]
            }),
            ("root-a" | "root-b", "directories") => json!({"kind":"roots","roots":[]}),
            ("root-b", "models") if data["input"]["kind"] == "start" => json!({
                "kind":"ready","revision":"models-b","choices":[],"next":{"query":"","offset":16}
            }),
            ("root-b", "models") => {
                models_tx.send(data["input"].clone()).unwrap();
                json!({"kind":"ready","revision":"models-b","next":null,"choices":[{
                    "selection":{"kind":"model","connectionId":"fixture","modelId":"second"},"sourceName":"Fixture",
                    "label":"Second page model","thinkingLevels":[],"defaultThinkingLevel":null
                }]})
            }
            ("root-a", "models") => json!({"kind":"ready","choices":[],"next":null}),
            ("root-a" | "root-b", "connections") => json!({"kind":"ready","revision":9,"connections":[],"defaultTarget":null,"next":null}),
            ("root-b", "assistantPreferences") => json!({
                "revision": 7, "language": "en", "resolvedLanguage":"en", "workspaceInstructions":true,
                "defaultSandboxMode":"workspace-write", "shell":{"titles":true}, "predictions":{"enabled":true},
                "defaultCompactionPrompt":"Default summary.", "compactionPrompt":"Summarize."
            }),
            ("root-b", "globalInstructions") => json!({"kind":"available","source":"agents","revision":"etag","content":"Original instructions","exists":true}),

            ("root-a", "list") => json!({
                "revision": "1",
                "needsYouCount": 0,
                "before": null,
                "after": null,
                "sessions": [{
                    "id": "shared-id", "title": "Auth refactor", "kind": "agent", "parentSessionId": null,
                    "labels": [], "workspace": { "name": "maka-agent", "path": "/src/maka-agent" },
                    "revision": 1, "updatedAt": 1700000002000u64, "archived": false, "pinned": false, "hasUnread": false, "activity": "working"
                }]
            }),
            ("root-b", "list") => json!({
                "revision": "1",
                "needsYouCount": if is_approved { 0 } else { 1 },
                "before": null,
                "after": null,
                "sessions": [{
                    "id": "shared-id", "title": "Deploy migration", "kind": "agent", "parentSessionId": null,
                    "labels": [], "workspace": { "name": "infra", "path": "/srv/infra" },
                    "revision": 1, "updatedAt": 1700000001000u64, "archived": false, "pinned": false, "hasUnread": false,
                    "activity": if is_approved { "idle" } else { "waiting" }
                }]
            }),
            ("root-a", "pendingInteractions") => json!({ "revision": 1, "entries": [] }),
            ("root-b", "pendingInteractions") => json!({
                "revision": 1,
                "entries": if is_approved { json!([]) } else { json!([{ "requestId": "req-b", "kind": "service_approval", "toolUseId": "tu-1" }]) }
            }),
            ("root-b", "interaction") => json!({
                "requestId": "req-b",
                "outcome": null,
                "request": {
                    "kind": "service_approval",
                    "toolUseId": "tu-1",
                    "toolName": "DeployRunner",
                    "service": "deploy",
                    "method": "apply",
                    "binding": "prod",
                    "through": 1
                }
            }),
            _ => json!({ "revision": 1, "entries": [] }),
        };
        call.reply(Ok(json!({ "value": value })));
    });
    let (mutate_tx, mut mutate_rx) = mpsc::unbounded_channel();
    let (save_tx, mut save_rx) = mpsc::unbounded_channel();
    let approved_m = approved.clone();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        if data["method"] == "respond" {
            approved_m.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        if data["method"] == "updateGlobalInstructions" {
            save_tx.send(call.into_reply().unwrap()).unwrap();
        } else {
            call.resolve(json!({"value":{"kind":"recorded","record":{"outcome":{"kind":"service_approval_decision","decision":"allow","committedAt":1}}}}));
        }
        mutate_tx.send(data).unwrap();
    });
    let (catalog_tx, mut catalog_rx) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let generation = if data["rootId"] == "root-a" { 1 } else { 2 };
        call.resolve(json!({"subscriptionId":data["subscriptionId"],"rootId":data["rootId"],"generation":generation}));
        catalog_tx.send(data).unwrap();
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({ "cancelled": true })));
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();

    // Both computers' conversations appear simultaneously even with colliding session IDs.
    app.wait_for("text:Auth refactor").unwrap();
    app.wait_for("text:Deploy migration").unwrap();

    let subscriptions: Vec<_> = std::iter::from_fn(|| catalog_rx.try_recv().ok()).collect();
    let mut id = None;
    for data in subscriptions {
        assert_eq!(data["endpoint"], "agent");
        match data["method"].as_str().unwrap() {
            "catalog" => {
                assert_eq!(
                    data["input"],
                    json!({"kind":null,"filter":"all","includeArchived":false,"rootsOnly":false,"position":{"kind":"start"},"scope":{"kind":"all"},"titleQuery":""})
                );
                if data["rootId"] == "root-a" {
                    id = Some(data["subscriptionId"].clone());
                }
            }
            "watchBotOutbox" => assert_eq!(data["input"], json!({"limit":0})),
            method => panic!("unexpected subscription {method}"),
        }
    }
    let id = id.expect("MacBook catalog subscription");
    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":id,"rootId":"root-a","generation":1,
        "item":{"revision":"2","needsYouCount":0,"before":null,"after":null,"sessions":[{
          "id":"shared-id","title":"Catalog live update","kind":"agent","parentSessionId":null,
          "workspace":{"name":"maka-agent","path":"/src/maka-agent"},"labels":[],
          "updatedAt":1700000002000u64,"archived":false,"pinned":false,"hasUnread":false,"activity":"working"
        }]}
    })).unwrap();
    app.wait_for("text:Catalog live update").unwrap();

    app.press("label:New Chat").unwrap();
    app.wait_for("text:Apple workspace").unwrap();
    app.press("label:Target computer").unwrap();
    app.choose_menu_item("Linux Workstation").unwrap();
    app.wait_for("text:Linux workspace").unwrap();
    for excluded in [
        "Archived workspace",
        "Unavailable workspace",
        "Missing path",
    ] {
        assert!(!app.shows(&format!("text:{excluded}")));
    }
    app.press("label:Model").unwrap();
    app.choose_menu_item("Second page model").unwrap();
    app.wait_for("text:Second page model").unwrap();
    assert_eq!(models_rx.try_recv().unwrap()["revision"], "models-b");

    app.wait_for_gone("text:Apple workspace", Duration::from_secs(2))
        .unwrap();
    app.press("label:Cancel").unwrap();

    // Filter to MacBook Pro hides Linux Workstation's conversation.
    app.press("label:MacBook Pro").unwrap();
    assert_eq!(
        filter_rx.try_recv().unwrap(),
        json!({"filter":{"kind":"single_computer","root_id":"root-a"}})
    );
    app.wait_for_gone("text:Deploy migration", Duration::from_secs(2))
        .unwrap();
    app.wait_for("text:Catalog live update").unwrap();

    // Pending stays aggregated even while Chats is scoped to the other computer.
    app.press("label:Pending").unwrap();
    app.wait_for("text:Allow service call DeployRunner?")
        .unwrap();

    // The phone offers only Deny, and the Desktop winner is authoritative.
    app.wait_for("text:/Review on Desktop/").unwrap();
    assert!(!app.shows("label:Allow"));
    app.press("label:Deny").unwrap();
    let mutation = mutate_rx.recv().await.unwrap();
    assert_eq!(mutation["rootId"], "root-b");
    assert_eq!(mutation["input"]["requestId"], "req-b");
    assert_eq!(mutation["input"]["answer"]["decision"], "deny");
    app.wait_for("text:Allowed").unwrap();
    app.wait_for("text:All caught up").unwrap();

    app.press("label:Settings").unwrap();
    app.wait_for("text:Paired Computers").unwrap();
    assert!(!app.shows("text:General"));
    app.press("label:Computer: Linux Workstation").unwrap();
    app.wait_for("text:Computer Settings").unwrap();
    app.press("label:General").unwrap();
    app.wait_for("label:AGENTS.md").unwrap();
    app.type_text("label:AGENTS.md", "Linux only").unwrap();
    app.type_text("label:Compaction prompt", "Retain more context")
        .unwrap();
    app.press("label:Save").unwrap();
    let write = tokio::time::timeout(Duration::from_secs(2), mutate_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(write["rootId"], "root-b");
    assert_eq!(write["endpoint"], "agent");
    assert_eq!(write["method"], "updateGlobalInstructions");
    assert_eq!(write["input"]["source"], "agents");
    assert_eq!(write["input"]["revision"], "etag");
    assert!(
        write["input"]["content"]
            .as_str()
            .unwrap()
            .contains("Linux only")
    );

    // Once the settings tab is left, acknowledgement of the first write must
    // not start the second (assistant preferences) write on the old Host.
    app.send_url_scheme("maka://chats");
    app.wait_for("text:Auth refactor").unwrap();
    save_rx
        .recv()
        .await
        .unwrap()
        .resolve(json!({"value":{"kind":"saved"}}));
    assert!(
        tokio::time::timeout(Duration::from_millis(300), mutate_rx.recv())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_streaming_collapsible_tools_inline_approval_and_queue_never_steers() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
            "revision": 1,
            "devicePeerId": "ios-device",
            "filter": { "kind": "all_computers" },
            "hosts": [
                { "rootId": "root-a", "hostName": "MacBook Pro", "peerId": "peer-a", "connected": true, "endpoints": ["agent"] }
            ],
            "active": {
                "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent"], "pathSummary": null, "transport": "quic"
            },
            "connections": {
                "root-a": { "status": "connected", "connection": { "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent"], "pathSummary": null, "transport": "quic" } }
            }
        })));
    });
    let session = json!({
        "id": "chat-1", "title": "Auth refactor", "kind": "agent", "parentSessionId": null,
        "backend": {"kind":"model","connectionId":"fixture","modelId":"claude-sonnet"},
        "labels": [], "workspace": { "name": "maka-agent", "path": "/src/maka-agent" },
        "revision": 1, "updatedAt": 1700000002000u64, "archived": false, "pinned": false, "hasUnread": false, "activity": "working"
    });
    let session_q = session.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let method = data["method"].as_str().unwrap();
        let value = match method {
            "list" => json!({ "revision": "1", "needsYouCount": 1, "before": null, "after": null, "sessions": [session_q] }),
            "observe" => json!({
                "session": session_q, "lastCompletedTurnId": "t0", "compacting": null, "through": 5,
                "run": { "backend": "model", "runId": "run-1", "turnId": "t1", "state": "running" },
                "parts": [], "toolSeeds": []
            }),
            "queue" => json!({"revision":3,"entries":[{"messageId":"q1","kind":"followup","preview":"Authoritative queue entry"}]}),
            "history" => json!({
                "kind": "ready", "through": 5, "before": null, "after": null,
                "chunks": [
                    { "field": "body", "position": { "kind": "live", "sequence": 1, "fact": "00000000-0000-4000-8000-000000000001", "itemIndex": 0 }, "order": { "path": [1], "itemIndex": 0 }, "offset": 0, "messageId": "m1", "turnId": "t0", "timestamp": 1, "role": "user", "text": "Fix the OAuth token refresh." },
                    { "field": "thinking", "position": { "kind": "live", "sequence": 2, "fact": "00000000-0000-4000-8000-000000000002", "itemIndex": 0 }, "order": { "path": [2], "itemIndex": 0 }, "offset": 0, "messageId": "m2", "turnId": "t0", "timestamp": 2, "role": "assistant", "text": "Inspecting token expiry window first." },
                    { "field": "body", "position": { "kind": "live", "sequence": 3, "fact": "00000000-0000-4000-8000-000000000003", "itemIndex": 0 }, "order": { "path": [3], "itemIndex": 0 }, "offset": 0, "messageId": "m2", "turnId": "t0", "timestamp": 3, "role": "assistant", "text": "", "tool": { "toolUseId": "tu1", "call":{"name":"Shell","title":{"fallback":"Test OAuth","translations":{"en":"Verify OAuth"}}},"result":{"isError":true} } },
                    { "field": "body", "position": { "kind": "live", "sequence": 4, "fact": "00000000-0000-4000-8000-000000000004", "itemIndex": 0 }, "order": { "path": [4], "itemIndex": 0 }, "offset": 0, "messageId": "m2", "turnId": "t0", "timestamp": 4, "role": "assistant", "text": "Updated refresh window to 60 seconds." }
                ]
            }),
            "models" => json!({ "kind": "ready", "choices": [{ "selection": { "kind": "model", "modelId": "claude-sonnet", "thinkingLevel": "high" }, "label": "Claude Sonnet · High", "sourceName": "anthropic", "thinkingLevels": ["high"], "defaultThinkingLevel": "high" }] }),
            "pendingInteractions" => json!({ "revision": 1, "entries": [{ "requestId": "perm-1", "kind": "permissions", "toolUseId": "tu2" }] }),
            "interaction" => json!({
                "requestId": "perm-1", "outcome": null,
                "request": {
                    "kind": "permissions", "target": {}, "toolUseId": "tu2", "basis": {},
                    "request": { "reason": "Run integration test suite", "command": { "command": "cargo test -p auth", "cwd": "/src/maka-agent" }, "permissions": { "filesystem": [], "network": "denied" } }
                }
            }),
            _ => json!({}),
        };
        call.reply(Ok(json!({ "value": value })));
    });
    let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let sub_id = data["subscriptionId"].as_str().unwrap().to_owned();
        if data["method"] == "watch" {
            let _ = watch_tx.send(sub_id.clone());
        }
        call.reply(Ok(
            json!({ "subscriptionId": sub_id, "rootId": "root-a", "generation": 1 }),
        ));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({ "cancelled": true })));
    });
    let (send_tx, mut send_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let value = if data["method"] == "editQueue" {
            json!(QueueMutationResult::RevisionConflict {
                expected: 2,
                actual: 3
            })
        } else if data["method"] == "send" {
            json!(maka_agent_api::contract::SendResult::Queued {
                session_id: "chat-1".into(),
                message_id: "queued".into(),
                revision: 4,
                completion: None,
            })
        } else {
            json!({"kind":"recorded"})
        };
        let _ = send_tx.send(data);
        call.reply(Ok(json!({"value":value})));
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();

    app.wait_for("label:Conversation: Auth refactor").unwrap();
    app.press("label:Conversation: Auth refactor").unwrap();

    // Committed turns + collapsible activity summary + inline approval render cleanly.
    app.wait_for("text:Fix the OAuth token refresh.").unwrap();
    app.wait_for("text:Updated refresh window to 60 seconds.")
        .unwrap();
    app.wait_for("text:Thought process · 1 tool").unwrap();
    assert!(!app.shows("Inspecting token expiry window first."));
    app.press("label:Thought process · 1 tool").unwrap();
    app.wait_for("text:Inspecting token expiry window first.")
        .unwrap();
    app.wait_for("text:/Test OAuth|Verify OAuth/").unwrap();
    app.wait_for("text:Run integration test suite").unwrap();

    // Stream live Markdown preview + queued turn over watch subscription.
    let watch_sub_id = watch_rx.recv().await.unwrap();
    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId": watch_sub_id,
        "rootId": "root-a",
        "generation": 1,
        "item": {
            "kind": "preview",
            "page": {
                "kind": "cut", "hostEpoch": "ea", "runId": "run-1", "turnId": "t1", "stepId": "s1", "attemptId": "a1",
                "revision": 1, "dependsOn": 0, "first": true, "last": false,
                "parts": [{ "ordinal": 0, "messageId": "m3", "providerPartId": null, "startedAt": 1, "field": { "kind": "text", "textKind": "text" }, "offset": 0, "totalBytes": 30, "text": "Streaming live verification..." }]
            }
        }
    })).unwrap();
    app.wait_for("text:Streaming live verification...").unwrap();

    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId": watch_sub_id,
        "rootId": "root-a",
        "generation": 1,
        "item": {
            "kind": "queue",
            "queue": { "revision": 2, "entries": [{ "messageId": "q1", "kind": "followup", "preview": "Add changelog entry" }] }
        }
    })).unwrap();
    app.wait_for("text:1 message queued").unwrap();
    app.press("text:1 message queued").unwrap();
    app.press("label:Remove queued message").unwrap();
    let retract = send_rx.recv().await.unwrap();
    assert_eq!(retract["method"], "editQueue");
    let retract: QueueMutation = serde_json::from_value(retract["input"].clone()).unwrap();
    assert_eq!(retract.expected_revision, 2);
    assert!(matches!(retract.edit, QueueAction::Retract { message_id } if message_id == "q1"));
    app.wait_for("text:Authoritative queue entry").unwrap();
    app.press("label:Done").unwrap();

    // Sending while running MUST use delivery = "queue" (never "steer").
    app.type_text("label:Message composer", "Follow up after tests")
        .unwrap();
    app.press("label:Queue message").unwrap();
    let sent = send_rx.recv().await.unwrap();
    assert_eq!(sent["rootId"], "root-a");
    assert_eq!(sent["method"], "send");
    assert_eq!(sent["input"]["delivery"], "queue");
    assert_eq!(sent["input"]["message"], "Follow up after tests");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diff_line_quote_inserts_into_draft_and_returns_to_chat_preserving_existing_draft() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
            "revision": 1,
            "devicePeerId": "ios-device",
            "filter": { "kind": "all_computers" },
            "hosts": [
                { "rootId": "root-a", "hostName": "MacBook Pro", "peerId": "peer-a", "connected": true, "endpoints": ["agent"] }
            ],
            "active": {
                "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent"], "pathSummary": null, "transport": "quic"
            },
            "connections": {
                "root-a": { "status": "connected", "connection": { "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent"], "pathSummary": null, "transport": "quic" } }
            }
        })));
    });
    let session = json!({
        "id": "chat-diff", "title": "Login fix", "kind": "agent", "parentSessionId": null,
        "labels": [], "workspace": { "name": "maka-agent", "path": "/src/maka-agent" },
        "revision": 1, "updatedAt": 1700000002000u64, "archived": false, "pinned": false, "hasUnread": false, "activity": "idle"
    });
    let session_q = session.clone();
    let sample_patch = "diff --git a/src/auth.rs b/src/auth.rs
--- a/src/auth.rs
+++ b/src/auth.rs
@@ -12,3 +12,3 @@ fn refresh() {
-    let ttl = 30;
+    let ttl = 60;
     ttl
 }
";
    let (files_tx, mut files_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({ "revision": "1", "needsYouCount": 0, "before": null, "after": null, "sessions": [session_q] }),
            "observe" => json!({ "session": session_q, "lastCompletedTurnId": null, "compacting": null, "through": 1, "run": null, "parts": [], "toolSeeds": [] }),
            "history" => json!({ "kind": "ready", "through": 1, "before": null, "after": null, "chunks": [] }),
            "models" => json!({ "kind": "ready", "choices": [] }),
            "pendingInteractions" => json!({ "revision": 1, "entries": [] }),
            "listFiles" => {
                files_tx.send(data["input"].clone()).unwrap();
                let path = &data["input"]["path"];
                let entries = if path.is_null() {
                    json!([{"path":{"bytesBase64":"LmdpdGh1Yg=="},"kind":"directory"}])
                } else {
                    json!([{"path":{"bytesBase64":"LmdpdGh1Yi9OT1RJQ0U="},"kind":"file"}])
                };
                json!({"directoryIdentity":"directory","entries":entries,"next":null})
            }
            "gitWorkspaceDiff" => json!({ "patch": sample_patch, "truncated": false, "skippedFiles": 0 }),
            _ => json!({}),
        };
        call.reply(Ok(json!({ "value": value })));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.reply(Ok(json!({ "subscriptionId": data["subscriptionId"], "rootId": "root-a", "generation": 1 })));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({ "cancelled": true })));
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();

    app.wait_for("label:Conversation: Login fix").unwrap();
    app.press("label:Conversation: Login fix").unwrap();
    app.wait_for("label:Message composer").unwrap();

    // Type an unsent draft before navigating to ProjectFiles -> DiffScreen.
    app.type_text("label:Message composer", "Please check this:")
        .unwrap();
    app.press("label:Files & Changes").unwrap();
    app.wait_for("label:Diff: src/auth.rs").unwrap();
    app.press("label:Diff: src/auth.rs").unwrap();
    app.wait_for("label:Quote line to chat").unwrap();
    app.press("label:Quote line to chat").unwrap();

    // Returns cleanly to ChatScreen with both original draft and quoted path:line.
    app.wait_for("text:/Please check this:/").unwrap();
    app.wait_for(r"text:/src\/auth\.rs:12/").unwrap();
    app.press("label:Files & Changes").unwrap();
    app.press("label:Files").unwrap();
    app.wait_for("label:.github").unwrap();
    app.press("label:.github").unwrap();
    app.press("label:NOTICE").unwrap();
    app.wait_for(r"text:/\.github\/NOTICE:1/").unwrap();
    let root = files_rx.try_recv().unwrap();
    let directory = files_rx.try_recv().unwrap();
    assert_eq!(root["sessionId"], "chat-diff");
    assert!(root["path"].is_null());
    assert_eq!(directory["sessionId"], "chat-diff");
    assert_eq!(directory["path"]["bytesBase64"], "LmdpdGh1Yg==");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbox_review_detail_reflects_remote_desktop_resolution_and_disables_duplicate_submit() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.reply(Ok(json!({
            "revision": 1,
            "devicePeerId": "ios-device",
            "filter": { "kind": "all_computers" },
            "hosts": [
                { "rootId": "root-a", "hostName": "MacBook Pro", "peerId": "peer-a", "connected": true, "endpoints": ["agent"] }
            ],
            "active": {
                "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent"], "pathSummary": null, "transport": "quic"
            },
            "connections": {
                "root-a": { "status": "connected", "connection": { "rootId": "root-a", "hostName": "MacBook Pro", "epoch": "ea", "session": "sa", "generation": 1, "endpoints": ["agent"], "pathSummary": null, "transport": "quic" } }
            }
        })));
    });
    let resolved_remotely = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let resolved_q = resolved_remotely.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let is_resolved = resolved_q.load(std::sync::atomic::Ordering::SeqCst);
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({
                "revision": "1", "needsYouCount": 1, "before": null, "after": null,
                "sessions": [{
                    "id": "s-1", "title": "Deploy API", "kind": "agent", "parentSessionId": null,
                    "labels": [], "workspace": { "name": "api", "path": "/srv/api" },
                    "revision": 1, "updatedAt": 1700000002000u64, "archived": false, "pinned": false, "hasUnread": false, "activity": "waiting"
                }]
            }),
            "pendingInteractions" => json!({ "revision": 1, "entries": [{ "requestId": "req-1", "kind": "service_approval", "toolUseId": "tu-1" }] }),
            "interaction" => json!({
                "requestId": "req-1",
                "outcome": if is_resolved { json!(InteractionOutcome::ServiceApprovalDecision { decision: Decision::Allow, committed_at: 1 }) } else { Value::Null },
                "request": {
                    "kind": "service_approval", "toolUseId": "tu-1", "toolName": "ReleaseTool",
                    "service": "release", "method": "publish", "binding": "prod", "through": 1
                }
            }),
            _ => json!({}),
        };
        call.reply(Ok(json!({ "value": value })));
    });
    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let id = data["subscriptionId"].as_str().unwrap().to_owned();
        let _ = sub_tx.send(id.clone());
        call.reply(Ok(
            json!({ "subscriptionId": id, "rootId": "root-a", "generation": 1 }),
        ));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({ "cancelled": true })));
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();

    app.wait_for("label:Pending").unwrap();
    app.press("label:Pending").unwrap();
    app.wait_for("text:Allow service call ReleaseTool?")
        .unwrap();
    app.press("text:Allow service call ReleaseTool?").unwrap();
    app.wait_for("label:Deny").unwrap();
    assert!(!app.shows("label:Allow"));

    // Desktop resolves the interaction while iPhone is viewing ReviewDetailScreen.
    resolved_remotely.store(true, std::sync::atomic::Ordering::SeqCst);
    let sub_id = loop {
        let id = sub_rx.recv().await.unwrap();
        if id.starts_with("review:") {
            break id;
        }
    };
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "subscriptionId": sub_id,
            "rootId": "root-a",
            "generation": 1,
            "item": DeliveryPage::Preview { page: PreviewPage::Empty { host_epoch: "ea".into() } }
        }),
    )
    .unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    app.wait_for("label:Deny").unwrap();
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "subscriptionId": sub_id,
            "rootId": "root-a",
            "generation": 1,
            "item": DeliveryPage::Interactions { pending: PendingInteractions { revision: 2, entries: vec![] } }
        }),
    )
    .unwrap();

    app.wait_for("text:Approved on another device").unwrap();
    app.wait_for_gone("label:Allow", Duration::from_secs(2))
        .unwrap();
    app.wait_for("label:Open Conversation").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_credentials_use_secret_slot_and_provider_progress_stays_live() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let connection = json!({
            "rootId":"root", "hostName":"Settings Host", "peerId":"peer", "connected":true,
            "epoch":"e", "session":"s", "generation":7,
            "endpoints":["agent","settings","authentication","setup","web"], "transport":"quic"
        });
        call.resolve(json!({
            "revision":1, "devicePeerId":"device", "hosts":[connection], "active":connection,
            "connections":{"root":{"status":"connected","connection":connection}},
        }));
    });
    channel.handle("ios.subscribe", |mut call| {
        let input = call.take_data();
        call.resolve(
            json!({"rootId":"root","subscriptionId":input["subscriptionId"],"generation":7}),
        );
    });
    channel.handle("ios.ackMutationProgress", |_| {});
    let identity =
        json!({"packageId":"test.provider","entryId":"provider","scope":"root","name":"fixture"});
    let target = json!({"connectionId":"c1","revision":9,"slug":"fixture","configuration":{},"provider":identity});
    let query_identity = identity.clone();
    let query_target = target.clone();
    let web = json!({"revision":6,"settings":{"enabled":true,"source":"custom","backend":{"kind":"tavily"}},"credential":{"configured":false,"revision":null},"presets":[]});
    let query_web = web.clone();
    let (queries_tx, mut queries) = mpsc::unbounded_channel();
    let query_failures = queries_tx.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({"sessions":[]}),
            "botOutbox" => json!({"isBot":false,"preview":"","through":0,"readThrough":0,"messages":[]}),
            "connections" => json!({"kind":"ready","revision":12,"defaultTarget":null,"next":null,
                "connections":[{"name":"Fixture provider","editable":true,"basis":{"connectionId":"c1","revision":9},
                    "provider":query_identity,"enabled":true,"enabledModelCount":0}]}),
            "models" => json!({"kind":"ready","revision":12,"choices":[],"next":null}),
            "externalAgents" => json!({"runtimes":[],"state":{"kind":"disabled"}}),
            "connection" => json!({"kind":"ready","target":query_target,"name":"Fixture provider","enabled":true,"enabledModelCount":0,
                "editing":{"enabledModelIds":[],"discoveredModelIds":[],"modelOverrides":null,"requestBodyOverlay":null}}),
            "provider" => json!({"identity":query_identity,"descriptor":{"label":"Fixture","configurationDefaults":{},"configurationSchema":{},
                "authentication":[{"id":"api_key","label":"API Key","interactive":false},{"id":"device","label":"Sign in with device code","interactive":true}],
                "discovery":true,"anonymous":false}}),
            "credentialStatus" => json!({"kind":"status","status":{"locator":data["input"]["locator"],"configured":false,"credentialId":null,"revision":null}}),
            "network" => json!({"revision":4,"rootId":"root","rootPath":"/work","proxy":{"enabled":true,"protocol":"https",
                "host":"proxy.example","port":443,"bypassList":[],"autoBypassDomains":[],"authEnabled":true,"username":"phone"},
                "credential":{"configured":true,"credentialId":"proxy-fixture-id","revision":2,"locator":{"key":"proxy"}}}),
            "snapshot" => query_web.clone(),
            other => {
                query_failures.send(Err(format!("unexpected query {other}"))).unwrap();
                call.reject("unexpected query");
                return;
            }
        };
        queries_tx.send(Ok(data)).unwrap();
        call.resolve(json!({"value":value}));
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let events = channel.clone();
    let (unexpected_tx, mut unexpected) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let result = match data["method"].as_str().unwrap() {
            "saveCredential" => json!({"kind":"saved"}),
            "saveKey" => json!({"kind":"updated","snapshot":web}),
            "updateNetwork" => json!({"kind":"applied","result":{"kind":"committed","revision":5}}),
            "discoverModels" => {
                tx.send((data, call.into_reply())).unwrap();
                return;
            }
            "loginCredential" => {
                let event = json!({"url":"https://example.com/device","userCode":"ABCD-1234"});
                events.send("ios.mutationProgress", json!({
                    "rootId":"root", "generation":7, "progressId":data["progressId"], "value":event,
                    "sequence":1, "deliveryId":1
                })).unwrap();
                tx.send((data, call.into_reply())).unwrap();
                return;
            }
            other => {
                unexpected_tx.send(other.to_owned()).unwrap();
                call.reject("unexpected mutation");
                return;
            }
        };
        tx.send((data, None)).unwrap();
        call.resolve(json!({"value":result}));
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.wait_for("label:Models & Connections").unwrap();
    app.press("label:Models & Connections").unwrap();
    app.wait_for("label:Fixture provider").unwrap();
    app.press("label:Fixture provider").unwrap();
    app.wait_for("label:API Key").unwrap();
    app.type_text("label:API Key", "provider-fixture-secret")
        .unwrap();
    app.press("label:Save API key").unwrap();
    let (call, _) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call["rootId"], "root");
    assert_eq!(call["endpoint"], "settings");
    assert_eq!(call["method"], "saveCredential");
    assert_eq!(call["secret"], "provider-fixture-secret");
    assert_eq!(
        call["input"],
        json!({"expected":target, "expectedCredential":null})
    );

    app.press("label:Discover models").unwrap();
    app.wait_for("text:Discovering models…").unwrap();
    let (call, reply) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call["endpoint"], "setup");
    assert!(call["progressId"].is_null());
    assert_eq!(call["input"], target);
    reply
        .unwrap()
        .resolve(json!({"value":{"kind":"ready","connection":{"connectionId":"c1","revision":9}}}));
    app.wait_for_gone("text:Discovering models…", Duration::from_secs(2))
        .unwrap();

    app.press("label:Sign in with device code").unwrap();
    app.wait_for("text:ABCD-1234").unwrap();
    app.wait_for("label:Copy code").unwrap();
    app.press("label:Open sign-in page").unwrap();
    assert_eq!(app.screen().opened_urls(), &["https://example.com/device"]);
    let (call, reply) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call["endpoint"], "authentication");
    assert_eq!(call["generation"], 7);
    assert_eq!(call["input"]["method"], "device");
    reply.unwrap().resolve(json!({"value":{"kind":"saved"}}));
    app.wait_for_gone("text:ABCD-1234", Duration::from_secs(2))
        .unwrap();
    app.wait_for("label:Models & Connections").unwrap();
    app.press("label:Models & Connections").unwrap();
    app.press("label:Settings").unwrap();

    app.press("label:Web Search").unwrap();
    app.wait_for("label:API Key").unwrap();
    app.type_text("label:API Key", "discarded-web-key").unwrap();
    app.press("label:Search source").unwrap();
    app.choose_menu_item("Model").unwrap();
    app.wait_for_gone("label:API Key", Duration::from_secs(2))
        .unwrap();
    app.press("label:Search source").unwrap();
    app.choose_menu_item("Search provider").unwrap();
    app.wait_for("label:API Key").unwrap();
    app.type_text("label:API Key", "web-fixture-secret")
        .unwrap();
    app.press("label:Save API key").unwrap();
    let (call, _) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call["rootId"], "root");
    assert_eq!(call["endpoint"], "web");
    assert_eq!(call["method"], "saveKey");
    assert_eq!(call["secret"], "web-fixture-secret");
    assert_eq!(call["input"], json!({"settingsRevision":6,"revision":null}));
    app.press("label:Settings").unwrap();

    app.press("label:Network Proxy").unwrap();
    app.wait_for("label:Replace password").unwrap();
    app.clear("label:Host").unwrap();
    app.type_text("label:Host", "new-proxy.example").unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:/Enter the password again or turn off proxy authentication/")
        .unwrap();
    assert!(rx.try_recv().is_err());
    app.type_text("label:Replace password", "proxy-fixture-secret")
        .unwrap();
    app.press("label:Save").unwrap();
    let (call, _) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call["rootId"], "root");
    assert_eq!(call["endpoint"], "settings");
    assert_eq!(call["method"], "updateNetwork");
    assert_eq!(call["secret"], "proxy-fixture-secret");
    assert_eq!(call["input"]["credential"], "replace");
    assert_eq!(call["input"]["expectedPolicyRevision"], 4);
    assert_eq!(call["input"]["networkProxy"]["host"], "new-proxy.example");
    assert!(!call["input"].to_string().contains("proxy-fixture-secret"));
    assert!(unexpected.try_recv().is_err());
    for query in std::iter::from_fn(|| queries.try_recv().ok()) {
        assert_eq!(query.unwrap()["rootId"], "root");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_settings_edit_presets_plugins_mcp_and_skills() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let connection = json!({
            "rootId":"root-m5", "hostName":"Settings computer", "peerId":"peer", "connected":true,
            "epoch":"e", "session":"s", "generation":7,
            "endpoints":["agent","settings","management","skills"], "transport":"quic"
        });
        call.resolve(
            json!({"revision":1,"devicePeerId":"phone","hosts":[connection],"active":connection,
            "connections":{"root-m5":{"status":"connected","connection":connection}}}),
        );
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":data["rootId"],"subscriptionId":data["subscriptionId"],"generation":7}),
        );
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let model = json!({"connectionId":"fixture","modelId":"test-model"});
    let preset = json!({"id":"preset-id","revision":8,"name":"Build reviewer","description":"Reviews changes",
        "instruction":"Check changes.","model":model,"thinkingLevel":null,"enabled":true,"availability":{"kind":"available"}});
    let source = json!({"deployment":"deploy","stateDomain":"domain","revision":9});
    let package = json!({"id":"demo.plugin","revision":"rev"});
    let plugin = json!({"instance":["key"],"package":package,"path":["demo"],"disabled":false,
        "parentDisabled":false,"structural":false,"presentation":{"displayName":"Demo Plugin","description":""}});
    let skill = json!({"reference":"skill-ref","name":"Release checklist","description":"Release process",
        "bundled":false,"valid":true,"source":"user","path":"/skills/check","preference":{"enabled":true,"pinned":false},
        "installation":{"source":{"kind":"directory","path":"/src"},"directory":"check"}});
    let bad_launch = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let bad_launch_q = bad_launch.clone();
    let (discovery_tx, mut discoveries) = mpsc::unbounded_channel();
    let source_q = source.clone();
    let package_q = package.clone();
    let (queries_tx, mut queries) = mpsc::unbounded_channel();
    let query_failures = queries_tx.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let workspace = &data["input"]["workspace"];
        let value = match (data["endpoint"].as_str().unwrap(),data["method"].as_str().unwrap()) {
            ("agent", "list") => json!({"sessions":[{"id":"project-session","title":"Workspace session","kind":"agent",
                "workspace":{"path":"/work","name":"Fixture workspace"},"updatedAt":1700000000000u64,"activity":"idle"}]}),
            ("agent", "pendingInteractions") => json!({"revision":0,"entries":[]}),
            ("agent", "botOutbox") => json!({"isBot":false,"through":0,"readThrough":0}),
            ("agent", "projects") => json!({"kind":"projects","next":null,"projects":[
                {"reference":{"id":"project"},"name":"Fixture workspace","path":"/work","archived":false,"available":true}
            ]}),
            ("agent", "presets") => json!([preset]),
            ("agent", "preset") => json!({"preset":preset,"availability":{"kind":"available"}}),
            ("settings", "models") => json!({"kind":"ready","revision":9,"next":null,"choices":[
                {"selection":model,"label":"Fixture model","connectionName":"Fixture","thinkingLevels":["low","high"]}
            ]}),
            ("management", "instances") => json!({"source":source_q,"instances":[plugin],"next":null}),
            ("management", "read") => json!({"source":{"reference":source_q,"input":{"instances":{"demo":{"bindings":{}}}}},"packages":[package_q]}),
            ("management", "readSettings") => json!({"fields":[],"next":null}),
            ("agent", "projectMcp") => {
                json!({"kind":"configuration","path":"/work/.mcp.json","revision":"trust-basis","trusted":false,
                    "servers":[{"name":"demo","launch":if bad_launch_q.load(std::sync::atomic::Ordering::SeqCst) {" "} else {"mcp-tool --stdio"},
                    "environment":["FIXTURE_TOKEN"],"headers":["Authorization"],"readOnlyTools":["look_up"],"preapproved":true}],
                    "disabled":["old"]})
            }
            ("agent", "mcpConfigurations") => {
                let location = if workspace.is_null() { "user:agents" } else {
                    "project:agents"
                };
                json!({"locations":[{"location":location,"path":"/config/mcp.json","revision":"mcp-basis","servers":[
                    {"name":"mcp-fixture","configuration":{"type":"stdio","command":"fixture-command","passEnv":["TOKEN"]}}
                ]}]})
            }
            ("skills", "list") => json!({"kind":"page","revision":"skill-basis","preferenceRevision":3,
                "entries":[skill],"targets":[{"location":"user:agents","path":"/skills"}],"writable":true}),
            ("skills", "discoverSource") => {
                discovery_tx.send(data["input"]["source"].clone()).unwrap();
                json!({"source":{"kind":"directory","path":"/skills"},"skills":[]})
            }
            ("skills", "read") => json!({"kind":"page","entry":skill,"revision":"skill-basis","text":"Fixture skill instructions.",
                "preferencesWritable":true,"preferenceRevision":3,"writable":true,"after":null}),
            method => {
                query_failures.send(Err(format!("unexpected query {method:?}"))).unwrap();
                call.reject("unexpected query");
                return;
            }
        };
        queries_tx.send(Ok(data)).unwrap();
        call.resolve(json!({"value":value}));
    });
    let (unexpected_tx, mut unexpected) = mpsc::unbounded_channel();
    let (tx, mut writes) = mpsc::unbounded_channel();
    let (delayed_tx, mut delayed) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "createPreset" | "updatePreset" | "manageMcpServer" => json!({"kind":"saved"}),
            "deletePreset" => json!({"kind":"deleted"}),
            "setEnabled" | "editComposition" => json!({"status":"committed","value":source}),
            "installUrl" => json!({"status":"committed","value":{"source":source,"package":{"id":"new.plugin","revision":"v2"}}}),
            "trustProjectMcp" => json!({"kind":"trusted"}),
            "setPreference" | "delete" => json!({"kind":"applied"}),
            method => {
                unexpected_tx.send(method.to_owned()).unwrap();
                call.reject("unexpected mutation");
                return;
            }
        };
        let hold = data["input"]["url"] == "https://example.com/delayed.maka-plugin";
        tx.send(data).unwrap();
        if hold {
            delayed_tx.send((call.into_reply().unwrap(), value)).unwrap();
        } else {
            call.resolve(json!({"value":value}));
        }
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.on_dialog(|dialog| {
        let button = if dialog.title.as_deref().unwrap().starts_with("Delete") {
            "Delete"
        } else if dialog.title.as_deref().unwrap().starts_with("Remove") {
            "Remove"
        } else if dialog.title.as_deref().unwrap().starts_with("Install") {
            "Install"
        } else if dialog.title.as_deref() == Some("Trust project MCP servers?") {
            let message = dialog.message.as_deref().unwrap();
            for part in [
                "outside the conversation sandbox",
                "/work/.mcp.json",
                "demo: mcp-tool --stdio",
                "FIXTURE_TOKEN",
                "Authorization",
                "look_up",
                "preapproved",
                "Disabled servers: old",
            ] {
                assert!(message.contains(part), "missing {part} in {message}");
            }
            "Trust"
        } else {
            panic!("unexpected dialog {:?}", dialog.title)
        };
        nsh_testing::DialogAnswer::Press(button.to_owned())
    });
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Subagents").unwrap();
    app.wait_for("label:Build reviewer").unwrap();
    app.press("label:Add subagent").unwrap();
    app.wait_for("label:Name").unwrap();
    app.type_text("label:Name", "New reviewer").unwrap();
    app.press("label:Save").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "createPreset");
    assert_eq!(write["input"]["model"]["modelId"], "test-model");
    app.press("label:Build reviewer").unwrap();
    app.wait_for("label:Instructions").unwrap();
    app.type_text("label:Instructions", "Check documentation too.")
        .unwrap();
    app.press("label:Save").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "updatePreset");
    assert_eq!(write["input"]["expectedRevision"], 8);
    app.press("label:Build reviewer").unwrap();
    app.wait_for("label:Delete").unwrap();
    app.press("label:Delete").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "deletePreset");
    app.press("label:Settings").unwrap();

    app.press("label:Plugins").unwrap();
    app.wait_for("label:Demo Plugin").unwrap();
    app.press("label:Demo Plugin").unwrap();
    app.wait_for("label:Enabled").unwrap();
    app.press("label:Enabled").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "setEnabled");
    assert_eq!(write["input"]["instance"], json!(["key"]));
    app.press("label:Plugins").unwrap();
    app.type_text("label:URL", "https://example.com/plugin.maka-plugin")
        .unwrap();
    app.press("label:Install").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "installUrl");
    assert!(write["progressId"].is_null());
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "editComposition");
    assert_eq!(write["input"]["edits"][0]["package"]["id"], "new.plugin");
    app.press("label:Settings").unwrap();

    app.press("label:MCP").unwrap();
    app.wait_for("label:mcp-fixture").unwrap();
    app.press("label:Workspace").unwrap();
    app.choose_menu_item("Fixture workspace").unwrap();
    app.wait_for("text:Fixture workspace").unwrap();
    app.press("label:Review project MCP consent").unwrap();
    app.wait_for("text:Review on Desktop").unwrap();
    assert!(writes.try_recv().is_err());
    bad_launch.store(false, std::sync::atomic::Ordering::SeqCst);
    app.press("label:Review project MCP consent").unwrap();
    let trust = writes.try_recv().unwrap();
    assert_eq!(trust["method"], "trustProjectMcp");
    assert_eq!(trust["input"]["revision"], "trust-basis");

    app.press("label:Add MCP server").unwrap();
    app.wait_for("label:Command").unwrap();
    app.type_text("label:Name", "mcp-fixture").unwrap();
    app.type_text("label:Command", "fixture-command").unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:A server with this name already exists at this location.")
        .unwrap();
    assert!(writes.try_recv().is_err());
    app.clear("label:Name").unwrap();
    app.type_text("label:Name", "new-server").unwrap();
    app.press("label:Protocol").unwrap();
    app.choose_menu_item("HTTP").unwrap();
    for url in [
        "https://user@example.test/mcp",
        "https://example.test/mcp?token=fixture",
    ] {
        app.clear("label:URL").unwrap();
        app.type_text("label:URL", url).unwrap();
        app.press("label:Save").unwrap();
        app.wait_for("text:/Use an HTTP URL without credentials/")
            .unwrap();
        assert!(writes.try_recv().is_err());
    }
    app.press("label:Protocol").unwrap();
    app.choose_menu_item("stdio").unwrap();
    app.type_text("label:Command", "mcp-tool").unwrap();
    app.send_host_event("ios.hostState", json!({"revision":2, "devicePeerId":"phone",
        "hosts":[{"rootId":"root-m5","hostName":"Settings computer","peerId":"peer","endpoints":[]}],
        "active":null,"connections":{"root-m5":{"status":"offline"}}})).unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:Could not save the MCP server.").unwrap();
    assert!(writes.try_recv().is_err());
    app.send_host_event("ios.hostState", json!({"revision":3, "devicePeerId":"phone",
        "hosts":[{"rootId":"root-m5","hostName":"Settings computer","peerId":"peer","endpoints":["agent","settings","management","skills"]}],
        "connections":{"root-m5":{"status":"connected","connection":{
            "rootId":"root-m5","hostName":"Settings computer","generation":8,
            "session":"new-anchor","epoch":"e","transport":"quic","endpoints":["agent","settings","management","skills"]
        }}}})).unwrap();
    assert!(writes.try_recv().is_err());
    app.press("label:Save").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "manageMcpServer");
    assert_eq!(write["rootId"], "root-m5");
    assert_eq!(write["input"]["workspace"]["projectId"], "project");
    assert_eq!(write["input"]["location"], "project:agents");
    assert_eq!(write["generation"], 8);
    assert_eq!(
        write["input"]["change"]["configuration"]["command"],
        "mcp-tool"
    );
    app.press("label:mcp-fixture").unwrap();
    app.wait_for("label:Enabled").unwrap();
    app.press("label:Enabled").unwrap();
    app.press("label:Save").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["input"]["change"]["configuration"]["disabled"], true);
    app.press("label:mcp-fixture").unwrap();
    app.wait_for("label:Remove").unwrap();
    app.press("label:Remove").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["input"]["change"]["kind"], "delete");
    app.press("label:Settings").unwrap();

    app.press("label:Skills").unwrap();
    app.wait_for("label:Release checklist").unwrap();
    for url in [
        "https://user:fixture@example.test/skills",
        "https:/user:fixture@example.test/skills",
        "https:user:fixture@example.test/skills",
        "https\t:/user@example.test/skills",
        "https://user@example.test/skills",
        "https://example.test/skills?token=fixture",
        "user:fixture@example.test:org/skills",
    ] {
        app.clear("label:Source").unwrap();
        app.type_text("label:Source", url).unwrap();
        app.press("label:Find skills").unwrap();
        app.wait_for("text:Use a URL without credentials.").unwrap();
        assert!(discoveries.try_recv().is_err());
    }
    app.clear("label:Source").unwrap();
    app.type_text("label:Source", "https://example.test/skills")
        .unwrap();
    app.press("label:Find skills").unwrap();
    assert_eq!(
        discoveries.try_recv().unwrap(),
        "https://example.test/skills"
    );
    app.press("label:Release checklist").unwrap();
    app.wait_for("text:Fixture skill instructions.").unwrap();
    app.press("label:Enabled").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "setPreference");
    assert_eq!(write["input"]["preference"]["enabled"], false);
    app.press("label:Release checklist").unwrap();
    app.wait_for("label:Delete").unwrap();
    app.press("label:Delete").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "delete");
    assert_eq!(write["input"]["reference"], "skill-ref");

    app.press("label:Settings").unwrap();
    app.press("label:Plugins").unwrap();
    app.type_text("label:URL", "https://example.com/delayed.maka-plugin")
        .unwrap();
    app.press("label:Install").unwrap();
    assert_eq!(writes.try_recv().unwrap()["method"], "installUrl");
    let (reply, value) = delayed.try_recv().unwrap();
    app.send_url_scheme("maka://chats");
    app.wait_for("text:Chats").unwrap();
    reply.resolve(json!({"value":value}));
    assert!(
        tokio::time::timeout(Duration::from_millis(300), writes.recv())
            .await
            .is_err()
    );
    assert!(unexpected.try_recv().is_err());
    let mut saw_project_proposal = false;
    let mut saw_redacted_inventory = false;
    for query in std::iter::from_fn(|| queries.try_recv().ok()) {
        let query = query.unwrap();
        assert_eq!(query["rootId"], "root-m5");
        match query["method"].as_str().unwrap() {
            "projectMcp" => {
                saw_project_proposal = true;
                assert_eq!(query["input"]["sessionId"], "project-session");
            }
            "mcpConfigurations" => {
                saw_redacted_inventory = true;
                assert_eq!(query["input"]["redacted"], true);
                let workspace = &query["input"]["workspace"];
                if !workspace.is_null() {
                    assert_eq!(workspace, &json!({"projectId":"project","path":"/work"}));
                }
            }
            _ => {}
        }
    }
    assert!(saw_project_proposal && saw_redacted_inventory);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_actions_match_the_scope_shown_and_fail_closed_for_future_grants() {
    let permissions = json!({"filesystem":[{"path":"/fixture/report","scope":"exact","access":"read"}],"network":"denied"});
    let known = |tool| {
        json!({"kind":"permissions","toolUseId":tool,
        "request":{"reason":"Report access","command":{"command":"read-report"},"permissions":permissions}})
    };
    let capability = |scope| {
        json!({"kind":"client_capability","toolUseId":"tool","target":{
        "providerId":"browser","contractId":"browser","serverId":"browser","toolName":"navigate",
        "capability":"browser","scope":scope}})
    };
    let cases = [
        (
            json!({"kind":"question","toolUseId":"tool","questions":[
                {"question":"Which release?","options":[{"label":"Stable"},{"label":"Beta"}]},
                {"question":"What notes?","options":[{"label":"Short"},{"label":"Full"}]}
            ]}),
            "Which release?",
            "Submit Answer",
            json!(InteractionAnswer::Question {
                answers: vec![Some("Stable".into()), None]
            }),
        ),
        (
            capability(json!({"kind":"browser_origin","origin":"https://example.test"})),
            "https://example.test",
            "Allow",
            json!(InteractionAnswer::ClientCapability {
                decision: Decision::Allow
            }),
        ),
        (
            capability(json!({"kind":"future_scope","scope":"everything"})),
            "Review on Desktop",
            "Deny",
            json!(InteractionAnswer::ClientCapability {
                decision: Decision::Deny
            }),
        ),
        (
            json!({"kind":"permissions","toolUseId":"tool","request":{"reason":"Future wire permission",
                "command":{"command":"read-report"},"permissions":{"filesystem":[],"network":"denied","future":true}}}),
            "Review on Desktop",
            "Deny",
            json!({"kind":"permissions","decision":{"decision":"deny"}}),
        ),
        (
            known(Value::String("tool".into())),
            "/fixture/report",
            "Allow once",
            json!({"kind":"permissions","decision":{"decision":"allow","scope":"once","permissions":permissions}}),
        ),
        (
            known(Value::Null),
            "/fixture/report",
            "This session",
            json!({"kind":"permissions","decision":{"decision":"allow","scope":"session","permissions":permissions}}),
        ),
        (
            json!({"kind":"session_approval","toolUseId":"tool","sessionId":"child","requestId":"delegate",
                "answer":{"kind":"computer_app","decision":"always"}}),
            "Review on Desktop",
            "Deny",
            json!(InteractionAnswer::SessionApproval {
                decision: Decision::Deny
            }),
        ),
    ];

    for (request, detail, button, expected) in cases {
        let channel = HostChannel::new();
        channel.handle("ios.bootstrap", |call| {
            let active = json!({"rootId":"root","hostName":"Fixture","generation":1,"transport":"quic","session":"anchor","endpoints":["agent"]});
            call.resolve(json!({"revision":1,"devicePeerId":"phone","active":active,
                "hosts":[{"rootId":"root","hostName":"Fixture","peerId":"fixture","endpoints":["agent"]}],
                "connections":{"root":{"status":"connected","connection":active}}}));
        });
        channel.handle("ios.subscribe", |mut call| {
            let data = call.take_data();
            call.resolve(
                json!({"rootId":"root","generation":1,"subscriptionId":data["subscriptionId"]}),
            );
        });
        let settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let settled_q = settled.clone();
        let (unexpected_tx, mut unexpected) = mpsc::unbounded_channel();
        channel.handle("ios.hostQuery", move |mut call| {
            let data = call.take_data();
            let value = match data["method"].as_str().unwrap() {
                "list" => json!({"revision":"1","needsYouCount":1,"sessions":[{"id":"s","title":"Review report","kind":"agent",
                    "workspace":{"path":"/fixture","name":"Fixture"},"updatedAt":1700000000000u64,"activity":"waiting"}]}),
                "botOutbox" => json!({"isBot":false,"through":0,"readThrough":0}),
                "pendingInteractions" => json!({"entries": if settled_q.load(std::sync::atomic::Ordering::SeqCst) {json!([])} else {
                    json!([{"requestId":"request","kind":request["kind"],"toolUseId":request["toolUseId"]}])
                }}),
                "interaction" => json!({"requestId":"request","request":request,"outcome":null}),
                method => {
                    unexpected_tx.send(method.to_owned()).unwrap();
                    call.reject("unexpected query");
                    return;
                }
            };
            call.resolve(json!({"value":value}));
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        channel.handle("ios.hostMutate", move |mut call| {
            let data = call.take_data();
            tx.send(data.clone()).unwrap();
            settled.store(true, std::sync::atomic::Ordering::SeqCst);
            let answer = &data["input"]["answer"];
            let outcome = if answer["kind"] == "question" {
                json!(InteractionOutcome::QuestionAnswer {
                    answers: serde_json::from_value(answer["answers"].clone()).unwrap(),
                    committed_at: 1,
                })
            } else {
                json!({"kind":format!("{}_decision", answer["kind"].as_str().unwrap()),
                    "decision":answer["decision"],"committedAt":1})
            };
            call.resolve(json!({"value":{"kind":"recorded","record":{"outcome":outcome}}}));
        });
        let mut config = engine_config(channel, tokio::runtime::Handle::current());
        config.viewport = Size::new(px(390.), px(844.));
        config.environment = Environment {
            os: Os::MacOs,
            reduce_motion: true,
            ..Environment::default()
        };
        let mut app = Headless::start(config).unwrap();
        app.wait_for("label:Pending").unwrap();
        app.press("label:Pending").unwrap();
        if button == "Submit Answer" {
            app.press("text:Which release?").unwrap();
            app.wait_for("text:What notes?").unwrap();
            app.press("label:Stable").unwrap();
            app.press("label:Submit Answer").unwrap();
            let data = rx.try_recv().unwrap();
            assert_eq!(data["method"], "respond");
            assert_eq!(data["input"]["answer"], expected);
            assert!(unexpected.try_recv().is_err());
            continue;
        }
        app.wait_for(&format!("text:/{}/", detail.replace('/', "\\/")))
            .unwrap();
        if button == "Deny" || button == "Always" || button == "This session" {
            assert!(!app.shows("label:Allow once"));
            assert!(!app.shows("label:Allow"));
        }
        app.press(&format!("label:{button}")).unwrap();
        let data = rx.try_recv().unwrap();
        assert_eq!(data["method"], "respond");
        assert_eq!(data["input"]["answer"], expected);
        assert!(unexpected.try_recv().is_err());
        app.wait_for(if button == "Deny" {
            "text:Denied"
        } else {
            "text:Allowed"
        })
        .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_websocket_is_visible_until_disconnected() {
    let channel = HostChannel::new();
    let empty =
        |revision| json!({"revision":revision,"devicePeerId":"phone","hosts":[],"connections":{}});
    channel.handle("ios.bootstrap", move |call| call.resolve(empty(1)));
    let (connect_tx, mut connect_rx) = mpsc::unbounded_channel();
    channel.handle("ios.connectWebSocket", move |mut call| {
        connect_tx.send(call.take_data()).unwrap();
        let connection = json!({"rootId":"manual","hostName":"WebSocket","generation":2,"session":"anchor",
            "endpoints":[],"transport":"websocket"});
        call.resolve(json!({"revision":2,"devicePeerId":"phone","hosts":[
            {"rootId":"manual","hostName":"WebSocket","peerId":"","ephemeral":true,"endpoints":[]}
        ],"active":connection,"connections":{"manual":{"status":"connected","connection":connection}}}));
    });
    let (disconnect_tx, mut disconnect_rx) = mpsc::unbounded_channel();
    channel.handle("ios.disconnectHost", move |mut call| {
        disconnect_tx.send(call.take_data()).unwrap();
        call.resolve(empty(3));
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Scan QR code on computer").unwrap();
    app.press("label:Scan QR code on computer").unwrap();
    app.wait_for("text:Scan QR Code").unwrap();
    app.press("label:Back").unwrap();
    app.press("label:Paste pairing link or connect manually")
        .unwrap();
    app.press("label:Custom relay or WebSocket").unwrap();
    app.type_text(
        "label:WebSocket endpoint",
        "wss://host.example/runtime-host",
    )
    .unwrap();
    app.type_text("label:Root ID", "manual").unwrap();
    app.type_text("label:Bearer token", "fixture-bearer")
        .unwrap();
    app.type_text("label:Client instance", "fixture-client")
        .unwrap();
    app.press("label:Connect via WebSocket").unwrap();
    assert_eq!(
        connect_rx.try_recv().unwrap(),
        json!({"endpoint":"wss://host.example/runtime-host","rootId":"manual",
        "bearer":"fixture-bearer","clientInstance":"fixture-client"})
    );
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Computer: WebSocket").unwrap();
    app.wait_for("label:Disconnect").unwrap();
    app.press("label:Disconnect").unwrap();
    assert_eq!(
        disconnect_rx.try_recv().unwrap(),
        json!({"rootId":"manual"})
    );
    app.wait_for("label:Scan QR code on computer").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_watch_keeps_the_boundary_and_ignores_pagination_from_an_old_connection() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host =
            json!({"rootId":"root","hostName":"Room Host","generation":1,"endpoints":["agent"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let phase = Arc::new(std::sync::atomic::AtomicU8::new(0));
    let query_phase = phase.clone();
    let (earlier_tx, mut earlier_rx) = mpsc::unbounded_channel();
    let (unexpected_tx, mut unexpected) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let session = json!({"id":"room-1","title":"Release Room","kind":"room","parentSessionId":null,
            "workspace":{"path":"/work"},"updatedAt":1700000000000u64,"activity":"idle",
            "backend":{"kind":"model","connectionId":"conn","modelId":"stale-model"}});
        let message = |sequence, id, text| {
            json!({"sequence":sequence,"id":id,"content":{"text":text,"attachments":[]},"at":1,
                "author":{"kind":"human"},"mentions":[],"deliveries":[],"reactions":[]})
        };
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({"sessions":[session],"needsYouCount":0}),
            "observe" => json!({"session":session,"through":0,"run":null}),
            "botOutbox" => json!({"isBot":false}),
            "models" => json!({"kind":"ready","choices":[{"label":"Stale model",
                "selection":{"kind":"model","connectionId":"conn","modelId":"stale-model"}}]}),
            "pendingInteractions" => json!({"entries":[]}),
            "history" => {
                if data["input"]["position"]["kind"] == "before_message" {
                    let value = if data["input"]["position"]["messageId"] == "m2" {
                        json!({"kind":"room","page":{"items":[message(1,"m1","Earlier room message")],"through":0,"before":"m1"}})
                    } else {
                        json!({"kind":"room","page":{"items":[message(0,"m0","Stale page from first connection")],"through":1,"before":null}})
                    };
                    earlier_tx.send((data, call, value)).unwrap();
                    return;
                }
                match query_phase.load(std::sync::atomic::Ordering::SeqCst) {
                    0 => json!({"kind":"room","page":{"items":[message(2,"m2","Initial room message")],"through":0,"before":"m2"}}),
                    1 => json!({"kind":"room","page":{"items":[message(3,"m3","Live room message")],"through":1,"before":"m3"}}),
                    _ => json!({"kind":"room","page":{"items":[message(4,"m4","Reconnected room message")],"through":2,"before":"m4"}}),
                }
            }
            method => {
                unexpected_tx.send(method.to_owned()).unwrap();
                call.reject("unexpected query");
                return;
            }
        };
        call.resolve(json!({"value":value}));
    });
    let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
    let subscribe_phase = phase.clone();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        if data["method"] == "watch" {
            watch_tx.send(data["subscriptionId"].clone()).unwrap();
        }
        let generation = if subscribe_phase.load(std::sync::atomic::Ordering::SeqCst) == 2 { 2 } else { 1 };
        call.resolve(
            json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":generation}),
        );
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let (send_tx, mut send_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        if data["method"] == "send" {
            send_tx.send(data["input"].clone()).unwrap();
        }
        call.resolve(
            json!({"value":maka_agent_api::contract::SendResult::Posted {
                session_id: "room-1".into(), message_id: "posted".into(), deliveries: vec![],
            }}),
        );
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Conversation: Release Room").unwrap();
    app.press("label:Conversation: Release Room").unwrap();
    app.wait_for("text:Initial room message").unwrap();
    app.press("label:Load earlier messages").unwrap();
    let (input, earlier, value) = earlier_rx.try_recv().unwrap();
    assert_eq!(input["input"]["position"]["messageId"], "m2");
    assert_eq!(input["input"]["through"], 0);
    let watch = watch_rx.try_recv().unwrap();
    phase.store(1, std::sync::atomic::Ordering::SeqCst);
    app.send_host_event(
        "ios.subscriptionItem",
        json!({"rootId":"root","generation":1,"subscriptionId":watch,
        "item":{"kind":"room","through":1,"revision":1}}),
    )
    .unwrap();
    app.wait_for("text:Live room message").unwrap();
    earlier.resolve(json!({"value":value}));
    app.wait_for("text:Earlier room message").unwrap();
    assert!(app.press("label:Select model").is_err());
    app.type_text("label:Message composer", "Hi Room").unwrap();
    app.press("label:Send message").unwrap();
    let input = send_rx.try_recv().unwrap();
    assert!(input["backend"].is_null());
    assert_eq!(input["message"], "Hi Room");
    app.wait_for("text:Initial room message").unwrap();
    app.press("label:Load earlier messages").unwrap();
    let (data, stale, page) = earlier_rx.try_recv().unwrap();
    assert_eq!(data["input"]["position"]["messageId"], "m1");
    phase.store(2, std::sync::atomic::Ordering::SeqCst);
    let host = json!({"rootId":"root","hostName":"Room Host","generation":2,"endpoints":["agent"]});
    app.send_host_event(
        "ios.hostState",
        json!({"revision":2,"hosts":[host],"active":host,
        "connections":{"root":{"status":"connected","connection":host}}}),
    )
    .unwrap();
    app.wait_for("text:Reconnected room message").unwrap();
    stale.resolve(json!({"value":page}));
    assert!(app.settle());
    assert!(!app.shows("Stale page from first connection"));
    app.wait_for("label:Load earlier messages").unwrap();
    assert!(unexpected.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_history_merges_overlapping_byte_ranges_and_coalesces_tail_refreshes() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host = json!({"rootId":"root","hostName":"Host","generation":1,"endpoints":["agent"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let prefix = "é".repeat(30); // 60 UTF-8 bytes, not 60 JS code units.
    let original = format!("{prefix}{}", "a".repeat(40));
    let refreshed = format!("{prefix}{}", "b".repeat(40));
    let final_text = format!("{prefix}{}", "c".repeat(40));
    let history = |position: u64, offset, text: &str, before| {
        json!({"kind":"ready","through":2,"before":before,"after":null,"chunks":[{
            "importedTurn":null,"field":"body","position":{"kind":"live","sequence":position,
                "fact":Uuid::from_u128(u128::from(position)),"itemIndex":0},
            "order":{"path":[position],"itemIndex":0},"offset":offset,"totalBytes":if position == 1 { text.len() } else { 100 },"messageId":format!("m{position}"),
            "role":if position == 1 { "user" } else { "assistant" },"turnId":"t1","text":text,"tool":null
        }]})
    };
    let initial = history(2, 0, &original, Some(json!({"fixture":"older"})));
    let mut older = history(1, 0, "Earlier user message", None);
    let prefix = "Imported user prefix ";
    let suffix = "and continuation";
    let mut first = history(1, 0, prefix, None)["chunks"][0].clone();
    first["messageId"] = Value::Null;
    first["order"]["itemIndex"] = json!(1);
    first["position"] = json!({"kind":"imported","path":[],"snapshot":Uuid::nil(),"messageOrdinal":1,"partOrdinal":1});
    first["totalBytes"] = json!(prefix.len() + suffix.len());
    let mut last = first.clone();
    last["text"] = json!(suffix);
    last["offset"] = json!(prefix.len());
    older["chunks"]
        .as_array_mut()
        .unwrap()
        .extend([first, last]);
    let (tail_tx, mut tail_rx) = mpsc::unbounded_channel();
    let tail_requests = std::sync::atomic::AtomicUsize::new(0);
    let (unexpected_tx, mut unexpected) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let session = json!({"id":"agent-1","title":"Agent History","kind":"agent","parentSessionId":null,
            "workspace":{"path":"/work"},"updatedAt":1700000000000u64,"activity":"idle"});
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({"sessions":[session],"needsYouCount":0}),
            "observe" => json!({"session":session,"through":2,"run":null}),
            "botOutbox" => json!({"isBot":false}),
            "models" => json!({"kind":"ready","choices":[]}),
            "pendingInteractions" => json!({"entries":[]}),
            "history" if data["input"]["position"]["kind"] == "before" => older.clone(),
            "history" if tail_requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 => initial.clone(),
            "history" => {
                tail_tx.send(call).unwrap();
                return;
            }
            method => {
                unexpected_tx.send(method.to_owned()).unwrap();
                call.reject("unexpected query");
                return;
            }
        };
        call.resolve(json!({"value":value}));
    });
    let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        if data["method"] == "watch" {
            watch_tx.send(data["subscriptionId"].clone()).unwrap();
        }
        call.resolve(
            json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":1}),
        );
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Conversation: Agent History").unwrap();
    app.press("label:Conversation: Agent History").unwrap();
    app.wait_for(&format!("text:/^{original}$/")).unwrap();
    app.press("label:Load earlier messages").unwrap();
    app.wait_for("text:Earlier user message").unwrap();
    app.wait_for("text:/^Imported user prefix and continuation$/")
        .unwrap();
    let watch = watch_rx.try_recv().unwrap();
    let delivery = |through| {
        json!({"rootId":"root","generation":1,"subscriptionId":watch,
        "item":{"kind":"events","through":through,"nextAfter":through,
            "events":[{"sequence":through,"runId":Uuid::nil(),"turnId":"t1","fact":{
                "kind":"executor_text_changed","messageId":"m2","thinking":false
            }}]}})
    };
    for through in 3..=12 {
        app.host()
            .send("ios.subscriptionItem", delivery(through))
            .unwrap();
    }
    // A visible delivery after the burst proves all earlier events were handled.
    app.host().send("ios.subscriptionItem", json!({
        "rootId":"root","generation":1,"subscriptionId":watch,
        "item": DeliveryPage::Queue { queue: Queue { revision: 1, entries: vec![QueueEntry {
            message_id: "queued".into(), kind: QueueKind::Followup, preview: "Queued".into(), origin: None,
        }] }}
    })).unwrap();
    app.wait_for("text:1 message queued").unwrap();
    let first = tail_rx.try_recv().unwrap();
    assert!(
        tail_rx.try_recv().is_err(),
        "parallel tail query while one is in flight"
    );

    first.resolve(json!({"value":history(2,60,&"b".repeat(40),None)}));
    app.wait_for(&format!("text:/^{refreshed}$/")).unwrap();
    let followup = tail_rx.try_recv().unwrap();
    followup.resolve(json!({"value":history(2,60,&"c".repeat(40),None)}));
    app.wait_for(&format!("text:/^{final_text}$/")).unwrap();
    app.wait_for("text:Earlier user message").unwrap();
    assert!(
        tail_rx.try_recv().is_err(),
        "burst should schedule just one catch-up query"
    );
    assert!(unexpected.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn default_model_is_sent_on_create_and_recovers_unbound_conversations() {
    use maka_agent_api::contract::{BackendPreference, Create, Send, SendResult, SessionKind};

    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host = json!({"rootId":"root","hostName":"Relay Host","generation":7,
            "endpoints":["agent","settings"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let session = |id: &str, title: &str, kind: SessionKind, backend| {
        json!({"id":id,"title":title,"kind":kind,"parentSessionId":null,"backend":backend,
            "workspace":{"path":"/work"},"revision":1,"updatedAt":1700000000000u64,"activity":"idle"})
    };
    let new_session = Arc::new(std::sync::Mutex::new(Value::Null));
    let query_session = new_session.clone();
    let unavailable = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let query_unavailable = unavailable.clone();
    let (resolve_tx, mut resolves) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let input = &data["input"];
        let legacy = session("legacy", "Legacy chat", SessionKind::Agent, Value::Null);
        let remembered = session("remembered", "Remembered chat", SessionKind::Agent, Value::Null);
        let value = match (data["endpoint"].as_str().unwrap(), data["method"].as_str().unwrap()) {
            ("agent", "list") => json!({"sessions":[legacy,remembered],"needsYouCount":0}),
            ("agent", "projects") => json!({"kind":"projects","next":null,"projects":[]}),
            ("agent", "directories") => json!({"kind":"roots","roots":[{"name":"Work","path":"/work"}]}),
            ("agent", "botOutbox") => json!({"isBot":false}),
            ("agent", "presets") => json!([]),
            ("agent", "models") => json!({"kind":"ready","choices":[
                {"label":"Not the default","selection":{"kind":"model","connectionId":"other","modelId":"other-model"}}
            ],"next":null}),
            ("agent", "pendingInteractions") => json!({"entries":[]}),
            ("agent", "observe") => {
                let (row, saved) = match input["sessionId"].as_str() {
                    Some("legacy") => (legacy, Value::Null),
                    Some("remembered") => (remembered, json!({"kind":"model","connectionId":"earlier","modelId":"remembered-model"})),
                    _ => (query_session.lock().unwrap().clone(), Value::Null),
                };
                json!({"session":row,"rememberedBackend":saved,"through":0,"run":null})
            }
            ("agent", "history") if input["sessionId"] == "room-new" =>
                json!({"kind":"room","page":{"items":[],"through":0,"before":null,"after":null}}),
            ("agent", "history") => json!({"kind":"ready","chunks":[],"through":0,"before":null,"after":null}),
            ("settings", "connections") => json!({"kind":"ready","revision":1,"connections":[],"next":null,
                "defaultTarget":{"connectionId":"kimi","modelId":"kimi-k2.5"}}),
            ("settings", "resolveModel") => {
                resolve_tx.send(input.clone()).unwrap();
                if query_unavailable.load(std::sync::atomic::Ordering::SeqCst) {
                    json!({"kind":"unavailable","target":input})
                } else {
                    json!({"kind":"ready","defaults":null,"choice":{"label":"Kimi default","connectionName":"Kimi",
                        "selection":{"connectionId":"kimi","modelId":"kimi-k2.5"},"thinkingLevels":[],"defaultThinkingLevel":null}})
                }
            }
            _ => {
                call.reject("unexpected query");
                return;
            }
        };
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":"root","generation":7,"subscriptionId":data["subscriptionId"]}),
        );
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let (mutate_tx, mut mutations) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str() {
            Some("create") => match serde_json::from_value::<Create>(data["input"].clone()) {
                Ok(create) => {
                    let id = if create.kind == SessionKind::Room {
                        "room-new"
                    } else {
                        "agent-new"
                    };
                    let row = session(id, &create.title, create.kind, json!(create.backend));
                    *new_session.lock().unwrap() = row.clone();
                    json!({"kind":"created","session":row})
                }
                Err(error) => {
                    mutate_tx.send(data).unwrap();
                    call.reject(error.to_string());
                    return;
                }
            },
            Some("send") => match serde_json::from_value::<Send>(data["input"].clone()) {
                Ok(send) if send.session_id == "room-new" => json!(SendResult::Posted {
                    session_id: send.session_id,
                    message_id: "posted".into(),
                    deliveries: vec![],
                }),
                Ok(send) if send.backend.is_some() => json!(SendResult::Queued {
                    session_id: send.session_id,
                    message_id: "queued".into(),
                    revision: 1,
                    completion: None,
                }),
                Ok(send) => json!(SendResult::Rejected {
                    session_id: send.session_id,
                    reason: maka_agent_api::contract::SendRejection::ModelUnavailable,
                    skills: None,
                }),
                Err(error) => {
                    mutate_tx.send(data).unwrap();
                    call.reject(error.to_string());
                    return;
                }
            },
            _ => {
                call.reject("unexpected mutation");
                return;
            }
        };
        mutate_tx.send(data).unwrap();
        call.resolve(json!({"value":value}));
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    let default_target = json!({"connectionId":"kimi","modelId":"kimi-k2.5"});
    let assert_backend = |backend, connection, model| {
        assert!(
            matches!(backend, Some(BackendPreference::Model {connection_id, model_id, ..})
            if connection_id == connection && model_id == model)
        );
    };
    let send_text = |app: &mut Headless, message: &str| {
        app.type_text("label:Message composer", message).unwrap();
        app.press("label:Send message").unwrap();
    };
    app.wait_for("label:New Chat").unwrap();
    app.press("label:New Chat").unwrap();
    app.wait_for("text:Kimi default").unwrap();
    assert_eq!(resolves.try_recv().unwrap(), default_target);
    app.press("label:Start Chat").unwrap();
    let data = mutations.try_recv().unwrap();
    assert_eq!(data["generation"], 7);
    let create: Create = serde_json::from_value(data["input"].clone()).unwrap();
    assert_eq!(create.kind, SessionKind::Agent);
    assert_backend(create.backend, "kimi", "kimi-k2.5");
    send_text(&mut app, "Hello from a new chat");
    let send: Send =
        serde_json::from_value(mutations.try_recv().unwrap()["input"].clone()).unwrap();
    assert_eq!(send.session_id, "agent-new");
    assert_backend(send.backend, "kimi", "kimi-k2.5");
    assert!(resolves.try_recv().is_err());

    app.press("label:Chats").unwrap();
    app.press("label:Conversation: Legacy chat").unwrap();
    send_text(&mut app, "Resume from before the fix");
    let send: Send =
        serde_json::from_value(mutations.try_recv().unwrap()["input"].clone()).unwrap();
    assert_eq!(send.session_id, "legacy");
    assert_backend(send.backend, "kimi", "kimi-k2.5");
    assert_eq!(resolves.try_recv().unwrap(), default_target);

    app.press("label:Chats").unwrap();
    app.press("label:Conversation: Remembered chat").unwrap();
    send_text(&mut app, "Use the earlier admitted model");
    let send: Send =
        serde_json::from_value(mutations.try_recv().unwrap()["input"].clone()).unwrap();
    assert_eq!(send.session_id, "remembered");
    assert_backend(send.backend, "earlier", "remembered-model");
    assert!(resolves.try_recv().is_err());

    app.press("label:Chats").unwrap();
    unavailable.store(true, std::sync::atomic::Ordering::SeqCst);
    app.press("label:Conversation: Legacy chat").unwrap();
    send_text(&mut app, "Keep this draft");
    app.wait_for("text:Select model").unwrap();
    app.wait_for("text:Keep this draft").unwrap();
    assert!(mutations.try_recv().is_err());

    app.press("label:Chats").unwrap();
    app.press("label:New Chat").unwrap();
    app.wait_for("text:Unavailable").unwrap();
    let _ = app.press("label:Start Chat");
    assert!(mutations.try_recv().is_err());
    app.press("label:Room").unwrap();
    app.press("label:Create Room").unwrap();
    let create: Create =
        serde_json::from_value(mutations.try_recv().unwrap()["input"].clone()).unwrap();
    assert_eq!(create.kind, SessionKind::Room);
    assert!(create.backend.is_none());
    send_text(&mut app, "Hello Room");
    let send: Send =
        serde_json::from_value(mutations.try_recv().unwrap()["input"].clone()).unwrap();
    assert_eq!(send.session_id, "room-new");
    assert!(send.backend.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_waits_for_current_backend_and_send_preserves_the_next_draft() {
    use maka_agent_api::contract::{SelectBackend, Send, SendResult};
    use nsh_core::{EventKind, EventPayload, MountItem};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    let channel = HostChannel::new();
    let host_state = |generation, revision| {
        let host = json!({"rootId":"root","hostName":"Relay Host","generation":generation,"endpoints":["agent"]});
        json!({"revision":revision,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}})
    };
    channel.handle("ios.bootstrap", move |call| call.resolve(host_state(1, 1)));
    let model = |connection| json!({"kind":"model","connectionId":connection,"modelId":"shared","serviceTier":"fast"});
    let row = |revision, backend: Value| {
        json!({"id":"chat","kind":"agent","title":"Chat","parentSessionId":null,
            "workspace":{"path":"/work"},"revision":revision,"backend":backend,
            "updatedAt":1700000000000u64,"activity":"idle"})
    };
    let session = Arc::new(std::sync::Mutex::new(row(1, model("first"))));
    let observed = session.clone();
    let hold_observe = Arc::new(AtomicBool::new(false));
    let held = hold_observe.clone();
    let (observe_tx, mut observations) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let row = observed.lock().unwrap().clone();
        let value = match data["method"].as_str() {
            Some("list") => json!({"sessions":[row],"needsYouCount":0}),
            Some("observe") => {
                let value = json!({"session":row,"through":1,"run":null});
                if held.swap(false, Ordering::SeqCst) {
                    observe_tx.send((call, value)).unwrap();
                    return;
                }
                value
            }
            Some("history") => {
                json!({"kind":"ready","chunks":[],"through":1,"before":null,"after":null})
            }
            Some("pendingInteractions") => json!({"entries":[]}),
            Some("botOutbox") => json!({"isBot":false}),
            Some("models") => json!({"kind":"ready","choices":[
                {"label":"First connector","selection":model("first")},
                {"label":"Second connector","selection":model("second")}
            ]}),
            _ => {
                call.reject("unexpected query");
                return;
            }
        };
        call.resolve(json!({"value":value}));
    });
    let generation = Arc::new(AtomicU64::new(1));
    let subscription_generation = generation.clone();
    let (watch_tx, mut watches) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        if data["method"] == "watch" {
            watch_tx
                .send(data["subscriptionId"].as_str().unwrap().to_owned())
                .unwrap();
        }
        let generation = subscription_generation.load(Ordering::SeqCst);
        call.resolve(json!({"rootId":"root","generation":generation,"subscriptionId":data["subscriptionId"]}));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let (mutation_tx, mut mutations) = mpsc::unbounded_channel();
    let picked = session.clone();
    let hold_selection = Arc::new(AtomicBool::new(false));
    let hold_commit = hold_selection.clone();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        match data["method"].as_str() {
            Some("send") => mutation_tx.send((data, Some(call))).unwrap(),
            Some("selectBackend") => {
                let mut current = picked.lock().unwrap();
                let revision = current["revision"].as_u64().unwrap() + 1;
                *current = row(revision, data["input"]["backend"].clone());
                if hold_commit.swap(false, Ordering::SeqCst) {
                    mutation_tx.send((data, Some(call))).unwrap();
                } else {
                    mutation_tx.send((data, None)).unwrap();
                    call.resolve(json!({"value":{"kind":"committed","session":*current}}));
                }
            }
            _ => call.reject("unexpected mutation"),
        }
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();

    // Headless hosts the iOS view tree, not UIKit's native menu. Read the
    // displayed items and return the chosen ID through the native select event.
    let (menu_tx, mut menus) = mpsc::unbounded_channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ComponentProps { id, props } = item {
                for (name, value) in props {
                    if name.as_ref() == "items"
                        && let Some(items) = value.as_ref().and_then(Value::as_array)
                        && items.iter().any(|item| item["label"] == "Second connector")
                    {
                        menu_tx.send((*id, items.clone())).unwrap();
                    }
                }
            }
        }
    });
    app.wait_for("label:Conversation: Chat").unwrap();
    app.press("label:Conversation: Chat").unwrap();
    app.type_text("label:Message composer", "First draft")
        .unwrap();

    let choose =
        |app: &mut Headless, menus: &mut mpsc::UnboundedReceiver<(_, Vec<Value>)>, label| {
            let (id, items) = std::iter::from_fn(|| menus.try_recv().ok()).last().unwrap();
            let item = items.iter().find(|item| item["label"] == label).unwrap();
            app.engine().control().dispatch_event(
                id,
                EventKind::NativeEvent,
                EventPayload::Native {
                    name: "select".into(),
                    data: item["id"].clone(),
                },
            );
            app.settle();
        };
    *session.lock().unwrap() = row(2, model("first"));
    hold_observe.store(true, Ordering::SeqCst);
    generation.store(2, Ordering::SeqCst);
    app.send_host_event("ios.hostState", host_state(2, 2))
        .unwrap();
    let (observe, snapshot) = observations.try_recv().unwrap();
    hold_selection.store(true, Ordering::SeqCst);
    choose(&mut app, &mut menus, "Second connector");
    assert!(
        mutations.try_recv().is_err(),
        "selected before the current observation"
    );
    app.press("label:Send message").unwrap();
    assert!(
        mutations.try_recv().is_err(),
        "sent before the current observation"
    );
    observe.resolve(json!({"value":snapshot}));
    app.settle();
    let (selection, commit) = mutations.try_recv().unwrap();
    assert_eq!(selection["method"], "selectBackend");
    assert_eq!(selection["generation"], 2);
    assert!(
        mutations.try_recv().is_err(),
        "sent before the model selection committed"
    );
    commit
        .unwrap()
        .resolve(json!({"value":{"kind":"committed","session":*session.lock().unwrap()}}));
    app.settle();
    let (call, receipt) = mutations.try_recv().unwrap();
    let send: Send = serde_json::from_value(call["input"].clone()).unwrap();
    assert_eq!(call["generation"], 2);
    assert_eq!(send.message, "First draft");
    assert_eq!(
        serde_json::to_value(send.backend).unwrap()["connectionId"],
        "second"
    );

    app.clear("label:Message composer").unwrap();
    app.type_text("label:Message composer", "Next draft")
        .unwrap();
    receipt.unwrap().resolve(json!({"value":SendResult::Queued {
        session_id: "chat".into(), message_id: "first".into(), revision: 1, completion: None,
    }}));
    assert!(app.settle());
    app.wait_for("text:Next draft").unwrap();

    choose(&mut app, &mut menus, "First connector");
    let (first, _) = mutations.try_recv().unwrap();
    assert_eq!(first["input"]["backend"]["connectionId"], "first");
    choose(&mut app, &mut menus, "Second connector");
    let (second, _) = mutations.try_recv().unwrap();
    assert_eq!(second["method"], "selectBackend");
    let select: SelectBackend = serde_json::from_value(second["input"].clone()).unwrap();
    let backend = serde_json::to_value(select.backend).unwrap();
    assert_eq!(backend["connectionId"], "second");
    assert_eq!(backend["serviceTier"], "fast");
    app.wait_for("text:Second connector").unwrap();

    // An ended watch event arriving while a stale running observe is in flight
    // must schedule a catch-up observe rather than sticking in the running state.
    let watch_id = std::iter::from_fn(|| watches.try_recv().ok())
        .last()
        .unwrap();
    hold_observe.store(true, Ordering::SeqCst);
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "rootId": "root",
            "subscriptionId": watch_id,
            "item": { "kind": "events", "through": 2, "events": [{ "runId": "r1", "fact": { "kind": "opened" } }] }
        }),
    )
    .unwrap();
    let (stale_observe, _) = observations.try_recv().unwrap();
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "rootId": "root",
            "subscriptionId": watch_id,
            "item": { "kind": "events", "through": 3, "events": [{ "runId": "r1", "fact": { "kind": "ended" } }] }
        }),
    )
    .unwrap();
    hold_observe.store(true, Ordering::SeqCst);
    let running_row = session.lock().unwrap().clone();
    stale_observe.resolve(json!({
        "value": {
            "session": running_row,
            "through": 2,
            "run": { "backend": "model", "runId": "r1", "turnId": "t1", "state": "running" }
        }
    }));
    app.wait_for("label:Stop Run").unwrap();
    let (catch_up_observe, idle_snapshot) = observations
        .try_recv()
        .expect("ended event during an in-flight observe must schedule a catch-up observe");
    catch_up_observe.resolve(json!({ "value": idle_snapshot }));
    assert!(app.settle());
    assert!(
        !app.shows("label:Stop Run"),
        "catch-up observe after ended must clear the running state"
    );
}
