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

//! The chat bots of a window's State Root, tied to its workbench.
//!
//! [`link_bots`] gives each workbench one [`BotService`], over the client's
//! `bot-chat.json`, for as long as the workbench lives (a switch to another
//! State Root builds a new workbench, and with it a new service; the old
//! one's sidecar stops when the service goes). The service learns its Host
//! once the window's first connection is ready (the State Root has its
//! marker by then, which the sidecar's launch checks): the local Host of
//! the State Root, or a remote one, which the bots refuse, as Desktop
//! refuses them for guest profiles. Bot Sessions are created where new
//! tasks go, the project the window has chosen (Desktop's
//! `currentDesktopWorkspaceTarget`). Settings reach the service through the
//! workbench ([`Workbench::set_bots`]).

use std::sync::Arc;

use bots::{BotHost, BotService, BotSettingsStore};
use gpui_kit::{App, AppContext as _, Entity, Subscription};
use workspace::{HostSession, ProjectSelection};

use crate::Workbench;

/// Keeps the service following the window; dropped with the workbench.
pub(crate) struct BotLink {
    _bots: Entity<BotService>,
    _subscriptions: [Subscription; 2],
}

/// Gives `workbench` its chat bots, over the settings file in the client's
/// config directory (none when there is no config directory).
pub fn link_bots(workbench: &Entity<Workbench>, cx: &mut App) {
    let store = match BotSettingsStore::in_config_directory() {
        Ok(store) => Arc::new(store),
        Err(error) => {
            log::warn!("no chat bots in this window: {error}");
            return;
        }
    };
    let bots = cx.new(|cx| BotService::new(store, cx));
    let (host, projects) = {
        let workbench = workbench.read(cx);
        (workbench.host().clone(), workbench.projects().clone())
    };
    let link = follow(bots.clone(), &host, &projects, cx);
    workbench.update(cx, |workbench, _| workbench.set_bots(bots));
    cx.observe_release(workbench, move |_, _| drop(link)).detach();
}

/// Tells `bots` the Host once `host` is connected, and the workspace
/// whenever `projects` changes its choice.
pub(crate) fn follow(
    bots: Entity<BotService>,
    host: &Entity<HostSession>,
    projects: &Entity<ProjectSelection>,
    cx: &mut App,
) -> BotLink {
    let tell_host = {
        let bots = bots.clone();
        move |host: Entity<HostSession>, cx: &mut App| {
            let session = host.read(cx);
            if !session.is_connected() {
                return;
            }
            let bot_host = if session.is_remote() {
                BotHost::Remote
            } else {
                BotHost::Local { state_root: session.root().to_owned() }
            };
            bots.update(cx, |bots, cx| bots.set_host(Some(bot_host), cx));
        }
    };
    let tell_workspace = {
        let bots = bots.clone();
        move |projects: Entity<ProjectSelection>, cx: &mut App| {
            let workspace = projects.read(cx).target().map(|target| target.workspace());
            bots.update(cx, |bots, cx| bots.set_workspace(workspace, cx));
        }
    };
    tell_host(host.clone(), cx);
    tell_workspace(projects.clone(), cx);
    let subscriptions = [cx.observe(host, tell_host), cx.observe(projects, tell_workspace)];
    BotLink { _bots: bots, _subscriptions: subscriptions }
}

#[cfg(test)]
// Test setup writes the settings file directly; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::time::Duration;

    use bots::testing::FakeSidecar;
    use bots::{BotProvider, BotSettingsStore};
    use futures_lite::future::{Boxed, block_on};
    use gpui_kit::TestAppContext;
    use host_client::{ConnectionEvent, HostEvent};
    use host_protocol::{HostAccepted, WorkspaceTarget};
    use serde_json::{Value, json};
    use workspace::{HostRequestError, HostSession, HostTransport, ProjectSelection};

    use super::*;

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

    fn accepted() -> HostAccepted {
        serde_json::from_value(json!({
            "kind": "accepted", "rootId": "r", "hostEpoch": "e", "connectionId": "c",
            "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
            "compositionRevision": "3", "state": "ready"
        }))
        .expect("accepted")
    }

    #[gpui_kit::test]
    fn the_bots_follow_the_windows_host_and_folder(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let scratch = std::env::temp_dir().join(format!("bot-link-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&scratch).expect("scratch");
        let store = Arc::new(BotSettingsStore::new(scratch.join("bot-chat.json")));
        block_on(store.update(|settings| {
            settings.channel_mut(BotProvider::Telegram).enabled = true;
        }))
        .expect("seeded");
        let fake = FakeSidecar::new();
        let launcher = fake.launcher();
        let bots = cx.new(|cx| BotService::new(store, cx).with_launcher(launcher));
        let root = PathBuf::from("/roots/demo");
        let host = cx.new(|_| HostSession::with_transport(root.clone(), Arc::new(Offline)));
        let projects = cx.new(|cx| {
            ProjectSelection::new(host.clone(), Rc::new(workspace::UnavailableProjectCatalog), cx)
        });
        let _link = cx.update(|cx| follow(bots.clone(), &host, &projects, cx));
        for _ in 0..50 {
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(fake.launches().is_empty(), "not before the Host answers");

        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                cx,
            )
        });
        for _ in 0..500 {
            cx.run_until_parked();
            if bots.read_with(cx, |bots, _| bots.is_running()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fake.launches(), [BotHost::Local { state_root: root }]);

        // New tasks go into the chosen folder, and so do bot Sessions.
        projects.update(cx, |projects, cx| projects.choose_folder("/work/demo", cx));
        cx.run_until_parked();
        assert_eq!(
            bots.read_with(cx, |bots, _| bots.workspace().cloned()),
            Some(WorkspaceTarget::HostPath { path: "/work/demo".into() })
        );
        for _ in 0..500 {
            cx.run_until_parked();
            if !fake.commands_named("set_workspace").is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fake.commands_named("set_workspace").last(),
            Some(&json!({"command": "set_workspace",
                         "workspace": {"kind": "host_path", "path": "/work/demo"}}))
        );
        std::fs::remove_dir_all(scratch).ok();
    }
}
