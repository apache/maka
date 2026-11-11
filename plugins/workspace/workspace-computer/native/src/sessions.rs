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
use maka_agent_facts::{
    durable::{ExecutionIdentity, RunId},
    language::Language,
};
use maka_js_runtime::repl::Repl;
use maka_sandbox::workspace::PermissionBasis;
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct Sessions {
    entries: Mutex<BTreeMap<String, Arc<Interaction>>>,
    pub input: Arc<tokio::sync::Mutex<()>>,
    pub driver: Arc<tokio::sync::Mutex<maka_computer_use::Driver>>,
    effects_changed: Arc<tokio::sync::Notify>,
    tasks: tokio_util::task::TaskTracker,
}
pub(super) struct Interaction {
    pub kernel: tokio::sync::Mutex<Option<Kernel>>,
    native_owner: maka_computer_use::SessionOwner,
    epochs: Mutex<Vec<Arc<Epoch>>>,
    pub retiring: CancellationToken,
    turns: Arc<Mutex<BTreeMap<RunId, Arc<TurnCleanup>>>>,
    effects_changed: Arc<tokio::sync::Notify>,
    closed: Mutex<Option<Retirement>>,
    tasks: tokio_util::task::TaskTracker,
}
pub(super) struct Kernel {
    pub repl: Option<Repl>,
    pub epoch: Arc<Epoch>,
    pub admission: Arc<super::admission::Gate>,
}
pub(super) type Retirement =
    futures_util::future::Shared<BoxFuture<'static, Result<(), ToolError>>>;

pub(super) struct TurnCleanup {
    floor: maka_sandbox::Sandbox,
    authority: Arc<dyn maka_agent_authority::computer::ComputerAccess>,
    source_lease: Mutex<Option<maka_event_log::root_store::SessionWorkLease>>,
    source_writer: maka_event_log::root_store::DataWriter,
    native_observed: Mutex<Option<maka_computer_use::NativeInterruption>>,
    // The original canonical writer ACK; not physical input-release proof.
    native_interruption: Mutex<Option<Retirement>>,
    pending: Mutex<Option<Retirement>>,
    // Actual input-release/child-wait proof, not success of the interrupted action.
    native_drained: Mutex<Option<maka_computer_use::NativeInterruptionDrain>>,
}

impl TurnCleanup {
    pub(super) fn check_native_monitor_admission(&self) -> Result<(), ToolError> {
        access::resource_boundary(&self.floor)?;
        if self.native_observed.lock().unwrap().is_some() {
            return Err(failed(
                "Native input was physically interrupted in this turn",
            ));
        }
        if self
            .pending
            .lock()
            .expect("Computer turn cleanup lock poisoned")
            .is_some()
        {
            return Err(failed("Native monitor turn is closing"));
        }
        Ok(())
    }

    fn start(
        &self,
        tasks: &tokio_util::task::TaskTracker,
        work: impl std::future::Future<Output = Result<(), ToolError>> + Send + 'static,
    ) -> Retirement {
        let mut pending = self.pending.lock().unwrap();
        if let Some(pending) = pending
            .as_ref()
            .filter(|pending| !matches!(pending.peek(), Some(Err(_))))
        {
            return pending.clone();
        }
        let (completed, result) = tokio::sync::oneshot::channel();
        tasks.spawn(async move {
            let result = AssertUnwindSafe(work)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(ToolError::CleanupUnconfirmed(
                        "Computer turn cleanup worker panicked".into(),
                    ))
                });
            let _ = completed.send(result);
        });
        let result = async move {
            result.await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!(
                    "Computer turn cleanup worker disappeared: {error}"
                ))
            })?
        }
        .boxed()
        .shared();
        *pending = Some(result.clone());
        result
    }
}

/// The observer may outlive its initiating evaluation/JS epoch. It retains the
/// original call capability and cannot retarget an observation to another Run.
pub(super) struct NativeInterruptionObserver {
    owner: std::sync::Weak<Computer>,
    cleanup: Arc<TurnCleanup>,
    authority: Arc<dyn maka_agent_authority::computer::ComputerAccess>,
    original: maka_plugin_core::operation::RecoveryRef,
    sink: Arc<Mutex<Option<maka_agent_authority::computer::NativeInterruptionSink>>>,
    invocation: ExecutionIdentity,
    epoch: String,
    operation: String,
}

pub(super) fn native_interruption_observer(
    owner: &Arc<Computer>,
    entry: &Interaction,
    call: &Call,
    epoch: &Epoch,
    operation: &str,
) -> Result<Arc<NativeInterruptionObserver>, ToolError> {
    let invocation = &call.authority.call().execution;
    let original = call
        .operation
        .clone()
        .ok_or_else(|| failed("Native producer requires its original Host mutation"))?;
    let cleanup = entry
        .turns
        .lock()
        .unwrap()
        .get(&invocation.run_id)
        .cloned()
        .ok_or_else(|| failed("Native interruption source Run is unavailable"))?;
    if cleanup.authority.call().execution != *invocation {
        return Err(failed("Native interruption source execution differs"));
    }
    Ok(Arc::new(NativeInterruptionObserver {
        owner: Arc::downgrade(owner),
        cleanup,
        authority: call.authority.clone(),
        original,
        sink: Arc::default(),
        invocation: invocation.clone(),
        epoch: epoch.id.clone(),
        operation: operation.to_owned(),
    }))
}
impl maka_computer_use::NativeInterruptionObserver for NativeInterruptionObserver {
    fn bound(
        &self,
        source: maka_computer_use::NativeBindingSource,
    ) -> maka_computer_use::InterruptionFuture {
        if source.session() != self.invocation.session_id
            || source.turn() != self.invocation.turn_id
            || source.execution_correlation().as_str() != self.invocation.run_id.to_string()
            || source.native_epoch() != self.epoch
            || source.operation_id() != self.operation
        {
            return Box::pin(async { Err(failed("Native producer binding mismatch")) });
        }
        let authority = self.authority.clone();
        let original = self.original.clone();
        let writer = self.cleanup.source_writer.clone();
        let slot = self.sink.clone();
        Box::pin(async move {
            let sink = authority.native_bound(&original, source, writer).await?;
            let mut retained = slot.lock().unwrap();
            if retained.is_some() {
                return Err(failed(
                    "Native producer already has its original bound writer",
                ));
            }
            *retained = Some(sink);
            Ok(())
        })
    }
    fn interrupted(
        &self,
        observed: maka_computer_use::NativeInterruption,
    ) -> maka_computer_use::InterruptionFuture {
        // Only the lower bound native-event producer can construct this sealed
        // value. An exit code, transport diagnostic or arbitrary JSON cannot.
        if observed.session() != self.invocation.session_id
            || observed.turn() != self.invocation.turn_id
            || observed.execution_correlation().as_str() != self.invocation.run_id.to_string()
            || observed.native_epoch() != self.epoch
            || observed.operation_id() != self.operation
        {
            return Box::pin(async {
                Err(failed("Native interruption producer binding mismatch"))
            });
        }
        let Some(owner) = self.owner.upgrade() else {
            return Box::pin(async { Err(failed("Native interruption Host is closed")) });
        };
        let Some(sink) = self.sink.lock().unwrap().clone() else {
            return Box::pin(async {
                Err(failed("Native interruption has no original bound writer"))
            });
        };
        let mut retained = self.cleanup.native_observed.lock().unwrap();
        if let Some(original) = retained.as_ref() {
            if original.generation() != observed.generation()
                || original.native_epoch() != observed.native_epoch()
            {
                return Box::pin(async {
                    Err(ToolError::CleanupUnconfirmed(
                        "Native interruption differs from its original resource receipt".into(),
                    ))
                });
            }
        } else {
            *retained = Some(observed.clone());
        }
        drop(retained);
        owner.sessions.effects_changed.notify_one();
        let mut pending = self.cleanup.native_interruption.lock().unwrap();
        let original = pending
            .get_or_insert_with(|| {
                let future = sink(observed).shared();
                let drive = future.clone();
                owner.tasks.spawn(async move {
                    let _ = drive.await;
                });
                future
            })
            .clone();
        Box::pin(original)
    }

    fn drained(
        &self,
        observed: maka_computer_use::NativeInterruptionDrain,
    ) -> maka_computer_use::InterruptionFuture {
        // Source operation may be an earlier completed call that installed this
        // monitor. The affected operation is this actual interrupted request.
        if observed.session() != self.invocation.session_id
            || observed.turn() != self.invocation.turn_id
            || observed.execution_correlation().as_str() != self.invocation.run_id.to_string()
            || observed.native_epoch() != self.epoch
            || observed.affected_operation_id() != self.operation
        {
            return Box::pin(async { Err(failed("Native interruption drain binding mismatch")) });
        }
        let mut retained = self.cleanup.native_drained.lock().unwrap();
        if let Some(original) = retained.as_ref() {
            if original.generation() != observed.generation()
                || original.affected_operation_id() != observed.affected_operation_id()
            {
                return Box::pin(async {
                    Err(ToolError::CleanupUnconfirmed(
                        "Native Turn drain differs from its retained physical owner".into(),
                    ))
                });
            }
        } else {
            *retained = Some(observed);
        }
        Box::pin(async { Ok(()) })
    }
}

/// An action may remain Unknown after its exact native owner is fully drained.
/// This proof neither changes the action result nor authorizes another call.
impl NativeInterruptionObserver {
    pub(super) async fn check_native_admission(&self) -> Result<(), ToolError> {
        self.cleanup.check_native_monitor_admission()?;
        self.authority.native_admission().await
    }
    /// Read the same captured logical-Turn record, even if its completed
    /// watcher has since removed it from Interaction.turns. This is physical
    /// cleanup proof for one original operation, never new native authority.
    pub(super) async fn native_drain(
        &self,
    ) -> Result<Option<maka_computer_use::NativeInterruptionDrain>, ToolError> {
        let proof = self
            .cleanup
            .native_drained
            .lock()
            .unwrap()
            .as_ref()
            .filter(|observed| {
                observed.session() == self.invocation.session_id
                    && observed.turn() == self.invocation.turn_id
                    && observed.execution_correlation().as_str()
                        == self.invocation.run_id.to_string()
                    && observed.native_epoch() == self.epoch
                    && observed.affected_operation_id() == self.operation
            })
            .cloned();
        if let Some(proof) = &proof {
            let source = self.cleanup.native_observed.lock().unwrap();
            if !source.as_ref().is_some_and(|source| {
                source.generation() == proof.generation()
                    && source.native_epoch() == proof.native_epoch()
            }) {
                return Err(ToolError::CleanupUnconfirmed(
                    "Native drain has no matching original interruption receipt".into(),
                ));
            }
        }
        Ok(proof)
    }
}

/// Actual physical resources of one VM binding. The list of these owners
/// preserves custody and revocation coverage; it is not a permission cache.
pub(super) struct Epoch {
    pub files: Arc<super::browser_files::SessionFiles>,
    pub id: String,
    pub native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    audio: Mutex<Option<Arc<AudioReceipt>>>,
    browser_preparations: Mutex<Vec<Arc<BrowserPreparationReceipt>>>,
    pub(super) native_monitors: Mutex<Vec<Arc<super::native_monitor::Receipt>>>,
    turns: Arc<Mutex<BTreeMap<RunId, Arc<TurnCleanup>>>>,
    pub(super) effects_changed: Arc<tokio::sync::Notify>,
    retirement: Mutex<Option<Retirement>>,
    vm_joined: std::sync::atomic::AtomicBool,
}
struct BrowserPreparationReceipt {
    basis: PermissionBasis,
    turn: String,
    gate: Arc<super::admission::Gate>,
    cleanup: Arc<TurnCleanup>,
    observation: Mutex<Option<Retirement>>,
}

#[derive(Clone, Copy)]
enum PreparationAuthority {
    Current,
    TurnInactive,
    VmRetired,
    Revoked,
}

struct RetainedSessionAudio {
    native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    policy: Arc<dyn maka_agent_authority::computer::SessionAudioRetention>,
    floor: maka_sandbox::Sandbox,
    stopping: CancellationToken,
}
struct AudioReceipt {
    retained: RetainedSessionAudio,
    finished: Retirement,
}
impl Sessions {
    pub fn with_audio(audio_enabled: bool, tasks: tokio_util::task::TaskTracker) -> Self {
        Self {
            driver: Arc::new(tokio::sync::Mutex::new(
                maka_computer_use::Driver::with_audio(audio_enabled),
            )),
            tasks,
            ..Default::default()
        }
    }
    pub async fn state(&self, session: &str) -> ReplState {
        let interaction = self.entries.lock().unwrap().get(session).cloned();
        let Some(interaction) = interaction else {
            return ReplState::Fresh;
        };
        if interaction.retiring.is_cancelled() {
            return ReplState::ResetRequired;
        }
        let kernel = interaction.kernel.lock().await;
        let Some(kernel) = kernel.as_ref() else {
            return ReplState::Fresh;
        };
        if kernel.admission.check_open().is_err() {
            return ReplState::ResetRequired;
        }
        match kernel.repl.as_ref() {
            Some(repl) if !repl.is_closed() => ReplState::Ready,
            _ => ReplState::Fresh,
        }
    }
    pub fn get(&self, session: &str) -> Result<Arc<Interaction>, ToolError> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(existing) = entries.get(session) {
            return if existing.retiring.is_cancelled() {
                Err(failed("Computer Session is retiring"))
            } else {
                Ok(existing.clone())
            };
        }
        let interaction = Arc::new(Interaction {
            kernel: Default::default(),
            native_owner: maka_computer_use::SessionOwner::new(self.driver.clone()),
            epochs: Default::default(),
            retiring: CancellationToken::new(),
            turns: Default::default(),
            effects_changed: self.effects_changed.clone(),
            closed: Default::default(),
            tasks: self.tasks.clone(),
        });
        entries.insert(session.into(), interaction.clone());
        Ok(interaction)
    }
    async fn retire(&self, id: &str, interaction: &Arc<Interaction>) -> Result<(), ToolError> {
        interaction.retiring.cancel();
        interaction.close().await?;
        let mut entries = self.entries.lock().unwrap();
        if entries
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, interaction))
        {
            entries.remove(id);
        }
        Ok(())
    }
    pub async fn close(&self) -> Result<(), ToolError> {
        let entries = self.entries.lock().unwrap().clone();
        for entry in entries.values() {
            entry.retiring.cancel();
        }
        let mut failure = None;
        for (id, entry) in entries {
            if let Err(error) = self.retire(&id, &entry).await {
                failure.get_or_insert(error);
            }
        }
        if let Err(error) = self.driver.lock().await.close().await {
            failure.get_or_insert(error);
        }
        failure.map_or(Ok(()), Err)
    }
}

pub(super) fn retain_sources(
    owner: &Arc<Computer>,
) -> Vec<maka_event_log::root_store::RetainedWorkSettlement> {
    let entries = owner
        .sessions
        .entries
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut retained = Vec::new();
    for entry in entries {
        let turns = entry
            .turns
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for turn in turns {
            let source = turn.source_lease.lock().unwrap().take();
            if let Some(source) = source {
                retained.push(source.retain_original_material(owner.clone()));
            }
        }
    }
    retained
}

pub(super) async fn watch_turn(
    owner: &Arc<Computer>,
    entry: &Arc<Interaction>,
    call: &Call,
    language: Language,
) -> Result<(), ToolError> {
    if owner.stopping.is_cancelled() || entry.retiring.is_cancelled() {
        return Err(failed("Computer Host service or Session is closing"));
    }
    let source = call.authority.call();
    let invocation = &source.execution;
    if call.scope.identity.agent() != Some(invocation)
        || source.custody.as_ref().is_none_or(|expected| {
            call.scope
                .work_custody()
                .is_none_or(|actual| !Arc::ptr_eq(actual, expected))
        })
    {
        return Err(failed(
            "Computer turn keeper requires its actual execution custody",
        ));
    }
    if let Some(existing) = entry.turns.lock().unwrap().get(&invocation.run_id) {
        return if existing.authority.call().execution == *invocation {
            Ok(())
        } else {
            Err(failed("Computer Run keeper execution differs"))
        };
    }
    let mut changes = call.authority.changes().map_err(failed)?;
    let mut ticket = owner.resources.reserve().map_err(failed)?;
    let source_lease = owner
        .store
        .fork_work(
            call.scope
                .work_custody()
                .expect("validated original custody")
                .as_ref(),
            &invocation.session_id,
        )
        .map_err(|e| ToolError::Persistence(message(e)))?;
    let source_writer = match source_lease.store().work_custody().and_then(|custody| {
        owner
            .store
            .data_writer_for_work(custody.as_ref(), &invocation.session_id)
    }) {
        Ok(writer) => writer,
        Err(error) => {
            source_lease.finish();
            return Err(ToolError::Persistence(message(error)));
        }
    };
    let turn_cleanup = {
        let mut turns = entry.turns.lock().unwrap();
        if owner.stopping.is_cancelled() || entry.retiring.is_cancelled() {
            source_lease.finish();
            return Err(failed("Computer Host service or Session is closing"));
        }
        match turns.entry(invocation.run_id) {
            std::collections::btree_map::Entry::Occupied(entry) => {
                source_lease.finish();
                return if entry.get().authority.call().execution == *invocation {
                    Ok(())
                } else {
                    Err(failed("Computer Run keeper execution differs"))
                };
            }
            std::collections::btree_map::Entry::Vacant(entry) => entry
                .insert(Arc::new(TurnCleanup {
                    floor: call.scope.sandbox_floor().clone(),
                    authority: call.authority.clone(),
                    source_lease: Mutex::new(Some(source_lease)),
                    source_writer,
                    native_observed: Default::default(),
                    native_interruption: Default::default(),
                    pending: Default::default(),
                    native_drained: Default::default(),
                }))
                .clone(),
        }
    };
    ticket.start();
    let entry = entry.clone();
    let stopping = owner.stopping.clone();
    owner.tasks.spawn(async move {
        let observed = async {
            loop {
                changes.borrow_and_update();
                entry.effects_changed.notify_one();
                let ended = tokio::select! {
                    biased;
                    () = stopping.cancelled() => return Ok(()),
                    () = entry.retiring.cancelled() => return Ok(()),
                    ended = turn_ended(&turn_cleanup) => ended?,
                };
                if ended {
                    return Ok(());
                }
                tokio::select! {
                    () = stopping.cancelled() => return Ok(()),
                    () = entry.retiring.cancelled() => return Ok(()),
                    changed = changes.changed() => changed.map_err(|error| ToolError::Persistence(message(error)))?,
                }
            }
        }.await;
        // Cleanup owns its cancellation lifetime. The ended run's cancelled
        // token must not discard a tab or recording still owned by that turn.
        let cleanup = entry
            .finish_turn(&turn_cleanup, language)
            .await;
        let result = observed.and(cleanup);
        entry.release_turn(&turn_cleanup, &result);
        ticket.complete(result.map_err(message));
    });
    Ok(())
}

pub(super) async fn drain_ended_turns(
    _owner: &Arc<Computer>,
    entry: &Arc<Interaction>,
    language: Language,
) -> Result<(), ToolError> {
    let turns = entry
        .turns
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    if turns.is_empty() {
        return Ok(());
    }
    for cleanup in turns {
        let invocation = &cleanup.authority.call().execution;
        if turn_ended(&cleanup).await? {
            let result = entry.finish_turn(&cleanup, language).await;
            entry.release_turn(&cleanup, &result);
            match result {
                Ok(()) => {}
                Err(ToolError::CleanupUnconfirmed(error)) => {
                    tracing::warn!(
                        session = invocation.session_id,
                        turn = invocation.turn_id,
                        run = %invocation.run_id,
                        error,
                        "Retained cleanup from an ended Computer turn"
                    );
                }
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

async fn turn_ended(cleanup: &TurnCleanup) -> Result<bool, ToolError> {
    match cleanup.authority.current().await {
        Ok(_) => Ok(false),
        Err(ToolError::Failed(_)) => Ok(true),
        Err(error) => Err(error),
    }
}
impl Epoch {
    pub(super) fn native_monitor_turn(
        &self,
        execution: &ExecutionIdentity,
    ) -> Result<Arc<TurnCleanup>, ToolError> {
        let cleanup = self
            .turns
            .lock()
            .expect("Computer turn registry lock poisoned")
            .get(&execution.run_id)
            .cloned()
            .ok_or_else(|| failed("Native monitor turn retired"))?;
        if cleanup.authority.call().execution != *execution {
            return Err(failed("Native monitor execution differs"));
        }
        cleanup.check_native_monitor_admission()?;
        Ok(cleanup)
    }

    /// Retain cleanup responsibility before the fixed native preparation can start.
    pub fn record_browser_preparation(
        &self,
        basis: PermissionBasis,
        execution: &ExecutionIdentity,
        gate: Arc<super::admission::Gate>,
    ) -> Result<(), ToolError> {
        gate.check_open()?;
        let cleanup = self
            .turns
            .lock()
            .expect("Computer turn registry lock poisoned")
            .get(&execution.run_id)
            .cloned()
            .ok_or_else(|| failed("Browser preparation turn has retired"))?;
        if cleanup.authority.call().execution != *execution {
            return Err(failed("Browser preparation execution differs"));
        }
        let turn = &execution.turn_id;
        access::resource_boundary(&cleanup.floor)?;
        if cleanup
            .pending
            .lock()
            .expect("Computer turn cleanup lock poisoned")
            .is_some()
        {
            return Err(failed("Browser preparation turn is closing"));
        }
        let mut preparations = self
            .browser_preparations
            .lock()
            .expect("Browser preparation receipt lock poisoned");
        if !preparations.iter().any(|current| {
            current.basis == basis
                && current.turn == *turn
                && Arc::ptr_eq(&current.gate, &gate)
                && Arc::ptr_eq(&current.cleanup, &cleanup)
        }) {
            preparations.push(Arc::new(BrowserPreparationReceipt {
                basis,
                turn: turn.clone(),
                gate,
                cleanup,
                observation: Default::default(),
            }));
        }
        drop(preparations);
        // Authority may have changed before this registration became visible.
        self.effects_changed.notify_one();
        Ok(())
    }

    fn clear_browser_preparations(&self, turn: &str, cleanup: &Arc<TurnCleanup>) {
        self.browser_preparations
            .lock()
            .expect("Browser preparation receipt lock poisoned")
            .retain(|current| current.turn != turn || !Arc::ptr_eq(&current.cleanup, cleanup));
    }

    async fn close_native(&self) -> Result<(), ToolError> {
        self.seal_native_monitors(None);
        let monitors = self.retire_native_monitors(None).await;
        let native = self.native.lock().await.close_native().await;
        let result = match (monitors, native) {
            (Ok(()), result) | (result, Ok(())) => result,
            (Err(monitors), Err(native)) => Err(ToolError::CleanupUnconfirmed(format!(
                "{monitors}; {native}"
            ))),
        };
        if result.is_ok() {
            self.files.close().await?;
            self.clear_audio();
            self.browser_preparations
                .lock()
                .expect("Browser preparation receipt lock poisoned")
                .clear();
        }
        result
    }
    /// Called after a successful native start while the native guard is held.
    pub fn record_audio(
        &self,
        policy: Arc<dyn maka_agent_authority::computer::SessionAudioRetention>,
        floor: maka_sandbox::Sandbox,
        stopping: CancellationToken,
        finished: BoxFuture<'static, Result<(), ToolError>>,
    ) {
        *self.audio.lock().unwrap() = Some(Arc::new(AudioReceipt {
            retained: RetainedSessionAudio {
                native: self.native.clone(),
                policy,
                floor,
                stopping,
            },
            finished: finished.shared(),
        }));
        self.effects_changed.notify_one();
    }

    pub fn clear_audio(&self) {
        *self.audio.lock().unwrap() = None;
    }

    async fn discard_audio_if_current(
        &self,
        receipt: &Arc<AudioReceipt>,
    ) -> Result<bool, ToolError> {
        if !Arc::ptr_eq(&self.native, &receipt.retained.native) {
            receipt.finished.clone().await?;
            return Ok(false);
        }
        let mut native = receipt.retained.native.lock().await;
        if !self
            .audio
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, receipt))
        {
            drop(native);
            receipt.finished.clone().await?;
            return Ok(false);
        }
        native.discard_audio().await?;
        self.clear_audio();
        Ok(true)
    }

    async fn settle_audio(&self, closing: &CancellationToken) -> Result<(), ToolError> {
        // The caller first joins the original REPL worker. An accepted Start
        // may publish its receipt after the observer has already returned.
        let receipt = self.audio.lock().unwrap().clone();
        let Some(receipt) = receipt else {
            return Ok(());
        };
        let observed = tokio::select! {
            biased;
            () = closing.cancelled() => None,
            result = receipt.finished.clone() => Some(result),
        };
        if self.discard_audio_if_current(&receipt).await? {
            observed.unwrap_or(Ok(()))
        } else {
            // A replacement cannot acknowledge the previous capture's EOF.
            match observed {
                Some(result) => result,
                None => receipt.finished.clone().await,
            }
        }
    }
}

impl Kernel {
    pub async fn close(self, closing: CancellationToken) -> Result<(), ToolError> {
        // Retained transport for an admitted RPC does not keep this VM's
        // automatic attached-service producer alive after reset/retirement.
        self.admission.close_admission();
        self.epoch.seal_native_monitors(None);
        let mut failures = Vec::new();
        if let Some(runtime) = self.repl
            && let Err(error) = runtime.close().await
        {
            failures.push(format!("JavaScript runtime cleanup failed: {error}"));
        }
        self.epoch
            .vm_joined
            .store(true, std::sync::atomic::Ordering::Release);
        if let Err(error) = self.epoch.settle_audio(&closing).await {
            failures.push(format!("Computer audio cleanup failed: {error}"));
        }
        if let Err(error) = self.epoch.close_native().await {
            failures.push(format!("Native computer cleanup failed: {error}"));
        }
        cleanup_result(failures)
    }
}

fn cleanup_result(failures: Vec<String>) -> Result<(), ToolError> {
    if failures.is_empty() {
        Ok(())
    } else {
        Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
    }
}

impl Interaction {
    pub fn fresh_kernel(&self) -> Result<Kernel, ToolError> {
        let mut epochs = self.epochs.lock().unwrap();
        if self.retiring.is_cancelled() {
            return Err(failed("Computer Session is retiring"));
        }
        let native = self.native_owner.new_epoch()?;
        let epoch = Arc::new(Epoch {
            files: Arc::default(),
            id: native.native_epoch().to_string(),
            native: Arc::new(tokio::sync::Mutex::new(native)),
            audio: Default::default(),
            browser_preparations: Default::default(),
            native_monitors: Default::default(),
            turns: self.turns.clone(),
            effects_changed: self.effects_changed.clone(),
            retirement: Default::default(),
            vm_joined: std::sync::atomic::AtomicBool::new(false),
        });
        epochs.push(epoch.clone());
        Ok(Kernel {
            repl: None,
            epoch,
            admission: Arc::default(),
        })
    }

    /// Transfer the exact worker and epoch before returning its observer. An
    /// admission failure returns ownership intact so the caller can restore it.
    /// The caller holds `kernel` while removing/restoring this current worker.
    pub fn retire_kernel(
        self: &Arc<Self>,
        owner: &Arc<Computer>,
        kernel: Kernel,
    ) -> Result<(), (ToolError, Kernel)> {
        self.spawn_kernel(owner, kernel, self.retiring.clone())
            .map(|_| ())
    }

    fn spawn_kernel(
        self: &Arc<Self>,
        owner: &Arc<Computer>,
        kernel: Kernel,
        closing: CancellationToken,
    ) -> Result<Retirement, (ToolError, Kernel)> {
        let mut ticket = match owner.resources.reserve() {
            Ok(ticket) => ticket,
            Err(error) => return Err((error.into(), kernel)),
        };
        let epoch = kernel.epoch.clone();
        let mut retirement = epoch.retirement.lock().unwrap();
        if retirement.is_some() {
            return Err((failed("Computer epoch is already retiring"), kernel));
        }
        kernel.admission.close_admission();
        ticket.start();
        let entry = Arc::downgrade(self);
        let retired = epoch.clone();
        let task = owner.tasks.spawn(async move {
            let result = AssertUnwindSafe(kernel.close(closing))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(ToolError::CleanupUnconfirmed(
                        "Computer epoch retirement worker panicked".into(),
                    ))
                });
            if result.is_ok()
                && let Some(entry) = entry.upgrade()
            {
                entry
                    .epochs
                    .lock()
                    .unwrap()
                    .retain(|current| !Arc::ptr_eq(current, &retired));
            }
            ticket.complete(result.clone().map_err(message));
            result
        });
        let result = async move {
            task.await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!("Computer epoch worker disappeared: {error}"))
            })?
        }
        .boxed()
        .shared();
        *retirement = Some(result.clone());
        Ok(result)
    }

    pub async fn close(self: &Arc<Self>) -> Result<(), ToolError> {
        self.retiring.cancel();
        let closing = {
            let mut closed = self.closed.lock().unwrap();
            if let Some(closing) = closed
                .as_ref()
                .filter(|closing| !matches!(closing.peek(), Some(Err(_))))
            {
                closing.clone()
            } else {
                let entry = self.clone();
                let task = self.tasks.spawn(async move {
                    AssertUnwindSafe(entry.close_owned())
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| {
                            Err(ToolError::CleanupUnconfirmed(
                                "Computer Session cleanup worker panicked".into(),
                            ))
                        })
                });
                let closing = async move {
                    task.await.map_err(|error| {
                        ToolError::CleanupUnconfirmed(format!(
                            "Computer Session cleanup worker disappeared: {error}"
                        ))
                    })?
                }
                .boxed()
                .shared();
                *closed = Some(closing.clone());
                closing
            }
        };
        closing.await
    }

    fn release_turn(&self, cleanup: &Arc<TurnCleanup>, result: &Result<(), ToolError>) {
        if result.is_err() {
            return;
        }
        let run = cleanup.authority.call().execution.run_id;
        let mut turns = self.turns.lock().unwrap();
        if turns
            .get(&run)
            .is_some_and(|current| Arc::ptr_eq(current, cleanup))
        {
            turns.remove(&run);
        }
    }

    fn finish_turn(&self, cleanup: &Arc<TurnCleanup>, language: Language) -> Retirement {
        let execution = cleanup.authority.call().execution.clone();
        let epochs = self.epochs.lock().unwrap().clone();
        // Fence fixed producers synchronously, before any sibling cleanup wait.
        for epoch in &epochs {
            epoch.seal_native_monitors(Some(&execution));
        }
        let native_owner = self.native_owner.clone();
        let session = execution.session_id.clone();
        let turn = execution.turn_id.clone();
        let correlation =
            maka_computer_use::ExecutionCorrelation::new(execution.run_id.to_string())
                .expect("nonempty actual Run identity");
        let cleanup_owner = cleanup.clone();
        cleanup.start(&self.tasks, async move {
            let mut failures = Vec::new();
            for epoch in &epochs {
                if let Err(error) = epoch.retire_native_monitors(Some(&execution)).await {
                    failures.push(message(error));
                }
                let mut native = epoch.native.lock().await;
                if let Err(error) = native
                    .finish_turn(&session, &turn, &correlation, language)
                    .await
                {
                    failures.push(message(error));
                }
            }
            if let Err(error) = native_owner
                .finish_turn(&session, &turn, &correlation, language)
                .await
            {
                failures.push(message(error));
            }
            // The producer may have observed Escape while its original close
            // drained. Read the final original writer only after that EOF.
            let interruption = cleanup_owner.native_interruption.lock().unwrap().clone();
            if let Some(original) = interruption
                && let Err(error) = original.await
            {
                failures.push(message(error));
            }
            let result = cleanup_result(failures);
            if result.is_ok() {
                for epoch in epochs {
                    epoch.clear_browser_preparations(&turn, &cleanup_owner);
                }
                if let Some(source) = cleanup_owner.source_lease.lock().unwrap().take() {
                    source.finish();
                }
            }
            result
        })
    }

    fn observe_browser_cleanup(
        self: &Arc<Self>,
        owner: &Arc<Computer>,
        epoch: &Arc<Epoch>,
        receipt: &Arc<BrowserPreparationReceipt>,
        observed: Result<PreparationAuthority, ToolError>,
    ) -> Result<(), ToolError> {
        // Only a global authority failure seals the VM reused across turns.
        if matches!(observed, Ok(PreparationAuthority::Revoked) | Err(_)) {
            receipt.gate.close_admission();
        }
        let mut observation = receipt
            .observation
            .lock()
            .expect("Browser cleanup observation lock poisoned");
        if observation
            .as_ref()
            .is_some_and(|original| !matches!(original.peek(), Some(Err(_))))
        {
            return Ok(());
        }
        let mut ticket = owner.resources.reserve().map_err(failed)?;
        ticket.start();
        let entry = self.clone();
        let owner = owner.clone();
        let epoch = epoch.clone();
        let receipt = receipt.clone();
        let tasks = owner.tasks.clone();
        let task = tasks.spawn(async move {
            let result = AssertUnwindSafe(async {
                let cleanup = if matches!(observed, Ok(PreparationAuthority::VmRetired)) {
                    entry.retire_prepared_epoch(&owner, &epoch).await
                } else {
                    let result = entry.finish_turn(&receipt.cleanup, Language::En).await;
                    entry.release_turn(&receipt.cleanup, &result);
                    result
                };
                observed.map(|_| ()).and(cleanup)
            })
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(ToolError::CleanupUnconfirmed(
                    "Browser preparation cleanup observer panicked".into(),
                ))
            });
            ticket.complete(result.clone().map_err(message));
            result
        });
        let result = async move {
            task.await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!(
                    "Browser cleanup observer disappeared: {error}"
                ))
            })?
        }
        .boxed()
        .shared();
        tasks.spawn(result.clone());
        *observation = Some(result);
        Ok(())
    }

    async fn settle_epoch(self: &Arc<Self>, epoch: &Arc<Epoch>) -> Result<(), ToolError> {
        let retirement = {
            let mut pending = epoch
                .retirement
                .lock()
                .expect("Computer epoch retirement lock poisoned");
            if let Some(original) = pending
                .as_ref()
                .filter(|original| !matches!(original.peek(), Some(Err(_))))
            {
                original.clone()
            } else {
                if !epoch.vm_joined.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(ToolError::CleanupUnconfirmed(
                        "Computer VM termination remains unconfirmed".into(),
                    ));
                }
                let epoch = epoch.clone();
                let entry = Arc::downgrade(self);
                let task = self.tasks.spawn(async move {
                    let result = epoch.close_native().await;
                    if result.is_ok() {
                        epoch.clear_audio();
                        if let Some(entry) = entry.upgrade() {
                            entry
                                .epochs
                                .lock()
                                .unwrap()
                                .retain(|current| !Arc::ptr_eq(current, &epoch));
                        }
                    }
                    result
                });
                let result = async move {
                    task.await.map_err(|error| {
                        ToolError::CleanupUnconfirmed(format!(
                            "Computer epoch cleanup worker disappeared: {error}"
                        ))
                    })?
                }
                .boxed()
                .shared();
                *pending = Some(result.clone());
                result
            }
        };
        retirement.await
    }

    async fn retire_prepared_epoch(
        self: &Arc<Self>,
        owner: &Arc<Computer>,
        epoch: &Arc<Epoch>,
    ) -> Result<(), ToolError> {
        let retirement = epoch
            .retirement
            .lock()
            .expect("Computer epoch retirement lock poisoned")
            .clone();
        if retirement.is_some() {
            return self.settle_epoch(epoch).await;
        }
        if self.retiring.is_cancelled() {
            return self.close().await;
        }
        let mut current = self.kernel.lock().await;
        let retirement = epoch
            .retirement
            .lock()
            .expect("Computer epoch retirement lock poisoned")
            .clone();
        if retirement.is_some() {
            drop(current);
            return self.settle_epoch(epoch).await;
        }
        if self.retiring.is_cancelled() {
            drop(current);
            return self.close().await;
        }
        if !current
            .as_ref()
            .is_some_and(|kernel| Arc::ptr_eq(&kernel.epoch, epoch))
        {
            return Err(ToolError::CleanupUnconfirmed(
                "Closed browser VM has no matching retained retirement".into(),
            ));
        }
        let kernel = current.take().expect("matched current Computer kernel");
        let retirement = match self.spawn_kernel(owner, kernel, self.retiring.clone()) {
            Ok(retirement) => retirement,
            Err((error, kernel)) => {
                *current = Some(kernel);
                return Err(error);
            }
        };
        drop(current);
        retirement.await
    }

    async fn close_owned(self: &Arc<Self>) -> Result<(), ToolError> {
        self.retiring.cancel();
        let turns = self
            .turns
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let current = self.kernel.lock().await.take();
        let mut failures = Vec::new();
        if let Some(kernel) = current {
            let epoch = kernel.epoch.clone();
            match kernel.close(self.retiring.clone()).await {
                Ok(()) => self
                    .epochs
                    .lock()
                    .unwrap()
                    .retain(|current| !Arc::ptr_eq(current, &epoch)),
                Err(error) => failures.push(message(error)),
            }
        }
        // Never join Computer.tasks/resources here: its catalog watch may be
        // the caller. Only these exact epoch workers belong to this close.
        let epochs = self.epochs.lock().unwrap().clone();
        for epoch in epochs {
            if let Err(error) = self.settle_epoch(&epoch).await {
                failures.push(message(error));
            }
        }
        for turn in turns {
            let result = self.finish_turn(&turn, turn.authority.language()).await;
            if let Err(error) = &result {
                failures.push(message(error));
            }
            self.release_turn(&turn, &result);
        }
        if let Err(error) = self.native_owner.close().await {
            failures.push(message(error));
        }
        cleanup_result(failures)
    }
}

async fn audio_current(receipt: &AudioReceipt) -> Result<bool, ToolError> {
    if receipt.retained.stopping.is_cancelled()
        || access::resource_boundary(&receipt.retained.floor).is_err()
    {
        return Ok(false);
    }
    receipt.retained.policy.current().await
}

async fn preparation_current(
    receipt: &BrowserPreparationReceipt,
) -> Result<PreparationAuthority, ToolError> {
    if access::resource_boundary(&receipt.cleanup.floor).is_err() {
        return Ok(PreparationAuthority::Revoked);
    }
    let authority = receipt.cleanup.authority.as_ref();
    let configuration = match authority.current().await {
        Ok(configuration) => configuration,
        Err(ToolError::Failed(_)) => return Ok(PreparationAuthority::TurnInactive),
        Err(error) => return Err(error),
    };
    if configuration.permission_basis() != receipt.basis
        || configuration.permissions.access == maka_agent_api::contract::WorkspaceAccess::ReadOnly
    {
        return Ok(PreparationAuthority::Revoked);
    }
    if configuration.permissions.access
        != maka_agent_api::contract::WorkspaceAccess::DangerFullAccess
        && authority
            .client_grant(&api::target())
            .await?
            .is_none_or(|grant| grant.basis != Some(receipt.basis))
    {
        return Ok(PreparationAuthority::Revoked);
    }
    if receipt.gate.check_open().is_err() {
        return Ok(PreparationAuthority::VmRetired);
    }
    Ok(PreparationAuthority::Current)
}

pub(super) fn watch(owner: &Arc<Computer>) {
    watch_scanned(owner, || {});
}

fn watch_scanned(owner: &Arc<Computer>, scanned: impl Fn() + Send + 'static) {
    let mut changes = owner.store.subscribe_catalog_changes();
    let stopping = owner.stopping.clone();
    let weak = Arc::downgrade(owner);
    let effects_changed = owner.sessions.effects_changed.clone();
    owner.tasks.spawn(async move {
        loop {
            changes.borrow_and_update();
            let Some(owner) = weak.upgrade() else {
                return;
            };
            let entries = owner.sessions.entries.lock().unwrap().clone();
            for (id, entry) in entries {
                let valid = async {
                    let store = owner.store.session(&id).await?;
                    let session = store
                        .get::<maka_agent_api::session::StoredSessionConfiguration>()
                        .await?;
                    let retired = store.session_retirement(&id).await?;
                    Ok::<_, maka_event_log::StoreError>(
                        session.is_some_and(|s| !s.archived) && retired.is_none(),
                    )
                }
                .await;
                if let Err(error) = &valid {
                    eprintln!("Computer catalog observation failed for {id}: {error}");
                }
                if matches!(valid, Ok(false)) {
                    let Ok(mut ticket) = owner.resources.reserve() else {
                        return;
                    };
                    ticket.start();
                    let result = owner.sessions.retire(&id, &entry).await.map_err(message);
                    if let Err(error) = &result {
                        eprintln!("Computer Session cleanup failed for {id}: {error}");
                    }
                    ticket.complete(result);
                    continue;
                }
                let epochs = entry.epochs.lock().unwrap().clone();
                for epoch in epochs {
                    epoch.observe_native_monitor_authority().await;
                    let preparations = epoch
                        .browser_preparations
                        .lock()
                        .expect("Browser preparation receipt lock poisoned")
                        .clone();
                    for receipt in preparations {
                        let observed = preparation_current(&receipt).await;
                        if matches!(observed, Ok(PreparationAuthority::Current)) {
                            continue;
                        }
                        if let Err(error) =
                            entry.observe_browser_cleanup(&owner, &epoch, &receipt, observed)
                        {
                            eprintln!(
                                "Computer browser cleanup observation failed for {id}: {error}"
                            );
                        }
                    }
                    let receipt = epoch.audio.lock().unwrap().clone();
                    let Some(receipt) = receipt else {
                        continue;
                    };
                    let observed = audio_current(&receipt).await;
                    if matches!(observed, Ok(true)) {
                        continue;
                    }
                    let Ok(mut ticket) = owner.resources.reserve() else {
                        return;
                    };
                    ticket.start();
                    let result = match epoch.discard_audio_if_current(&receipt).await {
                        Ok(false) => Ok(()),
                        Ok(true) => observed.map(|_| ()).map_err(message),
                        Err(error) => Err(message(error)),
                    };
                    if let Err(error) = &result {
                        eprintln!("Computer audio cleanup failed for {id}: {error}");
                    }
                    ticket.complete(result);
                }
            }
            drop(owner);
            scanned();
            tokio::select! {
                () = stopping.cancelled() => return,
                () = effects_changed.notified() => {},
                result = changes.changed() => if result.is_err() { return; },
            }
        }
    });
}
