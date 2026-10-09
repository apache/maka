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

//! Switching the window's Runtime Host: the workbench is built again for
//! the chosen Host, whose catalog is then read, from the settings surface
//! (on the same section) and from the footer menu's Host items. The Host
//! list is a scratch profile store; Workbenches get scripted transports.
#![allow(clippy::disallowed_methods)]

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_lite::future::{Boxed, block_on};
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Action as _, App, AppContext as _, Entity, TestAppContext, WindowHandle, px, size};
use host_client::{ConnectionEvent, HostEvent, RemoteHostProfile, RemoteProfileStore};
use host_protocol::{AccessCredential, HostAccepted, RemoteTransport};
use serde_json::{Value, json};
use settings::SettingsSection;
use workspace::actions::SwitchHost;
use workspace::{
    HostDirectory, HostPairing, HostRefusal, HostRequestError, HostSession, HostTransport,
    StateRootStore, UnavailableProjectCatalog, WindowHost,
};

use crate::{BuildWorkbench, StartupView, StateRootSetup, Workbench, show_workbench};

const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

/// Records what each Host was asked; answers the session list with an
/// empty page and nothing else.
#[derive(Default)]
struct Recorded(Mutex<Vec<String>>);

impl HostTransport for Recorded {
    fn request(
        &self,
        operation: &'static str,
        _: Value,
        _: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        self.0.lock().expect("requests").push(operation.to_owned());
        let reply = match operation {
            "session.catalog.query" => Ok(json!({
                "kind": "page", "revision": format!("sha256:{}", "0".repeat(64)),
                "sessions": [], "nextCursor": null
            })),
            _ => Err(HostRequestError::NotConnected),
        };
        Box::pin(async move { reply })
    }
}

/// Pairs nothing: the Hosts are saved already.
struct NoPairing;

impl HostPairing for NoPairing {
    fn probe(&self, _: RemoteHostProfile, _: AccessCredential) -> Boxed<Result<(), HostRefusal>> {
        Box::pin(async { Ok(()) })
    }

    fn pair(&self, _: RemoteHostProfile, _: AccessCredential) -> Boxed<Result<(), HostRefusal>> {
        Box::pin(async { Ok(()) })
    }
}

struct NoStore;

impl StateRootStore for NoStore {
    fn load(&self) -> Boxed<std::io::Result<Option<PathBuf>>> {
        Box::pin(async { Ok(None) })
    }

    fn remember(&self, _: PathBuf) -> Boxed<std::io::Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

fn accepted() -> HostAccepted {
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": ROOT_ID, "hostEpoch": "e", "connectionId": "c",
        "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
        "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

struct Shell {
    window: WindowHandle<Root>,
    setup: StateRootSetup,
    /// Each Workbench built: the Host it is for, and what it was asked.
    built: Rc<RefCell<Vec<(String, Arc<Recorded>)>>>,
    scratch: PathBuf,
}

impl Drop for Shell {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.scratch).ok();
    }
}

impl Shell {
    /// A window whose Host list saves `build` (Build box, enabled).
    fn open(cx: &mut TestAppContext) -> Self {
        cx.executor().allow_parking();
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            cx.set_reduce_motion(true);
        });
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let scratch =
            std::env::temp_dir().join(format!("app-host-switch-{}-{nanos}", std::process::id()));
        let store = RemoteProfileStore::new(scratch.join("config"));
        let transport = RemoteTransport::tls("wss://build.example.com/runtime-host").expect("tls");
        let profile =
            RemoteHostProfile::new("build", "Build box", ROOT_ID, transport).expect("profile");
        let credential = AccessCredential::new("mrha_build").expect("credential");
        block_on(store.create(&profile, &credential)).expect("saved");
        block_on(store.set_enabled("build", true)).expect("enabled");
        let directory = cx.new(|cx| HostDirectory::new(store, Arc::new(NoPairing), cx));
        cx.update(|cx| HostDirectory::install(directory.clone(), cx));
        let built = Rc::new(RefCell::new(Vec::new()));
        let build: Rc<BuildWorkbench> = Rc::new({
            let built = built.clone();
            move |root, host: WindowHost, window, cx| {
                let transport = Arc::new(Recorded::default());
                built.borrow_mut().push((host.profile_id().to_owned(), transport.clone()));
                let session =
                    cx.new(|_| HostSession::with_transport(root, transport.clone()).for_host(host));
                let workbench = cx.new(|cx| {
                    Workbench::new(session.clone(), Rc::new(UnavailableProjectCatalog), window, cx)
                });
                session.update(cx, |session, cx| {
                    session.handle_host_event(
                        HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                        cx,
                    )
                });
                workbench
            }
        });
        let setup = StateRootSetup::new(Rc::new(NoStore), PathBuf::from("/tmp/p"), None, build);
        let window = cx.open_window(size(px(1512.), px(885.)), |window, cx| {
            Root::new(cx.new(|_| StartupView), window, cx)
        });
        let shell = Self { window, setup, built, scratch };
        shell.with_window(cx, |window, cx| {
            show_workbench(&shell.setup, PathBuf::from("/tmp/.dev-root"), window, cx);
        });
        shell.settle(&directory, cx);
        shell
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

    fn workbench(&self, cx: &mut TestAppContext) -> Entity<Workbench> {
        cx.update_window(self.window.into(), |view, _, cx| {
            let root = view.downcast::<Root>().ok()?;
            root.read(cx).view().clone().downcast::<Workbench>().ok()
        })
        .expect("window")
        .expect("a workbench")
    }

    /// Lets background work (the profile store's files) and the switch it
    /// leads to finish.
    fn settle(&self, directory: &Entity<HostDirectory>, cx: &mut TestAppContext) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if directory.read_with(cx, |directory, _| directory.list().is_some())
                || Instant::now() > deadline
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        for _ in 0..20 {
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(5));
        }
        cx.run_until_parked();
    }

    fn hosts_built(&self) -> Vec<String> {
        self.built.borrow().iter().map(|(host, _)| host.clone()).collect()
    }

    fn directory(cx: &mut TestAppContext) -> Entity<HostDirectory> {
        cx.update(|cx| HostDirectory::global(cx)).expect("installed")
    }
}

#[gpui_kit::test]
fn switching_from_settings_rebuilds_the_window_for_the_host_on_the_same_section(
    cx: &mut TestAppContext,
) {
    let shell = Shell::open(cx);
    let directory = Shell::directory(cx);
    assert_eq!(shell.hosts_built(), ["local"]);
    let first = shell.workbench(cx);
    shell.with_window(cx, |window, cx| {
        first.update(cx, |workbench, cx| {
            workbench.show_settings(SettingsSection::Models, |_, _, _| {}, window, cx)
        })
    });
    first.update_in_window(&shell, cx, |workbench, window, cx| {
        workbench.switch_host("build".into(), window, cx)
    });
    shell.settle(&directory, cx);

    assert_eq!(shell.hosts_built(), ["local", "build"]);
    let second = shell.workbench(cx);
    assert_ne!(first, second, "a new workbench");
    second.read_with(cx, |workbench, cx| {
        let host = workbench.host().read(cx);
        assert!(host.is_remote());
        assert_eq!(host.remote_name().as_deref(), Some("Build box"));
        assert_eq!(host.root(), std::path::Path::new("/tmp/.dev-root"), "the State Root stays");
        assert_eq!(
            workbench.settings_view().map(|view| view.read(cx).section()),
            Some(SettingsSection::Models)
        );
    });
    // The new Host's sessions were read.
    let requests = shell.built.borrow()[1].1.0.lock().expect("requests").clone();
    assert!(requests.iter().any(|op| op == "session.catalog.query"), "{requests:?}");
    // Switching to the Host in use does nothing.
    second.update_in_window(&shell, cx, |workbench, window, cx| {
        workbench.switch_host("build".into(), window, cx)
    });
    shell.settle(&directory, cx);
    assert_eq!(shell.hosts_built(), ["local", "build"]);
}

#[gpui_kit::test]
fn the_footer_menus_host_items_switch_back_to_the_local_host(cx: &mut TestAppContext) {
    let shell = Shell::open(cx);
    let directory = Shell::directory(cx);
    shell.with_window(cx, |window, cx| {
        window.dispatch_action(SwitchHost::new("build").boxed_clone(), cx)
    });
    shell.settle(&directory, cx);
    assert_eq!(shell.hosts_built(), ["local", "build"]);
    // The footer names the Host and where it is.
    shell.with_window(cx, |window, _| {
        let footer = window.find("sidebar-footer").label().expect("label").to_owned();
        assert_eq!(footer, "Build box, remote Host, Connected, build.example.com");
    });
    shell.with_window(cx, |window, cx| {
        window.dispatch_action(SwitchHost::new("local").boxed_clone(), cx)
    });
    shell.settle(&directory, cx);
    assert_eq!(shell.hosts_built(), ["local", "build", "local"]);
    shell.workbench(cx).read_with(cx, |workbench, cx| {
        assert!(!workbench.host().read(cx).is_remote());
    });
}

/// `Entity::update` inside the shell's window.
trait UpdateInWindow {
    fn update_in_window(
        &self,
        shell: &Shell,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Workbench, &mut gpui_kit::Window, &mut gpui_kit::Context<Workbench>),
    );
}

impl UpdateInWindow for Entity<Workbench> {
    fn update_in_window(
        &self,
        shell: &Shell,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Workbench, &mut gpui_kit::Window, &mut gpui_kit::Context<Workbench>),
    ) {
        let workbench = self.clone();
        shell.with_window(cx, move |window, cx| {
            workbench.update(cx, |workbench, cx| f(workbench, window, cx))
        });
    }
}
