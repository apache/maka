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
use serde_json::Value;
use std::fmt::{self, Display};

/// A native X11 point parsed from the public JavaScript number representation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Point([i16; 2]);

/// A coordinate could not be parsed or accepted by its live window.
#[derive(Debug)]
pub(crate) enum Error {
    Parse(serde_json::Error),
    OutsideWindow,
}

impl TryFrom<[f64; 2]> for Point {
    type Error = Error;

    fn try_from(point: [f64; 2]) -> Result<Self, Self::Error> {
        // Reproduce JSON.stringify before native integer deserialization. In
        // particular, 37.0 is an integer and large numbers keep JS spellings.
        let serialized = json::stringify(&point).map_err(Error::Parse)?;
        let value: Value = serde_json::from_str(&serialized).map_err(Error::Parse)?;
        let coordinates = serde_json::from_value(value).map_err(Error::Parse)?;
        Ok(Self(coordinates))
    }
}

impl Point {
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
            Self::OutsideWindow => {
                formatter.write_str("background pointer position is outside the target window")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Parse(error) => Some(error),
            Self::OutsideWindow => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
