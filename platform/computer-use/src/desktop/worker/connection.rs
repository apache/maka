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

//! One connection retains each original request and its authorization until settlement.

use super::callbacks::{
    CallbackFault, ParentCallbacks, ParentCapabilities, ScopeIdentity, WorkerMessage,
};
use super::{
    AuthorizationMode, BrowserAuthorizationRequest, Failure, ParentFrame, Process, Request,
    WorkerFrame, authorization_cleanup, connection_error, failed, read, write,
};
#[cfg(all(target_os = "windows", feature = "native-desktop"))]
use crate::native_interruption::own_observation as own_native_observation;
use crate::{BrowserAuthorization, protocol::Command};
use maka_agent_facts::tools::ToolError;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

const WIRE_BUFFER: usize = 64;

type Completion = Result<(), ToolError>;
pub(in crate::desktop) type AudioObservation = watch::Receiver<Option<Completion>>;

#[derive(Debug)]
pub(in crate::desktop) struct Reply {
    pub(in crate::desktop) value: Value,
    pub(in crate::desktop) audio: Option<AudioObservation>,
}

#[derive(Clone)]
pub(in crate::desktop) struct Connection {
    requests: mpsc::UnboundedSender<Invocation>,
    sealed: CancellationToken,
    fault: watch::Receiver<Option<ToolError>>,
    closed: watch::Receiver<Option<CloseSettlement>>,
}

struct Invocation {
    request: Request,
    capabilities: ParentCapabilities,
    cancellation: CancellationToken,
    reply: oneshot::Sender<Result<Reply, ToolError>>,
    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    native_admission: Option<tokio::sync::OwnedMutexGuard<()>>,
    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    native_source: Option<NativeCallSource>,
}

struct Pending {
    native_observer: Option<Arc<dyn crate::NativeInterruptionObserver>>,
    frames: mpsc::UnboundedSender<Result<WorkerFrame, ToolError>>,
    response_received: bool,
    identity: Option<ScopeIdentity>,
    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    native_retirement: Option<NativeRetirement>,
    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    native_call: bool,
}

#[cfg(all(target_os = "windows", feature = "native-desktop"))]
#[derive(Clone)]
pub(super) struct NativeCallSource {
    pub key: super::native_owner::NativeKey,
    pub operation_id: Option<String>,
    pub observer: Option<Arc<dyn crate::NativeInterruptionObserver>>,
    pub binding: Option<crate::NativeBindingSource>,
}
#[cfg(all(target_os = "windows", feature = "native-desktop"))]
struct NativeRetirement {
    key: super::native_owner::NativeKey,
    source: Option<Arc<NativeCallSource>>,
}
#[cfg(all(target_os = "windows", feature = "native-desktop"))]
impl NativeRetirement {
    fn covers(&self, native: &NativeConnection) -> bool {
        self.key == native.key
            && match (&self.source, &native.observation.borrow().source) {
                (Some(retired), Some(current)) => Arc::ptr_eq(retired, current),
                (None, None) => true,
                _ => false,
            }
    }
}
#[cfg(all(target_os = "windows", feature = "native-desktop"))]
struct NativeConnection {
    key: super::native_owner::NativeKey,
    observation: watch::Sender<super::native_owner::NativeObservation>,
    generation: super::native_owner::NativeGeneration,
    interruption: Option<crate::NativeInterruption>,
    pending_observer: Option<crate::InterruptionFuture>,
    deferred: Option<Settled>,
    affected_request: Option<u64>,
}

struct NativeProxyBinding {
    invocation_id: u64,
    identity: ScopeIdentity,
    inner: crate::native_interruption::WireNativeSource,
    observer: Arc<dyn crate::NativeInterruptionObserver>,
}
enum CustodianSettlement {
    Request(Settled),
    NativeNotice {
        id: u64,
        identity: ScopeIdentity,
        result: Completion,
    },
}

struct AudioCapture {
    completion: watch::Sender<Option<Completion>>,
    start_acknowledged: bool,
}

struct Settled {
    id: u64,
    result: Result<Reply, ToolError>,
    reply: oneshot::Sender<Result<Reply, ToolError>>,
    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    _native_admission: Option<tokio::sync::OwnedMutexGuard<()>>,
    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    native_source: Option<NativeCallSource>,
}

fn combine_connection_completion(transport: Completion, remainders: Completion) -> Completion {
    match (transport, remainders) {
        (Ok(()), result) | (result, Ok(())) => result,
        (Err(original), Err(cleanup)) => Err(preserve_operation_observation(
            ToolError::CleanupUnconfirmed(format!("{original}; {cleanup}")),
            original,
        )),
    }
}

impl Connection {
    pub(super) fn start(process: Process) -> Self {
        Self::start_inner(
            process,
            None,
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            None,
        )
    }

    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    pub(super) fn start_native(
        process: Process,
        stop: CancellationToken,
        key: super::native_owner::NativeKey,
        generation: super::native_owner::NativeGeneration,
        observation: watch::Sender<super::native_owner::NativeObservation>,
    ) -> Self {
        Self::start_inner(
            process,
            Some(stop),
            Some(NativeConnection {
                key,
                observation,
                generation,
                interruption: None,
                pending_observer: None,
                deferred: None,
                affected_request: None,
            }),
        )
    }

    fn start_inner(
        mut process: Process,
        native_stop: Option<CancellationToken>,
        #[cfg(all(target_os = "windows", feature = "native-desktop"))] native: Option<
            NativeConnection,
        >,
    ) -> Self {
        let (input, output) = process
            .pipes
            .take()
            .expect("handshaken process owns its pipes");
        let (connection, mut task) = Self::channel();
        #[cfg(all(target_os = "windows", feature = "native-desktop"))]
        {
            task.native = native;
        }
        tokio::spawn(async move {
            let mut kill_failure: Option<std::io::Error> = None;
            let transport = {
                let run = task.run_wire(input, output);
                tokio::pin!(run);
                #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                {
                    match native_stop {
                        Some(stop) => tokio::select! {
                            result = &mut run => result,
                            _ = stop.cancelled() => {
                                kill_failure = process.stop_native().await.err();
                                // Keep the original IPC request custodians;
                                // child exit releases their real response pipe.
                                run.await
                            },
                        },
                        None => run.await,
                    }
                }
                #[cfg(not(all(target_os = "windows", feature = "native-desktop")))]
                {
                    let _ = native_stop;
                    run.await
                }
            };
            let physical_wait = process.disconnect();
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            let pending_observer = task
                .native
                .as_mut()
                .and_then(|native| native.pending_observer.take());
            #[cfg(not(all(target_os = "windows", feature = "native-desktop")))]
            let pending_observer: Option<crate::InterruptionFuture> = None;
            let (cleanup, remainders, observed) =
                tokio::join!(physical_wait, task.finish_requests(), async {
                    match pending_observer {
                        Some(future) => Some(future.await),
                        None => None,
                    }
                });
            let transport = combine_connection_completion(transport, remainders);
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            if let (Some(native), Some(observed)) = (task.native.as_mut(), observed) {
                native
                    .observation
                    .send_modify(|state| state.persisted = Some(observed));
            }
            #[cfg(not(all(target_os = "windows", feature = "native-desktop")))]
            let _ = observed;
            let cleanup = cleanup.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!(
                    "Windows desktop worker exit was not confirmed: {error}"
                ))
            });
            let cleanup = match kill_failure.take() {
                Some(error) => Err(ToolError::CleanupUnconfirmed(format!(
                    "native-only child stop failed: {error}; process settlement: {cleanup:?}"
                ))),
                None => cleanup,
            };
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            let cleanup = if let Some(native) = task.native.as_ref() {
                let retired = native
                    .observation
                    .borrow()
                    .retired
                    .clone()
                    .unwrap_or_else(|| {
                        Err(ToolError::CleanupUnconfirmed(
                            "native owner exited without owned-input retirement proof".into(),
                        ))
                    });
                match (cleanup, retired) {
                    (Ok(()), result) | (result, Ok(())) => result,
                    (Err(process), Err(inputs)) => Err(ToolError::CleanupUnconfirmed(format!(
                        "{inputs}; {process}"
                    ))),
                }
            } else {
                cleanup
            };
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            if let Some(native) = task.native.as_mut() {
                if let Some(mut settled) = native.deferred.take() {
                    if cleanup.is_ok() {
                        if let (Some(interruption), Some(source)) =
                            (native.interruption.clone(), settled.native_source.take())
                        {
                            if source.key == native.key {
                                if let (Some(operation), Some(observer)) =
                                    (source.operation_id, source.observer)
                                {
                                    match crate::NativeInterruptionDrain::from_drained_native(
                                        interruption,
                                        operation,
                                    ) {
                                        Ok(observed) => {
                                            // Await the original Host drain future before delivering
                                            // this same action's original Unknown result.
                                            if let Err(error) = own_native_observation(|| {
                                                observer.drained(observed)
                                            })
                                            .await
                                            {
                                                native.observation.send_modify(|state| {
                                                    state.persisted = Some(Err(error))
                                                });
                                            }
                                        }
                                        Err(error) => {
                                            native.observation.send_modify(|state| {
                                                state.persisted = Some(Err(error))
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                    drop(settled._native_admission);
                    let _ = settled.reply.send(settled.result);
                }
            }
            let settlement = CloseSettlement {
                transport,
                process: cleanup,
            };
            if settlement.native_cleanup_error().is_some()
                && let Err(error) = settlement.clone().cleanup()
            {
                task.fault.send_replace(Some(connection_error(&error)));
            }
            task.closed.send_replace(Some(settlement));
        });
        connection
    }

    #[cfg(all(test, target_os = "windows", feature = "native-desktop"))]
    pub(super) fn native_retirement_fixture(
        key: super::native_owner::NativeKey,
        generation: super::native_owner::NativeGeneration,
        observation: watch::Sender<super::native_owner::NativeObservation>,
    ) -> (Self, tokio::io::DuplexStream) {
        let (parent, peer) = tokio::io::duplex(8192);
        let (input, output) = tokio::io::split(parent);
        let (connection, mut task) = Self::channel();
        task.native = Some(NativeConnection {
            key,
            observation,
            generation,
            interruption: None,
            pending_observer: None,
            deferred: None,
            affected_request: None,
        });
        tokio::spawn(async move {
            let transport = task.run(output, input).await;
            task.closed.send_replace(Some(CloseSettlement {
                transport,
                process: Ok(()),
            }));
        });
        (connection, peer)
    }

    #[cfg(all(test, target_os = "windows", feature = "native-desktop"))]
    pub(super) fn native_fixture_without_process() -> Self {
        Self::channel().0
    }

    fn channel() -> (Self, ConnectionTask) {
        let (requests, receive) = mpsc::unbounded_channel();
        let sealed = CancellationToken::new();
        let (fault, fault_observation) = watch::channel(None);
        let (closed, closed_observation) = watch::channel(None);
        (
            Self {
                requests,
                sealed: sealed.clone(),
                fault: fault_observation,
                closed: closed_observation,
            },
            ConnectionTask {
                receive,
                sealed,
                fault,
                closed,
                #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                native: None,
                native_proxy: None,
                requests: JoinSet::new(),
                callback_custody: None,
            },
        )
    }

    pub(super) fn fault(&self) -> Option<ToolError> {
        self.fault.borrow().clone()
    }

    pub(in crate::desktop) async fn invoke(
        &self,
        request: Request,
        authorization: Option<Arc<dyn BrowserAuthorization>>,
        cancellation: CancellationToken,
    ) -> Result<Reply, ToolError> {
        self.invoke_capabilities(
            request,
            ParentCapabilities {
                authorization,
                ..Default::default()
            },
            cancellation,
        )
        .await
    }

    pub(in crate::desktop) async fn invoke_browser(
        &self,
        request: Request,
        invocation: &crate::InvocationContext<'_>,
        cancellation: CancellationToken,
    ) -> Result<Reply, ToolError> {
        self.begin_browser(request, invocation, cancellation)?.await
    }

    pub(in crate::desktop) fn begin_browser(
        &self,
        mut request: Request,
        invocation: &crate::InvocationContext<'_>,
        cancellation: CancellationToken,
    ) -> Result<maka_agent_facts::tools::ToolFuture<Reply>, ToolError> {
        // This private context field is captured from the real Host invocation,
        // never from the model Command or a previously active invocation.
        match &mut request {
            Request::Invoke {
                preparation_policy, ..
            }
            | Request::LeaseChild {
                preparation_policy, ..
            } => {
                *preparation_policy = invocation.browser_preparation_policy().clone();
            }
            _ => {}
        }
        if let Request::Invoke {
            native_observer_available,
            ..
        } = &mut request
        {
            *native_observer_available = invocation.native_interruption_observer().is_some();
        }
        let authorization = invocation.browser_authorization();
        self.begin_capabilities(
            request,
            ParentCapabilities {
                attachment: authorization
                    .as_ref()
                    .and_then(|authority| authority.attachment()),
                authorization,
                files: invocation.browser_asset_files(),
                effects: invocation.browser_host_effects(),
                settlement: invocation.operation_settlement(),
                native_interruption: invocation.native_interruption_observer(),
            },
            cancellation,
        )
    }

    async fn invoke_capabilities(
        &self,
        request: Request,
        capabilities: ParentCapabilities,
        cancellation: CancellationToken,
    ) -> Result<Reply, ToolError> {
        self.begin_capabilities(request, capabilities, cancellation)?
            .await
    }

    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    pub(super) async fn invoke_native(
        &self,
        request: Request,
        cancellation: CancellationToken,
        admission: tokio::sync::OwnedMutexGuard<()>,
        source: NativeCallSource,
    ) -> Result<Reply, ToolError> {
        self.begin_capabilities_with_native(
            request,
            ParentCapabilities::default(),
            cancellation,
            Some(admission),
            Some(source),
        )?
        .await
    }

    fn begin_capabilities(
        &self,
        request: Request,
        capabilities: ParentCapabilities,
        cancellation: CancellationToken,
    ) -> Result<maka_agent_facts::tools::ToolFuture<Reply>, ToolError> {
        self.begin_capabilities_with_native(
            request,
            capabilities,
            cancellation,
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            None,
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            None,
        )
    }

    fn begin_capabilities_with_native(
        &self,
        request: Request,
        capabilities: ParentCapabilities,
        cancellation: CancellationToken,
        #[cfg(all(target_os = "windows", feature = "native-desktop"))] native_admission: Option<
            tokio::sync::OwnedMutexGuard<()>,
        >,
        #[cfg(all(target_os = "windows", feature = "native-desktop"))] native_source: Option<
            NativeCallSource,
        >,
    ) -> Result<maka_agent_facts::tools::ToolFuture<Reply>, ToolError> {
        if let Some(error) = self.fault() {
            return Err(error);
        }
        if self.sealed.is_cancelled() {
            return Err(failed("Windows desktop worker is closed"));
        }
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before dispatch"));
        }
        let (reply, result) = oneshot::channel();
        self.requests
            .send(Invocation {
                request,
                capabilities,
                cancellation,
                reply,
                #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                native_admission,
                #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                native_source,
            })
            .map_err(|_| {
                self.fault()
                    .unwrap_or_else(|| failed("Windows desktop worker is closed"))
            })?;
        let connection = self.clone();
        Ok(Box::pin(async move { connection.observe(result).await }))
    }

    async fn observe(
        &self,
        result: oneshot::Receiver<Result<Reply, ToolError>>,
    ) -> Result<Reply, ToolError> {
        let result = match result.await {
            Ok(result) => result,
            Err(error) => {
                let lost = ToolError::OutcomeUnknown(format!(
                    "Windows desktop request observation was lost: {error}"
                ));
                self.sealed.cancel();
                return match self.settlement().await {
                    Ok(settled) => match settled.native_cleanup_error() {
                        Some(cleanup) => {
                            Err(ToolError::CleanupUnconfirmed(format!("{lost}; {cleanup}")))
                        }
                        None => Err(lost),
                    },
                    Err(cleanup) => {
                        Err(ToolError::CleanupUnconfirmed(format!("{lost}; {cleanup}")))
                    }
                };
            }
        };
        let needs_close = matches!(
            &result,
            Err(ToolError::CleanupUnconfirmed(_) | ToolError::OperationCleanupUnconfirmed { .. })
        ) || (matches!(
            &result,
            Err(ToolError::OutcomeUnknown(_) | ToolError::OperationUnknown { .. })
        ) && self.fault().is_some());
        if needs_close {
            self.sealed.cancel();
            let cleanup = match self.settlement().await {
                Ok(settled) => settled.native_cleanup_error(),
                Err(error) => Some(error),
            };
            if let Some(cleanup) = cleanup
                && let Err(original) = &result
                && cleanup.to_string() != original.to_string()
            {
                return Err(preserve_operation_observation(
                    ToolError::CleanupUnconfirmed(format!("{original}; {cleanup}")),
                    original.clone(),
                ));
            }
        }
        result
    }

    pub(in crate::desktop) async fn close(&self) -> Completion {
        self.sealed.cancel();
        self.settlement().await?.cleanup()
    }

    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    pub(super) async fn retire_native(&self, key: super::native_owner::NativeKey) -> Completion {
        if self.sealed.is_cancelled() {
            return Err(ToolError::CleanupUnconfirmed(
                "native control channel sealed before guard retirement".into(),
            ));
        }
        let (reply, receive) = oneshot::channel();
        self.requests
            .send(Invocation {
                request: Request::NativeRetire { key },
                capabilities: ParentCapabilities::default(),
                cancellation: CancellationToken::new(),
                reply,
                native_admission: None,
                native_source: None,
            })
            .map_err(|_| {
                ToolError::CleanupUnconfirmed(
                    "native guard-retirement control channel is closed".into(),
                )
            })?;
        // A failed guard ACK must keep its owner available for actual cleanup
        // retry. It does not auto-seal or declare the older action settled.
        receive.await.map_err(|error| {
            ToolError::CleanupUnconfirmed(format!(
                "native guard-retirement observation was lost: {error}"
            ))
        })??;
        Ok(())
    }

    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    pub(super) async fn native_process_cleanup(&self) -> Completion {
        self.settlement()
            .await?
            .native_cleanup_error()
            .map_or(Ok(()), Err)
    }

    async fn settlement(&self) -> Result<CloseSettlement, ToolError> {
        let mut closed = self.closed.clone();
        loop {
            if let Some(result) = closed.borrow().clone() {
                return Ok(result);
            }
            closed.changed().await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!(
                    "Windows desktop close observation was lost: {error}"
                ))
            })?;
        }
    }
}

#[derive(Clone)]
struct CloseSettlement {
    transport: Completion,
    process: Completion,
}

impl CloseSettlement {
    fn native_cleanup_error(&self) -> Option<ToolError> {
        match (&self.transport, &self.process) {
            (
                Err(
                    transport @ (ToolError::OperationUnknown { .. }
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                ),
                Err(process),
            ) => Some(preserve_operation_observation(
                ToolError::CleanupUnconfirmed(format!("{transport}; {process}")),
                transport.clone(),
            )),
            (_, Err(error))
            | (
                Err(
                    error @ (ToolError::CleanupUnconfirmed(_)
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                ),
                _,
            ) => Some(error.clone()),
            _ => None,
        }
    }

    fn cleanup(self) -> Completion {
        match (self.transport, self.process) {
            (Ok(()), result) => result,
            (
                Err(
                    error @ (ToolError::CleanupUnconfirmed(_)
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                ),
                Ok(()),
            ) => Err(error),
            (Err(error), Ok(())) => Err(preserve_operation_observation(
                ToolError::CleanupUnconfirmed(format!(
                    "Windows desktop cleanup was not confirmed: {error}"
                )),
                error,
            )),
            (Err(transport), Err(process)) => Err(preserve_operation_observation(
                ToolError::CleanupUnconfirmed(format!("{transport}; {process}")),
                transport,
            )),
        }
    }
}

struct ConnectionTask {
    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
    native: Option<NativeConnection>,
    native_proxy: Option<NativeProxyBinding>,
    requests: JoinSet<CustodianSettlement>,
    callback_custody: Option<ParentCallbacks>,
    receive: mpsc::UnboundedReceiver<Invocation>,
    sealed: CancellationToken,
    fault: watch::Sender<Option<ToolError>>,
    closed: watch::Sender<Option<CloseSettlement>>,
}

impl ConnectionTask {
    fn native_notice(
        &mut self,
        invocation_id: u64,
        identity: &ScopeIdentity,
        notice: crate::native_interruption::WireNativeNotice,
        pending: &HashMap<u64, Pending>,
    ) -> crate::InterruptionFuture {
        use crate::native_interruption::{WireNativeNotice, own_observation};
        let rejected = |message: &str| -> crate::InterruptionFuture {
            let message = message.to_owned();
            Box::pin(async move { Err(failed(message)) })
        };
        #[cfg(all(target_os = "windows", feature = "native-desktop"))]
        if self.native.is_some() {
            return rejected("native-only executor refuses outer observer proxy notices");
        }
        let mapped_source =
            |outer: &ScopeIdentity, inner: &crate::native_interruption::WireNativeSource| {
                // inner epoch is an actual Windows-local counter; public Host
                // observations use the exact original Parent epoch binding.
                crate::NativeBindingSource::from_bound_native(
                    outer.session.clone(),
                    outer.turn.clone(),
                    outer.epoch.clone(),
                    inner.generation.clone(),
                    inner.operation_id.clone(),
                )
            };
        match notice {
            WireNativeNotice::Bound(inner) => {
                let Some(request) = pending.get(&invocation_id).filter(|request| {
                    !request.response_received && request.identity.as_ref() == Some(identity)
                }) else {
                    return rejected("native observer binding is not an original admitted Invoke");
                };
                let Some(observer) = request.native_observer.clone() else {
                    return rejected(
                        "native observer is unavailable for this actual Host invocation",
                    );
                };
                if inner.session != identity.session
                    || inner.turn != identity.turn
                    || inner.operation_id != identity.operation_id
                    || inner.native_epoch.is_empty()
                    || uuid::Uuid::parse_str(&inner.generation)
                        .map_or(true, |generation| generation.is_nil())
                {
                    return rejected("native observer binding changed actual source identity");
                }
                let source = match mapped_source(identity, &inner) {
                    Ok(source) => source,
                    Err(error) => return Box::pin(async move { Err(error) }),
                };
                self.native_proxy = Some(NativeProxyBinding {
                    invocation_id,
                    identity: identity.clone(),
                    inner,
                    observer: observer.clone(),
                });
                own_observation(|| observer.bound(source))
            }
            WireNativeNotice::Interrupted(inner) => {
                let Some(binding) = self.native_proxy.as_ref().filter(|binding| {
                    binding.invocation_id == invocation_id
                        && binding.identity == *identity
                        && binding.inner == inner
                }) else {
                    return rejected(
                        "native interruption does not match the retained actual binding",
                    );
                };
                let source = match mapped_source(&binding.identity, &inner) {
                    Ok(source) => source,
                    Err(error) => return Box::pin(async move { Err(error) }),
                };
                let observer = binding.observer.clone();
                own_observation(|| {
                    observer.interrupted(crate::NativeInterruption::from_bound_native(source))
                })
            }
            WireNativeNotice::Drained {
                source: inner,
                affected_operation_id,
            } => {
                let Some(binding) = self.native_proxy.as_ref().filter(|binding| {
                    binding.inner == inner
                        && binding.identity.owner == identity.owner
                        && binding.identity.epoch == identity.epoch
                        && binding.identity.session == identity.session
                        && binding.identity.turn == identity.turn
                }) else {
                    return rejected(
                        "native drain does not match the retained executor generation",
                    );
                };
                let Some(request) = pending.get(&invocation_id).filter(|request| {
                    !request.response_received
                        && request.identity.as_ref() == Some(identity)
                        && identity.operation_id == affected_operation_id
                }) else {
                    return rejected("native drain has no exact affected original operation");
                };
                let Some(observer) = request.native_observer.clone() else {
                    return rejected(
                        "native drain observer is unavailable for the actual affected operation",
                    );
                };
                let source = match mapped_source(&binding.identity, &inner) {
                    Ok(source) => source,
                    Err(error) => return Box::pin(async move { Err(error) }),
                };
                let drained = match crate::NativeInterruptionDrain::from_drained_native(
                    crate::NativeInterruption::from_bound_native(source),
                    affected_operation_id,
                ) {
                    Ok(drained) => drained,
                    Err(error) => return Box::pin(async move { Err(error) }),
                };
                own_observation(|| observer.drained(drained))
            }
        }
    }

    #[cfg(test)]
    async fn run(
        &mut self,
        input: impl AsyncWrite + Unpin + Send + 'static,
        output: impl AsyncRead + Unpin + Send + 'static,
    ) -> Completion {
        let transport = self.run_wire(input, output).await;
        combine_connection_completion(transport, self.finish_requests().await)
    }

    async fn run_wire(
        &mut self,
        input: impl AsyncWrite + Unpin + Send + 'static,
        output: impl AsyncRead + Unpin + Send + 'static,
    ) -> Completion {
        let (wire, mut received) = mpsc::channel(WIRE_BUFFER);
        let reader = tokio::spawn(async move {
            let mut output = output;
            loop {
                let frame = read::<_, WorkerFrame>(&mut output).await;
                let terminal = frame.is_err();
                if wire.send(frame).await.is_err() || terminal {
                    break;
                }
            }
        });
        let (send, mut outgoing) = mpsc::unbounded_channel();
        let (writer_failure, mut writer_failed) = mpsc::channel(1);
        let writer = tokio::spawn(async move {
            let mut input = input;
            while let Some(frame) = outgoing.recv().await {
                if let Err(error) = write(&mut input, &frame).await {
                    let _ = writer_failure.send(error).await;
                    break;
                }
            }
        });
        let result = self.route(&send, &mut received, &mut writer_failed).await;
        reader.abort();
        writer.abort();
        let _ = reader.await;
        let _ = writer.await;
        result
    }

    async fn route(
        &mut self,
        send: &mpsc::UnboundedSender<ParentFrame>,
        received: &mut mpsc::Receiver<std::io::Result<WorkerFrame>>,
        writer_failed: &mut mpsc::Receiver<std::io::Error>,
    ) -> Completion {
        let (protocol_fault, mut protocol_failed) = mpsc::unbounded_channel::<CallbackFault>();
        let callback_send = send.clone();
        let callbacks = ParentCallbacks::new(
            Arc::new(move |message| {
                callback_send
                    .send(ParentFrame::BrowserCallback {
                        message: Box::new(message),
                    })
                    .map_err(|_| ToolError::OutcomeUnknown("desktop callback writer closed".into()))
            }),
            protocol_fault.clone(),
        );
        let mut pending = HashMap::<u64, Pending>::new();
        let mut audio = HashMap::<u64, AudioCapture>::new();
        let mut last_request = 0_u64;
        let mut last_authorization = 0_u64;
        let mut shutdown = None;
        let mut closing = false;
        let mut terminal: Option<ToolError> = None;
        loop {
            if closing && pending.is_empty() && shutdown.is_none() {
                if terminal.is_some() {
                    break;
                }
                let Some(id) = last_request.checked_add(1) else {
                    let _ = terminal.get_or_insert(failed("desktop request identity exhausted"));
                    break;
                };
                last_request = id;
                if send
                    .send(ParentFrame::Request {
                        id,
                        request: Box::new(Request::Shutdown),
                    })
                    .is_err()
                {
                    let _ = terminal.get_or_insert(ToolError::OutcomeUnknown(
                        "desktop channel closed during shutdown".into(),
                    ));
                    break;
                }
                shutdown = Some(id);
            }
            tokio::select! {
                biased;
                frame = received.recv() => {
                    let frame = match frame {
                        Some(Ok(frame)) => frame,
                        Some(Err(error)) => {
                            let _ = terminal.get_or_insert(ToolError::OutcomeUnknown(format!("Windows desktop connection lost: {error}")));
                            break;
                        }
                        None => {
                            let _ = terminal.get_or_insert(ToolError::OutcomeUnknown("Windows desktop connection closed without settlement".into()));
                            break;
                        }
                    };
                    match frame {
                        #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                        WorkerFrame::NativeInterruption { key, operation_id } => {
                            let Some(native) = self.native.as_mut().filter(|native| native.key == key && native.interruption.is_none()) else {
                                terminal.get_or_insert(ToolError::OutcomeUnknown("native interruption producer scope mismatch".into())); break;
                            };
                            native.affected_request = pending.iter().find(|(_, request)| request.native_call && !request.response_received).map(|(id, _)| *id);
                            native.observation.send_modify(|observed| observed.interrupted = true);
                            let source = native.observation.borrow().source.clone();
                            let producer = source.as_ref().and_then(|source| source.binding.as_ref().zip(source.observer.as_ref())).filter(|(binding, _)| {
                                Some(binding.operation_id()) == operation_id.as_deref()
                                    && binding.session() == key.session
                                    && binding.turn() == key.turn
                                    && binding.native_epoch() == key.epoch
                                    && binding.generation() == native.generation.observed()
                            });
                            if let Some((binding, observer)) = producer {
                                let observed = crate::NativeInterruption::from_bound_native(binding.clone());
                                native.interruption = Some(observed.clone());
                                native.pending_observer = Some(own_native_observation(|| observer.interrupted(observed)));
                            } else {
                                native.observation.send_modify(|observed| observed.persisted = Some(Err(ToolError::Failed("native interruption has no actual retained Host producer".into()))));
                            }
                        },
                        #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                        WorkerFrame::NativeRetired { key, result } => {
                            let Some(native) = self.native.as_mut().filter(|native| native.key == key && native.observation.borrow().interrupted) else {
                                terminal.get_or_insert(ToolError::OutcomeUnknown("native retirement producer scope mismatch".into())); break;
                            };
                            let released = result.map_err(ToolError::from);
                            native.observation.send_modify(|observed| observed.retired = Some(released.clone()));
                            if released.is_err() {
                                if let Some(settled) = native.deferred.take() {
                                    drop(settled._native_admission);
                                    let _ = settled.reply.send(settled.result);
                                }
                            }
                        },
                        WorkerFrame::BrowserCallback { message: WorkerMessage::NativeObserver { invocation_id, id, identity, notice } } => {
                            let future = self.native_notice(invocation_id, &identity, notice, &pending);
                            self.requests.spawn(async move {
                                CustodianSettlement::NativeNotice { id, identity, result: future.await }
                            });
                        },
                        WorkerFrame::BrowserCallback { message: WorkerMessage::Prepare { invocation_id, ref key, .. } } => {
                            let Some(request)=pending.get(&invocation_id).filter(|request|!request.response_received && request.identity.as_ref()==Some(&key.identity)) else {
                                terminal.get_or_insert(ToolError::OutcomeUnknown("desktop browser-service invocation identity mismatch".into()));break;
                            };
                            let _=request.frames.send(Ok(frame));
                        }
                        WorkerFrame::BrowserCallback { message } => {
                            if let Err(error)=callbacks.handle(message){terminal.get_or_insert(error);break;}
                        }
                        WorkerFrame::Response { id, result } if shutdown == Some(id) => {
                            match result {
                                Ok(_) => {},
                                Err(error) => { terminal.get_or_insert(error.into()); },
                            }
                            break;
                        }
                        WorkerFrame::AudioFinished { id, result } => {
                            let Some(capture) = audio.remove(&id).filter(|capture| capture.start_acknowledged) else {
                                let _ = terminal.get_or_insert(ToolError::OutcomeUnknown("desktop audio completion identity mismatch".into()));
                                break;
                            };
                            capture.completion.send_replace(Some(result.map_err(Into::into)));
                        }
                        WorkerFrame::Response { id, ref result } => {
                            let Some(request) = pending.get_mut(&id) else {
                                let _ = terminal.get_or_insert(ToolError::OutcomeUnknown("desktop response identity mismatch".into()));
                                break;
                            };
                            if request.response_received {
                                let _ = terminal.get_or_insert(ToolError::OutcomeUnknown("duplicate desktop terminal response".into()));
                                break;
                            }
                            request.response_received = true;
                            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                            if let Some(retirement) = request.native_retirement.as_ref() {
                                let Some(native) = self.native.as_ref() else {
                                    terminal.get_or_insert(ToolError::OutcomeUnknown("foreign native retirement response".into())); break;
                                };
                                if retirement.covers(native) {
                                    native.observation.send_modify(|observed| observed.retired = Some(result.as_ref().map(|_| ()).map_err(|error| ToolError::from(error.clone()))));
                                }
                            }
                            if let Some(capture) = audio.get_mut(&id) {
                                if result.is_ok() {
                                    capture.start_acknowledged = true;
                                } else if let Some(capture) = audio.remove(&id) {
                                    let error = result.as_ref().expect_err("failed response has failure").clone();
                                    capture.completion.send_replace(Some(Err(error.into())));
                                }
                            }
                            let _ = request.frames.send(Ok(frame));
                        }
                        WorkerFrame::BrowserAuthorization { id, authorization_id, .. }
                        | WorkerFrame::BrowserSessionPreparationAuthorization { id, authorization_id, .. } => {
                            let Some(request) = pending.get(&id).filter(|pending| !pending.response_received) else {
                                let _ = terminal.get_or_insert(ToolError::OutcomeUnknown("desktop response identity mismatch".into()));
                                break;
                            };
                            if authorization_id <= last_authorization {
                                let _ = terminal.get_or_insert(ToolError::OutcomeUnknown("desktop authorization identity mismatch".into()));
                                break;
                            }
                            last_authorization = authorization_id;
                            let _ = request.frames.send(Ok(frame));
                        }
                    }
                }
                Some(fault) = protocol_failed.recv() => {
                    if let Some(invocation_id) = fault.invocation_id
                        && let Some(request) = pending.get(&invocation_id)
                    {
                        let _ = request.frames.send(Err(fault.error.clone()));
                    }
                    terminal.get_or_insert(fault.error);
                    break;
                }
                error = writer_failed.recv() => {
                    let _ = terminal.get_or_insert(ToolError::OutcomeUnknown(format!("Windows desktop write failed: {}", error.map_or_else(|| "writer closed".into(), |error| error.to_string()))));
                    break;
                }
                observed = async {
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    if let Some(future) = self.native.as_mut().and_then(|native| native.pending_observer.as_mut()) {
                        return future.as_mut().await;
                    }
                    std::future::pending::<Completion>().await
                } => {
                    let _ = &observed;
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    if let Some(native) = self.native.as_mut() {
                        native.pending_observer = None;
                        native.observation.send_modify(|state| state.persisted = Some(observed));
                    }
                }
                result = self.requests.join_next(), if !self.requests.is_empty() => {
                    let result = match result.expect("guarded nonempty request set") {
                        Ok(CustodianSettlement::Request(result)) => result,
                        Ok(CustodianSettlement::NativeNotice { id, identity, result }) => {
                            let _ = send.send(ParentFrame::BrowserCallback { message: Box::new(super::callbacks::ParentMessage::NativeObserved { id, identity, result: result.map_err(Into::into) }) });
                            continue;
                        },
                        Err(error) => {
                            let _ = terminal.get_or_insert(ToolError::CleanupUnconfirmed(format!("desktop request custodian failed: {error}")));
                            break;
                        }
                    };
                    pending.remove(&result.id);
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    if let Some(native) = self.native.as_mut().filter(|native| native.interruption.is_some() && !matches!(native.observation.borrow().retired, Some(Err(_)))) {
                        if native.affected_request == Some(result.id) {
                            if native.deferred.is_some() { terminal.get_or_insert(ToolError::CleanupUnconfirmed("multiple native inputs escaped single-owner custody".into())); break; }
                            native.deferred = Some(result);
                            continue;
                        }
                    }
                    let result_value = match result.result {
                        Ok(reply) => Ok(reply),
                        Err(error) => {
                            if let Some(capture) = audio.remove(&result.id) {
                                capture.completion.send_replace(Some(Err(error.clone())));
                            }
                            if matches!(error, ToolError::CleanupUnconfirmed(_) | ToolError::OperationCleanupUnconfirmed { .. }) {
                                closing = true;
                                self.sealed.cancel();
                                self.fault.send_replace(Some(connection_error(&error)));
                                terminal.get_or_insert_with(|| error.clone());
                            }
                            Err(error)
                        }
                    };
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    drop(result._native_admission);
                    let _ = result.reply.send(result_value);
                }
                _ = self.sealed.cancelled(), if !closing => {
                    closing = true;
                    self.receive.close();
                }
                invocation = self.receive.recv(), if !closing => {
                    let Some(invocation) = invocation else {
                        closing = true;
                        continue;
                    };
                    if invocation.cancellation.is_cancelled() {
                        #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                        drop(invocation.native_admission);
                        let _ = invocation.reply.send(Err(failed("Computer Use cancelled before dispatch")));
                        continue;
                    }
                    let Some(id) = last_request.checked_add(1) else {
                        #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                        drop(invocation.native_admission);
                        let _ = invocation.reply.send(Err(failed("desktop request identity exhausted")));
                        closing = true;
                        continue;
                    };
                    last_request = id;
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    if let Request::NativeInvoke { ref key, ref operation_id, .. } = invocation.request {
                        let valid = self.native.as_ref().is_some_and(|native| {
                            (native.key == *key && !native.observation.borrow().interrupted) || (native.key.session == key.session && !native.observation.borrow().interrupted && matches!(native.observation.borrow().retired, Some(Ok(()))))
                        });
                        if !valid {
                            drop(invocation.native_admission);
                            let _ = invocation.reply.send(Err(ToolError::CleanupUnconfirmed("native binding was not retired by this process connection".into()))); continue;
                        }
                        let native = self.native.as_mut().expect("validated native process connection");
                        let Some(source) = invocation.native_source.as_ref().filter(|source| source.key == *key && source.operation_id == *operation_id) else {
                            drop(invocation.native_admission);
                            let _ = invocation.reply.send(Err(ToolError::CleanupUnconfirmed("native call source changed before wire admission".into()))); continue;
                        };
                        if let Some(binding) = source.binding.as_ref() {
                            if source.observer.is_none() || binding.session() != key.session || binding.turn() != key.turn || binding.native_epoch() != key.epoch || binding.generation() != native.generation.observed() || Some(binding.operation_id()) != operation_id.as_deref() {
                                drop(invocation.native_admission);
                                let _ = invocation.reply.send(Err(ToolError::CleanupUnconfirmed("native binding source changed before wire admission".into()))); continue;
                            }
                        }
                        let observed = native.observation.borrow().clone();
                        let replacement = native.key != *key || (source.binding.is_some() && matches!(observed.retired, Some(Ok(()))));
                        if source.binding.is_some() && observed.source.is_some() && !replacement {
                            drop(invocation.native_admission);
                            let _ = invocation.reply.send(Err(ToolError::CleanupUnconfirmed("native physical producer was not joined before observer replacement".into()))); continue;
                        }
                        if replacement {
                            native.key = key.clone();
                            native.observation.send_replace(super::native_owner::NativeObservation { key: Some(key.clone()), ..Default::default() });
                            native.interruption = None;
                        }
                        if native.observation.borrow().source.is_none() {
                            native.observation.send_modify(|state| state.source = Some(Arc::new(source.clone())));
                        }
                    }
                    let cancel_native = matches!(&invocation.request, Request::Invoke { .. } | Request::LeaseChild { .. });
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    let cancel_native = cancel_native || matches!(&invocation.request, Request::NativeInvoke { .. });
                    let is_audio = matches!(&invocation.request, Request::Invoke { command, .. } if matches!(command.as_ref(), Command::StartAudioRecording { .. }));
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    let is_audio = is_audio || matches!(&invocation.request, Request::NativeInvoke { operation: super::native_owner::NativeOperation::StartAudioRecording, .. });
                    let observation = if is_audio {
                        let (completion, observation) = watch::channel(None);
                        audio.insert(id, AudioCapture { completion, start_acknowledged: false });
                        Some(observation)
                    } else {
                        None
                    };
                    let (frames, response) = mpsc::unbounded_channel();
                    let identity=super::callback_identity(&invocation.request);
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    let native_retirement = match &invocation.request {
                        Request::NativeRetire { key } if self.native.as_ref().is_some_and(|native| native.key == *key) => Some(NativeRetirement { key: key.clone(), source: self.native.as_ref().expect("matched actual native connection").observation.borrow().source.clone() }),
                        Request::NativeRetire { .. } => {
                            drop(invocation.native_admission);
                            let _ = invocation.reply.send(Err(ToolError::CleanupUnconfirmed("native retirement target is not owned by this process connection".into()))); continue;
                        },
                        _ => None,
                    };
                    super::seal_parent_callbacks(&callbacks,&invocation.request);
                    pending.insert(id, Pending { native_observer: invocation.capabilities.native_interruption.clone(), frames, response_received: false, identity:identity.clone(), #[cfg(all(target_os = "windows", feature = "native-desktop"))] native_retirement, #[cfg(all(target_os = "windows", feature = "native-desktop"))] native_call: matches!(&invocation.request, Request::NativeInvoke { .. }) });
                    let sent = send.send(ParentFrame::Request { id, request: Box::new(invocation.request) });
                    let task_callbacks=callbacks.clone();
                    let task_send = send.clone();
                    self.requests.spawn(async move {
                        let result = if sent.is_ok() {
                            let cancellation = invocation.cancellation.clone();
                            let operation = invoke_routed(id, response, task_send.clone(), invocation.capabilities, invocation.cancellation, task_callbacks,identity);
                            tokio::pin!(operation);
                            tokio::select! {
                                biased;
                                result = &mut operation => result,
                                _ = cancellation.cancelled(), if cancel_native => {
                                    let _ = task_send.send(ParentFrame::Cancel { id });
                                    operation.await
                                }
                            }
                        } else {
                            Err(ToolError::OutcomeUnknown("desktop writer closed before request settlement".into()))
                        };
                        let result = result.map(|value| Reply { value, audio: observation });
                        CustodianSettlement::Request(Settled { id, result, reply: invocation.reply, #[cfg(all(target_os = "windows", feature = "native-desktop"))] _native_admission: invocation.native_admission, #[cfg(all(target_os = "windows", feature = "native-desktop"))] native_source: invocation.native_source })
                    });
                }
            }
        }
        callbacks.disconnect("desktop transport ended");
        self.sealed.cancel();
        self.receive.close();
        let lost = terminal.clone().unwrap_or_else(|| {
            ToolError::CleanupUnconfirmed(
                "desktop transport closed before request settlement".into(),
            )
        });
        if terminal.is_some() {
            let fault = match &lost {
                ToolError::CleanupUnconfirmed(_)
                | ToolError::OperationCleanupUnconfirmed { .. } => lost.clone(),
                _ => failed(format!(
                    "Windows desktop connection lost: {lost}; restart the Host before using Computer Use again"
                )),
            };
            self.fault.send_replace(Some(connection_error(&fault)));
        }
        while let Ok(invocation) = self.receive.try_recv() {
            let _ = invocation
                .reply
                .send(Err(failed("Windows desktop worker closed before dispatch")));
        }
        // A connection-wide fault can originate in a different request.
        // Its receipt must not become another pending request's observation.
        let pending_error = connection_error(&lost);
        for (_, request) in pending.drain() {
            let _ = request.frames.send(Err(pending_error.clone()));
        }
        for (_, capture) in audio {
            capture
                .completion
                .send_replace(Some(Err(pending_error.clone())));
        }
        self.callback_custody = Some(callbacks);
        terminal.map_or(Ok(()), Err)
    }

    async fn finish_requests(&mut self) -> Completion {
        let mut terminal = None;
        // EOF closed the writer, but these ACK attempts preserve the original
        // metadata future's actual outcome without resurrecting the channel.
        // A response already read still settles its own request; EOF cannot erase that ACK.
        // Request tasks retain canonical prompt cleanup before returning it.
        while let Some(result) = self.requests.join_next().await {
            match result {
                Ok(CustodianSettlement::NativeNotice {
                    id,
                    identity,
                    result,
                }) => {
                    // The original Host future has settled. EOF prevents an
                    // ACK; do not invent another queue or resurrect the wire.
                    let _ = (id, identity, result);
                }
                Ok(CustodianSettlement::Request(result)) => {
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    if let Some(native) = self.native.as_mut().filter(|native| {
                        native.interruption.is_some()
                            && !matches!(native.observation.borrow().retired, Some(Err(_)))
                    }) {
                        if native.affected_request == Some(result.id) && native.deferred.is_none() {
                            native.deferred = Some(result);
                            continue;
                        }
                    }
                    #[cfg(all(target_os = "windows", feature = "native-desktop"))]
                    drop(result._native_admission);
                    let _ = result.reply.send(result.result);
                }
                Err(error) => {
                    terminal.get_or_insert_with(|| {
                        ToolError::CleanupUnconfirmed(format!(
                            "desktop request custodian failed: {error}"
                        ))
                    });
                }
            }
        }
        if self
            .callback_custody
            .as_ref()
            .is_some_and(ParentCallbacks::has_unsettled)
        {
            terminal.get_or_insert(ToolError::CleanupUnconfirmed(
                "browser callback custody remains unconfirmed after desktop transport ended".into(),
            ));
        }
        self.callback_custody.take();
        terminal.map_or(Ok(()), Err)
    }
}

async fn invoke_routed(
    id: u64,
    mut frames: mpsc::UnboundedReceiver<Result<WorkerFrame, ToolError>>,
    send: mpsc::UnboundedSender<ParentFrame>,
    capabilities: ParentCapabilities,
    cancellation: CancellationToken,
    callbacks: ParentCallbacks,
    identity: Option<ScopeIdentity>,
) -> Result<Value, ToolError> {
    let mut cleanup_error = None;
    let mut decision_unknown = None;
    let result = async {
    let mut message = next(&mut frames).await?;
    loop {
        match message {
            WorkerFrame::BrowserCallback {
                message:
                    WorkerMessage::Prepare {
                        invocation_id,
                        request_id,
                        key,
                    },
            } => {
                let expected = identity
                    .as_ref()
                    .filter(|expected| invocation_id == id && *expected == &key.identity)
                    .ok_or_else(|| {
                        ToolError::OutcomeUnknown(
                            "desktop browser callback operation identity mismatch".into(),
                        )
                    })?;
                let callback_cancellation = cancellation.child_token();
                let prepare = callbacks.prepare(
                    id,
                    request_id,
                    key,
                    expected,
                    capabilities.clone(),
                    callback_cancellation.clone(),
                );
                tokio::pin!(prepare);
                let received = next(&mut frames);
                tokio::pin!(received);
                let following = tokio::select! {
                    biased;
                    result=&mut prepare=>{result?;received.await},
                    frame=&mut received=>{callback_cancellation.cancel();prepare.await?;frame},
                };
                message = following?;
            }
            WorkerFrame::Response { result, .. } => {
                return result.map_err(ToolError::from);
            }
            frame @ (WorkerFrame::BrowserAuthorization { .. }
            | WorkerFrame::BrowserSessionPreparationAuthorization { .. }) => {
                let (authorization_id, mode, request) = match frame {
                    WorkerFrame::BrowserAuthorization {
                        authorization_id,
                        mode,
                        access,
                        ..
                    } => (
                        authorization_id,
                        mode,
                        BrowserAuthorizationRequest::Access(access),
                    ),
                    WorkerFrame::BrowserSessionPreparationAuthorization {
                        authorization_id,
                        mode,
                        identity,
                        preparation,
                        ..
                    } => (
                        authorization_id,
                        mode,
                        BrowserAuthorizationRequest::SessionPreparation {
                            identity,
                            preparation,
                        },
                    ),
                    _ => unreachable!("matched authorization frame"),
                };
                let callback_cancellation = cancellation.child_token();
                let _callback_lifetime = callback_cancellation.clone().drop_guard();
                let mut decision: crate::AuthorizationFuture = match request {
                    BrowserAuthorizationRequest::SessionPreparation {
                        identity: observed,
                        preparation,
                    } => capabilities.session_preparation_decision(
                        identity.as_ref(),
                        observed,
                        preparation,
                        mode,
                        callback_cancellation.clone(),
                    ),
                    BrowserAuthorizationRequest::Access(access) => {
                        match capabilities.authorization.as_ref() {
                            Some(authorization) if !cancellation.is_cancelled() => match mode {
                                AuthorizationMode::Authorize => {
                                    authorization.authorize(access, callback_cancellation.clone())
                                }
                                AuthorizationMode::Check => {
                                    authorization.check(access, callback_cancellation.clone())
                                }
                            },
                            _ => Box::pin(async {
                                Err(failed("Browser site access requires Host authorization"))
                            }),
                        }
                    }
                };
                let received = next(&mut frames);
                tokio::pin!(received);
                let (following, cleanup) = tokio::select! {
                    biased;
                    frame = &mut received => {
                        let overlap = matches!(&frame, Ok(WorkerFrame::BrowserAuthorization { .. }
                            | WorkerFrame::BrowserSessionPreparationAuthorization { .. }));
                        if overlap {
                            callbacks.report_protocol_fault(ToolError::OutcomeUnknown("desktop authorization callback overlapped its original reply".into()));
                        }
                        callback_cancellation.cancel();
                        let cleanup = authorization_cleanup(decision.await);
                        let result = cleanup.as_ref().map_or_else(
                            || Err(Failure::Failed("Browser authorization invocation expired".into())),
                            |error| Err(Failure::from(error.clone())),
                        );
                        let _ = send.send(ParentFrame::BrowserAuthorizationResult { id, authorization_id, result });
                        if overlap {
                            return Err(cleanup.unwrap_or_else(|| ToolError::OutcomeUnknown("desktop authorization callback overlapped its original reply".into())));
                        }
                        (frame, cleanup)
                    }
                    _ = cancellation.cancelled() => {
                        callback_cancellation.cancel();
                        let cleanup = authorization_cleanup(decision.await);
                        let result = cleanup.as_ref().map_or_else(
                            || Err(Failure::Failed("Browser authorization cancelled".into())),
                            |error| Err(Failure::from(error.clone())),
                        );
                        let _ = send.send(ParentFrame::BrowserAuthorizationResult { id, authorization_id, result });
                        (received.await, cleanup)
                    }
                    result = &mut decision => {
                        // A completed decision's unknown outcome is not a
                        // separate failure to withdraw that decision.
                        let (result, cleanup) = match result {
                            Err(error @ (ToolError::OutcomeUnknown(_) | ToolError::OperationUnknown { .. })) => {
                                let wire_error = Failure::from(error.clone());
                                decision_unknown.get_or_insert(error);
                                (Err(wire_error), None)
                            }
                            result => {
                                let cleanup = authorization_cleanup(result.clone());
                                (result.map_err(Failure::from), cleanup)
                            }
                        };
                        let _ = send.send(ParentFrame::BrowserAuthorizationResult { id, authorization_id, result });
                        (received.await, cleanup)
                    }
                };
                if let Some(error) = cleanup {
                    cleanup_error.get_or_insert(error);
                }
                message = match following {
                    Ok(frame) => frame,
                    Err(error) => return Err(error),
                };
            }
            _ => {
                return Err(ToolError::OutcomeUnknown(
                    "desktop response identity mismatch".into(),
                ));
            }
        }
    }
    }.await;
    authorization_result(result, cleanup_error, decision_unknown)
}

fn authorization_result(
    result: Result<Value, ToolError>,
    cleanup_error: Option<ToolError>,
    decision_unknown: Option<ToolError>,
) -> Result<Value, ToolError> {
    let result = cleanup_error.map_or(result, Err);
    match (result, decision_unknown) {
        (
            Err(
                error @ (ToolError::CleanupUnconfirmed(_)
                | ToolError::OperationCleanupUnconfirmed { .. }),
            ),
            Some(original),
        ) => Err(preserve_operation_observation(error, original)),
        (_, Some(original)) => Err(original),
        (result, None) => result,
    }
}

fn preserve_operation_observation(cleanup: ToolError, original: ToolError) -> ToolError {
    let message = match cleanup {
        ToolError::CleanupUnconfirmed(message)
        | ToolError::OperationCleanupUnconfirmed { message, .. } => message,
        cleanup => return cleanup,
    };
    match original {
        ToolError::OperationUnknown { observation, .. }
        | ToolError::OperationCleanupUnconfirmed { observation, .. } => {
            ToolError::OperationCleanupUnconfirmed {
                message,
                observation,
            }
        }
        _ => ToolError::CleanupUnconfirmed(message),
    }
}

async fn next(
    frames: &mut mpsc::UnboundedReceiver<Result<WorkerFrame, ToolError>>,
) -> Result<WorkerFrame, ToolError> {
    frames
        .recv()
        .await
        .ok_or_else(|| ToolError::OutcomeUnknown("desktop response observation was lost".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BrowserAccess;
    use serde_json::json;
    use tokio::io::{AsyncWriteExt, DuplexStream};

    fn fixture() -> (Connection, DuplexStream) {
        let (parent, peer) = tokio::io::duplex(8192);
        let (input, output) = tokio::io::split(parent);
        let (connection, mut task) = Connection::channel();
        tokio::spawn(async move {
            let result = task.run(output, input).await;
            task.closed.send_replace(Some(CloseSettlement {
                transport: result,
                process: Ok(()),
            }));
        });
        (connection, peer)
    }

    fn request(epoch: &str, command: Command) -> Request {
        Request::Invoke {
            owner: "fixture-owner".into(),
            epoch: epoch.into(),
            session: "fixture-session".into(),
            turn: "fixture-turn".into(),
            native_observer_available: false,
            operation_id: None,
            browsers: Vec::new(),
            preparation_policy: Default::default(),
            command: Box::new(command),
            language: maka_agent_facts::language::Language::En,
        }
    }

    async fn incoming(peer: &mut DuplexStream) -> u64 {
        let ParentFrame::Request { id, .. } = read(peer).await.unwrap() else {
            panic!("expected original desktop request");
        };
        id
    }

    async fn respond(peer: &mut DuplexStream, id: u64, value: Value) {
        write(
            peer,
            &WorkerFrame::Response {
                id,
                result: Ok(value),
            },
        )
        .await
        .unwrap();
    }

    async fn cancelled_authorization_result(
        peer: &mut DuplexStream,
        expected: u64,
    ) -> Result<(), Failure> {
        let mut cancellation = false;
        let mut authorization = None;
        for _ in 0..2 {
            match read::<_, ParentFrame>(peer).await.unwrap() {
                ParentFrame::Cancel { id } => {
                    assert_eq!(id, expected);
                    assert!(!cancellation, "native cancellation is queued exactly once");
                    cancellation = true;
                }
                ParentFrame::BrowserAuthorizationResult {
                    id,
                    authorization_id,
                    result,
                } => {
                    assert_eq!((id, authorization_id), (expected, 1));
                    assert!(authorization.is_none());
                    authorization = Some(result);
                }
                _ => panic!("expected the original cancellation or authorization settlement"),
            }
        }
        assert!(cancellation);
        authorization.unwrap()
    }

    async fn shutdown(peer: &mut DuplexStream) {
        let ParentFrame::Request { id, request } = read(peer).await.unwrap() else {
            panic!("close must retain its original shutdown request");
        };
        assert!(matches!(*request, Request::Shutdown));
        respond(peer, id, Value::Null).await;
    }

    #[derive(Clone)]
    struct PendingAuthorization {
        started: Arc<tokio::sync::Notify>,
        cleanup: Arc<tokio::sync::Notify>,
        failure: ToolError,
    }

    impl PendingAuthorization {
        fn withdrawn(&self, cancellation: CancellationToken) -> crate::AuthorizationFuture {
            let started = self.started.clone();
            let cleanup = self.cleanup.clone();
            let failure = self.failure.clone();
            Box::pin(async move {
                started.notify_one();
                cancellation.cancelled().await;
                cleanup.notify_one();
                Err(failure)
            })
        }
    }

    impl BrowserAuthorization for PendingAuthorization {
        fn authorize(
            &self,
            _: BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.withdrawn(cancellation)
        }
        fn check(
            &self,
            _: BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.withdrawn(cancellation)
        }
        fn authorize_session_preparation(
            &self,
            _: crate::BrowserSessionPreparation,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.withdrawn(cancellation)
        }
    }
    #[derive(Clone)]
    struct AttachmentAuthority {
        pending: PendingAuthorization,
        release: Arc<tokio::sync::Notify>,
    }
    impl BrowserAuthorization for AttachmentAuthority {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
        fn attachment(&self) -> Option<Arc<dyn crate::BrowserAttachmentAuthorization>> {
            Some(Arc::new(self.clone()))
        }
    }
    impl crate::BrowserAttachmentAuthorization for AttachmentAuthority {
        fn check(
            &self,
            _: crate::BrowserAttachmentOrigin,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            let pending = self.pending.withdrawn(cancellation);
            let release = self.release.clone();
            Box::pin(async move {
                let result = pending.await;
                release.notified().await;
                result
            })
        }
    }

    async fn callback(peer: &mut DuplexStream, id: u64) {
        write(
            peer,
            &WorkerFrame::BrowserAuthorization {
                id,
                authorization_id: 1,
                mode: AuthorizationMode::Authorize,
                access: BrowserAccess::Read {
                    document: crate::BrowserDocument {
                        browser_id: "fixture-browser".into(),
                        generation: "fixture-generation".into(),
                        tab_id: "fixture-tab".into(),
                        url: "https://fixture.test/".into(),
                    },
                },
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn independent_epoch_response_passes_a_cancelled_prompt_and_partial_frame() {
        let (connection, mut peer) = fixture();
        let started = Arc::new(tokio::sync::Notify::new());
        let cleanup = Arc::new(tokio::sync::Notify::new());
        let cancellation = CancellationToken::new();
        let old = {
            let connection = connection.clone();
            let cancellation = cancellation.clone();
            let authorization = Arc::new(PendingAuthorization {
                started: started.clone(),
                cleanup: cleanup.clone(),
                failure: failed("fixture authorization withdrawn"),
            });
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("old", Command::Documentation),
                        Some(authorization),
                        cancellation,
                    )
                    .await
            })
        };
        let old_id = incoming(&mut peer).await;
        callback(&mut peer, old_id).await;
        started.notified().await;
        let fresh = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("fresh", Command::Documentation),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let fresh_id = incoming(&mut peer).await;
        let frame = super::super::encode(&WorkerFrame::Response {
            id: fresh_id,
            result: Ok(json!("fresh ready")),
        })
        .unwrap();
        peer.write_all(&frame[..2]).await.unwrap();
        cancellation.cancel();
        cleanup.notified().await;
        let result = cancelled_authorization_result(&mut peer, old_id).await;
        assert!(
            matches!(result, Err(Failure::Failed(message)) if message == "Browser authorization cancelled")
        );
        peer.write_all(&frame[2..]).await.unwrap();
        assert_eq!(fresh.await.unwrap().unwrap().value, json!("fresh ready"));
        assert!(
            !old.is_finished(),
            "old request retains its original native ACK"
        );
        respond(&mut peer, old_id, json!("old settled")).await;
        assert_eq!(old.await.unwrap().unwrap().value, json!("old settled"));
        let close = {
            let connection = connection.clone();
            tokio::spawn(async move { connection.close().await })
        };
        shutdown(&mut peer).await;
        close.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn immediate_audio_completion_keeps_the_start_bound_observation() {
        let (connection, mut peer) = fixture();
        let start = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request(
                            "audio",
                            Command::StartAudioRecording {
                                options: crate::protocol::AudioOptions::default(),
                            },
                        ),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        let mut bytes = super::super::encode(&WorkerFrame::Response {
            id,
            result: Ok(json!({"started": true})),
        })
        .unwrap();
        bytes.extend(
            super::super::encode(&WorkerFrame::AudioFinished { id, result: Ok(()) }).unwrap(),
        );
        peer.write_all(&bytes).await.unwrap();
        let reply = start.await.unwrap().unwrap();
        assert_eq!(reply.value, json!({"started": true}));
        let mut audio = reply
            .audio
            .expect("Start owns its observation before dispatch");
        while audio.borrow().is_none() {
            audio.changed().await.unwrap();
        }
        assert!(matches!(&*audio.borrow(), Some(Ok(()))));
        let close = {
            let connection = connection.clone();
            tokio::spawn(async move { connection.close().await })
        };
        shutdown(&mut peer).await;
        close.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dropping_a_request_observer_preserves_the_request_and_close_ack() {
        let (connection, mut peer) = fixture();
        let observer = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("retiring", Command::Documentation),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        observer.abort();
        let _ = observer.await;
        let close = {
            let connection = connection.clone();
            tokio::spawn(async move { connection.close().await })
        };
        tokio::task::yield_now().await;
        assert!(
            !close.is_finished(),
            "dropping an observer cannot settle native work"
        );
        respond(&mut peer, id, json!("settled after observer drop")).await;
        shutdown(&mut peer).await;
        close.await.unwrap().unwrap();
        assert!(
            matches!(connection.invoke(request("too-late", Command::Documentation), None, CancellationToken::new()).await, Err(ToolError::Failed(message)) if message == "Windows desktop worker is closed")
        );
    }

    #[tokio::test]
    async fn premature_audio_event_faults_the_same_capture_without_success() {
        let (connection, mut peer) = fixture();
        let start = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request(
                            "audio",
                            Command::StartAudioRecording {
                                options: crate::protocol::AudioOptions::default(),
                            },
                        ),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        write(
            &mut peer,
            &WorkerFrame::AudioFinished { id, result: Ok(()) },
        )
        .await
        .unwrap();
        let error = start.await.unwrap().unwrap_err();
        assert!(
            matches!(error, ToolError::OutcomeUnknown(message) if message == "desktop audio completion identity mismatch")
        );
        assert!(connection.fault().is_some());
        assert!(
            matches!(connection.close().await, Err(ToolError::CleanupUnconfirmed(message)) if message == "Windows desktop cleanup was not confirmed: tool effect outcome unknown: desktop audio completion identity mismatch")
        );
    }

    #[tokio::test]
    async fn known_response_survives_subsequent_transport_eof() {
        let (connection, mut peer) = fixture();
        let call = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("known", Command::Documentation),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        respond(&mut peer, id, json!("original acknowledged")).await;
        drop(peer);
        assert_eq!(
            call.await.unwrap().unwrap().value,
            json!("original acknowledged")
        );
        assert!(connection.close().await.is_err());
    }
    #[tokio::test]
    async fn failed_prompt_cleanup_keeps_the_old_ack_while_another_epoch_completes() {
        let (connection, mut peer) = fixture();
        let started = Arc::new(tokio::sync::Notify::new());
        let cleanup = Arc::new(tokio::sync::Notify::new());
        let cancellation = CancellationToken::new();
        let old = {
            let connection = connection.clone();
            let cancellation = cancellation.clone();
            let authorization = Arc::new(PendingAuthorization {
                started: started.clone(),
                cleanup: cleanup.clone(),
                failure: ToolError::CleanupUnconfirmed(
                    "fixture canonical withdrawal unavailable".into(),
                ),
            });
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("old", Command::Documentation),
                        Some(authorization),
                        cancellation,
                    )
                    .await
            })
        };
        let old_id = incoming(&mut peer).await;
        callback(&mut peer, old_id).await;
        started.notified().await;
        cancellation.cancel();
        cleanup.notified().await;
        let result = cancelled_authorization_result(&mut peer, old_id).await;
        assert!(
            matches!(result, Err(Failure::CleanupUnconfirmed(message)) if message == "Browser authorization cleanup was not confirmed: tool cleanup unconfirmed: fixture canonical withdrawal unavailable")
        );
        let fresh = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("fresh", Command::Documentation),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let fresh_id = incoming(&mut peer).await;
        respond(&mut peer, fresh_id, json!("fresh done")).await;
        assert_eq!(fresh.await.unwrap().unwrap().value, json!("fresh done"));
        assert!(
            !old.is_finished(),
            "unknown prompt cleanup must await the old native ACK"
        );
        respond(&mut peer, old_id, json!("old native joined")).await;
        let error = old.await.unwrap().unwrap_err();
        assert!(
            matches!(&error, ToolError::CleanupUnconfirmed(message) if message.contains("fixture canonical withdrawal unavailable"))
        );
        let repeated = connection
            .invoke(
                request("late", Command::Documentation),
                None,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(repeated.to_string(), error.to_string());
        assert_eq!(
            connection.close().await.unwrap_err().to_string(),
            error.to_string()
        );
    }
    #[tokio::test]
    async fn overlapping_callback_faults_the_original_request_and_releases_its_prompt() {
        let (connection, mut peer) = fixture();
        let started = Arc::new(tokio::sync::Notify::new());
        let cleanup = Arc::new(tokio::sync::Notify::new());
        let call = {
            let connection = connection.clone();
            let authorization = Arc::new(PendingAuthorization {
                started: started.clone(),
                cleanup: cleanup.clone(),
                failure: failed("fixture authorization withdrawn"),
            });
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("overlap", Command::Documentation),
                        Some(authorization),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        callback(&mut peer, id).await;
        started.notified().await;
        write(
            &mut peer,
            &WorkerFrame::BrowserAuthorization {
                id,
                authorization_id: 2,
                mode: AuthorizationMode::Authorize,
                access: BrowserAccess::Read {
                    document: crate::BrowserDocument {
                        browser_id: "fixture-browser".into(),
                        generation: "fixture-generation".into(),
                        tab_id: "fixture-tab".into(),
                        url: "https://other.test/".into(),
                    },
                },
            },
        )
        .await
        .unwrap();
        cleanup.notified().await;
        let error = call.await.unwrap().unwrap_err();
        assert!(
            matches!(error, ToolError::OutcomeUnknown(message) if message == "desktop authorization callback overlapped its original reply")
        );
        assert!(connection.fault().is_some());
        assert!(connection.close().await.is_err());
    }
    #[tokio::test]
    async fn request_cancellation_reaches_the_same_native_request_and_waits_for_its_ack() {
        let (connection, mut peer) = fixture();
        let cancellation = CancellationToken::new();
        let call = {
            let connection = connection.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("cancelled", Command::Documentation),
                        None,
                        cancellation,
                    )
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        cancellation.cancel();
        let ParentFrame::Cancel { id: cancelled } = read(&mut peer).await.unwrap() else {
            panic!("expected cancellation of the original dispatched request");
        };
        assert_eq!(cancelled, id);
        assert!(
            !call.is_finished(),
            "Cancel is not a terminal native acknowledgement"
        );
        write(
            &mut peer,
            &WorkerFrame::Response {
                id,
                result: Err(Failure::Failed("fixture native cancellation joined".into())),
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(call.await.unwrap(), Err(ToolError::Failed(message)) if message == "fixture native cancellation joined")
        );
        let close = {
            let connection = connection.clone();
            tokio::spawn(async move { connection.close().await })
        };
        shutdown(&mut peer).await;
        close.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn native_response_expiry_still_settles_its_exact_authorization_before_shutdown() {
        let (connection, mut peer) = fixture();
        let started = Arc::new(tokio::sync::Notify::new());
        let cleanup = Arc::new(tokio::sync::Notify::new());
        let call = {
            let connection = connection.clone();
            let authorization = Arc::new(PendingAuthorization {
                started: started.clone(),
                cleanup: cleanup.clone(),
                failure: failed("fixture authorization withdrawn"),
            });
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("expired", Command::Documentation),
                        Some(authorization),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        callback(&mut peer, id).await;
        started.notified().await;
        respond(&mut peer, id, json!("original native terminal")).await;
        cleanup.notified().await;
        assert_eq!(
            call.await.unwrap().unwrap().value,
            json!("original native terminal")
        );
        let close = {
            let connection = connection.clone();
            tokio::spawn(async move { connection.close().await })
        };
        let ParentFrame::BrowserAuthorizationResult {
            id: original,
            authorization_id,
            result,
        } = read(&mut peer).await.unwrap()
        else {
            panic!("native terminal cannot erase the original authorization reply");
        };
        assert_eq!((original, authorization_id), (id, 1));
        assert!(
            matches!(result, Err(Failure::Failed(message)) if message == "Browser authorization invocation expired")
        );
        shutdown(&mut peer).await;
        close.await.unwrap().unwrap();
    }
    struct CanonicalAuthorization {
        store: maka_event_log::SessionStore,
        invocation: maka_agent_facts::event::Invocation,
        record: maka_agent_facts::interaction::InteractionRecord,
        published: Arc<tokio::sync::Notify>,
    }

    impl BrowserAuthorization for CanonicalAuthorization {
        fn authorize(
            &self,
            _: BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            let store = self.store.clone();
            let invocation = self.invocation.clone();
            let record = self.record.clone();
            let published = self.published.clone();
            Box::pin(async move {
                store
                    .establish_run_interaction(&invocation, &record)
                    .await
                    .map_err(|error| ToolError::Persistence(error.to_string()))?;
                published.notify_one();
                maka_agent_authority::interaction_wait::wait(&store, &record, &cancellation)
                    .await
                    .map_err(|error| ToolError::CleanupUnconfirmed(error.into()))?;
                Err(failed("canonical consent closed"))
            })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async { Err(failed("canonical origin grant missing")) })
        }
    }

    #[tokio::test]
    async fn cancelled_or_expired_callback_settles_canonical_prompt_before_returning() {
        use maka_agent_facts::{
            event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent},
            interaction::{
                ClosureReason, Decision, GrantCapability, GrantScope, GrantTarget,
                InteractionOutcome, InteractionRecord, InteractionRequest,
            },
        };
        for response_first in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let owner = maka_event_log::root::RootOwner::create(
                &directory.path().join("root"),
                &maka_event_log::root::RootNamespaces {
                    ownership: directory.path().join("ownership"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap();
            let root = maka_event_log::RootStore::open(Arc::new(owner))
                .await
                .unwrap();
            let store = root
                .create_session("session", "fixture", &json!({}), 1)
                .await
                .unwrap();
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            };
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Message {
                                content: "browser consent".into(),
                                request_fingerprint: None,
                                source_messages: vec![],
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            let target = GrantTarget {
                provider_id: "maka_workspace_computer".into(),
                contract_id: "maka_workspace_computer_v1".into(),
                server_id: "maka_workspace_computer".into(),
                tool_name: "cua_repl".into(),
                capability: GrantCapability::Browser,
                scope: GrantScope::BrowserOrigin {
                    origin: "https://cancel.test".into(),
                },
            };
            let record = InteractionRecord {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                request_id: "cancelled_browser_origin".into(),
                created_at: 2,
                outcome: None,
                request: InteractionRequest::ClientCapability {
                    tool_use_id: "browser-operation".into(),
                    basis: None,
                    target: target.clone(),
                },
            };
            let published = Arc::new(tokio::sync::Notify::new());
            let authorization = Arc::new(CanonicalAuthorization {
                store: store.clone(),
                invocation,
                record: record.clone(),
                published: published.clone(),
            });
            let cancellation = CancellationToken::new();
            let cancel = cancellation.clone();
            let (connection, mut peer) = fixture();
            let peer = tokio::spawn(async move {
                let id = incoming(&mut peer).await;
                write(
                    &mut peer,
                    &WorkerFrame::BrowserAuthorization {
                        id,
                        authorization_id: 1,
                        mode: AuthorizationMode::Authorize,
                        access: BrowserAccess::Read {
                            document: crate::BrowserDocument {
                                browser_id: "fixture-browser".into(),
                                generation: "fixture-generation".into(),
                                tab_id: "fixture-tab".into(),
                                url: "https://cancel.test/".into(),
                            },
                        },
                    },
                )
                .await
                .unwrap();
                published.notified().await;
                let response = WorkerFrame::Response {
                    id,
                    result: Err(Failure::Failed("native invocation refused".into())),
                };
                if response_first {
                    write(&mut peer, &response).await.unwrap();
                    let ParentFrame::BrowserAuthorizationResult {
                        id: original,
                        authorization_id,
                        result,
                    } = read(&mut peer).await.unwrap()
                    else {
                        panic!("expected exact expired origin decision");
                    };
                    assert_eq!((original, authorization_id), (id, 1));
                    assert!(
                        matches!(result, Err(Failure::Failed(message)) if message == "Browser authorization invocation expired")
                    );
                } else {
                    cancel.cancel();
                    let result = cancelled_authorization_result(&mut peer, id).await;
                    assert!(
                        matches!(result, Err(Failure::Failed(message)) if message == "Browser authorization cancelled")
                    );
                    write(&mut peer, &response).await.unwrap();
                }
                shutdown(&mut peer).await;
            });
            let result = connection
                .invoke(
                    Request::Invoke {
                        owner: "canonical-owner".into(),
                        epoch: "canonical-epoch".into(),
                        session: "session".into(),
                        turn: "turn".into(),
                        native_observer_available: false,
                        operation_id: None,
                        browsers: Vec::new(),
                        preparation_policy: Default::default(),
                        command: Box::new(Command::Documentation),
                        language: maka_agent_facts::language::Language::En,
                    },
                    Some(authorization),
                    cancellation,
                )
                .await;
            assert!(
                matches!(result, Err(ToolError::Failed(message)) if message == "native invocation refused")
            );
            let canonical = store
                .interaction(&record.request_id)
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(
                    canonical.outcome,
                    Some(InteractionOutcome::Closure {
                        reason: ClosureReason::ProducerCancelled,
                        ..
                    })
                ),
                "the canonical pending prompt must close before the native operation returns"
            );
            let late = store
                .commit_interaction_outcome(
                    &record.request_id,
                    InteractionOutcome::ClientCapabilityDecision {
                        decision: Decision::Allow,
                        committed_at: 3,
                    },
                )
                .await
                .unwrap();
            assert!(
                !late.matches,
                "an abandoned prompt cannot accept a late approval"
            );
            assert!(
                store
                    .client_capability_grant("session", &target)
                    .await
                    .unwrap()
                    .is_none()
            );
            connection.close().await.unwrap();
            peer.await.unwrap();
            root.close().await.unwrap();
        }
    }
    fn browser_access(url: &str) -> BrowserAccess {
        BrowserAccess::Read {
            document: crate::BrowserDocument {
                browser_id: "fixture-browser".into(),
                generation: "ws://127.0.0.1/devtools/browser/fixture".into(),
                tab_id: "fixture-tab".into(),
                url: url.into(),
            },
        }
    }

    struct FixtureAuthorization {
        calls: std::sync::Mutex<Vec<(&'static str, BrowserAccess)>>,
    }

    impl BrowserAuthorization for FixtureAuthorization {
        fn authorize(
            &self,
            access: BrowserAccess,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.calls.lock().unwrap().push(("authorize", access));
            Box::pin(async { Ok(()) })
        }
        fn check(&self, access: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            self.calls.lock().unwrap().push(("check", access));
            Box::pin(async { Err(failed("fixture has no existing grant")) })
        }
    }

    fn authorization() -> Arc<FixtureAuthorization> {
        Arc::new(FixtureAuthorization {
            calls: std::sync::Mutex::new(Vec::new()),
        })
    }

    #[tokio::test]
    async fn browser_callbacks_route_the_exact_invocation_and_distinguish_check() {
        let (connection, mut peer) = fixture();
        let authorization = authorization();
        let expected = browser_access("https://example.test/private");
        let access = expected.clone();
        let peer_task = tokio::spawn(async move {
            let id = incoming(&mut peer).await;
            for (authorization_id, mode) in [
                (1, AuthorizationMode::Authorize),
                (2, AuthorizationMode::Check),
            ] {
                write(
                    &mut peer,
                    &WorkerFrame::BrowserAuthorization {
                        id,
                        authorization_id,
                        mode,
                        access: access.clone(),
                    },
                )
                .await
                .unwrap();
                let ParentFrame::BrowserAuthorizationResult {
                    id: original,
                    authorization_id: original_authorization,
                    result,
                } = read(&mut peer).await.unwrap()
                else {
                    panic!("expected original authorization result");
                };
                assert_eq!((original, original_authorization), (id, authorization_id));
                if authorization_id == 1 {
                    assert!(result.is_ok());
                } else {
                    assert!(
                        matches!(result, Err(Failure::Failed(message)) if message == "fixture has no existing grant")
                    );
                }
            }
            respond(&mut peer, id, json!({"settled": true})).await;
            shutdown(&mut peer).await;
        });
        let result = connection
            .invoke(
                request("bound", Command::Documentation),
                Some(authorization.clone()),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.value, json!({"settled": true}));
        assert_eq!(
            *authorization.calls.lock().unwrap(),
            vec![("authorize", expected.clone()), ("check", expected)]
        );
        connection.close().await.unwrap();
        peer_task.await.unwrap();
    }

    #[tokio::test]
    async fn an_old_worker_callback_cannot_borrow_the_new_invocations_authority() {
        let (connection, mut peer) = fixture();
        let old = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("old", Command::Documentation),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let old_id = incoming(&mut peer).await;
        respond(&mut peer, old_id, json!("old acknowledged")).await;
        assert_eq!(old.await.unwrap().unwrap().value, json!("old acknowledged"));
        let authorization = authorization();
        let fresh = {
            let connection = connection.clone();
            let authorization = authorization.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("fresh", Command::Documentation),
                        Some(authorization),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let fresh_id = incoming(&mut peer).await;
        assert_ne!(old_id, fresh_id);
        write(
            &mut peer,
            &WorkerFrame::BrowserAuthorization {
                id: old_id,
                authorization_id: 1,
                mode: AuthorizationMode::Authorize,
                access: browser_access("https://old.test/"),
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(fresh.await.unwrap(), Err(ToolError::OutcomeUnknown(message)) if message == "desktop response identity mismatch")
        );
        assert!(
            authorization.calls.lock().unwrap().is_empty(),
            "an old callback cannot request a grant from the newer invocation"
        );
        assert!(connection.close().await.is_err());
    }

    #[tokio::test]
    async fn eager_begin_queues_before_poll_and_preserves_order_with_a_later_invocation() {
        let (connection, mut peer) = fixture();
        let first = connection
            .begin_browser(
                request("first-prepare", Command::Documentation),
                &crate::InvocationContext::new("fixture-session", "fixture-turn"),
                CancellationToken::new(),
            )
            .unwrap();
        let second_connection = connection.clone();
        let second = tokio::spawn(async move {
            second_connection
                .invoke(
                    request("later-trigger", Command::Documentation),
                    None,
                    CancellationToken::new(),
                )
                .await
        });
        let peer_task = tokio::spawn(async move {
            let ParentFrame::Request {
                id: first_id,
                request: first,
            } = read(&mut peer).await.unwrap()
            else {
                panic!("expected first eagerly queued invocation");
            };
            assert!(matches!(*first, Request::Invoke { epoch, .. } if epoch == "first-prepare"));
            let ParentFrame::Request {
                id: second_id,
                request: second,
            } = read(&mut peer).await.unwrap()
            else {
                panic!("expected later invocation without awaiting the first result");
            };
            assert!(matches!(*second, Request::Invoke { epoch, .. } if epoch == "later-trigger"));
            assert!(first_id < second_id);
            respond(
                &mut peer,
                second_id,
                json!("later operation reached the child"),
            )
            .await;
            respond(&mut peer, first_id, json!("original completion")).await;
            shutdown(&mut peer).await;
        });
        assert_eq!(
            second.await.unwrap().unwrap().value,
            json!("later operation reached the child")
        );
        // The first owned result future has deliberately not been polled yet.
        assert_eq!(first.await.unwrap().value, json!("original completion"));
        connection.close().await.unwrap();
        peer_task.await.unwrap();
    }

    #[tokio::test]
    async fn eager_invocation_cancelled_before_actor_dispatch_never_reaches_the_wire() {
        let (connection, mut peer) = fixture();
        let cancellation = CancellationToken::new();
        let result = connection
            .begin_browser(
                request("cancelled-before-poll", Command::Documentation),
                &crate::InvocationContext::new("fixture-session", "fixture-turn"),
                cancellation.clone(),
            )
            .unwrap();
        cancellation.cancel();
        assert!(
            matches!(result.await, Err(ToolError::Failed(message)) if message == "Computer Use cancelled before dispatch")
        );
        let peer_task = tokio::spawn(async move { shutdown(&mut peer).await });
        connection.close().await.unwrap();
        peer_task.await.unwrap();
    }

    #[tokio::test]
    async fn lease_child_cancellation_keeps_its_original_native_reply_and_fresh_wire_identity() {
        let (connection, mut peer) = fixture();
        let cancellation = CancellationToken::new();
        let operation_id = "fresh-host-service-operation";
        // Deliberately invalid physical source data: this loopback verifies
        // transport/cancellation, never actual lease admission or a grant.
        let request = Request::LeaseChild {
            owner: "fixture-owner".into(),
            epoch: "fixture-epoch".into(),
            session: "fixture-session".into(),
            turn: "fixture-turn".into(),
            operation_id: operation_id.into(),
            browsers: Vec::new(),
            preparation_policy: Default::default(),
            request: crate::BrowserLeaseChildRequest {
                browser_id: "not-an-admitted-browser".into(),
                generation: "not-a-live-generation".into(),
                native_owner: uuid::Uuid::nil(),
                native_epoch: "not-a-live-native-epoch".into(),
                turn_id: "fixture-turn".into(),
                completion_id: 0,
                opener_subject: crate::BrowserLeaseSubject::PhysicalClaim {
                    claim_id: "not-an-admitted-claim".into(),
                },
                opener_tab_id: 0,
                url: "https://fixture.test/requested".into(),
            },
            language: maka_agent_facts::language::Language::En,
        };
        let context = crate::InvocationContext::new("fixture-session", "fixture-turn")
            .with_operation_id(operation_id.to_owned());
        let mut completion = connection
            .begin_browser(request, &context, cancellation.clone())
            .unwrap();
        let ParentFrame::Request { id, request } = read(&mut peer).await.unwrap() else {
            panic!("the new service retains its own original request");
        };
        let identity = super::super::callback_identity(&request).unwrap();
        assert_eq!(identity.operation_id, operation_id);
        assert!(matches!(*request, Request::LeaseChild { .. }));
        cancellation.cancel();
        assert!(
            matches!(read::<_, ParentFrame>(&mut peer).await.unwrap(), ParentFrame::Cancel { id: cancelled } if cancelled == id)
        );
        assert!(
            futures_util::poll!(&mut completion).is_pending(),
            "Cancel is not the actual native terminal reply"
        );
        respond(&mut peer, id, json!("the original worker reply")).await;
        let reply = completion.await.unwrap();
        assert_eq!(reply.value, json!("the original worker reply"));
        assert!(reply.audio.is_none());
        let peer_task = tokio::spawn(async move { shutdown(&mut peer).await });
        connection.close().await.unwrap();
        peer_task.await.unwrap();
    }

    // These keepers exercise real worker frame routing and its original
    // cancellation/decision lifetime; the fixture proves no native/HostDB lease.
    struct PreparationAuthority {
        calls: Arc<std::sync::Mutex<Vec<bool>>>,
        failure: Option<ToolError>,
    }
    impl BrowserAuthorization for PreparationAuthority {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async {
                Err(failed(
                    "session preparation must not request content access",
                ))
            })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async { Err(failed("session preparation must not check content access")) })
        }

        fn authorize_session_preparation(
            &self,
            _: crate::BrowserSessionPreparation,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.calls.lock().unwrap().push(true);
            let failure = self.failure.clone();
            Box::pin(async move { failure.map_or(Ok(()), Err) })
        }
        fn check_session_preparation(
            &self,
            _: crate::BrowserSessionPreparation,
            _: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.calls.lock().unwrap().push(false);
            let failure = self.failure.clone();
            Box::pin(async move { failure.map_or(Ok(()), Err) })
        }
    }
    struct LegacyOnlyPreparationAuthority;
    impl BrowserAuthorization for LegacyOnlyPreparationAuthority {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
    }
    fn preparation() -> crate::BrowserSessionPreparation {
        crate::BrowserSessionPreparation {
            native_owner: uuid::Uuid::from_u128(7),
            native_epoch: "actual-child-native-epoch".into(),
            browser_id: "fixture-browser".into(),
            generation: "fixture-generation".into(),
            turn_id: "fixture-turn".into(),
            operation_id: "preparation-operation".into(),
            target: crate::BrowserPreparationTarget::ClaimedTab {
                tab_id: "owned-tab".into(),
                claim_id: "owned-claim".into(),
            },
        }
    }
    fn preparation_request(epoch: &str, child: bool) -> Request {
        if child {
            Request::LeaseChild {
                owner: "fixture-owner".into(),
                epoch: epoch.into(),
                session: "fixture-session".into(),
                turn: "fixture-turn".into(),
                operation_id: "preparation-operation".into(),
                browsers: Vec::new(),
                preparation_policy: Default::default(),
                request: crate::BrowserLeaseChildRequest {
                    browser_id: "fixture-browser".into(),
                    generation: "fixture-generation".into(),
                    native_owner: uuid::Uuid::from_u128(7),
                    native_epoch: "actual-child-native-epoch".into(),
                    turn_id: "fixture-turn".into(),
                    completion_id: 1,
                    opener_subject: crate::BrowserLeaseSubject::PhysicalClaim {
                        claim_id: "owned-claim".into(),
                    },
                    opener_tab_id: 1,
                    url: "about:blank".into(),
                },
                language: maka_agent_facts::language::Language::En,
            }
        } else {
            let mut request = request(epoch, Command::Documentation);
            if let Request::Invoke { operation_id, .. } = &mut request {
                *operation_id = Some("preparation-operation".into());
            }
            request
        }
    }
    async fn preparation_callback(
        peer: &mut DuplexStream,
        id: u64,
        authorization_id: u64,
        mode: AuthorizationMode,
        identity: ScopeIdentity,
        preparation: crate::BrowserSessionPreparation,
    ) {
        write(
            peer,
            &WorkerFrame::BrowserSessionPreparationAuthorization {
                id,
                authorization_id,
                mode,
                identity,
                preparation,
            },
        )
        .await
        .unwrap();
    }
    async fn preparation_result(
        peer: &mut DuplexStream,
        expected: u64,
        authorization: u64,
    ) -> Result<(), Failure> {
        let ParentFrame::BrowserAuthorizationResult {
            id,
            authorization_id,
            result,
        } = read(peer).await.unwrap()
        else {
            panic!("typed preparation must use the original decision response");
        };
        assert_eq!((id, authorization_id), (expected, authorization));
        result
    }
    #[tokio::test]
    async fn typed_preparation_and_policy_follow_real_invoke_and_lease_child_frames() {
        for child in [false, true] {
            let (connection, mut peer) = fixture();
            let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
            let authority = Arc::new(PreparationAuthority {
                calls: calls.clone(),
                failure: None,
            });
            let policy = crate::BrowserPreparationPolicy {
                popup_enabled: true,
                headers: vec![crate::BrowserPreparationHeader {
                    name: "x-own-policy".into(),
                    value: "captured-context".into(),
                }],
            };
            let invocation = crate::InvocationContext::new("fixture-session", "fixture-turn")
                .with_operation_id("preparation-operation".into())
                .with_browser_authorization(authority)
                .with_browser_preparation_policy(policy.clone());
            let future = connection
                .begin_browser(
                    preparation_request("transport-epoch", child),
                    &invocation,
                    CancellationToken::new(),
                )
                .unwrap();
            drop(invocation); // Queued work retains this exact policy and authority.
            let call = tokio::spawn(future);
            let ParentFrame::Request { id, request } = read(&mut peer).await.unwrap() else {
                panic!("expected captured invocation");
            };
            let identity = super::super::callback_identity(&request).unwrap();
            assert_ne!(identity.owner, preparation().native_owner.to_string());
            assert_ne!(identity.epoch, preparation().native_epoch);
            let sent = match *request {
                Request::Invoke {
                    preparation_policy, ..
                }
                | Request::LeaseChild {
                    preparation_policy, ..
                } => preparation_policy,
                _ => panic!("expected policy-bearing request"),
            };
            assert_eq!(sent, policy);
            for (authorization_id, mode) in [
                (1, AuthorizationMode::Authorize),
                (2, AuthorizationMode::Check),
            ] {
                preparation_callback(
                    &mut peer,
                    id,
                    authorization_id,
                    mode,
                    identity.clone(),
                    preparation(),
                )
                .await;
                preparation_result(&mut peer, id, authorization_id)
                    .await
                    .unwrap();
            }
            assert_eq!(*calls.lock().unwrap(), vec![true, false]);
            respond(&mut peer, id, Value::Null).await;
            call.await.unwrap().unwrap();
            let close = {
                let connection = connection.clone();
                tokio::spawn(async move { connection.close().await })
            };
            shutdown(&mut peer).await;
            close.await.unwrap().unwrap();
        }
    }
    #[tokio::test]
    async fn stale_preparation_scope_operation_missing_host_and_legacy_authority_refuse_before_host()
     {
        for case in [
            "old-epoch",
            "old-operation",
            "wrong-dto-operation",
            "missing-scope",
            "no-host",
            "legacy-only",
        ] {
            let (connection, mut peer) = fixture();
            let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
            let authority: Option<Arc<dyn BrowserAuthorization>> = match case {
                "no-host" => None,
                "legacy-only" => Some(Arc::new(LegacyOnlyPreparationAuthority)),
                _ => Some(Arc::new(PreparationAuthority {
                    calls: calls.clone(),
                    failure: None,
                })),
            };
            let mut request = preparation_request("current-epoch", false);
            if case == "missing-scope"
                && let Request::Invoke { operation_id, .. } = &mut request
            {
                *operation_id = None;
            }
            let expected = super::super::callback_identity(&request);
            let call = {
                let connection = connection.clone();
                tokio::spawn(async move {
                    connection
                        .invoke(request, authority, CancellationToken::new())
                        .await
                })
            };
            let id = incoming(&mut peer).await;
            let mut observed = expected.unwrap_or(ScopeIdentity {
                owner: "fixture-owner".into(),
                epoch: "current-epoch".into(),
                session: "fixture-session".into(),
                turn: "fixture-turn".into(),
                operation_id: "preparation-operation".into(),
            });
            let mut dto = preparation();
            match case {
                "old-epoch" => observed.epoch = "old-epoch".into(),
                "old-operation" => observed.operation_id = "old-operation".into(),
                "wrong-dto-operation" => dto.operation_id = "other-operation".into(),
                _ => {}
            }
            preparation_callback(
                &mut peer,
                id,
                1,
                AuthorizationMode::Authorize,
                observed,
                dto,
            )
            .await;
            let refusal = preparation_result(&mut peer, id, 1).await;
            assert!(
                matches!(refusal, Err(Failure::Failed(_))),
                "{case}: {refusal:?}"
            );
            assert!(
                calls.lock().unwrap().is_empty(),
                "{case} must not call the current Host"
            );
            write(
                &mut peer,
                &WorkerFrame::Response {
                    id,
                    result: Err(Failure::Failed("worker kept actual refusal".into())),
                },
            )
            .await
            .unwrap();
            assert!(matches!(call.await.unwrap(), Err(ToolError::Failed(_))));
            let close = {
                let connection = connection.clone();
                tokio::spawn(async move { connection.close().await })
            };
            shutdown(&mut peer).await;
            close.await.unwrap().unwrap();
        }
    }
    #[tokio::test]
    async fn typed_preparation_cancellation_preserves_old_cleanup_and_native_ack() {
        let (connection, mut peer) = fixture();
        let started = Arc::new(tokio::sync::Notify::new());
        let cleanup = Arc::new(tokio::sync::Notify::new());
        let cancellation = CancellationToken::new();
        let original_request = preparation_request("old-epoch", false);
        let identity = super::super::callback_identity(&original_request).unwrap();
        let old = {
            let connection = connection.clone();
            let cancellation = cancellation.clone();
            let authorization = Arc::new(PendingAuthorization {
                started: started.clone(),
                cleanup: cleanup.clone(),
                failure: ToolError::CleanupUnconfirmed(
                    "fixture canonical withdrawal unavailable".into(),
                ),
            });
            tokio::spawn(async move {
                connection
                    .invoke(original_request, Some(authorization), cancellation)
                    .await
            })
        };
        let id = incoming(&mut peer).await;
        preparation_callback(
            &mut peer,
            id,
            1,
            AuthorizationMode::Authorize,
            identity,
            preparation(),
        )
        .await;
        started.notified().await;
        cancellation.cancel();
        cleanup.notified().await;
        let result = cancelled_authorization_result(&mut peer, id).await;
        assert!(
            matches!(result, Err(Failure::CleanupUnconfirmed(message)) if message.contains("fixture canonical withdrawal unavailable"))
        );
        assert!(
            !old.is_finished(),
            "canonical cleanup uncertainty cannot replace the old native ACK"
        );
        let fresh = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .invoke(
                        request("fresh-epoch", Command::Documentation),
                        None,
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        let fresh_id = incoming(&mut peer).await;
        respond(&mut peer, fresh_id, json!("fresh done")).await;
        assert_eq!(fresh.await.unwrap().unwrap().value, json!("fresh done"));
        respond(&mut peer, id, json!("old native ACK")).await;
        assert!(
            matches!(old.await.unwrap(), Err(ToolError::CleanupUnconfirmed(message)) if message.contains("fixture canonical withdrawal unavailable"))
        );
        assert!(matches!(
            connection.close().await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
    }
    #[tokio::test]
    async fn scoped_callback_fault_reaches_only_its_original_request_with_the_same_scope() {
        for source_completed in [false, true] {
            let (connection, mut peer) = fixture();
            let original = super::super::fixture_operation_unknown(3);
            let started = Arc::new(tokio::sync::Notify::new());
            let cleanup = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let authority = Arc::new(AttachmentAuthority {
                pending: PendingAuthorization {
                    started: started.clone(),
                    cleanup: cleanup.clone(),
                    failure: original.clone(),
                },
                release: release.clone(),
            });
            let mut calls = Vec::new();
            for preparation_id in [1_u64, 2] {
                let request = preparation_request("same-epoch", false);
                let identity = super::super::callback_identity(&request).unwrap();
                let call = {
                    let connection = connection.clone();
                    let authority = authority.clone();
                    tokio::spawn(async move {
                        connection
                            .invoke(request, Some(authority), CancellationToken::new())
                            .await
                    })
                };
                let id = incoming(&mut peer).await;
                write(
                    &mut peer,
                    &WorkerFrame::BrowserCallback {
                        message: WorkerMessage::Prepare {
                            invocation_id: id,
                            request_id: preparation_id,
                            key: super::super::callbacks::ScopeKey {
                                identity,
                                access: browser_access("https://fixture.test/"),
                            },
                        },
                    },
                )
                .await
                .unwrap();
                let ParentFrame::BrowserCallback { message } = read(&mut peer).await.unwrap()
                else {
                    panic!("expected the actual prepared parent scope");
                };
                let super::super::callbacks::ParentMessage::Prepared {
                    request_id, result, ..
                } = *message
                else {
                    panic!("expected the actual prepared parent token");
                };
                assert_eq!(request_id, preparation_id);
                let grant = serde_json::to_value((*result).unwrap()).unwrap();
                let token: super::super::callbacks::ScopeToken =
                    serde_json::from_value(grant["token"].clone()).unwrap();
                assert!(!call.is_finished());
                calls.push((id, token, call));
            }
            let mut calls = calls.into_iter();
            let (first_id, first_token, first) = calls.next().unwrap();
            let (second_id, second_token, second) = calls.next().unwrap();
            assert_ne!(first_id, second_id);
            assert_eq!(first_token.key.identity, second_token.key.identity);
            write(
                &mut peer,
                &WorkerFrame::BrowserCallback {
                    message: WorkerMessage::Check {
                        token: first_token.clone(),
                        id: 1,
                        origin: super::super::callbacks::AttachmentOrigin::Opaque,
                    },
                },
            )
            .await
            .unwrap();
            started.notified().await;
            write(
                &mut peer,
                &WorkerFrame::BrowserCallback {
                    message: WorkerMessage::CancelCheck {
                        token: first_token,
                        id: 1,
                    },
                },
            )
            .await
            .unwrap();
            cleanup.notified().await;
            let mut first = Some(first);
            if source_completed {
                // The raw native ACK does not settle the held original Host cleanup.
                respond(&mut peer, first_id, json!("original native ACK")).await;
                assert_eq!(
                    first.take().unwrap().await.unwrap().unwrap().value,
                    json!("original native ACK")
                );
            }
            release.notify_one();
            let ToolError::OperationUnknown {
                observation: expected,
                ..
            } = original
            else {
                unreachable!()
            };
            if let Some(first) = first {
                let ToolError::OperationCleanupUnconfirmed {
                    observation: actual,
                    ..
                } = first.await.unwrap().unwrap_err()
                else {
                    panic!("the source call lost its original observation");
                };
                assert_eq!(actual, expected);
            }
            let second = second.await.unwrap().unwrap_err();
            assert!(
                matches!(second, ToolError::CleanupUnconfirmed(_)),
                "a concurrent same-scope call must not inherit the source receipt"
            );
            let later = connection
                .invoke(
                    request("later", Command::Documentation),
                    None,
                    CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(later, ToolError::CleanupUnconfirmed(_)),
                "the connection fault watch cannot lend the source receipt"
            );
            assert!(
                matches!(connection.close().await, Err(ToolError::OperationCleanupUnconfirmed { observation, .. }) if observation == expected)
            );
        }
    }

    #[tokio::test]
    async fn cancelled_and_overlapping_preparation_keep_the_original_operation_receipt() {
        for overlap in [false, true] {
            let (connection, mut peer) = fixture();
            let started = Arc::new(tokio::sync::Notify::new());
            let cleanup = Arc::new(tokio::sync::Notify::new());
            let cancellation = CancellationToken::new();
            let request = preparation_request("original-epoch", false);
            let identity = super::super::callback_identity(&request).unwrap();
            let original = super::super::fixture_operation_unknown(3);
            let call = {
                let connection = connection.clone();
                let cancellation = cancellation.clone();
                let failure = original.clone();
                let authorization = Arc::new(PendingAuthorization {
                    started: started.clone(),
                    cleanup: cleanup.clone(),
                    failure,
                });
                tokio::spawn(async move {
                    connection
                        .invoke(request, Some(authorization), cancellation)
                        .await
                })
            };
            let id = incoming(&mut peer).await;
            preparation_callback(
                &mut peer,
                id,
                1,
                AuthorizationMode::Authorize,
                identity.clone(),
                preparation(),
            )
            .await;
            started.notified().await;
            if overlap {
                preparation_callback(
                    &mut peer,
                    id,
                    2,
                    AuthorizationMode::Authorize,
                    identity,
                    preparation(),
                )
                .await;
                cleanup.notified().await;
            } else {
                cancellation.cancel();
                cleanup.notified().await;
                assert!(
                    matches!(cancelled_authorization_result(&mut peer, id).await, Err(Failure::CleanupUnconfirmed(message)) if message.contains("original result remains unknown"))
                );
                assert!(
                    !call.is_finished(),
                    "cancelled authorization cleanup must still await the original native ACK"
                );
                respond(&mut peer, id, json!("original native ACK")).await;
            }
            let error = call.await.unwrap().unwrap_err();
            let (
                ToolError::OperationUnknown {
                    observation: expected,
                    ..
                },
                ToolError::OperationCleanupUnconfirmed {
                    message,
                    observation: actual,
                },
            ) = (original, error)
            else {
                panic!("uncertain withdrawal must preserve the original operation observation");
            };
            assert!(message.contains("original result remains unknown"));
            assert_eq!(actual, expected);
            assert!(connection.fault().is_some());
            assert!(connection.close().await.is_err());
        }
    }

    #[tokio::test]
    async fn another_requests_cleanup_cannot_replace_a_preparation_unknown_receipt() {
        let (connection, mut peer) = fixture();
        let mut calls = Vec::new();
        for operation in [3_u64, 4] {
            let request = preparation_request("shared-epoch", false);
            let identity = super::super::callback_identity(&request).unwrap();
            let original = super::super::fixture_operation_unknown(u128::from(operation));
            let call = {
                let connection = connection.clone();
                let original = original.clone();
                tokio::spawn(async move {
                    connection
                        .invoke(
                            request,
                            Some(Arc::new(PreparationAuthority {
                                calls: Arc::new(std::sync::Mutex::new(Vec::new())),
                                failure: Some(original),
                            })),
                            CancellationToken::new(),
                        )
                        .await
                })
            };
            let id = incoming(&mut peer).await;
            let dto = preparation();
            preparation_callback(
                &mut peer,
                id,
                operation,
                AuthorizationMode::Check,
                identity,
                dto,
            )
            .await;
            assert!(matches!(
                preparation_result(&mut peer, id, operation).await,
                Err(Failure::OutcomeUnknown(_))
            ));
            assert!(!call.is_finished());
            calls.push((id, original, call));
        }
        assert_ne!(calls[0].0, calls[1].0);
        write(
            &mut peer,
            &WorkerFrame::Response {
                id: calls[1].0,
                result: Err(Failure::CleanupUnconfirmed(
                    "second request native cleanup failed".into(),
                )),
            },
        )
        .await
        .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            connection.sealed.cancelled(),
        )
        .await
        .unwrap();
        assert!(
            calls.iter().all(|(_, _, call)| !call.is_finished()),
            "cleanup sealing is not native termination"
        );
        drop(peer);
        for (_, original, call) in calls {
            let actual = call.await.unwrap().unwrap_err();
            let (
                ToolError::OperationUnknown {
                    observation: expected,
                    ..
                },
                ToolError::OperationCleanupUnconfirmed {
                    observation: actual,
                    ..
                },
            ) = (original, actual)
            else {
                panic!(
                    "each request must retain its own original observation with cleanup uncertainty"
                );
            };
            assert_eq!(actual, expected);
        }
        assert!(matches!(
            connection.close().await,
            Err(ToolError::OperationCleanupUnconfirmed { .. })
        ));
        let later = connection
            .invoke(
                request("later-epoch", Command::Documentation),
                None,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(later, ToolError::CleanupUnconfirmed(_)),
            "a later call must not inherit a different request's receipt"
        );
    }

    #[tokio::test]
    async fn typed_preparation_outcome_unknown_is_not_downgraded_to_refusal() {
        enum NativeReply {
            Response(Result<Value, Failure>),
            Eof,
            ForeignPreparation,
        }
        for original in [
            ToolError::OutcomeUnknown("original result remains unknown".into()),
            super::super::fixture_operation_unknown(3),
        ] {
            for peer_result in [
                NativeReply::Response(Err(Failure::OutcomeUnknown("child outcome unknown".into()))),
                NativeReply::Response(Err(Failure::Failed(
                    "child reported a known refusal".into(),
                ))),
                NativeReply::Response(Ok(Value::Null)),
                NativeReply::Response(Err(Failure::CleanupUnconfirmed(
                    "child cleanup is not confirmed".into(),
                ))),
                NativeReply::Eof,
                NativeReply::ForeignPreparation,
            ] {
                let (connection, peer) = fixture();
                let mut peer = Some(peer);
                let request = preparation_request("current-epoch", false);
                let identity = super::super::callback_identity(&request).unwrap();
                let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
                let call = {
                    let connection = connection.clone();
                    let original = original.clone();
                    tokio::spawn(async move {
                        connection
                            .invoke(
                                request,
                                Some(Arc::new(PreparationAuthority {
                                    calls,
                                    failure: Some(original),
                                })),
                                CancellationToken::new(),
                            )
                            .await
                    })
                };
                let id = incoming(peer.as_mut().unwrap()).await;
                preparation_callback(
                    peer.as_mut().unwrap(),
                    id,
                    1,
                    AuthorizationMode::Check,
                    identity.clone(),
                    preparation(),
                )
                .await;
                let decision = preparation_result(peer.as_mut().unwrap(), id, 1).await;
                assert!(
                    matches!(decision, Err(Failure::OutcomeUnknown(message)) if message == "original result remains unknown")
                );
                assert!(
                    !call.is_finished(),
                    "the authorization decision cannot replace the original native ACK"
                );
                let native_cleanup = matches!(
                    &peer_result,
                    NativeReply::Response(Err(Failure::CleanupUnconfirmed(_)))
                );
                let native_response = matches!(&peer_result, NativeReply::Response(_));
                match peer_result {
                    NativeReply::Response(result) => {
                        write(
                            peer.as_mut().unwrap(),
                            &WorkerFrame::Response { id, result },
                        )
                        .await
                        .unwrap();
                    }
                    NativeReply::Eof => drop(peer.take()),
                    NativeReply::ForeignPreparation => {
                        let mut foreign = identity;
                        foreign.operation_id = "foreign-host-operation".into();
                        write(
                            peer.as_mut().unwrap(),
                            &WorkerFrame::BrowserCallback {
                                message: WorkerMessage::Prepare {
                                    invocation_id: id,
                                    request_id: 99,
                                    key: super::super::callbacks::ScopeKey {
                                        identity: foreign,
                                        access: BrowserAccess::Read {
                                            document: crate::BrowserDocument {
                                                browser_id: "fixture-browser".into(),
                                                generation: "fixture-generation".into(),
                                                tab_id: "owned-tab".into(),
                                                url: "https://fixture.test".into(),
                                            },
                                        },
                                    },
                                },
                            },
                        )
                        .await
                        .unwrap();
                    }
                }
                let actual = call.await.unwrap().unwrap_err();
                match (&original, &actual) {
                    (ToolError::OutcomeUnknown(expected), ToolError::OutcomeUnknown(actual)) => {
                        assert!(!native_cleanup);
                        assert_eq!(actual, expected);
                    }
                    (
                        ToolError::OperationUnknown {
                            message: expected,
                            observation: expected_observation,
                        },
                        ToolError::OperationUnknown {
                            message: actual,
                            observation: actual_observation,
                        },
                    ) => {
                        assert!(!native_cleanup);
                        assert_eq!(actual, expected);
                        assert_eq!(actual_observation, expected_observation);
                    }
                    (ToolError::OutcomeUnknown(_), ToolError::CleanupUnconfirmed(message)) => {
                        assert!(native_cleanup);
                        assert_eq!(message, "child cleanup is not confirmed");
                    }
                    (
                        ToolError::OperationUnknown {
                            observation: expected,
                            ..
                        },
                        ToolError::OperationCleanupUnconfirmed {
                            message,
                            observation: actual,
                        },
                    ) => {
                        assert!(native_cleanup);
                        assert_eq!(message, "child cleanup is not confirmed");
                        assert_eq!(actual, expected);
                    }
                    _ => panic!("original {original:?} was replaced by {actual:?}"),
                }
                if native_response && !native_cleanup {
                    let close = {
                        let connection = connection.clone();
                        tokio::spawn(async move { connection.close().await })
                    };
                    shutdown(peer.as_mut().unwrap()).await;
                    close.await.unwrap().unwrap();
                } else {
                    assert!(matches!(
                        connection.close().await,
                        Err(ToolError::CleanupUnconfirmed(_)
                            | ToolError::OperationCleanupUnconfirmed { .. })
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod native_observer_tests {
    use super::*;
    use crate::native_interruption::{WireNativeNotice, WireNativeSource};
    use std::sync::Mutex;
    use tokio::sync::Notify;

    #[derive(Default)]
    struct ObservationGate {
        entered: Notify,
        release: Notify,
    }
    #[derive(Default)]
    struct Probe {
        events: Arc<Mutex<Vec<crate::NativeInterruption>>>,
        drains: Arc<Mutex<Vec<crate::NativeInterruptionDrain>>>,
        gate: Option<Arc<ObservationGate>>,
        fail: bool,
    }
    impl crate::NativeInterruptionObserver for Probe {
        fn interrupted(&self, observed: crate::NativeInterruption) -> crate::InterruptionFuture {
            let events = self.events.clone();
            let gate = self.gate.clone();
            let fail = self.fail;
            Box::pin(async move {
                if let Some(gate) = gate {
                    gate.entered.notify_one();
                    gate.release.notified().await;
                }
                events.lock().unwrap().push(observed);
                if fail {
                    Err(failed("fixture native writer failed"))
                } else {
                    Ok(())
                }
            })
        }
        fn drained(&self, observed: crate::NativeInterruptionDrain) -> crate::InterruptionFuture {
            let drains = self.drains.clone();
            Box::pin(async move {
                drains.lock().unwrap().push(observed);
                Ok(())
            })
        }
    }
    fn identity(operation: &str) -> ScopeIdentity {
        ScopeIdentity {
            owner: "fixture-owner".into(),
            epoch: "outer-epoch".into(),
            session: "fixture-session".into(),
            turn: "fixture-turn".into(),
            operation_id: operation.into(),
        }
    }
    fn source(operation: &str) -> WireNativeSource {
        WireNativeSource {
            session: "fixture-session".into(),
            turn: "fixture-turn".into(),
            native_epoch: "actual-windows-local-epoch".into(),
            generation: uuid::Uuid::from_u128(7).to_string(),
            operation_id: operation.into(),
        }
    }
    fn request(operation: &str) -> Request {
        Request::Invoke {
            owner: "fixture-owner".into(),
            epoch: "outer-epoch".into(),
            session: "fixture-session".into(),
            turn: "fixture-turn".into(),
            operation_id: Some(operation.into()),
            native_observer_available: false,
            browsers: Vec::new(),
            preparation_policy: Default::default(),
            command: Box::new(Command::ListApps {
                options: Default::default(),
            }),
            language: maka_agent_facts::language::Language::En,
        }
    }
    fn pending_request(identity: ScopeIdentity, observer: Arc<Probe>) -> Pending {
        let (frames, _receiver) = mpsc::unbounded_channel();
        Pending {
            native_observer: Some(observer),
            frames,
            response_received: false,
            identity: Some(identity),
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            native_retirement: None,
            #[cfg(all(target_os = "windows", feature = "native-desktop"))]
            native_call: false,
        }
    }

    #[tokio::test]
    async fn native_proxy_presence_comes_from_actual_capability_not_operation_id_or_wire_flag() {
        for available in [false, true] {
            let (connection, mut task) = Connection::channel();
            let probe = Arc::new(Probe::default());
            let mut invocation = crate::InvocationContext::new("fixture-session", "fixture-turn")
                .with_operation_id("source-A".into());
            if available {
                invocation = invocation.with_native_interruption_observer(probe);
            }
            let mut wire = request("source-A");
            if let Request::Invoke {
                native_observer_available,
                ..
            } = &mut wire
            {
                *native_observer_available = !available;
            }
            let observing = connection
                .begin_browser(wire, &invocation, CancellationToken::new())
                .unwrap();
            let queued = task.receive.try_recv().unwrap();
            let Request::Invoke {
                native_observer_available,
                ..
            } = queued.request
            else {
                panic!("actual Invoke")
            };
            assert_eq!(native_observer_available, available);
            assert_eq!(queued.capabilities.native_interruption.is_some(), available);
            drop(observing);
        }
    }

    #[tokio::test]
    async fn retained_native_proxy_allows_idle_escape_and_maps_only_the_bound_parent_epoch() {
        let (_connection, mut task) = Connection::channel();
        let probe = Arc::new(Probe::default());
        let mut pending = HashMap::new();
        pending.insert(1, pending_request(identity("source-A"), probe.clone()));
        task.native_notice(
            1,
            &identity("source-A"),
            WireNativeNotice::Bound(source("source-A")),
            &pending,
        )
        .await
        .unwrap();
        pending.remove(&1); // The first T1/T2/RPC has really returned; its binding remains.
        task.native_notice(
            1,
            &identity("source-A"),
            WireNativeNotice::Interrupted(source("source-A")),
            &pending,
        )
        .await
        .unwrap();
        {
            let events = probe.events.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].native_epoch(), "outer-epoch");
            assert_eq!(events[0].operation_id(), "source-A");
            assert_eq!(events[0].generation(), uuid::Uuid::from_u128(7).to_string());
        }
        let mut changed = source("source-A");
        changed.generation = uuid::Uuid::from_u128(8).to_string();
        assert!(
            task.native_notice(
                1,
                &identity("source-A"),
                WireNativeNotice::Interrupted(changed),
                &pending
            )
            .await
            .is_err()
        );
        assert!(
            task.native_notice(
                1,
                &identity("source-A"),
                WireNativeNotice::Bound(source("source-A")),
                &pending
            )
            .await
            .is_err(),
            "terminal RPC cannot register a new observer"
        );
        assert_eq!(probe.events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn drain_uses_exact_unacknowledged_affected_operation_not_the_binding_producer() {
        let (_connection, mut task) = Connection::channel();
        let source_probe = Arc::new(Probe::default());
        let affected_probe = Arc::new(Probe::default());
        let mut pending = HashMap::new();
        pending.insert(
            1,
            pending_request(identity("source-A"), source_probe.clone()),
        );
        task.native_notice(
            1,
            &identity("source-A"),
            WireNativeNotice::Bound(source("source-A")),
            &pending,
        )
        .await
        .unwrap();
        pending.remove(&1);
        pending.insert(
            2,
            pending_request(identity("affected-B"), affected_probe.clone()),
        );
        let notice = || WireNativeNotice::Drained {
            source: source("source-A"),
            affected_operation_id: "affected-B".into(),
        };
        task.native_notice(2, &identity("affected-B"), notice(), &pending)
            .await
            .unwrap();
        assert!(source_probe.drains.lock().unwrap().is_empty());
        {
            let drains = affected_probe.drains.lock().unwrap();
            assert_eq!(drains.len(), 1);
            assert_eq!(drains[0].operation_id(), "source-A");
            assert_eq!(drains[0].affected_operation_id(), "affected-B");
            assert_eq!(drains[0].native_epoch(), "outer-epoch");
        }
        pending.get_mut(&2).unwrap().response_received = true;
        assert!(
            task.native_notice(2, &identity("affected-B"), notice(), &pending)
                .await
                .is_err(),
            "a completed success must never be relabeled by idle Escape"
        );
        assert_eq!(affected_probe.drains.lock().unwrap().len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn observer_future_survives_wire_eof_while_actual_owned_child_is_reaped() {
        use std::process::Stdio;
        use tokio::io::BufReader;
        let gate = Arc::new(ObservationGate::default());
        let probe = Arc::new(Probe {
            gate: Some(gate.clone()),
            ..Default::default()
        });
        let identity = identity("source-A");
        let frames = [
            WorkerFrame::BrowserCallback {
                message: WorkerMessage::NativeObserver {
                    invocation_id: 1,
                    id: 101,
                    identity: identity.clone(),
                    notice: WireNativeNotice::Bound(source("source-A")),
                },
            },
            WorkerFrame::Response {
                id: 1,
                result: Ok(Value::Null),
            },
            WorkerFrame::BrowserCallback {
                message: WorkerMessage::NativeObserver {
                    invocation_id: 1,
                    id: 102,
                    identity: identity.clone(),
                    notice: WireNativeNotice::Interrupted(source("source-A")),
                },
            },
        ];
        let octal = |bytes: Vec<u8>| {
            bytes
                .iter()
                .map(|byte| format!(r"\{:03o}", byte))
                .collect::<String>()
        };
        let hello = octal(
            super::super::encode(&super::super::Hello {
                protocol: super::super::PROTOCOL,
                platform: "windows".into(),
                audio_enabled: false,
            })
            .unwrap(),
        );
        let frames = octal(
            frames
                .iter()
                .flat_map(|frame| super::super::encode(frame).unwrap())
                .collect(),
        );
        // Task-owned protocol peer only: no Windows/native SDK/input/audio.
        // Closing stdout while still reading stdin creates the real EOF path;
        // Parent's writer close then lets this exact shell child exit.
        let script = format!(
            "printf '%b' '{hello}'; dd bs=1 count=1 of=/dev/null 2>/dev/null; printf '%b' '{frames}'; exec 1>&-; cat >/dev/null"
        );
        let mut child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let process = Process {
            pipes: Some((
                child.stdin.take().unwrap(),
                BufReader::new(child.stdout.take().unwrap()),
            )),
            child,
        };
        let connection = Connection::start(process.handshake(false).await.unwrap());
        let context = crate::InvocationContext::new("fixture-session", "fixture-turn")
            .with_operation_id("source-A".into())
            .with_native_interruption_observer(probe.clone());
        connection
            .invoke_browser(request("source-A"), &context, CancellationToken::new())
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.notified())
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while std::path::Path::new(&format!("/proc/{pid}")).exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("actual owned child wait/reap must not wait on Host observation");
        assert!(
            connection.closed.borrow().is_none(),
            "same observer future is still owned, not discarded on EOF"
        );
        assert!(probe.events.lock().unwrap().is_empty());
        gate.release.notify_one();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), connection.close())
            .await
            .unwrap();
        assert_eq!(probe.events.lock().unwrap().len(), 1);
    }
}
