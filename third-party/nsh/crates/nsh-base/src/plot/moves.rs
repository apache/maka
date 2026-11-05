//! [`Moves`]: a mark's moves from one pose to the next with the plot's
//! `motion.update`, for marks whose poses are laid out in points for the
//! plot's size (a sankey's, a treemap's).

use nsh_core::{element::Timing, prelude::*};

use super::{PlotContext, pie::Pose};

/// The plot's `motion.update`, unless it moves at once (none, no
/// duration, or reduced motion).
pub(super) fn update_timing(plot: PlotContext) -> Option<Timing> {
    untracked(|| plot.motion.get().and_then(|m| m.update))
        .filter(|t| t.duration_ms > 0.0 && !reduce_motion())
}

/// A mark's moves to new poses (`motion.update`, d3's transitions of a
/// mark's attributes): the pose it draws, the one it moves from while a
/// move runs, and how far that has gone, on the platform's animator. A
/// change while a move runs moves on from where the mark is drawn then, as
/// `Pie`'s `Update` does: the move stops, the animator tells how far it had
/// gone, and the next one starts from the pose drawn there (the mark holds
/// still until the animator answers). The changes of one turn make one
/// move (the app changing two props of it together moves once), and the
/// plot's size changing moves nothing: a pose laid out in points for a new
/// size shows at once.
pub(super) struct Moves<P> {
    /// The pose it moves to, and the one it moves from while a move runs.
    shown: Signal<Option<(P, Option<P>)>>,
    progress: AnimatedValue,
}

impl<P> Clone for Moves<P> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<P> Copy for Moves<P> {}

impl<P: Pose> Moves<P> {
    /// Follows `pose`, moving to each new one with the plot's
    /// `motion.update` (at once without one, with reduced motion, or when
    /// the plot's size made it).
    pub(super) fn new(plot: PlotContext, pose: Memo<Option<P>>) -> Self {
        let shown = signal(None::<(P, Option<P>)>);
        let progress = animated_value(1.0);
        // The last pose and the plot's size it was laid out in, and how
        // many changes came: a stopped move's successor starts only if no
        // change came while the animator was asked how far it had gone.
        let last = stored(None::<(P, Size<Points>)>);
        let changes = stored(0_u32);
        effect(move || {
            pose.with(|_| ());
            // Decided once the turn's changes are all in (a task runs
            // after the code that spawned it, and a newer run of this
            // effect cancels the one before): an app changing the rows
            // and the links together makes one move, not a move to the
            // rows with the old links first.
            spawn(async move {
                let to = pose.get_untracked();
                let size = plot.size.get_untracked();
                let before = last.replace(to.clone().map(|p| (p, size)));
                let Some(to) = to else {
                    if shown.with_untracked(Option::is_some) {
                        shown.set(None);
                    }
                    return;
                };
                let Some((before, was)) = before else {
                    return shown.set(Some((to, None)));
                };
                if before == to {
                    return;
                }
                let change = changes.with(|c| {
                    *c = c.wrapping_add(1);
                    *c
                });
                let Some(timing) = update_timing(plot).filter(|_| was == size) else {
                    return shown.set(Some((to, None)));
                };
                let (at, moving) = shown.with_untracked(|s| match s {
                    Some((at, from)) => (at.clone(), from.is_some()),
                    None => (before.clone(), false),
                });
                if !moving {
                    return Self::run(shown, progress, at, to, timing);
                }
                progress.stop();
                let t = progress.value().await;
                if changes.get() != change {
                    // A newer change asks again.
                    return;
                }
                let at = shown.with_untracked(|s| match s {
                    Some((at, Some(from))) => from.lerp(at, t),
                    Some((at, None)) => at.clone(),
                    None => to.clone(),
                });
                Self::run(shown, progress, at, to, timing);
            });
        });
        Moves { shown, progress }
    }

    /// Moves from `from` to `to` over `timing`.
    fn run(
        shown: Signal<Option<(P, Option<P>)>>,
        progress: AnimatedValue,
        from: P,
        to: P,
        timing: Timing,
    ) {
        shown.set(Some((to, Some(from))));
        progress.set(0.0);
        let end = progress.timing_with(1.0, timing);
        spawn(async move {
            // Stopped by a newer change: that one ends it.
            if end.await {
                shown.update(|s| {
                    if let Some((_, from)) = s {
                        *from = None;
                    }
                });
            }
        });
    }

    /// The pose it moves to and, while a move runs, the pose it moves from
    /// and how far it has gone.
    pub(super) fn shown(&self) -> Option<(P, Option<(P, AnimatedValue)>)> {
        let progress = self.progress;
        self.shown.with(|s| {
            s.as_ref()
                .map(|(to, from)| (to.clone(), from.clone().map(|from| (from, progress))))
        })
    }

    /// How far the move that runs has gone, 1 at rest.
    pub(super) fn progress(&self) -> AnimatedValue {
        self.progress
    }
}
