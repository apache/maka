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

use maka_event_log::root;
use maka_host_runtime::application::host::{Client as HostClient, discovery, startup};
use maka_workbench::bindings::Bindings;
use nsh_engine::EngineConfig;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::runtime::Handle;
use uuid::Uuid;

/// How often the window checks that its Host still runs.
const CHECK_EVERY: Duration = Duration::from_secs(2);
/// How soon a failed check is repeated before the Host counts as stopped.
const RECHECK_AFTER: Duration = Duration::from_millis(500);
/// How long a check waits for the Host to answer.
const STATUS_LIMIT: Duration = Duration::from_secs(2);

/// The workbench on one Host: its bindings, the engine configuration made
/// from them, the Root's client directory, and the Host they reach.
pub struct Connection {
    pub bindings: Bindings,
    pub config: EngineConfig,
    pub directory: PathBuf,
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
        config.data_dir = Some(directory.clone());
        config.assets = Some(bindings.assets());
        config.chunk_loader = Some(bindings.chunk_loader());
        Ok(Self {
            bindings,
            config,
            directory,
            endpoint,
            epoch,
        })
    }
}

/// The Root the desktop serves, and the launcher that starts its Host.
#[derive(Clone)]
pub struct Root {
    path: PathBuf,
    /// The identity of the Root found at `path` when the desktop opened.
    id: String,
    launcher: PathBuf,
}

impl Root {
    /// The Root at `path`, which must exist.
    pub fn find(path: PathBuf, launcher: PathBuf) -> Result<Self, String> {
        let id = root::resolve(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?
            .root_id()
            .to_owned();
        Ok(Self { path, id, launcher })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Connects to the Host serving the Root. When none runs, the launcher
    /// starts one, as `maka desktop` does.
    pub async fn connect(&self, runtime: Handle) -> Result<Connection, String> {
        // The launcher would initialize a new Root where this one was moved
        // or deleted.
        match root::resolve(&self.path) {
            Ok(found) if found.root_id() == self.id => {}
            Ok(_) => return Err(format!("{} holds another Root now", self.path.display())),
            Err(error) => return Err(format!("{}: {error}", self.path.display())),
        }
        let mut host = startup::connect_root(&self.launcher, &self.path).await?;
        let endpoint = match discovery::read(&self.path) {
            Ok(registered) if registered.host_epoch == host.epoch() => registered.endpoint,
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
        Connection::admit(host, endpoint, &self.path, runtime).await
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

/// Ends once the Host at `endpoint` has stopped or is stopping: two checks
/// in a row could not reach it, found another Host or found it closing.
pub async fn stopped(endpoint: PathBuf, epoch: Uuid) {
    let mut failed = 0;
    while failed < 2 {
        tokio::time::sleep(if failed == 0 {
            CHECK_EVERY
        } else {
            RECHECK_AFTER
        })
        .await;
        failed = if runs(&endpoint, epoch).await {
            0
        } else {
            failed + 1
        };
    }
}
