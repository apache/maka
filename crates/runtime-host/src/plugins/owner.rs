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

use super::{Command, Error, Lifecycle, Mutation, Owner, Snapshot, authority, invalid};
use maka_event_log::{StoreError, plugins::PackageUpdate};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

impl Owner {
    pub(super) async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        mut services: watch::Receiver<()>,
        shutdown: CancellationToken,
    ) -> Result<(), Error> {
        let mut lifecycle = self.kernel.subscribe();
        let serving = async {
            self.tick()?;
            loop {
                let tick = async {
                    match self.kernel.next_tick() {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => break,
                    command = commands.recv() => match command {
                        Some(command) => {
                            let result = self.mutate(command.mutation).await;
                            let _ = command.reply.send(result);
                        }
                        None => break,
                    },
                    _ = services.changed() => { self.tick()?; },
                    _ = lifecycle.changed() => { self.tick()?; },
                    _ = tick => { self.tick()?; },
                }
            }
            Ok::<(), Error>(())
        }
        .await;
        commands.close();
        while let Some(command) = commands.recv().await {
            let _ = command.reply.send(Err(Error::Closed));
        }
        self.lifecycle = Lifecycle::Draining;
        self.kernel.retire();
        self.publish();
        // A deadline limits the caller's wait, not the resource owner's life.
        loop {
            match self
                .kernel
                .shutdown(Instant::now() + Duration::from_secs(10))
                .await
            {
                Err(maka_plugins::Error::CleanupPending) => {
                    self.publish();
                }
                result => {
                    self.lifecycle = Lifecycle::Closed;
                    self.publish();
                    return serving.and(result.map_err(Into::into));
                }
            }
        }
    }

    async fn mutate(&mut self, mutation: Mutation) -> Result<Arc<Snapshot>, Error> {
        if let Some(fence) = &self.fence {
            return Err(Error::Fenced(fence.clone()));
        }
        if matches!(mutation, Mutation::Reconcile) {
            self.tick()?;
            return Ok(self.updates.borrow().clone());
        }
        let mut ledger = self.ledger.clone();
        let mut packages = self.packages.clone();
        let mut existing = self.kernel.definitions().clone();
        let mut force_reload = None;
        let mut persist = true;
        let update = match mutation {
            Mutation::Install { package, expected } => {
                let id = package.manifest().id.clone();
                self.check_package(&id, expected.as_ref())?;
                if self.builtins.contains_key(&id) {
                    return Err(invalid(
                        "built-in code is updated with Host, not package installation",
                    ));
                }
                if package.manifest().composition.is_some() && !ledger.package_layers.contains(&id)
                {
                    ledger.package_layers.push(id.clone());
                }
                existing.remove(&id);
                force_reload = Some(id.clone());
                packages.insert(id, package.clone());
                Some(PackageUpdate::Install(package))
            }
            Mutation::Uninstall { id, expected } => {
                self.check_package(&id, expected.as_ref())?;
                if self.builtins.contains_key(&id) {
                    return Err(invalid("built-in packages cannot be uninstalled"));
                }
                if !packages.contains_key(&id) {
                    return Err(invalid("package not found"));
                }
                if packages.values().any(|package| {
                    package
                        .manifest()
                        .dependencies
                        .iter()
                        .any(|dependency| dependency.id == id)
                        || package
                            .manifest()
                            .composition
                            .as_ref()
                            .is_some_and(|composition| {
                                composition.structural_dependencies.contains(&id)
                            })
                }) {
                    return Err(invalid("package is required by another installed package"));
                }
                ledger = authority::without_package_layer(
                    &ledger,
                    &packages,
                    &self.builtin_layers,
                    &id,
                )?;
                packages.remove(&id);
                Some(PackageUpdate::Remove(id))
            }
            Mutation::Apply {
                base_generation,
                operations,
            } => {
                if let Some(expected) =
                    base_generation.filter(|generation| *generation != ledger.generation)
                {
                    return Err(StoreError::RevisionConflict {
                        expected: expected.to_string(),
                        actual: ledger.generation.to_string(),
                    }
                    .into());
                }
                if operations.len() > 4096 {
                    return Err(invalid("composition request exceeds 4096 operations"));
                }
                // Validate the incoming batch before normalization, which must
                // not erase an invalid intermediate operation.
                self.desired.apply(&operations)?;
                ledger.extend(&operations);
                None
            }
            Mutation::Reload { id, expected } => {
                self.check_package(&id, expected.as_ref())?;
                if !packages.contains_key(&id) && !self.builtins.contains_key(&id) {
                    return Err(invalid("package not found"));
                }
                if !self.builtins.contains_key(&id) {
                    existing.remove(&id);
                }
                force_reload = Some(id);
                persist = false;
                None
            }
            Mutation::Reconcile => unreachable!(),
        };
        let (desired, prepared, required_services) = authority::prepare(
            &ledger,
            &packages,
            &self.builtins,
            &self.builtin_layers,
            self.loader.as_ref(),
            &existing,
            &self.required_services,
        )?;
        self.kernel.validate_change(&prepared)?;
        if persist {
            match self.log.commit_plugin_state(ledger, update).await {
                Ok(committed) => self.ledger = committed,
                Err(error @ (StoreError::CommitUnknown(_) | StoreError::OperationUnknown)) => {
                    self.fence = Some(error.to_string());
                    self.publish();
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.packages = packages;
        self.desired = desired;
        self.required_services = required_services;
        self.kernel.install(prepared);
        if let Some(id) = force_reload {
            self.kernel.reload(&id);
        }
        self.tick()?;
        Ok(self.updates.borrow().clone())
    }

    fn check_package(
        &self,
        id: &str,
        expected: Option<&maka_protocol::plugin::PackagePrecondition>,
    ) -> Result<(), Error> {
        let Some(expected) = expected else {
            return Ok(());
        };
        let actual = self.packages.get(id).map(|package| package.digest());
        if expected.base_generation != self.ledger.generation {
            return Err(StoreError::RevisionConflict {
                expected: expected.base_generation.to_string(),
                actual: self.ledger.generation.to_string(),
            }
            .into());
        }
        if expected.content_digest.as_deref() != actual {
            return Err(StoreError::RevisionConflict {
                expected: expected
                    .content_digest
                    .as_deref()
                    .unwrap_or("absent")
                    .into(),
                actual: actual.unwrap_or("absent").into(),
            }
            .into());
        }
        Ok(())
    }

    fn tick(&mut self) -> Result<(), Error> {
        self.kernel.tick()?;
        let previous = self.updates.borrow().clone();
        if previous.runtime != self.kernel.status()
            || previous.ledger != self.ledger
            || previous.required_services != self.required_services
            || previous.fence != self.fence
        {
            self.publish();
        }
        Ok(())
    }

    fn publish(&self) {
        self.updates.send_replace(Arc::new(Snapshot {
            lifecycle: self.lifecycle,
            ledger: self.ledger.clone(),
            desired: self.desired.clone(),
            packages: self.packages.clone(),
            required_services: self.required_services.clone(),
            runtime: self.kernel.status(),
            fence: self.fence.clone(),
        }));
    }
}
