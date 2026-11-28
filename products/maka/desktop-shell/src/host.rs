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

//! The Host the window's client reaches: the one `maka desktop` admitted,
//! then, after that one stops, whichever Host serves the Root next.

use maka_host_runtime::application::host::{Client as HostClient, discovery, startup};
use maka_workbench::bindings::Bindings;
use nsh_engine::EngineConfig;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::runtime::Handle;
#[cfg(not(windows))]
use uuid::Uuid;

/// How long a check waits for the Host to answer.
#[cfg(not(windows))]
const STATUS_LIMIT: Duration = Duration::from_secs(2);
/// How long quitting waits for the Host connection to close.
pub const DETACH_LIMIT: Duration = Duration::from_secs(5);

/// The workbench on one Host: its bindings, the engine configuration made
/// from them, the Root's client directory, and the Host they reach.
pub struct Connection {
    pub bindings: Bindings,
    pub config: EngineConfig,
    #[cfg(not(windows))]
    pub endpoint: PathBuf,
    #[cfg(not(windows))]
    pub epoch: Uuid,
}

impl Connection {
    /// Admits the Host client and sets the workbench up on it.
    pub async fn admit(
        host: HostClient,
        #[cfg(not(windows))] endpoint: PathBuf,
        root: &Path,
        runtime: Handle,
    ) -> Result<Self, String> {
        #[cfg(not(windows))]
        let epoch = host.epoch();
        let (client, directory) = maka_workbench::host::admit(host, root, "desktop").await?;
        Ok(Self::mount(
            client,
            directory,
            #[cfg(not(windows))]
            endpoint,
            #[cfg(not(windows))]
            epoch,
            runtime,
        ))
    }

    #[cfg(windows)]
    pub async fn admit_wsl(
        host: HostClient,
        root: &str,
        directory: PathBuf,
        runtime: Handle,
    ) -> Result<Self, String> {
        let (client, directory) =
            maka_workbench::host::admit_in(host, root, directory, "desktop").await?;
        let mut connection = Self::mount(client, directory, runtime);
        connection.config.context = connection
            .config
            .context
            .with(maka_workbench::RemoteHostFilesystem);
        Ok(connection)
    }

    fn mount(
        client: maka_app_client::Client,
        directory: PathBuf,
        #[cfg(not(windows))] endpoint: PathBuf,
        #[cfg(not(windows))] epoch: Uuid,
        runtime: Handle,
    ) -> Self {
        let bindings = Bindings::new(client, runtime.clone());
        let mut config = maka_workbench::configuration(bindings.registry(None), runtime);
        config.context = config.context.with(bindings.reload());
        config.data_dir = Some(directory);
        config.assets = Some(bindings.assets());
        config.chunk_loader = Some(bindings.chunk_loader());
        Self {
            bindings,
            config,
            #[cfg(not(windows))]
            endpoint,
            #[cfg(not(windows))]
            epoch,
        }
    }
}

/// Whether the Host at `endpoint` with `epoch` runs and is not closing. A
/// Host that does not answer within [`STATUS_LIMIT`] counts as running: only
/// one that is gone, replaced or closing has stopped.
#[cfg(not(windows))]
pub async fn runs(endpoint: &Path, epoch: Uuid) -> bool {
    match tokio::time::timeout(STATUS_LIMIT, HostClient::status(endpoint, Some(epoch))).await {
        Ok(status) => status.is_ok_and(|status| !status.closing && !status.closed),
        Err(_) => true,
    }
}

/// Connects to the initial Host named by `target`, using the finite startup
/// helper when the caller handed off only a Root and launcher.
pub async fn connect_initial(
    target: &crate::Target,
    runtime: Handle,
) -> Result<(Connection, PathBuf, uuid::Uuid), String> {
    let (host, endpoint, epoch) = match &target.host {
        crate::TargetHost::Connected { endpoint, epoch } => {
            let host = HostClient::connect(endpoint, Some(*epoch)).await?;
            (host, endpoint.clone(), *epoch)
        }
        crate::TargetHost::Ensure => {
            let mut host = startup::connect_root(&target.launcher, &target.root).await?;
            let epoch = host.epoch();
            let endpoint = match discovery::read(&target.root) {
                Ok(registered) if registered.host_epoch == epoch => registered.endpoint,
                other => {
                    let error = match other {
                        Ok(_) => "the Host changed while the desktop connected".to_owned(),
                        Err(error) => error.to_string(),
                    };
                    return Err(match host.close().await {
                        Ok(()) => error,
                        Err(cleanup) => format!("{error}; desktop Host cleanup: {cleanup}"),
                    });
                }
            };
            (host, endpoint, epoch)
        }
    };
    let root = match maka_event_log::root::resolve(&target.root) {
        Ok(root) => root,
        Err(error) => {
            let mut host = host;
            let error = format!("{}: {error}", target.root.display());
            return Err(match host.close().await {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; desktop Host cleanup: {cleanup}"),
            });
        }
    };
    let connection = Connection::admit(
        host,
        #[cfg(not(windows))]
        endpoint.clone(),
        root.canonical_path(),
        runtime,
    )
    .await?;
    Ok((connection, endpoint, epoch))
}

/// The explicit desktop quit reaches the exact Host even after a desktop reconnect.
pub async fn quit(bindings: Bindings) {
    if let Err(error) = bindings.quit_ephemeral().await {
        eprintln!("maka-desktop-shell: Host quit: {error}");
    }
}

#[cfg(target_os = "macos")]
/// Closes `bindings` for good, within [`DETACH_LIMIT`]. A failure is reported
/// only while their Host runs: one that stopped has no client left to detach.
pub async fn detach(bindings: Bindings, endpoint: &Path, epoch: Uuid) {
    let error = match tokio::time::timeout(DETACH_LIMIT, bindings.close()).await {
        Ok(Ok(())) => return,
        Ok(Err(error)) => format!("Host cleanup: {error}"),
        Err(_) => "Host cleanup did not finish in time".to_owned(),
    };
    if runs(endpoint, epoch).await {
        eprintln!("maka-desktop-shell: {error}");
    }
}

#[cfg(not(windows))]
mod reconnect;
#[cfg(not(windows))]
pub use reconnect::{Root, stopped};
