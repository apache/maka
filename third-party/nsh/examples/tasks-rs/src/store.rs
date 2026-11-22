//! The app's state: its signal stays private, pages read and change it
//! through these functions. A global is per surface, so each test has its own.

use nsh_core::prelude::*;

/// A task.
#[derive(Clone, PartialEq)]
pub(crate) struct Task {
    pub(crate) id: u32,
    pub(crate) title: SharedString,
    pub(crate) done: bool,
}

#[derive(Clone)]
struct Tasks {
    list: Vec<Task>,
    next_id: u32,
}

impl Default for Tasks {
    fn default() -> Self {
        let task = |id, title: &'static str, done| Task {
            id,
            title: title.into(),
            done,
        };
        Self {
            list: vec![
                task(1, "Read the coding guides", true),
                task(2, "Write the first page", false),
            ],
            next_id: 3,
        }
    }
}

fn tasks() -> Signal<Tasks> {
    global::<Tasks>()
}

/// How many tasks there are (tracked where it is read).
pub(crate) fn task_count() -> usize {
    tasks().with(|tasks| tasks.list.len())
}

/// The tasks' ids, in order (tracked where it is read).
pub(crate) fn task_ids() -> Vec<u32> {
    tasks().with(|tasks| tasks.list.iter().map(|task| task.id).collect())
}

/// The task at `index`, or none past the end (tracked where it is read).
pub(crate) fn task_at(index: usize) -> Option<Task> {
    tasks().with(|tasks| tasks.list.get(index).cloned())
}

/// One task, or none once it is removed (tracked where it is read).
pub(crate) fn task_by_id(id: u32) -> Option<Task> {
    tasks().with(|tasks| tasks.list.iter().find(|task| task.id == id).cloned())
}

/// Adds a task; a blank title adds nothing.
pub(crate) fn add_task(title: &str) {
    let title = title.trim();
    if title.is_empty() {
        return;
    }
    tasks().update(|tasks| {
        let id = tasks.next_id;
        tasks.next_id += 1;
        tasks.list.push(Task {
            id,
            title: title.to_owned().into(),
            done: false,
        });
    });
}

/// Sets whether a task is done.
pub(crate) fn set_task_done(id: u32, done: bool) {
    tasks().update(|tasks| {
        if let Some(task) = tasks.list.iter_mut().find(|task| task.id == id) {
            task.done = done;
        }
    });
}

/// Removes a task.
pub(crate) fn remove_task(id: u32) {
    tasks().update(|tasks| tasks.list.retain(|task| task.id != id));
}
