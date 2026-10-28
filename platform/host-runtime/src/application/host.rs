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

//! Authenticated public Host. One Application owns every accepted execution.
mod access;
mod client;
pub mod discovery;
mod lifecycle;
pub mod startup;
pub mod websocket;
pub use access::Pairing;
pub mod protocol;
pub use client::{CallChannelOpener, Client, LocalCall};
pub use discovery::Registration;
pub use protocol::{Configuration, LifecycleMode, Publication, Status, VERSION};

use super::transport::{
    Catalogue, Endpoints, HostEndpoint, Peer, PeerPolicy, Peers, Server, wire, with_gateway,
};
use super::{Application, NativeRegistry, Result};
use crate::ipc::{LocalListener, LocalStream};
use access::{Authority, Principal};
use maka_event_log::root_store::RootStore;
use maka_plugin_core::deployment::DeploymentRef;
use protocol::{Connected, Opening, Request, Response, SessionControl};
use sha2::Digest;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;
use websocket::WebSocketListener;

#[derive(Clone)]
pub struct Options {
    pub generation: Option<String>,
    pub lifecycle_mode: LifecycleMode,
    pub handshake_timeout: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            generation: None,
            lifecycle_mode: LifecycleMode::Service,
            handshake_timeout: Duration::from_secs(10),
        }
    }
}

/// Opened only from a checked, persisted source and trusted endpoint grants.
/// The caller retains this owner after any failed cleanup acknowledgement.
pub struct Host {
    root: Arc<maka_event_log::root::RootOwner>,
    options: Options,
    application: Application,
    store: Arc<RootStore>,
    access: Arc<maka_config::ConfigurationStore>,
    access_grant: Mutex<String>,
    access_gate: tokio::sync::Mutex<()>,
    epoch: Uuid,
    source: DeploymentRef,
    policy: Arc<PeerPolicy>,
    configuration: Mutex<Configuration>,
    sessions: Mutex<BTreeMap<Uuid, Arc<Session>>>,
    stop: CancellationToken,
    residency: Mutex<lifecycle::Residency>,
}
struct Session {
    principal: Principal,
    peer: Arc<Peers>,
    transport: Arc<Server>,
    mode: SessionMode,
    parent: Option<Uuid>,
}
enum SessionMode {
    Owned {
        selections: BTreeMap<String, HostEndpoint>,
    },
    Ui,
    Peer {
        source: DeploymentRef,
        selections: BTreeMap<String, HostEndpoint>,
    },
}
impl Host {
    pub async fn open(
        store: Arc<RootStore>,
        deployment: Uuid,
        native: NativeRegistry,
        scripts: Option<Arc<dyn super::backend::Factory>>,
        configuration: Configuration,
    ) -> Result<Arc<Self>> {
        Self::open_with_options(
            store,
            deployment,
            native,
            scripts,
            configuration,
            Options::default(),
        )
        .await
    }
    pub async fn open_with_options(
        store: Arc<RootStore>,
        deployment: Uuid,
        native: NativeRegistry,
        scripts: Option<Arc<dyn super::backend::Factory>>,
        configuration: Configuration,
        options: Options,
    ) -> Result<Arc<Self>> {
        let loaded = store
            .load_application(deployment)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("deployment not found")?;
        Self::open_loaded_with_options(store, loaded, native, scripts, configuration, options).await
    }

    /// Open a checked committed source without rereading its immutable packages.
    pub async fn open_loaded_with_options(
        store: Arc<RootStore>,
        loaded: maka_event_log::applications::LoadedDeployment,
        native: NativeRegistry,
        scripts: Option<Arc<dyn super::backend::Factory>>,
        configuration: Configuration,
        options: Options,
    ) -> Result<Arc<Self>> {
        if options.handshake_timeout.is_zero()
            || options
                .generation
                .as_ref()
                .is_some_and(|value| value.is_empty())
        {
            return Err("invalid Host options".into());
        }
        configuration.validate()?;
        let Configuration::PublicHost {
            endpoints,
            native: grants,
            ..
        } = &configuration;
        let root = store.owned_root().map_err(|error| error.to_string())?;
        let policy = Arc::new(PeerPolicy::with_native_grants(grants.clone())?);
        let application = Application::start_loaded(
            store.clone(),
            loaded,
            with_gateway(native)?,
            policy.issuer(),
            policy.clone(),
            scripts,
        )?;
        if let Err(error) = Endpoints::start(&application.client(), endpoints).await {
            application.shutdown().await?;
            return Err(error);
        }
        let access = match maka_config::ConfigurationStore::for_root(root.clone()).await {
            Ok(access) => Arc::new(access),
            Err(error) => {
                application.shutdown().await?;
                return Err(error.to_string());
            }
        };
        let access_grant = format!(
            "application.owner:{}",
            hex::encode(sha2::Sha256::digest(
                serde_json::to_vec(&(application.source(), &configuration))
                    .map_err(|error| error.to_string())?
            ))
        );
        Ok(Arc::new(Self {
            root,
            options,
            source: application.source().expect("persisted Host").clone(),
            application,
            store,
            access,
            access_grant: Mutex::new(access_grant),
            access_gate: tokio::sync::Mutex::new(()),
            policy,
            epoch: Uuid::new_v4(),
            configuration: Mutex::new(configuration),
            sessions: Mutex::default(),
            stop: CancellationToken::new(),
            residency: Mutex::new(lifecycle::Residency::default()),
        }))
    }

    async fn publication(&self) -> Result<Publication> {
        let _gate = self.access_gate.lock().await;
        if self.stop.is_cancelled() {
            return Err("Host is closing".into());
        }
        let source = self
            .store
            .application_head(self.source.deployment)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Host deployment source missing")?;
        Ok(Publication {
            source,
            configuration: self.configuration.lock().unwrap().clone(),
        })
    }

    /// This configuration step is durable independently of source replacement.
    /// The launcher's original pending operation coordinates their retries.
    async fn configure(
        &self,
        source: DeploymentRef,
        previous: Configuration,
        configuration: Configuration,
    ) -> Result<()> {
        previous.validate()?;
        configuration.validate()?;
        if source.state_domain != self.root_id() || source.deployment != self.source.deployment {
            return Err("foreign Host configuration source".into());
        }
        let _gate = self.access_gate.lock().await;
        if self.stop.is_cancelled() {
            return Err("Host is closing".into());
        }
        let Configuration::PublicHost { endpoints, .. } = &configuration;
        let resolved = Endpoints::capture(&self.application.client(), endpoints).await?;
        configuration.validate_product_methods(&previous, &Catalogue::captured(&resolved))?;
        let current = self.configuration.lock().unwrap().clone();
        let current = serde_json::to_value(current).map_err(|error| error.to_string())?;
        let previous = serde_json::to_value(previous).map_err(|error| error.to_string())?;
        let desired = serde_json::to_value(&configuration).map_err(|error| error.to_string())?;
        if current != previous && current != desired {
            return Err("Host configuration conflicts with current authority".into());
        }
        let record = self
            .store
            .application_launch()
            .await
            .map_err(|error| error.to_string())?
            .ok_or("public Host selection missing")?;
        if record.deployment != self.source.deployment {
            return Err("Host configuration selects another deployment".into());
        }
        // Optional domain fields may be omitted or explicitly empty. Compare
        // their typed meaning, but keep the exact stored JSON as the CAS witness.
        let persisted: Configuration = serde_json::from_value(record.configuration.clone())
            .map_err(|error| error.to_string())?;
        persisted.validate()?;
        let persisted = serde_json::to_value(persisted).map_err(|error| error.to_string())?;
        if persisted != previous && persisted != desired {
            return Err("Host configuration conflicts with persisted authority".into());
        }
        let access_grant = format!(
            "application.owner:{}",
            hex::encode(sha2::Sha256::digest(
                serde_json::to_vec(&(Some(&self.source), &configuration))
                    .map_err(|error| error.to_string())?
            ))
        );
        if !self
            .store
            .compare_and_set_application_launch_configuration(source, record.configuration, desired)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("Host configuration source or persisted authority changed".into());
        }
        // No await between durable confirmation and publication of live authority.
        // Existing sessions retain their captured bindings and accepted jobs.
        let Configuration::PublicHost { native, .. } = &configuration;
        self.policy.replace_native_grants(native.clone());
        *self.configuration.lock().unwrap() = configuration;
        *self.access_grant.lock().unwrap() = access_grant;
        Ok(())
    }
    pub fn root_id(&self) -> &str {
        self.root.root_id()
    }
    pub fn epoch(&self) -> Uuid {
        self.epoch
    }
    pub fn source(&self) -> &DeploymentRef {
        &self.source
    }
    pub fn status(&self) -> Status {
        let snapshot = self.application.client().snapshot();
        Status {
            root_id: self.root_id().to_owned(),
            version: VERSION,
            pid: std::num::NonZeroU32::new(std::process::id()).expect("process id"),
            generation: self.options.generation.clone(),
            lifecycle_mode: self.options.lifecycle_mode,
            epoch: self.epoch,
            source: self.source.clone(),
            closing: self.stop.is_cancelled() || snapshot.closing,
            closed: snapshot.closed,
            cleanup_error: snapshot.cleanup_error,
            sessions: self.sessions.lock().unwrap().len(),
            active_calls: snapshot
                .instances
                .iter()
                .map(|instance| instance.calls)
                .sum(),
        }
    }
    pub fn wait_for_drain(&self) -> impl Future<Output = ()> + Send + 'static {
        let stop = self.stop.clone();
        let mut updates = self.application.client().updates;
        async move {
            loop {
                if updates.borrow().closing {
                    return;
                }
                tokio::select! {
                    () = stop.cancelled() => return,
                    result = updates.changed() => if result.is_err() { return; },
                }
            }
        }
    }
    /// Current-account IPC is enforced by LocalListener's private directory/ACL
    /// and the held Unix peer credentials. No request chooses its own principal.
    pub async fn serve_local(
        self: &Arc<Self>,
        listener: LocalListener,
        cancel: CancellationToken,
    ) -> Result<()> {
        self.serve(listener, None, cancel).await
    }
    pub async fn serve(
        self: &Arc<Self>,
        mut listener: LocalListener,
        websocket: Option<WebSocketListener>,
        cancel: CancellationToken,
    ) -> Result<()> {
        enum Incoming {
            Local(LocalStream),
            Remote(tokio::net::TcpStream),
        }
        let tasks = TaskTracker::new();
        let accepted = loop {
            let stream = tokio::select! {
                biased;
                () = self.stop.cancelled() => break Ok(()),
                () = cancel.cancelled() => break Ok(()),
                value = listener.accept() => match value {
                    Ok(stream) => Incoming::Local(stream),
                    Err(error) => break Err(error.to_string()),
                },
                value = async {
                    match &websocket {
                        Some(listener) => listener.listener.accept().await,
                        None => std::future::pending().await,
                    }
                } => match value {
                    Ok((stream, _)) => Incoming::Remote(stream),
                    Err(error) => break Err(error.to_string()),
                },
            };
            let connection = {
                let mut residency = self.residency.lock().unwrap();
                if residency.paused || self.stop.is_cancelled() {
                    continue;
                }
                residency.connections += 1;
                residency.last_activity = tokio::time::Instant::now();
                lifecycle::Connection { host: self.clone() }
            };
            let host = self.clone();
            let origins = websocket
                .as_ref()
                .map(|listener| listener.allowed_origins.clone());
            tasks.spawn(async move {
                let _connection = connection;
                // A malformed or disconnected peer fails only its own channel.
                match stream {
                    Incoming::Local(stream) => {
                        let _ = host.connection(stream).await;
                    }
                    Incoming::Remote(stream) => {
                        let _ = websocket::connection(
                            stream,
                            host,
                            origins.expect("WebSocket listener"),
                        )
                        .await;
                    }
                }
            });
        };
        self.stop.cancel();
        tasks.close();
        tasks.wait().await;
        self.shutdown().await?;
        accepted
    }
    async fn connection(self: &Arc<Self>, stream: LocalStream) -> Result<()> {
        #[cfg(unix)]
        if stream.peer_cred().map_err(|error| error.to_string())?.uid()
            != unsafe { libc::geteuid() }
        {
            return Err("Host peer must belong to the current account".into());
        }
        self.channel(stream, Authority::Local).await
    }
    async fn channel<S>(self: &Arc<Self>, stream: S, authority: Authority) -> Result<()>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (input, mut output) = tokio::io::split(stream);
        let mut input = wire::Reader::new(input);
        let opening: Opening = tokio::select! {
            biased;
            () = self.stop.cancelled() => return Err("Host is closing".into()),
            value = tokio::time::timeout(self.options.handshake_timeout, input.read()) => value.map_err(|_| "Host handshake timed out")??,
        };
        if opening.version != VERSION || opening.epoch.is_some_and(|epoch| epoch != self.epoch) {
            return Err("Host protocol or incarnation changed".into());
        }
        match opening.request {
            Request::Status => {
                let gate = self.access_gate.lock().await;
                self.identify(&authority, opening.client_instance.as_deref())
                    .await?;
                drop(gate);
                wire::write(&mut output, &Response::Status(self.status())).await
            }
            Request::Publication => {
                authority.local()?;
                wire::write(
                    &mut output,
                    &Response::Publication(self.publication().await),
                )
                .await
            }
            Request::Configure {
                source,
                previous,
                configuration,
            } => {
                authority.local()?;
                let result = self.configure(source, previous, configuration).await;
                wire::write(&mut output, &Response::Configured(result)).await
            }
            Request::PrepareAccess { principal } => {
                authority.local()?;
                wire::write(
                    &mut output,
                    &Response::Pairing(self.prepare_access(principal).await),
                )
                .await
            }
            Request::RevokeAccess { credential } => {
                authority.local()?;
                wire::write(
                    &mut output,
                    &Response::Revoked(self.revoke_access(credential).await),
                )
                .await
            }
            Request::FinalizeAccess => {
                wire::write(
                    &mut output,
                    &Response::Finalized(
                        self.finalize_access(&authority, opening.client_instance)
                            .await,
                    ),
                )
                .await
            }
            Request::Retire {
                interrupt,
                allow_idle_connections,
            } => {
                authority.local()?;
                let result = self.retire(interrupt, allow_idle_connections).await;
                wire::write(&mut output, &Response::Retired(result)).await
            }
            Request::Quit { session: id } => {
                authority.local()?;
                let session = self.sessions.lock().unwrap().get(&id).cloned();
                if let Some(session) = session {
                    session.peer.replace(vec![])?;
                    session.transport.request_close();
                    self.close_ui_children(id).await?;
                    session.transport.close().await?;
                }
                let stop = {
                    // Admission and the last-session decision share the same gate.
                    let _gate = self.access_gate.lock().await;
                    let mut sessions = self.sessions.lock().unwrap();
                    sessions.remove(&id);
                    let stop = sessions.is_empty();
                    if stop {
                        self.residency.lock().unwrap().paused = true;
                        self.stop.cancel();
                    }
                    stop
                };
                if stop {
                    self.shutdown().await?;
                }
                wire::write(&mut output, &Response::Closed).await
            }
            request @ (Request::Connect
            | Request::ConnectPeer { .. }
            | Request::ConnectUi { .. }) => {
                let mut gate = Some(self.access_gate.lock().await);
                let principal = self
                    .identify(&authority, opening.client_instance.as_deref())
                    .await?;
                let (mode, peer, endpoints, consumers, source, ui, parent) = match request {
                    Request::Connect => {
                        let selections = {
                            let configuration = self.configuration.lock().unwrap();
                            let Configuration::PublicHost { endpoints, .. } = &*configuration;
                            endpoints.clone()
                        };
                        let consumers: BTreeMap<_, _> = selections
                            .iter()
                            .map(|(name, endpoint)| (name.clone(), endpoint.consumer.clone()))
                            .collect();
                        (
                            SessionMode::Owned {
                                selections: selections.clone(),
                            },
                            Peer::new(self.source.clone(), consumers.values().cloned().collect())?,
                            Endpoints::capture(&self.application.client(), &selections).await?,
                            consumers,
                            self.source.clone(),
                            None,
                            None,
                        )
                    }
                    Request::ConnectPeer {
                        source,
                        consumers,
                        endpoints: selections,
                    } => {
                        authority.local()?;
                        self.check_peer_selections(&selections)?;
                        let peer = Peer::new(source.clone(), consumers)?;
                        let endpoints =
                            Endpoints::capture(&self.application.client(), &selections).await?;
                        let consumers = selections
                            .iter()
                            .map(|(name, endpoint)| (name.clone(), endpoint.consumer.clone()))
                            .collect();
                        (
                            SessionMode::Peer { source, selections },
                            peer,
                            endpoints,
                            consumers,
                            self.source.clone(),
                            None,
                            None,
                        )
                    }
                    Request::ConnectUi {
                        owner,
                        source,
                        instance,
                    } => {
                        let parent = self.ui_parent(owner, &principal)?;
                        if source.state_domain != self.source.state_domain
                            || source.deployment != self.source.deployment
                        {
                            return Err("foreign UI deployment source".into());
                        }
                        drop(gate.take());
                        let loaded = self
                            .store
                            .load_application_at(&source)
                            .await
                            .map_err(|error| error.to_string())?
                            .ok_or("UI deployment source not found")?;
                        loaded
                            .plan()
                            .instances()
                            .get(&instance)
                            .filter(|entry| !entry.disabled && entry.ui_entry().is_some())
                            .ok_or("UI consumer is not declared and enabled")?;
                        drop(loaded);
                        let application = self.application.client();
                        let bindings = tokio::select! {
                            biased;
                            () = self.stop.cancelled() => return Err("Host is closing".into()),
                            () = parent.transport.wait_for_close() => return Err("UI owner session is closing".into()),
                            bindings = application.capture_ui(source.clone(), instance.clone()) => bindings?,
                        };
                        let mut endpoints = BTreeMap::new();
                        let mut imports = BTreeMap::new();
                        for (name, providers) in bindings {
                            let many = providers.len() > 1;
                            let mut names = Vec::new();
                            for (index, binding) in providers.into_iter().enumerate() {
                                let endpoint = if many {
                                    format!("{name}/{index}")
                                } else {
                                    name.clone()
                                };
                                let maka_plugin_core::contract::Interface::Service { methods } =
                                    &binding.contract().interface
                                else {
                                    return Err("UI import requires a service".into());
                                };
                                let grant = super::transport::Grant {
                                    methods: methods.keys().cloned().collect(),
                                    recovery: false,
                                };
                                if endpoints
                                    .insert(
                                        endpoint.clone(),
                                        super::transport::Endpoint::new(binding, grant)?,
                                    )
                                    .is_some()
                                {
                                    return Err("UI import endpoint names collide".into());
                                }
                                names.push(endpoint);
                            }
                            imports.insert(name, names);
                        }
                        let consumers = endpoints
                            .keys()
                            .map(|name| (name.clone(), instance.clone()))
                            .collect();
                        gate = Some(self.access_gate.lock().await);
                        if self
                            .identify(&authority, opening.client_instance.as_deref())
                            .await?
                            != principal
                        {
                            return Err("UI owner principal changed".into());
                        }
                        self.ui_parent(owner, &principal)?;
                        (
                            SessionMode::Ui,
                            Peer::new(source.clone(), [instance.clone()].into())?,
                            Endpoints::from(endpoints),
                            consumers,
                            source,
                            Some(protocol::UiConnection { instance, imports }),
                            Some(owner),
                        )
                    }
                    _ => unreachable!(),
                };
                let id = Uuid::new_v4();
                let session = Arc::new(Session {
                    principal,
                    peer: Peers::new(peer),
                    transport: Server::new(
                        self.application.client(),
                        self.policy.clone(),
                        endpoints,
                    )?,
                    mode,
                    parent,
                });
                {
                    let mut sessions = self.sessions.lock().unwrap();
                    let mut residency = self.residency.lock().unwrap();
                    if residency.paused || self.stop.is_cancelled() {
                        return Err("Host admission is paused".into());
                    }
                    residency.admitted = true;
                    sessions.insert(id, session.clone());
                }
                drop(gate);
                let result = async {
                    let connected = Connected {
                        version: VERSION,
                        epoch: self.epoch,
                        session: id,
                        source,
                        consumers,
                        catalogue: session.transport.catalogue(),
                        ui,
                    };
                    let response = Response::Connected(connected);
                    tokio::select! {
                        biased;
                        () = self.stop.cancelled() => return Err("Host is closing".into()),
                        result = wire::write(&mut output, &response) => result?,
                    }
                    let mut captured = None;
                    loop {
                        let command = tokio::select! {
                            biased;
                            () = self.stop.cancelled() => break Ok(()),
                            () = session.transport.wait_for_close() => break Ok(()),
                            result = input.read::<SessionControl>() => result?,
                        };
                        if matches!(command, SessionControl::Close) {
                            break Ok(());
                        }
                        let response = if matches!(command, SessionControl::Refresh) {
                            let result = async {
                                let SessionMode::Owned { selections } = &session.mode else {
                                    return Err("Peer sessions require captured approval".into());
                                };
                                let endpoints =
                                    Endpoints::start(&self.application.client(), selections)
                                        .await?;
                                let catalogue = Catalogue::captured(&endpoints);
                                wire::encode_bounded(
                                    &Response::Refreshed(Ok(catalogue.clone())),
                                    usize::MAX,
                                )?;
                                session.transport.replace_endpoints(endpoints)?;
                                Ok(catalogue)
                            }
                            .await;
                            Response::Refreshed(result)
                        } else {
                            let SessionMode::Peer {
                                source: origin,
                                selections,
                            } = &session.mode
                            else {
                                return Err("Host-owned session cannot approve peer sources".into());
                            };
                            match command {
                                SessionControl::Epochs => Response::Epochs(
                                    Endpoints::capture(&self.application.client(), selections)
                                        .await
                                        .map(|endpoints| endpoints.epochs()),
                                ),
                                SessionControl::Capture => {
                                    captured = None;
                                    let result =
                                        Endpoints::capture(&self.application.client(), selections)
                                            .await
                                            .map(|endpoints| {
                                                let catalogue = Catalogue::captured(&endpoints);
                                                captured = Some(endpoints);
                                                catalogue
                                            });
                                    let response = Response::Captured(result);
                                    if let Err(error) = wire::encode_bounded(&response, usize::MAX)
                                    {
                                        captured = None;
                                        Response::Captured(Err(format!(
                                            "cannot encode Host captured catalogue: {error}"
                                        )))
                                    } else {
                                        response
                                    }
                                }
                                SessionControl::Approve {
                                    source,
                                    consumers,
                                    retain,
                                    captured: expected,
                                } => {
                                    let result = (|| {
                                        source.validate()?;
                                        if source.state_domain != origin.state_domain
                                            || source.deployment != origin.deployment
                                        {
                                            return Err("foreign approval deployment".into());
                                        }
                                        let approved = if consumers.is_empty() {
                                            None
                                        } else {
                                            Some(Peer::new(source.clone(), consumers)?)
                                        };
                                        if approved.is_none() != expected.is_none() {
                                            return Err(
                                                "approval requires its captured endpoints".into()
                                            );
                                        }
                                        session.peer.check_update(approved.clone(), &retain)?;
                                        if let Some(expected) = expected {
                                            let endpoints = captured
                                                .take()
                                                .ok_or("Host endpoints were not captured")?;
                                            if Catalogue::captured(&endpoints) != expected {
                                                return Err("Host captured endpoints differ".into());
                                            }
                                            session.transport.replace_endpoints(endpoints)?;
                                        }
                                        session.peer.update(approved, &retain)
                                    })();
                                    Response::Approved { source, result }
                                }
                                SessionControl::Close | SessionControl::Refresh => unreachable!(),
                            }
                        };
                        tokio::select! {
                            biased;
                            () = self.stop.cancelled() => break Ok(()),
                            () = session.transport.wait_for_close() => break Ok(()),
                            result = wire::write(&mut output, &response) => result?,
                        }
                    }
                }
                .await;
                // Revocation fences late admissions, then the same transport
                // drains all original calls before releasing the session.
                session.peer.replace(vec![])?;
                session.transport.request_close();
                self.close_ui_children(id).await?;
                session.transport.close().await?;
                {
                    let _gate = self.access_gate.lock().await;
                    self.sessions.lock().unwrap().remove(&id);
                }
                // EOF or a partial control frame still requests this same
                // session's drain. Only the completed cleanup above authorizes
                // its acknowledgement; writing that acknowledgement may fail.
                wire::write(&mut output, &Response::Closed).await?;
                result
            }
            Request::Call { session } => {
                let gate = self.access_gate.lock().await;
                if self.stop.is_cancelled() || self.residency.lock().unwrap().paused {
                    return Err("Host admission is closed".into());
                }
                let principal = self
                    .identify(&authority, opening.client_instance.as_deref())
                    .await?;
                let session = self
                    .sessions
                    .lock()
                    .unwrap()
                    .get(&session)
                    .cloned()
                    .ok_or("Host session is unavailable")?;
                if session.principal != principal {
                    return Err("Host session belongs to another authenticated principal".into());
                }
                drop(gate);
                wire::write(&mut output, &Response::Accepted).await?;
                // Carry buffered bytes into the existing bounded transport.
                match &session.mode {
                    SessionMode::Owned { .. } | SessionMode::Ui => {
                        session
                            .transport
                            .serve_owned(input.inner, output, session.peer.clone())?
                            .await
                    }
                    SessionMode::Peer { .. } => {
                        session
                            .transport
                            .serve(input.inner, output, session.peer.clone())?
                            .await
                    }
                }
            }
        }
    }
    fn ui_parent(&self, owner: Uuid, principal: &Principal) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(&owner)
            .filter(|session| {
                &session.principal == principal
                    && matches!(session.mode, SessionMode::Owned { .. })
                    && !session.transport.is_closing()
            })
            .cloned()
            .ok_or("UI binding capture requires a live owner session".into())
    }

    async fn close_ui_children(&self, owner: Uuid) -> Result<()> {
        let children: Vec<_> = {
            let _gate = self.access_gate.lock().await;
            self.sessions
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, session)| session.parent == Some(owner))
                .map(|(id, session)| (*id, session.clone()))
                .collect()
        };
        for (_, child) in &children {
            child.peer.replace(vec![])?;
            child.transport.request_close();
        }
        for (_, child) in &children {
            child.transport.close().await?;
        }
        let _gate = self.access_gate.lock().await;
        let mut sessions = self.sessions.lock().unwrap();
        for (id, _) in children {
            sessions.remove(&id);
        }
        Ok(())
    }

    fn check_peer_selections(&self, selections: &BTreeMap<String, HostEndpoint>) -> Result<()> {
        if selections.is_empty() {
            return Err("invalid peer endpoint selections".into());
        }
        let configuration = self.configuration.lock().unwrap();
        let Configuration::PublicHost {
            endpoints: published,
            ..
        } = &*configuration;
        for (name, selection) in selections {
            selection.validate()?;
            let published = published
                .get(name)
                .ok_or("Host endpoint is not published")?;
            if selection.consumer != published.consumer
                || selection.import != published.import
                || !selection.grant.methods.is_subset(&published.grant.methods)
                || (selection.grant.recovery && !published.grant.recovery)
            {
                return Err("peer endpoint exceeds the published Host grant".into());
            }
        }
        Ok(())
    }
    /// Physical transport cleanup precedes Application cleanup and SQL drain.
    /// Errors retain this Host and its original Root for the embedding to hold.
    pub async fn shutdown(&self) -> Result<()> {
        self.stop.cancel();
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        for session in sessions {
            session.peer.replace(vec![])?;
            session.transport.close().await?;
        }
        self.application.shutdown().await?;
        self.access
            .shutdown()
            .await
            .map_err(|error| error.to_string())?;
        self.store.drain().await;
        self.sessions.lock().unwrap().clear();
        Ok(())
    }
}
