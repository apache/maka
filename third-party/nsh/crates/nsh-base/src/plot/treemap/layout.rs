//! The layout of a [`Treemap`](super::Treemap): the plot's rows made a
//! tree by their ids and parents (d3's `stratify`), the leaves' values
//! summed up it, and each level tiled into its parent's box as d3's
//! squarified `treemap` with its paddings.

use std::collections::HashMap;

use nsh_core::prelude::SharedString;

use super::TreemapSort;
use crate::plot::keys::Step;

/// What the layout takes of each row: its id, its parent's id (empty for
/// none) and its value (a leaf's area; a group's is its children's sum).
pub(super) struct Input<'a> {
    pub(super) ids: &'a [SharedString],
    pub(super) parents: &'a [SharedString],
    pub(super) values: &'a [f64],
}

/// What the app's rows got wrong, told once while it stays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Problem {
    /// Row `.0` has the id of an earlier row; it names no parent.
    DuplicateId(usize, SharedString),
    /// Row `.0` names a parent no row has: it is a top-level node.
    UnknownParent(usize, SharedString),
    /// Row `.0` is its own ancestor: neither it nor what is under it is
    /// drawn.
    Cycle(usize),
}

/// The rows as a tree: each row's parent row and children (in the order
/// the app wrote them), and its value, its leaves' sum for a group.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Tree {
    parent: Vec<Option<usize>>,
    children: Vec<Vec<usize>>,
    roots: Vec<usize>,
    pub(super) value: Vec<f64>,
    /// Rows in a cycle, and so out of the tree.
    lost: Vec<bool>,
    pub(super) problems: Vec<Problem>,
}

impl Tree {
    /// The tree of `input`'s rows (d3's `stratify`): a row whose parent is
    /// empty, or names no row, is a top-level node. A leaf's value is its
    /// own when it is a finite number above 0, else 0 (it takes no area); a
    /// group's is the sum of its children's, whatever its own.
    pub(super) fn new(input: &Input) -> Tree {
        let len = input
            .ids
            .len()
            .min(input.parents.len())
            .min(input.values.len());
        let mut problems = Vec::new();
        let mut by_id = HashMap::<&str, usize>::with_capacity(len);
        for (row, id) in input.ids[..len].iter().enumerate() {
            if by_id.contains_key(&**id) {
                problems.push(Problem::DuplicateId(row, id.clone()));
            } else {
                by_id.insert(id, row);
            }
        }
        let mut parent = vec![None; len];
        for (row, p) in input.parents[..len].iter().enumerate() {
            if p.is_empty() {
                continue;
            }
            match by_id.get(&**p) {
                Some(&of) => parent[row] = Some(of),
                None => problems.push(Problem::UnknownParent(row, p.clone())),
            }
        }
        // A row that is its own ancestor is lost, with what is under it.
        let mut lost = vec![false; len];
        let mut state = vec![0u8; len]; // 0: unseen, 1: on the path, 2: done
        for start in 0..len {
            let mut path = Vec::new();
            let mut at = Some(start);
            let mut cyclic = false;
            while let Some(row) = at {
                match state[row] {
                    2 => {
                        cyclic = lost[row];
                        break;
                    }
                    1 => {
                        cyclic = true;
                        problems.push(Problem::Cycle(row));
                        break;
                    }
                    _ => {
                        state[row] = 1;
                        path.push(row);
                        at = parent[row];
                    }
                }
            }
            for row in path {
                state[row] = 2;
                lost[row] = cyclic;
            }
        }
        let mut children = vec![Vec::new(); len];
        let mut roots = Vec::new();
        for row in 0..len {
            if lost[row] {
                continue;
            }
            match parent[row] {
                Some(p) => children[p].push(row),
                None => roots.push(row),
            }
        }
        let mut tree = Tree {
            parent,
            children,
            roots,
            value: vec![0.0; len],
            lost,
            problems,
        };
        let leaf_value = |v: f64| match v.is_finite() && v > 0.0 {
            true => v,
            false => 0.0,
        };
        for &root in &tree.roots.clone() {
            tree.sum(root, &|row| leaf_value(input.values[row]));
        }
        tree
    }

    /// Sums the leaves' values under `row` into each group's.
    fn sum(&mut self, row: usize, leaf: &impl Fn(usize) -> f64) -> f64 {
        let value = match self.children[row].is_empty() {
            true => leaf(row),
            false => {
                let mut sum = 0.0;
                for i in 0..self.children[row].len() {
                    sum += self.sum(self.children[row][i], leaf);
                }
                // A sum past `f64::MAX` stays a number.
                sum.min(f64::MAX)
            }
        };
        self.value[row] = value;
        value
    }

    /// The row has children in the tree.
    pub(super) fn is_group(&self, row: usize) -> bool {
        self.children.get(row).is_some_and(|c| !c.is_empty())
    }
}

/// How the layout tiles and pads.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Options {
    pub(super) width: f32,
    pub(super) height: f32,
    /// The aspect ratio the squarified tiles approach (d3's φ); at least 1.
    pub(super) ratio: f64,
    pub(super) sort: TreemapSort,
    /// The gap between siblings of each level (the last for the deeper
    /// ones; none without any).
    pub(super) padding_inner: Vec<f32>,
    /// The room inside the groups of each level around their children.
    pub(super) padding_outer: Vec<f32>,
    /// The band at the top of the groups of each level.
    pub(super) padding_top: Vec<f32>,
}

/// The value of each level of `levels` (the last for the deeper ones; 0
/// without any).
pub(super) fn at_level(levels: &[f32], level: usize) -> f32 {
    levels
        .get(level)
        .or(levels.last())
        .copied()
        .unwrap_or(0.0)
        .max(0.0)
}

/// A node laid out: its box, in points, and where it is in the tree.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Node {
    pub(super) row: usize,
    /// Its level: 0 for the top-level nodes.
    pub(super) depth: usize,
    pub(super) x0: f32,
    pub(super) y0: f32,
    pub(super) x1: f32,
    pub(super) y1: f32,
    /// A group: it has children laid out in it.
    pub(super) group: bool,
    /// The height of its band at the top (0: none, or a leaf).
    pub(super) header: f32,
    /// Its place in [`Layout::nodes`] (the tree in pre-order) and that of
    /// the last node under it: the nodes from `first` to `last` are it and
    /// what is under it.
    pub(super) first: usize,
    pub(super) last: usize,
}

impl Node {
    pub(super) fn width(&self) -> f32 {
        self.x1 - self.x0
    }

    pub(super) fn height(&self) -> f32 {
        self.y1 - self.y0
    }

    /// The distance from `(x, y)` to its box (0 inside).
    pub(super) fn distance(&self, x: f32, y: f32) -> f32 {
        let dx = (self.x0 - x).max(x - self.x1).max(0.0);
        let dy = (self.y0 - y).max(y - self.y1).max(0.0);
        dx.hypot(dy)
    }

    pub(super) fn center(&self) -> (f32, f32) {
        ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)
    }
}

/// The nodes that take area, in pre-order (a group before what is under
/// it, siblings in their tiling order), and the place of each row's among
/// them.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Layout {
    pub(super) nodes: Vec<Node>,
    pub(super) of_row: Vec<Option<usize>>,
    /// The places of the top-level nodes.
    pub(super) roots: Vec<usize>,
    /// The content box of each group (inside its paddings and band), by
    /// place: where the pointer finds its children.
    pub(super) content: Vec<[f32; 4]>,
}

impl Layout {
    /// The node of `row`, when it takes area.
    pub(super) fn of(&self, row: usize) -> Option<&Node> {
        self.nodes.get(self.of_row.get(row).copied().flatten()?)
    }

    /// The children of the node at `place`, by place.
    pub(super) fn children(&self, place: usize) -> impl Iterator<Item = usize> + '_ {
        let node = self.nodes[place];
        let mut at = place + 1;
        std::iter::from_fn(move || {
            if at > node.last || !node.group {
                return None;
            }
            let here = at;
            at = self.nodes[here].last + 1;
            Some(here)
        })
    }

    /// The leaves, by place, in pre-order.
    pub(super) fn leaves(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.nodes.len()).filter(|&i| !self.nodes[i].group)
    }

    /// The row of the node the pointer at `(x, y)` is over: a leaf, or a
    /// group in its band or padding; across a gap, a node beside it
    /// (within `reach` at the top level).
    pub(super) fn at(&self, x: f32, y: f32, reach: f32) -> Option<usize> {
        let nearest = |places: &mut dyn Iterator<Item = usize>, reach: f32| {
            places
                .map(|i| (i, self.nodes[i].distance(x, y)))
                .filter(|(_, d)| *d <= reach)
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(i, _)| i)
        };
        let mut at = nearest(&mut self.roots.iter().copied(), reach)?;
        loop {
            let node = self.nodes[at];
            if !node.group {
                return Some(node.row);
            }
            let [x0, y0, x1, y1] = self.content[at];
            if x < x0 || x > x1 || y < y0 || y > y1 {
                return Some(node.row);
            }
            match nearest(&mut self.children(at), f32::INFINITY) {
                Some(child) => at = child,
                None => return Some(node.row),
            }
        }
    }
}

/// The row of the leaf the keys step to from the node of row `from`: an
/// arrow to a leaf on its side on the screen, Home and End to the first and
/// last leaf; at an edge the hover stays.
pub(super) fn step(layout: &Layout, from: Option<usize>, step: Step) -> Option<usize> {
    let leaves: Vec<&Node> = layout.leaves().map(|i| &layout.nodes[i]).collect();
    let (first, last) = (leaves.first()?.row, leaves.last()?.row);
    let Some(here) = from.and_then(|row| layout.of(row)) else {
        return Some(match step {
            Step::Previous | Step::Up | Step::Last => last,
            Step::Next | Step::Down | Step::First => first,
        });
    };
    let (cx, cy) = here.center();
    // How far a leaf is past `here` in the step's direction (`None`: not
    // on that side), whether it overlaps it across, and how far its middle
    // is from `here`'s across.
    let side = |n: &Node| -> Option<(bool, f32, f32)> {
        let (nx, ny) = n.center();
        let across_x = n.x0 < here.x1 && n.x1 > here.x0;
        let across_y = n.y0 < here.y1 && n.y1 > here.y0;
        match step {
            Step::Next => {
                (n.x0 >= here.x1 - 0.5).then(|| (across_y, n.x0 - here.x1, (ny - cy).abs()))
            }
            Step::Previous => {
                (n.x1 <= here.x0 + 0.5).then(|| (across_y, here.x0 - n.x1, (ny - cy).abs()))
            }
            Step::Down => {
                (n.y0 >= here.y1 - 0.5).then(|| (across_x, n.y0 - here.y1, (nx - cx).abs()))
            }
            Step::Up => {
                (n.y1 <= here.y0 + 0.5).then(|| (across_x, here.y0 - n.y1, (nx - cx).abs()))
            }
            Step::First | Step::Last => None,
        }
    };
    match step {
        Step::First => Some(first),
        Step::Last => Some(last),
        _ => {
            let found = leaves
                .iter()
                .filter(|n| n.row != here.row)
                .filter_map(|n| side(n).map(|s| (n.row, s)))
                .min_by(|(_, a), (_, b)| {
                    b.0.cmp(&a.0)
                        .then(a.1.total_cmp(&b.1))
                        .then(a.2.total_cmp(&b.2))
                });
            Some(found.map_or(here.row, |(row, _)| row))
        }
    }
}

/// Lays `tree` out in a box of `options`' size at the origin, as d3's
/// squarified `treemap` does; a node with no value takes no area, and a
/// level's bands go on all the siblings of a parent or none.
pub(super) fn layout(tree: &Tree, options: &Options) -> Layout {
    let mut out = Layout {
        of_row: vec![None; tree.value.len()],
        ..Layout::default()
    };
    let (w, h) = (options.width.max(0.0), options.height.max(0.0));
    if w <= 0.0 || h <= 0.0 {
        return out;
    }
    let roots = ordered(tree, &tree.roots, options.sort);
    let p = at_level(&options.padding_inner, 0) / 2.0;
    // The top level, as d3 lays out its root's children: the box grown by
    // half the gap, each tile shrunk by it, so no gap runs along the edges.
    let tiles = squarify(
        &roots.iter().map(|&r| tree.value[r]).collect::<Vec<_>>(),
        [-p, -p, w + p, h + p],
        options.ratio,
    );
    let bands = bands(tree, &roots, &tiles, p, at_level(&options.padding_top, 0));
    let mut placed = Vec::new();
    for ((&row, tile), header) in roots.iter().zip(&tiles).zip(bands) {
        if let Some(i) = place(tree, options, &mut out, row, 0, *tile, p, header) {
            placed.push(i);
        }
    }
    out.roots = placed;
    out
}

/// The rows of `rows` that take area, in the order they are tiled.
fn ordered(tree: &Tree, rows: &[usize], sort: TreemapSort) -> Vec<usize> {
    let mut rows: Vec<usize> = rows
        .iter()
        .copied()
        .filter(|&r| tree.value[r] > 0.0)
        .collect();
    if sort == TreemapSort::Value {
        // Stable: equal values keep the rows' order.
        rows.sort_by(|&a, &b| tree.value[b].total_cmp(&tree.value[a]));
    }
    rows
}

/// Places `row` in its `tile` and what is under it; its place in
/// `out.nodes`, or `None` when it has no area.
#[allow(clippy::too_many_arguments)]
fn place(
    tree: &Tree,
    options: &Options,
    out: &mut Layout,
    row: usize,
    depth: usize,
    tile: [f32; 4],
    p: f32,
    header: f32,
) -> Option<usize> {
    let [mut x0, mut y0, mut x1, mut y1] = [tile[0] + p, tile[1] + p, tile[2] - p, tile[3] - p];
    if x1 < x0 {
        x0 = (x0 + x1) / 2.0;
        x1 = x0;
    }
    if y1 < y0 {
        y0 = (y0 + y1) / 2.0;
        y1 = y0;
    }
    let [x0, y0, x1, y1] = [x0, y0, x1, y1].map(f32::round);
    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return None;
    }
    let at = out.nodes.len();
    out.nodes.push(Node {
        row,
        depth,
        x0,
        y0,
        x1,
        y1,
        group: false,
        header: 0.0,
        first: at,
        last: at,
    });
    out.content.push([x0, y0, x1, y1]);
    out.of_row[row] = Some(at);
    let children = ordered(tree, &tree.children[row], options.sort);
    if !children.is_empty() {
        let outer = at_level(&options.padding_outer, depth);
        let p = at_level(&options.padding_inner, depth + 1) / 2.0;
        let content = [
            x0 + outer,
            (y0 + outer + header).min(y1),
            (x1 - outer).max(x0 + outer),
            (y1 - outer).max((y0 + outer + header).min(y1)),
        ];
        let tiles = squarify(
            &children.iter().map(|&c| tree.value[c]).collect::<Vec<_>>(),
            [
                content[0] - p,
                content[1] - p,
                content[2] + p,
                content[3] + p,
            ],
            options.ratio,
        );
        let bands = bands(
            tree,
            &children,
            &tiles,
            p,
            at_level(&options.padding_top, depth + 1),
        );
        for ((&child, tile), header) in children.iter().zip(&tiles).zip(bands) {
            place(tree, options, out, child, depth + 1, *tile, p, header);
        }
        // A group whose children all rounded to nothing is drawn as a leaf.
        if out.nodes.len() > at + 1 {
            out.nodes[at].group = true;
            out.nodes[at].header = header;
            out.content[at] = content;
        }
    }
    out.nodes[at].last = out.nodes.len() - 1;
    Some(at)
}

/// The height of the band at the top of each of `rows`, siblings tiled in
/// `tiles`: on all of their groups or none.
fn bands(tree: &Tree, rows: &[usize], tiles: &[[f32; 4]], p: f32, band: f32) -> Vec<f32> {
    let fits =
        |t: &[f32; 4]| t[2] - t[0] - 2.0 * p >= 2.0 * band && t[3] - t[1] - 2.0 * p >= 2.0 * band;
    let banded = band > 0.0
        && rows
            .iter()
            .zip(tiles)
            .all(|(&r, t)| !tree.is_group(r) || fits(t));
    rows.iter()
        .map(|&r| match banded && tree.is_group(r) {
            true => band,
            false => 0.0,
        })
        .collect()
}

/// d3's `treemapSquarify`: the box `[x0, y0, x1, y1]` cut into a tile per
/// value, in order, near `ratio`. The values are above 0.
pub(super) fn squarify(values: &[f64], area: [f32; 4], ratio: f64) -> Vec<[f32; 4]> {
    let n = values.len();
    let [mut x0, mut y0, x1, y1] = area.map(f64::from);
    let mut out = vec![[area[0], area[1], area[0], area[1]]; n];
    // Only the shares matter: divided by the largest, sums never overflow.
    let unit = values.iter().copied().fold(0.0, f64::max);
    if n == 0 || unit <= 0.0 || x1 <= x0 || y1 <= y0 {
        return out;
    }
    let value = |i: usize| values[i] / unit;
    let ratio = ratio.max(1.0);
    let mut remaining: f64 = (0..n).map(value).sum();
    let (mut i0, mut i1) = (0, 0);
    while i0 < n {
        let (dx, dy) = (x1 - x0, y1 - y0);
        let mut sum = value(i1);
        i1 += 1;
        let (mut min, mut max) = (sum, sum);
        let alpha = (dy / dx).max(dx / dy) / (remaining * ratio);
        let mut beta = sum * sum * alpha;
        let mut min_ratio = (max / beta).max(beta / min);
        while i1 < n {
            let v = value(i1);
            sum += v;
            min = min.min(v);
            max = max.max(v);
            beta = sum * sum * alpha;
            let new_ratio = (max / beta).max(beta / min);
            if new_ratio > min_ratio {
                sum -= v;
                break;
            }
            min_ratio = new_ratio;
            i1 += 1;
        }
        // The row: across the box's width when it is taller than wide (d3's
        // `dice`), else down its height (`slice`); the last row takes what
        // is left, so no sliver of rounding stays.
        let last = i1 >= n;
        let share = match last {
            true => 1.0,
            false => sum / remaining,
        };
        if dx < dy {
            let ry1 = match last {
                true => y1,
                false => y0 + dy * share,
            };
            let mut x = x0;
            for (i, tile) in out.iter_mut().enumerate().take(i1).skip(i0) {
                let nx = match i + 1 == i1 {
                    true => x1,
                    false => x + dx * value(i) / sum,
                };
                *tile = [x as f32, y0 as f32, nx as f32, ry1 as f32];
                x = nx;
            }
            y0 = ry1;
        } else {
            let rx1 = match last {
                true => x1,
                false => x0 + dx * share,
            };
            let mut y = y0;
            for (i, tile) in out.iter_mut().enumerate().take(i1).skip(i0) {
                let ny = match i + 1 == i1 {
                    true => y1,
                    false => y + dy * value(i) / sum,
                };
                *tile = [x0 as f32, y as f32, rx1 as f32, ny as f32];
                y = ny;
            }
            x0 = rx1;
        }
        remaining -= sum;
        i0 = i1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(all: &[&str]) -> Vec<SharedString> {
        all.iter()
            .map(|s| SharedString::from(s.to_string()))
            .collect()
    }

    fn tree(ids: &[&str], parents: &[&str], values: &[f64]) -> Tree {
        Tree::new(&Input {
            ids: &texts(ids),
            parents: &texts(parents),
            values,
        })
    }

    fn options(width: f32, height: f32) -> Options {
        Options {
            width,
            height,
            ratio: std::f64::consts::GOLDEN_RATIO,
            sort: TreemapSort::Value,
            padding_inner: Vec::new(),
            padding_outer: Vec::new(),
            padding_top: Vec::new(),
        }
    }

    fn area(t: &[f32; 4]) -> f64 {
        f64::from(t[2] - t[0]) * f64::from(t[3] - t[1])
    }

    /// Squarified tiles share the box by value, fill it without
    /// overlapping, and stay near square.
    #[test]
    fn squarified_tiles_share_the_box_by_value() {
        let values = [6.0, 6.0, 4.0, 3.0, 2.0, 2.0, 1.0];
        let tiles = squarify(&values, [0.0, 0.0, 600.0, 400.0], 1.0);
        assert_eq!(tiles[0], [0.0, 0.0, 300.0, 200.0]);
        assert_eq!(tiles[1], [0.0, 200.0, 300.0, 400.0]);
        let total: f64 = values.iter().sum();
        let mut covered = 0.0;
        for (t, v) in tiles.iter().zip(values) {
            let want = 600.0 * 400.0 * v / total;
            assert!((area(t) - want).abs() < 1e-2, "{t:?} {want}");
            assert!(t[0] >= 0.0 && t[1] >= 0.0 && t[2] <= 600.0 && t[3] <= 400.0);
            let (w, h) = (t[2] - t[0], t[3] - t[1]);
            assert!(w.max(h) / w.min(h) < 3.0, "{t:?}");
            covered += area(t);
        }
        assert!((covered - 240_000.0).abs() < 1e-2);
        for i in 0..tiles.len() {
            for j in i + 1..tiles.len() {
                let (a, b) = (tiles[i], tiles[j]);
                let overlap = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0)
                    * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
                assert!(overlap < 1e-3, "{a:?} {b:?}");
            }
        }
        // One value fills the box; none tiles nothing.
        assert_eq!(
            squarify(&[3.0], [0.0, 0.0, 10.0, 5.0], 1.0),
            [[0.0, 0.0, 10.0, 5.0]]
        );
        assert!(squarify(&[], [0.0, 0.0, 10.0, 5.0], 1.0).is_empty());
    }

    /// Groups' values are their leaves' sums, whatever they say
    /// themselves; a leaf of 0, below 0 or no number takes nothing.
    #[test]
    fn values_are_summed_up_the_tree() {
        let t = tree(
            &["tech", "fin", "a", "b", "c", "d", "e"],
            &["", "", "tech", "tech", "fin", "fin", "fin"],
            &[99.0, f64::NAN, 3.0, 2.0, 0.0, -4.0, f64::NAN],
        );
        assert_eq!(t.value, [5.0, 0.0, 3.0, 2.0, 0.0, 0.0, 0.0]);
        assert!(t.problems.is_empty());
        // `fin` takes no area, nor do its leaves.
        let l = layout(&t, &options(100.0, 50.0));
        assert_eq!(
            l.of(0).map(|n| (n.x0, n.y0, n.x1, n.y1)),
            Some((0.0, 0.0, 100.0, 50.0))
        );
        for row in [1, 4, 5, 6] {
            assert!(l.of(row).is_none(), "{row}");
        }
        assert_eq!(l.leaves().count(), 2);
    }

    /// A repeated id, a parent no row has and a cycle are told; the rows
    /// still draw where they can.
    #[test]
    fn the_rows_problems_are_told() {
        let t = tree(
            &["a", "a", "b", "c", "d"],
            &["", "", "x", "d", "c"],
            &[1.0, 1.0, 1.0, 1.0, 1.0],
        );
        assert!(t.problems.contains(&Problem::DuplicateId(1, "a".into())));
        assert!(t.problems.contains(&Problem::UnknownParent(2, "x".into())));
        assert!(t.problems.iter().any(|p| matches!(p, Problem::Cycle(_))));
        let l = layout(&t, &options(100.0, 100.0));
        // `b` is a top-level node; `c` and `d` are lost.
        assert!(l.of(2).is_some());
        assert!(l.of(3).is_none() && l.of(4).is_none());
    }

    /// The gap between siblings is even and runs along no outer edge;
    /// the levels take their own gaps, the last for those below.
    #[test]
    fn gaps_run_between_siblings_only() {
        let t = tree(
            &["g", "h", "a", "b", "c", "d"],
            &["", "", "g", "g", "h", "h"],
            &[0.0, 0.0, 5.0, 3.0, 4.0, 2.0],
        );
        let mut o = options(201.0, 101.0);
        o.padding_inner = vec![3.0, 1.0];
        let l = layout(&t, &o);
        let (g, h) = (*l.of(0).unwrap(), *l.of(1).unwrap());
        // The two groups fill the box but for the gap between them.
        let edges = [
            g.x0.min(h.x0),
            g.y0.min(h.y0),
            g.x1.max(h.x1),
            g.y1.max(h.y1),
        ];
        assert_eq!(edges, [0.0, 0.0, 201.0, 101.0]);
        let gap = (h.x0 - g.x1)
            .max(h.y0 - g.y1)
            .max(g.x0 - h.x1)
            .max(g.y0 - h.y1);
        assert_eq!(gap, 3.0);
        // The leaves of `g` fill it but for a gap of 1 between them.
        let (a, b) = (*l.of(2).unwrap(), *l.of(3).unwrap());
        let gap = (b.x0 - a.x1).max(b.y0 - a.y1);
        assert_eq!(gap, 1.0);
        assert_eq!(
            [
                a.x0.min(b.x0),
                a.y0.min(b.y0),
                a.x1.max(b.x1),
                a.y1.max(b.y1)
            ],
            [g.x0, g.y0, g.x1, g.y1]
        );
        // Every corner on a whole point.
        for n in &l.nodes {
            for v in [n.x0, n.y0, n.x1, n.y1] {
                assert_eq!(v, v.round());
            }
        }
        // In pre-order, each group before its children.
        assert_eq!(l.nodes[0].last, 2);
        assert_eq!(l.children(0).count(), 2);
    }

    /// The band at the top of a level's groups goes on all of them or
    /// none: a group too small for it takes it from its siblings.
    #[test]
    fn bands_go_on_all_siblings_or_none() {
        let ids = ["g", "h", "a", "b", "c"];
        let parents = ["", "", "g", "g", "h"];
        let mut o = options(400.0, 200.0);
        o.padding_top = vec![20.0];
        let l = layout(&tree(&ids, &parents, &[0.0, 0.0, 30.0, 30.0, 40.0]), &o);
        let (g, h) = (*l.of(0).unwrap(), *l.of(1).unwrap());
        assert_eq!((g.header, h.header), (20.0, 20.0));
        // The children start below the band.
        assert!(l.of(2).unwrap().y0 >= g.y0 + 20.0);
        // `h` is too narrow for it: no band on either.
        let l = layout(&tree(&ids, &parents, &[0.0, 0.0, 60.0, 60.0, 1.0]), &o);
        assert_eq!(
            (l.of(0).unwrap().header, l.of(1).unwrap().header),
            (0.0, 0.0)
        );
    }

    /// The pointer finds the leaf under it, across a gap the nearest one
    /// in the same group, and the group in its band.
    #[test]
    fn the_pointer_finds_leaves_and_bands() {
        let t = tree(&["g", "a", "b"], &["", "g", "g"], &[0.0, 1.0, 1.0]);
        let mut o = options(100.0, 100.0);
        o.padding_inner = vec![0.0, 4.0];
        o.padding_top = vec![20.0];
        let l = layout(&t, &o);
        let (a, b) = (*l.of(1).unwrap(), *l.of(2).unwrap());
        assert_eq!(l.at(10.0, 10.0, 0.0), Some(0));
        let (ax, ay) = a.center();
        assert_eq!(l.at(ax, ay, 0.0), Some(1));
        // In the gap between `a` and `b`, nearer `b`.
        let (gx, gy) = match b.x0 > a.x1 {
            true => (a.x1 + 3.0, ay),
            false => (ax, a.y1 + 3.0),
        };
        assert_eq!(l.at(gx, gy, 0.0), Some(2));
        assert_eq!(l.at(150.0, 50.0, 0.0), None);
        // Past the edge, within reach: the group, its content out of reach.
        assert_eq!(l.at(103.0, 50.0, 4.0), Some(0));
    }

    /// One node fills the box; a box with no area lays out nothing.
    #[test]
    fn a_single_node_fills_the_box() {
        let t = tree(&["only"], &[""], &[7.0]);
        let l = layout(&t, &options(120.0, 80.0));
        assert_eq!(l.nodes.len(), 1);
        assert_eq!(l.of(0).map(|n| (n.x1, n.y1)), Some((120.0, 80.0)));
        assert!(layout(&t, &options(0.0, 80.0)).nodes.is_empty());
    }
}
