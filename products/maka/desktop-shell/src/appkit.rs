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

//! The workbench in a window of NSH's AppKit backend, macOS's default. It has
//! one Host: closing destroys the UI, while Open builds a new UI on that same
//! admitted connection. The window does not follow a Host that stops, and
//! refuses a UI reload rather than pausing its input for one.

use crate::{
    host::{self, Connection},
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use maka_workbench::reload::{Request, UiReload};
use nsh_engine::JsonValue;
use nsh_platform_macos::{
    AppOptions, StatusMenuOptions, quit_app, run_resident_app_with_config, with_running_view,
};
use tokio::{runtime::Runtime, sync::watch};

pub fn run(first: Connection, runtime: Runtime) -> Result<(), String> {
    let Connection {
        bindings,
        config,
        endpoint,
        epoch,
    } = first;
    let directory = config
        .data_dir
        .as_ref()
        .expect("Host admission sets the client directory")
        .clone();
    let frame_autosave_name = Some(format!("{TITLE} {}", directory.display()));
    let (active, foreground) = watch::channel(false);
    let (shell, requests) = Shell::new(foreground);
    let reloading = config
        .context
        .get::<UiReload>()
        .expect("the admitted workbench owns its UI reload channel")
        .take_requests();
    drop(config);
    carry_out(requests, &runtime);
    refuse_reloads(reloading, &runtime);
    let options = AppOptions {
        app_id: APP_ID.into(),
        title: TITLE.into(),
        size: SIZE,
        min_size: Some((MIN_SIZE.0 as i32, MIN_SIZE.1 as i32)),
        frame_autosave_name,
        ..Default::default()
    };
    let ui_bindings = bindings.clone();
    let ui_runtime = runtime.handle().clone();
    let ui_shell = shell.clone();
    let closing_shell = shell.clone();
    let mut status_menu = StatusMenuOptions::default();
    status_menu.title = TITLE.into();
    status_menu.open_label = "Open Maka".into();
    status_menu.quit_label = "Quit".into();
    run_resident_app_with_config(
        options,
        status_menu,
        move || {
            let mut config =
                maka_workbench::configuration(ui_bindings.registry(None), ui_runtime.clone());
            config.context = config.context.with(ui_bindings.reload());
            config.data_dir = Some(directory.clone());
            config.assets = Some(ui_bindings.assets());
            config.chunk_loader = Some(ui_bindings.chunk_loader());
            ui_shell.attach(config)
        },
        move |is_active| {
            active.send_replace(is_active);
        },
        move || shell.release(),
        move || closing_shell.prepare_close(),
    );
    runtime.block_on(host::detach(bindings, &endpoint, epoch));
    runtime.shutdown_background();
    Ok(())
}

fn carry_out(requests: Requests, runtime: &Runtime) {
    let Requests {
        mut exits,
        mut close_ready,
        mut folders,
        mut text_sizes,
        mut notices,
    } = requests;
    runtime.spawn(async move {
        while exits.recv().await.is_some() {
            quit_app();
        }
    });
    runtime.spawn(async move {
        while let Some(request) = close_ready.recv().await {
            with_running_view(move |view| {
                if !request.is_current() {
                    return;
                }
                if let Some(window) = view.view().window() {
                    window.performClose(None);
                }
            });
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
        while let Some(call) = notices.recv().await {
            call.resolve(JsonValue::Null);
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
