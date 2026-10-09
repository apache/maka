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

//! The Host directory: pairing over the network against the scripted
//! WebSocket Host (`host_client::test_support`), and the directory's
//! actions against a scratch profile store with scripted pairing.
#![allow(clippy::disallowed_methods)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use futures_lite::future::{Boxed, block_on};
use gpui_kit::{AppContext as _, Entity, TestAppContext};
use host_client::test_support::{
    SCRIPTED_ROOT_ID, ScriptedWebSocketHost, StatusCode, free_listener, status_result,
};
use host_client::{LOCAL_PROFILE_ID, RemoteConnectOptions, RemoteHostProfile, RemoteProfileStore};
use host_protocol::{AccessCredential, RemoteTransport};
use serde_json::json;

use crate::{
    AddMethod, HostAction, HostDirectory, HostOutcome, HostPairing, HostRefusal, LivePairing,
    WindowHost,
};

fn credential() -> AccessCredential {
    AccessCredential::new("mrha_scripted").expect("credential")
}

fn plaintext_profile(id: &str, port: u16) -> RemoteHostProfile {
    let transport =
        RemoteTransport::plaintext(&format!("ws://127.0.0.1:{port}/runtime-host")).expect("url");
    RemoteHostProfile::new(id, "Build box", SCRIPTED_ROOT_ID, transport).expect("profile")
}

fn live() -> LivePairing {
    LivePairing::new(None, RemoteConnectOptions::default().with_timeout(Duration::from_secs(5)))
}

#[test]
fn live_pairing_probes_and_pairs_with_a_scripted_host() {
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        let mut probe = ScriptedWebSocketHost::accept(&listener, None).expect("upgrade");
        probe.accept_hello();
        probe.answer(status_result());
        probe.drain();
        let mut pairing = ScriptedWebSocketHost::accept(&listener, None).expect("upgrade");
        pairing.play_pairing(Ok(json!({"reconnectRequired": false})));
        pairing.drain();
        pairing.headers()["authorization"].to_str().expect("header").to_owned()
    });
    let pairing = live();
    let profile = plaintext_profile("box", port);
    block_on(pairing.probe(profile.clone(), credential())).expect("probe");
    block_on(pairing.pair(profile, credential())).expect("paired");
    assert_eq!(host.join().expect("host"), "Bearer mrha_scripted");
}

#[test]
fn live_pairing_names_each_refusal() {
    // The credential is refused at the upgrade.
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        ScriptedWebSocketHost::accept(&listener, Some(StatusCode::UNAUTHORIZED)).is_none()
    });
    let refusal = block_on(live().probe(plaintext_profile("box", port), credential()));
    assert_eq!(refusal, Err(HostRefusal::CredentialRefused));
    assert!(host.join().expect("host"));

    // Another State Root answers.
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        let mut host = ScriptedWebSocketHost::accept(&listener, None).expect("upgrade");
        host.accept_hello_for(&"b".repeat(64));
        host.drain();
    });
    let refusal = block_on(live().probe(plaintext_profile("box", port), credential()));
    assert_eq!(refusal, Err(HostRefusal::WrongHost));
    host.join().expect("host");

    // The code was used or expired: the Host will not finalize.
    let (listener, port) = free_listener();
    let host = thread::spawn(move || {
        let mut host = ScriptedWebSocketHost::accept(&listener, None).expect("upgrade");
        host.play_pairing(Err("invalid_request"));
        host.drain();
    });
    let refusal = block_on(live().pair(plaintext_profile("box", port), credential()));
    assert_eq!(refusal, Err(HostRefusal::CredentialRefused));
    host.join().expect("host");

    // Nothing listens there.
    let (listener, port) = free_listener();
    drop(listener);
    let refusal = block_on(live().probe(plaintext_profile("box", port), credential()));
    assert!(matches!(refusal, Err(HostRefusal::Unreachable(_))), "{refusal:?}");
}

/// Answers probes and pairings from queues; an empty queue succeeds.
#[derive(Default)]
struct ScriptedPairing {
    probes: Mutex<VecDeque<Result<(), HostRefusal>>>,
    pairings: Mutex<VecDeque<Result<(), HostRefusal>>>,
    paired: Mutex<Vec<String>>,
}

impl ScriptedPairing {
    fn probe_answers(&self, answer: Result<(), HostRefusal>) {
        self.probes.lock().expect("probes").push_back(answer);
    }

    fn pairing_answers(&self, answer: Result<(), HostRefusal>) {
        self.pairings.lock().expect("pairings").push_back(answer);
    }
}

impl HostPairing for ScriptedPairing {
    fn probe(&self, _: RemoteHostProfile, _: AccessCredential) -> Boxed<Result<(), HostRefusal>> {
        let answer = self.probes.lock().expect("probes").pop_front().unwrap_or(Ok(()));
        Box::pin(async move { answer })
    }

    fn pair(
        &self,
        profile: RemoteHostProfile,
        _: AccessCredential,
    ) -> Boxed<Result<(), HostRefusal>> {
        self.paired.lock().expect("paired").push(profile.id().to_owned());
        let answer = self.pairings.lock().expect("pairings").pop_front().unwrap_or(Ok(()));
        Box::pin(async move { answer })
    }
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn directory(
    name: &str,
    cx: &mut TestAppContext,
) -> (Entity<HostDirectory>, Arc<ScriptedPairing>, Scratch) {
    cx.executor().allow_parking();
    let dir = std::env::temp_dir()
        .join(format!("workspace-hosts-{name}-{}", crate::config_file::unique_suffix()));
    let pairing = Arc::new(ScriptedPairing::default());
    let store = RemoteProfileStore::new(dir.join("config"));
    let directory = cx.new(|cx| HostDirectory::new(store, pairing.clone(), cx));
    settle(&directory, cx);
    (directory, pairing, Scratch(dir))
}

/// Runs the directory's background work (the store's files are written on
/// the blocking pool) until it is idle and its list is read.
fn settle(directory: &Entity<HostDirectory>, cx: &mut TestAppContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        let idle = directory.read_with(cx, |directory, _| {
            !directory.is_busy() && (directory.list().is_some() || directory.load_error().is_some())
        });
        if idle || Instant::now() > deadline {
            break;
        }
        cx.foreground_executor()
            .block_test(async { async_io::Timer::after(Duration::from_millis(10)).await });
    }
    // The reload after an action answers too.
    for _ in 0..20 {
        cx.run_until_parked();
        cx.foreground_executor()
            .block_test(async { async_io::Timer::after(Duration::from_millis(5)).await });
    }
    cx.run_until_parked();
}

fn tls_profile(id: &str) -> RemoteHostProfile {
    let transport = RemoteTransport::tls("wss://build.example.com/runtime-host").expect("tls");
    RemoteHostProfile::new(id, "Build box", SCRIPTED_ROOT_ID, transport).expect("profile")
}

fn remote_ids(directory: &Entity<HostDirectory>, cx: &mut TestAppContext) -> Vec<String> {
    directory.read_with(cx, |directory, _| {
        directory
            .list()
            .map(|list| list.remotes.iter().map(|entry| entry.profile.id().to_owned()).collect())
            .unwrap_or_default()
    })
}

#[gpui_kit::test]
fn adding_a_host_probes_saves_pairs_and_enables_it(cx: &mut TestAppContext) {
    let (directory, pairing, _scratch) = directory("add", cx);
    directory.read_with(cx, |directory, _| {
        let list = directory.list().expect("list");
        assert_eq!(list.default_profile_id(), LOCAL_PROFILE_ID);
        assert_eq!(list.choices().len(), 1, "only the local Host");
    });
    directory.update(cx, |directory, cx| {
        directory.add_manual(tls_profile("build"), credential(), cx);
        assert_eq!(directory.action(), Some(&HostAction::Add(AddMethod::Manual)));
        // One action at a time.
        directory.set_default("build", cx);
        assert_eq!(directory.action(), Some(&HostAction::Add(AddMethod::Manual)));
    });
    settle(&directory, cx);
    directory.read_with(cx, |directory, _| {
        assert_eq!(
            directory.outcome(),
            Some(&HostOutcome::Added { profile_id: "build".into(), name: "Build box".into() })
        );
        let list = directory.list().expect("list");
        assert!(list.is_enabled("build"));
        let entry = list.remote("build").expect("saved");
        assert!(entry.has_credential && !entry.pairing_pending);
        let choices: Vec<_> = list.choices().into_iter().map(|c| c.profile_id).collect();
        assert_eq!(choices, ["local", "build"]);
    });
    assert_eq!(*pairing.paired.lock().expect("paired"), ["build"]);

    // It can be the default now, and then cannot be disabled or removed.
    directory.update(cx, |directory, cx| directory.set_default("build", cx));
    settle(&directory, cx);
    directory.update(cx, |directory, cx| directory.set_enabled("build", false, cx));
    settle(&directory, cx);
    directory.read_with(cx, |directory, _| {
        assert_eq!(directory.list().expect("list").default_profile_id(), "build");
        assert!(matches!(
            directory.outcome(),
            Some(HostOutcome::Refused { refusal: HostRefusal::Store(_), .. })
        ));
    });
    let resolved = directory.read_with(cx, |directory, cx| directory.resolve("build", cx));
    let host = cx.foreground_executor().block_test(resolved).expect("resolved");
    assert!(matches!(&host, WindowHost::Remote(remote) if remote.profile().id() == "build"));
    let local = directory.read_with(cx, |directory, cx| directory.resolve(LOCAL_PROFILE_ID, cx));
    assert!(matches!(cx.foreground_executor().block_test(local), Ok(WindowHost::Local)));

    // Back to Local, disabled, removed.
    directory.update(cx, |directory, cx| directory.set_default(LOCAL_PROFILE_ID, cx));
    settle(&directory, cx);
    directory.update(cx, |directory, cx| directory.set_enabled("build", false, cx));
    settle(&directory, cx);
    directory.update(cx, |directory, cx| directory.remove("build", cx));
    settle(&directory, cx);
    assert!(remote_ids(&directory, cx).is_empty());
}

#[gpui_kit::test]
fn a_host_that_cannot_be_reached_saves_nothing(cx: &mut TestAppContext) {
    let (directory, pairing, _scratch) = directory("probe", cx);
    pairing.probe_answers(Err(HostRefusal::Unreachable("127.0.0.1:9".into())));
    directory.update(cx, |directory, cx| directory.add_manual(tls_profile("x"), credential(), cx));
    settle(&directory, cx);
    directory.read_with(cx, |directory, _| {
        assert_eq!(
            directory.outcome(),
            Some(&HostOutcome::Refused {
                action: HostAction::Add(AddMethod::Manual),
                refusal: HostRefusal::Unreachable("127.0.0.1:9".into()),
            })
        );
    });
    assert!(remote_ids(&directory, cx).is_empty());
    assert!(pairing.paired.lock().expect("paired").is_empty(), "no pairing without a probe");
}

#[gpui_kit::test]
fn a_refused_pairing_is_rolled_back_and_an_unknown_one_kept_to_retry(cx: &mut TestAppContext) {
    let (directory, pairing, _scratch) = directory("pairing", cx);
    pairing.pairing_answers(Err(HostRefusal::CredentialRefused));
    directory.update(cx, |directory, cx| directory.add_manual(tls_profile("x"), credential(), cx));
    settle(&directory, cx);
    assert!(remote_ids(&directory, cx).is_empty(), "the refused pairing is removed");

    pairing.pairing_answers(Err(HostRefusal::OutcomeUnknown));
    directory.update(cx, |directory, cx| directory.add_manual(tls_profile("y"), credential(), cx));
    settle(&directory, cx);
    directory.read_with(cx, |directory, _| {
        let list = directory.list().expect("list");
        let entry = list.remote("y").expect("kept");
        assert!(entry.pairing_pending);
        assert!(!list.is_enabled("y"));
        assert_eq!(list.choices().len(), 1, "an unfinished pairing is not offered");
        assert!(matches!(
            directory.outcome(),
            Some(HostOutcome::Refused { refusal: HostRefusal::OutcomeUnknown, .. })
        ));
    });

    directory.update(cx, |directory, cx| directory.retry_pairing("y", cx));
    settle(&directory, cx);
    directory.read_with(cx, |directory, _| {
        let list = directory.list().expect("list");
        assert!(!list.remote("y").expect("kept").pairing_pending);
        assert!(list.is_enabled("y"));
    });

    // An unfinished pairing can be discarded instead.
    pairing.pairing_answers(Err(HostRefusal::NotReady));
    directory.update(cx, |directory, cx| directory.add_manual(tls_profile("z"), credential(), cx));
    settle(&directory, cx);
    directory.update(cx, |directory, cx| directory.remove("z", cx));
    settle(&directory, cx);
    assert_eq!(remote_ids(&directory, cx), ["y"]);
}

/// `encodeRuntimeHostOwnerConnectionCode` at the pin for a Direct peer
/// transport (the code in host-protocol's decoder tests).
const DIRECT_PEER_CODE: &str = "maka-runtime-host:connect:v2:eyJzY2hlbWFWZXJzaW9uIjoyLCJuYW1lIjoiU3R1ZGlvIE1hYyIsInJvb3RJZCI6IjY3ZDQ0MGYyYzA3ZDRjZjRlOWY1NmE1MmFhMmJmOGU0MzVjNzE2MDJkZGRhNjI0NDk4N2UyMDFkZTBjNGZiOGQiLCJ0cmFuc3BvcnQiOnsia2luZCI6ImxpYnAycC1kaXJlY3QiLCJyZWFjaGFiaWxpdHkiOnsibGVhc2UiOnsidmVyc2lvbiI6MSwicGVlcklkIjoiMTJEM0tvb1dHekJiREpoYlkyWTRuQjFoQ0tkazlvUzhaMnhDbVQ0cGozdXF2RzFYM29ZdSIsInJldmlzaW9uIjoyLCJpc3N1ZWRBdCI6MTc5MDAwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzkwMDAwNjAwMDAwLCJkaXJlY3RSb3V0ZXMiOlsiL2lwNC8xOTIuMTY4LjEuMjAvdWRwLzQwMDEvcXVpYy12MSJdLCJjb29yZGluYXRpb25Sb3V0ZXMiOltdfSwicHVibGljS2V5IjoiQ0FFU0lDMCIsInNpZ25hdHVyZSI6ImMybG5ibUYwZFhKbCJ9fSwiY3JlZGVudGlhbCI6Im1yaGFfQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9";

/// A connection code for a TLS Host, as the decoder accepts it.
fn tls_code() -> String {
    use base64::Engine as _;
    let payload = json!({
        "schemaVersion": 2,
        "name": "Studio",
        "rootId": SCRIPTED_ROOT_ID,
        "transport": {"kind": "tls", "url": "wss://studio.example.com/runtime-host"},
        "credential": "mrha_pending"
    });
    format!(
        "{}{}",
        host_protocol::OWNER_CONNECTION_CODE_PREFIX,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
    )
}

#[gpui_kit::test]
fn a_connection_code_is_decoded_and_a_direct_peer_one_refused(cx: &mut TestAppContext) {
    let (directory, pairing, _scratch) = directory("code", cx);
    let refused = |code: &str, cx: &mut TestAppContext| {
        directory.update(cx, |directory, cx| directory.import_code(code, cx));
        settle(&directory, cx);
        directory.read_with(cx, |directory, _| match directory.outcome() {
            Some(HostOutcome::Refused {
                action: HostAction::Add(AddMethod::ConnectionCode),
                refusal,
            }) => refusal.clone(),
            other => panic!("refused, got {other:?}"),
        })
    };
    assert_eq!(refused("not a code", cx), HostRefusal::InvalidCode);
    assert_eq!(refused(DIRECT_PEER_CODE, cx), HostRefusal::DirectPeer);
    assert!(pairing.paired.lock().expect("paired").is_empty());

    directory.update(cx, |directory, cx| directory.import_code(&format!("  {}\n", tls_code()), cx));
    settle(&directory, cx);
    directory.read_with(cx, |directory, _| {
        let Some(HostOutcome::Added { name, profile_id }) = directory.outcome() else {
            panic!("added, got {:?}", directory.outcome());
        };
        assert_eq!(name, "Studio");
        assert!(profile_id.starts_with("remote-"));
        assert!(directory.list().expect("list").is_enabled(profile_id));
    });
}
