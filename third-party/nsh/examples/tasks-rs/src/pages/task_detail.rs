//! A page: a controlled switch, and a system alert before a removal that
//! cannot be undone.

use nsh_base::{alert_dialog, button, nav_page, switch, theme};
use nsh_core::{element::Screen, prelude::*};

use crate::{components::header, nav, store};

pub(crate) fn task_detail(id: u32) -> Screen {
    // A closure, so the task is read where it is used and follows the store.
    let task = move || store::task_by_id(id);
    nav_page().title("Task").header(header("Task")).child(
        view()
            .flex_1()
            .gap_4()
            .p_4()
            .pb_safe_area_plus(px(16.0))
            .child(
                text(move || task().map(|task| task.title).unwrap_or_default())
                    .text_lg()
                    .text_color(move || theme().foreground),
            )
            .child(
                switch()
                    .checked(move || task().is_some_and(|task| task.done))
                    .on_change(move |&done: &bool| store::set_task_done(id, done))
                    .flex_row()
                    .items_center()
                    .gap_3()
                    // Its parts follow its state: `checked:` is theirs.
                    .track_class("w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary")
                    .thumb_class("size-5 rounded-full bg-background transition-transform checked:translate-x-5")
                    .child(text("Done").text_color(move || theme().foreground)),
            )
            .child(
                button()
                    .on_press(move || confirm_remove(id))
                    .self_start()
                    .px_4()
                    .py_2()
                    .border_1()
                    .border_color(move || theme().destructive)
                    .rounded(move || theme().radius)
                    .active(|s| s.opacity(0.6))
                    .child(text("Remove").text_color(move || theme().destructive)),
            ),
    )
}

/// Asks first; the alert's answer arrives in a task. The page pops before
/// the task goes, so it leaves showing what it showed.
fn confirm_remove(id: u32) {
    let answer = alert_dialog()
        .title("Remove this task?")
        .cancel("cancel", "Cancel")
        .destructive("remove", "Remove")
        .show();
    spawn(async move {
        if answer
            .await
            .is_ok_and(|answer| answer.action.as_deref() == Some("remove"))
        {
            nav::pop();
            store::remove_task(id);
        }
    });
}
