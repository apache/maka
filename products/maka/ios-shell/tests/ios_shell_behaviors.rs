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
    QueueMutation, QueueMutationResult, Send, SendResult,
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
use maka_remote_pairing::HostPlatform;
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
use nsh_engine::{Bundle, EngineConfig, HostCall, HostChannel};
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

    let platform = json!(HostPlatform::current());
    if let Some(platform) = platform.as_str() {
        app.wait_for(&format!("text:/^{platform} ·/")).unwrap();
    }
    app.wait_for("text:First test Host").unwrap();
    app.clear("label:Computer name").unwrap();
    for input in ["", "   "] {
        if !input.is_empty() {
            app.type_text("label:Computer name", input).unwrap();
        }
        app.press("label:Confirm & Connect").unwrap();
        app.wait_for("text:A name cannot be empty.").unwrap();
        assert!(first.host.list_peer_access().await.unwrap().is_empty());
        assert!(!support.path().join("hosts.json").exists());
    }
    app.clear("label:Computer name").unwrap();
    app.type_text("label:Computer name", &"界".repeat(43))
        .unwrap();
    app.press("label:Confirm & Connect").unwrap();
    app.wait_for("text:Computer name is too long.").unwrap();
    app.clear("label:Computer name").unwrap();
    app.type_text("label:Computer name", "Travel Mac").unwrap();
    app.wait_for("text:Travel Mac").unwrap();
    assert!(!app.shows("text:First test Host"));
    app.press("label:Confirm & Connect").unwrap();
    app.wait_for("text:Travel Mac · Online").unwrap();
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

    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: Travel Mac").unwrap();
    if let Some(platform) = platform.as_str() {
        app.wait_for(&format!("text:/^{platform} · Connected/"))
            .unwrap();
    }
    app.press("label:Computer: Travel Mac").unwrap();
    if let Some(platform) = platform.as_str() {
        app.wait_for(&format!("text:{platform}")).unwrap();
    }
    assert!(!app.shows("label:Save"));
    app.clear("label:Computer name").unwrap();
    app.type_text("label:Computer name", "Office Mac").unwrap();
    app.wait_for("label:Save").unwrap();
    app.submit("label:Computer name").unwrap();
    app.wait_for_gone("label:Save", Duration::from_secs(5))
        .unwrap();
    app.press("label:Connection details").unwrap();
    app.wait_for("text:/Direct connection discovery · Port/")
        .unwrap();
    app.wait_for("label:Check connection").unwrap();
    app.press("label:Check connection").unwrap();
    app.wait_for("text:Computer responded").unwrap();
    app.press("label:Disconnect").unwrap();
    app.wait_for("label:Reconnect").unwrap();

    drop(app);
    drop(bridge);
    let persisted = std::fs::read_to_string(support.path().join("hosts.json")).unwrap();
    assert!(!persisted.contains(RELAY_TOKEN));
    let profiles: Value = serde_json::from_str(&persisted).unwrap();
    let renamed = profiles
        .as_array()
        .unwrap()
        .iter()
        .find(|profile| profile["rootId"] == first.host.root_id())
        .unwrap();
    assert_eq!(renamed["hostName"], "Office Mac");
    assert_eq!(renamed["platform"], platform);

    // The paused profile and unpaused profile have the same relay route.
    // Only the unpaused one should try it without the in-memory Bearer.
    use nsh_core::platform::{Lifecycle, NetworkKind};
    let channel = HostChannel::new();
    let runtime = tokio::runtime::Handle::current();
    let _bridge =
        HostBridge::attach(channel.clone(), support.path().to_owned(), runtime.clone()).unwrap();
    let mut config = engine_config(channel, runtime);
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        lifecycle: Lifecycle::Active,
        reduce_motion: true,
        ..Environment::default()
    };
    config.environment.network.kind = NetworkKind::Wifi;
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: Second test Host").unwrap();
    app.press("label:Computer: Second test Host").unwrap();
    app.fast_forward(Duration::from_secs(16)).unwrap();
    app.wait_for("text:/relay rejected authentication/")
        .unwrap();

    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: Office Mac").unwrap();
    if let Some(platform) = platform.as_str() {
        app.wait_for(&format!("text:/^{platform} · Offline/"))
            .unwrap();
    }
    app.press("label:Computer: Office Mac").unwrap();
    resume_after_network_change(&mut app);
    app.wait_for("label:Reconnect").unwrap();
    assert!(
        !app.screen()
            .matches("text:/relay rejected authentication/")
            .unwrap()
    );
    assert!(first.handshakes.try_recv().is_err());
    assert!(
        maka_remote_client::SavedHosts::load(support.path().join("hosts.json"))
            .unwrap()
            .get(first.host.root_id())
            .unwrap()
            .reconnect_paused()
    );

    app.press("label:Relay Bearer for Office Mac").unwrap();
    app.type_text("label:Saved Host relay Bearer token", RELAY_TOKEN)
        .unwrap();
    app.press("label:Connect with Bearer token").unwrap();
    let (same_peer, _) = first.sas().await;
    assert_eq!(same_peer, peer);
    app.wait_for("label:Check connection").unwrap();
    assert!(
        !maka_remote_client::SavedHosts::load(support.path().join("hosts.json"))
            .unwrap()
            .get(first.host.root_id())
            .unwrap()
            .reconnect_paused()
    );
    assert!(first.host.revoke_peer_access(peer).await.unwrap());
    app.wait_for("text:/peer access revoked/").unwrap();

    resume_after_network_change(&mut app);
    assert!(
        tokio::time::timeout(Duration::from_millis(400), first.handshakes.recv())
            .await
            .is_err(),
        "the revoked live session must not be redialed"
    );

    // A manual attempt gets a fresh QUIC connection, but the opening itself
    // is rejected as revoked. That path must also stop automatic attempts.
    app.press("label:Reconnect").unwrap();
    assert_eq!(first.sas().await.0, same_peer);
    app.wait_for("text:/peer access revoked/").unwrap();
    resume_after_network_change(&mut app);
    assert!(
        tokio::time::timeout(Duration::from_millis(400), first.handshakes.recv())
            .await
            .is_err(),
        "a revoked opening must not be redialed"
    );
    drop(app);
    first.shutdown().await;
    second.shutdown().await;
    relay.shutdown().await.unwrap();
}

fn resume_after_network_change(app: &mut Headless) {
    use nsh_core::platform::{Lifecycle, NetworkKind};
    app.set_environment("background/offline", |env| {
        env.lifecycle = Lifecycle::Background;
        env.network.kind = NetworkKind::None;
    })
    .unwrap();
    app.fast_forward(Duration::from_secs(16)).unwrap();
    app.set_environment("foreground/online", |env| {
        env.lifecycle = Lifecycle::Active;
        env.network.kind = NetworkKind::Cellular;
    })
    .unwrap();
    app.fast_forward(Duration::from_secs(16)).unwrap();
}

#[tokio::test]
async fn opening_a_legacy_name_does_not_offer_or_submit_a_rename() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.resolve(json!({
            "revision": 1, "devicePeerId": "fixture",
            "hosts": [{"rootId":"legacy","hostName":" Studio ","peerId":"peer","endpoints":[]}],
            "active": null, "connections": {"legacy":{"status":"offline","autoReconnect":false}}
        }));
    });
    let (renamed, mut rename_requests) = mpsc::unbounded_channel();
    channel.handle("ios.renameHost", move |mut call| {
        renamed.send(call.take_data()).unwrap();
        call.reject("unexpected rename");
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
    app.press("label:/Computer: +Studio/").unwrap();
    app.wait_for("label:Computer name").unwrap();
    assert!(!app.shows("label:Save"));
    app.submit("label:Computer name").unwrap();
    assert!(rename_requests.try_recv().is_err());
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
        let mut a = Live::start(&config, &"界".repeat(43)).await;
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
            let mut confirm = json!({"pairingId":ticket["pairingId"],"sas":sas});
            if peers.is_empty() {
                let invalid = driver.call("ios.confirmPairing", confirm.clone()).await;
                assert_eq!(invalid, json!({"kind":"invalidName","field":"hostName","reason":"tooLong"}));

                for (field, name, reason) in [
                    ("hostName", "界".repeat(43), "tooLong"),
                    ("hostName", "Lab\nMac".into(), "controlCharacter"),
                    ("deviceLabel", "界".repeat(43), "tooLong"),
                    ("deviceLabel", "Field\nPhone".into(), "controlCharacter"),
                    ("deviceLabel", "\u{0085}".into(), "empty"),
                ] {
                    let mut input = confirm.clone();
                    input[field] = json!(name);
                    let invalid = driver.call("ios.confirmPairing", input).await;
                    assert_eq!(invalid, json!({"kind":"invalidName","field":field,"reason":reason}));
                }
                assert!(host.host.list_peer_access().await.unwrap().is_empty());
                assert!(!support.path().join("hosts.json").exists());
                confirm["hostName"] = json!("Host A");
            }
            // Correcting the name must still work with the same pairing ID and one-time invite.
            let paired = driver.call("ios.confirmPairing", confirm).await;
            assert_eq!(paired["kind"], "saved");
            assert_eq!(paired["snapshot"]["connections"][host.host.root_id()]["status"], "connected");
            peers.push(peer);
        }

        let a_id = a.host.root_id().to_owned();
        let b_id = b.host.root_id().to_owned();
        let state = driver.call("ios.bootstrap", json!({})).await;
        let b_session = state["connections"][&b_id]["connection"]["session"].clone();
        assert_eq!(state["connections"][&a_id]["status"], "connected");
        assert_eq!(state["active"]["rootId"], b_id);
        driver.call("ios.networkChange", json!({})).await;
        for (name, reason) in [("界".repeat(43), "tooLong"), ("Build\nMac".into(), "controlCharacter")] {
            let invalid = driver.call("ios.renameHost", json!({"rootId":b_id,"hostName":name})).await;
            assert_eq!(invalid, json!({"kind":"invalidName","field":"hostName","reason":reason}));
        }
        let unchanged = driver.call("ios.bootstrap", json!({})).await;
        assert_eq!(unchanged["hosts"], state["hosts"]);

        let renamed = driver.call("ios.renameHost", json!({"rootId":b_id,"hostName":"  Build Mac  "})).await;
        assert_eq!(renamed["kind"], "saved");
        let renamed = &renamed["snapshot"];
        assert_eq!(renamed["active"]["hostName"], "Build Mac");
        assert_eq!(renamed["connections"][&b_id]["connection"]["hostName"], "Build Mac");
        assert_eq!(renamed["connections"][&b_id]["connection"]["session"], b_session);
        loop {
            let broadcast = states.recv().await.unwrap();
            if broadcast["revision"] == renamed["revision"] {
                assert_eq!(&broadcast, renamed);
                break;
            }
        }

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
        let paused = driver.call("ios.connectHost", json!({"rootId":a_id,"automatic":true})).await;
        assert_eq!(paused["connections"][&a_id]["status"], "offline");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn detached_engine_subscriptions_do_not_reach_the_replacement_engine() {
    use std::io::Write;

    tokio::time::timeout(Duration::from_secs(30), async {
        let (relay, config, relay_url) = https_relay().await;
        let mut remote = Live::start(&config, "Log Host").await;
        let support = tempfile::tempdir().unwrap();
        let channel = HostChannel::new();
        let _bridge = HostBridge::attach(
            channel.clone(),
            support.path().into(),
            tokio::runtime::Handle::current(),
        )
        .unwrap();
        let (reply_tx, replies) = mpsc::unbounded_channel();
        channel.handle("test.reply", move |mut call| {
            reply_tx.send(call.take_data()).unwrap();
        });
        let (event_tx, mut events) = mpsc::unbounded_channel();
        channel.handle("test.subscription", move |mut call| {
            event_tx.send(call.take_data()).unwrap();
        });
        let start_engine = || {
            let bundle = Bundle::source(
                r#"
                import { host } from 'nsh';
                host.on('test.rpc', async ([[name, data]]) => {
                  try { host.post('test.reply', [{ok: await host.call(name, data)}]); }
                  catch (error) { host.post('test.reply', [{error: String(error)}]); }
                });
                host.on('ios.subscriptionItem', event => host.post('test.subscription', event));
                host.on('ios.subscriptionEnded', event => host.post('test.subscription', event));
            "#
                .to_owned(),
            )
            .with_capabilities_json(Some(r#"{"host":true}"#))
            .unwrap();
            let mut engine = EngineConfig::new(bundle);
            engine.host = channel.clone();
            engine.runtime = Some(tokio::runtime::Handle::current());
            Headless::start(engine).unwrap()
        };

        let a = start_engine();
        let mut driver = RpcDriver {
            channel: channel.clone(),
            replies,
        };
        let ticket = driver
            .call(
                "ios.beginPairing",
                json!({
                    "uri":remote.uri,"relayUrl":relay_url,"relayToken":RELAY_TOKEN
                }),
            )
            .await;
        let (_, sas) = remote.sas().await;
        let state = driver
            .call(
                "ios.confirmPairing",
                json!({"pairingId":ticket["pairingId"],"sas":sas}),
            )
            .await;
        let root = remote.host.root_id();
        assert_eq!(state["kind"], "saved");
        assert_eq!(
            state["snapshot"]["connections"][root]["status"],
            "connected"
        );
        let handle = driver.call("ios.subscribe", json!({
            "rootId":root,"endpoint":"hostLogs","method":"watch","subscriptionId":"engine-a",
            "input":{"position":{"kind":"tail"}}
        })).await;
        let first = events.recv().await.unwrap();
        assert_eq!(first["generation"], handle["generation"]);
        assert_eq!(first["item"]["kind"], "missing");
        drop(a);

        let b = start_engine();
        let state = driver.call("ios.bootstrap", json!({})).await;
        assert_eq!(state["connections"][root]["status"], "connected");
        let source = maka_host_runtime::logs::Source::for_root(
            root,
            &RootNamespaces {
                ownership: remote._root.path().join("ownership"),
                control: remote._root.path().join("control"),
            },
        )
        .unwrap();
        source
            .open_capture()
            .unwrap()
            .write_all(b"after engine replacement\n")
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), events.recv())
                .await
                .is_err(),
            "the replacement engine received an event from the old subscription"
        );
        assert_eq!(
            driver.call("ios.unsubscribe", handle).await,
            json!({"cancelled":false})
        );

        drop(b);
        remote.shutdown().await;
        relay.shutdown().await.unwrap();
    })
    .await
    .unwrap();
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
    let (invalid, confirm) = confirming.try_recv().unwrap();
    assert_eq!(invalid["deviceLabel"], "界".repeat(43));
    confirm.unwrap().resolve(json!({
        "kind": "invalidName", "field": "deviceLabel", "reason": "tooLong"
    }));
    app.wait_for("text:Device name is too long.").unwrap();
    app.clear("label:Device name").unwrap();
    app.type_text("label:Device name", "Field iPhone").unwrap();
    app.press("label:Confirm & Connect").unwrap();
    let (input, confirm) = confirming.try_recv().unwrap();
    assert_eq!(input["pairingId"], invalid["pairingId"]);
    assert_eq!(input["deviceLabel"], "Field iPhone");
    assert!(app.press("label:Cancel").is_err());
    assert!(cancelled.try_recv().is_err());
    confirm.unwrap().resolve(json!({
        "kind": "saved",
        "snapshot": {
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
        }
    }));
    app.wait_for_gone("text:123456", Duration::from_secs(1))
        .unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.wait_for("label:Computer: Newly paired Host").unwrap();
}

#[tokio::test]
async fn automatic_reconnect_respects_app_network_and_disconnect_intent() {
    use nsh_core::platform::{Lifecycle, NetworkKind};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn state(revision: u64, connection: Value) -> Value {
        let host = json!({
            "rootId":"root","hostName":"Test Mac","peerId":"peer","endpoints":[],
            "relays":[{"url":"https://relay.example.com","quicPort":null}]
        });
        json!({
            "revision":revision,"devicePeerId":"iphone","hosts":[host],
            "active":connection["connection"],
            "connections":{"root":connection}
        })
    }

    fn connected(revision: u64) -> Value {
        state(
            revision,
            json!({"status":"connected","connection":{
                "rootId":"root","hostName":"Test Mac","generation":revision,
                "endpoints":["hostLogs"],"transport":"quic"
            }}),
        )
    }

    let channel = HostChannel::new();
    let revision = Arc::new(AtomicU64::new(1));
    channel.handle("ios.bootstrap", |call| call.resolve(connected(1)));
    let (connect_tx, mut connects) = mpsc::unbounded_channel();
    let connect_revision = revision.clone();
    channel.handle("ios.connectHost", move |mut call| {
        connect_tx.send(call.take_data()).unwrap();
        call.resolve(connected(
            connect_revision.fetch_add(1, Ordering::SeqCst) + 1,
        ));
    });
    let (refresh_tx, mut refreshes) = mpsc::unbounded_channel();
    channel.handle("ios.networkChange", move |call| {
        refresh_tx.send(()).unwrap();
        call.resolve(Value::Null);
    });
    let disconnect_revision = revision.clone();
    channel.handle("ios.disconnectHost", move |call| {
        call.resolve(state(
            disconnect_revision.fetch_add(1, Ordering::SeqCst) + 1,
            json!({"status":"offline","autoReconnect":false}),
        ));
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        lifecycle: Lifecycle::Active,
        reduce_motion: true,
        ..Environment::default()
    };
    config.environment.network.kind = NetworkKind::Wifi;
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Computer: Test Mac").unwrap();
    app.wait_for("label:Disconnect").unwrap();
    app.press("label:Connection details").unwrap();
    app.wait_for("label:https://relay.example.com").unwrap();
    app.wait_for("text:Without a discovery port, direct connections may be harder.")
        .unwrap();

    let lose_connection = |app: &mut Headless| {
        app.send_host_event(
            "ios.hostState",
            state(
                revision.fetch_add(1, Ordering::SeqCst) + 1,
                json!({"status":"error","error":"Transport closed","autoReconnect":true}),
            ),
        )
        .unwrap();
        app.wait_for("text:Transport closed").unwrap();
    };

    app.set_environment("background", |env| env.lifecycle = Lifecycle::Background)
        .unwrap();
    lose_connection(&mut app);
    app.fast_forward(Duration::from_secs(16)).unwrap();
    assert!(connects.try_recv().is_err());
    app.set_environment("foreground", |env| env.lifecycle = Lifecycle::Active)
        .unwrap();
    app.wait_for_within("label:Disconnect", Duration::from_millis(200))
        .unwrap();
    assert_eq!(
        connects.try_recv().unwrap(),
        json!({"rootId":"root","automatic":true})
    );

    app.set_environment("offline", |env| env.network.kind = NetworkKind::None)
        .unwrap();
    assert!(
        refreshes.try_recv().is_ok(),
        "the live endpoint is notified"
    );
    lose_connection(&mut app);
    app.fast_forward(Duration::from_secs(16)).unwrap();
    assert!(connects.try_recv().is_err());
    app.set_environment("cellular", |env| env.network.kind = NetworkKind::Cellular)
        .unwrap();
    app.wait_for_within("label:Disconnect", Duration::from_millis(200))
        .unwrap();
    assert_eq!(
        connects.try_recv().unwrap(),
        json!({"rootId":"root","automatic":true})
    );

    app.press("label:Disconnect").unwrap();
    app.wait_for_gone("label:Disconnect", Duration::from_secs(1))
        .unwrap();
    app.set_environment("background", |env| env.lifecycle = Lifecycle::Background)
        .unwrap();
    app.set_environment("Wi-Fi restored in background", |env| {
        env.network.kind = NetworkKind::Wifi
    })
    .unwrap();
    app.set_environment("foreground", |env| env.lifecycle = Lifecycle::Active)
        .unwrap();
    app.fast_forward(Duration::from_secs(16)).unwrap();
    assert!(
        connects.try_recv().is_err(),
        "explicit Disconnect must survive resume"
    );
    assert!(!app.screen().matches("label:Disconnect").unwrap());
}

#[tokio::test]
async fn reconnecting_stays_neutral_and_network_change_during_dial_retries_immediately() {
    use nsh_core::platform::{Lifecycle, NetworkKind};

    fn snapshot(revision: u64, connection: Value) -> Value {
        json!({
            "revision":revision,"devicePeerId":"phone",
            "hosts":[{"rootId":"root","hostName":"Test Mac","peerId":"peer","endpoints":[]}],
            "connections":{"root":connection}
        })
    }

    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.resolve(snapshot(
            1,
            json!({"status":"error","error":"Transport closed","autoReconnect":true}),
        ))
    });
    let (connect_tx, mut connects) = mpsc::unbounded_channel();
    channel.handle("ios.connectHost", move |mut call| {
        let request = call.take_data();
        assert_eq!(request, json!({"rootId":"root","automatic":true}));
        connect_tx.send(call).unwrap();
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        lifecycle: Lifecycle::Active,
        reduce_motion: true,
        ..Environment::default()
    };
    config.environment.network.kind = NetworkKind::Wifi;
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Computer: Test Mac").unwrap();

    let assert_retrying = |app: &mut Headless| {
        app.wait_for("text:Reconnecting…").unwrap();
        app.wait_for("text:Transport closed").unwrap();
        app.wait_for("label:Retry now").unwrap();
        assert!(!app.screen().matches("text:Connection error").unwrap());
    };
    assert_retrying(&mut app);
    assert!(connects.try_recv().is_err());
    app.press("label:Retry now").unwrap();
    app.fast_forward(Duration::from_millis(200)).unwrap();
    let first = connects.try_recv().expect("Retry now bypasses backoff");
    app.send_host_event("ios.hostState", snapshot(2, json!({"status":"connecting"})))
        .unwrap();
    assert_retrying(&mut app);
    app.set_environment("cellular during dial", |env| {
        env.network.kind = NetworkKind::Cellular;
    })
    .unwrap();
    app.fast_forward(Duration::from_millis(200)).unwrap();
    assert!(
        connects.try_recv().is_err(),
        "no overlapping automatic dial"
    );

    app.send_host_event(
        "ios.hostState",
        snapshot(
            3,
            json!({"status":"error","error":"Transport closed","autoReconnect":true}),
        ),
    )
    .unwrap();
    first.reject("Transport closed");
    app.fast_forward(Duration::from_millis(200)).unwrap();
    let second = connects
        .try_recv()
        .expect("route change bypasses the next backoff");
    app.send_host_event(
        "ios.hostState",
        snapshot(
            4,
            json!({"status":"error","error":"Peer access revoked","autoReconnect":false}),
        ),
    )
    .unwrap();
    second.reject("Peer access revoked");
    app.wait_for("text:Connection error").unwrap();
    app.wait_for("text:Peer access revoked").unwrap();
    app.wait_for("label:Reconnect").unwrap();
    assert!(!app.screen().matches("label:Retry now").unwrap());
    app.fast_forward(Duration::from_secs(16)).unwrap();
    assert!(connects.try_recv().is_err(), "terminal errors stop retries");
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
            ("root-a" | "root-b", "queue") => json!({"revision":0,"entries":[]}),
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
                let filter = &data["input"]["filter"];
                assert!(filter == "all" || filter == "needs_you");
                assert_eq!(
                    data["input"],
                    json!({"kind":null,"filter":filter,"includeArchived":false,"rootsOnly":false,"position":{"kind":"start"},"scope":{"kind":"all"},"titleQuery":""})
                );
                if data["rootId"] == "root-a" && filter == "all" {
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

async fn fixture_recv<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn first_load_waits_for_catalogs_and_history_without_hiding_cached_chats() {
    use nsh_core::platform::{Lifecycle, NetworkKind};

    fn state(revision: u64, connection: Value) -> Value {
        json!({
            "revision":revision,"devicePeerId":"phone",
            "hosts":[{"rootId":"root","hostName":"Studio","peerId":"peer","endpoints":[]}],
            "active":connection["connection"],
            "connections":{"root":connection}
        })
    }

    let channel = HostChannel::new();
    let (bootstrap_tx, mut bootstraps) = mpsc::unbounded_channel();
    channel.handle("ios.bootstrap", move |call| {
        bootstrap_tx.send(call).unwrap();
    });
    let chat = json!({
        "id":"chat","title":"Cached chat","kind":"agent","activity":"idle",
        "workspace":{"path":"/work"},"revision":1
    });
    let observed = chat.clone();
    let (chats_tx, mut chats_rx) = mpsc::unbounded_channel();
    let (pending_tx, mut pending_rx) = mpsc::unbounded_channel();
    let (history_tx, mut history_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let query = call.take_data();
        let value = match query["method"].as_str().unwrap() {
            "list" if query["input"]["filter"] == "needs_you" => {
                pending_tx.send(call).unwrap();
                return;
            }
            "list" => {
                chats_tx.send(call).unwrap();
                return;
            }
            "history" => {
                history_tx.send((query["input"].clone(), call)).unwrap();
                return;
            }
            "observe" => json!({"session":observed,"through":0,"run":null}),
            "models" => json!({"kind":"ready","choices":[]}),
            "queue" => json!({"revision":0,"entries":[]}),
            "pendingInteractions" => json!({"revision":0,"entries":[]}),
            _ => json!({}),
        };
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let input = call.take_data();
        call.resolve(json!({
            "subscriptionId":input["subscriptionId"],"rootId":"root","generation":1
        }));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        lifecycle: Lifecycle::Active,
        reduce_motion: true,
        ..Environment::default()
    };
    config.environment.network.kind = NetworkKind::Wifi;
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let mut app = Headless::start(config).unwrap();
    let skeleton = "role:progressbar[Loading…]";

    fixture_recv(&mut bootstraps)
        .await
        .resolve(state(1, json!({"status":"connecting"})));
    assert!(app.settle());
    assert!(app.screen().matches("text:Connecting…").unwrap());
    assert!(!app.screen().matches("text:Studio is offline").unwrap());
    assert!(!app.screen().matches("text:No conversations yet").unwrap());
    assert!(!app.screen().matches(skeleton).unwrap());
    app.fast_forward(Duration::from_millis(149)).unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    app.fast_forward(Duration::from_millis(1)).unwrap();
    assert!(app.screen().matches(skeleton).unwrap());

    app.press("label:Pending").unwrap();
    app.wait_for("text:Connecting…").unwrap();
    assert!(!app.screen().matches("text:All caught up").unwrap());
    app.send_host_event(
        "ios.hostState",
        state(
            2,
            json!({"status":"connected","connection":{
                "rootId":"root","hostName":"Studio","generation":1,"endpoints":["agent"]
            }}),
        ),
    )
    .unwrap();
    let pending = fixture_recv(&mut pending_rx).await;
    let chats = fixture_recv(&mut chats_rx).await;
    app.wait_for_gone("text:Connecting…", Duration::from_secs(1))
        .unwrap();
    app.wait_for(skeleton).unwrap();
    assert!(!app.screen().matches("text:All caught up").unwrap());
    pending.resolve(json!({"value":{"revision":"p1","sessions":[],"after":null}}));
    app.wait_for("text:All caught up").unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());

    app.press("label:Chats").unwrap();
    app.wait_for(skeleton).unwrap();
    assert!(!app.screen().matches("text:No conversations yet").unwrap());
    chats.resolve(json!({"value":{"revision":"c1","sessions":[chat],"after":null}}));
    let chat_row = "label:Conversation: Cached chat";
    app.wait_for(chat_row).unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());

    app.press(chat_row).unwrap();
    let (_, abandoned) = fixture_recv(&mut history_rx).await;
    app.fast_forward(Duration::from_millis(70)).unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    app.press("label:Chats").unwrap();
    app.press(chat_row).unwrap();
    let (_, history) = fixture_recv(&mut history_rx).await;
    // Cross the previous visit's deadline, but not the new visit's.
    app.fast_forward(Duration::from_millis(149)).unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    app.fast_forward(Duration::from_millis(1)).unwrap();
    assert!(app.screen().matches(skeleton).unwrap());
    abandoned.resolve(json!({"value":{"kind":"ready","through":0,"before":null,"chunks":[]}}));
    let latest = quote_history_row(
        2,
        "assistant",
        &format!(
            "{}Loaded transcript",
            "A paragraph in the first history page.\n\n".repeat(30)
        ),
    );
    let cursor = history_cursor(&latest);
    history.resolve(history_page(2, vec![latest], cursor.clone()));
    app.wait_for("text:Loaded transcript").unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    assert!(
        !app.screen()
            .layout("text:Loaded transcript")
            .unwrap()
            .unwrap()
            .clipped
    );
    assert!(
        history_rx.try_recv().is_err(),
        "leaving the skeleton auto-paged history"
    );
    app.scroll("id:chat-transcript", px(-1300.)).unwrap();
    let (input, earlier) = fixture_recv(&mut history_rx).await;
    assert_eq!(input["position"], json!({"kind":"before","cursor":cursor}));
    assert_eq!(input["through"], 2);
    assert_eq!(input["view"], "chat");
    earlier.resolve(history_page(
        2,
        vec![quote_history_row(1, "user", "Earlier prompt")],
        Value::Null,
    ));
    app.scroll("id:chat-transcript", px(80.)).unwrap();
    app.scroll("id:chat-transcript", px(-170.)).unwrap();
    app.wait_for("text:Earlier prompt").unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    app.press("label:Chats").unwrap();

    let mut lost = state(3, json!({"status":"offline","autoReconnect":true}));
    lost["disconnectReason"] = json!("Transport closed");
    lost["disconnectedRootId"] = json!("root");
    app.send_host_event("ios.hostState", lost).unwrap();
    app.wait_for("text:Reconnecting…").unwrap();
    app.fast_forward(Duration::from_millis(150)).unwrap();
    assert!(app.screen().matches(chat_row).unwrap());
    assert!(!app.screen().matches(skeleton).unwrap());
    assert!(!app.screen().matches("text:Computer disconnected").unwrap());

    app.press(chat_row).unwrap();
    app.wait_for("text:Reconnecting…").unwrap();
    assert!(!app.screen().matches("text:Studio is offline").unwrap());
    assert!(!app.screen().matches("label:Reconnect").unwrap());
    assert!(!app.screen().matches("label:Message composer").unwrap());
    app.press("label:Chats").unwrap();

    app.press("label:Pending").unwrap();
    app.wait_for("text:Reconnecting…").unwrap();
    app.send_host_event(
        "ios.hostState",
        state(4, json!({"status":"offline","autoReconnect":false})),
    )
    .unwrap();
    app.wait_for("text:Studio is offline").unwrap();
    assert!(!app.screen().matches("text:Reconnecting…").unwrap());
    assert!(!app.screen().matches("text:All caught up").unwrap());
}

#[tokio::test]
async fn cold_reconnect_pauses_loading_in_airplane_mode_and_resumes_when_online() {
    use nsh_core::platform::NetworkKind;

    let host = json!({"rootId":"root","hostName":"Studio","peerId":"peer","endpoints":[]});
    let initial = json!({"revision":1,"hosts":[host],"active":null,
        "connections":{"root":{"status":"offline","autoReconnect":true}}});
    let lost = json!({"revision":2,"hosts":[host],"active":null,
        "disconnectedRootId":"root","disconnectReason":"Transport closed",
        "connections":{"root":{"status":"error","error":"Transport closed","autoReconnect":true}}});
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", move |call| call.resolve(initial.clone()));
    let (dial_tx, mut dial_rx) = mpsc::unbounded_channel();
    channel.handle("ios.connectHost", move |mut call| {
        dial_tx.send((call.take_data(), call)).unwrap();
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment.os = Os::MacOs;
    config.environment.reduce_motion = true;
    config.environment.network.kind = NetworkKind::Wifi;
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let mut app = Headless::start(config).unwrap();
    let skeleton = "role:progressbar[Loading…]";

    app.wait_for("text:Reconnecting…").unwrap();
    assert!(!app.screen().matches("text:Studio is offline").unwrap());
    app.wait_for(skeleton).unwrap();

    app.send_host_event("ios.hostState", lost).unwrap();
    app.press("label:Pending").unwrap();
    app.wait_for(skeleton).unwrap();
    app.set_environment("airplane mode", |env| env.network.kind = NetworkKind::None)
        .unwrap();
    app.wait_for("text:Studio is offline").unwrap();
    app.fast_forward(Duration::from_secs(16)).unwrap();
    assert!(dial_rx.try_recv().is_err());
    assert!(!app.screen().matches("text:Reconnecting…").unwrap());
    assert!(!app.screen().matches(skeleton).unwrap());

    app.press("label:Chats").unwrap();
    app.wait_for("text:Computer disconnected").unwrap();
    app.wait_for("text:Transport closed").unwrap();
    app.wait_for("text:Studio is offline").unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    assert!(app.screen().matches("label:Reconnect").unwrap());

    app.set_environment("Wi-Fi restored", |env| env.network.kind = NetworkKind::Wifi)
        .unwrap();
    app.wait_for("text:Reconnecting…").unwrap();
    app.fast_forward(Duration::from_millis(150)).unwrap();
    let (dial, _in_flight) = fixture_recv(&mut dial_rx).await;
    assert_eq!(dial, json!({"rootId":"root","automatic":true}));
}

#[tokio::test]
async fn catalog_retry_survives_peer_reconnect_and_a_cached_empty_catalog() {
    use nsh_core::platform::NetworkKind;

    let a = json!({"rootId":"a","hostName":"Studio","peerId":"peer-a","endpoints":["agent"]});
    let b = json!({"rootId":"b","hostName":"Backup Mac","peerId":"peer-b","endpoints":[]});
    let initial = json!({
        "revision":1,"hosts":[a,b],"filter":{"kind":"all_computers"},
        "connections":{
            "a":{"status":"connected","connection":{
                "rootId":"a","hostName":"Studio","generation":1,"endpoints":["agent"]
            }},
            "b":{"status":"offline","autoReconnect":true}
        }
    });
    let channel = HostChannel::new();
    let boot = initial.clone();
    channel.handle("ios.bootstrap", move |call| call.resolve(boot.clone()));
    channel.handle("ios.setFilter", |call| call.resolve(Value::Null));
    let (list_tx, mut lists) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let input = call.take_data();
        match input["method"].as_str().unwrap() {
            "list" if input["input"]["filter"] == "all" => {
                list_tx.send((input["rootId"].clone(), call)).unwrap();
            }
            "list" => call.resolve(json!({"value":{"revision":"p1","sessions":[],"after":null}})),
            _ => call.resolve(json!({"value":{}})),
        }
    });
    let (watch_tx, mut watches) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let input = call.take_data();
        if input["method"] == "catalog" && input["input"]["filter"] == "all" {
            watch_tx.send((input, call)).unwrap();
        } else {
            call.resolve(json!({
                "subscriptionId":input["subscriptionId"],"rootId":input["rootId"],"generation":10
            }));
        }
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment.os = Os::MacOs;
    config.environment.reduce_motion = true;
    config.environment.network.kind = NetworkKind::Wifi;
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let mut app = Headless::start(config).unwrap();

    let (watch, open) = fixture_recv(&mut watches).await;
    open.resolve(json!({"subscriptionId":watch["subscriptionId"],"rootId":"a","generation":11}));
    let (_, first) = fixture_recv(&mut lists).await;
    first.reject("Studio catalog unavailable");
    app.wait_for("text:Reconnecting…").unwrap();
    app.wait_for("text:Could not sync chats").unwrap();
    app.wait_for("label:Retry").unwrap();
    assert!(!app.screen().matches("text:No conversations yet").unwrap());

    app.press("label:Backup Mac").unwrap();
    let mut stale = initial.clone();
    stale["revision"] = json!(2);
    stale["filter"] = json!({"kind":"single_computer","root_id":"a"});
    stale["hosts"][1]["hostName"] = json!("Backup renamed");
    app.send_host_event("ios.hostState", stale.clone()).unwrap();
    app.wait_for("label:Backup renamed").unwrap();
    assert!(app.screen().matches("text:Reconnecting…").unwrap());
    assert!(!app.screen().matches("label:Retry").unwrap());

    app.press("label:All").unwrap();
    app.wait_for("text:Reconnecting…").unwrap();
    app.press("label:Retry").unwrap();
    let (root, retry) = fixture_recv(&mut lists).await;
    assert_eq!(root, "a");
    let empty = json!({"value":{"revision":"c1","sessions":[],"after":null}});
    stale["revision"] = json!(3);
    stale["connections"]["b"] = json!({"status":"offline","autoReconnect":false});
    app.send_host_event("ios.hostState", stale.clone()).unwrap();
    retry.resolve(empty.clone());
    app.wait_for("text:No conversations yet").unwrap();

    let mut lost = stale.clone();
    lost["revision"] = json!(4);
    lost["connections"]["a"] = json!({"status":"offline","autoReconnect":false});
    app.send_host_event("ios.hostState", lost).unwrap();
    app.wait_for("text:Studio is offline").unwrap();
    stale["revision"] = json!(5);
    stale["connections"]["a"]["connection"]["generation"] = json!(2);
    app.send_host_event("ios.hostState", stale).unwrap();
    let (_, reopen) = fixture_recv(&mut watches).await;
    reopen.reject("Catalog watch unavailable");
    let (_, refresh) = fixture_recv(&mut lists).await;
    app.wait_for("text:Loading…").unwrap();
    assert!(!app.screen().matches("text:No conversations yet").unwrap());
    refresh.reject("Reconnected catalog unavailable");
    app.wait_for("text:Could not sync chats").unwrap();
    app.wait_for("text:Reconnected catalog unavailable")
        .unwrap();
    assert!(!app.screen().matches("text:No conversations yet").unwrap());
    assert!(!app.screen().matches("role:progressbar[Loading…]").unwrap());

    app.press("label:Retry").unwrap();
    let (watch, reopen) = fixture_recv(&mut watches).await;
    reopen.resolve(json!({"subscriptionId":watch["subscriptionId"],"rootId":"a","generation":12}));
    let (root, retry) = fixture_recv(&mut lists).await;
    assert_eq!(root, "a");
    retry.resolve(empty);
    app.wait_for("text:No conversations yet").unwrap();
    assert!(!app.screen().matches("label:Retry").unwrap());
}

#[tokio::test]
async fn catalog_watch_can_be_repaired_after_a_successful_list_retry() {
    fn page(revision: &str, id: &str, title: &str) -> Value {
        json!({"revision":revision,"after":null,"sessions":[{
            "id":id,"title":title,"kind":"agent","activity":"idle","revision":1
        }]})
    }

    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host =
            json!({"rootId":"root","hostName":"Studio","generation":1,"endpoints":["agent"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let (list_tx, mut lists) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let input = call.take_data();
        match input["method"].as_str().unwrap() {
            "list" if input["input"]["filter"] == "all" => list_tx.send(call).unwrap(),
            "list" => {
                call.resolve(json!({"value":{"revision":"pending","sessions":[],"after":null}}))
            }
            _ => call.resolve(json!({"value":{}})),
        }
    });
    let (watch_tx, mut watches) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let input = call.take_data();
        let handle = json!({
            "subscriptionId":input["subscriptionId"],"rootId":"root","generation":2
        });
        if input["method"] == "catalog" && input["input"]["filter"] == "all" {
            watch_tx.send((handle, call)).unwrap();
        } else {
            call.resolve(handle);
        }
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment.os = Os::MacOs;
    config.environment.reduce_motion = true;
    let mut app = Headless::start(config).unwrap();

    let (_, original_watch) = fixture_recv(&mut watches).await;
    fixture_recv(&mut lists).await.reject("Initial list failed");
    app.wait_for("text:Initial list failed").unwrap();
    app.press("label:Retry").unwrap();
    fixture_recv(&mut lists)
        .await
        .resolve(json!({"value":page("c1", "existing", "Existing chat")}));
    let existing = "label:Conversation: Existing chat";
    app.wait_for(existing).unwrap();
    assert!(!app.screen().matches("label:Retry").unwrap());

    original_watch.reject("Catalog subscription timed out");
    app.wait_for("text:Catalog subscription timed out").unwrap();
    assert!(app.screen().matches(existing).unwrap());
    app.press("label:Retry").unwrap();
    let (handle, repair) = fixture_recv(&mut watches).await;
    repair.resolve(handle.clone());
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "subscriptionId":handle["subscriptionId"],"rootId":"root","generation":handle["generation"],
            "item":page("c2", "new", "Pushed chat")
        }),
    )
    .unwrap();
    app.wait_for("label:Conversation: Pushed chat").unwrap();
    assert!(!app.screen().matches("label:Retry").unwrap());

    let mut ended = handle;
    ended["error"] = json!("Catalog stream closed");
    app.send_host_event("ios.subscriptionEnded", ended).unwrap();
    app.wait_for("text:Catalog stream closed").unwrap();
    assert!(
        app.screen()
            .matches("label:Conversation: Pushed chat")
            .unwrap()
    );
    assert!(app.screen().matches("label:Retry").unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_catalog_watch_unsubscribes_when_setup_replies_late() {
    let host = json!({"rootId":"root","hostName":"Late Host","generation":1,"endpoints":["agent"]});
    let initial = json!({"revision":1,"hosts":[host],"active":host,
        "connections":{"root":{"status":"connected","connection":host}}});
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", move |call| call.resolve(initial.clone()));
    channel.handle("ios.hostQuery", |mut call| {
        let data = call.take_data();
        let value = if data["method"] == "list" {
            json!({"revision":"1","sessions":[],"after":null,"before":null,"needsYouCount":0})
        } else {
            json!({"isBot":false})
        };
        call.resolve(json!({"value":value}));
    });
    let (opening_tx, mut opening_rx) = mpsc::unbounded_channel();
    let sub_generation = std::sync::atomic::AtomicU64::new(2);
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let generation = sub_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let handle = json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":generation});
        if data["input"]["filter"] == "all" {
            opening_tx.send((handle, call)).unwrap();
        } else {
            call.resolve(handle);
        }
    });
    let active = Arc::new(std::sync::Mutex::new(None::<Value>));
    let native = active.clone();
    let (cancel_tx, mut cancel_rx) = mpsc::unbounded_channel();
    channel.handle("ios.unsubscribe", move |mut call| {
        let data = call.take_data();
        let mut native = native.lock().unwrap();
        let cancelled = native.as_ref() == Some(&data);
        if cancelled {
            *native = None;
            cancel_tx.send(data).unwrap();
        }
        call.resolve(json!({"cancelled":cancelled}));
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Search chats or projects").unwrap();
    let (handle, opening) = fixture_recv(&mut opening_rx).await;
    app.send_host_event(
        "ios.hostState",
        json!({"revision":2,"hosts":[host],"active":null,
        "connections":{"root":{"status":"offline","autoReconnect":false}}}),
    )
    .unwrap();
    app.wait_for("text:Late Host is offline").unwrap();

    // If the JS timeout still owns this handshake, it discards the late
    // handle and cannot cancel it. Native, not the app clock, owns the deadline.
    app.fast_forward(Duration::from_secs(31)).unwrap();
    *active.lock().unwrap() = Some(handle.clone());
    opening.resolve(handle.clone());
    assert_eq!(fixture_recv(&mut cancel_rx).await, handle);
    assert!(active.lock().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_pagination_keeps_chats_and_pending_on_the_current_snapshot() {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    fn row(i: usize, title: &str) -> Value {
        json!({
            "id":format!("s-{i}"), "title":title, "kind":"agent", "parentSessionId":null,
            "workspace":{"path":"/repo"}, "labels":[], "revision":1,
            "updatedAt":1700000002000u64 - i as u64,
            "archived":false, "pinned":false, "hasUnread":false, "activity":"waiting"
        })
    }
    fn page(revision: &str, sessions: &[Value], after: Option<&str>) -> Value {
        json!({"revision":revision,"needsYouCount":33,"before":null,"after":after,"sessions":sessions})
    }

    let snapshot = |revision, with_offline_peer| {
        let host = json!({"rootId":"root","hostName":"Paged Host","epoch":"ea","session":"sa",
            "generation":1,"endpoints":["agent"],"transport":"quic"});
        let mut snapshot = json!({"revision":revision,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}});
        if with_offline_peer {
            snapshot["hosts"].as_array_mut().unwrap().push(json!({
                "rootId":"offline","hostName":"Offline peer","peerId":"another-peer","connected":false
            }));
            snapshot["connections"]["offline"] = json!({"status":"offline"});
        }
        snapshot
    };
    let channel = HostChannel::new();
    let initial = snapshot(1, false);
    channel.handle("ios.bootstrap", move |call| call.resolve(initial.clone()));
    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    let sub_generation = AtomicU64::new(2);
    let fail_reopen = Arc::new(AtomicBool::new(false));
    let fail_pending = fail_reopen.clone();
    let generation = Arc::new(AtomicU64::new(1));
    let expected_generation = generation.clone();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        assert_eq!(
            data["generation"],
            expected_generation.load(Ordering::SeqCst),
            "subscribe is pinned to the connection"
        );
        if data["input"]["filter"] == "needs_you" && fail_pending.swap(false, Ordering::SeqCst) {
            call.reject("pending subscription unavailable");
            return;
        }
        let handle = json!({"subscriptionId":data["subscriptionId"],"rootId":"root",
            "generation":sub_generation.fetch_add(1, Ordering::SeqCst)});
        call.resolve(handle.clone());
        sub_tx.send((data, handle)).unwrap();
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });

    let first: Vec<_> = (0..32)
        .map(|i| {
            row(
                i,
                if i == 31 {
                    "Needle moved down"
                } else {
                    "Earlier chat"
                },
            )
        })
        .collect();
    let pending_head = page("pending-live", &first, Some("s-31"));
    let mut chats_head = page("chats-1", &first, Some("s-31"));
    chats_head["sessions"][0]["title"] = json!("Catalog after peer update");
    let chats_head = Arc::new(std::sync::Mutex::new(chats_head));
    let chats_basis = chats_head.clone();
    let pending_basis = Arc::new(std::sync::Mutex::new(page(
        "pending-unavailable",
        &[row(31, "Unavailable review")],
        Some("s-31"),
    )));
    let basis = pending_basis.clone();
    let (bot_tx, mut bot_rx) = mpsc::unbounded_channel();
    let hold_bot_query = AtomicBool::new(true);
    let hold_detail = Arc::new(AtomicBool::new(false));
    let hold = hold_detail.clone();
    let settled = Arc::new(AtomicBool::new(false));
    let is_settled = settled.clone();
    let (page_tx, mut page_rx) = mpsc::unbounded_channel();
    let (detail_tx, mut detail_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        assert_eq!(data["rootId"], "root");
        let input = &data["input"];
        let value = match data["method"].as_str().unwrap() {
            "list" if input["position"]["kind"] == "after" => {
                if matches!(input["position"]["revision"].as_str(), Some("pending-live" | "pending-burst")) {
                    assert_eq!(input["filter"], "needs_you");
                    assert_eq!(input["position"]["cursor"], "s-31");
                    page(input["position"]["revision"].as_str().unwrap(), &[row(32, "Second page review")], None)
                } else {
                    page_tx.send((data, call)).unwrap();
                    return;
                }
            }
            "list" if input["filter"] == "needs_you" => {
                if is_settled.load(Ordering::SeqCst) {
                    page("pending-settled", &[row(32, "Second page review")], None)
                } else {
                    basis.lock().unwrap().clone()
                }
            }
            "list" => chats_basis.lock().unwrap().clone(),
            "botOutbox" if hold_bot_query.swap(false, Ordering::SeqCst) => {
                bot_tx.send(call).unwrap();
                return;
            }
            "botOutbox" => json!({"isBot":true,"through":2,"readThrough":0,"preview":"New bot preview"}),
            "queue" => json!({"revision":0,"entries":[]}),
            "pendingInteractions" => {
                let entry = |id| json!({"requestId":id,"kind":"service_approval","toolUseId":"tu"});
                let entries = if input["sessionId"] == "s-32" {
                    if is_settled.load(Ordering::SeqCst) {
                        vec![entry("extra")]
                    } else {
                        vec![entry("page-two"), entry("extra")]
                    }
                } else {
                    vec![entry("other")]
                };
                let value = json!({"revision":1,"entries":entries});
                if input["sessionId"] == "s-32" && hold.swap(false, Ordering::SeqCst) {
                    detail_tx.send((call, value)).unwrap();
                    return;
                }
                value
            }
            "interaction" => {
                let id = &input["requestId"];
                let page_two = id == "page-two";
                json!({
                    "requestId":id,"createdAt":if page_two { 100 } else { 1 },
                    "outcome":if page_two && is_settled.load(Ordering::SeqCst) {
                        json!(InteractionOutcome::ServiceApprovalDecision { decision: Decision::Deny, committed_at: 101 })
                    } else { Value::Null },
                    "request":{"kind":"service_approval","toolUseId":"tu",
                        "toolName":if page_two { "PageTwoTool" } else { "OtherTool" },
                        "service":"fixture","method":"run","binding":"test","through":1}
                })
            }
            method => panic!("unexpected query {method}"),
        };
        call.resolve(json!({"value":value}));
    });
    let (answer_tx, mut answer_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        answer_tx.send(call.take_data()).unwrap();
        settled.store(true, Ordering::SeqCst);
        call.resolve(json!({"value":{"kind":"recorded","record":{"outcome":
            InteractionOutcome::ServiceApprovalDecision { decision: Decision::Deny, committed_at: 101 }
        }}}));
    });

    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Search chats or projects").unwrap();
    let mut subscriptions = BTreeMap::new();
    for _ in 0..3 {
        let (request, handle) = fixture_recv(&mut sub_rx).await;
        let key = request["input"]["filter"]
            .as_str()
            .unwrap_or_else(|| request["method"].as_str().unwrap());
        subscriptions.insert(key.to_owned(), handle);
    }
    let chats_watch = &subscriptions["all"];
    let pending_watch = &subscriptions["needs_you"];
    let push = |app: &mut Headless, handle: &Value, item: Value| {
        let mut event = handle.clone();
        event["item"] = item;
        app.send_host_event("ios.subscriptionItem", event).unwrap();
    };
    let old_bot = fixture_recv(&mut bot_rx).await;
    push(
        &mut app,
        &subscriptions["watchBotOutbox"],
        json!({"isBot":true,"through":2,"readThrough":0,"preview":"New bot preview"}),
    );
    app.wait_for("text:New bot preview").unwrap();
    old_bot.resolve(
        json!({"value":{"isBot":true,"through":1,"readThrough":0,"preview":"Old bot preview"}}),
    );
    assert!(app.screen().matches("text:New bot preview").unwrap());
    assert!(!app.screen().matches("text:Old bot preview").unwrap());

    let mut first_push = first.clone();
    first_push[0]["title"] = json!("Initial catalog push");
    push(
        &mut app,
        chats_watch,
        page("chats-initial-push", &first_push, Some("s-31")),
    );
    app.wait_for("label:Conversation: Initial catalog push")
        .unwrap();
    // A failed continuation isn't a confirmed empty inbox.
    let (pending_query, pending_failure) = fixture_recv(&mut page_rx).await;
    assert_eq!(
        pending_query["input"]["position"]["revision"],
        "pending-unavailable"
    );
    pending_failure.reject("second page unavailable");
    app.wait_for("text:New bot preview").unwrap();
    assert!(app.settle());
    assert!(app.screen().matches("text:New bot preview").unwrap());
    app.press("label:Pending").unwrap();
    app.wait_for("text:Could not sync Pending").unwrap();
    app.wait_for("text:second page unavailable").unwrap();
    assert!(!app.screen().matches("text:All caught up").unwrap());
    app.press("label:Retry").unwrap();
    let (_, retry_page) = fixture_recv(&mut page_rx).await;
    // R1 travels on the subscription while the continuation is still held.
    // Its single page has no cursor and used to overwrite R2 after the retry.
    let delayed = page("pending-stale-head", &[row(90, "Delayed review")], None);
    push(&mut app, pending_watch, delayed);
    *pending_basis.lock().unwrap() = pending_head.clone();
    hold_detail.store(true, Ordering::SeqCst);
    retry_page.reject("Host rejected call or control request: agent_catalog_changed");
    let (details, value) = fixture_recv(&mut detail_rx).await;
    push(&mut app, pending_watch, pending_head.clone());
    details.resolve(json!({"value":value}));
    app.wait_for("id:main-tab-bar >> text:34").unwrap();
    assert!(app.settle());
    assert!(app.screen().matches("id:main-tab-bar >> text:34").unwrap());

    // While another round is reading request details, coalesce a burst of
    // changes and still publish that round before loading the trailing one.
    let burst = page("pending-burst", &first, Some("s-31"));
    *pending_basis.lock().unwrap() = burst.clone();
    hold_detail.store(true, Ordering::SeqCst);
    push(&mut app, pending_watch, burst.clone());
    let (details, value) = fixture_recv(&mut detail_rx).await;
    push(&mut app, pending_watch, burst);
    push(
        &mut app,
        pending_watch,
        page("pending-intermediate", &first, Some("s-31")),
    );
    let latest = page("pending-latest", &first, Some("s-31"));
    *pending_basis.lock().unwrap() = latest.clone();
    push(&mut app, pending_watch, latest);
    assert!(
        page_rx.try_recv().is_err(),
        "a continuation started while detail was still held"
    );
    details.resolve(json!({"value":value}));
    let (trailing, trailing_page) = fixture_recv(&mut page_rx).await;
    assert_eq!(trailing["input"]["position"]["revision"], "pending-latest");
    app.wait_for("id:main-tab-bar >> text:34").unwrap();
    trailing_page.resolve(json!({"value":page("pending-latest", &[row(32, "Second page review"), row(33, "New review")], None)}));
    app.wait_for("id:main-tab-bar >> text:35").unwrap();
    app.wait_for_gone("text:Could not sync Pending", Duration::from_secs(2))
        .unwrap();

    // Topology effects rerun when another peer is added, not when A's native
    // stream ends. Both original A handles must still deliver after that rerun.
    app.press("label:Chats").unwrap();
    app.send_host_event("ios.hostState", snapshot(2, true))
        .unwrap();
    app.wait_for("label:Offline peer").unwrap();
    let mut chats_after_peer = first.clone();
    chats_after_peer[0]["title"] = json!("Catalog after peer update");
    push(
        &mut app,
        chats_watch,
        page("chats-1", &chats_after_peer, Some("s-31")),
    );
    app.wait_for("label:Conversation: Catalog after peer update")
        .unwrap();
    let after_peer = page("pending-after-peer", &[row(32, "Second page review")], None);
    *pending_basis.lock().unwrap() = after_peer.clone();
    push(&mut app, pending_watch, after_peer);
    app.wait_for("id:main-tab-bar >> text:2").unwrap();
    app.press("label:Pending").unwrap();
    *pending_basis.lock().unwrap() = pending_head.clone();
    // An unexpected end is visible and retry attaches a fresh subscription.
    app.send_host_event("ios.subscriptionEnded", pending_watch.clone())
        .unwrap();
    app.wait_for("text:Could not sync Pending").unwrap();
    fail_reopen.store(true, Ordering::SeqCst);
    app.press("label:Retry").unwrap();
    app.wait_for("text:pending subscription unavailable")
        .unwrap();
    app.press("label:Retry").unwrap();
    let (_, replacement) = fixture_recv(&mut sub_rx).await;
    assert_ne!(replacement["generation"], pending_watch["generation"]);
    app.wait_for("id:main-tab-bar >> text:34").unwrap();
    let pending_current = page("pending-current", &[row(32, "Second page review")], None);
    *pending_basis.lock().unwrap() = pending_current.clone();
    push(&mut app, pending_watch, page("stale-watch", &[], None));
    let mut wrong_generation = replacement.clone();
    wrong_generation["generation"] = json!(1);
    push(
        &mut app,
        &wrong_generation,
        page("wrong-generation", &[], None),
    );
    assert!(app.settle());
    assert!(app.screen().matches("id:main-tab-bar >> text:34").unwrap());
    push(&mut app, &replacement, pending_current);
    app.wait_for("id:main-tab-bar >> text:2").unwrap();

    app.press("label:Chats").unwrap();
    let mut wrong_generation = chats_watch.clone();
    wrong_generation["generation"] = json!(1);
    push(
        &mut app,
        &wrong_generation,
        page("wrong-generation", &[row(80, "Wrong chat")], None),
    );
    assert!(app.settle());
    assert!(!app.screen().matches("text:Wrong chat").unwrap());
    assert!(
        !app.screen().matches("label:Load more chats").unwrap(),
        "a scrollable catalog showed a manual pager before any filter"
    );
    app.type_text("label:Search chats or projects", "Needle moved up")
        .unwrap();
    app.wait_for("text:No matches in loaded chats").unwrap();
    assert!(page_rx.try_recv().is_err(), "Chats must not auto-drain");
    app.press("label:Load more chats").unwrap();
    let (failed_query, failed_reply) = fixture_recv(&mut page_rx).await;
    assert_eq!(failed_query["input"]["position"]["revision"], "chats-1");
    failed_reply.reject("chat second page unavailable");
    app.wait_for("text:chat second page unavailable").unwrap();
    app.wait_for("id:chat-catalog >> label:Retry").unwrap();
    let mut pushed_head = page("chats-after-error", &first, Some("s-31"));
    pushed_head["sessions"][0]["title"] = json!("New head after failure");
    *chats_head.lock().unwrap() = pushed_head.clone();
    push(&mut app, chats_watch, pushed_head);
    assert!(app.settle());
    app.wait_for("text:Could not sync chats").unwrap();
    app.wait_for("text:chat second page unavailable").unwrap();
    assert!(
        page_rx.try_recv().is_err(),
        "push retried the failed extension"
    );
    app.press("label:Clear search").unwrap();
    app.wait_for("label:Conversation: New head after failure")
        .unwrap();
    app.scroll("id:chat-catalog", px(2800.)).unwrap();
    assert!(page_rx.try_recv().is_err(), "scroll retried a failed page");
    app.type_text("label:Search chats or projects", "Needle moved up")
        .unwrap();
    app.wait_for("text:No matches in loaded chats").unwrap();
    app.press("id:chat-catalog >> label:Retry").unwrap();
    let (retry_query, retry_reply) = fixture_recv(&mut page_rx).await;
    assert_eq!(
        retry_query["input"]["position"],
        json!({"kind":"after","revision":"chats-after-error","cursor":"s-31"})
    );
    retry_reply.resolve(
        json!({"value":page("chats-after-error", &[row(32, "Needle moved up")], Some("s-32"))}),
    );
    app.wait_for("label:Conversation: Needle moved up").unwrap();

    // Swap rows across the boundary while a further page is outstanding.
    assert_eq!(
        app.screen()
            .input_text("label:Search chats or projects")
            .unwrap()
            .as_deref(),
        Some("Needle moved up")
    );
    app.press("label:Clear search").unwrap();
    app.scroll("id:chat-catalog", px(700.)).unwrap();
    assert!(page_rx.try_recv().is_err());
    app.wheel(
        "id:chat-catalog",
        nsh_core::geometry::point(px(0.), px(2200.)),
    )
    .unwrap();
    let (old_query, old_reply) = fixture_recv(&mut page_rx).await;
    assert_eq!(
        old_query["input"]["position"],
        json!({"kind":"after","revision":"chats-after-error","cursor":"s-32"})
    );
    let mut new_head = first[..31].to_vec();
    new_head.push(row(32, "Needle moved up in live catalog"));
    push(
        &mut app,
        chats_watch,
        page("chats-2", &new_head, Some("s-32")),
    );
    let (new_query, new_reply) = tokio::time::timeout(Duration::from_secs(2), page_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        new_query["input"]["position"],
        json!({"kind":"after","revision":"chats-2","cursor":"s-32"})
    );
    new_reply.resolve(json!({"value":page("chats-2", &[row(31, "Needle moved down"), row(33, "Newest chat")], None)}));
    app.wait_for("label:Conversation: Needle moved up in live catalog")
        .unwrap();
    old_reply.resolve(json!({"value":page("chats-after-error", &[row(33, "Needle stale")], None)}));
    assert!(app.settle());
    app.type_text("label:Search chats or projects", "Needle")
        .unwrap();
    app.wait_for("text:Needle moved down").unwrap();
    for label in ["Needle moved up in live catalog", "Needle moved down"] {
        assert_eq!(
            app.screen()
                .count(&format!("label:Conversation: {label}"))
                .unwrap(),
            1
        );
    }
    assert!(!app.screen().matches("text:Needle stale").unwrap());
    assert!(
        !app.screen()
            .matches("id:chat-catalog >> label:Retry")
            .unwrap()
    );

    *chats_head.lock().unwrap() = page("chats-1", &chats_after_peer, Some("s-31"));
    app.press("label:Pending").unwrap();
    app.wait_for("text:Allow service call PageTwoTool?")
        .unwrap();
    app.press("text:Allow service call PageTwoTool?").unwrap();
    app.press("label:Deny").unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(2), answer_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(answer["method"], "respond");
    assert_eq!(answer["input"]["sessionId"], "s-32");
    assert_eq!(answer["input"]["requestId"], "page-two");
    assert_eq!(answer["input"]["answer"]["decision"], "deny");
    app.wait_for("text:Denied").unwrap();
    app.press("label:Pending").unwrap();
    app.wait_for("id:main-tab-bar >> text:1").unwrap();

    app.press("label:Chats").unwrap();
    // Keep the completed window, not the in-flight continuation from the old connection.
    push(
        &mut app,
        chats_watch,
        page("chats-1", &chats_after_peer, Some("s-31")),
    );
    let (_, interrupted) = fixture_recv(&mut page_rx).await;
    let mut offline = snapshot(3, true);
    offline["active"] = Value::Null;
    offline["connections"]["root"] = json!({"status":"offline","autoReconnect":false});
    app.send_host_event("ios.hostState", offline).unwrap();
    app.wait_for_gone("label:Loading…", Duration::from_secs(2))
        .unwrap();
    app.wait_for("label:Conversation: Needle moved up in live catalog")
        .unwrap();

    // The new connection can report the same revision as the interrupted read.
    let mut reconnected = snapshot(4, true);
    reconnected["active"]["generation"] = json!(2);
    reconnected["connections"]["root"]["connection"]["generation"] = json!(2);
    generation.store(2, Ordering::SeqCst);
    app.send_host_event("ios.hostState", reconnected).unwrap();
    for _ in 0..3 {
        fixture_recv(&mut sub_rx).await;
    }
    let (continuation, resumed) = fixture_recv(&mut page_rx).await;
    assert_eq!(
        continuation["input"]["position"],
        json!({"kind":"after","revision":"chats-1","cursor":"s-31"})
    );
    resumed.resolve(json!({"value":page("chats-1", &[row(32, "Needle after reconnect")], None)}));
    interrupted
        .resolve(json!({"value":page("chats-1", &[row(32, "Needle from old connection")], None)}));
    app.wait_for("label:Conversation: Needle after reconnect")
        .unwrap();
    assert!(
        !app.screen()
            .matches("text:Needle from old connection")
            .unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_refresh_preserves_a_failed_catalog_extension_until_retry() {
    let host_state = |revision, connection: Value| {
        json!({"revision":revision,"hosts":[{"rootId":"root","hostName":"Studio","endpoints":["agent"]}],
            "active":connection["connection"],"connections":{"root":connection}})
    };
    let online = |generation| {
        json!({"status":"connected","connection":{
            "rootId":"root","hostName":"Studio","generation":generation,"endpoints":["agent"]
        }})
    };
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", move |call| {
        call.resolve(host_state(1, online(1)))
    });
    let (catalog, mut requests) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let input = &data["input"];
        match data["method"].as_str().unwrap() {
            "list" if input["filter"] == "all" => catalog.send((input.clone(), call)).unwrap(),
            "list" => {
                call.resolve(json!({"value":{"revision":"pending","sessions":[],"after":null}}))
            }
            "botOutbox" => call.resolve(json!({"value":{"isBot":false}})),
            method => panic!("unexpected query {method}"),
        };
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":data["generation"]}));
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment.os = Os::MacOs;
    config.environment.reduce_motion = true;
    let mut app = Headless::start(config).unwrap();
    let page = |revision, id, title, after: Option<&str>| {
        json!({"value":{
            "revision":revision, "after":after, "sessions":[{
                "id":id,"title":title,"kind":"agent","activity":"idle","revision":1
            }]
        }})
    };
    let (input, head) = fixture_recv(&mut requests).await;
    assert_eq!(input["position"]["kind"], "start");
    head.resolve(page("before", "cached", "Cached chat", Some("cached")));
    app.wait_for("label:Conversation: Cached chat").unwrap();
    app.press("label:Load more chats").unwrap();
    let (input, extension) = fixture_recv(&mut requests).await;
    assert_eq!(input["position"]["cursor"], "cached");
    extension.reject("Could not read second page");
    app.wait_for("text:Could not read second page").unwrap();

    app.send_host_event(
        "ios.hostState",
        host_state(2, json!({"status":"offline","autoReconnect":false})),
    )
    .unwrap();
    app.wait_for_gone("label:Retry", Duration::from_secs(2))
        .unwrap();
    assert!(
        app.screen()
            .matches("label:Conversation: Cached chat")
            .unwrap()
    );
    app.send_host_event("ios.hostState", host_state(3, online(2)))
        .unwrap();
    let (input, refreshed) = fixture_recv(&mut requests).await;
    assert_eq!(input["position"]["kind"], "start");
    let head = page("reconnected", "updated", "Refreshed chat", Some("updated"));
    refreshed.resolve(head.clone());
    app.wait_for("label:Conversation: Refreshed chat").unwrap();
    app.wait_for("text:Could not read second page").unwrap();
    assert!(app.settle());
    assert!(
        requests.try_recv().is_err(),
        "reconnect retried an uncommitted page"
    );

    app.press("label:Retry").unwrap();
    let (_, retry) = fixture_recv(&mut requests).await;
    retry.resolve(head);
    let (input, extension) = fixture_recv(&mut requests).await;
    assert_eq!(
        input["position"],
        json!({"kind":"after","revision":"reconnected","cursor":"updated"})
    );
    extension.resolve(page("reconnected", "next", "Second page", None));
    app.wait_for("label:Conversation: Second page").unwrap();
    assert!(!app.screen().matches("label:Retry").unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_chats_can_page_a_healthy_catalog_while_another_needs_retry() {
    fn row(id: &str, title: &str) -> Value {
        json!({"id":id,"title":title,"kind":"agent","activity":"idle","revision":1})
    }
    fn page(revision: &str, sessions: Vec<Value>, after: Option<&str>) -> Value {
        json!({"value":{"revision":revision,"sessions":sessions,"after":after}})
    }

    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let a = json!({"rootId":"a","hostName":"Studio","generation":1,"endpoints":["agent"]});
        let b = json!({"rootId":"b","hostName":"Laptop","generation":1,"endpoints":["agent"]});
        call.resolve(json!({"revision":1,"hosts":[a,b],"filter":{"kind":"all_computers"},"active":a,
            "connections":{"a":{"status":"connected","connection":a},"b":{"status":"connected","connection":b}}}));
    });
    let (pages, mut requests) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let query = call.take_data();
        let root = &query["rootId"];
        let input = &query["input"];
        match query["method"].as_str().unwrap() {
            "list" if input["filter"] == "needs_you" => call.resolve(page("pending", vec![], None)),
            "list" => pages
                .send((root.clone(), input["position"].clone(), call))
                .unwrap(),
            "botOutbox" => call.resolve(json!({"value":{"isBot":false}})),
            method => panic!("unexpected query {method}"),
        }
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":data["rootId"],"subscriptionId":data["subscriptionId"],"generation":1}),
        );
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment.os = Os::MacOs;
    config.environment.reduce_motion = true;
    let mut app = Headless::start(config).unwrap();
    for _ in 0..2 {
        let (root, position, reply) = fixture_recv(&mut requests).await;
        assert_eq!(position, json!({"kind":"start"}));
        let root = root.as_str().unwrap();
        reply.resolve(page(
            root,
            vec![row("first", &format!("First {root}"))],
            Some("first"),
        ));
    }
    app.wait_for("label:Conversation: First a").unwrap();
    app.wait_for("label:Conversation: First b").unwrap();
    app.press("label:Load more chats").unwrap();
    let mut roots = Vec::new();
    for _ in 0..2 {
        let (root, position, reply) = fixture_recv(&mut requests).await;
        assert_eq!(
            position,
            json!({"kind":"after","revision":root,"cursor":"first"})
        );
        if root == "a" {
            let rows = (0..24)
                .map(|n| row(&format!("chat-{n}"), &format!("Studio chat {n}")))
                .collect();
            reply.resolve(page("a", rows, Some("chat-23")));
        } else {
            assert_eq!(root, "b");
            reply.reject("Laptop second page unavailable");
        }
        roots.push(root);
    }
    assert_ne!(roots[0], roots[1]);
    app.wait_for("text:Laptop second page unavailable").unwrap();
    app.wait_for("label:Retry").unwrap();
    app.wait_for("label:Conversation: Studio chat 0").unwrap();
    assert!(!app.screen().matches("label:Load more chats").unwrap());
    app.scroll("id:chat-catalog", px(2800.)).unwrap();
    let (root, position, reply) = fixture_recv(&mut requests).await;
    assert_eq!(root, "a");
    assert_eq!(
        position,
        json!({"kind":"after","revision":"a","cursor":"chat-23"})
    );
    reply.resolve(page(
        "a",
        vec![row("scroll", "Found by scrolling")],
        Some("scroll"),
    ));
    app.wait_for("label:Conversation: Found by scrolling")
        .unwrap();

    app.type_text("label:Search chats or projects", "Only in the next page")
        .unwrap();
    app.wait_for("text:No matches in loaded chats").unwrap();
    app.press("label:Load more chats").unwrap();
    let (root, position, reply) = fixture_recv(&mut requests).await;
    assert_eq!(root, "a");
    assert_eq!(
        position,
        json!({"kind":"after","revision":"a","cursor":"scroll"})
    );
    reply.resolve(page("a", vec![row("match", "Only in the next page")], None));
    app.wait_for("label:Conversation: Only in the next page")
        .unwrap();
    assert!(app.screen().matches("label:Retry").unwrap());
    assert!(app.settle());
    assert!(
        requests.try_recv().is_err(),
        "paging retried the failed laptop window"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_catalog_barely_taller_than_the_viewport_pages_without_dragging() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host = json!({"rootId":"root","hostName":"Host","generation":1,"endpoints":["agent"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let (pages, mut requests) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let input = &data["input"];
        let value = match data["method"].as_str().unwrap() {
            "list" if input["filter"] == "needs_you" => {
                json!({"revision":"pending","sessions":[],"after":null,"needsYouCount":0})
            }
            "list" if input["position"]["kind"] == "after" => {
                pages.send((input.clone(), call)).unwrap();
                return;
            }
            "list" => {
                let rows: Vec<_> = (0..15)
                    .map(|n| {
                        json!({
                            "id":format!("chat-{n}"),"title":format!("Seed chat {n}"),
                            "kind":"agent","revision":1,"workspace":{"path":"/work"},
                            "activity":"idle","updatedAt":1700000000000u64+n
                        })
                    })
                    .collect();
                json!({"revision":"catalog","sessions":rows,"after":"chat-0","needsYouCount":0})
            }
            "botOutbox" => json!({"isBot":false}),
            method => panic!("unexpected query {method}"),
        };
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":1}),
        );
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(640.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Conversation: Seed chat 14").unwrap();
    assert!(app.settle());
    let overflow = |app: &Headless| {
        let scroll = app
            .screen()
            .layout_nodes()
            .into_iter()
            .find(|node| node.test_id.as_deref() == Some("chat-catalog"))
            .unwrap();
        scroll.scroll.unwrap().content_size.unwrap().height.0 - scroll.bounds.size.height.0
    };
    let size = 640. + overflow(&app) - 100.;
    let wheel = |app: &mut Headless, dy| {
        app.wheel("id:chat-catalog", nsh_core::geometry::point(px(0.), px(dy)))
            .unwrap();
    };
    wheel(&mut app, 15.);
    wheel(&mut app, -15.);
    app.set_viewport(Size::new(px(390.), px(size))).unwrap();
    assert!(app.settle());
    let extra = overflow(&app);
    assert!(
        extra > 1. && extra <= 160.,
        "fixture must barely overflow: {extra}"
    );
    assert!(!app.shows("label:Load more chats"));
    assert!(requests.try_recv().is_err());
    wheel(&mut app, extra + 20.);
    let (input, page) = fixture_recv(&mut requests).await;
    assert_eq!(
        input["position"],
        json!({"kind":"after","revision":"catalog","cursor":"chat-0"})
    );
    page.resolve(json!({"value":{"revision":"catalog","after":null,"sessions":[
        {"id":"next","title":"Found by wheel","kind":"agent","revision":1,"activity":"idle","updatedAt":1}
    ]}}));
    app.wait_for("label:Conversation: Found by wheel").unwrap();
    assert!(requests.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_streaming_collapsible_tools_and_inline_approval() {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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
    let settled = Arc::new(AtomicBool::new(false));
    let is_settled = settled.clone();
    let (inbox_tx, mut inbox_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let method = data["method"].as_str().unwrap();
        let resolved = is_settled.load(Ordering::SeqCst);
        let value = match method {
            "list" if resolved && data["input"]["filter"] == "needs_you" => {
                inbox_tx.send(call).unwrap();
                return;
            }
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
                    { "field": "body", "position": { "kind": "live", "sequence": 3, "fact": "00000000-0000-4000-8000-000000000003", "itemIndex": 0 }, "order": { "path": [3], "itemIndex": 0 }, "offset": 0, "messageId": "m2", "turnId": "t0", "timestamp": 3, "role": "assistant", "text": "", "tool": { "toolUseId": "tu1", "call":{"name":"Shell","title":{"fallback":"Test OAuth","translations":{"en":"Verify OAuth"}}},"result":{"isError":true} } },
                    { "field": "body", "position": { "kind": "live", "sequence": 4, "fact": "00000000-0000-4000-8000-000000000004", "itemIndex": 0 }, "order": { "path": [4], "itemIndex": 0 }, "offset": 0, "messageId": "m2", "turnId": "t0", "timestamp": 4, "role": "assistant", "text": "Updated refresh window to 60 seconds." }
                ]
            }),
            "models" => json!({ "kind": "ready", "choices": [{ "selection": { "kind": "model", "modelId": "claude-sonnet", "thinkingLevel": "high" }, "label": "Claude Sonnet · High", "sourceName": "anthropic", "thinkingLevels": ["high"], "defaultThinkingLevel": "high" }] }),
            "pendingInteractions" if resolved => json!({"revision":2,"entries":[]}),
            "queue" => json!({"revision":0,"entries":[]}),
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
    let sub_generation = AtomicU64::new(2);
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        assert_eq!(data["generation"], 1);
        let generation = sub_generation.fetch_add(1, Ordering::SeqCst);
        let handle = json!({"subscriptionId":data["subscriptionId"],"rootId":"root-a","generation":generation});
        if data["method"] == "watch" {
            watch_tx.send((handle, call)).unwrap();
        } else {
            call.resolve(handle);
        }
    });
    channel.handle("ios.unsubscribe", |call| {
        call.reply(Ok(json!({ "cancelled": true })));
    });
    let (send_tx, mut send_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let value = if data["method"] == "respond" {
            settled.store(true, Ordering::SeqCst);
            json!({"kind":"recorded","record":{"outcome":
                InteractionOutcome::ServiceApprovalDecision { decision: Decision::Deny, committed_at: 1 }
            }})
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
    app.wait_for("id:main-tab-bar >> text:1").unwrap();
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

    // Stream live Markdown preview over watch subscription.
    let (watch_handle, open_watch) = fixture_recv(&mut watch_rx).await;
    let watch_sub_id = &watch_handle["subscriptionId"];
    let generation = &watch_handle["generation"];
    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId": watch_sub_id,
        "rootId": "root-a",
        "generation": generation,
        "item": {
            "kind": "preview",
            "page": {
                "kind": "cut", "hostEpoch": "ea", "runId": "run-1", "turnId": "t1", "stepId": "s1", "attemptId": "a1",
                "revision": 1, "dependsOn": 0, "first": true, "last": false,
                "parts": [{ "ordinal": 0, "messageId": "m3", "providerPartId": null, "startedAt": 1, "field": { "kind": "text", "textKind": "text" }, "offset": 0, "totalBytes": 30, "text": "Streaming live verification..." }]
            }
        }
    })).unwrap();
    // Simulate JS receiving the first item before the subscribe promise runs.
    open_watch.resolve(watch_handle.clone());
    app.wait_for("text:Streaming live verification...").unwrap();

    // With the keyboard up, the approval at the tail still clears the
    // measured composer and can be tapped.
    app.set_environment("software keyboard shown", |env| {
        env.keyboard_height = px(330.)
    })
    .unwrap();
    app.wheel("id:chat-context", nsh_core::Point::new(px(0.), px(-450.)))
        .unwrap();
    let jump = app
        .screen()
        .layout("label:Scroll to latest")
        .unwrap()
        .unwrap()
        .bounds;
    let transcript = app
        .screen()
        .layout("id:chat-transcript")
        .unwrap()
        .unwrap()
        .bounds;
    assert_eq!(jump.size.width, jump.size.height);
    assert!((jump.center().x - transcript.center().x).0.abs() <= 1.);
    app.press("label:Scroll to latest").unwrap();
    let approval = app.screen().layout("label:Deny").unwrap().unwrap();
    let composer = app.screen().layout("id:chat-composer").unwrap().unwrap();
    assert!(
        !approval.clipped
            && approval.bounds.origin.y + approval.bounds.size.height <= composer.bounds.origin.y
    );
    assert!(!app.screen().matches("label:Scroll to latest").unwrap());
    app.press("label:Deny").unwrap();
    let answered = fixture_recv(&mut send_rx).await;
    assert_eq!(answered["method"], "respond");
    assert_eq!(answered["input"]["requestId"], "perm-1");
    let held_refresh = fixture_recv(&mut inbox_rx).await;
    app.press("label:Chats").unwrap();
    app.wait_for("id:main-tab-bar").unwrap();
    assert!(!app.screen().matches("id:main-tab-bar >> text:1").unwrap());
    held_refresh.resolve(json!({"value":{"revision":"2","needsYouCount":0,"before":null,"after":null,"sessions":[]}}));
}

fn more_menu_action<'a>(
    config: &'a nsh_core::ScreenConfig,
    label: &str,
) -> Option<&'a nsh_core::desktop::MenuAction> {
    let more = config
        .right_items
        .iter()
        .find(|item| item.key.as_deref() == Some("more"))?;
    more.menu.as_ref()?.iter().find_map(|item| match item {
        nsh_core::desktop::MenuItem::Action(action) if action.label == label => Some(action),
        _ => None,
    })
}

fn select_header_item(app: &mut Headless, id: u32) {
    app.engine().control().dispatch_event(
        nsh_core::ROOT_ID,
        nsh_core::EventKind::Menu,
        nsh_core::EventPayload::Map(vec![("id", nsh_core::PayloadValue::Number(f64::from(id)))]),
    );
    assert!(app.settle());
}

struct ComposerDockFixture {
    app: Headless,
    header: Arc<std::sync::Mutex<Option<nsh_core::ScreenConfig>>>,
    menus: mpsc::UnboundedReceiver<(String, (nsh_core::NodeId, Value))>,
    run: Arc<std::sync::Mutex<Value>>,
    observation: Arc<std::sync::Mutex<Value>>,
    observes: Arc<std::sync::atomic::AtomicUsize>,
    queue: Arc<std::sync::Mutex<Value>>,
    history: Arc<std::sync::Mutex<Vec<Value>>>,
    calls: mpsc::UnboundedReceiver<(Value, HostCall)>,
    watches: mpsc::UnboundedReceiver<Value>,
    goal_watches: mpsc::UnboundedReceiver<Value>,
    watch: Value,
    history_reads: mpsc::UnboundedReceiver<()>,
    hold_queue: Arc<std::sync::atomic::AtomicBool>,
    hold_history: Arc<std::sync::atomic::AtomicBool>,
    hold_observe: Arc<std::sync::atomic::AtomicBool>,
}

const DOCK_RUN_ID: &str = "a91a2b3c-0000-4000-8000-000000000001";

fn dock_host(generation: u64) -> Value {
    let host = json!({"rootId":"root","hostName":"Host","generation":generation,"endpoints":["agent","settings"]});
    json!({"revision":generation,"hosts":[host],"active":host,
        "connections":{"root":{"status":"connected","connection":host}}})
}

impl ComposerDockFixture {
    async fn start(run: Value, backend: Value, queue: Value) -> Self {
        Self::start_with_anchor(run, backend, queue, false).await
    }

    async fn start_with_anchor(run: Value, backend: Value, queue: Value, anchor: bool) -> Self {
        Self::start_chat(run, backend, queue, anchor, false).await
    }

    async fn start_room() -> Self {
        Self::start_chat(Value::Null, Value::Null, empty_queue(), false, true).await
    }

    async fn start_chat(
        run: Value,
        backend: Value,
        queue: Value,
        anchor: bool,
        room: bool,
    ) -> Self {
        let channel = HostChannel::new();
        channel.handle("ios.bootstrap", |call| call.resolve(dock_host(1)));
        let run = Arc::new(std::sync::Mutex::new(run));
        let observation = Arc::new(std::sync::Mutex::new(json!({})));
        let observes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (observation_q, observes_q) = (observation.clone(), observes.clone());
        let queue = Arc::new(std::sync::Mutex::new(queue));
        let mut answer = quote_history_row(1, "assistant", "An earlier answer");
        answer["finalOutput"] = json!(anchor);
        let mut side = side_session("saved", "Saved side question", &backend);
        side["branch"]["sessionId"] = json!("chat");
        side["branch"]["position"]["position"] = answer["position"].clone();
        let side_on_watch = side.clone();
        let history = Arc::new(std::sync::Mutex::new(if room {
            vec![]
        } else {
            vec![answer]
        }));
        let hold_queue = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hold_queue_read = hold_queue.clone();
        let hold_history = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hold_tail = hold_history.clone();
        let hold_observe = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hold_observation = hold_observe.clone();
        let (run_q, queue_q, history_q) = (run.clone(), queue.clone(), history.clone());
        let (tx, calls) = mpsc::unbounded_channel();
        let query_tx = tx.clone();
        let (history_tx, mut history_reads) = mpsc::unbounded_channel();
        channel.handle("ios.hostQuery", move |mut call| {
            let data = call.take_data();
            let session = json!({"id":"chat","kind":if room { "room" } else { "agent" },"title":"Dock Chat","revision":1,
                "workspace":{"path":"/work"},"backend":backend,"updatedAt":1,"activity":"working"});
            let value = match data["method"].as_str().unwrap() {
                "list" if data["input"]["scope"]["kind"] == "side_questions" =>
                    json!({"revision":"side","sessions":if anchor { vec![side.clone()] } else { vec![] },"needsYouCount":0}),
                "list" => json!({"revision":"list","sessions":[session],"needsYouCount":0}),
                "observe" if data["input"]["sessionId"] == "saved" =>
                    json!({"session":side,"through":1,"run":null}),
                "observe" => {
                    observes_q.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if hold_observation.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        query_tx.send((data, call)).unwrap();
                        return;
                    }
                    let mut obs = json!({"session":session,"through":1,"run":*run_q.lock().unwrap()});
                    for (key, value) in observation_q.lock().unwrap().as_object().unwrap() {
                        obs[key] = value.clone();
                    }
                    obs
                },
                "history" if hold_tail.swap(false, std::sync::atomic::Ordering::SeqCst) => {
                    query_tx.send((data, call)).unwrap();
                    return;
                }
                "history" if room => {
                    let rows = history_q.lock().unwrap();
                    let through = rows.last().and_then(|row| row["sequence"].as_u64()).unwrap_or(0);
                    call.resolve(json!({"value":{"kind":"room","page":{"items":*rows,"through":through,
                        "before":null,"after":null}}}));
                    history_tx.send(()).unwrap();
                    return;
                }
                "history" => {
                    let rows = history_q.lock().unwrap();
                    let through = rows.last().unwrap()["position"]["sequence"].clone();
                    let before = (rows[0]["position"]["sequence"].as_u64().unwrap() > 1)
                        .then(|| history_cursor(&rows[0]));
                    let page = json!({"kind":"ready","through":through,
                        "chunks":*rows,"before":before,"after":null});
                    call.resolve(json!({"value":page}));
                    history_tx.send(()).unwrap();
                    return;
                }
                "queue" if hold_queue_read.swap(false, std::sync::atomic::Ordering::SeqCst) => {
                    query_tx.send((data, call)).unwrap();
                    return;
                }
                "queue" => queue_q.lock().unwrap().clone(),
                "pendingInteractions" => json!({"revision":1,"entries":[]}),
                "models" => json!({"kind":"ready","choices":[
                    {"label":"Dock model","selection":dock_model(),"sourceName":"Test",
                        "thinkingLevels":["off","minimal","high"],"defaultThinkingLevel":"high"},
                    {"label":"Alternate thinker","selection":{"kind":"model","connectionId":"test","modelId":"alternate"},
                        "sourceName":"Test","thinkingLevels":["low","high"]},
                    {"label":"High-only model","selection":{"kind":"model","connectionId":"test","modelId":"high-only"},
                        "sourceName":"Test","thinkingLevels":["high"]},
                    {"label":"Other model","selection":{"kind":"model","connectionId":"other","modelId":"other"},"sourceName":"Other",
                        "thinkingLevels":[]},
                    {"label":"Executor","selection":{"kind":"executor","selection":{"executor":"codex","settings":{"runtime":"cli","model":"external"}}},"sourceName":"Codex",
                        "thinkingLevels":[]},
                    {"label":"Opus","sourceName":"Codex","selection":{"kind":"executor",
                        "selection":{"executor":"codex","settings":{"runtime":"cli","model":"opus"}}},
                        "aliases":[{"kind":"executor","selection":{"executor":"codex",
                            "settings":{"runtime":"cli","model":"opus-high","thinkingLevel":"high"}}}],
                        "thinkingLevels":["low","high"]}
                ]}),
                "botOutbox" => json!({"isBot":false}),
                "connections" => json!({"kind":"ready","revision":1,"connections":[],"next":null,
                    "defaultTarget":{"connectionId":"test","modelId":"model"}}),
                "queueMessage" | "resolveModel" | "execution" | "continuationAvailability" | "model" | "goal" => {
                    query_tx.send((data, call)).unwrap();
                    return;
                }
                method => panic!("unexpected query {method}"),
            };
            call.resolve(json!({"value":value}));
        });
        channel.handle("ios.ackMutationProgress", |call| call.resolve(Value::Null));
        channel.handle("ios.hostMutate", move |mut call| {
            let data = call.take_data();
            tx.send((data, call)).unwrap();
        });
        let (watch_tx, mut watches) = mpsc::unbounded_channel();
        let (goal_tx, goal_watches) = mpsc::unbounded_channel();
        let (side_tx, mut side_watch) = mpsc::unbounded_channel();
        channel.handle("ios.subscribe", move |mut call| {
            let data = call.take_data();
            let handle = json!({"subscriptionId":data["subscriptionId"],"rootId":"root",
                "generation":data["generation"].as_u64().unwrap()+10});
            call.resolve(handle.clone());
            if data["method"] == "watch" {
                watch_tx.send(handle).unwrap();
            } else if data["method"] == "watchGoal" {
                goal_tx.send(handle).unwrap();
            } else if anchor && data["input"]["scope"]["kind"] == "side_questions" {
                side_tx.send((handle, side_on_watch.clone())).unwrap();
            }
        });
        channel.handle("ios.unsubscribe", |call| {
            call.resolve(json!({"cancelled":true}))
        });
        let mut config = engine_config(channel, tokio::runtime::Handle::current());
        config.viewport = Size::new(px(390.), px(844.));
        config.environment = Environment {
            os: Os::Ios,
            reduce_motion: true,
            ..Environment::default()
        };
        let mut app = Headless::start(config).unwrap();
        let header = Arc::new(std::sync::Mutex::new(None));
        let mounted = header.clone();
        let menus = native_menu_items(&mut app, move |item| {
            if let nsh_core::MountItem::ScreenConfig { config, .. } = item
                && config.title.as_deref() == Some("Dock Chat")
            {
                *mounted.lock().unwrap() = Some((**config).clone());
            }
        });
        app.wait_for("label:Conversation: Dock Chat").unwrap();
        app.press("label:Conversation: Dock Chat").unwrap();
        if !room {
            app.wait_for("text:An earlier answer").unwrap();
        }
        let watch = fixture_recv(&mut watches).await;
        if anchor {
            let (handle, side) = fixture_recv(&mut side_watch).await;
            app.send_host_event(
                "ios.subscriptionItem",
                json!({
                    "subscriptionId":handle["subscriptionId"],"rootId":"root",
                    "generation":handle["generation"],
                    "item":{"revision":"side","sessions":[side],"needsYouCount":0}
                }),
            )
            .unwrap();
        }
        while history_reads.try_recv().is_ok() {}
        Self {
            app,
            header,
            menus,
            run,
            observation,
            observes,
            queue,
            history,
            calls,
            watches,
            goal_watches,
            watch,
            history_reads,
            hold_queue,
            hold_history,
            hold_observe,
        }
    }

    fn navigation_action(&self, label: &str) -> Option<nsh_core::desktop::MenuAction> {
        let config = self.header.lock().unwrap();
        more_menu_action(config.as_ref()?, label).cloned()
    }

    fn navigation_item(&self, label: &str) -> Option<u32> {
        self.navigation_action(label)
            .filter(|action| action.enabled)
            .map(|action| action.id)
    }

    fn confirm_backend(&self, reply: HostCall, revision: u64, backend: Value) {
        let session = json!({"id":"chat","title":"Dock Chat","kind":"agent","revision":revision,
            "backend":backend,"workspace":{"path":"/work"}});
        self.observation.lock().unwrap()["session"] = session.clone();
        reply.resolve(json!({"value":{"kind":"committed","session":session}}));
    }

    fn choose_navigation(&mut self, label: &str) {
        let id = self
            .navigation_item(label)
            .unwrap_or_else(|| panic!("missing UIKit menu item: {label}"));
        select_header_item(&mut self.app, id);
    }

    fn choose_model(&mut self, label: &str) {
        self.app.wait_for("id:chat-keyboard-model").unwrap();
        let item = std::iter::from_fn(|| self.menus.try_recv().ok())
            .filter_map(|(title, action)| (title == label).then_some(action))
            .last()
            .unwrap_or_else(|| panic!("missing model: {label}"));
        select_native_item(&mut self.app, item);
    }

    async fn prepare_room_post(&mut self, message_id: &str) -> HostCall {
        let (data, call) = fixture_recv(&mut self.calls).await;
        assert_eq!(data["method"], "send");
        assert_eq!(data["input"]["delivery"], "steer");
        assert_eq!(data["prepareRoomPost"], true);
        assert!(call.sender().send("ios.mutationProgress", json!({
            "rootId":"root","generation":1,"progressId":data["progressId"],
            "deliveryId":1,"sequence":1,"requiresObserver":true,"value":{"kind":"room_post_prepared","messageId":message_id}
        })).unwrap());
        assert!(self.app.settle());
        call
    }

    fn deliver(&mut self, item: Value) {
        self.app
            .send_host_event(
                "ios.subscriptionItem",
                json!({
                    "subscriptionId":self.watch["subscriptionId"],"rootId":"root",
                    "generation":self.watch["generation"],"item":item,
                }),
            )
            .unwrap();
    }

    fn queue_item(&mut self, queue: Value) {
        self.deliver(json!({"kind":"queue","queue":queue}));
    }

    fn transcript_changed(&mut self, through: u64, kind: &str) {
        self.deliver(json!({"kind":"events","through":through,"events":[
            {"runId":DOCK_RUN_ID,"fact":{"kind":kind}}
        ]}));
    }

    async fn call(&mut self, method: &str) -> (Value, HostCall) {
        let (data, call) = fixture_recv(&mut self.calls).await;
        assert_eq!(data["method"], method);
        (data["input"].clone(), call)
    }
}

fn dock_model() -> Value {
    json!({"kind":"model","connectionId":"test","modelId":"model"})
}

fn dock_run() -> Value {
    json!({"backend":"model","runId":DOCK_RUN_ID,"turnId":"t1","state":"running"})
}

fn empty_queue() -> Value {
    json!({"revision":0,"entries":[]})
}

fn queued_result(message_id: &str, revision: u64) -> Value {
    json!({"value": SendResult::Queued {
        session_id:"chat".into(), message_id:message_id.into(), revision, completion:None,
    }})
}

fn missing_queued(reason: &str) -> Value {
    json!({"value":{"kind":"missing","reason":reason}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_waits_for_the_observed_run_and_never_retargets_a_held_press() {
    use nsh_core::{EventKind, EventPayload};

    let mut run = dock_run();
    run["state"] = json!("waiting_for_user");
    let mut fx = ComposerDockFixture::start(run, dock_model(), empty_queue()).await;
    let primary = "id:chat-primary-action";
    assert_embedded_primary(&fx.app, "label:Stop current reply");
    fx.app.press("label:Stop current reply").unwrap();
    let (stop, reply) = fx.call("stop").await;
    assert_eq!(stop, json!({"sessionId":"chat","runId":DOCK_RUN_ID}));
    reply.resolve(json!({"value":{"requested":true}}));
    fx.app.wait_for("label:Stopping reply…").unwrap();
    assert!(!fx.app.screen().enabled(primary).unwrap());

    let mut next = dock_run();
    next["runId"] = json!("next-run");
    next["state"] = json!("admitted");
    *fx.run.lock().unwrap() = next.clone();
    fx.transcript_changed(2, "opened");
    fx.app.wait_for("label:Stop current reply").unwrap();

    let id = fx.app.screen().id(primary).unwrap();
    let control = fx.app.engine().control();
    control.dispatch_event(
        id,
        EventKind::PressDown,
        EventPayload::Press(Default::default()),
    );
    assert!(fx.app.settle());
    next["runId"] = json!("later-run");
    *fx.run.lock().unwrap() = next;
    fx.transcript_changed(3, "opened");
    assert!(fx.app.settle());
    control.dispatch_event(
        id,
        EventKind::Press,
        EventPayload::Press(Default::default()),
    );
    assert!(fx.app.settle());
    assert!(
        fx.calls.try_recv().is_err(),
        "a press begun on the replaced run must be cancelled"
    );

    fx.app.press(primary).unwrap();
    let (stop, reply) = fx.call("stop").await;
    assert_eq!(stop["runId"], "later-run");
    reply.resolve(json!({"value":{"requested":false}}));
    fx.app.wait_for("label:Stop current reply").unwrap();

    fx.app.press(primary).unwrap();
    let (_, reply) = fx.call("stop").await;
    reply.reject("Stop receipt lost");
    fx.app
        .wait_for("label:Stop not confirmed. Refresh to check the reply.")
        .unwrap();
    assert!(!fx.app.screen().enabled(primary).unwrap());
    assert!(fx.calls.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn navigation_menu_cannot_stop_a_replacement_run_but_can_queue_for_it() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.app
        .type_text("label:Message composer", "A draft for later")
        .unwrap();
    let captured_stop = fx.navigation_item("Stop current reply").unwrap();

    let mut run = dock_run();
    run["runId"] = json!("replacement-run");
    *fx.run.lock().unwrap() = run;
    fx.transcript_changed(2, "opened");
    assert!(fx.app.settle());
    select_header_item(&mut fx.app, captured_stop);
    assert!(
        fx.calls.try_recv().is_err(),
        "stale Stop must not retarget the replacement"
    );

    fx.choose_navigation("Add to queue");
    let (send, reply) = fx.call("send").await;
    assert_eq!(send["expectedRunId"], "replacement-run");
    assert_eq!(send["delivery"], "queue");
    assert_eq!(send["message"], "A draft for later");
    reply.resolve(queued_result("nav-queued", 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn menu_stop_keeps_the_quoted_draft_for_sending_after_the_run_ends() {
    let mut fx =
        ComposerDockFixture::start_with_anchor(dock_run(), dock_model(), empty_queue(), true).await;
    let mut choose = watch_native_menu_items(&mut fx.app, |_| {});
    fx.app.press("role:button[Quote] >> nth=0").unwrap();
    fx.app
        .type_text("label:Message composer", "Keep this\nand this")
        .unwrap();
    fx.app.wait_for("label:Ask Side Question").unwrap();
    fx.app.long_press("label:Send message").unwrap();
    choose(&mut fx.app, "Stop current reply");
    let (stop, reply) = fx.call("stop").await;
    assert_eq!(stop["runId"], DOCK_RUN_ID);
    reply.resolve(json!({"value":{"requested":true}}));
    assert!(fx.app.settle());
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep this\nand this")
    );
    fx.app
        .wait_for("label:Remove quote: An earlier answer")
        .unwrap();
    assert!(!fx.app.screen().enabled("id:chat-primary-action").unwrap());

    *fx.run.lock().unwrap() = Value::Null;
    fx.transcript_changed(2, "ended");
    fx.app.wait_for("label:Send message").unwrap();
    fx.app.press("label:Send message").unwrap();
    let (send, reply) = fx.call("send").await;
    assert!(send["expectedRunId"].is_null());
    assert_eq!(send["message"], "Keep this\nand this");
    assert_eq!(send["quotes"][0]["text"], "An earlier answer");
    reply.resolve(queued_result("quote", 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thinking_slider_previews_steps_then_commits_and_rolls_back_a_rejected_tick() {
    use nsh_core::geometry::Point;

    let mut backend = dock_model();
    backend["serviceTier"] = json!("fast");
    backend["thinkingLevel"] = json!("high");
    let mut fx = ComposerDockFixture::start(Value::Null, backend, empty_queue()).await;
    let pill = "id:chat-thinking-accessory";
    let slider = "id:chat-thinking-slider";
    fx.app
        .wait_for("id:chat-thinking-accessory >> text:High")
        .unwrap();
    fx.choose_navigation("Thinking level");
    fx.app.wait_for(slider).unwrap();
    assert!(!fx.app.screen().matches("id:chat-details-scroll").unwrap());
    fx.app.press("label:Minimal").unwrap();
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(
        change["backend"],
        json!({"kind":"model","connectionId":"test","modelId":"model",
        "serviceTier":"fast","thinkingLevel":"minimal"})
    );
    fx.app
        .wait_for("id:chat-thinking-accessory >> text:Minimal")
        .unwrap();
    assert!(!fx.navigation_action("Thinking level").unwrap().enabled);
    reply.resolve(json!({"value":{"kind":"rejected","reason":"tools_unavailable"}}));
    fx.app.wait_for("text:Could not change the model.").unwrap();
    fx.app
        .wait_for("id:chat-thinking-accessory >> text:High")
        .unwrap();

    let thumb = "label:Thinking level · High";
    let width = fx
        .app
        .screen()
        .layout(slider)
        .unwrap()
        .unwrap()
        .bounds
        .size
        .width;
    fx.app
        .drag_and_hold(thumb, Point::new(-width / 4., px(0.)), Default::default())
        .unwrap();
    fx.app
        .wait_for("id:chat-thinking-accessory >> text:Minimal")
        .unwrap();
    assert!(
        fx.calls.try_recv().is_err(),
        "drag must not save before release"
    );
    fx.app.drop_held().unwrap();
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(change["backend"]["thinkingLevel"], "minimal");
    assert_eq!(change["backend"]["serviceTier"], "fast");
    let session = json!({"id":"chat","title":"Dock Chat","kind":"agent","revision":2,
        "backend":change["backend"],"workspace":{"path":"/work"}});
    fx.observation.lock().unwrap()["session"] = session.clone();
    reply.resolve(json!({"value":{"kind":"committed","session":session}}));
    fx.app.wait_for("label:Thinking level · Minimal").unwrap();
    fx.app.press(pill).unwrap();
    assert!(!fx.app.screen().matches(slider).unwrap());

    fx.app.press(pill).unwrap();
    fx.app.press("id:chat-thinking-backdrop").unwrap();
    assert!(!fx.app.screen().matches(slider).unwrap());
    fx.app.type_text("label:Message composer", "draft").unwrap();
    fx.app.press(pill).unwrap();
    fx.app.press("label:Dismiss keyboard").unwrap();
    assert!(!fx.app.screen().matches(slider).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thinking_drag_is_cancelled_when_observe_switches_models_mid_gesture() {
    let mut backend = dock_model();
    backend["thinkingLevel"] = json!("high");
    let mut fx = ComposerDockFixture::start(Value::Null, backend, empty_queue()).await;
    let slider = "id:chat-thinking-slider";
    fx.choose_navigation("Thinking level");
    let width = fx
        .app
        .screen()
        .layout(slider)
        .unwrap()
        .unwrap()
        .bounds
        .size
        .width;
    fx.app
        .drag_and_hold(
            "label:Thinking level · High",
            nsh_core::Point::new(-width / 4., px(0.)),
            Default::default(),
        )
        .unwrap();
    fx.app.wait_for("label:Thinking level · Minimal").unwrap();
    let replacement = json!({"id":"chat","title":"Dock Chat","kind":"agent","revision":2,
        "workspace":{"path":"/work"},"backend":{"kind":"model","connectionId":"test","modelId":"alternate"}});
    *fx.observation.lock().unwrap() = json!({"session":replacement,"through":2});
    fx.transcript_changed(2, "step_ended");
    fx.app
        .wait_for("id:chat-keyboard-model >> text:Alternate thinker")
        .unwrap();
    fx.app.wait_for("label:Thinking level · Default").unwrap();
    fx.app.drop_held().unwrap();
    assert!(
        fx.calls.try_recv().is_err(),
        "old drag committed on a replacement model"
    );
    fx.app.press("label:Low").unwrap();
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(change["backend"]["modelId"], "alternate");
    assert_eq!(change["backend"]["thinkingLevel"], "low");
    fx.confirm_backend(reply, 3, change["backend"].clone());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thinking_slider_can_return_to_the_host_default() {
    let mut backend = dock_model();
    backend["serviceTier"] = json!("fast");
    let mut fx = ComposerDockFixture::start(Value::Null, backend.clone(), empty_queue()).await;
    fx.choose_navigation("Thinking level");
    let thumb = "label:Thinking level · Default";
    fx.app.wait_for(thumb).unwrap();
    let x = |app: &Headless, label| app.screen().layout(label).unwrap().unwrap().bounds.origin.x;
    let first_stop = x(&fx.app, thumb);

    fx.app.press("label:High").unwrap();
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(change["backend"]["thinkingLevel"], "high");
    fx.confirm_backend(reply, 2, change["backend"].clone());
    fx.app.wait_for("label:Thinking level · High").unwrap();
    assert!(x(&fx.app, "label:Thinking level · High") > first_stop);

    fx.app
        .wait_until("thinking save finished", Duration::from_secs(2), |screen| {
            screen.enabled("label:Default").unwrap_or(false)
        })
        .unwrap();
    fx.app.press("label:Default").unwrap();
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(change["backend"], backend);
    fx.confirm_backend(reply, 3, change["backend"].clone());
    fx.app
        .wait_until("default saved", Duration::from_secs(2), |screen| {
            screen.enabled("label:Default").unwrap_or(false)
        })
        .unwrap();
    fx.app.wait_for(thumb).unwrap();
    assert_eq!(x(&fx.app, thumb), first_stop);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn single_explicit_thinking_level_still_offers_host_default() {
    let default = json!({"kind":"model","connectionId":"test","modelId":"high-only"});
    let mut selected = default.clone();
    selected["thinkingLevel"] = json!("high");
    let mut fx = ComposerDockFixture::start(Value::Null, selected, empty_queue()).await;
    fx.app.wait_for("id:chat-thinking-accessory").unwrap();
    fx.choose_navigation("Thinking level");
    fx.app.wait_for("label:Thinking level · High").unwrap();

    fx.app.press("label:Default").unwrap();
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(change["backend"], default);
    fx.confirm_backend(reply, 2, default);
    fx.app.wait_for("label:Thinking level · Default").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_chat_hides_native_thinking_item_even_with_keyboard_closed() {
    let queue = json!({"revision":1,"entries":[
        {"messageId":"waiting","kind":"followup","preview":"Next question"}
    ]});
    let mut fx = ComposerDockFixture::start(Value::Null, dock_model(), queue).await;
    fx.app.wait_for("id:chat-thinking-accessory").unwrap();
    assert!(fx.navigation_item("Thinking level").is_some());

    fx.app.set_viewport(Size::new(px(844.), px(390.))).unwrap();
    fx.app
        .set_environment("landscape, keyboard closed", |env| {
            env.safe_area.left = px(47.);
            env.safe_area.right = px(47.);
            env.safe_area.bottom = px(21.);
            env.keyboard_height = px(0.);
        })
        .unwrap();
    fx.app.wait_for("id:chat-composer-actions").unwrap();
    assert!(fx.navigation_action("Thinking level").is_none());
    assert!(fx.navigation_item("Usage & Details").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accessory_model_menu_remains_reachable_at_300_percent_dynamic_type() {
    let mut fx = ComposerDockFixture::start(Value::Null, dock_model(), empty_queue()).await;
    fx.app.set_viewport(Size::new(px(375.), px(812.))).unwrap();
    fx.app
        .set_environment("300% Dynamic Type", |env| {
            env.font_scale = 3.0;
            env.keyboard_height = px(280.);
        })
        .unwrap();
    let model = "id:chat-keyboard-model";
    let layout = fx.app.screen().layout(model).unwrap().unwrap();
    assert!(
        layout.bounds.size.width >= px(72.) && !layout.clipped,
        "{layout:?}"
    );
    assert!(fx.app.screen().enabled(model).unwrap());
    // UIKit owns the press and menu presentation; deliver its selection event.
    fx.choose_model("Other model");
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(change["backend"]["modelId"], "other");
    fx.confirm_backend(reply, 2, change["backend"].clone());
    fx.app
        .wait_for("id:chat-keyboard-model >> text:Other model")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_goal_creation_uses_the_thinking_preference_saved_by_the_slider() {
    let mut backend = dock_model();
    backend["serviceTier"] = json!("fast");
    backend["thinkingLevel"] = json!("high");
    let mut fx = ComposerDockFixture::start(Value::Null, backend, empty_queue()).await;
    let mut frame = fixture_recv(&mut fx.goal_watches).await;
    frame["item"] = goal_view(Value::Null);
    fx.app
        .send_host_event("ios.subscriptionItem", frame)
        .unwrap();

    fx.choose_navigation("Thinking level");
    fx.app.wait_for("id:chat-thinking-slider").unwrap();
    fx.app.press("label:Minimal").unwrap();
    let (input, receipt) = fx.call("selectBackend").await;
    let confirmed = json!({"kind":"model","connectionId":"test","modelId":"model",
        "serviceTier":"fast","thinkingLevel":"minimal"});
    assert_eq!(input["backend"], confirmed);
    let session = json!({"id":"chat","kind":"agent","title":"Dock Chat","revision":2,
        "workspace":{"path":"/work"},"backend":confirmed,
        "permissions":{"access":"read_only","requestPermissions":true},"boundaryRevision":12,
        "binding":{"id":"00000000-0000-4000-8000-000000000001","permissionEpoch":3}});
    *fx.observation.lock().unwrap() = json!({"session":session});
    receipt.resolve(json!({"value":{"kind":"committed","session":session}}));
    fx.app.wait_for("label:Thinking level · Minimal").unwrap();
    fx.app.press("id:chat-thinking-backdrop").unwrap();

    fx.choose_navigation("New Goal…");
    fx.app.wait_for("id:chat-goal-sheet-scroll").unwrap();
    enter_goal_text(
        &mut fx.app,
        "goal-objective",
        "Check the selected thinking strength",
    );
    fx.app.press("id:goal-save").unwrap();
    let (input, receipt) = fx.call("changeGoal").await;
    assert_eq!(input["approval"]["backend"], confirmed);
    assert_eq!(input["approval"]["target"]["sessionId"], "chat");
    receipt.resolve(json!({"value":{"kind":"committed","goalId":GOAL_ID,"revision":1}}));
    let (input, read) = fx.call("goal").await;
    assert_eq!(input["sessionId"], "chat");
    read.resolve(json!({"value":goal_view(goal_record("active",1))}));
    fx.app.wait_for("text:Goal Details").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn details_distinguish_current_and_cached_usage_and_refresh_once_per_step_page() {
    use std::sync::atomic::Ordering;

    let executor = json!({"kind":"executor","selection":{"executor":"codex","settings":{"runtime":"cli","model":"external"}}});
    let mut fx = ComposerDockFixture::start(dock_run(), executor, empty_queue()).await;
    assert!(!fx.app.screen().matches("id:chat-details-scroll").unwrap());
    fx.choose_navigation("Usage & Details");
    fx.app.wait_for("text:No usage data yet").unwrap();
    let mut metrics = json!({"modelId":"measured-model","connectionId":"other-connection",
        "approximate":false,"contextLastKnown":false});
    let cases = [
        (
            json!(89_599),
            json!(128_000),
            json!(31.4),
            false,
            false,
            "89,599 / 128,000 tokens · 70%",
            "31.4 tok/s",
        ),
        (
            json!(96_000),
            json!(128_000),
            json!(31.4),
            false,
            false,
            "96,000 / 128,000 tokens · 75%",
            "31.4 tok/s",
        ),
        (
            json!(115_200),
            json!(128_000),
            json!(0),
            true,
            false,
            "≈115,200 / 128,000 tokens · ≈90%",
            "0.0 tok/s",
        ),
        (
            json!(160_000),
            json!(128_000),
            Value::Null,
            false,
            true,
            "160,000 / 128,000 tokens · 125%",
            "Not measured",
        ),
        (
            json!(0),
            json!(128_000),
            Value::Null,
            false,
            false,
            "0 / 128,000 tokens · 0%",
            "Not measured",
        ),
        (
            json!(1),
            json!(128_000),
            Value::Null,
            true,
            false,
            "≈1 / 128,000 tokens · ≈<1%",
            "Not measured",
        ),
        (
            json!(123),
            Value::Null,
            Value::Null,
            true,
            false,
            "≈123 tokens used",
            "Not measured",
        ),
        (
            Value::Null,
            json!(128_000),
            Value::Null,
            false,
            false,
            "128,000 token window",
            "Not measured",
        ),
        (
            json!(123),
            json!(0),
            Value::Null,
            false,
            false,
            "123 tokens used",
            "Not measured",
        ),
    ];
    for (index, (used, window, speed, approximate, last, usage, rate)) in
        cases.into_iter().enumerate()
    {
        let through = index + 2;
        metrics["contextTokens"] = used;
        metrics["contextWindow"] = window;
        metrics["outputTokensPerSecond"] = speed;
        metrics["approximate"] = json!(approximate);
        metrics["contextLastKnown"] = json!(last);
        *fx.observation.lock().unwrap() = json!({"through":through,"metrics":metrics});
        let before = fx.observes.load(Ordering::SeqCst);
        fx.deliver(json!({"kind":"events","through":through,"events":[
            {"runId":DOCK_RUN_ID,"fact":{"kind":"step_ended"}},
            {"runId":DOCK_RUN_ID,"fact":{"kind":"step_ended"}}
        ]}));
        fx.app.wait_for(&format!("text:{usage}")).unwrap();
        fx.app.wait_for(&format!("text:{rate}")).unwrap();
        assert_eq!(fx.observes.load(Ordering::SeqCst), before + 1);
        assert_eq!(
            fx.app
                .shows("Context from the last request. Newer content isn’t included."),
            last
        );
    }
    fx.app
        .wait_for("text:measured-model · other-connection")
        .unwrap();
    fx.app
        .send_host_event("ios.hostState", side_host_state(9, None))
        .unwrap();
    fx.app
        .wait_for("text:measured-model · other-connection · Last synced")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_header_and_keyboard_model_keep_usage_and_settings_separate() {
    use nsh_core::HeaderItemContent;
    let mut fx = ComposerDockFixture::start(Value::Null, dock_model(), empty_queue()).await;
    {
        let config = fx.header.lock().unwrap();
        let config = config.as_ref().unwrap();
        assert!(config.right.is_none(), "custom iOS headerRight is mounted");
        let symbols: Vec<_> = config
            .right_items
            .iter()
            .map(|item| &item.content)
            .collect();
        assert_eq!(
            symbols,
            [
                &HeaderItemContent::Symbol("folder".into()),
                &HeaderItemContent::Symbol("ellipsis.circle".into()),
            ]
        );
    }
    let slider = "id:chat-thinking-slider";
    let backdrop = "id:chat-thinking-backdrop";
    fx.choose_navigation("Thinking level");
    fx.app.wait_for(slider).unwrap();
    fx.app.wait_for(backdrop).unwrap();
    fx.app.set_viewport(Size::new(px(844.), px(390.))).unwrap();
    fx.app
        .set_environment("landscape keyboard", |env| {
            env.safe_area.left = px(47.);
            env.safe_area.right = px(47.);
            env.safe_area.bottom = px(21.);
            env.keyboard_height = px(240.);
        })
        .unwrap();
    assert!(!fx.app.screen().matches(slider).unwrap());
    assert!(!fx.app.screen().matches(backdrop).unwrap());
    assert!(
        !fx.app
            .screen()
            .enabled("id:chat-thinking-accessory")
            .unwrap()
    );
    assert!(!fx.app.screen().matches("id:chat-details-scroll").unwrap());
    fx.choose_model("Other model");
    let (change, reply) = fx.call("selectBackend").await;
    assert_eq!(change["backend"]["modelId"], "other");
    let session = json!({"id":"chat","title":"Dock Chat","kind":"agent","revision":2,
        "backend":change["backend"],"workspace":{"path":"/work"}});
    fx.observation.lock().unwrap()["session"] = session.clone();
    reply.resolve(json!({"value":{"kind":"committed","session":session}}));
    fx.app
        .wait_for("id:chat-keyboard-model >> text:Other model")
        .unwrap();
    assert!(
        !fx.app
            .screen()
            .matches("id:chat-thinking-accessory")
            .unwrap()
    );
    assert!(fx.navigation_item("Thinking level").is_none());
    assert!(!fx.app.screen().matches("id:chat-details-scroll").unwrap());

    fx.choose_navigation("Usage & Details");
    fx.app.wait_for("id:chat-details-scroll").unwrap();
    assert!(
        !fx.app
            .screen()
            .matches("id:chat-details-scroll >> label:Model")
            .unwrap()
    );
    assert!(
        !fx.app
            .screen()
            .matches("id:chat-details-scroll >> label:Thinking level")
            .unwrap()
    );
    assert_keyboard_target(&fx.app, "label:Done", 47., 797., 150.);
    fx.app.press("label:Done").unwrap();

    let room = ComposerDockFixture::start_room().await;
    assert!(
        !room
            .app
            .screen()
            .matches("id:chat-thinking-accessory")
            .unwrap()
    );
    assert!(room.navigation_item("Thinking level").is_none());
    assert!(room.navigation_item("Usage & Details").is_none());
}

const CONTINUE_ACTION: &str = "label:Continue reply";

fn stopped_source(state: &str) -> Value {
    json!({"sessionId":"chat","runId":DOCK_RUN_ID,"turnId":"t1","highWater":7,"state":{"kind":state}})
}

async fn stopped_conversation(
    queue: Value,
    backend: Value,
    tail_fallback: bool,
) -> ComposerDockFixture {
    let mut fx = ComposerDockFixture::start(dock_run(), backend, queue).await;
    let mut last = quote_history_row(2, "assistant", "Interrupted answer");
    last["runId"] = json!(DOCK_RUN_ID);
    fx.history.lock().unwrap().push(last);
    *fx.run.lock().unwrap() = Value::Null;
    *fx.observation.lock().unwrap() = json!({"through":2,
        "latestRunId":(!tail_fallback).then_some(DOCK_RUN_ID)});
    fx.transcript_changed(2, "ended");
    fx
}

async fn probe_continue_model(fx: &mut ComposerDockFixture, backend: &Value) -> HostCall {
    let source = stopped_source("failed");
    let (read, result) = fx.call("execution").await;
    assert_eq!(read, json!({"sessionId":"chat","runId":DOCK_RUN_ID}));
    assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());
    result.resolve(json!({"value":{"kind":"found","execution":source}}));
    let (read, result) = fx.call("continuationAvailability").await;
    assert_eq!(read, json!({"sessionId":"chat","runId":DOCK_RUN_ID}));
    result.resolve(json!({"value":{"kind":"ready","source":source}}));
    let (read, result) = fx.call("model").await;
    assert_eq!(&read["backend"], backend);
    result
}

fn continue_model(backend: &Value) -> Value {
    json!({"value":{"kind":"ready","choice":{"selection":backend,"label":"Dock model","sourceName":"Test",
        "serviceTiers":[{"id":"fast","name":"Fast"}],"thinkingLevels":["off","minimal","high"]}}})
}

async fn verify_continue(fx: &mut ComposerDockFixture, backend: &Value) {
    probe_continue_model(fx, backend)
        .await
        .resolve(continue_model(backend));
    fx.app.wait_for(CONTINUE_ACTION).unwrap();
}

async fn tap_continue(fx: &mut ComposerDockFixture, backend: &Value) -> (Value, HostCall) {
    fx.app.press(CONTINUE_ACTION).unwrap();
    let (read, result) = fx.call("model").await;
    assert_eq!(&read["backend"], backend);
    result.resolve(continue_model(backend));
    let (read, result) = fx.call("execution").await;
    assert_eq!(read["runId"], DOCK_RUN_ID);
    result.resolve(json!({"value":{"kind":"found","execution":stopped_source("failed")}}));
    fx.call("continueRun").await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_failure_settles_while_a_side_chat_is_on_top() {
    for submitted in [false, true] {
        let mut fx =
            ComposerDockFixture::start_with_anchor(dock_run(), dock_model(), empty_queue(), true)
                .await;
        fx.app.press("label:Stop current reply").unwrap();
        let (_, stop) = fx.call("stop").await;
        fx.app.wait_for("label:Stopping reply…").unwrap();
        fx.app
            .press("label:Side questions (1) · Waiting for your response")
            .unwrap();
        fx.app.wait_for("text:Side Question · Dock Chat").unwrap();
        if submitted {
            stop.reject("Connection failed after confirm");
        } else {
            stop.resolve(json!({"notSubmitted":"Prepare refused"}));
        }
        assert!(fx.app.settle());
        fx.app.press("label:Back").unwrap();

        if submitted {
            fx.app
                .wait_for("label:Stop not confirmed. Refresh to check the reply.")
                .unwrap();
            assert!(fx.calls.try_recv().is_err());
            fx.choose_navigation("Refresh");
        }
        fx.app.wait_for("label:Stop current reply").unwrap();
        fx.app.press("label:Stop current reply").unwrap();
        let (retry, stop) = fx.call("stop").await;
        assert_eq!(retry["runId"], DOCK_RUN_ID);
        stop.resolve(json!({"value":{"requested":false}}));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ended_queues_a_fresh_observe_even_if_step_snapshot_predates_backend_commit() {
    use std::sync::atomic::Ordering::SeqCst;

    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.hold_observe.store(true, SeqCst);
    fx.transcript_changed(2, "step_ended");
    let (_, old_step) = fx.call("observe").await;
    fx.choose_model("Other model");
    let (change, commit) = fx.call("selectBackend").await;

    let committed = json!({"id":"chat","kind":"agent","title":"Dock Chat","revision":2,
        "workspace":{"path":"/work"},"backend":change["backend"]});
    commit.resolve(json!({"value":{"kind":"committed","session":committed}}));
    fx.app
        .wait_for("id:chat-keyboard-model >> text:Other model")
        .unwrap();
    fx.app.wait_for("label:Stop current reply").unwrap();

    *fx.run.lock().unwrap() = Value::Null;
    *fx.observation.lock().unwrap() = json!({"session":committed,"through":3});
    fx.transcript_changed(3, "ended");
    let before = fx.observes.load(SeqCst);
    old_step.resolve(
        json!({"value":{"session":{"id":"chat","kind":"agent","revision":1,
        "title":"Dock Chat","backend":dock_model()},"through":2,"run":dock_run()}}),
    );
    fx.app.wait_for("label:Send message").unwrap();
    assert_eq!(fx.observes.load(SeqCst), before + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observe_failure_keeps_the_queued_ended_read_but_does_not_retry_on_its_own() {
    use std::sync::atomic::Ordering::SeqCst;

    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.hold_observe.store(true, SeqCst);
    fx.transcript_changed(2, "step_ended");
    let (_, read) = fx.call("observe").await;
    let before = fx.observes.load(SeqCst);
    read.reject("Unqueued observe failed");
    fx.app.wait_for("text:/Unqueued observe failed/").unwrap();
    assert!(fx.app.settle());
    assert_eq!(fx.observes.load(SeqCst), before);
    assert!(fx.app.screen().enabled("label:Stop current reply").unwrap());

    fx.hold_observe.store(true, SeqCst);
    fx.transcript_changed(3, "step_ended");
    let (_, old) = fx.call("observe").await;
    *fx.run.lock().unwrap() = Value::Null;
    fx.observation.lock().unwrap()["through"] = json!(4);
    fx.transcript_changed(4, "ended");
    let before = fx.observes.load(SeqCst);
    old.reject("Earlier step observe failed");

    fx.app.wait_for("label:Send message").unwrap();
    fx.app
        .wait_for("text:/Earlier step observe failed/")
        .unwrap();
    assert_eq!(fx.observes.load(SeqCst), before + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whitespace_draft_disables_send_instead_of_stopping_or_continuing() {
    let mut working = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    working
        .app
        .type_text("label:Message composer", "\n  ")
        .unwrap();
    assert!(!working.app.screen().enabled("label:Send message").unwrap());
    assert!(working.app.press("id:chat-primary-action").is_err());
    assert!(working.calls.try_recv().is_err());

    let backend = dock_model();
    let mut stopped = stopped_conversation(empty_queue(), backend.clone(), false).await;
    verify_continue(&mut stopped, &backend).await;
    stopped
        .app
        .type_text("label:Message composer", "\n  ")
        .unwrap();
    assert!(!stopped.app.screen().enabled("label:Send message").unwrap());
    assert!(stopped.app.press("id:chat-primary-action").is_err());
    assert!(stopped.calls.try_recv().is_err());

    stopped.app.clear("label:Message composer").unwrap();
    stopped.app.press(CONTINUE_ACTION).unwrap();
    let (_, model) = stopped.call("model").await;
    stopped
        .app
        .type_text("label:Message composer", "\n  ")
        .unwrap();
    model.resolve(continue_model(&backend));
    stopped.app.wait_for("label:Send message").unwrap();
    assert!(!stopped.app.screen().enabled("label:Send message").unwrap());
    assert!(stopped.calls.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_checks_explicit_tier_and_effort_both_times() {
    let mut backend = dock_model();
    backend["serviceTier"] = json!("fast");
    backend["thinkingLevel"] = json!("high");
    for (field, unsupported) in [
        ("serviceTiers", json!([{"id":"slow","name":"Slow"}])),
        ("thinkingLevels", json!(["minimal"])),
    ] {
        let mut fx = stopped_conversation(empty_queue(), backend.clone(), false).await;
        let mut unsupported_model = continue_model(&backend);
        unsupported_model["value"]["choice"][field] = unsupported;
        probe_continue_model(&mut fx, &backend)
            .await
            .resolve(unsupported_model.clone());
        assert!(fx.app.settle());
        assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());
        assert!(!fx.app.screen().enabled("id:chat-primary-action").unwrap());

        fx.app
            .send_host_event("ios.hostState", dock_host(2))
            .unwrap();
        verify_continue(&mut fx, &backend).await;
        fx.app.press(CONTINUE_ACTION).unwrap();
        let (_, model) = fx.call("model").await;
        model.resolve(unsupported_model);
        fx.app
            .wait_for("text:The selected model is unavailable. Try again or choose another model.")
            .unwrap();
        assert!(!fx.app.screen().enabled("id:chat-primary-action").unwrap());
        assert!(fx.calls.try_recv().is_err());
    }

    let mut fx = stopped_conversation(empty_queue(), backend.clone(), false).await;
    verify_continue(&mut fx, &backend).await;
    fx.app.press(CONTINUE_ACTION).unwrap();
    let (_, model) = fx.call("model").await;
    model.resolve(json!({"value":{"kind":"unavailable","message":"Host diagnostic in English"}}));
    fx.app
        .wait_for("text:The selected model is unavailable. Try again or choose another model.")
        .unwrap();
    assert!(!fx.app.shows("Host diagnostic in English"));
    assert!(fx.calls.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_successor_can_be_steered_and_queued_while_history_is_loading() {
    use std::sync::atomic::Ordering::SeqCst;

    let backend = dock_model();
    let mut fx = stopped_conversation(empty_queue(), backend.clone(), false).await;
    let mut choose = watch_native_menu_items(&mut fx.app, |_| {});
    verify_continue(&mut fx, &backend).await;
    let (_, result) = tap_continue(&mut fx, &backend).await;
    let mut run = dock_run();
    run["runId"] = json!("successor");
    *fx.run.lock().unwrap() = run;
    fx.hold_history.store(true, SeqCst);
    let mut execution = stopped_source("admitted");
    execution["runId"] = json!("successor");
    result.resolve(json!({"value":{"kind":"started","execution":execution}}));
    let (_, history) = fx.call("history").await;
    fx.app.wait_for("label:Stop current reply").unwrap();

    fx.app
        .type_text("label:Message composer", "Follow up")
        .unwrap();
    assert!(fx.app.screen().enabled("label:Send message").unwrap());
    choose(&mut fx.app, "Add to queue");
    let (send, reply) = fx.call("send").await;
    assert_eq!(send["delivery"], "queue");
    assert_eq!(send["expectedRunId"], "successor");
    reply.resolve(queued_result("follow-up", 1));
    history.resolve(history_page(
        2,
        fx.history.lock().unwrap().clone(),
        Value::Null,
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_successor_finishing_before_its_continue_receipt_cannot_relock_the_composer() {
    use std::sync::atomic::Ordering::SeqCst;

    let backend = dock_model();
    let mut fx = stopped_conversation(empty_queue(), backend.clone(), false).await;
    verify_continue(&mut fx, &backend).await;
    let (_, late_receipt) = tap_continue(&mut fx, &backend).await;

    let mut run = dock_run();
    run["runId"] = json!("successor");
    *fx.run.lock().unwrap() = run;
    *fx.observation.lock().unwrap() = json!({"through":3});
    fx.deliver(json!({"kind":"events","through":3,
        "events":[{"runId":"successor","fact":{"kind":"opened"}}]}));
    fx.app.wait_for("label:Stop current reply").unwrap();
    let draft = "New draft while the old receipt is pending";
    fx.app.type_text("label:Message composer", draft).unwrap();
    assert!(fx.app.screen().enabled("label:Send message").unwrap());

    *fx.run.lock().unwrap() = Value::Null;
    fx.observation.lock().unwrap()["through"] = json!(4);
    fx.hold_history.store(true, SeqCst);
    fx.deliver(json!({"kind":"events","through":4,
        "events":[{"runId":"successor","fact":{"kind":"ended"}}]}));
    let (_, history) = fx.call("history").await;
    // The successor projected no rows. Even if the old source is still
    // offered by the eligibility reads, it cannot be submitted again.
    history.resolve(history_page(
        4,
        fx.history.lock().unwrap().clone(),
        Value::Null,
    ));
    probe_continue_model(&mut fx, &backend)
        .await
        .resolve(continue_model(&backend));
    assert!(fx.app.settle());
    assert!(fx.app.screen().enabled("label:Send message").unwrap());
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some(draft)
    );

    fx.app.clear("label:Message composer").unwrap();
    assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());
    assert!(!fx.app.screen().enabled("id:chat-primary-action").unwrap());

    fx.app.type_text("label:Message composer", draft).unwrap();
    fx.app.press("label:Send message").unwrap();
    let (send, reply) = fx.call("send").await;
    assert_eq!(send["message"], draft);
    assert!(send["expectedRunId"].is_null());
    let mut execution = stopped_source("completed");
    execution["runId"] = json!("successor");
    late_receipt.resolve(json!({"value":{"kind":"started","execution":execution}}));
    reply.resolve(queued_result("new-draft", 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_executor_alias_shows_its_effort_and_edits_the_canonical_model() {
    let backend = json!({"kind":"executor","selection":{
        "executor":"codex","settings":{"runtime":"cli","model":"opus-high"}}});
    let mut fx = ComposerDockFixture::start(Value::Null, backend, empty_queue()).await;
    fx.app
        .wait_for("id:chat-thinking-accessory >> text:High")
        .unwrap();
    fx.choose_navigation("Thinking level");
    let high = fx
        .app
        .screen()
        .accessibility(Some("label:High"))
        .unwrap()
        .unwrap();
    assert!(high.selected);
    fx.app.press("label:Low").unwrap();
    let (change, commit) = fx.call("selectBackend").await;
    assert_eq!(
        change["backend"],
        json!({"kind":"executor","selection":{
        "executor":"codex","settings":{"runtime":"cli","model":"opus","thinkingLevel":"low"}}})
    );
    let session = json!({"id":"chat","kind":"agent","title":"Dock Chat","workspace":{"path":"/work"},
        "revision":2,"backend":change["backend"]});
    fx.observation.lock().unwrap()["session"] = session.clone();
    commit.resolve(json!({"value":{"kind":"committed","session":session}}));
    fx.app
        .wait_for("id:chat-thinking-accessory >> text:Low")
        .unwrap();
}

fn detail_metrics(last_known: bool) -> Value {
    json!({"modelId":"model","connectionId":"test","contextTokens":95_000,"contextWindow":100_000,
        "approximate":false,"contextLastKnown":last_known,"outputTokensPerSecond":31.4})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_native_usage_menu_action_survives_step_telemetry() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.app.wait_for("label:Stop current reply").unwrap();
    fx.app.wait_for("id:chat-thinking-accessory").unwrap();
    assert!(fx.navigation_item("Thinking level").is_some());
    let usage = fx.navigation_item("Usage & Details").unwrap();
    *fx.observation.lock().unwrap() = json!({"through":2,"metrics":detail_metrics(false),
        "session":{"id":"chat","title":"Dock Chat","kind":"agent","revision":1,
            "backend":dock_model(),"workspace":{"path":"/work/step-two"}}});
    fx.transcript_changed(2, "step_ended");
    fx.app.wait_for("id:chat-context >> text:step-two").unwrap();
    assert_eq!(fx.navigation_item("Usage & Details"), Some(usage));
    select_header_item(&mut fx.app, usage);
    fx.app
        .wait_for("id:chat-details-scroll >> text:31.4 tok/s")
        .unwrap();
    assert_eq!(fx.navigation_item("Usage & Details"), Some(usage));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn details_fit_or_scroll_on_short_iphone_and_captions_are_readable() {
    use nsh_core::{Color, MountItem, TransformKind, animation::Animator, platform::ColorScheme};

    let mut fx = ComposerDockFixture::start(Value::Null, dock_model(), empty_queue()).await;
    *fx.observation.lock().unwrap() = json!({"through":1,"metrics":detail_metrics(true)});
    fx.app.set_viewport(Size::new(px(375.), px(667.))).unwrap();
    fx.app
        .set_environment("short portrait", |env| {
            env.keyboard_height = px(0.);
            env.safe_area.top = px(20.);
            env.safe_area.bottom = px(34.);
        })
        .unwrap();
    // Layout frames omit detent transforms. Include what the native animator
    // actually presents, or a medium sheet's offscreen rows look visible.
    let presentation = Arc::new(std::sync::Mutex::new((
        Animator::default(),
        BTreeMap::new(),
    )));
    let mounted = presentation.clone();
    fx.app.observe(move |_, batch| {
        let (animator, transforms) = &mut *mounted.lock().unwrap();
        for item in &batch.items {
            animator.apply(item);
            if let MountItem::ViewStyle { id, style } = item {
                transforms.insert(*id, style.transform);
            }
        }
    });
    fx.choose_navigation("Usage & Details");
    fx.app.wait_for("text:Last request").unwrap();
    let scroll = "id:chat-details-scroll";
    let source = "text:model · test";
    let layout = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap();
    let sheet_offset = {
        let (animator, transforms) = &mut *presentation.lock().unwrap();
        animator.tick(0.0);
        animator.tick(5.0);
        let nodes = fx.app.screen().layout_nodes();
        let mut ancestors = Vec::new();
        let mut id = fx.app.screen().id(scroll).unwrap();
        while let Some(node) = nodes.iter().find(|node| node.id == id) {
            ancestors.push(id);
            id = node.parent;
        }
        let mut offset = 0.0;
        animator.write(
            |id| ancestors.contains(&id).then_some(id),
            |id, values, _| {
                if let Some(transform) = transforms.get(&id) {
                    for (i, op) in transform.ops().iter().enumerate() {
                        if op.kind == TransformKind::TranslateY {
                            offset += values.transform[i].unwrap_or(op.value);
                        }
                    }
                }
            },
        );
        px(offset)
    };
    let visible = |app: &Headless, selector| {
        let row = layout(app, selector);
        !row.hidden && !row.clipped && row.bounds.bottom() + sheet_offset <= px(633.)
    };
    if !visible(&fx.app, source) {
        fx.app.scroll(scroll, px(500.)).unwrap();
    }
    for selector in ["text:Output speed", source] {
        assert!(
            visible(&fx.app, selector),
            "{selector} is outside the visible sheet"
        );
    }

    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        fx.app
            .set_environment("appearance", |env| env.color_scheme = scheme)
            .unwrap();
        let nodes = fx.app.screen().layout_nodes();
        for selector in ["text:Usage", source, "text:Usage & Details"] {
            let id = fx.app.screen().id(selector).unwrap();
            let node = nodes.iter().find(|node| node.id == id).unwrap();
            let foreground = node.text.as_ref().unwrap().text.spans[0].style.color;
            let mut parent = node.parent;
            let background = loop {
                let style = fx
                    .app
                    .screen()
                    .view_style(&format!("view:{parent}"))
                    .unwrap()
                    .unwrap();
                if let Some(fill) = style.background_color {
                    break Color(fill);
                }
                parent = nodes.iter().find(|node| node.id == parent).unwrap().parent;
            };
            assert_readable_colors(selector, foreground, background);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continue_uses_run_local_fence_and_cancels_a_press_during_ime_composition() {
    use nsh_core::{EventKind, EventPayload};

    let mut backend = dock_model();
    backend["serviceTier"] = json!("fast");
    backend["thinkingLevel"] = json!("high");
    let held =
        json!({"revision":1,"entries":[{"kind":"held","messageId":"held","preview":"Held"}]});
    let mut fx = stopped_conversation(held, backend.clone(), true).await;
    verify_continue(&mut fx, &backend).await;
    assert_embedded_primary(&fx.app, CONTINUE_ACTION);
    let id = fx.app.screen().id(CONTINUE_ACTION).unwrap();
    let control = fx.app.engine().control();
    control.dispatch_event(
        id,
        EventKind::PressDown,
        EventPayload::Press(Default::default()),
    );
    assert!(fx.app.settle());
    fx.app.compose("label:Message composer", "ni").unwrap();
    fx.app.wait_for("label:Send message").unwrap();
    control.dispatch_event(
        id,
        EventKind::Press,
        EventPayload::Press(Default::default()),
    );
    assert!(fx.app.settle());
    assert!(fx.calls.try_recv().is_err());
    fx.app.compose("label:Message composer", "").unwrap();
    fx.app.wait_for(CONTINUE_ACTION).unwrap();

    let (request, result) = tap_continue(&mut fx, &backend).await;
    assert_eq!(
        request,
        json!({"sessionId":"chat","sourceRunId":DOCK_RUN_ID,"sourceHighWater":7,
        "model":{"connectionId":"test","modelId":"model","serviceTier":"fast"},"thinkingLevel":"high"})
    );
    assert!(!fx.app.screen().enabled("id:chat-primary-action").unwrap());
    let mut run = dock_run();
    run["runId"] = json!("continued-run");
    *fx.run.lock().unwrap() = run;
    let mut execution = stopped_source("admitted");
    execution["runId"] = json!("continued-run");
    result.resolve(json!({"value":{"kind":"started","execution":execution}}));
    fx.app.wait_for("label:Stop current reply").unwrap();
    assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());
    assert!(
        !fx.app
            .screen()
            .matches("id:chat-transcript >> text:Continue reply")
            .unwrap()
    );
    assert!(fx.calls.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continue_blocks_runnable_queue_and_only_retries_a_known_unsubmitted_intent() {
    let backend = dock_model();
    let runnable = json!({"revision":1,"entries":[{"kind":"in_flight","messageId":"in-flight","preview":"Hidden"}]});
    let mut fx = stopped_conversation(runnable, backend.clone(), false).await;
    fx.app.wait_for("text:Interrupted answer").unwrap();
    assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());
    assert!(fx.calls.try_recv().is_err());
    *fx.queue.lock().unwrap() = json!({"revision":2,"entries":[]});
    fx.queue_item(json!({"revision":2,"entries":[]}));
    verify_continue(&mut fx, &backend).await;
    let (request, result) = tap_continue(&mut fx, &backend).await;
    assert_eq!(request["thinkingLevel"], Value::Null);
    result.resolve(json!({"notSubmitted":"The mutation was not confirmed"}));
    fx.app.wait_for(CONTINUE_ACTION).unwrap();
    let (_, result) = tap_continue(&mut fx, &backend).await;
    fx.hold_observe
        .store(true, std::sync::atomic::Ordering::SeqCst);
    result.reject("The confirmation reply was lost");
    fx.app
        .wait_for("text:Continue not confirmed. Refresh to check the reply.")
        .unwrap();
    let (query, observed) = fx.call("observe").await;
    assert_eq!(query, json!({"sessionId":"chat"}));
    observed.resolve(
        json!({"value":{"session":{"id":"chat","kind":"agent","revision":1,
        "title":"Dock Chat","workspace":{"path":"/work"},"backend":backend},"through":2,"run":null,
        "latestRunId":DOCK_RUN_ID}}),
    );
    fx.app.wait_for("label:Send message").unwrap();
    assert!(!fx.app.screen().enabled("id:chat-primary-action").unwrap());
    assert!(
        fx.calls.try_recv().is_err(),
        "an unknown result must only trigger reads, never resend"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_rejection_is_explained_and_old_generation_eligibility_is_ignored() {
    let backend = dock_model();
    let mut fx = stopped_conversation(empty_queue(), backend.clone(), false).await;
    let (_, result) = fx.call("execution").await;
    result.resolve(json!({"value":{"kind":"found","execution":stopped_source("completed")}}));
    assert!(fx.app.settle());
    assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());
    assert!(fx.calls.try_recv().is_err());
    fx.app
        .send_host_event("ios.hostState", dock_host(2))
        .unwrap();
    verify_continue(&mut fx, &backend).await;
    let (_, result) = tap_continue(&mut fx, &backend).await;
    result.resolve(json!({"value":{"kind":"rejected","reason":"workspace_changed"}}));
    fx.app
        .wait_for("text:The workspace changed. Send a new message instead.")
        .unwrap();
    assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());

    fx.app
        .send_host_event("ios.hostState", dock_host(3))
        .unwrap();
    let (_, stale) = fx.call("execution").await;
    let mut offline = side_host_state(4, None);
    offline["connections"]["root"]["autoReconnect"] = json!(false);
    fx.app.send_host_event("ios.hostState", offline).unwrap();
    fx.app.wait_for("text:Host is offline").unwrap();
    stale.resolve(json!({"value":{"kind":"found","execution":stopped_source("cancelled")}}));
    assert!(fx.app.settle());
    assert!(fx.calls.try_recv().is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_rechecks_the_entire_observed_backend_before_submitting() {
    let mut backend = dock_model();
    backend["serviceTier"] = json!("fast");
    let mut fx = stopped_conversation(empty_queue(), backend.clone(), false).await;
    let (_, execution) = fx.call("execution").await;
    let source = stopped_source("cancelled");
    execution.resolve(json!({"value":{"kind":"found","execution":source}}));
    let (_, availability) = fx.call("continuationAvailability").await;
    let mut stale = source.clone();
    stale["highWater"] = json!(6);
    availability.resolve(json!({"value":{"kind":"ready","source":stale}}));
    assert!(fx.app.settle());
    assert!(!fx.app.screen().matches(CONTINUE_ACTION).unwrap());
    assert!(fx.calls.try_recv().is_err());

    fx.app
        .send_host_event("ios.hostState", dock_host(2))
        .unwrap();
    verify_continue(&mut fx, &backend).await;
    backend["thinkingLevel"] = json!("minimal");
    fx.observation.lock().unwrap()["session"] = json!({
        "id":"chat","title":"Dock Chat","kind":"agent","revision":2,
        "workspace":{"path":"/work"},"backend":backend
    });
    fx.app.press(CONTINUE_ACTION).unwrap();
    // The first call after fresh observe must be a new eligibility read,
    // not model resolution or a mutation using the previous preference.
    verify_continue(&mut fx, &backend).await;
    assert!(fx.calls.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_native_steer_uses_the_current_run_and_waits_across_queue_drain() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.app.wait_for("id:chat-context").unwrap(); // Non-compact at the fixture's 390pt width.
    let capsule = "id:chat-composer-input";
    let input = "label:Message composer";
    let bounds = |selector| fx.app.screen().layout(selector).unwrap().unwrap().bounds;
    let (pill, field) = (bounds(capsule), bounds(input));
    let padding = (field.origin.y - pill.origin.y) / 2.;
    assert!(padding > px(0.));
    fx.app
        .press_at(
            capsule,
            nsh_core::Point::new(field.center().x - pill.origin.x, padding),
        )
        .unwrap();
    fx.app.press_key("c").unwrap();
    assert_eq!(fx.app.screen().input_text(input).unwrap(), Some("c"));
    fx.app.press_key("Backspace").unwrap();
    fx.app
        .type_text("label:Message composer", "Change course")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, reply) = fx.call("send").await;
    let input: Send = serde_json::from_value(input).unwrap();
    assert!(matches!(
        input.delivery,
        Some(maka_agent_api::contract::SendDelivery::Steer)
    ));
    assert_eq!(
        input.expected_run_id,
        Some(serde_json::from_value(json!(DOCK_RUN_ID)).unwrap())
    );
    assert!(input.backend.is_none());
    fx.app.wait_for("text:Sending…").unwrap();
    fx.app.wait_for("text:Change course").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("")
    );

    let waiting = "text:Steer · Waiting for next step";
    fx.queue_item(json!({"revision":1,"entries":[
        {"messageId":"m2","kind":"steering","preview":"Change course"},
        {"messageId":"remote","kind":"steering","preview":"Steer from another device"}
    ]}));
    assert!(fx.app.settle());
    assert_eq!(fx.app.screen().count("text:Change course").unwrap(), 1);
    assert!(!fx.app.screen().matches(waiting).unwrap());
    reply.resolve(queued_result("m2", 1));
    fx.app.wait_for("text:Steer from another device").unwrap();
    assert_eq!(fx.app.screen().count("text:Change course").unwrap(), 1);
    assert!(!fx.app.screen().matches("text:1 queued").unwrap());
    fx.queue_item(json!({"revision":2,"entries":[]}));
    let mut probing = Vec::new();
    for _ in 0..2 {
        let (input, reply) = fx.call("queueMessage").await;
        assert_eq!(input["expectedRevision"], 2);
        probing.push((input["messageId"].as_str().unwrap().to_owned(), reply));
    }
    assert!(fx.app.settle());
    assert_eq!(fx.app.screen().count(waiting).unwrap(), 2);

    let mut remote = quote_history_row(3, "user", "Steer from another device");
    remote["messageId"] = json!("remote");
    fx.history
        .lock()
        .unwrap()
        .extend([quote_history_row(2, "user", "Change course"), remote]);
    fx.transcript_changed(3, "transcript_changed");
    fx.app
        .wait_for_gone(waiting, Duration::from_secs(2))
        .unwrap();
    fx.app
        .wait_for("id:chat-transcript >> text:Change course")
        .unwrap();
    fx.app
        .wait_for("id:chat-transcript >> text:Steer from another device")
        .unwrap();
    assert_eq!(fx.app.screen().count("text:Change course").unwrap(), 1);
    for (id, reply) in probing {
        assert!(id == "m2" || id == "remote");
        reply.resolve(missing_queued("delivered"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_executor_steer_that_falls_back_to_queue_hands_off_to_its_entry() {
    let mut run = dock_run();
    run["backend"] = json!("executor");
    let backend = json!({"kind":"executor","selection":{"executor":"codex","settings":{}}});
    let mut fx = ComposerDockFixture::start(run, backend.clone(), empty_queue()).await;
    fx.app
        .type_text("label:Message composer", "Executor follow-up")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["delivery"], "steer");
    assert_eq!(input["expectedRunId"], DOCK_RUN_ID);
    assert_eq!(input["backend"], backend);
    reply.resolve(queued_result("executor-followup", 1));
    let waiting = "text:Steer · Waiting for next step";
    fx.app.wait_for(waiting).unwrap();
    fx.queue_item(json!({"revision":1,"entries":[
        {"messageId":"executor-followup","kind":"followup","preview":"Executor follow-up"}
    ]}));
    fx.app.wait_for("text:1 queued").unwrap();
    fx.app
        .wait_for_gone(waiting, Duration::from_secs(2))
        .unwrap();
    assert_eq!(fx.app.screen().count("text:Executor follow-up").unwrap(), 1);
}

fn assert_embedded_primary(app: &Headless, label: &str) {
    let id = app.screen().id(label).unwrap();
    assert_eq!(id, app.screen().id("id:chat-primary-action").unwrap());
    let capsule = app.screen().id("id:chat-composer-input").unwrap();
    let nodes = app.screen().layout_nodes();
    let action = nodes.iter().find(|node| node.id == id).unwrap();
    let mut inner = action;
    while inner.parent != capsule {
        inner = nodes
            .iter()
            .find(|node| node.id == inner.parent)
            .expect("action outside input pill");
    }
    let pill = nodes.iter().find(|node| node.id == capsule).unwrap().bounds;
    assert!(action.bounds.right() < pill.right() && action.bounds.bottom() < pill.bottom());
    assert_eq!(action.bounds.size, Size::new(px(36.), px(36.)));
}

fn assert_dock_touch_target(app: &Headless, selector: &str) {
    let size = app
        .screen()
        .layout(selector)
        .unwrap()
        .unwrap_or_else(|| panic!("missing touch target: {selector}"))
        .bounds
        .size;
    assert!(
        size.width >= px(44.) && size.height >= px(44.),
        "{selector}: {size:?}"
    );
}

fn native_menu_items(
    app: &mut Headless,
    mut observe: impl FnMut(&nsh_core::MountItem) + std::marker::Send + 'static,
) -> mpsc::UnboundedReceiver<(String, (nsh_core::NodeId, Value))> {
    use nsh_core::MountItem;
    let (menu_tx, menus) = mpsc::unbounded_channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            observe(item);
            if let MountItem::ComponentProps { id, props } = item
                && let Some(items) = props.iter().find_map(|(name, value)| {
                    (name.as_ref() == "items")
                        .then_some(value.as_ref())?
                        .and_then(Value::as_array)
                })
            {
                let actions = items.iter().flat_map(|item| {
                    item["items"]
                        .as_array()
                        .filter(|items| !items.is_empty())
                        .map(|items| items.as_slice())
                        .unwrap_or_else(|| std::slice::from_ref(item))
                });
                for item in actions {
                    if let Some(label) = item["label"].as_str() {
                        menu_tx
                            .send((label.to_owned(), (*id, item["id"].clone())))
                            .unwrap();
                    }
                }
            }
        }
    });
    menus
}

fn select_native_item(app: &mut Headless, (menu, action): (nsh_core::NodeId, Value)) {
    use nsh_core::{EventKind, EventPayload};
    app.engine().control().dispatch_event(
        menu,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "select".into(),
            data: action,
        },
    );
    assert!(app.settle());
}

fn watch_native_menu_items<F>(
    app: &mut Headless,
    observe: F,
) -> impl FnMut(&mut Headless, &str) + use<F>
where
    F: FnMut(&nsh_core::MountItem) + std::marker::Send + 'static,
{
    let mut menus = native_menu_items(app, observe);
    let mut items = BTreeMap::new();
    move |app, label| {
        // Headless has no UIKit presentation. Deliver the installed item
        // through the same selection event UIKit dispatches.
        while let Ok((label, action)) = menus.try_recv() {
            items.insert(label, action);
        }
        let item = items
            .get(label)
            .cloned()
            .unwrap_or_else(|| panic!("missing native menu item: {label}"));
        select_native_item(app, item);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_explicit_queue_can_promote_review_edit_and_retract() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    let mut choose_menu_item = watch_native_menu_items(&mut fx.app, |_| {});
    fx.app
        .type_text("label:Message composer", "Handle it later")
        .unwrap();
    fx.app.long_press("label:Send message").unwrap();
    assert!(
        fx.calls.try_recv().is_err(),
        "long press also sent the message"
    );
    choose_menu_item(&mut fx.app, "Add to queue");
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["delivery"], "queue");
    assert_eq!(input["expectedRunId"], DOCK_RUN_ID);
    assert_eq!(input["backend"], dock_model());
    let queue = json!({"revision":1,"entries":[
        {"messageId":"running","kind":"in_flight","preview":"Running already"},
        {"messageId":"system","kind":"followup","preview":"Completion","origin":{"kind":"session_completion"}},
        {"messageId":"q1","kind":"followup","preview":"Handle it later"},
        {"messageId":"q2","kind":"held","preview":"Other work"}
    ]});
    // The watch can beat the receipt, and the post-send query can lag both.
    fx.queue_item(queue.clone());
    fx.app.wait_for("text:2 queued").unwrap();
    reply.resolve(queued_result("q1", 1));
    fx.app
        .wait_for_gone("text:Sending…", Duration::from_secs(2))
        .unwrap();
    assert_eq!(fx.app.screen().count("text:Handle it later").unwrap(), 1);
    assert!(!fx.app.screen().matches("label:Steer now").unwrap());

    fx.app.press("label:Queued Messages (2)").unwrap();
    assert!(!fx.app.screen().matches("text:Running already").unwrap());
    assert!(!fx.app.screen().matches("text:Completion").unwrap());
    for label in ["Steer now", "Edit queued message", "Remove queued message"] {
        assert_dock_touch_target(&fx.app, &format!("label:{label} >> nth=0"));
    }
    fx.app.press("label:Steer now >> nth=0").unwrap();
    let (input, reply) = fx.call("editQueue").await;
    let promote: QueueMutation = serde_json::from_value(input).unwrap();
    assert_eq!(promote.expected_revision, 1);
    assert!(matches!(promote.edit, QueueAction::Promote {message_id} if message_id == "q1"));
    let snapshot = |revision, text| {
        json!({"revision":revision,"entries":[
            {"messageId":"q2","kind":"held","preview":text}
        ]})
    };
    *fx.queue.lock().unwrap() = snapshot(2, "Other work");
    reply.resolve(json!({"value": QueueMutationResult::Committed {revision:2}}));
    fx.app.wait_for("text:1 queued").unwrap();

    fx.app.press("label:Edit queued message").unwrap();
    let (read, reply) = fx.call("queueMessage").await;
    assert_eq!(
        read,
        json!({"sessionId":"chat","messageId":"q2","expectedRevision":2})
    );
    let ready = |revision, message| {
        json!({"value":{"kind":"ready","revision":revision,
        "message":message,"hasAttachments":false,"quotes":[]}})
    };
    reply.resolve(ready(2, "Other work"));
    let editor = "id:queue-message-editor";
    fx.app.wait_for(editor).unwrap();
    fx.app.type_text(editor, " plus tests").unwrap();
    let edited = fx
        .app
        .screen()
        .input_text(editor)
        .unwrap()
        .unwrap()
        .to_owned();
    assert!(edited.contains("plus tests"));
    fx.app.compose(editor, "未提交").unwrap();
    assert!(!fx.app.screen().enabled("label:Save").unwrap());
    assert!(fx.app.press("label:Save").is_err());
    assert!(
        fx.calls.try_recv().is_err(),
        "an IME composition committed a partial edit"
    );
    fx.app.compose(editor, "").unwrap();
    fx.app.press("label:Save").unwrap();
    let (update, reply) = fx.call("editQueue").await;
    assert_eq!(
        update,
        json!({"sessionId":"chat","expectedRevision":2,
        "edit":{"kind":"update","messageId":"q2","message":edited}})
    );

    *fx.queue.lock().unwrap() = snapshot(3, "Changed elsewhere");
    reply.resolve(json!({"value": QueueMutationResult::RevisionConflict {expected:2,actual:3}}));
    fx.app
        .wait_for("text:The queue changed. Review the current message before trying again.")
        .unwrap();
    fx.app.wait_for("label:Review latest").unwrap();
    assert_eq!(
        fx.app.screen().input_text(editor).unwrap(),
        Some(edited.as_str())
    );
    assert!(fx.app.screen().matches("label:Copy edit").unwrap());
    fx.app.press("label:Review latest").unwrap();
    let (read, reply) = fx.call("queueMessage").await;
    assert_eq!(read["expectedRevision"], 3);
    reply.resolve(ready(3, "Changed elsewhere"));
    fx.app.wait_for("text:Changed elsewhere").unwrap();
    fx.app.press("label:Keep my edit").unwrap();
    fx.app.press("label:Save").unwrap();
    let (update, reply) = fx.call("editQueue").await;
    assert_eq!(update["expectedRevision"], 3);
    assert_eq!(update["edit"]["message"], edited);
    *fx.queue.lock().unwrap() = snapshot(4, &edited);
    reply.resolve(json!({"value": QueueMutationResult::Committed {revision:4}}));
    fx.app.wait_for("label:Remove queued message").unwrap();

    fx.app.press("label:Remove queued message").unwrap();
    let (retract, reply) = fx.call("editQueue").await;
    assert_eq!(
        retract,
        json!({"sessionId":"chat","expectedRevision":4,
        "edit":{"kind":"retract","messageId":"q2"}})
    );
    *fx.queue.lock().unwrap() = json!({"revision":5,"entries":[]});
    reply.resolve(json!({"value": QueueMutationResult::Committed {revision:5}}));
    fx.app
        .wait_for_gone("text:1 queued", Duration::from_secs(2))
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn floating_dock_moves_tail_clearance_and_latest_with_its_measured_height() {
    use nsh_core::{
        Filter, GlassEffect, MountItem,
        canvas::{CanvasOp, Paint},
        platform::ColorScheme,
    };

    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    let styles = Arc::new(std::sync::Mutex::new(BTreeMap::new()));
    let strokes = Arc::new(std::sync::Mutex::new(BTreeMap::new()));
    let (mounted_styles, mounted_strokes) = (styles.clone(), strokes.clone());
    fx.app.observe(move |_, batch| {
        for item in &batch.items {
            match item {
                MountItem::ViewStyle { id, style } => {
                    let blur = style.effects.as_ref().is_some_and(|effects| {
                        effects.backdrop_filters.iter().any(
                            |filter| matches!(filter, Filter::Blur(radius) if *radius > px(0.)),
                        )
                    });
                    mounted_styles
                        .lock()
                        .unwrap()
                        .insert(*id, (style.glass_effect, blur));
                }
                MountItem::Canvas { id, drawing } => {
                    if let Some(color) = drawing.ops.iter().find_map(|op| match op {
                        CanvasOp::StrokeStyle(Paint::Color(color)) => Some(*color),
                        _ => None,
                    }) {
                        mounted_strokes.lock().unwrap().insert(*id, color);
                    }
                }
                _ => {}
            }
        }
    });
    fx.history.lock().unwrap().extend((2..=18).map(|n| {
        let mut row = quote_history_row(n, "user", &format!("Earlier dock message {n}"));
        row["turnId"] = json!(format!("dock-turn-{n}"));
        row
    }));
    fx.transcript_changed(18, "transcript_changed");
    let tail = "id:chat-transcript >> text:Earlier dock message 18";
    fx.app.wait_for(tail).unwrap();

    let bounds = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap().bounds;
    let composer = |app: &Headless| bounds(app, "id:chat-composer");
    let gap = |app: &Headless| {
        let row = bounds(app, tail);
        composer(app).origin.y - row.origin.y - row.size.height
    };
    let original_gap = gap(&fx.app);
    assert!(original_gap >= px(0.));
    let empty = composer(&fx.app);
    fx.queue_item(json!({"revision":1,"entries":[
        {"messageId":"steer","kind":"steering","preview":"Change direction"},
        {"messageId":"later","kind":"followup","preview":"Work to revisit"}
    ]}));
    fx.app
        .wait_for("text:Steer · Waiting for next step")
        .unwrap();
    fx.app.wait_for("label:Queued Messages (1)").unwrap();
    assert!(composer(&fx.app).origin.y < empty.origin.y);
    assert_eq!(gap(&fx.app), original_gap);

    let latest = "label:Scroll to latest";
    let collapsed = composer(&fx.app);
    fx.app.scroll("id:chat-transcript", px(-350.)).unwrap();
    let scrolled = composer(&fx.app);
    let previous_arrow = bounds(&fx.app, latest);
    fx.app.press("label:Queued Messages (1)").unwrap();
    let expanded = composer(&fx.app);
    let arrow = bounds(&fx.app, latest);
    let dock = bounds(&fx.app, "id:composer-pending-dock");
    assert!(expanded.size.height > scrolled.size.height);
    assert_eq!(
        previous_arrow.origin.y - arrow.origin.y,
        expanded.size.height - scrolled.size.height
    );
    assert!(arrow.origin.y + arrow.size.height <= dock.origin.y);
    assert!(
        (arrow.center().x - bounds(&fx.app, "id:chat-transcript").center().x)
            .0
            .abs()
            <= 1.
    );
    for label in ["Steer now", "Edit queued message", "Remove queued message"] {
        assert_dock_touch_target(&fx.app, &format!("label:{label}"));
    }
    assert_eq!(arrow.size, Size::new(px(40.), px(40.)));
    let id = fx.app.screen().id(latest).unwrap();
    let canvas = fx
        .app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|node| node.parent == id && node.kind == nsh_core::ViewKind::Canvas)
        .unwrap()
        .id;
    let control = fx.app.engine().control();
    use nsh_core::tailwind::state::PRESSED;
    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        fx.app
            .set_environment("appearance", |env| env.color_scheme = scheme)
            .unwrap();
        let mut fills = [0; 2];
        for (fill, state) in fills.iter_mut().zip([0, PRESSED]) {
            control.set_states(id, state);
            assert!(fx.app.settle());
            assert_eq!(styles.lock().unwrap()[&id], (GlassEffect::Regular, true));
            let style = fx.app.screen().view_style(latest).unwrap().unwrap();
            assert_eq!(style.effective_opacity, 1.);
            *fill = style.background_color.unwrap();
            let (r, g, b, a) = nsh_core::Color(*fill).to_f64();
            if state == 0 {
                assert!(a > 0. && a < 1., "resting fill must reveal the glass");
            }
            let (fr, fg, fb, fa) = strokes.lock().unwrap()[&canvas].to_f64();
            assert_eq!(fa, 1.);
            let fg = relative_luminance([fr, fg, fb]);
            // UIKit paints the tint over the material. Bound its contrast
            // even when the material underneath is pure black or white.
            for backdrop in [0., 1.] {
                let bg = relative_luminance([r, g, b].map(|c| c * a + backdrop * (1. - a)));
                let ratio = (fg.max(bg) + 0.05) / (fg.min(bg) + 0.05);
                assert!(
                    ratio >= 4.5,
                    "{scheme:?}, state={state}, backdrop={backdrop}: {ratio:.2}:1"
                );
            }
        }
        assert_ne!(fills[0], fills[1], "no pressed feedback");
        control.set_states(id, 0);
        assert!(fx.app.settle());
    }
    fx.app.press(latest).unwrap();
    assert_eq!(gap(&fx.app), original_gap);
    fx.app.press("label:Queued Messages (1)").unwrap();
    assert_eq!(composer(&fx.app), collapsed);
    assert_eq!(gap(&fx.app), original_gap);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inline_queue_editor_keeps_its_focus_and_saves_above_the_portrait_keyboard() {
    let queue = json!({"revision":1,"entries":[
        {"messageId":"later","kind":"followup","preview":"Work to revisit"}
    ]});
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), queue.clone()).await;
    fx.app.set_viewport(Size::new(px(390.), px(780.))).unwrap();
    fx.app.press("label:Queued Messages (1)").unwrap();
    open_queue_editor(&mut fx).await;

    let editor = "id:queue-message-editor";
    let id = fx.app.screen().id(editor).unwrap();
    fx.app.type_text(editor, " first").unwrap();
    let text = fx
        .app
        .screen()
        .input_text(editor)
        .unwrap()
        .unwrap()
        .to_owned();
    fx.app
        .set_environment("portrait keyboard", |env| env.keyboard_height = px(336.))
        .unwrap();
    assert_eq!(fx.app.screen().id(editor).unwrap(), id);
    assert_eq!(
        fx.app.screen().input_text(editor).unwrap(),
        Some(text.as_str())
    );
    fx.app.press_key("x").unwrap();
    let changed = fx
        .app
        .screen()
        .input_text(editor)
        .unwrap()
        .unwrap()
        .to_owned();
    assert_ne!(
        text, changed,
        "the same queue editor must still receive keystrokes"
    );
    for selector in [editor, "label:Save", "label:Cancel"] {
        assert_keyboard_target(&fx.app, selector, 0., 390., 444.);
    }
    fx.app.press("label:Save").unwrap();
    confirm_queue_edit(&mut fx, queue, &changed).await;
}

async fn open_queue_editor(fx: &mut ComposerDockFixture) {
    fx.app
        .press_at(
            "label:Edit queued message",
            nsh_core::Point::new(px(22.), px(22.)),
        )
        .unwrap();
    let (input, reply) = fx.call("queueMessage").await;
    assert_eq!(input["messageId"], "later");
    reply.resolve(
        json!({"value":{"kind":"ready","revision":1,"message":"Work to revisit",
        "hasAttachments":false,"quotes":[]}}),
    );
    fx.app.wait_for("id:queue-message-editor").unwrap();
}

async fn confirm_queue_edit(fx: &mut ComposerDockFixture, mut queue: Value, edited: &str) {
    let (input, reply) = fx.call("editQueue").await;
    assert_eq!(
        input,
        json!({"sessionId":"chat","expectedRevision":1,
        "edit":{"kind":"update","messageId":"later","message":edited}})
    );
    queue["revision"] = json!(2);
    queue["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["messageId"] == "later")
        .unwrap()["preview"] = json!(edited);
    *fx.queue.lock().unwrap() = queue;
    reply.resolve(json!({"value":QueueMutationResult::Committed { revision: 2 }}));
    fx.app
        .wait_for_gone("id:queue-message-editor", Duration::from_secs(2))
        .unwrap();
}

fn assert_keyboard_target(
    app: &Headless,
    selector: &str,
    left: f32,
    right: f32,
    keyboard_top: f32,
) {
    let layout = app.screen().layout(selector).unwrap().unwrap();
    let b = layout.bounds;
    assert!(
        !layout.clipped
            && b.origin.y >= px(0.)
            && b.origin.y + b.size.height <= px(keyboard_top)
            && b.origin.x >= px(left)
            && b.origin.x + b.size.width <= px(right),
        "{selector}: {layout:?}, safe x={left}..{right}, keyboard top={keyboard_top}"
    );
}

fn reveal_sheet_target(app: &mut Headless, scroll: &str, selector: &str) {
    let bounds = |app: &Headless, s| app.screen().layout(s).unwrap().unwrap().bounds;
    let port = bounds(app, scroll);
    let target = bounds(app, selector);
    let overflow = target.origin.y + target.size.height - (port.origin.y + port.size.height);
    if overflow > px(0.) {
        app.scroll(scroll, overflow + px(1.)).unwrap();
    } else if target.origin.y < port.origin.y {
        app.scroll(scroll, target.origin.y - port.origin.y - px(1.))
            .unwrap();
    }
    assert_keyboard_target(app, selector, 47., 797., 150.);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_keyboard_keeps_pending_dock_and_quotes_out_of_the_composer_row() {
    let queue = json!({"revision":1,"entries":[
        {"messageId":"steer","kind":"steering","preview":"Change direction"},
        {"messageId":"later","kind":"followup","preview":"Work to revisit"}
    ]});
    let mut fx =
        ComposerDockFixture::start_with_anchor(dock_run(), dock_model(), queue.clone(), true).await;
    let input = "label:Message composer";
    let composer_input = fx.app.screen().id(input).unwrap();
    let (blur_tx, mut blurs) = mpsc::unbounded_channel();
    let mut choose_menu_item = watch_native_menu_items(&mut fx.app, move |item| {
        if let nsh_core::MountItem::Command {
            id,
            command: nsh_core::Command::Blur,
        } = item
            && *id == composer_input
        {
            blur_tx.send(()).unwrap();
        }
    });
    fx.app
        .type_text("label:Message composer", "A message to recover")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, rejected) = fx.call("send").await;
    rejected
        .resolve(json!({"value":{"kind":"rejected","sessionId":"chat","reason":"turn_stopped"}}));
    fx.app.wait_for("label:Retry").unwrap();
    fx.app.press("role:button[Quote]").unwrap();
    fx.app.set_viewport(Size::new(px(844.), px(390.))).unwrap();
    fx.app
        .set_environment("landscape keyboard and safe area", |env| {
            env.keyboard_height = px(240.);
            env.safe_area.left = px(47.);
            env.safe_area.right = px(47.);
        })
        .unwrap();
    let bounds = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap().bounds;
    let composer = bounds(&fx.app, "id:chat-composer");
    let header = bounds(&fx.app, "label:Chats");
    assert_eq!(composer.origin.y + composer.size.height, px(150.));
    assert!(composer.origin.y - header.origin.y - header.size.height >= px(44.));
    for selector in [
        "id:chat-composer-actions",
        "id:chat-composer-input",
        "label:Send message",
    ] {
        if selector != "label:Send message" {
            assert_dock_touch_target(&fx.app, selector);
        }
        let button = bounds(&fx.app, selector);
        assert!(button.origin.x >= px(47.) && button.origin.x + button.size.width <= px(797.));
        assert!(
            button.origin.y >= composer.origin.y
                && button.origin.y + button.size.height <= px(150.)
        );
    }
    assert!(!fx.app.screen().matches("id:composer-pending-dock").unwrap());
    while blurs.try_recv().is_ok() {}
    fx.app.type_text(input, "Steer").unwrap();
    choose_menu_item(&mut fx.app, "Queued Messages (1)");
    assert!(
        blurs.try_recv().is_err(),
        "opening Pending blurred the composer"
    );
    fx.app
        .wait_for("text:Steer · Waiting for next step")
        .unwrap();
    assert_keyboard_target(&fx.app, "label:Done", 47., 797., 150.);
    let pending = "id:chat-pending-sheet-scroll";
    reveal_sheet_target(&mut fx.app, pending, "label:Edit");
    reveal_sheet_target(&mut fx.app, pending, "label:Edit queued message");
    open_queue_editor(&mut fx).await;
    let editor = "id:queue-message-editor";
    reveal_sheet_target(&mut fx.app, pending, editor);
    fx.app.type_text(editor, " in landscape").unwrap();
    let edited = fx
        .app
        .screen()
        .input_text(editor)
        .unwrap()
        .unwrap()
        .to_owned();
    reveal_sheet_target(&mut fx.app, pending, "label:Save");
    assert_dock_touch_target(&fx.app, "label:Save");
    fx.app.press("label:Save").unwrap();
    confirm_queue_edit(&mut fx, queue, &edited).await;
    fx.app.press("label:Done").unwrap();
    fx.app.type_text(input, " with").unwrap();
    choose_menu_item(&mut fx.app, "Quote");
    assert!(
        blurs.try_recv().is_err(),
        "opening Quote blurred the composer"
    );
    fx.app
        .wait_for("label:Remove quote: An earlier answer")
        .unwrap();
    assert_keyboard_target(&fx.app, "label:Done", 47., 797., 150.);
    reveal_sheet_target(
        &mut fx.app,
        "id:chat-quote-sheet-scroll",
        "label:Remove quote: An earlier answer",
    );
    fx.app
        .press("label:Remove quote: An earlier answer")
        .unwrap();
    fx.app
        .wait_for_gone(
            "label:Remove quote: An earlier answer",
            Duration::from_secs(2),
        )
        .unwrap();
    fx.app.press("label:Done").unwrap();
    fx.app.press("role:button[Quote]").unwrap();
    assert_eq!(bounds(&fx.app, "id:chat-composer"), composer);

    fx.app.type_text(input, " this quote").unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["delivery"], "steer");
    assert_eq!(input["message"], "Steer with this quote");
    assert_eq!(input["quotes"][0]["text"], "An earlier answer");
    reply.resolve(queued_result("compact-steer", 3));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_stopped_send_can_restore_retry_or_dismiss_without_losing_the_next_draft() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.app.press("role:button[Quote]").unwrap();
    fx.app
        .type_text("label:Message composer", "First draft")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["quotes"][0]["text"], "An earlier answer");
    fx.app
        .type_text("label:Message composer", "Next draft")
        .unwrap();
    fx.app.press("role:button[Quote]").unwrap();
    let stopped =
        || json!({"value":{"kind":"rejected","sessionId":"chat","reason":"turn_stopped"}});
    let kept = "text:Stopped before delivery. Your message is kept.";
    reply.resolve(stopped());
    fx.app.wait_for(kept).unwrap();
    fx.app.press("label:Edit").unwrap();
    fx.app.wait_for_gone(kept, Duration::from_secs(2)).unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Next draft\n\nFirst draft")
    );
    fx.app.wait_for("text:1 quote").unwrap();

    fx.app.press("label:Send message").unwrap();
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["quotes"].as_array().unwrap().len(), 1);
    reply.resolve(stopped());
    fx.app.wait_for(kept).unwrap();
    *fx.run.lock().unwrap() = Value::Null;
    // No run-ended watch item has arrived yet; Retry must resolve the current turn.
    fx.app.press("label:Retry").unwrap();
    let (retry, reply) = fx.call("send").await;
    assert_eq!(retry["message"], input["message"]);
    assert_eq!(retry["quotes"], input["quotes"]);
    assert!(retry["expectedRunId"].is_null());
    assert_eq!(retry["backend"], dock_model());

    reply.reject("Host disconnected before the send reply");
    let unknown = "text:Could not confirm whether the message was sent. Check the conversation or queue before retrying.";
    fx.app.wait_for(unknown).unwrap();
    assert!(!fx.app.screen().matches("label:Retry").unwrap());
    fx.app.press("label:Dismiss").unwrap();
    fx.app
        .wait_for_gone(unknown, Duration::from_secs(2))
        .unwrap();
    assert!(fx.calls.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_queue_fetches_on_connection_and_ignores_older_watch_revisions() {
    let queue = |revision, text| {
        json!({"revision":revision,"entries":[
            {"messageId":"q","kind":"followup","preview":text}
        ]})
    };
    let mut fx =
        ComposerDockFixture::start(Value::Null, dock_model(), queue(10, "Initial queue")).await;
    fx.app.wait_for("text:Initial queue").unwrap();
    fx.queue_item(queue(12, "Latest queue"));
    fx.app.wait_for("text:Latest queue").unwrap();
    fx.queue_item(queue(11, "Stale queue"));
    assert!(fx.app.settle());
    assert!(!fx.app.screen().matches("text:Stale queue").unwrap());
    assert!(fx.app.screen().matches("text:Latest queue").unwrap());

    *fx.queue.lock().unwrap() = queue(2, "New connection queue");
    fx.app
        .send_host_event("ios.hostState", dock_host(2))
        .unwrap();
    fx.app.wait_for("text:New connection queue").unwrap();
    fx.queue_item(queue(13, "Old connection queue"));
    fx.watch = fixture_recv(&mut fx.watches).await;
    fx.queue_item(queue(1, "Stale queue"));
    assert!(fx.app.settle());
    assert!(
        fx.app
            .screen()
            .matches("text:New connection queue")
            .unwrap()
    );
    assert!(
        !fx.app
            .screen()
            .matches("text:Old connection queue")
            .unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_idle_projection_counts_identical_prompts_once_each_when_history_beats_the_receipt() {
    let mut fx = ComposerDockFixture::start(Value::Null, dock_model(), empty_queue()).await;
    fx.history
        .lock()
        .unwrap()
        .insert(0, quote_history_row(0, "user", "Repeat prompt"));
    fx.transcript_changed(1, "transcript_changed");
    let message = "id:chat-transcript >> text:Repeat prompt";
    fx.app.wait_for(message).unwrap();
    let _ = fixture_recv(&mut fx.history_reads).await;

    fx.app
        .type_text("label:Message composer", "Repeat prompt")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["delivery"], "steer");
    assert!(input["expectedRunId"].is_null());
    assert_eq!(fx.app.screen().count(message).unwrap(), 2);

    let mut next = quote_history_row(2, "user", "Repeat prompt");
    next["turnId"] = json!("t2");
    let mut answer = quote_history_row(3, "assistant", "Durable reply");
    answer["turnId"] = json!("t2");
    fx.history.lock().unwrap().extend([next, answer]);
    fx.transcript_changed(3, "transcript_changed");
    fixture_recv(&mut fx.history_reads).await;
    assert!(fx.app.settle());
    assert_eq!(
        fx.app.screen().count(message).unwrap(),
        2,
        "history beat the receipt; exactly one optimistic prompt should be visible"
    );

    reply.resolve(queued_result("m2", 1));
    fx.app.wait_for("text:Durable reply").unwrap();
    assert_eq!(
        fx.app.screen().count(message).unwrap(),
        2,
        "the two distinct prompts must not collapse by text"
    );
    assert!(
        !fx.app
            .screen()
            .matches("text:Steer · Waiting for next step")
            .unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_steer_recovers_the_snapshot_after_the_queue_revision_changes() {
    let mut fx =
        ComposerDockFixture::start_with_anchor(dock_run(), dock_model(), empty_queue(), true).await;
    fx.app
        .wait_for("label:Side questions (1) · Waiting for your response")
        .unwrap();
    fx.app
        .press("label:Side questions (1) · Waiting for your response")
        .unwrap();
    fx.app.wait_for("text:Side Question · Dock Chat").unwrap();
    fx.app.press("label:Bring to Main Draft").unwrap();
    fx.app
        .wait_for("label:Remove conversation link: Saved side question")
        .unwrap();

    fx.app.press("role:button[Quote] >> nth=0").unwrap();
    fx.app
        .type_text("label:Message composer", "Don't lose this")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (original, receipt) = fx.call("send").await;
    assert_eq!(original["quotes"][0]["text"], "An earlier answer");
    assert_eq!(
        original["message"],
        "Don't lose this [@Saved side question](maka://session/saved)"
    );
    receipt.resolve(queued_result("steering", 1));
    fx.queue_item(json!({"revision":1,"entries":[
        {"messageId":"steering","kind":"steering","preview":"Don't lose this"}
    ]}));
    let waiting = "text:Steer · Waiting for next step";
    fx.app.wait_for(waiting).unwrap();

    fx.app.press("label:Stop current reply").unwrap();
    let (stop, reply) = fx.call("stop").await;
    assert_eq!(stop["runId"], DOCK_RUN_ID);
    *fx.run.lock().unwrap() = Value::Null;
    reply.resolve(json!({"value":{"requested":true}}));
    fx.queue_item(json!({"revision":2,"entries":[]}));
    fx.transcript_changed(2, "ended");
    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(
        probe,
        json!({"sessionId":"chat","messageId":"steering","expectedRevision":2})
    );
    *fx.queue.lock().unwrap() = json!({"revision":3,"entries":[]});
    reply.resolve(json!({"value":QueueMutationResult::RevisionConflict {expected:2,actual:3}}));
    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(probe["expectedRevision"], 3);
    reply.resolve(missing_queued("cancelled"));

    let kept = "text:Stopped before delivery. Your message is kept.";
    fx.app.wait_for(kept).unwrap();
    assert!(!fx.app.screen().matches(waiting).unwrap());
    for label in ["Edit", "Retry", "Dismiss"] {
        assert_dock_touch_target(&fx.app, &format!("label:{label}"));
    }
    fx.app.press("label:Retry").unwrap();
    let (retry, reply) = fx.call("send").await;
    assert_eq!(retry["message"], original["message"]);
    assert_eq!(retry["quotes"], original["quotes"]);
    assert!(retry["expectedRunId"].is_null());
    reply.resolve(
        json!({"value":{"kind":"rejected","sessionId":"chat","reason":"model_unavailable"}}),
    );
    fx.app
        .wait_for("text:The selected model is unavailable. Try again or choose another model.")
        .unwrap();

    fx.app.press("label:Edit").unwrap();
    fx.app
        .wait_for("label:Remove quote: An earlier answer")
        .unwrap();
    fx.app
        .wait_for("label:Remove conversation link: Saved side question")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Don't lose this")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_does_not_retarget_when_the_run_ends_during_backend_preflight() {
    let mut run = dock_run();
    run["backend"] = json!("executor");
    let mut fx = ComposerDockFixture::start(run, Value::Null, empty_queue()).await;
    fx.app
        .type_text("label:Message composer", "Only for this turn")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, default_model) = fx.call("resolveModel").await;
    *fx.run.lock().unwrap() = Value::Null;
    fx.transcript_changed(2, "ended");
    assert!(fx.app.settle());
    default_model.resolve(json!({"value":{"kind":"ready","choice":{"selection":{"connectionId":"test","modelId":"model"}}}}));

    fx.app
        .wait_for("text:Stopped before delivery. Your message is kept.")
        .unwrap();
    assert!(
        fx.calls.try_recv().is_err(),
        "send silently started a new turn"
    );
    fx.app.press("label:Edit").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Only for this turn")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopened_chat_checks_delivery_when_accepted_sends_are_outside_the_history_page() {
    for run in [Value::Null, dock_run()] {
        let idle = run.is_null();
        let mut fx = ComposerDockFixture::start(run, dock_model(), empty_queue()).await;
        fx.app
            .type_text("label:Message composer", "Old submission")
            .unwrap();
        fx.app.press("label:Send message").unwrap();
        let (_, receipt) = fx.call("send").await;
        receipt.resolve(queued_result("m2", 1));
        fx.app
            .wait_until("send acknowledged", Duration::from_secs(2), |screen| {
                if idle {
                    screen
                        .matches("id:chat-transcript >> text:Old submission")
                        .unwrap()
                } else {
                    screen
                        .matches("text:Steer · Waiting for next step")
                        .unwrap()
                }
            })
            .unwrap();
        fx.app.press("label:Chats").unwrap();

        *fx.history.lock().unwrap() = vec![quote_history_row(12, "assistant", "Newer tail")];
        *fx.queue.lock().unwrap() = json!({"revision":2,"entries":[]});
        *fx.run.lock().unwrap() = Value::Null;
        fx.app.press("label:Conversation: Dock Chat").unwrap();
        fx.app.wait_for("text:Newer tail").unwrap();
        assert!(
            !fx.app
                .screen()
                .matches("id:chat-transcript >> text:Old submission")
                .unwrap()
        );
        let (probe, reply) = fx.call("queueMessage").await;
        assert_eq!(probe["messageId"], "m2");
        assert_eq!(probe["expectedRevision"], 2);
        reply.resolve(missing_queued("delivered"));
        fx.app
            .wait_for_gone("text:Old submission", Duration::from_secs(2))
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quoted_multiline_draft_keeps_the_primary_send_and_its_menu() {
    let mut fx =
        ComposerDockFixture::start_with_anchor(dock_run(), dock_model(), empty_queue(), true).await;
    let mut choose_menu_item = watch_native_menu_items(&mut fx.app, |_| {});
    fx.app.press("role:button[Quote] >> nth=0").unwrap();
    fx.app.wait_for("label:Ask Side Question").unwrap();
    for width in [375., 390., 430.] {
        fx.app.set_viewport(Size::new(px(width), px(844.))).unwrap();
        assert_embedded_primary(&fx.app, "label:Send message");
    }
    fx.app
        .type_text(
            "label:Message composer",
            "First line\nSecond line\nThird line",
        )
        .unwrap();
    fx.app.long_press("label:Send message").unwrap();
    assert!(fx.calls.try_recv().is_err());
    choose_menu_item(&mut fx.app, "Add to queue");
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["delivery"], "queue");
    assert_eq!(input["expectedRunId"], DOCK_RUN_ID);
    assert_eq!(input["quotes"][0]["text"], "An earlier answer");
    assert_eq!(input["message"], "First line\nSecond line\nThird line");
    reply.resolve(queued_result("quote", 1));
}

const DOCK_WAITING: &str = "text:Steer · Waiting for next step";
const DOCK_UNCONFIRMED: &str = "text:Could not confirm whether the message was sent. Check the conversation or queue before retrying.";

async fn accept_dock_steer(fx: &mut ComposerDockFixture) {
    fx.app
        .type_text("label:Message composer", "Keep these words")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, reply) = fx.call("send").await;
    reply.resolve(queued_result("m2", 1));
    fx.queue_item(json!({"revision":1,"entries":[
        {"messageId":"m2","kind":"steering","preview":"Keep these words"}
    ]}));
    fx.app.wait_for(DOCK_WAITING).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_steer_with_interrupted_verification_is_recoverable_and_can_be_rechecked() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.app.press("role:button[Quote] >> nth=0").unwrap();
    accept_dock_steer(&mut fx).await;
    fx.app.press("label:Stop current reply").unwrap();
    let (_, stop) = fx.call("stop").await;
    *fx.run.lock().unwrap() = Value::Null;
    stop.resolve(json!({"value":{"requested":true}}));
    let drained = json!({"revision":2,"entries":[]});
    fx.queue_item(drained.clone());
    fx.transcript_changed(2, "ended");
    fx.app
        .wait_for_gone("label:Stop current reply", Duration::from_secs(2))
        .unwrap();
    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(probe["expectedRevision"], 2);
    reply.reject("Host queueMessage timed out");

    fx.app.wait_for(DOCK_UNCONFIRMED).unwrap();
    assert!(!fx.app.screen().matches(DOCK_WAITING).unwrap());
    assert!(!fx.app.screen().matches("label:Retry").unwrap());
    assert!(
        fx.calls.try_recv().is_err(),
        "verification must not retry without a fresh snapshot"
    );
    fx.queue_item(drained);
    let (rechecked, reply) = fx.call("queueMessage").await;
    assert_eq!(rechecked, probe);
    reply.resolve(missing_queued("unknown"));
    fx.app.press("label:Edit").unwrap();
    fx.app
        .wait_for("label:Remove quote: An earlier answer")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep these words")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unconfirmed_local_steer_replaces_its_watch_pill_and_dismisses_both() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    accept_dock_steer(&mut fx).await;
    fx.queue_item(json!({"revision":2,"entries":[]}));
    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(probe["messageId"], "m2");
    reply.resolve(missing_queued("unknown"));

    fx.app.wait_for(DOCK_UNCONFIRMED).unwrap();
    assert_eq!(fx.app.screen().count("text:Keep these words").unwrap(), 1);
    assert!(!fx.app.screen().matches(DOCK_WAITING).unwrap());
    fx.app.press("label:Dismiss").unwrap();
    fx.app
        .wait_for_gone(DOCK_UNCONFIRMED, Duration::from_secs(2))
        .unwrap();
    assert_eq!(fx.app.screen().count("text:Keep these words").unwrap(), 0);
    assert!(!fx.app.screen().matches(DOCK_WAITING).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_steer_delivery_holds_the_pill_until_the_transcript_can_replace_it() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    fx.queue_item(json!({"revision":1,"entries":[
        {"messageId":"m2","kind":"steering","preview":"A remote steer"}
    ]}));
    fx.app.wait_for("text:A remote steer").unwrap();
    fx.queue_item(json!({"revision":2,"entries":[]}));
    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(probe["messageId"], "m2");
    fx.hold_history
        .store(true, std::sync::atomic::Ordering::SeqCst);
    reply.resolve(missing_queued("delivered"));
    let (tail, refresh) = fx.call("history").await;
    assert_eq!(tail["position"]["kind"], "tail");
    assert!(fx.app.settle());
    assert_eq!(fx.app.screen().count(DOCK_WAITING).unwrap(), 1);
    assert_eq!(fx.app.screen().count("text:A remote steer").unwrap(), 1);

    refresh.resolve(history_page(
        1,
        fx.history.lock().unwrap().clone(),
        Value::Null,
    ));
    assert!(fx.app.settle());
    assert_eq!(
        fx.app.screen().count(DOCK_WAITING).unwrap(),
        1,
        "an unchanged tail is not a handoff"
    );
    fx.history
        .lock()
        .unwrap()
        .push(quote_history_row(2, "user", "A remote steer"));
    fx.transcript_changed(2, "transcript_changed");
    fx.app
        .wait_for("id:chat-transcript >> text:A remote steer")
        .unwrap();
    assert_eq!(fx.app.screen().count("text:A remote steer").unwrap(), 1);
    assert!(!fx.app.screen().matches(DOCK_WAITING).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopened_chat_keeps_pending_idle_projection_until_the_original_receipt() {
    let mut fx = ComposerDockFixture::start(Value::Null, dock_model(), empty_queue()).await;
    fx.app
        .type_text("label:Message composer", "Pending submission")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, receipt) = fx.call("send").await;
    let prompt = "id:chat-transcript >> text:Pending submission";
    fx.app.wait_for(prompt).unwrap();
    fx.app.press("label:Chats").unwrap();
    fx.app.press("label:Conversation: Dock Chat").unwrap();
    fx.app.wait_for("text:An earlier answer").unwrap();
    fx.app.wait_for(prompt).unwrap();
    fx.watch = fixture_recv(&mut fx.watches).await;

    fx.history
        .lock()
        .unwrap()
        .push(quote_history_row(2, "user", "Pending submission"));
    fx.transcript_changed(2, "transcript_changed");
    // The fixture has now served both the reopened tail and the new watch tail.
    for _ in 0..2 {
        fixture_recv(&mut fx.history_reads).await;
    }
    assert!(fx.app.settle());
    assert_eq!(fx.app.screen().count(prompt).unwrap(), 1);

    receipt.resolve(queued_result("m2", 1));
    fx.app.wait_for(prompt).unwrap();
    assert!(fx.app.settle());
    assert_eq!(fx.app.screen().count(prompt).unwrap(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_shows_another_post_while_our_post_is_awaiting_receipt_and_history() {
    let mut fx = ComposerDockFixture::start_room().await;
    fx.app
        .type_text("label:Message composer", "My Room post")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let receipt = fx.prepare_room_post("mine").await;
    let mine = "text:My Room post";
    let other = "text:Another participant posted";
    fx.app.wait_for(mine).unwrap();
    fx.history
        .lock()
        .unwrap()
        .push(room_post(1, "other", "Another participant posted"));
    fx.deliver(json!({"kind":"room","through":1,"revision":1}));
    fx.app.wait_for(other).unwrap();
    assert_eq!(fx.app.screen().count(mine).unwrap(), 1);

    receipt.resolve(json!({"value":SendResult::Posted{
        session_id:"chat".into(),message_id:"mine".into(),deliveries:vec![],
    }}));
    for _ in 0..2 {
        fixture_recv(&mut fx.history_reads).await;
    }
    assert!(fx.app.settle());
    assert!(fx.app.screen().matches(other).unwrap());
    assert_eq!(
        fx.app.screen().count(mine).unwrap(),
        1,
        "an empty Room's first foreign post is not our handoff"
    );

    fx.history
        .lock()
        .unwrap()
        .push(room_post(2, "mine", "My Room post"));
    fx.deliver(json!({"kind":"room","through":2,"revision":2}));
    fixture_recv(&mut fx.history_reads).await;
    assert!(fx.app.settle());
    assert!(fx.app.screen().matches(other).unwrap());
    assert_eq!(fx.app.screen().count(mine).unwrap(), 1);
}

fn room_post(sequence: u64, id: &str, text: &str) -> Value {
    json!({"id":id,"sequence":sequence,"at":1,
        "author":{"kind":"human"},"content":{"text":text,"attachments":[]},"mentions":[],"deliveries":[]})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_hands_off_by_prepared_id_when_mixed_history_beats_the_receipt() {
    let mut fx = ComposerDockFixture::start_room().await;
    fx.app
        .type_text("label:Message composer", "Same words")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let receipt = fx.prepare_room_post("mine").await;
    let shared_text = "text:Same words";
    let other = "text:Another participant posted";
    assert_eq!(fx.app.screen().count(shared_text).unwrap(), 1);

    fx.history.lock().unwrap().extend([
        room_post(1, "other", "Another participant posted"),
        room_post(2, "same-text-other", "Same words"),
        room_post(3, "mine", "Same words"),
    ]);
    fx.deliver(json!({"kind":"room","through":3,"revision":3}));
    fx.app.wait_for(other).unwrap();
    assert_eq!(fx.app.screen().count(other).unwrap(), 1);
    assert_eq!(
        fx.app.screen().count(shared_text).unwrap(),
        2,
        "equal text from different posts must survive; only our optimistic copy should go"
    );

    receipt.resolve(json!({"value":SendResult::Posted{
        session_id:"chat".into(),message_id:"mine".into(),deliveries:vec![],
    }}));
    for _ in 0..2 {
        fixture_recv(&mut fx.history_reads).await;
    }
    assert!(fx.app.settle());
    assert_eq!(fx.app.screen().count(other).unwrap(), 1);
    assert_eq!(fx.app.screen().count(shared_text).unwrap(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_queue_does_not_withhold_remote_steering_while_waiting_for_receipt() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    let mut choose_menu_item = watch_native_menu_items(&mut fx.app, |_| {});
    fx.app
        .type_text("label:Message composer", "Handle it later")
        .unwrap();
    choose_menu_item(&mut fx.app, "Add to queue");
    let (input, receipt) = fx.call("send").await;
    assert_eq!(input["delivery"], "queue");
    fx.queue_item(json!({"revision":1,"entries":[
        {"messageId":"mine","kind":"followup","preview":"Handle it later"},
        {"messageId":"remote","kind":"steering","preview":"Steer from another device"}
    ]}));
    fx.app.wait_for("text:1 queued").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .count("text:Steer from another device")
            .unwrap(),
        1
    );
    receipt.resolve(queued_result("mine", 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_steer_recovers_when_the_conflicting_revision_cannot_be_loaded() {
    use std::sync::atomic::Ordering::SeqCst;
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    accept_dock_steer(&mut fx).await;
    fx.app.press("label:Stop current reply").unwrap();
    let (_, stop) = fx.call("stop").await;
    *fx.run.lock().unwrap() = Value::Null;
    stop.resolve(json!({"value":{"requested":true}}));
    fx.app
        .wait_for_gone("label:Stop current reply", Duration::from_secs(2))
        .unwrap();

    let drained = json!({"revision":2,"entries":[]});
    let conflict = json!({"value":{"kind":"revision_conflict","expected":2,"actual":3}});
    fx.queue_item(drained.clone());
    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(probe["expectedRevision"], 2);
    fx.hold_queue.store(true, SeqCst);
    reply.resolve(conflict.clone());
    fx.call("queue")
        .await
        .1
        .reject("Host queue query timed out");

    fx.app.wait_for(DOCK_UNCONFIRMED).unwrap();
    assert!(fx.app.screen().matches("label:Edit").unwrap());
    assert!(fx.app.screen().matches("label:Dismiss").unwrap());
    assert!(!fx.app.screen().matches("label:Retry").unwrap());
    assert!(!fx.app.screen().matches(DOCK_WAITING).unwrap());

    fx.queue_item(drained.clone());
    let (rechecked, reply) = fx.call("queueMessage").await;
    assert_eq!(rechecked, probe);
    fx.hold_queue.store(true, SeqCst);
    reply.resolve(conflict);
    fx.call("queue").await.1.resolve(json!({"value":drained}));
    assert!(fx.app.settle());
    assert!(
        fx.calls.try_recv().is_err(),
        "a stale refresh must not start a retry loop"
    );

    fx.queue_item(drained);
    let (rechecked, reply) = fx.call("queueMessage").await;
    assert_eq!(rechecked, probe);
    reply.resolve(missing_queued("unknown"));
    fx.app.press("label:Edit").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep these words")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_watch_revision_survives_the_old_conflict_refresh_failing() {
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    accept_dock_steer(&mut fx).await;
    fx.app.press("label:Stop current reply").unwrap();
    let (_, stop) = fx.call("stop").await;
    *fx.run.lock().unwrap() = Value::Null;
    stop.resolve(json!({"value":{"requested":true}}));
    fx.app
        .wait_for_gone("label:Stop current reply", Duration::from_secs(2))
        .unwrap();

    fx.queue_item(json!({"revision":2,"entries":[]}));
    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(probe["expectedRevision"], 2);
    fx.hold_queue
        .store(true, std::sync::atomic::Ordering::SeqCst);
    reply.resolve(json!({"value":{"kind":"revision_conflict","expected":2,"actual":3}}));
    let (_, refresh) = fx.call("queue").await;
    fx.queue_item(json!({"revision":3,"entries":[]}));
    assert!(fx.app.settle());
    refresh.reject("Old queue query timed out");

    let (probe, reply) = fx.call("queueMessage").await;
    assert_eq!(probe["expectedRevision"], 3);
    assert_eq!(probe["messageId"], "m2");
    reply.resolve(missing_queued("cancelled"));
    fx.app.wait_for("label:Retry").unwrap();
    assert!(!fx.app.screen().matches(DOCK_UNCONFIRMED).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_requires_proof_the_send_was_not_submitted() {
    for room in [false, true] {
        let mut fx = if room {
            ComposerDockFixture::start_room().await
        } else {
            ComposerDockFixture::start(Value::Null, dock_model(), empty_queue()).await
        };
        fx.app
            .type_text("label:Message composer", "Keep the draft")
            .unwrap();
        fx.app.press("label:Send message").unwrap();
        let (input, reply) = fx.call("send").await;
        reply.resolve(json!({"notSubmitted":"Timed out preparing the Host message"}));
        fx.app.wait_for("label:Retry").unwrap();
        assert!(!fx.app.screen().matches(DOCK_UNCONFIRMED).unwrap());

        fx.app.press("label:Retry").unwrap();
        let reply = if room {
            fx.prepare_room_post("mine").await
        } else {
            let (retry, reply) = fx.call("send").await;
            assert_eq!(retry, input);
            reply
        };
        reply.reject("Host mutation result was not acknowledged: timed out");
        fx.app.wait_for(DOCK_UNCONFIRMED).unwrap();
        assert!(fx.app.screen().matches("label:Edit").unwrap());
        assert!(fx.app.screen().matches("label:Dismiss").unwrap());
        assert!(!fx.app.screen().matches("label:Retry").unwrap());
        fx.app.press("label:Edit").unwrap();
        assert_eq!(
            fx.app
                .screen()
                .input_text("label:Message composer")
                .unwrap(),
            Some("Keep the draft")
        );
    }
}

fn workspace_host_state(revision: u64, name: &str) -> Value {
    let connection = json!({
        "rootId": "root-a", "hostName": name, "epoch": "ea", "session": "sa",
        "generation": 1, "endpoints": ["agent"], "pathSummary": null, "transport": "quic"
    });
    json!({
        "revision": revision, "devicePeerId": "ios-device", "filter": {"kind": "all_computers"},
        "hosts": [
            {"rootId": "root-a", "hostName": name, "peerId": "peer-a", "endpoints": ["agent"]},
            {"rootId": "root-b", "hostName": "Offline Host", "peerId": "peer-b", "endpoints": []}
        ],
        "active": connection,
        "connections": {"root-a": {"status": "connected", "connection": connection}}
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diff_and_file_quotes_join_the_composer_without_changing_text() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.resolve(workspace_host_state(1, "MacBook Pro"))
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
@@ -1234,3 +1234,3 @@ fn refresh() {
-    let ttl = 30;
+    let ttl = 60;
     ttl
 }
";
    let (files_tx, mut files_rx) = mpsc::unbounded_channel();
    let (diff_tx, mut diff_rx) = mpsc::unbounded_channel();
    let first_diff = std::sync::atomic::AtomicBool::new(true);
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({ "revision": "1", "needsYouCount": 0, "before": null, "after": null, "sessions": [session_q] }),
            "observe" => json!({ "session": session_q, "lastCompletedTurnId": null, "compacting": null, "through": 1, "run": null, "parts": [], "toolSeeds": [] }),
            "history" => json!({ "kind": "ready", "through": 1, "before": null, "after": null, "chunks": [] }),
            "models" => json!({ "kind": "ready", "choices": [] }),
            "queue" => json!({"revision":0,"entries":[]}),
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
            "gitWorkspaceDiff" if first_diff.swap(false, std::sync::atomic::Ordering::Relaxed) => {
                diff_tx.send(call.into_reply().unwrap()).unwrap();
                return;
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
    app.wait_for("text:MacBook Pro · maka-agent").unwrap();
    app.send_host_event("ios.hostState", workspace_host_state(2, "Travel Mac"))
        .unwrap();
    app.wait_for("text:Travel Mac · maka-agent").unwrap();

    // Type an unsent draft before navigating to ProjectFiles -> DiffScreen.
    app.type_text("label:Message composer", "Please check this:")
        .unwrap();
    app.press("label:More").unwrap();
    app.choose_menu_item("Files & Changes").unwrap();
    app.wait_for("text:Reading git workspace diff from Travel Mac.")
        .unwrap();
    app.send_host_event("ios.hostState", workspace_host_state(3, "Office Mac"))
        .unwrap();
    app.wait_for("text:Reading git workspace diff from Office Mac.")
        .unwrap();
    diff_rx.try_recv().unwrap().resolve(json!({
        "value": {"patch": sample_patch, "truncated": false, "skippedFiles": 0}
    }));
    app.wait_for("label:Diff: src/auth.rs").unwrap();
    app.press("label:Diff: src/auth.rs").unwrap();
    app.wait_for("label:Quote line to chat").unwrap();
    app.press("label:Quote line to chat").unwrap();
    app.wait_for("text:Quoted auth.rs:1234").unwrap();

    // Both references land in the same Composer queue, independently of the draft text.
    app.wait_for("text:/Please check this:/").unwrap();
    app.wait_for("text:src/auth.rs:1234").unwrap();
    app.wait_for("label:Remove quote: let ttl = 60;").unwrap();
    app.press("label:More").unwrap();
    app.choose_menu_item("Files & Changes").unwrap();
    app.press("label:Files").unwrap();
    app.wait_for("label:.github").unwrap();
    app.press("label:.github").unwrap();
    app.press("label:NOTICE").unwrap();
    app.wait_for("text:2 quotes").unwrap();
    app.wait_for("text:.github/NOTICE:1").unwrap();
    let root = files_rx.try_recv().unwrap();
    let directory = files_rx.try_recv().unwrap();
    assert_eq!(root["sessionId"], "chat-diff");
    assert!(root["path"].is_null());
    assert_eq!(directory["sessionId"], "chat-diff");
    assert_eq!(directory["path"]["bytesBase64"], "LmdpdGh1Yg==");
}

fn quote_chat_fixture(
    chunks: Vec<Value>,
    older_chunks: Vec<Value>,
    hold_first_refresh: Option<mpsc::UnboundedSender<(HostCall, Value)>>,
) -> (Headless, mpsc::UnboundedReceiver<(Send, HostCall)>) {
    quote_chat_fixture_with_work(chunks, older_chunks, hold_first_refresh, None, Os::MacOs)
}

fn quote_chat_fixture_with_work(
    chunks: Vec<Value>,
    older_chunks: Vec<Value>,
    hold_first_refresh: Option<mpsc::UnboundedSender<(HostCall, Value)>>,
    work: Option<(Vec<Value>, Vec<Value>)>,
    os: Os,
) -> (Headless, mpsc::UnboundedReceiver<(Send, HostCall)>) {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host = json!({"rootId":"root","hostName":"Host","generation":1,"endpoints":["agent"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let history_requests = AtomicUsize::new(0);
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let session = |id, title| json!({"id":id,"title":title,"kind":"agent","parentSessionId":null,
            "workspace":{"path":"/work"},"revision":1,"updatedAt":1700000000000u64,"activity":"idle",
            "backend":{"kind":"model","connectionId":"conn","modelId":"model"}});
        let method = data["method"].as_str().unwrap();
        let value = match method {
            "list" => json!({"sessions":[session("chat","Quotes Chat"),session("other","Other Chat")],"needsYouCount":0}),
            "observe" => {
                let row = if data["input"]["sessionId"] == "chat" {
                    session("chat", "Quotes Chat")
                } else {
                    session("other", "Other Chat")
                };
                json!({"session":row,"through":17,"run":null})
            }
            "history" if matches!(data["input"]["view"].as_str(), Some("turn" | "steps")) => {
                let (turn, steps) = work.as_ref().expect("unexpected work read");
                let rows = if data["input"]["view"] == "turn" {
                    assert_eq!(data["input"]["position"]["position"], chunks.last().unwrap()["position"]);
                    turn
                } else {
                    assert_eq!(data["input"]["position"]["position"], steps[0]["position"]);
                    steps
                };
                json!({"kind":"ready","chunks":rows,"through":17,"before":null,"after":null})
            }
            "history" => {
                let (rows, before) = match (
                    data["input"]["sessionId"].as_str(),
                    data["input"]["position"]["kind"].as_str(),
                ) {
                    (Some("chat"), Some("before")) => {
                        assert_eq!(data["input"]["position"]["cursor"], "older");
                        (older_chunks.as_slice(), None)
                    }
                    (Some("chat"), Some("tail")) => (chunks.as_slice(),
                        (!older_chunks.is_empty()).then_some("older")),
                    (Some("other"), Some("tail")) => (&[][..], None),
                    _ => panic!("unexpected history query: {data}"),
                };
                json!({"kind":"ready","chunks":rows,"through":17,"before":before,"after":null})
            }
            "models" if os == Os::Ios => json!({"kind":"ready","choices":[
                {"label":"Example model","selection":{"kind":"model","connectionId":"conn","modelId":"model"}}
            ]}),
            "models" => json!({"kind":"ready","choices":[]}),
            "queue" => json!({"revision":0,"entries":[]}),
            "pendingInteractions" => json!({"entries":[]}),
            "botOutbox" => json!({"isBot":false}),
            method => panic!("unexpected query: {method}"),
        };
        if method == "history"
            && let Some(refresh) = &hold_first_refresh
            && history_requests.fetch_add(1, Ordering::Relaxed) == 1
        {
            refresh.send((call, value)).unwrap();
            return;
        }
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":"root","generation":1,"subscriptionId":data["subscriptionId"]}),
        );
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let (send_tx, send_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let mut data = call.take_data();
        assert_eq!(data["method"], "send");
        assert_eq!(data["rootId"], "root");
        send_tx
            .send((serde_json::from_value(data["input"].take()).unwrap(), call))
            .unwrap();
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Conversation: Quotes Chat").unwrap();
    (app, send_rx)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_glass_keeps_the_transcript_full_bleed_and_clear_of_composer_growth() {
    use nsh_core::Point;

    let mut rows: Vec<_> = (1..=14)
        .map(|n| {
            let text = format!("Earlier message {n}: {}", "More context. ".repeat(10));
            let mut row = quote_history_row(n, "user", &text);
            row["turnId"] = json!(format!("turn-{n}"));
            row
        })
        .collect();
    rows.push(quote_history_row(15, "assistant", "Latest response"));
    let (mut app, _) = quote_chat_fixture(rows, vec![], None);
    app.set_environment("home indicator", |env| env.safe_area.bottom = px(34.))
        .unwrap();
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Latest response").unwrap();
    let bounds = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap().bounds;
    let bottom = |b: nsh_core::Bounds<nsh_core::Points>| b.origin.y + b.size.height;
    let list = bounds(&app, "id:chat-transcript");
    let context = bounds(&app, "id:chat-context");
    let composer = bounds(&app, "id:chat-composer");
    assert!((context.center().x - list.center().x).0.abs() <= 1.);
    assert!(context.size.width < list.size.width);
    assert!(context.origin.y >= bottom(bounds(&app, "label:Chats")));
    assert_eq!(bottom(list) - bottom(composer), px(34.));
    assert!(composer.origin.y < bottom(list));

    let show_keyboard = |app: &mut Headless| {
        app.set_environment("software keyboard shown", |env| {
            env.keyboard_height = px(350.);
            env.keyboard_duration = 250.;
        })
        .unwrap();
    };
    let hide_keyboard = |app: &mut Headless| {
        app.set_environment("software keyboard hidden", |env| {
            env.keyboard_height = px(0.)
        })
        .unwrap();
    };

    let latest = "id:chat-transcript >> text:Latest response";
    let opening = "id:chat-transcript >> text:/^Earlier message 1:/";
    let inset = |app: &Headless| bottom(list) - bottom(bounds(app, "id:chat-composer"));
    let tail_gap =
        |app: &Headless| bounds(app, "id:chat-composer").origin.y - bottom(bounds(app, latest));

    for reduce_motion in [false, true] {
        app.set_environment("motion preference", |env| env.reduce_motion = reduce_motion)
            .unwrap();

        // Wheel over the floating pill. Opening or hiding the keyboard must not
        // move the row the reader is looking at while away from the tail.
        app.wheel("id:chat-context", Point::new(px(0.), px(-2400.)))
            .unwrap();
        let first = bounds(&app, opening);
        assert!(first.origin.y >= bottom(context));
        show_keyboard(&mut app);
        assert_eq!(inset(&app), px(350.));
        assert_eq!(bounds(&app, opening), first);
        hide_keyboard(&mut app);
        assert_eq!(inset(&app), px(34.));
        assert_eq!(bounds(&app, opening), first);

        app.wheel("id:chat-context", Point::new(px(0.), px(2400.)))
            .unwrap();
        app.wait_for(latest).unwrap();
        let closed_tail = bounds(&app, latest);
        let gap = tail_gap(&app);
        assert!(gap > px(0.));
        show_keyboard(&mut app);
        assert_eq!(bounds(&app, "id:chat-transcript"), list);
        assert_eq!(inset(&app), px(350.));
        assert_eq!(tail_gap(&app), gap);
        hide_keyboard(&mut app);
        assert_eq!(inset(&app), px(34.));
        assert_eq!(bounds(&app, latest), closed_tail);
        assert_eq!(tail_gap(&app), gap);
    }

    show_keyboard(&mut app);
    let keyboard_composer = bounds(&app, "id:chat-composer");
    let gap = tail_gap(&app);
    app.press("role:button[Quote]").unwrap();
    app.wait_for("label:Remove quote: Latest response").unwrap();
    let with_quote = bounds(&app, "id:chat-composer");
    assert_eq!(bottom(with_quote), bottom(keyboard_composer));
    assert!(with_quote.size.height > keyboard_composer.size.height);
    assert!(
        gap > px(0.) && tail_gap(&app) == gap,
        "the tail must follow the growing composer"
    );

    app.press("label:Remove quote: Latest response").unwrap();
    assert_eq!(
        bounds(&app, "id:chat-composer").size.height,
        keyboard_composer.size.height
    );
    hide_keyboard(&mut app);
    assert_eq!(bottom(bounds(&app, "id:chat-composer")), bottom(composer));
    assert_eq!(tail_gap(&app), gap);
    app.press("label:Chats").unwrap();
    app.wait_for("label:Conversation: Quotes Chat").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn landscape_keyboard_leaves_the_composer_and_transcript_usable_with_quotes() {
    let mut rows: Vec<_> = (1..=12)
        .map(|n| {
            let mut row = quote_history_row(n, "user", &format!("Landscape message {n}"));
            row["turnId"] = json!(format!("turn-{n}"));
            row
        })
        .collect();
    rows.push(quote_history_row(13, "assistant", "Landscape reply"));
    let (mut app, _) = quote_chat_fixture(rows, vec![], None);
    let (tx, mut passthrough) = mpsc::unbounded_channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let nsh_core::MountItem::ViewProps { id, props } = item
                && props.accessibility.accessible == Some(false)
            {
                tx.send(*id).unwrap();
            }
        }
    });
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Landscape reply").unwrap();
    app.press("role:button[Quote]").unwrap();
    app.wait_for("label:Remove quote: Landscape reply").unwrap();
    app.set_viewport(Size::new(px(844.), px(390.))).unwrap();
    app.set_environment("landscape safe area", |env| {
        env.safe_area.left = px(47.);
        env.safe_area.right = px(47.);
    })
    .unwrap();
    app.set_environment("landscape keyboard shown", |env| {
        env.keyboard_height = px(240.)
    })
    .unwrap();

    let bounds = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap().bounds;
    let bottom = |b: nsh_core::Bounds<nsh_core::Points>| b.origin.y + b.size.height;
    let right = |b: nsh_core::Bounds<nsh_core::Points>| b.origin.x + b.size.width;
    let header_bottom = bottom(bounds(&app, "label:Chats"));
    let keyboard_top = px(390. - 240.);
    let composer = bounds(&app, "id:chat-composer");
    let input = bounds(&app, "label:Message composer");
    let actions = bounds(&app, "label:Composer actions");
    let send = bounds(&app, "label:Send message");

    assert_eq!(bottom(composer), keyboard_top);
    assert!(composer.origin.y - header_bottom >= px(44.));
    assert!(input.origin.y >= composer.origin.y && bottom(input) < keyboard_top);
    assert!(actions.origin.x >= px(47.) && right(send) <= px(844. - 47.));
    assert!(!app.screen().matches("id:chat-context").unwrap());
    assert!(!app.screen().matches("label:Clear all quotes").unwrap());

    // At the tail, the reply action is fully between the header and composer.
    let copy = bounds(&app, "role:button[Copy reply]");
    assert!(
        copy.origin.y >= header_bottom && bottom(copy) <= composer.origin.y,
        "copy at {copy:?}; readable band {header_bottom:?}..{:?}",
        composer.origin.y,
    );
    assert!(copy.origin.x >= px(47.) && right(copy) <= px(844. - 47.));
    app.press("role:button[Copy reply]").unwrap();
    assert_eq!(app.screen().clipboard(), Some("Landscape reply"));

    // Scroll just enough to read the reply itself, with both chrome surfaces in place.
    app.scroll("id:chat-transcript", px(-45.)).unwrap();
    let reply = bounds(&app, "id:chat-transcript >> text:Landscape reply");
    assert!(
        reply.origin.y >= header_bottom && bottom(reply) <= composer.origin.y,
        "reply at {reply:?}; readable band {header_bottom:?}..{:?}",
        composer.origin.y,
    );
    assert!(reply.origin.x >= px(47.) && right(reply) <= px(844. - 47.));

    let capsule_id = app.screen().id("id:chat-composer-input").unwrap();
    assert!(
        std::iter::from_fn(|| passthrough.try_recv().ok()).any(|id| id == capsule_id),
        "the pressable wrapper must not become a single VoiceOver element"
    );
    let capsule_a11y = app
        .screen()
        .accessibility(Some("id:chat-composer-input"))
        .unwrap()
        .unwrap();
    for label in ["Message composer", "Send message"] {
        assert!(
            capsule_a11y
                .children
                .iter()
                .any(|child| child.label.as_deref() == Some(label))
        );
    }

    let capsule = bounds(&app, "id:chat-composer-input");
    assert!(capsule.size.height >= px(44.) && capsule.size.width >= px(44.));
    let at = nsh_core::Point::new(px(6.), px(4.));
    assert!(capsule.origin.x + at.x < input.origin.x);
    assert!(capsule.origin.y + at.y < input.origin.y);
    app.press_at("id:chat-composer-input", at).unwrap();
    app.press_key("a").unwrap();
    assert_eq!(
        app.screen().input_text("label:Message composer").unwrap(),
        Some("a")
    );
    app.press("label:Composer actions").unwrap();
    app.choose_menu_item("Quote").unwrap();
    app.wait_for("label:Clear all quotes").unwrap();
    app.press("label:Clear all quotes").unwrap();
    assert!(
        !app.screen()
            .matches("label:Remove quote: Landscape reply")
            .unwrap()
    );
    app.press("label:Done").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_chats_can_clear_local_quotes_after_the_host_goes_offline() {
    let mut answer = quote_history_row(2, "assistant", "Saved reply");
    answer["finalOutput"] = json!(true);
    let (mut app, _) = quote_chat_fixture(
        vec![quote_history_row(1, "user", "What happened?"), answer],
        vec![],
        None,
    );
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Saved reply").unwrap();
    app.press("role:button[Quote]").unwrap();
    app.wait_for("label:Remove quote: Saved reply").unwrap();
    app.wait_for("label:Ask Side Question").unwrap();
    app.set_viewport(Size::new(px(812.), px(375.))).unwrap();
    app.set_environment("landscape safe area", |env| {
        env.safe_area.left = px(47.);
        env.safe_area.right = px(47.);
        env.safe_area.bottom = px(21.);
    })
    .unwrap();
    app.wait_for("label:Composer actions").unwrap();
    app.send_host_event(
        "ios.hostState",
        json!({
            "revision":2,"hosts":[{"rootId":"root","hostName":"Host","endpoints":["agent"]}],
            "connections":{"root":{"status":"offline","autoReconnect":false}}
        }),
    )
    .unwrap();
    app.wait_for("text:Host is offline").unwrap();
    let bounds = |selector| app.screen().layout(selector).unwrap().unwrap().bounds;
    let back = bounds("label:Chats");
    let files = bounds("label:Files & Changes");
    let reconnect = bounds("label:Reconnect");
    assert!(back.origin.x >= px(47.));
    assert!(files.origin.x + files.size.width <= px(812. - 47.));
    assert!(reconnect.size.height >= px(44.) && reconnect.size.width >= px(44.));

    app.press("label:Composer actions").unwrap();
    app.choose_menu_item("Quote").unwrap();
    app.wait_for("label:Remove quote: Saved reply").unwrap();
    assert!(!app.screen().matches("label:Ask Side Question").unwrap());
    assert!(!app.screen().matches("label:Send to Main Chat").unwrap());
    app.press("label:Clear all quotes").unwrap();
    app.wait_for_gone("label:Remove quote: Saved reply", Duration::from_secs(2))
        .unwrap();
    app.press("label:Done").unwrap();
    assert!(!app.screen().matches("label:Composer actions").unwrap());
}

// Headless does not present UIKit's text edit menu. Read the action the
// selectable view mounted and report its ID through the same event as UIKit.
fn watch_quote_menus(
    app: &mut Headless,
) -> impl FnMut(&mut Headless, &str, Option<&str>) -> bool + use<> {
    watch_selection_menu(app, "Add to quotes")
}

fn watch_selection_menu(
    app: &mut Headless,
    title: &'static str,
) -> impl FnMut(&mut Headless, &str, Option<&str>) -> bool + use<> {
    let mut select = watch_selection_menus(app);
    move |app, selector, text| select(app, title, selector, text)
}

fn watch_selection_menus(
    app: &mut Headless,
) -> impl FnMut(&mut Headless, &str, &str, Option<&str>) -> bool + use<> {
    use nsh_core::{EventKind, EventPayload, MountItem, PayloadValue, ROOT_ID, desktop::MenuItem};

    let (tx, mut rx) = mpsc::unbounded_channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewProps { id, props } = item
                && props.selectable_view
            {
                let actions = props
                    .selection_menu
                    .iter()
                    .filter_map(|item| match item {
                        MenuItem::Action(action) if action.enabled => {
                            Some((action.label.to_string(), action.id))
                        }
                        _ => None,
                    })
                    .collect::<BTreeMap<_, _>>();
                tx.send((*id, actions)).unwrap();
            }
        }
    });
    let mut actions = BTreeMap::new();
    move |app, title, selector, text| {
        while let Ok((node, action)) = rx.try_recv() {
            actions.insert(node, action);
        }
        let mut node = app.screen().id(selector).unwrap();
        let nodes = app.screen().layout_nodes();
        let (owner, action) = loop {
            if let Some(action) = actions.get(&node).and_then(|items| items.get(title)) {
                break (node, *action);
            }
            let Some(parent) = nodes
                .iter()
                .find(|entry| entry.id == node)
                .map(|entry| entry.parent)
            else {
                return false;
            };
            if parent == ROOT_ID {
                return false;
            }
            node = parent;
        };
        let control = app.engine().control();
        if let Some(text) = text {
            control.dispatch_event(
                owner,
                EventKind::SelectionChange,
                EventPayload::Map(vec![
                    ("text", PayloadValue::Str(text.into())),
                    ("start", PayloadValue::Number(0.0)),
                ]),
            );
            assert!(app.settle());
        }
        control.dispatch_event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(action)))]),
        );
        assert!(app.settle());
        true
    }
}

// Headless scrolling clamps the offset. Deliver the native drag events for
// short transcripts that UIKit lets the reader pull at the top.
fn pull_at_transcript_start(app: &mut Headless) {
    use nsh_core::{EventKind, EventPayload, Point};

    let list = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|node| node.test_id.as_deref() == Some("chat-transcript"))
        .expect("transcript scroll view");
    for event in [
        EventKind::ScrollDragStart,
        EventKind::ScrollDragEnd,
        EventKind::ScrollEnd,
    ] {
        app.engine().control().dispatch_event(
            list.id,
            event,
            EventPayload::Scroll(Point::default()),
        );
    }
    assert!(app.settle());
}

fn quote_history_row(sequence: u64, role: &str, text: &str) -> Value {
    json!({"importedTurn":null,"field":"body","position":{"kind":"live","sequence":sequence,
        "fact":Uuid::from_u128(u128::from(sequence)),"itemIndex":0},
        "order":{"path":[sequence],"itemIndex":0},"offset":0,"totalBytes":text.len(),
        "messageId":format!("m{sequence}"),"turnId":"t1","role":role,"text":text,"tool":null})
}

fn history_cursor(row: &Value) -> Value {
    json!({"position":row["position"],"field":row["field"],"offset":row["offset"]})
}

fn history_page(through: u64, chunks: Vec<Value>, before: Value) -> Value {
    json!({"value":{"kind":"ready","through":through,"chunks":chunks,"before":before,"after":null}})
}

struct ProjectionFixture {
    app: Headless,
    queries: mpsc::UnboundedReceiver<(Value, HostCall)>,
    watch: Value,
}

impl ProjectionFixture {
    async fn start(initial: Value) -> Self {
        let channel = HostChannel::new();
        channel.handle("ios.bootstrap", |call| {
            let host =
                json!({"rootId":"root","hostName":"Host","generation":1,"endpoints":["agent"]});
            call.resolve(json!({"revision":1,"hosts":[host],"active":host,
                "connections":{"root":{"status":"connected","connection":host}}}));
        });
        let (query_tx, queries) = mpsc::unbounded_channel();
        let first_tail = std::sync::atomic::AtomicBool::new(true);
        channel.handle("ios.hostQuery", move |mut call| {
            let data = call.take_data();
            let session = json!({"id":"projection","title":"Projection Chat","kind":"agent","revision":1,
                "workspace":{"path":"/work"},"activity":"idle","updatedAt":1});
            let value = match data["method"].as_str().unwrap() {
                "list" if data["input"]["scope"]["kind"] == "side_questions" =>
                    json!({"sessions":[],"revision":"side","after":null,"before":null}),
                "list" => json!({"sessions":[session],"needsYouCount":0}),
                "observe" => json!({"session":session,"through":11,"run":null}),
                "botOutbox" => json!({"isBot":false}),
                "models" => json!({"kind":"ready","choices":[]}),
                "queue" => json!({"revision":0,"entries":[]}),
                "pendingInteractions" => json!({"entries":[]}),
                "history" => {
                    let input = data["input"].clone();
                    if input["position"]["kind"] == "tail" &&
                        first_tail.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        call.resolve(initial.clone());
                    } else {
                        query_tx.send((input, call)).unwrap();
                    }
                    return;
                }
                method => panic!("unexpected query: {method}"),
            };
            call.resolve(json!({"value":value}));
        });
        let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
        channel.handle("ios.subscribe", move |mut call| {
            let data = call.take_data();
            let handle =
                json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":1});
            if data["method"] == "watch" {
                watch_tx.send(handle.clone()).unwrap();
            }
            call.resolve(handle);
        });
        channel.handle("ios.unsubscribe", |call| {
            call.resolve(json!({"cancelled":true}))
        });
        let mut config = engine_config(channel, tokio::runtime::Handle::current());
        config.viewport = Size::new(px(390.), px(844.));
        config.environment = Environment {
            os: Os::MacOs,
            reduce_motion: true,
            ..Environment::default()
        };
        let mut app = Headless::start(config).unwrap();
        app.wait_for("label:Conversation: Projection Chat").unwrap();
        app.press("label:Conversation: Projection Chat").unwrap();
        let watch = fixture_recv(&mut watch_rx).await;
        Self {
            app,
            queries,
            watch,
        }
    }

    fn ended(&mut self) {
        let mut watch = self.watch.clone();
        watch["item"] = json!({"kind":"events","through":12,"nextAfter":12,"events":[
            {"sequence":12,"runId":Uuid::nil(),"turnId":"t1","fact":{"kind":"ended"}}
        ]});
        self.app
            .send_host_event("ios.subscriptionItem", watch)
            .unwrap();
    }
}

fn mark_final(row: &mut Value) {
    row["finalOutput"] = json!(true);
    row["foldedWork"] = json!({"thoughts":0,"tools":1,"messages":0,"imageCount":0,"images":[]});
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_tail_supersedes_a_late_before_from_the_live_projection() {
    let prompt = quote_history_row(1, "user", "What changed?");
    let mut suffix = quote_history_row(3, "assistant", " done");
    suffix["offset"] = json!(5);
    suffix["totalBytes"] = json!("café done".len());
    let cursor = history_cursor(&suffix);
    let mut prefix = suffix.clone();
    prefix["offset"] = json!(0);
    prefix["text"] = json!("café");
    let mut fx =
        ProjectionFixture::start(history_page(11, vec![suffix.clone()], cursor.clone())).await;
    let mut ask = watch_selection_menu(&mut fx.app, "Ask Side Question");
    fx.app.wait_for("text:done").unwrap();
    pull_at_transcript_start(&mut fx.app);
    let (input, stale) = fixture_recv(&mut fx.queries).await;
    assert_eq!(input["through"], 11);
    assert_eq!(input["position"]["cursor"], cursor);
    fx.ended();
    let (input, tail) = fixture_recv(&mut fx.queries).await;
    assert_eq!(input["position"]["kind"], "tail");
    mark_final(&mut suffix);
    tail.resolve(history_page(12, vec![suffix.clone()], cursor.clone()));
    let (input, rebuilt) = fixture_recv(&mut fx.queries).await;
    assert_eq!(input["through"], 12);
    assert_eq!(input["view"], "chat");
    assert_eq!(input["position"]["cursor"], cursor);
    stale.resolve(history_page(
        11,
        vec![prompt.clone(), prefix.clone()],
        Value::Null,
    ));
    assert!(fx.app.settle());
    assert!(
        !fx.app.shows("café done"),
        "the stale before published during rebasing"
    );
    mark_final(&mut prefix);
    rebuilt.resolve(history_page(12, vec![prompt.clone(), prefix], Value::Null));
    fx.app.wait_for("text:café done").unwrap();

    fx.app.press("role:button[Copy reply]").unwrap();
    let (input, work) = fixture_recv(&mut fx.queries).await;
    assert_eq!(input["view"], "turn");
    assert_eq!(input["through"], 12);
    let mut tool = quote_history_row(2, "tool_call", "");
    tool["tool"] = json!({"toolUseId":"t","call":{"name":"Inspect result"}});
    let mut group = tool.clone();
    group["tool"] = Value::Null;
    group["work"] = json!({"end":history_cursor(&tool),"kinds":[{"kind":"tool","presentation":null}],
        "last":{"kind":"tool","presentation":null},"thoughts":0,"tools":1,"messages":0,
        "imageCount":0,"images":[]});
    let mut final_body = quote_history_row(3, "assistant", "café done");
    final_body["finalOutput"] = json!(true);
    work.resolve(history_page(
        12,
        vec![prompt, group, final_body],
        Value::Null,
    ));
    fx.app.wait_for("text:Copied").unwrap();
    assert_eq!(fx.app.screen().clipboard(), Some("café done"));
    fx.app.press("label:Used 1 tool").unwrap();
    let (input, steps) = fixture_recv(&mut fx.queries).await;
    assert_eq!(input["view"], "steps");
    steps.resolve(history_page(12, vec![tool], Value::Null));
    fx.app.wait_for("text:Inspect result").unwrap();
    assert!(ask(&mut fx.app, "text:café done", Some("café")));
    fx.app.wait_for("text:Side Question").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn folded_tail_keeps_both_final_parts_when_only_the_second_fits() {
    let prompt = quote_history_row(1, "user", "Show both parts");
    let mut tool = quote_history_row(2, "tool_call", "");
    tool["tool"] = json!({"toolUseId":"t","call":{"name":"Inspect result"}});
    let tool_end = history_cursor(&tool);
    tool["work"] = json!({"end":tool_end,"kinds":[{"kind":"tool","presentation":null}],
        "last":{"kind":"tool","presentation":null},"thoughts":0,"tools":1,"messages":0,
        "imageCount":0,"images":[]});
    tool["tool"] = Value::Null;
    let mut a = quote_history_row(3, "assistant", "First final part A");
    let beginning = "The beginning of final body B.\n\n";
    let end = format!("<!--{}-->\n\nFinal B end", "x".repeat(32730));
    assert!(beginning.len() + end.len() > 32 * 1024 && end.len() <= 32 * 1024);
    let mut suffix = quote_history_row(4, "assistant", &end);
    suffix["offset"] = json!(beginning.len());
    suffix["totalBytes"] = json!(beginning.len() + end.len());
    let mut prefix = suffix.clone();
    prefix["offset"] = json!(0);
    prefix["text"] = json!(beginning);
    let cursor = history_cursor(&suffix);
    let mut fx =
        ProjectionFixture::start(history_page(11, vec![suffix.clone()], cursor.clone())).await;
    let mut ask = watch_selection_menu(&mut fx.app, "Ask Side Question");
    fx.app.wait_for("text:Final B end").unwrap();
    pull_at_transcript_start(&mut fx.app);
    let (input, before) = fixture_recv(&mut fx.queries).await;
    assert_eq!(input["through"], 11);
    before.resolve(history_page(
        11,
        vec![prompt.clone(), tool, a.clone(), prefix.clone()],
        Value::Null,
    ));
    fx.app.wait_for("text:First final part A").unwrap();
    fx.app
        .wait_for("text:The beginning of final body B.")
        .unwrap();
    fx.ended();
    let (_, tail) = fixture_recv(&mut fx.queries).await;
    mark_final(&mut suffix);
    tail.resolve(history_page(12, vec![suffix], cursor.clone()));
    let (input, rebase) = fixture_recv(&mut fx.queries).await;
    assert_eq!(input["through"], 12);
    assert_eq!(input["position"]["cursor"], cursor);
    mark_final(&mut a);
    mark_final(&mut prefix);
    rebase.resolve(history_page(12, vec![prompt, a, prefix], Value::Null));
    fx.app.wait_for("label:Used 1 tool").unwrap();
    fx.app.wait_for("text:First final part A").unwrap();
    fx.app
        .wait_for("text:The beginning of final body B.")
        .unwrap();
    fx.app.wait_for("text:Final B end").unwrap();
    assert_eq!(fx.app.screen().count("label:Used 1 tool").unwrap(), 1);
    assert!(fx.app.settle());
    assert!(ask(
        &mut fx.app,
        "text:First final part A",
        Some("First final part A")
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expanded_user_headed_work_follows_new_steps_and_ignores_an_old_generation() {
    use std::sync::atomic::{AtomicU64, Ordering};

    let channel = HostChannel::new();
    let connection = |generation| {
        let host = json!({"rootId":"root","hostName":"Host","generation":generation,"endpoints":["agent"]});
        json!({"revision":generation,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}})
    };
    channel.handle("ios.bootstrap", move |call| call.resolve(connection(1)));
    let mut message = quote_history_row(10, "user", "Worker reported back");
    message["origin"] = json!({"kind":"bot_worker","sessionId":"worker"});
    let mut group = message.clone();
    group["text"] = json!("");
    group["totalBytes"] = json!(0);
    let tool = |sequence, name: &str| {
        let mut row = quote_history_row(sequence, "tool_call", "");
        row["tool"] = json!({"toolUseId":format!("tool-{sequence}"),"call":{"name":name}});
        row
    };
    let first_tool = tool(11, "Read source");
    let next_tool = tool(12, "Verify source");
    let responses = Arc::new(AtomicU64::new(1));
    let response = responses.clone();
    let first = first_tool.clone();
    let next = next_tool.clone();
    let earlier: Vec<_> = (1..=5)
        .map(|n| {
            let mut row = quote_history_row(
                n,
                "assistant",
                &format!("Older row {n}\n\n{}", "Filler paragraph\n\n".repeat(13)),
            );
            row["turnId"] = json!(format!("older-{n}"));
            row
        })
        .collect();
    let (steps_tx, mut steps_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let phase = response.load(Ordering::SeqCst);
        let session = json!({"id":"active","title":"Active Chat","kind":"agent","revision":1,
            "workspace":{"path":"/work"},"activity":"working","updatedAt":1,
            "backend":{"kind":"model","connectionId":"conn","modelId":"model"}});
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({"sessions":[session],"needsYouCount":0}),
            "observe" => json!({"session":session,"through":20+phase,"run":{"turnId":"t1","runId":"work","state":"running"}}),
            "models" => json!({"kind":"ready","choices":[]}),
            "botOutbox" => json!({"isBot":false}),
            "queue" => json!({"revision":0,"entries":[]}),
            "pendingInteractions" => json!({"entries":[]}),
            "history" if data["input"]["view"] == "steps" => {
                steps_tx.send((data["input"].clone(), call)).unwrap();
                return;
            }
            "history" => {
                let tool_end = if phase == 1 { &first } else { &next };
                let mut group = group.clone();
                group["work"] = json!({
                    "end":{"position":tool_end["position"],"field":"body","offset":0},
                    "kinds":[{"kind":"message"},{"kind":"tool","presentation":null}],
                    "last":{"kind":"tool","presentation":null},
                    "thoughts":0,"tools":phase.min(2),"messages":1,"imageCount":0,"images":[]
                });
                let mut rows = earlier.clone();
                rows.push(group);
                if phase > 1 {
                    rows.push(quote_history_row(13, "assistant", &format!("Working answer {phase}")));
                }
                json!({"kind":"ready","through":20+phase,"chunks":rows,"before":null,"after":null})
            }
            method => panic!("unexpected query: {method}"),
        };
        call.resolve(json!({"value":value}));
    });
    let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let handle = json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":data["generation"]});
        if data["method"] == "watch" { watch_tx.send(handle.clone()).unwrap(); }
        call.resolve(handle);
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    channel.handle("ios.hostMutate", |mut call| {
        assert_eq!(call.take_data()["method"], "send");
        call.resolve(json!({"value":SendResult::Queued {
            session_id:"active".into(), message_id:"queued".into(), revision:2, completion:None,
        }}));
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(760.));
    config.environment = Environment {
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Conversation: Active Chat").unwrap();
    app.press("label:Conversation: Active Chat").unwrap();
    app.wait_for("label:Used 1 tool").unwrap();
    assert!(!app.shows("Worker reported back"));
    app.press("label:Used 1 tool").unwrap();
    let (initial, read) = fixture_recv(&mut steps_rx).await;
    assert_eq!(initial["position"]["position"], message["position"]);
    assert_eq!(initial["through"], 21);
    let page = |through, chunks| json!({"value":{"kind":"ready","through":through,"chunks":chunks,"before":null,"after":null}});
    read.resolve(page(21, vec![message.clone(), first_tool.clone()]));
    app.wait_for("text:Worker reported back").unwrap();
    app.wait_for("text:Read source").unwrap();
    app.scroll("id:chat-transcript", px(-1900.)).unwrap();
    assert!(
        app.screen()
            .layout("label:Used 1 tool")
            .unwrap()
            .is_none_or(|layout| layout.clipped || layout.hidden)
    );
    app.scroll("id:chat-transcript", px(1900.)).unwrap();
    app.wait_for("text:Read source").unwrap();
    assert!(
        steps_rx.try_recv().is_err(),
        "recycling reread opened steps"
    );

    let watch = fixture_recv(&mut watch_rx).await;
    let deliver = |app: &mut Headless, phase: u64| {
        responses.store(phase, Ordering::SeqCst);
        let through = 20 + phase;
        let mut watch = watch.clone();
        watch["item"] = json!({"kind":"events","through":through,"nextAfter":through,
            "events":[{"sequence":through,"runId":Uuid::nil(),"turnId":"t1","fact":{"kind":"tool_settled"}}]});
        app.send_host_event("ios.subscriptionItem", watch).unwrap();
    };
    deliver(&mut app, 2);
    app.wait_for("text:Working answer 2").unwrap();
    let (updated, first_page) = fixture_recv(&mut steps_rx).await;
    assert_eq!(updated["through"], 22);
    let mut partial = page(22, vec![message.clone(), first_tool.clone()]);
    partial["value"]["after"] = history_cursor(&first_tool);
    first_page.resolve(partial);
    let (continuation, second_page) = fixture_recv(&mut steps_rx).await;
    assert_eq!(continuation["position"]["kind"], "after");
    assert_eq!(continuation["through"], 22);
    for phase in 3..=4 {
        deliver(&mut app, phase);
        app.wait_for(&format!("text:Working answer {phase}"))
            .unwrap();
        app.wait_for("text:Read source").unwrap();
        assert!(!app.shows("text:Loading…"));
        assert!(
            steps_rx.try_recv().is_err(),
            "a newer tail preempted the in-flight steps page"
        );
    }
    second_page.resolve(page(22, vec![next_tool.clone()]));
    let (catchup, stale) = fixture_recv(&mut steps_rx).await;
    assert_eq!(catchup["through"], 24);
    app.wait_for("text:Verify source").unwrap();
    assert!(!app.shows("text:Loading…"));
    assert!(steps_rx.try_recv().is_err(), "more than one catch-up read");

    responses.store(5, Ordering::SeqCst);
    app.send_host_event("ios.hostState", connection(2)).unwrap();
    assert!(app.settle());
    let (reconnected, fresh) = fixture_recv(&mut steps_rx).await;
    assert_eq!(reconnected["through"], 25);
    stale.reject("outdated steps error");
    fresh.resolve(page(
        25,
        vec![message, first_tool, tool(12, "Verified after reconnect")],
    ));
    app.wait_for("text:Verified after reconnect").unwrap();
    assert!(!app.shows("outdated steps error"));

    app.scroll("id:chat-transcript", px(-1200.)).unwrap();
    app.type_text("label:Message composer", "Follow up")
        .unwrap();
    app.press("label:Send message").unwrap();
    let answer = "text:Working answer 5";
    app.wait_until(
        "sending returned to the latest answer",
        Duration::from_secs(3),
        |screen| {
            screen
                .layout(answer)
                .unwrap()
                .is_some_and(|layout| !layout.clipped && !layout.hidden)
        },
    )
    .unwrap();
    assert!(steps_rx.try_recv().is_err());

    app.scroll("id:chat-transcript", px(-500.)).unwrap();
    app.press("label:Chats").unwrap();
    app.press("label:Conversation: Active Chat").unwrap();
    app.wait_until(
        "reopening showed the new tail",
        Duration::from_secs(3),
        |screen| {
            screen
                .layout(answer)
                .unwrap()
                .is_some_and(|layout| !layout.clipped && !layout.hidden)
        },
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_scroll_completes_previous_turn_and_keeps_the_visible_text_anchored() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host = json!({"rootId":"root","hostName":"Host","generation":1,"endpoints":["agent"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let prefix = "Café in the missing prefix.\n\n".repeat(18);
    let suffix = format!(
        "Reading marker\n\n{}Newest paragraph",
        "Visible reply paragraph.\n\n".repeat(32)
    );
    let mut visible = quote_history_row(23, "assistant", &suffix);
    visible["turnId"] = json!("latest");
    visible["offset"] = json!(prefix.len());
    visible["totalBytes"] = json!(prefix.len() + suffix.len());
    let cursor = |row: &Value| {
        json!({
            "position": row["position"], "field": row["field"], "offset": row["offset"],
        })
    };
    let page = |rows: Vec<Value>, before: Value| {
        json!({
            "kind":"ready","through":30,"chunks":rows,"before":before,"after":null,
        })
    };
    let boundary = cursor(&visible);
    let tail = page(vec![visible.clone()], boundary.clone());
    let (history_tx, mut history_rx) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let session = json!({"id":"paged","title":"Paged Chat","kind":"agent","revision":1,
            "workspace":{"path":"/work"},"activity":"idle","updatedAt":1});
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({"sessions":[session],"needsYouCount":0}),
            "observe" => json!({"session":session,"through":31,"run":null}),
            "gitWorkspaceDiff" => json!({"patch":"","truncated":false}),
            "models" => json!({"kind":"ready","choices":[]}),
            "botOutbox" => json!({"isBot":false}),
            "queue" => json!({"revision":0,"entries":[]}),
            "pendingInteractions" => json!({"entries":[]}),
            "history" => {
                let input = data["input"].clone();
                if input["position"]["kind"] == "tail" {
                    assert_eq!(input["view"], "chat");
                    tail.clone()
                } else {
                    history_tx.send((input, call)).unwrap();
                    return;
                }
            }
            method => panic!("unexpected query: {method}"),
        };
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":1}),
        );
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    let mut choose_menu = watch_native_menu_items(&mut app, |_| {});
    app.wait_for("label:Conversation: Paged Chat").unwrap();
    app.press("label:Conversation: Paged Chat").unwrap();
    app.wait_for("text:Newest paragraph").unwrap();
    assert!(
        history_rx.try_recv().is_err(),
        "opening the chat fetched older history"
    );
    app.scroll("id:chat-transcript", px(-1600.)).unwrap();
    let (abandoned_input, abandoned) = fixture_recv(&mut history_rx).await;
    choose_menu(&mut app, "Files & Changes");
    app.wait_for("text:No uncommitted changes").unwrap();
    let mut older_fragment = visible.clone();
    older_fragment["offset"] = json!(0);
    older_fragment["text"] = json!(prefix);
    abandoned.resolve(json!({"value":page(vec![older_fragment.clone()], cursor(&older_fragment))}));
    assert!(app.settle());
    assert!(
        history_rx.try_recv().is_err(),
        "covered Chat continued paging"
    );
    app.press("label:Chat").unwrap();
    app.wait_for("text:Reading marker").unwrap();
    assert!(!app.shows("Café in the missing prefix."));
    app.scroll("id:chat-transcript", px(230.)).unwrap();
    app.scroll("id:chat-transcript", px(-230.)).unwrap();
    let (input, failed) = fixture_recv(&mut history_rx).await;
    assert_eq!(input, abandoned_input);
    assert_eq!(input["view"], "chat");
    assert_eq!(
        input["through"], 30,
        "use the history fence, not the observation"
    );
    assert_eq!(input["position"]["cursor"], boundary);
    failed.reject("older history unavailable");
    app.wait_for("id:chat-transcript >> label:Retry").unwrap();
    app.scroll("id:chat-transcript", px(210.)).unwrap();
    app.scroll("id:chat-transcript", px(-340.)).unwrap();
    assert!(
        history_rx.try_recv().is_err(),
        "scroll retried a failed page"
    );
    app.press("id:chat-transcript >> label:Retry").unwrap();
    let (retry_input, retry) = fixture_recv(&mut history_rx).await;
    assert_eq!(retry_input, input);
    assert!(app.settle());
    let marker_y = |app: &Headless| {
        app.screen()
            .layout("text:Reading marker")
            .unwrap()
            .expect("reading marker is still mounted")
            .bounds
            .origin
            .y
            .0
    };
    let before = marker_y(&app);
    visible["offset"] = json!(0);
    visible["text"] = json!(prefix);
    let mut latest_prompt = quote_history_row(14, "user", "Latest question");
    latest_prompt["turnId"] = json!("latest");
    let mut prior_end = quote_history_row(13, "assistant", " is complete.");
    prior_end["offset"] = json!(14);
    prior_end["totalBytes"] = json!(27);
    prior_end["finalOutput"] = json!(true);
    prior_end["foldedWork"] =
        json!({"thoughts":1,"tools":1,"messages":0,"imageCount":0,"images":[]});
    let prior_cursor = cursor(&prior_end);
    let mut first_page = vec![prior_end.clone(), latest_prompt];
    first_page.extend((15..22).map(|sequence| {
        let mut step = quote_history_row(sequence, "tool_call", "");
        step["turnId"] = json!("latest");
        step["tool"] = json!({"toolUseId":format!("call-{sequence}"),"call":{"name":"Read"}});
        step
    }));
    // Supply the tool-heavy page separately: a single drag must cross it.
    let raw_work = first_page.split_off(2);
    let work_cursor = cursor(&raw_work[0]);
    retry.resolve(json!({"value":page([raw_work, vec![visible]].concat(), work_cursor.clone())}));
    let (next, work) = fixture_recv(&mut history_rx).await;
    assert_eq!(next["position"]["cursor"], work_cursor);
    work.resolve(json!({"value":page(first_page, prior_cursor.clone())}));
    let (next, earlier) = fixture_recv(&mut history_rx).await;
    assert_eq!(next["position"]["cursor"], prior_cursor);
    prior_end["offset"] = json!(0);
    prior_end["text"] = json!("Previous reply");
    let prompt = quote_history_row(2, "user", "Previous question");
    let mut oldest = quote_history_row(1, "assistant", "Even older reply");
    oldest["turnId"] = json!("older");
    let oldest_cursor = cursor(&oldest);
    earlier.resolve(json!({"value":page(vec![oldest, prompt.clone(), prior_end.clone()], oldest_cursor.clone())}));
    app.wait_for_gone(
        "id:chat-transcript >> text:Loading…",
        Duration::from_secs(2),
    )
    .unwrap();
    assert!(app.settle());
    let after = marker_y(&app);
    assert!(
        (after - before).abs() <= 24.,
        "reading marker jumped from {before} to {after}"
    );
    assert!(
        history_rx.try_recv().is_err(),
        "paging continued beyond a complete prior Turn"
    );
    app.scroll("id:chat-transcript", px(-1100.)).unwrap();
    let (next, start) = fixture_recv(&mut history_rx).await;
    assert_eq!(next["position"]["cursor"], oldest_cursor);
    start.resolve(json!({"value":page(vec![], Value::Null)}));
    app.wait_for("text:Previous question").unwrap();
    app.wait_for("text:Previous reply is complete.").unwrap();
    assert!(
        history_rx.try_recv().is_err(),
        "collapsed work was fetched before opening it"
    );

    app.press("label:Thought process · 1 tool").unwrap();
    let (turn, turn_page) = fixture_recv(&mut history_rx).await;
    assert_eq!(turn["view"], "turn");
    assert_eq!(turn["position"]["position"], prior_end["position"]);
    let mut thought = quote_history_row(3, "assistant", "Recovered thought");
    thought["field"] = json!("thinking");
    let mut group = thought.clone();
    group["text"] = json!("");
    group["totalBytes"] = json!(0);
    group["work"] = json!({"end":cursor(&thought),"kinds":[{"kind":"thought"}],"last":{"kind":"thought"},
        "thoughts":1,"tools":1,"messages":0,"imageCount":0,"images":[]});
    turn_page.resolve(json!({"value":page(vec![prompt, group, prior_end], Value::Null)}));
    let (steps, step_page) = fixture_recv(&mut history_rx).await;
    assert_eq!(steps["view"], "steps");
    assert_eq!(steps["position"]["position"], thought["position"]);
    let mut tool = quote_history_row(4, "tool_call", "");
    tool["tool"] = json!({"toolUseId":"search","call":{"name":"Search source"}});
    step_page.resolve(json!({"value":page(vec![thought, tool], Value::Null)}));
    app.wait_for("text:Recovered thought").unwrap();
    app.wait_for("text:Search source").unwrap();
}

fn side_history_rows() -> (Value, Value) {
    let mut early = quote_history_row(9, "assistant", "Earlier durable answer");
    early["position"] = json!({
        "kind":"snapshot", "path":[Uuid::from_u128(2)], "snapshot":Uuid::from_u128(3),
        "sequence":9, "fact":Uuid::from_u128(9), "itemIndex":0,
    });
    early["order"] = json!({"path":[5, 9], "itemIndex":0});
    early["turnId"] = json!("zzz");
    let mut late = quote_history_row(2, "assistant", "Later durable answer");
    late["order"] = json!({"path":[6], "itemIndex":0});
    late["turnId"] = json!("aaa");
    late["finalOutput"] = json!(true);
    (early, late)
}

fn side_session(id: &str, title: &str, backend: &Value) -> Value {
    let (_, late) = side_history_rows();
    json!({
        "id":id, "title":title, "kind":"agent", "activity":"waiting",
        "parentSessionId":"not-the-main-chat",
        "branch":{"side":true,"sessionId":"main","position":{
            "kind":"through_source_turn","position":late["position"],
        }},
        "backend":backend, "workspace":{"path":"/work"}, "revision":1,
    })
}

struct SideChatFixture {
    app: Headless,
    header: Arc<std::sync::Mutex<Option<nsh_core::ScreenConfig>>>,
    mutations: mpsc::UnboundedReceiver<(Value, HostCall)>,
    goal_reads: mpsc::UnboundedReceiver<(Value, HostCall)>,
    goal_authority: Arc<std::sync::atomic::AtomicBool>,
    subscriptions: mpsc::UnboundedReceiver<Value>,
    unsubscribed: mpsc::UnboundedReceiver<Value>,
    main_removed: Arc<std::sync::atomic::AtomicBool>,
    hold_side_observe: Arc<std::sync::atomic::AtomicBool>,
    side_observations: mpsc::UnboundedReceiver<(HostCall, Value)>,
    backend: Arc<std::sync::Mutex<Value>>,
}

impl SideChatFixture {
    fn open_main(&mut self) {
        self.app.press("label:Conversation: Main Chat").unwrap();
        self.app.wait_for("text:Later durable answer").unwrap();
    }

    async fn subscription(&mut self, method: &str, scope: Option<&str>) -> Value {
        tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(sub) = self.subscriptions.recv().await {
                if sub["method"] == method && sub["input"]["scope"]["kind"].as_str() == scope {
                    return sub;
                }
            }
            panic!("no {method} subscription");
        })
        .await
        .unwrap()
    }

    async fn mutation(&mut self, method: &str) -> (Value, HostCall) {
        let (data, call) = tokio::time::timeout(Duration::from_secs(2), self.mutations.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(data["rootId"], "root");
        assert_eq!(data["generation"], 7);
        assert_eq!(data["method"], method);
        (data["input"].clone(), call)
    }
}

fn side_host_state(revision: u64, generation: Option<u64>) -> Value {
    let host = json!({"rootId":"root","hostName":"Host","generation":generation,
        "endpoints":["agent","settings"]});
    let connection = if generation.is_some() {
        json!({"status":"connected","connection":host})
    } else {
        json!({"status":"offline"})
    };
    json!({"revision":revision,"hosts":[host],
        "active":generation.map(|_| host),
        "connections":{"root":connection}})
}

fn side_chat_fixture(default_model: bool, missing_main: bool) -> SideChatFixture {
    side_chat_fixture_on(default_model, missing_main, Os::MacOs, 1)
}

fn side_chat_fixture_on(
    default_model: bool,
    missing_main: bool,
    os: Os,
    early_count: u64,
) -> SideChatFixture {
    let (early, late) = side_history_rows();
    let mut provisional = quote_history_row(12, "assistant", "Provider marked this final");
    provisional["order"] = json!({"path":[7],"itemIndex":0});
    provisional["finalAnswer"] = json!(true);
    let mut main_history = vec![early];
    for i in 1..early_count {
        let mut row = quote_history_row(20 + i, "assistant", &format!("Collected answer {i}"));
        row["order"] = json!({"path":[5, 9 + i],"itemIndex":0});
        row["finalOutput"] = json!(true);
        main_history.push(row);
    }
    let mut user = quote_history_row(11, "user", "A user message");
    user["order"] = json!({"path":[6, 1],"itemIndex":0});
    main_history.extend([late, user, provisional]);
    side_chat_fixture_with_history(default_model, missing_main, os, main_history, "/work")
}

fn side_chat_fixture_with_history(
    default_model: bool,
    missing_main: bool,
    os: Os,
    main_history: Vec<Value>,
    main_workspace: &str,
) -> SideChatFixture {
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

    let main_workspace = main_workspace.to_owned();
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.resolve(side_host_state(1, Some(7)))
    });
    let backend = if default_model {
        Value::Null
    } else {
        json!({"kind":"model","connectionId":"selected","modelId":"selected-model"})
    };
    let backend = Arc::new(Mutex::new(backend));
    let observed_backend = backend.clone();
    let main_removed = Arc::new(AtomicBool::new(missing_main));
    let removed = main_removed.clone();
    let hold_side_observe = Arc::new(AtomicBool::new(false));
    let hold = hold_side_observe.clone();
    let (observe_tx, side_observations) = mpsc::unbounded_channel();
    let main_revision = AtomicU64::new(40);
    let (goal_read_tx, goal_reads) = mpsc::unbounded_channel();
    let goal_authority = Arc::new(AtomicBool::new(true));
    let with_authority = goal_authority.clone();
    let (_, late) = side_history_rows();
    let mut saved_history: Vec<_> = (20..=45)
        .map(|n| {
            let mut row = quote_history_row(n, "user", &format!("Saved side question message {n}"));
            row["turnId"] = json!(format!("saved-{n}"));
            row
        })
        .collect();
    saved_history.push(quote_history_row(
        46,
        "assistant",
        "Saved side question tail",
    ));
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        assert_eq!(data["rootId"], "root");
        let input = &data["input"];
        let backend = observed_backend.lock().unwrap().clone();
        let missing_main = removed.load(Ordering::Relaxed);
        let main = json!({"id":"main","title":"Main Chat","kind":"agent","activity":"idle",
            "branch":null,"parentSessionId":null,"workspace":{"path":main_workspace},"revision":2,
            "backend":backend});
        let room = json!({"id":"room","title":"Room Chat","kind":"room","activity":"idle",
            "branch":null,"parentSessionId":null,"workspace":{"path":"/work"},"revision":1});
        let saved = side_session("saved", "Saved side question", &backend);
        let value = match data["method"].as_str().unwrap() {
            "goal" => {
                goal_read_tx.send((data, call)).unwrap();
                return;
            }
            "list" if input["scope"]["kind"] == "side_questions" => {
                assert_eq!(input["scope"]["sessionId"], "main");
                assert_eq!(input["position"], json!({"kind":"after","revision":"sides-7","cursor":"older"}));
                let mut old = side_session("old", "From an unloaded page", &backend);
                old["branch"]["position"]["position"] = quote_history_row(0, "assistant", "Older")["position"].clone();
                old["activity"] = json!("idle");
                json!({"sessions":[old],"revision":"sides-7","needsYouCount":1,"before":null,"after":null})
            }
            "list" if input["filter"] == "needs_you" => {
                if input["position"]["kind"] == "start" {
                    let mut waiting = room.clone();
                    waiting["activity"] = json!("waiting");
                    json!({"sessions":[waiting],"revision":"pending-7","needsYouCount":2,"before":null,"after":"pending-next"})
                } else {
                    assert_eq!(input["position"], json!({"kind":"after","revision":"pending-7","cursor":"pending-next"}));
                    json!({"sessions":[saved],"revision":"pending-7","needsYouCount":2,"before":null,"after":null})
                }
            }
            "list" => {
                let sessions = if missing_main { vec![room] } else { vec![main, room] };
                json!({"sessions":sessions,"revision":"main-7","needsYouCount":1,"before":null,"after":null})
            }
            "observe" => {
                let session = match input["sessionId"].as_str().unwrap() {
                    "main" if missing_main => {
                        call.reject("agent_session_not_found");
                        return;
                    }
                    "main" => {
                        let revision = main_revision.fetch_add(1, Ordering::Relaxed) + 1;
                        let mut main = main;
                        main["revision"] = json!(revision);
                        main
                    }
                    "room" => room,
                    "saved" => saved,
                    "new-side" => side_session("new-side", "A side question", &backend),
                    id => panic!("unexpected observe: {id}"),
                };
                let mut session = session;
                if session["kind"] == "agent" && with_authority.load(Ordering::Relaxed) {
                    session["binding"] = json!({
                        "id":"00000000-0000-4000-8000-000000000001","permissionEpoch":3
                    });
                    session["permissions"] = json!({"access":"read_only","requestPermissions":true});
                    session["boundaryRevision"] = json!(12);
                }
                json!({"session":session,"through":99,"run":null})
            }
            "history" if input["sessionId"] == "room" => json!({
                "kind":"room","page":{"items":[{
                    "id":"message","sequence":1, "content":{"text":"Room message"},
                    "author":{"kind":"human"}, "createdAt":0
                }],"through":1,"before":null,"after":null}
            }),
            "history" => {
                let chunks = match input["sessionId"].as_str().unwrap() {
                    "main" => main_history.as_slice(),
                    "saved" => saved_history.as_slice(),
                    _ => std::slice::from_ref(&late),
                };
                json!({"kind":"ready","chunks":chunks,"through":99,"before":null,"after":null})
            }
            "models" if os == Os::Ios => json!({"kind":"ready","choices":[
                {"label":"New side model","selection":{"kind":"model","connectionId":"new","modelId":"new-model"}}
            ]}),
            "models" => json!({"kind":"ready","choices":[]}),
            "botOutbox" => json!({"isBot":false}),
            "connections" => json!({"kind":"ready","revision":1,"connections":[],"next":null,
                "defaultTarget":{"connectionId":"default","modelId":"default-model"}}),
            "resolveModel" => json!({"kind":"ready","defaults":null,"choice":{
                "label":"Host default","connectionName":"Host",
                "selection":{"connectionId":"default","modelId":"default-model"},"thinkingLevels":[],
            }}),
            "pendingInteractions" if input["sessionId"] == "saved" =>
                json!({"entries":[{"requestId":"side-request","kind":"service_approval","toolUseId":"tool"}]}),
            "queue" => json!({"revision":0,"entries":[]}),
            "pendingInteractions" => json!({"entries":[]}),
            "interaction" if input["sessionId"] == "saved" => json!({
                "requestId":"side-request","outcome":null,"request":{
                    "kind":"service_approval","toolUseId":"tool","toolName":"SideTool",
                    "service":"service","method":"execute","binding":"binding","through":1
                }
            }),
            method => panic!("unexpected side chat query: {method}"),
        };
        let value = json!({"value":value});
        if data["method"] == "observe" && input["sessionId"] == "saved" && hold.swap(false, Ordering::Relaxed) {
            observe_tx.send((call, value)).unwrap();
        } else {
            call.resolve(value);
        }
    });
    let (sub_tx, subscriptions) = mpsc::unbounded_channel();
    let subscription_generation = AtomicU64::new(11);
    channel.handle("ios.subscribe", move |mut call| {
        let mut data = call.take_data();
        let generation = subscription_generation.fetch_add(1, Ordering::Relaxed);
        call.resolve(
            json!({"rootId":"root","generation":generation,"subscriptionId":data["subscriptionId"]}),
        );
        data["generation"] = json!(generation);
        sub_tx.send(data).unwrap();
    });
    let (unsub_tx, unsubscribed) = mpsc::unbounded_channel();
    channel.handle("ios.unsubscribe", move |mut call| {
        unsub_tx.send(call.take_data()).unwrap();
        call.resolve(json!({"cancelled":true}));
    });
    let (mut_tx, mutations) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        mut_tx.send((call.take_data(), call)).unwrap();
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    let header = Arc::new(Mutex::new(None));
    if os == Os::Ios {
        let mounted = header.clone();
        app.observe(move |_, batch| {
            for item in &batch.items {
                if let nsh_core::MountItem::ScreenConfig { config, .. } = item
                    && config.title.as_deref() == Some("Main Chat")
                {
                    *mounted.lock().unwrap() = Some((**config).clone());
                }
            }
        });
    }
    app.wait_for("label:Conversation: Room Chat").unwrap();
    SideChatFixture {
        app,
        header,
        mutations,
        goal_reads,
        goal_authority,
        subscriptions,
        unsubscribed,
        main_removed,
        hold_side_observe,
        side_observations,
        backend,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_uses_transcript_order_and_keeps_the_main_draft() {
    let mut fx = side_chat_fixture(false, false);
    let mut quote = watch_quote_menus(&mut fx.app);
    fx.open_main();
    fx.app
        .type_text("label:Message composer", "Main draft")
        .unwrap();
    assert!(quote(
        &mut fx.app,
        "text:Later durable answer",
        Some("Later durable answer")
    ));
    assert!(quote(
        &mut fx.app,
        "text:Earlier durable answer",
        Some("Earlier durable answer")
    ));
    fx.app.wait_for("text:2 quotes").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Main draft")
    );
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app.wait_for("text:Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Compare these\nanswers?")
        .unwrap();
    fx.app.press("label:Send message").unwrap();

    let (input, call) = fx.mutation("fork").await;
    let fork: maka_agent_api::contract::Fork = serde_json::from_value(input.clone()).unwrap();
    let (_, late) = side_history_rows();
    assert_eq!(fork.session_id, "main");
    assert_eq!(fork.expected_revision, 42);
    assert!(fork.side);
    assert!(fork.labels.is_empty());
    assert_eq!(fork.title, "Compare these answers?");
    assert_eq!(
        input["position"],
        json!({"kind":"through_source_turn","position":late["position"]})
    );
    call.resolve(
        json!({"value":{"kind":"forked","session":side_session("new-side", &fork.title,
        &json!({"kind":"model","connectionId":"selected","modelId":"selected-model"}))}}),
    );

    let (input, call) = fx.mutation("send").await;
    let send: Send = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(send.session_id, "new-side");
    assert_eq!(send.message, "Compare these\nanswers?");
    assert_eq!(input["backend"]["modelId"], "selected-model");
    assert_eq!(
        json!(send.quotes),
        json!([
            {"text":"Later durable answer","label":"Maka","sourceMessageId":"m2","sourceTurnId":"aaa"},
            {"text":"Earlier durable answer","label":"Maka","sourceMessageId":"m9","sourceTurnId":"zzz"},
        ])
    );
    call.resolve(json!({"value":SendResult::Queued{
        session_id:"new-side".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
    fx.app.wait_for("label:Bring to Main Draft").unwrap();
    fx.app.press("label:Back").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Main draft")
    );
    fx.app
        .wait_for("label:Remove quote: Later durable answer")
        .unwrap();
    fx.app
        .wait_for("label:Remove quote: Earlier durable answer")
        .unwrap();
    assert!(fx.mutations.try_recv().is_err());

    fx.app.press("label:Send message").unwrap();
    let (payload, receipt) = fx.mutation("send").await;
    let main: Send = serde_json::from_value(payload).unwrap();
    assert_eq!(main.session_id, "main");
    assert_eq!(main.message, "Main draft");
    assert_eq!(main.quotes, send.quotes);
    receipt.resolve(json!({"value":SendResult::Queued{
        session_id:"main".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_cancel_and_unicode_whitespace_do_not_mutate() {
    let mut fx = side_chat_fixture(false, false);
    let mut ask = watch_selection_menu(&mut fx.app, "Ask Side Question");
    fx.open_main();
    fx.app
        .type_text("label:Message composer", "Keep me")
        .unwrap();
    assert!(ask(
        &mut fx.app,
        "text:Earlier durable answer",
        Some("Earlier durable")
    ));
    fx.app
        .wait_for("label:Remove quote: Earlier durable")
        .unwrap();
    fx.app.wait_for("text:Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "\u{0085}\u{2003}")
        .unwrap();
    assert!(!fx.app.screen().enabled("label:Send message").unwrap());
    fx.app
        .type_text("label:Message composer", "Should not send")
        .unwrap();
    assert!(fx.app.screen().enabled("label:Send message").unwrap());
    fx.app.press("label:Cancel").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep me")
    );
    assert!(!fx.app.shows("label:Clear all quotes"));
    assert!(fx.mutations.try_recv().is_err());
}

fn relative_luminance(rgb: [f64; 3]) -> f64 {
    rgb.into_iter()
        .zip([0.2126, 0.7152, 0.0722])
        .map(|(c, w)| {
            w * if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        })
        .sum()
}

fn color_over(color: nsh_core::Color, backdrop: [f64; 3]) -> [f64; 3] {
    let (r, g, b, a) = color.to_f64();
    std::array::from_fn(|index| [r, g, b][index] * a + backdrop[index] * (1. - a))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composer_and_keyboard_toolbar_keep_glass_and_touch_targets() {
    use nsh_core::{
        Color, Filter, GlassEffect, MountItem, NodeId, ViewKind,
        canvas::{CanvasOp, Paint},
        platform::ColorScheme,
        tailwind::state::PRESSED,
    };

    let (mut app, _) = quote_chat_fixture_with_work(
        vec![quote_history_row(1, "assistant", "Previous answer")],
        vec![],
        None,
        None,
        Os::Ios,
    );
    let (tx, mut changes) = mpsc::unbounded_channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props } => {
                    tx.send((*id, Some(props.hit_slop), None, None)).unwrap();
                }
                MountItem::ViewStyle { id, style } => {
                    tx.send((*id, None, Some(style.clone()), None)).unwrap();
                }
                MountItem::Canvas { id, drawing } => {
                    if let Some(ink) = drawing.ops.iter().find_map(|op| match op {
                        CanvasOp::StrokeStyle(Paint::Color(color)) => Some(*color),
                        _ => None,
                    }) {
                        tx.send((*id, None, None, Some(ink))).unwrap();
                    }
                }
                _ => {}
            }
        }
    });
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("id:chat-keyboard-model-glass").unwrap();
    let capsule = "id:chat-composer-input";
    let input = "label:Message composer";
    let send = "label:Send message";
    let bounds = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap().bounds;
    let bottom = |b: nsh_core::Bounds<nsh_core::Points>| b.origin.y + b.size.height;
    let right = |b: nsh_core::Bounds<nsh_core::Points>| b.origin.x + b.size.width;
    let send_inset = |app: &Headless| {
        let (capsule, input, send) = (bounds(app, capsule), bounds(app, input), bounds(app, send));
        assert!(right(input) <= send.origin.x && right(send) < right(capsule));
        assert!(send.origin.y > capsule.origin.y && bottom(send) < bottom(capsule));
        (right(capsule) - right(send), bottom(capsule) - bottom(send))
    };
    assert!(!app.screen().enabled(send).unwrap());
    let empty = bounds(&app, capsule);
    app.type_text(input, "One line").unwrap();
    let single = bounds(&app, capsule);
    assert_eq!(empty.size.height, single.size.height);
    let inset = send_inset(&app);
    assert!(
        (bounds(&app, input).center().y - bounds(&app, send).center().y)
            .0
            .abs()
            <= 1.
    );
    app.type_text(input, "\nSecond line\nThird line").unwrap();
    assert!(bounds(&app, capsule).size.height > single.size.height);
    assert_eq!(send_inset(&app), inset);
    assert!(
        (bottom(bounds(&app, input)) - bottom(bounds(&app, send)))
            .0
            .abs()
            <= 1.
    );

    let controls = [
        ("id:chat-keyboard-model-glass", false),
        ("label:Quote diff", true),
        ("label:Dismiss keyboard", true),
    ];
    let node_id = |app: &Headless, selector| app.screen().id(selector).unwrap();
    let nodes = app.screen().layout_nodes();
    let parent = |id| nodes.iter().find(|node| node.id == id).unwrap().parent;
    assert_eq!(parent(node_id(&app, send)), node_id(&app, capsule));
    assert_dock_touch_target(&app, "id:chat-keyboard-model");
    for (selector, _) in controls {
        let mut id = node_id(&app, selector);
        while let Some(node) = nodes.iter().find(|node| node.id == id) {
            if node.kind == ViewKind::InputAccessory {
                break;
            }
            id = node.parent;
        }
        assert!(
            nodes
                .iter()
                .any(|n| n.id == id && n.kind == ViewKind::InputAccessory)
        );
    }

    let mut slop = BTreeMap::new();
    let mut styles = BTreeMap::new();
    let mut ink = BTreeMap::new();
    let mut sync =
        |slop: &mut BTreeMap<_, _>, styles: &mut BTreeMap<_, _>, ink: &mut BTreeMap<_, _>| {
            while let Ok((id, hit_slop, style, color)) = changes.try_recv() {
                if let Some(hit_slop) = hit_slop {
                    slop.insert(id, hit_slop);
                }
                if let Some(style) = style {
                    styles.insert(id, style);
                }
                if let Some(color) = color {
                    ink.insert(id, color);
                }
            }
        };
    let assert_hit_target = |selector, app: &Headless, slop: &BTreeMap<_, nsh_core::EdgeInsets>| {
        let b = bounds(&app, selector);
        let pad = slop[&node_id(&app, selector)];
        assert!(
            b.size.width + pad.left + pad.right >= px(44.)
                && b.size.height + pad.top + pad.bottom >= px(44.),
            "{selector}: {b:?} + {pad:?}"
        );
    };
    sync(&mut slop, &mut styles, &mut ink);
    for selector in [send, "label:Quote diff", "label:Dismiss keyboard"] {
        assert_hit_target(selector, &app, &slop);
    }

    let assert_glass = |style: &nsh_core::ViewStyle| {
        assert_eq!(style.glass_effect, GlassEffect::Regular);
        assert!(
            style
                .effects
                .as_ref()
                .is_some_and(|fx| { matches!(fx.backdrop_filters.as_slice(), [Filter::Blur(_)]) })
        );
    };
    let control = app.engine().control();
    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        app.set_environment("appearance", |env| env.color_scheme = scheme)
            .unwrap();
        for (selector, changes_fill) in controls {
            let id: NodeId = node_id(&app, selector);
            let mut fills = [Color::default(); 2];
            for (fill, state) in fills.iter_mut().zip([0, PRESSED]) {
                control.set_states(id, state);
                assert!(app.settle());
                sync(&mut slop, &mut styles, &mut ink);
                assert_glass(&styles[&node_id(&app, capsule)]);
                let style = &styles[&id];
                assert_glass(style);
                *fill = style.background_color;
                let (_, _, _, a) = fill.to_f64();
                assert!(a > 0. && a < 1., "{selector} has an opaque fill");
                for child in nodes.iter().filter(|node| node.parent == id) {
                    let fg = match child.kind {
                        ViewKind::Canvas => ink[&child.id],
                        ViewKind::Text => button_text_color(&app, id),
                        _ => continue,
                    };
                    let (fr, fg, fb, fa) = fg.to_f64();
                    assert_eq!(fa, 1.);
                    let fg = relative_luminance([fr, fg, fb]);
                    for backdrop in [0., 1.] {
                        let bg = relative_luminance(color_over(*fill, [backdrop; 3]));
                        let contrast = (fg.max(bg) + 0.05) / (fg.min(bg) + 0.05);
                        assert!(contrast >= 4.5, "{selector} {scheme:?}: {contrast:.2}:1");
                    }
                }
            }
            if changes_fill {
                assert_ne!(fills[0], fills[1], "{selector} has no pressed feedback");
            }
            control.set_states(id, 0);
            assert!(app.settle());
        }
    }

    app.press("role:button[Quote]").unwrap();
    app.wait_for("label:Remove quote: Previous answer").unwrap();
    sync(&mut slop, &mut styles, &mut ink);
    assert_hit_target("label:Remove quote: Previous answer", &app, &slop);
    assert_hit_target("label:Clear all quotes", &app, &slop);
}

fn assert_readable_colors(
    selector: &str,
    foreground: nsh_core::Color,
    background: nsh_core::Color,
) {
    let luminance = |color: nsh_core::Color| {
        let (r, g, b, a) = color.to_f64();
        assert_eq!(a, 1.0, "{selector}: transparent color {color:?}");
        relative_luminance([r, g, b])
    };
    let bg = luminance(background);
    let fg = luminance(foreground);
    let contrast = (bg.max(fg) + 0.05) / (bg.min(fg) + 0.05);
    assert!(contrast >= 4.5, "{selector}: {contrast:.2}:1");
}

fn assert_chat_button_contrast(
    app: &mut Headless,
    selector: &str,
    glass_parent: Option<&str>,
    foreground: impl Fn(&Headless, nsh_core::NodeId) -> nsh_core::Color,
) {
    let id = app.screen().id(selector).unwrap();
    let control = app.engine().control();
    let luminance = |color: nsh_core::Color| {
        let (r, g, b, a) = color.to_f64();
        assert_eq!(a, 1.0, "{selector}: transparent color {color:?}");
        relative_luminance([r, g, b])
    };
    let mut fills = [None; 2];
    for (fill, state) in fills
        .iter_mut()
        .zip([0, nsh_core::tailwind::state::PRESSED])
    {
        control.set_states(id, state);
        assert!(app.settle());
        let style = app.screen().view_style(selector).unwrap().unwrap();
        assert_eq!(style.effective_opacity, 1.0, "{selector}, state={state}");
        *fill = style.background_color;
        let button = nsh_core::Color(fill.unwrap_or(0));
        let fg = luminance(foreground(app, id));
        let tray = glass_parent.map(|parent| {
            nsh_core::Color(
                app.screen()
                    .view_style(parent)
                    .unwrap()
                    .unwrap()
                    .background_color
                    .unwrap(),
            )
        });
        for backdrop in [0., 1.] {
            let bg = match tray {
                Some(tray) => {
                    relative_luminance(color_over(button, color_over(tray, [backdrop; 3])))
                }
                None => luminance(button),
            };
            let contrast = (bg.max(fg) + 0.05) / (bg.min(fg) + 0.05);
            assert!(
                contrast >= 4.5,
                "{selector}, state={state}: {contrast:.2}:1"
            );
        }
    }
    if glass_parent.is_some() {
        assert_eq!(fills[0], None, "{selector} paints a box at rest");
    }
    assert_ne!(fills[0], fills[1], "{selector} has no pressed feedback");
    control.set_states(id, 0);
    assert!(app.settle());
}

fn button_text_color(app: &Headless, id: nsh_core::NodeId) -> nsh_core::Color {
    app.screen()
        .layout_nodes()
        .iter()
        .find_map(|node| {
            (node.parent == id)
                .then_some(node.text.as_ref())?
                .map(|text| text.text.spans[0].style.color)
        })
        .expect("button text")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quote_actions_and_sheet_done_keep_contrast_when_pressed() {
    use nsh_core::platform::ColorScheme;

    let mut fx = side_chat_fixture(false, false);
    let mut quote = watch_quote_menus(&mut fx.app);
    fx.open_main();
    assert!(quote(
        &mut fx.app,
        "text:Later durable answer",
        Some("Later durable answer")
    ));

    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        fx.app
            .set_environment("appearance", |env| env.color_scheme = scheme)
            .unwrap();
        assert_chat_button_contrast(
            &mut fx.app,
            "label:Ask Side Question",
            None,
            button_text_color,
        );
        assert_chat_button_contrast(
            &mut fx.app,
            "label:Clear all quotes",
            Some("id:chat-draft-quotes"),
            button_text_color,
        );
    }

    fx.app.set_viewport(Size::new(px(844.), px(390.))).unwrap();
    fx.app
        .set_environment("landscape keyboard", |env| env.keyboard_height = px(240.))
        .unwrap();
    fx.app.press("label:Composer actions").unwrap();
    fx.app.choose_menu_item("Quote").unwrap();
    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        fx.app
            .set_environment("appearance", |env| env.color_scheme = scheme)
            .unwrap();
        assert_chat_button_contrast(&mut fx.app, "label:Done", None, button_text_color);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn normal_send_has_readable_icon_in_both_press_states() {
    use nsh_core::{
        MountItem,
        canvas::{CanvasOp, Paint},
        platform::ColorScheme,
    };

    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    let strokes = Arc::new(std::sync::Mutex::new(BTreeMap::new()));
    let mounted = strokes.clone();
    fx.app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::Canvas { id, drawing } = item
                && let Some(color) = drawing.ops.iter().find_map(|op| match op {
                    CanvasOp::StrokeStyle(Paint::Color(color)) => Some(*color),
                    _ => None,
                })
            {
                mounted.lock().unwrap().insert(*id, color);
            }
        }
    });
    fx.app
        .type_text("label:Message composer", "Ready to send")
        .unwrap();
    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        fx.app
            .set_environment("appearance", |env| env.color_scheme = scheme)
            .unwrap();
        assert_chat_button_contrast(&mut fx.app, "label:Send message", None, |app, id| {
            let canvas = app
                .screen()
                .layout_nodes()
                .into_iter()
                .find(|node| node.parent == id && node.kind == nsh_core::ViewKind::Canvas)
                .unwrap();
            strokes.lock().unwrap()[&canvas.id]
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_fork_conflict_then_failed_first_send_retries_in_the_new_chat() {
    let mut fx = side_chat_fixture(true, false);
    let mut select = watch_selection_menus(&mut fx.app);
    fx.open_main();
    assert!(select(
        &mut fx.app,
        "Add to quotes",
        "text:Later durable answer",
        Some("Later durable answer")
    ));
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Why this one?")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, call) = fx.mutation("fork").await;
    assert_eq!(input["expectedRevision"], 42);
    call.resolve(json!({"value":{"kind":"revision_conflict","expected":42,"actual":43}}));
    fx.app
        .wait_for("text:Could not create the side question. Try again.")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Why this one?")
    );
    fx.app
        .wait_for("label:Remove quote: Later durable answer")
        .unwrap();
    assert!(fx.mutations.try_recv().is_err());

    fx.app.press("label:Send message").unwrap();
    let (input, call) = fx.mutation("fork").await;
    assert_eq!(input["expectedRevision"], 43);
    call.resolve(json!({"value":{"kind":"forked","session":side_session("new-side","Why this one?",&Value::Null)}}));
    let (send, call) = fx.mutation("send").await;
    assert_eq!(send["backend"]["modelId"], "default-model");
    call.resolve(json!({"value":SendResult::Rejected {
        session_id:"new-side".into(), reason:maka_agent_api::contract::SendRejection::ModelUnavailable,
        skills:None,
    }}));

    fx.app.wait_for("text:Side Question · Main Chat").unwrap();
    fx.app.wait_for("text:Could not send the message.").unwrap();
    fx.app.press("text:Could not send the message.").unwrap();
    fx.app
        .wait_for("label:Remove quote: Later durable answer")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Why this one?")
    );
    assert!(!fx.app.shows("label:Ask Side Question"));
    assert!(!select(
        &mut fx.app,
        "Ask Side Question",
        "text:Later durable answer >> nth=0",
        None
    ));
    fx.app.press("label:Send message").unwrap();
    let (retry, call) = fx.mutation("send").await;
    assert_eq!(retry, send);
    assert_eq!(retry["sessionId"], "new-side");
    call.resolve(json!({"value":SendResult::Queued{
        session_id:"new-side".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
    fx.app
        .wait_for_gone("label:Clear all quotes", Duration::from_secs(2))
        .unwrap();
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_unacknowledged_first_send_keeps_draft_and_warns_before_retry() {
    let mut fx = side_chat_fixture(false, false);
    let mut quote = watch_quote_menus(&mut fx.app);
    fx.open_main();
    assert!(quote(
        &mut fx.app,
        "text:Later durable answer",
        Some("Later durable answer")
    ));
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "What did the Host receive?")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, fork) = fx.mutation("fork").await;
    fork.resolve(json!({"value":{"kind":"forked","session":side_session("new-side","What did the Host receive?",&Value::Null)}}));
    let (submitted, send) = fx.mutation("send").await;
    assert_eq!(submitted["sessionId"], "new-side");
    send.reject("Host mutation result was not acknowledged: connection closed");

    let notice = "text:Could not confirm whether the message was sent. Check the conversation or queue before retrying.";
    fx.app.wait_for(notice).unwrap();
    assert!(!fx.app.shows("text:Could not send the message."));
    fx.app.press(notice).unwrap();
    fx.app.wait_for("text:Side Question · Main Chat").unwrap();
    fx.app
        .wait_for("label:Remove quote: Later durable answer")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("What did the Host receive?")
    );
    assert!(
        fx.mutations.try_recv().is_err(),
        "automatically retried the send or fork"
    );

    fx.app.press("label:Send message").unwrap();
    let (retry, send) = fx.mutation("send").await;
    assert_eq!(retry, submitted);
    send.resolve(json!({"value":SendResult::Queued{
        session_id:"new-side".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
    fx.app
        .wait_for_gone("label:Clear all quotes", Duration::from_secs(2))
        .unwrap();
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_rediscovers_anchors_pages_and_brings_a_link_back() {
    let mut fx = side_chat_fixture(false, false);
    fx.app.wait_for("text:1").unwrap();
    assert_eq!(fx.app.screen().count("text:1").unwrap(), 1);
    assert_eq!(fx.app.screen().count("text:2").unwrap(), 0);
    fx.open_main();
    let scope = fx.subscription("catalog", Some("side_questions")).await;
    assert_ne!(scope["generation"], 7);
    assert_eq!(scope["input"]["scope"]["sessionId"], "main");
    assert_eq!(scope["input"]["position"]["kind"], "start");
    let mut saved = side_session("saved", "Saved side question", &Value::Null);
    saved["branch"]["position"]["position"]["itemIndex"] = json!(1);
    let correct = side_session("saved", "Saved side question", &Value::Null);
    // Wrong row in the same event must not surface an anchor.
    fx.app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":scope["subscriptionId"],"rootId":"root","generation":scope["generation"],
        "item":{"revision":"sides-6","sessions":[saved],"needsYouCount":1,"before":null,"after":null}
    })).unwrap();
    assert!(fx.app.settle());
    assert!(!fx.app.shows("text:Side questions (1)"));

    fx.app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":scope["subscriptionId"],"rootId":"root","generation":scope["generation"],
        "item":{"revision":"sides-7","sessions":[correct],"needsYouCount":1,"before":null,"after":"older"}
    })).unwrap();
    fx.app
        .wait_for("label:Side questions (1) · Waiting for your response")
        .unwrap();
    fx.app.press("label:More").unwrap();
    fx.app.choose_menu_item("All Side Questions").unwrap();
    fx.app
        .wait_for("label:Saved side question · Waiting for your response")
        .unwrap();
    fx.app.wait_for("label:From an unloaded page").unwrap();
    fx.app.press("label:Done").unwrap();

    fx.app
        .type_text("label:Message composer", "Main draft")
        .unwrap();
    fx.app
        .press("label:Side questions (1) · Waiting for your response")
        .unwrap();
    fx.app.wait_for("text:Side Question · Main Chat").unwrap();
    fx.app.wait_for("text:Saved side question tail").unwrap();
    assert!(
        fx.app
            .screen()
            .layout("text:Saved side question message 20")
            .unwrap()
            .is_none_or(|view| view.clipped)
    );
    fx.app.press("label:Bring to Main Draft").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Main draft")
    );
    fx.app
        .wait_for("label:Remove conversation link: Saved side question")
        .unwrap();
    assert!(fx.mutations.try_recv().is_err());

    fx.app
        .press("label:Remove conversation link: Saved side question")
        .unwrap();
    assert!(
        !fx.app
            .shows("label:Remove conversation link: Saved side question")
    );
    fx.app
        .press("label:Side questions (1) · Waiting for your response")
        .unwrap();
    fx.app.wait_for("text:Saved side question").unwrap();
    fx.app.press("label:Bring to Main Draft").unwrap();
    fx.app.press("label:Send message").unwrap();
    let (payload, send) = fx.mutation("send").await;
    let input: Send = serde_json::from_value(payload).unwrap();
    assert_eq!(input.session_id, "main");
    assert_eq!(
        input.message,
        "Main draft [@Saved side question](maka://session/saved)"
    );
    assert!(input.quotes.is_empty());
    send.resolve(json!({"value":SendResult::Queued{
        session_id:"main".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
    fx.app
        .wait_for_gone(
            "label:Remove conversation link: Saved side question",
            Duration::from_secs(2),
        )
        .unwrap();

    fx.app.press("label:Chats").unwrap();
    fx.app.wait_for("label:Conversation: Main Chat").unwrap();
    let unsubscribed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let handle = fx.unsubscribed.recv().await.unwrap();
            if handle["subscriptionId"] == scope["subscriptionId"] {
                break handle;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(unsubscribed["generation"], scope["generation"]);
    assert_eq!(fx.app.screen().count("text:1").unwrap(), 1);
    assert_eq!(fx.app.screen().count("text:2").unwrap(), 0);

    fx.open_main();
    let scope = fx.subscription("catalog", Some("side_questions")).await;
    fx.app
        .send_host_event(
            "ios.subscriptionEnded",
            json!({
                "rootId":"root","subscriptionId":scope["subscriptionId"],
                "generation":scope["generation"],"error":"catalog closed"
            }),
        )
        .unwrap();
    fx.app.press("label:More").unwrap();
    fx.app.choose_menu_item("All Side Questions").unwrap();
    fx.app
        .wait_for("text:Could not load side questions")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_pending_restores_the_readable_main_and_can_open_an_orphan() {
    for missing_main in [false, true] {
        let mut fx = side_chat_fixture(false, missing_main);
        fx.app.press("label:Pending").unwrap();
        fx.app
            .wait_for("text:Allow service call SideTool?")
            .unwrap();
        assert_eq!(
            fx.app
                .screen()
                .count("text:Allow service call SideTool?")
                .unwrap(),
            1
        );
        fx.app.press("text:Allow service call SideTool?").unwrap();
        fx.app.press("label:Open Conversation >> nth=0").unwrap();
        if missing_main {
            fx.app.wait_for("text:Side Question").unwrap();
            assert!(!fx.app.shows("label:Bring to Main Draft"));
            fx.app.press("label:Chats").unwrap();
            fx.app.wait_for("label:Conversation: Room Chat").unwrap();
        } else {
            fx.app.wait_for("text:Side Question · Main Chat").unwrap();
            fx.app.press("label:Back").unwrap();
            fx.app.wait_for("text:Main Chat").unwrap();
            fx.app.wait_for("text:Earlier durable answer").unwrap();
        }
        assert!(fx.mutations.try_recv().is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_actions_are_absent_in_rooms_and_from_live_preview() {
    let mut fx = side_chat_fixture(false, false);
    let mut ask = watch_selection_menu(&mut fx.app, "Ask Side Question");
    fx.app.press("label:Conversation: Room Chat").unwrap();
    fx.app.wait_for("text:Room message").unwrap();
    assert!(!fx.app.shows("label:Ask Side Question"));
    assert!(!fx.app.screen().matches("id:chat-details-scroll").unwrap());
    fx.app.press("label:Chats").unwrap();
    while fx.subscriptions.try_recv().is_ok() {}
    fx.open_main();
    let watch = fx.subscription("watch", None).await;
    fx.app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":watch["subscriptionId"],"rootId":"root","generation":watch["generation"],
        "item":{"kind":"preview","page":{
            "kind":"cut","hostEpoch":"ea","runId":"run","turnId":"running","stepId":"step","attemptId":"attempt",
            "revision":1,"dependsOn":0,"first":true,"last":false,
            "parts":[{"ordinal":0,"messageId":"streaming","startedAt":1,
                "field":{"kind":"text","textKind":"text"},"offset":0,"totalBytes":11,"text":"Live answer"}]
        }}
    })).unwrap();
    fx.app.wait_for("text:Live answer").unwrap();
    // Only the two durable source rows are eligible; neither a provider's
    // finalAnswer flag nor the live preview exposes collection or direct Ask.
    assert!(!ask(&mut fx.app, "text:Provider marked this final", None));
    assert!(!ask(&mut fx.app, "text:Live answer", None));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_connection_change_discards_only_the_unsubmitted_side_draft() {
    let mut fx = side_chat_fixture(false, false);
    let mut quote = watch_quote_menus(&mut fx.app);
    fx.open_main();
    fx.app
        .type_text("label:Message composer", "Keep the main draft")
        .unwrap();
    assert!(quote(
        &mut fx.app,
        "text:Earlier durable answer",
        Some("Earlier durable answer")
    ));

    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Not submitted")
        .unwrap();
    fx.app
        .send_host_event("ios.hostState", side_host_state(2, None))
        .unwrap();
    fx.app.wait_for("text:Reconnecting…").unwrap();
    fx.app.wait_for("text:Main Chat").unwrap();

    fx.app
        .send_host_event("ios.hostState", side_host_state(3, Some(8)))
        .unwrap();
    fx.app.wait_for("label:Message composer").unwrap();
    fx.app
        .wait_for("label:Remove quote: Earlier durable answer")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep the main draft")
    );
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app.wait_for("text:Side Question").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("")
    );
    fx.app
        .send_host_event("ios.hostState", side_host_state(4, Some(9)))
        .unwrap();
    fx.app.wait_for("text:Main Chat").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep the main draft")
    );
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_late_fork_receipt_keeps_child_draft_after_disconnect() {
    let mut fx = side_chat_fixture(false, false);
    let mut quote = watch_quote_menus(&mut fx.app);
    fx.open_main();
    assert!(quote(
        &mut fx.app,
        "text:Earlier durable answer",
        Some("Earlier durable answer")
    ));
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Keep this question")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, fork) = fx.mutation("fork").await;

    fx.app
        .send_host_event("ios.hostState", side_host_state(2, None))
        .unwrap();
    fx.app.wait_for("text:Reconnecting…").unwrap();
    let old_catalog = fx.subscription("catalog", Some("side_questions")).await;
    let side = side_session("new-side", "Keep this question", &Value::Null);
    fork.resolve(json!({"value":{"kind":"forked","session":side}}));
    fx.app
        .send_host_event("ios.hostState", side_host_state(3, Some(8)))
        .unwrap();
    let catalog = fx.subscription("catalog", Some("side_questions")).await;
    assert_ne!(catalog["subscriptionId"], old_catalog["subscriptionId"]);
    fx.app.send_host_event("ios.subscriptionItem", json!({
        "rootId":"root","subscriptionId":catalog["subscriptionId"],"generation":catalog["generation"],
        "item":{"revision":"sides-new","sessions":[side],"needsYouCount":0,"before":null,"after":null}
    })).unwrap();
    fx.app
        .press("label:Side questions (1) · Waiting for your response")
        .unwrap();
    fx.app
        .wait_for("label:Remove quote: Earlier durable answer")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep this question")
    );
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_unselected_row_is_an_anchor_even_with_a_full_quote_tray() {
    let mut fx = side_chat_fixture_on(false, false, Os::MacOs, 16);
    let mut select = watch_selection_menus(&mut fx.app);
    fx.open_main();
    assert!(select(
        &mut fx.app,
        "Add to quotes",
        "text:Earlier durable answer",
        Some("Earlier durable answer")
    ));
    for i in 1..16 {
        let text = format!("Collected answer {i}");
        assert!(select(
            &mut fx.app,
            "Add to quotes",
            &format!("text:{text}"),
            Some(&text)
        ));
    }
    fx.app.wait_for("text:Quote limit reached (16)").unwrap();
    assert!(select(
        &mut fx.app,
        "Ask Side Question",
        "text:Later durable answer",
        None
    ));
    fx.app
        .type_text("label:Message composer", "What ties these together?")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, fork) = fx.mutation("fork").await;
    let (_, late) = side_history_rows();
    assert_eq!(input["position"]["position"], late["position"]);
    fork.resolve(json!({"value":{"kind":"forked","session":side_session("new-side","What ties these together?",&Value::Null)}}));
    let (payload, send) = fx.mutation("send").await;
    let input: Send = serde_json::from_value(payload).unwrap();
    assert_eq!(input.session_id, "new-side");
    let expected = std::iter::once("Earlier durable answer".into())
        .chain((1..16).map(|i| format!("Collected answer {i}")))
        .collect::<Vec<String>>();
    assert_eq!(
        input
            .quotes
            .into_iter()
            .map(|quote| quote.text)
            .collect::<Vec<_>>(),
        expected
    );
    send.resolve(json!({"value":SendResult::Queued{
        session_id:"new-side".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_reply_context_menu_starts_an_anchor_only_draft() {
    use nsh_core::{EventKind, EventPayload, MountItem};

    let mut fx = side_chat_fixture_on(false, false, Os::Ios, 1);
    let (menu_tx, mut menus) = mpsc::unbounded_channel();
    // UIKit presents the context menu. Drive the action the reply mounted.
    fx.app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ComponentProps { id, props } = item
                && let Some(action) = props.iter().find_map(|(name, value)| {
                    if name.as_ref() != "items" {
                        return None;
                    }
                    value
                        .as_ref()?
                        .as_array()?
                        .iter()
                        .find(|item| item["label"] == "Ask Side Question")
                })
            {
                menu_tx.send((*id, action["id"].clone())).unwrap();
            }
        }
    });
    fx.open_main();
    let (menu, action) = menus.try_recv().unwrap();
    fx.app.engine().control().dispatch_event(
        menu,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "select".into(),
            data: action,
        },
    );
    fx.app.wait_for("text:Side Question").unwrap();
    assert!(!fx.app.shows("label:Clear all quotes"));
    assert!(fx.mutations.try_recv().is_err());
    fx.app
        .type_text("label:Message composer", "Follow up on the latest answer")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, fork) = fx.mutation("fork").await;
    let (_, late) = side_history_rows();
    assert_eq!(input["position"]["position"], late["position"]);
    fork.resolve(json!({"value":{"kind":"forked","session":side_session("new-side","Follow up",&Value::Null)}}));
    let (payload, send) = fx.mutation("send").await;
    let input: Send = serde_json::from_value(payload).unwrap();
    assert_eq!(input.session_id, "new-side");
    assert!(input.quotes.is_empty());
    send.resolve(json!({"value":SendResult::Queued{
        session_id:"new-side".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_tray_rejects_mixed_sources_but_a_direct_anchor_keeps_eligible_quotes() {
    let mut fx = side_chat_fixture(false, false);
    let mut select = watch_selection_menus(&mut fx.app);
    fx.open_main();
    assert!(select(
        &mut fx.app,
        "Add to quotes",
        "text:Later durable answer",
        Some("Later durable answer")
    ));
    fx.app.wait_for("label:Ask Side Question").unwrap();
    for text in ["A user message", "Provider marked this final"] {
        assert!(select(
            &mut fx.app,
            "Add to quotes",
            &format!("text:{text}"),
            Some(text)
        ));
        fx.app.wait_for("text:2 quotes").unwrap();
        assert!(!fx.app.shows("label:Ask Side Question"));
        if text == "A user message" {
            fx.app.press("label:Remove quote: A user message").unwrap();
            fx.app.wait_for("label:Ask Side Question").unwrap();
        }
    }
    assert!(select(
        &mut fx.app,
        "Ask Side Question",
        "text:Earlier durable answer",
        None
    ));
    fx.app
        .wait_for("label:Remove quote: Later durable answer")
        .unwrap();
    assert!(
        !fx.app
            .shows("label:Remove quote: Provider marked this final")
    );
    fx.app
        .type_text("label:Message composer", "Ask from this reply")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, fork) = fx.mutation("fork").await;
    let (early, _) = side_history_rows();
    assert_eq!(input["position"]["position"], early["position"]);
    fork.resolve(json!({"value":{"kind":"forked","session":side_session("new-side","Ask from this reply",&Value::Null)}}));
    let (payload, send) = fx.mutation("send").await;
    let input: Send = serde_json::from_value(payload).unwrap();
    assert_eq!(input.quotes.len(), 1);
    assert_eq!(input.quotes[0].text, "Later durable answer");
    send.resolve(json!({"value":SendResult::Queued{
        session_id:"new-side".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_from_tray_cannot_send_after_the_last_quote_is_removed() {
    let mut fx = side_chat_fixture(false, false);
    let mut quote = watch_quote_menus(&mut fx.app);
    fx.open_main();
    assert!(quote(
        &mut fx.app,
        "text:Earlier durable answer",
        Some("Earlier durable answer")
    ));
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Question without a source")
        .unwrap();
    assert!(fx.app.screen().enabled("label:Send message").unwrap());
    fx.app
        .press("label:Remove quote: Earlier durable answer")
        .unwrap();
    assert!(!fx.app.screen().enabled("label:Send message").unwrap());
    assert!(fx.app.press("label:Send message").is_err());
    assert!(fx.mutations.try_recv().is_err());
    fx.app.press("label:Cancel").unwrap();
    fx.app
        .wait_for("label:Remove quote: Earlier durable answer")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_blank_reply_context_menu_has_no_quote_action() {
    use nsh_core::{EventKind, EventPayload, MountItem};

    let mut blank = quote_history_row(1, "assistant", " \u{2003} ");
    blank["finalOutput"] = json!(true);
    let mut fx = side_chat_fixture_with_history(false, false, Os::Ios, vec![blank], "/work");
    let (menu_tx, mut menus) = mpsc::unbounded_channel();
    fx.app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ComponentProps { id, props } = item
                && let Some(items) = props.iter().find_map(|(name, value)| {
                    if name.as_ref() != "items" {
                        return None;
                    }
                    let items = value.as_ref()?.as_array()?;
                    items
                        .iter()
                        .any(|item| item["label"] == "Ask Side Question")
                        .then_some(items)
                })
            {
                menu_tx.send((*id, items.clone())).unwrap();
            }
        }
    });
    fx.app.press("label:Conversation: Main Chat").unwrap();
    fx.app.wait_for("label:Copy reply").unwrap();
    let (menu, items) = menus.try_recv().unwrap();
    assert!(!items.iter().any(|item| item["label"] == "Add to quotes"));
    assert!(!fx.app.shows("label:Quote"));

    let ask = items
        .iter()
        .find(|item| item["label"] == "Ask Side Question")
        .unwrap();
    // Invoke the remaining action through the same event UIKit sends.
    fx.app.engine().control().dispatch_event(
        menu,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "select".into(),
            data: ask["id"].clone(),
        },
    );
    fx.app.wait_for("text:Side Question").unwrap();
    assert!(!fx.app.shows("label:Clear all quotes"));
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_uncertain_fork_can_check_catalog_without_discarding_question() {
    let mut fx = side_chat_fixture(false, false);
    let mut quote = watch_quote_menus(&mut fx.app);
    fx.open_main();
    let catalog = fx.subscription("catalog", Some("side_questions")).await;
    assert!(quote(
        &mut fx.app,
        "text:Later durable answer",
        Some("Later durable answer")
    ));
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Did this branch get created?")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, fork) = fx.mutation("fork").await;
    fork.reject("Host mutation result was not acknowledged: connection closed");
    fx.app
        .wait_for("text:Side question creation could not be confirmed.")
        .unwrap();
    fx.app.press("label:View All Side Questions").unwrap();
    fx.app.wait_for("text:All Side Questions").unwrap();

    fx.app.send_host_event("ios.subscriptionItem", json!({
        "rootId":"root","subscriptionId":catalog["subscriptionId"],"generation":catalog["generation"],
        "item":{"revision":"sides-1","sessions":[side_session("new-side","Recovered side question",&Value::Null)],
            "needsYouCount":0,"before":null,"after":null}
    })).unwrap();
    fx.app.wait_for("text:Recovered side question").unwrap();
    fx.app.press("label:Done").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Did this branch get created?")
    );
    fx.app
        .wait_for("label:Remove quote: Later durable answer")
        .unwrap();
    assert!(!fx.app.screen().enabled("label:Send message").unwrap());
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_cannot_bring_a_link_to_a_removed_main_conversation() {
    use std::sync::atomic::Ordering;

    let mut fx = side_chat_fixture(false, false);
    fx.open_main();
    fx.app
        .type_text("label:Message composer", "Unchanged")
        .unwrap();
    let catalog = fx.subscription("catalog", Some("side_questions")).await;
    fx.app.send_host_event("ios.subscriptionItem", json!({
        "rootId":"root","subscriptionId":catalog["subscriptionId"],"generation":catalog["generation"],
        "item":{"revision":"sides-1","sessions":[side_session("saved","Saved side question",&Value::Null)],
            "needsYouCount":1,"before":null,"after":null}
    })).unwrap();
    fx.app
        .press("label:Side questions (1) · Waiting for your response")
        .unwrap();
    fx.app.wait_for("text:Side Question · Main Chat").unwrap();
    fx.main_removed.store(true, Ordering::Relaxed);
    fx.app.press("label:Bring to Main Draft").unwrap();
    fx.app
        .wait_for("text:The main conversation is no longer available.")
        .unwrap();
    fx.app
        .press("text:The main conversation is no longer available.")
        .unwrap();
    fx.app.wait_for("text:Side Question · Main Chat").unwrap();
    fx.app.press("label:Back").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Unchanged")
    );
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_uses_the_confirmed_parent_model_selection() {
    let mut fx = side_chat_fixture_on(false, false, Os::Ios, 1);
    let mut choose = watch_native_menu_items(&mut fx.app, |_| {});
    fx.open_main();
    fx.app.wait_for("id:chat-keyboard-model").unwrap();
    choose(&mut fx.app, "New side model");
    let (selection, commit) = fx.mutation("selectBackend").await;
    assert!(!fx.app.screen().enabled("id:chat-keyboard-model").unwrap());
    assert!(fx.mutations.try_recv().is_err());

    let backend = selection["backend"].clone();
    *fx.backend.lock().unwrap() = backend.clone();
    commit.resolve(json!({"value":{"kind":"committed","session":{
        "id":"main","title":"Main Chat","kind":"agent","revision":42,"backend":backend,
        "branch":null,"workspace":{"path":"/work"}
    }}}));
    fx.app.wait_for("text:New side model").unwrap();
    fx.app.press("label:Quote >> nth=0").unwrap();
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Use the just-selected model")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, fork) = fx.mutation("fork").await;
    // The fork re-observes after the model change.
    assert_eq!(input["expectedRevision"], 43);
    fork.resolve(json!({"value":{"kind":"forked","session":side_session("new-side","Use the new model",&backend)}}));
    let (input, send) = fx.mutation("send").await;
    assert_eq!(input["backend"]["modelId"], "new-model");
    assert_eq!(input["sessionId"], "new-side");
    send.resolve(json!({"value":SendResult::Queued{
        session_id:"new-side".into(),message_id:"queued".into(),revision:2,completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_slow_pending_jump_is_cancelled_after_leaving_the_review_or_tab() {
    use std::sync::atomic::Ordering;

    for leave_review in [true, false] {
        let mut fx = side_chat_fixture(false, false);
        fx.app.press("label:Pending").unwrap();
        fx.app.press("text:Allow service call SideTool?").unwrap();
        fx.hold_side_observe.store(true, Ordering::Relaxed);
        fx.app.press("label:Open Conversation >> nth=0").unwrap();
        let (observe, value) =
            tokio::time::timeout(Duration::from_secs(2), fx.side_observations.recv())
                .await
                .unwrap()
                .unwrap();
        if leave_review {
            fx.app.press("label:Pending").unwrap();
        } else {
            fx.app.send_url_scheme("maka://settings");
            fx.app.wait_for("label:Computer: Host").unwrap();
            fx.app.send_url_scheme("maka://pending");
            fx.app.wait_for("label:Open Conversation >> nth=0").unwrap();
        }
        observe.resolve(value);
        assert!(fx.app.settle());
        assert!(!fx.app.shows("text:Side Question · Main Chat"));
        if leave_review {
            fx.app
                .wait_for("text:Allow service call SideTool?")
                .unwrap();
            assert!(!fx.app.shows("label:Open Conversation"));
        } else {
            fx.app.wait_for("label:Open Conversation >> nth=0").unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_quote_draft_sends_ordered_excerpts_without_text_and_renders_history() {
    let mut user = quote_history_row(1, "user", "Keep café intact.");
    user["text"] = json!("Keep café");
    let mut continuation = user.clone();
    continuation["offset"] = json!("Keep café".len());
    continuation["text"] = json!(" intact.");
    let assistant = quote_history_row(2, "assistant", "Context\n\n**Swift** ready");
    let mut history = quote_history_row(3, "user", "");
    history["quotes"] =
        json!([{"label":"Desktop source","text":"A quote-only history excerpt","truncated":true}]);
    let (mut app, mut sends) =
        quote_chat_fixture(vec![user, continuation, assistant, history], vec![], None);

    let mut choose_quote = watch_quote_menus(&mut app);
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Desktop source").unwrap();
    app.wait_for("text:A quote-only history excerpt…").unwrap();
    app.wait_for("text:Keep café intact.").unwrap();
    app.wait_for("text:Swift ready").unwrap();
    // Drag from the end of the first paragraph to the end of the second.
    // The result is a single paragraph of rendered text, not the Markdown source.
    let center = |selector| {
        app.screen()
            .layout(selector)
            .unwrap()
            .unwrap()
            .bounds
            .center()
    };
    let by = center("text:Swift ready") - center("text:Context");
    app.drag("text:Context", by, Default::default()).unwrap();
    assert!(!app.shows("role:button[Quote] >> nth=1"));
    assert!(choose_quote(&mut app, "text:Swift ready", None));
    let user_body = "text:Keep café intact. >> nth=0";
    let mut quote_user = |app: &mut Headless| {
        assert!(choose_quote(app, user_body, Some("Keep café intact.")));
    };
    quote_user(&mut app);
    app.wait_for("text:2 quotes").unwrap();
    app.wait_for("label:Remove quote: Swift ready").unwrap();
    app.wait_for("label:Remove quote: Keep café intact.")
        .unwrap();

    let chip = |selector| {
        let id = app.screen().id(selector).unwrap();
        let nodes = app.screen().layout_nodes();
        let parent = nodes.iter().find(|node| node.id == id).unwrap().parent;
        nodes.iter().find(|node| node.id == parent).unwrap().bounds
    };
    let first = chip("label:Remove quote: Swift ready");
    let second = chip("label:Remove quote: Keep café intact.");
    assert!(
        first.size.height < px(44.),
        "the visual chip has a slimmer outline"
    );
    assert_eq!(second.size.height, first.size.height);
    assert_eq!(second.origin.y, first.origin.y);
    assert!(second.origin.x.0 >= (first.origin.x + first.size.width).0);

    quote_user(&mut app);
    app.press("text:Already quoted").unwrap();
    app.press("label:Remove quote: Keep café intact.").unwrap();
    app.wait_for("text:1 quote").unwrap();
    assert!(!app.shows("label:Remove quote: Keep café intact."));
    quote_user(&mut app);

    app.press("label:Chats").unwrap();
    app.press("label:Conversation: Other Chat").unwrap();
    assert!(!app.shows("label:Clear all quotes"));
    app.press("label:Chats").unwrap();
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:2 quotes").unwrap();

    app.press("label:Send message").unwrap();
    let (send, call) = sends.try_recv().unwrap();
    assert_eq!(send.session_id, "chat");
    assert_eq!(send.message, "");
    assert_eq!(
        json!(send.quotes),
        json!([
            {"text":"Swift ready","label":"Maka","sourceMessageId":"m2","sourceTurnId":"t1"},
            {"text":"Keep café intact.","label":"You","sourceMessageId":"m1","sourceTurnId":"t1"}
        ])
    );
    call.resolve(json!({"value":SendResult::Rejected {
        session_id:"chat".into(), reason:maka_agent_api::contract::SendRejection::ModelUnavailable,
        skills:None,
    }}));
    app.wait_for("text:The selected model is unavailable. Try again or choose another model.")
        .unwrap();
    app.press("label:Retry").unwrap();
    let (retry, call) = sends.try_recv().unwrap();
    assert_eq!(retry.quotes, send.quotes);
    call.resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"queued".into(), revision:2, completion:None,
    }}));
    assert!(app.settle());
    assert!(!app.shows("label:Clear all quotes"));
    assert!(app.press("label:Send message").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn draft_quote_chips_and_scroll_grow_with_dynamic_type() {
    let excerpt = "A draft quote";
    let (mut app, _) = quote_chat_fixture(
        vec![quote_history_row(1, "assistant", excerpt)],
        vec![],
        None,
    );
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.press("role:button[Quote]").unwrap();
    let scroll = "id:chat-draft-quote-scroll";
    let remove = "label:Remove quote: A draft quote";
    app.wait_for(remove).unwrap();
    let layout = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap();
    let normal = layout(&app, scroll).bounds.size.height;
    app.set_environment("Dynamic Type at 200%", |env| env.font_scale = 2.0)
        .unwrap();

    let nodes = app.screen().layout_nodes();
    let button = app.screen().id(remove).unwrap();
    let chip = nodes.iter().find(|node| node.id == button).unwrap().parent;
    let chip = nodes.iter().find(|node| node.id == chip).unwrap().bounds;
    let viewport = layout(&app, scroll).bounds;
    let author = layout(&app, "id:chat-draft-quote-scroll >> text:Maka");
    let excerpt = layout(&app, "id:chat-draft-quote-scroll >> text:A draft quote");
    let bottom = |b: nsh_core::Bounds<nsh_core::Points>| b.origin.y + b.size.height;
    assert!(viewport.size.height > normal && !author.clipped && !excerpt.clipped);
    assert!(viewport.origin.y <= chip.origin.y && bottom(chip) <= bottom(viewport));
    assert!(chip.origin.y <= author.bounds.origin.y && bottom(excerpt.bounds) <= bottom(chip));
    assert!(bottom(author.bounds) <= excerpt.bounds.origin.y);
    app.press(remove).unwrap();
    app.wait_for_gone(scroll, Duration::from_secs(2)).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn folded_turn_copies_and_quotes_all_prose_even_before_expansion() {
    let prompt = quote_history_row(1, "user", "Summarize the work");
    let first = quote_history_row(2, "assistant", "**First** answer");
    let mut tool = quote_history_row(3, "tool_call", "");
    tool["tool"] = json!({"toolUseId":"work","call":{"name":"Search sources"}});
    let mut group = tool.clone();
    group["tool"] = Value::Null;
    group["work"] = json!({
        "end":{"position":tool["position"],"field":"body","offset":0},
        "kinds":[{"kind":"tool","presentation":null}],"last":{"kind":"tool","presentation":null},
        "thoughts":0,"tools":1,"messages":0,"imageCount":0,"images":[]
    });
    let mut last = quote_history_row(4, "assistant", "Second answer");
    last["finalOutput"] = json!(true);
    let mut folded = last.clone();
    folded["foldedWork"] = json!({"thoughts":0,"tools":1,"messages":0,"imageCount":0,"images":[]});
    let (mut app, mut sends) = quote_chat_fixture_with_work(
        vec![prompt.clone(), folded],
        vec![],
        None,
        Some((vec![prompt, first, group, last], vec![tool])),
        Os::MacOs,
    );
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Second answer").unwrap();
    assert!(!app.shows("First answer"));
    app.press("role:button[Copy reply]").unwrap();
    assert!(app.settle());
    assert_eq!(
        app.screen().clipboard(),
        Some("**First** answer\n\nSecond answer")
    );
    assert!(
        !app.shows("First answer"),
        "copy opened the user's disclosure"
    );
    app.press("label:Used 1 tool").unwrap();
    app.wait_for("text:Search sources").unwrap();
    app.wait_for("text:First answer").unwrap();
    app.press("role:button[Quote]").unwrap();
    app.press("label:Send message").unwrap();
    let (send, receipt) = sends.try_recv().unwrap();
    assert_eq!(
        json!(send.quotes),
        json!([{"text":"**First** answer\n\nSecond answer","label":"Maka","sourceTurnId":"t1"}])
    );
    receipt.resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"combined".into(), revision:2, completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_boundary_reply_gains_whole_turn_actions_only_after_earlier_history_loads() {
    let mut tool = quote_history_row(2, "assistant", "");
    tool["tool"] = json!({"toolUseId":"work","call":{"name":"Shell"}});
    let (mut app, mut sends) = quote_chat_fixture(
        vec![quote_history_row(3, "assistant", "Second answer")],
        vec![quote_history_row(1, "assistant", "First answer"), tool],
        None,
    );
    let mut choose_quote = watch_quote_menus(&mut app);
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Second answer").unwrap();
    assert!(!app.shows("role:button[Copy reply]"));
    assert!(!app.shows("role:button[Quote]"));
    assert!(choose_quote(&mut app, "text:Second answer", Some("Second")));
    app.wait_for("label:Remove quote: Second").unwrap();

    pull_at_transcript_start(&mut app);
    app.wait_for("text:First answer").unwrap();
    app.press("role:button[Copy reply]").unwrap();
    assert_eq!(
        app.screen().clipboard(),
        Some("First answer\n\nSecond answer")
    );
    app.press("role:button[Quote]").unwrap();
    app.press("label:Send message").unwrap();
    let (send, receipt) = sends.try_recv().unwrap();
    assert_eq!(
        json!(send.quotes),
        json!([
            {"text":"Second","label":"Maka","sourceMessageId":"m3","sourceTurnId":"t1"},
            {"text":"First answer\n\nSecond answer","label":"Maka","sourceTurnId":"t1"}
        ])
    );
    receipt.resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"boundary".into(), revision:2, completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_quote_limit_disables_the_seventeenth_quote() {
    let (mut app, mut sends) = quote_chat_fixture(
        (1..=17)
            .map(|n| {
                let mut row = quote_history_row(n, "assistant", &format!("Excerpt {n}"));
                row["turnId"] = json!(format!("t{n}"));
                row
            })
            .collect(),
        vec![],
        None,
    );
    app.set_viewport(Size::new(px(390.), px(1900.))).unwrap();
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Excerpt 17").unwrap();
    for n in 0..16 {
        app.press(&format!("role:button[Quote] >> nth={n}"))
            .unwrap();
    }
    app.wait_for("text:Quote limit reached (16)").unwrap();
    assert!(app.press("role:button[Quote] >> nth=16").is_err());
    app.press("label:Send message").unwrap();
    let (send, call) = sends.try_recv().unwrap();
    let excerpts = send
        .quotes
        .iter()
        .map(|q| q.text.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        excerpts,
        (1..=16).map(|n| format!("Excerpt {n}")).collect::<Vec<_>>()
    );

    // Dispatch consumes the submitted quotes; new quotes belong to the next draft.
    assert!(!app.screen().matches("label:Clear all quotes").unwrap());
    app.press("role:button[Quote] >> nth=16").unwrap();
    app.press("role:button[Quote] >> nth=0").unwrap();
    call.resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"queued".into(), revision:2, completion:None,
    }}));
    assert!(app.settle());
    app.wait_for("label:Remove quote: Excerpt 17").unwrap();
    app.wait_for("label:Remove quote: Excerpt 1").unwrap();
    app.wait_for("text:2 quotes").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_quote_in_flight_survives_reopening_and_consumes_only_the_sent_quote() {
    let mut second_turn = quote_history_row(2, "assistant", "Second excerpt");
    second_turn["turnId"] = json!("t2");
    let (mut app, mut sends) = quote_chat_fixture(
        vec![
            quote_history_row(1, "assistant", "First excerpt"),
            second_turn,
        ],
        vec![],
        None,
    );
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:First excerpt").unwrap();
    app.press("role:button[Quote] >> nth=0").unwrap();
    app.press("label:Send message").unwrap();
    let (first, receipt) = sends.try_recv().unwrap();
    assert!(first.message.is_empty());
    assert_eq!(first.quotes.len(), 1);
    assert_eq!(first.quotes[0].text, "First excerpt");

    app.type_text("label:Message composer", "Next draft")
        .unwrap();
    app.press("role:button[Quote] >> nth=1").unwrap();
    app.wait_for("text:1 quote").unwrap();
    app.press("label:Chats").unwrap();
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:1 quote").unwrap();
    assert!(!app.screen().enabled("label:Send message").unwrap());
    assert!(app.press("label:Send message").is_err());
    assert!(
        sends.try_recv().is_err(),
        "send duplicated after reopening chat"
    );

    let queued = |id: &str, revision| {
        json!({"value":SendResult::Queued {
            session_id:"chat".into(), message_id:id.into(), revision, completion:None,
        }})
    };
    receipt.resolve(queued("first", 2));
    app.wait_until(
        "send ready for the next draft",
        Duration::from_secs(2),
        |screen| screen.enabled("label:Send message").unwrap(),
    )
    .unwrap();
    app.wait_for("text:Next draft").unwrap();
    assert!(!app.shows("label:Remove quote: First excerpt"));
    app.press("label:Send message").unwrap();
    let (second, receipt) = sends.try_recv().unwrap();
    assert_eq!(second.message, "Next draft");
    assert_eq!(second.quotes.len(), 1);
    assert_eq!(second.quotes[0].text, "Second excerpt");
    receipt.resolve(queued("second", 3));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_can_send_the_next_draft_before_history_refresh_returns() {
    let (refresh_tx, mut refreshes) = mpsc::unbounded_channel();
    let (mut app, mut sends) = quote_chat_fixture(
        vec![quote_history_row(1, "assistant", "First excerpt")],
        vec![],
        Some(refresh_tx),
    );
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:First excerpt").unwrap();
    app.press("role:button[Quote]").unwrap();
    app.press("label:Send message").unwrap();
    let (first, receipt) = sends.try_recv().unwrap();
    assert_eq!(first.quotes[0].text, "First excerpt");

    app.type_text("label:Message composer", "Next draft")
        .unwrap();
    receipt.resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"first".into(), revision:2, completion:None,
    }}));
    app.wait_until(
        "send ready for the next draft",
        Duration::from_secs(2),
        |screen| screen.enabled("label:Send message").unwrap(),
    )
    .unwrap();
    let (history, page) = tokio::time::timeout(Duration::from_secs(2), refreshes.recv())
        .await
        .unwrap()
        .unwrap();

    app.press("label:Send message").unwrap();
    let (second, receipt) = sends.try_recv().unwrap();
    assert_eq!(second.message, "Next draft");
    assert!(second.quotes.is_empty());
    assert!(app.press("label:Send message").is_err());
    assert!(sends.try_recv().is_err());
    receipt.resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"second".into(), revision:3, completion:None,
    }}));
    history.resolve(json!({"value":page}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_quote_selection_rejects_rust_whitespace_and_trims_valid_excerpts() {
    let (mut app, mut sends) = quote_chat_fixture(
        vec![quote_history_row(1, "user", "Keep\u{0085}the excerpt")],
        vec![],
        None,
    );
    let mut choose_quote = watch_quote_menus(&mut app);
    app.press("label:Conversation: Quotes Chat").unwrap();
    let body = "text:Keep\u{0085}the excerpt";
    app.wait_for(body).unwrap();
    assert!(app.screen().in_selectable_view(body).unwrap());
    assert!(!app.shows("role:button[Quote]"));
    // UIKit reports the selected text, which can include NEL.
    assert!(choose_quote(&mut app, body, Some("\u{0085}")));
    assert!(!app.shows("label:Clear all quotes"));
    assert!(app.press("label:Send message").is_err());
    assert!(sends.try_recv().is_err());

    assert!(choose_quote(&mut app, body, Some("\u{0085}the excerpt")));
    app.press("label:Send message").unwrap();
    let (send, receipt) = sends.try_recv().unwrap();
    assert_eq!(send.quotes.len(), 1);
    assert_eq!(send.quotes[0].text, "the excerpt");
    receipt.resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"excerpt".into(), revision:2, completion:None,
    }}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_user_quote_button_exists_only_for_a_valid_selection() {
    use nsh_core::{EventKind, EventPayload, PayloadValue};

    let (mut app, _sends) = quote_chat_fixture(
        vec![quote_history_row(1, "user", "Keep\u{0085}this excerpt")],
        vec![],
        None,
    );
    app.press("label:Conversation: Quotes Chat").unwrap();
    let body = "text:Keep\u{0085}this excerpt";
    let action = "role:button[Add to quotes]";
    app.wait_for(body).unwrap();
    assert!(!app.shows("role:button[Quote]"));
    assert!(!app.shows(action));

    let body_id = app.screen().id(body).unwrap();
    let owner = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|node| node.id == body_id)
        .unwrap()
        .parent;
    let select = |app: &mut Headless, text: &str| {
        app.engine().control().dispatch_event(
            owner,
            EventKind::SelectionChange,
            EventPayload::Map(vec![
                ("text", PayloadValue::Str(text.into())),
                ("start", PayloadValue::Number(4.0)),
            ]),
        );
        assert!(app.settle());
    };
    select(&mut app, "\u{0085}");
    assert!(!app.shows(action));

    select(&mut app, "this excerpt");
    app.wait_for(action).unwrap();
    assert_eq!(
        app.screen()
            .layout(action)
            .unwrap()
            .unwrap()
            .bounds
            .size
            .height,
        px(44.)
    );
    select(&mut app, "");
    assert!(!app.shows(action));
    assert!(!app.shows("label:Clear all quotes"));

    select(&mut app, "this excerpt");
    app.press(action).unwrap();
    app.wait_for("label:Remove quote: this excerpt").unwrap();
    assert!(!app.shows(action));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbox_review_detail_reflects_remote_desktop_resolution_and_disables_duplicate_submit() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        call.resolve(workspace_host_state(1, "MacBook Pro"))
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
            "queue" => json!({"revision":0,"entries":[]}),
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
    let subscription_generation = std::sync::atomic::AtomicU64::new(2);
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let generation = subscription_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let handle = json!({"subscriptionId":data["subscriptionId"],"rootId":"root-a","generation":generation});
        call.resolve(handle.clone());
        sub_tx.send(handle).unwrap();
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
    app.wait_for("text:MacBook Pro").unwrap();
    app.send_host_event("ios.hostState", workspace_host_state(2, "Office Mac"))
        .unwrap();
    app.wait_for("text:Office Mac").unwrap();

    // Desktop resolves the interaction while iPhone is viewing ReviewDetailScreen.
    resolved_remotely.store(true, std::sync::atomic::Ordering::SeqCst);
    let watch = loop {
        let handle = fixture_recv(&mut sub_rx).await;
        if handle["subscriptionId"]
            .as_str()
            .unwrap()
            .starts_with("review:")
        {
            break handle;
        }
    };
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "subscriptionId": watch["subscriptionId"],
            "rootId": "root-a",
            "generation": watch["generation"],
            "item": DeliveryPage::Preview { page: PreviewPage::Empty { host_epoch: "ea".into() } }
        }),
    )
    .unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    app.wait_for("label:Deny").unwrap();
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "subscriptionId": watch["subscriptionId"],
            "rootId": "root-a",
            "generation": watch["generation"],
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
            "projects" => json!({"kind":"projects","projects":[],"next":null}),
            "mcpConfigurations" => json!({"locations":[
                {"location":"user:agents","path":"/config/mcp.json","revision":"mcp-basis","servers":[]}
            ]}),
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
            "save" => json!({"kind":"future_web_result"}),
            "saveKey" if data["secret"] == "bad-web-key" => json!({"kind":"invalid_key"}),
            "saveKey" => json!({"kind":"updated","snapshot":web}),
            "manageMcpServer" => json!({"kind":"changed"}),
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
    app.press("label:Advanced options").unwrap();
    app.type_text("label:Request body overlay", "{").unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:Enter a JSON object.").unwrap();
    assert!(rx.try_recv().is_err());
    app.clear("label:Request body overlay").unwrap();
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
    app.type_text("label:API Key", "bad-web-key").unwrap();
    app.press("label:Save API key").unwrap();
    app.wait_for("text:Invalid API key").unwrap();
    assert!(!app.shows("text:Could not save the search API key."));
    assert_eq!(rx.try_recv().unwrap().0["method"], "saveKey");
    app.clear("label:API Key").unwrap();
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
    app.press("label:Search provider").unwrap();
    app.choose_menu_item("Brave").unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:Could not read or update settings.")
        .unwrap();
    let (call, _) = rx.try_recv().unwrap();
    assert_eq!(call["method"], "save");
    assert_eq!(call["input"]["settings"]["backend"]["kind"], "brave");
    app.press("label:Search provider").unwrap();
    app.choose_menu_item("Tavily").unwrap();
    app.press("label:Settings").unwrap();

    app.press("label:MCP").unwrap();
    app.wait_for("label:Add MCP server").unwrap();
    app.press("label:Add MCP server").unwrap();
    app.type_text("label:Name", "test-server").unwrap();
    app.press("label:Protocol").unwrap();
    app.choose_menu_item("HTTP").unwrap();
    app.type_text("label:URL", "https://example.test/mcp")
        .unwrap();
    let headers = "label:Header environment references (JSON)";
    app.type_text(headers, "{").unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:Enter a JSON object.").unwrap();
    assert!(rx.try_recv().is_err());
    app.clear(headers).unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:Refresh and try again.").unwrap();
    assert!(!app.shows("text:Could not save the MCP server."));
    let (call, _) = rx.try_recv().unwrap();
    assert_eq!(call["method"], "manageMcpServer");
    assert_eq!(call["input"]["revision"], "mcp-basis");
    assert_eq!(call["input"]["name"], "test-server");
    app.clear("label:Name").unwrap();
    app.press("label:Protocol").unwrap();
    app.choose_menu_item("stdio").unwrap();
    app.press("label:MCP").unwrap();
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
        "instruction":"Check changes.","model":{"connectionId":"fixture","modelId":"test-model","serviceTier":"fast"},"thinkingLevel":null,"enabled":true,"availability":{"kind":"available"}});
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
            ("agent", "queue") => json!({"revision":0,"entries":[]}),
            ("agent", "pendingInteractions") => json!({"revision":0,"entries":[]}),
            ("agent", "botOutbox") => json!({"isBot":false,"through":0,"readThrough":0}),
            ("agent", "projects") => json!({"kind":"projects","next":null,"projects":[
                {"reference":{"id":"project"},"name":"Fixture workspace","path":"/work","archived":false,"available":true}
            ]}),
            ("agent", "presets") => {
                let mut other = preset.clone();
                other["id"] = json!("work-preset");
                other["name"] = json!("Work reviewer");
                other["model"]["connectionId"] = json!("work");
                json!([preset, other])
            }
            ("agent", "preset") => json!({"preset":preset,"availability":{"kind":"available"}}),
            ("settings", "models") => json!({"kind":"ready","revision":9,"next":null,"choices":[
                {"selection":model,"label":"Fixture model","connectionName":"Personal","thinkingLevels":["low","high"]},
                {"selection":{"connectionId":"work","modelId":"test-model"},"label":"Fixture model","connectionName":"Work","thinkingLevels":[]},
                {"selection":{"connectionId":"work","modelId":"unique"},"label":"Unique model","connectionName":"Work","thinkingLevels":[]},
                {"selection":{"connectionId":"solo","modelId":"solo"},"label":"Solo model","connectionName":"Solo","thinkingLevels":[]}
            ]}),
            ("settings", "connections") => {
                let next = (data["input"]["kind"] == "start").then_some(2);
                let provider = json!({"packageId":"fixture","entryId":"provider","scope":"root","name":"acme"});
                let rows = if next.is_some() {
                    json!([
                        {"basis":{"connectionId":"fixture","revision":1},"slug":"personal","name":"Personal","provider":provider},
                        {"basis":{"connectionId":"solo","revision":1},"slug":"solo","name":"Solo",
                         "provider":{"packageId":"different","entryId":"provider","scope":"root","name":"acme"}}
                    ])
                } else {
                    json!([{"basis":{"connectionId":"work","revision":1},"slug":"work","name":"Work","provider":provider}])
                };
                json!({"kind":"ready","revision":7,"connections":rows,"defaultTarget":null,"next":next})
            }
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
            "manageMcpServer" if data["input"]["name"] == "future-server" =>
                json!({"kind":"future_mcp_result"}),
            "createPreset" | "updatePreset" | "manageMcpServer" => json!({"kind":"saved"}),
            "deletePreset" => json!({"kind":"deleted"}),
            "setEnabled" => json!({"status":"rejected","reason":"invalid_source"}),
            "editComposition" => json!({"status":"committed","value":source}),
            "installUrl" if data["input"]["url"] == "https://example.com/invalid.maka-plugin" =>
                json!({"status":"rejected","reason":"invalid_bundle","diagnostic":"private plugin diagnostic"}),
            "installUrl" if data["input"]["url"] == "https://example.com/offline.maka-plugin" => {
                tx.send(data).unwrap();
                call.reject("private plugin diagnostic");
                return;
            }
            "installUrl" => json!({"status":"committed","value":{"source":source,"package":{"id":"new.plugin","revision":"v2"}}}),
            "trustProjectMcp" => json!({"kind":"trusted"}),
            "update" if data["endpoint"] == "skills" => {
                tx.send(data).unwrap();
                call.reject("Skill management is disabled");
                return;
            }
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
    app.wait_for("text:/Fixture model · Personal/").unwrap();
    app.wait_for("text:/Fixture model · Work/").unwrap();
    app.press("label:Add subagent").unwrap();
    app.wait_for("label:Name").unwrap();
    app.press("label:Model").unwrap();
    assert_eq!(
        app.menu()
            .unwrap()
            .into_iter()
            .map(|entry| entry.label)
            .collect::<Vec<_>>(),
        [
            "Fixture model · Personal",
            "Fixture model · Work",
            "Unique model · Work",
            "Solo model"
        ]
    );
    app.choose_menu_item("Fixture model · Work").unwrap();
    app.type_text("label:Name", "New reviewer").unwrap();
    app.press("label:Save").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "createPreset");
    assert_eq!(write["input"]["model"]["modelId"], "test-model");
    assert_eq!(write["input"]["model"]["connectionId"], "work");
    app.press("label:Build reviewer").unwrap();
    app.wait_for("label:Instructions").unwrap();
    app.press("label:Model").unwrap();
    let entries = app.menu().unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.checked == Some(true))
            .map(|entry| entry.label.as_str())
            .collect::<Vec<_>>(),
        ["Fixture model · Personal"]
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.label.ends_with(" · Personal"))
            .count(),
        1
    );
    app.choose_menu_item("Fixture model · Personal").unwrap();
    app.type_text("label:Instructions", "Check documentation too.")
        .unwrap();
    app.press("label:Save").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "updatePreset");
    assert_eq!(write["input"]["expectedRevision"], 8);
    assert_eq!(write["input"]["model"]["serviceTier"], "fast");
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
    app.wait_for("text:The selected deployment source is invalid.")
        .unwrap();
    assert_eq!(write["method"], "setEnabled");
    assert_eq!(write["input"]["instance"], json!(["key"]));
    app.press("label:Plugins").unwrap();
    for (url, message) in [
        (
            "https://example.com/invalid.maka-plugin",
            "The plugin bundle is invalid.",
        ),
        (
            "https://example.com/offline.maka-plugin",
            "Could not install the plugin.",
        ),
    ] {
        app.type_text("label:URL", url).unwrap();
        app.press("label:Install").unwrap();
        app.wait_for(&format!("text:{message}")).unwrap();
        assert!(!app.shows("text:/private plugin diagnostic/"));
        let write = writes.try_recv().unwrap();
        assert_eq!(write["method"], "installUrl");
        assert_eq!(write["input"]["url"], url);
        assert!(writes.try_recv().is_err());
        app.clear("label:URL").unwrap();
    }
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
    app.clear("label:Name").unwrap();
    app.type_text("label:Name", "future-server").unwrap();
    app.press("label:Save").unwrap();
    app.wait_for("text:Could not save the MCP server.").unwrap();
    assert_eq!(writes.try_recv().unwrap()["input"]["name"], "future-server");
    app.clear("label:Name").unwrap();
    app.type_text("label:Name", "new-server").unwrap();
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
    app.wait_for("label:Update").unwrap();
    app.press("label:Update").unwrap();
    app.wait_for("text:Could not read or update settings.")
        .unwrap();
    assert!(!app.shows("text:/Skill management is disabled/"));
    let write = writes.try_recv().unwrap();
    assert_eq!(write["method"], "update");
    assert_eq!(write["input"]["reference"], "skill-ref");
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
                "queue" => json!({"revision":0,"entries":[]}),
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
            "queue" => json!({"revision":0,"entries":[]}),
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
                    1 => json!({"kind":"room","page":{"items":[message(2,"m2","Initial room message"),message(3,"m3","Live room message")],"through":1,"before":"m3"}}),
                    2 => json!({"kind":"room","page":{"items":[message(4,"m4","Reconnected room message")],"through":2,"before":"m4"}}),
                    _ => json!({"kind":"room","page":{"items":[message(4,"m4","Reconnected room message"),message(5,"m5","Updated room after reconnect")],"through":3,"before":"m5"}}),
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
    let subscription_generation = std::sync::atomic::AtomicU64::new(3);
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let generation = subscription_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let handle = json!({"rootId":"root","subscriptionId":data["subscriptionId"],"generation":generation});
        call.resolve(handle.clone());
        if data["method"] == "watch" {
            watch_tx.send(handle).unwrap();
        }
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
    let mut choose_quote = watch_quote_menus(&mut app);
    app.wait_for("label:Conversation: Release Room").unwrap();
    app.press("label:Conversation: Release Room").unwrap();
    app.wait_for("text:Initial room message").unwrap();
    pull_at_transcript_start(&mut app);
    let (input, earlier, value) = earlier_rx.try_recv().unwrap();
    assert_eq!(input["input"]["position"]["messageId"], "m2");
    assert_eq!(input["input"]["through"], 0);
    let watch = watch_rx.try_recv().unwrap();
    phase.store(1, std::sync::atomic::Ordering::SeqCst);
    app.send_host_event(
        "ios.subscriptionItem",
        json!({"rootId":"root","generation":watch["generation"],"subscriptionId":watch["subscriptionId"],
        "item":{"kind":"room","through":1,"revision":1}}),
    )
    .unwrap();
    app.wait_for("text:Live room message").unwrap();
    earlier.resolve(json!({"value":value}));
    app.wait_for("text:Earlier room message").unwrap();
    assert!(app.press("label:Select model").is_err());
    assert!(!app.shows("label:Quote"));
    assert!(!choose_quote(&mut app, "text:Live room message", None));
    assert!(!app.shows("label:Clear all quotes"));
    app.type_text("label:Message composer", "Hi Room").unwrap();
    app.press("label:Send message").unwrap();
    let input = send_rx.try_recv().unwrap();
    assert!(input["backend"].is_null());
    assert_eq!(input["message"], "Hi Room");
    assert!(input.get("quotes").is_none());
    app.wait_for("text:Initial room message").unwrap();
    pull_at_transcript_start(&mut app);
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
    assert!(
        !app.shows("Initial room message"),
        "a disjoint Room tail retained the old window"
    );
    assert!(
        !app.shows("Earlier room message"),
        "a disjoint Room tail retained the old window"
    );
    let new_watch = fixture_recv(&mut watch_rx).await;
    let deliver = |app: &mut Headless, mut handle: Value| {
        handle["item"] = json!({"kind":"room","through":3,"revision":3});
        app.send_host_event("ios.subscriptionItem", handle).unwrap();
    };
    phase.store(3, std::sync::atomic::Ordering::SeqCst);
    deliver(&mut app, watch);
    assert!(
        !app.screen()
            .matches("text:Updated room after reconnect")
            .unwrap()
    );
    deliver(&mut app, new_watch);
    app.wait_for("text:Updated room after reconnect").unwrap();
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
            "queue" => json!({"revision":0,"entries":[]}),
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
    pull_at_transcript_start(&mut app);
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
    app.wait_for("text:1 queued").unwrap();
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
    app.host()
        .send("ios.subscriptionItem", delivery(13))
        .unwrap();
    let gap = fixture_recv(&mut tail_rx).await;
    let mut new_tail = history(
        2,
        168,
        "Later text after missing bytes",
        Some(json!({"fixture":"new-edge"})),
    );
    new_tail["chunks"][0]["totalBytes"] = json!(198);
    gap.resolve(json!({"value":new_tail}));
    app.wait_for("text:Later text after missing bytes").unwrap();
    assert!(
        !app.shows("Earlier user message"),
        "tail with a byte gap kept the old window"
    );
    assert!(!app.shows(&final_text));
    assert!(
        !app.shows("role:button[Copy reply]"),
        "a disconnected fragment was offered as a complete reply"
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
                {"label":"Other Kimi model","selection":{"kind":"model","connectionId":"other","modelId":"other-model"}},
                {"label":"Standalone model","selection":{"kind":"model","connectionId":"solo","modelId":"standalone"}}
            ],"next":null}),
            ("agent", "queue") => json!({"revision":0,"entries":[]}),
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
            ("settings", "connections") => json!({"kind":"ready","revision":1,"next":null,
                "defaultTarget":{"connectionId":"kimi","modelId":"kimi-k2.5"},"connections":[
                    {"basis":{"connectionId":"kimi","revision":1},"name":"Personal","slug":"kimi",
                        "provider":{"packageId":"fixture","entryId":"kimi","scope":"root","name":"kimi"}},
                    {"basis":{"connectionId":"other","revision":1},"name":"Work","slug":"other",
                        "provider":{"packageId":"fixture","entryId":"kimi","scope":"root","name":"kimi"}},
                    {"basis":{"connectionId":"solo","revision":1},"name":"Solo connection","slug":"solo",
                        "provider":{"packageId":"another","entryId":"kimi","scope":"root","name":"kimi"}}
                ]}),
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
    app.wait_for("text:Kimi default · Personal").unwrap();
    app.press("label:Model").unwrap();
    let entries = app.menu().unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.label.as_str())
            .collect::<Vec<_>>(),
        [
            "Kimi default · Personal",
            "Other Kimi model · Work",
            "Standalone model"
        ]
    );
    app.close_menu().unwrap();
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
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    let channel = HostChannel::new();
    let host_state = |generation, revision| {
        let host = json!({"rootId":"root","hostName":"Relay Host","generation":generation,"endpoints":["agent","settings"]});
        json!({"revision":revision,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}})
    };
    channel.handle("ios.bootstrap", move |call| call.resolve(host_state(1, 1)));
    let model = |connection| json!({"kind":"model","connectionId":connection,"modelId":"shared","serviceTier":"fast","thinkingLevel":"high"});
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
            Some("queue") => json!({"revision":0,"entries":[]}),
            Some("pendingInteractions") => json!({"entries":[]}),
            Some("botOutbox") => json!({"isBot":false}),
            Some("models") => json!({"kind":"ready","choices":[
                {"label":"Shared model","selection":{"kind":"model","connectionId":"first","modelId":"shared","serviceTier":null,"thinkingLevel":null}},
                {"label":"Shared model","selection":{"kind":"model","connectionId":"second","modelId":"shared","serviceTier":null,"thinkingLevel":null}},
                {"label":"Unique model","selection":{"kind":"model","connectionId":"second","modelId":"unique"}},
                {"label":"Solo model","selection":{"kind":"model","connectionId":"solo","modelId":"solo"}},
                {"label":"Native agent","selection":{"kind":"executor","selection":{"executor":"codex","settings":{"runtime":"cli","model":"gpt-5"}}}}
            ]}),
            Some("connections") => {
                let rows = if data["input"]["kind"] == "start" {
                    json!([
                        {"basis":{"connectionId":"first","revision":1},"name":"First connector","slug":"first",
                            "provider":{"packageId":"multi","entryId":"provider","scope":"root","name":"fixture"}},
                        {"basis":{"connectionId":"solo","revision":1},"name":"Solo connector","slug":"solo",
                            "provider":{"packageId":"single","entryId":"provider","scope":"root","name":"fixture"}}
                    ])
                } else {
                    json!([{"basis":{"connectionId":"second","revision":1},"name":"Second connector","slug":"second",
                        "provider":{"packageId":"multi","entryId":"provider","scope":"root","name":"fixture"}}])
                };
                let next = (data["input"]["kind"] == "start").then_some(2);
                json!({"kind":"ready","revision":1,"connections":rows,"next":next,"defaultTarget":null})
            }
            _ => {
                call.reject("unexpected query");
                return;
            }
        };
        call.resolve(json!({"value":value}));
    });
    let generation = Arc::new(AtomicU64::new(1));
    let subscription_generation = AtomicU64::new(3);
    let (watch_tx, mut watches) = mpsc::unbounded_channel();
    channel.handle("ios.subscribe", move |mut call| {
        let data = call.take_data();
        let generation = subscription_generation.fetch_add(1, Ordering::SeqCst);
        let handle = json!({"rootId":"root","generation":generation,"subscriptionId":data["subscriptionId"]});
        call.resolve(handle.clone());
        if data["method"] == "watch" {
            watch_tx.send(handle).unwrap();
        }
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

    let mut choose = watch_native_menu_items(&mut app, |_| {});
    app.wait_for("label:Conversation: Chat").unwrap();
    app.set_viewport(Size::new(px(375.), px(812.))).unwrap();
    app.press("label:Conversation: Chat").unwrap();
    app.wait_for("text:work").unwrap();
    app.wait_for("id:chat-keyboard-model").unwrap();
    choose(&mut app, "Shared model · First connector");
    assert!(
        mutations.try_recv().is_err(),
        "reselecting must preserve tier and thinking"
    );
    *session.lock().unwrap() = row(2, model("first"));
    hold_observe.store(true, Ordering::SeqCst);
    generation.store(2, Ordering::SeqCst);
    app.send_host_event("ios.hostState", host_state(2, 2))
        .unwrap();
    let (observe, snapshot) = observations.try_recv().unwrap();
    app.wait_for("id:chat-keyboard-model >> text:Default")
        .unwrap();
    observe.resolve(json!({"value":snapshot}));
    app.wait_for("text:Shared model · First connector").unwrap();
    app.type_text("label:Message composer", "Prior configured model")
        .unwrap();
    app.press("label:Send message").unwrap();
    let (first_send, first_receipt) = mutations.try_recv().unwrap();
    assert_eq!(first_send["generation"], 2);
    assert_eq!(first_send["input"]["backend"], model("first"));
    first_receipt
        .unwrap()
        .resolve(json!({"value":SendResult::Queued {
            session_id:"chat".into(), message_id:"prior".into(), revision:1, completion:None
        }}));
    assert!(app.settle());
    app.type_text("label:Message composer", "Wait for the fresh snapshot")
        .unwrap();

    *session.lock().unwrap() = row(3, model("first"));
    hold_observe.store(true, Ordering::SeqCst);
    generation.store(3, Ordering::SeqCst);
    app.send_host_event("ios.hostState", host_state(3, 3))
        .unwrap();
    let (observe, snapshot) = observations.try_recv().unwrap();
    app.press("label:Send message").unwrap();
    assert!(
        mutations.try_recv().is_err(),
        "sent before the current observation"
    );
    observe.resolve(json!({"value":snapshot}));
    assert!(app.settle());
    let (refreshed_send, receipt) = mutations.try_recv().unwrap();
    assert_eq!(refreshed_send["generation"], 3);
    assert_eq!(refreshed_send["input"]["backend"], model("first"));
    assert_eq!(
        refreshed_send["input"]["message"],
        "Wait for the fresh snapshot"
    );
    receipt.unwrap().resolve(queued_result("refreshed", 1));
    assert!(app.settle());
    app.type_text("label:Message composer", "First draft")
        .unwrap();

    hold_selection.store(true, Ordering::SeqCst);
    choose(&mut app, "Shared model · Second connector");
    assert!(!app.screen().enabled("id:chat-keyboard-model").unwrap());
    let (selection, commit) = mutations.try_recv().unwrap();
    assert_eq!(selection["method"], "selectBackend");
    assert_eq!(selection["generation"], 3);
    assert!(
        mutations.try_recv().is_err(),
        "sent before the model selection committed"
    );
    commit
        .unwrap()
        .resolve(json!({"value":{"kind":"committed","session":*session.lock().unwrap()}}));
    app.wait_for("text:Shared model · Second connector")
        .unwrap();
    app.press("label:Send message").unwrap();
    let (call, receipt) = mutations.try_recv().unwrap();
    let send: Send = serde_json::from_value(call["input"].clone()).unwrap();
    assert_eq!(call["generation"], 3);
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

    choose(&mut app, "Shared model · First connector");
    let (first, _) = mutations.try_recv().unwrap();
    assert_eq!(first["input"]["backend"]["connectionId"], "first");
    choose(&mut app, "Shared model · Second connector");
    let (second, _) = mutations.try_recv().unwrap();
    assert_eq!(second["method"], "selectBackend");
    let select: SelectBackend = serde_json::from_value(second["input"].clone()).unwrap();
    let backend = serde_json::to_value(select.backend).unwrap();
    assert_eq!(backend["connectionId"], "second");
    assert!(backend["serviceTier"].is_null());
    app.wait_for("text:Shared model · Second connector")
        .unwrap();

    app.clear("label:Message composer").unwrap();

    // An ended watch event arriving while a stale running observe is in flight
    // must schedule a catch-up observe rather than sticking in the running state.
    let watch = std::iter::from_fn(|| watches.try_recv().ok())
        .last()
        .unwrap();
    hold_observe.store(true, Ordering::SeqCst);
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "rootId": "root",
            "subscriptionId": watch["subscriptionId"],
            "generation": watch["generation"],
            "item": { "kind": "events", "through": 2, "events": [{ "runId": "r1", "fact": { "kind": "opened" } }] }
        }),
    )
    .unwrap();
    let (stale_observe, _) = observations.try_recv().unwrap();
    app.send_host_event(
        "ios.subscriptionItem",
        json!({
            "rootId": "root",
            "subscriptionId": watch["subscriptionId"],
            "generation": watch["generation"],
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
    app.wait_for("label:Stop current reply").unwrap();
    let (catch_up_observe, idle_snapshot) = observations
        .try_recv()
        .expect("ended event during an in-flight observe must schedule a catch-up observe");
    let mut idle_snapshot = idle_snapshot;
    idle_snapshot["through"] = json!(3);
    catch_up_observe.resolve(json!({ "value": idle_snapshot }));
    assert!(app.settle());
    assert!(
        !app.screen().matches("label:Stop current reply").unwrap(),
        "catch-up observe after ended must clear the running state"
    );
    let executor = json!({"kind":"executor","selection":{"executor":"codex",
        "settings":{"runtime":"cli","model":"gpt-5","thinkingLevel":"high"}}});
    *session.lock().unwrap() = row(8, executor.clone());
    generation.store(4, Ordering::SeqCst);
    app.send_host_event("ios.hostState", host_state(4, 4))
        .unwrap();
    app.wait_for("text:Native agent").unwrap();
    choose(&mut app, "Native agent");
    assert!(
        mutations.try_recv().is_err(),
        "reselecting the executor must not overwrite its settings"
    );

    app.clear("label:Message composer").unwrap();
    app.type_text(
        "label:Message composer",
        "Executor with configured thinking",
    )
    .unwrap();
    app.press("label:Send message").unwrap();
    let (sent, receipt) = mutations.try_recv().unwrap();
    assert_eq!(sent["generation"], 4);
    assert_eq!(sent["input"]["backend"], executor);
    receipt.unwrap().resolve(json!({"value":SendResult::Queued {
        session_id:"chat".into(), message_id:"executor".into(), revision:2, completion:None
    }}));
    assert!(app.settle());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_defaults_use_all_pages_and_preserve_manual_edits() {
    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host = json!({"rootId":"root","hostName":"Naming Host","generation":1,"endpoints":["agent","settings","authentication"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let identity = json!({"packageId":"fixture.provider","entryId":"provider","scope":"profile","name":"acme_cloud"});
    let summary = |id: &str, slug: &str, name: &str, provider: &Value| {
        json!({"basis":{"connectionId":id,"revision":1},"slug":slug,"name":name,"provider":provider,
            "enabled":true,"enabledModelCount":0,"editable":true,"usageLimits":false})
    };
    let initial = vec![
        summary(
            "other",
            "other",
            "Other",
            &json!({"packageId":"other.provider","entryId":"provider","scope":"profile","name":"other"}),
        ),
        summary("original", "legacy-acme", " Acme ", &identity),
    ];
    let catalog = Arc::new(std::sync::Mutex::new(initial));
    let query_catalog = catalog.clone();
    let provider_identity = identity.clone();
    let fail_continuation = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let fail_read = fail_continuation.clone();
    let (catalog_tx, mut catalog_reads) = mpsc::unbounded_channel();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let input = &data["input"];
        let value = match data["method"].as_str().unwrap() {
            "list" => json!({"sessions":[]}),
            "botOutbox" => json!({"isBot":false}),
            "connections" => {
                catalog_tx.send(input.clone()).unwrap();
                let rows = query_catalog.lock().unwrap();
                let revision = rows.len();
                if input["kind"] == "continue" && fail_read.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    call.resolve(json!({"value":{"kind":"changed","revision":revision + 1}}));
                    return;
                }
                let (connections, next) = if input["kind"] == "start" {
                    (&rows[..1], Some(1))
                } else {
                    (&rows[1..], None)
                };
                json!({"kind":"ready","revision":revision,"connections":connections,"next":next,"defaultTarget":null})
            }
            "models" => json!({"kind":"ready","revision":1,"choices":[],"next":null}),
            "externalAgents" => json!({"runtimes":[],"state":{"kind":"disabled"}}),
            "providers" => json!({"next":null,"providers":[{"label":"Acme","identity":provider_identity}]}),
            "provider" => json!({"identity":provider_identity,"descriptor":{"label":"Acme",
                "configurationDefaults":{},"configurationSchema":{},"authentication":[],"anonymous":true}}),
            "connection" => {
                let rows = query_catalog.lock().unwrap();
                let Some(row) = rows.iter().find(|row| row["basis"]["connectionId"] == input["connectionId"]) else {
                    call.reject("connection not found");
                    return;
                };
                json!({"kind":"ready","name":row["name"],"enabled":true,"enabledModelCount":0,
                    "target":{"connectionId":row["basis"]["connectionId"],"revision":1,"slug":row["slug"],
                        "configuration":{},"provider":row["provider"]},
                    "editing":{"enabledModelIds":[],"discoveredModelIds":[],"modelOverrides":null,"requestBodyOverlay":null}})
            }
            "credentialStatus" => json!({"kind":"status","status":{"locator":input["locator"],"configured":false,
                "credentialId":null,"revision":null}}),
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
            json!({"rootId":"root","generation":1,"subscriptionId":data["subscriptionId"]}),
        );
    });
    let (save_tx, mut saves) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let input = &data["input"];
        let mut rows = catalog.lock().unwrap();
        let revision = rows.len();
        save_tx.send(data.clone()).unwrap();
        if data["method"] != "create" || input["expectedCatalogRevision"] != revision {
            call.reject("expected a create using the displayed catalog revision");
            return;
        }
        let draft = &input["connection"];
        let slug = draft["slug"].as_str().unwrap();
        let name = draft["name"].as_str().unwrap();
        if let Err(error) = maka_agent_facts::configuration::validation::slug(slug) {
            call.reject(error);
            return;
        }
        if rows.iter().any(|row| row["slug"] == slug) {
            call.reject("duplicate slug");
            return;
        }
        rows.push(summary(slug, slug, name, &draft["provider"]));
        call.resolve(
            json!({"value":{"kind":"committed","connection":{"connectionId":slug,"revision":1}}}),
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
    app.wait_for("label:Settings").unwrap();
    app.press("label:Settings").unwrap();
    app.press("label:Models & Connections").unwrap();
    app.wait_for("label:Add connection").unwrap();
    let assert_catalog = |reads: &mut mpsc::UnboundedReceiver<Value>, revision| {
        assert_eq!(reads.try_recv().unwrap(), json!({"kind":"start"}));
        assert_eq!(
            reads.try_recv().unwrap(),
            json!({"kind":"continue","offset":1,"revision":revision})
        );
        assert!(reads.try_recv().is_err());
    };
    assert_catalog(&mut catalog_reads, 2);
    app.press("label:Add connection").unwrap();
    for (revision, expected_name, expected_slug) in [
        (2, "Acme 2", "acme-cloud"),
        (3, "Acme 3", "acme-cloud-2"),
        (4, "Acme 4", "acme-cloud-3"),
    ] {
        app.wait_for("label:Acme").unwrap();
        app.press("label:Acme").unwrap();
        app.wait_for("label:Name").unwrap();
        assert_eq!(
            app.screen().input_text("label:Name").unwrap(),
            Some(expected_name)
        );
        assert_eq!(
            app.screen().input_text("label:Connection ID").unwrap(),
            Some(expected_slug)
        );
        assert!(
            catalog_reads.try_recv().is_err(),
            "opening the editor refetched the catalog"
        );
        let (name, slug) = if revision == 4 {
            app.clear("label:Name").unwrap();
            app.type_text("label:Name", "Personal Acme").unwrap();
            app.clear("label:Connection ID").unwrap();
            app.type_text("label:Connection ID", "personal-acme")
                .unwrap();
            ("Personal Acme", "personal-acme")
        } else {
            (expected_name, expected_slug)
        };
        if revision == 3 {
            fail_continuation.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        app.press("label:Save").unwrap();
        let data = saves.try_recv().unwrap();
        assert_eq!(data["generation"], 1);
        assert_eq!(data["input"]["connection"]["name"], name);
        assert_eq!(data["input"]["connection"]["slug"], slug);
        assert_eq!(data["input"]["expectedCatalogRevision"], revision);
        app.wait_for_gone("label:Connection ID", Duration::from_secs(2))
            .unwrap();
        assert_catalog(&mut catalog_reads, revision + 1);
        app.press("label:Provider").unwrap();
        if revision == 3 {
            assert!(
                app.press("label:Acme").is_err(),
                "obsolete catalog must not open an editor"
            );
            app.press("label:Models & Connections").unwrap();
            app.wait_for("label:Retry").unwrap();
            app.press("label:Retry").unwrap();
            assert_catalog(&mut catalog_reads, 4);
            app.press("label:Add connection").unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_menus_work_without_permission_to_read_connections() {
    use maka_agent_api::contract::SendResult;
    use nsh_core::{EventKind, EventPayload, MountItem};

    let channel = HostChannel::new();
    channel.handle("ios.bootstrap", |call| {
        let host = json!({"rootId":"root","hostName":"Restricted Host","generation":1,"endpoints":["agent","settings"]});
        call.resolve(json!({"revision":1,"hosts":[host],"active":host,
            "connections":{"root":{"status":"connected","connection":host}}}));
    });
    let session = Arc::new(std::sync::Mutex::new(json!({
        "id":"chat","kind":"agent","title":"Permission test","parentSessionId":null,"workspace":{"path":"/work"},
        "revision":1,"backend":{"kind":"model","connectionId":"a","modelId":"a"},
        "updatedAt":1700000000000u64,"activity":"idle"
    })));
    let read = session.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let row = read.lock().unwrap().clone();
        let value = match data["method"].as_str() {
            Some("connections") => {
                call.reject("settings.connections not granted");
                return;
            }
            Some("list") => json!({"sessions":[row]}),
            Some("observe") => json!({"session":row,"through":0,"run":null}),
            Some("history") => json!({"kind":"ready","chunks":[],"through":0,"before":null}),
            Some("queue") => json!({"revision":0,"entries":[]}),
            Some("pendingInteractions") => json!({"entries":[]}),
            Some("botOutbox") => json!({"isBot":false}),
            Some("projects") => json!({"kind":"projects","projects":[],"next":null}),
            Some("directories") => json!({"kind":"roots","roots":[{"name":"Work","path":"/work"}]}),
            Some("models") => json!({"kind":"ready","revision":1,"next":null,"choices":[
                {"label":"First model","selection":{"kind":"model","connectionId":"a","modelId":"a"}},
                {"label":"Second model","selection":{"kind":"model","connectionId":"b","modelId":"b"}}
            ]}),
            _ => { call.reject("unexpected query"); return; }
        };
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":"root","generation":1,"subscriptionId":data["subscriptionId"]}),
        );
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let (writes_tx, mut writes) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        let result = match data["method"].as_str() {
            Some("selectBackend") => {
                let mut row = session.lock().unwrap();
                row["revision"] = json!(2);
                row["backend"] = data["input"]["backend"].clone();
                json!({"kind":"committed","session":*row})
            }
            Some("send") => json!(SendResult::Queued {
                session_id: "chat".into(),
                message_id: "queued".into(),
                revision: 1,
                completion: None
            }),
            _ => {
                call.reject("unexpected mutation");
                return;
            }
        };
        writes_tx.send(data).unwrap();
        call.resolve(json!({"value":result}));
    });
    let mut config = engine_config(channel, tokio::runtime::Handle::current());
    config.viewport = Size::new(px(390.), px(844.));
    config.environment = Environment {
        os: Os::Ios,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    let (menu_tx, mut menus) = mpsc::unbounded_channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ComponentProps { id, props } = item
                && let Some(items) = props.iter().find_map(|(name, value)| {
                    if name.as_ref() == "items" {
                        value.as_ref()?.as_array()
                    } else {
                        None
                    }
                })
                && let Some(choice) = items.iter().find(|item| item["label"] == "Second model")
            {
                menu_tx.send((*id, choice["id"].clone())).unwrap();
            }
        }
    });
    app.wait_for("label:Conversation: Permission test").unwrap();
    app.press("label:Conversation: Permission test").unwrap();
    app.wait_for("id:chat-keyboard-model").unwrap();
    let item = std::iter::from_fn(|| menus.try_recv().ok()).last().unwrap();
    select_native_item(&mut app, item);
    app.wait_for("id:chat-keyboard-model >> text:Second model")
        .unwrap();
    assert_eq!(writes.try_recv().unwrap()["method"], "selectBackend");
    app.type_text("label:Message composer", "Send with restricted settings")
        .unwrap();
    app.press("label:Send message").unwrap();
    let send = writes.try_recv().unwrap();
    assert_eq!(send["method"], "send");
    assert_eq!(send["input"]["backend"]["connectionId"], "b");

    app.back().unwrap();
    app.press("label:New Chat").unwrap();
    app.wait_for("text:Unavailable").unwrap();
    let (id, choice) = std::iter::from_fn(|| menus.try_recv().ok()).last().unwrap();
    app.engine().control().dispatch_event(
        id,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "select".into(),
            data: choice,
        },
    );
    app.wait_for("text:Second model").unwrap();
    assert!(app.screen().enabled("label:Start Chat").unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_settings_reload_after_reconnect_and_refresh_the_host_default_summary() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let channel = HostChannel::new();
    let host_state = |generation| {
        let host = json!({"rootId":"root","hostName":"Models Host","generation":generation,"endpoints":["agent","settings"]});
        let offline = json!({"rootId":"offline","hostName":"Offline Host","endpoints":[]});
        json!({"revision":generation,"hosts":[host,offline],"active":host,
            "connections":{"root":{"status":"connected","connection":host},"offline":{"status":"offline"}}})
    };
    channel.handle("ios.bootstrap", move |call| call.resolve(host_state(1)));
    let (pending_tx, mut pending) = mpsc::unbounded_channel();
    let hold = Arc::new(AtomicBool::new(false));
    let hold_read = hold.clone();
    let hold_presets = Arc::new(AtomicBool::new(false));
    let pending_presets = hold_presets.clone();
    let default_work = Arc::new(AtomicBool::new(false));
    let read_default = default_work.clone();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        let target = |id| json!({"connectionId":id,"modelId":"same"});
        let value = match (data["endpoint"].as_str(), data["method"].as_str()) {
            (Some("settings"), Some("connections")) => {
                let provider = json!({"packageId":"fixture","entryId":"provider","scope":"profile","name":"fixture"});
                let row = |id, name| json!({"basis":{"connectionId":id,"revision":1},"name":name,"slug":id,"provider":provider});
                let current = if read_default.load(Ordering::SeqCst) { "work" } else { "personal" };
                let page = json!({"kind":"ready","revision":5,"next":null,"defaultTarget":target(current),
                    "connections":[row("personal","Personal"),row("work","Work")]});
                if hold_read.swap(false, Ordering::SeqCst) {
                    pending_tx.send((call, page)).unwrap();
                    return;
                }
                page
            }
            (Some("settings"), Some("resolveModel")) => json!({"kind":"ready","choice":{
                "label":"Shared model","selection":data["input"],"thinkingLevels":[],"defaultThinkingLevel":null
            }}),
            (Some("settings"), Some("models")) => json!({"kind":"ready","revision":5,"next":null,"choices":[
                {"label":"Shared model","selection":target("personal"),"thinkingLevels":[]},
                {"label":"Shared model","selection":target("work"),"thinkingLevels":[]}
            ]}),
            (Some("agent"), Some("presets")) => {
                let preset = |name| json!([{"id":"preset","name":name,"description":"","instruction":"",
                    "enabled":true,"availability":{"kind":"available"},"model":target("work")}]);
                if pending_presets.swap(false, Ordering::SeqCst) {
                    pending_tx.send((call, preset("Old generation preset"))).unwrap();
                    return;
                }
                preset("New generation preset")
            }
            (_, Some("externalAgents")) => json!({"runtimes":[],"state":{"kind":"disabled"}}),
            (_, Some("list")) => json!({"sessions":[]}),
            (_, Some("botOutbox")) => json!({"isBot":false}),
            _ => { call.reject("unexpected query"); return; }
        };
        call.resolve(json!({"value":value}));
    });
    channel.handle("ios.subscribe", |mut call| {
        let data = call.take_data();
        call.resolve(
            json!({"rootId":data["rootId"],"generation":1,"subscriptionId":data["subscriptionId"]}),
        );
    });
    channel.handle("ios.unsubscribe", |call| {
        call.resolve(json!({"cancelled":true}))
    });
    let (writes_tx, mut writes) = mpsc::unbounded_channel();
    channel.handle("ios.hostMutate", move |mut call| {
        let data = call.take_data();
        if data["method"] != "setDefault" {
            call.reject("unexpected mutation");
            return;
        }
        default_work.store(true, Ordering::SeqCst);
        writes_tx.send(data).unwrap();
        call.resolve(json!({"value":{"kind":"committed","revision":6}}));
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
    app.wait_for("text:Connected · Shared model · Personal")
        .unwrap();
    app.press("label:Computer: Models Host").unwrap();

    hold.store(true, Ordering::SeqCst);
    app.press("label:Models & Connections").unwrap();
    let (old, page) = pending.try_recv().unwrap();
    app.send_host_event("ios.hostState", host_state(2)).unwrap();
    old.resolve(json!({"value":page}));
    app.wait_for("label:Add connection").unwrap();
    assert!(app.screen().enabled("label:Add connection").unwrap());
    app.press("label:Default model").unwrap();
    app.choose_menu_item("Shared model · Work").unwrap();
    let write = writes.try_recv().unwrap();
    assert_eq!(write["generation"], 2);
    assert_eq!(write["input"]["target"]["connectionId"], "work");
    app.back().unwrap();
    app.back().unwrap();
    app.wait_for("text:Connected · Shared model · Work")
        .unwrap();

    app.press("label:Computer: Models Host").unwrap();
    hold_presets.store(true, Ordering::SeqCst);
    app.press("label:Subagents").unwrap();
    let (old, stale) = pending.try_recv().unwrap();
    app.send_host_event("ios.hostState", host_state(3)).unwrap();
    old.resolve(json!({"value":stale}));
    app.wait_for("label:New generation preset").unwrap();
    assert!(!app.shows("Old generation preset"));
}

const GOAL_ID: &str = "00000000-0000-4000-8000-000000000007";

fn goal_record(status: &str, revision: u64) -> Value {
    json!({
        "id":GOAL_ID, "revision":revision, "objective":"Review database migrations", "status":status,
        "iterations":3,"tokenBudget":2000,"consumed":{"known":1234,"missing":0},
        "remainingTokens":766,"elapsedSeconds":45,"createdAt":1,"retryAt":null,
        "pending":false,"dismissed":false,"note":"Reviewed the schema.","report":null
    })
}

fn goal_view(current: Value) -> Value {
    json!({"enabled":true,"current":current})
}

impl SideChatFixture {
    fn open_native_goal(&mut self, label: &str) {
        let id = {
            let config = self.header.lock().unwrap();
            config
                .as_ref()
                .and_then(|config| more_menu_action(config, label))
                .filter(|action| action.enabled)
                .unwrap_or_else(|| panic!("missing UIKit Goal menu item: {label}"))
                .id
        };
        select_header_item(&mut self.app, id);
        self.app.wait_for("id:chat-goal-sheet-scroll").unwrap();
    }

    fn goal_frame(&mut self, sub: &Value, item: Value) {
        self.app
            .send_host_event(
                "ios.subscriptionItem",
                json!({
                    "subscriptionId":sub["subscriptionId"],"rootId":"root",
                    "generation":sub["generation"],"item":item
                }),
            )
            .unwrap();
        assert!(self.app.settle());
    }

    async fn expect_goal_unsubscribe(&mut self, sub: &Value) {
        loop {
            let handle = fixture_recv(&mut self.unsubscribed).await;
            if handle["subscriptionId"] == sub["subscriptionId"] {
                assert_eq!(handle["generation"], sub["generation"]);
                return;
            }
        }
    }

    async fn goal_read(&mut self, session: &str) -> HostCall {
        let (data, call) = fixture_recv(&mut self.goal_reads).await;
        assert_eq!(data["rootId"], "root");
        assert_eq!(data["input"], json!({"sessionId":session}));
        call
    }

    async fn goal_commit(&mut self, call: HostCall, record: Value) {
        call.resolve(json!({"value":{"kind":"committed","goalId":record["id"],"revision":record["revision"]}}));
        self.goal_read("main")
            .await
            .resolve(json!({"value":goal_view(record)}));
        assert!(self.app.settle());
    }
}

fn open_goal(app: &mut Headless, label: &str) {
    app.press("label:More").unwrap();
    app.choose_menu_item(label).unwrap();
    app.wait_for("id:chat-goal-sheet-scroll").unwrap();
}

fn enter_goal_text(app: &mut Headless, id: &str, text: &str) {
    let selector = format!("id:{id}");
    app.clear(&selector).unwrap();
    if !text.is_empty() {
        app.type_text(&selector, text).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_capability_and_watches_follow_visible_agent_and_forked_side_chat() {
    use nsh_core::platform::Lifecycle;

    let mut fx = side_chat_fixture(false, false);
    let mut native_quote = watch_quote_menus(&mut fx.app);
    fx.app.press("label:Conversation: Room Chat").unwrap();
    fx.app.wait_for("text:Room message").unwrap();
    assert!(
        !std::iter::from_fn(|| fx.subscriptions.try_recv().ok())
            .any(|sub| sub["method"] == "watchGoal")
    );
    fx.app.press("label:More").unwrap();
    assert!(fx.app.choose_menu_item("New Goal…").is_err());
    fx.app.close_menu().unwrap();
    fx.app.press("label:Chats").unwrap();

    fx.open_main();
    fx.app.press("label:More").unwrap();
    assert!(
        fx.app.choose_menu_item("New Goal…").is_err(),
        "before the first frame"
    );
    fx.app.close_menu().unwrap();
    let main = fx.subscription("watchGoal", None).await;
    assert_eq!(main["input"], json!({"sessionId":"main"}));
    fx.goal_frame(&main, json!({"enabled":false,"current":null}));
    fx.app.press("label:More").unwrap();
    assert!(
        fx.app.choose_menu_item("New Goal…").is_err(),
        "Host disabled it"
    );
    fx.app.close_menu().unwrap();
    fx.goal_frame(
        &main,
        json!({"enabled":false,"current":goal_record("paused",1)}),
    );
    open_goal(&mut fx.app, "Goal Details…");
    fx.app
        .wait_for("text:Goals are turned off on this computer.")
        .unwrap();
    assert!(!fx.app.screen().matches("id:goal-toggle").unwrap());
    fx.app.press("id:goal-close").unwrap();
    assert!(fx.mutations.try_recv().is_err());

    assert!(native_quote(
        &mut fx.app,
        "text:Later durable answer",
        Some("Later durable answer")
    ));
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app.wait_for("text:Side Question").unwrap();
    assert!(!fx.app.screen().matches("label:More").unwrap());
    fx.expect_goal_unsubscribe(&main).await;
    assert!(
        !std::iter::from_fn(|| fx.subscriptions.try_recv().ok())
            .any(|sub| sub["method"] == "watchGoal")
    );

    fx.app
        .type_text("label:Message composer", "A separate question")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    let (_, fork) = fx.mutation("fork").await;
    let backend = json!({"kind":"model","connectionId":"selected","modelId":"selected-model","thinkingLevel":"high"});
    *fx.backend.lock().unwrap() = backend.clone();
    fork.resolve(json!({"value":{"kind":"forked","session":side_session("new-side","A separate question",&backend)}}));
    let (input, send) = fx.mutation("send").await;
    assert_eq!(input["sessionId"], "new-side");
    send.resolve(
        json!({"value":{"kind":"rejected","sessionId":"new-side","reason":"turn_stopped"}}),
    );

    let child = fx.subscription("watchGoal", None).await;
    assert_eq!(child["input"], json!({"sessionId":"new-side"}));
    fx.goal_frame(&child, goal_view(Value::Null));
    open_goal(&mut fx.app, "New Goal…");
    enter_goal_text(&mut fx.app, "goal-objective", "Child objective");
    fx.app.press("id:goal-save").unwrap();
    let (create, receipt) = fx.mutation("changeGoal").await;
    assert_eq!(create["sessionId"], "new-side");
    assert_eq!(create["approval"]["target"]["sessionId"], "new-side");
    assert_eq!(create["approval"]["backend"], backend);
    receipt.resolve(json!({"value":{"kind":"committed","goalId":GOAL_ID,"revision":1}}));
    fx.goal_read("new-side")
        .await
        .resolve(json!({"value":goal_view(goal_record("active",1))}));
    fx.app.wait_for("text:Review database migrations").unwrap();

    fx.app
        .set_environment("background", |env| env.lifecycle = Lifecycle::Background)
        .unwrap();
    fx.expect_goal_unsubscribe(&child).await;
    fx.app.wait_for("text:Last synced · Read-only").unwrap();
    fx.app
        .set_environment("foreground", |env| env.lifecycle = Lifecycle::Active)
        .unwrap();
    let back = fx.subscription("watchGoal", None).await;
    assert_eq!(back["input"], child["input"]);
    assert_ne!(back["subscriptionId"], child["subscriptionId"]);
    fx.goal_frame(&child, goal_view(goal_record("cancelled", 20)));
    assert!(!fx.app.shows("text:Goal Cancelled"));
    fx.goal_frame(&back, goal_view(goal_record("paused", 2)));
    fx.app.wait_for("text:Goal Paused").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_create_validates_inputs_and_uses_observed_authority_without_touching_the_draft() {
    use nsh_testing::DialogAnswer;

    let mut fx = side_chat_fixture(false, false);
    *fx.backend.lock().unwrap() = json!({
        "kind":"model","connectionId":"chosen","modelId":"m","serviceTier":"priority","thinkingLevel":"high"
    });
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(Value::Null));
    fx.app
        .type_text("label:Message composer", "Keep this as a chat draft")
        .unwrap();
    open_goal(&mut fx.app, "New Goal…");
    assert_eq!(
        fx.app.screen().input_text("id:goal-objective").unwrap(),
        Some("")
    );
    enter_goal_text(&mut fx.app, "goal-objective", "\u{0085}\u{2003}");
    assert!(fx.app.press("id:goal-save").is_err());
    enter_goal_text(
        &mut fx.app,
        "goal-objective",
        "\u{0085} Write the migration plan \u{2003}",
    );
    for invalid in ["0", "-1", "1.5", "1e3", "9007199254740992", "+3", "0x10"] {
        enter_goal_text(&mut fx.app, "goal-budget", invalid);
        assert!(fx.app.press("id:goal-save").is_err(), "{invalid}");
    }
    enter_goal_text(&mut fx.app, "goal-budget", "");
    fx.app.press_key("escape").unwrap();
    assert!(
        fx.app.screen().matches("id:goal-objective").unwrap(),
        "dirty edit stayed open"
    );
    fx.app.answer_dialogs_myself();
    fx.app.press("id:goal-close").unwrap();
    assert_eq!(
        fx.app.pending_dialog().unwrap().title.as_deref(),
        Some("Discard goal edits?")
    );
    fx.app
        .answer_dialog(DialogAnswer::Press("Keep Editing".into()))
        .unwrap();
    assert!(fx.mutations.try_recv().is_err());

    fx.app.compose("id:goal-objective", "qianyi").unwrap();
    assert!(
        fx.app.press("id:goal-save").is_err(),
        "do not submit marked text"
    );
    assert!(fx.mutations.try_recv().is_err());
    fx.app.compose("id:goal-objective", "").unwrap();
    fx.app.press("id:goal-save").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(
        input,
        json!({
            "kind":"create","sessionId":"main","objective":"Write the migration plan","tokenBudget":null,"start":true,
            "approval":{
                "target":{"sessionId":"main","workspace":{"path":"/work"},
                    "permissions":{"access":"read_only","requestPermissions":true},"boundaryRevision":12,
                    "binding":{"id":"00000000-0000-4000-8000-000000000001","permissionEpoch":3}},
                "backend":*fx.backend.lock().unwrap()
            }
        })
    );
    assert!(
        fx.app.press("id:goal-save").is_err(),
        "in-flight mutation disables submission"
    );
    let mut goal = goal_record("active", 1);
    goal["objective"] = input["objective"].clone();
    fx.goal_commit(call, goal).await;
    fx.app.wait_for("text:Write the migration plan").unwrap();
    assert!(!fx.app.screen().matches("id:goal-objective").unwrap());
    fx.app.press("id:goal-close").unwrap();
    assert_eq!(
        fx.app
            .screen()
            .input_text("label:Message composer")
            .unwrap(),
        Some("Keep this as a chat draft")
    );
    assert!(
        fx.mutations.try_recv().is_err(),
        "closing does not send a mutation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_cannot_create_from_list_metadata_without_observed_authority() {
    let mut fx = side_chat_fixture(false, false);
    fx.goal_authority
        .store(false, std::sync::atomic::Ordering::Relaxed);
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(Value::Null));
    open_goal(&mut fx.app, "New Goal…");
    enter_goal_text(&mut fx.app, "goal-objective", "A separate objective");
    fx.app.press("id:goal-save").unwrap();
    fx.app
        .wait_for("text:Could not verify this chat’s settings. Review them and try again.")
        .unwrap();
    assert_eq!(
        fx.app.screen().input_text("id:goal-objective").unwrap(),
        Some("A separate objective")
    );
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_controls_use_host_revision_pending_and_budget_completeness() {
    use nsh_testing::DialogAnswer;
    let mut fx = side_chat_fixture(false, false);
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(goal_record("armed", 1)));
    fx.app.wait_for("text:work · Goal Ready").unwrap();
    open_goal(&mut fx.app, "Goal Details…");
    fx.app.press("id:goal-toggle").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "resume");
    assert_eq!(input["revision"], 1);
    assert_eq!(input["goalId"], GOAL_ID);
    assert_eq!(input["approval"]["target"]["sessionId"], "main");
    let mut active = goal_record("active", 2);
    active["pending"] = json!(true);
    active["retryAt"] = json!(4_000_000_000_000u64);
    fx.goal_commit(call, active).await;
    fx.app.wait_for("text:/Next attempt:/").unwrap();
    assert!(!fx.app.screen().matches("id:goal-complete").unwrap());
    fx.app.press("id:goal-toggle").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(
        input,
        json!({"kind":"control","sessionId":"main","goalId":GOAL_ID,"revision":2,"action":"pause"})
    );
    let mut paused = goal_record("paused", 3);
    paused["pending"] = json!(true);
    fx.goal_commit(call, paused).await;
    fx.app.wait_for("text:Goal Paused").unwrap();
    fx.app.press("id:goal-toggle").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "resume");
    assert!(input.get("approval").is_none());
    let mut blocked = goal_record("blocked", 4);
    blocked["note"] = json!("A dependency is unavailable.");
    fx.goal_commit(call, blocked.clone()).await;
    fx.app
        .wait_for("text:A dependency is unavailable.")
        .unwrap();

    fx.app.press("id:goal-edit-budget").unwrap();
    enter_goal_text(&mut fx.app, "goal-budget", "3500");
    fx.app.press("id:goal-save").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "set_budget");
    assert_eq!(input["budget"], json!({"tokenBudget":3500}));
    assert!(input.get("approval").is_none());
    blocked["revision"] = json!(5);
    blocked["tokenBudget"] = json!(3500);
    fx.goal_commit(call, blocked).await;
    fx.app.wait_for("text:3,500 tokens").unwrap();

    let mut limited = goal_record("budget_limited", 6);
    limited["tokenBudget"] = json!(1234);
    limited["remainingTokens"] = json!(0);
    fx.goal_frame(&sub, goal_view(limited.clone()));
    fx.app.wait_for("text:Goal Budget Limited").unwrap();
    assert!(
        !fx.app.screen().matches("id:goal-toggle").unwrap(),
        "no bare resume"
    );
    fx.app.press("id:goal-adjust").unwrap();
    assert_eq!(
        fx.app.screen().input_text("id:goal-budget").unwrap(),
        Some("1234")
    );
    assert!(
        fx.app.press("id:goal-save").is_err(),
        "the existing cap must not be removed implicitly"
    );
    assert!(fx.mutations.try_recv().is_err());
    enter_goal_text(&mut fx.app, "goal-budget", "4321");
    fx.app.press("id:goal-save").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "resume");
    assert_eq!(input["budget"], json!({"tokenBudget":4321}));
    assert_eq!(input["revision"], 6);
    limited["revision"] = json!(7);
    limited["consumed"]["missing"] = json!(1);
    limited["report"] = json!({"status":"progress","note":limited["note"]});
    fx.goal_commit(call, limited.clone()).await;
    fx.app.wait_for("text:At least 1,234 tokens").unwrap();
    assert_eq!(
        fx.app.screen().count("text:Reviewed the schema.").unwrap(),
        1
    );
    fx.app.wait_for("text:Unknown · Incomplete usage").unwrap();
    assert!(!fx.app.shows("text:0 tokens"));
    assert!(!fx.app.screen().matches("id:goal-adjust").unwrap());

    let mut older = goal_record("cancelled", 6);
    older["objective"] = json!("Old goal");
    fx.goal_frame(&sub, goal_view(older));
    limited["consumed"]["known"] = json!(1235);
    limited["elapsedSeconds"] = json!(51);
    fx.goal_frame(&sub, goal_view(limited));
    fx.app.wait_for("text:At least 1,235 tokens").unwrap();
    fx.app.wait_for("text:51 s").unwrap();

    fx.app.press("id:goal-remove-limit").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "resume");
    assert_eq!(input["budget"], json!({"tokenBudget":null}));
    assert_eq!(input["revision"], 7);
    let mut active = goal_record("active", 8);
    active["consumed"]["missing"] = json!(1);
    active["tokenBudget"] = Value::Null;
    fx.goal_commit(call, active).await;
    assert_eq!(fx.app.screen().count("text:Unlimited").unwrap(), 2);
    fx.app.answer_dialogs_myself();
    fx.app.press("id:goal-cancel").unwrap();
    fx.app
        .answer_dialog(DialogAnswer::Press("Keep Goal".into()))
        .unwrap();
    assert!(fx.mutations.try_recv().is_err());
    fx.app.press("id:goal-cancel").unwrap();
    fx.app
        .answer_dialog(DialogAnswer::Press("Cancel Goal".into()))
        .unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "cancel");
    let mut cancelled = goal_record("cancelled", 9);
    cancelled["pending"] = json!(true);
    fx.goal_commit(call, cancelled.clone()).await;
    fx.app
        .wait_for("text:Waiting for this turn to finish.")
        .unwrap();
    assert!(fx.app.press("id:goal-new").is_err());
    assert!(!fx.app.screen().matches("id:goal-dismiss").unwrap());
    cancelled["pending"] = json!(false);
    cancelled["revision"] = json!(10);
    fx.goal_frame(&sub, goal_view(cancelled.clone()));
    fx.app.press("id:goal-dismiss").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "dismiss");
    cancelled["dismissed"] = json!(true);
    cancelled["revision"] = json!(11);
    fx.goal_commit(call, cancelled).await;
    assert!(!fx.app.screen().matches("id:goal-dismiss").unwrap());
    fx.app.press("id:goal-close").unwrap();
    assert!(!fx.app.shows("text:work · Goal Cancelled"));
    // A new Host record, not a local "hidden" bit, owns the summary.
    let mut next = goal_record("paused", 12);
    next["id"] = json!("00000000-0000-4000-8000-000000000008");
    fx.goal_frame(&sub, goal_view(next));
    fx.app.wait_for("text:work · Goal Paused").unwrap();
    open_goal(&mut fx.app, "Goal Details…");
    fx.app.press("id:goal-complete").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "complete");
    let mut achieved = goal_record("achieved", 13);
    achieved["id"] = input["goalId"].clone();
    fx.goal_commit(call, achieved).await;
    fx.app.wait_for("text:Goal Achieved").unwrap();
    fx.app.press("id:goal-new").unwrap();
    fx.app.wait_for("id:goal-objective").unwrap();
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_conflict_rejections_and_disconnect_read_back_without_replaying_changes() {
    let mut fx = side_chat_fixture(false, false);
    use nsh_core::{Command, MountItem};
    let (announcement_tx, mut announcements) = mpsc::unbounded_channel();
    fx.app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::Command {
                command: Command::Announce(message),
                ..
            } = item
            {
                announcement_tx.send(message.clone()).unwrap();
            }
        }
    });
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    let active = goal_record("active", 4);
    fx.goal_frame(&sub, goal_view(active.clone()));
    open_goal(&mut fx.app, "Goal Details…");
    fx.app.press("id:goal-toggle").unwrap();
    let (_, call) = fx.mutation("changeGoal").await;
    call.resolve(json!({"value":{"kind":"conflict","actual":5}}));
    let query = fx.goal_read("main").await;
    fx.goal_frame(&sub, goal_view(goal_record("blocked", 5)));
    query.resolve(json!({"value":goal_view(active)}));
    fx.app
        .wait_for("text:The goal changed. Review it and try again.")
        .unwrap();
    fx.app.wait_for("text:Goal Blocked").unwrap();

    assert_eq!(
        fixture_recv(&mut announcements).await,
        "The goal changed. Review it and try again."
    );
    let mut usage_update = goal_record("blocked", 5);
    usage_update["elapsedSeconds"] = json!(46);
    fx.goal_frame(&sub, goal_view(usage_update));
    fx.app.wait_for("text:46 s").unwrap();
    assert!(
        announcements.try_recv().is_err(),
        "meter updates must not interrupt VoiceOver"
    );

    for (reason, message) in [
        (
            "goal_current_unfinished",
            "Finish or cancel the current goal first.",
        ),
        ("goal_disabled", "Goals are turned off on this computer."),
        (
            "goal_status_tool_unavailable",
            "Enable Goal tools for this chat to start or resume a goal.",
        ),
        (
            "scheduler_authorization_changed",
            "Chat settings changed. Review them and try again.",
        ),
        (
            "goal_authorization_changed",
            "Chat settings changed. Review them and try again.",
        ),
        (
            "future_reason",
            "The computer rejected the goal change: future_reason",
        ),
    ] {
        fx.app.press("id:goal-toggle").unwrap();
        let (_, call) = fx.mutation("changeGoal").await;
        call.resolve(json!({"value":{"kind":"rejected","reason":reason}}));
        fx.goal_read("main")
            .await
            .resolve(json!({"value":goal_view(goal_record("blocked",5))}));
        fx.app.wait_for(&format!("text:{message}")).unwrap();
        assert_eq!(fixture_recv(&mut announcements).await, message);
        assert!(fx.app.settle());
    }

    fx.app.press("id:goal-toggle").unwrap();
    let (_, call) = fx.mutation("changeGoal").await;
    fx.app
        .send_host_event("ios.hostState", side_host_state(2, None))
        .unwrap();
    call.reject("Connection interrupted");
    fx.app.wait_for("text:Last synced · Read-only").unwrap();
    fx.app
        .wait_for("text:Could not confirm the goal change. Check its status before trying again.")
        .unwrap();
    assert!(fx.app.press("id:goal-toggle").is_err());
    fx.app
        .send_host_event("ios.hostState", side_host_state(3, Some(8)))
        .unwrap();
    assert!(fx.app.settle());
    let reconnected = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(goal_record("cancelled", 99)));
    fx.goal_frame(&reconnected, goal_view(goal_record("active", 6)));
    fx.app.wait_for("text:Goal in Progress").unwrap();
    assert!(
        fx.mutations.try_recv().is_err(),
        "never reissued the lost mutation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_sheet_fits_landscape_ime_and_transcript_omits_the_internal_prompt() {
    use nsh_core::platform::ColorScheme;

    let mut continuation = quote_history_row(1, "user", "Internal continuation instructions");
    continuation["origin"] =
        json!({"kind":"goal","goalId":GOAL_ID,"objective":"Review database migrations"});
    let (_, answer) = side_history_rows();
    let subtitle = "production-schema-migration-review-for-november-release";
    let mut fx = side_chat_fixture_with_history(
        false,
        false,
        Os::Ios,
        vec![continuation, answer],
        &format!("/work/{subtitle}"),
    );
    fx.app.set_viewport(Size::new(px(600.), px(844.))).unwrap();
    fx.open_main();
    fx.app
        .wait_for("label:Continuing goal: Review database migrations")
        .unwrap();
    assert!(!fx.app.shows("text:Internal continuation instructions"));
    let sub = fx.subscription("watchGoal", None).await;
    let mut compact = goal_record("paused", 1);
    compact["objective"] = json!("A".repeat(150));
    fx.goal_frame(&sub, goal_view(compact));
    let context_label = |app: &Headless| {
        let node = app
            .screen()
            .layout_nodes()
            .into_iter()
            .find(|node| node.test_id.as_deref() == Some("chat-context-label"))
            .unwrap();
        (node.bounds, node.text.unwrap().text.text.to_string())
    };
    assert_eq!(
        context_label(&fx.app).1,
        format!("{subtitle} · Goal Paused")
    );
    fx.app.set_viewport(Size::new(px(375.), px(812.))).unwrap();
    fx.app
        .set_environment("larger type", |env| env.font_scale = 1.45)
        .unwrap();
    let (label_bounds, label) = context_label(&fx.app);
    assert_eq!(label, subtitle);
    let pill = fx
        .app
        .screen()
        .layout("id:chat-context")
        .unwrap()
        .unwrap()
        .bounds;
    assert!(pill.origin.x >= px(16.) && pill.origin.x + pill.size.width <= px(359.));
    assert!(label_bounds.origin.x + label_bounds.size.width <= pill.origin.x + pill.size.width);
    fx.open_native_goal("Goal Details…");
    let sheet = "id:chat-goal-sheet-scroll";
    fx.app.wait_for(sheet).unwrap();
    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        fx.app
            .set_environment("Goal appearance", |env| env.color_scheme = scheme)
            .unwrap();
        for selector in ["id:goal-close", "id:goal-toggle", "id:goal-cancel"] {
            assert_dock_touch_target(&fx.app, selector);
            assert_chat_button_contrast(&mut fx.app, selector, None, button_text_color);
        }
    }
    fx.app.press("id:goal-close").unwrap();
    fx.app.set_viewport(Size::new(px(844.), px(390.))).unwrap();
    fx.app
        .set_environment("landscape keyboard and safe area", |env| {
            env.font_scale = 1.;
            env.keyboard_height = px(240.);
            env.safe_area.left = px(47.);
            env.safe_area.right = px(47.);
            env.safe_area.bottom = px(34.);
        })
        .unwrap();
    let composer_before = fx
        .app
        .screen()
        .layout("id:chat-composer")
        .unwrap()
        .unwrap()
        .bounds;
    assert_eq!(
        composer_before.origin.y + composer_before.size.height,
        px(150.)
    );
    assert!(!fx.app.screen().matches("id:chat-context").unwrap());
    fx.goal_frame(&sub, goal_view(goal_record("active", 2)));
    assert_eq!(
        fx.app
            .screen()
            .layout("id:chat-composer")
            .unwrap()
            .unwrap()
            .bounds,
        composer_before
    );
    fx.open_native_goal("Goal Details…");
    fx.app.wait_for(sheet).unwrap();
    reveal_sheet_target(&mut fx.app, sheet, "id:goal-toggle");
    reveal_sheet_target(&mut fx.app, sheet, "id:goal-edit-budget");
    fx.app.press("id:goal-edit-budget").unwrap();
    reveal_sheet_target(&mut fx.app, sheet, "id:goal-budget");
    assert_dock_touch_target(&fx.app, "id:goal-budget");
    enter_goal_text(&mut fx.app, "goal-budget", "3000");
    reveal_sheet_target(&mut fx.app, sheet, "id:goal-save");
    assert_dock_touch_target(&fx.app, "id:goal-save");
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_budget_limited_can_cancel_a_pending_turn_and_mark_a_settled_goal_complete() {
    use nsh_testing::DialogAnswer;

    let mut fx = side_chat_fixture(false, false);
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    let mut limited = goal_record("budget_limited", 1);
    limited["pending"] = json!(true);
    fx.goal_frame(&sub, goal_view(limited));
    open_goal(&mut fx.app, "Goal Details…");
    assert!(!fx.app.screen().matches("id:goal-complete").unwrap());
    fx.app.answer_dialogs_myself();
    fx.app.press("id:goal-cancel").unwrap();
    fx.app
        .answer_dialog(DialogAnswer::Press("Cancel Goal".into()))
        .unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "cancel");
    assert_eq!(input["revision"], 1);
    fx.goal_commit(call, goal_record("cancelled", 2)).await;
    fx.app.wait_for("text:Goal Cancelled").unwrap();

    let mut next = goal_record("budget_limited", 3);
    next["id"] = json!("00000000-0000-4000-8000-000000000008");
    fx.goal_frame(&sub, goal_view(next));
    fx.app.press("id:goal-complete").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["action"], "complete");
    assert_eq!(input["revision"], 3);
    let mut achieved = goal_record("achieved", 4);
    achieved["id"] = input["goalId"].clone();
    fx.goal_commit(call, achieved).await;
    fx.app.wait_for("text:Goal Achieved").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_continuations_do_not_appear_in_the_pending_dock_or_its_count() {
    const INTERNAL: &str = "Continue using these internal Goal instructions";
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), empty_queue()).await;
    let goal = json!({
        "messageId":"goal-continuation","kind":"followup","preview":INTERNAL,
        "origin":{"kind":"goal","goalId":GOAL_ID,"objective":"Review database migrations"}
    });
    fx.queue_item(json!({"revision":1,"entries":[goal]}));
    assert!(!fx.app.screen().matches("id:composer-pending-dock").unwrap());
    assert!(!fx.app.shows("text:1 queued"));

    fx.queue_item(json!({"revision":2,"entries":[goal,
        {"messageId":"user-followup","kind":"followup","preview":"A user follow-up"}
    ]}));
    fx.app.press("label:Queued Messages (1)").unwrap();
    fx.app.wait_for("text:A user follow-up").unwrap();
    assert!(!fx.app.shows(&format!("text:{INTERNAL}")));
    assert_eq!(
        fx.app.screen().count("label:Edit queued message").unwrap(),
        1
    );
    fx.app.press("label:Edit queued message").unwrap();
    let (input, reply) = fx.call("queueMessage").await;
    assert_eq!(input["messageId"], "user-followup");
    reply.resolve(json!({"value":{"kind":"ready","revision":2,
        "message":"A user follow-up","hasAttachments":false,"quotes":[]}}));
    fx.app.wait_for("id:queue-message-editor").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_portrait_sheet_stays_below_the_notch_and_above_the_keyboard() {
    let mut fx = side_chat_fixture_on(false, false, Os::Ios, 1);
    fx.app.set_viewport(Size::new(px(375.), px(812.))).unwrap();
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(Value::Null));
    fx.open_native_goal("New Goal…");
    fx.app
        .set_environment("portrait keyboard and safe area", |env| {
            env.safe_area.top = px(47.);
            env.safe_area.bottom = px(34.);
            env.keyboard_height = px(320.);
        })
        .unwrap();
    for selector in ["id:chat-goal-sheet-scroll", "id:goal-close"] {
        assert_keyboard_target(&fx.app, selector, 16., 359., 492.);
        let bounds = fx.app.screen().layout(selector).unwrap().unwrap().bounds;
        assert!(bounds.origin.y >= px(47.), "{selector}: {bounds:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_late_readback_cannot_close_a_new_budget_editor() {
    use nsh_testing::DialogAnswer;
    let mut fx = side_chat_fixture(false, false);
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(goal_record("paused", 1)));
    open_goal(&mut fx.app, "Goal Details…");
    fx.app.press("id:goal-edit-budget").unwrap();
    enter_goal_text(&mut fx.app, "goal-budget", "3000");
    fx.app.press("id:goal-save").unwrap();
    let (_, call) = fx.mutation("changeGoal").await;
    call.resolve(json!({"value":{"kind":"committed","goalId":GOAL_ID,"revision":2}}));
    let readback = fx.goal_read("main").await;
    let mut committed = goal_record("paused", 2);
    committed["tokenBudget"] = json!(3000);
    fx.goal_frame(&sub, goal_view(committed.clone()));

    fx.app.answer_dialogs_myself();
    fx.app.press("id:goal-close").unwrap();
    fx.app
        .answer_dialog(DialogAnswer::Press("Discard Edits".into()))
        .unwrap();
    fx.app.press("id:goal-edit-budget").unwrap();
    enter_goal_text(&mut fx.app, "goal-budget", "4050");

    // A newer snapshot proves JS processed the held read, not just that the
    // draft was still there before its promise settled.
    committed["revision"] = json!(3);
    readback.resolve(json!({"value":goal_view(committed)}));
    fx.app
        .wait_for("text:The goal changed. Close the editor to review it.")
        .unwrap();
    assert_eq!(
        fx.app.screen().input_text("id:goal-budget").unwrap(),
        Some("4050")
    );
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_watch_ack_keeps_the_submitted_budget_editor_read_only_until_readback() {
    let mut fx = side_chat_fixture(false, false);
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(goal_record("paused", 1)));
    open_goal(&mut fx.app, "Goal Details…");
    fx.app.press("id:goal-edit-budget").unwrap();
    enter_goal_text(&mut fx.app, "goal-budget", "3000");
    fx.app.press("id:goal-save").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["budget"], json!({"tokenBudget":3000}));
    call.resolve(json!({"value":{"kind":"committed","goalId":GOAL_ID,"revision":2}}));
    let readback = fx.goal_read("main").await;
    let mut committed = goal_record("paused", 2);
    committed["tokenBudget"] = json!(3000);
    fx.goal_frame(&sub, goal_view(committed.clone()));

    // The editor has seen the watch frame, but its own save has not returned.
    fx.app
        .wait_for("text:The goal changed. Close the editor to review it.")
        .unwrap();
    assert!(fx.app.type_text("id:goal-budget", "4050").is_err());
    assert_eq!(
        fx.app.screen().input_text("id:goal-budget").unwrap(),
        Some("3000")
    );

    readback.resolve(json!({"value":goal_view(committed)}));
    fx.app.wait_for("text:3,000 tokens").unwrap();
    assert!(!fx.app.screen().matches("id:goal-budget").unwrap());
    fx.app.press("id:goal-edit-budget").unwrap();
    enter_goal_text(&mut fx.app, "goal-budget", "4050");
    assert_eq!(
        fx.app.screen().input_text("id:goal-budget").unwrap(),
        Some("4050")
    );
    assert!(fx.mutations.try_recv().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_sheet_can_reconnect_only_the_watch_without_losing_or_submitting_a_draft() {
    let mut fx = side_chat_fixture(false, false);
    fx.open_main();
    let sub = fx.subscription("watchGoal", None).await;
    fx.goal_frame(&sub, goal_view(Value::Null));
    open_goal(&mut fx.app, "New Goal…");
    enter_goal_text(&mut fx.app, "goal-objective", "Check the migration plan");
    enter_goal_text(&mut fx.app, "goal-budget", "3400");
    fx.app
        .send_host_event(
            "ios.subscriptionEnded",
            json!({
                "subscriptionId":sub["subscriptionId"],"rootId":"root",
                "generation":sub["generation"],"error":"watch interrupted"
            }),
        )
        .unwrap();
    fx.app.wait_for("text:Last synced · Read-only").unwrap();
    assert!(fx.app.press("id:goal-save").is_err());
    fx.app.press("id:goal-reconnect").unwrap();
    let reconnected = fx.subscription("watchGoal", None).await;
    assert_ne!(reconnected["subscriptionId"], sub["subscriptionId"]);
    assert_eq!(reconnected["input"], sub["input"]);
    fx.goal_frame(&reconnected, goal_view(Value::Null));
    assert!(fx.goal_reads.try_recv().is_err());
    assert!(fx.mutations.try_recv().is_err());
    fx.app.press("id:goal-save").unwrap();
    let (input, call) = fx.mutation("changeGoal").await;
    assert_eq!(input["objective"], "Check the migration plan");
    assert_eq!(input["tokenBudget"], 3400);
    fx.goal_commit(call, goal_record("active", 1)).await;
    fx.app.wait_for("text:Goal Details").unwrap();
}
