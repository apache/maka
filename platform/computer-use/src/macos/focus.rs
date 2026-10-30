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

//! The native profile's shared synthetic focus monitor, owned by Host leases.

mod observation;

use crate::{
    NativeMonitorAuthority, NativeMonitorFuture, NativeMonitorPermit, NativeMonitorResource,
};
use maka_agent_facts::tools::ToolError;
use observation::{Focus, Resolver};
use platform_macos::input::{
    native_focus::{
        observer::ActivationObserver,
        tap::{BorrowedEvent, Disposition, Tap},
    },
    native_move::{FocusActivationWindow, prepare_focus_activation, prepare_other_event},
    skylight::NativeFocusApis,
};
use std::{
    sync::{
        Arc, Condvar, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
};
use tokio::sync::watch;

type Completion = watch::Receiver<Option<Result<(), ToolError>>>;
type InputRetirement = Arc<dyn Fn() -> Result<(), ToolError> + Send + Sync>;
const COMMAND_FLAG: u64 = 1 << 20;

/// A stable, non-serialized use of one real controller by one Host epoch.
/// The Controller retains this even after a failed close; it cannot be reopened.
pub(crate) struct Resource {
    pid: i32,
    generation: String,
    authority: Weak<dyn NativeMonitorAuthority>,
    sealed: AtomicBool,
    state: Mutex<UseState>,
    this: Weak<Self>,
    callback_failure: Mutex<Option<ToolError>>,
    retained_runtime: Mutex<Option<Arc<Runtime>>>,
    pending: Mutex<usize>,
    drained: Condvar,
    input_retirement: Mutex<Option<InputRetirement>>,
}

enum UseState {
    Dormant,
    Running(Arc<Enforcer>),
    Closing {
        pending: Completion,
        _owner: Arc<Enforcer>,
    },
    Closed {
        result: Result<(), ToolError>,
        _retained: Option<Arc<Enforcer>>,
    },
}

impl Resource {
    pub(crate) fn new(
        pid: i32,
        generation: String,
        authority: &Arc<dyn NativeMonitorAuthority>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            pid,
            generation,
            authority: Arc::downgrade(authority),
            sealed: AtomicBool::new(false),
            state: Mutex::new(UseState::Dormant),
            this: this.clone(),
            callback_failure: Mutex::new(None),
            retained_runtime: Mutex::new(None),
            pending: Mutex::new(0),
            drained: Condvar::new(),
            input_retirement: Mutex::new(None),
        })
    }

    pub(crate) fn set_input_retirement(&self, callback: InputRetirement) {
        *self
            .input_retirement
            .lock()
            .expect("native input retirement poisoned") = Some(callback.clone());
        if self.is_sealed() {
            self.retire_inputs(callback);
        }
    }

    fn retire_inputs(&self, callback: InputRetirement) {
        if let Err(error) = callback() {
            let mut failure = self
                .callback_failure
                .lock()
                .expect("native callback failure poisoned");
            if failure.is_none() {
                *failure = Some(error);
            }
        }
    }

    /// Called only after the Host has attached this exact resource successfully.
    pub(crate) fn start(self: &Arc<Self>) -> Result<(), ToolError> {
        let mut state = self.state.lock().expect("native monitor use poisoned");
        if self.sealed.load(Ordering::Acquire) {
            return Err(failed("native monitor use was retired"));
        }
        match &*state {
            UseState::Running(_) => return Ok(()),
            UseState::Dormant => {}
            UseState::Closing { .. } | UseState::Closed { .. } => {
                return Err(failed("native monitor use was retired"));
            }
        }
        let setup = (|| {
            let runtime = Runtime::shared(self)?;
            match runtime.register(self) {
                Ok(enforcer) => Ok(enforcer),
                Err(error) => {
                    let close = runtime.retire_if_empty();
                    Err(match close {
                        Ok(()) => error,
                        Err(close) => cleanup(format!("{error}; {close}")),
                    })
                }
            }
        })();
        let enforcer = match setup {
            Ok(enforcer) => enforcer,
            Err(error) => {
                self.seal_admission();
                *state = UseState::Closed {
                    result: Err(error.clone()),
                    _retained: None,
                };
                return Err(error);
            }
        };
        if self.sealed.load(Ordering::Acquire) {
            self.wait_drained();
            let result = enforcer.release(self);
            *state = UseState::Closed {
                result: result.clone(),
                _retained: result.is_err().then_some(enforcer),
            };
            return result
                .and_then(|()| Err(failed("native monitor use was retired during setup")));
        }
        *state = UseState::Running(enforcer);
        Ok(())
    }

    fn admit(&self) -> Result<Box<dyn NativeMonitorPermit>, ToolError> {
        if self.sealed.load(Ordering::Acquire) {
            return Err(failed("native monitor use was retired"));
        }
        // The retained PID is still the Controller's exact process generation;
        // OS observations of other PIDs below never become app authority.
        let pid = u32::try_from(self.pid).map_err(failed)?;
        match crate::identity::process(pid) {
            Ok(current) if current == self.generation => {}
            Ok(_) => {
                self.seal_admission();
                return Err(failed("native monitor process generation retired"));
            }
            Err(error) => {
                self.seal_admission();
                return Err(error);
            }
        }
        let mut pending = self
            .pending
            .lock()
            .expect("native monitor pending work poisoned");
        if self.sealed.load(Ordering::Acquire) {
            return Err(failed("native monitor use was retired"));
        }
        let next = pending
            .checked_add(1)
            .ok_or_else(|| failed("native monitor pending work exhausted"))?;
        let host = self
            .authority
            .upgrade()
            .ok_or_else(|| failed("native monitor Host owner is unavailable"))?
            .try_admit()?;
        let resource = self
            .this
            .upgrade()
            .expect("Controller retains its monitor resource");
        *pending = next;
        Ok(Box::new(Permit {
            host: Some(host),
            resource,
            settled: false,
        }))
    }

    fn wait_drained(&self) {
        let mut pending = self
            .pending
            .lock()
            .expect("native monitor pending work poisoned");
        while *pending != 0 {
            pending = self
                .drained
                .wait(pending)
                .expect("native monitor pending work poisoned");
        }
    }

    pub(crate) fn is_sealed(&self) -> bool {
        self.sealed.load(Ordering::Acquire)
    }

    pub(crate) fn same_authority(&self, authority: &Arc<dyn NativeMonitorAuthority>) -> bool {
        Weak::ptr_eq(&self.authority, &Arc::downgrade(authority))
    }

    pub(crate) fn input_permit(&self) -> Result<Box<dyn NativeMonitorPermit>, ToolError> {
        self.admit()
    }

    pub(crate) fn enforce(&self, window: Option<FocusActivationWindow>) -> Result<(), ToolError> {
        self.enforce_with_window(|| window)
    }

    pub(crate) fn enforce_with_window(
        &self,
        window: impl FnOnce() -> Option<FocusActivationWindow>,
    ) -> Result<(), ToolError> {
        if let Some(error) = self
            .callback_failure
            .lock()
            .expect("native callback failure poisoned")
            .clone()
        {
            return Err(error);
        }
        let enforcer = match &*self.state.lock().expect("native monitor use poisoned") {
            UseState::Running(enforcer) => enforcer.clone(),
            _ => return Err(failed("native monitor is unavailable")),
        };
        let state = *enforcer.state.lock().expect("native focus state poisoned");
        if state.believes_focus {
            return Ok(());
        }
        let permit = self.admit()?;
        let result = (|| {
            let events = if state.believes_active {
                vec![prepare_other_event(21, 0x8000, 0, 0).map_err(failed)?]
            } else {
                prepare_focus_activation(window()).map_err(failed)?
            };
            let mut posted = false;
            for event in events {
                event.timestamp_and_post(self.pid).map_err(|error| {
                    if posted {
                        unknown(error)
                    } else {
                        failed(error)
                    }
                })?;
                posted = true;
            }
            enforcer
                .mutate(|state| {
                    state.believes_active = true;
                    state.believes_focus = true;
                })
                .map_err(unknown)
        })();
        permit.complete(result.clone());
        result
    }

    pub(crate) fn coordinate_click_focus(
        &self,
        has_hit: bool,
        window: impl FnOnce() -> Option<FocusActivationWindow>,
    ) -> Result<(u64, bool), ToolError> {
        let enforcer = match &*self.state.lock().expect("native monitor use poisoned") {
            UseState::Running(enforcer) => enforcer.clone(),
            _ => return Err(failed("native monitor is unavailable")),
        };
        if enforcer
            .state
            .lock()
            .expect("native focus state poisoned")
            .believes_focus
        {
            return Ok((0, false));
        }
        if has_hit {
            self.enforce_with_window(window)?;
            Ok((0, true))
        } else {
            Ok((COMMAND_FLAG, false))
        }
    }

    fn completion(&self) -> Completion {
        self.seal_admission();
        let mut state = self.state.lock().expect("native monitor use poisoned");
        match &*state {
            UseState::Closing { pending, .. } => return pending.clone(),
            UseState::Closed { result, .. } => return watch::channel(Some(result.clone())).1,
            UseState::Dormant => {
                *state = UseState::Closed {
                    result: Ok(()),
                    _retained: None,
                };
                return watch::channel(Some(Ok(()))).1;
            }
            UseState::Running(_) => {}
        }
        let UseState::Running(enforcer) = &*state else {
            unreachable!()
        };
        let enforcer = enforcer.clone();
        let (reply, pending) = watch::channel(None);
        *state = UseState::Closing {
            pending: pending.clone(),
            _owner: enforcer.clone(),
        };
        let this = self
            .this
            .upgrade()
            .expect("Controller retains its monitor resource");
        let retained = enforcer.clone();
        let completion = reply.clone();
        let spawned = thread::Builder::new()
            .name("maka-mac-monitor-close".into())
            .spawn(move || {
                let mut result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    objc2::rc::autoreleasepool(|_| {
                        this.wait_drained();
                        enforcer.release(&this)
                    })
                }))
                .unwrap_or_else(|_| Err(cleanup("native focus cleanup owner panicked")));
                if let Some(error) = this
                    .callback_failure
                    .lock()
                    .expect("native callback failure poisoned")
                    .clone()
                {
                    result = Err(cleanup(match result {
                        Ok(()) => error.to_string(),
                        Err(close) => format!("{error}; {close}"),
                    }));
                }
                *this.state.lock().expect("native monitor use poisoned") = UseState::Closed {
                    result: result.clone(),
                    _retained: result.is_err().then_some(enforcer),
                };
                let _ = reply.send(Some(result));
            });
        if let Err(error) = spawned {
            let result = Err(cleanup(error));
            *state = UseState::Closed {
                result: result.clone(),
                _retained: Some(retained),
            };
            let _ = completion.send(Some(result));
        }
        pending
    }
}

impl NativeMonitorResource for Resource {
    fn seal_admission(&self) {
        let first = {
            let _pending = self
                .pending
                .lock()
                .expect("native monitor pending work poisoned");
            !self.sealed.swap(true, Ordering::AcqRel)
        };
        if first {
            let callback = self
                .input_retirement
                .lock()
                .expect("native input retirement poisoned")
                .clone();
            if let Some(callback) = callback {
                self.retire_inputs(callback);
            }
        }
    }
    fn close(&self) -> NativeMonitorFuture {
        let mut pending = self.completion();
        Box::pin(async move {
            loop {
                if let Some(result) = pending.borrow().clone() {
                    return result;
                }
                pending
                    .changed()
                    .await
                    .map_err(|_| cleanup("native monitor cleanup owner disappeared"))?;
            }
        })
    }
}

struct Permit {
    host: Option<Box<dyn NativeMonitorPermit>>,
    resource: Arc<Resource>,
    settled: bool,
}

impl Permit {
    fn settle_local(&mut self) {
        let mut pending = self
            .resource
            .pending
            .lock()
            .expect("native monitor pending work poisoned");
        *pending = pending
            .checked_sub(1)
            .expect("native monitor work settles once");
        self.settled = true;
        if *pending == 0 {
            self.resource.drained.notify_all();
        }
    }
}

impl NativeMonitorPermit for Permit {
    fn complete(mut self: Box<Self>, result: Result<(), ToolError>) {
        self.host
            .take()
            .expect("native monitor has one Host permit")
            .complete(result);
        self.settle_local();
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if !self.settled {
            // The Host permit's own Drop records the missing actual terminal.
            drop(self.host.take());
            self.resource
                .callback_failure
                .lock()
                .expect("native callback failure poisoned")
                .get_or_insert_with(|| {
                    cleanup("native monitor work disappeared before its actual terminal result")
                });
            self.settle_local();
        }
    }
}

#[derive(Clone, Copy)]
struct AppState {
    believes_active: bool,
    believes_focus: bool,
    actual_active: bool,
}

struct Enforcer {
    pid: i32,
    runtime: Arc<Runtime>,
    uses: Mutex<Vec<Weak<Resource>>>,
    state: Mutex<AppState>,
    keyboard: Mutex<Option<Tap>>,
    click: Mutex<Option<Tap>>,
    retired: AtomicBool,
    retirement: Mutex<Option<Result<(), ToolError>>>,
}

impl Enforcer {
    fn record_failure(&self, error: ToolError) {
        for resource in self
            .uses
            .lock()
            .expect("native monitor uses poisoned")
            .iter()
            .filter_map(Weak::upgrade)
        {
            resource.seal_admission();
            resource
                .callback_failure
                .lock()
                .expect("native callback failure poisoned")
                .get_or_insert_with(|| error.clone());
        }
    }

    fn active_use(&self) -> Option<(Arc<Resource>, Box<dyn NativeMonitorPermit>)> {
        self.uses
            .lock()
            .expect("native monitor uses poisoned")
            .iter()
            .filter_map(Weak::upgrade)
            .find_map(|resource| resource.admit().ok().map(|permit| (resource, permit)))
    }

    fn mutate(self: &Arc<Self>, mutation: impl FnOnce(&mut AppState)) -> Result<(), ToolError> {
        let listen = {
            let mut state = self.state.lock().expect("native focus state poisoned");
            mutation(&mut state);
            state.believes_active && !state.actual_active
        };
        let mut click = self
            .click
            .lock()
            .expect("native focus click owner poisoned");
        if listen && click.is_none() && !self.retired.load(Ordering::Acquire) {
            let Some((_resource, permit)) = self.active_use() else {
                return Ok(());
            };
            let weak = Arc::downgrade(self);
            let prepared = (|| {
                Ok(Tap::global(2, 0, 1, 1 << 1, move |event| {
                    let Some(enforcer) = weak.upgrade() else {
                        return Disposition::Keep;
                    };
                    if event.integer_value_field(41) == i64::from(std::process::id())
                        || event.integer_value_field(40) == i64::from(enforcer.pid)
                    {
                        return Disposition::Keep;
                    }
                    let Ok(window) = u32::try_from(event.integer_value_field(51)) else {
                        return Disposition::Keep;
                    };
                    if observation::owner_pid(window) != Some(enforcer.pid) {
                        return Disposition::Keep;
                    }
                    if let Some((_resource, permit)) = enforcer.active_use() {
                        observation::activate(enforcer.pid);
                        permit.complete(Ok(()));
                    }
                    Disposition::Keep
                })
                .map_err(failed)?)
            })();
            permit.complete(prepared.as_ref().map(|_| ()).map_err(Clone::clone));
            *click = Some(prepared?);
        } else if !listen && let Some(tap) = click.as_mut() {
            tap.seal();
            tap.stop_and_join().map_err(cleanup)?;
            *click = None;
        }
        Ok(())
    }

    fn release(self: &Arc<Self>, resource: &Resource) -> Result<(), ToolError> {
        let mut retirement = self
            .retirement
            .lock()
            .expect("native focus retirement poisoned");
        if let Some(result) = &*retirement {
            return result.clone();
        }
        let last = {
            let mut uses = self.uses.lock().expect("native monitor uses poisoned");
            uses.retain(|entry| {
                entry.upgrade().is_some_and(|entry| {
                    !std::ptr::eq(entry.as_ref(), resource) && !entry.sealed.load(Ordering::Acquire)
                })
            });
            let last = uses.is_empty();
            if last {
                self.retired.store(true, Ordering::Release);
            }
            last
        };
        if !last {
            return Ok(());
        }
        let mut failures = Vec::new();
        // Deactivate only the synthetic active state. Real activation is left alone.
        let state = *self.state.lock().expect("native focus state poisoned");
        if state.believes_active && !state.actual_active {
            // Cleanup belongs to the accepted fixed resource, after admission closes.
            let result = prepare_other_event(13, 2, 0, 0)
                .map_err(cleanup)
                .and_then(|event| event.timestamp_and_post(self.pid).map_err(cleanup));
            if let Err(error) = result {
                failures.push(error.to_string());
            } else {
                let mut state = self.state.lock().expect("native focus state poisoned");
                state.believes_active = false;
                state.believes_focus = false;
            }
        }
        for owner in [&self.keyboard, &self.click] {
            let mut owner = owner.lock().expect("native focus tap owner poisoned");
            if let Some(tap) = owner.as_mut() {
                tap.seal();
                if let Err(error) = tap.stop_and_join() {
                    failures.push(error.to_string());
                } else {
                    *owner = None;
                }
            }
        }
        if let Err(error) = self.runtime.unregister(self) {
            failures.push(error.to_string());
        }
        let result = if failures.is_empty() {
            Ok(())
        } else {
            Err(cleanup(failures.join("; ")))
        };
        *retirement = Some(result.clone());
        result
    }
}

struct Suppression {
    thief_pid: i32,
    thief_app_pid: i32,
    victim_pid: i32,
    released_theft: bool,
    suppressed_return: bool,
    resource: Weak<Resource>,
}

struct MonitorState {
    current: Focus,
    previous: Option<Focus>,
    last_viewbridge_suppressed: bool,
    last_suppression_resource: Option<Weak<Resource>>,
    suppression: Option<Suppression>,
    registrations: Vec<Weak<Enforcer>>,
    resolver: Resolver,
    last_activation: Option<i32>,
}

impl MonitorState {
    fn registered(&self, pid: i32) -> Option<Arc<Enforcer>> {
        self.registrations
            .iter()
            .filter_map(Weak::upgrade)
            .find(|entry| entry.pid == pid && !entry.retired.load(Ordering::Acquire))
    }
}

enum Work {
    Focus(Weak<Enforcer>, bool),
    Activated(i32),
    Pulse {
        pid: i32,
        permit: Box<dyn NativeMonitorPermit>,
    },
    Barrier(mpsc::Sender<()>),
    Stop,
}

struct Runtime {
    state: Mutex<MonitorState>,
    apis: NativeFocusApis,
    auxiliary: Option<i32>,
    registration: Mutex<()>,
    global: Mutex<Option<Tap>>,
    activation: Mutex<Option<ActivationObserver>>,
    sender: mpsc::Sender<Work>,
    worker: Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
}

impl Runtime {
    fn shared(resource: &Resource) -> Result<Arc<Self>, ToolError> {
        static SHARED: OnceLock<Mutex<Weak<Runtime>>> = OnceLock::new();
        let mut shared = SHARED
            .get_or_init(|| Mutex::new(Weak::new()))
            .lock()
            .expect("native shared monitor poisoned");
        if let Some(runtime) = shared.upgrade()
            && !runtime.closed.load(Ordering::Acquire)
        {
            *resource
                .retained_runtime
                .lock()
                .expect("native monitor setup owner poisoned") = Some(runtime.clone());
            return Ok(runtime);
        }
        let resolver = Resolver::new();
        let current = resolver.observed_focus()?;
        let (sender, receiver) = mpsc::channel();
        let runtime = Arc::new(Self {
            state: Mutex::new(MonitorState {
                current,
                previous: None,
                last_viewbridge_suppressed: false,
                last_suppression_resource: None,
                suppression: None,
                registrations: Vec::new(),
                resolver,
                last_activation: observation::menu_bar_owner_pid(),
            }),
            apis: NativeFocusApis::resolve().map_err(failed)?,
            auxiliary: observation::first_auxiliary_pid(),
            registration: Mutex::new(()),
            global: Mutex::new(None),
            activation: Mutex::new(None),
            sender,
            worker: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        *resource
            .retained_runtime
            .lock()
            .expect("native monitor setup owner poisoned") = Some(runtime.clone());
        let setup = (|| -> Result<(), ToolError> {
            let weak = Arc::downgrade(&runtime);
            *runtime
                .worker
                .lock()
                .expect("native monitor worker poisoned") = Some(
                thread::Builder::new()
                    .name("maka-mac-focus-notices".into())
                    .spawn(move || {
                        while let Ok(work) = receiver.recv() {
                            let Some(runtime) = weak.upgrade() else {
                                break;
                            };
                            if matches!(&work, Work::Stop) {
                                break;
                            }
                            objc2::rc::autoreleasepool(|_| match work {
                                Work::Stop => {}
                                Work::Barrier(reply) => {
                                    let _ = reply.send(());
                                }
                                Work::Focus(enforcer, focused) => {
                                    if let Some(enforcer) = enforcer.upgrade() {
                                        if let Err(error) =
                                            enforcer.mutate(|state| state.believes_focus = focused)
                                        {
                                            enforcer.record_failure(error);
                                        }
                                    }
                                }
                                Work::Activated(pid) => runtime.activated(pid),
                                Work::Pulse { pid, permit } => {
                                    let result = (|| {
                                        prepare_other_event(21, 0x4000, 0, 0)
                                            .map_err(failed)?
                                            .timestamp_and_post(pid)
                                            .map_err(failed)?;
                                        prepare_other_event(21, 0x8000, 0, 0)
                                            .map_err(unknown)?
                                            .timestamp_and_post(pid)
                                            .map_err(unknown)
                                    })();
                                    permit.complete(result);
                                }
                            });
                        }
                    })
                    .map_err(failed)?,
            );
            let weak = Arc::downgrade(&runtime);
            let tap = Tap::global(2, 1, 0, 1 << 21, move |event| {
                weak.upgrade()
                    .map_or(Disposition::Keep, |runtime| runtime.event(event))
            })
            .map_err(failed)?;
            *runtime
                .global
                .lock()
                .expect("native global tap owner poisoned") = Some(tap);
            let weak = Arc::downgrade(&runtime);
            let observer = ActivationObserver::start(Arc::new(move |pid| {
                if let Some(runtime) = weak.upgrade()
                    && !runtime.closed.load(Ordering::Acquire)
                {
                    let _ = runtime.sender.send(Work::Activated(pid));
                }
            }))
            .map_err(failed)?;
            *runtime
                .activation
                .lock()
                .expect("native activation owner poisoned") = Some(observer);
            Ok(())
        })();
        if let Err(error) = setup {
            return Err(match runtime.shutdown() {
                Ok(()) => error,
                Err(close) => cleanup(format!("{error}; {close}")),
            });
        }
        *shared = Arc::downgrade(&runtime);
        Ok(runtime)
    }

    fn register(self: &Arc<Self>, resource: &Arc<Resource>) -> Result<Arc<Enforcer>, ToolError> {
        let registration = self
            .registration
            .lock()
            .expect("native monitor registration poisoned");
        if self.closed.load(Ordering::Acquire) {
            drop(registration);
            return Runtime::shared(resource)?.register(resource);
        }
        let (current, existing) = {
            let state = self.state.lock().expect("native monitor state poisoned");
            (
                state.current,
                state
                    .registrations
                    .iter()
                    .filter_map(Weak::upgrade)
                    .find(|entry| entry.pid == resource.pid),
            )
        };
        if let Some(enforcer) = existing {
            let mut uses = enforcer.uses.lock().expect("native monitor uses poisoned");
            if !enforcer.retired.load(Ordering::Acquire) {
                uses.push(Arc::downgrade(resource));
                drop(uses);
                return Ok(enforcer);
            }
            drop(uses);
            drop(registration);
            let result = enforcer
                .retirement
                .lock()
                .expect("native focus retirement poisoned")
                .clone()
                .ok_or_else(|| cleanup("native focus retirement has no terminal result"))?;
            result?;
            return Runtime::shared(resource)?.register(resource);
        }
        let active = observation::application_active(resource.pid);
        let enforcer = Arc::new(Enforcer {
            pid: resource.pid,
            runtime: self.clone(),
            uses: Mutex::new(vec![Arc::downgrade(resource)]),
            state: Mutex::new(AppState {
                believes_active: active,
                believes_focus: current.host() == resource.pid,
                actual_active: active,
            }),
            keyboard: Mutex::new(None),
            click: Mutex::new(None),
            retired: AtomicBool::new(false),
            retirement: Mutex::new(None),
        });
        let weak = Arc::downgrade(&enforcer);
        let keyboard = Tap::for_pid(
            resource.pid,
            1,
            0,
            (1 << 10) | (1 << 11) | (1 << 12),
            move |event| {
                let Some(enforcer) = weak.upgrade() else {
                    return Disposition::Keep;
                };
                if event.integer_value_field(41) == i64::from(std::process::id()) {
                    return Disposition::Keep;
                }
                let state = enforcer
                    .runtime
                    .state
                    .lock()
                    .expect("native monitor state poisoned");
                let Some(suppression) = &state.suppression else {
                    return Disposition::Keep;
                };
                if event.integer_value_field(40) != i64::from(suppression.thief_pid) {
                    return Disposition::Keep;
                }
                let Some(resource) = suppression.resource.upgrade() else {
                    return Disposition::Keep;
                };
                let Ok(permit) = resource.admit() else {
                    return Disposition::Keep;
                };
                event.post_to_pid(suppression.victim_pid);
                permit.complete(Ok(()));
                Disposition::Drop
            },
        )
        .map_err(failed)?;
        *enforcer
            .keyboard
            .lock()
            .expect("native keyboard tap owner poisoned") = Some(keyboard);
        self.state
            .lock()
            .expect("native monitor state poisoned")
            .registrations
            .push(Arc::downgrade(&enforcer));
        Ok(enforcer)
    }

    fn activated(&self, pid: i32) {
        let registrations = {
            let mut state = self.state.lock().expect("native monitor state poisoned");
            if state.last_activation == Some(pid) {
                return;
            }
            state.last_activation = Some(pid);
            state
                .registrations
                .iter()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>()
        };
        for enforcer in registrations {
            if let Err(error) = enforcer.mutate(|state| {
                let was_active = state.actual_active;
                state.actual_active = pid == enforcer.pid;
                if was_active || state.actual_active {
                    state.believes_active = state.actual_active;
                    state.believes_focus = state.actual_active;
                }
            }) {
                enforcer.record_failure(error);
            }
        }
    }

    fn event(&self, event: BorrowedEvent<'_>) -> Disposition {
        if self.closed.load(Ordering::Acquire) || event.event_type() != 21 {
            return Disposition::Keep;
        }
        let subtype = event.integer_value_field(64) as u16;
        let mut state = self.state.lock().expect("native monitor state poisoned");
        if subtype == 0x4000 {
            let Ok(thief) = i32::try_from(event.integer_value_field(73)) else {
                state.suppression = None;
                return Disposition::Keep;
            };
            let Ok(focus) = state.resolver.map_focus(thief) else {
                return Disposition::Keep;
            };
            let Some(enforcer) = state
                .registered(focus.host())
                .filter(|_| state.current.host() != focus.host())
            else {
                state.suppression = None;
                return Disposition::Keep;
            };
            let Some((resource, permit)) = enforcer.active_use() else {
                return Disposition::Keep;
            };
            let Ok(victim) = i32::try_from(event.integer_value_field(40)) else {
                permit.complete(Err(failed("focus recipient PID cannot be represented")));
                return Disposition::Keep;
            };
            state.suppression = Some(Suppression {
                thief_pid: thief,
                thief_app_pid: focus.host(),
                victim_pid: victim,
                released_theft: false,
                suppressed_return: false,
                resource: Arc::downgrade(&resource),
            });
            permit.complete(Ok(()));
            return Disposition::Drop;
        }
        if subtype == 0x8000 {
            if let Some(suppression) = state.suppression.as_mut()
                && !suppression.suppressed_return
                && event.integer_value_field(40) == i64::from(suppression.victim_pid)
                && let Some(resource) = suppression.resource.upgrade()
                && let Ok(permit) = resource.admit()
            {
                suppression.suppressed_return = true;
                permit.complete(Ok(()));
                return Disposition::Drop;
            }
            return Disposition::Keep;
        }
        if self.auxiliary.map(i64::from) != Some(event.integer_value_field(40)) {
            return Disposition::Keep;
        }
        if subtype == 2 {
            if state.suppression.as_ref().is_some_and(|suppression| {
                event.integer_value_field(73) == i64::from(suppression.thief_pid)
            }) {
                state.suppression = None;
            }
            if state.last_viewbridge_suppressed
                && let Some(resource) = state
                    .last_suppression_resource
                    .as_ref()
                    .and_then(Weak::upgrade)
                && let Ok(permit) = resource.admit()
            {
                permit.complete(Ok(()));
                return Disposition::Drop;
            }
            return Disposition::Keep;
        }
        if subtype != 0xf102 {
            return Disposition::Keep;
        }
        let Ok(event_pid) = i32::try_from(event.integer_value_field(73)) else {
            return Disposition::Keep;
        };
        let Ok(new) = state.resolver.map_focus(event_pid) else {
            return Disposition::Keep;
        };
        let old = std::mem::replace(&mut state.current, new);
        state.previous = Some(old);
        let registrations = state
            .registrations
            .iter()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for enforcer in &registrations {
            let suppressed = state
                .suppression
                .as_ref()
                .is_some_and(|suppression| suppression.thief_app_pid == enforcer.pid);
            if !suppressed && old.host() != new.host() {
                if enforcer.pid == new.host() {
                    let _ = self
                        .sender
                        .send(Work::Focus(Arc::downgrade(enforcer), true));
                }
                if enforcer.pid == old.host() {
                    let _ = self
                        .sender
                        .send(Work::Focus(Arc::downgrade(enforcer), false));
                }
            }
        }
        let mut release = false;
        let mut returned = false;
        let mut receipt = None;
        if let Some(suppression) = state.suppression.as_mut() {
            if event_pid == suppression.thief_pid {
                returned = true;
                if !suppression.released_theft {
                    suppression.released_theft = true;
                    release = true;
                }
                receipt = suppression.resource.upgrade();
            } else if event_pid != suppression.victim_pid {
                state.suppression = None;
            }
        }
        let registered = state
            .registered(new.host())
            .filter(|_| new.host() != old.host());
        if old.auxiliary()
            && new.auxiliary()
            && !returned
            && registered.is_some()
            && let Some(classification) =
                observation::foreign_owner_classification(old.host(), &[0, 1])
            && state.registered(old.host()).is_none()
        {
            let enforcer = registered.as_ref().expect("membership was checked");
            if classification == 0 {
                release = true;
                receipt = enforcer.active_use().map(|(resource, permit)| {
                    permit.complete(Ok(()));
                    resource
                });
            } else if let Some((resource, permit)) = enforcer.active_use() {
                receipt = Some(resource);
                if let Err(error) = self.sender.send(Work::Pulse {
                    pid: old.host(),
                    permit,
                }) && let Work::Pulse { permit, .. } = error.0
                {
                    permit.complete(Err(cleanup("native focus pulse owner stopped")));
                }
            }
        }
        let release_receipt = receipt.as_ref().map(Arc::downgrade);
        let suppressed = if release {
            receipt
                .and_then(|resource| resource.admit().ok())
                .is_some_and(|permit| {
                    let result = u32::try_from(event.integer_value_field(71))
                        .map_err(failed)
                        .map(|id| self.apis.release_key_focus(id) == 0);
                    let success = result.as_ref().is_ok_and(|released| *released);
                    permit.complete(result.map(|_| ()));
                    success
                })
        } else {
            false
        };
        if new.auxiliary() {
            state.last_viewbridge_suppressed = suppressed;
            state.last_suppression_resource = release_receipt;
        }
        Disposition::Keep
    }

    fn retire_if_empty(&self) -> Result<(), ToolError> {
        let _registration = self
            .registration
            .lock()
            .expect("native monitor registration poisoned");
        if self
            .state
            .lock()
            .expect("native monitor state poisoned")
            .registrations
            .is_empty()
        {
            self.shutdown()
        } else {
            Ok(())
        }
    }

    fn unregister(&self, enforcer: &Arc<Enforcer>) -> Result<(), ToolError> {
        let _registration = self
            .registration
            .lock()
            .expect("native monitor registration poisoned");
        let last = {
            let mut state = self.state.lock().expect("native monitor state poisoned");
            state.registrations.retain(|entry| {
                entry
                    .upgrade()
                    .is_some_and(|entry| !Arc::ptr_eq(&entry, enforcer))
            });
            state.registrations.is_empty()
        };
        if last {
            self.shutdown()
        } else {
            let (reply, ack) = mpsc::channel();
            self.sender.send(Work::Barrier(reply)).map_err(cleanup)?;
            ack.recv().map_err(cleanup)
        }
    }

    fn shutdown(&self) -> Result<(), ToolError> {
        self.closed.store(true, Ordering::Release);
        if let Some(tap) = self
            .global
            .lock()
            .expect("native global tap owner poisoned")
            .as_ref()
        {
            tap.seal();
        }
        if let Some(observer) = self
            .activation
            .lock()
            .expect("native activation owner poisoned")
            .as_ref()
        {
            observer.seal();
        }
        let mut failures = Vec::new();
        if let Some(tap) = self
            .global
            .lock()
            .expect("native global tap owner poisoned")
            .as_mut()
        {
            if let Err(error) = tap.stop_and_join() {
                failures.push(error.to_string());
            }
        }
        if let Some(observer) = self
            .activation
            .lock()
            .expect("native activation owner poisoned")
            .as_mut()
        {
            if let Err(error) = observer.stop_and_join() {
                failures.push(error.to_string());
            }
        }
        if let Some(worker) = self
            .worker
            .lock()
            .expect("native monitor worker poisoned")
            .take()
        {
            // Tap and observer callbacks have drained, so every accepted message
            // precedes this Stop. The worker settles all earlier pulse permits.
            if let Err(error) = self.sender.send(Work::Stop) {
                failures.push(error.to_string());
            }
            if worker.join().is_err() {
                failures.push("native focus notice owner panicked".into());
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(cleanup(failures.join("; ")))
        }
    }
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
fn unknown(error: impl std::fmt::Display) -> ToolError {
    ToolError::OutcomeUnknown(error.to_string())
}
fn cleanup(error: impl std::fmt::Display) -> ToolError {
    ToolError::CleanupUnconfirmed(error.to_string())
}
