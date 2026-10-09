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

//! The task list's lines: group headings, tasks, and "Show more" rows, built
//! from the catalog rows as of one moment. Pure, so the grouping rules are
//! tested without a window.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, TimeZone};
use gpui_kit::SharedString;
use shared::copy::{self, Locale, Text};
use shared::time::{DayGroup, compact_age};
use workspace::{ProjectEntry, path_name};

use crate::row::SessionRow;

/// A group lists this many tasks, then "Show more" (AllSum), until it is
/// expanded.
pub const GROUP_ROW_LIMIT: usize = 8;

/// How the task list groups the tasks that are not archived: Maka's
/// 按时间 / 按项目 switch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum TaskGrouping {
    /// Today, Yesterday, This week, Earlier.
    #[default]
    ByTime,
    /// One group per project, headed by its name, then the tasks in no
    /// project (Desktop's `deriveSessionNavigationGroups`).
    ByProject,
}

impl TaskGrouping {
    pub const ALL: [Self; 2] = [Self::ByTime, Self::ByProject];

    pub fn label(self) -> Text {
        match self {
            Self::ByTime => copy::GROUP_BY_TIME,
            Self::ByProject => copy::GROUP_BY_PROJECT,
        }
    }

    /// A stable key for element ids.
    pub fn key(self) -> &'static str {
        match self {
            Self::ByTime => "time",
            Self::ByProject => "project",
        }
    }
}

/// A group of the task list: a day (Today, Yesterday, This week, Earlier)
/// or a project for tasks that are not archived, and one Archived group at
/// the end.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum TaskGroup {
    Day(DayGroup),
    /// The tasks of the project with this id: a registered project (tasks
    /// that name one of its aliases included), or an id the project catalog
    /// does not list.
    Project(SharedString),
    /// The tasks that run in no project.
    NoProject,
    Archived,
}

impl From<DayGroup> for TaskGroup {
    fn from(group: DayGroup) -> Self {
        Self::Day(group)
    }
}

impl TaskGroup {
    /// A stable key for element ids and tests: the day's key,
    /// `project:<id>`, `no-project`, or `archived`.
    pub fn key(&self) -> SharedString {
        match self {
            Self::Day(group) => group.key().into(),
            Self::Project(id) => format!("project:{id}").into(),
            Self::NoProject => "no-project".into(),
            Self::Archived => "archived".into(),
        }
    }
}

/// One task as its row shows it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TaskEntry {
    pub id: SharedString,
    /// The title as the list shows it ([`copy::task_title`]).
    pub title: SharedString,
    pub age: SharedString,
    pub running: bool,
    /// Waits on the user; drawn with the waiting glyph in the warning ink.
    pub waiting: bool,
    pub flagged: bool,
    pub archived: bool,
}

/// One line of the task list.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Entry {
    Header {
        group: TaskGroup,
        label: SharedString,
        /// How many tasks the group holds, shown beside a label that does
        /// not imply it (Archived, which starts folded).
        count: Option<usize>,
        collapsed: bool,
        /// A registered project with no task: listed by name, as Desktop
        /// lists every project, with nothing to fold.
        empty: bool,
    },
    Session(TaskEntry),
    /// The row after a group's first [`GROUP_ROW_LIMIT`] tasks that shows
    /// the `hidden` rest.
    ShowMore {
        group: TaskGroup,
        hidden: usize,
    },
}

/// How the list is folded: groups folded to their heading, groups whose
/// "Show more" was chosen, and the selected task (a group whose hidden rows
/// hold it lists them all, so the selection stays on screen).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Folding<'a> {
    pub collapsed: &'a HashSet<TaskGroup>,
    pub expanded: &'a HashSet<TaskGroup>,
    pub selected: Option<&'a SharedString>,
}

/// A project's group while the list is built.
struct ProjectGroup {
    group: TaskGroup,
    label: SharedString,
    tasks: Vec<TaskEntry>,
}

/// The list's lines for `rows` (newest activity first) as of `now`, in
/// `locale`, and the group of every task, folded or not.
///
/// By project, as Desktop's `deriveSessionNavigationGroups` and its rail
/// order them: every registered project that is not archived, in the
/// catalog's order (`projects`), headed by its name and listed even with no
/// task; then each project id the catalog does not list, headed by the
/// folder of its newest task, in the order of their newest task; then the
/// tasks in no project, under No project; then the archived projects that
/// still hold tasks (Desktop folds them under Archived projects). Tasks
/// keep their newest-first order within a group.
pub(crate) fn build_entries<Tz: TimeZone>(
    locale: Locale,
    rows: &[SessionRow],
    grouping: TaskGrouping,
    projects: &[ProjectEntry],
    folding: Folding<'_>,
    now: &DateTime<Tz>,
) -> (Vec<Entry>, HashMap<SharedString, TaskGroup>) {
    let mut groups = HashMap::with_capacity(rows.len());
    let mut by_day: [Vec<TaskEntry>; 4] = Default::default();
    let by_project = grouping == TaskGrouping::ByProject;
    let projects = if by_project { projects } else { &[] };
    let mut registered: Vec<ProjectGroup> = projects
        .iter()
        .map(|project| ProjectGroup {
            group: TaskGroup::Project(project.id.clone()),
            label: project.label(),
            tasks: Vec::new(),
        })
        .collect();
    // A project's own id wins over another project's alias.
    let mut owners: HashMap<&str, usize> = HashMap::new();
    for (ix, project) in projects.iter().enumerate() {
        owners.insert(&project.id, ix);
    }
    for (ix, project) in projects.iter().enumerate() {
        for alias in &project.aliases {
            owners.entry(alias).or_insert(ix);
        }
    }
    let mut unregistered: Vec<ProjectGroup> = Vec::new();
    let mut no_project = Vec::new();
    let mut archived = Vec::new();
    for row in rows {
        let entry = TaskEntry {
            id: row.id.clone(),
            title: copy::task_title(locale, &row.name).to_owned().into(),
            age: compact_age(locale, row.activity_at, now).into(),
            running: row.is_running,
            waiting: row.is_waiting,
            flagged: row.is_flagged,
            archived: row.is_archived,
        };
        if row.is_archived {
            groups.insert(row.id.clone(), TaskGroup::Archived);
            archived.push(entry);
        } else if by_project {
            let group = match &row.project_id {
                None => {
                    no_project.push(entry);
                    TaskGroup::NoProject
                }
                Some(id) => match owners.get(id.as_ref()) {
                    Some(&ix) => {
                        registered[ix].tasks.push(entry);
                        registered[ix].group.clone()
                    }
                    None => {
                        let group = TaskGroup::Project(id.clone());
                        match unregistered.iter_mut().find(|existing| existing.group == group) {
                            Some(existing) => existing.tasks.push(entry),
                            None => unregistered.push(ProjectGroup {
                                group: group.clone(),
                                label: path_name(&row.workspace_path)
                                    .map_or_else(|| id.clone(), |name| name.to_owned().into()),
                                tasks: vec![entry],
                            }),
                        }
                        group
                    }
                },
            };
            groups.insert(row.id.clone(), group);
        } else {
            let day = DayGroup::of(row.activity_at, now);
            groups.insert(row.id.clone(), TaskGroup::Day(day));
            by_day[day as usize].push(entry);
        }
    }
    let mut entries = Vec::with_capacity(
        rows.len() + DayGroup::ALL.len() + registered.len() + unregistered.len() + 2,
    );
    for (day, tasks) in DayGroup::ALL.into_iter().zip(by_day) {
        let label = day.label().in_locale(locale).into();
        push_group(&mut entries, TaskGroup::Day(day), label, false, tasks, folding);
    }
    let mut archived_projects = Vec::new();
    for (project, ProjectGroup { group, label, tasks }) in projects.iter().zip(registered) {
        if project.archived {
            archived_projects.push((group, label, tasks));
        } else if tasks.is_empty() {
            entries.push(Entry::Header {
                group,
                label,
                count: None,
                collapsed: false,
                empty: true,
            });
        } else {
            push_group(&mut entries, group, label, false, tasks, folding);
        }
    }
    for ProjectGroup { group, label, tasks } in unregistered {
        push_group(&mut entries, group, label, false, tasks, folding);
    }
    let label = copy::GROUP_NO_PROJECT.in_locale(locale).into();
    push_group(&mut entries, TaskGroup::NoProject, label, false, no_project, folding);
    for (group, label, tasks) in archived_projects {
        push_group(&mut entries, group, label, false, tasks, folding);
    }
    let label = copy::GROUP_ARCHIVED.in_locale(locale).into();
    push_group(&mut entries, TaskGroup::Archived, label, true, archived, folding);
    (entries, groups)
}

fn push_group(
    entries: &mut Vec<Entry>,
    group: TaskGroup,
    label: SharedString,
    counted: bool,
    tasks: Vec<TaskEntry>,
    folding: Folding<'_>,
) {
    if tasks.is_empty() {
        return;
    }
    let collapsed = folding.collapsed.contains(&group);
    entries.push(Entry::Header {
        label,
        count: counted.then_some(tasks.len()),
        group: group.clone(),
        collapsed,
        empty: false,
    });
    if collapsed {
        return;
    }
    let hidden = tasks.len().saturating_sub(GROUP_ROW_LIMIT);
    let selection_hidden =
        tasks.iter().skip(GROUP_ROW_LIMIT).any(|task| Some(&task.id) == folding.selected);
    if hidden == 0 || folding.expanded.contains(&group) || selection_hidden {
        entries.extend(tasks.into_iter().map(Entry::Session));
    } else {
        entries.extend(tasks.into_iter().take(GROUP_ROW_LIMIT).map(Entry::Session));
        entries.push(Entry::ShowMore { group, hidden });
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use host_protocol::SessionCatalogItem;
    use serde_json::json;

    use super::*;

    fn row(id: &str, activity_at: u64, archived: bool) -> SessionRow {
        row_in(id, activity_at, archived, "/w", None)
    }

    /// A task in folder `path`, in project `project` when given (else in no
    /// project).
    fn row_in(
        id: &str,
        activity_at: u64,
        archived: bool,
        path: &str,
        project: Option<&str>,
    ) -> SessionRow {
        let target = match project {
            Some(project) => json!({"kind": "project", "projectId": project}),
            None => json!({"kind": "host_path", "path": path}),
        };
        let item: SessionCatalogItem = serde_json::from_value(json!({
            "id": id, "revision": 1,
            "workspace": {"target": target, "hostCwd": path},
            "createdAt": 1, "activityAt": activity_at, "name": format!("# {id}"),
            "isFlagged": false, "isArchived": archived, "labels": [], "labelsTruncated": false,
            "hasUnread": false, "status": "active", "backend": "ai-sdk", "llmConnectionId": null,
            "llmConnectionSlug": "env", "connectionLocked": false, "model": "m",
            "permissionMode": "ask", "collaborationMode": "agent", "orchestrationMode": "default"
        }))
        .expect("item");
        SessionRow::from_item(&item).expect("row")
    }

    fn shape(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                Entry::Header { group, count, collapsed, empty, .. } => {
                    format!(
                        "[{}{}{}{}]",
                        group.key(),
                        count.map(|n| format!(" {n}")).unwrap_or_default(),
                        if *collapsed { " folded" } else { "" },
                        if *empty { " empty" } else { "" }
                    )
                }
                Entry::Session(task) => task.title.to_string(),
                Entry::ShowMore { hidden, .. } => format!("+{hidden}"),
            })
            .collect()
    }

    fn labels(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Header { label, .. } => Some(label.to_string()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn archived_tasks_leave_the_day_groups_for_a_folded_group_at_the_end() {
        let now = Utc::now();
        let recent = u64::try_from(now.timestamp_millis()).expect("now");
        let rows = [row("a", recent, false), row("b", recent, true), row("c", 2, false)];
        let archived_folded = HashSet::from([TaskGroup::Archived]);
        let none = HashSet::new();
        let folding = Folding { collapsed: &archived_folded, expanded: &none, selected: None };
        let (entries, groups) =
            build_entries(Locale::English, &rows, TaskGrouping::ByTime, &[], folding, &now);
        assert_eq!(shape(&entries), ["[today]", "a", "[earlier]", "c", "[archived 1 folded]"]);
        assert_eq!(groups.get("b"), Some(&TaskGroup::Archived));

        let folding = Folding { collapsed: &none, expanded: &none, selected: None };
        let (entries, _) =
            build_entries(Locale::English, &rows, TaskGrouping::ByTime, &[], folding, &now);
        assert_eq!(
            shape(&entries).last().map(String::as_str),
            Some("b"),
            "unfolded, it lists them"
        );
    }

    #[test]
    fn by_project_lists_the_projects_in_catalog_order_then_no_project() {
        let now = Utc::now();
        let projects = [
            ProjectEntry::new("alpha", "Alpha app", "/work/alpha"),
            ProjectEntry::new("beta", "Beta", "/work/beta").with_aliases(["beta-old"]),
            ProjectEntry::new("idle", "Idle", "/work/idle"),
            ProjectEntry::new("shelf", "Shelf", "/work/shelf").with_archived(true),
            ProjectEntry::new("dusty", "Dusty", "/work/dusty").with_archived(true),
        ];
        let rows = [
            row_in("a", 70, false, "/", None),
            // Two tasks of one project in different folders: one group.
            row_in("b", 60, false, "/work/beta", Some("beta")),
            row_in("c", 50, false, "/work/beta-wt", Some("beta-old")),
            row_in("d", 40, false, "/work/gone", Some("gone")),
            row_in("e", 30, false, "/work/alpha", Some("alpha")),
            row_in("f", 25, false, "/work/shelf", Some("shelf")),
            // In a registered project's folder, but naming no project.
            row_in("g", 20, false, "/work/alpha", None),
            row_in("h", 10, true, "/work/alpha", Some("alpha")),
        ];
        let none = HashSet::new();
        let folding = Folding { collapsed: &none, expanded: &none, selected: None };
        let (entries, groups) = build_entries(
            Locale::English,
            &rows,
            TaskGrouping::ByProject,
            &projects,
            folding,
            &now,
        );
        assert_eq!(
            shape(&entries),
            [
                "[project:alpha]",
                "e",
                "[project:beta]",
                "b",
                "c",
                "[project:idle empty]",
                "[project:gone]",
                "d",
                "[no-project]",
                "a",
                "g",
                "[project:shelf]",
                "f",
                "[archived 1]",
                "h"
            ],
            "an archived project with no task is left out"
        );
        assert_eq!(
            labels(&entries),
            ["Alpha app", "Beta", "Idle", "gone", "No project", "Shelf", "Archived"]
        );
        assert_eq!(groups.get("c"), Some(&TaskGroup::Project("beta".into())), "an alias");
        assert_eq!(groups.get("g"), Some(&TaskGroup::NoProject));

        let (entries, _) = build_entries(
            Locale::SimplifiedChinese,
            &rows[..1],
            TaskGrouping::ByProject,
            &[],
            folding,
            &now,
        );
        assert_eq!(labels(&entries), ["未归属项目"]);
    }

    #[test]
    fn a_project_the_catalog_does_not_list_is_headed_by_its_folder() {
        let now = Utc::now();
        let rows = [
            row_in("a", 30, false, "/work/api/", Some("p9")),
            row_in("b", 20, false, "/", Some("p8")),
            row_in("c", 10, false, "/work/other", Some("p9")),
        ];
        let folded = HashSet::from([TaskGroup::Project("p9".into())]);
        let none = HashSet::new();
        let folding = Folding { collapsed: &folded, expanded: &none, selected: None };
        // Before the catalog loads, and when it does not list them.
        let (entries, groups) =
            build_entries(Locale::English, &rows, TaskGrouping::ByProject, &[], folding, &now);
        assert_eq!(shape(&entries), ["[project:p9 folded]", "[project:p8]", "b"]);
        // The newest task's folder names the group; a root has no name, so
        // the id does (Desktop's `pathName || projectId`).
        assert_eq!(labels(&entries), ["api", "p8"]);
        assert_eq!(groups.get("c"), Some(&TaskGroup::Project("p9".into())));

        // Once listed, the same group (still folded) takes the project's name.
        let projects = [ProjectEntry::new("p9", "API", "/work/api")];
        let (entries, _) = build_entries(
            Locale::English,
            &rows,
            TaskGrouping::ByProject,
            &projects,
            folding,
            &now,
        );
        assert_eq!(shape(&entries)[0], "[project:p9 folded]");
        assert_eq!(labels(&entries)[0], "API");
    }
}
