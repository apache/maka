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

//! UI integration tests of the screen that stands in for the task view
//! while a Host blocker is in place: a Runtime Host of another protocol
//! epoch, and a missing or unbuilt Maka checkout. The production window
//! content runs against a scripted Host transport; the supervisor's events
//! are fed as the `host-client` supervisor sends them (its own tests cover
//! a scripted Host answering `incompatible`).

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{App, AppContext as _, Entity, TestAppContext, WindowHandle, px, size};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::{
    HostAccepted, MAKA_PIN_COMMIT, RUNTIME_HOST_COMPATIBILITY_EPOCH, ReplacementDisposition,
};
use serde_json::{Value, json};
use shared::copy::host as copy;
use shared::copy::{self as shell_copy, Locale};
use workspace::{
    EpochMismatch, HostBlocker, HostRequestError, HostSession, HostTransport, MissingCheckout,
    StateRootStore, UnavailableProjectCatalog,
};

use crate::{BuildWorkbench, StateRootSetup, Workbench};

const EN: Locale = Locale::English;

/// Lists one task and opens an empty subscription for it.
struct ScriptedHost;

impl HostTransport for ScriptedHost {
    fn request(
        &self,
        operation: &'static str,
        input: Value,
        _: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        let result = match operation {
            "session.catalog.query" => Ok(json!({
                "kind": "page",
                "revision": format!("sha256:{}", "0".repeat(64)),
                "sessions": [session("s1")],
                "nextCursor": null
            })),
            "subscription.open" => Ok(open_result(input["sessionId"].as_str().expect("id"))),
            "subscription.ready" | "subscription.close" => {
                Ok(json!({"subscriptionId": input["subscriptionId"]}))
            }
            other => Err(HostRequestError::Transport(format!("unexpected {other}").into())),
        };
        Box::pin(async move { result })
    }
}

fn session(id: &str) -> Value {
    json!({
        "id": id, "revision": 1,
        "workspace": {"target": {"kind": "host_path", "path": "/work/demo"}, "hostCwd": "/work/demo"},
        "createdAt": 1, "activityAt": 2, "name": "Alpha", "isFlagged": false, "isArchived": false,
        "labels": [], "labelsTruncated": false, "hasUnread": false, "status": "active",
        "backend": "ai-sdk", "llmConnectionId": null, "llmConnectionSlug": "env",
        "connectionLocked": false, "model": "m", "permissionMode": "ask",
        "collaborationMode": "agent", "orchestrationMode": "default"
    })
}

fn open_result(session_id: &str) -> Value {
    json!({
        "hostEpoch": "e1",
        "subscriptionId": format!("sub-{session_id}"),
        "nextSequence": 1,
        "snapshot": {
            "schemaVersion": 5,
            "session": {"sessionId": session_id, "metadataRevision": 1, "status": "active",
                        "createdAt": 1, "isArchived": false},
            "projectionRevision": 1, "rootTurn": null, "goal": null,
            "queue": {"hostEpoch": "e1", "queueRevision": 0, "steering": [], "followup": []},
            "interactions": {"pending": []}
        },
        "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": session_id, "direction": "older", "throughSequence": null,
            "rawBytes": 0, "fragments": [], "nextCursor": null, "endsAtTurnBoundary": true
        }}
    })
}

fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": "e1", "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": RUNTIME_HOST_COMPATIBILITY_EPOCH,
        "compositionId": "maka.interactive", "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

/// Remembers nothing: Switch data folder… only has to open its dialog.
struct NoStore;

impl StateRootStore for NoStore {
    fn load(&self) -> Boxed<std::io::Result<Option<PathBuf>>> {
        Box::pin(async { Ok(None) })
    }

    fn remember(&self, _: PathBuf) -> Boxed<std::io::Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

struct Harness {
    host: Entity<HostSession>,
    window: WindowHandle<Root>,
}

impl Harness {
    fn open(cx: &mut TestAppContext) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            cx.set_reduce_motion(true);
        });
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), Arc::new(ScriptedHost))
        });
        let build: Rc<BuildWorkbench> =
            Rc::new(|_, _, _, _| unreachable!("the root is not switched"));
        let setup = StateRootSetup::new(Rc::new(NoStore), PathBuf::from("/tmp/other"), None, build);
        let window = cx.open_window(size(px(1200.), px(800.)), |window, cx| {
            let view = cx.new(|cx| {
                let mut workbench =
                    Workbench::new(host.clone(), Rc::new(UnavailableProjectCatalog), window, cx);
                workbench.set_state_root_setup(setup);
                workbench
            });
            Root::new(view, window, cx)
        });
        let harness = Self { host, window };
        harness.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
        harness
    }

    fn feed(&self, event: ConnectionEvent, cx: &mut TestAppContext) {
        self.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Connection(event), cx));
        cx.run_until_parked();
    }

    /// An attempt fails permanently with `blocker`, as the supervisor
    /// reports it.
    fn block(&self, blocker: HostBlocker, cx: &mut TestAppContext) {
        let reason: Arc<str> = "the Runtime Host is incompatible with this client".into();
        self.feed(ConnectionEvent::AttemptFailed { attempt: 1, reason: reason.clone() }, cx);
        self.feed(ConnectionEvent::Suspended { reason, blocker: Some(blocker) }, cx);
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut gpui_kit::Window, &mut App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        result
    }

    fn label(&self, id: &'static str, cx: &mut TestAppContext) -> String {
        self.with_window(cx, |window, _| {
            window.find(id).label().unwrap_or_else(|| panic!("{id} has a label")).to_owned()
        })
    }

    fn checkout(&self, cx: &mut TestAppContext) -> Option<PathBuf> {
        self.host.read_with(cx, |host, _| host.maka_checkout().map(Path::to_owned))
    }
}

fn fact(label: shell_copy::Text, value: &str) -> String {
    shell_copy::labeled(EN, label.en(), value)
}

#[gpui_kit::test]
fn a_host_of_another_epoch_gets_a_screen_that_says_which_side_to_update(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let older = RUNTIME_HOST_COMPATIBILITY_EPOCH - 1;
    harness.block(
        HostBlocker::Epoch(EpochMismatch::new(
            older,
            Some(ReplacementDisposition::WaitForIdleExit),
        )),
        cx,
    );
    harness.with_window(cx, |window, _| {
        assert!(window.find("host-blocked").visible());
        // It stands in for the task view and the strip; the sidebar stays.
        assert!(window.try_find("host-disconnected").is_none());
        assert!(window.try_find("empty-state").is_none());
        assert!(window.try_find("send-message").is_none(), "no composer");
        assert!(window.find(shared::domain_element_id("session-row", "s1")).visible());
        assert_eq!(
            window.find("sidebar-footer").label(),
            Some("Local Host, Disconnected, data folder .dev-root")
        );
        assert_eq!(window.find("host-blocked-retry").label(), Some(shell_copy::RETRY.en()));
    });
    assert_eq!(harness.label("host-blocked-title", cx), copy::HOST_OLDER_TITLE.en());
    assert_eq!(
        harness.label("host-blocked-client-epoch", cx),
        fact(copy::CLIENT_LABEL, &copy::epoch_value(EN, RUNTIME_HOST_COMPATIBILITY_EPOCH))
    );
    assert_eq!(
        harness.label("host-blocked-host-epoch", cx),
        fact(copy::HOST_LABEL, &copy::epoch_value(EN, older))
    );
    assert_eq!(harness.label("host-blocked-pin", cx), fact(copy::PIN_LABEL, MAKA_PIN_COMMIT));
    assert_eq!(harness.label("host-blocked-steps", cx), copy::UPDATE_HOST_STEPS.en());
    assert_eq!(harness.label("host-blocked-note", cx), copy::HOST_EXITS_WHEN_IDLE.en());
    // The commands move the checkout this window starts Hosts from to the
    // pinned commit and build it.
    let checkout = harness.checkout(cx).expect("a home directory in tests");
    assert_eq!(
        harness.label("host-blocked-checkout", cx),
        fact(copy::CHECKOUT_LABEL, &checkout.display().to_string())
    );
    assert_eq!(
        harness.label("host-blocked-commands", cx),
        copy::pin_commands(&checkout, MAKA_PIN_COMMIT)
    );

    // Retried against a Host that is newer and stays: the screen says so.
    let newer = RUNTIME_HOST_COMPATIBILITY_EPOCH + 1;
    harness.block(
        HostBlocker::Epoch(EpochMismatch::new(
            newer,
            Some(ReplacementDisposition::BlockedByResidency),
        )),
        cx,
    );
    assert_eq!(harness.label("host-blocked-title", cx), copy::HOST_NEWER_TITLE.en());
    assert_eq!(
        harness.label("host-blocked-host-epoch", cx),
        fact(copy::HOST_LABEL, &copy::epoch_value(EN, newer))
    );
    assert_eq!(harness.label("host-blocked-steps", cx), copy::update_client_steps(EN, newer));
    assert_eq!(harness.label("host-blocked-note", cx), copy::HOST_KEEPS_RUNNING.en());

    // A Host of this client's epoch: the task view comes back.
    harness.feed(ConnectionEvent::HostStarting { attempt: 1, pid: 42 }, cx);
    harness.feed(ConnectionEvent::Connected { accepted: accepted() }, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("host-blocked").is_none());
        assert!(window.find("empty-state").visible());
        assert!(window.find("send-message").visible());
    });
}

#[gpui_kit::test]
fn a_missing_or_unbuilt_checkout_shows_where_it_looked_and_how_to_build_it(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let path = Path::new("/nowhere/code/maka-pin");
    harness.block(HostBlocker::Checkout(MissingCheckout::new(path, false, false)), cx);
    assert_eq!(harness.label("host-blocked-title", cx), copy::CHECKOUT_MISSING_TITLE.en());
    assert_eq!(
        harness.label("host-blocked-checkout", cx),
        fact(copy::CHECKOUT_LABEL, "/nowhere/code/maka-pin")
    );
    assert_eq!(harness.label("host-blocked-steps", cx), copy::checkout_steps(EN, path, false));
    assert_eq!(
        harness.label("host-blocked-commands", cx),
        copy::clone_commands(path, MAKA_PIN_COMMIT)
    );
    harness.with_window(cx, |window, _| assert!(window.try_find("host-blocked-note").is_none()));

    harness.block(HostBlocker::Checkout(MissingCheckout::new(path, true, true)), cx);
    assert_eq!(harness.label("host-blocked-title", cx), copy::CHECKOUT_UNBUILT_TITLE.en());
    assert_eq!(harness.label("host-blocked-steps", cx), copy::checkout_steps(EN, path, true));
    let commands = harness.label("host-blocked-commands", cx);
    assert_eq!(commands, copy::build_commands(path));
    assert!(commands.contains("npm --workspace maka-agent run build:workspace-deps"));

    // Switch data folder… opens the data folder dialog from here too.
    harness.with_window(cx, |window, cx| window.click("host-blocked-switch-data-folder", cx));
    harness.with_window(cx, |window, _| assert!(window.find("state-root-picker").visible()));
}

#[gpui_kit::test]
fn other_suspensions_keep_the_strip(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let reason: Arc<str> = "the Runtime Host serves composition maka.headless".into();
    harness.feed(ConnectionEvent::AttemptFailed { attempt: 1, reason: reason.clone() }, cx);
    harness.feed(ConnectionEvent::Suspended { reason, blocker: None }, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("host-blocked").is_none());
        assert!(window.find("host-disconnected").visible());
        assert!(window.find("empty-state").visible());
    });
}
