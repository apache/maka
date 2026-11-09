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

//! The disposable workbench window and the process-owned Host connection.

//! Native SNI tray. A successful registration, not just a D-Bus connection,
//! admits hiding the last window. Failed/lost watchers leave the UI reachable.

use crate::shell::{APP_ID, TITLE};
use ksni::TrayMethods as _;
use std::time::Duration;
use tokio::{
    runtime::Handle,
    sync::{mpsc, watch},
    task::JoinHandle,
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Open,
    Quit,
    Unavailable,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Registration {
    #[default]
    Starting,
    Ready,
    Offline,
}

impl Registration {
    fn registered(&mut self) -> bool {
        if *self == Self::Starting {
            *self = Self::Ready;
            true
        } else {
            false
        }
    }
}

pub(crate) struct Tray {
    registration: watch::Receiver<Registration>,
    task: JoinHandle<()>,
}

impl Tray {
    pub(crate) fn start(runtime: Handle, events: mpsc::UnboundedSender<Event>) -> Self {
        let (state, registration) = watch::channel(Registration::Starting);
        let icon = runtime.spawn_blocking(icon);
        let task = runtime.spawn(async move {
            let icon = icon.await.expect("the icon decoder completes");
            let mut reported = false;
            loop {
                state.send_replace(Registration::Starting);
                let item = Item {
                    events: events.clone(),
                    registration: state.clone(),
                    icon: icon.clone(),
                };
                match item.spawn().await {
                    Ok(handle) => {
                        let service = Service(handle);
                        reported = false;
                        // Offline can arrive while spawn is still returning.
                        // Never overwrite that loss with stale readiness.
                        state.send_if_modified(Registration::registered);
                        while !service.0.is_closed() {
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                        state.send_replace(Registration::Offline);
                        if events.send(Event::Unavailable).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        state.send_replace(Registration::Offline);
                        if !reported {
                            eprintln!("maka-desktop-shell: tray unavailable: {error}");
                            reported = true;
                        }
                    }
                }
                if events.is_closed() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
        Self { registration, task }
    }

    pub(crate) fn ready(&self) -> bool {
        *self.registration.borrow() == Registration::Ready
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Service(ksni::Handle<Item>);

impl Drop for Service {
    fn drop(&mut self) {
        // shutdown enqueues immediately; no async work runs in this Drop.
        drop(self.0.shutdown());
    }
}

struct Item {
    events: mpsc::UnboundedSender<Event>,
    registration: watch::Sender<Registration>,
    icon: ksni::Icon,
}

impl ksni::Tray for Item {
    fn id(&self) -> String {
        APP_ID.into()
    }
    fn title(&self) -> String {
        TITLE.into()
    }
    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![self.icon.clone()]
    }
    fn activate(&mut self, _: i32, _: i32) {
        let _ = self.events.send(Event::Open);
    }
    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        vec![
            StandardItem {
                label: format!("Open {TITLE}"),
                activate: Box::new(|item: &mut Self| {
                    let _ = item.events.send(Event::Open);
                }),
                ..Default::default()
            }
            .into(),
            ksni::MenuItem::Separator,
            StandardItem {
                label: "Quit".into(),
                activate: Box::new(|item: &mut Self| {
                    let _ = item.events.send(Event::Quit);
                }),
                ..Default::default()
            }
            .into(),
        ]
    }

    fn watcher_offline(&self, reason: ksni::OfflineReason) -> bool {
        self.registration.send_replace(Registration::Offline);
        eprintln!("maka-desktop-shell: tray watcher lost: {reason:?}");
        let _ = self.events.send(Event::Unavailable);
        // Recreate and verify registration instead of trusting watcher_online:
        // ksni emits it before the replacement watcher accepts our item.
        false
    }
}

fn icon() -> ksni::Icon {
    let image = image::load_from_memory(include_bytes!("../../workbench/app/assets/maka.png"))
        .expect("the bundled Maka icon is a PNG")
        .resize_exact(48, 48, image::imageops::FilterType::Lanczos3)
        .into_rgba8();
    let mut argb = image.into_raw();
    for pixel in argb.chunks_exact_mut(4) {
        pixel.rotate_right(1);
    }
    ksni::Icon {
        width: 48,
        height: 48,
        data: argb,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ksni::Tray as _;
    use std::{collections::HashMap, process::Command};
    use zbus::{Connection, Proxy, zvariant::OwnedValue};

    #[test]
    fn loss_during_registration_cannot_hide_the_application() {
        let (registration, state) = watch::channel(Registration::Starting);
        let (events, mut received) = mpsc::unbounded_channel();
        let item = Item {
            registration: registration.clone(),
            events,
            icon: icon(),
        };
        assert!(!item.watcher_offline(ksni::OfflineReason::No));
        registration.send_if_modified(Registration::registered);
        assert!(*state.borrow() == Registration::Offline);
        assert_eq!(received.try_recv(), Ok(Event::Unavailable));
    }

    #[test]
    fn sni_registration_watcher_recovery_and_actions() {
        const CHILD: &str = "MAKA_TRAY_TEST_PRIVATE_BUS";
        if std::env::var_os(CHILD).is_none() {
            let status = Command::new("dbus-run-session")
                .arg("--")
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tray_linux::tests::sni_registration_watcher_recovery_and_actions",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .status()
                .expect("the Linux tray test requires dbus-run-session");
            assert!(status.success(), "isolated SNI test failed: {status}");
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            tokio::time::timeout(Duration::from_secs(30), exercise_bus())
                .await
                .expect("SNI registration or recovery did not settle");
        });
    }

    struct Watcher(mpsc::UnboundedSender<String>);

    #[zbus::interface(name = "org.kde.StatusNotifierWatcher")]
    impl Watcher {
        fn register_status_notifier_item(&self, service: String) {
            self.0.send(service).unwrap();
        }

        #[zbus(property)]
        fn is_status_notifier_host_registered(&self) -> bool {
            true
        }
    }

    async fn watcher(registered: mpsc::UnboundedSender<String>) -> Connection {
        zbus::connection::Builder::session()
            .unwrap()
            .name("org.kde.StatusNotifierWatcher")
            .unwrap()
            .serve_at("/StatusNotifierWatcher", Watcher(registered))
            .unwrap()
            .build()
            .await
            .unwrap()
    }

    async fn state(tray: &Tray, expected: Registration) {
        let mut state = tray.registration.clone();
        let _ = state.wait_for(|state| *state == expected).await.unwrap();
    }

    type Layout = (i32, HashMap<String, OwnedValue>, Vec<OwnedValue>);

    async fn menu_action(connection: &Connection, service: &str, label: &str) {
        let menu = Proxy::new(connection, service, "/MenuBar", "com.canonical.dbusmenu")
            .await
            .unwrap();
        let (_, layout): (u32, Layout) = menu
            .call("GetLayout", &(0i32, 1i32, Vec::<String>::new()))
            .await
            .unwrap();
        let item = layout
            .2
            .into_iter()
            .map(|item| Layout::try_from(item).unwrap())
            .find(|item| {
                item.1.get("label").is_some_and(|value| {
                    String::try_from(value.try_clone().unwrap()).unwrap() == label
                })
            })
            .expect("tray menu action is present");
        let _: () = menu
            .call("Event", &(item.0, "clicked", OwnedValue::from(0i32), 0u32))
            .await
            .unwrap();
    }

    async fn exercise_bus() {
        let (events, mut received) = mpsc::unbounded_channel();
        let tray = Tray::start(Handle::current(), events);
        state(&tray, Registration::Offline).await;
        assert!(
            !tray.ready(),
            "a missing watcher must not strand a hidden app"
        );

        let (registered, mut items) = mpsc::unbounded_channel();
        let first = watcher(registered.clone()).await;
        let service = items.recv().await.unwrap();
        state(&tray, Registration::Ready).await;
        let item = Proxy::new(
            &first,
            service.as_str(),
            "/StatusNotifierItem",
            "org.kde.StatusNotifierItem",
        )
        .await
        .unwrap();
        let _: () = item.call("Activate", &(0i32, 0i32)).await.unwrap();
        assert_eq!(received.recv().await, Some(Event::Open));
        drop(item);

        first.close().await.unwrap();
        assert_eq!(received.recv().await, Some(Event::Unavailable));
        assert!(!tray.ready(), "watcher loss must prevent another hide");
        let second = watcher(registered).await;
        let service = items.recv().await.unwrap();
        state(&tray, Registration::Ready).await;
        // Drain the final offline event from the retired service, if present.
        while received.try_recv().is_ok() {}
        menu_action(&second, &service, "Open Maka").await;
        assert_eq!(received.recv().await, Some(Event::Open));
        menu_action(&second, &service, "Quit").await;
        assert_eq!(received.recv().await, Some(Event::Quit));
        drop(tray);
        second.close().await.unwrap();
    }
}
