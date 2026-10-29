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

//! Read-only AX page anchors.

use super::target::{
    action_names, element_attribute, element_frame, frame_attribute, string_attribute,
};
use core_foundation::base::{CFEqual, CFRelease};
use cua_driver_contract::WindowBounds;
use maka_agent_facts::tools::ToolError;
use platform_macos::ax::{
    bindings::{AXUIElementCopyElementAtPosition, AXUIElementRef, kAXErrorSuccess},
    snapshot::RetainedElement,
};
use tokio_util::sync::CancellationToken;
use unicode_segmentation::UnicodeSegmentation;

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Size {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    origin: Point,
    size: Size,
}

impl From<WindowBounds> for Rect {
    fn from(bounds: WindowBounds) -> Self {
        Self {
            origin: Point {
                x: bounds.x,
                y: bounds.y,
            },
            size: Size {
                width: bounds.width,
                height: bounds.height,
            },
        }
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    static CGRectInfinite: Rect;
    fn CGRectIntersection(first: Rect, second: Rect) -> Rect;
    fn CGRectIsEmpty(rect: Rect) -> bool;
    fn CGRectIsNull(rect: Rect) -> bool;
    fn CGRectEqualToRect(first: Rect, second: Rect) -> bool;
    fn CGRectContainsPoint(rect: Rect, point: Point) -> bool;
    fn CGRectGetMidX(rect: Rect) -> f64;
    fn CGRectGetMidY(rect: Rect) -> f64;
    fn CGRectGetMinX(rect: Rect) -> f64;
    fn CGRectGetMinY(rect: Rect) -> f64;
    fn CGRectGetWidth(rect: Rect) -> f64;
    fn CGRectGetHeight(rect: Rect) -> f64;
}

pub(crate) struct ClickablePoint {
    element: RetainedElement,
    chess_candidate: bool,
}

impl ClickablePoint {
    /// Freeze the predicate before the Host asks AppKit for the first running
    /// Chess application. Ordinary elements do not trigger that lookup.
    pub(crate) fn new(
        element: &RetainedElement,
        app_bundle_id: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Self, ToolError> {
        check_cancelled(cancellation)?;
        let chess_candidate = app_bundle_id == Some("com.apple.Chess")
            && string_attribute(element, "AXRole")
                .ok()
                .flatten()
                .as_deref()
                == Some("AXButton")
            && string_attribute(element, "AXTitle")
                .ok()
                .flatten()
                .is_some_and(|title| chess_square_title(&title));
        Ok(Self {
            element: element.clone(),
            chess_candidate,
        })
    }

    pub(crate) fn needs_chess_application(&self) -> bool {
        self.chess_candidate
    }

    pub(crate) fn resolve_after_preparation(
        self,
        chess_application: Option<&RetainedElement>,
        cancellation: &CancellationToken,
        prepare: impl FnOnce(&RetainedElement) -> Result<(), ToolError>,
    ) -> Result<Option<[f64; 2]>, ToolError> {
        check_cancelled(cancellation)?;
        if self.chess_candidate
            && let Some(point) = chess_point(&self.element, chess_application, cancellation)?
        {
            return Ok(Some(point));
        }
        prepare(&self.element)?;
        normal_point(&self.element, cancellation)
    }

    /// Return the original global logical point, which may be absent. Absence
    /// preserves the controller's previous position; it does not select a center.
    pub(crate) fn resolve(
        self,
        chess_application: Option<&RetainedElement>,
        cancellation: &CancellationToken,
    ) -> Result<Option<[f64; 2]>, ToolError> {
        check_cancelled(cancellation)?;
        if self.chess_candidate
            && let Some(point) = chess_point(&self.element, chess_application, cancellation)?
        {
            return Ok(Some(point));
        }
        normal_point(&self.element, cancellation)
    }
}

pub(crate) fn center_is_visible(
    element: &RetainedElement,
    cancellation: &CancellationToken,
) -> Result<bool, ToolError> {
    normal_point(element, cancellation).map(|point| point.is_some())
}

fn normal_point(
    element: &RetainedElement,
    cancellation: &CancellationToken,
) -> Result<Option<[f64; 2]>, ToolError> {
    let frame = frame_attribute(element)?
        .ok_or_else(|| failed("page element has no AXFrame for its clickable point"))?;
    let Some(clipped) = clipped_frame(element, cancellation)? else {
        return Ok(None);
    };
    let center = center(frame.into());
    // SAFETY: these are by-value CoreGraphics geometry values, with no
    // independently standardized dimensions or replacement point.
    Ok(unsafe {
        CGRectContainsPoint(
            clipped,
            Point {
                x: center[0],
                y: center[1],
            },
        )
    }
    .then_some(center))
}

fn clipped_frame(
    element: &RetainedElement,
    cancellation: &CancellationToken,
) -> Result<Option<Rect>, ToolError> {
    // SAFETY: CoreGraphics exports this immutable CGRect value.
    let initial = unsafe { CGRectInfinite };
    let mut clipped = initial;
    let mut current = Some(element.clone());
    while let Some(element) = current {
        check_cancelled(cancellation)?;
        let role = string_attribute(&element, "AXRole")?;
        if role.as_deref() == Some("AXApplication") {
            break;
        }
        let Some(frame) = frame_attribute(&element)? else {
            return Ok(None);
        };
        let boundary = matches!(
            role.as_deref(),
            Some("AXWindow" | "AXSheet" | "AXMenu" | "AXPopover")
        );
        let scroll_container = role.as_deref() == Some("AXScrollArea")
            || (role.as_deref() == Some("AXGroup")
                && action_names(&element)?
                    .iter()
                    .any(|action| is_page_action(action)));
        if boundary || scroll_container {
            // SAFETY: preserve CoreGraphics intersection and empty/null
            // semantics, including unusual or degenerate native rectangles.
            clipped = unsafe { CGRectIntersection(clipped, frame.into()) };
            if unsafe { CGRectIsEmpty(clipped) || CGRectIsNull(clipped) } {
                return Ok(None);
            }
        }
        if boundary {
            break;
        }
        current = element_attribute(&element, "AXParent")?;
    }
    // SAFETY: both arguments are copied CoreGraphics geometry values.
    Ok((!unsafe { CGRectEqualToRect(clipped, initial) }).then_some(clipped))
}

fn is_page_action(action: &str) -> bool {
    matches!(
        action,
        "AXScrollLeftByPage" | "AXScrollRightByPage" | "AXScrollUpByPage" | "AXScrollDownByPage"
    )
}

fn chess_point(
    element: &RetainedElement,
    application: Option<&RetainedElement>,
    cancellation: &CancellationToken,
) -> Result<Option<[f64; 2]>, ToolError> {
    let Some(application) = application else {
        return Ok(None);
    };
    let Some(frame) = element_frame(element).ok().flatten() else {
        return Ok(None);
    };
    let Some(hit) = chess_hit_test(application, center(frame.into())) else {
        return Ok(None);
    };
    if same_element(&hit, element) {
        return Ok(None);
    }
    let Some(parent) = element_attribute(element, "AXParent").ok().flatten() else {
        return Ok(None);
    };
    let Some(parent_frame) = element_frame(&parent).ok().flatten() else {
        return Ok(None);
    };
    let parent_frame = Rect::from(parent_frame);
    // SAFETY: use the native CGRect accessors used by this branch, rather
    // than changing how negative dimensions are interpreted.
    let grid = unsafe {
        ChessGrid {
            min_x: CGRectGetMinX(parent_frame),
            min_y: CGRectGetMinY(parent_frame),
            width: CGRectGetWidth(parent_frame),
            height: CGRectGetHeight(parent_frame),
        }
    };
    let mut matches = MatchingPoints::default();
    for row in 0..ChessGrid::SIDE {
        for column in 0..ChessGrid::SIDE {
            check_cancelled(cancellation)?;
            let point = grid.point(row, column);
            if chess_hit_test(application, point).is_some_and(|hit| same_element(&hit, element)) {
                matches.add(point);
            }
        }
    }
    Ok(matches.mean())
}

fn chess_square_title(title: &str) -> bool {
    let mut characters = title.graphemes(true);
    matches!(
        characters.next(),
        Some("a" | "b" | "c" | "d" | "e" | "f" | "g" | "h")
    ) && matches!(
        characters.next(),
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8")
    )
}

/// The specialized Chess branch treats each native hit-test error as no hit.
fn chess_hit_test(application: &RetainedElement, point: [f64; 2]) -> Option<RetainedElement> {
    let mut hit: AXUIElementRef = std::ptr::null_mut();
    // SAFETY: the application remains retained throughout the AX call; a
    // successful returned reference is copied and its transferred retain freed.
    unsafe {
        let status = AXUIElementCopyElementAtPosition(
            application.as_ptr() as AXUIElementRef,
            point[0] as f32,
            point[1] as f32,
            &mut hit,
        );
        if status != kAXErrorSuccess || hit.is_null() {
            if !hit.is_null() {
                CFRelease(hit.cast());
            }
            return None;
        }
        let retained = RetainedElement::retain(hit as usize);
        CFRelease(hit.cast());
        Some(retained)
    }
}

fn same_element(first: &RetainedElement, second: &RetainedElement) -> bool {
    // SAFETY: both elements retain their native AX objects for this comparison.
    unsafe {
        CFEqual(
            (first.as_ptr() as AXUIElementRef).cast(),
            (second.as_ptr() as AXUIElementRef).cast(),
        ) != 0
    }
}

fn center(rect: Rect) -> [f64; 2] {
    // SAFETY: these native geometry accessors consume CGRect values only.
    unsafe { [CGRectGetMidX(rect), CGRectGetMidY(rect)] }
}

struct ChessGrid {
    min_x: f64,
    min_y: f64,
    width: f64,
    height: f64,
}

impl ChessGrid {
    const SIDE: u32 = 64;

    fn point(&self, row: u32, column: u32) -> [f64; 2] {
        [
            self.min_x + (f64::from(column) + 0.5) * (self.width / 64.0),
            self.min_y + (f64::from(row) + 0.5) * (self.height / 64.0),
        ]
    }
}

#[derive(Default)]
struct MatchingPoints {
    sum: [f64; 2],
    count: u32,
}

impl MatchingPoints {
    fn add(&mut self, point: [f64; 2]) {
        self.sum[0] += point[0];
        self.sum[1] += point[1];
        self.count += 1;
    }

    fn mean(&self) -> Option<[f64; 2]> {
        (self.count > 0).then(|| {
            [
                self.sum[0] / f64::from(self.count),
                self.sum[1] / f64::from(self.count),
            ]
        })
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), ToolError> {
    if cancellation.is_cancelled() {
        Err(failed("Computer Use cancelled before page input dispatch"))
    } else {
        Ok(())
    }
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chess_titles_use_two_characters_and_allow_a_suffix() {
        assert!(chess_square_title("a1"));
        assert!(chess_square_title("h8 black rook"));
        for title in ["a", "A1", "i1", "a9", "a\u{301}1", "a1\u{301}"] {
            assert!(!chess_square_title(title), "{title:?}");
        }
    }

    #[test]
    fn chess_anchor_is_the_mean_of_all_matching_probe_points() {
        let grid = ChessGrid {
            min_x: -40.0,
            min_y: 20.0,
            width: 128.0,
            height: 256.0,
        };
        let mut matches = MatchingPoints::default();
        assert_eq!(matches.mean(), None);
        matches.add(grid.point(0, 0));
        matches.add(grid.point(0, 63));
        matches.add(grid.point(63, 0));
        assert_eq!(matches.mean(), Some([3.0, 106.0]));
    }
}
