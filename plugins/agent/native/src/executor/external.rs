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
use catalog::Catalog;
use maka_agent_api::executor::{ExternalConfiguration, NativeCommand, NativeRuntime};
use maka_agent_ports::executor::RootSettlementOwner;
use maka_agent_ports::executor::{Outcome, Request};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

mod agy;
mod agy_acp;
#[cfg(unix)]
pub mod agy_front;
mod attachments;
pub(super) mod catalog;
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
const PRESENTATION_VERSION: u32 = 3;
const AGY_ACP_VERSION: u32 = 5;
const CONTEXT_VERSION: u32 = 6;
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
    ClaudePty {
        session: String,
    },
    ClaudeStream {
        session: String,
        input: String,
    },
    AntigravityAcp {
        session: String,
        prompt_id: u64,
    },
}

impl NativeTask {
    pub(super) fn is_pty(&self) -> bool {
        matches!(self, Self::Claude { .. } | Self::ClaudePty { .. })
    }
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
    pub snapshot: Option<maka_process::isolated::SnapshotProof>,
    pub task: NativeTask,
}

impl NativeBinding {
    pub(super) fn supported(&self) -> bool {
        matches!(
            self.adapter_version,
            2 | PRESENTATION_VERSION | AGY_ACP_VERSION | CONTEXT_VERSION
        )
    }
}

pub(crate) trait TaskBinding: Send + Sync {
    fn observation_retired(&self) -> CancellationToken;
    fn owner_stop(&self) -> CancellationToken;
    fn admitted_steering_batches(&self) -> BoxFuture<'_, Result<u64, Error>>;
    fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>>;
    fn closed(&self, outcome: Outcome) -> BoxFuture<'_, Result<(), Error>>;
    /// Original Root resources only, not quiescence of every private descendant.
    /// Success means the source owns the proof and any pending SQL ACK, not that the fact is durable.
    fn cleanup(&self, cleanup: OperationCleanup) -> BoxFuture<'_, Result<(), Error>>;
    fn bound(&self, binding: NativeBinding) -> BoxFuture<'_, Result<(), Error>>;
}

#[expect(
    clippy::large_enum_variant,
    reason = "An original task observation transfers its terminal outcome or blocker as one owned value"
)]
pub(crate) enum NativeTaskObservation {
    Known {
        outcome: Outcome,
    },
    Blocked {
        reason: maka_agent_facts::durable::BlockerKind,
        diagnostic: String,
    },
}

fn interrupted() -> Outcome {
    Outcome::Cancelled {
        reason: Some("External agent exited before finishing".into()),
    }
}

async fn await_closed_task(
    resource: &maka_process::isolated::Descriptor,
    cancellation: &CancellationToken,
    retired: &CancellationToken,
) -> Result<maka_process::isolated::ClosedEvidence, Error> {
    use maka_process::isolated::{self, EvidenceInterest, EvidenceWatch};

    let unavailable = |error: isolated::Error| Error::Provider(error.to_string());
    if let Some(evidence) = isolated::closed_evidence(resource)
        .await
        .map_err(unavailable)?
    {
        return Ok(evidence);
    }
    let mut watch = EvidenceWatch::open(resource, EvidenceInterest::Cleanup)
        .await
        .map_err(unavailable)?;
    let observed = tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(Error::ObservationRetired),
        () = retired.cancelled() => Err(Error::ObservationRetired),
        result = watch.wait() => result.map_err(unavailable),
    };
    watch.close().await.map_err(unavailable)?;
    observed?;
    isolated::closed_evidence(resource)
        .await
        .map_err(unavailable)?
        .ok_or(Error::Unknown)
}

pub(crate) struct External {
    #[cfg(unix)]
    agy_fronts: agy_front::Fronts,
    commands: BTreeMap<NativeRuntime, NativeCommand>,
    queries: Arc<maka_plugin_core::work::resources::Resources>,
    catalog: tokio::sync::Mutex<Catalog>,
    catalog_changes: tokio::sync::watch::Sender<()>,
    stop: CancellationToken,
    endpoints: tokio::sync::Mutex<BTreeMap<(String, NativeRuntime), Arc<mcp::Endpoint>>>,
    root: Arc<RootStore>,
    sessions: maka_host_runtime::storage::Storage,
    package: String,
    activation: String,
    pub basis: String,
}
impl External {
    pub fn capture(
        context: &NativeContext,
        configuration: &ExternalConfiguration,
        declaration: &Binding,
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
        let root = persistence
            .store()
            .owned_root()
            .map_err(|error| error.to_string())?;
        // Own-export evidence follows the actual logical owner, not its live
        // activation. It includes the declaration, configuration and imports.
        let basis = hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                "maka.native-external-basis.v1",
                root.root_id(),
                &persistence.source().state_domain,
                persistence.source().deployment,
                context.activation().instance(),
                context.package(),
                declaration.execution_basis(),
                &commands,
            ))
            .map_err(|e| e.to_string())?,
        ));
        let prefix = hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                &persistence.source().state_domain,
                persistence.source().deployment,
                context.activation().instance(),
            ))
            .map_err(|error| error.to_string())?,
        ));
        let sessions = maka_host_runtime::storage::Storage::new(
            persistence.store().clone(),
            format!("{prefix}/"),
            maka_plugin_core::storage::Namespace::new(
                "maka.agent.external",
                maka_plugin_core::scope::Scope::Profile,
            )
            .map_err(|error| error.to_string())?,
        );
        Ok(Arc::new(Self {
            #[cfg(unix)]
            agy_fronts: Default::default(),
            commands,
            sessions,
            queries: Arc::default(),
            catalog: tokio::sync::Mutex::new(Catalog::default()),
            catalog_changes: tokio::sync::watch::channel(()).0,
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
    pub fn admit(
        self: &Arc<Self>,
        request: Request,
        host_tools: Option<HostTools>,
        binding: Arc<dyn TaskBinding>,
        inputs: Arc<dyn Inputs>,
        isolated: maka_process::isolated::TaskOwner,
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
            NativeTask::AntigravityAcp { .. } => NativeRuntime::Antigravity,
            NativeTask::Claude { .. }
            | NativeTask::ClaudePty { .. }
            | NativeTask::ClaudeStream { .. } => NativeRuntime::Claude,
        };
        if !binding.supported()
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
        let retired = lifecycle.observation_retired();
        // The original helper owns these bytes. Recovery does not use the
        // current executable, configuration or credentials to observe them.
        let evidence = match await_closed_task(&binding.resource, &cancellation, &retired).await {
            Ok(evidence) => evidence,
            Err(error @ Error::ObservationRetired) => return Err(error),
            Err(error) => return Ok(blocked(error.to_string())),
        };
        let pipe_receipt = matches!(
            evidence.receipt,
            maka_process::isolated::TaskReceipt::Task {
                terminal_size: None,
                ..
            }
        );
        if evidence.snapshot != binding.snapshot || pipe_receipt != !binding.task.is_pty() {
            return Ok(blocked(
                "Original resource snapshot or transport receipt differs from the recorded binding"
                    .into(),
            ));
        }
        lifecycle.cleanup(OperationCleanup::Confirmed).await?;
        let outcome = if binding.task.is_pty() {
            // The child controls the PTY transcript. Retain only the output already
            // accepted by Maka, and use the owner receipt to end the interrupted run.
            interrupted()
        } else {
            let admitted_steering_batches = lifecycle.admitted_steering_batches().await?;
            let mut input =
                replay::Stream::new(evidence.stdin, cancellation.clone(), retired.clone());
            let mut stream = replay::Stream::new(evidence.stdout, cancellation, retired);
            let count = replay::Count::new(after_index);
            match replay::parse(
                request,
                binding,
                admitted_steering_batches,
                &mut input,
                &mut stream,
                &count,
            )
            .await
            {
                Ok(outcome)
                    if count.total() >= after_index
                        && (expected_prefix == Some(count.prefix())
                            || after_index == 0 && expected_prefix.is_none()) =>
                {
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
                    outcome
                }
                Err(error @ (Error::Cancelled | Error::ObservationRetired)) => return Err(error),
                Err(error) => {
                    tracing::debug!(%error, "Closed native task has no recoverable completion");
                    interrupted()
                }
                Ok(_) => {
                    tracing::warn!("Closed native task output differs from the accepted history");
                    interrupted()
                }
            }
        };
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
        if !matches!(kind, "status" | "models" | "usage_limits") {
            return Err(Error::Invalid("Unsupported external query kind".into()));
        }
        let selected = request
            .get("runtime")
            .map(|id| self.require_runtime(id.as_str()))
            .transpose()?;
        if selected.is_none() && kind == "models" {
            return Err(Error::Invalid("Models require a runtime selection".into()));
        }
        if kind == "usage_limits" && !selected.is_some_and(NativeRuntime::reports_usage_limits) {
            return Err(Error::Invalid(
                "Usage limits require a supported runtime".into(),
            ));
        }
        if kind == "status" {
            self.catalog.lock().await.invalidate();
        }
        self.discover(cwd, kind.to_owned(), selected, cancellation)
            .await
    }
    pub(super) fn catalog_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.catalog_changes.subscribe()
    }

    pub(super) async fn catalog(
        self: &Arc<Self>,
        cwd: String,
        selected: Option<NativeRuntime>,
        read: catalog::Read,
        cancellation: CancellationToken,
    ) -> Result<(Vec<Value>, bool), Error> {
        let mut changes = self.catalog_changes();
        let mut cache = self.catalog.lock().await;
        cache.failure()?;
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let (generation, work) = cache.prepare(
            &cwd,
            self.commands
                .keys()
                .copied()
                .filter(|runtime| selected.is_none_or(|selected| selected == *runtime)),
            read != catalog::Read::Snapshot,
        );
        for runtime in work {
            let owner = self.clone();
            let cwd = cwd.clone();
            tokio::spawn(async move {
                let result = owner
                    .discover(
                        cwd,
                        "catalog".into(),
                        Some(runtime),
                        owner.stop.child_token(),
                    )
                    .await;
                owner
                    .catalog
                    .lock()
                    .await
                    .publish(generation, runtime, result);
                owner.catalog_changes.send_modify(|_| {});
            });
        }
        loop {
            changes.borrow_and_update();
            cache.failure()?;
            if !cache.is_current(generation) {
                return Err(Error::Invalid(
                    "Native catalog workspace changed; retry the read".into(),
                ));
            }
            let snapshot = cache.snapshot(selected);
            if read != catalog::Read::Resolve || !snapshot.1 {
                return Ok(snapshot);
            }
            drop(cache);
            tokio::select! { biased;
                () = cancellation.cancelled() => return Err(Error::Cancelled),
                () = self.stop.cancelled() => return Err(Error::Retired),
                result = changes.changed() => result.map_err(|_| Error::Retired)?,
            }
            cache = self.catalog.lock().await;
        }
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
            let endpoint = mcp::Endpoint::open(session.to_owned()).await?;
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
        #[cfg(unix)]
        let fronts = self.agy_fronts.finish().await;
        let queries = self.queries.finish().await.map_err(|e| e.to_string());
        let sessions = self.sessions.finish().await;
        #[cfg(unix)]
        fronts?;
        queries?;
        endpoints?;
        sessions
    }
}
struct Call {
    owner: Arc<External>,
    request: Request,
    host_tools: Option<HostTools>,
    binding: Arc<dyn TaskBinding>,
    inputs: Arc<dyn Inputs>,
    isolated: maka_process::isolated::TaskOwner,
}
#[derive(Default)]
struct CallResources {
    pipes: std::sync::OnceLock<Arc<maka_plugin_core::work::resources::Resources>>,
    bridge: std::sync::OnceLock<Arc<mcp::Bridge>>,
    rejection: std::sync::Mutex<Option<Arc<PrelaunchRejection>>>,
}
struct PrelaunchRejection {
    seal: maka_process::isolated::NoLaunchSeal,
    code: &'static str,
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
            code: Some(self.code.into()),
            recoverable: false,
        };
        self.binding.closed(outcome.clone()).await?;
        Ok(outcome)
    }
}
async fn reject_prelaunch(
    isolated: maka_process::isolated::TaskOwner,
    binding: Arc<dyn TaskBinding>,
    root_resources: &Arc<CallResources>,
    code: &'static str,
    message: String,
) -> Result<Outcome, Error> {
    let original = Arc::new(PrelaunchRejection {
        seal: isolated.into_no_launch_seal(),
        code,
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
    result
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
                if let Some(resources) = self.pipes.get()
                    && let Err(error) = resources.settle().await
                {
                    tracing::error!(%error, "Original pipe resource settlement remains unconfirmed");
                    std::future::pending::<()>().await;
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
        } = *self;
        if cancellation.is_cancelled() || binding.observation_retired().is_cancelled() {
            return Err(Error::ObservationRetired);
        }
        owner
            .root
            .session_for_work(execution.as_ref(), &request.execution.session_id)
            .map_err(|e| Error::Persistence(e.to_string()))?;
        let cwd = request.cwd.as_str();
        let material_root = isolated.inputs();
        enum PrelaunchError {
            Rejected { code: &'static str, message: String },
            Other(Error),
        }
        impl From<Error> for PrelaunchError {
            fn from(error: Error) -> Self {
                match error {
                    Error::Invalid(_) | Error::Provider(_) => Self::Rejected {
                        code: "native_preparation_failed",
                        message: error.to_string(),
                    },
                    other => Self::Other(other),
                }
            }
        }
        let prepared = async {
            let runtime = owner.require_runtime(request.settings.runtime.as_deref())?;
            let config = &owner.commands[&runtime];
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
                )
                .into());
            }
            let mut materials = match attachments::prepare(
                &artifacts,
                &scope,
                &request.content,
                request.language,
                &cancellation,
                &material_root,
            )
            .await
            {
                Ok(materials) => materials,
                Err(attachments::PreparationError::Source(error)) => return Err(error.into()),
                Err(attachments::PreparationError::Unsupported(message)) => {
                    return Err(PrelaunchError::Rejected {
                        code: "native_input_rejected",
                        message,
                    });
                }
            };
            let command_basis = runtime::command_basis(config, cwd)?;
            let journal = journal::ProtocolSession::load(
                owner.sessions.clone(),
                &request,
                binding.clone(),
                command_basis,
                &isolated,
                cancellation.clone(),
            )
            .await?;
            let _ = root_resources
                .pipes
                .set(journal.observation().resources.clone());
            let history_path = material_root.join(maka_agent_authority::executor::HISTORY_FILE);
            let mut options = tokio::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut history = options.open(&history_path).await.map_err(|e| {
                Error::Provider(format!("Canonical history file creation failed: {e}"))
            })?;
            inputs
                .write_history(request.task_id, journal.last_delivered_run(), &mut history)
                .await?;
            tokio::io::AsyncWriteExt::flush(&mut history).await.map_err(|e| {
                Error::Provider(format!("Canonical history file flush failed: {e}"))
            })?;
            if history
                .metadata()
                .await
                .map_err(|error| Error::Provider(error.to_string()))?
                .len()
                != 0
            {
                let history_path = history_path.to_str().ok_or_else(|| {
                    Error::Invalid("Private canonical history path must be UTF-8".into())
                })?;
                materials.message = format!(
                    "Read the prior conversation context from this file before answering: {}\n\n--- Current user message ---\n{}",
                    serde_json::to_string(history_path).expect("history path is JSON"),
                    materials.message
                );
            }
            if cancellation.is_cancelled() || binding.observation_retired().is_cancelled() {
                return Err(PrelaunchError::Other(Error::ObservationRetired));
            }
            let steering = steering::Steering::new(
                artifacts,
                scope,
                request.language,
                cancellation.clone(),
                inputs.clone(),
                request.task_id,
                material_root.clone(),
            );
            let bridge = owner
                .bridge(&request, host_tools, material_root.join("mcp"))
                .await?;
            Ok((runtime, materials, journal, steering, bridge))
        }
        .await;
        let (runtime, mut materials, mut journal, mut steering, bridge) = match prepared {
            Ok(prepared) => prepared,
            Err(PrelaunchError::Rejected { code, message })
                if !cancellation.is_cancelled()
                    && !binding.observation_retired().is_cancelled() =>
            {
                return reject_prelaunch(isolated, binding, root_resources, code, message).await;
            }
            Err(PrelaunchError::Rejected { .. }) => return Err(Error::ObservationRetired),
            Err(PrelaunchError::Other(error)) => return Err(error),
        };
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
            &owner,
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
