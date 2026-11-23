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
use std::{ffi::OsString, fmt, io, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    runtime::{Handle, Runtime},
    sync::oneshot,
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};

const STDERR_LIMIT: usize = 2048;

#[derive(Clone, Copy)]
enum ConnectPhase {
    Bootstrap,
    RootIdentity,
    Anchor,
    Workbench,
    Handoff,
    HandoffAck,
}

impl ConnectPhase {
    fn failure(self, reason: impl fmt::Display) -> String {
        let phase = match self {
            Self::Bootstrap => "bootstrap (waiting for Ready)",
            Self::RootIdentity => "Root identity",
            Self::Anchor => "Host anchor",
            Self::Workbench => "workbench admission",
            Self::Handoff => "residency handoff",
            Self::HandoffAck => "residency handoff ACK",
        };
        format!("WSL connection failed during {phase}: {reason}")
    }

    async fn before<T, E: fmt::Display>(
        self,
        deadline: Instant,
        step: impl Future<Output = Result<T, E>>,
    ) -> Result<T, String> {
        timeout_at(deadline, step)
            .await
            .map_err(|_| self.failure("timed out"))?
            .map_err(|error| self.failure(error))
    }
}

async fn stderr_tail(mut stderr: impl AsyncRead + Unpin) -> io::Result<String> {
    let mut tail = Vec::with_capacity(STDERR_LIMIT);
    let mut chunk = [0; 1024];
    loop {
        let read = stderr.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let trim = (tail.len() + read).saturating_sub(STDERR_LIMIT);
        tail.drain(..trim);
        tail.extend_from_slice(&chunk[..read]);
    }
    Ok(String::from_utf8_lossy(&tail)
        .trim()
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect())
}

pub(crate) struct Target {
    distro: OsString,
    executable: OsString,
    root: OsString,
    directory: PathBuf,
}

pub(crate) struct Session {
    pub(crate) connection: Connection,
    pub(crate) bridge: Bridge,
    pub(crate) disconnected: oneshot::Receiver<()>,
    pub(crate) root: String,
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
        let runtime = Runtime::new().map_err(|error| error.to_string())?;
        let first = runtime.block_on(self.connect(None))?;
        direct2d::run_wsl(first, self, runtime)
    }

    pub(crate) async fn connect(&self, expected: Option<&str>) -> Result<Session, String> {
        let mut child = Command::new("wsl.exe")
            .arg("--distribution")
            .arg(&self.distro)
            .arg("--exec")
            .arg(&self.executable)
            .arg(HELPER)
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
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
            stderr: Some(tokio::spawn(stderr_tail(
                child.stderr.take().expect("piped WSL stderr"),
            ))),
            child,
            driver: Some(driver),
            monitor: None,
        };
        let deadline = Instant::now() + Duration::from_secs(120);
        let admit = async {
            let (mut bootstrap, ready) = ConnectPhase::Bootstrap
                .before(deadline, async {
                    let mut bootstrap = opener.open().await?;
                    let ready = Ready::receive(&mut bootstrap).await?;
                    Ok::<_, io::Error>((bootstrap, ready))
                })
                .await?;
            if ready.root.len() != 64
                || !ready.root.bytes().all(|byte| byte.is_ascii_hexdigit())
                || ready.epoch.is_nil()
                || expected.is_some_and(|root| root != ready.root)
            {
                return Err(ConnectPhase::RootIdentity.failure("changed or invalid"));
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
            let host = ConnectPhase::Anchor
                .before(deadline, Client::connect_on(open, Some(ready.epoch), None))
                .await?;
            let connection = ConnectPhase::Workbench
                .before(
                    deadline,
                    Connection::admit_wsl(
                        host,
                        &ready.root,
                        self.directory.join(&ready.root),
                        Handle::current(),
                    ),
                )
                .await?;
            ConnectPhase::Handoff
                .before(deadline, async {
                    bootstrap.write_u8(1).await?;
                    bootstrap.shutdown().await
                })
                .await?;
            if ConnectPhase::HandoffAck
                .before(deadline, bootstrap.read_u8())
                .await?
                != 1
            {
                return Err(ConnectPhase::HandoffAck.failure("expected acknowledgement byte 1"));
            }
            Ok::<_, String>((connection, ready.root, bootstrap))
        };
        match admit.await {
            Ok((connection, root, mut lifetime)) => {
                let (done, disconnected) = oneshot::channel();
                bridge.monitor = Some(tokio::spawn(async move {
                    // EOF on this stream means the specific Host anchor was lost.
                    let _ = lifetime.read_u8().await;
                    let _ = done.send(());
                }));
                Ok(Session {
                    connection,
                    bridge,
                    disconnected,
                    root,
                })
            }
            Err(mut error) => {
                if let Some(stderr) = bridge.finish().await {
                    error.push_str("\nWSL helper stderr:\n");
                    error.push_str(&stderr);
                }
                Err(error)
            }
        }
    }
}

pub(crate) struct Bridge {
    child: Child,
    stderr: Option<JoinHandle<io::Result<String>>>,
    driver: Option<JoinHandle<()>>,
    monitor: Option<JoinHandle<()>>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(monitor) = self.monitor.take() {
            monitor.abort();
        }
        if let Some(driver) = self.driver.take() {
            driver.abort();
        }
        if let Some(stderr) = self.stderr.take() {
            stderr.abort();
        }
    }
}

impl Bridge {
    pub(crate) async fn close(self) {
        if let Some(stderr) = self.finish().await {
            eprintln!("{stderr}");
        }
    }

    async fn finish(mut self) -> Option<String> {
        if let Some(monitor) = self.monitor.take() {
            monitor.abort();
            let _ = monitor.await;
        }
        if let Some(driver) = self.driver.take() {
            driver.abort();
            let _ = driver.await;
        }
        match timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => eprintln!("wait for WSL stdio helper: {error}"),
            Err(_) => {
                if let Err(error) = self.child.kill().await {
                    eprintln!("stop WSL stdio helper: {error}");
                }
            }
        }
        let stderr = self.stderr.as_mut().expect("WSL helper stderr reader");
        match timeout(Duration::from_secs(1), stderr).await {
            Ok(Ok(Ok(tail))) => return (!tail.is_empty()).then_some(tail),
            Ok(Ok(Err(error))) => eprintln!("read WSL stdio helper stderr: {error}"),
            Ok(Err(error)) => eprintln!("WSL stdio helper stderr reader: {error}"),
            Err(_) => eprintln!("WSL stdio helper stderr did not close"),
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connection_errors_name_the_failing_phase() {
        let deadline = Instant::now() + Duration::from_secs(1);
        let root = ConnectPhase::RootIdentity.failure("changed or invalid");
        let handoff = ConnectPhase::HandoffAck
            .before(deadline, async { Err::<(), _>("unexpected end of file") })
            .await
            .unwrap_err();
        let startup = ConnectPhase::Bootstrap
            .before(Instant::now(), std::future::pending::<io::Result<()>>())
            .await
            .unwrap_err();
        assert_eq!(
            root,
            "WSL connection failed during Root identity: changed or invalid"
        );
        assert_eq!(
            handoff,
            "WSL connection failed during residency handoff ACK: unexpected end of file"
        );
        assert_eq!(
            startup,
            "WSL connection failed during bootstrap (waiting for Ready): timed out"
        );
    }

    #[tokio::test]
    async fn helper_stderr_keeps_only_a_bounded_tail() {
        let mut stderr = b"discard this prefix\n".to_vec();
        stderr.extend(std::iter::repeat_n(b'x', STDERR_LIMIT));
        stderr.extend_from_slice(b"\nWSL stdio helper: deadline has elapsed\n");
        let tail = stderr_tail(stderr.as_slice()).await.unwrap();
        assert!(!tail.contains("discard this prefix"));
        assert!(tail.ends_with("\nWSL stdio helper: deadline has elapsed"));
        assert!(tail.len() <= STDERR_LIMIT);
    }
}
