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
                        child = Some(
                            detached::spawn(
                                launcher,
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
        let store = maka_transport::open_store(Arc::new(root)).await?;
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
            crate::application::LivePublication::Restart => {}
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::ProductHost;
    use maka_host_runtime::application::host::{Configuration, Host, Options};
    use maka_packages::Package;
    use tokio_util::sync::CancellationToken;

    fn catalog_transport() -> std::sync::Arc<dyn maka_agent_ports::model::Transport> {
        struct Unavailable;
        impl maka_agent_ports::model::Transport for Unavailable {
            fn identity(&self) -> u64 {
                0
            }
            fn request(
                &self,
                _: maka_capabilities::http::Request,
                _: tokio_util::sync::CancellationToken,
            ) -> futures_util::future::BoxFuture<
                '_,
                Result<maka_capabilities::http::Response, maka_agent_ports::model::Error>,
            > {
                Box::pin(async {
                    Err(maka_agent_ports::model::Error::Adapter(
                        "public catalog network is not part of this fixture".into(),
                    ))
                })
            }
            fn connect(
                &self,
                _: maka_agent_ports::model::Connect,
            ) -> futures_util::future::BoxFuture<
                '_,
                Result<
                    std::sync::Arc<dyn maka_agent_ports::model::Socket>,
                    maka_agent_ports::model::Error,
                >,
            > {
                Box::pin(async {
                    Err(maka_agent_ports::model::Error::Adapter(
                        "public catalog does not use WebSockets".into(),
                    ))
                })
            }
        }
        std::sync::Arc::new(Unavailable)
    }

    async fn serve_fixture(
        endpoint: crate::endpoint::LocalEndpoint,
        mut product: ProductHost,
        stop: CancellationToken,
        websocket: Option<maka_host_runtime::application::host::websocket::WebSocketListener>,
    ) -> Result<(), String> {
        // Retain the socket directory without the process entrypoint's exit
        // watchdog, since several Hosts share this test process.
        let result = product
            .host
            .clone()
            .serve(endpoint.listener, websocket, stop)
            .await;
        let cleanup = product.shutdown().await.map_err(|error| error.to_string());
        result.and(cleanup)
    }

    type ServedProduct = (
        String,
        uuid::Uuid,
        CancellationToken,
        tokio::task::JoinHandle<()>,
    );

    enum DesiredRevision {
        CurrentPackages,
        ConfigurationOnly,
    }

    async fn serve_product(
        root: &std::path::Path,
        old: bool,
        broken: bool,
        generation: Option<String>,
    ) -> ServedProduct {
        serve_product_with_desired(root, old, broken, generation, None).await
    }

    async fn serve_product_with_desired(
        root: &std::path::Path,
        old: bool,
        broken: bool,
        generation: Option<String>,
        desired: Option<DesiredRevision>,
    ) -> ServedProduct {
        let namespaces = RootNamespaces::for_current_account().unwrap();
        if !root.exists() {
            let mut host = crate::application::open_host(
                RootOwner::create(root, &namespaces).unwrap(),
                Options::default(),
                crate::application::Roots::Configured(Some(vec![])),
                Some(catalog_transport()),
            )
            .await
            .unwrap();
            host.shutdown().await.unwrap();
            drop(host);
        }
        let store = Arc::new(
            maka_transport::open_store(Arc::new(RootOwner::open(root, &namespaces).unwrap()))
                .await
                .unwrap(),
        );
        let record = store.application_launch().await.unwrap().unwrap();
        let mut loaded = store
            .load_application(record.deployment)
            .await
            .unwrap()
            .unwrap();
        if old {
            let settings = loaded
                .packages()
                .iter()
                .find(|package| package.application_ref().id == "maka.agent.settings")
                .unwrap();
            let mut files = settings.files().clone();
            files.insert(
                "previous-build.txt".into(),
                b"Older selected package".to_vec(),
            );
            if broken {
                let mut manifest: serde_json::Value =
                    serde_json::from_slice(&files["maka.extension.json"]).unwrap();
                manifest["application"]["host"]["implementation"]["implementation"] =
                    serde_json::json!("example.FailingSettings");
                files.insert(
                    "maka.extension.json".into(),
                    serde_json::to_vec(&manifest).unwrap(),
                );
            }
            let previous = Package::new(files).unwrap();
            let mut input = loaded.source().input.clone();
            input.instances.get_mut("settings").unwrap().package =
                previous.application_ref().into();
            let packages = loaded
                .packages()
                .iter()
                .map(|package| {
                    if package.application_ref() == settings.application_ref() {
                        previous.clone()
                    } else {
                        package.clone()
                    }
                })
                .collect();
            store
                .commit_application(
                    record.deployment,
                    loaded.source().reference.revision,
                    input,
                    vec![],
                    packages,
                )
                .await
                .unwrap();
            loaded = store
                .load_application(record.deployment)
                .await
                .unwrap()
                .unwrap();
        } else {
            // Merely installed older bytes must not trigger a restart when no
            // instance or override selects them.
            let mut files = loaded.packages()[0].files().clone();
            files.insert(
                "unselected-build.txt".into(),
                b"Unselected older package".to_vec(),
            );
            let mut packages = loaded.packages().to_vec();
            packages.push(Package::new(files).unwrap());
            store
                .commit_application(
                    record.deployment,
                    loaded.source().reference.revision,
                    loaded.source().input.clone(),
                    vec![],
                    packages,
                )
                .await
                .unwrap();
            loaded = store
                .load_application(record.deployment)
                .await
                .unwrap()
                .unwrap();
        }
        if let Some(desired) = desired {
            let mut input = loaded.source().input.clone();
            let mut packages = loaded.packages().to_vec();
            match desired {
                DesiredRevision::CurrentPackages => {
                    let mut reference = loaded.source().reference.clone();
                    reference.revision = 1;
                    let initial = store
                        .load_application_at(&reference)
                        .await
                        .unwrap()
                        .unwrap();
                    let settings = initial
                        .packages()
                        .iter()
                        .find(|package| package.application_ref().id == "maka.agent.settings")
                        .unwrap()
                        .clone();
                    input.instances.get_mut("settings").unwrap().package =
                        settings.application_ref().into();
                    packages.push(settings);
                }
                DesiredRevision::ConfigurationOnly => {
                    input
                        .instances
                        .get_mut("settings")
                        .unwrap()
                        .configuration
                        .values
                        .insert("locale".into(), serde_json::json!("zh-CN"));
                }
            }
            store
                .commit_application(
                    record.deployment,
                    loaded.source().reference.revision,
                    input,
                    vec![],
                    packages,
                )
                .await
                .unwrap();
            // Start the incarnation from its exact frozen snapshot even though
            // the desired head is newer. No sleep or adoption timing is needed.
        }
        let publication = serde_json::from_value(record.configuration).unwrap();
        let configuration = maka_config::ConfigurationStore::for_root(store.owned_root().unwrap())
            .await
            .unwrap();
        let catalog = maka_product_native::catalog::RuntimeCatalog::with_transport(
            configuration,
            catalog_transport(),
        )
        .await
        .unwrap();
        // Deliberately model an already running older Host, bypassing the new
        // executable's startup synchronization only when building this fixture.
        let host = Host::open_loaded_with_options(
            store.clone(),
            loaded,
            {
                let mut native = maka_host_runtime::application::NativeRegistry::default();
                maka_product_native::provide(&mut native, catalog.catalog()).unwrap();
                native
                    .insert(
                        "example.FailingSettings".into(),
                        Arc::new(|_, _| {
                            Box::pin(async {
                                maka_host_runtime::application::NativeActivation {
                                    exports: Err(
                                        "fixture: outdated settings native contract".into()
                                    ),
                                    owner: Arc::new(()),
                                }
                            })
                        }),
                    )
                    .unwrap();
                native
            },
            Some(maka_host_js::factory(Default::default())),
            publication,
            Options {
                generation: generation.clone(),
                lifecycle_mode: if generation
                    .as_deref()
                    .is_some_and(|generation| generation.starts_with("cli-sha256:"))
                {
                    maka_host_runtime::application::host::LifecycleMode::Ephemeral
                } else {
                    maka_host_runtime::application::host::LifecycleMode::Service
                },
                ..Options::default()
            },
        )
        .await
        .unwrap();
        let host = ProductHost::admitted(host, catalog);
        drop(store);
        let endpoint = crate::endpoint::LocalEndpoint::bind().unwrap();
        let websocket = if generation.is_some() {
            Some(
                maka_host_runtime::application::host::websocket::WebSocketListener::bind(
                    "127.0.0.1:0".parse().unwrap(),
                    vec![],
                )
                .await
                .unwrap(),
            )
        } else {
            None
        };
        let registration = host
            .host
            .publish_registration(
                &endpoint.path,
                websocket
                    .as_ref()
                    .map(|listener| listener.local_addr().unwrap()),
            )
            .unwrap();
        let root_id = host.host.root_id().to_owned();
        let epoch = host.host.epoch();
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let server = tokio::spawn(async move {
            serve_fixture(endpoint, host, stopped, websocket)
                .await
                .unwrap();
            registration.remove().unwrap();
        });
        (root_id, epoch, stop, server)
    }

    #[cfg(unix)]
    fn watch_fixture_owner(stop: CancellationToken) {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let mut bytes = Vec::new();
            let read = std::io::stdin().lock().read_until(b'\n', &mut bytes);
            if read.is_err()
                || !serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| {
                    value == serde_json::json!({"kind":"runtime-host-launch-owner-release"})
                })
            {
                stop.cancel();
            }
        });
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cold_start_candidate_process_fixture() {
        let Some(root) = std::env::var_os("MAKA_DEFAULTS_FIXTURE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let generation = std::env::var("MAKA_DEFAULTS_FIXTURE_GENERATION")
            .ok()
            .filter(|value| !value.is_empty());
        let attempts = root.with_file_name("fixture-candidate-attempts");
        let previous = match std::fs::read_to_string(&attempts) {
            Ok(value) => value.parse::<u32>().unwrap(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(error) => panic!("candidate counter unavailable: {error}"),
        };
        let attempt = previous.checked_add(1).unwrap();
        std::fs::write(&attempts, attempt.to_string()).unwrap();
        let first = attempt == 1;
        let code_only = std::env::var("MAKA_DEFAULTS_FIXTURE_CODE_ONLY").as_deref() == Ok("1");
        let mut incarnation_generation = generation.clone();
        if code_only && first {
            let stale = incarnation_generation.as_mut().expect("CLI generation");
            let last = stale.pop().unwrap();
            stale.push(if last == '0' { '1' } else { '0' });
        }
        let options = Options {
            generation: incarnation_generation,
            lifecycle_mode: if code_only {
                maka_host_runtime::application::host::LifecycleMode::Ephemeral
            } else {
                maka_host_runtime::application::host::LifecycleMode::Service
            },
            ..Options::default()
        };
        let mut host = crate::application::open_host(
            RootOwner::open(&root, &RootNamespaces::for_current_account().unwrap()).unwrap(),
            options,
            crate::application::Roots::Configured(Some(vec![])),
            Some(catalog_transport()),
        )
        .await
        .unwrap();
        if first && !code_only {
            host.shutdown().await.unwrap();
            drop(host);
            let (_, _, stop, mut server) = serve_product(&root, true, true, generation).await;
            watch_fixture_owner(stop.clone());
            if tokio::time::timeout(Duration::from_secs(45), &mut server)
                .await
                .is_err()
            {
                stop.cancel();
                server.await.unwrap();
                panic!("launcher did not retire the failed candidate");
            }
        } else {
            let endpoint = crate::endpoint::LocalEndpoint::bind().unwrap();
            let websocket = if generation.is_some() {
                Some(
                    maka_host_runtime::application::host::websocket::WebSocketListener::bind(
                        "127.0.0.1:0".parse().unwrap(),
                        vec![],
                    )
                    .await
                    .unwrap(),
                )
            } else {
                None
            };
            let registration = host
                .host
                .publish_registration(
                    &endpoint.path,
                    websocket
                        .as_ref()
                        .map(|listener| listener.local_addr().unwrap()),
                )
                .unwrap();
            let stop = CancellationToken::new();
            watch_fixture_owner(stop.clone());
            tokio::time::timeout(
                Duration::from_secs(45),
                serve_fixture(endpoint, host, stop, websocket),
            )
            .await
            .unwrap()
            .unwrap();
            registration.remove().unwrap();
        }
    }

    #[cfg(unix)]
    async fn cold_launcher_recovers_its_candidate(managed: bool, code_only: bool) {
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("host");
        let owner =
            RootOwner::create(&root_path, &RootNamespaces::for_current_account().unwrap()).unwrap();
        let root_path = owner.canonical_path().to_owned();
        let root_id = owner.root_id().to_owned();
        let deployment_id = uuid::Uuid::new_v4();
        let generation = if managed {
            format!("{deployment_id}:1")
        } else {
            String::new()
        };
        let executable = std::env::current_exe().unwrap();
        let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
        let script = format!(
            "#!/bin/sh\nexport MAKA_DEFAULTS_FIXTURE_ROOT=\"$4\"\nexport MAKA_DEFAULTS_FIXTURE_GENERATION={}\nexport MAKA_DEFAULTS_FIXTURE_CODE_ONLY={}\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --generation ]; then\n    shift\n    export MAKA_DEFAULTS_FIXTURE_GENERATION=\"$1\"\n    break\n  fi\n  shift\ndone\nexec {} --exact deployment::local::tests::cold_start_candidate_process_fixture --nocapture\n",
            quote(&generation),
            if code_only { "1" } else { "0" },
            quote(executable.to_str().unwrap())
        );
        let launcher = temporary.path().join("launcher");
        std::fs::write(&launcher, &script).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        let deployment_directory = directory(&root_id).unwrap();
        if managed {
            root::private_directory(&deployment_directory).unwrap();
            let lease =
                Arc::new(FileLease::acquire(&deployment_directory.join("executor.lock")).unwrap());
            let digest = hex::encode(Sha256::digest(script.as_bytes()));
            let packaged = super::super::package::path(&deployment_directory, &digest);
            root::private_directory(packaged.parent().unwrap()).unwrap();
            std::fs::copy(&launcher, &packaged).unwrap();
            let deployment = super::super::Deployment {
                deployment_id,
                config_revision: 1,
                root_id: root_id.clone(),
                root_path: root_path.clone(),
                executable: packaged,
                sha256: digest,
                mode: super::super::Mode::OnDemand,
                websocket: "127.0.0.1:0".parse().unwrap(),
                project_directory_roots: Some(vec![]),
                admission: super::super::Admission::Active,
            };
            store::install(
                &deployment_directory,
                lease.clone(),
                Arc::new(owner),
                deployment,
            )
            .await
            .unwrap();
            drop(lease);
        } else {
            drop(owner);
        }
        let mut client = connect_inner(root_path.clone(), None, &launcher)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root_path.with_file_name("fixture-candidate-attempts"))
                .unwrap(),
            "2"
        );
        assert!(client.catalogue().startup_error().is_none());
        assert!(
            client
                .catalogue()
                .describe("settings")
                .unwrap()
                .registration_epoch
                .is_some()
        );
        assert!(
            !crate::application::live_update_available(&client)
                .await
                .unwrap()
        );
        if !managed {
            let current = discovery::read(&root_path).unwrap();
            let status = Client::status(&current.endpoint, Some(current.host_epoch))
                .await
                .unwrap();
            current.verify(&status).unwrap();
            assert_eq!(
                status.generation,
                Some(format!(
                    "cli-sha256:{}",
                    hex::encode(Sha256::digest(script.as_bytes()))
                ))
            );
        }
        client.quit().await.unwrap();
        let owner = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match RootOwner::open(&root_path, &RootNamespaces::for_current_account().unwrap()) {
                    Ok(owner) => break owner,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => pause().await,
                    Err(error) => panic!("{error}"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(owner.root_id(), root_id);
        drop(owner);
        if deployment_directory.exists() {
            std::fs::remove_dir_all(deployment_directory).unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cold_standalone_launcher_reaps_and_restarts_its_retired_candidate() {
        cold_launcher_recovers_its_candidate(false, false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cold_managed_launcher_reuses_its_anchor_and_reactivates() {
        cold_launcher_recovers_its_candidate(true, false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cold_standalone_launcher_restarts_code_drift_with_current_packages() {
        cold_launcher_recovers_its_candidate(false, true).await;
    }

    async fn desired_metadata(
        client: &Client,
    ) -> maka_plugin_core::deployment::management::ManagedDeployment {
        use maka_host_runtime::application::transport::Reply;
        let mut call = client
            .call(
                "management",
                "read".into(),
                serde_json::json!({}),
                Default::default(),
            )
            .await
            .unwrap();
        call.start().await.unwrap();
        let Reply::Finished { result, cleanup } = call.receive().await.unwrap() else {
            panic!("management query did not finish")
        };
        cleanup.unwrap();
        call.close().await.unwrap();
        serde_json::from_value(result.unwrap()).unwrap()
    }

    fn bundled_settings() -> maka_plugin_core::package::PackageSelection {
        let bundle = PathBuf::from(env!("OUT_DIR")).join("product");
        Package::read_from(&bundle.join("packages/settings"))
            .unwrap()
            .application_ref()
            .into()
    }

    #[tokio::test]
    async fn current_desired_head_does_not_hide_older_incarnation_pins() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("host");
        let (_, epoch, stop, server) = serve_product_with_desired(
            &root,
            true,
            false,
            None,
            Some(DesiredRevision::CurrentPackages),
        )
        .await;
        let discovery = discovery::read(&root).unwrap();
        let mut client = Client::connect(&discovery.endpoint, Some(epoch))
            .await
            .unwrap();
        let metadata = desired_metadata(&client).await;
        assert_ne!(metadata.source.reference, *client.source());
        assert_eq!(
            metadata.source.input.instances["settings"].package,
            bundled_settings()
        );
        assert!(
            crate::application::live_update_available(&client)
                .await
                .unwrap()
        );
        client.close().await.unwrap();
        stop.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn configuration_only_desired_revision_keeps_current_incarnation_running() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("host");
        let (root_id, epoch, stop, server) = serve_product_with_desired(
            &root,
            false,
            false,
            None,
            Some(DesiredRevision::ConfigurationOnly),
        )
        .await;
        let mut attempted = UpdateAttempt::default();
        let mut client = live(&root, &root_id, None, &mut attempted)
            .await
            .unwrap()
            .unwrap();
        let metadata = desired_metadata(&client).await;
        assert_ne!(metadata.source.reference, *client.source());
        assert_eq!(
            metadata.source.input.instances["settings"].package,
            bundled_settings()
        );
        assert_eq!(
            metadata.source.input.instances["settings"]
                .configuration
                .values["locale"],
            serde_json::json!("zh-CN")
        );
        assert_eq!(client.epoch(), epoch);
        assert!(!attempted.restarted);
        client.close().await.unwrap();
        stop.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unavailable_endpoints_recover_before_opening_the_interface() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        let (root_id, epoch, _stop, server) = serve_product(&root, true, true, None).await;
        let discovery = discovery::read(&root).unwrap();
        let mut probe = Client::connect(&discovery.endpoint, Some(epoch))
            .await
            .unwrap();
        let original = probe
            .catalogue()
            .startup_error()
            .expect("fixture must fail native initialization")
            .to_owned();
        assert!(
            probe
                .catalogue()
                .describe("settings")
                .unwrap()
                .registration_epoch
                .is_none()
        );
        probe.close().await.unwrap();
        let mut attempted = UpdateAttempt::default();
        assert!(
            live(&root, &root_id, None, &mut attempted)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(attempted.startup_error.as_deref(), Some(original.as_str()));
        server.await.unwrap();
        // A replacement that still fails must report the real diagnostic and
        // stay available for inspection, never enter a retirement loop.
        let (_, failed_epoch, stop, failed_server) = serve_product(&root, false, false, None).await;
        let error = live(&root, &root_id, None, &mut attempted)
            .await
            .err()
            .unwrap();
        assert!(
            error
                .to_string()
                .contains("Host startup failed after automatic recovery"),
            "{error}"
        );
        assert!(error.to_string().contains(original.as_str()), "{error}");
        let failed_discovery = discovery::read(&root).unwrap();
        assert!(
            !Client::status(&failed_discovery.endpoint, Some(failed_epoch))
                .await
                .unwrap()
                .closing
        );
        stop.cancel();
        failed_server.await.unwrap();
        let host = crate::application::open_host(
            RootOwner::open(&root, &RootNamespaces::for_current_account().unwrap()).unwrap(),
            Options::default(),
            crate::application::Roots::Saved,
            Some(catalog_transport()),
        )
        .await
        .unwrap();
        let endpoint = crate::endpoint::LocalEndpoint::bind().unwrap();
        let registration = host
            .host
            .publish_registration(&endpoint.path, None)
            .unwrap();
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let server = tokio::spawn(async move {
            serve_fixture(endpoint, host, stopped, None).await.unwrap();
            registration.remove().unwrap();
        });
        let mut client = live(&root, &root_id, None, &mut attempted)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(client.epoch(), epoch);
        assert!(client.catalogue().startup_error().is_none());
        assert!(
            client
                .catalogue()
                .describe("settings")
                .unwrap()
                .registration_epoch
                .is_some()
        );
        client.close().await.unwrap();
        stop.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn current_live_host_refreshes_product_methods_before_returning_its_connection() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        let namespaces = RootNamespaces::for_current_account().unwrap();
        let mut initialized = crate::application::open_host(
            RootOwner::create(&root, &namespaces).unwrap(),
            Options::default(),
            crate::application::Roots::Configured(Some(vec![])),
            Some(catalog_transport()),
        )
        .await
        .unwrap();
        initialized.shutdown().await.unwrap();
        drop(initialized);
        let store =
            maka_transport::open_store(Arc::new(RootOwner::open(&root, &namespaces).unwrap()))
                .await
                .unwrap();
        let record = store.application_launch().await.unwrap().unwrap();
        let loaded = store
            .load_application(record.deployment)
            .await
            .unwrap()
            .unwrap();
        let mut publication: Configuration =
            serde_json::from_value(record.configuration.clone()).unwrap();
        let Configuration::PublicHost { endpoints, .. } = &mut publication;
        for name in ["agent", "coordinator"] {
            for method in ["projectMcp", "trustProjectMcp", "fileCandidates"] {
                assert!(
                    endpoints
                        .get_mut(name)
                        .unwrap()
                        .grant
                        .methods
                        .remove(method)
                );
            }
        }
        // A caller can remove business management while retaining product-owned
        // Agent publication. Owner coordination must not need this endpoint.
        assert!(endpoints.remove("management").is_some());
        assert!(
            store
                .compare_and_set_application_launch_configuration(
                    loaded.source().reference.clone(),
                    record.configuration,
                    serde_json::to_value(publication).unwrap(),
                )
                .await
                .unwrap()
        );
        store.drain().await;
        drop((loaded, store));

        let (root_id, epoch, stop, server) = serve_product(&root, false, false, None).await;
        let mut attempted = UpdateAttempt::default();
        let mut client = live(&root, &root_id, None, &mut attempted)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(client.epoch(), epoch);
        assert!(!attempted.restarted);
        let mut call = client
            .call(
                "agent",
                "projectMcp".into(),
                serde_json::json!({"sessionId":"missing-session"}),
                Default::default(),
            )
            .await
            .unwrap();
        // Admission must use this returned connection's refreshed grant. A
        // publication write alone would still leave its original snapshot stale.
        call.start().await.unwrap();
        call.close().await.unwrap();
        let publication = client.publication().await.unwrap();
        let Configuration::PublicHost { endpoints, .. } = publication.configuration;
        assert!(endpoints["agent"].grant.methods.contains("projectMcp"));
        assert!(!endpoints.contains_key("management"));
        client.close().await.unwrap();
        stop.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn current_live_host_is_reused_without_retirement() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        let (root_id, epoch, stop, server) = serve_product(&root, false, false, None).await;
        let mut attempted = UpdateAttempt::default();
        let mut client = live(&root, &root_id, None, &mut attempted)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(client.epoch(), epoch);
        assert!(!attempted.restarted);
        client.close().await.unwrap();
        stop.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn launcher_owned_updates_interrupt_the_old_host_and_wait_for_cleanup() {
        tokio::time::timeout(Duration::from_secs(60), async {
            for code_changed in [false, true] {
                let temporary = tempfile::tempdir().unwrap();
                let root = temporary.path().join("host");
                let launcher = temporary.path().join("launcher");
                std::fs::write(&launcher, b"current executable").unwrap();
                let mut attempted = UpdateAttempt {
                    launcher: Some(launcher),
                    ..Default::default()
                };
                let generation = if code_changed {
                    format!("cli-sha256:{}", "0".repeat(64))
                } else {
                    attempted.generation().await.unwrap().unwrap().to_owned()
                };
                let (root_id, epoch, _stop, server) =
                    serve_product(&root, !code_changed, false, Some(generation)).await;
                let discovery = discovery::read(&root).unwrap();
                let other = Client::connect(&discovery.endpoint, Some(epoch))
                    .await
                    .unwrap();
                assert!(
                    !Client::retire_with_options(&discovery.endpoint, epoch, false, false)
                        .await
                        .unwrap()
                );
                assert!(
                    live(&root, &root_id, None, &mut attempted)
                        .await
                        .unwrap()
                        .is_none()
                );
                assert!(attempted.restarted);
                // Returning to startup must mean physical cleanup released the
                // writer, even while an old client still holds its connection.
                let owner = RootOwner::open(&root, &RootNamespaces::for_current_account().unwrap())
                    .unwrap();
                assert_eq!(owner.root_id(), root_id);
                drop((owner, other));
                server.await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn old_live_host_refuses_other_sessions_then_updates_on_safe_reconnect() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        let (root_id, epoch, _stop, server) = serve_product(&root, true, false, None).await;
        let discovery = discovery::read(&root).unwrap();
        let mut other = Client::connect(&discovery.endpoint, Some(epoch))
            .await
            .unwrap();
        let mut attempted = UpdateAttempt::default();
        let error = live(&root, &root_id, None, &mut attempted)
            .await
            .err()
            .unwrap();
        assert!(
            error
                .to_string()
                .contains("another Host session or active task"),
            "{error}"
        );
        let status = Client::status(&discovery.endpoint, Some(epoch))
            .await
            .unwrap();
        assert_eq!(status.epoch, epoch);
        assert!(!status.closing);
        assert_eq!(status.sessions, 1);
        other.close().await.unwrap();
        let mut attempted = UpdateAttempt::default();
        assert!(
            live(&root, &root_id, None, &mut attempted)
                .await
                .unwrap()
                .is_none()
        );
        assert!(attempted.restarted);
        server.await.unwrap();
        let host = crate::application::open_host(
            RootOwner::open(&root, &RootNamespaces::for_current_account().unwrap()).unwrap(),
            Options::default(),
            crate::application::Roots::Saved,
            Some(catalog_transport()),
        )
        .await
        .unwrap();
        assert_ne!(host.host.epoch(), epoch);
        let endpoint = crate::endpoint::LocalEndpoint::bind().unwrap();
        let registration = host
            .host
            .publish_registration(&endpoint.path, None)
            .unwrap();
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let server = tokio::spawn(async move {
            serve_fixture(endpoint, host, stopped, None).await.unwrap();
            registration.remove().unwrap();
        });
        let mut client = live(&root, &root_id, None, &mut attempted)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(client.epoch(), epoch);
        assert!(
            !crate::application::live_update_available(&client)
                .await
                .unwrap()
        );
        client.close().await.unwrap();
        stop.cancel();
        server.await.unwrap();
    }
}
