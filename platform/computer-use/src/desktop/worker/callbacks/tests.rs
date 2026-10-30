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
use futures_util::poll;
use std::sync::atomic::AtomicUsize;
use tokio::sync::mpsc;

#[derive(Default)]
struct Authority {
    reads: Mutex<Vec<BrowserAccess>>,
    origins: Arc<Mutex<Vec<BrowserAttachmentOrigin>>>,
    metadata_checks: Arc<AtomicUsize>,
    check_failure: Option<ToolError>,
    attachment_failure: Option<ToolError>,
    attachment_wait_for_cancel: bool,
    attachment_started: Arc<Notify>,
}
impl BrowserAuthorization for Authority {
    fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
        panic!("preparing attachment services must never request a new grant");
    }
    fn check(&self, access: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
        self.reads.lock().unwrap().push(access);
        let failure = self.check_failure.clone();
        Box::pin(async move { failure.map_or(Ok(()), Err) })
    }
    fn attachment(&self) -> Option<Arc<dyn BrowserAttachmentAuthorization>> {
        Some(Arc::new(Attachment {
            origins: self.origins.clone(),
            metadata_checks: self.metadata_checks.clone(),
            failure: self.attachment_failure.clone(),
            wait_for_cancel: self.attachment_wait_for_cancel,
            started: self.attachment_started.clone(),
        }))
    }
}
struct Attachment {
    origins: Arc<Mutex<Vec<BrowserAttachmentOrigin>>>,
    metadata_checks: Arc<AtomicUsize>,
    failure: Option<ToolError>,
    wait_for_cancel: bool,
    started: Arc<Notify>,
}
impl BrowserAttachmentAuthorization for Attachment {
    fn check_metadata(&self, cancellation: CancellationToken) -> AuthorizationFuture {
        self.metadata_checks.fetch_add(1, Ordering::SeqCst);
        let failure = self.failure.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(failed("fixture metadata cancelled"));
            }
            failure.map_or(Ok(()), Err)
        })
    }
    fn check(
        &self,
        origin: BrowserAttachmentOrigin,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        self.origins.lock().unwrap().push(origin);
        let started = self.started.clone();
        let failure = self.failure.clone();
        let wait_for_cancel = self.wait_for_cancel;
        Box::pin(async move {
            started.notify_one();
            if wait_for_cancel {
                cancellation.cancelled().await;
            }
            failure.map_or(Ok(()), Err)
        })
    }
}
struct Admitted {
    pending: HostEffectFuture,
    uncertainty: HostUncertaintyFuture,
}
#[derive(Default)]
struct Host {
    admitted: Mutex<Vec<Admitted>>,
    retained: Mutex<Vec<CheckedSettlementFuture>>,
    rejection: Option<ToolError>,
}
impl BrowserHostEffects for Host {
    fn spawn(&self, _: HostEffectFuture) -> Result<(), ToolError> {
        panic!("remote admission must preserve uncertainty observation");
    }
    fn spawn_custodied(
        &self,
        pending: HostEffectFuture,
        uncertainty: HostUncertaintyFuture,
        _: Rejected,
    ) -> Result<(), ToolError> {
        if let Some(error) = &self.rejection {
            return Err(error.clone());
        }
        self.admitted.lock().unwrap().push(Admitted {
            pending,
            uncertainty,
        });
        Ok(())
    }
}
impl OperationSettlement for Host {
    fn retain(&self, _: SettlementFuture) -> Result<(), (ToolError, SettlementFuture)> {
        panic!("the parent must observe checked remote completion");
    }
    fn retain_checked(
        &self,
        pending: CheckedSettlementFuture,
    ) -> Result<(), (ToolError, CheckedSettlementFuture)> {
        self.retained.lock().unwrap().push(pending);
        Ok(())
    }
}
struct Fixture {
    parent: ParentCallbacks,
    worker: WorkerCallbacks,
    parent_messages: mpsc::UnboundedReceiver<ParentMessage>,
    worker_messages: mpsc::UnboundedReceiver<WorkerMessage>,
    faults: mpsc::UnboundedReceiver<CallbackFault>,
}
impl Fixture {
    fn new() -> Self {
        let (parent_send, parent_messages) = mpsc::unbounded_channel();
        let (worker_send, worker_messages) = mpsc::unbounded_channel();
        let (fault, faults) = mpsc::unbounded_channel();
        Self {
            parent: ParentCallbacks::new(
                Arc::new(move |message| {
                    parent_send
                        .send(message)
                        .map_err(|_| failed("fixture parent closed"))
                }),
                fault,
            ),
            worker: WorkerCallbacks::new(Arc::new(move |message| {
                worker_send
                    .send(message)
                    .map_err(|_| failed("fixture worker closed"))
            })),
            parent_messages,
            worker_messages,
            faults,
        }
    }
    async fn prepare(&mut self, authority: Arc<Authority>, host: Arc<Host>) -> BrowserServices {
        self.prepare_access(17, key(), authority, host).await
    }
    async fn prepare_access(
        &mut self,
        invocation_id: u64,
        key: ScopeKey,
        authority: Arc<Authority>,
        host: Arc<Host>,
    ) -> BrowserServices {
        let identity = key.identity.clone();
        let worker = self.worker.clone();
        let preparing = tokio::spawn(async move {
            worker
                .prepare(invocation_id, key, CancellationToken::new())
                .await
        });
        let actual_invocation = invocation_id;
        let WorkerMessage::Prepare {
            invocation_id,
            request_id,
            key: actual,
        } = self.worker_message().await
        else {
            panic!("expected service preparation");
        };
        assert_eq!(invocation_id, actual_invocation);
        self.parent
            .prepare(
                actual_invocation,
                request_id,
                actual,
                &identity,
                ParentCapabilities {
                    files: None,
                    native_interruption: None,
                    authorization: Some(authority),
                    attachment: None,
                    effects: Some(host.clone()),
                    settlement: Some(host),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let prepared = self.parent_message().await;
        self.worker.handle(prepared).unwrap();
        preparing.await.unwrap().unwrap()
    }
    async fn parent_message(&mut self) -> ParentMessage {
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.parent_messages.recv(),
        )
        .await
        .unwrap()
        .unwrap()
    }
    async fn worker_message(&mut self) -> WorkerMessage {
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.worker_messages.recv(),
        )
        .await
        .unwrap()
        .unwrap()
    }
}
fn identity() -> ScopeIdentity {
    ScopeIdentity {
        owner: "logical-owner".into(),
        epoch: "native-epoch".into(),
        session: "agent-session".into(),
        turn: "logical-turn".into(),
        operation_id: "original-host-operation".into(),
    }
}
fn key() -> ScopeKey {
    ScopeKey {
        identity: identity(),
        access: BrowserAccess::Read {
            document: crate::BrowserDocument {
                browser_id: "selected-browser".into(),
                generation: "selected-generation".into(),
                tab_id: "selected-tab".into(),
                url: "https://fixture.test/page".into(),
            },
        },
    }
}
fn remote_token(worker: &WorkerCallbacks) -> ScopeToken {
    worker
        .0
        .state
        .lock()
        .unwrap()
        .scopes
        .values()
        .next()
        .unwrap()
        .token
        .clone()
}

#[tokio::test]
async fn rejected_and_sealed_effects_do_not_poll_or_borrow_a_new_scope() {
    let mut fixture = Fixture::new();
    let host = Arc::new(Host {
        rejection: Some(failed("original Host rejected")),
        ..Host::default()
    });
    let services = fixture
        .prepare(Arc::new(Authority::default()), host.clone())
        .await;
    let polls = Arc::new(AtomicUsize::new(0));
    let rejected = Arc::new(AtomicUsize::new(0));
    let observed = polls.clone();
    let refusals = rejected.clone();
    services
        .effects
        .as_ref()
        .unwrap()
        .spawn_guarded(
            Box::pin(async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
            Box::new(move |_| {
                refusals.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .unwrap();
    let message = fixture.worker_message().await;
    fixture.parent.handle(message).unwrap();
    let message = fixture.parent_message().await;
    assert!(matches!(&message, ParentMessage::Rejected { .. }));
    fixture.worker.handle(message).unwrap();
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    assert_eq!(rejected.load(Ordering::SeqCst), 1);
    let declined = fixture.worker_message().await;
    assert!(matches!(&declined, WorkerMessage::EffectDeclined { .. }));
    fixture.parent.handle(declined).unwrap();
    assert!(fixture.parent.0.state.lock().unwrap().effects.is_empty());
    fixture.parent.seal(&identity());
    let message = fixture.parent_message().await;
    fixture.worker.handle(message).unwrap();
    assert!(
        services
            .effects
            .as_ref()
            .unwrap()
            .spawn_guarded(Box::pin(async { Ok(()) }), Box::new(|_| {}))
            .is_err()
    );
    let mut forged = remote_token(&fixture.worker);
    forged.key.identity.epoch = "another-epoch".into();
    assert!(
        fixture
            .parent
            .handle(WorkerMessage::Effect {
                token: forged,
                id: 100
            })
            .is_err()
    );
    assert!(host.admitted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn attachment_uses_security_origin_and_original_captured_scope() {
    let mut fixture = Fixture::new();
    let authority = Arc::new(Authority::default());
    let services = fixture
        .prepare(authority.clone(), Arc::new(Host::default()))
        .await;
    let attachment = services.attachment.unwrap();
    let checking = tokio::spawn(async move {
        attachment
            .check(
                BrowserAttachmentOrigin::Site("https://inherited.test".into()),
                CancellationToken::new(),
            )
            .await
    });
    let message = fixture.worker_message().await;
    fixture.parent.handle(message).unwrap();
    let message = fixture.parent_message().await;
    fixture.worker.handle(message).unwrap();
    checking.await.unwrap().unwrap();
    assert_eq!(
        *authority.origins.lock().unwrap(),
        vec![BrowserAttachmentOrigin::Site(
            "https://inherited.test".into()
        )]
    );
}

#[tokio::test]
async fn checked_rpc_custody_is_accepted_before_completion_and_reports_uncertainty() {
    let mut fixture = Fixture::new();
    let host = Arc::new(Host::default());
    let services = fixture
        .prepare(Arc::new(Authority::default()), host.clone())
        .await;
    let (finish, finished) = oneshot::channel();
    services
        .settlement
        .as_ref()
        .unwrap()
        .retain_checked(Box::pin(async move { finished.await.unwrap() }))
        .unwrap_or_else(|(error, _)| panic!("remote checked custody refused: {error}"));
    let message = fixture.worker_message().await;
    fixture.parent.handle(message).unwrap();
    let message = fixture.parent_message().await;
    fixture.worker.handle(message).unwrap();
    fixture.worker.barrier(&identity(), 17).await.unwrap();
    assert!(
        fixture.parent.has_unsettled(),
        "handoff ACK cannot pretend the original RPC finished"
    );
    let mut pending = host.retained.lock().unwrap().pop().unwrap();
    assert!(poll!(pending.as_mut()).is_pending());
    finish
        .send(Err(ToolError::OutcomeUnknown("original RPC EOF".into())))
        .unwrap();
    let message = fixture.worker_message().await;
    assert!(matches!(&message, WorkerMessage::RetainedUncertain { .. }));
    fixture.parent.handle(message).unwrap();
    assert!(matches!(
        poll!(pending.as_mut()),
        Poll::Ready(Err(ToolError::CleanupUnconfirmed(_)))
    ));
    assert!(fixture.worker.barrier(&identity(), 17).await.is_err());
    assert!(fixture.parent.has_unsettled());
    assert!(fixture.worker.has_unsettled());
}

#[tokio::test]
async fn lost_transport_after_admission_is_uncertain_and_does_not_complete_host_effect() {
    let mut fixture = Fixture::new();
    let host = Arc::new(Host::default());
    let services = fixture
        .prepare(Arc::new(Authority::default()), host.clone())
        .await;
    services
        .effects
        .unwrap()
        .spawn_guarded(
            Box::pin(std::future::pending()),
            Box::new(|_| panic!("admitted effect cannot be rejected as unpolled")),
        )
        .unwrap();
    let message = fixture.worker_message().await;
    fixture.parent.handle(message).unwrap();
    let mut admitted = host.admitted.lock().unwrap().pop().unwrap();
    assert!(poll!(admitted.pending.as_mut()).is_pending());
    let message = fixture.parent_message().await;
    fixture.worker.handle(message).unwrap();
    tokio::task::yield_now().await;
    fixture.parent.disconnect("fixture EOF");
    fixture.worker.disconnect("fixture EOF");
    assert!(matches!(poll!(admitted.pending.as_mut()), Poll::Pending));
    assert!(matches!(
        poll!(admitted.uncertainty.as_mut()),
        Poll::Ready(ToolError::CleanupUnconfirmed(_))
    ));
    assert!(fixture.parent.has_unsettled());
    assert!(fixture.worker.has_unsettled());
}

#[tokio::test]
async fn physical_checked_reply_before_custody_ack_releases_the_exact_scope_once() {
    let mut fixture = Fixture::new();
    let host = Arc::new(Host::default());
    let services = fixture
        .prepare(Arc::new(Authority::default()), host.clone())
        .await;
    services
        .settlement
        .as_ref()
        .unwrap()
        .retain_checked(Box::pin(async { Ok(()) }))
        .unwrap_or_else(|(error, _)| panic!("checked RPC handoff failed: {error}"));
    let message = fixture.worker_message().await;
    fixture.parent.handle(message).unwrap();
    let message = fixture.worker_message().await;
    assert!(matches!(&message, WorkerMessage::RetainedFinished { .. }));
    fixture.parent.handle(message).unwrap();
    let mut pending = host.retained.lock().unwrap().pop().unwrap();
    assert!(matches!(poll!(pending.as_mut()), Poll::Ready(Ok(()))));
    let worker = fixture.worker.clone();
    let identity = identity();
    let barrier = worker.barrier(&identity, 17);
    tokio::pin!(barrier);
    assert!(
        poll!(&mut barrier).is_pending(),
        "physical completion cannot forge Parent custody acceptance"
    );
    let message = fixture.parent_message().await;
    assert!(matches!(
        &message,
        ParentMessage::Retained { result: Ok(()), .. }
    ));
    fixture.worker.handle(message).unwrap();
    barrier.await.unwrap();
    drop(services);
    let message = fixture.worker_message().await;
    assert!(matches!(&message, WorkerMessage::Release { .. }));
    fixture.parent.handle(message).unwrap();
    let message = fixture.parent_message().await;
    assert!(matches!(&message, ParentMessage::Released { .. }));
    fixture.worker.handle(message).unwrap();
    assert!(fixture.worker.0.state.lock().unwrap().scopes.is_empty());
    assert!(fixture.parent.0.state.lock().unwrap().scopes.is_empty());
}

#[tokio::test]
async fn cancelled_attachment_cleanup_faults_original_connection_after_receiver_has_returned() {
    let mut fixture = Fixture::new();
    let authority = Arc::new(Authority {
        attachment_failure: Some(ToolError::Persistence(
            "original authority prompt cleanup was lost".into(),
        )),
        attachment_wait_for_cancel: true,
        ..Authority::default()
    });
    let services = fixture
        .prepare(authority.clone(), Arc::new(Host::default()))
        .await;
    let token = remote_token(&fixture.worker);
    let cancellation = CancellationToken::new();
    let cancelled = cancellation.clone();
    let attachment = services.attachment.unwrap();
    let checking = tokio::spawn(async move {
        attachment
            .check(
                BrowserAttachmentOrigin::Site("https://original.test".into()),
                cancellation,
            )
            .await
    });
    let message = fixture.worker_message().await;
    fixture.parent.handle(message).unwrap();
    authority.attachment_started.notified().await;
    cancelled.cancel();
    let message = fixture.worker_message().await;
    assert!(matches!(&message, WorkerMessage::CancelCheck { .. }));
    fixture.parent.handle(message).unwrap();
    assert!(
        matches!(checking.await.unwrap(), Err(ToolError::Failed(message)) if message == "Browser attachment check cancelled")
    );
    let message = fixture.parent_message().await;
    assert!(
        matches!(&message, ParentMessage::Checked { token: actual, result: Err(Failure::CleanupUnconfirmed(message)), .. }
        if *actual == token && message.contains("original authority prompt cleanup was lost"))
    );
    fixture.worker.handle(message).unwrap();
    let fault = tokio::time::timeout(std::time::Duration::from_secs(2), fixture.faults.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fault.invocation_id, Some(17));
    assert!(
        matches!(fault.error, ToolError::CleanupUnconfirmed(message) if message.contains("original authority prompt cleanup was lost"))
    );
    assert!(
        fixture.parent.has_unsettled(),
        "the dropped child receiver cannot erase the original Host cleanup failure"
    );
    let foreign = Arc::new(Authority::default());
    let mut key = key();
    key.identity.operation_id = "next-operation".into();
    let identity = key.identity.clone();
    let refused = fixture
        .parent
        .prepare(
            18,
            901,
            key,
            &identity,
            ParentCapabilities {
                authorization: Some(foreign.clone()),
                ..ParentCapabilities::default()
            },
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(refused, Err(ToolError::Failed(_))));
    assert!(matches!(
        fixture.parent_messages.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    assert!(
        foreign.reads.lock().unwrap().is_empty(),
        "a later invocation cannot supply replacement authority"
    );
    assert!(
        fixture.parent.has_unsettled(),
        "a rejected invocation cannot erase the original cleanup custody"
    );
}

#[tokio::test]
async fn verified_opaque_presentation_uses_the_same_host_scope_without_clipboard_origin() {
    let mut fixture = Fixture::new();
    let authority = Arc::new(Authority::default());
    let mut opaque = key();
    opaque.access = BrowserAccess::ReadDocument {
        document: opaque.access.document().clone(),
        origin: BrowserAttachmentOrigin::Opaque,
    };
    let services = fixture
        .prepare_access(17, opaque, authority.clone(), Arc::new(Host::default()))
        .await;
    let checking = tokio::spawn(async move {
        services
            .attachment
            .unwrap()
            .check_metadata(CancellationToken::new())
            .await
    });
    let request = fixture.worker_message().await;
    assert!(matches!(request, WorkerMessage::CheckMetadata { .. }));
    fixture.parent.handle(request).unwrap();
    let reply = fixture.parent_message().await;
    fixture.worker.handle(reply).unwrap();
    checking.await.unwrap().unwrap();
    assert_eq!(authority.metadata_checks.load(Ordering::SeqCst), 1);
    assert!(
        authority.origins.lock().unwrap().is_empty(),
        "metadata admission must not fabricate a clipboard origin"
    );
}

#[tokio::test]
async fn early_uncertainty_keeps_bridge_pending_until_the_same_actual_terminal_unknown_result() {
    let mut fixture = Fixture::new();
    let host = Arc::new(Host::default());
    let services = fixture
        .prepare(Arc::new(Authority::default()), host.clone())
        .await;
    let calls = Arc::new(AtomicUsize::new(0));
    let effect_calls = calls.clone();
    let (finish, finished) = oneshot::channel::<Result<(), ToolError>>();
    services
        .effects
        .unwrap()
        .spawn_guarded(
            Box::pin(async move {
                effect_calls.fetch_add(1, Ordering::SeqCst);
                finished.await.unwrap()
            }),
            Box::new(|_| panic!("admitted effect cannot become an unpolled refusal")),
        )
        .unwrap();
    let request = fixture.worker_message().await;
    let (token, id) = match &request {
        WorkerMessage::Effect { token, id } => (token.clone(), *id),
        _ => panic!("expected effect request"),
    };
    fixture.parent.handle(request).unwrap();
    let mut admitted = host.admitted.lock().unwrap().pop().unwrap();
    assert!(poll!(admitted.pending.as_mut()).is_pending());
    let admission = fixture.parent_message().await;
    fixture.worker.handle(admission).unwrap();
    tokio::task::yield_now().await;
    fixture
        .parent
        .handle(WorkerMessage::EffectUncertain {
            token,
            id,
            error: Failure::CleanupUnconfirmed("actual early observer loss".into()),
        })
        .unwrap();
    assert!(matches!(
        poll!(admitted.uncertainty.as_mut()),
        Poll::Ready(ToolError::CleanupUnconfirmed(_))
    ));
    assert!(
        poll!(admitted.pending.as_mut()).is_pending(),
        "early notification cannot fabricate terminal completion"
    );
    finish
        .send(Err(ToolError::OutcomeUnknown(
            "same request terminal outcome unknown".into(),
        )))
        .unwrap();
    let actual = fixture.worker_message().await;
    assert!(matches!(
        &actual,
        WorkerMessage::EffectFinished {
            result: Err(Failure::OutcomeUnknown(_)),
            ..
        }
    ));
    fixture.parent.handle(actual).unwrap();
    assert!(matches!(
        poll!(admitted.pending.as_mut()),
        Poll::Ready(Err(ToolError::OutcomeUnknown(_)))
    ));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the original effect was not replaced or replayed"
    );
}

#[tokio::test]
async fn early_effect_loss_remains_observable_when_actual_success_arrives_before_host_poll() {
    let mut fixture = Fixture::new();
    let host = Arc::new(Host::default());
    let services = fixture
        .prepare(Arc::new(Authority::default()), host.clone())
        .await;
    let (finish, finished) = oneshot::channel::<()>();
    services
        .effects
        .unwrap()
        .spawn_guarded(
            Box::pin(async move {
                finished.await.unwrap();
                Ok(())
            }),
            Box::new(|_| panic!("actual accepted effect must not be refused")),
        )
        .unwrap();
    let request = fixture.worker_message().await;
    let (token, id) = match &request {
        WorkerMessage::Effect { token, id } => (token.clone(), *id),
        _ => panic!("expected actual effect request"),
    };
    fixture.parent.handle(request).unwrap();
    let mut admitted = host.admitted.lock().unwrap().pop().unwrap();
    assert!(poll!(admitted.pending.as_mut()).is_pending());
    let admission = fixture.parent_message().await;
    fixture.worker.handle(admission).unwrap();
    fixture
        .parent
        .handle(WorkerMessage::EffectUncertain {
            token,
            id,
            error: Failure::CleanupUnconfirmed("early physical observer loss".into()),
        })
        .unwrap();
    finish.send(()).unwrap();
    let terminal = fixture.worker_message().await;
    assert!(matches!(
        &terminal,
        WorkerMessage::EffectFinished { result: Ok(()), .. }
    ));
    fixture.parent.handle(terminal).unwrap();
    // Both real messages have arrived before either observer is polled.
    assert!(matches!(poll!(admitted.uncertainty.as_mut()),
        Poll::Ready(ToolError::CleanupUnconfirmed(message)) if message.contains("early physical observer loss")));
    assert!(matches!(
        poll!(admitted.pending.as_mut()),
        Poll::Ready(Ok(()))
    ));
    assert!(
        !fixture.parent.has_unsettled(),
        "actual terminal mapping is distinct from sticky failure observation"
    );
}

#[tokio::test]
async fn history_preparation_routes_only_to_its_independent_host_consent() {
    struct HistoryAuthority(Arc<Mutex<Vec<&'static str>>>);
    impl BrowserAuthorization for HistoryAuthority {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            panic!("history must not use page authorization");
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            Box::pin(async { Err(failed("history fixture does not authorize page access")) })
        }
        fn authorize_session_preparation(
            &self,
            _: crate::BrowserSessionPreparation,
            _: CancellationToken,
        ) -> AuthorizationFuture {
            self.0.lock().unwrap().push("generic preparation");
            Box::pin(async { Ok(()) })
        }
        fn authorize_history(
            &self,
            _: crate::BrowserSessionPreparation,
            _: CancellationToken,
        ) -> AuthorizationFuture {
            self.0.lock().unwrap().push("history approval");
            Box::pin(async { Err(failed("fixture history requires its own grant")) })
        }
        fn check_history(
            &self,
            _: crate::BrowserSessionPreparation,
            _: CancellationToken,
        ) -> AuthorizationFuture {
            self.0.lock().unwrap().push("history check");
            Box::pin(async { Err(failed("fixture history grant was revoked")) })
        }
    }
    let calls = Arc::new(Mutex::new(Vec::new()));
    let capabilities = ParentCapabilities {
        authorization: Some(Arc::new(HistoryAuthority(calls.clone()))),
        ..Default::default()
    };
    let identity = identity();
    let request = crate::BrowserSessionPreparation {
        native_owner: uuid::Uuid::from_u128(17),
        native_epoch: "actual-native-epoch-fixture".into(),
        browser_id: "selected-browser".into(),
        generation: "selected-generation".into(),
        turn_id: identity.turn.clone(),
        operation_id: identity.operation_id.clone(),
        target: crate::BrowserPreparationTarget::SessionHistory,
    };
    for (mode, message) in [
        (
            AuthorizationMode::Authorize,
            "fixture history requires its own grant",
        ),
        (
            AuthorizationMode::Check,
            "fixture history grant was revoked",
        ),
    ] {
        let result = capabilities
            .session_preparation_decision(
                Some(&identity),
                identity.clone(),
                request.clone(),
                mode,
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(ToolError::Failed(reason)) if reason == message));
    }
    assert_eq!(
        *calls.lock().unwrap(),
        ["history approval", "history check"]
    );
    let mut foreign = identity.clone();
    foreign.operation_id = "other-operation".into();
    assert!(
        capabilities
            .session_preparation_decision(
                Some(&identity),
                foreign,
                request,
                AuthorizationMode::Authorize,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        calls.lock().unwrap().len(),
        2,
        "foreign scope never reaches any Host authority"
    );
}
