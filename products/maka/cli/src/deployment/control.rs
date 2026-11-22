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

use super::{Admission, Deployment, RootId, activation, directory, service, store, update};
use clap::Args;
use maka_event_log::root::{self, FileLease};
use maka_host_runtime::HostError;
use serde::Serialize;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Args)]
pub(crate) struct Control {
    #[arg(long)]
    root_id: RootId,
    #[arg(long)]
    expected_deployment_id: Uuid,
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=9_007_199_254_740_991))]
    expected_revision: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ControlAction {
    Stop,
    Restart,
    Uninstall,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Outcome {
    ActiveTasks {
        deployment: Deployment,
    },
    Stopped {
        deployment: Deployment,
    },
    Ready {
        deployment: Deployment,
        host: crate::host_client::LiveHost,
    },
    Unregistered {
        deployment: Deployment,
        cleanup: Cleanup,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Cleanup {
    Complete,
    Pending { message: String },
}

impl Control {
    pub async fn run(self, action: ControlAction) -> Result<(), HostError> {
        let directory = directory(&self.root_id.0)?;
        if !directory.is_dir() {
            return Err("Host deployment is not installed".into());
        }
        let lease = Arc::new(FileLease::acquire(&directory.join("executor.lock"))?);
        let store::Installation::Installed(current) = store::read(&directory).await? else {
            return Err("Host deployment is absent or incomplete".into());
        };
        let root = root::resolve(&current.root_path)?;
        current.validate(&root, &directory)?;
        let retry = action == ControlAction::Uninstall
            && current.admission == Admission::Revoked
            && current.config_revision == self.expected_revision + 1;
        if current.root_id != self.root_id.0
            || current.deployment_id != self.expected_deployment_id
            || (current.config_revision != self.expected_revision && !retry)
        {
            return Err("deployment identity or revision changed".into());
        }
        if action != ControlAction::Uninstall {
            current.require_active()?;
        }
        let Some(owner) = update::retire(&current, false).await? else {
            println!(
                "{}",
                serde_json::to_string(&Outcome::ActiveTasks {
                    deployment: current
                })?
            );
            return Ok(());
        };
        let owner = Arc::new(owner);
        let outcome = if action == ControlAction::Uninstall {
            let deployment = if current.admission == Admission::Revoked {
                current
            } else {
                store::change(
                    &directory,
                    lease.clone(),
                    owner.clone(),
                    current,
                    store::Change::Revoke,
                )
                .await?
            };
            // Once revoked, startup remains denied even if OS cleanup fails.
            // Retain Root data, packages and the tombstone for explicit recovery.
            let cleanup = match async {
                service::remove(deployment.clone(), lease.clone(), owner).await?;
                if super::policy::read(&directory).await?.revision != 0 {
                    service::schedule(deployment.clone(), false, lease.clone()).await?;
                }
                Ok::<_, HostError>(())
            }
            .await
            {
                Ok(()) => Cleanup::Complete,
                Err(error) => Cleanup::Pending {
                    message: error.to_string().chars().take(2048).collect(),
                },
            };
            Outcome::Unregistered {
                deployment,
                cleanup,
            }
        } else {
            service::stop(current.clone(), lease.clone(), owner.clone()).await?;
            drop(owner);
            if action == ControlAction::Restart {
                let (client, host) = activation::connect_or_launch(&current, lease.clone()).await?;
                // The live receipt, not OS status, establishes restart readiness.
                lease.validate()?;
                println!(
                    "{}",
                    serde_json::to_string(&Outcome::Ready {
                        deployment: current,
                        host
                    })?
                );
                drop(client);
                return Ok(());
            }
            Outcome::Stopped {
                deployment: current,
            }
        };
        lease.validate()?;
        println!("{}", serde_json::to_string(&outcome)?);
        Ok(())
    }
}
