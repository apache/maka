//! The tasks app, written in Rust: `nsh.json` `"root"` names [`App`].

mod components;
mod nav;
mod pages;
mod shell;
mod store;

use nsh_base::theme;
use nsh_core::prelude::*;

/// The app's UI set (`nsh.json` `"rust"`).
#[native_module("tasks/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// The app's root: the whole surface, on the theme's background.
#[component]
pub fn App() -> impl IntoElement {
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(shell::shell())
}
