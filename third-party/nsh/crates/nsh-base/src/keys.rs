//! Keys a control handles while it has the keyboard focus (a slider's
//! arrows): bound in the surface's keymap only while the control says it
//! is focused, so they never take a key from the rest of the app.

use std::rc::Rc;

use nsh_core::{keymap::When, prelude::*};

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
    let run = Rc::new(run);
    effect(move || {
        if !active() {
            return;
        }
        for &(keystroke, repeat, action) in keys {
            let run = run.clone();
            on_key_with(
                keystroke,
                KeyOptions {
                    when: When::NotEditing,
                    repeat,
                },
                move |_| run(action),
            );
        }
    });
}
