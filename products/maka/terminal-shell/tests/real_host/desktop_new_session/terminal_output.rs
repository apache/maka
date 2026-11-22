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

use super::{Desktop, Fixture, Modifiers, NativeSurface, PlatformInput, point, px, size};
use nsh_terminal::{DevicePixels, ScrollDelta, ScrollWheelEvent};
use nsh_terminal::{MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent};
use std::path::Path;

pub(super) async fn follows_terminal_output() {
    let fixture = Fixture::open().await;
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let entry = manifest.join("../terminal-shell/tests/real_host/terminal_output_preview.tsx");
    let output = fixture.directory.path().join("terminal-output");
    let source = tokio::task::spawn_blocking(move || {
        let compiled =
            maka_ui_build::compile(&entry, &output, manifest.ancestors().nth(3)).unwrap();
        std::fs::read_to_string(compiled.module).unwrap()
    })
    .await
    .unwrap();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(DevicePixels(960), DevicePixels(640)),
        nsh_core::platform::Appearance::Dark,
        Some((source, "en", "Append batch 1")),
    )
    .await;
    let wheel = |lines| {
        let output = desktop.controls("Terminal output")[0];
        let mut event = ScrollWheelEvent::default();
        event.position = output.center();
        event.delta = ScrollDelta::Lines(point(0., lines));
        desktop
            .platform
            .dispatch_input(PlatformInput::ScrollWheel(event))
            .unwrap();
    };
    let paint = |batch: [u8; 3]| {
        let [bounds] = desktop.controls("Terminal output")[..] else {
            return None;
        };
        desktop.pixels(bounds).and_then(|pixels| {
            pixels
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[..3] == batch)
                .then_some(())
        })
    };

    let first = [210, 40, 100];
    let third = [120, 200, 30];
    let fourth = [230, 130, 20];
    let fifth = [165, 90, 235];
    desktop
        .until("initial output was not painted", || paint(first))
        .await;

    desktop.press("Append batch 1").await;
    desktop.press("Append batch 2").await;
    desktop
        .until("the third batch never reached the viewport", || {
            paint(third)
        })
        .await;
    desktop.artifact("terminal-output-following");

    wheel(100.);
    desktop
        .until("wheel did not reveal the oldest batch", || paint(first))
        .await;
    let short_height = desktop.control("Terminal output").await.size.height;
    desktop.press("Append batch 3").await;
    desktop.control("Append batch 4").await;
    desktop.press("Resize viewport").await;
    desktop
        .until("terminal viewport did not resize", || {
            let [bounds] = desktop.controls("Terminal output")[..] else {
                return None;
            };
            (bounds.size.height > short_height).then_some(())
        })
        .await;
    desktop
        .until("resize or new output displaced the oldest batch", || {
            paint(first)
        })
        .await;
    desktop.artifact("terminal-output-history");

    wheel(-100.);
    desktop
        .until("wheel did not return to the fourth batch", || paint(fourth))
        .await;
    desktop.press("Append batch 4").await;
    desktop
        .until(
            "the fifth batch never reached the viewport after returning to the bottom",
            || paint(fifth),
        )
        .await;
    desktop.artifact("terminal-output-resumed");

    let output = desktop.control("Terminal output").await;
    let scrollbar_x = output.right() - px(5.);
    let top = point(scrollbar_x, output.top() + px(8.));
    let bottom = point(scrollbar_x, output.bottom() - px(8.));
    let drag = |from, to| {
        desktop.hover_at(from);
        for event in [
            PlatformInput::MouseDown(native!(MouseDownEvent {
                button: MouseButton::Left,
                position: from,
                click_count: 1,
            })),
            PlatformInput::MouseMove(native!(MouseMoveEvent {
                position: to,
                pressed_button: Some(MouseButton::Left),
            })),
            PlatformInput::MouseUp(native!(MouseUpEvent {
                button: MouseButton::Left,
                position: to,
                click_count: 1,
            })),
        ] {
            desktop.platform.dispatch_input(event).unwrap();
            desktop.pump();
        }
    };
    drag(bottom, top);
    desktop
        .until("scrollbar did not reveal history", || paint(first))
        .await;
    drag(top, bottom);
    desktop
        .until("scrollbar did not return to the latest batch", || {
            paint(fifth)
        })
        .await;

    desktop.press("Focus terminal input").await;
    desktop.target_after(None).await;
    let mut shift = Modifiers::default();
    shift.shift = true;
    desktop.key_with("pageup", shift);
    desktop.key_with("pageup", shift);
    desktop
        .until("Shift+PageUp did not reveal history", || paint(fourth))
        .await;
    desktop.key_with("pagedown", shift);
    desktop.key_with("pagedown", shift);
    desktop
        .until("Shift+PageDown did not return to the latest batch", || {
            paint(fifth)
        })
        .await;

    desktop.press("Clear output").await;
    desktop
        .until("cleared output was not painted", || paint([180, 100, 35]))
        .await;
    desktop.close().await;
    fixture.finish().await;
}
