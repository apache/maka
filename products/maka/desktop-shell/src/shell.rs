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

//! The workbench-to-window command protocol.

use nsh_engine::{EngineConfig, HostCall, HostChannel, JsonValue};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

pub(crate) const APP_ID: &str = "org.apache.maka.desktop";
pub(crate) const TITLE: &str = "Maka";
/// The narrowest layout the workbench folds its sidebar for.
pub(crate) const MIN_SIZE: (f32, f32) = (640., 480.);

pub(crate) const SIZE: (i32, i32) = (1280, 820);

/// What the workbench asks of its window, for the window to carry out.
pub(crate) struct Requests {
    pub(crate) exits: tokio::sync::mpsc::UnboundedReceiver<()>,
    pub(crate) folders: tokio::sync::mpsc::UnboundedReceiver<HostCall>,
    pub(crate) text_sizes: tokio::sync::mpsc::UnboundedReceiver<f32>,
}

/// What the window gives each workbench it loads, beside its Host.
#[derive(Clone)]
pub(crate) struct Shell {
    /// Whether the window is active.
    foreground: watch::Receiver<bool>,
    /// Closes the window.
    exit: tokio::sync::mpsc::UnboundedSender<()>,
    /// Asks for a folder with the system's dialog.
    folder: tokio::sync::mpsc::UnboundedSender<HostCall>,
    text_size: tokio::sync::mpsc::UnboundedSender<f32>,
    /// The loaded workbench's host channel for shell events.
    pub(crate) events: Arc<Mutex<Option<HostChannel>>>,
    updater: Option<Arc<crate::updater::Controller>>,
}

impl Shell {
    pub(crate) fn new(foreground: watch::Receiver<bool>) -> (Self, Requests) {
        let (exit, exits) = tokio::sync::mpsc::unbounded_channel();
        let (folder, folders) = tokio::sync::mpsc::unbounded_channel();
        let (text_size, text_sizes) = tokio::sync::mpsc::unbounded_channel();
        let shell = Self {
            foreground,
            exit,
            folder,
            text_size,
            events: Arc::default(),
            updater: None,
        };
        let requests = Requests {
            exits,
            folders,
            text_sizes,
        };
        (shell, requests)
    }

    pub(crate) fn exit_sender(&self) -> tokio::sync::mpsc::UnboundedSender<()> {
        self.exit.clone()
    }

    pub(crate) fn with_updater(mut self, updater: Arc<crate::updater::Controller>) -> Self {
        self.updater = Some(updater);
        self
    }

    pub(crate) fn attach(&self, mut config: EngineConfig) -> EngineConfig {
        config.context = config
            .context
            .with(maka_workbench::Foreground(self.foreground.clone()));
        // The workbench's exit gesture (Ctrl+C twice) closes the window, as
        // it ends the terminal.
        let exit = self.exit.clone();
        config.host.handle("terminal.exit", move |_| {
            let _ = exit.send(());
        });
        let folder = self.folder.clone();
        config.host.handle("workspace.chooseFolder", move |call| {
            if let Err(error) = folder.send(call) {
                error.0.reject("the window is closing");
            }
        });
        let text_size = self.text_size.clone();
        config.host.handle(
            "appearance.textSize",
            move |call| match call.data()["scale"].as_f64().map(|scale| scale as f32) {
                Some(scale) if scale.is_finite() && scale > 0.0 => {
                    if text_size.send(scale).is_ok() {
                        call.resolve(JsonValue::Null);
                    } else {
                        call.reject("the window is closing");
                    }
                }
                _ => call.reject("expected a finite positive text scale"),
            },
        );
        #[cfg(target_os = "macos")]
        config
            .host
            .handle("screenshot.chooseFolder", crate::screenshot::choose_folder);
        #[cfg(target_os = "macos")]
        config.host.handle("quickLauncher.commandHeld", |call| {
            call.resolve(JsonValue::Bool(crate::appkit::command_only(
                objc2_app_kit::NSEvent::modifierFlags_class(),
            )));
        });
        if let Some(updater) = self.updater.clone() {
            let state_controller = Arc::clone(&updater);
            config.host.handle("updater.state", move |call| {
                call.resolve(state_controller.snapshot_json());
            });
            let check_controller = Arc::clone(&updater);
            config.host.handle("updater.check", move |call| {
                let controller = Arc::clone(&check_controller);
                check_controller.runtime().spawn(async move {
                    let snapshot = controller.check(true).await;
                    call.resolve(serde_json::to_value(snapshot).unwrap_or(JsonValue::Null));
                });
            });
            let download_controller = Arc::clone(&updater);
            config.host.handle("updater.download", move |call| {
                let controller = Arc::clone(&download_controller);
                download_controller.runtime().spawn(async move {
                    match controller.download().await {
                        Ok(snapshot) => {
                            call.resolve(serde_json::to_value(snapshot).unwrap_or(JsonValue::Null))
                        }
                        Err(error) => call.reject(error),
                    }
                });
            });
            let install_controller = Arc::clone(&updater);
            config
                .host
                .handle("updater.installAndRestart", move |call| {
                    let controller = Arc::clone(&install_controller);
                    install_controller.runtime().spawn(async move {
                        match controller.install_and_restart().await {
                            Ok(()) => call.resolve(JsonValue::Null),
                            Err(error) => call.reject(error),
                        }
                    });
                });
        }
        *self.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(config.host.clone());
        config
    }
}
