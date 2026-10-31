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

//! The workbench in a window of NSH's AppKit backend, on macOS, opted into
//! with [`ENABLE`]. It has one Host: the window does not follow a Host that
//! stops, and refuses a UI reload rather than pausing its input for one.

use crate::{
    host::{self, Connection},
    window::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use maka_workbench::reload::{Request, UiReload};
use nsh_engine::JsonValue;
use nsh_platform_macos::{AppOptions, quit_app, run_app_with_config, with_running_view};
use tokio::{runtime::Runtime, sync::watch};

/// Set and not empty, the shell opens this window instead of the GPUI one.
pub const ENABLE: &str = "MAKA_APPKIT";

pub fn run(first: Connection, runtime: Runtime) -> Result<(), String> {
    let Connection {
        bindings,
        config,
        directory,
        endpoint,
        epoch,
    } = first;
    let (active, foreground) = watch::channel(false);
    let (shell, requests) = Shell::new(foreground);
    let reloading = config
        .context
        .get::<UiReload>()
        .expect("the admitted workbench owns its UI reload channel")
        .take_requests();
    let config = shell.attach(config);
    carry_out(requests, &runtime);
    refuse_reloads(reloading, &runtime);
    let options = AppOptions {
        app_id: APP_ID.into(),
        title: TITLE.into(),
        size: SIZE,
        min_size: Some((MIN_SIZE.0 as i32, MIN_SIZE.1 as i32)),
        frame_autosave_name: Some(format!("{TITLE} {}", directory.display())),
        ..Default::default()
    };
    run_app_with_config(config, options, move |is_active| {
        active.send_replace(is_active);
    });
    runtime.block_on(host::detach(bindings, &endpoint, epoch));
    runtime.shutdown_background();
    Ok(())
}

fn carry_out(requests: Requests, runtime: &Runtime) {
    let Requests {
        mut exits,
        mut folders,
        mut text_sizes,
        mut notices,
    } = requests;
    runtime.spawn(async move {
        if exits.recv().await.is_some() {
            quit_app();
        }
    });
    runtime.spawn(async move {
        while let Some(call) = folders.recv().await {
            with_running_view(move |view| {
                view.choose_directory(move |path| match path {
                    Some(path) => match path.to_str() {
                        Some(path) => call.resolve(JsonValue::from(path)),
                        None => call.reject("the folder's path is not valid UTF-8"),
                    },
                    None => call.resolve(JsonValue::Null),
                });
            });
        }
    });
    runtime.spawn(async move {
        while let Some(scale) = text_sizes.recv().await {
            with_running_view(move |view| view.set_font_scale(Some(scale)));
        }
    });
    runtime.spawn(async move {
        while notices.recv().await.is_some() {
            eprintln!("maka-desktop-shell: the AppKit window posts no notifications");
        }
    });
}

fn refuse_reloads(mut reloading: tokio::sync::mpsc::UnboundedReceiver<Request>, runtime: &Runtime) {
    runtime.spawn(async move {
        while let Some(request) = reloading.recv().await {
            if let Request::Pause(ready) = request {
                let _ = ready.send(Err("the AppKit window cannot reload its UI".into()));
            }
        }
    });
}
