//! A page: a native text input and a virtualized list over the store's tasks.

use nsh_base::{button, input, nav_page, theme};
use nsh_core::{
    element::{Position, Screen},
    prelude::*,
};

use crate::{components::header, nav, store};

pub(crate) fn task_list() -> Screen {
    // Transient view state belongs to the page that renders it.
    let draft = signal(String::new());
    let submit = move || {
        store::add_task(&draft.get_untracked());
        draft.set(String::new());
    };
    nav_page().title("Tasks").header(header("Tasks")).child(
        view()
            .flex_1()
            .gap_3()
            .p_4()
            .pb_safe_area_plus(px(16.0))
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        input()
                            .value(move || draft.get())
                            .on_change(move |value: &str| draft.set(value.to_owned()))
                            .on_submit(move |_: &str| submit())
                            .placeholder("New task")
                            .flex_1()
                            .px_3()
                            .py_2()
                            .border_1()
                            .border_color(move || theme().input)
                            .rounded(move || theme().radius)
                            .text_color(move || theme().foreground),
                    )
                    .child(
                        button()
                            .disabled(move || draft.with(|draft| draft.trim().is_empty()))
                            .on_press(submit)
                            .px_4()
                            .py_2()
                            .rounded(move || theme().radius)
                            .bg(move || theme().primary)
                            .active(|s| s.opacity(0.6))
                            .disabled_style(|s| s.opacity(0.4))
                            .child(text("Add").text_color(move || theme().primary_foreground)),
                    ),
            )
            .child(
                virtual_list(store::task_count, task_row)
                    .keys(store::task_ids)
                    .estimated_item_size(px(48.0))
                    .flex_1(),
            ),
    )
}

/// A cell, made once and given other rows as it is reused: it keeps no
/// state, and its bindings read the row where it is now.
fn task_row(at: Position) -> impl IntoElement {
    let task = computed(move || store::task_at(at.index()));
    button()
        .flex_row()
        .items_center()
        .justify_between()
        .p_3()
        .active(|s| s.bg(move || theme().muted))
        .on_press(move || {
            if let Some(task) = task.get_untracked() {
                nav::push(task.id);
            }
        })
        .child(
            text(move || task.get().map(|task| task.title).unwrap_or_default())
                .text_color(move || theme().foreground),
        )
        .child(
            text(move || match task.get() {
                Some(task) if task.done => "Done",
                _ => "Open",
            })
            .text_color(move || theme().muted_foreground),
        )
}
