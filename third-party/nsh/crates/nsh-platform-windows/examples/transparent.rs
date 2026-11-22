//! A transparent, borderless window that stays out of the taskbar
//! (`AppOptions::transparent`, `AppOptions::skip_taskbar`): a translucent
//! rounded card on the desktop, dragged by its body, with buttons that put
//! it back in the taskbar and close it.
//!
//! `cargo run -p nsh-platform-windows --example transparent`

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod app {
    use nsh_base::button;
    use nsh_core::{Color, element::desktop as window, prelude::*};

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
        let win = window::current_window();
        let close = win.clone();
        // The root draws nothing: only the card shows.
        view().flex_1().p_4().child(
            view()
                .flex_1()
                .gap_3()
                .p_4()
                .rounded(px(16.0))
                .bg(Color(0x1e1e_2ecc))
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
                        .child(action("Toggle taskbar", move || {
                            let next = !skip.get_untracked();
                            skip.set(next);
                            let mut attributes = nsh_core::desktop::WindowAttributes::default();
                            attributes.taskbar = Some(!next);
                            win.set(attributes);
                        }))
                        .child(action("Close", move || close.close())),
                ),
        )
    }
}

#[cfg(target_os = "windows")]
fn main() -> std::process::ExitCode {
    use nsh_platform_windows::{AppOptions, AppSource, Root, run_app};
    run_app(
        AppSource::Rust(Root::of::<app::Card>()),
        AppOptions {
            title: "Transparent".to_owned(),
            size: (360, 200),
            transparent: true,
            skip_taskbar: true,
            ..Default::default()
        },
    )
}

#[cfg(not(target_os = "windows"))]
fn main() {}
