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

//! The Host's scheduled tasks, as the page and the sidebar show them,
//! after Desktop's Scheduled Tasks controller
//! (apps/desktop/src/renderer/features/module-hub/controller/use-scheduled-tasks-controller.ts),
//! the preload calls it goes through (`listScheduledTasks` and
//! `mutateScheduledTask` in apps/desktop/src/preload/preload.ts), and the
//! main process's change subscription
//! (`subscribeScheduledTaskChanges` in apps/desktop/src/main/runtime-host-boot.ts).

use std::collections::HashSet;

use gpui_kit::{App, Context, Entity, EventEmitter, SharedString, Subscription, Task};
use host_protocol::{
    ChangeNotice, HostOperationErrorCode, PushFrame, SCHEDULED_TASK_CATALOG_MAX_ITEMS,
    ScheduledTask, ScheduledTaskChangedReason, ScheduledTaskEffect, ScheduledTaskMutate,
    ScheduledTaskMutateInput, ScheduledTaskNotify, ScheduledTaskQuery, ScheduledTaskQueryInput,
    ScheduledTaskQueryResult, ScheduledTaskStatus,
};
use shared::copy::Text;
use shared::copy::automations as copy;
use workspace::{HostRequestError, HostRequester, HostSession, HostSessionEvent};

/// How often a listing is read again from its first page after the
/// catalog changed under it (`listScheduledTasks`' three attempts).
const READ_ATTEMPTS: usize = 3;

/// A snooze's delay: ten minutes (Desktop's `snooze`).
pub const SNOOZE_DELAY_MS: u64 = 10 * 60 * 1000;

/// The Host's words when a notification's fire waits for a client that
/// delivers it (`ScheduledTaskNativeUnavailableError` in
/// packages/runtime-host/src/server/scheduled-task-coordinator.ts).
const NATIVE_DELIVERY_WAITING: &str = "waiting for a Desktop provider";

/// The Host's code for a create refused in incognito mode
/// (`SCHEDULED_TASK_INCOGNITO_ACTIVE`).
const INCOGNITO_ACTIVE: &str = "SCHEDULED_TASK_INCOGNITO_ACTIVE";

/// A failed read or change: its title (Desktop's toast title) and what
/// the page says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct ActionFailure {
    pub title: Text,
    pub reason: Text,
}

impl ActionFailure {
    pub fn new(title: Text, reason: Text) -> Self {
        Self { title, reason }
    }
}

/// What the catalog announces.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ScheduledTasksEvent {
    /// A task fired whose effect this client should announce (an Agent
    /// run, a resumed task, a bot message; Desktop's own native effect
    /// announces a local notification), by id and title.
    Fired { task_id: SharedString, title: SharedString },
}

/// One change to a task, as the page asks for it.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskChange {
    SetEnabled(bool),
    TriggerNow,
    Snooze,
    ClearHistory,
    Delete,
}

impl TaskChange {
    fn input(&self, task_id: String) -> ScheduledTaskMutateInput {
        match self {
            Self::SetEnabled(true) => ScheduledTaskMutateInput::Resume { task_id },
            Self::SetEnabled(false) => ScheduledTaskMutateInput::Pause { task_id },
            Self::TriggerNow => ScheduledTaskMutateInput::TriggerNow { task_id },
            Self::Snooze => ScheduledTaskMutateInput::Snooze { task_id, delay_ms: SNOOZE_DELAY_MS },
            Self::ClearHistory => ScheduledTaskMutateInput::ClearHistory { task_id },
            Self::Delete => ScheduledTaskMutateInput::Delete { task_id },
        }
    }

    /// Desktop's failure title and fallback for the change.
    fn failure(&self) -> (Text, Text) {
        match self {
            Self::SetEnabled(_) => (copy::UPDATE_FAILED, copy::UPDATE_FALLBACK),
            Self::TriggerNow => (copy::TRIGGER_FAILED, copy::TRIGGER_FALLBACK),
            Self::Snooze => (copy::SNOOZE_FAILED, copy::SNOOZE_FALLBACK),
            Self::ClearHistory => (copy::CLEAR_FAILED, copy::CLEAR_FALLBACK),
            Self::Delete => (copy::DELETE_FAILED, copy::DELETE_FALLBACK),
        }
    }

    /// Whether the change drops a fire held for a delivery service (the
    /// coordinator's `cancelWaitingNativeFire`).
    fn cancels_held_fire(&self) -> bool {
        matches!(self, Self::SetEnabled(false) | Self::Snooze | Self::Delete)
    }
}

/// Behavior owner of the scheduled tasks for one window: the catalog, read
/// whole (every page at the first page's revision, again from the start
/// when it changes between pages) on every new connection and whenever the
/// Host says it changed, and every change the page makes to it. A change
/// reads the catalog again once it is committed; its task resolves after
/// that read, so the page shows the result with the change.
///
/// It also keeps which notification fires wait for Maka Desktop's delivery
/// service because a Trigger now could not deliver them, until the task
/// fires, fails, or is changed in a way that drops the fire.
pub struct ScheduledTasks {
    host: Entity<HostSession>,
    /// The catalog as last read, in the Host's order; `None` until read.
    tasks: Option<Vec<ScheduledTask>>,
    loading: bool,
    error: Option<ActionFailure>,
    /// Bumped by every read; a result for an older one is dropped.
    generation: u64,
    /// A change arrived while a read was in flight: read again after it.
    stale: bool,
    /// Tasks whose fire the Host holds for a delivery service.
    held: HashSet<String>,
    _read: Option<Task<()>>,
    _fired: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ScheduledTasksEvent> for ScheduledTasks {}

impl std::fmt::Debug for ScheduledTasks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScheduledTasks")
            .field("tasks", &self.tasks.as_ref().map(Vec::len))
            .field("loading", &self.loading)
            .finish_non_exhaustive()
    }
}

impl ScheduledTasks {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| match event {
                HostSessionEvent::Connected { host_changed } => {
                    if *host_changed {
                        this.held.clear();
                    }
                    this.reload(cx);
                }
                HostSessionEvent::Push(frame) => {
                    if let PushFrame::Change(ChangeNotice::ScheduledTaskChanged {
                        reason,
                        task_id,
                        ..
                    }) = frame.as_ref()
                    {
                        this.changed(reason.clone(), task_id.clone(), cx);
                    }
                }
                _ => {}
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            host,
            tasks: None,
            loading: false,
            error: None,
            generation: 0,
            stale: false,
            held: HashSet::new(),
            _read: None,
            _fired: Vec::new(),
            _subscriptions: subscriptions,
        };
        if this.host.read(cx).is_connected() {
            this.reload(cx);
        }
        this
    }

    pub fn host(&self) -> &Entity<HostSession> {
        &self.host
    }

    /// The catalog as last read, `None` until it has been.
    pub fn tasks(&self) -> Option<&[ScheduledTask]> {
        self.tasks.as_deref()
    }

    pub fn task(&self, task_id: &str) -> Option<&ScheduledTask> {
        self.tasks.as_ref()?.iter().find(|task| task.id == task_id)
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    /// Why the last read failed.
    pub fn error(&self) -> Option<&ActionFailure> {
        self.error.as_ref()
    }

    /// How many tasks are active: the sidebar's count and the page's meta.
    pub fn active_count(&self) -> usize {
        self.tasks.as_ref().map_or(0, |tasks| {
            tasks.iter().filter(|task| task.status == ScheduledTaskStatus::Active).count()
        })
    }

    /// Whether the Host holds a fire of `task_id` for a delivery service,
    /// as a Trigger now it refused said.
    pub fn is_held(&self, task_id: &str) -> bool {
        self.held.contains(task_id)
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    /// Reads the catalog again in the background.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let read = self.read(cx);
        self._read = Some(read);
    }

    /// Reads the catalog again; the task resolves once it is applied (or
    /// dropped for a newer read). A failed read keeps the tasks there were.
    pub fn read(&mut self, cx: &mut Context<Self>) -> Task<()> {
        if !self.host.read(cx).is_connected() {
            return Task::ready(());
        }
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.stale = false;
        cx.notify();
        let requester = self.requester(cx);
        cx.spawn(async move |this, cx| {
            let result = read_catalog(&requester).await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(tasks) => {
                        this.error = None;
                        this.tasks = Some(tasks);
                    }
                    Err(error) => {
                        log::warn!("scheduled-task.query failed: {error}");
                        this.error =
                            Some(ActionFailure::new(copy::REFRESH_FAILED, copy::REFRESH_FALLBACK));
                    }
                }
                if std::mem::take(&mut this.stale) {
                    this.reload(cx);
                }
                cx.notify();
            })
            .ok();
        })
    }

    /// A `scheduled-task.changed` push: the catalog is read again (after a
    /// read in flight, not beside it), and a fire this client announces is
    /// looked up (`get`) and announced.
    fn changed(
        &mut self,
        reason: ScheduledTaskChangedReason,
        task_id: String,
        cx: &mut Context<Self>,
    ) {
        if matches!(
            reason,
            ScheduledTaskChangedReason::Fired
                | ScheduledTaskChangedReason::Failed
                | ScheduledTaskChangedReason::Blocked
                | ScheduledTaskChangedReason::Deleted
        ) {
            self.held.remove(&task_id);
        }
        if self.loading {
            self.stale = true;
        } else {
            self.reload(cx);
        }
        if reason == ScheduledTaskChangedReason::Fired {
            self.announce(task_id, cx);
        }
    }

    /// Desktop's main process on `fired`: the task is read, and announced
    /// unless Desktop's own native effect did (a local notification).
    fn announce(&mut self, task_id: String, cx: &mut Context<Self>) {
        let requester = self.requester(cx);
        let input = ScheduledTaskQueryInput::get(task_id);
        let lookup = cx.spawn(async move |this, cx| {
            let Ok(ScheduledTaskQueryResult::Task { task: Some(task) }) =
                requester.request::<ScheduledTaskQuery>(&input).await
            else {
                return;
            };
            if matches!(task.effect, ScheduledTaskEffect::Notify(ScheduledTaskNotify::Local)) {
                return;
            }
            this.update(cx, |_, cx| {
                cx.emit(ScheduledTasksEvent::Fired {
                    task_id: task.id.clone().into(),
                    title: task.title.clone().into(),
                });
            })
            .ok();
        });
        self._fired.retain(|task| !task.is_ready());
        self._fired.push(lookup);
    }

    /// Sends a create or an update (the form's submission); the task
    /// resolves once the catalog has been read again.
    pub fn submit(
        &mut self,
        input: ScheduledTaskMutateInput,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        let (title, fallback) = match &input {
            ScheduledTaskMutateInput::Create { .. } => (copy::CREATE_FAILED, copy::CREATE_FALLBACK),
            _ => (copy::SAVE_FAILED, copy::SAVE_FALLBACK),
        };
        if let ScheduledTaskMutateInput::Update { task_id, .. } = &input {
            self.held.remove(task_id);
        }
        self.mutate(input, title, fallback, cx)
    }

    /// Changes one task; the task resolves once the catalog has been read
    /// again.
    pub fn change(
        &mut self,
        task_id: &str,
        change: TaskChange,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        if change.cancels_held_fire() {
            self.held.remove(task_id);
        }
        let (title, fallback) = change.failure();
        let trigger = change == TaskChange::TriggerNow;
        let held = task_id.to_owned();
        let sent = self.mutate(change.input(task_id.to_owned()), title, fallback, cx);
        cx.spawn(async move |this, cx| {
            let outcome = sent.await;
            // A Trigger now the Host could not deliver: the fire waits for
            // Maka Desktop's delivery service.
            if trigger && outcome.is_err_and(|failure| failure.reason == copy::NEEDS_DESKTOP) {
                this.update(cx, |this, cx| {
                    this.held.insert(held);
                    cx.notify();
                })
                .ok();
            }
            outcome
        })
    }

    fn mutate(
        &mut self,
        input: ScheduledTaskMutateInput,
        title: Text,
        fallback: Text,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), ActionFailure>> {
        if !self.host.read(cx).is_connected() {
            return Task::ready(Err(ActionFailure::new(title, fallback)));
        }
        let requester = self.requester(cx);
        cx.spawn(async move |this, cx| {
            if let Err(error) = requester.request::<ScheduledTaskMutate>(&input).await {
                log::warn!("scheduled-task.mutate failed: {error}");
                return Err(ActionFailure::new(title, refusal(&error, fallback)));
            }
            if let Ok(read) = this.update(cx, |this, cx| this.read(cx)) {
                read.await;
            }
            Ok(())
        })
    }
}

/// What the page says for a refused change: the two refusals Desktop and
/// this client word, else Desktop's fallback (the Host's own message is
/// logged, as Desktop's `unexpectedOperationFallback` reports it).
fn refusal(error: &HostRequestError, fallback: Text) -> Text {
    match error {
        HostRequestError::Operation { message, .. } if message.contains(INCOGNITO_ACTIVE) => {
            copy::CREATE_INCOGNITO
        }
        HostRequestError::Operation {
            code: HostOperationErrorCode::OperationConflict,
            message,
            ..
        } if message.contains(NATIVE_DELIVERY_WAITING) => copy::NEEDS_DESKTOP,
        _ => fallback,
    }
}

/// Why a read of the catalog failed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
enum ReadError {
    #[error(transparent)]
    Host(#[from] HostRequestError),
    #[error("the Host answered a list with no page")]
    NotAPage,
    #[error("the catalog's revision changed without a restart signal")]
    RevisionMoved,
    #[error("the catalog repeated a task")]
    RepeatedTask,
    #[error("the catalog exceeds its item limit")]
    TooMany,
    #[error("the catalog repeated a page cursor")]
    RepeatedCursor,
    #[error("the catalog kept changing while it was read")]
    Unstable,
}

/// Every page of the catalog at the first page's revision
/// (`listScheduledTasks`): read again from the start when a continuation
/// answers `revision_changed`, at most [`READ_ATTEMPTS`] times.
async fn read_catalog(requester: &HostRequester) -> Result<Vec<ScheduledTask>, ReadError> {
    'attempts: for _ in 0..READ_ATTEMPTS {
        let mut tasks: Vec<ScheduledTask> = Vec::new();
        let mut ids = HashSet::new();
        let mut cursors = HashSet::new();
        let mut revision = None;
        let mut input = ScheduledTaskQueryInput::first_page();
        loop {
            let (page_revision, page, next_cursor) =
                match requester.request::<ScheduledTaskQuery>(&input).await? {
                    ScheduledTaskQueryResult::Page { revision, tasks, next_cursor } => {
                        (revision, tasks, next_cursor)
                    }
                    ScheduledTaskQueryResult::RevisionChanged { .. } => continue 'attempts,
                    _ => return Err(ReadError::NotAPage),
                };
            let revision = *revision.get_or_insert(page_revision);
            if page_revision != revision {
                return Err(ReadError::RevisionMoved);
            }
            let empty = page.is_empty();
            for task in page {
                if !ids.insert(task.id.clone()) {
                    return Err(ReadError::RepeatedTask);
                }
                tasks.push(task);
            }
            if tasks.len() > SCHEDULED_TASK_CATALOG_MAX_ITEMS {
                return Err(ReadError::TooMany);
            }
            let Some(cursor) = next_cursor else {
                return Ok(tasks);
            };
            if empty || !cursors.insert(cursor.clone()) {
                return Err(ReadError::RepeatedCursor);
            }
            input = ScheduledTaskQueryInput::page_after(cursor, revision);
        }
    }
    Err(ReadError::Unstable)
}
