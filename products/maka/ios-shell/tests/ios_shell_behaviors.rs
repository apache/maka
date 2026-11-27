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
                history_tx.send(call).unwrap();
                return;
            }
            "observe" => json!({"session":observed,"through":0,"run":null}),
            "models" => json!({"kind":"ready","choices":[]}),
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
    let abandoned = fixture_recv(&mut history_rx).await;
    app.fast_forward(Duration::from_millis(70)).unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    app.press("label:Chats").unwrap();
    app.press(chat_row).unwrap();
    let history = fixture_recv(&mut history_rx).await;
    // Cross the previous visit's deadline, but not the new visit's.
    app.fast_forward(Duration::from_millis(149)).unwrap();
    assert!(!app.screen().matches(skeleton).unwrap());
    app.fast_forward(Duration::from_millis(1)).unwrap();
    assert!(app.screen().matches(skeleton).unwrap());
    abandoned.resolve(json!({"value":{"kind":"ready","through":0,"before":null,"chunks":[]}}));
    history.resolve(json!({"value":{
        "kind":"ready","through":1,"before":null,
        "chunks":[quote_history_row(1, "assistant", "Loaded transcript")]
    }}));
    app.wait_for("text:Loaded transcript").unwrap();
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
            "list" => chats_head.clone(),
            "botOutbox" if hold_bot_query.swap(false, Ordering::SeqCst) => {
                bot_tx.send(call).unwrap();
                return;
            }
            "botOutbox" => json!({"isBot":true,"through":2,"readThrough":0,"preview":"New bot preview"}),
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
    app.type_text("label:Search chats or projects", "Needle moved up")
        .unwrap();
    app.wait_for("text:No matches in loaded chats").unwrap();
    assert!(page_rx.try_recv().is_err(), "Chats must not auto-drain");
    app.press("label:Load more chats").unwrap();
    let (failed_query, failed_reply) = fixture_recv(&mut page_rx).await;
    assert_eq!(failed_query["input"]["position"]["revision"], "chats-1");
    failed_reply.reject("chat second page unavailable");
    app.wait_for("text:chat second page unavailable").unwrap();
    app.press("label:Retry").unwrap();
    let (retry_query, retry_reply) = fixture_recv(&mut page_rx).await;
    assert_eq!(
        retry_query["input"]["position"],
        json!({"kind":"after","revision":"chats-1","cursor":"s-31"})
    );
    retry_reply
        .resolve(json!({"value":page("chats-1", &[row(32, "Needle moved up")], Some("s-32"))}));
    app.wait_for("label:Conversation: Needle moved up").unwrap();

    // Swap rows across the boundary while a further page is outstanding.
    app.press("label:Load more chats").unwrap();
    let (old_query, old_reply) = fixture_recv(&mut page_rx).await;
    assert_eq!(
        old_query["input"]["position"],
        json!({"kind":"after","revision":"chats-1","cursor":"s-32"})
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
    old_reply.resolve(json!({"value":page("chats-1", &[row(33, "Needle stale")], None)}));
    assert!(app.settle());
    app.press("label:Clear search").unwrap();
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
    assert!(!app.screen().matches("label:Load more chats").unwrap());

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
async fn chat_streaming_collapsible_tools_inline_approval_and_queue_never_steers() {
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
            "pendingInteractions" if resolved => json!({"revision":2,"entries":[]}),
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
        } else if data["method"] == "respond" {
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

    // Stream live Markdown preview + queued turn over watch subscription.
    let (watch_handle, open_watch) = fixture_recv(&mut watch_rx).await;
    let watch_sub_id = &watch_handle["subscriptionId"];
    let generation = &watch_handle["generation"];
    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId":watch_sub_id,"rootId":"root-a","generation":1,
        "item":{"kind":"queue","queue":{"revision":2,"entries":[{"messageId":"stale","kind":"followup","preview":"Stale queued message"}]}}
    })).unwrap();
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
    assert!(!app.screen().matches("text:1 message queued").unwrap());

    app.send_host_event("ios.subscriptionItem", json!({
        "subscriptionId": watch_sub_id,
        "rootId": "root-a",
        "generation": generation,
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
    app.press("label:Files & Changes").unwrap();
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
    app.press("label:Files & Changes").unwrap();
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
            "models" => json!({"kind":"ready","choices":[]}),
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
        os: Os::MacOs,
        reduce_motion: true,
        ..Environment::default()
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("label:Conversation: Quotes Chat").unwrap();
    (app, send_rx)
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

fn quote_history_row(sequence: u64, role: &str, text: &str) -> Value {
    json!({"importedTurn":null,"field":"body","position":{"kind":"live","sequence":sequence,
        "fact":Uuid::from_u128(u128::from(sequence)),"itemIndex":0},
        "order":{"path":[sequence],"itemIndex":0},"offset":0,"totalBytes":text.len(),
        "messageId":format!("m{sequence}"),"turnId":"t1","role":role,"text":text,"tool":null})
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
    mutations: mpsc::UnboundedReceiver<(Value, HostCall)>,
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
    side_chat_fixture_with_history(default_model, missing_main, os, main_history)
}

fn side_chat_fixture_with_history(
    default_model: bool,
    missing_main: bool,
    os: Os,
    main_history: Vec<Value>,
) -> SideChatFixture {
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

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
    let (_, late) = side_history_rows();
    channel.handle("ios.hostQuery", move |mut call| {
        let data = call.take_data();
        assert_eq!(data["rootId"], "root");
        let input = &data["input"];
        let backend = observed_backend.lock().unwrap().clone();
        let missing_main = removed.load(Ordering::Relaxed);
        let main = json!({"id":"main","title":"Main Chat","kind":"agent","activity":"idle",
            "branch":null,"parentSessionId":null,"workspace":{"path":"/work"},"revision":2,
            "backend":backend});
        let room = json!({"id":"room","title":"Room Chat","kind":"room","activity":"idle",
            "branch":null,"parentSessionId":null,"workspace":{"path":"/work"},"revision":1});
        let saved = side_session("saved", "Saved side question", &backend);
        let value = match data["method"].as_str().unwrap() {
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
                json!({"session":session,"through":99,"run":null})
            }
            "history" if input["sessionId"] == "room" => json!({
                "kind":"room","page":{"items":[{
                    "id":"message","sequence":1, "content":{"text":"Room message"},
                    "author":{"kind":"human"}, "createdAt":0
                }],"through":1,"before":null,"after":null}
            }),
            "history" => {
                let chunks = if input["sessionId"] == "main" { main_history.clone() }
                    else { vec![late.clone()] };
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
    app.wait_for("label:Conversation: Room Chat").unwrap();
    SideChatFixture {
        app,
        mutations,
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

    fx.app.press("label:Send to Main Chat").unwrap();
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
    assert!(!fx.app.shows("label:More"));
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
    let mut fx = side_chat_fixture_with_history(false, false, Os::Ios, vec![blank]);
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
async fn side_chat_waits_for_the_parent_model_selection_to_commit() {
    use nsh_core::{EventKind, EventPayload, MountItem};

    let mut fx = side_chat_fixture_on(false, false, Os::Ios, 1);
    let (menu_tx, mut menus) = mpsc::unbounded_channel();
    fx.app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ComponentProps { id, props } = item {
                for (name, value) in props {
                    if name.as_ref() == "items"
                        && let Some(items) = value.as_ref().and_then(Value::as_array)
                        && let Some(model) =
                            items.iter().find(|item| item["label"] == "New side model")
                    {
                        menu_tx.send((*id, model["id"].clone())).unwrap();
                    }
                }
            }
        }
    });
    fx.open_main();
    let (menu, model) = tokio::time::timeout(Duration::from_secs(2), menus.recv())
        .await
        .unwrap()
        .unwrap();
    fx.app.engine().control().dispatch_event(
        menu,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "select".into(),
            data: model,
        },
    );
    fx.app.settle(); // The model RPC is intentionally still pending.
    let (selection, commit) = fx.mutation("selectBackend").await;
    fx.app.press("label:Quote >> nth=0").unwrap();
    fx.app.press("label:Ask Side Question").unwrap();
    fx.app
        .type_text("label:Message composer", "Use the just-selected model")
        .unwrap();
    fx.app.press("label:Send message").unwrap();
    assert!(
        fx.mutations.try_recv().is_err(),
        "forked before the model selection committed"
    );

    let backend = selection["backend"].clone();
    *fx.backend.lock().unwrap() = backend.clone();
    commit.resolve(json!({"value":{"kind":"committed","session":{
        "id":"main","title":"Main Chat","kind":"agent","revision":42,"backend":backend,
        "branch":null,"workspace":{"path":"/work"}
    }}}));
    let (input, fork) = fx.mutation("fork").await;
    assert_eq!(input["expectedRevision"], 42);
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
    assert_eq!(first.size.height, px(44.));
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
    app.wait_for("text:Could not send the message.").unwrap();
    app.wait_for("text:2 quotes").unwrap();

    app.press("label:Send message").unwrap();
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
async fn assistant_turn_with_tools_has_one_copy_and_quote_action_for_all_bodies() {
    let mut tool = quote_history_row(2, "assistant", "");
    tool["tool"] = json!({"toolUseId":"work","call":{"name":"Shell"}});
    let (mut app, mut sends) = quote_chat_fixture(
        vec![
            quote_history_row(1, "assistant", "**First** answer"),
            tool,
            quote_history_row(3, "assistant", "Second answer"),
        ],
        vec![],
        None,
    );
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:Second answer").unwrap();
    app.press("role:button[Copy reply]").unwrap();
    assert_eq!(
        app.screen().clipboard(),
        Some("**First** answer\n\nSecond answer")
    );
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
    app.wait_for("label:Load earlier messages").unwrap();
    assert!(!app.shows("role:button[Copy reply]"));
    assert!(!app.shows("role:button[Quote]"));
    assert!(choose_quote(&mut app, "text:Second answer", Some("Second")));
    app.wait_for("label:Remove quote: Second").unwrap();

    app.press("label:Load earlier messages").unwrap();
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

    // Edits during a pending send belong to the next draft.
    app.press("label:Clear all quotes").unwrap();
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
    app.wait_for("text:2 quotes").unwrap();
    app.press("label:Chats").unwrap();
    app.press("label:Conversation: Quotes Chat").unwrap();
    app.wait_for("text:2 quotes").unwrap();
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
    app.wait_for("text:1 quote").unwrap();
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
    app.wait_for_gone("label:Remove quote: First excerpt", Duration::from_secs(2))
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
                    2 => json!({"kind":"room","page":{"items":[message(4,"m4","Reconnected room message")],"through":2,"before":"m4"}}),
                    _ => json!({"kind":"room","page":{"items":[message(5,"m5","Updated room after reconnect")],"through":3,"before":"m5"}}),
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
    app.press("label:Load earlier messages").unwrap();
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
                {"label":"Other Kimi model","selection":{"kind":"model","connectionId":"other","modelId":"other-model"}},
                {"label":"Standalone model","selection":{"kind":"model","connectionId":"solo","modelId":"standalone"}}
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
    use nsh_core::{EventKind, EventPayload, MountItem};
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

    // Headless hosts the iOS view tree, not UIKit's native menu. Read the
    // displayed items and return the chosen ID through the native select event.
    let (menu_tx, mut menus) = mpsc::unbounded_channel();
    let (header_tx, mut headers) = mpsc::unbounded_channel();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ScreenConfig { config, .. } = item
                && config.title.as_deref() == Some("Chat")
            {
                header_tx.send(config.clone()).unwrap();
            }
            if let MountItem::ComponentProps { id, props } = item {
                for (name, value) in props {
                    if name.as_ref() == "items"
                        && let Some(items) = value.as_ref().and_then(Value::as_array)
                        && items
                            .iter()
                            .any(|item| item["label"] == "Shared model · Second connector")
                    {
                        menu_tx.send((*id, items.clone())).unwrap();
                    }
                }
            }
        }
    });
    app.wait_for("label:Conversation: Chat").unwrap();
    app.set_viewport(Size::new(px(375.), px(812.))).unwrap();
    app.press("label:Conversation: Chat").unwrap();
    app.wait_for("text:work").unwrap();
    let header = headers.try_recv().unwrap();
    assert!(
        header.title_view.is_none(),
        "UIKit must fit the title to its actual buttons"
    );
    assert!(header.back_visible);
    assert_eq!(header.right_items.len(), 2);
    app.wait_for("text:Shared model · First connector").unwrap();
    let (node, items) = std::iter::from_fn(|| menus.try_recv().ok()).last().unwrap();
    let checked: Vec<_> = items
        .iter()
        .filter(|item| item["checked"] == true)
        .map(|item| &item["label"])
        .collect();
    assert_eq!(checked, [&json!("Shared model · First connector")]);
    let selected = items.iter().find(|item| item["checked"] == true).unwrap();
    app.engine().control().dispatch_event(
        node,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "select".into(),
            data: selected["id"].clone(),
        },
    );
    assert!(app.settle());
    assert!(
        mutations.try_recv().is_err(),
        "reselecting must not overwrite tier or thinking level"
    );
    let choose =
        |app: &mut Headless, menus: &mut mpsc::UnboundedReceiver<(_, Vec<Value>)>, label| {
            let (id, items) = std::iter::from_fn(|| menus.try_recv().ok()).last().unwrap();
            assert_eq!(
                items
                    .iter()
                    .map(|item| item["label"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                [
                    "Shared model · First connector",
                    "Shared model · Second connector",
                    "Unique model · Second connector",
                    "Solo model",
                    "Native agent"
                ]
            );
            let item = items.iter().find(|item| item["label"] == label).unwrap();
            if label == "Native agent" {
                assert_eq!(item["checked"], true);
            }
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
    app.wait_for("text:Default").unwrap();
    choose(&mut app, &mut menus, "Shared model · First connector");
    assert!(mutations.try_recv().is_err());
    observe.resolve(json!({"value":snapshot}));
    assert!(app.settle());
    assert!(
        mutations.try_recv().is_err(),
        "reselecting after observe must also be a no-op"
    );

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
    app.type_text("label:Message composer", "First draft")
        .unwrap();

    *session.lock().unwrap() = row(3, model("first"));
    hold_observe.store(true, Ordering::SeqCst);
    generation.store(3, Ordering::SeqCst);
    app.send_host_event("ios.hostState", host_state(3, 3))
        .unwrap();
    let (observe, snapshot) = observations.try_recv().unwrap();
    hold_selection.store(true, Ordering::SeqCst);
    choose(&mut app, &mut menus, "Shared model · Second connector");
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
    assert_eq!(selection["generation"], 3);
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

    choose(&mut app, &mut menus, "Shared model · First connector");
    let (first, _) = mutations.try_recv().unwrap();
    assert_eq!(first["input"]["backend"]["connectionId"], "first");
    choose(&mut app, &mut menus, "Shared model · Second connector");
    let (second, _) = mutations.try_recv().unwrap();
    assert_eq!(second["method"], "selectBackend");
    let select: SelectBackend = serde_json::from_value(second["input"].clone()).unwrap();
    let backend = serde_json::to_value(select.backend).unwrap();
    assert_eq!(backend["connectionId"], "second");
    assert!(backend["serviceTier"].is_null());
    app.wait_for("text:Shared model · Second connector")
        .unwrap();

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
    let executor = json!({"kind":"executor","selection":{"executor":"codex",
        "settings":{"runtime":"cli","model":"gpt-5","thinkingLevel":"high"}}});
    *session.lock().unwrap() = row(8, executor.clone());
    generation.store(4, Ordering::SeqCst);
    app.send_host_event("ios.hostState", host_state(4, 4))
        .unwrap();
    app.wait_for("text:Native agent").unwrap();
    choose(&mut app, &mut menus, "Native agent");
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
    app.wait_for("text:First model").unwrap();
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
