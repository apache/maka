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

//! Supervisor behavior against scripted fake Hosts on socket pairs.
//!
//! Each connection attempt pops the next script from a fake connector. The
//! fake Hosts run on their own threads with blocking I/O; the supervisor runs
//! on another thread under `block_on`, as it would on a background executor.
#![allow(clippy::disallowed_methods)]

use std::collections::VecDeque;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use async_net::unix::UnixStream;
use futures_lite::future::block_on;
use host_protocol::{
    ChangeNotice, PushFrame, RUNTIME_HOST_COMPATIBILITY_EPOCH, ReplacementDisposition,
};
use serde_json::{Value, json};

use crate::connection::until;
use crate::tests::{FakeHost, accepted_with_epoch, hello, status_result_with_epoch};
use crate::{
    AttemptError, AttemptReporter, ConnectError, ConnectOptions, Connected, Connection,
    ConnectionEvent, DiscoveryError, HostBlocker, HostConnector, HostEvent, ReconnectPolicy,
    Supervised, SupervisorHandle, supervise,
};

type HostScript = Box<dyn FnOnce(FakeHost) + Send>;

enum Script {
    Fail(fn() -> AttemptError),
    Host(HostScript),
}

#[derive(Default)]
struct ConnectorState {
    scripts: Mutex<VecDeque<Script>>,
    attempts: AtomicUsize,
    hosts: Mutex<Vec<JoinHandle<()>>>,
}

/// Pops one script per attempt; with none left, reports that no Host is
/// registered.
#[derive(Clone, Default)]
struct FakeConnector(Arc<ConnectorState>);

impl FakeConnector {
    fn with(scripts: impl IntoIterator<Item = Script>) -> Self {
        let connector = Self::default();
        connector.0.scripts.lock().expect("scripts").extend(scripts);
        connector
    }

    fn push(&self, script: Script) {
        self.0.scripts.lock().expect("scripts").push_back(script);
    }

    fn attempts(&self) -> usize {
        self.0.attempts.load(Ordering::SeqCst)
    }

    fn join_hosts(&self) {
        let hosts = std::mem::take(&mut *self.0.hosts.lock().expect("hosts"));
        for host in hosts {
            host.join().expect("fake host thread");
        }
    }
}

impl HostConnector for FakeConnector {
    fn connect(
        &self,
        timeout: Duration,
        _: &AttemptReporter,
    ) -> impl Future<Output = Result<Connected, AttemptError>> + Send {
        let state = self.0.clone();
        async move {
            state.attempts.fetch_add(1, Ordering::SeqCst);
            let script = state.scripts.lock().expect("scripts").pop_front();
            match script {
                None => Err(not_registered()),
                Some(Script::Fail(make)) => Err(make()),
                Some(Script::Host(run)) => {
                    let (client, host) = StdUnixStream::pair().expect("socket pair");
                    let handle = thread::spawn(move || run(FakeHost::new(host)));
                    state.hosts.lock().expect("hosts").push(handle);
                    let stream = UnixStream::try_from(client).expect("async stream");
                    let options = ConnectOptions::default().with_timeout(timeout);
                    Ok(Connection::handshake(stream.clone(), stream, hello(), options).await?)
                }
            }
        }
    }
}

fn not_registered() -> AttemptError {
    AttemptError::Discovery(DiscoveryError::NotRegistered(PathBuf::from("/fake/control")))
}

fn incompatible() -> AttemptError {
    AttemptError::Connect(ConnectError::CompatibilityEpochMismatch { expected: 197, actual: 198 })
}

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

fn fast_policy() -> ReconnectPolicy {
    ReconnectPolicy::default()
        .with_backoff(ms(20), ms(100), ms(200))
        .with_liveness(ms(30), ms(150))
        .with_timeouts(ms(2_000), ms(2_000))
}

/// Answers every request until the client closes the connection.
fn serve(host_epoch: &'static str) -> Script {
    serve_with(host_epoch, accepted_with_epoch(host_epoch))
}

/// Answers every request as the Host that sent `accepted`.
fn serve_with(host_epoch: &'static str, accepted: Value) -> Script {
    let mut status = status_result_with_epoch(host_epoch);
    status["compositionRevision"] = accepted["compositionRevision"].clone();
    Script::Host(Box::new(move |mut host| {
        host.read();
        host.write(accepted);
        while let Some(request) = host.read_within(Duration::from_secs(10)) {
            let result =
                if request["operation"] == "host.status" { status.clone() } else { json!({}) };
            host.reply(&request, result);
        }
    }))
}

/// Accepts, reports ready, writes `pushes`, then closes the socket.
fn ready_then_close(host_epoch: &'static str, pushes: Vec<Value>) -> Script {
    Script::Host(Box::new(move |mut host| {
        host.read();
        host.write(accepted_with_epoch(host_epoch));
        host.answer(status_result_with_epoch(host_epoch));
        for push in pushes {
            host.write(push);
        }
    }))
}

/// Accepts, reports ready, then reads the first liveness probe and never
/// answers it; returns once the client closes the connection.
fn ready_then_hang(host_epoch: &'static str) -> Script {
    Script::Host(Box::new(move |mut host| {
        host.read();
        host.write(accepted_with_epoch(host_epoch));
        host.answer(status_result_with_epoch(host_epoch));
        let probe = host.read();
        assert_eq!(probe["operation"], "host.status");
        while host.read_within(Duration::from_secs(10)).is_some() {}
    }))
}

/// A running supervisor with its event channel.
struct Running {
    handle: SupervisorHandle,
    events: async_channel::Receiver<HostEvent>,
    run: JoinHandle<()>,
}

fn start(connector: &FakeConnector, policy: ReconnectPolicy) -> Running {
    let Supervised { handle, run, events, .. } = supervise(connector.clone(), policy);
    Running { handle, events, run: thread::spawn(move || block_on(run)) }
}

impl Running {
    fn next(&self) -> HostEvent {
        self.next_within(Duration::from_secs(5)).expect("an event within 5 s")
    }

    fn next_within(&self, timeout: Duration) -> Option<HostEvent> {
        block_on(until(Instant::now() + timeout, self.events.recv()))
            .map(|event| event.expect("the event channel is open"))
    }

    fn next_connection(&self) -> ConnectionEvent {
        match self.next() {
            HostEvent::Connection(event) => event,
            other => panic!("expected a connection event, got {other:?}"),
        }
    }

    /// Shuts down and checks that the run future finishes.
    fn stop(self) {
        self.handle.shutdown();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.run.is_finished() {
            assert!(Instant::now() < deadline, "the supervisor did not stop");
            // Keep draining so a blocked emit cannot hold the loop.
            let _ = self.events.try_recv();
            thread::sleep(ms(5));
        }
        self.run.join().expect("supervisor thread");
    }
}

fn assert_connected(event: ConnectionEvent, host_epoch: &str) {
    match event {
        ConnectionEvent::Connected { accepted } => assert_eq!(accepted.host_epoch, host_epoch),
        other => panic!("expected Connected({host_epoch}), got {other:?}"),
    }
}

#[test]
fn reconnects_after_the_host_closes_and_reports_the_new_epoch() {
    let connector = FakeConnector::with([ready_then_close("epoch-1", vec![]), serve("epoch-2")]);
    let running = start(&connector, fast_policy());

    assert_connected(running.next_connection(), "epoch-1");
    assert!(matches!(running.next_connection(), ConnectionEvent::Disconnected { .. }));
    assert_eq!(
        running.next_connection(),
        ConnectionEvent::Reconnecting { attempt: 1, delay: Duration::ZERO },
        "the first attempt after a loss is immediate"
    );
    assert_eq!(
        running.next_connection(),
        ConnectionEvent::HostEpochChanged { previous: "epoch-1".into(), current: "epoch-2".into() }
    );
    assert_connected(running.next_connection(), "epoch-2");
    assert_eq!(
        running.handle.connection().expect("connected").host_epoch(),
        "epoch-2",
        "requests go to the new Host"
    );

    running.handle.shutdown();
    assert!(matches!(running.next_connection(), ConnectionEvent::Disconnected { .. }));
    running.stop();
    connector.join_hosts();
    assert_eq!(connector.attempts(), 2);
}

#[test]
fn an_unanswered_liveness_probe_ends_the_connection() {
    let connector = FakeConnector::with([ready_then_hang("epoch-1")]);
    let policy = fast_policy();
    let running = start(&connector, policy.clone());

    assert_connected(running.next_connection(), "epoch-1");
    let connected_at = Instant::now();
    let reason = match running.next_connection() {
        ConnectionEvent::Disconnected { reason } => reason,
        other => panic!("expected Disconnected, got {other:?}"),
    };
    let elapsed = connected_at.elapsed();
    assert!(reason.contains("did not answer host.status"), "{reason}");
    assert!(elapsed >= policy.liveness_timeout, "declared lost after {elapsed:?}");
    assert!(elapsed < Duration::from_secs(2), "declared lost after {elapsed:?}");
    assert!(running.handle.connection().is_none(), "no requests go to a dead connection");

    // The Host is gone from the registry now: attempts fail and back off.
    assert_eq!(
        running.next_connection(),
        ConnectionEvent::Reconnecting { attempt: 1, delay: Duration::ZERO }
    );
    assert!(matches!(
        running.next_connection(),
        ConnectionEvent::AttemptFailed { attempt: 1, reason }
            if reason.contains("no Runtime Host is registered")
    ));
    assert!(matches!(
        running.next_connection(),
        ConnectionEvent::Reconnecting { attempt: 2, delay } if delay > Duration::ZERO
    ));
    running.stop();
    connector.join_hosts();
}

#[test]
fn a_healthy_host_keeps_the_connection_through_many_probes() {
    let probes = Arc::new(AtomicUsize::new(0));
    let counted = probes.clone();
    let connector = FakeConnector::with([Script::Host(Box::new(move |mut host| {
        host.read();
        host.write(accepted_with_epoch("epoch-1"));
        while let Some(request) = host.read_within(Duration::from_secs(10)) {
            assert_eq!(request["operation"], "host.status");
            counted.fetch_add(1, Ordering::SeqCst);
            host.reply(&request, status_result_with_epoch("epoch-1"));
        }
    }))]);
    let running = start(&connector, fast_policy());

    assert_connected(running.next_connection(), "epoch-1");
    assert_eq!(running.next_within(ms(400)), None, "no event while the Host answers");
    // One readiness poll, then a probe every ~30 ms.
    let answered = probes.load(Ordering::SeqCst);
    assert!(answered >= 5, "{answered} probes");
    running.stop();
    connector.join_hosts();
}

#[test]
fn pushes_arrive_in_order_between_their_connection_events() {
    let pushes = (1..=3)
        .map(|revision| {
            json!({"kind": "session.catalog.changed", "revision": revision, "sessionId": "s1"})
        })
        .collect();
    let connector = FakeConnector::with([ready_then_close("epoch-1", pushes)]);
    let running = start(&connector, fast_policy());

    assert_connected(running.next_connection(), "epoch-1");
    for revision in 1..=3 {
        assert_eq!(
            running.next(),
            HostEvent::Push(PushFrame::Change(ChangeNotice::SessionCatalogChanged {
                revision,
                session_id: "s1".into(),
                attention: None,
            }))
        );
    }
    assert!(matches!(running.next_connection(), ConnectionEvent::Disconnected { .. }));
    running.stop();
    connector.join_hosts();
}

#[test]
fn backoff_grows_and_reconnect_now_skips_the_wait() {
    let connector = FakeConnector::default();
    let policy = fast_policy().with_backoff(ms(5_000), ms(10_000), ms(20_000));
    let running = start(&connector, policy);

    assert!(matches!(running.next_connection(), ConnectionEvent::AttemptFailed { attempt: 1, .. }));
    assert_eq!(
        running.next_connection(),
        ConnectionEvent::Reconnecting { attempt: 2, delay: Duration::ZERO }
    );
    assert!(matches!(running.next_connection(), ConnectionEvent::AttemptFailed { attempt: 2, .. }));
    let delay = match running.next_connection() {
        ConnectionEvent::Reconnecting { attempt: 3, delay } => delay,
        other => panic!("expected the third attempt, got {other:?}"),
    };
    assert!(delay >= ms(4_000) && delay <= ms(6_000), "{delay:?}");

    let woken_at = Instant::now();
    running.handle.reconnect_now();
    assert!(matches!(running.next_connection(), ConnectionEvent::AttemptFailed { attempt: 3, .. }));
    assert!(woken_at.elapsed() < ms(1_000), "reconnect_now skipped the {delay:?} wait");
    running.stop();
}

#[test]
fn an_incompatible_host_suspends_retries_until_the_user_reconnects() {
    let connector = FakeConnector::with([Script::Fail(incompatible)]);
    let running = start(&connector, fast_policy());

    assert!(matches!(
        running.next_connection(),
        ConnectionEvent::AttemptFailed { attempt: 1, reason } if reason.contains("compatibility epoch")
    ));
    assert!(matches!(running.next_connection(), ConnectionEvent::Suspended { .. }));
    assert_eq!(running.next_within(ms(300)), None, "no automatic retry");
    assert_eq!(connector.attempts(), 1);

    connector.push(serve("epoch-1"));
    running.handle.reconnect_now();
    assert_connected(running.next_connection(), "epoch-1");
    running.stop();
    connector.join_hosts();
}

/// Reads the hello and answers `incompatible` as a Host at `epoch` does
/// (`HostKernel#handshake`), then closes.
fn refuse_as_epoch(epoch: u32, replacement: &'static str) -> Script {
    Script::Host(Box::new(move |mut host| {
        host.read();
        host.write(json!({
            "kind": "incompatible", "hostEpoch": format!("host-{epoch}"), "protocolMin": 0,
            "protocolMax": 0, "compatibilityEpoch": epoch, "compositionId": "maka.interactive",
            "compositionRevision": "3", "state": "ready", "replacement": replacement
        }));
    }))
}

fn suspended_blocker(event: ConnectionEvent) -> Option<HostBlocker> {
    match event {
        ConnectionEvent::Suspended { blocker, .. } => blocker,
        other => panic!("expected Suspended, got {other:?}"),
    }
}

#[test]
fn a_host_of_another_epoch_suspends_with_both_epochs_in_either_direction() {
    let older = RUNTIME_HOST_COMPATIBILITY_EPOCH - 1;
    let newer = RUNTIME_HOST_COMPATIBILITY_EPOCH + 1;
    let connector = FakeConnector::with([refuse_as_epoch(older, "wait_for_idle_exit")]);
    let running = start(&connector, fast_policy());

    assert!(matches!(running.next_connection(), ConnectionEvent::AttemptFailed { .. }));
    let Some(HostBlocker::Epoch(mismatch)) = suspended_blocker(running.next_connection()) else {
        panic!("expected an epoch mismatch");
    };
    assert_eq!((mismatch.client, mismatch.host), (RUNTIME_HOST_COMPATIBILITY_EPOCH, older));
    assert!(!mismatch.host_is_newer());
    assert_eq!(mismatch.replacement, Some(ReplacementDisposition::WaitForIdleExit));
    assert_eq!(running.next_within(ms(300)), None, "no automatic retry");

    connector.push(refuse_as_epoch(newer, "blocked_by_residency"));
    running.handle.reconnect_now();
    assert!(matches!(running.next_connection(), ConnectionEvent::AttemptFailed { .. }));
    let Some(HostBlocker::Epoch(mismatch)) = suspended_blocker(running.next_connection()) else {
        panic!("expected an epoch mismatch");
    };
    assert_eq!(mismatch.host, newer);
    assert!(mismatch.host_is_newer());
    assert_eq!(mismatch.replacement, Some(ReplacementDisposition::BlockedByResidency));

    // Another cause of suspension carries no blocker.
    connector.push(Script::Fail(|| AttemptError::Connect(ConnectError::ProtocolOutOfRange(3))));
    running.handle.reconnect_now();
    assert!(matches!(running.next_connection(), ConnectionEvent::AttemptFailed { .. }));
    assert_eq!(suspended_blocker(running.next_connection()), None);

    connector.push(serve("epoch-1"));
    running.handle.reconnect_now();
    assert_connected(running.next_connection(), "epoch-1");
    running.stop();
    connector.join_hosts();
}

#[test]
fn a_changed_composition_is_not_accepted_silently() {
    let mut upgraded = accepted_with_epoch("epoch-2");
    upgraded["compositionRevision"] = json!("4");
    let connector = FakeConnector::with([
        ready_then_close("epoch-1", vec![]),
        serve_with("epoch-2", upgraded.clone()),
    ]);
    let running = start(&connector, fast_policy());

    assert_connected(running.next_connection(), "epoch-1");
    assert!(matches!(running.next_connection(), ConnectionEvent::Disconnected { .. }));
    assert!(matches!(running.next_connection(), ConnectionEvent::Reconnecting { attempt: 1, .. }));
    assert!(matches!(
        running.next_connection(),
        ConnectionEvent::AttemptFailed { reason, .. } if reason.contains("composition changed")
    ));
    assert!(matches!(running.next_connection(), ConnectionEvent::Suspended { .. }));

    // Reconnecting on request accepts the upgraded Host as a new one.
    connector.push(serve_with("epoch-2", upgraded));
    running.handle.reconnect_now();
    assert_eq!(
        running.next_connection(),
        ConnectionEvent::HostEpochChanged { previous: "epoch-1".into(), current: "epoch-2".into() }
    );
    assert_connected(running.next_connection(), "epoch-2");
    running.stop();
    connector.join_hosts();
}

/// Fails twice, connects once (the Host then closes), and returns the delay
/// before the first attempt after that loss.
fn delay_after_a_loss_following_failures(policy: ReconnectPolicy) -> Duration {
    let connector = FakeConnector::with([
        Script::Fail(not_registered),
        Script::Fail(not_registered),
        ready_then_close("epoch-1", vec![]),
    ]);
    let running = start(&connector, policy);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < deadline, "never connected");
        if let ConnectionEvent::Connected { .. } = running.next_connection() {
            break;
        }
    }
    assert!(matches!(running.next_connection(), ConnectionEvent::Disconnected { .. }));
    let delay = match running.next_connection() {
        ConnectionEvent::Reconnecting { attempt: 1, delay } => delay,
        other => panic!("expected the first reconnect, got {other:?}"),
    };
    running.stop();
    connector.join_hosts();
    delay
}

#[test]
fn only_a_stable_connection_resets_the_backoff_streak() {
    // The connection lives far shorter than the default 10 s, so its loss
    // continues the streak of two failures: the third failure's delay.
    let unstable = delay_after_a_loss_following_failures(fast_policy());
    assert!(unstable >= ms(32) && unstable <= ms(48), "{unstable:?}");
    // Counted as stable, the loss starts a new streak: immediate retry.
    let stable =
        delay_after_a_loss_following_failures(fast_policy().with_stable_connection(Duration::ZERO));
    assert_eq!(stable, Duration::ZERO);
}

#[test]
fn shutdown_during_a_backoff_wait_ends_the_run_promptly() {
    let connector = FakeConnector::default();
    let policy = fast_policy().with_backoff(ms(10_000), ms(10_000), ms(10_000));
    let running = start(&connector, policy);
    while !matches!(
        running.next_connection(),
        ConnectionEvent::Reconnecting { delay, .. } if delay > Duration::ZERO
    ) {}
    let stopped_at = Instant::now();
    running.stop();
    assert!(stopped_at.elapsed() < ms(1_000));
}

#[test]
fn shutdown_does_not_wait_for_a_host_that_never_becomes_ready() {
    let connector = FakeConnector::with([Script::Host(Box::new(|mut host| {
        host.read();
        host.write(accepted_with_epoch("epoch-1"));
        // Read the readiness probe and never answer it.
        host.read();
        while host.read_within(Duration::from_secs(10)).is_some() {}
    }))]);
    let policy = fast_policy().with_timeouts(ms(2_000), ms(60_000));
    let running = start(&connector, policy);
    // Let the attempt reach the readiness wait.
    while connector.attempts() == 0 {
        thread::sleep(ms(5));
    }
    thread::sleep(ms(100));
    let stopped_at = Instant::now();
    running.stop();
    assert!(stopped_at.elapsed() < ms(1_000), "stopped after {:?}", stopped_at.elapsed());
    connector.join_hosts();
}

#[test]
fn dropping_the_event_receiver_stops_the_supervisor() {
    let connector = FakeConnector::with([serve("epoch-1")]);
    let Supervised { handle, run, events, .. } = supervise(connector.clone(), fast_policy());
    let run = thread::spawn(move || block_on(run));
    assert!(matches!(
        block_on(events.recv()).expect("event"),
        HostEvent::Connection(ConnectionEvent::Connected { .. })
    ));
    drop(events);
    // With nobody listening the loop ends at its next event: the
    // Disconnected that follows closing the connection.
    handle.connection().expect("connected").shutdown();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !run.is_finished() {
        assert!(Instant::now() < deadline, "the supervisor kept running");
        thread::sleep(ms(5));
    }
    run.join().expect("supervisor thread");
    assert!(handle.connection().is_none());
    connector.join_hosts();
}
