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

use super::probe::Capabilities;
use std::num::NonZeroU64;
use termina::escape::osc::{NshTextInput, NshTextInputCaretRect, Osc};

#[derive(Clone, Copy, Default, Debug, Eq, PartialEq)]
pub(super) struct Cursor {
    column: u16,
    row: u16,
    candidate: Option<NshTextInputCaretRect>,
}

impl Cursor {
    pub fn from_native(
        caret: Option<gpui::Bounds<gpui::Pixels>>,
        candidate: Option<gpui::Bounds<gpui::Pixels>>,
        caps: Capabilities,
    ) -> Self {
        let Some(pixels) = caps.pixel_size() else {
            return Self::default();
        };
        let scale = f64::from(caps.scale_factor());
        let cell = |position: gpui::Pixels, extent: i32, count: u16| {
            f64::from(f32::from(position)) * scale * f64::from(count) / f64::from(extent)
        };
        let (column, row) =
            caret
                .filter(|bounds| caps.contains(bounds.origin))
                .map_or((0, 0), |bounds| {
                    (
                        (cell(bounds.origin.x, pixels.width.0, caps.size.cols).floor() as u16)
                            .min(caps.size.cols - 1),
                        (cell(bounds.origin.y, pixels.height.0, caps.size.rows).floor() as u16)
                            .min(caps.size.rows - 1),
                    )
                });
        let candidate = candidate
            .filter(|bounds| caps.contains(bounds.origin))
            .and_then(|bounds| {
                NshTextInputCaretRect::new(
                    cell(bounds.origin.x, pixels.width.0, caps.size.cols),
                    cell(bounds.origin.y, pixels.height.0, caps.size.rows),
                    cell(
                        bounds.origin.x + bounds.size.width,
                        pixels.width.0,
                        caps.size.cols,
                    ),
                    cell(
                        bounds.origin.y + bounds.size.height,
                        pixels.height.0,
                        caps.size.rows,
                    ),
                )
            });
        Self {
            column,
            row,
            candidate,
        }
    }

    pub fn bytes(self, nonce: Option<NonZeroU64>) -> Vec<u8> {
        let mut bytes = format!(
            "\x1b[{};{}H",
            u32::from(self.row) + 1,
            u32::from(self.column) + 1
        )
        .into_bytes();
        if let Some(nonce) = nonce {
            bytes.extend_from_slice(
                Osc::NshTextInput(NshTextInput::Caret {
                    nonce,
                    bounds: self.candidate,
                })
                .to_string()
                .as_bytes(),
            );
        }
        bytes
    }

    pub fn frame_parts(self, mut image: Vec<u8>, nonce: Option<NonZeroU64>) -> [Vec<u8>; 2] {
        const END_SYNC: &[u8] = b"\x1b[?2026l";
        let synchronized = image.ends_with(END_SYNC);
        if synchronized {
            image.truncate(image.len() - END_SYNC.len());
        }
        let mut tail = self.bytes(nonce);
        if synchronized {
            tail.extend_from_slice(END_SYNC);
        }
        [image, tail]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::pixels::probe::{MouseCoordinates, Protocol, SixelGeometry};

    fn caps(scale: u16) -> Capabilities {
        Capabilities {
            size: termina::WindowSize {
                cols: 100,
                rows: 40,
                pixel_width: Some(1000 * scale),
                pixel_height: Some(640 * scale),
            },
            mouse: MouseCoordinates::Cells,
            protocol: Some(Protocol::Kitty),
            synchronized: true,
            sixel_geometry: SixelGeometry::Unknown,
            ui_scale: 1.0,
        }
    }

    fn caret(x: f32, y: f32) -> Option<gpui::Bounds<gpui::Pixels>> {
        Some(gpui::Bounds::new(
            gpui::point(gpui::px(x), gpui::px(y)),
            gpui::size(gpui::px(2.0), gpui::px(20.0)),
        ))
    }

    #[test]
    fn native_caret_uses_real_cell_metrics_and_density_without_resizing_the_image() {
        let nonce = NonZeroU64::new(7).unwrap();
        for scale in [1, 2] {
            let cursor = Cursor::from_native(caret(123.0, 41.0), caret(123.0, 41.0), caps(scale));
            assert_eq!(cursor.bytes(None), b"\x1b[3;13H");
            assert_eq!(
                cursor.candidate.unwrap().edges(),
                [12.3, 2.5625, 12.5, 3.8125]
            );
            let image = b"\x1b[HIMAGE\x1b[H\x1b[?2026l".to_vec();
            let original = image.as_ptr();
            let parts = cursor.frame_parts(image, Some(nonce));
            assert_eq!(
                parts[0].as_ptr(),
                original,
                "retain the original owned image buffer"
            );
            assert_eq!(
                parts.concat(),
                b"\x1b[HIMAGE\x1b[H\x1b[3;13H\x1b]777;nsh-text-input;caret;7;12.3;2.5625;12.5;3.8125\x1b\\\x1b[?2026l"
            );
        }
        let cursor = Cursor::from_native(caret(990.0, 630.0), caret(990.0, 630.0), caps(1));
        assert_eq!(
            cursor.frame_parts(b"\x1b[HIMAGE".to_vec(), None).concat(),
            b"\x1b[HIMAGE\x1b[40;100H"
        );
        assert_eq!(
            Cursor::from_native(None, None, caps(1)).bytes(None),
            b"\x1b[1;1H"
        );
        assert_eq!(
            Cursor::from_native(None, None, caps(1)).bytes(Some(nonce)),
            b"\x1b[1;1H\x1b]777;nsh-text-input;caret;7\x1b\\"
        );
        assert_eq!(
            Cursor::from_native(caret(-1.0, 12.0), caret(-1.0, 12.0), caps(1)).bytes(None),
            b"\x1b[1;1H"
        );
        let marked = Cursor::from_native(caret(143.0, 41.0), caret(123.0, 41.0), caps(1));
        assert_eq!(
            marked.bytes(Some(nonce)),
            b"\x1b[3;15H\x1b]777;nsh-text-input;caret;7;12.3;2.5625;12.5;3.8125\x1b\\"
        );
        let mut zoomed = caps(1);
        zoomed.ui_scale = 1.25;
        assert_eq!(
            Cursor::from_native(caret(128.0, 32.0), caret(128.0, 32.0), zoomed)
                .candidate
                .unwrap()
                .edges(),
            [16.0, 2.5, 16.25, 4.0625]
        );
        let mut cropped = caps(1);
        cropped.protocol = Some(Protocol::Sixel);
        cropped.sixel_geometry = SixelGeometry::Finite {
            width: std::num::NonZeroU32::new(800).unwrap(),
            height: std::num::NonZeroU32::new(600).unwrap(),
        };
        let cursor = Cursor::from_native(caret(799.0, 559.0), caret(799.0, 559.0), cropped);
        assert_eq!(cursor.bytes(None), b"\x1b[35;80H");
        assert_eq!(
            cursor.candidate.unwrap().edges(),
            [79.9, 34.9375, 80.1, 36.1875]
        );
        assert_eq!(
            Cursor::from_native(caret(801.0, 559.0), caret(801.0, 559.0), cropped).bytes(None),
            b"\x1b[1;1H"
        );
    }
}
