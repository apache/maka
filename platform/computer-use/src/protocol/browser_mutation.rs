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

//! Closed locator mutations transported through the existing Computer Use owner.

use serde::{Deserialize, Serialize};

/// A locator mutation after public JavaScript argument normalization.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserMutationOperation {
    /// Activate an element with one mouse click.
    Click {
        #[serde(default)]
        options: BrowserClickOptions,
    },
    /// Activate an element with a double click.
    DoubleClick {
        #[serde(default)]
        options: BrowserClickOptions,
    },
    /// Replace editable content with text.
    Fill {
        value: String,
        #[serde(default)]
        options: BrowserTextOptions,
    },
    /// Insert text without replacing existing content.
    Type {
        value: String,
        #[serde(default)]
        options: BrowserTextOptions,
    },
    /// Press a keyboard chord on the focused element.
    Press {
        value: String,
        #[serde(default)]
        options: BrowserTextOptions,
    },
    /// Deliver characters while retaining the original focused target.
    PressSequentially {
        value: String,
        #[serde(default)]
        options: BrowserTextOptions,
    },
    /// Select one or more options from a native select element.
    SelectOption {
        values: Vec<BrowserSelectOption>,
        #[serde(default)]
        options: BrowserTextOptions,
    },
    /// Change checked state only when it differs from the requested state.
    SetChecked {
        checked: bool,
        #[serde(default)]
        options: BrowserCheckOptions,
    },
}

/// Mouse buttons supported by locator click operations.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BrowserMouseButton {
    /// The primary mouse button.
    #[default]
    Left,
    /// The secondary mouse button.
    Right,
    /// The middle mouse button.
    Middle,
}

/// Keyboard modifiers supported by locator mouse operations.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum BrowserKeyboardModifier {
    /// The Alt modifier.
    Alt,
    /// The Control modifier.
    Control,
    /// Meta on macOS and Control on other hosts.
    ControlOrMeta,
    /// The Meta modifier.
    Meta,
    /// The Shift modifier.
    Shift,
}

/// Options accepted by locator click and double-click operations.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserClickOptions {
    /// The requested button, defaulting to left.
    pub button: Option<BrowserMouseButton>,
    /// Modifiers held only around this pointer operation.
    #[serde(default)]
    pub modifiers: Vec<BrowserKeyboardModifier>,
    /// Skip the action checks for which the backend supports forcing.
    #[serde(default)]
    pub force: bool,
    /// A positive JavaScript integer, capped by the operation's own deadline.
    pub timeout_ms: Option<f64>,
}

/// Options accepted by locator text and option-selection operations.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserTextOptions {
    /// A positive JavaScript integer, capped by the operation's own deadline.
    pub timeout_ms: Option<f64>,
}

/// Options accepted by locator checked-state operations.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserCheckOptions {
    /// Skip the action checks for which the backend supports forcing.
    #[serde(default)]
    pub force: bool,
    /// A positive JavaScript integer, capped by the operation's own deadline.
    pub timeout_ms: Option<f64>,
}

/// A native option matched by its value, label, index, or their combination.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserSelectOption {
    /// Match the native option value exactly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Match the native option label exactly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Match a nonnegative integer option position.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<f64>,
}

impl BrowserMutationOperation {
    #[cfg(feature = "native-desktop")]
    pub(crate) fn timeout_ms(&self) -> Option<f64> {
        match self {
            Self::Click { options } | Self::DoubleClick { options } => options.timeout_ms,
            Self::Fill { options, .. }
            | Self::Type { options, .. }
            | Self::Press { options, .. }
            | Self::PressSequentially { options, .. }
            | Self::SelectOption { options, .. } => options.timeout_ms,
            Self::SetChecked { options, .. } => options.timeout_ms,
        }
    }
}
