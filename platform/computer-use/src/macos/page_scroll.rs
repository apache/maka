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

//! Geometry retained with an authoritative native app-state observation.
//!
//! The owner updates this record before attempting capture. It is separate from
//! successful image/AX snapshots: invalidating those observations does not undo
//! an already-retained target's geometry. Dropping the target drops the record.
//! Metadata is prepared by the existing AppKit helper. On-screen capture uses
//! its floating requested size. Page input uses the retained scalar and native
//! controller; desktop verification and off-screen capture parity remain open.

pub(crate) mod clickable_point;
pub(crate) mod dispatch;
pub(crate) mod metadata;
pub(crate) mod target;
pub(crate) mod windows;

use crate::protocol::Direction;
use cua_driver_contract::WindowBounds;
use maka_agent_facts::tools::ToolError;

#[derive(Clone, Copy, Debug)]
pub(crate) struct SizingPolicy {
    use_legacy_sizing: bool,
    normalize_to_points: bool,
}

impl SizingPolicy {
    /// These are source defaults, not observed remote configuration values.
    pub(crate) const SOURCE_DEFAULTS: Self = Self {
        use_legacy_sizing: false,
        normalize_to_points: true,
    };
}

#[derive(Clone)]
pub(crate) struct PageFrame {
    bounds: WindowBounds,
    scaling_factor: f64,
    requested_image_size: [f64; 2],
}

impl PageFrame {
    /// Retain a native observation's geometry and its explicit scalar mapping.
    /// The policy resolves the scalar before integer image sizing; deriving it
    /// from independently rounded image dimensions changes the original map.
    pub(crate) fn from_native_geometry(
        geometry: platform_macos::geometry::NativeWindowGeometry,
        sizing_policy: SizingPolicy,
    ) -> Result<Self, ToolError> {
        let bounds = WindowBounds {
            x: geometry.bounds.x,
            y: geometry.bounds.y,
            width: geometry.bounds.width,
            height: geometry.bounds.height,
        };
        let native_scale = geometry.native_scale;
        if ![
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            native_scale,
        ]
        .iter()
        .all(|value| value.is_finite())
            || bounds.width <= 0.0
            || bounds.height <= 0.0
            || native_scale <= 0.0
        {
            return Err(unavailable());
        }
        let logical_base = sizing_policy.use_legacy_sizing
            && sizing_policy.normalize_to_points
            && native_scale > 1.0;
        let base_scale = if logical_base { 1.0 } else { native_scale };
        let mut requested_image_size = [bounds.width * base_scale, bounds.height * base_scale];
        let resize_scale = if sizing_policy.use_legacy_sizing {
            let longest = requested_image_size[0].max(requested_image_size[1]);
            let first = (2048.0 / longest).min(1.0);
            let shortest = (requested_image_size[0] * first).min(requested_image_size[1] * first);
            first * (768.0 / shortest).min(1.0)
        } else {
            1.0
        };
        for dimension in &mut requested_image_size {
            *dimension *= resize_scale;
        }
        let scaling_factor = 1.0 / (base_scale * resize_scale);
        if requested_image_size
            .iter()
            .chain(std::iter::once(&scaling_factor))
            .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(unavailable());
        }
        Ok(Self {
            bounds,
            scaling_factor,
            requested_image_size,
        })
    }

    /// Requested CGFloat dimensions precede the capture's independent ceil.
    pub(crate) fn requested_image_size(&self) -> [f64; 2] {
        self.requested_image_size
    }

    /// Apply the observation's one scalar on both axes, then translate into
    /// WindowServer coordinates. The action owner retains stale-frame checks.
    pub(crate) fn screen_point(&self, point: [f64; 2]) -> Result<[f64; 2], ToolError> {
        if !point.iter().all(|value| value.is_finite()) {
            return Err(unavailable());
        }
        let point = [
            self.bounds.x + point[0] * self.scaling_factor,
            self.bounds.y + point[1] * self.scaling_factor,
        ];
        if !point.iter().all(|value| value.is_finite()) {
            return Err(unavailable());
        }
        Ok(point)
    }

    /// The indexed path converts the original global anchor back to controller
    /// integers by truncating toward zero before the ordinary move transform.
    pub(crate) fn scaled_position(&self, point: [f64; 2]) -> Result<[i64; 2], ToolError> {
        let point = [
            (point[0] - self.bounds.x) / self.scaling_factor,
            (point[1] - self.bounds.y) / self.scaling_factor,
        ];
        Ok([checked_integer(point[0])?, checked_integer(point[1])?])
    }

    /// This fallback affects distance only. It does not invent an element
    /// center or replace the point selected by the original action route.
    pub(crate) fn extent(
        &self,
        direction: &Direction,
        element_frame: Option<&WindowBounds>,
    ) -> f64 {
        let bounds = element_frame.unwrap_or(&self.bounds);
        match direction {
            Direction::Up | Direction::Down => bounds.height,
            Direction::Left | Direction::Right => bounds.width,
        }
    }
}

fn checked_integer(value: f64) -> Result<i64, ToolError> {
    if !value.is_finite() || !(-9223372036854775808.0..9223372036854775808.0).contains(&value) {
        return Err(ToolError::Failed(
            "native controller coordinate cannot be represented".into(),
        ));
    }
    Ok(value as i64)
}

/// Coordinate inputs and indexed inverse transforms both use the native
/// checked conversion toward zero. Page distances remain unmodified f64.
pub(crate) fn controller_position(point: [f64; 2]) -> Result<[i64; 2], ToolError> {
    Ok([checked_integer(point[0])?, checked_integer(point[1])?])
}

pub(crate) struct IndexedSelection {
    pub(crate) frame: Option<WindowBounds>,
    pub(crate) clickable: clickable_point::ClickablePoint,
}

pub(crate) fn indexed_selection(
    target: &crate::macos::Target,
    index: u64,
    bundle: Option<&str>,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<IndexedSelection, ToolError> {
    target.verify()?;
    let element = target
        .elements
        .get(&index)
        .ok_or_else(|| ToolError::Failed("stale_element: read getAXState first".into()))?;
    Ok(IndexedSelection {
        frame: target::element_frame(element)?,
        clickable: clickable_point::ClickablePoint::new(element, bundle, cancellation)?,
    })
}

pub(crate) fn application(
    pid: i32,
) -> Result<platform_macos::ax::snapshot::RetainedElement, ToolError> {
    use core_foundation::base::CFRelease;
    use platform_macos::ax::{bindings::AXUIElementCreateApplication, snapshot::RetainedElement};
    // SAFETY: transfer the copied AX application's ownership to the wrapper.
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return Err(ToolError::Failed(
                "native AX application unavailable".into(),
            ));
        }
        let retained = RetainedElement::retain(app as usize);
        CFRelease(app.cast());
        Ok(retained)
    }
}

fn unavailable() -> ToolError {
    ToolError::Failed("native page scroll requires retained native frame geometry".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use platform_macos::{geometry::NativeWindowGeometry, windows};

    fn geometry(width: f64, height: f64, native_scale: f64) -> NativeWindowGeometry {
        NativeWindowGeometry {
            window_id: 1,
            pid: 1,
            layer: 0,
            bounds: windows::WindowBounds {
                x: -10.0,
                y: 20.0,
                width,
                height,
            },
            native_scale,
        }
    }

    #[test]
    fn native_sizing_retains_fractional_size_and_one_scalar() {
        let frame = PageFrame::from_native_geometry(
            geometry(100.25, 80.125, 2.0),
            SizingPolicy::SOURCE_DEFAULTS,
        )
        .unwrap();
        assert_eq!(frame.requested_image_size(), [200.5, 160.25]);
        assert_eq!(frame.screen_point([200.0, 160.0]).unwrap(), [90.0, 100.0]);
    }

    #[test]
    fn legacy_normalization_is_an_explicit_sizing_choice() {
        for (normalize_to_points, size, point) in [
            (true, [500.0, 300.0], [90.0, 120.0]),
            (false, [1000.0, 600.0], [40.0, 70.0]),
        ] {
            let frame = PageFrame::from_native_geometry(
                geometry(500.0, 300.0, 2.0),
                SizingPolicy {
                    use_legacy_sizing: true,
                    normalize_to_points,
                },
            )
            .unwrap();
            assert_eq!(frame.requested_image_size(), size);
            assert_eq!(frame.screen_point([100.0, 100.0]).unwrap(), point);
        }
    }

    #[test]
    fn legacy_sizing_applies_both_resize_stages() {
        let frame = PageFrame::from_native_geometry(
            geometry(4000.0, 2000.0, 2.0),
            SizingPolicy {
                use_legacy_sizing: true,
                normalize_to_points: true,
            },
        )
        .unwrap();
        assert_eq!(frame.requested_image_size(), [1536.0, 768.0]);
        assert_eq!(frame.scaling_factor, 1.0 / 0.384);
    }

    #[test]
    fn invalid_native_metadata_is_rejected() {
        for metadata in [
            geometry(0.0, 100.0, 2.0),
            geometry(100.0, 100.0, f64::NAN),
            geometry(f64::MAX, 100.0, 2.0),
        ] {
            assert!(
                PageFrame::from_native_geometry(metadata, SizingPolicy::SOURCE_DEFAULTS).is_err()
            );
        }
    }

    #[test]
    fn native_controller_coordinates_truncate_before_the_one_scalar_map() {
        let frame = PageFrame::from_native_geometry(
            geometry(100.25, 80.125, 2.0),
            SizingPolicy::SOURCE_DEFAULTS,
        )
        .unwrap();
        let direct = controller_position([3.9, -3.9]).unwrap();
        assert_eq!(direct, [3, -3]);
        assert_eq!(
            frame
                .screen_point(direct.map(|value| value as f64))
                .unwrap(),
            [-8.5, 18.5]
        );
        let indexed = frame.scaled_position([-9.1, 19.1]).unwrap();
        assert_eq!(indexed, [1, -1]);
        assert_eq!(
            frame
                .screen_point(indexed.map(|value| value as f64))
                .unwrap(),
            [-9.5, 19.5]
        );
        assert_eq!(controller_position([0.5, -0.5]).unwrap(), [0, 0]);
        assert!(controller_position([9223372036854775808.0, 0.0]).is_err());
        assert_eq!(
            controller_position([-9223372036854775808.0, 0.0]).unwrap(),
            [i64::MIN, 0]
        );
    }
}
