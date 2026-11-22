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

//! Cursor configuration shared with the desktop worker protocol.
use serde::{Deserialize, Serialize};

#[cfg(feature = "native-desktop")]
mod native;
#[cfg(feature = "native-desktop")]
pub mod theme;
#[cfg(feature = "native-desktop")]
pub use native::bootstrap;
#[cfg(feature = "native-desktop")]
pub(crate) use native::{Host, RenderState, Spec};

/// Call before starting runtime threads to dispatch a private cursor helper.
#[cfg(not(feature = "native-desktop"))]
pub fn bootstrap() -> Option<std::process::ExitCode> {
    (std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("__maka-cua-cursor"))).then(
        || {
            eprintln!("Maka cursor: native desktop support is not included in this build");
            std::process::ExitCode::FAILURE
        },
    )
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Color {
    Blue,
    Mint,
    Violet,
    Amber,
    Rose,
    Cyan,
}
impl Color {
    pub const ALL: [Self; 6] = [
        Self::Blue,
        Self::Mint,
        Self::Violet,
        Self::Amber,
        Self::Rose,
        Self::Cyan,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Blue => "blue",
            Self::Mint => "mint",
            Self::Violet => "violet",
            Self::Amber => "amber",
            Self::Rose => "rose",
            Self::Cyan => "cyan",
        }
    }
    pub fn rgba(self) -> [u8; 4] {
        match self {
            Self::Blue => [102, 158, 255, 255],
            Self::Mint => [41, 176, 147, 255],
            Self::Violet => [155, 123, 237, 255],
            Self::Amber => [224, 159, 48, 255],
            Self::Rose => [228, 112, 153, 255],
            Self::Cyan => [48, 170, 211, 255],
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub label: Option<String>,
    pub color: Option<Color>,
    pub enabled: Option<bool>,
    pub reduced_motion: Option<bool>,
}
