//! The page's header on the desktops and the web; iOS and Android show the
//! system's, from the page's `title`.

use nsh_base::{button, theme};
use nsh_core::prelude::*;

use crate::nav;

pub(crate) fn header(title: &'static str) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .p_3()
        .border_b_1()
        .border_b_color(move || theme().border)
        .child(when(nav::can_go_back, || {
            button()
                .active(|s| s.opacity(0.6))
                .on_press(nav::pop)
                .child(text("Back").text_color(move || theme().primary))
        }))
        .child(
            text(title)
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(move || theme().foreground),
        )
}
