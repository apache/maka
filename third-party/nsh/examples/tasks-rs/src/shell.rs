//! The app shell: the navigation stack and its pages, no page logic.

use nsh_base::nav_stack;
use nsh_core::prelude::*;

use crate::{
    nav,
    pages::{task_detail, task_list},
};

pub(crate) fn shell() -> impl IntoElement {
    nav_stack().flex_1().child(task_list()).child(each(
        nav::open_tasks,
        |id: &u32| *id,
        |id, depth| {
            task_detail(id.get_untracked())
                // Back on iOS and Android is the system's: it pops the page
                // natively, and the route (with what is above it) follows.
                .on_dismiss(move || nav::truncate(depth.get_untracked()))
        },
    ))
}
