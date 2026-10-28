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

use super::Color;
use cursor_overlay::{
    CompiledAnimation, CompiledDrawCommand, CompiledFrame, CompiledGeometry, CompiledStroke,
    CompiledTheme, CompiledTransform, CursorAction,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

/// Artwork is authored here as bounded vector geometry; no runtime theme code.
const TIP: f32 = 29.519;
// The bare product mark from scripts/generate-logo.py is the cursor itself.
// Rotate the whole mark towards Cua's upper-left pointing direction, placing
// the leading edge of its detached bar at the native renderer's pointer tip.
const BRAND_SCALE: f32 = 0.11;
const BRAND_STROKE: f32 = 70.0 * BRAND_SCALE;
const fn brand(x: f32, y: f32) -> [f32; 2] {
    let x = (x - 512.0) * BRAND_SCALE;
    let y = (y - 127.0) * BRAND_SCALE;
    [
        TIP + (x + y) * std::f32::consts::FRAC_1_SQRT_2,
        TIP + (y - x) * std::f32::consts::FRAC_1_SQRT_2,
    ]
}
struct MarkPath {
    points: &'static [[f32; 2]],
    cap: u8,
    join: u8,
}
const MARK: &[MarkPath] = &[
    MarkPath {
        points: &[
            brand(359.1, 537.0),
            brand(512.0, 274.0),
            brand(664.9, 537.0),
        ],
        cap: 1,
        join: 2,
    },
    MarkPath {
        points: &[
            brand(180.0, 845.0),
            brand(359.1, 537.0),
            brand(512.0, 800.0),
        ],
        cap: 2,
        join: 1,
    },
    MarkPath {
        points: &[
            brand(844.0, 845.0),
            brand(664.9, 537.0),
            brand(512.0, 800.0),
        ],
        cap: 2,
        join: 1,
    },
    MarkPath {
        points: &[brand(405.0, 162.0), brand(619.0, 162.0)],
        cap: 2,
        join: 2,
    },
];
fn layers(color: Color) -> [([u8; 4], f32); 3] {
    // Thin edges follow the glyph itself and retain its transparent openings.
    [
        ([23, 34, 59, 170], BRAND_STROKE + 3.0),
        ([255, 255, 255, 255], BRAND_STROKE + 1.5),
        (color.rgba(), BRAND_STROKE),
    ]
}
fn path(points: &[[f32; 2]]) -> CompiledGeometry {
    CompiledGeometry::Path {
        vertices: points.to_vec(),
        in_tangents: vec![[0.0; 2]; points.len()],
        out_tangents: vec![[0.0; 2]; points.len()],
        closed: false,
    }
}
fn command(
    geometry: CompiledGeometry,
    color: [u8; 4],
    width: f32,
    line_cap: u8,
    line_join: u8,
) -> CompiledDrawCommand {
    CompiledDrawCommand {
        geometries: vec![geometry],
        transform: CompiledTransform::default(),
        opacity: 1.0,
        fill: None,
        stroke: Some(CompiledStroke {
            color,
            width,
            line_cap,
            line_join,
        }),
    }
}
pub fn compiled(color: Color) -> CompiledTheme {
    let fill = color.rgba();
    let mut actions = BTreeMap::new();
    for action in CursorAction::ALL {
        let frames = if matches!(action, CursorAction::Click | CursorAction::Key) {
            24
        } else {
            1
        };
        let mut animation = Vec::new();
        for i in 0..frames {
            let progress = i as f32 / frames as f32;
            let mut commands = Vec::new();
            if matches!(action, CursorAction::Click | CursorAction::Key) {
                let size = 10.0 + progress * 50.0;
                let mut ring = fill;
                ring[3] = ((1.0 - progress) * 150.0) as u8;
                commands.push(command(
                    CompiledGeometry::Ellipse {
                        center: [TIP, TIP],
                        size: [size, size],
                    },
                    ring,
                    3.0,
                    2,
                    2,
                ));
            }
            for (color, width) in layers(color) {
                for mark in MARK {
                    commands.push(command(
                        path(mark.points),
                        color,
                        width,
                        mark.cap,
                        mark.join,
                    ));
                }
            }
            animation.push(CompiledFrame { commands });
        }
        actions.insert(
            action.as_str().into(),
            CompiledAnimation {
                still_frame: 0,
                frames: animation,
            },
        );
    }
    CompiledTheme {
        id: format!("org.apache.maka.cursor.{}", color.name()),
        name: format!("Maka {}", color.name()),
        version: "1.2.0".into(),
        author: "Apache Maka".into(),
        license: "Apache-2.0".into(),
        profile: cursor_overlay::THEME_PROFILE.into(),
        source_hash: Sha256::digest(include_bytes!("theme.rs")).into(),
        hotspot: [30, 30],
        actions,
    }
}
pub(crate) fn write_artifacts(directory: &Path) -> Result<(), String> {
    for color in Color::ALL {
        let theme = compiled(color);
        let bytes = cursor_overlay::encode_theme(&theme).map_err(|e| e.to_string())?;
        std::fs::write(directory.join(format!("{}.cua-theme", theme.id)), bytes)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
