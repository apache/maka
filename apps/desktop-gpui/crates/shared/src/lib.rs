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

//! Small pieces every feature crate uses: stable element identity derived
//! from domain ids, the interface copy, time formatting for lists, shared
//! layout measures, the menu surface, the theme and Desktop's palettes,
//! the minimum contrast themed text keeps, the code languages the
//! highlighter knows, unified diffs as Desktop reads them, and the embedded
//! assets.
//!
//! Theme access needs no helper here: views read `cx.theme()` through
//! `gpui_kit::component::ActiveTheme` directly.

pub mod assets;
pub mod contrast;
pub mod copy;
pub mod dialog;
pub mod diff;
pub mod hop;
pub mod icons;
mod ids;
pub mod layout;
pub mod links;
pub mod menu;
pub mod palette;
pub mod rows;
pub mod syntax;
pub mod theme;
pub mod time;

pub use ids::domain_element_id;
