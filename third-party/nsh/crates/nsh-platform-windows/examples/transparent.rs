//! A transparent, borderless window that stays out of the taskbar: a
//! translucent rounded card on the desktop over the system's blur of what is
//! behind it (`windows_backdrop`, Windows 11 and later), dragged by its body,
//! with buttons that turn the blur off and on, put it back in the taskbar
//! and close it. The window is the
//! one the app declares: `transparent: true` and `taskbar: false` are its
//! attributes (`AppOptions` describe the invisible app host).
//!
//! `cargo run -p nsh-platform-windows --example transparent`

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod app {
    use nsh_base::button;
    use nsh_core::{
        Color, WindowsBackdrop, desktop::WindowAttributes, element::desktop, prelude::*,
    };

    fn action(label: &'static str, press: impl Fn() + 'static) -> impl IntoElement {
        button()
            .px_3()
            .py_1()
            .rounded(px(6.0))
            .bg(Color(0xffff_ff26))
            .active(|s| s.opacity(0.6))
            .on_press(press)
            .child(text(label).text_color(Color(0xffff_ffff)))
    }

    #[component]
    pub fn Card() -> impl IntoElement {
        let skip = signal(true);
        let blur = signal(true);
        let mut attributes = WindowAttributes::default();
        attributes.transparent = Some(true);
        attributes.taskbar = Some(false);
        let content = move || {
            let win = desktop::current_window();
            let close = win.clone();
            // Draws the card alone: the window is transparent where nothing
            // is drawn, so the desktop shows around its rounded corners.
            view().flex_1().p_4().child(
                view()
                    .flex_1()
                    .gap_3()
                    .p_4()
                    .rounded(px(16.0))
                    .bg(Color(0x1e1e_2e80))
                    .windows_backdrop(move || blur.get().then(WindowsBackdrop::default))
                    .window_drag(true)
                    .child(
                        text("Transparent window")
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(Color(0xffff_ffff)),
                    )
                    .child(
                        text(move || {
                            if skip.get() {
                                "Not in the taskbar. Drag me anywhere."
                            } else {
                                "In the taskbar. Drag me anywhere."
                            }
                        })
                        .text_color(Color(0xffff_ffb3)),
                    )
                    .child(
                        view()
                            .flex_row()
                            .gap_2()
                            .child(action("Toggle blur", move || {
                                blur.set(!blur.get_untracked())
                            }))
                            .child(action("Toggle taskbar", move || {
                                let next = !skip.get_untracked();
                                skip.set(next);
                                let mut attributes = WindowAttributes::default();
                                attributes.taskbar = Some(!next);
                                win.set(attributes);
                            }))
                            .child(action("Close", move || close.close())),
                    ),
            )
        };
        // The app host is invisible: the app declares the window it shows.
        desktop::window()
            .id("main")
            .title("Transparent")
            .default_size(size(px(360.0), px(200.0)))
            .attributes(attributes)
            .content(content)
    }
}

#[cfg(target_os = "windows")]
fn main() -> std::process::ExitCode {
    use nsh_platform_windows::{AppOptions, AppSource, Root, run_app};
    run_app(
        AppSource::Rust(Root::of::<app::Card>()),
        AppOptions {
            title: "Transparent".to_owned(),
            ..Default::default()
        },
    )
}

#[cfg(not(target_os = "windows"))]
fn main() {}
