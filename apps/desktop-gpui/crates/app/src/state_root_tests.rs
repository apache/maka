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

//! UI integration tests for choosing the State Root: the first-launch
//! dialog over the startup view, and Host > Switch Data Folder… over a
//! Workbench. The choice goes to an in-memory store and Workbenches get a
//! Host session that is never connected, so nothing touches the disk or
//! starts a Host.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Action as _, App, AppContext as _, Entity, TestAppContext, WindowHandle, px, size};
use serde_json::Value;
use shared::copy;
use workspace::actions::SwitchStateRoot;
use workspace::{
    HostRequestError, HostSession, HostTransport, StateRootStore, UnavailableProjectCatalog,
};

use crate::{
    BuildWorkbench, StartupView, StateRootSetup, Workbench, open_state_root_dialog, show_workbench,
};

const PROPOSAL: &str = "/data/maka-gpui/state-root";
const DESKTOP: &str = "/data/Maka";

/// Answers nothing: the tests look at the shell, not at Host data.
struct Offline;

impl HostTransport for Offline {
    fn request(
        &self,
        _: &'static str,
        _: Value,
        _: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        Box::pin(async { Err(HostRequestError::NotConnected) })
    }
}

/// Remembers in memory, or fails when told to.
#[derive(Default)]
struct MemoryStore {
    remembered: RefCell<Vec<PathBuf>>,
    fail: Cell<bool>,
}

impl StateRootStore for MemoryStore {
    fn load(&self) -> Boxed<std::io::Result<Option<PathBuf>>> {
        let last = self.remembered.borrow().last().cloned();
        Box::pin(async move { Ok(last) })
    }

    fn remember(&self, root: PathBuf) -> Boxed<std::io::Result<()>> {
        if self.fail.get() {
            return Box::pin(async { Err(std::io::Error::other("disk full")) });
        }
        self.remembered.borrow_mut().push(root);
        Box::pin(async { Ok(()) })
    }
}

struct Shell {
    window: WindowHandle<Root>,
    store: Rc<MemoryStore>,
    built: Rc<RefCell<Vec<PathBuf>>>,
    setup: StateRootSetup,
}

impl Shell {
    fn open(cx: &mut TestAppContext) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            // The dialog slides in on the wall clock; with motion reduced
            // it settles on its first frame, so a click cannot land on a
            // surface that is still moving.
            cx.set_reduce_motion(true);
        });
        let store = Rc::new(MemoryStore::default());
        let built = Rc::new(RefCell::new(Vec::new()));
        let build: Rc<BuildWorkbench> = Rc::new({
            let built = built.clone();
            move |root, _, window, cx| {
                built.borrow_mut().push(root.clone());
                let host = cx.new(|_| HostSession::with_transport(root, Arc::new(Offline)));
                cx.new(|cx| Workbench::new(host, Rc::new(UnavailableProjectCatalog), window, cx))
            }
        });
        let setup = StateRootSetup::new(
            store.clone(),
            PathBuf::from(PROPOSAL),
            Some(PathBuf::from(DESKTOP)),
            build,
        );
        let window = cx.open_window(size(px(1200.), px(700.)), |window, cx| {
            let startup = cx.new(|_| StartupView);
            Root::new(startup, window, cx)
        });
        Self { window, store, built, setup }
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

    /// The Workbench the window shows, if it shows one.
    fn workbench(&self, cx: &mut TestAppContext) -> Option<Entity<Workbench>> {
        cx.update_window(self.window.into(), |view, _, cx| {
            let root = view.downcast::<Root>().ok()?;
            root.read(cx).view().clone().downcast::<Workbench>().ok()
        })
        .expect("window")
    }

    fn root_of_workbench(&self, cx: &mut TestAppContext) -> Option<PathBuf> {
        let workbench = self.workbench(cx)?;
        Some(workbench.read_with(cx, |workbench, cx| workbench.host().read(cx).root().to_owned()))
    }

    fn remembered(&self) -> Vec<PathBuf> {
        self.store.remembered.borrow().clone()
    }

    fn built(&self) -> Vec<PathBuf> {
        self.built.borrow().clone()
    }

    fn choose(&self, folder: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| window.click("state-root-choose", cx));
        assert!(cx.did_prompt_for_paths());
        let folder = PathBuf::from(folder);
        cx.simulate_path_prompt_response(move |options| {
            assert!(options.directories && !options.files && !options.multiple);
            Some(vec![folder])
        });
        cx.run_until_parked();
    }
}

fn path_label(path: &str) -> String {
    format!("{}: {path}", copy::STATE_ROOT_FOLDER.en())
}

#[gpui_kit::test]
fn the_first_launch_proposes_a_folder_and_cannot_be_dismissed(cx: &mut TestAppContext) {
    let shell = Shell::open(cx);
    shell.with_window(cx, |window, cx| {
        open_state_root_dialog(shell.setup.clone(), None, window, cx);
    });
    shell.with_window(cx, |window, cx| {
        assert!(window.find("state-root-picker").visible());
        assert_eq!(window.find("state-root-path").label(), Some(path_label(PROPOSAL).as_str()));
        assert!(window.try_find("state-root-cancel").is_none(), "nothing to go back to");
        window.press("escape", cx);
    });
    shell.with_window(cx, |window, _| {
        assert!(window.find("state-root-picker").visible(), "Escape does not dismiss it");
    });
    assert!(shell.workbench(cx).is_none());

    // Enter continues with the proposal.
    shell.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(shell.remembered(), [PathBuf::from(PROPOSAL)]);
    assert_eq!(shell.built(), [PathBuf::from(PROPOSAL)]);
    assert_eq!(shell.root_of_workbench(cx), Some(PathBuf::from(PROPOSAL)));
    shell.with_window(cx, |window, _| {
        assert!(window.try_find("state-root-picker").is_none());
        assert!(window.find("host-status").visible(), "the Workbench replaced the startup view");
    });
}

#[gpui_kit::test]
fn maka_desktops_data_is_refused_and_another_folder_is_taken(cx: &mut TestAppContext) {
    let shell = Shell::open(cx);
    shell.with_window(cx, |window, cx| {
        open_state_root_dialog(shell.setup.clone(), None, window, cx);
    });
    shell.choose("/data/Maka/workspaces/default", cx);
    shell.with_window(cx, |window, cx| window.click("state-root-continue", cx));
    shell.with_window(cx, |window, _| {
        assert_eq!(
            window.find("state-root-error").label(),
            Some(copy::STATE_ROOT_DESKTOP_REFUSED.en())
        );
        assert!(window.find("state-root-picker").visible());
    });
    assert!(shell.remembered().is_empty());
    assert!(shell.built().is_empty());

    shell.choose("/work/maka-data", cx);
    shell.with_window(cx, |window, cx| {
        assert!(window.try_find("state-root-error").is_none(), "a new folder clears the error");
        assert_eq!(
            window.find("state-root-path").label(),
            Some(path_label("/work/maka-data").as_str())
        );
        window.click("state-root-continue", cx);
    });
    assert_eq!(shell.remembered(), [PathBuf::from("/work/maka-data")]);
    assert_eq!(shell.root_of_workbench(cx), Some(PathBuf::from("/work/maka-data")));
}

#[gpui_kit::test]
fn a_choice_that_cannot_be_remembered_keeps_the_dialog_open(cx: &mut TestAppContext) {
    let shell = Shell::open(cx);
    shell.store.fail.set(true);
    shell.with_window(cx, |window, cx| {
        open_state_root_dialog(shell.setup.clone(), None, window, cx);
    });
    shell.with_window(cx, |window, cx| window.click("state-root-continue", cx));
    shell.with_window(cx, |window, _| {
        let error = window.find("state-root-error");
        let label = error.label().expect("error text");
        assert!(label.starts_with(copy::STATE_ROOT_SAVE_FAILED.en()), "{label}");
        assert!(label.ends_with("Disk full."), "{label}");
    });
    assert!(shell.built().is_empty());
    assert!(shell.workbench(cx).is_none());
}

#[gpui_kit::test]
fn switching_starts_from_the_root_in_use_and_can_be_cancelled(cx: &mut TestAppContext) {
    let shell = Shell::open(cx);
    shell.with_window(cx, |window, cx| {
        show_workbench(&shell.setup, PathBuf::from("/tmp/.dev-root"), window, cx);
    });
    let open_switch = |cx: &mut TestAppContext| {
        shell.with_window(cx, |window, cx| {
            window.dispatch_action(SwitchStateRoot.boxed_clone(), cx)
        });
    };

    open_switch(cx);
    shell.with_window(cx, |window, cx| {
        assert_eq!(
            window.find("state-root-path").label(),
            Some(path_label("/tmp/.dev-root").as_str())
        );
        window.click("state-root-cancel", cx);
    });
    shell.with_window(cx, |window, _| assert!(window.try_find("state-root-picker").is_none()));

    open_switch(cx);
    shell.with_window(cx, |window, cx| window.press("escape", cx));
    shell.with_window(cx, |window, _| assert!(window.try_find("state-root-picker").is_none()));

    // Continuing with the root in use changes nothing.
    open_switch(cx);
    shell.with_window(cx, |window, cx| window.click("state-root-continue", cx));
    shell.with_window(cx, |window, _| assert!(window.try_find("state-root-picker").is_none()));
    assert!(shell.remembered().is_empty());
    assert_eq!(shell.built(), [PathBuf::from("/tmp/.dev-root")]);

    open_switch(cx);
    shell.choose("/work/other-root", cx);
    shell.with_window(cx, |window, cx| window.click("state-root-continue", cx));
    assert_eq!(shell.remembered(), [PathBuf::from("/work/other-root")]);
    assert_eq!(shell.root_of_workbench(cx), Some(PathBuf::from("/work/other-root")));
    let label =
        shell.with_window(cx, |window, _| window.find("sidebar-footer").label().map(str::to_owned));
    assert_eq!(label.as_deref().map(|label| label.ends_with("data folder other-root")), Some(true));
}
