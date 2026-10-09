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

//! The pages the sidebar opens on the plate instead of a task: Desktop's
//! `NavSelection` sections other than the Session list
//! (packages/ui/src/nav-selection.ts), in the order its rail lists them
//! (`SessionSidebarNav` in packages/ui/src/session-sidebar-nav.tsx).
//! WorkHub is not one of them: this client does not offer it.

use gpui_kit::Action;
use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::Icon;
use shared::copy::Text;
use shared::copy::extensions as copy;
use workspace::actions::{OpenExtensions, OpenScheduledTasks};

/// A page of the main area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SidebarPage {
    /// Skills (Desktop's `extensions` section).
    Extensions,
    /// Scheduled tasks (Desktop's `automations` section).
    ScheduledTasks,
}

impl SidebarPage {
    /// Every page, in the sidebar's order.
    pub const ALL: [Self; 2] = [Self::Extensions, Self::ScheduledTasks];

    /// A stable key: element ids, launch flags, tests.
    pub fn key(self) -> &'static str {
        match self {
            Self::Extensions => "extensions",
            Self::ScheduledTasks => "scheduled-tasks",
        }
    }

    /// The page a key names.
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|page| page.key() == key)
    }

    /// Its title, in the sidebar and on the plate's header.
    pub fn title(self) -> Text {
        match self {
            Self::Extensions => copy::EXTENSIONS,
            Self::ScheduledTasks => copy::SCHEDULED_TASKS,
        }
    }

    /// The palette's command that opens it.
    pub fn command(self) -> Text {
        match self {
            Self::Extensions => copy::OPEN_EXTENSIONS,
            Self::ScheduledTasks => copy::OPEN_SCHEDULED_TASKS,
        }
    }

    /// Desktop's glyph for it (`Blocks`, `Timer`).
    pub fn icon(self) -> Icon {
        Icon::new(match self {
            Self::Extensions => AssetIcon::Blocks,
            Self::ScheduledTasks => AssetIcon::Timer,
        })
    }

    /// The Action that opens it.
    pub fn action(self) -> Box<dyn Action> {
        match self {
            Self::Extensions => Box::new(OpenExtensions),
            Self::ScheduledTasks => Box::new(OpenScheduledTasks),
        }
    }
}
