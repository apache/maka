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

use futures_util::FutureExt;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::Ticket;
use maka_computer_use::{
    BrowserHostEffects, HostEffectFuture, OperationSettlement, SettlementFuture,
};
use maka_event_log::root_store::InvocationEffectLease;
use maka_js_runtime::repl::ReplAdmission;
use std::panic::AssertUnwindSafe;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

/// The VM producer's admission handshake. Actual effect completion and
/// authority remain in the original journal and invocation execution lease.
#[derive(Default)]
pub(super) struct Gate {
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    sealed: bool,
    pending: usize,
    failure: Option<ToolError>,
}

#[derive(Clone)]
pub(super) struct Receipt(Arc<Pending>);

struct Pending {
    gate: Arc<Gate>,
    acknowledged: AtomicBool,
}

impl Gate {
    pub fn check_open(&self) -> Result<(), ToolError> {
        let state = self.state.lock().unwrap();
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        if state.sealed {
            return Err(ToolError::Failed("Computer VM has retired".into()));
        }
        Ok(())
    }

    pub fn register(self: &Arc<Self>) -> Result<Receipt, ToolError> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        if state.sealed {
            return Err(ToolError::Failed("Computer VM has retired".into()));
        }
        state.pending = state.pending.checked_add(1).ok_or_else(|| {
            ToolError::CleanupUnconfirmed("Computer admission count overflow".into())
        })?;
        Ok(Receipt(Arc::new(Pending {
            gate: self.clone(),
            acknowledged: AtomicBool::new(false),
        })))
    }

    pub async fn seal(&self) -> Result<(), ToolError> {
        self.close_admission();
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let mut state = self.state.lock().unwrap();
                state.sealed = true;
                if state.pending == 0 {
                    return state.failure.clone().map_or(Ok(()), Err);
                }
            }
            changed.await;
        }
    }

    pub fn close_admission(&self) {
        self.state.lock().unwrap().sealed = true;
    }

    fn resolve(&self, failure: Option<ToolError>) {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = failure {
            state.failure.get_or_insert(error);
        }
        state.pending = state.pending.checked_sub(1).expect("registered admission");
        drop(state);
        self.changed.notify_waiters();
    }
}

impl ReplAdmission for Gate {
    fn seal(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ToolError>> + Send + '_>>
    {
        Box::pin(Gate::seal(self))
    }
}

impl Receipt {
    /// The original Agent journal committed T1; its Run ticket still owns work.
    pub fn agent_dispatched(&self) {
        self.acknowledge();
    }

    /// The complete call returned, including a refusal which cannot dispatch later.
    pub fn complete_call(&self) {
        self.acknowledge();
    }

    /// An attached Host service transferred its unpolled effect to an existing
    /// resource ticket and worker. This is not an Agent ToolDispatched fact.
    fn host_transferred(&self) {
        self.acknowledge();
    }

    fn acknowledge(&self) {
        if !self.0.acknowledged.swap(true, Ordering::AcqRel) {
            self.0.gate.resolve(None);
        }
    }

    pub fn fail(&self, error: ToolError) {
        if !self.0.acknowledged.swap(true, Ordering::AcqRel) {
            self.0.gate.resolve(Some(error));
        }
    }
}

/// A native call can return a confirmed result before its exact RPC replies.
/// This slot carries only those owned futures, never another grant or Run.
struct Settlement {
    pending: Mutex<Option<Vec<SettlementFuture>>>,
}
impl OperationSettlement for Settlement {
    fn retain(&self, pending: SettlementFuture) -> Result<(), (ToolError, SettlementFuture)> {
        let mut slot = self.pending.lock().unwrap();
        match slot.as_mut() {
            Some(retained) => {
                retained.push(pending);
                Ok(())
            }
            None => Err((
                ToolError::Failed("Computer call settlement is closed".into()),
                pending,
            )),
        }
    }
}

/// Original effect custody while the journal is still committing its outcome.
/// Drop transfers the same RPCs to tracked cleanup rather than dropping them.
pub(super) struct Operation {
    settlement: Arc<Settlement>,
    lease: Option<InvocationEffectLease>,
    ticket: Option<Ticket>,
    tasks: tokio_util::task::TaskTracker,
    stopping: tokio_util::sync::CancellationToken,
}
impl Operation {
    pub fn new(
        owner: &Arc<super::Computer>,
        lease: InvocationEffectLease,
    ) -> Result<Self, ToolError> {
        let mut ticket = match owner.resources.reserve() {
            Ok(ticket) => ticket,
            Err(error) => {
                // The native call has not reached journal admission.
                lease.finish(Ok(()));
                return Err(error);
            }
        };
        ticket.start();
        Ok(Self {
            settlement: Arc::new(Settlement {
                pending: Mutex::new(Some(Vec::new())),
            }),
            lease: Some(lease),
            ticket: Some(ticket),
            tasks: owner.tasks.clone(),
            stopping: owner.stopping.clone(),
        })
    }

    pub fn handoff(&self) -> Arc<dyn OperationSettlement> {
        self.settlement.clone()
    }

    pub fn complete(mut self, journal_failure: Option<String>) {
        self.transfer(journal_failure);
    }

    fn transfer(&mut self, journal_failure: Option<String>) {
        let Some(lease) = self.lease.take() else {
            return;
        };
        let pending = self
            .settlement
            .pending
            .lock()
            .unwrap()
            .take()
            .expect("original settlement owner");
        let mut custody = PendingSettlement {
            pending: Some(pending),
            lease: Some(lease),
            ticket: self.ticket.take(),
            stopping: self.stopping.clone(),
            failure: None,
        };
        if let Some(failure) = journal_failure {
            custody.fail(failure);
        }
        if custody.pending.as_ref().unwrap().is_empty() {
            custody.finish();
        } else {
            self.tasks.spawn(custody.run());
        }
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if self.lease.is_some() {
            self.transfer(Some(
                "Computer journal owner disappeared before settlement".into(),
            ));
        }
    }
}

struct PendingSettlement {
    pending: Option<Vec<SettlementFuture>>,
    lease: Option<InvocationEffectLease>,
    ticket: Option<Ticket>,
    stopping: tokio_util::sync::CancellationToken,
    failure: Option<String>,
}
impl PendingSettlement {
    fn fail(&mut self, failure: String) {
        self.stopping.cancel();
        if let Some(lease) = self.lease.take() {
            lease.retain_unconfirmed(failure.clone());
        }
        self.failure.get_or_insert(failure);
    }

    fn finish(&mut self) {
        // Every retained future has become Ready. A late RPC rejection was
        // already mapped to () by the backend after proving exact Closed.
        self.pending.take();
        if let Some(lease) = self.lease.take() {
            lease.finish(Ok(()));
        }
        if let Some(ticket) = self.ticket.take() {
            ticket.complete(self.failure.take().map_or(Ok(()), Err));
        }
    }

    async fn run(mut self) {
        let result = {
            // Keep the opaque boxes outside catch_unwind. An unwinding poll
            // must not drop a Cua PendingCall and close its original socket.
            let pending = self.pending.as_mut().expect("owned settlement futures");
            AssertUnwindSafe(async {
                for future in pending {
                    future.as_mut().await;
                }
            })
            .catch_unwind()
            .await
        };
        if result.is_ok() {
            self.finish();
        } else {
            self.fail("Computer RPC settlement worker panicked".into());
            // Drop retains the original opaque futures with failed custody.
        }
    }
}
impl Drop for PendingSettlement {
    fn drop(&mut self) {
        if self.pending.is_some() {
            self.fail("Computer RPC settlement owner disappeared".into());
            if let Some(ticket) = self.ticket.take() {
                ticket.unconfirmed(self.failure.take().unwrap(), self.pending.take().unwrap());
            }
        }
    }
}

struct HostEffects {
    owner: std::sync::Weak<super::Computer>,
    gate: Arc<Gate>,
}
pub(super) fn host_effects(
    owner: &Arc<super::Computer>,
    gate: Arc<Gate>,
) -> Arc<dyn BrowserHostEffects> {
    Arc::new(HostEffects {
        owner: Arc::downgrade(owner),
        gate,
    })
}
impl BrowserHostEffects for HostEffects {
    fn spawn(&self, unpolled: HostEffectFuture) -> Result<(), ToolError> {
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| ToolError::Failed("Computer Host service is closed".into()))?;
        if owner.stopping.is_cancelled() {
            return Err(ToolError::Failed("Computer Host service is closed".into()));
        }
        let receipt = self.gate.register()?;
        let mut ticket = match owner.resources.reserve() {
            Ok(ticket) => ticket,
            Err(error) => {
                receipt.complete_call();
                return Err(error);
            }
        };
        ticket.start();
        let custody = HostCustody {
            pending: Some(unpolled),
            ticket: Some(ticket),
            stopping: owner.stopping.clone(),
            root: Some(owner.store.clone()),
        };
        owner.tasks.spawn(custody.run());
        receipt.host_transferred();
        Ok(())
    }
}
struct HostCustody {
    pending: Option<HostEffectFuture>,
    ticket: Option<Ticket>,
    stopping: tokio_util::sync::CancellationToken,
    root: Option<Arc<maka_event_log::RootStore>>,
}
impl HostCustody {
    async fn run(mut self) {
        let result = AssertUnwindSafe(self.pending.as_mut().unwrap().as_mut())
            .catch_unwind()
            .await;
        match result {
            Ok(result) => {
                self.pending.take();
                let failure = match result {
                    Err(
                        error @ (ToolError::Persistence(_)
                        | ToolError::CleanupUnconfirmed(_)
                        | ToolError::OperationCleanupUnconfirmed { .. }),
                    ) => {
                        self.stopping.cancel();
                        Some(error.to_string())
                    }
                    _ => None, // A rejected, Ready RPC has settled its custody.
                };
                self.ticket
                    .take()
                    .unwrap()
                    .complete(failure.map_or(Ok(()), Err));
            }
            Err(_) => { /* Drop retains the original future. */ }
        }
    }
}
impl Drop for HostCustody {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.take() {
            self.stopping.cancel();
            if let Some(ticket) = self.ticket.take() {
                ticket.unconfirmed(
                    "Computer Host-service effect owner disappeared".into(),
                    (pending, self.root.take()),
                );
            }
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.acknowledged.load(Ordering::Acquire) {
            self.gate.resolve(Some(ToolError::CleanupUnconfirmed(
                "Computer admission owner disappeared before dispatch was confirmed".into(),
            )));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    use maka_agent_facts::{
        event::{
            CommitError, CommitFuture, EventSink, EventWrite, Fact, Invocation, InvocationInput,
            RuntimeEvent, ToolOutcome,
        },
        tool_call::ToolCallIdentity,
        tools::{PreparedEffect, ToolJournal},
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use tokio_util::sync::CancellationToken;

    struct Fixture {
        directory: tempfile::TempDir,
        owner: Arc<super::super::Computer>,
        store: Arc<maka_event_log::SessionStore>,
        invocation: Invocation,
        parent: maka_event_log::root_store::SessionExecutionLease,
        effects: maka_event_log::root_store::InvocationEffects,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root_owner = maka_event_log::root::RootOwner::create(
                &directory.path().join("root"),
                &maka_event_log::root::RootNamespaces {
                    ownership: directory.path().join("ownership"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap();
            let root = Arc::new(
                maka_event_log::RootStore::open(Arc::new(root_owner))
                    .await
                    .unwrap(),
            );
            let session = root
                .create_session("session", "fixture", &json!({}), 1)
                .await
                .unwrap();
            let prepared = session.execution_scope(None).await.unwrap();
            let store = Arc::new(prepared.store());
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            };
            let (parent, effects) = prepared
                .accept_invocation(invocation.clone(), CancellationToken::new())
                .unwrap();
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Code {
                                source: "fixture".into(),
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            let tasks = tokio_util::task::TaskTracker::new();
            let owner = Arc::new(super::super::Computer {
                store: root,
                configuration: Default::default(),
                sessions: super::super::sessions::Sessions::with_audio(false, tasks.clone()),
                resources: Arc::default(),
                stopping: CancellationToken::new(),
                tasks,
                origin: maka_agent_facts::tool_call::ToolOrigin::HostSdk {
                    package_id: "fixture".into(),
                    entry_id: "fixture".into(),
                    activation: "fixture".into(),
                    parent: None,
                },
            });
            Self {
                directory,
                owner,
                store,
                invocation,
                parent,
                effects,
            }
        }
        fn lease(&self) -> InvocationEffectLease {
            self.owner
                .store
                .fork_invocation_effect(
                    self.store.clone().execution_custody().unwrap().as_ref(),
                    &self.invocation,
                )
                .unwrap()
        }
        async fn facts(&self) -> Vec<Fact> {
            let through = self
                .store
                .observe_session::<serde_json::Value>("session")
                .await
                .unwrap()
                .unwrap()
                .through_sequence;
            self.store
                .session_events("session", 0, through, 32, 1024 * 1024)
                .await
                .unwrap()
                .events
                .into_iter()
                .map(|stored| stored.event.fact.clone())
                .collect()
        }
        async fn close(self, unconfirmed: bool) {
            self.owner.tasks.close();
            self.owner.tasks.wait().await;
            self.owner.sessions.close().await.unwrap();
            if unconfirmed {
                self.parent.retain_unconfirmed();
            } else {
                self.parent.finish();
            }
            assert_eq!(self.owner.store.shutdown().await.is_err(), unconfirmed);
            if unconfirmed {
                let _ = self.directory.keep();
            }
        }
    }

    struct FailOutcome(Arc<maka_event_log::SessionStore>);
    impl EventSink for FailOutcome {
        fn commit(self: Arc<Self>, write: EventWrite) -> CommitFuture {
            Box::pin(async move {
                if matches!(&write.event().fact, Fact::ToolSettled { .. }) {
                    Err(CommitError::OutcomeUnknown(
                        "fixture T2 commit was not observed".into(),
                    ))
                } else {
                    self.0.clone().commit(write).await
                }
            })
        }
    }
    struct DropWitness(Arc<AtomicBool>);
    impl Drop for DropWitness {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn durable_closed_result_retains_same_run_until_original_rpc_is_ready() {
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease()).unwrap();
        let handoff = operation.handoff();
        let release = CancellationToken::new();
        let _release_on_failure = release.clone().drop_guard();
        let started = CancellationToken::new();
        let sent = Arc::new(AtomicUsize::new(0));
        let effect_sent = sent.clone();
        let pending_release = release.clone();
        let pending_started = started.clone();
        let pending = Box::pin(async move {
            pending_started.cancel();
            pending_release.cancelled().await;
            // This is the same RPC's late rejection after exact Closed. Its
            // Ready state settles transport custody without reversing Closed.
            let _late_reply: Result<(), ToolError> =
                Err(ToolError::Failed("late RPC rejection".into()));
        });
        let result = ToolJournal::new(fixture.store.clone(), fixture.invocation.clone())
            .invoke_prepared_output(
                "dialog".into(),
                ToolCallIdentity::standalone("call".into()),
                "fixture_dialog".into(),
                json!({}),
                CancellationToken::new(),
                PreparedEffect::new(move |_| {
                    Box::pin(async move {
                        effect_sent.fetch_add(1, AtomicOrdering::SeqCst);
                        if let Err((error, pending)) = handoff.retain(pending) {
                            pending.await;
                            return Err(error);
                        }
                        Ok(json!({"closed":true}).into())
                    })
                }),
            )
            .await
            .unwrap();
        assert_eq!(result.into_json(), json!({"closed":true}));
        operation.complete(None);
        started.cancelled().await;
        let facts = fixture.facts().await;
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::ToolDispatched { .. }))
                .count(),
            1
        );
        assert!(facts.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        )));
        let mut run = Box::pin(fixture.effects.settle());
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(poll!(&mut run).is_pending());
        assert!(poll!(&mut resources).is_pending());
        release.cancel();
        run.await.unwrap();
        resources.await.unwrap();
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 1);
        fixture.close(false).await;
    }

    #[tokio::test]
    async fn journal_failure_or_lost_owner_keeps_same_rpc_and_quarantines_original_authority() {
        for lost_owner in [false, true] {
            let fixture = Fixture::new().await;
            let operation = Operation::new(&fixture.owner, fixture.lease()).unwrap();
            let handoff = operation.handoff();
            let release = CancellationToken::new();
            let _release_on_failure = release.clone().drop_guard();
            let dropped = Arc::new(AtomicBool::new(false));
            let witness = DropWitness(dropped.clone());
            let pending_release = release.clone();
            let pending = Box::pin(async move {
                let _witness = witness;
                pending_release.cancelled().await;
            });
            let sink: Arc<dyn EventSink> = if lost_owner {
                fixture.store.clone()
            } else {
                Arc::new(FailOutcome(fixture.store.clone()))
            };
            let result = ToolJournal::new(sink, fixture.invocation.clone())
                .invoke_prepared_output(
                    "dialog".into(),
                    ToolCallIdentity::standalone("call".into()),
                    "fixture_dialog".into(),
                    json!({}),
                    CancellationToken::new(),
                    PreparedEffect::new(move |_| {
                        Box::pin(async move {
                            if let Err((error, pending)) = handoff.retain(pending) {
                                pending.await;
                                return Err(error);
                            }
                            Ok(json!({"closed":true}).into())
                        })
                    }),
                )
                .await;
            if lost_owner {
                assert!(result.is_ok());
                drop(operation);
            } else {
                assert!(matches!(result, Err(ToolError::Persistence(_))));
                operation.complete(Some("fixture T2 commit was not observed".into()));
            }
            assert!(fixture.owner.stopping.is_cancelled());
            assert!(!dropped.load(Ordering::SeqCst));
            let mut resources = Box::pin(fixture.owner.resources.settle());
            assert!(poll!(&mut resources).is_pending());
            release.cancel();
            assert!(resources.await.is_err());
            assert!(fixture.effects.settle().await.is_err());
            assert!(dropped.load(Ordering::SeqCst));
            fixture.close(true).await;
        }
    }

    #[tokio::test]
    async fn lost_physical_worker_retains_rpc_without_a_computer_resource_cycle() {
        let fixture = Fixture::new().await;
        let mut ticket = fixture.owner.resources.reserve().unwrap();
        ticket.start();
        let dropped = Arc::new(AtomicBool::new(false));
        let witness = DropWitness(dropped.clone());
        let custody = PendingSettlement {
            pending: Some(vec![Box::pin(async move {
                let _witness = witness;
                std::future::pending::<()>().await;
            })]),
            lease: Some(fixture.lease()),
            ticket: Some(ticket),
            stopping: fixture.owner.stopping.clone(),
            failure: None,
        };
        drop(custody);
        assert!(!dropped.load(Ordering::SeqCst));
        assert!(fixture.owner.resources.settle().await.is_err());
        assert!(fixture.effects.settle().await.is_err());
        let resources = fixture.owner.resources.clone();
        fixture.close(true).await;
        assert!(!dropped.load(Ordering::SeqCst));
        drop(resources);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn automatic_host_effect_transfers_resource_custody_without_agent_dispatch() {
        let fixture = Fixture::new().await;
        let gate = Arc::new(Gate::default());
        let host = host_effects(&fixture.owner, gate.clone());
        let release = CancellationToken::new();
        let _release_on_failure = release.clone().drop_guard();
        let started = CancellationToken::new();
        let sent = Arc::new(AtomicUsize::new(0));
        let effect_sent = sent.clone();
        let effect_started = started.clone();
        let pending_release = release.clone();
        host.spawn(Box::pin(async move {
            effect_sent.fetch_add(1, AtomicOrdering::SeqCst);
            effect_started.cancel();
            pending_release.cancelled().await;
            Ok(())
        }))
        .unwrap();
        assert!(!fixture.owner.resources.is_idle());
        gate.seal().await.unwrap(); // Resource transfer, not RPC completion.
        started.cancelled().await;
        fixture.effects.settle().await.unwrap(); // No fake Run effect ticket.
        let rejected_sent = sent.clone();
        assert!(
            host.spawn(Box::pin(async move {
                rejected_sent.fetch_add(1, AtomicOrdering::SeqCst);
                Ok(())
            }))
            .is_err()
        );
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 1);
        assert!(
            !fixture
                .facts()
                .await
                .iter()
                .any(|fact| matches!(fact, Fact::ToolDispatched { .. }))
        );
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(poll!(&mut resources).is_pending());
        release.cancel();
        resources.await.unwrap();
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 1);
        fixture.close(false).await;
    }

    #[tokio::test]
    async fn late_handoff_returns_the_exact_unpolled_future_for_synchronous_draining() {
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease()).unwrap();
        let handoff = operation.handoff();
        operation.complete(None);
        let sent = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let pending_sent = sent.clone();
        let witness = DropWitness(dropped.clone());
        let result = handoff.retain(Box::pin(async move {
            let _witness = witness;
            pending_sent.fetch_add(1, AtomicOrdering::SeqCst);
        }));
        let (error, pending) = match result {
            Err(returned) => returned,
            Ok(()) => panic!("completed call cannot accept new RPC custody"),
        };
        assert!(matches!(error, ToolError::Failed(_)));
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 0);
        assert!(!dropped.load(Ordering::SeqCst));
        pending.await;
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 1);
        assert!(dropped.load(Ordering::SeqCst));
        fixture.effects.settle().await.unwrap();
        fixture.owner.resources.settle().await.unwrap();
        fixture.close(false).await;
    }

    #[tokio::test]
    async fn panicking_rpc_poll_preserves_its_box_and_the_committed_closed_result() {
        struct Panicking {
            polled: CancellationToken,
            _witness: DropWitness,
        }
        impl std::future::Future for Panicking {
            type Output = ();
            fn poll(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<()> {
                self.polled.cancel();
                panic!("fixture RPC poll panicked");
            }
        }
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease()).unwrap();
        let handoff = operation.handoff();
        let polled = CancellationToken::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let pending = Box::pin(Panicking {
            polled: polled.clone(),
            _witness: DropWitness(dropped.clone()),
        });
        ToolJournal::new(fixture.store.clone(), fixture.invocation.clone())
            .invoke_prepared_output(
                "dialog".into(),
                ToolCallIdentity::standalone("call".into()),
                "fixture_dialog".into(),
                json!({}),
                CancellationToken::new(),
                PreparedEffect::new(move |_| {
                    Box::pin(async move {
                        if let Err((error, pending)) = handoff.retain(pending) {
                            pending.await;
                            return Err(error);
                        }
                        Ok(json!({"closed":true}).into())
                    })
                }),
            )
            .await
            .unwrap();
        operation.complete(None);
        polled.cancelled().await;
        assert!(fixture.owner.resources.settle().await.is_err());
        assert!(fixture.effects.settle().await.is_err());
        assert!(!dropped.load(Ordering::SeqCst));
        assert!(fixture.facts().await.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        )));
        let resources = fixture.owner.resources.clone();
        fixture.close(true).await;
        assert!(!dropped.load(Ordering::SeqCst));
        drop(resources);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn sealed_vm_waits_for_original_admission_and_refuses_new_calls() {
        let gate = Arc::new(Gate::default());
        let first = gate.register().unwrap();
        let second = gate.register().unwrap();
        let second_observer = second.clone();
        let mut sealing = Box::pin(gate.seal());
        assert!(poll!(&mut sealing).is_pending());
        assert!(gate.register().is_err());
        first.acknowledge();
        drop(first);
        assert!(poll!(&mut sealing).is_pending());
        second_observer.acknowledge();
        second.acknowledge();
        drop(second);
        assert!(sealing.await.is_ok());
        drop(second_observer);
    }

    #[tokio::test]
    async fn lost_admission_reports_failure_after_other_preparations_settle() {
        let gate = Arc::new(Gate::default());
        let lost = gate.register().unwrap();
        let live = gate.register().unwrap();
        let mut sealing = Box::pin(gate.seal());
        assert!(poll!(&mut sealing).is_pending());
        drop(lost);
        assert!(poll!(&mut sealing).is_pending());
        live.acknowledge();
        assert!(matches!(
            sealing.await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
    }

    #[tokio::test]
    async fn unresolved_commit_failure_cannot_be_acknowledged_by_another_observer() {
        let gate = Arc::new(Gate::default());
        let receipt = gate.register().unwrap();
        let other = receipt.clone();
        receipt.fail(ToolError::Persistence("inner T1 commit uncertain".into()));
        other.acknowledge();
        assert!(matches!(gate.seal().await, Err(ToolError::Persistence(_))));
    }
}
