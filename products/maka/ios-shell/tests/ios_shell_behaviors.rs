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
    app.wait_for("text:First test Host").unwrap();
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
        assert_eq!(state["activeRootId"], b_id);

        let save = |root: &str| json!({
            "rootId":root, "endpoint":"web", "method":"save",
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
        let mut watched_roots = vec![items.recv().await.unwrap(), items.recv().await.unwrap()];
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
            "rootId":b_id, "endpoint":"web", "method":"saveKey", "secret":secret,
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
async fn close_during_pairing_admission_cancels_and_ignores_late_admission() {
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
    channel.handle("ios.confirmPairing", move |call| {
        confirm_tx.send(call.into_reply().unwrap()).unwrap()
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
    app.press("label:Connect and compare").unwrap();
    app.wait_for("text:123456").unwrap();
    app.press("label:Confirm & Connect").unwrap();
    let confirm = confirming.try_recv().unwrap();
    app.press("label:Close").unwrap();
    cancelled.try_recv().unwrap();
    confirm.resolve(json!({
        "revision": 2,
        "devicePeerId": "fixture",
        "filter": { "kind": "all_computers" },
        "hosts": [{
            "rootId": "late-root",
            "hostName": "Unexpected late Host",
            "peerId": "late-peer",
            "connected": true,
            "endpoints": []
        }],
        "active": {
            "rootId": "late-root",
            "hostName": "Unexpected late Host",
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
    app.wait_for_gone("text:Unexpected late Host", Duration::from_secs(1))
        .unwrap();
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
    channel.handle("ios.setFilter", |call| {
        call.reply(Ok(json!({ "revision": 1, "devicePeerId": "ios-device", "filter": { "kind": "all_computers" }, "hosts": [], "active": null })));
    });
    let approved = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let approved_q = approved.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let root = data["rootId"].as_str().unwrap_or("");
        let method = data["method"].as_str().unwrap();
        let is_approved = approved_q.load(std::sync::atomic::Ordering::SeqCst);
        let value = match (root, method) {
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
    let approved_m = approved.clone();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        approved_m.store(true, std::sync::atomic::Ordering::SeqCst);
        mutate_tx.send(data).unwrap();
        call.reply(Ok(json!({ "value": { "kind": "recorded" } })));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.reply(Ok(json!({
            "subscriptionId": data["subscriptionId"],
            "rootId": data["rootId"],
            "generation": 1
        })));
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

    // Filter to MacBook Pro hides Linux Workstation's conversation.
    app.press("label:MacBook Pro").unwrap();
    app.wait_for_gone("text:Deploy migration", Duration::from_secs(2))
        .unwrap();
    app.wait_for("text:Auth refactor").unwrap();

    // Switch back to All Computers and open Tab 2 Pending Inbox (live badge shows 1).
    app.press("label:All Computers").unwrap();
    app.wait_for("text:Deploy migration").unwrap();
    app.press("label:Pending").unwrap();
    app.wait_for("text:Allow service call DeployRunner?")
        .unwrap();

    // Approve directly from Pending Inbox and verify the mutation targets root-b.
    app.press("label:Allow").unwrap();
    let mutation = mutate_rx.recv().await.unwrap();
    assert_eq!(mutation["rootId"], "root-b");
    assert_eq!(mutation["input"]["requestId"], "req-b");
    app.wait_for("text:All caught up").unwrap();
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
            "history" => json!({
                "kind": "ready", "through": 5, "before": null, "after": null,
                "chunks": [
                    { "field": "body", "position": { "kind": "live", "sequence": 1, "fact": "00000000-0000-4000-8000-000000000001", "itemIndex": 0 }, "order": { "path": [1], "itemIndex": 0 }, "offset": 0, "messageId": "m1", "turnId": "t0", "timestamp": 1, "role": "user", "text": "Fix the OAuth token refresh." },
                    { "field": "thinking", "position": { "kind": "live", "sequence": 2, "fact": "00000000-0000-4000-8000-000000000002", "itemIndex": 0 }, "order": { "path": [2], "itemIndex": 0 }, "offset": 0, "messageId": "m2", "turnId": "t0", "timestamp": 2, "role": "assistant", "text": "Inspecting token expiry window first." },
                    { "field": "body", "position": { "kind": "live", "sequence": 3, "fact": "00000000-0000-4000-8000-000000000003", "itemIndex": 0 }, "order": { "path": [3], "itemIndex": 0 }, "offset": 0, "messageId": "m2", "turnId": "t0", "timestamp": 3, "role": "assistant", "text": "", "tool": { "toolUseId": "tu1", "name": "Shell", "title": "cargo test oauth", "isError": false } },
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
        let _ = send_tx.send(data);
        call.reply(Ok(json!({ "value": { "kind": "recorded" } })));
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
    app.wait_for("text:cargo test oauth").unwrap();
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
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({ "revision": "1", "needsYouCount": 0, "before": null, "after": null, "sessions": [session_q] }),
            "observe" => json!({ "session": session_q, "lastCompletedTurnId": null, "compacting": null, "through": 1, "run": null, "parts": [], "toolSeeds": [] }),
            "history" => json!({ "kind": "ready", "through": 1, "before": null, "after": null, "chunks": [] }),
            "models" => json!({ "kind": "ready", "choices": [] }),
            "pendingInteractions" => json!({ "revision": 1, "entries": [] }),
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
                "outcome": if is_resolved { json!({ "decision": "allow" }) } else { Value::Null },
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
    app.wait_for("label:Allow once").unwrap();

    // Desktop resolves the interaction while iPhone is viewing ReviewDetailScreen.
    resolved_remotely.store(true, std::sync::atomic::Ordering::SeqCst);
    let sub_id = sub_rx.recv().await.unwrap();
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "subscriptionId": sub_id,
            "rootId": "root-a",
            "generation": 1,
            "item": { "kind": "changed" }
        }),
    )
    .unwrap();

    app.wait_for("text:Approved on another device").unwrap();
    app.wait_for_gone("label:Allow once", Duration::from_secs(2))
        .unwrap();
    app.wait_for("label:Open Conversation").unwrap();
}
