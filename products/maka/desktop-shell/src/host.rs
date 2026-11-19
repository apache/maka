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

use maka_host_runtime::application::host::Client as HostClient;
use maka_workbench::bindings::Bindings;
use nsh_engine::EngineConfig;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::runtime::Handle;
use uuid::Uuid;

/// How long a check waits for the Host to answer.
const STATUS_LIMIT: Duration = Duration::from_secs(2);
/// How long quitting waits for the Host connection to close.
pub const DETACH_LIMIT: Duration = Duration::from_secs(5);

/// The workbench on one Host: its bindings, the engine configuration made
/// from them, the Root's client directory, and the Host they reach.
pub struct Connection {
    pub bindings: Bindings,
    pub config: EngineConfig,
    pub endpoint: PathBuf,
    pub epoch: Uuid,
}

impl Connection {
    /// Admits the client of the Host at `endpoint` and sets the workbench up
    /// on it.
    pub async fn admit(
        host: HostClient,
        endpoint: PathBuf,
        root: &Path,
        runtime: Handle,
    ) -> Result<Self, String> {
        let epoch = host.epoch();
        let (client, directory) = maka_workbench::host::admit(host, root, "desktop").await?;
        let bindings = Bindings::new(client, runtime.clone());
        let mut config = maka_workbench::configuration(bindings.registry(None), runtime);
        config.context = config.context.with(bindings.reload());
        config.data_dir = Some(directory);
        config.assets = Some(bindings.assets());
        config.chunk_loader = Some(bindings.chunk_loader());
        Ok(Self {
            bindings,
            config,
            endpoint,
            epoch,
        })
    }
}

/// Whether the Host at `endpoint` with `epoch` runs and is not closing. A
/// Host that does not answer within [`STATUS_LIMIT`] counts as running: only
/// one that is gone, replaced or closing has stopped.
pub async fn runs(endpoint: &Path, epoch: Uuid) -> bool {
    match tokio::time::timeout(STATUS_LIMIT, HostClient::status(endpoint, Some(epoch))).await {
        Ok(status) => status.is_ok_and(|status| !status.closing && !status.closed),
        Err(_) => true,
    }
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
