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

//! The measures of the Maka look (`docs/design/polish-2026-09-26.md`) that
//! the transcript and the composer share.
//!
//! The spec gives pixel values. The window's rem stays at gpui-kit's 16 px
//! (the kit's scale is built on it; body text is 14 px through the window
//! root's default text size), so each value is written here as rems at that
//! base: it lands on the spec's pixel at the default zoom and follows the
//! application zoom like the rest of the kit's scale.

use gpui_kit::{Pixels, Rems, Window, rems};

/// The base font the spec's pixel values are converted at: gpui-kit's rem.
const DESIGN_BASE_PX: f32 = 16.;

/// A spec pixel value as rems at the 16 px base.
pub(crate) const fn dp(px: f32) -> Rems {
    rems(px / DESIGN_BASE_PX)
}

/// A spec pixel value in the window's pixels, for the APIs that take
/// [`Pixels`] (a button's corner radius, shadow geometry).
pub(crate) fn dp_px(px: f32, window: &Window) -> Pixels {
    window.rem_size() * (px / DESIGN_BASE_PX)
}

/// Radii (spec §3): control, surface, modal, chat.
pub(crate) const RADIUS_CONTROL: f32 = 6.;
pub(crate) const RADIUS_SURFACE: f32 = 10.;
pub(crate) const RADIUS_MODAL: f32 = 12.;
pub(crate) const RADIUS_CHAT: f32 = 28.;

/// Type sizes, on Maka's role scale (12 / 14 / 16 / 18 / 20 / 22; review
/// round 6): transcript body 14/22, labels 14/500, supporting 12, code
/// 14/20 (Maka's code role) in code blocks and prompts, and the compact
/// 12/20 mono of tool rows and their output, which pairs the supporting
/// size with the code family.
pub(crate) const BODY_SIZE: f32 = 14.;
pub(crate) const BODY_LINE: f32 = 22.;
pub(crate) const LABEL_SIZE: f32 = 14.;
pub(crate) const SUPPORTING_SIZE: f32 = 12.;
pub(crate) const CODE_SIZE: f32 = 14.;
pub(crate) const CODE_COMPACT_SIZE: f32 = 12.;
pub(crate) const CODE_LINE: f32 = 20.;

/// The side padding of the reading column inside the plate (spec §7), in
/// spec pixels: `shared::layout`'s, which the window's layout reads too.
pub(crate) const COLUMN_GUTTER: f32 = shared::layout::COLUMN_GUTTER_REMS * DESIGN_BASE_PX;

/// The reading column's widest measure, shared with the empty state and the
/// sidebar-less layouts through `shared::layout`.
pub(crate) fn column_max_width() -> Rems {
    rems(shared::layout::COLUMN_MAX_WIDTH_REMS)
}
