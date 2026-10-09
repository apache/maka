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

//! Sessions: the catalog the Host keeps, the selected session, creating new
//! ones, and the sidebar that shows them.
//!
//! - [`SessionCatalog`] loads `session.catalog.query` in one background pass,
//!   reloads on `session.catalog.changed`, and owns the selection: a task,
//!   or none for the new task's draft, which New task opens without asking
//!   the Host (the draft's first message creates the task).
//! - [`SessionSidebar`] renders the catalog as a virtualized list grouped by
//!   day (Today, Yesterday, This week, Earlier) or by project, with archived
//!   tasks in a folded group at the end, under the app name, a "New task"
//!   row, and the entries of the pages the plate can show instead of a task
//!   ([`SidebarPage`]). Each task has a context menu: rename in place, flag,
//!   archive, copy its ID, and delete once archived.
//! - [`SessionHistory`] remembers the tasks and pages a window showed, for
//!   Back and Forward.

mod catalog;
mod history;
mod page;
mod row;
mod sidebar;
#[cfg(test)]
mod sidebar_tests;

pub use catalog::{LoadState, SessionCatalog, SessionCatalogEvent, TaskCommand};
pub use history::{Place, SessionHistory};
pub use page::SidebarPage;
pub use row::SessionRow;
pub use sidebar::{
    ActivateSessionEntry, CancelRename, CollapseSessionGroup, ExpandSessionGroup, GROUP_ROW_LIMIT,
    OpenSessionMenu, RenameSession, SESSION_LIST_CONTEXT, SESSION_RENAME_CONTEXT,
    SelectFirstSession, SelectLastSession, SelectNextSession, SelectPreviousSession,
    SessionSidebar, SidebarEvent, TaskGroup, TaskGrouping, init,
};
