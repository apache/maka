//! The tasks app, written in Rust: `nsh.json` `"root"` names [`App`].

mod components;
mod nav;
mod pages;
mod shell;
mod store;

use nsh_base::theme;
use nsh_core::{element::desktop::window as app_window, prelude::*};

/// The app's UI set (`nsh.json` `"rust"`).
#[native_module("tasks/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// The app's root: the whole surface, on the theme's background. On the
/// desktops it renders in the window it declares; off them the root's view is
/// the app's screen, as a phone's window is the app.
#[component]
pub fn App() -> impl IntoElement {
    let content = || {
        view()
            .flex_1()
            .bg(move || theme().background)
            .child(shell::shell())
    };
    // One declaration everywhere: off the desktops `window()` shows its
    // content in the app's one surface.
    app_window().id("main").content(content)
}
