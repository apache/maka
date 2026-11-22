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

//! Root-bound discovery is a hint; clients verify its identity against live status.
use super::{Host, LifecycleMode, Status, VERSION};
use maka_event_log::root::{self, RootNamespaces, RootOwner};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub version: u32,
    pub root_id: String,
    pub generation: Option<String>,
    pub host_epoch: Uuid,
    pub source: maka_plugin_core::deployment::DeploymentRef,
    pub lifecycle_mode: LifecycleMode,
    pub endpoint: PathBuf,
    pub pid: NonZeroU32,
    pub websocket_endpoints: Vec<String>,
}
impl Discovery {
    pub fn verify(&self, status: &Status) -> io::Result<()> {
        if self.version != VERSION
            || status.version != VERSION
            || self.root_id != status.root_id
            || self.host_epoch != status.epoch
            || self.pid != status.pid
            || self.source != status.source
            || self.generation != status.generation
            || self.lifecycle_mode != status.lifecycle_mode
            || status.closing
            || status.closed
        {
            return Err(io::Error::other(
                "Host discovery is stale, incompatible or not ready",
            ));
        }
        Ok(())
    }
}

pub fn read(root: &Path) -> io::Result<Discovery> {
    read_with_namespaces(root, &RootNamespaces::for_current_account()?)
}
pub fn read_with_namespaces(root: &Path, namespaces: &RootNamespaces) -> io::Result<Discovery> {
    let root = root::resolve(root)?;
    let path = namespaces
        .control
        .join(root.root_id())
        .join("registration.json");
    let discovery: Discovery = serde_json::from_slice(&read_record(&path)?)?;
    if discovery.version != VERSION
        || discovery.root_id != root.root_id()
        || discovery.host_epoch.is_nil()
        || !discovery.endpoint.is_absolute()
    {
        return Err(io::Error::other(
            "Host discovery does not match the native Root or protocol",
        ));
    }
    discovery.source.validate().map_err(io::Error::other)?;
    #[cfg(windows)]
    if !discovery
        .endpoint
        .to_str()
        .and_then(|path| path.strip_prefix(r"\\.\pipe\"))
        .is_some_and(|name| !name.is_empty() && !name.contains(['\\', '/', '\0']))
    {
        return Err(io::Error::other("Host discovery is not a local named pipe"));
    }
    Ok(discovery)
}
fn read_record(path: &Path) -> io::Result<Vec<u8>> {
    let before = path.symlink_metadata()?;
    if !before.is_file() {
        return Err(io::Error::other("invalid Host discovery record"));
    }
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?
    };
    #[cfg(windows)]
    let file = root::windows::open_nofollow(path, false)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Host discovery is not a regular file"));
    }
    let mut bytes = Vec::new();
    let mut file = file;
    file.read_to_end(&mut bytes)?;
    let after = path.symlink_metadata()?;
    if !after.is_file()
        || before.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(io::Error::other("Host discovery changed while reading"));
    }
    Ok(bytes)
}

/// Retains the original Root lease, and removes only this incarnation's record.
pub struct Registration {
    root: Arc<RootOwner>,
    epoch: Uuid,
    path: PathBuf,
}
impl Host {
    pub fn publish_registration(
        &self,
        endpoint: &Path,
        websocket: Option<std::net::SocketAddr>,
    ) -> io::Result<Registration> {
        self.root.validate_current()?;
        if !endpoint.is_absolute() || endpoint.to_str().is_none() {
            return Err(io::Error::other("invalid Host discovery endpoint"));
        }
        if self.status().closing {
            return Err(io::Error::other("Host is closing"));
        }
        let value = Discovery {
            version: VERSION,
            root_id: self.root_id().to_owned(),
            generation: self.options.generation.clone(),
            host_epoch: self.epoch,
            source: self.source.clone(),
            lifecycle_mode: self.options.lifecycle_mode,
            endpoint: endpoint.into(),
            pid: NonZeroU32::new(std::process::id()).expect("process id"),
            websocket_endpoints: websocket
                .into_iter()
                .map(|address| format!("ws://{address}/runtime-host"))
                .collect(),
        };
        let directory = self.root.control_directory();
        let path = directory.join("registration.json");
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer(&mut temporary, &value)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        self.root.validate_current()?;
        temporary.persist(&path)?;
        Ok(Registration {
            root: self.root.clone(),
            epoch: self.epoch,
            path,
        })
    }
}
impl Registration {
    pub fn remove(self) -> io::Result<()> {
        self.remove_current()
    }
    fn remove_current(&self) -> io::Result<()> {
        self.root.validate_current()?;
        let bytes = match read_record(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let current: Discovery = serde_json::from_slice(&bytes)?;
        if current.host_epoch == self.epoch && current.root_id == self.root.root_id() {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Err(error) = self.remove_current() {
            eprintln!("could not remove Host registration: {error}");
        }
    }
}
