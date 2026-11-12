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

//! The AppKit workbench follows the Root's admitted Host. Utility windows
//! belong to that connection and close before a replacement client is loaded.

mod permissions;

use crate::{
    host::{self, Connection, Root},
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use maka_workbench::{
    bindings::SystemPermissionWindow,
    reload::{Request, UiReload},
};
use nsh_engine::JsonValue;
use nsh_platform_macos::{
    AppOptions, objc2::MainThreadMarker, quit_app, run_app_with_config, with_running_view,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    runtime::Runtime,
    sync::{mpsc, watch},
};

pub(crate) fn start(target: crate::Target) -> Result<(), String> {
    use maka_host_runtime::application::host::Client as HostClient;
    let root = host::Root::find(target.root, target.launcher)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    let first = runtime.block_on(async {
        let host = HostClient::connect(&target.endpoint, Some(target.epoch)).await?;
        Connection::admit(
            host,
            target.endpoint,
            root.path(),
            tokio::runtime::Handle::current(),
        )
        .await
    })?;
    run(first, root, runtime)
}

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
    carry_out(requests, &runtime);
    let windows = permission_requests(&first);
    refuse_reloads(
        first
            .config
            .context
            .get::<UiReload>()
            .expect("the admitted workbench owns its UI reload channel")
            .take_requests(),
        runtime.handle(),
    );
    let (quit, quitting) = watch::channel(false);
    let following = runtime.spawn(follow(first, root, shell, windows, quitting));
    let options = AppOptions {
        app_id: APP_ID.into(),
        title: TITLE.into(),
        size: SIZE,
        min_size: Some((MIN_SIZE.0 as i32, MIN_SIZE.1 as i32)),
        frame_autosave_name,
        ..Default::default()
    };
    crate::screenshot::register(
        &options.components,
        MainThreadMarker::new().expect("the desktop shell runs on AppKit's main thread"),
    );
    run_app_with_config(config, options, move |is_active| {
        active.send_replace(is_active);
    });
    permissions::close_all();
    quit.send_replace(true);
    runtime
        .block_on(following)
        .map_err(|error| error.to_string())?;
    runtime.shutdown_background();
    Ok(())
}

fn permission_requests(connection: &Connection) -> mpsc::UnboundedReceiver<SystemPermissionWindow> {
    let (send, receive) = mpsc::unbounded_channel();
    connection.bindings.set_system_permission_windows(send);
    receive
}

async fn follow(
    current: Connection,
    root: Root,
    shell: Shell,
    mut windows: mpsc::UnboundedReceiver<SystemPermissionWindow>,
    mut quit: watch::Receiver<bool>,
) {
    let Connection {
        bindings,
        mut endpoint,
        mut epoch,
        config: mut configuration,
    } = current;
    let mut bindings = Some(bindings);
    let mut pause = Duration::from_secs(1);
    'connected: loop {
        let reached = Instant::now();
        let alive = Arc::new(AtomicBool::new(true));
        let stopped = host::stopped(endpoint.clone(), epoch);
        tokio::pin!(stopped);
        let mut accepting_windows = true;
        loop {
            tokio::select! {
                biased;
                _ = quit.changed() => {
                    alive.store(false, Ordering::Release);
                    break 'connected;
                }
                _ = &mut stopped => break,
                request = windows.recv(), if accepting_windows => {
                    if let Some(request) = request {
                        let alive = alive.clone();
                        let configuration = configuration.clone();
                        with_running_view(move |_| {
                            if alive.load(Ordering::Acquire) { permissions::open(request, alive, &configuration); }
                        });
                    } else { accepting_windows = false; }
                }
            }
        }
        alive.store(false, Ordering::Release);
        // Main-thread barrier: no old engine or drag source survives into the
        // next connection. Quitting can end the standalone runner first.
        let (closed, closing) = tokio::sync::oneshot::channel();
        with_running_view(move |view| {
            permissions::close_all();
            view.stop();
            let _ = closed.send(());
        });
        tokio::select! {
            _ = quit.changed() => break,
            _ = closing => {}
        }
        host::detach(
            bindings.take().expect("a connected Host owns bindings"),
            &endpoint,
            epoch,
        )
        .await;
        let mut wait = reached.elapsed() < Duration::from_secs(60);
        if !wait {
            pause = Duration::from_secs(1);
        }
        let next = loop {
            if wait {
                tokio::select! {
                    _ = quit.changed() => break 'connected,
                    _ = tokio::time::sleep(pause) => {}
                }
                pause = (pause * 2).min(Duration::from_secs(30));
            }
            if *quit.borrow() {
                break 'connected;
            }
            wait = true;
            // Finish an admitted attempt even when quitting; then detach it.
            match root.connect(tokio::runtime::Handle::current()).await {
                Ok(connection) => break connection,
                Err(error) => {
                    eprintln!("maka-desktop-shell: reconnecting: {error}");
                    // The tray left with the engine: a hidden window is the
                    // only way back while no Host answers.
                    with_running_view(|view| {
                        if let Some(window) = view.view().window()
                            && !window.isVisible()
                        {
                            window.makeKeyAndOrderFront(None);
                        }
                    });
                }
            }
            if *quit.borrow() {
                break 'connected;
            }
        };
        windows = permission_requests(&next);
        let Connection {
            bindings: admitted,
            config,
            endpoint: reached_endpoint,
            epoch: reached_epoch,
        } = next;
        bindings = Some(admitted);
        endpoint = reached_endpoint;
        epoch = reached_epoch;
        if *quit.borrow() {
            break;
        }
        let reloading = config
            .context
            .get::<UiReload>()
            .expect("the admitted workbench owns its UI reload channel")
            .take_requests();
        refuse_reloads(reloading, &tokio::runtime::Handle::current());
        configuration = shell.attach(config);
        let config = configuration.clone();
        with_running_view(move |view| view.load_with_config(config));
    }
    if let Some(bindings) = bindings {
        host::quit(bindings).await;
    }
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

fn refuse_reloads(
    mut reloading: tokio::sync::mpsc::UnboundedReceiver<Request>,
    runtime: &tokio::runtime::Handle,
) {
    runtime.spawn(async move {
        while let Some(request) = reloading.recv().await {
            if let Request::Pause(ready) = request {
                let _ = ready.send(Err("the AppKit window cannot reload its UI".into()));
            }
        }
    });
}
