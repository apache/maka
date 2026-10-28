//! The keyboard over a [`super::Plot`]: while the plot has the keyboard
//! focus, Left and Right move the hover to the row before or after, Home
//! and End to the first or last, and Escape clears it, the same hover the
//! pointer drives. `gpui-base`'s plot has no keyboard of its own and
//! WAI-ARIA has no pattern for charts, so the keys are the few a row
//! picker takes (a slider's Left / Right / Home / End, a listbox's
//! Escape) and nothing more. As a slider's arrows in a right-to-left
//! layout, Left and Right follow the screen: on a reversed x scale (the
//! first row at the right edge) Right moves to the row before, while Home
//! and End, and screen readers' increment and decrement, keep the rows'
//! order.
//!
//! The app's shortcuts are window-wide (`on_key_with`), so the plot binds
//! its keys only while it has the focus (as `DataTable` does), and Escape
//! only while a row is hovered: otherwise Escape goes on to what it does
//! around the plot (closing a dialog, going back).

use nsh_core::prelude::*;

use crate::keys::bind_while;

/// Where a key moves the hover.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    /// The row before (Left; a screen reader's decrement).
    Previous,
    /// The row after (Right; a screen reader's increment).
    Next,
    /// The first row (Home).
    First,
    /// The last row (End).
    Last,
}

impl Step {
    /// The step the other arrow takes: Left's and Right's swapped, the
    /// others as they are.
    fn mirrored(self) -> Self {
        match self {
            Step::Previous => Step::Next,
            Step::Next => Step::Previous,
            step => step,
        }
    }
}

/// The row `step` moves the hover to from `from`, among `len` rows of
/// which those `placed` can be hovered (a row with no point, or no slice
/// of a pie, is skipped, as the pointer skips it). With no row hovered,
/// the first key starts at the first row (Right, Home) or the last (Left,
/// End); at either end the hover stays. `None`: no row is placed.
pub(super) fn step(
    len: usize,
    placed: impl Fn(usize) -> bool,
    from: Option<u32>,
    step: Step,
) -> Option<u32> {
    let first = || (0..len).find(|&i| placed(i));
    let last = || (0..len).rev().find(|&i| placed(i));
    let at = match (step, from.map(|i| i as usize)) {
        (Step::First, _) | (Step::Next, None) => first(),
        (Step::Last, _) | (Step::Previous, None) => last(),
        // A row the rows no longer hold (fewer rows since) moves to the
        // nearest end.
        (Step::Next, Some(i)) => (i + 1..len).find(|&j| placed(j)).or_else(|| {
            if i < len && placed(i) {
                Some(i)
            } else {
                last()
            }
        }),
        (Step::Previous, Some(i)) => (0..i.min(len)).rev().find(|&j| placed(j)).or_else(|| {
            if i < len && placed(i) {
                Some(i)
            } else {
                first()
            }
        }),
    };
    at.map(|i| i as u32)
}

/// The plot's keys: a step of the hover, or Escape's clearing it.
const KEYS: &[(&str, bool, Step)] = &[
    ("left", true, Step::Previous),
    ("right", true, Step::Next),
    ("home", false, Step::First),
    ("end", false, Step::Last),
];

/// Binds the plot's keys while `active` (focused and interactive): each
/// moves the hover to the row `to` finds for its step, Left's and Right's
/// swapped while `mirrored` (the rows run right to left); Escape
/// (`go(None)`) only while a row is `hovered`.
pub(super) fn bind(
    active: impl Fn() -> bool + Copy + 'static,
    mirrored: impl Fn() -> bool + Copy + 'static,
    hovered: Signal<Option<u32>>,
    to: impl Fn(Step) -> Option<u32> + Copy + 'static,
    go: impl Fn(Option<u32>) + Copy + 'static,
) {
    bind_while(active, KEYS, move |step: Step| {
        let step = match mirrored() {
            true => step.mirrored(),
            false => step,
        };
        go(to(step))
    });
    let hovering = computed(move || hovered.get().is_some());
    bind_while(
        move || active() && hovering.get(),
        &[("escape", false, ())],
        move |()| go(None),
    );
}

#[cfg(test)]
mod tests {
    use super::{Step, step};

    /// The keys move between the rows that are placed, stop at either end,
    /// and start from an end when no row is hovered.
    #[test]
    fn keys_step_through_the_placed_rows() {
        let xs = [0.0, f32::NAN, 50.0, 100.0];
        let at = |from, to| step(xs.len(), |i| xs[i].is_finite(), from, to);
        assert_eq!(at(None, Step::Next), Some(0));
        assert_eq!(at(None, Step::Previous), Some(3));
        assert_eq!(at(Some(0), Step::Next), Some(2));
        assert_eq!(at(Some(2), Step::Previous), Some(0));
        assert_eq!(at(Some(3), Step::Next), Some(3));
        assert_eq!(at(Some(0), Step::Previous), Some(0));
        assert_eq!(at(Some(2), Step::First), Some(0));
        assert_eq!(at(Some(0), Step::Last), Some(3));
        // Fewer rows than the one hovered: the nearest end.
        assert_eq!(at(Some(9), Step::Next), Some(3));
        assert_eq!(at(Some(9), Step::Previous), Some(3));
        // No row placed: nothing to hover.
        assert_eq!(step(0, |_| true, None, Step::Next), None);
        assert_eq!(step(1, |_| false, Some(0), Step::Next), None);
    }

    /// Mirrored (a reversed x scale), Left and Right swap their steps and
    /// Home and End keep theirs.
    #[test]
    fn mirrored_arrows_swap_their_steps() {
        assert_eq!(Step::Next.mirrored(), Step::Previous);
        assert_eq!(Step::Previous.mirrored(), Step::Next);
        assert_eq!(Step::First.mirrored(), Step::First);
        assert_eq!(Step::Last.mirrored(), Step::Last);
    }
}
