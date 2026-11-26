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

use maka_computer_use::cursor::{Color, theme};
fn main() {
    let output = std::env::args()
        .nth(1)
        .expect("usage: cursor-preview output.png");
    let mut image = tiny_skia::Pixmap::new(960, 400).unwrap();
    image.fill(tiny_skia::Color::from_rgba8(242, 247, 255, 255));
    let mut background = tiny_skia::Paint::default();
    background.set_color_rgba8(19, 27, 43, 255);
    image.fill_rect(
        tiny_skia::Rect::from_xywh(0.0, 200.0, 960.0, 200.0).unwrap(),
        &background,
        tiny_skia::Transform::identity(),
        None,
    );
    let state = cursor_overlay::CursorVisualState::default();
    for (index, color) in Color::ALL.into_iter().enumerate() {
        // Preview the actual artifact accepted by the native renderer.
        let bytes = cursor_overlay::encode_theme(&theme::compiled(color)).unwrap();
        let theme = cursor_overlay::decode_theme(&bytes).unwrap();
        for row in [0.0, 200.0] {
            for (y, scale) in [(55.0, 1.0), (125.0, 3.0)] {
                cursor_overlay::paint_compiled_theme(
                    &mut image,
                    &theme,
                    &state,
                    80.0 + index as f32 * 160.0,
                    row + y,
                    std::f32::consts::FRAC_PI_4,
                    scale,
                    1.0,
                );
            }
        }
    }
    image.save_png(output).unwrap();
}
