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
use maka_agent_facts::workspace::PermissionBasis;
use maka_agent_facts::{event::Invocation, language::Language};
use maka_js_runtime::repl::Repl;
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
    turns: Arc<Mutex<BTreeMap<String, Arc<TurnCleanup>>>>,
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

#[derive(Default)]
pub(super) struct TurnCleanup {
    pending: Mutex<Option<Retirement>>,
    // Actual observation-write custody, not a second permission flag. Native
    // admission always checks the canonical logical-Turn fact in its T1.
    native_interruption: Mutex<Option<Retirement>>,
    // Actual input-release/child-wait proof, not success of the interrupted action.
    native_drained: Mutex<Option<maka_computer_use::NativeInterruptionDrain>>,
}

impl TurnCleanup {
    pub(super) fn check_native_monitor_admission(&self) -> Result<(), ToolError> {
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

/// The observer may outlive its initiating evaluation/JS epoch. It owns no
/// Agent Run, grant or model-supplied identifier, only the original source identity.
pub(super) struct NativeInterruptionObserver {
    owner: std::sync::Weak<Computer>,
    cleanup: Arc<TurnCleanup>,
    invocation: Invocation,
    epoch: String,
    operation: String,
}

pub(super) fn native_interruption_observer(
    owner: &Arc<Computer>,
    entry: &Interaction,
    invocation: &Invocation,
    epoch: &Epoch,
    operation: &str,
) -> Result<Arc<NativeInterruptionObserver>, ToolError> {
    let cleanup = entry
        .turns
        .lock()
        .unwrap()
        .get(&invocation.turn_id)
        .cloned()
        .ok_or_else(|| failed("Native interruption source Turn is unavailable"))?;
    Ok(Arc::new(NativeInterruptionObserver {
        owner: Arc::downgrade(owner),
        cleanup,
        invocation: invocation.clone(),
        epoch: epoch.id.clone(),
        operation: operation.to_owned(),
    }))
}
impl maka_computer_use::NativeInterruptionObserver for NativeInterruptionObserver {
    fn interrupted(
        &self,
        observed: maka_computer_use::NativeInterruption,
    ) -> maka_computer_use::InterruptionFuture {
        // Only the lower bound native-event producer can construct this sealed
        // value. An exit code, transport diagnostic or arbitrary JSON cannot.
        if observed.session() != self.invocation.session_id
            || observed.turn() != self.invocation.turn_id
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
        let mut pending = self.cleanup.native_interruption.lock().unwrap();
        if let Some(original) = pending.as_ref() {
            let original = original.clone();
            return Box::pin(original);
        }
        let mut ticket = match owner.resources.reserve() {
            Ok(ticket) => ticket,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        let record = maka_event_log::native_computer::NativeInterruption {
            opening: self.invocation.clone(),
            operation_id: self.operation.clone(),
            native_epoch: self.epoch.clone(),
            native_generation: observed.generation().to_owned(),
        };
        let (completed, result) = tokio::sync::oneshot::channel::<Result<(), ToolError>>();
        let original = async move {
            result.await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!(
                    "Native interruption writer disappeared: {error}"
                ))
            })?
        }
        .boxed()
        .shared();
        *pending = Some(original.clone());
        ticket.start();
        let tasks = owner.tasks.clone();
        tasks.spawn(async move {
            let result = AssertUnwindSafe(async {
                let store = match owner.store.session(&record.opening.session_id).await {
                    Ok(store) => store,
                    // The sealed event still belongs to its removed original
                    // Session. It cannot fence a newer Session/Turn or revive A.
                    Err(
                        maka_event_log::StoreError::SessionNotFound
                        | maka_event_log::StoreError::SessionRetired,
                    ) => return Ok(()),
                    Err(error) => return Err(ToolError::Persistence(message(error))),
                };
                match store.record_native_turn_interruption(record).await {
                    Ok(_) | Err(maka_event_log::StoreError::SessionRetired) => Ok(()),
                    Err(error) => Err(ToolError::Persistence(message(error))),
                }
            })
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(ToolError::CleanupUnconfirmed(
                    "Native interruption writer panicked".into(),
                ))
            });
            // The same accepted SQL future has settled. A failing observation
            // remains visible to native admission/final close; it never requests
            // cancellation of the Agent, browser or JS producer.
            ticket.complete(result.as_ref().map(|_| ()).map_err(message));
            let _ = completed.send(result);
        });
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

/// A canonical action may remain Unknown after its exact native owner is fully
/// drained. This proof does not change T2 or authorize another native call.
impl NativeInterruptionObserver {
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
                    && observed.native_epoch() == self.epoch
                    && observed.affected_operation_id() == self.operation
            })
            .cloned();
        if proof.is_some() {
            // Clone the original writer receipt and release every Turn lock
            // before awaiting it. Physical input cleanup cannot substitute for
            // the canonical fence, and this SQL future never needs native/T2.
            let write = self.cleanup.native_interruption.lock().unwrap().clone();
            confirm_native_interruption(write).await?;
        }
        Ok(proof)
    }
}

/// Both prerequisites are required for the native-only Unknown exception:
/// real physical drain and successful custody of the original canonical write.
/// This observes the same accepted future, never starts a replacement write.
pub(super) async fn confirm_native_interruption(
    write: Option<Retirement>,
) -> Result<(), ToolError> {
    write
        .ok_or_else(|| {
            ToolError::CleanupUnconfirmed(
                "Native input drained without its canonical interruption writer".into(),
            )
        })?
        .await
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
    turns: Arc<Mutex<BTreeMap<String, Arc<TurnCleanup>>>>,
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

struct AudioReceipt {
    basis: PermissionBasis,
    requires_audio_consent: bool,
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

pub(super) async fn watch_turn(
    owner: &Arc<Computer>,
    entry: &Arc<Interaction>,
    invocation: &Invocation,
    language: Language,
) -> Result<(), ToolError> {
    if entry
        .turns
        .lock()
        .unwrap()
        .contains_key(&invocation.turn_id)
    {
        return Ok(());
    }
    let store = owner
        .store
        .session(&invocation.session_id)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    let mut changes = store.subscribe_commits().map_err(failed)?;
    let mut ticket = owner.resources.reserve().map_err(failed)?;
    let turn_cleanup = {
        let mut turns = entry.turns.lock().unwrap();
        match turns.entry(invocation.turn_id.clone()) {
            std::collections::btree_map::Entry::Occupied(_) => return Ok(()),
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Arc::new(TurnCleanup::default())).clone()
            }
        }
    };
    ticket.start();
    let entry = entry.clone();
    let session = invocation.session_id.clone();
    let turn = invocation.turn_id.clone();
    let stopping = owner.stopping.clone();
    owner.tasks.spawn(async move {
        let observed = async {
            loop {
                changes.borrow_and_update();
                let ended = tokio::select! {
                    biased;
                    () = stopping.cancelled() => return Ok(()),
                    () = entry.retiring.cancelled() => return Ok(()),
                    ended = turn_ended(&store, &session, &turn) => ended?,
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
            .finish_turn(&turn_cleanup, &session, &turn, language)
            .await;
        let result = observed.and(cleanup);
        entry.release_turn(&turn, &turn_cleanup, &result);
        ticket.complete(result.map_err(message));
    });
    Ok(())
}

pub(super) async fn drain_ended_turns(
    owner: &Arc<Computer>,
    entry: &Arc<Interaction>,
    session: &str,
    language: Language,
) -> Result<(), ToolError> {
    let turns = entry
        .turns
        .lock()
        .unwrap()
        .iter()
        .map(|(turn, cleanup)| (turn.clone(), cleanup.clone()))
        .collect::<Vec<_>>();
    if turns.is_empty() {
        return Ok(());
    }
    let store = owner
        .store
        .session(session)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    for (turn, cleanup) in turns {
        if turn_ended(&store, session, &turn).await? {
            let result = entry.finish_turn(&cleanup, session, &turn, language).await;
            entry.release_turn(&turn, &cleanup, &result);
            match result {
                Ok(()) => {}
                Err(ToolError::CleanupUnconfirmed(error)) => {
                    tracing::warn!(
                        session,
                        turn,
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

async fn turn_ended(
    store: &maka_event_log::SessionStore,
    session: &str,
    turn: &str,
) -> Result<bool, ToolError> {
    let boundary = store
        .turn_boundary(session, turn)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
        .ok_or_else(|| {
            ToolError::CleanupUnconfirmed("Computer turn lifetime is unavailable".into())
        })?;
    // A handoff seals a physical Run while preserving the logical Turn.
    Ok(boundary.state.terminal_outcome().is_some())
}
impl Epoch {
    pub(super) fn native_monitor_turn(&self, turn: &str) -> Result<Arc<TurnCleanup>, ToolError> {
        let cleanup = self
            .turns
            .lock()
            .expect("Computer turn registry lock poisoned")
            .get(turn)
            .cloned()
            .ok_or_else(|| failed("Native monitor turn retired"))?;
        cleanup.check_native_monitor_admission()?;
        Ok(cleanup)
    }

    /// Retain cleanup responsibility before the fixed native preparation can start.
    pub fn record_browser_preparation(
        &self,
        basis: PermissionBasis,
        turn: &str,
        gate: Arc<super::admission::Gate>,
    ) -> Result<(), ToolError> {
        gate.check_open()?;
        let cleanup = self
            .turns
            .lock()
            .expect("Computer turn registry lock poisoned")
            .get(turn)
            .cloned()
            .ok_or_else(|| failed("Browser preparation turn has retired"))?;
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
                && current.turn == turn
                && Arc::ptr_eq(&current.gate, &gate)
                && Arc::ptr_eq(&current.cleanup, &cleanup)
        }) {
            preparations.push(Arc::new(BrowserPreparationReceipt {
                basis,
                turn: turn.to_owned(),
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
    pub fn record_audio(&self, basis: PermissionBasis, requires_audio_consent: bool) {
        *self.audio.lock().unwrap() = Some(Arc::new(AudioReceipt {
            basis,
            requires_audio_consent,
        }));
        // The catalog event may have preceded the successful start/receipt.
        self.effects_changed.notify_one();
    }

    pub fn clear_audio(&self) {
        *self.audio.lock().unwrap() = None;
    }

    async fn discard_audio_if_current(
        &self,
        receipt: &Arc<AudioReceipt>,
    ) -> Result<bool, ToolError> {
        let mut native = self.native.lock().await;
        if !self
            .audio
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, receipt))
        {
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
        if closing.is_cancelled() {
            return self.discard_audio_if_current(&receipt).await.map(|_| ());
        }
        let finished = {
            let native = self.native.lock().await;
            if !self
                .audio
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &receipt))
            {
                return Ok(());
            }
            native.wait_audio_finished()
        };
        // The completion future owns its native capture observation. Holding
        // the Session mutex here would prevent revoke/final-close discard.
        let observed = tokio::select! {
            result = finished => result,
            () = closing.cancelled() => Ok(()),
        };
        match self.discard_audio_if_current(&receipt).await? {
            false => Ok(()), // Another exact owner already confirmed discard.
            true => observed,
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
            Err(error) => return Err((error, kernel)),
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

    fn release_turn(&self, turn: &str, cleanup: &Arc<TurnCleanup>, result: &Result<(), ToolError>) {
        if result.is_err() {
            return;
        }
        let mut turns = self.turns.lock().unwrap();
        if turns
            .get(turn)
            .is_some_and(|current| Arc::ptr_eq(current, cleanup))
        {
            turns.remove(turn);
        }
    }

    fn finish_turn(
        &self,
        cleanup: &Arc<TurnCleanup>,
        session: &str,
        turn: &str,
        language: Language,
    ) -> Retirement {
        let epochs = self.epochs.lock().unwrap().clone();
        // Fence fixed producers synchronously, before any sibling cleanup wait.
        for epoch in &epochs {
            epoch.seal_native_monitors(Some(turn));
        }
        let native_owner = self.native_owner.clone();
        let session = session.to_owned();
        let turn = turn.to_owned();
        let cleanup_owner = cleanup.clone();
        cleanup.start(&self.tasks, async move {
            let mut failures = Vec::new();
            let interruption = cleanup_owner.native_interruption.lock().unwrap().clone();
            if let Some(original) = interruption
                && let Err(error) = original.await
            {
                failures.push(message(error));
            }
            for epoch in &epochs {
                if let Err(error) = epoch.retire_native_monitors(Some(&turn)).await {
                    failures.push(message(error));
                }
                let mut native = epoch.native.lock().await;
                let windows = native.platform() == "windows";
                match native.finish_turn(&session, &turn, language).await {
                    Ok(()) if windows => epoch.clear_audio(),
                    Ok(()) => {}
                    Err(error) => failures.push(message(error)),
                }
            }
            if let Err(error) = native_owner.finish_turn(&turn, language).await {
                failures.push(message(error));
            }
            let result = cleanup_result(failures);
            if result.is_ok() {
                for epoch in epochs {
                    epoch.clear_browser_preparations(&turn, &cleanup_owner);
                }
            }
            result
        })
    }

    fn observe_browser_cleanup(
        self: &Arc<Self>,
        owner: &Arc<Computer>,
        session: &str,
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
        let session = session.to_owned();
        let tasks = owner.tasks.clone();
        let task = tasks.spawn(async move {
            let result = AssertUnwindSafe(async {
                let cleanup = if matches!(observed, Ok(PreparationAuthority::VmRetired)) {
                    entry.retire_prepared_epoch(&owner, &epoch).await
                } else {
                    let result = entry
                        .finish_turn(&receipt.cleanup, &session, &receipt.turn, Language::En)
                        .await;
                    entry.release_turn(&receipt.turn, &receipt.cleanup, &result);
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
        if let Err(error) = self.native_owner.close().await {
            failures.push(message(error));
        }
        cleanup_result(failures)
    }
}

async fn audio_current(
    root: &maka_event_log::RootStore,
    session: &str,
    receipt: &AudioReceipt,
) -> Result<bool, ToolError> {
    let store = root
        .session(session)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    for target in
        std::iter::once(api::target()).chain(receipt.requires_audio_consent.then(api::audio_target))
    {
        // The canonical grant read rejects a stale permission basis inside its
        // database snapshot. This receipt supplies ownership, never authority.
        let grant = store
            .client_capability_grant(session, &target)
            .await
            .map_err(|error| ToolError::Persistence(message(error)))?;
        if grant.is_none_or(|grant| grant.basis != Some(receipt.basis)) {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn preparation_current(
    root: &maka_event_log::RootStore,
    session: &str,
    receipt: &BrowserPreparationReceipt,
) -> Result<PreparationAuthority, ToolError> {
    let store = root
        .session(session)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    let projection = store
        .session_projection::<maka_agent_api::session::StoredSessionConfiguration>(session)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    let Some(projection) = projection.filter(|projection| !projection.session.archived) else {
        return Ok(PreparationAuthority::Revoked);
    };
    let current_turn = projection.root_turn.as_ref().is_some_and(|turn| {
        turn.invocation.turn_id == receipt.turn && turn.state.terminal_outcome().is_none()
    });
    let configuration = maka_agent_authority::permissions::resolve_session(projection.session)
        .map_err(|error| ToolError::Persistence(message(error)))?
        .configuration;
    if configuration.permission_basis() != receipt.basis
        || configuration.permissions.access == maka_agent_api::contract::WorkspaceAccess::ReadOnly
        || configuration
            .tools
            .as_ref()
            .is_some_and(|tools| !tools.iter().any(|tool| tool == "cua_repl"))
    {
        return Ok(PreparationAuthority::Revoked);
    }
    let grant = store
        .client_capability_grant(session, &api::target())
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    if grant.is_none_or(|grant| grant.basis != Some(receipt.basis)) {
        return Ok(PreparationAuthority::Revoked);
    }
    // A different current turn is not evidence of a global permission change.
    if !current_turn {
        return Ok(PreparationAuthority::TurnInactive);
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
                        .get_session::<maka_agent_api::session::StoredSessionConfiguration>(&id)
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
                        let observed = preparation_current(&owner.store, &id, &receipt).await;
                        if matches!(observed, Ok(PreparationAuthority::Current)) {
                            continue;
                        }
                        if let Err(error) =
                            entry.observe_browser_cleanup(&owner, &id, &epoch, &receipt, observed)
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
                    let observed = audio_current(&owner.store, &id, &receipt).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::event::{EventWrite, Fact, InvocationInput, RuntimeEvent};

    async fn current_epoch(entry: &Interaction) -> Arc<Epoch> {
        let mut kernel = entry.kernel.lock().await;
        if kernel.is_none() {
            *kernel = Some(entry.fresh_kernel().unwrap());
        }
        kernel.as_ref().unwrap().epoch.clone()
    }

    #[tokio::test]
    async fn clearing_one_epoch_never_discards_the_replacement_epochs_receipt() {
        let sessions = Sessions::with_audio(true, Default::default());
        let entry = sessions.get("session").unwrap();
        let old = entry.fresh_kernel().unwrap();
        let current = current_epoch(&entry).await;
        assert_ne!(old.epoch.id, current.id);
        let basis = PermissionBasis {
            boundary_revision: 0,
            binding: maka_agent_facts::workspace::BindingStamp {
                id: uuid::Uuid::new_v4(),
                permission_epoch: 0,
            },
        };
        old.epoch.record_audio(basis, false);
        current.record_audio(basis, false);
        let previous = old.epoch.audio.lock().unwrap().clone().unwrap();
        let replacement = current.audio.lock().unwrap().clone().unwrap();
        assert!(old.epoch.discard_audio_if_current(&previous).await.unwrap());
        assert!(
            current
                .audio
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|receipt| Arc::ptr_eq(receipt, &replacement))
        );
        let closing = CancellationToken::new();
        closing.cancel();
        old.close(closing).await.unwrap();
        assert!(
            current
                .audio
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|receipt| Arc::ptr_eq(receipt, &replacement))
        );
        sessions.close().await.unwrap();
        assert!(current.audio.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn cleanup_retries_after_failure_and_joins_an_inflight_retry() {
        let tasks = tokio_util::task::TaskTracker::new();
        let cleanup = TurnCleanup::default();
        assert!(
            cleanup
                .start(&tasks, async {
                    Err(ToolError::CleanupUnconfirmed(
                        "temporary transport loss".into(),
                    ))
                })
                .await
                .is_err()
        );
        let (release, released) = tokio::sync::oneshot::channel();
        let retry = cleanup.start(&tasks, async move {
            released.await.expect("original cleanup release");
            Ok(())
        });
        let joined = cleanup.start(&tasks, async {
            panic!("pending cleanup must be joined rather than replaced");
        });
        assert!(futures_util::poll!(Box::pin(retry.clone())).is_pending());
        release.send(()).unwrap();
        retry.await.unwrap();
        joined.await.unwrap();
        tasks.close();
        tasks.wait().await;
    }

    struct PreparedBrowserFixture {
        _directory: tempfile::TempDir,
        root: Arc<maka_event_log::RootStore>,
        store: maka_event_log::SessionStore,
        owner: Arc<Computer>,
        entry: Arc<Interaction>,
        epoch: Arc<Epoch>,
        gate: Arc<super::super::admission::Gate>,
        invocation: Invocation,
        basis: PermissionBasis,
    }

    impl PreparedBrowserFixture {
        async fn open() -> Self {
            use maka_agent_api::{
                contract::{Workspace, WorkspaceAccess, WorkspacePermissions},
                session::StoredSessionConfiguration,
            };
            use maka_agent_facts::workspace::BindingStamp;
            let directory = tempfile::tempdir().expect("private browser authority fixture");
            let workspace_path = directory.path().join("workspace");
            std::fs::create_dir(&workspace_path).expect("private fixture workspace");
            let private = directory.path().join("root");
            let control = directory.path().join("control");
            let root_owner = maka_event_log::root::RootOwner::create(
                &private,
                &maka_event_log::root::RootNamespaces {
                    ownership: directory.path().join("ownership"),
                    control: control.clone(),
                },
            )
            .expect("fixture Root owner");
            let root = Arc::new(
                maka_event_log::RootStore::open(Arc::new(root_owner))
                    .await
                    .expect("fixture Root store"),
            );
            let (path, directory_identity) = maka_fs_tools::directory::capture(&workspace_path)
                .expect("capture actual fixture workspace");
            let opened = maka_fs_tools::directory::open(&path, &directory_identity)
                .expect("open actual fixture workspace");
            let identity = maka_fs_tools::workspace::ensure_directory_identity(
                path.clone(),
                opened,
                private,
                control,
                None,
            )
            .await
            .expect("prepare actual fixture workspace identity");
            let workspace = Workspace {
                worktree: None,
                project_id: None,
                path: path.to_string_lossy().into_owned(),
                directory_identity,
                identity,
            };
            let binding = root
                .attach_workspace(
                    "fixture",
                    &serde_json::to_value(workspace).expect("serialize actual fixture workspace"),
                )
                .await
                .expect("actual fixture workspace binding");
            let store = root
                .create_session(
                    "browser-session",
                    "fixture",
                    &StoredSessionConfiguration {
                        parent_session_id: None,
                        backend: None,
                        collaboration_mode: maka_agent_facts::execution::CollaborationMode::Agent,
                        tools: None,
                        compaction_prompt: None,
                        title: "browser authority fixture".into(),
                        title_is_manual: false,
                        pinned: false,
                        labels: vec![],
                        workspace: binding,
                        permissions: WorkspacePermissions {
                            access: WorkspaceAccess::WorkspaceWrite,
                            request_permissions: false,
                        },
                        boundary_revision: 0,
                    },
                    1,
                )
                .await
                .expect("actual fixture Session");
            let basis = PermissionBasis {
                boundary_revision: 0,
                binding: BindingStamp {
                    id: binding.id,
                    permission_epoch: binding.permission_epoch_at_attach,
                },
            };
            let invocation = Invocation {
                session_id: "browser-session".into(),
                turn_id: "browser-turn".into(),
                run_id: "browser-run".into(),
                invocation_id: "browser-invocation".into(),
            };
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Message {
                                content: "browser authority fixture".into(),
                                request_fingerprint: None,
                                source_messages: vec![],
                            },
                        },
                    ))
                    .expect("fixture open event"),
                )
                .await
                .expect("commit actual fixture Turn");
            use maka_agent_facts::interaction::{
                Decision, InteractionOutcome, InteractionRecord, InteractionRequest,
            };
            store
                .establish_run_interaction(
                    &invocation,
                    &InteractionRecord {
                        session_id: invocation.session_id.clone(),
                        turn_id: invocation.turn_id.clone(),
                        run_id: invocation.run_id.clone(),
                        request_id: "browser-computer".into(),
                        created_at: 10,
                        request: InteractionRequest::ClientCapability {
                            tool_use_id: "browser-computer".into(),
                            basis: Some(basis),
                            target: api::target(),
                        },
                        outcome: None,
                    },
                )
                .await
                .unwrap();
            assert!(
                store
                    .commit_interaction_outcome(
                        "browser-computer",
                        InteractionOutcome::ClientCapabilityDecision {
                            decision: Decision::Allow,
                            committed_at: 20,
                        },
                    )
                    .await
                    .unwrap()
                    .matches
            );
            let tasks = tokio_util::task::TaskTracker::new();
            let owner = Arc::new(Computer {
                popup_provenance: None,
                store: root.clone(),
                configuration: Configuration::default(),
                sessions: Sessions::with_audio(false, tasks.clone()),
                resources: Arc::new(Resources::default()),
                stopping: CancellationToken::new(),
                tasks,
                origin: ToolOrigin::HostSdk {
                    package_id: "fixture".into(),
                    entry_id: "fixture".into(),
                    activation: "fixture".into(),
                    parent: None,
                },
            });
            let entry = owner
                .sessions
                .get(&invocation.session_id)
                .expect("fixture interaction");
            watch_turn(&owner, &entry, &invocation, Language::En)
                .await
                .expect("register actual Turn cleanup owner");
            let epoch = current_epoch(&entry).await;
            let gate = entry
                .kernel
                .lock()
                .await
                .as_ref()
                .expect("fixture current kernel")
                .admission
                .clone();
            Self {
                _directory: directory,
                root,
                store,
                owner,
                entry,
                epoch,
                gate,
                invocation,
                basis,
            }
        }

        async fn revoke_basis(&self) {
            use maka_agent_api::session::StoredSessionConfiguration;
            let current = self
                .store
                .get_session::<StoredSessionConfiguration>(&self.invocation.session_id)
                .await
                .expect("read actual Session")
                .expect("fixture Session exists");
            self.store
                .update_session_permissions(
                    &self.invocation.session_id,
                    current.revision,
                    30,
                    |configuration: &mut StoredSessionConfiguration| {
                        configuration.boundary_revision += 1;
                        Ok(())
                    },
                )
                .await
                .expect("commit actual basis revocation");
        }

        async fn close(self) {
            self.owner.stopping.cancel();
            self.owner
                .sessions
                .close()
                .await
                .expect("fixture native cleanup");
            self.owner
                .resources
                .settle()
                .await
                .expect("actual original cleanup tickets");
            self.owner.tasks.close();
            self.owner.tasks.wait().await;
            self.root.shutdown().await.expect("fixture Root shutdown");
        }
    }

    async fn preparation_cleanup_started(receipt: &BrowserPreparationReceipt) -> Retirement {
        let mut registered_cleanup = None;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let cleanup = receipt
                    .cleanup
                    .pending
                    .lock()
                    .expect("fixture cleanup lock")
                    .clone();
                if let Some(cleanup) = cleanup {
                    registered_cleanup = Some(cleanup);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("idle revocation must retain the original cleanup future");
        registered_cleanup.expect("captured original cleanup registration")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn idle_browser_basis_revoke_seals_producer_and_waits_for_original_native_cleanup() {
        use futures_util::poll;
        let fixture = PreparedBrowserFixture::open().await;
        // Holding the real Session guard delays its actual cleanup; no browser
        // protocol, Chrome installation or physical hook result is fabricated.
        let native = fixture.epoch.native.lock().await;
        fixture
            .epoch
            .record_browser_preparation(
                fixture.basis,
                &fixture.invocation.turn_id,
                fixture.gate.clone(),
            )
            .expect("record admitted preparation");
        fixture
            .epoch
            .record_browser_preparation(
                fixture.basis,
                &fixture.invocation.turn_id,
                fixture.gate.clone(),
            )
            .expect("same actual owner is idempotent");
        let receipt = {
            let receipts = fixture
                .epoch
                .browser_preparations
                .lock()
                .expect("fixture receipts");
            assert_eq!(
                receipts.len(),
                1,
                "repeated checks do not create cleanup workers"
            );
            receipts[0].clone()
        };
        watch(&fixture.owner);
        fixture.revoke_basis().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture.gate.wait_closed(),
        )
        .await
        .expect("catalog revocation must fence idle page-event producers");
        let cleanup = preparation_cleanup_started(&receipt).await;
        let mut observation = Box::pin(cleanup.clone());
        assert!(
            poll!(&mut observation).is_pending(),
            "a native lock is not a successful cleanup receipt"
        );
        assert!(
            !fixture
                .epoch
                .browser_preparations
                .lock()
                .expect("fixture receipts")
                .is_empty(),
            "cleanup responsibility remains until the real future terminates"
        );
        assert!(
            matches!(
                fixture
                    .owner
                    .sessions
                    .state(&fixture.invocation.session_id)
                    .await,
                ReplState::ResetRequired
            ),
            "a sealed prepared VM must not report Ready"
        );
        fixture.owner.stopping.cancel();
        let mut settlement = Box::pin(fixture.owner.resources.settle());
        assert!(
            poll!(&mut settlement).is_pending(),
            "original cleanup tickets outlive their observer"
        );
        drop(native);
        observation
            .await
            .expect("actual native cleanup after guard release");
        settlement
            .await
            .expect("original resource settlement after native termination");
        assert!(
            fixture
                .epoch
                .browser_preparations
                .lock()
                .expect("fixture receipts")
                .is_empty()
        );
        fixture.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn old_prepared_vm_retirement_does_not_finish_the_new_vm_in_the_same_turn() {
        let fixture = PreparedBrowserFixture::open().await;
        fixture
            .epoch
            .record_browser_preparation(
                fixture.basis,
                &fixture.invocation.turn_id,
                fixture.gate.clone(),
            )
            .expect("old prepared VM");
        let old_native = fixture.epoch.native.lock().await;
        let old_kernel = fixture
            .entry
            .kernel
            .lock()
            .await
            .take()
            .expect("old actual kernel");
        fixture
            .entry
            .retire_kernel(&fixture.owner, old_kernel)
            .unwrap_or_else(|(error, _)| panic!("retire old actual VM: {error}"));
        let new_kernel = fixture.entry.fresh_kernel().expect("new actual VM binding");
        let new_epoch = new_kernel.epoch.clone();
        let new_gate = new_kernel.admission.clone();
        *fixture.entry.kernel.lock().await = Some(new_kernel);
        new_epoch
            .record_browser_preparation(
                fixture.basis,
                &fixture.invocation.turn_id,
                new_gate.clone(),
            )
            .expect("new prepared VM in same logical Turn");
        let old_receipt = fixture
            .epoch
            .browser_preparations
            .lock()
            .expect("old receipts")[0]
            .clone();
        watch(&fixture.owner);
        let mut registered_observation = None;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let observation = old_receipt
                    .observation
                    .lock()
                    .expect("old VM observation lock")
                    .clone();
                if let Some(observation) = observation {
                    registered_observation = Some(observation);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retain the actual old-VM observer");
        let observation = registered_observation.expect("captured original old-VM observation");
        assert!(
            new_gate.check_open().is_ok(),
            "old VM retirement must not seal the replacement producer"
        );
        assert!(
            old_receipt
                .cleanup
                .pending
                .lock()
                .expect("actual Turn cleanup")
                .is_none(),
            "VM retirement must not start the shared whole-Turn cleanup"
        );
        drop(old_native);
        let retired = fixture
            .epoch
            .retirement
            .lock()
            .expect("actual old retirement")
            .clone()
            .expect("original retirement was retained");
        retired.await.expect("actual old VM close");
        observation
            .await
            .expect("actual observer also completes before checking replacement VM");
        assert!(new_gate.check_open().is_ok());
        assert_eq!(
            new_epoch
                .browser_preparations
                .lock()
                .expect("new receipts")
                .len(),
            1,
            "exact epoch retirement preserves new preparation responsibility"
        );
        fixture.close().await;
    }
}
