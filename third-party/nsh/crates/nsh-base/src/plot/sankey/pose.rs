//! What a [`Sankey`](super::Sankey) draws, apart from its look: its
//! nodes' rectangles and its ribbons' outlines (the pose `motion.update`
//! moves), and its moves from one pose to the next, as `Pie`'s `Update`
//! moves its poses: a change while one runs moves on from where the marks
//! are drawn.

use std::sync::Arc as Shared;

use nsh_core::{element::Timing, prelude::*};

use super::{
    LinkKey, PlotContext, find,
    layout::{Graph, Ribbon},
    link_keys, node_rect, update_timing,
};

/// Where a node's label goes (`gpui-component`'s placement,
/// `chart/sankey_chart.rs:666-689`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Side {
    /// Left of a node in the first column, at its middle.
    Before,
    /// Right of a node in the last column, at its middle.
    After,
    /// Centered above a node between them.
    Above,
}

impl Side {
    /// The point a label on this side of `rect` hangs from.
    pub(super) fn anchor(self, rect: Bounds<Points>) -> (f32, f32) {
        let (x0, y0) = (rect.origin.x.0, rect.origin.y.0);
        let (w, h) = (rect.size.width.0, rect.size.height.0);
        match self {
            Side::Before => (x0, y0 + h / 2.0),
            Side::After => (x0 + w, y0 + h / 2.0),
            Side::Above => (x0 + w / 2.0, y0),
        }
    }
}

/// A node as drawn: its rectangle, and the side its label goes on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct NodePose {
    pub(super) rect: Bounds<Points>,
    pub(super) side: Side,
}

/// What a sankey draws: its nodes by row and its ribbons by link key, the
/// thinnest a ribbon draws (`minLinkWidth`) with them.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Pose {
    nodes: Shared<[NodePose]>,
    ribbons: Shared<[(LinkKey, Ribbon)]>,
    min: f32,
}

impl Pose {
    /// What `graph` draws, its ribbons at least `min` thick.
    pub(super) fn of(graph: &Graph, min: f32) -> Self {
        let last = graph.layer_count().saturating_sub(1);
        let nodes = graph.nodes.iter().map(|n| NodePose {
            rect: node_rect(n),
            side: match n.layer {
                0 => Side::Before,
                l if l == last => Side::After,
                _ => Side::Above,
            },
        });
        let ribbons = link_keys(graph).into_iter().filter_map(|key| {
            let link = find(graph, key)?;
            Some((key, Ribbon::of(graph, link, min)))
        });
        Pose {
            nodes: nodes.collect(),
            ribbons: ribbons.collect(),
            min,
        }
    }

    /// Node `i`.
    pub(super) fn node(&self, i: usize) -> Option<NodePose> {
        self.nodes.get(i).copied()
    }

    /// Link `key`'s ribbon.
    pub(super) fn ribbon(&self, key: LinkKey) -> Option<Ribbon> {
        self.ribbons
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, r)| *r)
    }

    /// Where node `i` moves from when this pose moves to one where it is
    /// `to`: where it is here, or for a node new to it, `to` with no
    /// height at its middle (it grows from there).
    pub(super) fn node_from(&self, i: usize, to: Bounds<Points>) -> Bounds<Points> {
        match self.node(i) {
            Some(n) => n.rect,
            None => Bounds::new(
                point(to.origin.x, to.origin.y + to.size.height / 2.0),
                size(to.size.width, px(0.0)),
            ),
        }
    }

    /// Where link `key`'s ribbon moves from when this pose moves to one
    /// where it is `to`: where it is here, or for a link new to it, `to`
    /// at its least width.
    pub(super) fn ribbon_from(&self, key: LinkKey, to: &Ribbon, min: f32) -> Ribbon {
        self.ribbon(key).unwrap_or_else(|| to.thin(min))
    }

    /// What is drawn `t` of the way from this pose to `to`: `to`'s nodes
    /// and ribbons, each that far from where it moves from.
    pub(super) fn lerp(&self, to: &Pose, t: f32) -> Pose {
        let at = |a: f32, b: f32| a + (b - a) * t;
        let nodes = to.nodes.iter().enumerate().map(|(i, n)| {
            let (a, b) = (self.node_from(i, n.rect), n.rect);
            NodePose {
                rect: Bounds::new(
                    point(
                        px(at(a.origin.x.0, b.origin.x.0)),
                        px(at(a.origin.y.0, b.origin.y.0)),
                    ),
                    size(
                        px(at(a.size.width.0, b.size.width.0)),
                        px(at(a.size.height.0, b.size.height.0)),
                    ),
                ),
                side: n.side,
            }
        });
        let ribbons = to.ribbons.iter().map(|(key, b)| {
            let a = self.ribbon_from(*key, b, to.min);
            let r = Ribbon {
                sx: at(a.sx, b.sx),
                s_top: at(a.s_top, b.s_top),
                s_bottom: at(a.s_bottom, b.s_bottom),
                tx: at(a.tx, b.tx),
                t_top: at(a.t_top, b.t_top),
                t_bottom: at(a.t_bottom, b.t_bottom),
            };
            (*key, r)
        });
        Pose {
            nodes: nodes.collect(),
            ribbons: ribbons.collect(),
            min: to.min,
        }
    }

    /// The thinnest its ribbons draw.
    pub(super) fn min(&self) -> f32 {
        self.min
    }
}

/// A sankey's moves to new flows (`motion.update`, d3's transitions of a
/// sankey's attributes): the pose it draws, the one it moves from while a
/// move runs, and how far that has gone, on the platform's animator. Every
/// number it draws is linear in the pose's, so each moves on the animator
/// from its old value to its new one. A change while a move runs moves on
/// from where the sankey is drawn then, as `Pie`'s `Update` does: the move
/// stops, the animator tells how far it had gone, and the next one starts
/// from the pose drawn there (the sankey holds still until the animator
/// answers). The changes of one turn make one move. The plot's size
/// changing moves nothing.
#[derive(Clone, Copy)]
pub(super) struct Moves {
    /// The pose it moves to, and the one it moves from while a move runs.
    shown: Signal<Option<(Pose, Option<Pose>)>>,
    progress: AnimatedValue,
}

impl Moves {
    /// Follows `pose`, moving to each new one with the plot's
    /// `motion.update` (at once without one, with reduced motion, or when
    /// the plot's size made it).
    pub(super) fn new(plot: PlotContext, pose: Memo<Option<Pose>>) -> Self {
        let shown = signal(None::<(Pose, Option<Pose>)>);
        let progress = animated_value(1.0);
        // The last pose and the plot's size it was laid out in, and how
        // many changes came: a stopped move's successor starts only if no
        // change came while the animator was asked how far it had gone.
        let last = stored(None::<(Pose, Size<Points>)>);
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
        shown: Signal<Option<(Pose, Option<Pose>)>>,
        progress: AnimatedValue,
        from: Pose,
        to: Pose,
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
    pub(super) fn shown(&self) -> Option<(Pose, Option<(Pose, AnimatedValue)>)> {
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
