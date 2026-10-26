//! `Sheet`: the gallery's bottom sheet, a panel that slides up from the
//! bottom over a dimmed backdrop, dragged down to close. The drag and the springs run natively: the panel
//! follows the finger with no engine work per frame.

use nsh_base::{dialog, theme};
use nsh_core::prelude::*;

use super::colors;

/// The props of [`Sheet`].
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct SheetProps {
    /// Shown.
    #[prop(default)]
    pub(crate) open: Prop<bool>,
    /// The content: made when the sheet opens and released when it has
    /// closed, so it starts fresh each time.
    #[prop(lazy)]
    pub(crate) children: Children,
}

/// The events of a [`Sheet`].
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum SheetEvent {
    /// The user closed it (it slid away).
    Close,
}

/// A drag further down than this, or faster, closes it.
const CLOSE_DISTANCE: f32 = 120.0;
const CLOSE_VELOCITY: f32 = 900.0;

/// How the panel springs back to where it rests.
fn settle(velocity: Option<f32>) -> Spring {
    Spring {
        stiffness: 280.0,
        damping: 30.0,
        velocity,
        ..Spring::default()
    }
}

/// A panel that slides up from the bottom over a dimmed backdrop while
/// `open`; dragging it down, tapping the backdrop or the back button closes
/// it (`onClose`: set `open` to false).
#[component]
pub(crate) fn Sheet(props: SheetProps, cx: Scope<SheetEvent>) -> impl IntoElement {
    // How far down the panel is from where it rests.
    let offset = animated_value(0.0);
    // Closing: the panel slides away, then the app is told.
    let closing = stored(None::<Spawned<()>>);
    // Slides in from below the screen.
    let open = move || {
        if let Some(task) = closing.replace(None) {
            task.cancel();
        }
        offset.set(window().height.0);
        offset.spring(0.0, settle(None));
    };
    // Slides away, then tells the app.
    let close = move || {
        if closing.with(|c| c.is_some()) {
            return;
        }
        let end = offset.timing(untracked(window).height.0, 220.0, Easing::EaseIn);
        closing.replace(Some(spawn(async move {
            // Ended or interrupted: closed either way.
            let _ = end.await;
            closing.replace(None);
            cx.emit(SheetEvent::Close);
        })));
    };
    effect(move || {
        if props.open.get() {
            untracked(open);
        }
    });
    let children = props.children;
    view().child(when(props.open, move || {
        let height = untracked(window).height;
        dialog()
            .animation(ModalAnimation::None)
            // The sheet slides away itself before it goes: nothing closes
            // it natively, every attempt is reported to `on_cancel`.
            .close_on_escape(false)
            .close_on_backdrop_press(false)
            .close_on_swipe(false)
            .on_cancel(close)
            .child(
                // The backdrop fades with the panel's position.
                view()
                    .absolute()
                    .inset_0()
                    .bg(hsla(0.0, 0.0, 0.0, 0.5))
                    .bind_opacity(&offset.interpolate(&[0.0, height.0], &[1.0, 0.0]))
                    .label("Close")
                    // For the pointer: Escape and the back button close it
                    // from the keyboard, which goes straight to the panel.
                    .focusable(false)
                    .on_press(close),
            )
            .child(
                view()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .pt_2()
                    .pb(move || px(safe_area().bottom.0 + 16.0))
                    .px_4()
                    .gap_3()
                    .rounded_t(move || theme().radius.max(px(16.0)))
                    .bg(colors::SURFACE)
                    .shadow_lg()
                    .bind_translate_y(&offset)
                    .pan_values(None, Some(&offset))
                    .on_pan_end(move |e: &PanEvent| {
                        if e.translation.y.0 > CLOSE_DISTANCE || e.velocity_y > CLOSE_VELOCITY {
                            close();
                        } else {
                            offset.spring(0.0, settle(Some(e.velocity_y)));
                        }
                    })
                    // The grabber.
                    .child(
                        view()
                            .w(px(36.0))
                            .h(px(5.0))
                            .self_center()
                            .rounded_full()
                            .bg(move || theme().muted),
                    )
                    .child(children),
            )
    }))
}
