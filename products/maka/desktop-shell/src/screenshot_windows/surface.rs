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

use super::*;

use annotate::Tool;

#[derive(Clone)]
pub(super) struct Mark {
    pub tool: Tool,
    pub points: Vec<POINT>,
    pub color: u32,
    pub width: i32,
    pub font: i32,
    pub text: String,
}

pub(super) struct Surface {
    pub dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    pub width: i32,
    pub height: i32,
}

impl Surface {
    pub(super) fn paint_mark(&mut self, mark: &annotate::Mark, region: area::Area, clip: Area) {
        use annotate::Shape;
        let point = |(x, y): area::Pixel| POINT {
            x: (x - region.x) as i32,
            y: (y - region.y) as i32,
        };
        let corners = |area: area::Area| {
            vec![
                point((area.x, area.y)),
                point((area.right() + 1, area.bottom() + 1)),
            ]
        };
        let (tool, points, text) = match &mark.shape {
            Shape::Rectangle(bounds) => (Tool::Rectangle, corners(*bounds), String::new()),
            Shape::Ellipse(bounds) => (Tool::Ellipse, corners(*bounds), String::new()),
            Shape::Mosaic(bounds) => (Tool::Mosaic, corners(*bounds), String::new()),
            Shape::Arrow(from, to) => (Tool::Arrow, vec![point(*from), point(*to)], String::new()),
            Shape::Pen(points) => (
                Tool::Pen,
                points.iter().copied().map(point).collect(),
                String::new(),
            ),
            Shape::Marker(points) => (
                Tool::Marker,
                points.iter().copied().map(point).collect(),
                String::new(),
            ),
            Shape::Number { at, number } => (Tool::Number, vec![point(*at)], number.to_string()),
            Shape::Text { at, text } => (Tool::Text, vec![point(*at)], text.clone()),
        };
        let [red, green, blue] = mark.ink.color;
        self.mark(
            &Mark {
                tool,
                points,
                text,
                color: u32::from_le_bytes([red, green, blue, 0]),
                width: (mark.ink.size.stroke() * mark.ink.scale).round() as i32,
                font: (mark.ink.size.font() * mark.ink.scale).round() as i32,
            },
            clip,
        );
    }

    pub fn new(picture: &Picture) -> Result<Self, String> {
        // SAFETY: a top-down DIB owns exactly width * height * 4 bytes. Its DC and
        // selected bitmap stay on the creating thread and are released together.
        unsafe {
            let dc = CreateCompatibleDC(null_mut());
            if dc.is_null() {
                return Err(last_error("CreateCompatibleDC"));
            }
            let mut bits = null_mut();
            let bitmap = CreateDIBSection(
                dc,
                &picture.info(),
                DIB_RGB_COLORS,
                &mut bits,
                null_mut(),
                0,
            );
            if bitmap.is_null() {
                DeleteDC(dc);
                return Err(last_error("CreateDIBSection"));
            }
            let previous = SelectObject(dc, bitmap);
            std::ptr::copy_nonoverlapping(
                picture.pixels.as_ptr(),
                bits.cast(),
                picture.pixels.len(),
            );
            Ok(Self {
                dc,
                bitmap,
                previous,
                bits: bits.cast(),
                width: picture.width,
                height: picture.height,
            })
        }
    }

    pub fn load(&mut self, picture: &Picture) {
        assert_eq!(
            picture.pixels.len(),
            self.width as usize * self.height as usize * 4
        );
        // SAFETY: the length matches the allocation and pending GDI writes finish before copying.
        unsafe {
            GdiFlush();
            std::ptr::copy_nonoverlapping(picture.pixels.as_ptr(), self.bits, picture.pixels.len());
        }
    }

    pub fn bounds(&self) -> Area {
        Area {
            left: 0,
            top: 0,
            right: self.width,
            bottom: self.height,
        }
    }

    pub fn pixels(&self) -> &[u8] {
        // SAFETY: the top-down DIB owns this many bytes and pending GDI writes finish before reading.
        unsafe {
            GdiFlush();
            std::slice::from_raw_parts(self.bits, self.width as usize * self.height as usize * 4)
        }
    }

    pub fn picture(&self, area: Area) -> Picture {
        // SAFETY: synchronization makes completed GDI output visible in the DIB allocation.
        unsafe {
            GdiFlush();
            let mut pixels = Vec::with_capacity(area.width() as usize * area.height() as usize * 4);
            for row in area.top..area.bottom {
                let offset = (row as usize * self.width as usize + area.left as usize) * 4;
                pixels.extend_from_slice(std::slice::from_raw_parts(
                    self.bits.add(offset),
                    area.width() as usize * 4,
                ));
            }
            for pixel in pixels.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            Picture {
                width: area.width(),
                height: area.height(),
                pixels,
            }
        }
    }

    pub fn mark(&mut self, mark: &Mark, clip: Area) {
        let start = mark.points[0];
        let end = *mark.points.last().unwrap();
        let bounds = Area {
            left: start.x,
            top: start.y,
            right: end.x,
            bottom: end.y,
        };
        if mark.tool == Tool::Marker {
            unsafe {
                GdiFlush();
            }
            let pixels = unsafe {
                std::slice::from_raw_parts_mut(
                    self.bits,
                    self.width as usize * self.height as usize * 4,
                )
            };
            let radius = (mark.width * 2).max(1);
            let channels = [
                (mark.color >> 16) as u8,
                (mark.color >> 8) as u8,
                mark.color as u8,
            ];
            let mut spans = std::collections::BTreeMap::<i32, Vec<(i32, i32)>>::new();
            for (index, &to) in mark.points.iter().enumerate() {
                let from = mark.points[index.saturating_sub(1)];
                let dx = to.x - from.x;
                let dy = to.y - from.y;
                let steps = dx.abs().max(dy.abs()).max(1);
                for step in 0..=steps {
                    let x = from.x + (i64::from(dx) * i64::from(step) / i64::from(steps)) as i32;
                    let y = from.y + (i64::from(dy) * i64::from(step) / i64::from(steps)) as i32;
                    for row in (y - radius).max(clip.top)..=(y + radius).min(clip.bottom - 1) {
                        let half =
                            (((radius * radius - (row - y) * (row - y)) as f64).sqrt()) as i32;
                        spans
                            .entry(row)
                            .or_default()
                            .push(((x - half).max(clip.left), (x + half + 1).min(clip.right)));
                    }
                }
            }
            for (row, mut runs) in spans {
                runs.sort_unstable();
                let mut painted = clip.left;
                for (left, right) in runs {
                    for column in left.max(painted)..right {
                        let offset = (row as usize * self.width as usize + column as usize) * 4;
                        for (index, channel) in channels.iter().enumerate() {
                            pixels[offset + index] = ((u16::from(pixels[offset + index]) * 3
                                + u16::from(*channel))
                                / 4) as u8;
                        }
                    }
                    painted = painted.max(right);
                }
            }
            return;
        }
        if mark.tool == Tool::Mosaic {
            let bounds = Area {
                left: bounds.left.max(clip.left),
                top: bounds.top.max(clip.top),
                right: bounds.right.min(clip.right),
                bottom: bounds.bottom.min(clip.bottom),
            };
            if !bounds.valid() {
                return;
            }
            // SAFETY: the clipped bounds address only allocated pixels, after flushing GDI.
            unsafe {
                GdiFlush();
                let pixels = std::slice::from_raw_parts_mut(
                    self.bits,
                    self.width as usize * self.height as usize * 4,
                );
                mosaic(pixels, self.width, bounds, mark.width * 4 + 6);
            }
            return;
        }
        // SAFETY: all drawing is clipped to the selection; temporary GDI objects are
        // deselected by RestoreDC before deletion. Text buffers live through DrawTextW.
        unsafe {
            let saved = SaveDC(self.dc);
            IntersectClipRect(self.dc, clip.left, clip.top, clip.right, clip.bottom);
            let pen = CreatePen(PS_SOLID, mark.width, mark.color);
            SelectObject(self.dc, pen);
            SelectObject(self.dc, GetStockObject(NULL_BRUSH));
            SetBkMode(self.dc, TRANSPARENT as i32);
            SetTextColor(self.dc, mark.color);
            let mut font = null_mut();
            let mut brush = null_mut();
            match mark.tool {
                Tool::Rectangle => {
                    Rectangle(
                        self.dc,
                        bounds.left,
                        bounds.top,
                        bounds.right,
                        bounds.bottom,
                    );
                }
                Tool::Ellipse => {
                    Ellipse(
                        self.dc,
                        bounds.left,
                        bounds.top,
                        bounds.right,
                        bounds.bottom,
                    );
                }
                Tool::Pen => {
                    if mark.points.len() == 1 {
                        brush = CreateSolidBrush(mark.color);
                        SelectObject(self.dc, brush);
                        let radius = (mark.width / 2).max(1);
                        Ellipse(
                            self.dc,
                            start.x - radius,
                            start.y - radius,
                            start.x + radius + 1,
                            start.y + radius + 1,
                        );
                    } else {
                        Polyline(self.dc, mark.points.as_ptr(), mark.points.len() as i32);
                    }
                }
                Tool::Arrow => {
                    let angle = ((end.y - start.y) as f64).atan2((end.x - start.x) as f64);
                    let length = (mark.width * 4 + 12) as f64;
                    let points = [
                        start,
                        end,
                        POINT {
                            x: end.x - (length * (angle - 0.5).cos()) as i32,
                            y: end.y - (length * (angle - 0.5).sin()) as i32,
                        },
                        end,
                        POINT {
                            x: end.x - (length * (angle + 0.5).cos()) as i32,
                            y: end.y - (length * (angle + 0.5).sin()) as i32,
                        },
                    ];
                    Polyline(self.dc, points.as_ptr(), points.len() as i32);
                }
                Tool::Text | Tool::Number => {
                    let size = if mark.tool == Tool::Number {
                        (mark.font as f64 * 0.8).round() as i32
                    } else {
                        mark.font
                    };
                    font = ui_font(size);
                    SelectObject(self.dc, font);
                    let mut rect = RECT {
                        left: start.x,
                        top: start.y,
                        right: clip.right,
                        bottom: clip.bottom,
                    };
                    let flags = if mark.tool == Tool::Number {
                        brush = CreateSolidBrush(mark.color);
                        SelectObject(self.dc, brush);
                        let radius = (mark.font as f64 * 0.7).round() as i32;
                        Ellipse(
                            self.dc,
                            start.x - radius,
                            start.y - radius,
                            start.x + radius,
                            start.y + radius,
                        );
                        SetTextColor(self.dc, 0x00ffffff);
                        rect = RECT {
                            left: start.x - radius,
                            top: start.y - radius,
                            right: start.x + radius,
                            bottom: start.y + radius,
                        };
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE
                    } else {
                        DT_WORDBREAK | DT_EDITCONTROL
                    };
                    DrawTextW(
                        self.dc,
                        wide(&mark.text).as_ptr(),
                        -1,
                        &mut rect,
                        flags | DT_NOPREFIX,
                    );
                }
                _ => {}
            }
            RestoreDC(self.dc, saved);
            DeleteObject(pen);
            if !font.is_null() {
                DeleteObject(font);
            }
            if !brush.is_null() {
                DeleteObject(brush);
            }
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: restore the original bitmap before releasing the owned bitmap and DC.
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

pub(super) fn ui_font(height: i32) -> HFONT {
    // SAFETY: the face name is terminated and copied by GDI; caller owns the returned font.
    unsafe {
        CreateFontW(
            -height,
            0,
            0,
            0,
            400,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            0,
            0,
            CLEARTYPE_QUALITY as u32,
            0,
            wide("Segoe UI").as_ptr(),
        )
    }
}

fn mosaic(pixels: &mut [u8], stride: i32, area: Area, block: i32) {
    for top in (area.top..area.bottom).step_by(block as usize) {
        for left in (area.left..area.right).step_by(block as usize) {
            let bottom = (top + block).min(area.bottom);
            let right = (left + block).min(area.right);
            let mut sum = [0u32; 3];
            let count = ((bottom - top) * (right - left)) as u32;
            for row in top..bottom {
                for column in left..right {
                    let offset = (row as usize * stride as usize + column as usize) * 4;
                    for channel in 0..3 {
                        sum[channel] += pixels[offset + channel] as u32;
                    }
                }
            }
            for row in top..bottom {
                for column in left..right {
                    let offset = (row as usize * stride as usize + column as usize) * 4;
                    for channel in 0..3 {
                        pixels[offset + channel] = (sum[channel] / count) as u8;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mosaic_averages_only_the_selected_pixels() {
        let mut pixels = vec![
            0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 240, 240, 240, 255,
        ];
        mosaic(
            &mut pixels,
            4,
            Area {
                left: 1,
                top: 0,
                right: 3,
                bottom: 1,
            },
            10,
        );
        assert_eq!(
            pixels,
            [
                0, 0, 0, 255, 150, 150, 150, 255, 150, 150, 150, 255, 240, 240, 240, 255
            ]
        );
    }

    #[test]
    fn exported_mosaic_includes_last_row_and_column() {
        let image = Picture {
            width: 4,
            height: 4,
            pixels: (0..16).flat_map(|value| [value * 8, 12, 31, 255]).collect(),
        };
        let mut surface = Surface::new(&image).unwrap();
        let region = area::Area::spanning((10, 20), (13, 23));
        let mark = annotate::Mark {
            shape: annotate::Shape::Mosaic(area::Area::spanning((12, 22), (11, 21))),
            ink: annotate::Ink {
                size: annotate::Size::Small,
                scale: 1.,
                color: [0; 3],
            },
        };
        surface.paint_mark(&mark, region, surface.bounds());
        let exported = surface.picture(surface.bounds());
        for (index, pixel) in exported.pixels.chunks_exact(4).enumerate() {
            let inside = (1..=2).contains(&(index % 4)) && (1..=2).contains(&(index / 4));
            assert_eq!(
                pixel[0],
                if inside { 60 } else { index as u8 * 8 },
                "pixel {index}"
            );
        }
    }

    #[test]
    fn rendered_marks_are_clipped_and_exported() {
        let picture = Picture {
            width: 40,
            height: 40,
            pixels: vec![255; 40 * 40 * 4],
        };
        let mut surface = Surface::new(&picture).unwrap();
        let clip = Area {
            left: 10,
            top: 10,
            right: 30,
            bottom: 30,
        };
        surface.mark(
            &Mark {
                tool: Tool::Rectangle,
                points: vec![POINT { x: 5, y: 5 }, POINT { x: 25, y: 25 }],
                color: 255,
                width: 3,
                font: 20,
                text: String::new(),
            },
            clip,
        );
        let full = surface.picture(Area {
            left: 0,
            top: 0,
            right: 40,
            bottom: 40,
        });
        assert_eq!(
            &full.pixels[(5 * 40 + 5) * 4..(5 * 40 + 5) * 4 + 4],
            &[255; 4]
        );
        let exported = surface.picture(clip);
        assert!(
            exported
                .pixels
                .chunks_exact(4)
                .any(|pixel| pixel == [0, 0, 255, 255])
        );
    }

    #[test]
    fn annotation_tools_survive_composition_and_png_export() {
        let picture = Picture {
            width: 120,
            height: 100,
            pixels: vec![255; 120 * 100 * 4],
        };
        let area = Area {
            left: 0,
            top: 0,
            right: 120,
            bottom: 100,
        };
        for tool in [
            Tool::Rectangle,
            Tool::Ellipse,
            Tool::Arrow,
            Tool::Pen,
            Tool::Text,
            Tool::Number,
            Tool::Marker,
        ] {
            let mut surface = Surface::new(&picture).unwrap();
            surface.mark(
                &Mark {
                    tool,
                    points: vec![POINT { x: 20, y: 20 }, POINT { x: 90, y: 75 }],
                    color: 255,
                    width: 3,
                    font: 20,
                    text: "Test 标注 1".into(),
                },
                area,
            );
            let rendered = surface.picture(area);
            assert_ne!(
                rendered.pixels, picture.pixels,
                "{tool:?} must be present in the exported image"
            );
            let mut encoded = Vec::new();
            rendered.write_png(&mut encoded).unwrap();
            let mut reader = png::Decoder::new(std::io::Cursor::new(encoded))
                .read_info()
                .unwrap();
            let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
            let output = reader.next_frame(&mut decoded).unwrap();
            let expected: Vec<_> = rendered
                .pixels
                .chunks_exact(4)
                .flat_map(|pixel| [pixel[2], pixel[1], pixel[0]])
                .collect();
            assert_eq!(&decoded[..output.buffer_size()], expected);
        }
    }
}
