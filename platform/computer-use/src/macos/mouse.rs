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

//! Coordinate clicks keep target references and event delivery on the Controller.

use super::{
    controller::{Application, Controller, verify_generation},
    focus::Resource,
    keyboard::aliases::SynthesizedEventError,
    page_scroll::{
        PageFrame, controller_position,
        dispatch::{resolve_target, settle},
        target::EventTarget,
    },
};
use crate::{
    NativeMonitorPermit, cursor::Spec, desktop::NativeEpochId, driver::Driver,
    protocol::MouseButton,
};
use core_foundation::base::CFRelease;
use maka_agent_facts::tools::ToolError;
use platform_macos::{
    ax::{
        bindings::{
            AXUIElementCreateApplication, AXUIElementRef, copy_binary_attr, kAXErrorSuccess,
            perform_action,
        },
        snapshot::RetainedElement,
    },
    input::native_move::{
        FocusActivationWindow, NativeClickButton, NativeClickError, NativeClickRequest,
        PreparedNativeEvent, prepare_native_click, prepare_native_drag,
    },
};
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub(crate) struct Input {
    pub(crate) point: [f64; 2],
    pub(crate) button: MouseButton,
    pub(crate) count: i64,
}

/// Screen-space values prepared from one retained page frame.
#[derive(Clone, Copy)]
pub(crate) struct CoordinateInput {
    pub(crate) click: Input,
    pub(crate) drag_target: Option<[f64; 2]>,
}

pub(crate) struct CoordinateClick {
    pub(crate) application: Application,
    pub(crate) controller: Controller,
    pub(crate) epoch: NativeEpochId,
    pub(crate) frame: PageFrame,
    pub(crate) drag_target: Option<[f64; 2]>,
    pub(crate) input: Input,
    pub(crate) cursor: Spec,
    pub(crate) cancellation: CancellationToken,
    pub(crate) focus: Arc<Resource>,
}

impl CoordinateClick {
    pub(crate) async fn run(self, native: Arc<Mutex<Driver>>) -> Result<(), ToolError> {
        // The accepted continuation owns resolution, native dispatch and the
        // terminal target release even when its caller stops observing it.
        let task = tokio::spawn(async move { self.execute(native).await });
        task.await.map_err(|error| {
            ToolError::CleanupUnconfirmed(format!("native click custodian failed: {error}"))
        })?
    }

    async fn execute(mut self, native: Arc<Mutex<Driver>>) -> Result<(), ToolError> {
        check_admission(&self.focus, &self.cancellation)?;
        let position = controller_position(self.input.point)?;
        let drag_target = self
            .drag_target
            .map(|point| {
                let point = controller_position(point)?;
                self.frame.screen_point(point.map(|value| value as f64))
            })
            .transpose()?;
        self.controller.set_position(position).await?;
        let point = self
            .frame
            .screen_point(position.map(|value| value as f64))?;
        self.input.point = point;
        let (token, target) = resolve_target(
            &self.controller,
            &native,
            self.epoch,
            point,
            &self.cancellation,
        )
        .await?;
        let result: Result<(), ToolError> = async {
            if self.cursor.enabled && !target.is_menu {
                check_admission(&self.focus, &self.cancellation)?;
                let movement = native.lock().await.cursors.update(
                    &self.cursor,
                    Some(point),
                    cursor_overlay::CursorAction::Click,
                    Some(u64::from(target.window_id)),
                );
                let state = movement.await?;
                if !state.visible
                    || state.renderer_pid.is_none()
                    || state.requested_position != Some(point)
                {
                    return Err(failed(
                        "native cursor renderer did not acknowledge the click position",
                    ));
                }
            }
            self.application
                .coordinate_click(
                    token,
                    CoordinateInput {
                        click: self.input,
                        drag_target,
                    },
                    self.cancellation.clone(),
                    self.focus.clone(),
                )
                .await
        }
        .await;
        settle(result, self.controller.release_resolve(token)).await
    }
}

pub(super) fn send(
    app_pid: i32,
    generation: &str,
    target: &EventTarget,
    input: Input,
    focus: &Resource,
    cancellation: &CancellationToken,
    window: impl FnOnce() -> Option<FocusActivationWindow>,
) -> Result<(), ToolError> {
    let permit = focus.input_permit()?;
    let result = send_physical(
        app_pid,
        generation,
        target,
        CoordinateInput {
            click: input,
            drag_target: None,
        },
        focus,
        cancellation,
        window,
    );
    settle_permit(permit, &result);
    result
}

pub(super) fn send_coordinate(
    app_pid: i32,
    generation: &str,
    target: &EventTarget,
    input: CoordinateInput,
    focus: &Resource,
    cancellation: &CancellationToken,
    window: impl FnOnce() -> Option<FocusActivationWindow>,
) -> Result<(), ToolError> {
    let permit = focus.input_permit()?;
    let result: Result<(), ToolError> = (|| {
        check_admission(focus, cancellation)?;
        verify_generation(app_pid, generation)?;
        if let Some(menu) = target.menu_element() {
            if !target.menu_supports_press() {
                return Err(super::server_error("Failed to click menu item"));
            }
            check_admission(focus, cancellation)?;
            verify_generation(app_pid, generation)?;
            // SAFETY: this exact menu remains retained by the resolved target
            // on the CF owner while the admitted operation is dispatched once.
            let status = unsafe { perform_action(menu.as_ptr() as AXUIElementRef, "AXPress") };
            if status != kAXErrorSuccess {
                return Err(ToolError::OutcomeUnknown(format!(
                    "Menu input was dispatched but its outcome was not confirmed (AX error {status}). Inspect the UI before another action."
                )));
            }
            return Ok(());
        }
        send_physical(
            app_pid,
            generation,
            target,
            input,
            focus,
            cancellation,
            window,
        )
    })();
    settle_permit(permit, &result);
    result
}

fn send_physical(
    app_pid: i32,
    generation: &str,
    target: &EventTarget,
    input: CoordinateInput,
    focus: &Resource,
    cancellation: &CancellationToken,
    window: impl FnOnce() -> Option<FocusActivationWindow>,
) -> Result<(), ToolError> {
    check_admission(focus, cancellation)?;
    let (flags, wait_frontmost) =
        focus.coordinate_click_focus(target._retained_element.is_some(), window)?;
    if wait_frontmost {
        wait_until_frontmost(app_pid, focus, cancellation)?;
    }
    check_admission(focus, cancellation)?;
    verify_generation(app_pid, generation)?;
    let request = NativeClickRequest {
        button: match input.click.button {
            MouseButton::Left => NativeClickButton::Left,
            MouseButton::Right => NativeClickButton::Right,
            MouseButton::Middle => NativeClickButton::Other,
        },
        count: input.click.count,
        screen_point: input.click.point,
        flags,
        window_id: Some(target.window_id),
        window_bounds: Some([
            target.bounds.x,
            target.bounds.y,
            target.bounds.width,
            target.bounds.height,
        ]),
        window_uses_flipped_coordinates: target.flipped,
    };
    let mut posted = false;
    let mut post_group = |down: PreparedNativeEvent,
                          dragged: Option<[PreparedNativeEvent; 3]>,
                          up: PreparedNativeEvent|
     -> Result<(), ToolError> {
        verify_generation(app_pid, generation)
            .map_err(|error| if posted { unknown(error) } else { error })?;
        check_admission(focus, cancellation)
            .map_err(|error| if posted { unknown(error) } else { error })?;
        down.timestamp_and_post(target.pid).map_err(|error| {
            if posted {
                unknown(error)
            } else {
                failed(error)
            }
        })?;
        posted = true;
        // A committed group drains on this owner. Its original UP is attempted
        // even when a dragged event fails; cancellation cannot drop the release.
        let movement = dragged
            .into_iter()
            .flatten()
            .try_for_each(|event| event.timestamp_and_post(target.pid).map_err(unknown));
        let release = up.timestamp_and_post(target.pid).map_err(|error| {
            ToolError::CleanupUnconfirmed(format!(
                "native mouse release was not confirmed: {error}"
            ))
        });
        match (movement, release) {
            (Ok(()), result) => result,
            (Err(error), Ok(())) => Err(error),
            (Err(error), Err(cleanup)) => {
                Err(ToolError::CleanupUnconfirmed(format!("{error}; {cleanup}")))
            }
        }
    };
    match input.drag_target {
        Some(end) => {
            let groups = prepare_native_drag(request, end).map_err(factory_error)?;
            for group in groups {
                post_group(group.down, Some(group.dragged), group.up)?;
            }
        }
        None => {
            let pairs = prepare_native_click(request).map_err(factory_error)?;
            for pair in pairs {
                post_group(pair.down, None, pair.up)?;
            }
        }
    }
    Ok(())
}

fn factory_error(error: NativeClickError) -> ToolError {
    match error {
        NativeClickError::InvalidCount => SynthesizedEventError::InvalidParameter.into_tool_error(),
        other => failed(other),
    }
}

fn wait_until_frontmost(
    pid: i32,
    focus: &Resource,
    cancellation: &CancellationToken,
) -> Result<(), ToolError> {
    // SAFETY: AX returns a copied application reference. Transfer a retained
    // reference to this CF owner and balance the copy before waiting.
    let application = unsafe {
        let raw = AXUIElementCreateApplication(pid);
        if raw.is_null() {
            None
        } else {
            let retained = RetainedElement::retain(raw as usize);
            CFRelease(raw.cast());
            Some(retained)
        }
    };
    let start = SystemTime::now();
    loop {
        check_admission(focus, cancellation)?;
        if start
            .elapsed()
            .is_ok_and(|elapsed| elapsed > Duration::from_secs(2))
        {
            return Ok(());
        }
        if application.as_ref().is_some_and(|application| {
            // SAFETY: the application reference remains retained on this owner.
            unsafe {
                copy_binary_attr(application.as_ptr() as AXUIElementRef, "AXFrontmost")
                    == Some(true)
            }
        }) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(super) fn check_admission(
    focus: &Resource,
    cancellation: &CancellationToken,
) -> Result<(), ToolError> {
    if focus.is_sealed() || cancellation.is_cancelled() {
        Err(failed("Computer Use stopped before native mouse dispatch"))
    } else {
        Ok(())
    }
}

pub(super) fn settle_permit(permit: Box<dyn NativeMonitorPermit>, result: &Result<(), ToolError>) {
    let terminal = match result {
        Err(error @ ToolError::CleanupUnconfirmed(_)) => Err(error.clone()),
        _ => Ok(()),
    };
    permit.complete(terminal);
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

pub(super) fn unknown(error: impl std::fmt::Display) -> ToolError {
    ToolError::OutcomeUnknown(format!(
        "Native mouse input was already posted: {error}. Inspect the UI before another action."
    ))
}
