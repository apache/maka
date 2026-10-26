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
use gpui::{AppContext, Application, Bounds, Focusable, WindowBounds, WindowOptions, point, px};
use nsh_core::ui::prelude::*;
use nsh_engine::{App, Bundle, EngineConfig};
use nsh_gpui_terminal::{SubmittedFrame, TerminalPlatform};
use nsh_platform_gpui::{AppOptions, AppView};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};
use termina::{
    Event, WindowSize,
    event::{Modifiers, MouseButton, MouseEventKind, SgrMouseEvent},
};

#[class]
struct RailHost {}

#[class]
impl RailHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }
    #[getter]
    pub fn ui_scale_supported(&self) -> bool {
        true
    }
    pub fn preview_ui_scale(&self, _scale: f32) {}
}

#[test]
fn every_visible_turn_mark_can_be_clicked_with_cell_coordinates() {
    // The GPUI engine queue belongs to the first Application in the process.
    // Isolate this Application from the native editor's Application in libtest.
    const CHILD: &str = "MAKA_TURN_RAIL_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                concat!(
                    module_path!(),
                    "::every_visible_turn_mark_can_be_clicked_with_cell_coordinates"
                )
                .strip_prefix("maka_terminal_shell::")
                .unwrap(),
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "rail subprocess failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let mut host = Registry::ui_set("maka/host");
    host.native_values(&["host"]);
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/turn-navigation.tsx"),
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into(), host.into()],
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
    let viewport = caps.logical_viewport().unwrap();
    let frames = Rc::new(RefCell::new(Vec::<SubmittedFrame>::new()));
    let received = frames.clone();
    let platform = TerminalPlatform::new(
        Box::new(gpui_wgpu::WgpuHeadlessRenderer::new().unwrap()),
        Box::new(move |frame| received.borrow_mut().push(frame)),
        Arc::new(|| {}),
    )
    .unwrap();
    let errors = Rc::new(RefCell::new(None));
    let failed = errors.clone();
    let source = source.to_owned();
    let application = Application::with_platform(platform.clone()).run_embedded(move |cx| {
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    point(px(0.0), px(0.0)),
                    viewport,
                ))),
                inactive_frame_interval: None,
                ..Default::default()
            },
            move |window, cx| {
                cx.new(|cx| {
                    let view = AppView::new(
                        AppOptions {
                            terminal_keyboard: true,
                            ..Default::default()
                        },
                        window,
                        cx,
                    );
                    view.on_error(move |message| *failed.borrow_mut() = Some(message.to_owned()));
                    let mut host = Registry::ui_set("maka/host");
                    host.value("host", move || Instance::new(RailHost {}));
                    view.load_with_config(EngineConfig {
                        ui_sets: vec![nsh_base::registry(), host],
                        ..EngineConfig::new(App::Js(Bundle::source(source)))
                    });
                    window.focus(&view.focus_handle(cx), cx);
                    view
                })
            },
        )
        .unwrap();
    });
    for (stage, scale) in [1.0, 0.8, 0.5, 2.0].into_iter().enumerate() {
        caps.ui_scale = scale;
        platform
            .set_viewport(caps.pixel_size().unwrap(), caps.scale_factor())
            .unwrap();
        let keystroke = gpui::Keystroke {
            key: (stage + 1).to_string(),
            modifiers: gpui::Modifiers {
                control: true,
                ..Default::default()
            },
            ..Default::default()
        };
        platform
            .dispatch_input(gpui::PlatformInput::KeyDown(gpui::KeyDownEvent {
                keystroke: keystroke.clone(),
                is_held: false,
                prefer_character_input: false,
            }))
            .unwrap();
        platform
            .dispatch_input(gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let marks = loop {
            platform.pump();
            assert!(
                errors.borrow().is_none(),
                "rail failed to load: {:?}",
                errors.borrow()
            );
            let mut found = None;
            for frame in frames.borrow_mut().drain(..) {
                let frame = frame.complete().unwrap();
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
                "six rendered marks missing at scale {scale}"
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
                platform.pump();
                for frame in frames.borrow_mut().drain(..) {
                    frame.complete().unwrap();
                }
                assert!(
                    errors.borrow().is_none(),
                    "rail input failed: {:?}",
                    errors.borrow()
                );
                if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text()) {
                    assert_eq!(
                        text,
                        format!("turn-{index}"),
                        "scale {scale}, tick {index}, cell ({column}, {row})"
                    );
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "tick {index} not clickable at scale {scale}"
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
                platform.pump();
                for frame in frames.borrow_mut().drain(..) {
                    let frame = frame.complete().unwrap();
                    let width = frame.size().width.0 as usize;
                    let preview = frame.pixels().as_chunks::<4>().0.iter().enumerate().any(
                        |(index, pixel)| index % width < width - 48 && pixel[..3] == [32, 33, 35],
                    );
                    if preview == visible {
                        return;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "preview visible={visible} at scale {scale}"
                );
            }
        };
        move_to(1, 1);
        move_to(80, (marks[0] / 16.0).floor() as i32 + 1);
        wait_for_preview(true);
        move_to(1, 1);
        wait_for_preview(false);
    }
    drop(application);
}
