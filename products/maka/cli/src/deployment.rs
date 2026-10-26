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

mod activation;
mod configuration;
mod connect;
mod control;
mod diagnostics;
mod entry;
mod local;
mod logs;
mod package;
mod policy;
mod query;
mod service;
mod setup;
mod store;
mod update;
mod updates;
pub(super) use activation::Activate;
pub(super) use connect::Connect;
pub(super) use control::{Control, ControlAction};
pub(super) use entry::ServiceRun;
pub(super) use local::{connect as connect_local, connect_application};
pub(super) use logs::Logs;
pub(super) use policy::{
    Configure as UpdatePolicy,
    worker::{Reconcile as AutoUpdate, Upgrade},
};
pub(super) use query::Status;
pub(super) use setup::Setup;
pub(super) use update::{Expected, Update};

use clap::{Args, ValueEnum};
use maka_event_log::root::{self, FileLease, RootLocation, RootNamespaces, RootOwner};
use maka_host_runtime::{DirectoryRootSpec, HostError};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
};
use uuid::Uuid;

#[derive(Clone)]
struct RootId(String);

impl FromStr for RootId {
    type Err = &'static str;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(Self(value.into()))
        } else {
            Err("root ID must contain 64 lowercase hexadecimal characters")
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Mode {
    OnDemand,
    Supervised,
}

#[derive(Args)]
pub(super) struct Install {
    /// Native State Root (defaults to this account's Maka runtime-host-rust directory).
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
    /// Launch policy for a new installation (defaults to on-demand).
    #[arg(long, value_enum)]
    mode: Option<Mode>,
    /// Loopback listener for a new installation (defaults to 127.0.0.1:0).
    #[arg(long)]
    websocket: Option<SocketAddr>,
    #[command(flatten)]
    directories: configuration::Directories,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Admission {
    Active,
    Revoked,
}

/// Deployment admission authorizes startup; it does not assert process health.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Deployment {
    deployment_id: Uuid,
    config_revision: u64,
    root_id: String,
    root_path: PathBuf,
    pub executable: PathBuf,
    sha256: String,
    pub mode: Mode,
    pub websocket: SocketAddr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_directory_roots: Option<Vec<DirectoryRootSpec>>,
    admission: Admission,
}

impl Deployment {
    fn require_active(&self) -> Result<(), HostError> {
        if self.admission != Admission::Active {
            return Err("deployment has been uninstalled".into());
        }
        Ok(())
    }

    pub fn generation(&self) -> String {
        format!("{}:{}", self.deployment_id, self.config_revision)
    }

    fn validate(&self, root: &RootLocation, directory: &Path) -> Result<(), HostError> {
        self.validate_record(directory)?;
        if self.root_id != root.root_id() || self.root_path != root.canonical_path() {
            return Err("deployment does not match its native root".into());
        }
        Ok(())
    }

    fn validate_record(&self, directory: &Path) -> Result<(), HostError> {
        if self.root_id.parse::<RootId>().is_err()
            || !self.root_path.is_absolute()
            || !(1..=9_007_199_254_740_991).contains(&self.config_revision)
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || self.executable != package::path(directory, &self.sha256)
            || self.websocket.ip() != std::net::Ipv4Addr::LOCALHOST
            || serde_json::to_vec(self)?.len() > 65_536
        {
            return Err("deployment does not match its native root or package".into());
        }
        Ok(())
    }
}

pub(super) fn directory(root_id: &str) -> Result<PathBuf, HostError> {
    let namespaces = RootNamespaces::for_current_account()?;
    Ok(namespaces
        .ownership
        .parent()
        .ok_or("missing account data directory")?
        .canonicalize()?
        .join("deployments")
        .join(root_id))
}

enum ExistingDeployment {
    RequireMatching,
    Reuse,
}

impl Install {
    pub async fn run(self) -> Result<(), HostError> {
        let (deployment, _lease) = self.install(ExistingDeployment::RequireMatching).await?;
        println!("{}", serde_json::to_string(&deployment)?);
        Ok(())
    }

    async fn install(
        self,
        existing_policy: ExistingDeployment,
    ) -> Result<(Deployment, Arc<FileLease>), HostError> {
        let mode = self.mode.unwrap_or(Mode::OnDemand);
        let websocket = self
            .websocket
            .unwrap_or_else(|| SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, 0)));
        if websocket.ip() != std::net::Ipv4Addr::LOCALHOST {
            return Err("managed Host listener must use 127.0.0.1".into());
        }
        let directories_specified = self.directories.is_specified();
        let project_directory_roots = self.directories.resolve(None).await?;
        let root_path = match self.root {
            Some(root) => root,
            None => RootNamespaces::for_current_account()?
                .ownership
                .parent()
                .ok_or("missing account data directory")?
                .join("runtime-host-rust"),
        };
        let (root, directory, lease) = tokio::task::spawn_blocking(move || {
            root::initialize(&root_path, &RootNamespaces::for_current_account()?)?;
            let root = root::resolve(&root_path)?;
            let directory = directory(root.root_id())?;
            root::private_directory(&directory)?;
            let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock"))?);
            lease.validate()?;
            Ok::<_, HostError>((root, directory, lease))
        })
        .await??;
        let existing = store::read(&directory).await?;
        if let store::Installation::Installed(existing) = &existing
            && existing.admission == Admission::Active
        {
            existing.validate(&root, &directory)?;
            if matches!(existing_policy, ExistingDeployment::Reuse) {
                if self.mode.is_some_and(|mode| mode != existing.mode)
                    || self
                        .websocket
                        .is_some_and(|websocket| websocket != existing.websocket)
                    || (directories_specified
                        && project_directory_roots != existing.project_directory_roots)
                {
                    return Err("deployment configuration changes require an update".into());
                }
                // Setup attaches to existing authority; only update selects new
                // code. Activation still validates the installed package and Host.
                lease.validate()?;
                return Ok((existing.clone(), lease));
            }
            if existing.mode != mode
                || existing.websocket != websocket
                || existing.project_directory_roots != project_directory_roots
            {
                return Err("deployment configuration changes require an update".into());
            }
            if existing.executable == std::env::current_exe()?.canonicalize()? {
                lease.validate()?;
                return Ok((existing.clone(), lease));
            }
        }
        let stage_directory = directory.clone();
        let stage_lease = lease.clone();
        let (executable, sha256) = tokio::task::spawn_blocking(move || {
            stage_lease.validate()?;
            let package = package::stage(&stage_directory, &package::source(mode)?)?;
            stage_lease.validate()?;
            Ok::<_, HostError>(package)
        })
        .await??;
        let requested = Deployment {
            deployment_id: Uuid::new_v4(),
            config_revision: 1,
            root_id: root.root_id().into(),
            root_path: root.canonical_path().into(),
            executable,
            sha256,
            mode,
            websocket,
            project_directory_roots,
            admission: Admission::Active,
        };
        requested.validate(&root, &directory)?;
        let deployment = if let store::Installation::Installed(existing) = existing {
            existing.validate(&root, &directory)?;
            if existing.admission == Admission::Revoked {
                let owner = Arc::new(RootOwner::open(
                    root.canonical_path(),
                    &RootNamespaces::for_current_account()?,
                )?);
                // Remove the old projection before granting a new installation:
                // an old login trigger must not resurrect it across the cut.
                service::remove(existing.clone(), lease.clone(), owner.clone()).await?;
                if directories_specified {
                    crate::application::configure_workspace_locations(
                        owner.clone(),
                        crate::application::directories(requested.project_directory_roots.clone())?,
                    )
                    .await?;
                }
                store::change(
                    &directory,
                    lease.clone(),
                    owner,
                    existing,
                    store::Change::Reinstall(requested),
                )
                .await?
            } else {
                if existing.executable != requested.executable
                    || existing.mode != requested.mode
                    || existing.websocket != requested.websocket
                {
                    return Err(
                        "deployment is already installed; changing it requires an update".into(),
                    );
                }
                existing
            }
        } else {
            // No deployment database is created before obtaining the Root. A busy
            // unmanaged Host remains unmanaged; staging alone cannot fence startup.
            let owner = RootOwner::open(
                root.canonical_path(),
                &RootNamespaces::for_current_account()?,
            )?;
            if owner.root_id() != root.root_id() {
                return Err("State Root changed during installation".into());
            }
            let owner = Arc::new(owner);
            if directories_specified {
                crate::application::configure_workspace_locations(
                    owner.clone(),
                    crate::application::directories(requested.project_directory_roots.clone())?,
                )
                .await?;
            }
            store::install(&directory, lease.clone(), owner, requested).await?
        };
        lease.validate()?;
        Ok((deployment, lease))
    }
}

/// Called with the actual writer lease, before any Host database can migrate.
pub(super) async fn admit(owner: &RootOwner, mode: Mode) -> Result<Option<Deployment>, HostError> {
    let root = root::resolve(owner.canonical_path())?;
    let directory = directory(root.root_id())?;
    let deployment = match store::read(&directory).await? {
        store::Installation::Missing => return Ok(None),
        store::Installation::Incomplete => {
            return Err("deployment installation must finish before Host startup".into());
        }
        store::Installation::Installed(deployment) => deployment,
    };
    deployment.validate(&root, &directory)?;
    deployment.require_active()?;
    if !deployment.executable.symlink_metadata()?.is_file()
        || deployment.executable.canonicalize()? != deployment.executable
        || deployment.mode != mode
        || std::env::current_exe()?.canonicalize()? != deployment.executable
    {
        return Err("this executable or launch mode is not authorized by the deployment".into());
    }
    owner.validate_current()?;
    Ok(Some(deployment))
}
