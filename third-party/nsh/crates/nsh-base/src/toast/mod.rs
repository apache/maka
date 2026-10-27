//! Toasts, as `gpui-base`'s: [`Toast`], an unstyled semantic root whose
//! `transition_status` the app's presentation follows; [`ToastStack`],
//! which measures its toasts and lays them out as overlapping layers or,
//! expanded (hovered or pressed), a list, and moves them with springs;
//! [`ToastManager`], headless ordered storage and lifecycle (enter, timeout,
//! pause, exit), a class in TS; [`ToastMotion`], their tokens.
//!
//! NSH adds what touch screens and the platforms' screen readers need, on
//! the same primitives: a toast is swiped away (`swipe_direction`, its
//! `DismissRequest`), the stack hears Escape and the Android back button
//! (its `Cancel`), a finger on the stack expands it as the pointer does
//! (and so pauses the manager's timeouts, which the app passes as
//! `paused`), and a toast's `accessibility_label` is read as it shows.
//!
//! The imperative layer (`toast("Copied")` from anywhere, with a title, a
//! description and an action) is a styled library's, as `gpui-component`'s
//! notifications are: an app builds it on these (the gallery's
//! `examples/gallery/toast.tsx`).

mod js;
mod manager;
mod root;
mod stack;

pub(crate) use js::ToastManager as ToastManagerClass;
pub use manager::{ToastAdvance, ToastManager, ToastMotion, ToastOptions, ToastTransitionStatus};
pub use root::{SwipeDirection, Toast, ToastElement, ToastEvent, ToastProps, toast};
pub use stack::{
    Anchor, ToastStack, ToastStackElement, ToastStackEvent, ToastStackProps, ToastStackState,
    toast_stack,
};

/// The website's example (`website/elements/toast.md`), compiled.
#[cfg(test)]
#[allow(dead_code)]
mod example {
    use std::time::Duration;

    use nsh_core::{prelude::*, time::now};

    use crate::{
        Anchor, ToastManager, ToastMotion, ToastOptions, ToastStackState, theme, toast, toast_stack,
    };

    pub(super) fn toasts() -> impl IntoElement {
        let manager = stored(ToastManager::<u64, SharedString>::new(ToastMotion::sonner()));
        let shown = signal(Vec::new());
        let state = ToastStackState::new();
        let sync = move || {
            shown.set(manager.with(|m| {
                m.visible(3)
                    .map(|(id, t, s)| (*id, t.clone(), s))
                    .collect::<Vec<_>>()
            }))
        };
        // Advance the lifecycle while toasts are mounted, paused while expanded.
        set_interval(Duration::from_millis(50), move || {
            if manager.with(|m| m.advance(now(), state.is_expanded()).changed) {
                sync();
            }
        });
        manager.with(|m| {
            m.push(
                1,
                "Copied".into(),
                ToastOptions::timeout(Some(Duration::from_secs(5))),
                now(),
            )
        });
        sync();
        toast_stack()
            .placement(Anchor::BottomCenter)
            .state(state)
            .w(px(340.0))
            .child(each(
                shown,
                |(id, _, _)| *id,
                move |item, _| {
                    toast()
                        .transition_status(move || item.get().2)
                        .accessibility_label(move || Some(item.get().1))
                        .on_dismiss_request(move || {
                            manager.with(|m| m.dismiss(&item.get().0, now()));
                        })
                        .rounded_xl()
                        .px_4()
                        .py_3()
                        .bg(move || theme().card)
                        .shadow_lg()
                        .transition_all()
                        .duration(200.0)
                        .starting_class("opacity-0 translate-y-4")
                        .ending_class("opacity-0 scale-95")
                        .child(text(move || item.get().1))
                },
            ))
    }
}
