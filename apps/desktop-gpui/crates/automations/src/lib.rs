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

//! The Scheduled tasks page, as Maka Desktop's automations hub
//! (apps/desktop/src/renderer/features/module-hub/, packages/ui/src/scheduled-task-panel.tsx,
//! scheduled-task-detail.tsx, scheduled-task-form-dialog.tsx, and
//! daily-review-panel.tsx): the Host's scheduled tasks and their runs, a
//! task's detail and form, and the Daily review.
//!
//! - [`ScheduledTasks`] reads the catalog (`scheduled-task.query`, every
//!   page at one revision) on every connection and whenever the Host says
//!   it changed (`scheduled-task.changed`), makes every change to it
//!   (`scheduled-task.mutate`), and announces the fires Desktop announces.
//!   The window keeps it from the start, so the sidebar can count the
//!   active tasks before the page shows.
//! - [`AutomationsView`] is the page: the header's actions and meta, which
//!   the shell puts in the plate's header row, and under them the tabs, My
//!   scheduled tasks and Run history, the detail and the form in dialogs.
//! - [`DailyReviewView`] is the Daily review tab (`daily-review.query`,
//!   `daily-review.mutate`).
//! - [`KeepSystemAwake`] is the page's Keep system awake setting.
//!
//! A local notification or a bot message is delivered by a client's
//! native effect service, which Maka Desktop registers and this client
//! does not: such a task says so on its row and in its runs once its fire
//! waits for one.

mod awake;
mod catalog;
mod cron;
pub mod form;
mod form_view;
pub mod model;
mod page;
mod review;
mod widgets;

use gpui_kit::App;

pub use awake::{AwakeBlocker, AwakeHold, KeepSystemAwake};
pub use catalog::{
    ActionFailure, SNOOZE_DELAY_MS, ScheduledTasks, ScheduledTasksEvent, TaskChange,
};
pub use cron::is_valid_cron;
pub use form_view::{TaskForm, TaskFormEvent};
pub use page::{
    AutomationsEvent, AutomationsView, HubTab, OpenScheduledTask, SCHEDULED_TASK_LIST_CONTEXT,
    SelectFirstScheduledTask, SelectLastScheduledTask, SelectNextScheduledTask,
    SelectPreviousScheduledTask, TasksView,
};
pub use review::{DailyReviewEvent, DailyReviewView, Scope};

/// Binds the page's keys. Call once after `gpui_kit::init`, before
/// building menus.
pub fn init(cx: &mut App) {
    page::bind_keys(cx);
    shared::menu::init(cx);
}

#[cfg(test)]
mod tests;
