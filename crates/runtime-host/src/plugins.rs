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

pub(crate) mod assistant;
mod authority;
pub(crate) mod background_health;
mod changes;
mod client;
mod effects;
mod entrypoint;
pub(crate) mod external_agent;
pub(crate) mod goal;
pub(crate) mod graph;
pub(crate) mod host;
mod http;
pub(crate) mod insights;
pub(crate) mod javascript;
pub(crate) mod jev;
pub(crate) mod models;
mod owner;
pub(crate) mod plan;
mod pricing;
mod process;
pub(crate) mod recall;
pub(crate) mod remote;
pub(crate) mod scheduler;
pub(crate) mod session_import;
pub(crate) mod session_recap;
pub(crate) mod skills;
pub(crate) mod storage;
mod terminal;
pub(crate) mod todo;
mod usage;
pub(crate) mod web;
pub mod wire;
pub(crate) mod workhub;

use maka_event_log::{EventLog, StoreError};
use maka_plugins::{
    composition::{Composition, Ledger, Operation},
    contributions::Catalog,
    kernel::{Definitions, Kernel, Status},
    package::Package,
};
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

pub trait PackageLoader: Send + Sync {
    /// Construct an entrypoint for fixed bytes; no plugin code executes here.
    fn definition(
        &self,
        package: &Package,
    ) -> Result<Arc<maka_plugins::kernel::Definition>, maka_plugins::Error>;
}

/// Embedders register linked code explicitly; registration performs no activation.
#[derive(Default)]
pub struct Setup {
    pub builtins: Definitions,
    pub layers: BTreeMap<String, Vec<Operation>>,
    pub loader: Option<Arc<dyn PackageLoader>>,
}

pub(crate) struct ExternalLoader(pub Option<Arc<dyn PackageLoader>>);
impl PackageLoader for ExternalLoader {
    fn definition(
        &self,
        package: &Package,
    ) -> Result<Arc<maka_plugins::kernel::Definition>, maka_plugins::Error> {
        self.0
            .as_ref()
            .ok_or_else(|| {
                maka_plugins::Error::Invalid("JavaScript plugin loader is not configured".into())
            })?
            .definition(package)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Invalid(#[from] maka_plugins::Error),
    #[error(transparent)]
    Persistence(#[from] StoreError),
    #[error("plugin platform is closed")]
    Closed,
    #[error("accepted plugin mutation outcome is unknown")]
    OutcomeUnknown,
    #[error("plugin authority is fenced: {0}")]
    Fenced(String),
}

pub enum Mutation {
    Install {
        package: Package,
        expected: Option<maka_protocol::plugin::PackagePrecondition>,
    },
    Uninstall {
        id: String,
        expected: Option<maka_protocol::plugin::PackagePrecondition>,
    },
    Apply {
        base_generation: Option<u64>,
        operations: Vec<Operation>,
    },
    Reload {
        id: String,
        expected: Option<maka_protocol::plugin::PackagePrecondition>,
    },
    Reconcile,
}

type RequiredServices = BTreeMap<String, Option<Vec<String>>>;

#[derive(Clone)]
pub struct Snapshot {
    pub lifecycle: Lifecycle,
    pub ledger: Ledger,
    pub desired: Composition,
    pub packages: BTreeMap<String, Package>,
    pub required_services: RequiredServices,
    pub runtime: Status,
    pub fence: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    Active,
    Draining,
    Closed,
}

#[derive(Clone)]
pub struct Platform {
    commands: mpsc::Sender<Command>,
    snapshot: watch::Receiver<Arc<Snapshot>>,
    catalog: Catalog,
    clients: Arc<client::Cache>,
}

struct Command {
    mutation: Mutation,
    reply: oneshot::Sender<Result<Arc<Snapshot>, Error>>,
}

struct Owner {
    lifecycle: Lifecycle,
    log: Arc<EventLog>,
    loader: Arc<dyn PackageLoader>,
    builtins: Definitions,
    builtin_layers: BTreeMap<String, Vec<Operation>>,
    ledger: Ledger,
    packages: BTreeMap<String, Package>,
    desired: Composition,
    required_services: RequiredServices,
    kernel: Kernel,
    updates: watch::Sender<Arc<Snapshot>>,
    fence: Option<String>,
}

impl Platform {
    /// Recovery validates fixed bytes and intent before starting reconciliation.
    /// The returned owner future must be tracked by Host through shutdown.
    pub async fn open(
        log: Arc<EventLog>,
        loader: Arc<dyn PackageLoader>,
        builtins: Definitions,
        builtin_layers: BTreeMap<String, Vec<Operation>>,
        mut kernel: Kernel,
        shutdown: CancellationToken,
    ) -> Result<
        (
            Self,
            impl Future<Output = Result<(), Error>> + Send + 'static,
        ),
        Error,
    > {
        let catalog = kernel.catalog().clone();
        catalog.host_only::<maka_plugins::model::Adapter>()?;
        catalog.host_only::<maka_plugins::provider::Definition>()?;
        let services_changed = kernel.subscribe_services();
        catalog
            .host_only::<maka_plugins::remote::Endpoint>()
            .map_err(|error| invalid(&error.to_string()))?;
        catalog
            .host_only::<Arc<dyn maka_plugins::background::BackgroundWork>>()
            .map_err(|error| invalid(&error.to_string()))?;
        let mut ledger = log.plugin_composition().await?;
        let mut packages = BTreeMap::new();
        for (id, _) in log.plugin_packages().await? {
            if builtins.contains_key(&id) {
                return Err(invalid("installed package impersonates a built-in"));
            }
            packages.insert(
                id.clone(),
                log.plugin_package(&id)
                    .await?
                    .ok_or_else(|| invalid("installed package disappeared"))?,
            );
        }
        let mut defaults_changed = false;
        for id in builtin_layers.keys() {
            if ledger.package_layers.contains(id) {
                continue;
            }
            let mut candidate = ledger.clone();
            candidate.package_layers.push(id.clone());
            let validation = authority::prepare(
                &candidate,
                &packages,
                &builtins,
                &builtin_layers,
                loader.as_ref(),
                &Definitions::new(),
                &BTreeMap::new(),
            )
            .and_then(|(_, prepared, _)| kernel.validate_change(&prepared).map_err(Error::from));
            match validation {
                Ok(()) => {
                    ledger = candidate;
                    defaults_changed = true;
                }
                Err(error) if ledger.generation != 0 => {
                    // Existing user overlays remain authoritative. A conflicting
                    // new default must not prevent the old Host root from opening.
                    eprintln!(
                        "new built-in default {id} conflicts with stored composition: {error}"
                    );
                }
                Err(error) => return Err(error),
            }
        }
        if defaults_changed {
            ledger = log.commit_plugin_state(ledger, None).await?;
        }
        let (desired, prepared, required_services) = authority::prepare(
            &ledger,
            &packages,
            &builtins,
            &builtin_layers,
            loader.as_ref(),
            &Definitions::new(),
            &BTreeMap::new(),
        )?;
        kernel.install(prepared);
        let snapshot = Arc::new(Snapshot {
            lifecycle: Lifecycle::Active,
            ledger: ledger.clone(),
            desired: desired.clone(),
            packages: packages.clone(),
            required_services: required_services.clone(),
            runtime: kernel.status(),
            fence: None,
        });
        let (updates, snapshot) = watch::channel(snapshot);
        let (commands, receiver) = mpsc::channel(32);
        let owner = Owner {
            lifecycle: Lifecycle::Active,
            log,
            loader,
            builtins,
            builtin_layers,
            ledger,
            packages,
            desired,
            required_services,
            kernel,
            updates,
            fence: None,
        };
        Ok((
            Self {
                commands,
                snapshot,
                catalog,
                clients: Arc::default(),
            },
            owner.run(receiver, services_changed, shutdown),
        ))
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.borrow().clone()
    }

    pub(crate) fn pending_background_work(&self) -> usize {
        self.catalog
            .all::<Arc<dyn maka_plugins::background::BackgroundWork>>()
            .into_iter()
            .filter(|entry| entry.is_effective() && entry.value.is_pending())
            .count()
    }
    pub(crate) fn wake_background_work(&self) {
        for entry in self
            .catalog
            .all::<Arc<dyn maka_plugins::background::BackgroundWork>>()
        {
            if let Ok(_call) = entry.admit() {
                entry.value.wake();
            }
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.snapshot.clone()
    }

    /// Wait for in-flight initial activation, not for eventual convergence.
    /// Failed plugins and unmet services remain observable failures; they do not
    /// hold recovery indefinitely. Loading deadlines belong to the kernel.
    pub(crate) async fn wait_for_activation(&self, shutdown: &CancellationToken) -> bool {
        use maka_plugins::fiber::Phase;
        let mut updates = self.subscribe();
        loop {
            let pending = updates
                .borrow_and_update()
                .runtime
                .entries
                .iter()
                .any(|entry| {
                    !entry.disabled
                        && (entry.phase == Phase::Loading
                            || (entry.phase == Phase::Pending && entry.waiting_for.is_empty()))
                });
            if !pending {
                return !shutdown.is_cancelled();
            }
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => return false,
                changed = updates.changed() => if changed.is_err() { return false; },
            }
        }
    }

    /// Once queued, the owner completes the mutation even if its caller goes away.
    pub async fn mutate(&self, mutation: Mutation) -> Result<Arc<Snapshot>, Error> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command { mutation, reply })
            .await
            .map_err(|_| Error::Closed)?;
        result.await.map_err(|_| Error::OutcomeUnknown)?
    }
}

fn invalid(message: &str) -> Error {
    maka_plugins::Error::Invalid(message.into()).into()
}
