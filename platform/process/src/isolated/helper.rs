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

#[cfg(unix)]
use super::Closure;
use super::Manifest;
use crate::Command;
#[cfg(unix)]
use std::time::Duration;
use std::{io, path::Path};
#[cfg(unix)]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Private current-executable role. Never reconstruct a task from a descriptor:
/// create_new owner/started is a one-shot effect fence, not a resumable lease.
pub async fn run_helper(resource: &Path) -> io::Result<i32> {
    if !cfg!(target_os = "macos") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "persistent native task isolation unavailable",
        ));
    }
    let resource = tokio::fs::canonicalize(resource).await?;
    let task_path = resource.join("owner/task.json");
    let task = tokio::fs::try_exists(&task_path).await?;
    let bytes = if task {
        super::write_json_new(
            &resource.join("owner/started.json"),
            &super::Started {
                helper_pid: std::process::id(),
            },
        )
        .await?;
        let material = resource.join("launch/material.json");
        let bytes = tokio::fs::read(&material).await?;
        // Consume launch secrets before any provider process starts. A cold
        // descriptor cannot recreate either the material or the once fence.
        tokio::fs::remove_file(material).await?;
        bytes
    } else {
        tokio::fs::read(resource.join("owner/manifest.json")).await?
    };
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    drop(bytes);
    match manifest {
        Manifest::Snapshot { source, policy } => {
            let dest = resource.clone();
            let proof = tokio::task::spawn_blocking(move || {
                super::snapshot::capture(&source, &dest, &policy)
            })
            .await
            .map_err(io::Error::other)??;
            super::write_json_new(&resource.join("owner/snapshot.json"), &proof).await?;
            Ok(0)
        }
        Manifest::Task {
            executable,
            args,
            environment,
            sandbox,
            size,
            cwd,
        } => {
            let mut command = Command::new(
                executable,
                cwd.unwrap_or_else(|| resource.join("workspace")),
            );
            command.env_clear().args(args);
            #[cfg(target_os = "macos")]
            {
                command.private_stdio = true;
            }
            for (key, value) in environment {
                command.env(key, value);
            }
            let command = command.sandbox(&sandbox).map_err(io::Error::other)?;
            #[cfg(unix)]
            {
                let status = if let Some(size) = size {
                    let (mut child, io) = crate::pty::spawn(command, size)
                        .await
                        .map_err(|e| io::Error::other(e.to_string()))?;
                    let io = std::sync::Arc::new(io);
                    let input = input_pty(io.clone(), &resource).await?;
                    let output = output_pty(io, &resource).await?;
                    let mut controls = Control::new(&resource).await?;
                    loop {
                        tokio::select! {
                            biased;
                            exited = child.root_exited() => break exited?,
                            operation = controls.next() => {
                                let delivered = match operation? {
                                    Operation::Terminate => child.terminate().map(|_| ()),
                                    Operation::Interrupt => child.interrupt_group().map(|_| ()),
                                };
                                if let Err(error) = delivered {
                                    eprintln!("Original private task control failed: {error}");
                                }
                            }
                        }
                    }
                    publish_exited(&resource).await?;
                    let status = child.wait().await?;
                    input.finish().await?;
                    output.await.map_err(io::Error::other)??;
                    child.close().await?;
                    status
                } else {
                    let spawned = crate::pipe::spawn(command)
                        .await
                        .map_err(|e| io::Error::other(e.to_string()))?;
                    let crate::pipe::Spawned {
                        mut child,
                        stdin,
                        stdout,
                        stderr,
                    } = spawned;
                    let input = input_pipe(stdin, &resource).await?;
                    let out = output_pipe(
                        stdout,
                        tokio::io::stdout(),
                        resource.join("owner/stdout.bin"),
                    )
                    .await?;
                    let err = output_pipe(
                        stderr,
                        tokio::io::stderr(),
                        resource.join("owner/stderr.bin"),
                    )
                    .await?;
                    let mut controls = Control::new(&resource).await?;
                    loop {
                        tokio::select! {
                            biased;
                            exited = child.root_exited() => break exited?,
                            operation = controls.next() => {
                                let delivered = match operation? {
                                    Operation::Terminate => child.terminate().await,
                                    Operation::Interrupt => child.interrupt_group().await.map(|_| ()),
                                };
                                if let Err(error) = delivered {
                                    eprintln!("Original private task control failed: {error}");
                                }
                            }
                        }
                    }
                    publish_exited(&resource).await?;
                    let status = child.wait().await?;
                    input.finish().await?;
                    out.await.map_err(io::Error::other)??;
                    err.await.map_err(io::Error::other)??;
                    status
                };
                let original = resource.clone();
                tokio::task::spawn_blocking(move || {
                    let pinned = super::evidence::pin(&original)?;
                    let snapshot = super::evidence::snapshot_identity(&pinned.owner)?;
                    let closure = Closure::GroupClosed {
                        resource: original.clone(),
                        snapshot,
                        exit_code: status.code(),
                        signal: std::os::unix::process::ExitStatusExt::signal(&status),
                        original_group_closed: true,
                        streams_drained: true,
                    };
                    super::publish_proof(&original, "closure.json", &closure)
                })
                .await
                .map_err(io::Error::other)??;
                Ok(status.code().unwrap_or(1))
            }
            #[cfg(not(unix))]
            {
                let _ = (command, size);
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "task owner unavailable",
                ))
            }
        }
    }
}

#[cfg(unix)]
async fn publish_exited(resource: &Path) -> io::Result<()> {
    let resource = resource.to_owned();
    tokio::task::spawn_blocking(move || {
        let pinned = super::evidence::pin(&resource)?;
        let snapshot = super::evidence::snapshot_identity(&pinned.owner)?;
        super::publish_proof(
            &resource,
            "exited.json",
            &super::ChildExited {
                resource: resource.clone(),
                snapshot,
            },
        )
    })
    .await
    .map_err(io::Error::other)?
}

#[cfg(unix)]
async fn log_file(path: impl AsRef<Path>) -> io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).await
}
#[cfg(unix)]
struct InputRelay {
    stop: tokio_util::sync::CancellationToken,
    task: tokio::task::JoinHandle<io::Result<()>>,
}
#[cfg(unix)]
impl InputRelay {
    async fn finish(self) -> io::Result<()> {
        self.stop.cancel();
        self.task.await.map_err(io::Error::other)?
    }
}
#[cfg(unix)]
async fn input_pipe(mut target: crate::pipe::Input, resource: &Path) -> io::Result<InputRelay> {
    let mut log = log_file(resource.join("owner/stdin.bin")).await?;
    let stop = tokio_util::sync::CancellationToken::new();
    let cancelled = stop.clone();
    let task = tokio::spawn(async move {
        let mut source = tokio::io::stdin();
        let mut buffer = [0u8; 16384];
        loop {
            let count = tokio::select! {
                _ = cancelled.cancelled() => break,
                result = source.read(&mut buffer) => result?,
            };
            if count == 0 {
                // Host EOF is observation detachment, never protocol quit.
                cancelled.cancelled().await;
                break;
            }
            log.write_all(&buffer[..count]).await?;
            log.flush().await?;
            if let Err(error) = target.write_all(&buffer[..count]).await {
                if error.kind() == io::ErrorKind::BrokenPipe {
                    break;
                }
                return Err(error);
            }
        }
        log.sync_all().await
    });
    Ok(InputRelay { stop, task })
}
#[cfg(unix)]
async fn output_pipe<R, W>(
    mut source: R,
    mut front: W,
    path: std::path::PathBuf,
) -> io::Result<tokio::task::JoinHandle<io::Result<()>>>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut log = log_file(path).await?;
    Ok(tokio::spawn(async move {
        let mut connected = true;
        let mut buffer = [0u8; 16384];
        loop {
            let count = source.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            let chunk = &buffer[..count];
            log.write_all(chunk).await?;
            log.flush().await?;
            if connected {
                // Buffered stdio can report a detached observer only on flush.
                let forwarded = async {
                    front.write_all(chunk).await?;
                    front.flush().await
                }
                .await;
                if let Err(error) = forwarded {
                    if matches!(
                        error.kind(),
                        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                    ) {
                        connected = false;
                    } else {
                        return Err(error);
                    }
                }
            }
        }
        log.sync_all().await
    }))
}
#[cfg(unix)]
async fn input_pty(
    target: std::sync::Arc<crate::pty::PtyIo>,
    resource: &Path,
) -> io::Result<InputRelay> {
    let mut log = log_file(resource.join("owner/stdin.bin")).await?;
    let stop = tokio_util::sync::CancellationToken::new();
    let cancelled = stop.clone();
    let task = tokio::spawn(async move {
        let mut source = tokio::io::stdin();
        let mut buffer = [0u8; 16384];
        loop {
            let count = tokio::select! {
                _ = cancelled.cancelled() => break,
                result = source.read(&mut buffer) => result?,
            };
            if count == 0 {
                cancelled.cancelled().await;
                break;
            }
            log.write_all(&buffer[..count]).await?;
            log.flush().await?;
            let mut cursor = &buffer[..count];
            while !cursor.is_empty() {
                let n = tokio::select! {
                    _ = cancelled.cancelled() => return log.sync_all().await,
                    result = target.write(cursor) => result?,
                };
                if n == 0 {
                    return Err(io::ErrorKind::WriteZero.into());
                }
                cursor = &cursor[n..];
            }
        }
        log.sync_all().await
    });
    Ok(InputRelay { stop, task })
}
#[cfg(unix)]
async fn output_pty(
    source: std::sync::Arc<crate::pty::PtyIo>,
    resource: &Path,
) -> io::Result<tokio::task::JoinHandle<io::Result<()>>> {
    let mut log = log_file(resource.join("owner/stdout.bin")).await?;
    Ok(tokio::spawn(async move {
        let mut front = tokio::io::stdout();
        let mut connected = true;
        let mut buffer = [0u8; 16384];
        loop {
            let count = source.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            log.write_all(&buffer[..count]).await?;
            log.flush().await?;
            if connected {
                // Buffered stdio can report a detached observer only on flush.
                let forwarded = async {
                    front.write_all(&buffer[..count]).await?;
                    front.flush().await
                }
                .await;
                if let Err(error) = forwarded {
                    if matches!(
                        error.kind(),
                        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                    ) {
                        connected = false;
                    } else {
                        return Err(error);
                    }
                }
            }
        }
        log.sync_all().await
    }))
}

#[cfg(unix)]
enum Operation {
    Terminate,
    Interrupt,
}
#[cfg(unix)]
struct Control {
    directory: std::path::PathBuf,
    seen: u64,
    timer: tokio::time::Interval,
}
#[cfg(unix)]
impl Control {
    async fn new(resource: &Path) -> io::Result<Self> {
        Ok(Self {
            directory: resource.join("owner"),
            seen: 0,
            timer: tokio::time::interval(Duration::from_millis(20)),
        })
    }
    async fn next(&mut self) -> io::Result<Operation> {
        loop {
            self.timer.tick().await;
            let path = self.directory.join(format!("control-{}", self.seen));
            match tokio::fs::read(&path).await {
                Ok(bytes) => {
                    self.seen += 1;
                    return match bytes.as_slice() {
                        b"T" => Ok(Operation::Terminate),
                        b"I" => Ok(Operation::Interrupt),
                        _ => Err(io::Error::other("invalid external task control")),
                    };
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(target_os = "macos")]
enum Publication {
    Ready(u64),
    Pending {
        interrupt: bool,
        work: tokio::task::JoinHandle<(u64, io::Result<()>)>,
    },
    // The worker has ended, but an unknown handoff must never be replayed.
    Failed(std::sync::Arc<tokio::task::JoinError>),
}

#[cfg(target_os = "macos")]
fn publish_control(
    resource: std::path::PathBuf,
    mut next: u64,
    interrupt: bool,
) -> (u64, io::Result<()>) {
    use rustix::fs::{AtFlags, Mode, OFlags, openat, unlinkat};
    use std::{io::Write, os::fd::AsRawFd};
    let result = (|| {
        let successor = next
            .checked_add(1)
            .ok_or_else(|| io::Error::other("private control sequence exhausted"))?;
        let pinned = super::evidence::pin(&resource)?;
        let name = format!("control-{next}");
        let pending = format!(".{name}.pending");
        let mut file: std::fs::File = openat(
            &pinned.owner,
            pending.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )?
        .into();
        let written = (|| {
            file.write_all(if interrupt { b"I" } else { b"T" })?;
            file.sync_all()?;
            let from = std::ffi::CString::new(pending.as_str()).map_err(io::Error::other)?;
            let to = std::ffi::CString::new(name).map_err(io::Error::other)?;
            // SAFETY: the pinned owner FD and owned C strings live through the call;
            // EXCL refuses to overwrite any original control publication.
            if unsafe {
                libc::renameatx_np(
                    pinned.owner.as_raw_fd(),
                    from.as_ptr(),
                    pinned.owner.as_raw_fd(),
                    to.as_ptr(),
                    libc::RENAME_EXCL,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            // Handoff precedes directory durability and cannot be rolled back.
            next = successor;
            pinned.owner.sync_all()
        })();
        match written {
            Err(error) if next != successor => {
                match unlinkat(&pinned.owner, pending.as_str(), AtFlags::empty()) {
                    Ok(()) | Err(rustix::io::Errno::NOENT) => Err(error),
                    Err(cleanup) => Err(io::Error::new(
                        error.kind(),
                        format!("{error}; original control temporary cleanup failed: {cleanup}"),
                    )),
                }
            }
            result => result,
        }
    })();
    (next, result)
}

#[cfg(unix)]
pub(crate) struct ExternalOwner {
    resource: std::path::PathBuf,
    #[cfg(target_os = "macos")]
    publication: Publication,
    checking: Option<tokio::task::JoinHandle<io::Result<bool>>>,
}
#[cfg(unix)]
impl ExternalOwner {
    pub(crate) fn new(resource: std::path::PathBuf) -> Self {
        Self {
            resource,
            #[cfg(target_os = "macos")]
            publication: Publication::Ready(0),
            checking: None,
        }
    }
    /// Join the already admitted effect; cancellation leaves the same handle here.
    pub(crate) async fn settle_control(&mut self) -> io::Result<Option<bool>> {
        #[cfg(target_os = "macos")]
        {
            let (interrupt, completed) = match &mut self.publication {
                Publication::Ready(_) => return Ok(None),
                Publication::Failed(error) => return Err(io::Error::other(error.clone())),
                Publication::Pending { interrupt, work } => (*interrupt, work.await),
            };
            match completed {
                Ok((next, result)) => {
                    self.publication = Publication::Ready(next);
                    result.map(|()| Some(interrupt))
                }
                Err(error) => {
                    let error = std::sync::Arc::new(error);
                    self.publication = Publication::Failed(error.clone());
                    Err(io::Error::other(error))
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(None)
        }
    }
    pub(crate) async fn control(&mut self, interrupt: bool) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        {
            if self.settle_control().await? == Some(interrupt) {
                return Ok(());
            }
            let Publication::Ready(next) = &self.publication else {
                unreachable!("original control joined");
            };
            let next = *next;
            let resource = self.resource.clone();
            self.publication = Publication::Pending {
                interrupt,
                work: tokio::task::spawn_blocking(move || {
                    publish_control(resource, next, interrupt)
                }),
            };
            self.settle_control().await.map(|_| ())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = interrupt;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "private task control unavailable",
            ))
        }
    }
    pub(crate) fn io_settled(&self) -> bool {
        #[cfg(target_os = "macos")]
        if matches!(self.publication, Publication::Pending { .. }) {
            return false;
        }
        self.checking.is_none()
    }
    /// Join only admitted observation/control I/O; never start a closure read or control.
    pub(crate) async fn confirm(&mut self) -> io::Result<()> {
        let result = async {
            if self.checking.is_none() {
                let resource = self.resource.clone();
                self.checking = Some(tokio::task::spawn_blocking(move || {
                    super::evidence::group_closed(&resource)
                }));
            }
            let closed = self.checking.as_mut().expect("original closure read").await;
            self.checking = None;
            if !closed.map_err(io::Error::other)?? {
                return Err(io::Error::other("incomplete owner closure"));
            }
            Ok(())
        }
        .await;
        result.map_err(|error: io::Error| {
            io::Error::other(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
                format!("external task owner closure unconfirmed: {error}"),
            ))
        })
    }
}
