//! Whether views can be seen ([`crate::view::NshView::shown`]), and the
//! move counter that tells when that may have changed ([`moved`]).
//!
//! Views whose drawing changed out of sight are drawn once they show
//! ([`crate::mount::Mounter::revisit`]). A pass over many of them (rows of
//! a long list, a page of charts) resolves each ancestor's visible part
//! once ([`Sights`]) and shares it among the views under it, so a pass
//! costs about one look at each distinct ancestor, not one walk to the
//! root per view.
//!
//! What a view's visibility depends on (frames, hidden views, windows,
//! scroll offsets, transforms) changes at a few places, which call [`moved`]; the
//! display link's frames revisit only when that counter moved, while an
//! endless animation elsewhere keeps the frames coming.

use std::cell::Cell;

pub(crate) use nsh_platform_apple::sight::{Sights, Span, Tree};
use objc2_foundation::NSRect;

/// A frame as a [`Span`].
pub(crate) fn placed(f: NSRect) -> Span {
    let (x, y) = (f.origin.x as f32, f.origin.y as f32);
    (x, y, x + f.size.width as f32, y + f.size.height as f32)
}

thread_local! {
    /// Bumped whenever something visibility depends on changes (see the
    /// module doc). Views are main-thread only and only the root knows
    /// its surface, so the count is the main thread's: a move in one
    /// surface costs another at most one extra pass.
    static MOVES: Cell<u64> = const { Cell::new(0) };
}

/// Something views' visibility depends on changed: a frame, a view hidden
/// or shown, a view attached or detached, a scroll offset or a transform.
pub(crate) fn moved() {
    MOVES.with(|m| m.set(m.get().wrapping_add(1)));
}

/// The count of [`moved`] calls so far; a pass that starts at one count
/// has seen every move before it.
pub(crate) fn moves() -> u64 {
    MOVES.with(Cell::get)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_count() {
        let before = moves();
        moved();
        assert_ne!(moves(), before);
    }
}
