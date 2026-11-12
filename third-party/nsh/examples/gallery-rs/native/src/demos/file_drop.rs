//! Desktop local-file destinations; drag files from the system file manager.
//! The card is the destination: files dropped on its inputs' text reach it
//! as anywhere else on it, and the inputs insert nothing.
use nsh_base::input;
use nsh_core::{element::Input, prelude::*};

use crate::ui::{colors, radius};

#[component]
pub(crate) fn FileDrop() -> impl IntoElement {
    let hovering = signal(false);
    let offered = signal(0usize);
    let images = signal(false);
    let files = signal(Vec::<String>::new());
    view()
        .flex_1()
        .p_6()
        .gap_4()
        .child(text("Drop files or directories from your file manager").text_color(colors::TEXT))
        .child(
            view()
                .p_4()
                .gap_3()
                .rounded(px(radius::CARD))
                .border_1()
                .border_color(move || {
                    if hovering.get() {
                        colors::ACCENT
                    } else {
                        colors::BORDER
                    }
                })
                .bg(move || {
                    if hovering.get() {
                        colors::RAISED
                    } else {
                        colors::SURFACE
                    }
                })
                .on_file_drag_enter(move |event: &FileDragEvent| {
                    offered.set(event.uris.len());
                    images.set(event.mime_types.iter().all(|t| t.starts_with("image/")));
                    hovering.set(true);
                })
                .on_file_drag_leave(move || hovering.set(false))
                .on_file_drop(move |event: &FileDropEvent| {
                    files.set(event.uris.clone());
                    hovering.set(false);
                })
                .child(field().placeholder("Subject").h(px(44.0)))
                .child(
                    field()
                        .multiline(true)
                        .placeholder("Write a message, or drop files on it")
                        .h(px(120.0))
                        .py(px(10.0)),
                )
                .child(
                    text(move || match (hovering.get(), offered.get()) {
                        (true, 1) if images.get() => "Release to attach 1 image".to_string(),
                        (true, n) if n > 1 && images.get() => {
                            format!("Release to attach {n} images")
                        }
                        (true, 1) => "Release to attach 1 item".to_string(),
                        (true, n) if n > 1 => format!("Release to attach {n} items"),
                        (true, _) => "Release to attach".to_string(),
                        _ => "Files dropped anywhere on this card are attached".to_string(),
                    })
                    .text_size(px(13.0))
                    .text_color(colors::MUTED),
                ),
        )
        .child(
            scroll().flex_1().child(
                text(move || files.get().join("\n"))
                    .text_size(px(13.0))
                    .text_color(colors::MUTED),
            ),
        )
}

/// An input of the card.
fn field() -> Input {
    input()
        .placeholder_color(|| color(colors::FAINT))
        .caret_color(|| color(colors::ACCENT))
        .selection_color(|| color(colors::ACCENT))
        .px(px(12.0))
        .text_size(px(15.0))
        .text_color(colors::TEXT)
        .bg(colors::INSET)
        .rounded(px(radius::CONTROL))
}
