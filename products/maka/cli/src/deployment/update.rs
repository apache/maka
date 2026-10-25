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

use super::{
    Deployment, Mode, RootId, activation, configuration, directory, package, store, updates,
};
use crate::host_client::RetirementResult;
use crate::host_client::{HostClient, LiveHost};
use clap::Args;
use maka_event_log::root::{self, FileLease, RootNamespaces, RootOwner};
use maka_host_runtime::HostError;
use serde::Serialize;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use uuid::Uuid;

#[derive(Args)]
pub(crate) struct Update {
    #[command(flatten)]
    expected: Expected,
    #[command(flatten)]
    settings: Settings,
}

#[derive(Args)]
pub(crate) struct Expected {
    #[arg(long)]
    root_id: RootId,
    #[arg(long)]
    expected_deployment_id: Uuid,
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=9_007_199_254_740_991))]
    expected_revision: u64,
    /// Guard a scheduled update against a concurrently changed policy.
    #[arg(long, hide = true)]
    expected_policy_revision: Option<u64>,
}

#[derive(Args)]
struct Settings {
    /// Change the launch policy together with this executable.
    #[arg(long, value_enum)]
    mode: Option<Mode>,
    /// Replace the loopback listener address.
    #[arg(long)]
    websocket: Option<SocketAddr>,
    #[command(flatten)]
    directories: configuration::Directories,
}

pub(super) enum Action {
    Update,
    Reconcile,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Outcome {
    Applied {
        deployment: Deployment,
    },
    Ready {
        deployment: Deployment,
        host: LiveHost,
    },
    ActiveTasks {
        deployment: Deployment,
        target: Deployment,
    },
}

impl Update {
    pub async fn run(self) -> Result<(), HostError> {
        self.expected.run(Some(self.settings)).await
    }
}

impl Expected {
    pub(super) fn from_deployment(deployment: &Deployment, policy_revision: u64) -> Self {
        Self {
            root_id: RootId(deployment.root_id.clone()),
            expected_deployment_id: deployment.deployment_id,
            expected_revision: deployment.config_revision,
            expected_policy_revision: Some(policy_revision),
        }
    }

    pub(super) fn arguments(&self, action: Action) -> Vec<String> {
        let mut args = vec![
            "host".into(),
            match action {
                Action::Update => "update",
                Action::Reconcile => "reconcile",
            }
            .into(),
            "--root-id".into(),
            self.root_id.0.clone(),
            "--expected-deployment-id".into(),
            self.expected_deployment_id.to_string(),
            "--expected-revision".into(),
            self.expected_revision.to_string(),
        ];
        if let Some(revision) = self.expected_policy_revision {
            args.extend(["--expected-policy-revision".into(), revision.to_string()]);
        }
        args
    }
    pub async fn reconcile(self) -> Result<(), HostError> {
        self.run(None).await
    }

    async fn run(self, settings: Option<Settings>) -> Result<(), HostError> {
        println!("{}", serde_json::to_string(&self.apply(settings).await?)?);
        Ok(())
    }

    async fn apply(self, settings: Option<Settings>) -> Result<Outcome, HostError> {
        crate::operation::check()?;
        crate::operation::progress(crate::operation::Phase::Stage, None, None);
        let directory = directory(&self.root_id.0)?;
        if !directory.is_dir() {
            return Err("Host deployment is not installed".into());
        }
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock"))?);
        if let Some(revision) = self.expected_policy_revision {
            super::policy::require_revision(&directory, revision).await?;
        }
        // Do not create a deployment database through update/reconcile.
        let store::Installation::Installed(current) = store::read(&directory).await? else {
            return Err("Host deployment is absent or incomplete".into());
        };
        let root = root::resolve(&current.root_path)?;
        current.validate(&root, &directory)?;
        current.require_active()?;
        if current.root_id != self.root_id.0 || current.deployment_id != self.expected_deployment_id
        {
            return Err("deployment identity or revision changed".into());
        }
        let (observed, pending) = updates::read(&directory, lease.clone()).await?;
        if observed != current
            || !(current.config_revision == self.expected_revision
                || (current.config_revision == self.expected_revision + 1 && pending.is_none()))
        {
            return Err("deployment revision changed".into());
        }
        let target = if let Some(settings) = settings {
            let mut target = current.clone();
            target.mode = settings.mode.unwrap_or(current.mode);
            target.websocket = settings.websocket.unwrap_or(current.websocket);
            let replace_roots = settings.directories.is_specified();
            if replace_roots {
                target.project_directory_roots = settings.directories.resolve(None).await?;
            }
            target.validate(&root, &directory)?;
            // Code and configuration are one target. The calling distribution
            // understands every field it writes, unlike an arbitrary older pin.
            let source = package::source(target.mode)?;
            let (executable, sha256) = if source == current.executable {
                (source, current.sha256.clone())
            } else {
                let stage_directory = directory.clone();
                let stage_lease = lease.clone();
                tokio::task::spawn_blocking(move || {
                    stage_lease.validate()?;
                    let package = package::stage(&stage_directory, &source)?;
                    stage_lease.validate()?;
                    Ok::<_, HostError>(package)
                })
                .await??
            };
            target.executable = executable;
            target.sha256 = sha256;
            if target == current
                && (!replace_roots || current.config_revision != self.expected_revision)
            {
                if pending.is_some() {
                    return Err("another update is pending; reconcile it first".into());
                }
                None // Includes a lost acknowledgement after the same target committed.
            } else {
                if current.config_revision != self.expected_revision {
                    return Err("deployment changed before package staging".into());
                }
                target.config_revision += 1;
                target.validate(&root, &directory)?;
                let roots = if replace_roots {
                    Some(crate::application::directories(
                        target.project_directory_roots.clone(),
                    )?)
                } else {
                    None
                };
                let target = updates::Pending {
                    deployment: target,
                    roots,
                };
                updates::prepare(&directory, lease.clone(), current.clone(), target.clone())
                    .await?;
                Some(target)
            }
        } else {
            pending
        };
        let deployment = if let Some(pending) = target {
            let target = &pending.deployment;
            target.validate(&root, &directory)?;
            let Some(owner) = retire(&current, self.expected_policy_revision.is_some()).await?
            else {
                lease.validate()?;
                return Ok(Outcome::ActiveTasks {
                    deployment: current,
                    target: target.clone(),
                });
            };
            let owner = Arc::new(owner);
            if current.mode == Mode::Supervised && target.mode == Mode::OnDemand {
                // Remove the old login/restart trigger while Root is held.
                // If removal or COMMIT fails, pending remains and Active can
                // still be reactivated; there is no second cleanup authority.
                super::service::remove(current.clone(), lease.clone(), owner.clone()).await?;
            }
            if let Some(roots) = &pending.roots {
                crate::application::configure_workspace_locations(owner.clone(), roots.clone())
                    .await?;
            }
            let deployment = target.clone();
            updates::commit(&directory, lease.clone(), owner, current, pending).await?;
            deployment
        } else {
            current
        };
        if self.expected_policy_revision.is_some() && deployment.mode == Mode::OnDemand {
            // A scheduled updater must not parent an on-demand Host: systemd
            // would reap it with the updater's cgroup. Attached clients reconnect
            // through their ordinary launcher; a sleeping Host stays asleep.
            return Ok(Outcome::Applied { deployment });
        }
        // The executor is already held. Calling the public activate command here
        // would acquire it twice. A Ready failure never restores older code.
        crate::operation::check()?;
        crate::operation::progress(crate::operation::Phase::Activate, None, None);
        let (client, host) = activation::connect_or_launch(&deployment, lease.clone()).await?;
        lease.validate()?;
        drop(client);
        Ok(Outcome::Ready { deployment, host })
    }
}

/// Reopening observes the existing intent; it never prepares a second update.
/// The executor and revision checks in `apply` close races with another CLI.
pub(super) async fn recover_pending(root_id: &RootId) -> Result<(), HostError> {
    let directory = directory(&root_id.0)?;
    let store::Installation::Installed(current) = store::read(&directory).await? else {
        return Ok(());
    };
    if super::query::pending(&directory, &current).await?.is_none() {
        return Ok(());
    }
    Expected {
        root_id: RootId(current.root_id.clone()),
        expected_deployment_id: current.deployment_id,
        expected_revision: current.config_revision,
        expected_policy_revision: None,
    }
    .apply(None)
    .await?;
    Ok(())
}

/// A prepared receipt is not proof of release: only acquiring RootOwner is.
pub(super) async fn retire(
    deployment: &Deployment,
    allow_idle_connections: bool,
) -> Result<Option<RootOwner>, HostError> {
    crate::operation::check()?;
    crate::operation::progress(crate::operation::Phase::Retire, None, None);
    tokio::time::timeout(
        crate::operation::remaining(Duration::from_secs(30)),
        async {
            loop {
                match RootOwner::open(
                    &deployment.root_path,
                    &RootNamespaces::for_current_account()?,
                ) {
                    Ok(owner) => {
                        if owner.root_id() != deployment.root_id
                            || owner.canonical_path() != deployment.root_path
                        {
                            return Err("State Root changed during retirement".into());
                        }
                        return Ok(Some(owner));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error.into()),
                }
                if let Ok(mut client) =
                    HostClient::connect(&deployment.root_path, Some(&deployment.generation())).await
                {
                    match client.retire(None, false, allow_idle_connections).await? {
                        RetirementResult::ActiveTasks => return Ok(None),
                        RetirementResult::Prepared { .. } => {}
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        },
    )
    .await?
}
