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

//! The Extensions page, as Maka Desktop's Extensions › Skills
//! (apps/desktop/src/renderer/features/module-hub/ and
//! packages/ui/src/skills-panel.tsx): the Skills of the project new tasks
//! go into, the built-in Skills and local sources to install, and what can
//! be done to each.
//!
//! - [`SkillCatalog`] reads the catalog's three views
//!   (`skill.catalog.query`, every page at one revision) and makes every
//!   change to it (`skill.catalog.mutate`: install, enable, pin, update,
//!   delete; `skill.catalog.preview-update` for the update review),
//!   rebuilding a change after a revision conflict and reading the views
//!   again after it, and on every new connection.
//! - [`ExtensionsView`] is the page: the header's search, refresh, and Add
//!   menu, which the shell puts in the plate's header row, and the Skills
//!   tab under it, with each installed Skill's detail in a dialog.
//! - [`import`] and [`locations`] are the local actions Desktop's main
//!   process runs, for a Host on this machine: importing a SKILL.md into
//!   the source library, the Skill locations, and a Skill's SKILL.md.

mod catalog;
pub mod import;
pub mod locations;
mod page;

use gpui_kit::App;

pub use catalog::{
    ActionFailure, CatalogView, FailureReason, InstallSource, Listing, Projection, SkillCatalog,
};
pub use page::{
    ExtensionsContext, ExtensionsView, OpenSkill, Opener, SKILL_LIST_CONTEXT, SelectFirstSkill,
    SelectLastSkill, SelectNextSkill, SelectPreviousSkill,
};

/// Binds the page's keys. Call once after `gpui_kit::init`, before
/// building menus.
pub fn init(cx: &mut App) {
    page::bind_keys(cx);
    shared::menu::init(cx);
}

#[cfg(test)]
mod tests;
