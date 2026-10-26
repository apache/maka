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

use crate::{
    Result,
    transport::{ipc, native},
};
use futures_util::{
    FutureExt,
    future::{BoxFuture, join_all},
};
use maka_event_log::{root::RootNamespaces, root_store::RootStore};
use maka_host_runtime::application::host::{
    Client,
    startup::{self, valid_root_id},
};
use maka_plugin_core::{
    composition::{ExecutionLocation, InstanceId, PresentationTarget},
    deployment::{DeploymentRef, RemoteObservation},
    plan::{Plan, Provider, RemoteCapability, RemoteExports},
};
use maka_ui_runtime::actions::RemoteService;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

mod host;
use host::{CohostConnector, ConnectedHost, HostLink};

/// Trusted launcher input, never a guest-created credential or deployment edit.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub hosts: Vec<Host>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Host {
    pub name: String,
    pub location: HostLocation,
    pub deployment: Uuid,
    pub endpoints: BTreeMap<String, HostEndpoint>,
    #[serde(default)]
    pub native: Vec<crate::transport::NativeGrant>,
}
pub use maka_host_runtime::application::transport::HostEndpoint;
/// Explicit Host attachment chosen by the trusted launcher. Cohost borrows
/// the already owned UI Store; it never opens a filesystem Root.
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostLocation {
    Public {
        root: PathBuf,
        /// Optional launcher pin, checked against discovery and live status.
        #[serde(default, rename = "stateDomain")]
        state_domain: Option<String>,
    },
    Cohost {},
}

pub use maka_host_runtime::application::transport::Grant;
impl Configuration {
    pub fn read(path: &Path) -> Result<Self> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let configuration: Self = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        configuration.validate()?;
        Ok(configuration)
    }
    /// Check trusted launcher input without starting a Host or opening a Root.
    pub fn validate(&self) -> Result<()> {
        let mut names = BTreeSet::new();
        for host in &self.hosts {
            if host.name.is_empty()
                || !names.insert(&host.name)
                || host.deployment.is_nil()
                || host.endpoints.is_empty()
            {
                return Err("invalid or duplicate local Host declaration".into());
            }
            if let HostLocation::Public {
                state_domain: Some(domain),
                ..
            } = &host.location
                && !valid_root_id(domain)
            {
                return Err("invalid Host State Root identity".into());
            }
            for grant in &host.native {
                grant.validate()?;
            }
            for (name, endpoint) in &host.endpoints {
                if name.is_empty() {
                    return Err("invalid Host endpoint name".into());
                }
                endpoint.validate()?;
            }
        }
        Ok(())
    }
}

struct PreparedHost {
    configuration: Host,
    consumers: BTreeSet<InstanceId>,
}
fn consumers(plan: &Plan, host: &str) -> BTreeSet<InstanceId> {
    plan.instances()
        .values()
        .filter(|i| !i.disabled && i.entry.is_some())
        .filter(|i| {
            i.bindings.values().flatten().any(|b|
            matches!(&b.provider, Provider::Remote { capability } if capability.deployment == host))
        })
        .map(|i| i.identity.clone())
        .collect()
}
#[derive(PartialEq)]
enum Phase {
    Prepared,
    Starting,
    Started,
    Closing,
    Closed,
}
/// UI physical-call custody belongs to the launcher; public Hosts remain independent.
/// Prepare first, retain this object, then observe start through a mutable borrow.
/// Close the UI and its actual accepted work before draining these connections.
pub struct Connections {
    target: PresentationTarget,
    source: DeploymentRef,
    initial: Option<maka_event_log::applications::LoadedDeployment>,
    observations: Vec<RemoteObservation>,
    store: Option<Arc<RootStore>>,
    cohost_native: maka_host_runtime::application::NativeRegistry,
    cohost_scripts: Option<Arc<dyn maka_host_runtime::application::backend::Factory>>,
    namespaces: RootNamespaces,
    helper: PathBuf,
    prepared: Vec<PreparedHost>,
    hosts: Vec<ConnectedHost>,
    registrations: Vec<RemoteService>,
    startup_errors: Vec<String>,
    phase: Phase,
}
impl Connections {
    /// Validate the exact presentation and resolved caller identities before any
    /// Host starts. This phase has no Host process or database effects.
    #[allow(clippy::too_many_arguments)]
    pub async fn prepare(
        store: Arc<RootStore>,
        deployment: Uuid,
        target: PresentationTarget,
        configuration: Configuration,
        namespaces: RootNamespaces,
        helper: PathBuf,
        cohost_native: maka_host_runtime::application::NativeRegistry,
        cohost_scripts: Option<Arc<dyn maka_host_runtime::application::backend::Factory>>,
    ) -> Result<Self> {
        let loaded = store
            .load_application(deployment)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("UI deployment not found")?;
        Self::prepare_loaded(
            store,
            loaded,
            target,
            configuration,
            namespaces,
            helper,
            cohost_native,
            cohost_scripts,
        )
        .await
    }

    /// Adopt one checked UI snapshot from the same live original Root owner.
    #[allow(clippy::too_many_arguments)]
    pub async fn prepare_loaded(
        store: Arc<RootStore>,
        loaded: maka_event_log::applications::LoadedDeployment,
        target: PresentationTarget,
        configuration: Configuration,
        namespaces: RootNamespaces,
        helper: PathBuf,
        mut cohost_native: maka_host_runtime::application::NativeRegistry,
        cohost_scripts: Option<Arc<dyn maka_host_runtime::application::backend::Factory>>,
    ) -> Result<Self> {
        store
            .check_application(&loaded)
            .map_err(|error| error.to_string())?;
        configuration.validate()?;
        let deployment = loaded.source().reference.deployment;
        if loaded.source().input.environment.location != ExecutionLocation::Ui
            || loaded.source().input.environment.presentation != Some(target)
        {
            return Err("stored presentation target mismatch".into());
        }
        let plan = loaded.plan();
        if plan
            .instances()
            .values()
            .filter(|i| !i.disabled)
            .flat_map(|i| i.bindings.values().flatten())
            .any(|binding| {
                matches!(&binding.provider, Provider::Remote {capability}
                    if !configuration.hosts.iter().any(|host| host.name == capability.deployment))
            })
        {
            return Err("UI source selects an unconfigured Host".into());
        }
        let mut prepared = Vec::new();
        let mut cohosts = BTreeSet::new();
        for mut host in configuration.hosts {
            let consumers = consumers(plan, &host.name);
            match &mut host.location {
                HostLocation::Public { root, .. } => {
                    *root = std::path::absolute(&*root).map_err(|e| e.to_string())?
                }
                HostLocation::Cohost {} => {
                    if host.deployment == deployment || !cohosts.insert(host.deployment) {
                        return Err("cohost requires one distinct Host deployment executor".into());
                    }
                }
            }
            prepared.push(PreparedHost {
                configuration: host,
                consumers,
            });
        }
        if !cohosts.is_empty() {
            cohost_native = crate::with_gateway(cohost_native)?;
            let management =
                maka_host_runtime::application::management::ManagementTarget::from_source(
                    store.clone(),
                    loaded.source().reference.clone(),
                )
                .await?;
            maka_host_runtime::application::management::provide_target(
                &mut cohost_native,
                crate::UI_DEPLOYMENT_MANAGER.into(),
                management,
            )?;
        }
        Ok(Self {
            store: Some(store),
            cohost_native,
            cohost_scripts,
            target,
            source: loaded.source().reference.clone(),
            observations: loaded.source().remote_exports.clone(),
            initial: Some(loaded),
            namespaces,
            helper: std::path::absolute(helper).map_err(|error| error.to_string())?,
            prepared,
            hosts: Vec::new(),
            registrations: Vec::new(),
            startup_errors: Vec::new(),
            phase: Phase::Prepared,
        })
    }
    /// The launcher retains actual local custody before awaiting startup. Dropping
    /// the observer never restarts a public Host or closes an accepted UI call.
    pub async fn start(&mut self) -> Result<()> {
        if self.phase != Phase::Prepared {
            return Err("Host connections cannot start in this phase".into());
        }
        self.phase = Phase::Starting;
        let mut targets = BTreeSet::new();
        for prepared in std::mem::take(&mut self.prepared) {
            if prepared.consumers.is_empty() {
                // Trusted availability is not a running executor or an approval.
                self.prepared.push(prepared);
                continue;
            }
            let host = prepared.configuration;
            let catalogue = self
                .start_selected(host.clone(), prepared.consumers, self.source.clone())
                .await
                .map_err(|error| format!("Host {}: {error}", host.name))?;
            if let Some(error) = catalogue.startup_error() {
                self.startup_errors
                    .push(format!("Host {}: {error}", host.name));
            }
            let owned = self.hosts.last_mut().unwrap();
            catalogue.check_names(host.endpoints.keys())?;
            owned.epochs = catalogue.epochs();
            for import in host.endpoints.keys() {
                let description = catalogue.describe(import)?;
                let target = RemoteCapability {
                    deployment: host.name.clone(),
                    instance: description.provider.clone(),
                    export: description.export.clone(),
                };
                if !targets.insert(target.clone()) {
                    return Err("duplicate local endpoint grant".into());
                }
                if !self.observations.iter().any(|o| {
                    o.capability == target && o.declaration.contract.accepts(&description.contract)
                }) {
                    return Err(
                        "Host endpoint differs from the selected UI source observation".into(),
                    );
                }
                let Some(registration_epoch) = description.registration_epoch else {
                    continue;
                };
                let selection = catalogue.select(import)?;
                self.registrations.push(RemoteService {
                    target,
                    registration_epoch,
                    contract: description.contract.clone(),
                    implementation: Arc::new(native::Service::new(
                        owned.connection.as_ref().unwrap().clone(),
                        selection,
                        owned.peers.clone(),
                    )?),
                });
            }
        }
        for owned in &mut self.hosts {
            owned.published = true;
        }
        self.phase = Phase::Started;
        Ok(())
    }
    async fn start_selected(
        &mut self,
        host: Host,
        consumers: BTreeSet<InstanceId>,
        source: DeploymentRef,
    ) -> Result<crate::transport::Catalogue> {
        match host.location.clone() {
            HostLocation::Public { root, .. } => {
                self.connect_public(host, consumers, root, source).await
            }
            HostLocation::Cohost {} => self.start_cohost(host, consumers, source).await,
        }
    }
    async fn connect_public(
        &mut self,
        configuration: Host,
        consumers: BTreeSet<InstanceId>,
        root: PathBuf,
        source: DeploymentRef,
    ) -> Result<crate::transport::Catalogue> {
        tokio::time::timeout(
            std::time::Duration::from_secs(40),
            self.connect_public_inner(configuration, consumers, root, source),
        )
        .await
        .map_err(|_| "local Host connection/startup deadline elapsed".to_owned())?
    }
    async fn connect_public_inner(
        &mut self,
        configuration: Host,
        consumers: BTreeSet<InstanceId>,
        root: PathBuf,
        source: DeploymentRef,
    ) -> Result<crate::transport::Catalogue> {
        let HostLocation::Public { state_domain, .. } = &configuration.location else {
            unreachable!()
        };
        let request = startup::Request {
            root,
            state_domain: state_domain.clone(),
            deployment: configuration.deployment,
            endpoints: configuration.endpoints.clone(),
            native: configuration.native.clone(),
        };
        let prepared = startup::prepare(&self.helper, &request, &self.namespaces).await?;
        let client = Client::connect_peer(
            &prepared.discovery().endpoint,
            Some(prepared.discovery().host_epoch),
            source.clone(),
            consumers.clone(),
            configuration.endpoints.clone(),
        )
        .await?;
        if client.source() != &prepared.discovery().source {
            return Err("local Host source changed during admission".into());
        }
        let catalogue = client.catalogue().clone();
        let connection =
            native::Connection::new(Arc::new(ipc::Connector::new(client.call_channel_opener()?)));
        self.hosts.push(ConnectedHost {
            owner: HostLink::Public {
                client: Some(Box::new(client)),
            },
            connection: Some(connection),
            ready: true,
            published: false,
            epochs: BTreeMap::new(),
            configuration,
            peers: crate::transport::Peers::new(crate::transport::Peer::new(source, consumers)?),
        });
        drop(prepared);
        Ok(catalogue)
    }
    async fn start_cohost(
        &mut self,
        configuration: Host,
        consumers: BTreeSet<InstanceId>,
        source: DeploymentRef,
    ) -> Result<crate::transport::Catalogue> {
        let peers = crate::transport::Peers::new(crate::transport::Peer::new(source, consumers)?);
        self.hosts.push(ConnectedHost {
            owner: HostLink::Cohost {
                application: None,
                server: None,
                captured: None,
            },
            connection: None,
            ready: false,
            published: false,
            epochs: BTreeMap::new(),
            configuration: configuration.clone(),
            peers: peers.clone(),
        });
        let owned = self.hosts.last_mut().unwrap();
        let HostLink::Cohost {
            application,
            server,
            ..
        } = &mut owned.owner
        else {
            unreachable!()
        };
        let policy = Arc::new(crate::transport::PeerPolicy::with_native_grants(
            configuration.native,
        )?);
        *application = Some(
            maka_host_runtime::application::Application::start_from_store(
                self.store.as_ref().ok_or("cohost Store is closed")?.clone(),
                configuration.deployment,
                self.cohost_native.clone(),
                policy.issuer(),
                policy.clone(),
                self.cohost_scripts.clone(),
            )
            .await?,
        );
        let app = application.as_ref().unwrap();
        let client = app.client();
        let endpoints =
            crate::transport::Endpoints::start(&client, &configuration.endpoints).await?;
        let actual = crate::transport::Server::new(client, policy, endpoints)?;
        let catalogue = actual.catalogue();
        *server = Some(actual.clone());
        owned.connection = Some(native::Connection::new(Arc::new(CohostConnector {
            server: actual,
            peers,
        })));
        owned.ready = true;
        Ok(catalogue)
    }
    /// Transfer the original checked bytes to the foreground owner.
    pub fn take_initial(&mut self) -> Option<maka_event_log::applications::LoadedDeployment> {
        self.initial.take()
    }
    pub fn source(&self) -> &DeploymentRef {
        &self.source
    }
    pub fn startup_errors(&self) -> &[String] {
        &self.startup_errors
    }

    pub fn registrations(&self) -> Vec<RemoteService> {
        self.registrations.clone()
    }
    /// Probe only already owned, published Hosts. Observations cannot start an
    /// executor, replace a binding, delegate a grant or replay a business call.
    pub(crate) async fn registrations_changed(&mut self) -> Result<bool> {
        if self.phase != Phase::Started {
            return Err("Host connections are not ready for observation".into());
        }
        let mut changed = false;
        for owned in &mut self.hosts {
            if owned.ready && owned.published && !owned.epochs.is_empty() {
                changed |= owned.registrations_changed().await?;
            }
        }
        Ok(changed)
    }
    /// Trusted same-Root manager operation, not a head-watcher grant. The caller
    /// delegates the original configuration's grants to this exact committed
    /// plan's enabled consumers, retaining only the explicitly live old sources.
    pub async fn approve_source(
        &mut self,
        store: &RootStore,
        source: DeploymentRef,
        retain: BTreeSet<u64>,
    ) -> Result<Vec<RemoteService>> {
        if self.phase != Phase::Started {
            return Err("Host connections are not ready for approval".into());
        }
        if source.state_domain != self.source.state_domain
            || source.deployment != self.source.deployment
        {
            return Err("foreign UI deployment approval".into());
        }
        let loaded = store
            .load_application_at(&source)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("committed UI source not found")?;
        if loaded.source().input.environment.location != ExecutionLocation::Ui
            || loaded.source().input.environment.presentation != Some(self.target)
        {
            return Err("stored presentation target mismatch".into());
        }
        let plan = loaded.plan();
        self.approve_plan(source, self.target, plan.clone(), retain)
            .await
    }

    /// The foreground's preflighted source supplies the projection. Trusted
    /// launcher configuration still bounds every Host, endpoint and grant.
    pub(crate) async fn approve_plan(
        &mut self,
        source: DeploymentRef,
        target: PresentationTarget,
        plan: Plan,
        retain: BTreeSet<u64>,
    ) -> Result<Vec<RemoteService>> {
        if self.phase != Phase::Started {
            return Err("Host connections are not ready for approval".into());
        }
        if source.state_domain != self.source.state_domain
            || source.deployment != self.source.deployment
        {
            return Err("foreign UI deployment approval".into());
        }
        if target != self.target {
            return Err("stored presentation target mismatch".into());
        }
        let remote: RemoteExports = plan
            .instances()
            .values()
            .flat_map(|i| i.bindings.values().flatten())
            .filter_map(|b| match &b.provider {
                Provider::Remote { capability } => {
                    Some((capability.clone(), b.declaration.as_ref().clone()))
                }
                Provider::Local { .. } => None,
            })
            .collect();
        let required: BTreeSet<_> = plan
            .instances()
            .values()
            .filter(|i| !i.disabled)
            .flat_map(|i| i.bindings.values().flatten())
            .filter_map(|binding| match &binding.provider {
                Provider::Remote { capability } => Some(capability.clone()),
                _ => None,
            })
            .collect();
        if required.iter().any(|target| {
            !self
                .hosts
                .iter()
                .any(|host| host.configuration.name == target.deployment)
                && !self
                    .prepared
                    .iter()
                    .any(|host| host.configuration.name == target.deployment)
        }) {
            return Err("UI source selects an unconfigured Host".into());
        }
        while let Some(index) = self
            .prepared
            .iter()
            .position(|host| !consumers(&plan, &host.configuration.name).is_empty())
        {
            let prepared = self.prepared.remove(index);
            let callers = consumers(&plan, &prepared.configuration.name);
            // Retain newly selected local custody before observing startup.
            // Public connections never restart or replace the discovered Host.
            let owners = self.hosts.len();
            let result = self
                .start_selected(prepared.configuration.clone(), callers, source.clone())
                .await;
            // A failed connection without published custody may remain prepared.
            // This never replays an operation or replaces an existing connection.
            if result.is_err() && self.hosts.len() == owners {
                self.prepared.insert(index, prepared);
            }
            result?;
        }
        let mut published = Vec::new();
        let mut targets = BTreeSet::new();
        let mut staged = Vec::new();
        for owned in &mut self.hosts {
            let name = owned.configuration.name.clone();
            let consumers = consumers(&plan, &name);
            if !owned.ready && !consumers.is_empty() {
                return Err("selected Host startup is unconfirmed".into());
            }
            if !owned.published && consumers.is_empty() {
                // No endpoint from this owner was published. Keep custody for
                // real cleanup without requiring a nonexistent approval channel.
                staged.push(None);
                continue;
            }
            let approved = if consumers.is_empty() {
                None
            } else {
                Some(crate::transport::Peer::new(
                    source.clone(),
                    consumers.clone(),
                )?)
            };
            owned.peers.check_update(approved.clone(), &retain)?;
            let catalogue = if consumers.is_empty() {
                None
            } else {
                Some(owned.capture().await?)
            };
            if let Some(catalogue) = &catalogue {
                catalogue.check_names(owned.configuration.endpoints.keys())?;
                for import in owned.configuration.endpoints.keys() {
                    let description = catalogue.describe(import)?;
                    let target = RemoteCapability {
                        deployment: name.clone(),
                        instance: description.provider.clone(),
                        export: description.export.clone(),
                    };
                    if !targets.insert(target.clone()) {
                        return Err("duplicate local endpoint grant".into());
                    }
                    if !required.contains(&target) {
                        continue;
                    }
                    if !remote
                        .get(&target)
                        .is_some_and(|expected| expected.contract.accepts(&description.contract))
                    {
                        return Err(
                            "Host endpoint differs from selected UI source observation".into()
                        );
                    }
                    let Some(registration_epoch) = description.registration_epoch else {
                        continue;
                    };
                    let selection = catalogue.select(import)?;
                    let value = if let Some(registered) =
                        self.registrations.iter().find(|registered| {
                            registered.target == target
                                && registered.registration_epoch == registration_epoch
                        }) {
                        registered.clone()
                    } else {
                        RemoteService {
                            target,
                            registration_epoch,
                            contract: description.contract.clone(),
                            implementation: Arc::new(native::Service::new(
                                owned.connection.as_ref().unwrap().clone(),
                                selection,
                                owned.peers.clone(),
                            )?),
                        }
                    };
                    published.push(value);
                }
            }
            owned.check_approval(&source, &consumers, &retain, &catalogue)?;
            staged.push(Some((approved, consumers, catalogue)));
        }
        if required.iter().any(|target| !targets.contains(target)) {
            return Err("UI source selects an endpoint outside its configured grants".into());
        }
        // Complete the whole batch's known validation before changing any grant.
        // Physical IO failure still belongs to its original connection, not rollback.
        for (owned, approval) in self.hosts.iter_mut().zip(staged) {
            let Some((approved, consumers, catalogue)) = approval else {
                owned.peers.update(None, &BTreeSet::new())?;
                continue;
            };
            let epochs = catalogue.as_ref().map(crate::transport::Catalogue::epochs);
            owned
                .approve(source.clone(), consumers, retain.clone(), catalogue)
                .await?;
            owned.peers.update(approved, &retain)?;
            owned.epochs = epochs.unwrap_or_default();
        }
        for owned in &mut self.hosts {
            if !consumers(&plan, &owned.configuration.name).is_empty() {
                owned.published = true;
            }
        }
        self.registrations = published.clone();
        Ok(published)
    }
    /// Retention only: removing a ticket never delegates new consumers or
    /// changes an endpoint. Complete all known checks before revoking locally.
    pub fn revoke_sources(&mut self, retain: &BTreeSet<u64>) -> Result<()> {
        if self.phase != Phase::Started {
            return Err("Host connections are not ready for retention".into());
        }
        for owned in &self.hosts {
            owned.peers.check_update(None, retain)?;
        }
        for owned in &self.hosts {
            owned.peers.update(None, retain)?;
        }
        Ok(())
    }

    /// Acknowledge retention on each original physical controller. Revocation
    /// may already have happened locally; IO uncertainty stays in that owner.
    pub async fn retain_sources(&mut self, retain: BTreeSet<u64>) -> Result<()> {
        self.revoke_sources(&retain)?;
        let mut failures = Vec::new();
        for owned in self.hosts.iter_mut().filter(|owned| owned.published) {
            if let Err(error) = owned
                .approve(self.source.clone(), BTreeSet::new(), retain.clone(), None)
                .await
            {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    /// Fence UI calls synchronously, then confirm their original physical cleanup.
    /// Public session detachment never claims Host cleanup or waits for Host exit.
    pub fn close(&mut self) -> BoxFuture<'_, Result<()>> {
        self.close_with(crate::ExitMode::KeepHost)
    }
    pub fn close_with(&mut self, mode: crate::ExitMode) -> BoxFuture<'_, Result<()>> {
        self.phase = Phase::Closing;
        let physical: Vec<_> = self
            .hosts
            .iter()
            .map(|host| {
                host.connection
                    .as_ref()
                    .map(|connection| connection.close())
            })
            .collect();
        async move {
            let namespaces = &self.namespaces;
            let closes: Vec<_> = self
                .hosts
                .iter_mut()
                .zip(physical)
                .map(|(host, physical)| async move {
                    if let Some(physical) = physical {
                        physical.await?;
                    }
                    host.close_owner(mode, namespaces).await
                })
                .collect();
            let results = join_all(closes).await;
            if let Some(error) = results.into_iter().find_map(Result::err) {
                return Err(error);
            }
            self.registrations.clear();
            self.hosts.clear();
            self.prepared.clear();
            // Closed execution cannot reactivate factories. Release its borrowed
            // Store and compiled target handles after all original cleanup; the
            // launcher still owns and closes the independent SQL worker.
            self.cohost_native = Default::default();
            drop(self.store.take());
            self.phase = Phase::Closed;
            Ok(())
        }
        .boxed()
    }
    /// Unconfirmed UI cleanup retains its original owners and runtime. Historical
    /// receipts or a detached public session cannot settle a failed physical Call.
    pub async fn drain(&mut self) {
        self.drain_with(crate::ExitMode::KeepHost).await;
    }
    pub async fn drain_with(&mut self, mode: crate::ExitMode) {
        let mut reported = BTreeSet::new();
        loop {
            match self.close_with(mode).await {
                Ok(()) => return,
                Err(error) => {
                    if reported.insert(error.clone()) {
                        eprintln!("local Host cleanup unconfirmed: {error:?}");
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}
