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
//! follows the Root's Host, but refuses an in-place UI reload rather than
//! pausing its input for one.

use crate::{
    host::{self, Connection, FIRST_PAUSE, RECONNECT_LIMIT, Root, STEADY},
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use maka_workbench::reload::Request;
use nsh_engine::JsonValue;
use nsh_platform_macos::{AppOptions, quit_app, run_app_with_config, with_running_view};
use std::time::Instant;
use tokio::{
    runtime::Runtime,
    sync::{oneshot, watch},
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
    let mut following = runtime.spawn(follow(first, root, shell, quitting));
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

async fn follow(
    mut current: Connection,
    root: Root,
    shell: Shell,
    mut quitting: watch::Receiver<bool>,
) {
    let mut pause = FIRST_PAUSE;
    loop {
        let reached = Instant::now();
        let mut reloading = current.bindings.reload().take_requests();
        let state = {
            let preparing = async {
                host::stopped(current.endpoint.clone(), current.epoch).await;
                loop {
                    let (ready, paused) = oneshot::channel();
                    with_running_view(move |view| {
                        view.pause_input(move |result| {
                            let _ = ready.send(result);
                        })
                    });
                    let result = async {
                        paused
                            .await
                            .map_err(|_| "the window closed while pausing input".to_owned())??;
                        maka_workbench::reload::prepare(&current.config.host).await
                    }
                    .await;
                    match result {
                        Ok(state) => break state,
                        Err(error) => {
                            eprintln!("maka-desktop-shell: preserving the workbench: {error}");
                            with_running_view(|view| view.resume_input());
                            tokio::time::sleep(pause).await;
                            pause = (pause * 2).min(RECONNECT_LIMIT);
                        }
                    }
                }
            };
            tokio::pin!(preparing);
            loop {
                if *quitting.borrow() {
                    break None;
                }
                tokio::select! {
                    _ = quitting.changed() => break None,
                    state = &mut preparing => break Some(state),
                    Some(request) = reloading.recv() => {
                        if let Request::Pause(ready) = request {
                            let _ = ready.send(Err("the AppKit window cannot reload its UI".into()));
                        }
                    }
                }
            }
        };
        // Settle the old client's journal before admitting the next client.
        host::detach(current.bindings, &current.endpoint, current.epoch).await;
        drop(current.config);
        let Some(state) = state else { return };
        if *quitting.borrow() {
            return;
        }
        let mut wait = reached.elapsed() < STEADY;
        if !wait {
            pause = FIRST_PAUSE;
        }
        current = loop {
            if wait {
                tokio::select! {
                    _ = quitting.changed() => return,
                    _ = tokio::time::sleep(pause) => {}
                }
                pause = (pause * 2).min(RECONNECT_LIMIT);
            }
            if *quitting.borrow() {
                return;
            }
            wait = true;
            match root.connect(tokio::runtime::Handle::current()).await {
                Ok(connection) => break connection,
                Err(error) => eprintln!("maka-desktop-shell: reconnecting: {error}"),
            }
        };
        if *quitting.borrow() {
            host::detach(current.bindings, &current.endpoint, current.epoch).await;
            return;
        }
        current.bindings.reload().restore(state);
        let config = shell.attach(current.config.clone());
        with_running_view(move |view| {
            view.resume_input();
            view.load_with_config(config);
        });
    }
}
