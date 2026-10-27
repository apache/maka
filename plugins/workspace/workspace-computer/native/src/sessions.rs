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
struct TurnCleanup {
    pending: Mutex<Option<Retirement>>,
}

impl TurnCleanup {
    fn start(
        &self,
        tasks: &tokio_util::task::TaskTracker,
        work: impl std::future::Future<Output = Result<(), ToolError>> + Send + 'static,
    ) -> Retirement {
        let mut pending = self.pending.lock().unwrap();
        if let Some(pending) = pending.as_ref() {
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

/// Actual physical resources of one VM binding. The list of these owners
/// preserves custody and revocation coverage; it is not a permission cache.
pub(super) struct Epoch {
    pub id: String,
    pub native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    audio: Mutex<Option<Arc<AudioReceipt>>>,
    browser_preparations: Mutex<Vec<Arc<BrowserPreparationReceipt>>>,
    turns: Arc<Mutex<BTreeMap<String, Arc<TurnCleanup>>>>,
    effects_changed: Arc<tokio::sync::Notify>,
    retirement: Mutex<Option<Retirement>>,
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
        if entries.len() >= 16 {
            return Err(failed(
                "Computer Use session capacity reached; retire an unused Session",
            ));
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
    let weak = Arc::downgrade(owner);
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
        if result.is_err() {
            entry.retiring.cancel();
            if let Some(owner) = weak.upgrade() {
                owner.stopping.cancel();
            }
        }
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
            if result.is_err() {
                entry.retiring.cancel();
                owner.stopping.cancel();
            }
            result?;
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
        let result = self.native.lock().await.close_native().await;
        if result.is_ok() {
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
        let mut failures = Vec::new();
        if let Some(runtime) = self.repl
            && let Err(error) = runtime.close().await
        {
            failures.push(format!("JavaScript runtime cleanup failed: {error}"));
        }
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
            id: native.native_epoch().to_string(),
            native: Arc::new(tokio::sync::Mutex::new(native)),
            audio: Default::default(),
            browser_preparations: Default::default(),
            turns: self.turns.clone(),
            effects_changed: self.effects_changed.clone(),
            retirement: Default::default(),
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
        let weak = Arc::downgrade(owner);
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
            if result.is_ok() {
                if let Some(entry) = entry.upgrade() {
                    entry
                        .epochs
                        .lock()
                        .unwrap()
                        .retain(|current| !Arc::ptr_eq(current, &retired));
                }
            } else {
                if let Some(entry) = entry.upgrade() {
                    entry.retiring.cancel();
                }
                if let Some(owner) = weak.upgrade() {
                    owner.stopping.cancel();
                }
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
            if let Some(closing) = closed.as_ref() {
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
        let native_owner = self.native_owner.clone();
        let session = session.to_owned();
        let turn = turn.to_owned();
        let cleanup_owner = cleanup.clone();
        cleanup.start(&self.tasks, async move {
            let mut failures = Vec::new();
            for epoch in &epochs {
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
        if observation.is_some() {
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
            if result.is_err() {
                entry.retiring.cancel();
                owner.stopping.cancel();
            }
            ticket.complete(result.clone().map_err(message));
            result
        });
        *observation = Some(
            async move {
                task.await.map_err(|error| {
                    ToolError::CleanupUnconfirmed(format!(
                        "Browser cleanup observer disappeared: {error}",
                    ))
                })?
            }
            .boxed()
            .shared(),
        );
        Ok(())
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
        if let Some(retirement) = retirement {
            return retirement.await;
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
        if let Some(retirement) = retirement {
            drop(current);
            return retirement.await;
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

    async fn close_owned(&self) -> Result<(), ToolError> {
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
            let retirement = epoch.retirement.lock().unwrap().clone();
            if let Some(retirement) = retirement {
                if let Err(error) = retirement.await {
                    failures.push(message(error));
                }
            } else {
                match epoch.close_native().await {
                    Ok(()) => {
                        epoch.clear_audio();
                        self.epochs
                            .lock()
                            .unwrap()
                            .retain(|current| !Arc::ptr_eq(current, &epoch));
                    }
                    Err(error) => failures.push(message(error)),
                }
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
                if !matches!(valid, Ok(true)) {
                    let Ok(mut ticket) = owner.resources.reserve() else {
                        return;
                    };
                    ticket.start();
                    let result = owner.sessions.retire(&id, &entry).await.map_err(message);
                    let failed = result.is_err();
                    if failed {
                        entry.retiring.cancel();
                        owner.stopping.cancel();
                    }
                    ticket.complete(result);
                    if failed {
                        return;
                    }
                    continue;
                }
                let epochs = entry.epochs.lock().unwrap().clone();
                for epoch in epochs {
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
                        if entry
                            .observe_browser_cleanup(&owner, &id, &epoch, &receipt, observed)
                            .is_err()
                        {
                            entry.retiring.cancel();
                            owner.stopping.cancel();
                            return;
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
                    let failed = result.is_err();
                    if failed {
                        entry.retiring.cancel();
                        owner.stopping.cancel();
                    }
                    ticket.complete(result);
                    if failed {
                        return;
                    }
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
    use maka_agent_facts::event::{
        EventWrite, Fact, InvocationInput, InvocationOutcome, RuntimeEvent,
    };
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_turn_watcher_observes_the_original_cleanup_without_stopping_a_new_capture() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let sessions = Sessions::default();
            let entry = sessions.get("turn-custody").unwrap();
            let cleanup = Arc::new(TurnCleanup::default());
            entry
                .turns
                .lock()
                .unwrap()
                .insert("turn-a".into(), cleanup.clone());
            let current_capture = Arc::new(AtomicUsize::new(1));
            let cleanup_count = Arc::new(AtomicUsize::new(0));
            let watcher_ready = CancellationToken::new();
            let release_watcher = CancellationToken::new();
            let late_watcher = {
                let cleanup = cleanup.clone();
                let current_capture = current_capture.clone();
                let cleanup_count = cleanup_count.clone();
                let watcher_ready = watcher_ready.clone();
                let release_watcher = release_watcher.clone();
                let tasks = entry.tasks.clone();
                tokio::spawn(async move {
                    watcher_ready.cancel();
                    release_watcher.cancelled().await;
                    cleanup
                        .start(&tasks, async move {
                            cleanup_count.fetch_add(1, Ordering::SeqCst);
                            current_capture.store(0, Ordering::SeqCst);
                            Ok(())
                        })
                        .await
                })
            };
            watcher_ready.cancelled().await;
            let draining = {
                let current_capture = current_capture.clone();
                let cleanup_count = cleanup_count.clone();
                cleanup.start(&entry.tasks, async move {
                    cleanup_count.fetch_add(1, Ordering::SeqCst);
                    current_capture.store(0, Ordering::SeqCst);
                    Ok(())
                })
            };
            let drained = draining.await;
            entry.release_turn("turn-a", &cleanup, &drained);
            drained.unwrap();
            assert!(!entry.turns.lock().unwrap().contains_key("turn-a"));
            current_capture.store(2, Ordering::SeqCst);
            let replacement = Arc::new(TurnCleanup::default());
            entry
                .turns
                .lock()
                .unwrap()
                .insert("turn-b".into(), replacement.clone());
            release_watcher.cancel();
            late_watcher.await.unwrap().unwrap();
            assert_eq!(cleanup_count.load(Ordering::SeqCst), 1);
            assert_eq!(current_capture.load(Ordering::SeqCst), 2);
            assert!(
                entry
                    .turns
                    .lock()
                    .unwrap()
                    .get("turn-b")
                    .is_some_and(|current| Arc::ptr_eq(current, &replacement))
            );
            entry.tasks.close();
            entry.tasks.wait().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn turn_cleanup_observers_retain_the_first_failure_without_retrying() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let sessions = Sessions::default();
            let entry = sessions.get("failed-turn-custody").unwrap();
            let cleanup = Arc::new(TurnCleanup::default());
            entry
                .turns
                .lock()
                .unwrap()
                .insert("turn-a".into(), cleanup.clone());
            let tasks = entry.tasks.clone();
            let started = CancellationToken::new();
            let release = CancellationToken::new();
            let attempts = Arc::new(AtomicUsize::new(0));
            let error =
                ToolError::CleanupUnconfirmed("fixture original turn cleanup failure".into());
            let expected = error.to_string();
            let first = {
                let attempts = attempts.clone();
                let started = started.clone();
                let release = release.clone();
                cleanup.start(&tasks, async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    started.cancel();
                    release.cancelled().await;
                    Err(error)
                })
            };
            started.cancelled().await;
            let second = {
                let attempts = attempts.clone();
                cleanup.start(&tasks, async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            };
            release.cancel();
            let (first, second) = tokio::join!(first, second);
            entry.release_turn("turn-a", &cleanup, &first);
            assert!(
                entry
                    .turns
                    .lock()
                    .unwrap()
                    .get("turn-a")
                    .is_some_and(|current| Arc::ptr_eq(current, &cleanup))
            );
            assert_eq!(first.unwrap_err().to_string(), expected);
            assert_eq!(second.unwrap_err().to_string(), expected);
            let late = {
                let attempts = attempts.clone();
                cleanup.start(&tasks, async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            };
            assert_eq!(late.await.unwrap_err().to_string(), expected);
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
            tasks.close();
            tasks.wait().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_turn_cleanup_observation_keeps_the_original_worker_and_result() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let cleanup = Arc::new(TurnCleanup::default());
            let tasks = tokio_util::task::TaskTracker::new();
            let started = CancellationToken::new();
            let release = CancellationToken::new();
            let completed = Arc::new(AtomicUsize::new(0));
            let observer = {
                let cleanup = cleanup.clone();
                let tasks = tasks.clone();
                let started = started.clone();
                let release = release.clone();
                let completed = completed.clone();
                tokio::spawn(async move {
                    cleanup
                        .start(&tasks, async move {
                            started.cancel();
                            release.cancelled().await;
                            completed.fetch_add(1, Ordering::SeqCst);
                            Ok(())
                        })
                        .await
                })
            };
            started.cancelled().await;
            observer.abort();
            assert!(observer.await.unwrap_err().is_cancelled());
            assert_eq!(completed.load(Ordering::SeqCst), 0);
            release.cancel();
            tasks.close();
            tasks.wait().await;
            assert_eq!(completed.load(Ordering::SeqCst), 1);
            let observed = cleanup
                .start(&tasks, async {
                    Err(ToolError::CleanupUnconfirmed(
                        "replacement cleanup must never run".into(),
                    ))
                })
                .await;
            assert!(observed.is_ok());
        })
        .await
        .unwrap();
    }

    async fn approved(
        store: &maka_event_log::SessionStore,
        invocation: &Invocation,
        id: &str,
        target: maka_agent_facts::interaction::GrantTarget,
        basis: PermissionBasis,
    ) {
        use maka_agent_facts::interaction::{
            Decision, InteractionOutcome, InteractionRecord, InteractionRequest,
        };
        store
            .establish_run_interaction(
                invocation,
                &InteractionRecord {
                    session_id: invocation.session_id.clone(),
                    turn_id: invocation.turn_id.clone(),
                    run_id: invocation.run_id.clone(),
                    request_id: id.into(),
                    created_at: 10,
                    request: InteractionRequest::ClientCapability {
                        tool_use_id: id.into(),
                        basis: Some(basis),
                        target,
                    },
                    outcome: None,
                },
            )
            .await
            .unwrap();
        assert!(
            store
                .commit_interaction_outcome(
                    id,
                    InteractionOutcome::ClientCapabilityDecision {
                        decision: Decision::Allow,
                        committed_at: 20,
                    }
                )
                .await
                .unwrap()
                .matches
        );
    }

    async fn current_epoch(entry: &Interaction) -> Arc<Epoch> {
        let mut kernel = entry.kernel.lock().await;
        if kernel.is_none() {
            *kernel = Some(entry.fresh_kernel().unwrap());
        }
        kernel.as_ref().unwrap().epoch.clone()
    }

    async fn audio_cleared(epoch: &Epoch) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while epoch.audio.lock().unwrap().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("idle revocation must discard owned audio");
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn final_close_joins_the_original_worker_before_discarding_a_late_start_receipt() {
        use maka_agent_facts::tools::{ToolExecutor, ToolFuture};
        use maka_code_runtime::{CellContext, CellLimits, CellResult, CellStore};
        use std::time::Duration;

        struct Start {
            epoch: Arc<Epoch>,
            admission: Arc<super::super::admission::Gate>,
            started: CancellationToken,
            release: CancellationToken,
            basis: PermissionBasis,
            fail: bool,
        }
        impl ToolExecutor for Start {
            fn names(&self) -> Vec<String> {
                vec!["fixture_start".into()]
            }
            fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
                // This held fixture stands for an already admitted start; the
                // journal admission contract is tested against SQLite separately.
                let receipt = self.admission.register().unwrap();
                receipt.agent_dispatched();
                self.started.cancel();
                let epoch = self.epoch.clone();
                let release = self.release.clone();
                let basis = self.basis;
                let fail = self.fail;
                Box::pin(async move {
                    release.cancelled().await;
                    epoch.record_audio(basis, true);
                    if fail {
                        Err(ToolError::Persistence("fixture late T2 failure".into()))
                    } else {
                        Ok(json!({"recording":true}))
                    }
                })
            }
        }

        tokio::time::timeout(Duration::from_secs(10), async {
            for (already_retired, cancel_before_observation, late_failure) in [
                (false, false, false),
                (true, false, false),
                (false, true, false),
                (false, false, true),
                (true, false, true),
                (false, true, true),
            ] {
                let directory = tempfile::tempdir().unwrap();
                let root_owner = maka_event_log::root::RootOwner::create(
                    &directory.path().join("root"),
                    &maka_event_log::root::RootNamespaces {
                        ownership: directory.path().join("ownership"),
                        control: directory.path().join("control"),
                    },
                )
                .unwrap();
                let store = Arc::new(
                    maka_event_log::RootStore::open(Arc::new(root_owner))
                        .await
                        .unwrap(),
                );
                let tasks = tokio_util::task::TaskTracker::new();
                let owner = Arc::new(Computer {
                popup_provenance: None,
                    store: store.clone(),
                    configuration: Configuration {
                        audio: true,
                        ..Default::default()
                    },
                    sessions: Sessions::with_audio(true, tasks.clone()),
                    resources: Arc::default(),
                    stopping: CancellationToken::new(),
                    tasks,
                    origin: ToolOrigin::HostSdk {
                        package_id: "fixture".into(),
                        entry_id: "fixture".into(),
                        activation: "fixture".into(),
                        parent: None,
                    },
                });
                let entry = owner.sessions.get("session").unwrap();
                let mut old = entry.fresh_kernel().unwrap();
                old.repl = Some(Repl::new_observed(
                    "Object.defineProperty(globalThis, 'start', { value: async () => {\n\
                        const result = await call('fixture_start', {});\n\
                        if (!result.ok) throw Error(result.error.message);\n\
                        return result.value;\n\
                    }});",
                    CellLimits::default(),
                    old.admission.clone(),
                ).unwrap());
                let epoch = old.epoch.clone();
                let started = CancellationToken::new();
                let release = CancellationToken::new();
                let _release_on_panic = release.clone().drop_guard();
                let result = old
                    .repl
                    .as_ref()
                    .unwrap()
                    .evaluate(
                        "await start()".into(),
                        Arc::new(Start {
                            epoch: epoch.clone(),
                            admission: old.admission.clone(),
                            started: started.clone(),
                            release: release.clone(),
                            basis: PermissionBasis {
                                boundary_revision: 0,
                                binding: maka_agent_facts::workspace::BindingStamp {
                                    id: uuid::Uuid::new_v4(),
                                    permission_epoch: 0,
                                },
                            },
                            fail: late_failure,
                        }),
                        CancellationToken::new(),
                        CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap(),
                        Duration::from_millis(100),
                    )
                    .await
                    .unwrap();
                assert!(started.is_cancelled(),
                    "accepted start was not entered (retired={already_retired}, cancel_before_observation={cancel_before_observation}, late_failure={late_failure}): {result:?}");
                assert!(matches!(result, CellResult::Failure { .. }), "{result:?}");
                assert!(epoch.audio.lock().unwrap().is_none());
                if already_retired {
                    entry
                        .retire_kernel(&owner, old)
                        .unwrap_or_else(|(error, _)| panic!("{error}"));
                    let current = entry.fresh_kernel().unwrap();
                    assert_ne!(epoch.id, current.epoch.id);
                    *entry.kernel.lock().await = Some(current);
                } else if cancel_before_observation {
                    let cancellation = CancellationToken::new();
                    cancellation.cancel();
                    let mut closing = entry
                        .spawn_kernel(&owner, old, cancellation)
                        .unwrap_or_else(|(error, _)| panic!("{error}"));
                    assert!(futures_util::poll!(&mut closing).is_pending());
                    drop(closing);
                    // The original retirement already transferred the exact worker;
                    // even an unobserved result remains joinable by final close.
                    assert!(
                        entry
                            .epochs
                            .lock()
                            .unwrap()
                            .iter()
                            .any(|retained| Arc::ptr_eq(retained, &epoch))
                    );
                } else {
                    *entry.kernel.lock().await = Some(old);
                }
                let mut closing = Box::pin(entry.close());
                assert!(futures_util::poll!(&mut closing).is_pending());
                assert!(entry.retiring.is_cancelled());
                assert!(epoch.audio.lock().unwrap().is_none());
                drop(closing);
                let mut closing = Box::pin(entry.close());
                assert!(futures_util::poll!(&mut closing).is_pending());
                release.cancel();
                let closed = closing.await;
                if late_failure {
                    assert!(
                        closed
                            .unwrap_err()
                            .to_string()
                            .contains("fixture late T2 failure")
                    );
                    assert!(
                        entry
                            .close()
                            .await
                            .unwrap_err()
                            .to_string()
                            .contains("fixture late T2 failure")
                    );
                } else {
                    closed.unwrap();
                }
                assert!(epoch.audio.lock().unwrap().is_none());
                if !late_failure {
                    assert!(entry.epochs.lock().unwrap().is_empty());
                }
                owner.tasks.close();
                let _ = owner.resources.settle().await;
                owner.tasks.wait().await;
                assert_eq!(owner.sessions.close().await.is_err(), late_failure);
                drop(entry);
                drop(owner);
                store.shutdown().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn idle_revocation_discards_audio_without_retiring_the_session() {
        use maka_agent_api::{
            contract::{WorkspaceAccess, WorkspacePermissions},
            session::StoredSessionConfiguration,
        };
        use maka_agent_facts::workspace::BindingStamp;
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
        let binding = root
            .attach_workspace("fixture", &json!({"path":directory.path()}))
            .await
            .unwrap();
        let store = root
            .create_session(
                "session",
                "fixture",
                &StoredSessionConfiguration {
                    backend: None,
                    collaboration_mode: maka_agent_facts::execution::CollaborationMode::Agent,
                    tools: None,
                    title: "fixture".into(),
                    title_is_manual: false,
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
            .unwrap();
        let basis = PermissionBasis {
            boundary_revision: 0,
            binding: BindingStamp {
                id: binding.id,
                permission_epoch: binding.permission_epoch_at_attach,
            },
        };
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
                            content: "fixture".into(),
                            request_fingerprint: None,
                            source_messages: vec![],
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        approved(&store, &invocation, "computer", api::target(), basis).await;
        let ordinary = AudioReceipt {
            basis,
            requires_audio_consent: false,
        };
        let mac = AudioReceipt {
            basis,
            requires_audio_consent: true,
        };
        assert!(audio_current(&root, "session", &ordinary).await.unwrap());
        assert!(
            !audio_current(&root, "session", &mac).await.unwrap(),
            "Computer Use alone cannot authorize Mac audio"
        );
        approved(&store, &invocation, "audio", api::audio_target(), basis).await;
        assert!(audio_current(&root, "session", &mac).await.unwrap());

        let tasks = tokio_util::task::TaskTracker::new();
        let owner = Arc::new(Computer {
            popup_provenance: None,
            store: root.clone(),
            configuration: Configuration {
                audio: true,
                ..Default::default()
            },
            sessions: Sessions::with_audio(true, tasks.clone()),
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
        let entry = owner.sessions.get("session").unwrap();
        let epoch = current_epoch(&entry).await;
        let retired_kernel = entry.fresh_kernel().unwrap();
        let retired_epoch = retired_kernel.epoch.clone();
        {
            let _native = epoch.native.lock().await;
            epoch.record_audio(basis, true);
        }
        {
            let _native = retired_epoch.native.lock().await;
            retired_epoch.record_audio(basis, true);
        }
        watch(&owner);
        let mut changes = root.subscribe_catalog_changes();
        changes.borrow_and_update();
        let current = store
            .get_session::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap();
        store
            .update_session_permissions(
                "session",
                current.revision,
                30,
                |configuration: &mut StoredSessionConfiguration| {
                    configuration.boundary_revision += 1;
                    Ok(())
                },
            )
            .await
            .unwrap();
        changes.changed().await.unwrap();
        assert!(!audio_current(&root, "session", &ordinary).await.unwrap());
        assert!(!audio_current(&root, "session", &mac).await.unwrap());
        audio_cleared(&epoch).await;
        audio_cleared(&retired_epoch).await;
        assert!(!entry.retiring.is_cancelled());
        assert!(Arc::ptr_eq(&owner.sessions.get("session").unwrap(), &entry));

        // Registration can happen after the catalog revoke was consumed by
        // the watch. No further store event is needed to clear this receipt.
        {
            let _native = epoch.native.lock().await;
            epoch.record_audio(basis, true);
        }
        {
            let _native = retired_epoch.native.lock().await;
            retired_epoch.record_audio(basis, true);
        }
        audio_cleared(&epoch).await;
        audio_cleared(&retired_epoch).await;
        assert!(!entry.retiring.is_cancelled());
        assert!(!owner.stopping.is_cancelled());
        entry
            .retire_kernel(&owner, retired_kernel)
            .unwrap_or_else(|(error, _)| panic!("{error}"));
        owner.stopping.cancel();
        owner.tasks.close();
        owner.sessions.close().await.unwrap();
        owner.resources.settle().await.unwrap();
        owner.tasks.wait().await;
        drop(owner);
        root.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn queued_cleanup_preserves_a_new_audio_start_with_the_same_basis() {
        let sessions = Sessions::with_audio(true, Default::default());
        let entry = sessions.get("session").unwrap();
        let epoch = current_epoch(&entry).await;
        let basis = PermissionBasis {
            boundary_revision: 0,
            binding: maka_agent_facts::workspace::BindingStamp {
                id: uuid::Uuid::new_v4(),
                permission_epoch: 0,
            },
        };
        let native = epoch.native.lock().await;
        epoch.record_audio(basis, false);
        let previous = epoch.audio.lock().unwrap().clone().unwrap();
        let (attempted, waiting) = tokio::sync::oneshot::channel();
        let queued = tokio::spawn({
            let epoch = epoch.clone();
            async move {
                attempted.send(()).unwrap();
                epoch.discard_audio_if_current(&previous).await
            }
        });
        waiting.await.unwrap();
        epoch.record_audio(basis, false);
        let current = epoch.audio.lock().unwrap().clone().unwrap();
        drop(native);
        assert!(!queued.await.unwrap().unwrap());
        assert!(
            epoch
                .audio
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|receipt| Arc::ptr_eq(receipt, &current))
        );
        assert!(!entry.retiring.is_cancelled());
        assert!(epoch.discard_audio_if_current(&current).await.unwrap());
        assert!(epoch.audio.lock().unwrap().is_none());
        sessions.close().await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_follows_the_exact_canonical_turn_instead_of_the_session_tip() {
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
        let selected = Invocation {
            session_id: "session".into(),
            turn_id: "selected".into(),
            run_id: "selected-run".into(),
            invocation_id: "selected-invocation".into(),
        };
        let unrelated = Invocation {
            session_id: "session".into(),
            turn_id: "unrelated".into(),
            run_id: "unrelated-run".into(),
            invocation_id: "unrelated-invocation".into(),
        };
        let opened = |invocation: &Invocation| {
            EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        content: "fixture".into(),
                        request_fingerprint: None,
                        source_messages: Vec::new(),
                    },
                },
            ))
            .unwrap()
        };
        store.append(&opened(&selected)).await.unwrap();
        assert!(!turn_ended(&store, "session", "selected").await.unwrap());
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    selected,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        store.append(&opened(&unrelated)).await.unwrap();
        assert!(turn_ended(&store, "session", "selected").await.unwrap());
        assert!(!turn_ended(&store, "session", "unrelated").await.unwrap());
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    unrelated,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Cancelled {
                            source: "fixture".into(),
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert!(turn_ended(&store, "session", "unrelated").await.unwrap());
        assert!(matches!(
            turn_ended(&store, "session", "unknown").await,
            Err(ToolError::CleanupUnconfirmed(message)) if message == "Computer turn lifetime is unavailable"
        ));
        root.close().await.unwrap();
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
                        backend: None,
                        collaboration_mode: maka_agent_facts::execution::CollaborationMode::Agent,
                        tools: None,
                        title: "browser authority fixture".into(),
                        title_is_manual: false,
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
            approved(
                &store,
                &invocation,
                "browser-computer",
                api::target(),
                basis,
            )
            .await;
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
    async fn late_preparation_registration_rechecks_revocation_without_another_agent_call() {
        let fixture = PreparedBrowserFixture::open().await;
        let (scanned, mut scans) = tokio::sync::mpsc::unbounded_channel();
        watch_scanned(&fixture.owner, move || {
            let _ = scanned.send(());
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), scans.recv())
            .await
            .expect("initial watcher scan")
            .expect("watcher remains live");
        fixture.revoke_basis().await;
        tokio::time::timeout(std::time::Duration::from_secs(5), scans.recv())
            .await
            .expect("watcher consumes the original revoke commit")
            .expect("watcher remains live");
        let native = fixture.epoch.native.lock().await;
        fixture
            .epoch
            .record_browser_preparation(
                fixture.basis,
                &fixture.invocation.turn_id,
                fixture.gate.clone(),
            )
            .expect("retain prior admission responsibility");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture.gate.wait_closed(),
        )
        .await
        .expect("receipt notification must recheck the already changed authority");
        let receipt = fixture
            .epoch
            .browser_preparations
            .lock()
            .expect("fixture receipts")[0]
            .clone();
        let cleanup = preparation_cleanup_started(&receipt).await;
        assert!(
            fixture
                .epoch
                .record_browser_preparation(
                    fixture.basis,
                    &fixture.invocation.turn_id,
                    fixture.gate.clone()
                )
                .is_err(),
            "revocation must reject another preparation before native dispatch"
        );
        drop(native);
        cleanup.await.expect("actual retained native cleanup");
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
