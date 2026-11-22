//! What a [`Treemap`](super::Treemap) draws, apart from its look: a box,
//! a color and classes per node, the pose `motion.update` moves between.

use std::{collections::HashMap, sync::Arc};

use nsh_core::prelude::*;

use super::Layer;
use crate::plot::pie::Pose;

/// A node as drawn: its row and id (what it is known by across changes),
/// its box (`[x0, y0, x1, y1]`, points), color and classes, and where it
/// is in the tree.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Spot {
    pub(super) id: SharedString,
    pub(super) row: usize,
    pub(super) rect: [f32; 4],
    pub(super) color: Option<Hsla>,
    pub(super) class: SharedString,
    pub(super) group: bool,
    pub(super) depth: usize,
    /// The place of its top-level node among them, which the appear
    /// staggers by.
    pub(super) root: usize,
    /// Its span of the layout's pre-order (it and what is under it).
    pub(super) first: usize,
    pub(super) last: usize,
    /// The height of its band (0: none).
    pub(super) header: f32,
}

impl Spot {
    /// The canvas it draws on.
    pub(super) fn layer(&self) -> Layer {
        Layer {
            group: self.group,
            depth: match self.group {
                true => self.depth,
                false => 0,
            },
            class: self.class.clone(),
        }
    }

    /// The same node shrunk to `t` of its size about its middle.
    pub(super) fn scaled(&self, t: f32) -> Spot {
        let [x0, y0, x1, y1] = self.rect;
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        Spot {
            rect: [
                cx + (x0 - cx) * t,
                cy + (y0 - cy) * t,
                cx + (x1 - cx) * t,
                cy + (y1 - cy) * t,
            ],
            ..self.clone()
        }
    }
}

/// The nodes of a treemap in its layout's pre-order (a group before what
/// is under it).
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct TreemapPose(pub(super) Arc<[Spot]>);

impl Pose for TreemapPose {
    /// The pose drawn `t` of the way from this one to `to`, its nodes
    /// known by their ids: new ones growing, gone ones shrinking.
    fn lerp(&self, to: &Self, t: f32) -> Self {
        let before: HashMap<&str, &Spot> = self.0.iter().map(|s| (&*s.id, s)).collect();
        let mix = |p: f32, q: f32| p + (q - p) * t;
        let now = to.0.iter().map(|b| match before.get(&*b.id) {
            Some(a) => Spot {
                rect: std::array::from_fn(|i| mix(a.rect[i], b.rect[i])),
                color: match (a.color, b.color) {
                    (Some(p), Some(q)) => Some(q.mix_oklab(p, t)),
                    (_, color) => color,
                },
                ..b.clone()
            },
            None => b.scaled(t),
        });
        let gone = self
            .0
            .iter()
            .filter(|a| !to.0.iter().any(|b| b.id == a.id))
            .map(|a| a.scaled(1.0 - t));
        TreemapPose(now.chain(gone).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spot(id: &str, rect: [f32; 4]) -> Spot {
        Spot {
            id: id.to_owned().into(),
            row: 0,
            rect,
            color: None,
            class: SharedString::default(),
            group: false,
            depth: 0,
            root: 0,
            first: 0,
            last: 0,
            header: 0.0,
        }
    }

    /// Between two poses a node in both moves, known by its id whatever its
    /// place; a new one grows from its middle, one that is gone shrinks to
    /// its own.
    #[test]
    fn nodes_move_by_id_grow_and_shrink() {
        let a = TreemapPose(
            [
                spot("x", [0.0, 0.0, 10.0, 10.0]),
                spot("y", [10.0, 0.0, 20.0, 10.0]),
            ]
            .into(),
        );
        let b = TreemapPose(
            [
                spot("z", [0.0, 0.0, 20.0, 20.0]),
                spot("x", [10.0, 10.0, 30.0, 30.0]),
            ]
            .into(),
        );
        let mid = a.lerp(&b, 0.5);
        let of = |id: &str| mid.0.iter().find(|s| &*s.id == id).unwrap().rect;
        assert_eq!(of("x"), [5.0, 5.0, 20.0, 20.0]);
        assert_eq!(of("z"), [5.0, 5.0, 15.0, 15.0]);
        assert_eq!(of("y"), [12.5, 2.5, 17.5, 7.5]);
        assert_eq!(a.lerp(&b, 1.0).0[..2], b.0[..]);
    }
}
