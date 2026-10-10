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

//! The task's trace: what its Turns did, step by step with their time,
//! tokens and status, what its recorded calls used and cost, and how full
//! its context window is, as Maka Desktop's Inspector shows them
//! (`apps/desktop/src/renderer/application/contracts/session-inspector/`),
//! read from the Runtime Host through `execution.inspect.query`,
//! `usage.query` and `context.diagnostics.query`.
//!
//! - [`model`] works out what is shown: the trace's pages merged, the
//!   timeline's rows, the overview's figures, and how they are written.
//! - [`read`] sends the three reads and pages the trace.
//! - [`InspectorState`] keeps the selected task's trace, usage summary and
//!   context snapshot, refreshed from the Session's own signals while the
//!   face shows.
//! - [`InspectorView`] is the workbar's Trace face: the overview over the
//!   timeline. Its keys bind in [`INSPECTOR_CONTEXT`] ([`init`]).

pub mod model;
pub mod read;
mod state;
mod view;

use gpui_kit::{App, KeyBinding};

pub use state::{InspectorState, REFRESH_DEBOUNCE, Signal, signal_of};
pub use view::{InspectorView, InspectorViewEvent};

/// Key context of the Trace face, while anything in it has focus.
pub const INSPECTOR_CONTEXT: &str = "InspectorFace";

gpui_kit::actions!(
    inspector,
    [
        /// Give the panel back: the face is left.
        Back,
    ]
);

/// Binds the face's keys. Call once after `gpui_kit::init`: Escape anywhere
/// in the face gives the conversation its place back.
pub fn init(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", Back, Some(INSPECTOR_CONTEXT))]);
}

#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod tests;
