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

use cua_driver_core::browser::host_handoff::{
    ConfiguredHandoff, HandoffError,
    transport::{Connection, Message},
};
use maka_agent_facts::tools::ToolError;
use std::{
    process::{ExitCode, Stdio},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

mod native;
mod process;
mod supervisor;
mod transaction;

const ENTRY: &str = "__maka-browser-handoff";
const RESTORE: &str = "__maka-browser-restore";
const STARTUP: Duration = Duration::from_secs(15);

pub(crate) fn bootstrap() -> Option<ExitCode> {
    let argument = std::env::args_os().nth(1);
    let restore_cli = argument.as_deref() == Some(std::ffi::OsStr::new("browser"))
        && std::env::args_os().nth(2).as_deref() == Some(std::ffi::OsStr::new("restore"))
        && std::env::args_os().len() == 3;
    if restore_cli
        || argument
            .as_deref()
            .is_some_and(|arg| arg == ENTRY || arg == RESTORE)
    {
        let result = (|| {
            let config = ConfiguredHandoff::load().map_err(failed)?;
            let Some(config) = config else {
                if restore_cli {
                    return cua_driver_core::browser::host_handoff::restore_current()
                        .map_err(failed);
                }
                return Err(failed("on-demand browser host is not configured"));
            };
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(failed)?;
            if restore_cli || argument.as_deref() == Some(std::ffi::OsStr::new(RESTORE)) {
                runtime.block_on(supervisor::recover(config))
            } else {
                runtime.block_on(supervisor::run(config))
            }
        })();
        return Some(match result {
            Ok(()) => {
                if restore_cli {
                    eprintln!("Restored the original browser host registration.");
                }
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Maka browser handoff: {error}");
                ExitCode::FAILURE
            }
        });
    }
    let origin = std::env::args_os().nth(1)?;
    let origin_text = origin.to_str()?;
    if !origin_text.starts_with("chrome-extension://") {
        return None;
    }
    let result = (|| {
        let Some(config) = ConfiguredHandoff::load().map_err(failed)? else {
            return Ok(None);
        };
        let selected = origin_text == format!("chrome-extension://{}/", config.extension_id());
        if selected && native::admit(&config)? {
            return Ok(None);
        }
        let original = config.original().map_err(failed)?;
        if !original
            .allowed_origins
            .iter()
            .any(|allowed| allowed == origin_text)
        {
            return Err(failed(
                "origin is not allowed by the original host registration",
            ));
        }
        let status = std::process::Command::new(&original.executable)
            .args(std::env::args_os().skip(1))
            .current_dir(
                original
                    .executable
                    .parent()
                    .ok_or_else(|| failed("original host lacks parent"))?,
            )
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(failed)?;
        Ok(Some(if status.success() {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        }))
    })();
    match result {
        Ok(exit) => exit,
        Err(error) => {
            eprintln!("Maka browser host forwarding: {error}");
            Some(ExitCode::FAILURE)
        }
    }
}

pub(crate) struct Lease {
    release: Option<tokio::sync::oneshot::Sender<()>>,
    completed: tokio::sync::watch::Receiver<Option<Result<usize, ToolError>>>,
    recovery: Option<(ConfiguredHandoff, uuid::Uuid)>,
}

impl Lease {
    pub(crate) async fn acquire(
        config: ConfiguredHandoff,
        owner: uuid::Uuid,
        cancellation: &CancellationToken,
    ) -> Result<Self, ToolError> {
        let operation = async {
            let mut child: Option<tokio::process::Child> = None;
            loop {
                if let Ok(mut connection) = Connection::connect(&config.recovery_directory()).await
                {
                    let acknowledgement = async {
                        connection
                            .send(&Message::Acquire {
                                owner,
                                extension_id: config.extension_id().to_owned(),
                            })
                            .await?;
                        connection.receive().await
                    }
                    .await;
                    match acknowledgement {
                        Ok(Some(Message::Ready)) => {
                            let mut lease = Self::watch(connection);
                            lease.recovery = Some((config.clone(), owner));
                            return Ok(lease);
                        }
                        Ok(Some(Message::Failed { message })) => return Err(failed(message)),
                        Ok(None) => {}
                        Err(HandoffError::Ipc(cua_driver_core::browser::IpcError::Io(error)))
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                                    | std::io::ErrorKind::NotConnected
                                    | std::io::ErrorKind::UnexpectedEof
                            ) => {}
                        Err(error) => return Err(failed(error)),
                        _ => return Err(failed("unexpected browser handoff acknowledgement")),
                    }
                }
                let start = match child.as_mut() {
                    Some(child) => child.try_wait().map_err(failed)?.is_some(),
                    None => true,
                };
                if start {
                    let mut command = tokio::process::Command::new(config.executable());
                    command
                        .arg(ENTRY)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::inherit())
                        .kill_on_drop(false);
                    #[cfg(unix)]
                    command.process_group(0);
                    #[cfg(windows)]
                    command.creation_flags(0x01000000 | 0x08000000 | 0x00000200);
                    child = Some(command.spawn().map_err(failed)?);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        };
        tokio::select! {
            _ = cancellation.cancelled() => Err(failed("browser handoff cancelled")),
            result = tokio::time::timeout(STARTUP, operation) => result.map_err(|_| failed("browser handoff did not become ready before the startup deadline"))?,
        }
    }

    pub(crate) fn watch(mut connection: Connection) -> Self {
        let (release, requested) = tokio::sync::oneshot::channel();
        let (finished, completed) = tokio::sync::watch::channel(None);
        tokio::spawn(async move {
            let result = tokio::select! {
                _ = requested => async {
                    connection.send(&Message::Release).await.map_err(failed)?;
                    match connection.receive().await.map_err(failed)? {
                        Some(Message::Released { users }) => Ok(users),
                        Some(Message::Failed { message }) => Err(failed(message)),
                        _ => Err(failed("browser handoff release was not acknowledged")),
                    }
                }.await,
                message = connection.receive() => Err(failed(match message {
                    Ok(None) => "browser handoff supervisor disconnected".to_owned(),
                    Ok(Some(Message::Failed { message })) => message,
                    Ok(Some(_)) => "unexpected message from browser handoff supervisor".to_owned(),
                    Err(error) => error.to_string(),
                })),
            };
            finished.send_replace(Some(result));
        });
        Self {
            release: Some(release),
            completed,
            recovery: None,
        }
    }

    pub(crate) fn is_live(&self) -> bool {
        self.completed.borrow().is_none() && !self.completed.has_changed().is_err()
    }

    pub(crate) async fn release(&mut self) -> Result<usize, ToolError> {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        let operation = async {
            loop {
                if let Some(result) = self.completed.borrow().clone() {
                    return result;
                }
                self.completed
                    .changed()
                    .await
                    .map_err(|_| failed("browser handoff cleanup observer ended"))?;
            }
        };
        let result = tokio::time::timeout(STARTUP, operation)
            .await
            .map_err(|_| failed("browser handoff release acknowledgement timed out"))
            .and_then(|result| result);
        if let (Err(original), Some((config, owner))) = (&result, &self.recovery) {
            let remaining = recover_owner(config, *owner).await.map_err(|recovery| {
                failed(format!("{original}; browser handoff recovery: {recovery}"))
            })?;
            self.completed = tokio::sync::watch::channel(Some(Ok(remaining))).1;
            return Ok(remaining);
        }
        result
    }
}

async fn recover_owner(config: &ConfiguredHandoff, owner: uuid::Uuid) -> Result<usize, ToolError> {
    async fn release(mut connection: Connection, owner: uuid::Uuid) -> Result<usize, ToolError> {
        connection
            .send(&Message::ReleaseOwner { owner })
            .await
            .map_err(failed)?;
        match connection.receive().await.map_err(failed)? {
            Some(Message::Released { users }) => Ok(users),
            Some(Message::Failed { message }) => Err(failed(message)),
            _ => Err(failed("browser handoff recovery was not acknowledged")),
        }
    }
    let recovery = async {
        if let Ok(connection) = Connection::connect(&config.recovery_directory()).await {
            return release(connection, owner).await;
        }
        let mut command = tokio::process::Command::new(config.executable());
        command
            .arg(RESTORE)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x01000000 | 0x08000000 | 0x00000200);
        let status = command.status().await.map_err(failed)?;
        if status.success() {
            return Ok(0);
        }
        // A successor may have acquired the lock while recovery was spawning.
        if let Ok(connection) = Connection::connect(&config.recovery_directory()).await {
            return release(connection, owner).await;
        }
        Err(failed(format!(
            "browser handoff recovery exited with {status}"
        )))
    };
    tokio::time::timeout(STARTUP, recovery)
        .await
        .map_err(failed)?
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
