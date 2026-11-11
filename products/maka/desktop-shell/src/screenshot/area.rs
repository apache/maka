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

//! Selection geometry in the frozen picture's pixels.

/// A pixel of the picture, from its top left.
pub(crate) type Pixel = (i64, i64);

/// A rectangle of whole pixels, never empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Area {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl Area {
    /// The pixels from `a` to `b`, both included.
    pub fn spanning(a: Pixel, b: Pixel) -> Self {
        Self {
            x: a.0.min(b.0),
            y: a.1.min(b.1),
            width: (a.0 - b.0).abs() + 1,
            height: (a.1 - b.1).abs() + 1,
        }
    }

    pub fn right(self) -> i64 {
        self.x + self.width - 1
    }

    pub fn bottom(self) -> i64 {
        self.y + self.height - 1
    }

    pub fn contains(self, (x, y): Pixel) -> bool {
        (self.x..=self.right()).contains(&x) && (self.y..=self.bottom()).contains(&y)
    }

    pub fn intersection(self, other: Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        (x <= right && y <= bottom).then(|| Self::spanning((x, y), (right, bottom)))
    }

    /// Moved by `(dx, dy)`, kept inside `bounds` with its size.
    pub fn moved(self, (dx, dy): Pixel, bounds: Self) -> Self {
        Self {
            x: (self.x + dx).clamp(bounds.x, bounds.right() + 1 - self.width),
            y: (self.y + dy).clamp(bounds.y, bounds.bottom() + 1 - self.height),
            ..self
        }
    }

    /// The edges within `slop` pixels of `pixel`, for a resize; none when it is not on the border.
    pub fn edges_at(self, (x, y): Pixel, slop: i64) -> Edges {
        let near = |a: i64, b: i64| (a - b).abs() <= slop;
        let across = (self.x - slop..=self.right() + slop).contains(&x);
        let along = (self.y - slop..=self.bottom() + slop).contains(&y);
        Edges {
            left: along && near(x, self.x),
            right: along && near(x, self.right()) && !near(x, self.x),
            top: across && near(y, self.y),
            bottom: across && near(y, self.bottom()) && !near(y, self.y),
        }
    }

    /// With the `edges` moved to `pixel`; an edge dragged past the opposite one flips the area.
    pub fn resized(self, edges: Edges, (x, y): Pixel) -> Self {
        let left = if edges.left { x } else { self.x };
        let right = if edges.right { x } else { self.right() };
        let top = if edges.top { y } else { self.y };
        let bottom = if edges.bottom { y } else { self.bottom() };
        Self::spanning((left, top), (right, bottom))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Edges {
    pub left: bool,
    pub right: bool,
    pub top: bool,
    pub bottom: bool,
}

impl Edges {
    pub fn any(self) -> bool {
        self.left || self.right || self.top || self.bottom
    }
}

/// The front-most of `windows` (front to back) under `pixel`, or the whole picture.
pub(crate) fn target(windows: &[Area], pixel: Pixel, whole: Area) -> Area {
    windows
        .iter()
        .copied()
        .find(|window| window.contains(pixel))
        .unwrap_or(whole)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHOLE: Area = Area {
        x: 0,
        y: 0,
        width: 100,
        height: 80,
    };

    #[test]
    fn a_drag_in_any_direction_selects_the_pixels_it_crossed() {
        assert_eq!(
            Area::spanning((30, 40), (10, 5)),
            Area {
                x: 10,
                y: 5,
                width: 21,
                height: 36
            }
        );
    }

    #[test]
    fn hovering_targets_the_front_window_and_falls_back_to_the_whole_picture() {
        let front = Area::spanning((10, 10), (40, 40));
        let back = Area::spanning((0, 0), (60, 60));
        assert_eq!(target(&[front, back], (20, 20), WHOLE), front);
        assert_eq!(target(&[front, back], (50, 50), WHOLE), back);
        assert_eq!(target(&[front, back], (90, 70), WHOLE), WHOLE);
    }

    #[test]
    fn moving_keeps_the_selection_on_the_picture() {
        let area = Area::spanning((10, 10), (29, 19));
        assert_eq!(area.moved((-50, 0), WHOLE).x, 0);
        assert_eq!(area.moved((500, 500), WHOLE).right(), 99);
        assert_eq!(area.moved((500, 500), WHOLE).bottom(), 79);
        assert_eq!(area.moved((1, 0), WHOLE).x, 11);
    }

    #[test]
    fn a_corner_resizes_both_of_its_edges_and_flips_past_the_opposite_ones() {
        let area = Area::spanning((10, 10), (30, 30));
        let corner = area.edges_at((30, 31), 2);
        assert_eq!(
            corner,
            Edges {
                right: true,
                bottom: true,
                ..Edges::default()
            }
        );
        assert_eq!(
            area.resized(corner, (40, 50)),
            Area::spanning((10, 10), (40, 50))
        );
        assert_eq!(
            area.resized(corner, (0, 0)),
            Area::spanning((0, 0), (10, 10))
        );
        assert!(!area.edges_at((20, 20), 2).any());
    }
}
