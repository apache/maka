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

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, Write},
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use x11rb::{
    connection::Connection,
    protocol::{Event, xproto::*},
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};

const SOCKET_ENV: &str = "MAKA_WHEEL_FIXTURE_SOCKET";

#[derive(Deserialize, Serialize)]
#[serde(tag = "command", deny_unknown_fields)]
enum Request {
    Create,
    Events { window: u32 },
    Close { window: u32 },
    Shutdown,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "response", deny_unknown_fields)]
enum Response {
    Created { window: u32, pid: u32 },
    Events { events: Vec<ObservedEvent> },
    Closed,
    Shutdown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedEvent {
    pub press: bool,
    pub event: u32,
    pub detail: u8,
    pub event_x: i16,
    pub event_y: i16,
    pub response_type: u8,
    pub time: u32,
}

// NO_EVENT XSendEvent reaches the creating client; it must be outside the SDK's authorization process.
pub struct Window {
    pub id: u32,
    child: Option<Child>,
    connection: tokio::io::BufReader<tokio::net::UnixStream>,
    _directory: tempfile::TempDir,
}

impl Window {
    pub async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("fixture.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "linux_wheel::fixture_process",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(SOCKET_ENV, socket)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut owner = ChildOwner(Some(child));
        let (connection, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .expect("fixture process did not connect")
            .unwrap();
        let mut result = Self {
            id: 0,
            child: owner.0.take(),
            connection: tokio::io::BufReader::new(connection),
            _directory: directory,
        };
        result.id = result.create().await;
        result
    }

    async fn request(&mut self, request: Request) -> Response {
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        self.connection.get_mut().write_all(&bytes).await.unwrap();
        let mut response = String::new();
        assert_ne!(
            tokio::time::timeout(
                Duration::from_secs(10),
                self.connection.read_line(&mut response),
            )
            .await
            .expect("fixture process did not reply")
            .unwrap(),
            0,
            "fixture process closed its control socket"
        );
        serde_json::from_str(&response).unwrap()
    }

    async fn create(&mut self) -> u32 {
        let Response::Created { window, pid } = self.request(Request::Create).await else {
            panic!("fixture did not create its window")
        };
        assert_eq!(pid, self.child.as_ref().unwrap().id());
        assert_ne!(pid, std::process::id());
        eprintln!(
            "MAKA_PUBLIC_WHEEL_FIXTURE {}",
            serde_json::json!({"window":window,"fixture_pid":pid,"runtime_pid":std::process::id()})
        );
        window
    }

    pub async fn sibling(&mut self) -> u32 {
        self.create().await
    }

    pub async fn events(&mut self) -> Vec<ObservedEvent> {
        self.events_for(self.id).await
    }

    pub async fn events_for(&mut self, window: u32) -> Vec<ObservedEvent> {
        let Response::Events { events } = self.request(Request::Events { window }).await else {
            panic!("fixture did not return its events")
        };
        events
    }

    pub async fn close(&mut self) {
        assert!(matches!(
            self.request(Request::Close { window: self.id }).await,
            Response::Closed
        ));
    }

    pub async fn finish(mut self) {
        assert!(matches!(
            self.request(Request::Shutdown).await,
            Response::Shutdown
        ));
        let mut child = self.child.take().unwrap();
        let status = tokio::task::spawn_blocking(move || child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success(), "fixture process failed: {status}");
    }
}

struct ChildOwner(Option<Child>);
impl Drop for ChildOwner {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        drop(ChildOwner(self.child.take()));
    }
}

#[test]
#[ignore = "private subprocess entry point for the disposable X11 fixture"]
fn fixture_process() {
    let Some(socket) = std::env::var_os(SOCKET_ENV) else {
        return;
    };
    let connection = std::os::unix::net::UnixStream::connect(socket).unwrap();
    let mut connection = std::io::BufReader::new(connection);
    let mut windows = BTreeMap::new();
    loop {
        let mut line = String::new();
        if connection.read_line(&mut line).unwrap() == 0 {
            break;
        }
        let (response, shutdown) = match serde_json::from_str::<Request>(&line).unwrap() {
            Request::Create => {
                let window = RawWindow::new();
                let id = window.id;
                windows.insert(id, window);
                (
                    Response::Created {
                        window: id,
                        pid: std::process::id(),
                    },
                    false,
                )
            }
            Request::Events { window } => (
                Response::Events {
                    events: windows.get(&window).expect("known fixture window").events(),
                },
                false,
            ),
            Request::Close { window } => {
                windows
                    .get_mut(&window)
                    .expect("known fixture window")
                    .close();
                (Response::Closed, false)
            }
            Request::Shutdown => (Response::Shutdown, true),
        };
        serde_json::to_writer(connection.get_mut(), &response).unwrap();
        connection.get_mut().write_all(b"\n").unwrap();
        if shutdown {
            break;
        }
    }
}

struct RawWindow {
    connection: RustConnection,
    pub id: u32,
    closed: bool,
}

impl RawWindow {
    fn new() -> Self {
        let (connection, screen) = x11rb::connect(None).expect("isolated X11 display");
        let root = connection.setup().roots[screen].root;
        let id = connection.generate_id().unwrap();
        connection
            .create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                id,
                root,
                100,
                100,
                320,
                240,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new()
                    .event_mask(EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE),
            )
            .unwrap()
            .check()
            .unwrap();
        connection
            .change_property8(
                PropMode::REPLACE,
                id,
                AtomEnum::WM_NAME,
                AtomEnum::STRING,
                b"Maka isolated wheel fixture",
            )
            .unwrap()
            .check()
            .unwrap();
        let pid = connection
            .intern_atom(false, b"_NET_WM_PID")
            .unwrap()
            .reply()
            .unwrap()
            .atom;
        connection
            .change_property32(
                PropMode::REPLACE,
                id,
                pid,
                AtomEnum::CARDINAL,
                &[std::process::id()],
            )
            .unwrap()
            .check()
            .unwrap();
        connection.map_window(id).unwrap().check().unwrap();
        connection.flush().unwrap();
        let clients = connection
            .intern_atom(false, b"_NET_CLIENT_LIST_STACKING")
            .unwrap()
            .reply()
            .unwrap()
            .atom;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let listed = connection
                .get_property(false, root, clients, AtomEnum::WINDOW, 0, u32::MAX)
                .unwrap()
                .reply()
                .unwrap()
                .value32()
                .is_some_and(|mut windows| windows.any(|window| window == id));
            let mapped = connection
                .get_window_attributes(id)
                .unwrap()
                .reply()
                .unwrap()
                .map_state
                == MapState::VIEWABLE;
            if listed && mapped {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "fixture window {id} was not mapped and listed by its window manager"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        Self {
            connection,
            id,
            closed: false,
        }
    }

    fn events(&self) -> Vec<ObservedEvent> {
        self.connection.get_input_focus().unwrap().reply().unwrap();
        let mut events = Vec::new();
        while let Some(event) = self.connection.poll_for_event().unwrap() {
            match event {
                Event::ButtonPress(event) => events.push(observed(true, event)),
                Event::ButtonRelease(event) => events.push(observed(false, event)),
                Event::Error(error) => panic!("X11 fixture error: {error:?}"),
                _ => {}
            }
        }
        events
    }

    fn close(&mut self) {
        if !self.closed {
            self.connection
                .destroy_window(self.id)
                .unwrap()
                .check()
                .unwrap();
            self.closed = true;
        }
    }
}

impl Drop for RawWindow {
    fn drop(&mut self) {
        self.close();
    }
}

fn observed(press: bool, event: ButtonPressEvent) -> ObservedEvent {
    ObservedEvent {
        press,
        event: event.event,
        detail: event.detail,
        event_x: event.event_x,
        event_y: event.event_y,
        response_type: event.response_type,
        time: event.time,
    }
}
