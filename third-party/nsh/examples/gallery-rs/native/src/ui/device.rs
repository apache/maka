//! What depends on the device's input (as the TSX gallery's `hint`):
//! phones and tablets are touched, desktops pointed at.

use nsh_core::{platform::Os, prelude::*};

/// Instructions for the device's input: `touch` on phones and tablets,
/// `pointer` on desktops (a mouse, a touchpad, a keyboard).
pub(crate) fn hint(touch: &'static str, pointer: &'static str) -> &'static str {
    if is_desktop() { pointer } else { touch }
}

/// Desktops' way to refresh what phones pull down (the mouse does not drag
/// scroll views; TS `bindRefresh`): Ctrl+R / Cmd+R calls `refresh` while
/// the calling view lives, next to the refresh button the demo shows.
/// Browsers keep the key to reload the page (and the development hosts to
/// reload the app). The key's label for the hint, or `None` where it is not
/// bound.
pub(crate) fn bind_refresh(refresh: impl Fn() + 'static) -> Option<String> {
    if !is_desktop() || os() == Os::Web {
        return None;
    }
    on_key("mod+r", move |_| refresh());
    Some(key_label("mod+r"))
}
