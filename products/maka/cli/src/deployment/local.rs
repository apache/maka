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

use super::{activation, directory, store};
use maka_event_log::root::{self, FileLease, RootNamespaces, RootOwner};
use maka_host_runtime::HostError;
use maka_host_runtime::{
    application::host::{Client, discovery},
    ipc,
};
use maka_process::detached::{self, Child};
use sha2::{Digest, Sha256};
use std::{io, path::PathBuf, sync::Arc, time::Duration};
use tokio::io::AsyncWriteExt;

mod generation;

type Connection = Client;

#[derive(Default)]
struct UpdateAttempt {
    restarted: bool,
    startup_error: Option<String>,
    launcher: Option<PathBuf>,
    generation: tokio::sync::OnceCell<String>,
}
impl UpdateAttempt {
    async fn generation(&self) -> Result<Option<&str>, HostError> {
        let Some(launcher) = &self.launcher else {
            return Ok(None);
        };
        let generation = self
            .generation
            .get_or_try_init(|| generation::hash(launcher.clone()))
            .await?;
        Ok(Some(generation))
    }
}

/// Interactive startup connects to a live Host or starts one. A newly started
/// Host synchronizes its selected bundled application packages before Ready.
/// The UI calls this only after terminal validation, in a cancellable background job.
pub async fn connect(path: PathBuf) -> Result<Connection, HostError> {
    let launcher = std::env::current_exe()?;
    crate::operation::without_progress(connect_inner(path, None, &launcher)).await
}

pub async fn connect_application(
    request: &maka_host_runtime::application::host::startup::Request,
) -> Result<Connection, HostError> {
    request.validate()?;
    let launcher = std::env::current_exe()?;
    crate::operation::without_progress(connect_inner(
        request.root.clone(),
        Some(request),
        &launcher,
    ))
    .await
}

async fn connect_inner(
    path: PathBuf,
    selection: Option<&maka_host_runtime::application::host::startup::Request>,
    launcher: &std::path::Path,
) -> Result<Connection, HostError> {
    let mut child = None;
    let mut update_attempt = UpdateAttempt {
        launcher: selection.is_none().then(|| launcher.to_owned()),
        ..Default::default()
    };
    let result: Result<Connection, HostError> = async {
        let (_launch, root_id) = loop {
            let root_path = path.clone();
            let result = tokio::task::spawn_blocking(move || {
                let namespaces = RootNamespaces::for_current_account()?;
                let canonical = root::prepare_directory(&root_path)?;
                let key = hex::encode(Sha256::digest(canonical.as_os_str().as_encoded_bytes()));
                root::private_directory(&namespaces.ownership)?;
                // Before initialization there is no Root ID. Serialize launchers
                // for this path through Ready, including partial marker/database
                // publication; the Root writer lease remains the sole authority.
                let launch = FileLease::acquire(
                    &namespaces.ownership.join(format!("tui-launch-{key}.lock")),
                )?;
                let id = root::initialize(&root_path, &namespaces)?;
                launch.validate()?;
                Ok::<_, io::Error>((launch, id))
            })
            .await?;
            match result {
                Ok(initialized) => break initialized,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => pause().await,
                Err(error) => return Err(error.into()),
            }
        };
        if selection
            .and_then(|selection| selection.state_domain.as_ref())
            .is_some_and(|expected| *expected != root_id)
        {
            return Err("State Root differs from the selected application Host".into());
        }
        if let Some(connection) = live(&path, &root_id, selection, &mut update_attempt).await? {
            return Ok(connection);
        }
        let directory = directory(&root_id)?;
        root::private_directory(&directory)?;
        let lease = loop {
            match FileLease::acquire(&directory.join("executor.lock")) {
                Ok(lease) => break Arc::new(lease),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if let Some(connection) =
                        live(&path, &root_id, selection, &mut update_attempt).await?
                    {
                        return Ok(connection);
                    }
                    pause().await;
                }
                Err(error) => return Err(error.into()),
            }
        };
        lease.validate()?;
        if let Some(connection) = live(&path, &root_id, selection, &mut update_attempt).await? {
            return Ok(connection);
        }
        match store::read(&directory).await? {
            store::Installation::Installed(deployment) => {
                let root = root::resolve(&path)?;
                deployment.validate(&root, &directory)?;
                deployment.require_active()?;
                prepare_application(&path, &root_id, selection, &mut update_attempt).await?;
                loop {
                    let (probe, _) = activation::connect_or_launch(&deployment, lease.clone()).await?;
                    // Reuse this launcher's residency session for admission, so
                    // it cannot block its own idle retirement as another client.
                    let anchor = probe.anchor().await?;
                    match observe_live(&path, &root_id, selection, &mut update_attempt, Some(anchor)).await? {
                        Live::Ready(connection) => {
                            lease.validate()?;
                            return Ok(*connection);
                        }
                        Live::Retired => continue,
                        Live::Missing => return Err("Activated Host is unavailable".into()),
                    }
                }
            }
            store::Installation::Incomplete => {
                return Err("Host deployment installation is incomplete".into());
            }
            store::Installation::Missing => {}
        }
        prepare_application(&path, &root_id, selection, &mut update_attempt).await?;
        loop {
            lease.validate()?;
            match observe_live(&path, &root_id, selection, &mut update_attempt, None).await? {
                Live::Ready(connection) => {
                    if let Some(child) = &mut child {
                        release(child).await?;
                    }
                    return Ok(*connection);
                }
                Live::Retired => {
                    if let Some(mut retired) = child.take() {
                        activation::stop_failed_candidate(&mut retired, Duration::from_secs(5)).await?;
                    }
                    continue;
                }
                Live::Missing => {},
            }
            if let Some(child) = &mut child {
                if let Some(status) = child.try_wait()? {
                    return Err(format!("Host candidate exited before Ready: {status}. Read the startup error with maka host logs --root-id {root_id}, resolve it, and retry opening Maka.").into());
                }
            } else {
                match RootOwner::open(&path, &RootNamespaces::for_current_account()?) {
                    Ok(owner) => {
                        if owner.root_id() != root_id {
                            return Err("State Root changed before launch".into());
                        }
                        let canonical = owner.canonical_path().to_owned();
                        let capture =
                            maka_host_runtime::logs::Source::from_owner(&owner)?.open_capture()?;
                        drop(owner);
                        let attempt = uuid::Uuid::new_v4().to_string();
                        let mut arguments = vec![
                                    "host",
                                    "candidate",
                                    "--root",
                                    canonical.to_str().ok_or("State Root must be UTF-8")?,
                                    "--expected-root-id",
                                    &root_id,
                                    "--startup-attempt-id",
                                    &attempt,
                                    "--owner-stdin",
                                    "--initial-connection-timeout-ms",
                                    "30000",
                                ];
                        if let Some(generation) = update_attempt.generation().await? {
                            arguments.extend(["--generation", generation]);
                        }
                        let (program, leading) = super::host_identity::command(launcher).await?;
                        let arguments = leading
                            .iter()
                            .map(String::as_str)
                            .chain(arguments)
                            .collect::<Vec<_>>();
                        child = Some(
                            detached::spawn(
                                &program,
                                &arguments,
                                Some(capture),
                            )
                            .await?,
                        );
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error.into()),
                }
            }
            pause().await;
        }
    }
    .await;
    if result.is_err()
        && let Some(mut child) = child
        && let Err(cleanup) =
            activation::stop_failed_candidate(&mut child, Duration::from_secs(5)).await
    {
        return Err(format!("{}; candidate cleanup: {cleanup}", result.err().unwrap()).into());
    }
    result.map_err(|error| match &update_attempt.startup_error {
        Some(original) => {
            HostError::from(format!("{error}; original Host startup error: {original}"))
        }
        None => error,
    })
}

async fn prepare_application(
    path: &std::path::Path,
    root_id: &str,
    selection: Option<&maka_host_runtime::application::host::startup::Request>,
    update_attempt: &mut UpdateAttempt,
) -> Result<(), HostError> {
    let Some(selection) = selection else {
        return Ok(());
    };
    loop {
        if live(path, root_id, Some(selection), update_attempt)
            .await?
            .is_some()
        {
            return Ok(());
        }
        let root = match RootOwner::open(path, &RootNamespaces::for_current_account()?) {
            Ok(root) => root,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                pause().await;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if root.root_id() != root_id {
            return Err("State Root changed before application preparation".into());
        }
        let store =
            maka_transport::open_store(Arc::new(root), &maka_product_native::root_migrations())
                .await?;
        let result = crate::application::select_committed_host(&store, selection).await;
        store.drain().await;
        return result;
    }
}

async fn pause() {
    tokio::time::sleep(Duration::from_millis(25)).await;
}

async fn release(child: &mut Child) -> Result<(), HostError> {
    child
        .stdin
        .take()
        .ok_or("candidate owner pipe is missing")?
        .write_all(b"{\"kind\":\"runtime-host-launch-owner-release\"}\n")
        .await?;
    Ok(())
}

enum Live {
    Missing,
    Ready(Box<Connection>),
    Retired,
}

async fn live(
    path: &std::path::Path,
    expected_root: &str,
    selection: Option<&maka_host_runtime::application::host::startup::Request>,
    update_attempt: &mut UpdateAttempt,
) -> Result<Option<Connection>, HostError> {
    Ok(
        match observe_live(path, expected_root, selection, update_attempt, None).await? {
            Live::Ready(connection) => Some(*connection),
            Live::Missing | Live::Retired => None,
        },
    )
}

async fn observe_live(
    path: &std::path::Path,
    expected_root: &str,
    selection: Option<&maka_host_runtime::application::host::startup::Request>,
    update_attempt: &mut UpdateAttempt,
    anchor: Option<Connection>,
) -> Result<Live, HostError> {
    // A candidate has not published discovery until database initialization is
    // complete. Do not inspect its transient SQLite startup files as a live root.
    if !RootNamespaces::for_current_account()?
        .control
        .join(expected_root)
        .join("registration.json")
        .try_exists()?
    {
        return Ok(Live::Missing);
    }
    let discovery_path = path.to_owned();
    let discovery =
        match tokio::task::spawn_blocking(move || discovery::read(&discovery_path)).await? {
            Ok(discovery) => discovery,
            Err(error) if absent(&error) => return Ok(Live::Missing),
            Err(error) => return Err(error.into()),
        };
    if discovery.root_id != expected_root {
        return Err("State Root changed during startup".into());
    }
    if selection.is_some_and(|selection| discovery.source.deployment != selection.deployment) {
        return Err("live Host belongs to another application deployment".into());
    }

    let stream = match ipc::connect(&discovery.endpoint).await {
        Ok(stream) => stream,
        Err(error) if error.downcast_ref::<io::Error>().is_some_and(absent) => {
            return Ok(Live::Missing);
        }
        Err(error) => return Err(error),
    };
    let status = Client::status_stream(stream, Some(discovery.host_epoch)).await?;
    discovery.verify(&status)?;
    // The namespace is explicit CLI ownership. Library Hosts, installed
    // deployments and explicit generic selections retain their owners.
    let cli_owned = status.generation.as_deref().is_some_and(|generation| {
        generation
            .strip_prefix("cli-sha256:")
            .is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
    });
    let launcher_owned = selection.is_none()
        && update_attempt.launcher.is_some()
        && status.lifecycle_mode == maka_host_runtime::application::host::LifecycleMode::Ephemeral
        && cli_owned
        && matches!(
            store::read(&directory(expected_root)?).await?,
            store::Installation::Missing
        );
    let code_changed = if launcher_owned {
        status.generation.as_deref() != update_attempt.generation().await?
    } else {
        false
    };

    let mut client = if let Some(mut client) = anchor {
        if client.epoch() != discovery.host_epoch || client.source() != &discovery.source {
            client.close().await?;
            return Err("Host changed during activation admission".into());
        }
        client
    } else {
        let stream = match ipc::connect(&discovery.endpoint).await {
            Ok(stream) => stream,
            Err(error) if error.downcast_ref::<io::Error>().is_some_and(absent) => {
                return Ok(Live::Missing);
            }
            Err(error) => return Err(error),
        };
        Client::connect_stream(&discovery.endpoint, Some(discovery.host_epoch), stream).await?
    };
    let startup_error = client.catalogue().startup_error().map(str::to_owned);
    let available = if code_changed || startup_error.is_some() {
        // A failed Application may have no callable management endpoint. Retry
        // its startup once under the same idle retirement fence, preserving the
        // diagnostic if recovery fails.
        Ok(true)
    } else {
        crate::application::live_update_available(&client).await
    };
    let available = match available {
        Ok(available) => available,
        Err(error) => {
            client.close().await?;
            return Err(error);
        }
    };
    if !available {
        let publication = match crate::application::prepare_live_publication(&client).await {
            Ok(publication) => publication,
            Err(error) => {
                client.close().await?;
                return Err(error);
            }
        };
        match publication {
            crate::application::LivePublication::Current => {
                return Ok(Live::Ready(Box::new(client)));
            }
            crate::application::LivePublication::Updated => {
                // Acquire the new publication before releasing this residency
                // anchor; an ephemeral Host must never observe an idle gap.
                let refreshed =
                    Client::connect(&discovery.endpoint, Some(discovery.host_epoch)).await;
                let mut refreshed = match refreshed {
                    Ok(refreshed) => refreshed,
                    Err(error) => {
                        client.close().await?;
                        return Err(error.into());
                    }
                };
                if let Err(error) = client.close().await {
                    refreshed.close().await?;
                    return Err(error.into());
                }
                return Ok(Live::Ready(Box::new(refreshed)));
            }
        }
    }
    if update_attempt.restarted {
        client.close().await?;
        if let Some(error) = startup_error {
            return Err(format!("Host startup failed after automatic recovery: {error}").into());
        }
        return Err("The restarted Host still uses older bundled applications. Update the managed Host executable, then retry opening Maka.".into());
    }
    update_attempt.startup_error = startup_error;
    // Launcher-owned upgrades cancel the old incarnation's work, including
    // persistent terminals. Other owners retain their idle-only update policy.
    client.close().await?;
    let target_changed = || -> Result<bool, HostError> {
        let current = match discovery::read(path) {
            Ok(current) => current,
            Err(error) if absent(&error) => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if current.root_id != expected_root {
            return Err("State Root changed during automatic application update".into());
        }
        Ok(current.host_epoch != discovery.host_epoch
            || current.source != discovery.source
            || current.generation != discovery.generation
            || current.pid != discovery.pid)
    };
    let target_unavailable = || async {
        match RootOwner::open(path, &RootNamespaces::for_current_account()?) {
            Ok(owner) => {
                if owner.root_id() != expected_root {
                    return Err(HostError::from(
                        "State Root changed during automatic application update",
                    ));
                }
                return Ok(true);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }
        match discovery::read(path) {
            Err(error) if absent(&error) => return Ok(true),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        match ipc::connect(&discovery.endpoint).await {
            Ok(stream) => {
                drop(stream);
                Ok(false)
            }
            Err(error) if error.downcast_ref::<io::Error>().is_some_and(absent) => Ok(true),
            Err(error) => Err(error),
        }
    };
    let retirement_deadline =
        tokio::time::Instant::now() + crate::operation::remaining(Duration::from_secs(30));
    loop {
        if tokio::time::Instant::now() >= retirement_deadline {
            return Err("Host did not reach idle retirement before the operation deadline".into());
        }
        match Client::retire_with_options(
            &discovery.endpoint,
            discovery.host_epoch,
            launcher_owned,
            false,
        )
        .await
        {
            Ok(true) => {
                update_attempt.restarted = true;
                break;
            }
            Ok(false) => {
                // Readiness and failed-activation cleanup do not settle the
                // independent native startup scans. Only the same atomic idle
                // fence may authorize retirement after they finish.
                if target_changed()? {
                    return Ok(Live::Retired);
                }
                let stream = match ipc::connect(&discovery.endpoint).await {
                    Ok(stream) => stream,
                    Err(error) if error.downcast_ref::<io::Error>().is_some_and(absent) => break,
                    Err(error) => return Err(error),
                };
                let status = match Client::status_stream(stream, Some(discovery.host_epoch)).await {
                    Ok(status) => status,
                    Err(error) => {
                        if target_changed()? {
                            return Ok(Live::Retired);
                        }
                        if target_unavailable().await? {
                            break;
                        }
                        return Err(error.into());
                    }
                };
                if status.closing || status.closed {
                    break;
                }
                if discovery.verify(&status).is_err() {
                    return Ok(Live::Retired);
                }
                if let Some(error) = status.cleanup_error {
                    return Err(format!("Host retirement cleanup is unconfirmed: {error}").into());
                }
                if status.sessions != 0 || status.active_calls != 0 {
                    let action = if update_attempt.startup_error.is_some() {
                        "Automatic Host recovery"
                    } else {
                        "Automatic bundled application updating"
                    };
                    return Err(format!("{action} cannot proceed while another Host session or active task remains. Close the other sessions or wait for their work to finish, then retry opening Maka; no manual update command is needed.").into());
                }
                pause().await;
            }
            Err(error) => {
                // The target can exit or be replaced while this request is in
                // flight. Never carry its restart count onto a different Host.
                if target_changed()? {
                    return Ok(Live::Retired);
                }
                if target_unavailable().await? {
                    break;
                }
                return Err(error.into());
            }
        }
    }
    // A retirement acknowledgement is not proof that its writer lease is free.
    loop {
        match RootOwner::open(path, &RootNamespaces::for_current_account()?) {
            Ok(owner) => {
                if owner.root_id() != expected_root {
                    return Err("State Root changed during automatic application update".into());
                }
                return Ok(Live::Retired);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if target_changed()? {
                    return Ok(Live::Retired);
                }
                if tokio::time::Instant::now() >= retirement_deadline {
                    return Err(
                        "Host did not release its writer before the operation deadline".into(),
                    );
                }
                pause().await;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn absent(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}
