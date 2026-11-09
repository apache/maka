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

use super::*;
use futures_util::future::Shared;
use maka_agent_api::executor::{ExternalConfiguration, NativeCommand, NativeRuntime};
use maka_agent_ports::executor::RootSettlementOwner;
use maka_agent_ports::executor::{Outcome, Request};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

mod agy;
mod attachments;
mod claude;
mod codex;
mod discovery;
mod history;
mod journal;
mod mcp;
mod replay;
mod runtime;
mod steering;
mod tools;
pub(crate) use history::Inputs;
pub(crate) use tools::{HostEffects, HostTools};

/// Observation addresses from the original runtime acknowledgement. None is a
/// permission to submit another prompt or reconstruct a lost process owner.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "runtime", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum NativeTask {
    Codex {
        thread: String,
        turn: String,
    },
    Claude {
        session: String,
        transcript: PathBuf,
        offset: u64,
        prompt: String,
        images: usize,
    },
    ClaudeStream {
        session: String,
        input: String,
    },
    Antigravity {
        conversation: String,
        user_step: u64,
    },
}

/// Native's original task owner durably records this before accepting outputs.
/// A failed acknowledgement is not permission to replay native submission.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeBinding {
    /// Version of this adapter-owned descriptor, not a claimed native server version.
    pub adapter_version: u32,
    pub command_basis: String,
    pub resource: maka_process::isolated::Descriptor,
    pub snapshot: maka_process::isolated::SnapshotProof,
    pub task: NativeTask,
}

pub(crate) trait TaskBinding: Send + Sync {
    fn observation_retired(&self) -> CancellationToken;
    fn admitted_steering_batches(&self) -> BoxFuture<'_, Result<u64, Error>>;
    fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>>;
    fn closed(&self, outcome: Outcome) -> BoxFuture<'_, Result<(), Error>>;
    /// Original Root resources only, not quiescence of every private descendant.
    /// Success means the source owns the proof and any pending SQL ACK, not that the fact is durable.
    fn cleanup(&self, cleanup: OperationCleanup) -> BoxFuture<'_, Result<(), Error>>;
    fn bound(&self, binding: NativeBinding) -> BoxFuture<'_, Result<(), Error>>;
}

pub(crate) enum NativeTaskObservation {
    Known {
        outcome: Outcome,
    },
    Blocked {
        reason: maka_agent_facts::durable::BlockerKind,
        diagnostic: String,
    },
}

struct CatalogSnapshot {
    cwd: String,
    selected: Option<NativeRuntime>,
    started: Instant,
    result: Shared<BoxFuture<'static, Result<Value, Error>>>,
}

impl CatalogSnapshot {
    fn reusable(&self) -> bool {
        let Some(result) = self.result.peek() else {
            return true;
        };
        let Ok(catalog) = result else {
            return false;
        };
        let rows = match self.selected {
            Some(_) => std::slice::from_ref(catalog),
            None => catalog
                .as_array()
                .expect("unscoped native catalog is an array"),
        };
        self.started.elapsed() < Duration::from_secs(30)
            && !rows.iter().any(|row| {
                ["installation", "models"].iter().any(|field| {
                    row.get(field)
                        .and_then(|value| value.get("kind"))
                        .and_then(Value::as_str)
                        == Some("error")
                })
            })
    }
}
enum Catalog {
    Empty,
    Cached(CatalogSnapshot),
    Failed(Error),
}
impl Catalog {
    fn failure(&self) -> Result<(), Error> {
        match self {
            Self::Failed(error) => Err(error.clone()),
            _ => Ok(()),
        }
    }
    fn invalidate(&mut self) {
        if !matches!(self, Self::Failed(_)) {
            *self = Self::Empty;
        }
    }
    fn admit(
        &self,
        resources: &Arc<maka_plugin_core::work::resources::Resources>,
    ) -> Result<maka_plugin_core::work::resources::Ticket, Error> {
        self.failure()?;
        resources.reserve().map_err(|_| Error::Retired)
    }
    fn observe(&mut self, result: &Result<Value, Error>) {
        if let Err(error @ (Error::Unknown | Error::CleanupUnconfirmed)) = result
            && !matches!(self, Self::Failed(Error::CleanupUnconfirmed))
        {
            *self = Self::Failed(error.clone());
        }
    }
}

pub(crate) struct External {
    commands: BTreeMap<NativeRuntime, NativeCommand>,
    queries: Arc<maka_plugin_core::work::resources::Resources>,
    catalog: tokio::sync::Mutex<Catalog>,
    stop: CancellationToken,
    endpoints: tokio::sync::Mutex<BTreeMap<(String, NativeRuntime), Arc<mcp::Endpoint>>>,
    root: Arc<RootStore>,
    package: String,
    activation: String,
    pub basis: String,
}
impl External {
    pub fn capture(
        context: &NativeContext,
        configuration: &ExternalConfiguration,
    ) -> Result<Arc<Self>, String> {
        let persistence = context
            .persistence()
            .ok_or("External agents require persistence")?;
        let mut commands = BTreeMap::new();
        for runtime in configuration.enabled_runtimes() {
            let command =
                configuration
                    .command(runtime)
                    .cloned()
                    .unwrap_or_else(|| NativeCommand {
                        executable: runtime.executable().into(),
                        args: Vec::new(),
                        env: BTreeMap::new(),
                    });
            runtime::validate_command(runtime, &command)?;
            commands.insert(runtime, command);
        }
        let basis = hex::encode(Sha256::digest(
            serde_json::to_vec(&(context.activation().epoch(), &commands))
                .map_err(|e| e.to_string())?,
        ));
        Ok(Arc::new(Self {
            commands,
            queries: Arc::default(),
            catalog: tokio::sync::Mutex::new(Catalog::Empty),
            stop: CancellationToken::new(),
            endpoints: tokio::sync::Mutex::new(BTreeMap::new()),
            root: persistence.store().clone(),
            package: context.package().id.clone(),
            activation: context.activation().epoch().to_string(),
            basis,
        }))
    }
    pub(crate) fn source_identity(&self) -> maka_agent_facts::executor::Binding {
        maka_agent_facts::executor::Binding {
            executor_id: "external"
                .to_owned()
                .try_into()
                .expect("external executor identity"),
            package_id: self.package.clone(),
            entry_id: "external".into(),
            activation: self.activation.clone(),
        }
    }
    pub(super) fn command(&self, runtime: NativeRuntime) -> &NativeCommand {
        &self.commands[&runtime]
    }
    pub fn admit(
        self: &Arc<Self>,
        request: Request,
        host_tools: Option<HostTools>,
        binding: Arc<dyn TaskBinding>,
        inputs: Arc<dyn Inputs>,
        isolated: maka_process::isolated::TaskOwner,
        credential_seeds: Vec<super::CredentialSeed>,
    ) -> Result<Admitted, Error> {
        self.require_runtime(request.settings.runtime.as_deref())?;
        Ok(Admitted {
            identity: self.source_identity(),
            execution: Box::new(Call {
                owner: self.clone(),
                request,
                host_tools,
                binding,
                inputs,
                isolated,
                credential_seeds,
            }),
        })
    }
    /// A resource address locates original evidence, not permission to restart
    /// its CLI. OS closure alone cannot establish native business completion.
    #[expect(
        clippy::too_many_arguments,
        reason = "read-only replay verifies the original cursor and Root-owned prefix before publication"
    )]
    pub async fn observe_task(
        &self,
        request: &Request,
        binding: &NativeBinding,
        descriptor: maka_agent_facts::durable::ContentRef,
        after_index: u64,
        expected_prefix: Option<[u8; 32]>,
        output: Arc<dyn OutputSink>,
        lifecycle: Arc<dyn TaskBinding>,
        cancellation: CancellationToken,
    ) -> Result<NativeTaskObservation, Error> {
        if cancellation.is_cancelled() || lifecycle.observation_retired().is_cancelled() {
            return Err(Error::ObservationRetired);
        }
        let blocked = |diagnostic: String| NativeTaskObservation::Blocked {
            reason: maka_agent_facts::durable::BlockerKind::ExternalTaskUnobservable {
                descriptor: descriptor.clone(),
            },
            diagnostic,
        };
        let runtime = match &binding.task {
            NativeTask::Codex { .. } => NativeRuntime::Codex,
            NativeTask::Antigravity { .. } => NativeRuntime::Antigravity,
            NativeTask::Claude { .. } | NativeTask::ClaudeStream { .. } => NativeRuntime::Claude,
        };
        if binding.adapter_version != 2
            || request
                .settings
                .runtime
                .as_deref()
                .and_then(|runtime| runtime.parse::<NativeRuntime>().ok())
                != Some(runtime)
        {
            return Ok(blocked(
                "Original native binding protocol or runtime does not match this task".into(),
            ));
        }
        let evidence = match maka_process::isolated::closed_evidence(&binding.resource).await {
            Ok(Some(evidence)) => evidence,
            Ok(None) => {
                return Ok(blocked(
                    "Original isolated resource has no immutable tracked-group/stream closure"
                        .into(),
                ));
            }
            Err(error) => {
                return Ok(blocked(format!(
                    "Original isolated evidence is unavailable: {error}"
                )));
            }
        };
        let pipe_receipt = matches!(
            evidence.receipt,
            maka_process::isolated::TaskReceipt::Task {
                terminal_size: None,
                ..
            }
        );
        if evidence.snapshot != binding.snapshot
            || pipe_receipt != !matches!(binding.task, NativeTask::Claude { .. })
        {
            return Ok(blocked(
                "Original resource snapshot or transport receipt differs from the recorded binding"
                    .into(),
            ));
        }
        lifecycle.cleanup(OperationCleanup::Confirmed).await?;
        if matches!(binding.task, NativeTask::Claude { .. }) {
            return Ok(blocked("Original Claude PTY transcript is job-writable; it is not immutable native business-completion evidence".into()));
        }
        let expected_prefix = match expected_prefix {
            Some(prefix) => prefix,
            None if after_index == 0 => [0; 32],
            None => {
                return Ok(blocked(
                    "The current Root did not supply the original accepted output-prefix proof"
                        .into(),
                ));
            }
        };
        let admitted_steering_batches = lifecycle.admitted_steering_batches().await?;
        let retired = lifecycle.observation_retired();
        let mut input = replay::Stream::new(evidence.stdin, cancellation.clone(), retired.clone());
        let mut stream = replay::Stream::new(evidence.stdout, cancellation.clone(), retired);
        let count = replay::Count::new(after_index);
        let outcome = match replay::parse(
            request,
            binding,
            admitted_steering_batches,
            &mut input,
            &mut stream,
            &count,
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(error @ (Error::Cancelled | Error::ObservationRetired)) => return Err(error),
            Err(error) => {
                return Ok(blocked(format!(
                    "Original native protocol is not a complete correlated task: {error}"
                )));
            }
        };
        if count.total() < after_index || count.prefix() != expected_prefix {
            return Ok(blocked("Original native output prefix does not match the Root's accepted cursor and digest".into()));
        }
        input.rewind().await?;
        stream.rewind().await?;
        let suffix = replay::Suffix::new(after_index, output.as_ref());
        let replayed = replay::parse(
            request,
            binding,
            admitted_steering_batches,
            &mut input,
            &mut stream,
            &suffix,
        )
        .await?;
        if !replay::same_outcome(&outcome, &replayed) {
            return Ok(blocked(
                "Original protocol changed during read-only replay".into(),
            ));
        }
        lifecycle.closed(outcome.clone()).await?;
        Ok(NativeTaskObservation::Known { outcome })
    }
    pub(super) fn require_runtime(&self, runtime: Option<&str>) -> Result<NativeRuntime, Error> {
        let runtime = runtime
            .ok_or_else(|| Error::Invalid("External agent requires a runtime selection".into()))?
            .parse::<NativeRuntime>()
            .map_err(Error::Invalid)?;
        if !self.commands.contains_key(&runtime) {
            return Err(Error::Invalid(format!(
                "External agent runtime is not enabled: {}",
                runtime.as_str()
            )));
        }
        Ok(runtime)
    }
    pub async fn query(
        self: &Arc<Self>,
        cwd: String,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, Error> {
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let kind = request
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid("Missing external query kind".into()))?;
        if !matches!(kind, "status" | "catalog" | "models") {
            return Err(Error::Invalid("Unsupported external query kind".into()));
        }
        let selected = request
            .get("runtime")
            .map(|id| self.require_runtime(id.as_str()))
            .transpose()?;
        if selected.is_none() && kind == "models" {
            return Err(Error::Invalid("Models require a runtime selection".into()));
        }
        if kind == "catalog" {
            let (discovery, catalog_runtime) = {
                let mut cached = self.catalog.lock().await;
                cached.failure()?;
                if let Catalog::Cached(entry) = &*cached
                    && entry.cwd == cwd
                    && (entry.selected == selected
                        || (entry.selected.is_none() && entry.result.peek().is_some()))
                    && entry.reusable()
                {
                    (entry.result.clone(), entry.selected)
                } else {
                    let owner = self.clone();
                    let work_cwd = cwd.clone();
                    let discovery = async move {
                        owner
                            .discover(
                                work_cwd,
                                "catalog".into(),
                                selected,
                                owner.stop.child_token(),
                            )
                            .await
                    }
                    .boxed()
                    .shared();
                    let retained = discovery.clone();
                    tokio::spawn(async move {
                        let _ = retained.await;
                    });
                    *cached = Catalog::Cached(CatalogSnapshot {
                        cwd,
                        selected,
                        started: Instant::now(),
                        result: discovery.clone(),
                    });
                    (discovery, selected)
                }
            };
            return tokio::select! { biased;
                () = cancellation.cancelled() => Err(Error::Cancelled),
                () = self.stop.cancelled() => Err(Error::Retired),
                result = discovery => {
                    let value = result?;
                    if catalog_runtime.is_none() && let Some(runtime) = selected {
                        value.as_array().expect("unscoped native catalog is an array")
                            .iter().find(|row| row["runtime"].as_str() == Some(runtime.as_str()))
                            .cloned().ok_or_else(|| Error::Invalid("Native runtime missing from catalog".into()))
                    } else {
                        Ok(value)
                    }
                },
            };
        }
        if kind == "status" {
            self.catalog.lock().await.invalidate();
        }
        self.discover(cwd, kind.to_owned(), selected, cancellation)
            .await
    }
    async fn discover(
        self: &Arc<Self>,
        cwd: String,
        kind: String,
        selected: Option<NativeRuntime>,
        cancellation: CancellationToken,
    ) -> Result<Value, Error> {
        let mut ticket = self.catalog.lock().await.admit(&self.queries)?;
        let owner = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            ticket.start();
            let cancel = cancellation.child_token();
            let work = discovery::query(&owner.commands, &cwd, &kind, selected, cancel.clone());
            tokio::pin!(work);
            let result = tokio::select! {
                result = &mut work => result,
                () = owner.stop.cancelled() => { cancel.cancel(); work.await },
            };
            owner.catalog.lock().await.observe(&result);
            ticket.complete(if matches!(result, Err(Error::CleanupUnconfirmed)) {
                Err("Native discovery cleanup is unconfirmed".into())
            } else {
                Ok(())
            });
            let _ = send.send(result);
        });
        match receive.await {
            Ok(result) => result,
            Err(_) => {
                let result = Err(Error::CleanupUnconfirmed);
                self.catalog.lock().await.observe(&result);
                result
            }
        }
    }
    async fn ensure_endpoint(
        &self,
        conversation: &str,
        session: &str,
        runtime: NativeRuntime,
    ) -> Result<Arc<mcp::Endpoint>, Error> {
        let mut endpoints = self.endpoints.lock().await;
        if self.stop.is_cancelled() {
            return Err(Error::Retired);
        }
        let key = (conversation.to_owned(), runtime);
        if !endpoints.contains_key(&key) {
            let endpoint = mcp::Endpoint::open(session.to_owned(), None).await?;
            endpoints.insert(key.clone(), endpoint);
        }
        let endpoint = endpoints[&key].clone();
        if endpoint.session_id != session || self.stop.is_cancelled() {
            return Err(Error::Retired);
        }
        endpoint.local_addr().await?;
        Ok(endpoint)
    }
    async fn bridge(
        &self,
        request: &Request,
        tools: tools::Tools,
        directory: PathBuf,
    ) -> Result<Arc<mcp::Bridge>, Error> {
        let runtime = self.require_runtime(request.settings.runtime.as_deref())?;
        let endpoint = self
            .ensure_endpoint(
                &request.conversation_key,
                &request.execution.session_id,
                runtime,
            )
            .await?;
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|e| Error::Provider(e.to_string()))?;
        endpoint.bind(tools, directory)
    }
    pub async fn remove_sessions(&self, sessions: &[String]) -> Result<(), String> {
        let selected = self
            .endpoints
            .lock()
            .await
            .iter()
            .filter(|(_, endpoint)| sessions.contains(&endpoint.session_id))
            .map(|(key, endpoint)| (key.clone(), endpoint.clone()))
            .collect::<Vec<_>>();
        self.finish_endpoints(selected).await
    }
    async fn finish_endpoints(
        &self,
        selected: Vec<((String, NativeRuntime), Arc<mcp::Endpoint>)>,
    ) -> Result<(), String> {
        let mut failure = None;
        for (key, endpoint) in selected {
            match endpoint.finish().await {
                Ok(()) => {
                    let mut endpoints = self.endpoints.lock().await;
                    if endpoints
                        .get(&key)
                        .is_some_and(|current| Arc::ptr_eq(current, &endpoint))
                    {
                        endpoints.remove(&key);
                    }
                }
                Err(error) => failure = Some(error.to_string()),
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.stop.cancel();
        self.catalog.lock().await.invalidate();
        let selected = self
            .endpoints
            .lock()
            .await
            .iter()
            .map(|(key, endpoint)| (key.clone(), endpoint.clone()))
            .collect();
        let endpoints = self.finish_endpoints(selected).await;
        let queries = self.queries.finish().await.map_err(|e| e.to_string());
        queries?;
        endpoints
    }
}
impl super::Backend {
    /// Opens only the same Root-owned listener that a later fresh Call binds.
    /// The address is not authority: the original issuer must grant its route.
    #[cfg(test)]
    pub(crate) async fn prepare_native_endpoint(
        &self,
        session: &str,
        owner_stop: &CancellationToken,
    ) -> Result<std::net::SocketAddr, Error> {
        let super::Implementation::External(owner) = &self.implementation else {
            return Err(Error::Invalid(
                "Native endpoint requires the selected external backend".into(),
            ));
        };
        let runtime = owner.require_runtime(self.accepted.selection.settings.runtime.as_deref())?;
        if owner_stop.is_cancelled() || owner.stop.is_cancelled() {
            return Err(Error::Retired);
        }
        // session_retirement enters this original Root's fresh session gates;
        // transport preparation acquires no writer or accepted Work capability.
        let retiring = owner
            .root
            .session_retirement(session)
            .await
            .map_err(|e| Error::Persistence(e.to_string()))?
            .is_some();
        if owner_stop.is_cancelled() || owner.stop.is_cancelled() || retiring {
            return Err(Error::Retired);
        }
        // The sole fixture calls this before its send loop, not concurrently
        // with same-session send. Created custody here is not a general
        // concurrent unbound-close proof; retirement and Stop may still race.
        let key = (session.to_owned(), runtime);
        let (endpoint, created) = {
            let mut endpoints = owner.endpoints.lock().await;
            if owner_stop.is_cancelled() || owner.stop.is_cancelled() {
                return Err(Error::Retired);
            }
            match endpoints.entry(key.clone()) {
                std::collections::btree_map::Entry::Occupied(entry) => (entry.get().clone(), false),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    let endpoint = mcp::Endpoint::open(session.to_owned(), None).await?;
                    entry.insert(endpoint.clone());
                    (endpoint, true)
                }
            }
        };
        if endpoint.session_id != session {
            return Err(Error::Retired);
        }
        let address = endpoint.local_addr().await;
        let retirement = owner.root.session_retirement(session).await;
        let permanently_retired = owner_stop.is_cancelled()
            || owner.stop.is_cancelled()
            || matches!(&retirement, Ok(Some(_)));
        let result = match retirement {
            Err(error) => Err(Error::Persistence(error.to_string())),
            Ok(_) if permanently_retired => Err(Error::Retired),
            Ok(_) => address,
        };
        match result {
            Ok(address) => Ok(address),
            Err(cause) => {
                // A transient query/address failure cannot revoke a reused
                // live bridge. Only our new listener or known retirement is
                // ours to close; ptr_eq removal cannot affect a replacement.
                if created || permanently_retired {
                    if let Err(cleanup) = owner.finish_endpoints(vec![(key, endpoint)]).await {
                        return Err(Error::Persistence(format!(
                            "Native endpoint preparation failed: {cause}; original endpoint cleanup failed: {cleanup}"
                        )));
                    }
                }
                Err(cause)
            }
        }
    }
}
struct Call {
    owner: Arc<External>,
    request: Request,
    host_tools: Option<HostTools>,
    binding: Arc<dyn TaskBinding>,
    inputs: Arc<dyn Inputs>,
    isolated: maka_process::isolated::TaskOwner,
    credential_seeds: Vec<super::CredentialSeed>,
}
#[derive(Default)]
struct CallResources {
    pipes: std::sync::OnceLock<Arc<maka_plugin_core::work::resources::Resources>>,
    bridge: std::sync::OnceLock<Arc<mcp::Bridge>>,
    rejection: std::sync::Mutex<Option<Arc<PrelaunchRejection>>>,
}
struct PrelaunchRejection {
    seal: maka_process::isolated::NoLaunchSeal,
    message: String,
    binding: Arc<dyn TaskBinding>,
    recording: tokio::sync::Mutex<()>,
}
impl PrelaunchRejection {
    async fn settle_cleanup(&self) -> Result<(), Error> {
        let _recording = self.recording.lock().await;
        self.seal
            .record()
            .await
            .map_err(|error| Error::Persistence(error.to_string()))?;
        self.binding.cleanup(OperationCleanup::Confirmed).await?;
        Ok(())
    }
    async fn record(&self) -> Result<Outcome, Error> {
        self.settle_cleanup().await?;
        let outcome = Outcome::Failed {
            message: self.message.clone(),
            code: Some("native_input_rejected".into()),
            recoverable: false,
        };
        self.binding.closed(outcome.clone()).await?;
        Ok(outcome)
    }
}
impl maka_agent_ports::executor::RootSettlementOwner for CallResources {
    fn original_root_cleanup(&self) -> OperationCleanup {
        if self.pipes.get().is_none_or(|resources| resources.is_idle())
            && self.bridge.get().is_none_or(|bridge| bridge.drained())
            && self
                .rejection
                .lock()
                .expect("original rejection custody")
                .is_none()
        {
            OperationCleanup::Confirmed
        } else {
            OperationCleanup::Unconfirmed
        }
    }
    fn original_root_cleanup_signal(self: Arc<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let rejection = self
                .rejection
                .lock()
                .expect("original rejection custody")
                .clone();
            let rejection = async {
                if let Some(rejection) = rejection {
                    match rejection.settle_cleanup().await {
                        Ok(()) => {
                            self.rejection
                                .lock()
                                .expect("original rejection custody")
                                .take();
                        }
                        Err(error) => {
                            tracing::error!(%error, "Original no-launch rejection remains unsettled");
                            std::future::pending::<()>().await;
                        }
                    }
                }
            };
            let pipes = async {
                if let Some(resources) = self.pipes.get() {
                    if let Err(error) = resources.settle().await {
                        tracing::error!(%error, "Original pipe resource settlement remains unconfirmed");
                        std::future::pending::<()>().await;
                    }
                }
            };
            let bridge = async {
                if let Some(bridge) = self.bridge.get() {
                    let _business = bridge.close().await;
                    bridge.clone().original_root_cleanup_signal().await;
                }
            };
            tokio::join!(rejection, pipes, bridge);
        })
    }
}
impl executor::Execution for Call {
    fn execute(
        self: Box<Self>,
        execution: Arc<dyn maka_plugin_core::work::WorkCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Settlement> {
        Box::pin(async move {
            let resources = Arc::new(CallResources::default());
            let mut bridge = None;
            let result = self
                .run(execution, output, cancellation, &mut bridge, &resources)
                .await;
            if let Some(bridge) = bridge {
                let _ = resources.bridge.set(bridge.clone());
                let pending = resources
                    .pipes
                    .get()
                    .is_some_and(|pipes| pipes.has_pending());
                if !pending {
                    let _business = bridge.close().await;
                }
            }
            let cleanup = resources.original_root_cleanup();
            Settlement::new(result, cleanup, resources)
        })
    }
}
impl Call {
    async fn run(
        self: Box<Self>,
        execution: Arc<dyn maka_plugin_core::work::WorkCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
        root_bridge: &mut Option<Arc<mcp::Bridge>>,
        root_resources: &Arc<CallResources>,
    ) -> Result<Outcome, Error> {
        let Self {
            owner,
            request,
            host_tools,
            binding,
            inputs,
            isolated,
            credential_seeds,
        } = *self;
        if cancellation.is_cancelled() || binding.observation_retired().is_cancelled() {
            return Err(Error::ObservationRetired);
        }
        owner
            .root
            .session_for_work(execution.as_ref(), &request.execution.session_id)
            .map_err(|e| Error::Persistence(e.to_string()))?;
        seed_credentials(
            &credential_seeds,
            &isolated,
            &cancellation,
            &binding.observation_retired(),
        )
        .await?;
        let workspace = isolated.workspace();
        let cwd = workspace
            .to_str()
            .ok_or_else(|| Error::Invalid("Private workspace must be UTF-8".into()))?;
        let material_root = isolated.inputs();
        let mut config =
            owner.commands[&owner.require_runtime(request.settings.runtime.as_deref())?].clone();
        for (key, path) in [
            ("HOME", isolated.home()),
            ("CODEX_HOME", isolated.codex_home()),
            ("CLAUDE_CONFIG_DIR", isolated.claude_config_dir()),
        ] {
            config.env.insert(
                key.into(),
                path.to_str()
                    .ok_or_else(|| {
                        Error::Invalid("Private native configuration path must be UTF-8".into())
                    })?
                    .into(),
            );
        }
        let host_tools = tools::Tools::bind(
            host_tools.clone(),
            &request,
            execution.clone(),
            &owner,
            cancellation.clone(),
        )
        .await?;
        let (artifacts, scope) = inputs.artifacts();
        if scope.session != request.execution.session_id {
            return Err(Error::Invalid(
                "External artifact scope belongs to another session".into(),
            ));
        }
        let mut materials = match attachments::prepare(
            &artifacts,
            &scope,
            &request.content,
            &cancellation,
            &material_root,
        )
        .await
        {
            Ok(materials) => materials,
            Err(attachments::PreparationError::Source(error)) => return Err(error),
            Err(attachments::PreparationError::Unsupported(message)) => {
                let original = Arc::new(PrelaunchRejection {
                    seal: isolated.into_no_launch_seal(),
                    message,
                    binding,
                    recording: tokio::sync::Mutex::new(()),
                });
                *root_resources
                    .rejection
                    .lock()
                    .expect("original rejection custody") = Some(original.clone());
                let result = original.record().await;
                if result.is_ok() {
                    root_resources
                        .rejection
                        .lock()
                        .expect("original rejection custody")
                        .take();
                }
                return result;
            }
        };
        let runtime = owner.require_runtime(request.settings.runtime.as_deref())?;
        let command_basis = runtime::command_basis(&owner.commands[&runtime], &request.cwd)?;
        let mut journal = journal::ProtocolSession::new(
            binding.clone(),
            command_basis,
            &isolated,
            cancellation.clone(),
        );
        let _ = root_resources
            .pipes
            .set(journal.observation().resources.clone());
        let history_path = material_root.join(maka_agent_authority::executor::HISTORY_FILE);
        let mut options = tokio::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut history = options
            .open(&history_path)
            .await
            .map_err(|e| Error::Provider(format!("Canonical history file creation failed: {e}")))?;
        inputs
            .write_history(request.task_id, None, &mut history)
            .await?;
        tokio::io::AsyncWriteExt::flush(&mut history)
            .await
            .map_err(|e| Error::Provider(format!("Canonical history file flush failed: {e}")))?;
        let history_path = history_path
            .to_str()
            .ok_or_else(|| Error::Invalid("Private canonical history path must be UTF-8".into()))?;
        materials.message = format!(
            "Read the canonical conversation history from this private read-only input file before answering: {}\n\n--- Current user message ---\n{}",
            serde_json::to_string(history_path).expect("history path is JSON"),
            materials.message
        );
        if cancellation.is_cancelled() || binding.observation_retired().is_cancelled() {
            return Err(Error::ObservationRetired);
        }
        let mut steering = steering::Steering::new(
            artifacts,
            scope,
            cancellation.clone(),
            inputs.clone(),
            request.task_id,
            material_root.clone(),
        );
        let bridge = owner
            .bridge(&request, host_tools, material_root.join("mcp"))
            .await?;
        *root_bridge = Some(bridge.clone());
        let native_request = serde_json::json!({
            "kind":"execute", "runtime":request.settings.runtime, "cwd":cwd,
            "message":materials.message,
            "images":materials.images,
            "tools":bridge.definitions(),
        });
        let mut native_request = native_request.as_object().expect("worker request").clone();
        for (key, value) in [
            ("model", request.settings.model.as_deref()),
            (
                "effort",
                request.settings.thinking_level.as_ref().map(|e| e.as_str()),
            ),
            ("instructions", request.instructions.as_deref()),
            ("resume", journal.native_session()),
        ] {
            if let Some(value) = value {
                native_request.insert(key.into(), value.into());
            }
        }
        // Root settlement does not prove that escaping private writers are gone.
        // Retain this one task's inputs for private-resource GC, never for reuse.
        let _ = materials.handoff();
        runtime::execute(
            runtime,
            &config,
            cwd,
            native_request.into(),
            &mut journal,
            output,
            bridge,
            &mut steering,
            isolated,
        )
        .await
    }
}
async fn seed_credentials(
    seeds: &[super::CredentialSeed],
    owner: &maka_process::isolated::TaskOwner,
    cancellation: &CancellationToken,
    retired: &CancellationToken,
) -> Result<(), Error> {
    use std::path::Component;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for seed in seeds {
        if seed.relative.as_os_str().is_empty()
            || seed
                .relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(Error::Invalid(
                "Native credential seed must have a private relative path".into(),
            ));
        }
        let base = match seed.base {
            super::CredentialBase::Home => owner.home(),
            super::CredentialBase::CodexHome => owner.codex_home(),
            super::CredentialBase::ClaudeConfig => owner.claude_config_dir(),
        };
        let path = base.join(&seed.relative);
        tokio::fs::create_dir_all(path.parent().expect("private credential parent"))
            .await
            .map_err(|e| {
                Error::Provider(format!("Native credential directory creation failed: {e}"))
            })?;
        let mut options = tokio::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(path)
            .await
            .map_err(|e| Error::Provider(format!("Native credential seed creation failed: {e}")))?;
        let source = seed.file.try_clone().map_err(|e| {
            Error::Provider(format!("Native credential source duplication failed: {e}"))
        })?;
        let mut source = tokio::fs::File::from_std(source).take(seed.len);
        let copied = tokio::select! {
            biased;
            () = retired.cancelled() => return Err(Error::ObservationRetired),
            () = cancellation.cancelled() => return Err(Error::ObservationRetired),
            copied = tokio::io::copy(&mut source, &mut file) => copied.map_err(|e| Error::Provider(format!("Native credential seed copy failed: {e}")))?,
        };
        if copied != seed.len {
            return Err(Error::Invalid(
                "Native credential source did not yield its captured length".into(),
            ));
        }
        file.flush()
            .await
            .map_err(|e| Error::Provider(format!("Native credential seed flush failed: {e}")))?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{Mutex, oneshot};

    #[tokio::test]
    async fn evicted_catalog_probe_still_quarantines_metadata_and_drains_overlapping_status() {
        let cached = CatalogSnapshot {
            cwd: "workspace".into(),
            selected: None,
            started: Instant::now(),
            result: futures_util::future::pending::<Result<Value, Error>>()
                .boxed()
                .shared(),
        };
        let catalog = Arc::new(Mutex::new(Catalog::Cached(cached)));
        let resources = Arc::new(maka_plugin_core::work::resources::Resources::default());
        async fn probe(
            catalog: Arc<Mutex<Catalog>>,
            resources: Arc<maka_plugin_core::work::resources::Resources>,
            entered: oneshot::Sender<()>,
            release: oneshot::Receiver<Result<Value, Error>>,
        ) -> Result<Value, Error> {
            let mut ticket = catalog.lock().await.admit(&resources)?;
            ticket.start();
            entered.send(()).unwrap();
            let result = release.await.unwrap();
            catalog.lock().await.observe(&result);
            ticket.complete(if matches!(result, Err(Error::CleanupUnconfirmed)) {
                Err("probe cleanup unconfirmed".into())
            } else {
                Ok(())
            });
            result
        }
        let (catalog_entered, entered) = oneshot::channel();
        let (release_catalog, result) = oneshot::channel();
        let original = tokio::spawn(probe(
            catalog.clone(),
            resources.clone(),
            catalog_entered,
            result,
        ));
        entered.await.unwrap();
        catalog.lock().await.invalidate();
        assert!(matches!(*catalog.lock().await, Catalog::Empty));
        let (status_entered, entered) = oneshot::channel();
        let (release_status, result) = oneshot::channel();
        let status = tokio::spawn(probe(
            catalog.clone(),
            resources.clone(),
            status_entered,
            result,
        ));
        entered.await.unwrap();
        release_catalog
            .send(Err(Error::CleanupUnconfirmed))
            .unwrap();
        assert!(matches!(
            original.await.unwrap(),
            Err(Error::CleanupUnconfirmed)
        ));
        catalog.lock().await.invalidate();
        assert!(matches!(
            catalog.lock().await.admit(&resources),
            Err(Error::CleanupUnconfirmed)
        ));
        assert!(
            resources.has_pending(),
            "the admitted status probe must remain owned after its sibling fails"
        );
        release_status.send(Ok(serde_json::json!([]))).unwrap();
        status.await.unwrap().unwrap();
        assert!(!resources.has_pending());
        assert!(
            resources.reserve().is_ok(),
            "Resources alone do not quarantine discovery"
        );
        catalog.lock().await.invalidate();
        assert!(
            matches!(
                catalog.lock().await.admit(&resources),
                Err(Error::CleanupUnconfirmed)
            ),
            "clean status completion/refresh cannot erase the original fatal result"
        );
        assert!(resources.finish().await.is_err());
    }
}
