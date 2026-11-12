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
        match &request {
            Request::Invoke {
                session,
                turn,
                execution,
                operation_id,
                ..
            } => {
                if session != invocation.session()
                    || turn != invocation.turn()
                    || execution != invocation.execution_correlation()
                    || operation_id.as_deref() != invocation.operation_id()
                {
                    return Err(failed(
                        "desktop request changed its original invocation source",
                    ));
                }
            }
            Request::LeaseChild {
                session,
                turn,
                execution,
                operation_id,
                ..
            } if (session != invocation.session()
                || turn != invocation.turn()
                || execution != invocation.execution_correlation()
                || Some(operation_id.as_str()) != invocation.operation_id()) =>
            {
                return Err(failed(
                    "browser lease child changed its original invocation source",
                ));
            }
            _ => {}
        }
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
                preview: None,
            },
            cancellation,
        )
    }

    pub(in crate::desktop) fn same_connection(&self, other: &Self) -> bool {
        self.requests.same_channel(&other.requests)
    }
    pub(in crate::desktop) async fn invoke_preview(
        &self,
        request: Request,
        authority: Option<Arc<dyn crate::preview::PreviewAuthority>>,
        cancellation: CancellationToken,
    ) -> Result<Reply, ToolError> {
        self.invoke_capabilities(
            request,
            ParentCapabilities {
                preview: authority,
                ..Default::default()
            },
            cancellation,
        )
        .await
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
                    outer.execution.clone(),
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
                    || inner.execution != identity.execution
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
                        && binding.identity.execution == identity.execution
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
                                    && binding.execution_correlation() == &key.execution
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
                        WorkerFrame::PreviewAuthorization { id, authorization_id, .. }
                        | WorkerFrame::BrowserAuthorization { id, authorization_id, .. }
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
                            if source.observer.is_none() || binding.session() != key.session || binding.turn() != key.turn || binding.execution_correlation() != &key.execution || binding.native_epoch() != key.epoch || binding.generation() != native.generation.observed() || Some(binding.operation_id()) != operation_id.as_deref() {
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
                    let cancel_native = matches!(&invocation.request, Request::Invoke { .. } | Request::LeaseChild { .. } | Request::PreviewRead { .. } | Request::PreviewWatch { .. });
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
            frame @ (WorkerFrame::PreviewAuthorization { .. } | WorkerFrame::BrowserAuthorization { .. }
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
                    WorkerFrame::PreviewAuthorization { authorization_id, request, .. } => (authorization_id, AuthorizationMode::Check, BrowserAuthorizationRequest::Preview(request)),
                    _ => unreachable!("matched authorization frame"),
                };
                let callback_cancellation = cancellation.child_token();
                let _callback_lifetime = callback_cancellation.clone().drop_guard();
                let mut decision: crate::AuthorizationFuture = match request {
                    BrowserAuthorizationRequest::Preview(request) => super::preview::decide(capabilities.preview.clone(), request, callback_cancellation.clone()),
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
                        let overlap = matches!(&frame, Ok(WorkerFrame::PreviewAuthorization { .. } | WorkerFrame::BrowserAuthorization { .. }
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
mod preview_tests;
