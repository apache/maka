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

use crate::{direct2d, host::Connection};
use maka_host_runtime::application::host::{Channel, Client, OpenChannel};
use maka_wsl_bridge::{HELPER, Ready};
use std::{ffi::OsString, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    runtime::{Handle, Runtime},
    sync::oneshot,
    task::JoinHandle,
};

pub(crate) struct Target {
    distro: OsString,
    executable: OsString,
    root: OsString,
    directory: PathBuf,
}

impl Target {
    pub(crate) fn from_env(distro: OsString) -> Result<Self, String> {
        let get = |key: &str| {
            std::env::var_os(key)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{key} is required for WSL Desktop"))
        };
        let directory = PathBuf::from(get("MAKA_DESKTOP_WSL_CLIENT_DIR")?);
        if distro.is_empty() || !directory.is_absolute() {
            return Err("WSL Desktop needs a distribution and an absolute client directory".into());
        }
        Ok(Self {
            distro,
            executable: get("MAKA_DESKTOP_WSL_MAKA")?,
            root: get("MAKA_DESKTOP_WSL_ROOT")?,
            directory,
        })
    }

    pub(crate) fn run(self) -> Result<(), String> {
        let mut expected = None;
        loop {
            let runtime = Runtime::new().map_err(|error| error.to_string())?;
            let (connection, bridge, disconnected, root) =
                runtime.block_on(self.connect(expected.as_deref()))?;
            expected = Some(root);
            let result = direct2d::run(connection, &runtime, Some(disconnected));
            runtime.block_on(bridge.close());
            if !result? {
                return Ok(());
            }
        }
    }

    async fn connect(
        &self,
        expected: Option<&str>,
    ) -> Result<(Connection, Bridge, oneshot::Receiver<()>, String), String> {
        let mut child = Command::new("wsl.exe")
            .arg("--distribution")
            .arg(&self.distro)
            .arg("--exec")
            .arg(&self.executable)
            .arg(HELPER)
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("start WSL stdio helper: {error}"))?;
        let pipes = tokio::io::join(
            child.stdout.take().expect("piped WSL stdout"),
            child.stdin.take().expect("piped WSL stdin"),
        );
        let (opener, drive) = maka_wsl_bridge::client(pipes);
        let driver = tokio::spawn(async move {
            if let Err(error) = drive.await {
                eprintln!("WSL stdio bridge: {error}");
            }
        });
        let mut bridge = Bridge {
            child,
            driver,
            monitor: None,
        };
        let admit = async {
            let mut bootstrap = opener.open().await.map_err(|error| error.to_string())?;
            let ready = Ready::receive(&mut bootstrap)
                .await
                .map_err(|error| error.to_string())?;
            if ready.root.len() != 64
                || !ready.root.bytes().all(|byte| byte.is_ascii_hexdigit())
                || ready.epoch.is_nil()
                || expected.is_some_and(|root| root != ready.root)
            {
                return Err("WSL Host Root identity changed or is invalid".into());
            }
            let open: OpenChannel = Arc::new(move || {
                let opener = opener.clone();
                Box::pin(async move {
                    opener
                        .open()
                        .await
                        .map(|stream| Box::new(stream) as Channel)
                })
            });
            let host = Client::connect_on(open, Some(ready.epoch), None).await?;
            let connection = Connection::admit_wsl(
                host,
                &ready.root,
                self.directory.join(&ready.root),
                Handle::current(),
            )
            .await?;
            bootstrap
                .write_u8(1)
                .await
                .map_err(|error| error.to_string())?;
            bootstrap
                .shutdown()
                .await
                .map_err(|error| error.to_string())?;
            if bootstrap
                .read_u8()
                .await
                .map_err(|error| error.to_string())?
                != 1
            {
                return Err("WSL Host residency handoff failed".into());
            }
            Ok((connection, ready.root, bootstrap))
        };
        match tokio::time::timeout(Duration::from_secs(120), admit).await {
            Ok(Ok((connection, root, mut lifetime))) => {
                let (done, disconnected) = oneshot::channel();
                bridge.monitor = Some(tokio::spawn(async move {
                    // EOF on this stream means the specific Host anchor was lost.
                    let _ = lifetime.read_u8().await;
                    let _ = done.send(());
                }));
                Ok((connection, bridge, disconnected, root))
            }
            result => {
                bridge.close().await;
                match result {
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err("WSL Host startup timed out".into()),
                    Ok(Ok(_)) => unreachable!(),
                }
            }
        }
    }
}

struct Bridge {
    child: Child,
    driver: JoinHandle<()>,
    monitor: Option<JoinHandle<()>>,
}

impl Bridge {
    async fn close(mut self) {
        if let Some(monitor) = self.monitor.take() {
            monitor.abort();
            let _ = monitor.await;
        }
        self.driver.abort();
        let _ = self.driver.await;
        // EOF normally lets the Linux helper settle its IPC channels.
        if tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .is_err()
            && let Err(error) = self.child.kill().await
        {
            eprintln!("stop WSL stdio helper: {error}");
        }
    }
}
