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

//! Marks drawn over the selection, in the frozen picture's pixels.

use super::area::{Area, Pixel};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tool {
    Rectangle,
    Ellipse,
    Arrow,
    Pen,
    Marker,
    Text,
    Mosaic,
    Number,
}

impl Tool {
    pub fn named(name: &str) -> Option<Self> {
        Some(match name {
            "rectangle" => Self::Rectangle,
            "ellipse" => Self::Ellipse,
            "arrow" => Self::Arrow,
            "pen" => Self::Pen,
            "marker" => Self::Marker,
            "text" => Self::Text,
            "mosaic" => Self::Mosaic,
            "number" => Self::Number,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Size {
    Small,
    Medium,
    Large,
}

impl Size {
    pub fn named(name: &str) -> Option<Self> {
        Some(match name {
            "small" => Self::Small,
            "medium" => Self::Medium,
            "large" => Self::Large,
            _ => return None,
        })
    }

    /// Line width in points.
    pub fn stroke(self) -> f64 {
        match self {
            Self::Small => 2.0,
            Self::Medium => 4.0,
            Self::Large => 6.0,
        }
    }

    /// Text size in points.
    pub fn font(self) -> f64 {
        match self {
            Self::Small => 14.0,
            Self::Medium => 20.0,
            Self::Large => 28.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Ink {
    pub color: [u8; 3],
    pub size: Size,
    /// Picture pixels per point, so a mark keeps its look in the saved picture.
    pub scale: f64,
}

/// `#RRGGBB`.
pub(crate) fn color(hex: &str) -> Option<[u8; 3]> {
    let hex = hex.strip_prefix('#').filter(|hex| hex.len() == 6)?;
    let channel = |at: usize| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Shape {
    Rectangle(Area),
    Ellipse(Area),
    Arrow(Pixel, Pixel),
    Pen(Vec<Pixel>),
    Marker(Vec<Pixel>),
    Text { at: Pixel, text: String },
    Mosaic(Area),
    Number { at: Pixel, number: u32 },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Mark {
    pub shape: Shape,
    pub ink: Ink,
}

impl Mark {
    /// The mark a drag with `tool` from `at` starts; text and numbers are placed, not dragged.
    pub fn dragged(tool: Tool, at: Pixel, ink: Ink) -> Option<Self> {
        let shape = match tool {
            Tool::Rectangle => Shape::Rectangle(Area::spanning(at, at)),
            Tool::Ellipse => Shape::Ellipse(Area::spanning(at, at)),
            Tool::Arrow => Shape::Arrow(at, at),
            Tool::Pen => Shape::Pen(vec![at]),
            Tool::Marker => Shape::Marker(vec![at]),
            Tool::Mosaic => Shape::Mosaic(Area::spanning(at, at)),
            Tool::Text | Tool::Number => return None,
        };
        Some(Self { shape, ink })
    }

    /// The drag that started at `anchor` reached `to`.
    pub fn extend(&mut self, anchor: Pixel, to: Pixel) {
        match &mut self.shape {
            Shape::Rectangle(area) | Shape::Ellipse(area) | Shape::Mosaic(area) => {
                *area = Area::spanning(anchor, to)
            }
            Shape::Arrow(_, end) => *end = to,
            Shape::Pen(points) | Shape::Marker(points) => {
                if points.last() != Some(&to) {
                    points.push(to)
                }
            }
            Shape::Text { .. } | Shape::Number { .. } => {}
        }
    }

    /// Whether the drag drew anything: a press without a move leaves no box or arrow.
    pub fn drawn(&self) -> bool {
        match &self.shape {
            Shape::Rectangle(area) | Shape::Ellipse(area) | Shape::Mosaic(area) => {
                area.width > 1 && area.height > 1
            }
            Shape::Arrow(from, to) => from != to,
            Shape::Text { text, .. } => !text.trim().is_empty(),
            Shape::Pen(_) | Shape::Marker(_) | Shape::Number { .. } => true,
        }
    }
}

/// The marks made, with those undone kept for redo until a new one is made.
#[derive(Default)]
pub(crate) struct Marks {
    made: Vec<Mark>,
    undone: Vec<Mark>,
}

impl Marks {
    pub fn add(&mut self, mark: Mark) {
        self.made.push(mark);
        self.undone.clear();
    }

    pub fn undo(&mut self) {
        self.undone.extend(self.made.pop());
    }

    pub fn redo(&mut self) {
        self.made.extend(self.undone.pop());
    }

    pub fn clear(&mut self) {
        self.made.clear();
        self.undone.clear();
    }

    pub fn made(&self) -> &[Mark] {
        &self.made
    }

    pub fn next_number(&self) -> u32 {
        let numbers = self
            .made
            .iter()
            .filter(|mark| matches!(mark.shape, Shape::Number { .. }));
        numbers.count() as u32 + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INK: Ink = Ink {
        color: [255, 0, 0],
        size: Size::Medium,
        scale: 2.0,
    };

    #[test]
    fn a_drag_shapes_the_mark_and_a_bare_press_draws_no_box() {
        let mut rectangle = Mark::dragged(Tool::Rectangle, (10, 10), INK).unwrap();
        assert!(!rectangle.drawn());
        rectangle.extend((10, 10), (4, 30));
        assert_eq!(
            rectangle.shape,
            Shape::Rectangle(Area::spanning((4, 10), (10, 30)))
        );
        assert!(rectangle.drawn());

        let mut pen = Mark::dragged(Tool::Pen, (0, 0), INK).unwrap();
        pen.extend((0, 0), (1, 1));
        pen.extend((0, 0), (1, 1));
        assert_eq!(pen.shape, Shape::Pen(vec![(0, 0), (1, 1)]));
        assert!(Mark::dragged(Tool::Text, (0, 0), INK).is_none());
    }

    #[test]
    fn undo_and_redo_step_through_the_marks_until_a_new_one_is_made() {
        let number = |number| Mark {
            shape: Shape::Number { at: (0, 0), number },
            ink: INK,
        };
        let mut marks = Marks::default();
        marks.add(number(1));
        marks.add(number(2));
        assert_eq!(marks.next_number(), 3);
        marks.undo();
        assert_eq!(marks.made(), [number(1)]);
        marks.redo();
        assert_eq!(marks.made(), [number(1), number(2)]);
        marks.undo();
        marks.add(number(9));
        marks.redo();
        assert_eq!(marks.made(), [number(1), number(9)]);
    }

    #[test]
    fn colors_are_six_hex_digits() {
        assert_eq!(color("#2A8FFF"), Some([0x2A, 0x8F, 0xFF]));
        assert_eq!(color("2A8FFF"), None);
        assert_eq!(color("#2A8FF"), None);
    }
}
