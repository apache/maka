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

//! One Host-owned native pointer future with both native target selections.

use super::metadata::{Observation, Query};
use super::{PageFrame, controller_position};
use crate::{
    cursor::Spec,
    desktop::NativeEpochId,
    driver::Driver,
    macos::controller::{
        Application, Controller, IndexedStep, ResolveId, ResolveStep, TargetData, Window,
    },
    protocol::{Direction, Position},
};
use maka_agent_facts::{capability::CallResult, language::Language, tools::ToolError};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub(crate) enum Operation {
    Move,
    Pages { direction: Direction, pages: f64 },
}

pub(crate) struct PointerAction {
    pub(crate) pid: i32,
    pub(crate) generation: String,
    pub(crate) frame: PageFrame,
    pub(crate) accessibility: Option<AccessibilityTarget>,
    pub(crate) position: Position,
    pub(crate) operation: Operation,
}

pub(crate) enum AccessibilityTarget {
    Window(Window),
    Application {
        application: Application,
        window_id: u32,
    },
}

impl PointerAction {
    pub(crate) async fn run(
        self,
        driver: &Arc<Mutex<Driver>>,
        epoch: NativeEpochId,
        cursor: &Spec,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        check_cancelled(cancellation)?;
        let controller = Driver::mac_controller(driver, self.pid, &self.generation).await?;
        let (destination, element_frame) = match self.position {
            Position::Point(point) => (Some(controller_position(point)?), None),
            Position::Element(index) => {
                let accessibility = self.accessibility.as_ref().ok_or_else(|| {
                    failed("indexed native input requires a retained accessibility window")
                })?;
                let step = match accessibility {
                    AccessibilityTarget::Window(window) => {
                        controller
                            .begin_indexed(window, index, cancellation.clone())
                            .await?
                    }
                    AccessibilityTarget::Application {
                        application,
                        window_id,
                    } => {
                        controller
                            .begin_application_indexed(
                                application,
                                *window_id,
                                index,
                                cancellation.clone(),
                            )
                            .await?
                    }
                };
                let selected = match step {
                    IndexedStep::Ready(selected) => selected,
                    IndexedStep::NeedChess { token } => {
                        let result = async {
                            check_cancelled(cancellation)?;
                            let Observation::FirstBundleProcess { pid } = metadata(
                                driver,
                                Query::FirstBundleProcess {
                                    bundle: "com.apple.Chess".into(),
                                },
                            )
                            .await?
                            else {
                                return Err(failed("unexpected Chess application observation"));
                            };
                            controller.finish_indexed(token, pid).await
                        }
                        .await;
                        settle(result, controller.cancel_indexed(token)).await?
                    }
                };
                (
                    selected
                        .point
                        .map(|point| self.frame.scaled_position(point))
                        .transpose()?,
                    selected.frame,
                )
            }
        };
        let wheel = match self.operation {
            Operation::Move => None,
            Operation::Pages { direction, pages } => {
                let extent = self.frame.extent(&direction, element_frame.as_ref());
                let direction = native_direction(&direction);
                platform_macos::input::page_scroll::page_deltas(direction, pages, extent)
                    .map_err(failed)?;
                Some((direction, pages, extent))
            }
        };
        if wheel.is_none() && destination.is_none() {
            return Err(failed(
                "the element has no clickable point; native controller position was retained",
            ));
        }
        let mut move_posted = false;
        if let Some(destination) = destination {
            // Store before target selection, including its error path. The AX
            // actor owns this state across facade handles and native epochs.
            controller.set_position(destination).await?;
            let point = self
                .frame
                .screen_point(destination.map(|value| value as f64))?;
            let (token, target) =
                resolve_target(&controller, driver, epoch, point, cancellation).await?;
            let result = async {
                if cursor.enabled {
                    check_cancelled(cancellation)?;
                    let movement = {
                        driver.lock().await.cursors.update(
                            cursor,
                            Some(point),
                            cursor_overlay::CursorAction::Idle,
                            Some(u64::from(target.window_id)),
                        )
                    };
                    let state = movement.await?;
                    if !state.visible
                        || state.renderer_pid.is_none()
                        || state.requested_position != Some(point)
                    {
                        return Err(failed(
                            "native cursor renderer did not acknowledge its completed movement",
                        ));
                    }
                }
                let pixels = target_pixels(driver, &target, point).await?;
                let mut request = platform_macos::input::native_move::NativeMoveRequest {
                    pid: target.pid,
                    window_id: target.window_id,
                    screen_point: Default::default(),
                    window_bounds: Default::default(),
                    window_uses_flipped_coordinates: target.flipped,
                    native_window_pixels: pixels,
                };
                request.screen_point.x = point[0];
                request.screen_point.y = point[1];
                request.window_bounds.origin.x = target.bounds.x;
                request.window_bounds.origin.y = target.bounds.y;
                request.window_bounds.size.width = target.bounds.width;
                request.window_bounds.size.height = target.bounds.height;
                Driver::native_pointer_move(driver, request, epoch, cancellation, language).await
            }
            .await;
            let posted = result.is_ok();
            let result = settle(result, controller.release_resolve(token)).await;
            let result = if posted {
                result.map_err(after_move_failure)
            } else {
                result
            }?;
            if wheel.is_none() {
                return Ok(result);
            }
            move_posted = true;
        }
        let (direction, pages, extent) =
            wheel.expect("only pages continue without a clickable destination");
        let result = async {
            check_cancelled(cancellation)?;
            let position = controller.position().await?;
            let point = self
                .frame
                .screen_point(position.map(|value| value as f64))?;
            // Native movement and its post wait settled before this new query.
            let (token, target) =
                resolve_target(&controller, driver, epoch, point, cancellation).await?;
            let result = async {
                let pixels = target_pixels(driver, &target, point).await?;
                let mut request = platform_macos::input::page_scroll::NativePageScrollRequest {
                    event: platform_macos::input::page_scroll::PageScrollRequest {
                        pid: target.pid,
                        window_id: target.window_id,
                        screen_point: Default::default(),
                        window_bounds: Default::default(),
                        window_uses_flipped_coordinates: target.flipped,
                        direction,
                        pages,
                        extent,
                    },
                    native_window_pixels: pixels,
                };
                request.event.screen_point.x = point[0];
                request.event.screen_point.y = point[1];
                request.event.window_bounds.origin.x = target.bounds.x;
                request.event.window_bounds.origin.y = target.bounds.y;
                request.event.window_bounds.size.width = target.bounds.width;
                request.event.window_bounds.size.height = target.bounds.height;
                Driver::native_page_scroll(driver, request, epoch, cancellation, language).await
            }
            .await;
            settle(result, controller.release_resolve(token)).await
        }
        .await;
        if move_posted {
            result.map_err(after_move_failure)
        } else {
            result
        }
    }
}

async fn metadata(driver: &Arc<Mutex<Driver>>, query: Query) -> Result<Observation, ToolError> {
    let pending = { driver.lock().await.cursors.mac_metadata(query) };
    pending.await
}

pub(crate) async fn resolve_target(
    controller: &Controller,
    driver: &Arc<Mutex<Driver>>,
    epoch: NativeEpochId,
    point: [f64; 2],
    cancellation: &CancellationToken,
) -> Result<(ResolveId, TargetData), ToolError> {
    check_cancelled(cancellation)?;
    let mut step = controller
        .begin_resolve(epoch, point, cancellation.clone())
        .await?;
    loop {
        match step {
            ResolveStep::Ready { token, target } => return Ok((token, target)),
            ResolveStep::NeedQuery { token, query } => {
                let result = async {
                    check_cancelled(cancellation)?;
                    let observation = metadata(driver, query).await?;
                    controller.advance_resolve(token, observation).await
                }
                .await;
                step = match result {
                    Ok(step) => step,
                    Err(error) => {
                        return settle(Err(error), controller.release_resolve(token)).await;
                    }
                };
            }
        }
    }
}

async fn target_pixels(
    driver: &Arc<Mutex<Driver>>,
    target: &TargetData,
    point: [f64; 2],
) -> Result<[f64; 2], ToolError> {
    let pending = {
        driver
            .lock()
            .await
            .cursors
            .window_geometry(target.pid, target.window_id)
    };
    let geometry = pending.await?;
    let pixels = [
        (point[0] - geometry.bounds.x) * geometry.native_scale,
        (point[1] - geometry.bounds.y) * geometry.native_scale,
    ];
    if !pixels.iter().all(|value| value.is_finite()) {
        return Err(failed("native window pixels cannot be represented"));
    }
    Ok(pixels)
}

pub(crate) async fn settle<T>(
    result: Result<T, ToolError>,
    cleanup: impl std::future::Future<Output = Result<(), ToolError>>,
) -> Result<T, ToolError> {
    match cleanup.await {
        Ok(()) => result,
        Err(error) => Err(ToolError::CleanupUnconfirmed(match result {
            Ok(_) => format!("native continuation cleanup was not confirmed: {error}"),
            Err(original) => {
                format!("{original}; native continuation cleanup was not confirmed: {error}")
            }
        })),
    }
}

fn native_direction(direction: &Direction) -> platform_macos::input::page_scroll::PageDirection {
    use platform_macos::input::page_scroll::PageDirection as Native;
    match direction {
        Direction::Up => Native::Up,
        Direction::Down => Native::Down,
        Direction::Left => Native::Left,
        Direction::Right => Native::Right,
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), ToolError> {
    if cancellation.is_cancelled() {
        Err(failed(
            "Computer Use cancelled before native pointer dispatch",
        ))
    } else {
        Ok(())
    }
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

fn after_move_failure(error: ToolError) -> ToolError {
    let message = format!(
        "The native mouse move was already posted before native pointer input stopped: {error}. Inspect the UI before another action."
    );
    match error {
        ToolError::CleanupUnconfirmed(_) => ToolError::CleanupUnconfirmed(message),
        _ => ToolError::OutcomeUnknown(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_after_the_move_post_never_becomes_a_safe_refusal() {
        assert!(matches!(
            after_move_failure(ToolError::Failed("wheel target changed".into())),
            ToolError::OutcomeUnknown(_)
        ));
        assert!(matches!(
            after_move_failure(ToolError::CleanupUnconfirmed(
                "worker ownership unknown".into()
            )),
            ToolError::CleanupUnconfirmed(_)
        ));
    }
}
