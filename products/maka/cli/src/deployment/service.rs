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

use super::Deployment;
use maka_event_log::root::{FileLease, RootOwner};
use maka_host_runtime::HostError;
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Host,
    Updater,
}

mod status;
pub(super) use status::{Observation, State, observe};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

/// The worker owns both leases until their actual effects finish, even if the
/// caller stops awaiting it. A service definition is only a projection of Active.
pub(super) async fn start(
    deployment: Deployment,
    lease: Arc<FileLease>,
    owner: RootOwner,
) -> Result<(), HostError> {
    tokio::task::spawn_blocking(move || {
        lease.validate()?;
        owner.validate_current()?;
        if owner.root_id() != deployment.root_id {
            return Err("State Root changed before service activation".into());
        }
        let service = platform::Service::new(&deployment, Role::Host)?;
        // Root is held: an OS restart cannot begin user work during replacement.
        service.prepare()?;
        owner.validate_current()?;
        drop(owner);
        service.start()?;
        lease.validate()?;
        Ok::<_, HostError>(())
    })
    .await?
}

pub(super) async fn stop(
    deployment: Deployment,
    lease: Arc<FileLease>,
    owner: Arc<RootOwner>,
) -> Result<(), HostError> {
    change(deployment, lease, owner, false).await
}

pub(super) async fn remove(
    deployment: Deployment,
    lease: Arc<FileLease>,
    owner: Arc<RootOwner>,
) -> Result<(), HostError> {
    change(deployment, lease, owner, true).await
}

async fn change(
    deployment: Deployment,
    lease: Arc<FileLease>,
    owner: Arc<RootOwner>,
    remove: bool,
) -> Result<(), HostError> {
    if deployment.mode == super::Mode::OnDemand {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        lease.validate()?;
        owner.validate_current()?;
        if owner.root_id() != deployment.root_id || owner.canonical_path() != deployment.root_path {
            return Err("State Root changed before service control".into());
        }
        let service = platform::Service::new(&deployment, Role::Host)?;
        if remove {
            service.remove()?;
        } else {
            service.stop()?;
        }
        owner.validate_current()?;
        lease.validate()?;
        Ok::<_, HostError>(())
    })
    .await?
}

fn arguments(deployment: &Deployment, role: Role) -> Result<[&str; 5], HostError> {
    let executable = deployment
        .executable
        .to_str()
        .ok_or("service executable must be UTF-8")?;
    if executable.chars().any(char::is_control) {
        return Err("service paths cannot contain control characters".into());
    }
    Ok([
        executable,
        "host",
        match role {
            Role::Host => "service-run",
            Role::Updater => "auto-update",
        },
        "--root-id",
        &deployment.root_id,
    ])
}

fn label(deployment: &Deployment, role: Role) -> String {
    let suffix = if role == Role::Updater { ".update" } else { "" };
    format!("org.apache.maka.host.{}{suffix}", deployment.root_id)
}

pub(super) async fn schedule(
    deployment: Deployment,
    enabled: bool,
    lease: Arc<FileLease>,
) -> Result<(), HostError> {
    tokio::task::spawn_blocking(move || {
        lease.validate()?;
        let service = platform::Service::new(&deployment, Role::Updater)?;
        if enabled {
            service.prepare()?
        } else {
            service.remove()?
        }
        lease.validate()?;
        Ok::<_, HostError>(())
    })
    .await?
}

#[cfg(any(target_os = "macos", windows))]
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(unix)]
fn command(program: &str, args: &[&str]) -> Result<std::process::Output, HostError> {
    Ok(std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()?)
}

#[cfg(unix)]
fn checked(output: std::process::Output) -> Result<String, HostError> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "service manager failed ({}): {}",
            output.status,
            stderr.chars().take(2048).collect::<String>()
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

#[cfg(unix)]
fn publish(path: &std::path::Path, contents: &str) -> Result<(), HostError> {
    use std::io::Write;
    let parent = path.parent().ok_or("service definition has no parent")?;
    std::fs::create_dir_all(parent)?;
    match path.symlink_metadata() {
        Ok(metadata) if !metadata.is_file() => {
            return Err("service definition is not a regular file".into());
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(contents.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}
