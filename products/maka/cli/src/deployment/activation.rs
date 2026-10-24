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

use super::{Deployment, Mode, RootId, directory, store};
use crate::host_client::{HostClient, LiveHost};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::Args;
use maka_event_log::root::{self, FileLease, RootNamespaces, RootOwner};
use maka_host_runtime::HostError;
use maka_process::detached::{self, Child};
use serde::Serialize;
use std::{
    io::Write,
    num::{NonZeroU16, NonZeroU32},
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Args)]
pub(crate) struct Activate {
    #[arg(long)]
    root_id: RootId,
    #[arg(long)]
    framed: bool,
    /// Confirm the same Linux filesystem was remounted, preserving root identity.
    #[arg(long)]
    repair_root_after_remount: bool,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Frame {
    Result {
        schema_version: u8,
        deployment_id: Uuid,
        config_revision: u64,
        root_id: String,
        host_epoch: String,
        pid: NonZeroU32,
        protocol_version: u32,
        endpoint: Endpoint,
    },
    Error {
        schema_version: u8,
        error: Failure,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    host: &'static str,
    port: NonZeroU16,
    websocket_path: &'static str,
}

#[derive(Serialize)]
struct Failure {
    code: &'static str,
    message: String,
}

impl Activate {
    pub async fn run(self) -> Result<(), HostError> {
        let result = self.activate().await;
        if let Err(error) = &result
            && self.framed
        {
            let mut message = error.to_string();
            message.truncate(message.floor_char_boundary(2048));
            emit(
                &Frame::Error {
                    schema_version: 1,
                    error: Failure {
                        code: "activation_failed",
                        message,
                    },
                },
                true,
            )?;
        }
        result
    }

    async fn activate(&self) -> Result<(), HostError> {
        crate::operation::check()?;
        crate::operation::progress(crate::operation::Phase::Activate, None, None);
        if !self.repair_root_after_remount {
            super::update::recover_pending(&self.root_id).await?;
        }
        let (deployment, lease) = prepare(&self.root_id, self.repair_root_after_remount).await?;
        let (client, live) = connect_or_launch(&deployment, lease.clone()).await?;
        let anchor = client.anchor().await?;
        lease.validate()?;
        emit(
            &Frame::Result {
                schema_version: 1,
                deployment_id: deployment.deployment_id,
                config_revision: deployment.config_revision,
                root_id: deployment.root_id,
                host_epoch: live.epoch,
                pid: live.pid,
                protocol_version: maka_host_runtime::application::host::VERSION,
                endpoint: Endpoint {
                    host: "127.0.0.1",
                    port: live.port,
                    websocket_path: "/runtime-host",
                },
            },
            self.framed,
        )?;
        // Keep the transport resident until the complete result has been flushed.
        drop(anchor);
        Ok(())
    }
}

pub(super) async fn prepare(
    root_id: &RootId,
    repair: bool,
) -> Result<(Deployment, Arc<FileLease>), HostError> {
    let directory = directory(&root_id.0)?;
    // Activation never creates a deployment database.
    if !directory.is_dir() {
        return Err("Host deployment is not installed".into());
    }
    let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock"))?);
    let store::Installation::Installed(deployment) = store::read(&directory).await? else {
        return Err("Host deployment is absent or incomplete".into());
    };
    deployment.validate_record(&directory)?;
    deployment.require_active()?;
    if deployment.root_id != root_id.0 {
        return Err("deployment root identity changed".into());
    }
    if repair {
        let path = deployment.root_path.clone();
        let expected = root_id.0.clone();
        let lease = lease.clone();
        tokio::task::spawn_blocking(move || {
            lease.validate()?;
            if path.canonicalize()? != path {
                return Err(std::io::Error::other("deployment root path was rebound"));
            }
            root::repair_after_remount(&path, &expected, &RootNamespaces::for_current_account()?)?;
            lease.validate()
        })
        .await??;
    }
    let root = root::resolve(&deployment.root_path)?;
    if root.root_id() != root_id.0 {
        return Err("deployment root identity changed".into());
    }
    deployment.validate(&root, &directory)?;
    lease.validate()?;
    Ok((deployment, lease))
}

pub(super) async fn connect_or_launch(
    deployment: &Deployment,
    lease: Arc<FileLease>,
) -> Result<(HostClient, LiveHost), HostError> {
    deployment.require_active()?;
    let mut child: Option<Child> = None;
    let mut service_started = false;
    let deadline = crate::operation::deadline();
    let diagnostics_budget = if deployment.mode == Mode::Supervised {
        deadline
            .map(|deadline| deadline.saturating_duration_since(tokio::time::Instant::now()) / 10)
            .unwrap_or(Duration::from_secs(2))
            .min(Duration::from_secs(2))
    } else {
        Duration::ZERO
    };
    let connect = async {
        loop {
            if let Ok(mut client) =
                HostClient::connect(&deployment.root_path, Some(&deployment.generation())).await
            {
                let live = client.live_host(deployment.websocket.port()).await?;
                if let Some(child) = &mut child {
                    let mut owner = child
                        .stdin
                        .take()
                        .ok_or("candidate owner pipe is missing")?;
                    owner
                        .write_all(b"{\"kind\":\"runtime-host-launch-owner-release\"}\n")
                        .await?;
                }
                return Ok::<_, HostError>((client, live));
            }
            if let Some(child) = &mut child {
                if let Some(status) = child.try_wait()? {
                    return Err(format!("Host candidate exited before Ready: {status}. Read the startup error with maka host logs --root-id {}, resolve it, and retry opening Maka.", deployment.root_id).into());
                }
            } else if service_started {
                use super::service::{Observation, State};
                match super::service::observe(deployment.clone()).await {
                    Observation::Present {
                        state: State::Running,
                        ..
                    } => {}
                    #[cfg(any(target_os = "linux", windows))]
                    Observation::Present {
                        state: State::Starting,
                        ..
                    } => {}
                    observation => {
                        return Err(format!(
                            "Host service stopped before Ready: {}",
                            serde_json::to_string(&observation)?
                        )
                        .into());
                    }
                }
            } else {
                match RootOwner::open(
                    &deployment.root_path,
                    &RootNamespaces::for_current_account()?,
                ) {
                    Ok(owner) => {
                        if owner.root_id() != deployment.root_id {
                            return Err("State Root changed before launch".into());
                        }
                        if deployment.mode == Mode::Supervised {
                            super::service::start(deployment.clone(), lease.clone(), owner).await?;
                            service_started = true;
                        } else {
                            let capture = maka_host_runtime::logs::Source::from_owner(&owner)?
                                .open_capture()?;
                            drop(owner);
                            child = Some(
                                detached::spawn(
                                    &deployment.executable,
                                    &[
                                        "host",
                                        "candidate",
                                        "--root",
                                        deployment
                                            .root_path
                                            .to_str()
                                            .ok_or("State Root must be UTF-8")?,
                                        "--expected-root-id",
                                        &deployment.root_id,
                                        "--startup-attempt-id",
                                        &Uuid::new_v4().to_string(),
                                        "--owner-stdin",
                                        "--initial-connection-timeout-ms",
                                        "30000",
                                    ],
                                    Some(capture),
                                )
                                .await?,
                            );
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error.into()),
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    let result = if let Some(deadline) = deadline {
        tokio::time::timeout_at(deadline - diagnostics_budget, connect)
            .await
            .map_err(|_| {
                HostError::from("Host did not become Ready before the activation deadline")
            })
            .and_then(|result| result)
    } else {
        connect.await
    };

    match result {
        Ok(connected) => Ok(connected),
        Err(error) => {
            if deployment.mode == Mode::Supervised {
                return Err(super::diagnostics::startup_failure(
                    deployment,
                    error,
                    deadline.unwrap_or_else(|| tokio::time::Instant::now() + diagnostics_budget),
                    diagnostics_budget,
                )
                .await);
            }
            if let Some(mut child) = child
                && let Err(cleanup) =
                    stop_failed_candidate(&mut child, Duration::from_secs(5)).await
            {
                return Err(format!("{error}; candidate cleanup: {cleanup}").into());
            }
            Err(error)
        }
    }
}

pub(super) async fn stop_failed_candidate(
    child: &mut Child,
    grace: Duration,
) -> Result<(), HostError> {
    // EOF asks for normal drain; it does not prove rollback or safe termination.
    drop(child.stdin.take());
    crate::operation::progress(crate::operation::Phase::Cleanup, None, None);
    if let Ok(result) = tokio::time::timeout(crate::operation::remaining(grace), child.wait()).await
    {
        result?;
        return Ok(());
    }
    // Startup may already have recovered accepted effects. Owning the launcher
    // is not evidence that force termination is safe; retain its writer lease.
    Err("candidate drain is unconfirmed; State Root remains authoritative".into())
}

fn emit(frame: &Frame, framed: bool) -> Result<(), HostError> {
    let bytes = serde_json::to_vec(frame)?;
    let line = if framed {
        let encoded = URL_SAFE_NO_PAD.encode(bytes);
        if encoded.len() > 16 * 1024 {
            return Err("activation frame exceeds its limit".into());
        }
        format!("MAKA_RUNTIME_HOST_ACTIVATION_V1 {encoded}\n")
    } else {
        format!("{}\n", String::from_utf8(bytes)?)
    };
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(line.as_bytes())?;
    stdout.flush()?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failed_candidate_drains_or_reports_unconfirmed_without_killing_its_authority() {
        // No descendants: each child is either an EOF-driven reader or exec'd sleep.
        for (command, graceful) in [("read line; exit 0", true), ("exec sleep 60", false)] {
            let mut child =
                detached::spawn(std::path::Path::new("/bin/sh"), &["-c", command], None)
                    .await
                    .unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                stop_failed_candidate(&mut child, Duration::from_millis(250)),
            )
            .await
            .unwrap();
            if graceful {
                result.unwrap();
                assert!(child.try_wait().unwrap().unwrap().success());
            } else {
                assert!(result.unwrap_err().to_string().contains("unconfirmed"));
                assert!(child.try_wait().unwrap().is_none());
                // Only the test knows this is an inert sleep with no effects.
                child.start_kill().unwrap();
                child.wait().await.unwrap();
            }
        }
    }
}
