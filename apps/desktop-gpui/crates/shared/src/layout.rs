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

//! Measures that several regions share so their edges line up. Each is in
//! `rem`, so it follows the theme's base font (the application zoom).

/// The maximum width of the main pane's content column: the transcript, the
/// composer, and the empty state all use it. 720px at gpui-kit's 16px rem
/// (the base font stays 16px; see `crate::theme`).
pub const COLUMN_MAX_WIDTH_REMS: f32 = 45.;

/// The reading column's side padding inside the plate: the transcript's
/// and the composer's gutters, 24px at gpui-kit's 16px rem (spec §7).
pub const COLUMN_GUTTER_REMS: f32 = 1.5;

/// The maximum width of a sidebar page's column (Extensions, Scheduled
/// tasks), its 24px side padding included. Desktop's module page is a
/// Layout of `contentWidth={MODULE_PAGE_WIDTH}` (900) and `padding={5}`,
/// whose content Astryx aligns to 900 less 20 each side: 860px of content,
/// as here (908 less 24 each side). Settings' column is Desktop's other
/// width, 920 less 24 each side (review round 12).
pub const PAGE_MAX_WIDTH_REMS: f32 = 56.75;
