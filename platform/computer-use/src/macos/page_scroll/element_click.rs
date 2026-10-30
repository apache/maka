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

//! Retained element clicks on the controller's CF owner.

use crate::macos::mouse::{self, Input, check_admission, settle_permit};
use crate::macos::{
    Target, activation_window,
    controller::{TargetData, verify_generation},
    focus::Resource,
    keyboard::aliases::SynthesizedEventError,
    page_scroll::{
        application,
        clickable_point::ClickablePoint,
        metadata::{Observation, Query},
        reveal::reveal,
        target::{
            self, EventTarget, GlobalWindowObservation, ProcessState, Resolution, TargetResolver,
        },
        windows::WindowVariant,
    },
};
use crate::{NativeMonitorPermit, protocol::MouseButton};
use core_foundation::base::{CFEqual, CFTypeRef};
use maka_agent_facts::tools::ToolError;
use platform_macos::ax::{
    bindings::{self, AXUIElementRef},
    snapshot::RetainedElement,
};
use std::{cell::Cell, collections::HashMap, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub(crate) struct ElementInput {
    pub(crate) index: i64,
    pub(crate) count: i64,
    pub(crate) button: MouseButton,
    pub(crate) always_simulate: bool,
}

/// Read whether macOS element clicks must use simulated mouse events.
/// The default is false; the environment variable accepts only true or false.
pub(crate) fn configured_simulation() -> Result<bool, ToolError> {
    match std::env::var("MAKA_COMPUTER_USE_ALWAYS_SIMULATE_CLICK") {
        Ok(value) => value
            .parse()
            .map_err(|_| failed("MAKA_COMPUTER_USE_ALWAYS_SIMULATE_CLICK must be true or false")),
        Err(std::env::VarError::NotPresent) => Ok(false),
        Err(std::env::VarError::NotUnicode(_)) => Err(failed(
            "MAKA_COMPUTER_USE_ALWAYS_SIMULATE_CLICK must be true or false",
        )),
    }
}

pub(in crate::macos) enum Progress {
    NeedQuery(Query),
    Ready {
        point: Option<[f64; 2]>,
        target: Option<TargetData>,
    },
}

#[derive(Clone, Copy)]
enum Need {
    Process(i32),
    GlobalWindow,
}

enum Intent {
    Menu {
        menu: RetainedElement,
        point: Option<[f64; 2]>,
    },
    Semantic {
        action: &'static str,
        point: Option<[f64; 2]>,
    },
    Physical {
        target: EventTarget,
        point: [f64; 2],
    },
}

enum Phase {
    Chess,
    Searching {
        resolver: TargetResolver,
        processes: HashMap<i32, ProcessState>,
        global: GlobalWindowObservation,
        needed: Need,
    },
    Ready(Intent),
    Terminal,
}

/// AX references and the admitted input work never leave the CF owner.
/// The permit is dropped after every retained native field.
pub(in crate::macos) struct PendingClick {
    pid: i32,
    generation: String,
    bundle: Option<String>,
    window_id: u32,
    window: WindowVariant,
    element: RetainedElement,
    chess: Option<RetainedElement>,
    input: ElementInput,
    phase: Phase,
    focus: Arc<Resource>,
    cancellation: CancellationToken,
    effects: Cell<bool>,
    resolving_point: Option<[f64; 2]>,
    permit: Option<Box<dyn NativeMonitorPermit>>,
}

impl PendingClick {
    pub(in crate::macos) fn new(
        pid: i32,
        generation: String,
        bundle: Option<String>,
        target: &Target,
        mut input: ElementInput,
        focus: Arc<Resource>,
        cancellation: CancellationToken,
    ) -> Result<Box<Self>, ToolError> {
        check_admission(&focus, &cancellation)?;
        target.verify()?;
        let element = u64::try_from(input.index)
            .ok()
            .and_then(|index| target.elements.get(&index))
            .cloned()
            .ok_or_else(|| {
                crate::macos::server_error(format_args!("{} is an invalid element ID", input.index))
            })?;
        // The indexed native caller has a two-case click type.
        if !matches!(input.button, MouseButton::Right) {
            input.button = MouseButton::Left;
        }
        let permit = focus.input_permit()?;
        Ok(Box::new(Self {
            pid,
            generation,
            bundle,
            window_id: target.window_id,
            window: WindowVariant::retained_window(target.window.clone()),
            element,
            chess: None,
            input,
            phase: Phase::Terminal,
            focus,
            cancellation,
            effects: Cell::new(false),
            resolving_point: None,
            permit: Some(permit),
        }))
    }

    pub(in crate::macos) fn mutation_started(&self) -> bool {
        self.effects.get()
    }

    pub(in crate::macos) fn window_id(&self) -> u32 {
        self.window_id
    }

    pub(in crate::macos) fn uses_resource(&self, resource: &Arc<Resource>) -> bool {
        Arc::ptr_eq(&self.focus, resource)
    }

    fn check(&self) -> Result<(), ToolError> {
        check_admission(&self.focus, &self.cancellation)?;
        verify_generation(self.pid, &self.generation)?;
        if target::ax_window_id(self.window.element())? != self.window_id {
            return Err(failed("native element window identity changed"));
        }
        Ok(())
    }

    pub(in crate::macos) fn begin(&mut self) -> Result<Progress, ToolError> {
        self.check()?;
        let point = ClickablePoint::new(&self.element, self.bundle.as_deref(), &self.cancellation)?;
        if point.needs_chess_application() {
            self.phase = Phase::Chess;
            return Ok(Progress::NeedQuery(Query::FirstBundleProcess {
                bundle: "com.apple.Chess".into(),
            }));
        }
        self.prepare()
    }

    fn point(&self) -> Result<Option<[f64; 2]>, ToolError> {
        self.check()?;
        let result =
            ClickablePoint::new(&self.element, self.bundle.as_deref(), &self.cancellation)?
                .resolve(self.chess.as_ref(), &self.cancellation);
        self.check()?;
        result
    }

    fn prepare(&mut self) -> Result<Progress, ToolError> {
        self.check()?;
        let selection =
            ClickablePoint::new(&self.element, self.bundle.as_deref(), &self.cancellation)?;
        let focus = self.focus.clone();
        let cancellation = self.cancellation.clone();
        let pid = self.pid;
        let generation = self.generation.clone();
        let window = self.window.element().clone();
        let window_id = self.window_id;
        let mut guard = || {
            check_admission(&focus, &cancellation)?;
            verify_generation(pid, &generation)?;
            if target::ax_window_id(&window)? != window_id {
                return Err(failed("native element window identity changed"));
            }
            Ok(())
        };
        let prepared_point = selection.resolve_after_preparation(
            self.chess.as_ref(),
            &self.cancellation,
            |element| {
                if let Some(frame) = target::element_frame(element)? {
                    reveal(element, frame, &cancellation, &mut guard, &self.effects)?;
                }
                Ok(())
            },
        )?;
        self.check()?;
        let role = target::string_attribute(&self.element, "AXRole")
            .ok()
            .flatten();
        if matches!(self.input.button, MouseButton::Left)
            && self.input.count == 1
            && role.as_deref() == Some("AXMenuBarItem")
            && let Some(menu) = first_menu_child(&self.element)?
        {
            self.phase = Phase::Ready(Intent::Menu {
                menu,
                point: prepared_point,
            });
            return self.ready();
        }
        let actions = target::action_names(&self.element).unwrap_or_default();
        self.check()?;
        let action = if actions.iter().any(|value| value == "AXPick") {
            Some("AXPick")
        } else if actions.iter().any(|value| value == "AXPress") {
            Some("AXPress")
        } else {
            None
        };
        if !self.input.always_simulate
            && self.input.count < 2
            && matches!(self.input.button, MouseButton::Left)
            && let Some(action) = action
        {
            let physical = if inside_web_view(&self.element, self.bundle.as_deref(), &mut guard)? {
                self.web_hit_requires_physical(&mut guard)?
            } else {
                false
            };
            if !physical {
                let point = self.point().ok().flatten();
                self.check()?;
                self.phase = Phase::Ready(Intent::Semantic { action, point });
                return self.ready();
            }
        }
        let point = self
            .point()?
            .ok_or_else(|| SynthesizedEventError::CannotClickOffscreenElement.into_tool_error())?;
        let resolver = TargetResolver::from_known(
            self.pid,
            self.bundle.as_deref(),
            self.window.clone(),
            self.element.clone(),
            point,
        )?;
        self.resolve(
            resolver,
            HashMap::new(),
            GlobalWindowObservation::Unqueried,
            point,
        )
    }

    fn web_hit_requires_physical(
        &self,
        guard: &mut impl FnMut() -> Result<(), ToolError>,
    ) -> Result<bool, ToolError> {
        let point = self.point();
        guard()?;
        let Ok(Some(point)) = point else {
            return Ok(false);
        };
        let app = application(self.pid)?;
        let hit = target::hit_test(&app, point);
        guard()?;
        let Ok(Some(hit)) = hit else { return Ok(false) };
        hit_chain_contains(&hit, &self.element, guard)
    }

    pub(in crate::macos) fn advance(
        &mut self,
        observation: Observation,
    ) -> Result<Progress, ToolError> {
        self.check()?;
        match (
            std::mem::replace(&mut self.phase, Phase::Terminal),
            observation,
        ) {
            (Phase::Chess, Observation::FirstBundleProcess { pid }) => {
                self.chess = pid.map(application).transpose()?;
                self.prepare()
            }
            (
                Phase::Searching {
                    resolver,
                    mut processes,
                    global,
                    needed: Need::Process(pid),
                },
                Observation::Process { application },
            ) => {
                processes.insert(
                    pid,
                    application.map_or(ProcessState::Absent, |app| ProcessState::Running {
                        finished_launching: app.finished_launching,
                        activation_policy: app.activation_policy,
                    }),
                );
                let point = self.point_for_resolver()?;
                self.resolve(resolver, processes, global, point)
            }
            (
                Phase::Searching {
                    resolver,
                    processes,
                    needed: Need::GlobalWindow,
                    ..
                },
                Observation::GlobalWindow { id },
            ) => {
                let point = self.point_for_resolver()?;
                self.resolve(
                    resolver,
                    processes,
                    GlobalWindowObservation::Observed(id),
                    point,
                )
            }
            _ => Err(failed(
                "native element continuation received a different observation kind",
            )),
        }
    }

    fn point_for_resolver(&self) -> Result<[f64; 2], ToolError> {
        // The resolver's original point is retained independently of live AX reads.
        self.resolving_point
            .ok_or_else(|| failed("native element resolver lost its point"))
    }

    fn resolve(
        &mut self,
        mut resolver: TargetResolver,
        processes: HashMap<i32, ProcessState>,
        global: GlobalWindowObservation,
        point: [f64; 2],
    ) -> Result<Progress, ToolError> {
        self.check()?;
        self.resolving_point = Some(point);
        match resolver.advance(&processes, &global)? {
            Resolution::NeedsProcess(pid) => {
                self.phase = Phase::Searching {
                    resolver,
                    processes,
                    global,
                    needed: Need::Process(pid),
                };
                Ok(Progress::NeedQuery(Query::Process { pid }))
            }
            Resolution::NeedsGlobalWindow => {
                self.phase = Phase::Searching {
                    resolver,
                    processes,
                    global,
                    needed: Need::GlobalWindow,
                };
                Ok(Progress::NeedQuery(Query::GlobalWindow { point }))
            }
            Resolution::Ready(target) => {
                self.phase = Phase::Ready(Intent::Physical { target, point });
                self.ready()
            }
        }
    }

    fn ready(&self) -> Result<Progress, ToolError> {
        match &self.phase {
            Phase::Ready(Intent::Menu { point, .. } | Intent::Semantic { point, .. }) => {
                Ok(Progress::Ready {
                    point: *point,
                    target: None,
                })
            }
            Phase::Ready(Intent::Physical { target, point }) => Ok(Progress::Ready {
                point: Some(*point),
                target: Some(TargetData {
                    pid: target.pid,
                    window_id: target.window_id,
                    bounds: target.bounds.clone(),
                    flipped: target.flipped,
                    is_menu: target.is_menu(),
                }),
            }),
            _ => Err(failed("native element preparation is not ready")),
        }
    }

    pub(in crate::macos) fn finish(
        mut self: Box<Self>,
        publish_menu: impl FnOnce(RetainedElement, RetainedElement) -> Result<(), ToolError>,
    ) -> Result<(), ToolError> {
        let result = (|| {
            self.check()?;
            match std::mem::replace(&mut self.phase, Phase::Terminal) {
                Phase::Ready(Intent::Menu { menu, .. }) => {
                    self.focus.enforce_with_window(|| {
                        activation_window(self.window.element(), self.window_id)
                    })?;
                    self.check()?;
                    publish_menu(self.element.clone(), menu)
                }
                Phase::Ready(Intent::Semantic { action, .. }) => {
                    self.focus.enforce_with_window(|| {
                        activation_window(self.window.element(), self.window_id)
                    })?;
                    self.check()?;
                    self.effects.set(true);
                    let status = unsafe {
                        bindings::perform_action(self.element.as_ptr() as AXUIElementRef, action)
                    };
                    if status != bindings::kAXErrorSuccess {
                        return Err(failed(format!("{action} failed with AX error {status}")));
                    }
                    Ok(())
                }
                Phase::Ready(Intent::Physical { target, point }) => mouse::send(
                    self.pid,
                    &self.generation,
                    &target,
                    Input {
                        point,
                        button: self.input.button,
                        count: self.input.count,
                    },
                    &self.focus,
                    &self.cancellation,
                    || activation_window(self.window.element(), self.window_id),
                ),
                _ => Err(failed("native element preparation is not ready")),
            }
        })();
        let result = result.map_err(|error| self.after_effect(error));
        let permit = self.permit.take().expect("element click owns one permit");
        drop(self);
        settle_permit(permit, &result);
        result
    }

    pub(in crate::macos) fn fail(mut self: Box<Self>, error: ToolError) -> ToolError {
        let error = self.after_effect(error);
        let permit = self.permit.take().expect("element click owns one permit");
        drop(self);
        settle_permit(permit, &Err(error.clone()));
        error
    }

    pub(in crate::macos) fn cancel(mut self: Box<Self>) {
        let permit = self.permit.take().expect("element click owns one permit");
        drop(self);
        permit.complete(Ok(()));
    }

    fn after_effect(&self, error: ToolError) -> ToolError {
        if self.effects.get()
            && !matches!(
                error,
                ToolError::CleanupUnconfirmed(_) | ToolError::OutcomeUnknown(_)
            )
        {
            mouse::unknown(error)
        } else {
            error
        }
    }
}

fn inside_web_view(
    element: &RetainedElement,
    bundle: Option<&str>,
    guard: &mut impl FnMut() -> Result<(), ToolError>,
) -> Result<bool, ToolError> {
    if bundle.is_some_and(|bundle| bundle.starts_with("com.openai.atlas")) {
        return Ok(true);
    }
    let mut current = Some(element.clone());
    for _ in 0..=300 {
        guard()?;
        let Some(element) = current.take() else { break };
        if target::string_attribute(&element, "AXRole")
            .ok()
            .flatten()
            .as_deref()
            == Some("AXWebArea")
        {
            return Ok(true);
        }
        current = target::element_attribute(&element, "AXParent")
            .ok()
            .flatten();
    }
    guard()?;
    Ok(false)
}

fn first_menu_child(element: &RetainedElement) -> Result<Option<RetainedElement>, ToolError> {
    Ok(target::children(element)?.into_iter().find(|child| {
        target::string_attribute(child, "AXRole")
            .ok()
            .flatten()
            .as_deref()
            == Some("AXMenu")
    }))
}

fn hit_chain_contains(
    hit: &RetainedElement,
    original: &RetainedElement,
    guard: &mut impl FnMut() -> Result<(), ToolError>,
) -> Result<bool, ToolError> {
    let mut current = Some(hit.clone());
    for _ in 0..=300 {
        guard()?;
        let Some(element) = current.take() else { break };
        if native_same_element(&element, original) {
            return Ok(true);
        }
        current = target::element_attribute(&element, "AXParent")
            .ok()
            .flatten();
    }
    guard()?;
    Ok(false)
}

fn native_same_element(left: &RetainedElement, right: &RetainedElement) -> bool {
    // SAFETY: both references remain retained on this CF owner.
    unsafe { CFEqual(left.as_ptr() as CFTypeRef, right.as_ptr() as CFTypeRef) != 0 }
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
