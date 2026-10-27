//! The software keyboard: `Keyboard` (content kept above it is the
//! styles' `env(keyboard-inset-height)`).

use crate::prelude::*;

/// The software keyboard.
#[module]
#[derive(Debug)]
pub struct Keyboard;

#[module]
impl Keyboard {
    /// Unfocuses the focused input, hiding the keyboard.
    pub fn dismiss(cx: &mut ModuleCx) {
        cx.dismiss_keyboard();
    }
}
