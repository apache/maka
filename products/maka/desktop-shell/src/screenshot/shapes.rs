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

//! Rectangles seen in the picture itself, flat blocks of color and outlined boxes, for the many
//! apps (web views, Electron, terminals) whose controls Accessibility does not describe.

use super::{
    area::{Area, NEAR},
    paint::bitmap,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGContext, CGImage,
};

/// Runs of one color past which the picture is mostly photo or gradient, with no boxes to find;
/// bounds the memory the search takes.
const MOST_RUNS: usize = 4_000_000;
/// Pixels from a box's border that still count as its outline.
const BAND: u32 = 3;

/// RGBA rows, `stride` bytes apart.
pub(super) struct Pixels<'a> {
    pub data: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub stride: usize,
}

/// The boxes in `picture` at least `smallest` pixels on each side.
pub(super) fn find(picture: &CGImage, smallest: i64) -> Vec<Area> {
    let width = CGImage::width(Some(picture));
    let height = CGImage::height(Some(picture));
    let Some(context) = bitmap(width, height, picture) else {
        return Vec::new();
    };
    let all = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(width as f64, height as f64),
    );
    CGContext::draw_image(Some(&context), all, Some(picture));
    let stride = CGBitmapContextGetBytesPerRow(Some(&context));
    let data = CGBitmapContextGetData(Some(&context));
    if data.is_null() {
        return Vec::new();
    }
    // SAFETY: the context owns `height` rows of `stride` bytes, alive until it drops below, and
    // nothing else draws into it meanwhile.
    let data = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), stride * height) };
    rectangles(
        &Pixels {
            data,
            width,
            height,
            stride,
        },
        smallest,
    )
}

/// A horizontal stretch of one color. Flat colors on screen are exact; any tolerance lets the
/// soft edge of a rounded box, a step of color a pixel, join it to what is around it.
struct Run {
    start: u32,
    end: u32,
    color: [u8; 3],
}

#[derive(Clone, Copy)]
struct Shape {
    left: u32,
    right: u32,
    top: u32,
    bottom: u32,
    count: u64,
    /// Pixels on the bounding box's border.
    edge: u64,
    /// Pixels within `BAND` of it.
    band: u64,
}

/// Regions of one color whose shape is a box: filled, like a button or a panel with content on
/// it, or outlined, like a field or a frame, largest first.
pub(super) fn rectangles(pixels: &Pixels, smallest: i64) -> Vec<Area> {
    let Some((runs, rows)) = runs(pixels) else {
        return Vec::new();
    };
    let mut parent: Vec<u32> = (0..runs.len() as u32).collect();
    for y in 1..pixels.height {
        let above = rows[y - 1]..rows[y];
        let mut first = above.start;
        for here in rows[y]..rows[y + 1] {
            let run = &runs[here];
            while first < above.end && runs[first].end < run.start {
                first += 1;
            }
            let mut other = first;
            while other < above.end && runs[other].start <= run.end {
                if runs[other].color == run.color {
                    join(&mut parent, other as u32, here as u32);
                }
                other += 1;
            }
        }
    }

    let mut label = vec![u32::MAX; runs.len()];
    let mut shapes: Vec<Shape> = Vec::new();
    let mut of = Vec::with_capacity(runs.len());
    for y in 0..pixels.height {
        for (index, run) in runs.iter().enumerate().take(rows[y + 1]).skip(rows[y]) {
            let root = root(&mut parent, index as u32) as usize;
            if label[root] == u32::MAX {
                label[root] = shapes.len() as u32;
                shapes.push(Shape {
                    left: u32::MAX,
                    right: 0,
                    top: y as u32,
                    bottom: 0,
                    count: 0,
                    edge: 0,
                    band: 0,
                });
            }
            let shape = &mut shapes[label[root] as usize];
            shape.left = shape.left.min(run.start);
            shape.right = shape.right.max(run.end);
            shape.bottom = y as u32;
            shape.count += u64::from(run.end - run.start + 1);
            of.push(label[root]);
        }
    }
    drop(label);
    drop(parent);

    let big = |shape: &Shape| {
        i64::from(shape.right - shape.left + 1) >= smallest
            && i64::from(shape.bottom - shape.top + 1) >= smallest
    };
    let mut index = 0;
    for y in 0..pixels.height as u32 {
        for run in &runs[rows[y as usize]..rows[y as usize + 1]] {
            let shape = &mut shapes[of[index] as usize];
            index += 1;
            if !big(shape) {
                continue;
            }
            let length = u64::from(run.end - run.start + 1);
            if y == shape.top || y == shape.bottom {
                shape.edge += length;
            }
            shape.edge += u64::from(run.start == shape.left) + u64::from(run.end == shape.right);
            shape.band += if y < shape.top + BAND || y + BAND > shape.bottom {
                length
            } else {
                overlap(run, shape.left, shape.left + BAND - 1)
                    + overlap(run, shape.right + 1 - BAND, shape.right)
            };
        }
    }

    let whole = (pixels.width as u32, pixels.height as u32);
    let mut boxes: Vec<Area> = shapes
        .iter()
        .filter(|shape| big(shape))
        .filter(|shape| {
            let width = u64::from(shape.right - shape.left + 1);
            let height = u64::from(shape.bottom - shape.top + 1);
            let straight = shape.edge * 5 >= 2 * (width + height) * 3;
            let filled = shape.count * 2 >= width * height;
            let outlined = shape.band * 5 >= shape.count * 4;
            (width as u32, height as u32) != whole && straight && (filled || outlined)
        })
        .map(|shape| {
            Area::spanning(
                (i64::from(shape.left), i64::from(shape.top)),
                (i64::from(shape.right), i64::from(shape.bottom)),
            )
        })
        .collect();
    boxes.sort_by_key(|area| std::cmp::Reverse(area.size()));
    let mut kept: Vec<Area> = Vec::new();
    for area in boxes {
        if !kept.iter().any(|other| other.near(area, NEAR)) {
            kept.push(area);
        }
    }
    kept
}

/// The picture's runs of one color, and where each row's start, with one more for the end.
fn runs(pixels: &Pixels) -> Option<(Vec<Run>, Vec<usize>)> {
    let mut runs = Vec::new();
    let mut rows = Vec::with_capacity(pixels.height + 1);
    for y in 0..pixels.height {
        rows.push(runs.len());
        let row = &pixels.data[y * pixels.stride..][..pixels.width * 4];
        let color = |x: usize| [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]];
        let mut start = 0;
        let mut first = color(0);
        for x in 1..pixels.width {
            let here = color(x);
            if here != first {
                runs.push(Run {
                    start: start as u32,
                    end: x as u32 - 1,
                    color: first,
                });
                start = x;
                first = here;
            }
        }
        runs.push(Run {
            start: start as u32,
            end: pixels.width as u32 - 1,
            color: first,
        });
        if runs.len() > MOST_RUNS {
            return None;
        }
    }
    rows.push(runs.len());
    Some((runs, rows))
}

fn root(parent: &mut [u32], mut at: u32) -> u32 {
    while parent[at as usize] != at {
        let up = parent[parent[at as usize] as usize];
        parent[at as usize] = up;
        at = up;
    }
    at
}

fn join(parent: &mut [u32], a: u32, b: u32) {
    let (a, b) = (root(parent, a), root(parent, b));
    if a != b {
        parent[a.max(b) as usize] = a.min(b);
    }
}

fn overlap(run: &Run, from: u32, to: u32) -> u64 {
    let (start, end) = (run.start.max(from), run.end.min(to));
    if start <= end {
        u64::from(end - start + 1)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BACKGROUND: [u8; 3] = [240, 240, 240];

    struct Canvas {
        width: usize,
        height: usize,
        data: Vec<u8>,
    }

    impl Canvas {
        fn new(width: usize, height: usize) -> Self {
            let mut canvas = Self {
                width,
                height,
                data: vec![255; width * height * 4],
            };
            canvas.fill(
                Area::spanning((0, 0), (width as i64 - 1, height as i64 - 1)),
                BACKGROUND,
            );
            canvas
        }

        fn set(&mut self, x: i64, y: i64, [r, g, b]: [u8; 3]) {
            let at = (y as usize * self.width + x as usize) * 4;
            self.data[at..at + 3].copy_from_slice(&[r, g, b]);
        }

        fn fill(&mut self, area: Area, color: [u8; 3]) {
            for y in area.y..=area.bottom() {
                for x in area.x..=area.right() {
                    self.set(x, y, color);
                }
            }
        }

        fn outline(&mut self, area: Area, color: [u8; 3]) {
            for x in area.x..=area.right() {
                self.set(x, area.y, color);
                self.set(x, area.bottom(), color);
            }
            for y in area.y..=area.bottom() {
                self.set(area.x, y, color);
                self.set(area.right(), y, color);
            }
        }

        fn rectangles(&self) -> Vec<Area> {
            rectangles(
                &Pixels {
                    data: &self.data,
                    width: self.width,
                    height: self.height,
                    stride: self.width * 4,
                },
                10,
            )
        }
    }

    #[test]
    fn filled_and_outlined_boxes_are_found_through_what_is_drawn_on_them() {
        let mut canvas = Canvas::new(200, 120);
        let panel = Area::spanning((10, 10), (189, 109));
        let button = Area::spanning((20, 20), (79, 43));
        let field = Area::spanning((100, 20), (179, 43));
        canvas.fill(panel, [255, 255, 255]);
        canvas.fill(button, [30, 120, 250]);
        // A label on the button.
        canvas.fill(Area::spanning((30, 28), (60, 34)), [255, 255, 255]);
        canvas.outline(field, [180, 180, 180]);
        let found = canvas.rectangles();
        for area in [panel, button, field] {
            assert!(found.contains(&area), "{area:?} not in {found:?}");
        }
    }

    #[test]
    fn letters_gradients_and_small_marks_are_not_boxes() {
        let mut canvas = Canvas::new(120, 80);
        // An M, taller than the smallest box, mostly diagonal strokes.
        for y in 0..30 {
            canvas.set(10, 10 + y, [0, 0, 0]);
            canvas.set(40, 10 + y, [0, 0, 0]);
            canvas.set(10 + y / 2, 10 + y, [0, 0, 0]);
            canvas.set(40 - y / 2, 10 + y, [0, 0, 0]);
        }
        // A gradient no two neighbors of which are one color.
        for y in 50..80 {
            for x in 50..120 {
                canvas.set(x, y, [(x * 5) as u8, (y * 7) as u8, 0]);
            }
        }
        canvas.fill(Area::spanning((60, 10), (65, 15)), [200, 0, 0]);
        assert_eq!(canvas.rectangles(), []);
    }

    #[test]
    fn a_frame_and_its_fill_one_pixel_in_are_one_box() {
        let mut canvas = Canvas::new(100, 100);
        let frame = Area::spanning((10, 10), (89, 89));
        canvas.fill(frame, [255, 255, 255]);
        canvas.outline(frame, [100, 100, 100]);
        assert_eq!(canvas.rectangles(), [frame]);
    }
}
