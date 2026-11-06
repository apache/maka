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

//! The workbench in a window of NSH's AppKit backend, macOS's default. It
//! follows the Root's Host while keeping the workbench and local input alive.

mod permissions;

use crate::{
    host::{self, Connection, FIRST_PAUSE, RECONNECT_LIMIT, Root, STEADY},
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use maka_workbench::{bindings::SystemPermissionWindow, reload::Request};
use nsh_engine::JsonValue;
use nsh_platform_macos::{AppOptions, quit_app, run_app_with_config, with_running_view};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use tokio::{
    runtime::Runtime,
    sync::{mpsc, watch},
};

pub fn run(first: Connection, root: Root, runtime: Runtime) -> Result<(), String> {
    let directory = first
        .config
        .data_dir
        .as_ref()
        .expect("Host admission sets the client directory");
    let frame_autosave_name = Some(format!("{TITLE} {}", directory.display()));
    let (active, foreground) = watch::channel(false);
    let (shell, requests) = Shell::new(foreground);
    let config = shell.attach(first.config.clone());
    let (quit, quitting) = watch::channel(false);
    carry_out(requests, &runtime);
    refuse_reloads(first.bindings.reload().take_requests(), &runtime);
    let windows = permission_requests(&first);
    let mut following = runtime.spawn(follow(first, root, windows, quitting));
    let options = AppOptions {
        app_id: APP_ID.into(),
        title: TITLE.into(),
        size: SIZE,
        min_size: Some((MIN_SIZE.0 as i32, MIN_SIZE.1 as i32)),
        frame_autosave_name,
        ..Default::default()
    };
    run_app_with_config(config, options, move |is_active| {
        active.send_replace(is_active);
    });
    permissions::close_all();
    quit.send_replace(true);
    runtime.block_on(async {
        // Admission can still be in flight when the window closes. Give it
        // the same bounded grace period as a connected client's detach.
        if tokio::time::timeout(host::DETACH_LIMIT, &mut following)
            .await
            .is_err()
        {
            following.abort();
            let _ = following.await;
        }
    });
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
        while let Some(call) = notices.recv().await {
            call.resolve(JsonValue::Null);
            eprintln!("maka-desktop-shell: the AppKit window posts no notifications");
        }
    });
}

fn permission_requests(connection: &Connection) -> mpsc::UnboundedReceiver<SystemPermissionWindow> {
    let (send, receive) = mpsc::unbounded_channel();
    connection.bindings.set_system_permission_windows(send);
    receive
}

async fn follow(
    mut current: Connection,
    root: Root,
    mut windows: mpsc::UnboundedReceiver<SystemPermissionWindow>,
    mut quitting: watch::Receiver<bool>,
) {
    let mut pause = FIRST_PAUSE;
    loop {
        let reached = Instant::now();
        if *quitting.borrow() {
            break;
        }
        let alive = Arc::new(AtomicBool::new(true));
        let stopped = host::stopped(current.endpoint.clone(), current.epoch);
        tokio::pin!(stopped);
        let reconnect = loop {
            tokio::select! {
                biased;
                _ = quitting.changed() => break false,
                () = &mut stopped => break true,
                Some(request) = windows.recv() => {
                    let alive = alive.clone();
                    let config = current.config.clone();
                    with_running_view(move |_| {
                        if alive.load(Ordering::Acquire) {
                            permissions::open(request, alive, &config);
                        }
                    });
                }
            }
        };
        alive.store(false, Ordering::Release);
        // Reject queued and in-flight requests from the old Host generation.
        windows.close();
        while windows.try_recv().is_ok() {}
        if !reconnect {
            break;
        }
        let (closed, closing) = tokio::sync::oneshot::channel();
        with_running_view(move |_| {
            permissions::close_all();
            let _ = closed.send(());
        });
        tokio::select! {
            _ = quitting.changed() => break,
            _ = closing => {}
        }
        // Only the disconnected transport generation closes. Local journal
        // writes, native file selections and the JS workbench stay alive.
        let _ = tokio::time::timeout(host::DETACH_LIMIT, current.bindings.disconnect()).await;
        let mut wait = reached.elapsed() < STEADY;
        if !wait {
            pause = FIRST_PAUSE;
        }
        loop {
            if wait {
                tokio::select! {
                    _ = quitting.changed() => break,
                    _ = tokio::time::sleep(pause) => {}
                }
                pause = (pause * 2).min(RECONNECT_LIMIT);
            }
            if *quitting.borrow() {
                break;
            }
            wait = true;
            let connecting = async {
                let (host, endpoint) = root.connect_host().await?;
                let epoch = host.epoch();
                let (client, _) = maka_workbench::host::admit(host, root.path(), "desktop").await?;
                current.bindings.reconnect(client).await?;
                Ok::<_, String>((endpoint, epoch))
            };
            let result = tokio::select! {
                _ = quitting.changed() => break,
                result = connecting => result,
            };
            match result {
                Ok((endpoint, epoch)) => {
                    current.endpoint = endpoint;
                    current.epoch = epoch;
                    windows = permission_requests(&current);
                    let _ = current
                        .config
                        .host
                        .send("workbench.reconnected", JsonValue::Null);
                    break;
                }
                Err(error) => eprintln!("maka-desktop-shell: reconnecting: {error}"),
            }
        }
        if *quitting.borrow() {
            break;
        }
    }
    host::detach(current.bindings, &current.endpoint, current.epoch).await;
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
