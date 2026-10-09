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

//! A scripted remote Runtime Host for tests: one WebSocket on a loopback
//! port, driven with tungstenite's blocking server on a test thread. This
//! crate's remote tests use it, and so can other crates' (feature
//! `test-support`), to pair with or connect to a Host whose every answer
//! the test writes. The frames follow the TypeScript decoders the rest of
//! this crate cites.
#![allow(clippy::disallowed_methods, clippy::expect_used)]

use std::net::{TcpListener, TcpStream};

pub use async_tungstenite::tungstenite::Message;
use async_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
pub use async_tungstenite::tungstenite::http::{HeaderMap, StatusCode};
use async_tungstenite::tungstenite::{self, WebSocket};
use host_protocol::RUNTIME_HOST_COMPATIBILITY_EPOCH;
use serde_json::{Value, json};

/// The State Root id the scripted Host serves unless told otherwise.
pub const SCRIPTED_ROOT_ID: &str =
    "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

/// The Host end of one WebSocket.
#[derive(Debug)]
pub struct ScriptedWebSocketHost {
    socket: WebSocket<TcpStream>,
    path: String,
    headers: HeaderMap,
}

impl ScriptedWebSocketHost {
    /// Accepts one connection on `listener`; `refuse` answers the upgrade
    /// with that status instead (`None` then).
    pub fn accept(listener: &TcpListener, refuse: Option<StatusCode>) -> Option<Self> {
        let (stream, _) = listener.accept().expect("accept");
        let mut path = String::new();
        let mut headers = HeaderMap::new();
        // tungstenite's server callback returns its own `ErrorResponse`.
        #[allow(clippy::result_large_err)]
        let callback = |request: &Request, response: Response| {
            path = request.uri().path().to_owned();
            headers = request.headers().clone();
            match refuse {
                None => Ok(response),
                Some(status) => {
                    let mut refusal = ErrorResponse::new(None);
                    *refusal.status_mut() = status;
                    Err(refusal)
                }
            }
        };
        let socket = tungstenite::accept_hdr(stream, callback).ok()?;
        Some(Self { socket, path, headers })
    }

    /// The upgrade request's path.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// The upgrade request's headers.
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    /// Sends a raw WebSocket message (a binary one, an oversize one).
    pub fn send(&mut self, message: Message) {
        let _ = self.socket.send(message);
    }

    /// The next text message, which must be one JSON value with no newline;
    /// `None` once the client closed.
    pub fn read(&mut self) -> Option<Value> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    assert!(!text.contains('\n'), "a message is one line of JSON: {text}");
                    return Some(serde_json::from_str(&text).expect("client message is JSON"));
                }
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    pub fn write(&mut self, value: Value) {
        self.socket.send(Message::text(value.to_string())).expect("send");
    }

    /// Reads the hello and accepts it for [`SCRIPTED_ROOT_ID`].
    pub fn accept_hello(&mut self) -> Value {
        self.accept_hello_for(SCRIPTED_ROOT_ID)
    }

    /// Reads the hello and accepts it for the State Root `root_id`.
    pub fn accept_hello_for(&mut self, root_id: &str) -> Value {
        let hello = self.read().expect("hello");
        self.write(accepted_frame(root_id));
        hello
    }

    /// Answers the next request with `result`, returning the request.
    pub fn answer(&mut self, result: Value) -> Value {
        let request = self.read().expect("request");
        self.reply(&request, result);
        request
    }

    pub fn reply(&mut self, request: &Value, result: Value) {
        self.write(json!({
            "requestId": request["requestId"],
            "operation": request["operation"],
            "ok": true,
            "result": result
        }));
    }

    /// Answers `request` with the error `code`.
    pub fn refuse(&mut self, request: &Value, code: &str) {
        self.write(json!({
            "requestId": request["requestId"],
            "operation": request["operation"],
            "ok": false,
            "error": {"code": code, "message": "refused by the scripted Host"}
        }));
    }

    /// One pairing connection: the hello, `host.status` ready, then the
    /// finalize answered with `finalize` (a result or an error code).
    pub fn play_pairing(&mut self, finalize: Result<Value, &str>) {
        self.accept_hello();
        self.answer(status_result());
        let request = self.read().expect("finalize");
        assert_eq!(request["operation"], "access.credential.finalize");
        assert_eq!(request["input"], json!({}));
        match finalize {
            Ok(result) => self.reply(&request, result),
            Err(code) => self.refuse(&request, code),
        }
    }

    /// Reads until the client closes, so the client's close is observed.
    pub fn drain(&mut self) {
        while self.read().is_some() {}
    }
}

/// A listener on a free loopback port, and the port.
pub fn free_listener() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("address").port();
    (listener, port)
}

/// An `accepted` frame for `root_id` at this client's compatibility epoch
/// (`decodeHostAccepted`).
pub fn accepted_frame(root_id: &str) -> Value {
    json!({
        "kind": "accepted",
        "rootId": root_id,
        "hostEpoch": "epoch-1",
        "connectionId": "connection-1",
        "selectedProtocol": 0,
        "compatibilityEpoch": RUNTIME_HOST_COMPATIBILITY_EPOCH,
        "compositionId": "maka.interactive",
        "compositionRevision": "3",
        "state": "ready"
    })
}

/// A `host.status` result for a ready Host (`decodeHostStatusResult`).
pub fn status_result() -> Value {
    json!({
        "hostEpoch": "epoch-1",
        "compositionId": "maka.interactive",
        "compositionRevision": "3",
        "state": "ready",
        "connections": 1,
        "activeOperations": 1,
        "activeResidencies": 0
    })
}
