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

//! The Windows workbench in a Direct2D window, with one admitted Host.

use crate::{
    host::{self, Connection},
    shell::{APP_ID, MIN_SIZE, Requests, SIZE, Shell, TITLE},
};
use maka_workbench::reload::{Request, UiReload};
use nsh_engine::JsonValue;
use nsh_platform_windows::{AppOptions, quit_app, run_app_with_config, with_running_view};
use tokio::{
    runtime::{Handle, Runtime},
    sync::watch,
};

pub(crate) fn start(target: crate::Target) -> Result<(), String> {
    use maka_host_runtime::application::host::Client as HostClient;
    let root = maka_event_log::root::resolve(&target.root).map_err(|error| error.to_string())?;
    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    let first = runtime.block_on(async {
        let host = HostClient::connect(&target.endpoint, Some(target.epoch)).await?;
        host::Connection::admit(
            host,
            target.endpoint,
            root.canonical_path(),
            Handle::current(),
        )
        .await
    })?;
    run(first, runtime)
}

fn run(first: Connection, runtime: Runtime) -> Result<(), String> {
    let Connection {
        bindings,
        config,
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
    carry_out(requests, &runtime);
    refuse_reloads(reloading, runtime.handle());
    let result = run_app_with_config(
        shell.attach(config),
        AppOptions {
            app_id: APP_ID.into(),
            title: TITLE.into(),
            size: SIZE,
            min_size: Some((MIN_SIZE.0 as i32, MIN_SIZE.1 as i32)),
            ..Default::default()
        },
        move |is_active| {
            active.send_replace(is_active);
        },
    );
    runtime.block_on(host::detach(bindings, &endpoint, epoch));
    runtime.shutdown_background();
    if result == std::process::ExitCode::SUCCESS {
        Ok(())
    } else {
        Err("the Direct2D window failed".into())
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
        while let Some(call) = notices.recv().await {
            call.reject("the Direct2D window does not support system notifications");
        }
    });
    runtime.spawn(async move {
        if exits.recv().await.is_some() {
            quit_app();
        }
    });
    runtime.spawn(async move {
        while let Some(call) = folders.recv().await {
            with_running_view(move |view| {
                view.choose_directory(move |path| match path {
                    Ok(Some(path)) => match path.to_str() {
                        Some(path) => call.resolve(JsonValue::from(path)),
                        None => call.reject("the folder's path is not valid UTF-8"),
                    },
                    Ok(None) => call.resolve(JsonValue::Null),
                    Err(error) => call.reject(error),
                });
            });
        }
    });
    runtime.spawn(async move {
        while let Some(scale) = text_sizes.recv().await {
            with_running_view(move |view| view.set_font_scale(Some(scale)));
        }
    });
}

fn refuse_reloads(mut requests: tokio::sync::mpsc::UnboundedReceiver<Request>, runtime: &Handle) {
    runtime.spawn(async move {
        while let Some(request) = requests.recv().await {
            if let Request::Pause(ready) = request {
                let _ = ready.send(Err("the Direct2D window cannot reload its UI".into()));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_exit_closes_the_native_window() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        let runtime = Runtime::new().unwrap();
        let (_active, foreground) = watch::channel(false);
        let (shell, requests) = Shell::new(foreground);
        carry_out(requests, &runtime);
        let mut policy = nsh_engine::Policy::default();
        policy
            .declared
            .get_or_insert_default()
            .host
            .push("terminal.exit".into());
        let bundle = nsh_engine::Bundle::source(
            "import { host, mount } from 'nsh';
             import { element } from 'nsh:rt';
             import { currentWindow } from 'nsh/desktop';
             mount(() => {
               currentWindow().set({ closeOnPress: false });
               host.post('terminal.exit');
               return element('view');
             });"
            .into(),
        )
        .with_policy(policy);
        let config = shell.attach(nsh_engine::EngineConfig::new(bundle));
        let (done, finished) = mpsc::channel();
        let timed_out = Arc::new(AtomicBool::new(false));
        let timeout = timed_out.clone();
        let watchdog = std::thread::spawn(move || {
            if matches!(
                finished.recv_timeout(std::time::Duration::from_secs(30)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                timeout.store(true, Ordering::SeqCst);
                quit_app();
            }
        });
        let code = run_app_with_config(
            config,
            AppOptions {
                app_id: "org.apache.maka.direct2d-test".into(),
                title: "Direct2D exit bridge test".into(),
                size: (320, 240),
                ..Default::default()
            },
            |_| {},
        );
        let _ = done.send(());
        watchdog.join().unwrap();
        runtime.shutdown_background();
        assert!(
            !timed_out.load(Ordering::SeqCst),
            "terminal.exit did not close the native window"
        );
        assert_eq!(code, std::process::ExitCode::SUCCESS);
    }

    #[tokio::test]
    async fn reload_pause_gets_an_explicit_rejection() {
        let (send, recv) = tokio::sync::mpsc::unbounded_channel();
        refuse_reloads(recv, &Handle::current());
        let (ready, received) = tokio::sync::oneshot::channel();
        send.send(Request::Pause(ready)).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), received)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result,
            Err("the Direct2D window cannot reload its UI".into())
        );
    }
}
