//! The terminal's status line: the bottom row of the viewport, where a
//! toast's message shows, as a terminal app's message line. (A `Tooltip`
//! stands next to its trigger instead, so the two never take each other's
//! place.)
//!
//! A toast claims the line ([`claim`]) and of two claims the newer one
//! shows. A claim ends with its owner. Nothing animates: the line
//! changes in one frame, and nothing stacks. The state is the surface's
//! ([`global`]), so every surface has its own line.

use std::sync::atomic::{AtomicU64, Ordering};

use nsh_core::prelude::*;

/// What a claim of the line shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Claim {
    /// A toast's message.
    Toast,
}

/// Who claims the line, oldest first.
#[derive(Debug, Clone, Default)]
struct Line {
    toasts: Vec<u64>,
}

impl Line {
    fn of(&mut self, kind: Claim) -> &mut Vec<u64> {
        match kind {
            Claim::Toast => &mut self.toasts,
        }
    }
}

/// Claims the line for `kind` while `active` (tracked) holds, until the
/// owner goes. Returns whether this claim is the one the line shows
/// (tracked): the newest one's.
pub(crate) fn claim(kind: Claim, active: impl Fn() -> bool + 'static) -> Memo<bool> {
    // Unique among every surface's claims, which is all a claim needs.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let state = global::<Line>();
    effect(move || {
        let on = active();
        let held = state.with_untracked(|l| match kind {
            Claim::Toast => l.toasts.contains(&id),
        });
        if on != held {
            state.update(|l| match on {
                true => l.of(kind).push(id),
                false => l.of(kind).retain(|&c| c != id),
            });
        }
    });
    cleanup(move || {
        if state.with_untracked(|l| l.toasts.contains(&id)) {
            state.update(|l| {
                l.toasts.retain(|&c| c != id);
            });
        }
    });
    computed(move || {
        state.with(|l| match kind {
            Claim::Toast => l.toasts.last() == Some(&id),
        })
    })
}

/// The line's row, always mounted, for an owner that keeps what it holds
/// mounted while the line is another's (a toast stack's toasts, counted as
/// they come and go): it hides the row itself while it does not show.
pub(crate) fn row() -> Overlay {
    overlay()
        .left_0()
        .right_0()
        .bottom_0()
        .h(crate::terminal::cell_height())
        // The row is the line's alone: what it covers does not
        // show through between its texts.
        .bg(crate::theme::theme().background)
        .flex_row()
        .items_center()
        .overflow_hidden()
        .pointer_events(PointerEvents::BoxNone)
        .focusable(false)
        // What the terminal's painter knows the line by: one row on its
        // ground, never framed as an overlay is.
        .role(AccessibilityRole::Summary)
}
