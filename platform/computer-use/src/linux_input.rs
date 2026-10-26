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

//! Linux native coordinates retain the original integer parsing and window bounds.

use cua_driver_contract::WindowBounds;
use maka_agent_facts::capability::json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt::{self, Display};

/// A native X11 point parsed from the public JavaScript number representation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Point([i16; 2]);

/// A native click target after coordinate and element-field deserialization.
#[derive(Debug)]
pub(crate) enum ClickTarget {
    Coordinates(Point),
    Element(Option<String>),
}

/// A click after the original native integer and mouse-option boundaries.
#[derive(Debug)]
pub(crate) struct Click {
    pub target: ClickTarget,
    pub button: crate::protocol::MouseButton,
    pub count: u32,
}

#[derive(Deserialize)]
struct ClickInput {
    click_count: Option<u32>,
    element_id: Option<String>,
    mouse_button: Option<crate::protocol::MouseButton>,
    x: Option<i16>,
    y: Option<i16>,
}

/// A native scroll with coordinate completeness deferred to its input target.
#[derive(Debug)]
pub(crate) struct Scroll {
    pub x: Option<i16>,
    pub y: Option<i16>,
    pub direction: crate::protocol::Direction,
    pub pixels: u16,
    pub element_id: Option<String>,
}

#[derive(Deserialize)]
struct ScrollInput {
    direction: crate::protocol::Direction,
    element_id: Option<String>,
    pixels: Option<u16>,
    x: Option<i16>,
    y: Option<i16>,
}

/// A drag path after strict native point-record deserialization.
#[derive(Debug)]
pub(crate) struct Drag {
    pub path: Vec<Point>,
}

#[derive(Deserialize)]
struct DragInput {
    path: Vec<DragPoint>,
}

#[derive(Deserialize)]
struct DragPoint {
    x: i16,
    y: i16,
}

/// Native input could not be parsed or accepted by its live window.
#[derive(Debug)]
pub(crate) enum Error {
    Parse(serde_json::Error),
    IncompletePoint,
    IncompleteScrollPoint,
    OutsideWindow,
    UnsupportedElementClickOptions,
    UnknownElementId(String),
    ElementNotInWindow,
}

fn canonical(input: &impl Serialize) -> Result<Value, Error> {
    let serialized = json::stringify(input).map_err(Error::Parse)?;
    serde_json::from_str(&serialized).map_err(Error::Parse)
}

fn parse_command<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, Error> {
    fn sort_fields(value: &mut Value) {
        match value {
            Value::Object(fields) => {
                fields.sort_keys();
                for value in fields.values_mut() {
                    sort_fields(value);
                }
            }
            Value::Array(values) => {
                for value in values {
                    sort_fields(value);
                }
            }
            _ => {}
        }
    }

    let mut value = canonical(&input)?;
    // Preserve the native JSON object's field visitation, including points
    // nested in a drag path, when another crate enables insertion-ordered maps.
    sort_fields(&mut value);
    serde_json::from_value(value).map_err(Error::Parse)
}

impl Click {
    pub(crate) fn parse(input: Value) -> Result<Self, Error> {
        let input: ClickInput = parse_command(input)?;
        let target = match (input.x, input.y) {
            (Some(x), Some(y)) => ClickTarget::Coordinates(Point([x, y])),
            (None, None) => ClickTarget::Element(input.element_id),
            _ => return Err(Error::IncompletePoint),
        };
        let button = input
            .mouse_button
            .unwrap_or(crate::protocol::MouseButton::Left);
        let count = input.click_count.unwrap_or(1);
        if matches!(target, ClickTarget::Element(_))
            && (count != 1 || matches!(button, crate::protocol::MouseButton::Middle))
        {
            return Err(Error::UnsupportedElementClickOptions);
        }
        Ok(Self {
            target,
            button,
            count,
        })
    }
}

impl Scroll {
    pub(crate) fn parse(input: Value) -> Result<Self, Error> {
        let input: ScrollInput = parse_command(input)?;
        Ok(Self {
            x: input.x,
            y: input.y,
            direction: input.direction,
            pixels: input.pixels.unwrap_or(800),
            element_id: input.element_id,
        })
    }
}

impl Drag {
    pub(crate) fn parse(input: Value) -> Result<Self, Error> {
        let input: DragInput = parse_command(input)?;
        Ok(Self {
            path: input
                .path
                .into_iter()
                .map(|point| Point([point.x, point.y]))
                .collect(),
        })
    }
}

/// Recognize public-ID syntax without normalizing the ASCII digit string.
pub(crate) fn public_element_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
}

impl TryFrom<[f64; 2]> for Point {
    type Error = Error;

    fn try_from(point: [f64; 2]) -> Result<Self, Self::Error> {
        // Reproduce JSON.stringify before native integer deserialization. In
        // particular, 37.0 is an integer and large numbers keep JS spellings.
        let value = canonical(&point)?;
        let coordinates = serde_json::from_value(value).map_err(Error::Parse)?;
        Ok(Self(coordinates))
    }
}

impl Point {
    pub(crate) const fn from_coordinates(point: [i16; 2]) -> Self {
        Self(point)
    }

    pub(crate) fn coordinates(self) -> [i16; 2] {
        self.0
    }

    /// Check client-local coordinates against the window's current pixel extent.
    ///
    /// # Errors
    /// Returns the native refusal when either coordinate is outside that extent.
    pub(crate) fn check_window(&self, bounds: &WindowBounds) -> Result<(), Error> {
        let [x, y] = self.0.map(f64::from);
        if x >= 0.0 && y >= 0.0 && x < bounds.width && y < bounds.height {
            Ok(())
        } else {
            Err(Error::OutsideWindow)
        }
    }
}

impl Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => write!(formatter, "failed to parse command input: {error}"),
            Self::IncompletePoint => formatter.write_str("coordinate click requires both x and y"),
            Self::IncompleteScrollPoint => formatter.write_str("x and y must be provided together"),
            Self::OutsideWindow => {
                formatter.write_str("background pointer position is outside the target window")
            }
            Self::UnsupportedElementClickOptions => formatter.write_str(
                "element click supports one left or right click without key or duration; use coordinates for other mouse options",
            ),
            Self::UnknownElementId(id) => write!(
                formatter,
                "Unknown element ID {id} for this window; refresh get_window_state()"
            ),
            Self::ElementNotInWindow => formatter.write_str(
                "element is not in this window's AT-SPI tree; refresh get_window_state()",
            ),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Parse(error) => Some(error),
            Self::IncompletePoint
            | Self::IncompleteScrollPoint
            | Self::OutsideWindow
            | Self::UnsupportedElementClickOptions
            | Self::UnknownElementId(_)
            | Self::ElementNotInWindow => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_click_counts_keep_the_u32_domain_and_null_defaults() {
        for count in [0, 1, 4, u32::MAX] {
            let click = Click::parse(json!({"x":37.0,"y":41.0,"click_count":count}))
                .expect("native u32 click count");
            assert_eq!(click.count, count);
            assert!(matches!(
                click.target,
                ClickTarget::Coordinates(point) if point.coordinates() == [37, 41]
            ));
        }
        for input in [
            json!({"x":37.0,"y":41.0}),
            json!({"x":37.0,"y":41.0,"click_count":null}),
        ] {
            let click = Click::parse(input).expect("native default click count");
            assert_eq!(click.count, 1);
            assert!(matches!(
                click.target,
                ClickTarget::Coordinates(point) if point.coordinates() == [37, 41]
            ));
            assert!(matches!(click.button, crate::protocol::MouseButton::Left));
        }
    }

    #[test]
    fn native_click_parses_count_before_points_regardless_of_json_field_order() {
        for (count, expected) in [
            (json!(-1.0), "invalid value: integer `-1`, expected u32"),
            (
                json!(1.5),
                "invalid type: floating point `1.5`, expected u32",
            ),
            (
                json!(4_294_967_296_u64),
                "invalid value: integer `4294967296`, expected u32",
            ),
        ] {
            for fields in [
                [
                    ("y", json!(41)),
                    ("x", json!(37.9)),
                    ("click_count", count.clone()),
                ],
                [
                    ("click_count", count.clone()),
                    ("x", json!(37.9)),
                    ("y", json!(41)),
                ],
            ] {
                let input = Value::Object(
                    fields
                        .into_iter()
                        .map(|(key, value)| (key.into(), value))
                        .collect(),
                );
                let error = Click::parse(input).expect_err("native count is not a u32");
                assert_eq!(
                    error.to_string(),
                    format!("failed to parse command input: {expected}"),
                );
            }
        }
    }

    #[test]
    fn native_click_parses_both_coordinates_before_completeness_or_zero_count() {
        for input in [
            json!({"x":null,"y":37.9}),
            json!({"x":37.9,"y":null}),
            json!({"x":32768,"y":41,"click_count":0}),
        ] {
            let expected = if input["x"] == 32768 {
                "failed to parse command input: invalid value: integer `32768`, expected i16"
            } else {
                "failed to parse command input: invalid type: floating point `37.9`, expected i16"
            };
            assert_eq!(
                Click::parse(input)
                    .expect_err("invalid native point")
                    .to_string(),
                expected,
            );
        }
        for input in [
            json!({"x":null,"y":41}),
            json!({"x":37}),
            json!({"x":null,"y":41,"click_count":0}),
        ] {
            assert_eq!(
                Click::parse(input)
                    .expect_err("incomplete native point")
                    .to_string(),
                "coordinate click requires both x and y",
            );
        }
        let bounds = WindowBounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let click = Click::parse(json!({"x":-1,"y":41,"click_count":0}))
            .expect("zero count still parses a point");
        let ClickTarget::Coordinates(point) = click.target else {
            panic!("coordinates became an element click");
        };
        assert!(matches!(
            point.check_window(&bounds),
            Err(Error::OutsideWindow)
        ));
    }

    #[test]
    fn native_element_clicks_preserve_ids_and_validate_options_after_types() {
        for id in ["1", "01", "٣", ":1.0:/org/a11y/atspi/accessible/5"] {
            let click = Click::parse(json!({"element_id":id,"mouse_button":"right"}))
                .expect("native element target");
            assert!(matches!(
                click.target,
                ClickTarget::Element(Some(actual)) if actual == id
            ));
            assert!(matches!(click.button, crate::protocol::MouseButton::Right));
        }
        for input in [json!({}), json!({"element_id":null,"x":null,"y":null})] {
            assert!(matches!(
                Click::parse(input).unwrap().target,
                ClickTarget::Element(None)
            ));
        }
        for input in [
            json!({"element_id":null,"click_count":0}),
            json!({"element_id":"missing","click_count":4}),
            json!({"element_id":"1","mouse_button":"middle"}),
        ] {
            assert_eq!(
                Click::parse(input).unwrap_err().to_string(),
                "element click supports one left or right click without key or duration; use coordinates for other mouse options"
            );
        }
        let error = Click::parse(json!({"element_id":null,"click_count":0,"y":37.9}))
            .expect_err("coordinate type errors precede element mouse-option checks");
        assert_eq!(
            error.to_string(),
            "failed to parse command input: invalid type: floating point `37.9`, expected i16"
        );
        let click = Click::parse(
            json!({"element_id":"missing","x":37,"y":41,"click_count":0,"mouse_button":"middle"}),
        )
        .expect("coordinates take precedence over an element ID");
        assert!(matches!(click.target, ClickTarget::Coordinates(_)));
    }

    #[test]
    fn public_element_ids_use_ascii_digits_without_normalizing_the_text() {
        for id in ["0", "1", "01", "0003"] {
            assert!(public_element_id(id), "{id:?}");
        }
        for id in [
            "",
            "٣",
            "１２",
            " 3",
            "3 ",
            "+3",
            "-3",
            "3.0",
            "not-an-element",
        ] {
            assert!(!public_element_id(id), "{id:?}");
        }
        assert_eq!(
            Error::UnknownElementId("01".into()).to_string(),
            "Unknown element ID 01 for this window; refresh get_window_state()"
        );
        assert_eq!(
            Error::ElementNotInWindow.to_string(),
            "element is not in this window's AT-SPI tree; refresh get_window_state()"
        );
    }

    #[test]
    fn native_scroll_keeps_u16_pixels_defaults_and_partial_points_for_dispatch() {
        for (pixels, expected) in [
            (None, 800),
            (Some(Value::Null), 800),
            (Some(json!(0)), 0),
            (Some(json!(65535)), 65535),
        ] {
            let mut input = json!({"direction":"down","element_id":"01","x":37.0,"y":41.0});
            if let Some(pixels) = pixels {
                input["pixels"] = pixels;
            }
            let scroll = Scroll::parse(input).expect("native u16 scroll");
            assert_eq!(scroll.pixels, expected);
            assert_eq!((scroll.x, scroll.y), (Some(37), Some(41)));
            assert_eq!(scroll.element_id.as_deref(), Some("01"));
            assert!(matches!(scroll.direction, crate::protocol::Direction::Down));
        }
        for (input, expected) in [
            (json!({"direction":"down","x":37}), (Some(37), None)),
            (
                json!({"direction":"down","x":null,"y":41}),
                (None, Some(41)),
            ),
            (json!({"direction":"down"}), (None, None)),
        ] {
            let scroll =
                Scroll::parse(input).expect("point completeness belongs to native dispatch");
            assert_eq!((scroll.x, scroll.y), expected);
        }
        for (input, expected) in [
            (
                json!({"direction":"down","x":null,"y":37.9}),
                "invalid type: floating point `37.9`, expected i16",
            ),
            (
                json!({"direction":"down","pixels":100.5,"x":37.9,"y":null}),
                "invalid type: floating point `100.5`, expected u16",
            ),
            (
                json!({"direction":"down","pixels":65536,"x":37.9}),
                "invalid value: integer `65536`, expected u16",
            ),
        ] {
            assert_eq!(
                Scroll::parse(input).unwrap_err().to_string(),
                format!("failed to parse command input: {expected}")
            );
        }
    }

    #[test]
    fn native_drag_strict_point_records_preserve_null_and_float_error_order() {
        let drag = Drag::parse(json!({"path":[{"x":37.0,"y":41.0},{"x":57.0,"y":61.0}]}))
            .expect("the facade projects two native point records");
        assert_eq!(
            drag.path
                .into_iter()
                .map(Point::coordinates)
                .collect::<Vec<_>>(),
            vec![[37, 41], [57, 61]]
        );
        for (path, expected) in [
            (
                json!([{"y":37.9,"x":null},{"x":57,"y":61}]),
                "invalid type: null, expected i16",
            ),
            (
                json!([{"y":null,"x":37.9},{"x":57,"y":61}]),
                "invalid type: floating point `37.9`, expected i16",
            ),
            (
                json!([{"x":37,"y":41},{"y":61.5,"x":null}]),
                "invalid type: null, expected i16",
            ),
            (
                json!([{"x":37,"y":41},{"y":null,"x":57.5}]),
                "invalid type: floating point `57.5`, expected i16",
            ),
        ] {
            assert_eq!(
                Drag::parse(json!({"path":path})).unwrap_err().to_string(),
                format!("failed to parse command input: {expected}")
            );
        }
    }

    #[test]
    fn native_integer_parsing_keeps_javascript_number_spelling() {
        for (input, expected) in [
            ([37.0, 41.0], [37, 41]),
            ([-0.0, 41.0], [0, 41]),
            (
                [f64::from(i16::MIN), f64::from(i16::MAX)],
                [i16::MIN, i16::MAX],
            ),
        ] {
            assert_eq!(
                Point::try_from(input)
                    .expect("valid native integer point")
                    .0,
                expected,
                "input {input:?}"
            );
        }
        for (input, expected) in [
            (
                [37.9, 41.9],
                "invalid type: floating point `37.9`, expected i16",
            ),
            (
                [-1.0, 37.9],
                "invalid type: floating point `37.9`, expected i16",
            ),
            (
                [-0.5, 37.5],
                "invalid type: floating point `-0.5`, expected i16",
            ),
            (
                [32768.0, 65535.0],
                "invalid value: integer `32768`, expected i16",
            ),
            (
                [1_000_000_000_000_000_100.0, 41.0],
                "invalid value: integer `1000000000000000100`, expected i16",
            ),
        ] {
            let error = Point::try_from(input).expect_err("invalid native integer point");
            assert_eq!(
                error.to_string(),
                format!("failed to parse command input: {expected}"),
                "input {input:?}"
            );
            assert!(
                std::error::Error::source(&error).is_some(),
                "parse cause must be retained for input {input:?}"
            );
        }
    }

    #[test]
    fn native_window_checks_use_live_client_extent_after_integer_parsing() {
        let bounds = WindowBounds {
            x: 420.0,
            y: 280.0,
            width: 2400.0,
            height: 1200.0,
        };
        for input in [[0.0, 0.0], [37.0, 41.0], [2399.0, 1199.0]] {
            Point::try_from(input)
                .expect("valid native integer point")
                .check_window(&bounds)
                .unwrap_or_else(|error| panic!("input {input:?}: {error}"));
        }
        for input in [[-1.0, 41.0], [2400.0, 41.0], [37.0, 1200.0]] {
            let error = Point::try_from(input)
                .expect("out-of-window integers remain valid coordinates")
                .check_window(&bounds)
                .expect_err("point is outside the live client extent");
            assert!(matches!(error, Error::OutsideWindow), "input {input:?}");
            assert_eq!(
                error.to_string(),
                "background pointer position is outside the target window",
                "input {input:?}"
            );
        }
    }
}
