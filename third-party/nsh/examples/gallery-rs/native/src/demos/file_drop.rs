//! Desktop local-file destinations; drag files from the system file manager.
use nsh_core::prelude::*;

use crate::ui::colors;

#[component]
pub(crate) fn FileDrop() -> impl IntoElement {
    let hovering = signal(false);
    let files = signal(Vec::<String>::new());
    view()
        .flex_1()
        .p_6()
        .gap_4()
        .child(text("Drop files or directories from your file manager"))
        .child(
            view()
                .min_h(px(160.0))
                .p_6()
                .border_1()
                .border_color(colors::LINE)
                .bg(move || {
                    if hovering.get() {
                        colors::LINE
                    } else {
                        colors::BACKGROUND
                    }
                })
                .on_file_drag_enter(move || hovering.set(true))
                .on_file_drag_leave(move || hovering.set(false))
                .on_file_drop(move |event: &FileDropEvent| {
                    files.set(event.uris.clone());
                    hovering.set(false);
                })
                .child(text(move || {
                    if hovering.get() {
                        "Release to receive file URLs"
                    } else {
                        "Drop here"
                    }
                })),
        )
        .child(
            scroll()
                .flex_1()
                .child(text(move || files.get().join("\n"))),
        )
}
