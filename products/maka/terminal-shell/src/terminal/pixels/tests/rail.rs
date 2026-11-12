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

use super::super::{
    mapping::Mapping,
    probe::{Capabilities, MouseCoordinates},
};
use super::TerminalSurface;
use nsh_core::prelude::*;
use nsh_engine::{App, Bundle, EngineConfig};
use nsh_terminal::CandidateFrame;
use nsh_terminal::NativeSurface;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
use termina::{
    Event, WindowSize,
    event::{Modifiers, MouseButton, MouseEventKind, SgrMouseEvent},
};

#[class]
struct RailHost {
    active_scale: Arc<AtomicU32>,
}

#[class]
impl RailHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
    #[getter]
    pub fn ui_scale_factor(&self) -> f32 {
        f32::from_bits(self.active_scale.load(Ordering::Relaxed))
    }
}

pub(super) fn every_visible_turn_mark_can_be_clicked_with_cell_coordinates() {
    let mut host = maka_workbench::bindings::ui_registry();
    host.native_values(&["host"]);
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/turn-navigation.tsx"),
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into(), host.into()],
        asset_root_from: Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")),
        ..Default::default()
    })
    .unwrap();
    check_marks(&bundle.code);
}

fn check_marks(source: &str) {
    // Keep the actual cell conversion, including UI zoom, in the path under test.
    let mut caps = Capabilities {
        size: WindowSize {
            cols: 80,
            rows: 40,
            pixel_width: Some(640),
            pixel_height: Some(640),
        },
        mouse: MouseCoordinates::Cells,
        ui_scale: 1.0,
        protocol: None,
        synchronized: false,
        sixel_geometry: Default::default(),
    };
    let frames = Rc::new(RefCell::new(Vec::<CandidateFrame>::new()));
    let received = frames.clone();
    let active_scale = Arc::new(AtomicU32::new(1.0f32.to_bits()));
    let host_scale = active_scale.clone();
    let mut host = maka_workbench::bindings::ui_registry();
    host.value("host", move || {
        Instance::new(RailHost {
            active_scale: host_scale.clone(),
        })
    });
    let platform = TerminalSurface::new(
        EngineConfig {
            environment: nsh_core::platform::Environment {
                color_scheme: nsh_core::platform::ColorScheme::Dark,
                ..Default::default()
            },
            ui_sets: vec![nsh_base::registry(), host],
            ..EngineConfig::new(App::Js(Bundle::source(source.to_owned())))
        },
        caps.pixel_size().unwrap(),
        caps.scale_factor(),
        Box::new(move |frame| {
            received
                .borrow_mut()
                .push(frame.submit().unwrap().complete().unwrap());
        }),
        Arc::new(|| {}),
    )
    .unwrap();
    for (stage, font_scale) in [1.0f32, 0.8, 0.5, 2.0].into_iter().enumerate() {
        active_scale.store(font_scale.to_bits(), Ordering::Relaxed);
        caps.ui_scale = font_scale;
        platform
            .set_viewport(caps.pixel_size().unwrap(), caps.scale_factor())
            .unwrap();
        let keystroke = {
            let mut value = nsh_terminal::Keystroke::default();
            value.key = (stage + 1).to_string();
            value.modifiers = {
                let mut value = nsh_terminal::Modifiers::default();
                value.control = true;
                value
            };
            value
        };
        platform
            .dispatch_input(nsh_terminal::PlatformInput::KeyDown({
                let mut value = nsh_terminal::KeyDownEvent::default();
                value.keystroke = keystroke.clone();
                value.is_held = false;
                value.prefer_character_input = false;
                value
            }))
            .unwrap();
        platform
            .dispatch_input(nsh_terminal::PlatformInput::KeyUp({
                let mut value = nsh_terminal::KeyUpEvent::default();
                value.keystroke = keystroke;
                value
            }))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let marks = loop {
            platform.pump_with_draw(true);
            {
                let error = platform.take_error();
                assert!(error.is_none(), "rail failed to load: {:?}", error);
            }
            let mut found = None;
            for frame in frames.borrow_mut().drain(..) {
                let width = frame.size().width.0 as usize;
                let height = frame.size().height.0 as usize;
                if frame.pixels()[..3] != [22 + stage as u8, 23 + stage as u8, 25 + stage as u8] {
                    continue;
                }
                let mut marks = Vec::new();
                let mut previous = None;
                for y in 0..height {
                    // Fractional zoom antialiases the stroke into its background.
                    let has_tick = (width - 24..width)
                        .filter(|x| {
                            let pixel = &frame.pixels()[(y * width + x) * 4..][..3];
                            pixel[0] >= 35 && pixel[0] <= 55 && pixel[1] >= 36 && pixel[2] >= 39
                        })
                        .count()
                        >= 3;
                    if has_tick {
                        if previous != Some(y - 1) {
                            marks.push(y as f32 + 0.5);
                        }
                        previous = Some(y);
                    }
                }
                if marks.len() == 6 {
                    found = Some(marks);
                }
            }
            if let Some(marks) = found {
                break marks;
            }
            assert!(
                Instant::now() < deadline,
                "six rendered marks missing at scale {font_scale}"
            );
        };
        let mut mapping = Mapping::default();
        for (index, y) in marks.iter().copied().enumerate() {
            let column = 80;
            let row = (y / 16.0).floor() as i32 + 1;
            for kind in [
                MouseEventKind::Moved,
                MouseEventKind::Down(MouseButton::Left),
                MouseEventKind::Up(MouseButton::Left),
            ] {
                let event = Event::SgrMouse(SgrMouseEvent {
                    kind,
                    x: column,
                    y: row,
                    modifiers: Modifiers::NONE,
                });
                platform
                    .dispatch_input(mapping.input(&event, caps).unwrap())
                    .unwrap();
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                platform.pump_with_draw(true);
                frames.borrow_mut().clear();
                {
                    let error = platform.take_error();
                    assert!(error.is_none(), "rail input failed: {:?}", error);
                }
                if let Some(text) = platform.take_clipboard_write() {
                    assert_eq!(
                        text,
                        format!("turn-{index}"),
                        "scale {font_scale}, tick {index}, cell ({column}, {row})"
                    );
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "tick {index} not clickable at scale {font_scale}"
                );
            }
        }
        let move_to = |x, y| {
            let event = Event::SgrMouse(SgrMouseEvent {
                kind: MouseEventKind::Moved,
                x,
                y,
                modifiers: Modifiers::NONE,
            });
            platform
                .dispatch_input(Mapping::default().input(&event, caps).unwrap())
                .unwrap();
        };
        let wait_for_preview = |visible| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                platform.pump_with_draw(true);
                for frame in frames.borrow_mut().drain(..) {
                    let width = frame.size().width.0 as usize;
                    let preview = frame.pixels().as_chunks::<4>().0.iter().enumerate().any(
                        |(index, pixel)| index % width < width - 48 && pixel[..3] == [42, 43, 46],
                    );
                    if preview == visible {
                        return;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "preview visible={visible} at scale {font_scale}"
                );
            }
        };
        move_to(1, 1);
        move_to(80, (marks[0] / 16.0).floor() as i32 + 1);
        wait_for_preview(true);
        move_to(1, 1);
        wait_for_preview(false);
    }
    platform.shutdown();
}
