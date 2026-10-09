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

//! Keep system awake (保持系统唤醒), the Scheduled tasks page's client
//! setting: while it is on, the machine does not go to idle sleep, so the
//! Host's timers keep running and tasks fire on time. Desktop holds
//! Electron's `powerSaveBlocker` with `prevent-app-suspension`
//! (apps/desktop/src/main/keep-system-awake.ts), which lets the display
//! sleep; this client holds `caffeinate -i -w <pid>` on macOS, the same
//! assertion (idle system sleep only), which also ends by itself when the
//! app does. Other platforms do not offer the setting.
//!
//! The setting is this client's, saved in its config directory
//! (`scheduled-tasks.json`), and applies from launch.

use std::any::Any;
use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::{App, AppContext as _, Context, Entity, Global, Task};
use serde::{Deserialize, Serialize};
use workspace::{client_config_file, read_config_file, write_config_file};

/// The settings file, beside the client's other config files.
const SETTINGS_FILE: &str = "scheduled-tasks.json";
const SETTINGS_MAX_BYTES: u64 = 4 * 1024;

/// What holds the machine awake while it lives; dropping it lets go.
pub type AwakeHold = Box<dyn Any>;

/// Starts a hold, `None` when it could not.
pub type AwakeBlocker = Rc<dyn Fn() -> Option<AwakeHold>>;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    keep_system_awake: bool,
}

/// Behavior owner of the setting for the whole app: the value last saved
/// (or being saved), and the hold while it is on.
pub struct KeepSystemAwake {
    enabled: bool,
    /// A save in flight: the switch waits for it.
    saving: bool,
    store: Option<PathBuf>,
    blocker: Option<AwakeBlocker>,
    hold: Option<AwakeHold>,
    _io: Option<Task<()>>,
}

impl std::fmt::Debug for KeepSystemAwake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeepSystemAwake")
            .field("enabled", &self.enabled)
            .field("held", &self.hold.is_some())
            .finish_non_exhaustive()
    }
}

struct GlobalKeepAwake(Entity<KeepSystemAwake>);

impl Global for GlobalKeepAwake {}

impl KeepSystemAwake {
    /// Creates the app's setting, saved in the client's config directory,
    /// and applies what was saved (Desktop applies it at launch). Call once
    /// at startup.
    pub fn init_global(cx: &mut App) -> Entity<Self> {
        if let Some(global) = Self::try_global(cx) {
            return global;
        }
        let entity = cx.new(|cx| Self::new(client_config_file(SETTINGS_FILE), caffeinate(), cx));
        cx.set_global(GlobalKeepAwake(entity.clone()));
        entity
    }

    /// The app's setting, when the app made one (previews and tests do
    /// not offer it).
    pub fn try_global(cx: &App) -> Option<Entity<Self>> {
        cx.try_global::<GlobalKeepAwake>().map(|global| global.0.clone())
    }

    /// Makes `entity` the app's setting (tests hold with a stand-in, and
    /// remember nothing).
    pub fn install(entity: Entity<Self>, cx: &mut App) {
        cx.set_global(GlobalKeepAwake(entity));
    }

    /// The setting saved at `store` (none: not remembered), holding with
    /// `blocker` (none: not offered on this platform).
    pub fn new(
        store: Option<PathBuf>,
        blocker: Option<AwakeBlocker>,
        cx: &mut Context<Self>,
    ) -> Self {
        let load = store.clone().filter(|_| blocker.is_some()).map(|path| {
            cx.spawn(async move |this, cx| {
                let settings = match read_config_file(&path, SETTINGS_MAX_BYTES).await {
                    Ok(Some(bytes)) => {
                        serde_json::from_slice::<Settings>(&bytes).unwrap_or_default()
                    }
                    Ok(None) => Settings::default(),
                    Err(error) => {
                        log::warn!("could not read {}: {error}", path.display());
                        Settings::default()
                    }
                };
                this.update(cx, |this, cx| {
                    if !this.saving {
                        this.apply(settings.keep_system_awake);
                        cx.notify();
                    }
                })
                .ok();
            })
        });
        Self { enabled: false, saving: false, store, blocker, hold: None, _io: load }
    }

    /// Whether this platform offers the setting.
    pub fn is_supported(&self) -> bool {
        self.blocker.is_some()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Whether the machine is held awake now.
    pub fn is_holding(&self) -> bool {
        self.hold.is_some()
    }

    pub fn is_saving(&self) -> bool {
        self.saving
    }

    /// Turns the setting on or off at once and saves it; a failed save
    /// puts the old value back, and the task says so.
    pub fn set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) -> Task<Result<(), ()>> {
        if self.saving || !self.is_supported() {
            return Task::ready(Err(()));
        }
        let previous = self.enabled;
        self.apply(enabled);
        cx.notify();
        let Some(path) = self.store.clone() else {
            return Task::ready(Ok(()));
        };
        self.saving = true;
        let contents = serde_json::to_vec_pretty(&Settings { keep_system_awake: enabled });
        cx.spawn(async move |this, cx| {
            let saved = match contents {
                Ok(contents) => write_config_file(path, contents).await,
                Err(error) => Err(std::io::Error::other(error)),
            };
            this.update(cx, |this, cx| {
                this.saving = false;
                let outcome = saved.map_err(|error| {
                    log::warn!("could not save Keep system awake: {error}");
                    this.apply(previous);
                });
                cx.notify();
                outcome
            })
            .unwrap_or(Err(()))
        })
    }

    /// Holds the machine awake while `enabled`, and lets go otherwise.
    fn apply(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.hold = None;
        } else if self.hold.is_none()
            && let Some(blocker) = &self.blocker
        {
            self.hold = blocker();
            if self.hold.is_none() {
                log::warn!("could not keep the system awake");
            }
        }
    }
}

/// `caffeinate -i -w <this process>` on macOS: no idle sleep while it
/// runs, and it exits when the app does; dropping the child kills it.
fn caffeinate() -> Option<AwakeBlocker> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    Some(Rc::new(|| {
        let pid = std::process::id().to_string();
        async_process::Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &pid])
            .stdin(async_process::Stdio::null())
            .stdout(async_process::Stdio::null())
            .stderr(async_process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| log::warn!("could not start caffeinate: {error}"))
            .ok()
            .map(|child| Box::new(child) as AwakeHold)
    }))
}
