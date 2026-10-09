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

//! Connection behavior against a scripted fake Host on a socket pair.
//!
//! The fake Host runs on its own thread with blocking I/O, and sleeps there to
//! simulate a slow Host; the client side never blocks on it.
#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use async_net::unix::UnixStream;
use futures_lite::future::block_on;
use host_protocol::{
    ChangeNotice, ClientHello, ClientInstanceId, HostOperationErrorCode, HostStatus,
    HostStatusInput, PushFrame, SessionCatalogQuery, SessionCatalogQueryInput,
    SessionCatalogQueryResult,
};
use serde_json::{Value, json};

use crate::{
    ConnectError, ConnectOptions, Connected, Connection, ConnectionError, PUSH_CHANNEL_CAPACITY,
    PushEvent, RequestError,
};

const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

/// The Host end of a socket pair, driven with blocking I/O on a thread.
pub(crate) struct FakeHost {
    reader: BufReader<StdUnixStream>,
    writer: StdUnixStream,
}

impl FakeHost {
    /// A fake Host on `host`, the Host end of a socket pair.
    pub(crate) fn new(host: StdUnixStream) -> Self {
        let reader = BufReader::new(host.try_clone().expect("clone"));
        Self { reader, writer: host }
    }

    /// Reads the next frame, or `None` at end of stream or after `timeout`.
    pub(crate) fn read_within(&mut self, timeout: Duration) -> Option<Value> {
        self.reader.get_ref().set_read_timeout(Some(timeout)).expect("set timeout");
        let mut line = String::new();
        let read = self.reader.read_line(&mut line);
        // Fails with EINVAL once the peer has closed; nothing to clear then.
        let _ = self.reader.get_ref().set_read_timeout(None);
        match read {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(serde_json::from_str(line.trim_end()).expect("client frame is JSON")),
        }
    }

    pub(crate) fn read(&mut self) -> Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("read frame");
        serde_json::from_str(line.trim_end()).expect("client frame is JSON")
    }

    pub(crate) fn write(&mut self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).expect("encode");
        bytes.push(b'\n');
        self.writer.write_all(&bytes).expect("write frame");
    }

    pub(crate) fn accept(&mut self) -> Value {
        let hello = self.read();
        self.write(accepted());
        hello
    }

    pub(crate) fn reply(&mut self, request: &Value, result: Value) {
        self.write(json!({
            "requestId": request["requestId"],
            "operation": request["operation"],
            "ok": true,
            "result": result
        }));
    }

    /// Answers the next request with `result`, returning the request.
    pub(crate) fn answer(&mut self, result: Value) -> Value {
        let request = self.read();
        self.reply(&request, result);
        request
    }
}

pub(crate) fn accepted() -> Value {
    accepted_with_epoch("epoch-1")
}

/// An `accepted` frame from a Host with `host_epoch`, at this client's
/// compatibility epoch.
pub(crate) fn accepted_with_epoch(host_epoch: &str) -> Value {
    json!({
        "kind": "accepted",
        "rootId": ROOT_ID,
        "hostEpoch": host_epoch,
        "connectionId": "connection-1",
        "selectedProtocol": 0,
        "compatibilityEpoch": hello().compatibility_epoch,
        "compositionId": "maka.interactive",
        "compositionRevision": "3",
        "state": "ready"
    })
}

pub(crate) fn status_result() -> Value {
    status_result_with_epoch("epoch-1")
}

pub(crate) fn status_result_with_epoch(host_epoch: &str) -> Value {
    json!({
        "hostEpoch": host_epoch,
        "compositionId": "maka.interactive",
        "compositionRevision": "3",
        "state": "ready",
        "connections": 1,
        "activeOperations": 1,
        "activeResidencies": 0
    })
}

fn empty_page() -> Value {
    json!({
        "kind": "page",
        "revision": format!("sha256:{}", "0".repeat(64)),
        "sessions": [],
        "nextCursor": null
    })
}

pub(crate) fn hello() -> ClientHello {
    ClientHello::new(ClientInstanceId::new("test-client").expect("valid id"))
}

/// Starts a fake Host running `script` and returns the client stream.
pub(crate) fn fake_host<T: Send + 'static>(
    script: impl FnOnce(FakeHost) -> T + Send + 'static,
) -> (UnixStream, JoinHandle<T>) {
    let (client, host) = StdUnixStream::pair().expect("socket pair");
    let handle = thread::spawn(move || script(FakeHost::new(host)));
    (UnixStream::try_from(client).expect("async stream"), handle)
}

fn connect(stream: UnixStream, options: ConnectOptions) -> Result<Connected, ConnectError> {
    block_on(Connection::handshake(stream.clone(), stream, hello(), options))
}

/// Connects and runs the pump on its own thread.
fn connect_running(
    stream: UnixStream,
) -> (Connection, async_channel::Receiver<PushEvent>, JoinHandle<Result<(), ConnectionError>>) {
    let Connected { connection, pump, pushes, .. } =
        connect(stream, ConnectOptions::default()).expect("accepted");
    (connection, pushes, thread::spawn(move || block_on(pump)))
}

#[test]
fn handshake_then_typed_requests_route_out_of_order() {
    let (stream, host) = fake_host(|mut host| {
        let hello = host.accept();
        let first = host.read();
        let second = host.read();
        // Answer in reverse order.
        host.reply(&second, empty_page());
        host.reply(&first, status_result());
        // Returning `host` keeps the socket open until the client shuts down.
        (host, hello, first, second)
    });
    let Connected { connection, pump, .. } =
        connect(stream, ConnectOptions::default().with_expected_root_id(ROOT_ID))
            .expect("accepted");
    assert_eq!(connection.root_id(), ROOT_ID);
    assert_eq!(connection.host_epoch(), "epoch-1");
    assert_eq!(connection.connection_id(), "connection-1");
    assert_eq!(connection.selected_protocol(), 0);
    let pump = thread::spawn(move || block_on(pump));

    let (status, catalog) = block_on(futures_lite::future::zip(
        connection.request::<HostStatus>(&HostStatusInput::default()),
        connection.request::<SessionCatalogQuery>(&SessionCatalogQueryInput::ListStart),
    ));
    assert_eq!(status.expect("status").connections, 1);
    assert!(matches!(
        catalog.expect("catalog"),
        SessionCatalogQueryResult::Page { sessions, .. } if sessions.is_empty()
    ));

    let (_host, hello, first, second) = host.join().expect("host thread");
    assert_eq!(hello["kind"], "hello");
    assert_eq!(hello["clientInstanceId"], "test-client");
    assert_eq!(hello["activitySnapshotVersion"], 2);
    assert_eq!(first["operation"], "host.status");
    assert_eq!(first["input"], json!({}));
    assert_eq!(second["input"], json!({"kind": "list_start"}));
    assert_ne!(first["requestId"], second["requestId"]);

    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}

#[test]
fn incompatible_handshake_is_reported() {
    let (stream, _host) = fake_host(|mut host| {
        host.read();
        host.write(json!({
            "kind": "incompatible", "hostEpoch": "e", "protocolMin": 0, "protocolMax": 0,
            "compatibilityEpoch": 178, "compositionId": "maka.interactive",
            "compositionRevision": "4", "state": "ready", "replacement": "blocked_by_residency"
        }));
    });
    match connect(stream, ConnectOptions::default()) {
        Err(ConnectError::Incompatible(incompatible)) => {
            assert_eq!(incompatible.compatibility_epoch, 178);
        }
        other => panic!("expected incompatible, got {other:?}"),
    }
}

#[test]
fn draining_handshake_is_reported() {
    let (stream, _host) = fake_host(|mut host| {
        host.read();
        host.write(json!({"kind": "draining", "hostEpoch": "e"}));
    });
    assert!(matches!(connect(stream, ConnectOptions::default()), Err(ConnectError::Draining(_))));
}

#[test]
fn accepted_handshake_is_checked() {
    let (stream, _host) = fake_host(|mut host| host.accept());
    assert!(matches!(
        connect(stream, ConnectOptions::default().with_expected_root_id("f".repeat(64))),
        Err(ConnectError::RootMismatch { .. })
    ));

    let (stream, _host) = fake_host(|mut host| {
        host.read();
        let mut frame = accepted();
        frame["compatibilityEpoch"] = json!(1);
        host.write(frame);
    });
    assert!(matches!(
        connect(stream, ConnectOptions::default()),
        Err(ConnectError::CompatibilityEpochMismatch { actual: 1, .. })
    ));

    let (stream, _host) = fake_host(|mut host| {
        host.read();
        let mut frame = accepted();
        frame["selectedProtocol"] = json!(9);
        host.write(frame);
    });
    assert!(matches!(
        connect(stream, ConnectOptions::default()),
        Err(ConnectError::ProtocolOutOfRange(9))
    ));

    let (stream, _host) = fake_host(|mut host| {
        host.read();
        let mut frame = accepted();
        frame["compositionId"] = json!("maka.other");
        host.write(frame);
    });
    assert!(matches!(
        connect(stream, ConnectOptions::default()),
        Err(ConnectError::CompositionMismatch { .. })
    ));

    let (stream, _host) = fake_host(|mut host| host.accept());
    assert!(matches!(
        connect(stream, ConnectOptions::default().with_expected_host_epoch("other-epoch")),
        Err(ConnectError::HostEpochMismatch { .. })
    ));
}

#[test]
fn response_before_handshake_is_rejected() {
    let (stream, _host) = fake_host(|mut host| {
        host.read();
        host.write(json!({"requestId": "r", "operation": "host.status", "ok": true, "result": {}}));
    });
    assert!(matches!(
        connect(stream, ConnectOptions::default()),
        Err(ConnectError::UnexpectedFrame)
    ));
}

#[test]
fn silent_host_times_out_the_handshake() {
    let (stream, host) = fake_host(|mut host| {
        host.read();
        // Keep the socket open without answering until the client gives up.
        thread::sleep(Duration::from_millis(400));
    });
    let started = Instant::now();
    assert!(matches!(
        connect(stream, ConnectOptions::default().with_timeout(Duration::from_millis(100))),
        Err(ConnectError::Timeout(_))
    ));
    assert!(started.elapsed() < Duration::from_millis(390));
    host.join().expect("host thread");
}

#[test]
fn pushes_are_forwarded_including_unknown_frames() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        host.write(json!({"kind": "session.catalog.changed", "revision": 2, "sessionId": "s1"}));
        host.write(
            json!({"kind": "subscription.session_delta", "subscriptionId": "sub", "seq": 1}),
        );
        host.write(json!({"kind": "future.frame", "payload": [1, 2]}));
        host
    });
    let (connection, pushes, pump) = connect_running(stream);

    assert_eq!(
        block_on(pushes.recv()).expect("change notice"),
        PushEvent::Frame(PushFrame::Change(ChangeNotice::SessionCatalogChanged {
            revision: 2,
            session_id: "s1".into(),
            attention: None,
        }))
    );
    assert!(matches!(
        block_on(pushes.recv()).expect("subscription frame"),
        PushEvent::Frame(PushFrame::Subscription(frame)) if frame.subscription_id == "sub"
    ));
    assert!(matches!(
        block_on(pushes.recv()).expect("unknown frame"),
        PushEvent::Frame(PushFrame::Unknown(value)) if value["kind"] == "future.frame"
    ));

    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
    assert!(block_on(pushes.recv()).is_err(), "the push channel closes with the pump");
}

#[test]
fn operation_errors_are_returned_to_the_caller() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        let request = host.read();
        host.write(json!({
            "requestId": request["requestId"], "operation": request["operation"], "ok": false,
            "error": {"code": "host_not_ready", "message": "Runtime Host is starting"}
        }));
        host
    });
    let (connection, _pushes, pump) = connect_running(stream);
    let result =
        block_on(connection.request::<SessionCatalogQuery>(&SessionCatalogQueryInput::ListStart));
    match result {
        Err(RequestError::Operation { operation, error }) => {
            assert_eq!(operation, "session.catalog.query");
            assert_eq!(error.code, HostOperationErrorCode::HostNotReady);
        }
        other => panic!("expected an operation error, got {other:?}"),
    }
    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}

#[test]
fn timed_out_request_absorbs_its_late_response() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        let slow = host.read();
        thread::sleep(Duration::from_millis(150));
        // The late answer must not break the connection.
        host.reply(&slow, status_result());
        host.answer(status_result());
        host
    });
    let (connection, _pushes, pump) = connect_running(stream);

    let slow = block_on(connection.request_with_timeout::<HostStatus>(
        &HostStatusInput::default(),
        Duration::from_millis(50),
    ));
    assert!(matches!(slow, Err(RequestError::Timeout { .. })));
    let next = block_on(connection.host_status()).expect("the connection still works");
    assert_eq!(next.host_epoch, "epoch-1");

    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}

#[test]
fn unmatched_response_fails_the_connection() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        let _request = host.read();
        host.write(json!({"requestId": "nobody", "operation": "host.status", "ok": true,
                          "result": status_result()}));
        // Keep the socket open so only the protocol violation ends it.
        thread::sleep(Duration::from_millis(200));
    });
    let (connection, _pushes, pump) = connect_running(stream);
    let result = block_on(connection.request::<HostStatus>(&HostStatusInput::default()));
    assert!(matches!(result, Err(RequestError::Disconnected { .. })));
    assert!(matches!(pump.join().expect("pump thread"), Err(ConnectionError::Protocol(_))));
    assert!(connection.is_closed());
    host.join().expect("host thread");
}

#[test]
fn host_closing_the_socket_ends_the_pump() {
    let (stream, _host) = fake_host(|mut host| {
        host.accept();
    });
    let Connected { connection, pump, .. } =
        connect(stream, ConnectOptions::default()).expect("accepted");
    assert!(matches!(block_on(pump), Err(ConnectionError::HostClosed)));
    let result = block_on(connection.request::<HostStatus>(&HostStatusInput::default()));
    assert!(matches!(result, Err(RequestError::Disconnected { .. })));
}

#[test]
fn identity_change_in_host_status_shuts_the_connection_down() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        let mut status = status_result();
        status["hostEpoch"] = json!("epoch-2");
        host.answer(status);
        host
    });
    let (connection, _pushes, pump) = connect_running(stream);
    assert!(matches!(block_on(connection.host_status()), Err(RequestError::HostIdentityChanged)));
    pump.join().expect("pump thread").expect("shut down by the client");
    let _host = host.join().expect("host thread");
}

#[test]
fn wait_until_ready_polls_until_ready() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        let mut starting = status_result();
        starting["state"] = json!("starting");
        host.answer(starting.clone());
        host.answer(starting);
        host.answer(status_result());
        host
    });
    let (connection, _pushes, pump) = connect_running(stream);
    let status =
        block_on(connection.wait_until_ready(Duration::from_secs(5))).expect("becomes ready");
    assert_eq!(status.state, host_protocol::HostLifecycleState::Ready);
    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}

#[test]
fn dropping_every_handle_ends_the_pump() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        host
    });
    let Connected { connection, pump, .. } =
        connect(stream, ConnectOptions::default()).expect("accepted");
    let _host = host.join().expect("host thread");
    drop(connection);
    block_on(pump).expect("the pump ends cleanly once no handle can send");
}

#[test]
fn production_protocol_types_tolerate_unknown_fields() {
    // `host-protocol` compiles without `cfg(test)` here, so its types must
    // ignore fields a newer Host adds.
    let mut status = status_result();
    status["futureField"] = json!({"nested": true});
    let decoded: host_protocol::HostStatusResult =
        serde_json::from_value(status).expect("unknown fields are ignored");
    assert_eq!(decoded.connections, 1);

    let mut accepted = accepted();
    accepted["futureCapability"] = json!(true);
    assert!(matches!(
        host_protocol::HostFrame::decode(accepted).expect("classifies"),
        host_protocol::HostFrame::Handshake(host_protocol::HandshakeResult::Accepted(_))
    ));
}

#[test]
fn dropping_the_pump_fails_waiting_requests() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        let _unanswered = host.read();
        host
    });
    let Connected { connection, pump, .. } =
        connect(stream, ConnectOptions::default()).expect("accepted");
    // Poll the pump just long enough to send the request, then drop it.
    let input = HostStatusInput::default();
    let request = connection.request::<HostStatus>(&input);
    let result = block_on(async {
        let mut pump = Box::pin(pump);
        let mut request = Box::pin(request);
        futures_lite::future::poll_once(&mut request).await;
        futures_lite::future::poll_once(&mut pump).await;
        drop(pump);
        request.await
    });
    assert!(matches!(result, Err(RequestError::Disconnected { .. })));
    assert!(connection.is_closed());
    let _host = host.join().expect("host thread");
}

#[test]
fn a_full_push_channel_holds_the_pump_back_without_losing_frames() {
    const EXTRA: usize = 40;
    let total = PUSH_CHANNEL_CAPACITY + EXTRA;
    let (stream, host) = fake_host(move |mut host| {
        host.accept();
        for seq in 0..total {
            host.write(json!({"kind": "future.frame", "seq": seq}));
        }
        // The client asks for host.status while the pump is stuck behind the
        // pushes; answer only after every push has been written.
        let request = host.read();
        host.reply(&request, status_result());
        host
    });
    let (connection, pushes, pump) = connect_running(stream);

    // The answer sits behind pushes nobody reads yet, so it cannot arrive.
    let blocked = block_on(connection.request_with_timeout::<HostStatus>(
        &HostStatusInput::default(),
        Duration::from_millis(200),
    ));
    assert!(matches!(blocked, Err(RequestError::Timeout { .. })), "{blocked:?}");
    assert_eq!(pushes.len(), PUSH_CHANNEL_CAPACITY, "the channel stays bounded");

    let mut frames = Vec::new();
    let mut lagging = Vec::new();
    while frames.len() < total {
        let next = block_on(crate::connection::until(
            Instant::now() + Duration::from_secs(5),
            pushes.recv(),
        ));
        let Some(push) = next else {
            panic!("frames were lost: only {} of {total} arrived", frames.len());
        };
        match push.expect("push") {
            PushEvent::Frame(PushFrame::Unknown(value)) => {
                frames.push(value["seq"].as_u64().expect("seq") as usize)
            }
            PushEvent::Lagging => lagging.push(frames.len()),
            other => panic!("unexpected push {other:?}"),
        }
    }
    assert_eq!(frames, (0..total).collect::<Vec<_>>(), "every frame, in order");
    assert_eq!(
        lagging,
        [PUSH_CHANNEL_CAPACITY],
        "one lagging marker, before the first frame that waited"
    );

    // Once drained, the connection works again; the late answer to the timed
    // out request was absorbed.
    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}

#[test]
fn lagging_is_reported_again_after_the_consumer_catches_up() {
    let (stream, host) = fake_host(move |mut host| {
        host.accept();
        for round in 0..2 {
            for seq in 0..=PUSH_CHANNEL_CAPACITY {
                host.write(json!({"kind": "future.frame", "round": round, "seq": seq}));
            }
            // Wait for the client to say it drained this round.
            host.answer(json!({}));
        }
        host
    });
    let (connection, pushes, pump) = connect_running(stream);
    for _round in 0..2 {
        let mut lagging = 0;
        let mut frames = 0;
        // Let the pump fill the channel before draining.
        while pushes.len() < PUSH_CHANNEL_CAPACITY {
            thread::sleep(Duration::from_millis(5));
        }
        while frames <= PUSH_CHANNEL_CAPACITY {
            match block_on(pushes.recv()).expect("push") {
                PushEvent::Frame(_) => frames += 1,
                PushEvent::Lagging => lagging += 1,
            }
        }
        assert_eq!(lagging, 1);
        assert!(pushes.is_empty());
        block_on(connection.request_value("test.drained", json!({}), None)).expect("drained");
    }
    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}

#[test]
fn domain_requests_queue_behind_the_in_flight_budget_but_host_status_does_not() {
    const BUDGET: usize = host_protocol::MAX_IN_FLIGHT_DOMAIN_REQUESTS - 1;
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        let mut held: Vec<Value> = (0..BUDGET).map(|_| host.read()).collect();
        assert!(held.iter().all(|request| request["operation"] == "session.catalog.query"));
        // The next request on the wire is the status probe that bypasses the
        // budget, not the queued domain request.
        let status = host.read();
        assert_eq!(status["operation"], "host.status");
        host.reply(&status, status_result());
        assert!(
            host.read_within(Duration::from_millis(150)).is_none(),
            "no domain request beyond the budget is sent"
        );
        // Answering one frees a slot for the queued request.
        let first = held.remove(0);
        host.reply(&first, empty_page());
        let queued = host.read();
        assert_eq!(queued["operation"], "session.catalog.query");
        host.reply(&queued, empty_page());
        for request in held {
            host.reply(&request, empty_page());
        }
        host
    });
    let (connection, _pushes, pump) = connect_running(stream);
    let requests: Vec<_> = (0..=BUDGET)
        .map(|_| {
            let connection = connection.clone();
            thread::spawn(move || {
                block_on(
                    connection.request::<SessionCatalogQuery>(&SessionCatalogQueryInput::ListStart),
                )
            })
        })
        .collect();
    // Give every domain request time to take a slot or queue.
    thread::sleep(Duration::from_millis(100));
    block_on(connection.host_status()).expect("host.status bypasses the budget");
    for request in requests {
        request.join().expect("request thread").expect("catalog page");
    }
    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}

/// Adversarial review 2026-09-26: the Host encodes every frame with
/// `JSON.stringify` (`encodeProtocolMessage` in
/// `packages/runtime-host/src/protocol/index.ts`), which writes a lone UTF-16
/// surrogate as a `\udXXX` escape, and the TS client parses frames with
/// `JSON.parse` (`local-ipc-framing.ts`), which accepts it. A lone surrogate
/// reaches a frame whenever the Host cuts a string by UTF-16 length inside an
/// astral character; `withinWireLimit` in `packages/core/src/model-catalog.ts`
/// does that to model display names and descriptions. `decode_frame_json`
/// (serde_json) rejected the escape, so the pump ended the whole connection,
/// and the same frame came back after every reconnect that read the same data.
/// It now replaces unpaired surrogate escapes with U+FFFD before parsing.
#[test]
fn a_lone_surrogate_escape_does_not_end_the_connection() {
    let (stream, host) = fake_host(|mut host| {
        host.accept();
        host.writer
            .write_all(b"{\"kind\":\"future.frame\",\"description\":\"cut inside \\ud83d\"}\n")
            .expect("write frame");
        if let Some(request) = host.read_within(Duration::from_secs(5)) {
            host.reply(&request, status_result());
        }
        host
    });
    let (connection, pushes, pump) = connect_running(stream);

    let pushed =
        block_on(crate::connection::until(Instant::now() + Duration::from_secs(5), pushes.recv()));
    assert!(
        matches!(&pushed, Some(Ok(PushEvent::Frame(PushFrame::Unknown(value))))
            if value["description"].as_str().is_some_and(|text| text.starts_with("cut inside"))),
        "the frame is delivered: {pushed:?}"
    );
    block_on(connection.host_status()).expect("the connection survives the frame");

    let _host = host.join().expect("host thread");
    connection.shutdown();
    pump.join().expect("pump thread").expect("clean shutdown");
}
