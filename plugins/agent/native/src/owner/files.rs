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

//! Session-bound directory observations; the worker owns watcher settlement.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_capabilities::call::Scope;
use maka_fs_tools::files::{Directory, FileCapture, Watch};
use maka_host_runtime::application::Context;
use std::{io, path::Path};

// The existing readFile byte quantum also targets path-observation batches.
const FILE_STREAM_BYTES: usize = 32 * 1024;

impl Owner {
    pub async fn read_file(
        self: &Arc<Self>,
        input: FileRead,
        context: Context,
    ) -> Result<Value, String> {
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, scope| {
            Box::pin(async move {
                let (original, directory) = owner
                    .file_directory(&input.session_id, None, &scope)
                    .await?;
                let capture = worktrees::blocking(&scope, &owner.stop, move |cancel| {
                    directory
                        .read_file(&input.path, input.expected_version.as_deref(), &cancel)
                        .map_err(file_failure)
                })
                .await;
                owner
                    .check_file_session(&input.session_id, &original, &scope)
                    .await?;
                let snapshot = match capture? {
                    FileCapture::Ready(value) => value,
                    value => {
                        let part = match value {
                            FileCapture::Absent => FileReadPart::Absent,
                            FileCapture::Changed => FileReadPart::Changed,
                            FileCapture::Binary { bytes } => FileReadPart::Binary { bytes },
                            FileCapture::Unsupported { file_kind } => {
                                FileReadPart::Unsupported { file_kind }
                            }
                            FileCapture::Ready(_) => unreachable!("ready capture handled above"),
                        };
                        owner.emit_file_part(part, &context).await?;
                        return Ok(Value::Null);
                    }
                };
                let bytes = snapshot.data.len() as u64;
                owner
                    .emit_file_part(
                        FileReadPart::Begin {
                            version: snapshot.version.clone(),
                            digest: snapshot.digest.clone(),
                            bytes,
                            content: snapshot.content.clone(),
                        },
                        &context,
                    )
                    .await?;
                let text = matches!(snapshot.content, FileContent::Text)
                    .then(|| std::str::from_utf8(&snapshot.data).expect("captured text is UTF-8"));
                let mut offset = 0;
                while offset < snapshot.data.len() {
                    let mut end = (offset + FILE_STREAM_BYTES).min(snapshot.data.len());
                    if let Some(text) = text {
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                    }
                    owner
                        .emit_file_part(
                            FileReadPart::Chunk {
                                offset: offset as u64,
                                data: STANDARD.encode(&snapshot.data[offset..end]),
                            },
                            &context,
                        )
                        .await?;
                    offset = end;
                }
                owner
                    .check_file_session(&input.session_id, &original, &scope)
                    .await?;
                owner
                    .emit_file_part(
                        FileReadPart::End {
                            version: snapshot.version,
                            digest: snapshot.digest,
                            bytes,
                        },
                        &context,
                    )
                    .await?;
                Ok(Value::Null)
            })
        })
        .await
    }

    async fn emit_file_part(&self, part: FileReadPart, context: &Context) -> Result<(), String> {
        if context.scope().cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_files_cancelled".into());
        }
        let value = serde_json::to_value(part).map_err(|_| "agent_files_output_unavailable")?;
        maka_plugin_core::json::exact_numbers(&value)
            .map_err(|_| "agent_files_output_unavailable")?;
        tokio::select! {
            biased;
            _ = context.scope().cancellation.cancelled() => Err("agent_files_cancelled".into()),
            _ = self.stop.cancelled() => Err("agent_files_cancelled".into()),
            result = context.emit(value) => result,
        }
    }

    pub async fn list_files(
        self: &Arc<Self>,
        input: FileListRead,
        scope: &Scope,
    ) -> Result<FilePage, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let (original, directory) = owner
                    .file_directory(&input.session_id, input.path, &scope)
                    .await?;
                let result = worktrees::blocking(&scope, &owner.stop, move |cancel| {
                    directory
                        .list(input.after.as_ref(), &cancel)
                        .map_err(file_failure)
                })
                .await;
                owner
                    .check_file_session(&input.session_id, &original, &scope)
                    .await?;
                result
            })
        })
        .await
    }

    pub async fn file_candidates(
        self: &Arc<Self>,
        input: FileCandidatesRead,
        context: Context,
    ) -> Result<Value, String> {
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, scope| {
            Box::pin(async move {
                let (original, directory) = owner
                    .file_directory(&input.session_id, input.directory, &scope)
                    .await?;
                // One batch can wait for the emitter; its consumer's backpressure
                // stops the filesystem producer without capping the result set.
                let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
                let scan = worktrees::blocking(&scope, &owner.stop, move |cancel| {
                    let mut entries = Vec::new();
                    let mut bytes = 0;
                    directory
                        .candidates(&input.query, &cancel, |entry| {
                            bytes += serde_json::to_vec(&entry)
                                .map_err(io::Error::other)?
                                .len();
                            entries.push(entry);
                            if bytes >= FILE_STREAM_BYTES {
                                sender
                                    .blocking_send(FileCandidates {
                                        entries: std::mem::take(&mut entries),
                                    })
                                    .map_err(|_| io::Error::other("files_cancelled"))?;
                                bytes = 0;
                            }
                            Ok(())
                        })
                        .map_err(file_failure)?;
                    if !entries.is_empty() {
                        sender
                            .blocking_send(FileCandidates { entries })
                            .map_err(|_| "agent_files_cancelled".to_owned())?;
                    }
                    Ok(())
                });
                tokio::pin!(scan);
                let mut completed = None;
                let emitted = loop {
                    let batch = tokio::select! {
                        biased;
                        _ = scope.cancellation.cancelled() => break Err("agent_files_cancelled".to_owned()),
                        _ = owner.stop.cancelled() => break Err("agent_files_cancelled".to_owned()),
                        result = &mut scan, if completed.is_none() => {
                            let failed = result.is_err();
                            completed = Some(result);
                            if failed { break Ok(()); }
                            continue;
                        },
                        batch = receiver.recv() => batch,
                    };
                    let Some(batch) = batch else { break Ok(()) };
                    let value = match serde_json::to_value(batch) {
                        Ok(value) => value,
                        Err(_) => break Err("agent_files_output_unavailable".to_owned()),
                    };
                    let result = tokio::select! {
                        biased;
                        _ = scope.cancellation.cancelled() => Err("agent_files_cancelled".to_owned()),
                        _ = owner.stop.cancelled() => Err("agent_files_cancelled".to_owned()),
                        result = context.emit(value) => result,
                    };
                    if result.is_err() { break result; }
                };
                // Release a producer blocked in blocking_send before waiting for
                // physical worker settlement, including cancellation and errors.
                drop(receiver);
                let scanned = match completed {
                    Some(result) => result,
                    None => scan.await,
                };
                emitted?;
                scanned?;
                owner
                    .check_file_session(&input.session_id, &original, &scope)
                    .await?;
                Ok(Value::Null)
            })
        })
        .await
    }

    pub async fn watch_files(
        self: &Arc<Self>,
        input: FileWatch,
        context: Context,
    ) -> Result<Value, String> {
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, scope| {
            Box::pin(async move {
                let (original, directory) = owner
                    .file_directory(&input.session_id, input.path, &scope)
                    .await?;
                let capture = directory.clone();
                let mut watch = worktrees::blocking(&scope, &owner.stop, move |_| {
                    capture.watch().map_err(file_failure)
                })
                .await?;
                let result = owner
                    .observe_files(
                        &input.session_id,
                        &original,
                        &directory,
                        &mut watch,
                        &context,
                    )
                    .await;
                // Never abandon cleanup when the observer or Owner stops. On
                // supported backends this waits for normal watch/callback
                // quiescence; it does not claim a portable native thread join.
                watch.close().await.map_err(file_failure)?;
                result
            })
        })
        .await
    }

    async fn file_directory(
        &self,
        session: &str,
        path: Option<WorkspacePath>,
        scope: &Scope,
    ) -> Result<(SessionConfiguration, Arc<Directory>), String> {
        if let Some(path) = &path {
            path.validate().map_err(|_| "agent_files_invalid_path")?;
        }
        let original = self.session(session).await?.configuration;
        self.check_file_session(session, &original, scope).await?;
        let root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable")?;
        let private = root.canonical_path().to_owned();
        let control = root.control_directory().to_owned();
        let selected = original.workspace.clone();
        let directory = worktrees::blocking(scope, &self.stop, move |cancel| {
            Directory::open(
                Path::new(&selected.path),
                &selected.directory_identity,
                &private,
                &control,
                selected.worktree.as_deref(),
                path.as_ref(),
                &cancel,
            )
            .map(Arc::new)
            .map_err(file_failure)
        })
        .await?;
        self.check_file_session(session, &original, scope).await?;
        Ok((original, directory))
    }

    async fn check_file_session(
        &self,
        session: &str,
        original: &SessionConfiguration,
        scope: &Scope,
    ) -> Result<(), String> {
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_files_cancelled".into());
        }
        workspace::validate(
            &self.workspace_roots,
            &original.workspace,
            &self.managed_worktrees,
        )
        .await?;
        let current = self.session(session).await?.configuration;
        if current.workspace != original.workspace
            || current.boundary_revision != original.boundary_revision
        {
            return Err("agent_files_changed".into());
        }
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_files_cancelled".into());
        }
        Ok(())
    }

    async fn observe_files(
        &self,
        session: &str,
        original: &SessionConfiguration,
        directory: &Arc<Directory>,
        watch: &mut Watch,
        context: &Context,
    ) -> Result<Value, String> {
        #[cfg(target_os = "macos")]
        let mut snapshot = None;
        let result = async {
            // Subscribe before revalidating the captured Session. Earlier changes
            // are caught by the read; later changes remain pending on this receiver.
            let mut commits = self.store.subscribe_commits();
            commits.borrow_and_update();
            #[cfg(not(all(test, target_os = "macos")))]
            let native_hints = true;
            #[cfg(all(test, target_os = "macos"))]
            let native_hints = self.file_native_hints.load(std::sync::atomic::Ordering::Relaxed);
            #[cfg(target_os = "macos")]
            let mut next_scan;
            #[cfg(target_os = "macos")]
            {
                self.check_file_session(session, original, context.scope()).await?;
                let capture = directory.clone();
                let baseline = worktrees::blocking(context.scope(), &self.stop, move |cancel| {
                    let started = std::time::Instant::now();
                    let current = capture.snapshot(&cancel).map_err(file_failure)?;
                    Ok((current, started.elapsed()))
                }).await;
                let (current, elapsed) = match baseline {
                    Ok(value) => value,
                    Err(error) => {
                        self.check_file_session(session, original, context.scope()).await?;
                        if error == "agent_files_changed" {
                            return self.emit_file_change(FileChange::Unavailable {
                                reason: FileUnavailable::DirectoryChanged,
                            }, context).await;
                        }
                        return Err(error);
                    }
                };
                snapshot = Some(current);
                next_scan = next_file_scan(elapsed);
                self.check_file_session(session, original, context.scope()).await?;
            }
            let mut change = Some(FileChange::Ready {
                directory_identity: directory.directory_identity().clone(),
            });
            loop {
                let capture = directory.clone();
                let valid = worktrees::blocking(context.scope(), &self.stop, move |_| {
                    capture.validate().map_err(file_failure)
                })
                .await;
                self.check_file_session(session, original, context.scope())
                    .await?;
                match valid {
                    Ok(()) => {}
                    Err(error) if error == "agent_files_changed" => {
                        let terminal = FileChange::Unavailable {
                            reason: FileUnavailable::DirectoryChanged,
                        };
                        return self.emit_file_change(terminal, context).await;
                    }
                    Err(error) => return Err(error),
                }
                if let Some(change) = change {
                    self.emit_file_change(change, context).await?;
                }
                change = tokio::select! {
                    biased;
                    _ = context.scope().cancellation.cancelled() => return Err("agent_files_cancelled".into()),
                    _ = self.stop.cancelled() => return Err("agent_files_cancelled".into()),
                    // A due scan precedes advisory/commit traffic. Non-macOS has no
                    // snapshot or timer; this permanently pending branch is inert.
                    _ = async {
                        #[cfg(target_os = "macos")]
                        tokio::time::sleep_until(next_scan).await;
                        #[cfg(not(target_os = "macos"))]
                        std::future::pending::<()>().await;
                    } => {
                        #[cfg(target_os = "macos")]
                        {
                            self.check_file_session(session, original, context.scope()).await?;
                            let capture = directory.clone();
                            let previous = snapshot.take().expect("baseline snapshot");
                            let current = worktrees::blocking(context.scope(), &self.stop, move |cancel| {
                                let started = std::time::Instant::now();
                                let current = capture.snapshot(&cancel).map_err(file_failure)?;
                                let changed = previous != current;
                                drop(previous);
                                Ok((current, changed, started.elapsed()))
                            }).await;
                            let changed = match current {
                                Ok((current, changed, elapsed)) => {
                                    snapshot = Some(current);
                                    next_scan = next_file_scan(elapsed);
                                    Ok(changed)
                                }
                                Err(error) => Err(error),
                            };
                            self.check_file_session(session, original, context.scope()).await?;
                            match changed {
                                Ok(changed) => changed.then_some(FileChange::Changed),
                                Err(error) if error == "agent_files_changed" => {
                                    return self.emit_file_change(FileChange::Unavailable {
                                        reason: FileUnavailable::DirectoryChanged,
                                    }, context).await;
                                }
                                Err(error) => return Err(error),
                            }
                        }
                        #[cfg(not(target_os = "macos"))]
                        unreachable!("reconciliation is macOS only")
                    },
                    result = watch.changed(), if native_hints => {
                        // A native observation failure ends the stream. Reconnect
                        // starts with a fresh read, never an invented replay cursor.
                        result.map_err(file_failure)?;
                        Some(FileChange::Changed)
                    },
                    result = commits.changed() => {
                        result.map_err(|_| "agent_observation_closed")?;
                        commits.borrow_and_update();
                        None
                    },
                };
            }
        }.await;
        #[cfg(target_os = "macos")]
        if let Some(snapshot) = snapshot.take() {
            worktrees::blocking(context.scope(), &self.stop, move |_| {
                drop(snapshot);
                Ok(())
            })
            .await?;
        }
        result
    }

    async fn emit_file_change(
        &self,
        change: FileChange,
        context: &Context,
    ) -> Result<Value, String> {
        let value = serde_json::to_value(change).map_err(|_| "agent_files_output_unavailable")?;
        tokio::select! {
            biased;
            _ = context.scope().cancellation.cancelled() => Err("agent_files_cancelled".into()),
            _ = self.stop.cancelled() => Err("agent_files_cancelled".into()),
            result = context.emit(value.clone()) => {
                result?;
                Ok(value)
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn next_file_scan(elapsed: std::time::Duration) -> tokio::time::Instant {
    // Keep small active directories fresh. Large scans rest for nine times
    // their duration, targeting 10% scan duty per subscription rather than
    // consuming a core continuously; native hints remain active between scans.
    let pause = std::time::Duration::from_secs(1).max(elapsed.saturating_mul(9));
    tokio::time::Instant::now() + pause
}

// Only backend-owned static causes cross the service boundary. OS paths and
// arbitrary error Display strings never become a client error or log payload.
fn file_failure(error: io::Error) -> String {
    let cause = match error.to_string().as_str() {
        "files_invalid_path" => "agent_files_invalid_path",
        "files_invalid_cursor" => "agent_files_invalid_cursor",
        "files_private" => "agent_files_private",
        "files_changed" => "agent_files_changed",
        "files_cancelled" => "agent_files_cancelled",
        "files_watch_unavailable" => "agent_files_watch_unavailable",
        _ => "agent_files_unavailable",
    };
    if cause != "agent_files_cancelled" {
        tracing::warn!(stage = "files_read", cause, io_kind = ?error.kind(),
            os_code = error.raw_os_error(), "Workspace file observation failed");
    }
    cause.into()
}
