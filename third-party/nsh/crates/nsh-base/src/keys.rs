//! Keys a control handles while it has the keyboard focus (a slider's
//! arrows, a number input's): bound in the surface's keymap only while the
//! control says it is focused, so they never take a key from the rest of
//! the app.
//!
//! A control laid out along the reading direction (a row of tabs, a
//! horizontal slider, a carousel) binds its keys with
//! [`bind_while_directed`]: in a right-to-left layout its row runs from the
//! right, so Left and Right trade places, as WAI-ARIA's patterns say (Left
//! moves to the next tab, raises the slider). Up and Down, Home and End
//! keep theirs.

use std::{borrow::Cow, rc::Rc};

use nsh_core::{element::layout_rtl, keymap::When, prelude::*};

/// Binds `keys` while `active` holds, and removes them when it stops (an
/// effect: `active` reads a signal, usually the control's focus from its
/// `on_focus` / `on_blur`). Each key is a keystroke as `on_key` names it,
/// whether it fires again on a held key's repeats, and the action `run`
/// gets. The keys fire only while no text input edits
/// ([`When::NotEditing`]).
pub(crate) fn bind_while<A: Copy + 'static>(
    active: impl Fn() -> bool + 'static,
    keys: &'static [(&'static str, bool, A)],
    run: impl Fn(A) + 'static,
) {
    bind(active, When::NotEditing, false, keys, run);
}

/// [`bind_while`] for a control laid out along the reading direction: in
/// a right-to-left layout Left and Right trade places ([`directed`]), and
/// a change of the direction binds them again.
pub(crate) fn bind_while_directed<A: Copy + 'static>(
    active: impl Fn() -> bool + 'static,
    keys: &'static [(&'static str, bool, A)],
    run: impl Fn(A) + 'static,
) {
    bind(active, When::NotEditing, true, keys, run);
}

/// [`bind_while`] firing as `when` says: [`When::Always`] for a control
/// whose own text input has the focus (a number input's arrows, which the
/// input would otherwise take to move its caret).
pub(crate) fn bind_while_when<A: Copy + 'static>(
    active: impl Fn() -> bool + 'static,
    when: When,
    keys: &'static [(&'static str, bool, A)],
    run: impl Fn(A) + 'static,
) {
    bind(active, when, false, keys, run);
}

fn bind<A: Copy + 'static>(
    active: impl Fn() -> bool + 'static,
    when: When,
    follows_direction: bool,
    keys: &'static [(&'static str, bool, A)],
    run: impl Fn(A) + 'static,
) {
    let run = Rc::new(run);
    effect(move || {
        if !active() {
            return;
        }
        // Read only while bound: a direction change binds the keys again.
        let rtl = follows_direction && layout_rtl();
        for &(keystroke, repeat, action) in keys {
            let run = run.clone();
            on_key_with(
                &directed(keystroke, rtl),
                KeyOptions {
                    when,
                    repeat,
                    ..Default::default()
                },
                move |_| run(action),
            );
        }
    });
}

/// `keystroke` as a control laid out along the reading direction binds it:
/// with `rtl`, Left is Right and Right is Left, its modifiers kept
/// (`shift+left` is `shift+right`); any other key is itself.
pub(crate) fn directed(keystroke: &str, rtl: bool) -> Cow<'_, str> {
    if !rtl {
        return Cow::Borrowed(keystroke);
    }
    let (modifiers, key) = keystroke.split_at(keystroke.rfind('+').map_or(0, |at| at + 1));
    match key {
        "left" => Cow::Owned(format!("{modifiers}right")),
        "right" => Cow::Owned(format!("{modifiers}left")),
        _ => Cow::Borrowed(keystroke),
    }
}

#[cfg(test)]
mod tests {
    use super::directed;

    #[test]
    fn right_to_left_trades_left_and_right_and_keeps_the_rest() {
        assert_eq!(directed("left", false), "left");
        assert_eq!(directed("right", false), "right");
        assert_eq!(directed("left", true), "right");
        assert_eq!(directed("right", true), "left");
        assert_eq!(directed("shift+left", true), "shift+right");
        assert_eq!(directed("alt+shift+right", true), "alt+shift+left");
        assert_eq!(directed("up", true), "up");
        assert_eq!(directed("home", true), "home");
        assert_eq!(directed("pagedown", true), "pagedown");
    }
}
