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

//! End to end against a running development Host: the window's terminal
//! owner starts a terminal in a scratch task, `echo` is typed and read back
//! from the emulator, and the terminal is closed (its shell stopped); then
//! the same through the terminal view in a window, typed as keys and
//! painted at the window's size.
//!
//! Ignored by default. Run it against a Host serving a development State
//! Root, never live Maka data:
//!
//! ```sh
//! MAKA_GPUI_LIVE_ROOT=~/code/maka-gpui/target/demo-root \
//!   cargo test -p terminal --test live_host -- --ignored --nocapture --test-threads 1
//! ```
//!
//! It connects to the registered Host directly (it never starts one),
//! creates a task in `/private/tmp/maka-gpui-fixture-workspace`, keeps one
//! terminal at most, and removes the task again, stopping the terminal
//! first if a step failed.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use conversation::ConversationState;
use futures_lite::future::{Boxed, block_on};
use gpui_kit::{AppContext as _, Entity, TestAppContext};
use host_client::{
    ConnectOptions, Connected, Connection, ConnectionEvent, HostEvent, PushEvent, RequestError,
    discover_host, random_client_instance_id,
};
use host_protocol::ClientHello;
use serde_json::{Value, json};
use terminal::{TerminalPhase, Terminals, TerminalsShown};
use workspace::{HostRequestError, HostSession, HostTransport};

const WORKSPACE: &str = "/private/tmp/maka-gpui-fixture-workspace";
const WAIT: Duration = Duration::from_secs(30);

/// Requests over a direct connection to the Host.
struct LiveTransport(Connection);

impl HostTransport for LiveTransport {
    fn request(
        &self,
        operation: &'static str,
        input: Value,
        timeout: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        let connection = self.0.clone();
        Box::pin(async move {
            connection.request_value(operation, input, Some(timeout)).await.map_err(|error| {
                match error {
                    RequestError::Operation { error, .. } => HostRequestError::Operation {
                        operation,
                        code: error.code,
                        message: error.message.into(),
                    },
                    other => HostRequestError::Transport(other.to_string().into()),
                }
            })
        })
    }
}

/// Removes the scratch task when the test ends, stopping its terminal
/// first when a step failed before the close.
struct Scratch {
    connection: Connection,
    session_id: String,
    terminal: Option<String>,
}

impl Scratch {
    fn request(&self, operation: &str, input: Value) -> Result<Value, RequestError> {
        block_on(self.connection.request_value(operation, input, Some(Duration::from_secs(15))))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(resource_ref) = self.terminal.take() {
            let stopped = self.request(
                "runtime.resource.stop",
                json!({"sessionId": self.session_id, "ref": resource_ref}),
            );
            eprintln!("cleanup: stop {resource_ref}: {:?}", stopped.map(|_| ()));
        }
        let archived = self.request(
            "session.lifecycle.set",
            json!({"sessionId": self.session_id, "state": "archived"}),
        );
        let revision = archived.ok().and_then(|result| result["revision"].as_u64());
        let removed = revision.map(|revision| {
            self.request(
                "session.remove",
                json!({"sessionId": self.session_id, "expectedRevision": revision}),
            )
        });
        eprintln!("cleanup: removed {}: {:?}", self.session_id, removed.map(|r| r.is_ok()));
        self.connection.shutdown();
    }
}

/// Runs the window until `done` holds, feeding it what the Host pushes.
#[allow(clippy::disallowed_methods, reason = "a test waiting for a real Host")]
fn wait_until(
    cx: &mut TestAppContext,
    host: &Entity<HostSession>,
    pushes: &async_channel::Receiver<PushEvent>,
    what: &str,
    mut done: impl FnMut(&mut TestAppContext) -> bool,
) {
    let deadline = Instant::now() + WAIT;
    loop {
        while let Ok(event) = pushes.try_recv() {
            if let PushEvent::Frame(frame) = event {
                host.update(cx, |host, cx| host.handle_host_event(HostEvent::Push(frame), cx));
            }
        }
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A window's Host connection, conversation and terminals on a scratch
/// task of the Host serving `MAKA_GPUI_LIVE_ROOT`.
struct Live {
    host: Entity<HostSession>,
    pushes: async_channel::Receiver<PushEvent>,
    scratch: Scratch,
    conversation: Entity<ConversationState>,
    terminals: Entity<Terminals>,
    pump: std::thread::JoinHandle<Result<(), host_client::ConnectionError>>,
    session_id: String,
}

impl Live {
    fn open(cx: &mut TestAppContext) -> Option<Self> {
        let Some(root) = std::env::var_os("MAKA_GPUI_LIVE_ROOT").map(PathBuf::from) else {
            eprintln!("MAKA_GPUI_LIVE_ROOT is not set; nothing to run against");
            return None;
        };
        // The connection's pump runs on a thread of its own and wakes the
        // window's tasks from there: real I/O, not the test scheduler's.
        cx.executor().allow_parking();
        std::fs::create_dir_all(WORKSPACE).expect("workspace");
        let discovered = block_on(discover_host(&root)).expect("a Host serves the root");
        let hello = ClientHello::new(random_client_instance_id());
        let options = ConnectOptions::default().with_expected_root_id(discovered.root_id.clone());
        let Connected { connection, pump, pushes, .. } =
            block_on(Connection::connect(&discovered.registration.endpoint, hello, options))
                .expect("connect");
        let pump = std::thread::spawn(move || block_on(pump));
        let accepted = connection.accepted().clone();
        let session_id = format!("e2e-terminal-{}", uuid::Uuid::new_v4().simple());
        let scratch = Scratch {
            connection: connection.clone(),
            session_id: session_id.clone(),
            terminal: None,
        };
        scratch
            .request(
                "session.create",
                json!({"sessionId": session_id, "workspace": {"kind": "host_path", "path": WORKSPACE},
                       "modelTarget": {"kind": "default"}, "name": "Terminal end to end"}),
            )
            .expect("session.create");
        let transport = Arc::new(LiveTransport(connection.clone()));
        let host = cx.new(|_| HostSession::with_transport(root.clone(), transport));
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted }),
                cx,
            )
        });
        let conversation = cx.new(|cx| ConversationState::new(host.clone(), cx));
        let terminals = cx.new(|cx| Terminals::new(host.clone(), conversation.clone(), cx));
        conversation
            .update(cx, |state, cx| state.select_session(Some(session_id.clone().into()), cx));
        Some(Self { host, pushes, scratch, conversation, terminals, pump, session_id })
    }

    fn wait(
        &self,
        cx: &mut TestAppContext,
        what: &str,
        done: impl FnMut(&mut TestAppContext) -> bool,
    ) {
        wait_until(cx, &self.host, &self.pushes, what, done);
    }

    /// The terminal's state once closed: its shell ended.
    fn status_after_close(&mut self) -> Value {
        let resource_ref = self.scratch.terminal.take().expect("ref");
        let state = self
            .scratch
            .request(
                "runtime.resource.query",
                json!({"kind": "get", "sessionId": self.session_id, "ref": resource_ref}),
            )
            .expect("get");
        state["resource"]["result"].clone()
    }

    fn finish(self, cx: &mut TestAppContext) {
        self.conversation.update(cx, |state, cx| state.select_session(None, cx));
        cx.run_until_parked();
        let Self { scratch, pump, .. } = self;
        drop(scratch);
        pump.join().expect("pump").ok();
    }
}

#[gpui_kit::test]
#[ignore = "needs a running development Host: set MAKA_GPUI_LIVE_ROOT"]
fn a_terminal_runs_echo_on_a_real_host(cx: &mut TestAppContext) {
    let Some(mut live) = Live::open(cx) else { return };
    let terminals = live.terminals.clone();
    terminals.update(cx, |terminals, cx| terminals.set_shown(TerminalsShown::Face, cx));
    live.wait(cx, "the empty inventory", |cx| {
        terminals
            .read_with(cx, |terminals, _| *terminals.inventory() == terminal::Inventory::Loaded)
    });

    terminals.update(cx, |terminals, cx| terminals.start(cx));
    live.wait(cx, "a started terminal", |cx| {
        terminals.read_with(cx, |terminals, _| !terminals.terminals().is_empty())
    });
    let terminal = terminals.read_with(cx, |terminals, _| terminals.terminals()[0].clone());
    live.scratch.terminal =
        Some(terminal.read_with(cx, |terminal, _| terminal.resource_ref().to_string()));
    terminal.update(cx, |terminal, cx| terminal.set_grid(100, 30, cx));
    live.wait(cx, "the prompt", |cx| {
        terminal.read_with(cx, |terminal, _| {
            *terminal.phase() == TerminalPhase::Live && !terminal.content().text().trim().is_empty()
        })
    });

    terminal.update(cx, |terminal, cx| terminal.input("echo maka-e2e-$((40+2))\r", cx));
    live.wait(cx, "the echo", |cx| {
        terminal.read_with(cx, |terminal, _| terminal.content().text().contains("maka-e2e-42"))
    });
    let (text, size) =
        terminal.read_with(cx, |terminal, _| (terminal.content().text(), terminal.content().size));
    let shown: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    eprintln!("grid {}x{}, screen:\n{}", size.cols, size.rows, shown.join("\n"));
    assert_eq!((size.cols, size.rows), (100, 30));

    terminals.update(cx, |terminals, cx| terminals.close(&terminal, cx));
    live.wait(cx, "the close", |cx| {
        terminals.read_with(cx, |terminals, _| terminals.terminals().is_empty())
    });
    let state = live.status_after_close();
    eprintln!("after the close: {}, exit code {}", state["status"], state["exitCode"]);
    assert!(["cancelled", "completed", "failed"].contains(&state["status"].as_str().unwrap_or("")));
    live.finish(cx);
}

#[gpui_kit::test]
#[ignore = "needs a running development Host: set MAKA_GPUI_LIVE_ROOT"]
fn the_terminal_view_types_and_paints_on_a_real_host(cx: &mut TestAppContext) {
    use gpui_kit::component::Root;
    use gpui_kit::test::TestWindowExt as _;
    use terminal::TerminalView;

    let Some(mut live) = Live::open(cx) else { return };
    cx.update(|cx| {
        gpui_kit::init(cx);
        search::init(cx);
        terminal::init(cx);
    });
    let terminals = live.terminals.clone();
    let mut view = None;
    let window =
        cx.open_window(gpui_kit::size(gpui_kit::px(900.), gpui_kit::px(560.)), |window, cx| {
            let terminal_view = cx.new(|cx| TerminalView::new(terminals.clone(), window, cx));
            view = Some(terminal_view.clone());
            Root::new(terminal_view, window, cx)
        });
    let view = view.expect("view");
    let frame = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| window.render_frame(cx)).expect("window");
    };
    terminals.update(cx, |terminals, cx| terminals.set_shown(TerminalsShown::Face, cx));
    live.wait(cx, "the empty inventory", |cx| {
        frame(cx);
        terminals
            .read_with(cx, |terminals, _| *terminals.inventory() == terminal::Inventory::Loaded)
    });
    view.update(cx, |view, cx| view.new_terminal(cx));
    live.wait(cx, "a started terminal", |cx| {
        frame(cx);
        view.read_with(cx, |view, cx| view.active_terminal(cx).is_some())
    });
    let terminal = view.read_with(cx, |view, cx| view.active_terminal(cx)).expect("terminal");
    live.scratch.terminal =
        Some(terminal.read_with(cx, |terminal, _| terminal.resource_ref().to_string()));
    live.wait(cx, "the prompt at the window's size", |cx| {
        frame(cx);
        terminal.read_with(cx, |terminal, _| {
            let content = terminal.content();
            *terminal.phase() == TerminalPhase::Live
                && !content.text().trim().is_empty()
                && (content.size.cols, content.size.rows) != (80, 24)
        })
    });
    cx.update_window(window.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.focus(window, cx));
        window.input("echo maka-view-$((40+2))", cx);
        window.press("enter", cx);
    })
    .expect("window");
    live.wait(cx, "the echo", |cx| {
        frame(cx);
        terminal.read_with(cx, |terminal, _| terminal.content().text().contains("maka-view-42"))
    });
    let (text, size) =
        terminal.read_with(cx, |terminal, _| (terminal.content().text(), terminal.content().size));
    let shown: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    eprintln!("grid {}x{} from the window, screen:\n{}", size.cols, size.rows, shown.join("\n"));
    let painted = cx
        .update_window(window.into(), |_, window, _| window.try_find("terminal-box").is_some())
        .expect("window");
    assert!(painted, "the grid's box is drawn");

    let resource_ref = terminal.read_with(cx, |terminal, _| terminal.resource_ref().clone());
    view.update(cx, |view, cx| view.close(&resource_ref, cx));
    live.wait(cx, "the close", |cx| {
        frame(cx);
        view.read_with(cx, |view, cx| view.tabs(cx).is_empty())
    });
    let state = live.status_after_close();
    eprintln!("after the close: {}, exit code {}", state["status"], state["exitCode"]);
    assert!(["cancelled", "completed", "failed"].contains(&state["status"].as_str().unwrap_or("")));
    live.finish(cx);
}
