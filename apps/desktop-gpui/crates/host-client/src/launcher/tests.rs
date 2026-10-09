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

//! The election against a fake candidate (`tests/fixtures/fake-candidate.sh`,
//! run with `/bin/sh`) and a fake Host listening on a Unix socket, so every
//! path is exercised without the real Runtime Host. Registrations go to a
//! scratch control namespace, never the real one.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use futures_lite::future::{self, block_on};
use host_protocol::{HostLifecycleState, RUNTIME_HOST_COMPATIBILITY_EPOCH};
use serde_json::{Value, json};

use super::*;
use crate::tests::{FakeHost, hello};
use crate::{
    ConnectError, Connected, ConnectionEvent, HostEvent, ReconnectPolicy, RootConnector,
    STORAGE_ROOT_MARKER_FILE, Supervised, read_root_id, supervise,
};

const FAKE_CANDIDATE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-candidate.sh");

/// A scratch State Root, control namespace, and fake Host for one test.
struct Scenario {
    dir: PathBuf,
    root: PathBuf,
    namespace: PathBuf,
    log: PathBuf,
    socket: PathBuf,
    connections: Arc<AtomicUsize>,
}

impl Scenario {
    /// `close_first` makes the fake Host drop its first connection, and
    /// delete the registration, once it has answered one `host.status`: a
    /// Host that went away.
    fn new(name: &str, close_first: bool) -> Self {
        let dir = std::env::temp_dir()
            .join(format!("host-client-launch-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("scratch dir");
        let dir = fs::canonicalize(dir).expect("canonical scratch dir");
        let root = dir.join("state-root");
        let namespace = dir.join("runtime-hosts");
        fs::create_dir_all(&namespace).expect("namespace");
        // Socket paths are short-lived and must stay under the 104-byte limit.
        let socket = std::env::temp_dir()
            .join(format!("hcl-{}.sock", &uuid::Uuid::new_v4().simple().to_string()[..12]));
        let connections = Arc::new(AtomicUsize::new(0));
        serve_fake_host(&socket, root.clone(), namespace.clone(), close_first, connections.clone());
        Self { log: dir.join("launches.log"), dir, root, namespace, socket, connections }
    }

    /// Options that launch the fake candidate in `modes` (see the script).
    fn options(&self, modes: &str) -> LaunchOptions {
        LaunchOptions::default()
            .control_namespace(&self.namespace)
            .node(NodeRuntime::with_path("/bin/sh"))
            .installation(MakaInstallation::with_entrypoint(FAKE_CANDIDATE))
            .election_deadline(Duration::from_secs(10))
            .env("FAKE_CANDIDATE_LOG", &self.log)
            .env("FAKE_CANDIDATE_MODES", modes)
            .env("FAKE_CANDIDATE_CONTROL_DIR", &self.namespace)
            .env("FAKE_CANDIDATE_ENDPOINT", &self.socket)
            .env("FAKE_CANDIDATE_EPOCH", RUNTIME_HOST_COMPATIBILITY_EPOCH.to_string())
            .env("FAKE_CANDIDATE_LIFETIME", "3")
    }

    /// One line per candidate launch.
    fn launches(&self) -> Vec<String> {
        fs::read_to_string(&self.log)
            .map(|text| text.lines().map(str::to_owned).collect())
            .unwrap_or_default()
    }

    fn root_id(&self) -> String {
        block_on(read_root_id(&self.root)).expect("root id")
    }

    fn control_directory(&self) -> PathBuf {
        self.namespace.join(self.root_id())
    }
}

impl Drop for Scenario {
    fn drop(&mut self) {
        fs::remove_file(&self.socket).ok();
        fs::remove_dir_all(&self.dir).ok();
    }
}

/// Accepts connections on `socket` and answers as the Host that the current
/// registration of `root` describes.
fn serve_fake_host(
    socket: &Path,
    root: PathBuf,
    namespace: PathBuf,
    close_first: bool,
    connections: Arc<AtomicUsize>,
) {
    let listener = UnixListener::bind(socket).expect("bind fake Host socket");
    // Blocks in accept until the process exits; one listener per test.
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let number = connections.fetch_add(1, Ordering::SeqCst) + 1;
            let registration = block_on(read_root_id(&root))
                .map(|root_id| namespace.join(root_id).join(crate::REGISTRATION_FILE))
                .expect("marker");
            let close = close_first && number == 1;
            thread::spawn(move || serve_connection(stream, &registration, close));
        }
    });
}

fn serve_connection(stream: UnixStream, registration_path: &Path, close_after_ready: bool) {
    let registration: Value =
        serde_json::from_slice(&fs::read(registration_path).expect("registration"))
            .expect("registration json");
    let epoch = registration["hostEpoch"].clone();
    let mut host = FakeHost::new(stream);
    if host.read_within(Duration::from_secs(5)).is_none() {
        return;
    }
    host.write(json!({
        "kind": "accepted",
        "rootId": registration["rootId"],
        "hostEpoch": epoch,
        "connectionId": "fake-connection",
        "selectedProtocol": 0,
        "compatibilityEpoch": RUNTIME_HOST_COMPATIBILITY_EPOCH,
        "compositionId": "maka.interactive",
        "compositionRevision": "3",
        "state": "ready"
    }));
    while let Some(request) = host.read_within(Duration::from_secs(10)) {
        host.reply(
            &request,
            json!({
                "hostEpoch": epoch,
                "compositionId": "maka.interactive",
                "compositionRevision": "3",
                "state": "ready",
                "connections": 1,
                "activeOperations": 0,
                "activeResidencies": 0
            }),
        );
        if close_after_ready {
            fs::remove_file(registration_path).ok();
            return;
        }
    }
}

/// Records the pid of every spawned candidate.
#[derive(Default)]
struct Spawns(Mutex<Vec<u32>>);

impl LaunchObserver for Spawns {
    async fn candidate_spawned(&self, candidate: &CandidateProcess) {
        self.0.lock().expect("spawns").push(candidate.pid());
    }
}

impl Spawns {
    fn pids(&self) -> Vec<u32> {
        self.0.lock().expect("spawns").clone()
    }
}

/// Asks the Host for `host.status` over `connected` and closes it.
fn status_over(connected: Connected) -> HostLifecycleState {
    let Connected { connection, pump, .. } = connected;
    let (_, status) = block_on(future::zip(pump, async {
        let status = connection.host_status().await;
        connection.shutdown();
        status
    }));
    status.expect("host.status").state
}

fn field<'a>(line: &'a str, key: &str) -> &'a str {
    let start = line.find(&format!("{key}=")).expect(key) + key.len() + 1;
    line[start..].split(' ').next().expect("value")
}

fn argument<'a>(line: &'a str, flag: &str) -> &'a str {
    let args = &line[line.find("args=").expect("args") + 5..];
    let mut words = args.split(' ');
    words.find(|word| *word == flag).expect(flag);
    words.next().expect("flag value")
}

#[test]
fn a_missing_host_is_spawned_on_a_new_state_root() {
    let scenario = Scenario::new("spawn", false);
    let spawns = Spawns::default();
    let options = scenario.options("register");
    let launched =
        block_on(connect_or_spawn(&scenario.root, hello(), &options, &spawns)).expect("launched");

    // The State Root was created with a marker, as `resolveStorageRoot` does.
    assert!(launched.root.created);
    assert!(scenario.root.join(STORAGE_ROOT_MARKER_FILE).is_file());
    assert_eq!(launched.root.root_id, scenario.root_id());

    let launches = scenario.launches();
    assert_eq!(launches.len(), 1, "{launches:?}");
    let line = &launches[0];
    let spawned = launched.spawned.as_ref().expect("this call spawned the Host");
    assert_eq!(spawns.pids(), [spawned.pid()]);
    assert_eq!(launched.registration.pid, spawned.pid());
    assert_eq!(field(line, "pid"), spawned.pid().to_string());
    assert_eq!(field(line, "pipe"), "1", "MAKA_RUNTIME_HOST_STDERR_PIPE");
    assert_eq!(field(line, "cwd"), "/bin", "the directory of the executable");
    assert_eq!(argument(line, "--root"), scenario.root.display().to_string());
    assert_eq!(argument(line, "--expected-root-id"), launched.root.root_id);
    assert_eq!(argument(line, "--startup-attempt-id"), spawned.startup_attempt_id());
    let initial: u64 =
        argument(line, "--initial-connection-timeout-ms").parse().expect("milliseconds");
    assert!((9_000..=10_000).contains(&initial), "the time left before the deadline: {initial}");
    assert!(!line.contains("--idle-grace-ms"));

    assert_eq!(status_over(launched.connected), HostLifecycleState::Ready);
    assert!(spawned.try_exit().is_none(), "the Host keeps running after the launcher is done");
}

#[test]
fn a_registered_host_is_used_without_spawning() {
    let scenario = Scenario::new("existing", false);
    // A Host already runs: another launcher spawned it.
    let first =
        block_on(connect_or_spawn(&scenario.root, hello(), &scenario.options("register"), &()))
            .expect("first launch");
    let spawns = Spawns::default();
    let second = block_on(connect_or_spawn(
        &scenario.root,
        hello(),
        &scenario.options("register").idle_grace(Duration::from_secs(1)),
        &spawns,
    ))
    .expect("second connection");
    assert!(!second.root.created);
    assert!(second.spawned.is_none());
    assert!(spawns.pids().is_empty());
    assert_eq!(scenario.launches().len(), 1, "no second candidate");
    assert_eq!(second.registration.pid, first.registration.pid);
    status_over(first.connected);
    status_over(second.connected);
}

#[test]
fn a_permanent_startup_failure_ends_the_election_with_the_diagnostic() {
    let scenario = Scenario::new("fail65", false);
    let started = Instant::now();
    let error =
        block_on(connect_or_spawn(&scenario.root, hello(), &scenario.options("fail65"), &()))
            .expect_err("stored data incompatible");
    assert!(started.elapsed() < Duration::from_secs(5), "no waiting for the deadline");
    assert!(error.is_permanent());
    let LaunchError::Startup { reason, diagnostic, startup_attempt_id, .. } = &error else {
        panic!("{error:?}");
    };
    assert_eq!(*reason, StartupFailureReason::StoredDataIncompatible);
    let diagnostic = diagnostic.as_ref().expect("the candidate's diagnostic");
    assert_eq!(&diagnostic.startup_attempt_id, startup_attempt_id);
    assert_eq!(scenario.launches().len(), 1);
    let text = error.to_string();
    assert!(text.starts_with("Maka cannot read part of this workspace’s stored data."), "{text}");
    assert!(
        text.ends_with(
            "Details: StoredSessionMessageError (stored_session_message_incompatible) session s1 \
             has an unreadable message"
        ),
        "{text}"
    );
    // The diagnostic that ended the election is kept under the selected
    // name, as `selectCandidateStartupDiagnostic` keeps it.
    let control = scenario.control_directory();
    assert!(!startup_diagnostic_path(&control, startup_attempt_id).exists());
    let kept: Value = serde_json::from_slice(
        &fs::read(control.join(SELECTED_STARTUP_DIAGNOSTIC_FILE)).expect("the selected diagnostic"),
    )
    .expect("json");
    assert_eq!(kept["startupAttemptId"], json!(startup_attempt_id));
}

/// The startup diagnostic files in `control`, by name.
fn diagnostic_files(control: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(control)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter(|name| name.starts_with("startup-diagnostic."))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// A connection deletes the diagnostics this election's failures left and
/// the one an earlier election kept, as `retireCandidateStartupDiagnostic`
/// does; a second transient failure, which the election does not report,
/// loses its file at once. Another launcher's attempt is left alone.
#[test]
fn a_connection_deletes_the_stale_startup_diagnostics() {
    let scenario = Scenario::new("retire", false);
    let spawns = Spawns::default();
    // Create the State Root first, so its control directory can be seeded.
    block_on(super::state_root::prepare_state_root(&scenario.root)).expect("root");
    let control = scenario.control_directory();
    fs::create_dir_all(&control).expect("control directory");
    fs::write(control.join(SELECTED_STARTUP_DIAGNOSTIC_FILE), "{}").expect("an earlier failure");
    let foreign = startup_diagnostic_path(&control, &new_startup_attempt_id());
    fs::write(&foreign, "{}").expect("another launcher's attempt");

    let launched = block_on(connect_or_spawn(
        &scenario.root,
        hello(),
        &scenario.options("fail70 fail70 register"),
        &spawns,
    ))
    .expect("the third candidate wins");
    assert_eq!(spawns.pids().len(), 3);
    let foreign_name = foreign.file_name().and_then(|name| name.to_str()).expect("name");
    assert_eq!(diagnostic_files(&control), [foreign_name.to_owned()]);
    status_over(launched.connected);
}

#[test]
fn a_candidate_that_lost_the_election_is_replaced() {
    let scenario = Scenario::new("lose", false);
    let spawns = Spawns::default();
    let launched = block_on(connect_or_spawn(
        &scenario.root,
        hello(),
        &scenario.options("lose register"),
        &spawns,
    ))
    .expect("second candidate wins");
    let pids = spawns.pids();
    assert_eq!(pids.len(), 2, "{pids:?}");
    assert_eq!(launched.spawned.as_ref().map(CandidateProcess::pid), Some(pids[1]));
    status_over(launched.connected);
}

#[test]
fn a_transient_startup_failure_is_retried_until_the_deadline() {
    let scenario = Scenario::new("crash70", false);
    let options = scenario.options("crash70").election_deadline(Duration::from_millis(1_200));
    let error = block_on(connect_or_spawn(&scenario.root, hello(), &options, &()))
        .expect_err("internal failure");
    assert!(!error.is_permanent(), "the supervisor retries it");
    assert!(
        matches!(
            error,
            LaunchError::Startup { reason: StartupFailureReason::InternalStartupFailure, .. }
        ),
        "{error:?}"
    );
    assert!(scenario.launches().len() >= 2, "a new candidate after each failure");
    let text = error.to_string();
    assert!(text.contains("INTERNAL_STARTUP_FAILURE"), "{text}");
    assert!(
        text.ends_with("Host output: [runtime-host] startup failed: fake internal failure"),
        "{text}"
    );
}

#[test]
fn a_candidate_that_never_registers_times_out() {
    let scenario = Scenario::new("hang", false);
    let options = scenario.options("hang").election_deadline(Duration::from_millis(700));
    let started = Instant::now();
    let error =
        block_on(connect_or_spawn(&scenario.root, hello(), &options, &())).expect_err("timeout");
    assert!(started.elapsed() < Duration::from_secs(3));
    let LaunchError::Timeout { diagnostic } = &error else { panic!("{error:?}") };
    assert_eq!(diagnostic.candidate_launches, 1, "no second candidate while the first runs");
    assert!(diagnostic.not_registered >= 2);
    assert!(!diagnostic.saw_endpoint_connected);
    assert!(!error.is_permanent());
    let text = error.to_string();
    assert!(text.contains("still running"), "{text}");
    assert!(text.contains(ELECTION_DEADLINE_ENV), "{text}");
}

#[test]
fn a_missing_entry_point_fails_before_spawning() {
    let scenario = Scenario::new("no-entry", false);
    let options = scenario
        .options("register")
        .installation(MakaInstallation::with_entrypoint(scenario.dir.join("missing.js")));
    let error =
        block_on(connect_or_spawn(&scenario.root, hello(), &options, &())).expect_err("no entry");
    assert!(error.is_permanent());
    assert!(error.to_string().contains("missing.js"), "{error}");
    assert!(scenario.launches().is_empty());
}

/// A Host far enough from this client's epoch can answer in a shape this
/// client does not decode (here an `incompatible` from before `replacement`
/// existed). Its registration still names its epoch, so the election ends
/// at once with both epochs instead of starting candidates until the
/// deadline.
#[test]
fn a_host_registered_at_another_epoch_that_fails_the_handshake_ends_the_election() {
    let scenario = Scenario::new("registered-epoch", false);
    let root = block_on(prepare_state_root(&scenario.root)).expect("state root");
    let control = scenario.namespace.join(&root.root_id);
    fs::create_dir_all(&control).expect("control directory");
    let socket = std::env::temp_dir()
        .join(format!("hcl-{}.sock", &uuid::Uuid::new_v4().simple().to_string()[..12]));
    let listener = UnixListener::bind(&socket).expect("bind the old Host's socket");
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let mut host = FakeHost::new(stream);
            host.read_within(Duration::from_secs(5));
            host.write(json!({
                "kind": "incompatible", "hostEpoch": "old-host", "protocolMin": 0,
                "protocolMax": 0, "compatibilityEpoch": 150, "state": "ready"
            }));
        }
    });
    let registration = json!({
        "kind": "maka-runtime-host", "schemaVersion": 1, "rootId": root.root_id,
        "hostEpoch": "old-host", "endpoint": socket, "protocolMin": 0, "protocolMax": 0,
        "compatibilityEpoch": 150, "compositionId": "maka.interactive",
        "compositionRevision": "1", "lifecycleMode": "service", "state": "ready",
        "pid": std::process::id(), "createdAt": "2026-09-25T00:00:00.000Z"
    });
    fs::write(control.join(crate::REGISTRATION_FILE), registration.to_string())
        .expect("registration");

    let started = Instant::now();
    let error = block_on(connect_or_spawn(&scenario.root, hello(), &scenario.options("hang"), &()))
        .expect_err("refused");
    assert!(started.elapsed() < Duration::from_secs(5), "ended at once: {:?}", started.elapsed());
    assert!(error.is_permanent());
    assert!(
        matches!(
            &error,
            LaunchError::Connect(ConnectError::RegisteredEpochMismatch {
                expected: RUNTIME_HOST_COMPATIBILITY_EPOCH,
                registered: 150,
                ..
            })
        ),
        "{error:?}"
    );
    assert!(scenario.launches().is_empty(), "no candidate");
    fs::remove_file(&socket).ok();
}

#[test]
fn the_supervisor_starts_a_host_again_when_the_registration_disappears() {
    let scenario = Scenario::new("supervised", true);
    let connector =
        RootConnector::new(&scenario.root, hello()).spawning(scenario.options("register"));
    let policy = ReconnectPolicy::default()
        .with_backoff(
            Duration::from_millis(20),
            Duration::from_millis(100),
            Duration::from_millis(200),
        )
        .with_liveness(Duration::from_millis(30), Duration::from_millis(500));
    let Supervised { handle, run, events } = supervise(connector, policy);
    let runner = thread::spawn(move || block_on(run));

    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut connected = 0;
    while connected < 2 && Instant::now() < deadline {
        let event = block_on(events.recv()).expect("event");
        if let HostEvent::Connection(event) = event {
            if matches!(event, ConnectionEvent::Connected { .. }) {
                connected += 1;
            }
            seen.push(event);
        }
    }
    handle.shutdown();
    runner.join().expect("supervisor thread");

    let starts: Vec<u32> = seen
        .iter()
        .filter_map(|event| match event {
            ConnectionEvent::HostStarting { pid, .. } => Some(*pid),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 2, "{seen:?}");
    assert_ne!(starts[0], starts[1]);
    // Each start precedes its connection; the Host that came back is a new one.
    let position =
        |wanted: fn(&ConnectionEvent) -> bool| seen.iter().position(wanted).expect("event present");
    assert!(
        position(|event| matches!(event, ConnectionEvent::HostStarting { attempt: 1, .. }))
            < position(|event| matches!(event, ConnectionEvent::Connected { .. }))
    );
    assert!(seen.iter().any(|event| matches!(event, ConnectionEvent::Disconnected { .. })));
    assert!(seen.iter().any(|event| matches!(event, ConnectionEvent::HostEpochChanged { .. })));
    assert_eq!(scenario.launches().len(), 2);
    assert!(scenario.connections.load(Ordering::SeqCst) >= 2);
}
