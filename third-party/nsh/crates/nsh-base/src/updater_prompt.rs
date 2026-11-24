//! The window of NSH's built-in update prompt (`promptForUpdate` of
//! `nsh/updater`), as macOS apps' Sparkle shows it: the new version and its
//! notes, Skip This Version, Remind Me Later and Install Update, then the
//! download's progress and Install and Relaunch or Install on Quit. Its look
//! is fixed, in the theme's colors. The core asks through it
//! ([`set_update_presenter`]) on the desktops; elsewhere the system's alert
//! asks.

use nsh_core::{
    desktop::WindowAttributes,
    element::desktop::{current_window, open_window, window},
    prelude::*,
    runtime::{UpdatePrompt, set_update_presenter},
};

use crate::{button, checkbox, progress, text_view, theme::theme};

/// Installs the window as the engine's update prompt.
pub(crate) fn install() {
    set_update_presenter(present);
}

/// Where the prompt is.
#[derive(Debug, Clone, PartialEq)]
enum Stage {
    /// Asking whether to install.
    Ask,
    /// Downloading: bytes received and the total, when known.
    Downloading(u64, Option<u64>),
    /// Downloaded, waiting for Install and Relaunch or Install on Quit.
    Ready,
    /// Installing.
    Installing,
    /// Something failed: why.
    Failed(String),
}

/// Opens the prompt's window; `false` where it cannot open.
fn present(prompt: &UpdatePrompt) -> bool {
    let prompt = prompt.clone();
    let mut attributes = WindowAttributes::default();
    attributes.resizable = Some(false);
    attributes.minimizable = Some(false);
    attributes.maximizable = Some(false);
    open_window(
        window()
            .id("nsh-updater")
            .title("Software Update")
            .default_size(size(px(560.0), px(400.0)))
            .attributes(attributes)
            .content(move || prompt_view(prompt.clone())),
    )
    .is_some()
}

/// `bytes` in megabytes, as the download's progress says it.
fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

/// What the progress says: "3.2 MB of 18.4 MB".
fn progress_label(received: u64, total: Option<u64>) -> String {
    match total {
        Some(total) => format!("{} of {}", megabytes(received), megabytes(total)),
        None => megabytes(received),
    }
}

/// A push button: the primary one in the theme's primary color.
fn action(label: &'static str, primary: bool, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .flex_row()
        .items_center()
        .justify_center()
        .h(px(28.0))
        .px(px(14.0))
        .rounded(move || Length::from(theme().radius))
        .bg(move || {
            if primary {
                theme().primary
            } else {
                theme().secondary
            }
        })
        .active(|s| s.opacity(0.8))
        .child(
            text(label)
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || {
                    if primary {
                        theme().primary_foreground
                    } else {
                        theme().secondary_foreground
                    }
                }),
        )
}

fn prompt_view(prompt: UpdatePrompt) -> impl IntoElement {
    let window = current_window();
    // The footer's branches go as the stage changes, and a task spawned
    // under one would end with it: downloads and installs run under the
    // whole prompt's owner instead.
    let owner = Owner::current();
    let stage = signal(Stage::Ask);
    let automatic = signal(prompt.automatic);
    let close = {
        let window = window.clone();
        move || window.close()
    };
    let title = format!("A new version of {} is available!", prompt.app_name);
    let subtitle = format!(
        "{} {} is now available\u{2014}you have {}. Would you like to download it now?",
        prompt.app_name, prompt.version, prompt.current_version
    );
    let notes = prompt.notes.clone().filter(|n| !n.trim().is_empty());

    let install = {
        let prompt = prompt.clone();
        let close = close.clone();
        move || {
            if !prompt.can_install {
                let opened = prompt.open_url();
                let close = close.clone();
                spawn(async move {
                    opened.await;
                    close();
                });
                return;
            }
            stage.set(Stage::Downloading(0, None));
            let downloaded = prompt
                .download(move |received, total| stage.set(Stage::Downloading(received, total)));
            owner.run(|| {
                spawn(async move {
                    match downloaded.await {
                        Ok(()) => stage.set(Stage::Ready),
                        Err(e) => stage.set(Stage::Failed(e)),
                    }
                });
            });
        }
    };
    let skip = {
        let prompt = prompt.clone();
        let close = close.clone();
        move || {
            prompt.skip();
            close();
        }
    };
    let later = close.clone();
    let footer = {
        let prompt = prompt.clone();
        let close = close.clone();
        move || match stage.get() {
            Stage::Ask => view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(action("Skip This Version", false, skip.clone()))
                .child(view().flex_1())
                .child(action("Remind Me Later", false, later.clone()))
                .child(action("Install Update", true, install.clone()))
                .into_element(),
            Stage::Downloading(received, total) => {
                let value = total
                    .filter(|t| *t > 0)
                    .map(|t| received as f32 / t as f32 * 100.0);
                view()
                    .gap_2()
                    .child(
                        text("Downloading update\u{2026}")
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(move || theme().foreground),
                    )
                    .child(
                        progress()
                            .value(value.unwrap_or(0.0))
                            .indeterminate(value.is_none())
                            .track_style(|s| s.h(px(6.0)).rounded_full().overflow_hidden())
                            .indicator_style(|s| s.h_full().rounded_full())
                            .track_class("bg-muted")
                            .indicator_class("bg-primary"),
                    )
                    .child(
                        view()
                            .flex_row()
                            .items_center()
                            .child(
                                text(progress_label(received, total))
                                    .flex_1()
                                    .text_xs()
                                    .text_color(move || theme().muted_foreground),
                            )
                            .child(action("Cancel", false, close.clone())),
                    )
                    .into_element()
            }
            Stage::Ready | Stage::Installing => {
                let installing = stage.get_untracked() == Stage::Installing;
                let relaunch = {
                    let prompt = prompt.clone();
                    move || {
                        stage.set(Stage::Installing);
                        let installed = prompt.install_and_restart();
                        owner.run(|| {
                            spawn(async move {
                                if let Err(e) = installed.await {
                                    stage.set(Stage::Failed(e));
                                }
                            });
                        });
                    }
                };
                let on_quit = {
                    let prompt = prompt.clone();
                    let close = close.clone();
                    move || {
                        stage.set(Stage::Installing);
                        let installed = prompt.install_on_quit();
                        let close = close.clone();
                        owner.run(|| {
                            spawn(async move {
                                match installed.await {
                                    Ok(()) => close(),
                                    Err(e) => stage.set(Stage::Failed(e)),
                                }
                            });
                        });
                    }
                };
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        text(if installing {
                            "Installing update\u{2026}"
                        } else {
                            "Ready to install"
                        })
                        .flex_1()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || theme().foreground),
                    )
                    .child(action("Install on Quit", false, on_quit))
                    .child(action("Install and Relaunch", true, relaunch))
                    .style_when(installing, |s| {
                        s.opacity(0.5).pointer_events(PointerEvents::None)
                    })
                    .into_element()
            }
            Stage::Failed(e) => view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(
                    text(format!("The update failed: {e}"))
                        .flex_1()
                        .text_sm()
                        .text_color(move || theme().destructive),
                )
                .child(action("Close", true, close.clone()))
                .into_element(),
        }
    };

    view()
        .size_full()
        .p(px(20.0))
        .gap_3()
        .bg(move || theme().background)
        .child(
            view()
                .gap_1()
                .child(
                    text(title)
                        .text_base()
                        .font_weight(FontWeight::BOLD)
                        .text_color(move || theme().foreground),
                )
                .child(
                    text(subtitle)
                        .text_sm()
                        .text_color(move || theme().muted_foreground),
                ),
        )
        .child(match notes {
            Some(notes) => view()
                .flex_1()
                .min_h(px(0.0))
                .gap_1()
                .child(
                    text("Release Notes:")
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || theme().foreground),
                )
                .child(
                    scroll()
                        .flex_1()
                        .border_1()
                        .border_color(move || theme().border)
                        .rounded(move || Length::from(theme().radius))
                        .bg(move || theme().card)
                        .child(
                            text_view()
                                .markdown(move || Some(SharedString::from(notes.clone())))
                                .selectable(true)
                                .p(px(12.0))
                                .gap_2()
                                .text_sm()
                                .text_color(move || theme().card_foreground),
                        ),
                )
                .into_element(),
            None => view().flex_1().into_element(),
        })
        .child(when(prompt.can_install, {
            let prompt = prompt.clone();
            move || {
                let prompt = prompt.clone();
                checkbox()
                    .checked(automatic)
                    .on_change(move |next: &bool| {
                        automatic.set(*next);
                        prompt.set_automatic(*next);
                    })
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .indicator_style(|s| {
                        s.size(px(16.0))
                            .rounded(px(4.0))
                            .border_1()
                            .items_center()
                            .justify_center()
                    })
                    .indicator_class("border-input checked:bg-primary checked:border-primary")
                    .indicator(
                        text("\u{2713}")
                            .text_xs()
                            .font_weight(FontWeight::BOLD)
                            .text_color(move || theme().primary_foreground)
                            .style_when(move || !automatic.get(), |s| s.opacity(0.0)),
                    )
                    .child(
                        text("Automatically download and install updates in the future")
                            .text_sm()
                            .text_color(move || theme().foreground),
                    )
            }
        }))
        .child(dynamic(footer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_progress_reads_in_megabytes() {
        assert_eq!(
            progress_label(3_200_000, Some(18_400_000)),
            "3.2 MB of 18.4 MB"
        );
        assert_eq!(progress_label(512_000, None), "0.5 MB");
    }
}
