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

use nsh_core::Matrix;
use objc2_foundation::NSRect;
use rustc_hash::FxHashMap;

/// A rectangle as `(x0, y0, x1, y1)`.
pub(crate) type Span = (f32, f32, f32, f32);

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

/// What can be seen of a view's content space (the space its children's
/// frames are in).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Sight {
    /// Nothing: it is hidden, out of a window or clipped away.
    Hidden,
    /// Everything: no ancestor clips it.
    All,
    /// What is within this rectangle.
    Within(Span),
}

/// What can be seen of a view's content space, from `outer`, what can be
/// seen of its parent's: `frame` is its placed frame (in the parent's
/// content space), `origin` the point its content shows from (a scroll
/// view's offset, (0, 0) otherwise), `transform` its layer transform about
/// the frame's top left, and `clips` whether it clips its
/// children. An ancestor that does not clip only moves what can be seen
/// into its own space: what overflows it shows, as in CSS.
pub(crate) fn inner(
    outer: Sight,
    frame: Span,
    origin: (f32, f32),
    clips: bool,
    transform: Option<Matrix>,
) -> Sight {
    let (ox, oy) = origin;
    let moved = match outer {
        Sight::Hidden => return Sight::Hidden,
        Sight::All => None,
        Sight::Within(r) => {
            let local = (r.0 - frame.0, r.1 - frame.1, r.2 - frame.0, r.3 - frame.1);
            let local = match transform {
                None => Some(local),
                Some(m) => untransform(local, &m),
            };
            local.map(|r| (r.0 + ox, r.1 + oy, r.2 + ox, r.3 + oy))
        }
    };
    if !clips {
        return moved.map_or(Sight::All, Sight::Within);
    }
    let own = (ox, oy, ox + frame.2 - frame.0, oy + frame.3 - frame.1);
    match moved {
        None => within(own),
        Some(r) => within((
            r.0.max(own.0),
            r.1.max(own.1),
            r.2.min(own.2),
            r.3.min(own.3),
        )),
    }
}

/// Enclose the inverse image of the visible rectangle. Rotation and skew
/// can draw early in the corners of this box, never defer visible content.
/// For depth, perspective or singular transforms, keep the ancestor's own
/// clip but do not narrow it by an unsafe inverse projection.
fn untransform(r: Span, m: &Matrix) -> Option<Span> {
    if !m.is_2d() {
        return None;
    }
    let m = &m.0;
    let det = m[0] * m[5] - m[1] * m[4];
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let mut bounds = (
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    );
    for (x, y) in [(r.0, r.1), (r.2, r.1), (r.0, r.3), (r.2, r.3)] {
        let (x, y) = (x as f64 - m[12], y as f64 - m[13]);
        let (x, y) = (
            ((x * m[5] - y * m[4]) / det) as f32,
            ((y * m[0] - x * m[1]) / det) as f32,
        );
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        bounds = (
            bounds.0.min(x),
            bounds.1.min(y),
            bounds.2.max(x),
            bounds.3.max(y),
        );
    }
    Some(bounds)
}

/// `r` if it is not empty.
fn within(r: Span) -> Sight {
    if r.2 <= r.0 || r.3 <= r.1 {
        Sight::Hidden
    } else {
        Sight::Within(r)
    }
}

/// Whether any of `rect` (in the content space `sight` is of) can be seen.
pub(crate) fn admits(sight: Sight, rect: Span) -> bool {
    match sight {
        Sight::Hidden => false,
        Sight::All => true,
        Sight::Within(r) => rect.2.min(r.2) > rect.0.max(r.0) && rect.3.min(r.3) > rect.1.max(r.1),
    }
}

/// What a visibility check reads of a view tree.
pub(crate) trait Tree {
    /// A view.
    type Node;

    /// Identifies `node` for the length of a pass.
    fn key(&self, node: &Self::Node) -> usize;

    /// Its parent view, if it has one.
    fn parent(&self, node: &Self::Node) -> Option<Self::Node>;

    /// Whether it is hidden itself.
    fn hidden(&self, node: &Self::Node) -> bool;

    /// For a view with no parent view: whether it is in a window and
    /// neither it nor anything above it is hidden.
    fn top_shown(&self, node: &Self::Node) -> bool;

    /// Its placed frame, in its parent's content space.
    fn frame(&self, node: &Self::Node) -> Span;

    /// Its layer transform about the placed frame's top left.
    fn transform(&self, node: &Self::Node) -> Option<Matrix>;

    /// The point its content shows from and whether it clips its
    /// children.
    fn content(&self, node: &Self::Node) -> ((f32, f32), bool);
}

/// The ancestors resolved in one pass: each one's [`Sight`], shared by
/// every view under it. Cleared ([`Sights::clear`]) before anything moves:
/// keys only identify views while they live and stay put.
pub(crate) struct Sights<N> {
    known: FxHashMap<usize, Sight>,
    /// The chain being resolved (kept for its allocation).
    chain: Vec<N>,
}

impl<N> Default for Sights<N> {
    fn default() -> Self {
        Sights {
            known: FxHashMap::default(),
            chain: Vec::new(),
        }
    }
}

impl<N> Sights<N> {
    /// Forgets what was resolved (keeps the allocations).
    pub(crate) fn clear(&mut self) {
        self.known.clear();
        self.chain.clear();
    }

    /// Whether any of `node` can be seen: in a window, not hidden, and not
    /// entirely clipped away by its ancestors that clip (the top one, the
    /// root, always does: the window shows only it).
    pub(crate) fn shows<T: Tree<Node = N>>(&mut self, tree: &T, node: &N) -> bool {
        match tree.parent(node) {
            None => tree.top_shown(node),
            Some(parent) => match self.sight(tree, parent) {
                Sight::Hidden => false,
                sight => {
                    if tree.hidden(node) {
                        return false;
                    }
                    let frame = tree.frame(node);
                    match tree.transform(node) {
                        None => admits(sight, frame),
                        transform => {
                            // Clip the inverse-mapped sight to the local box:
                            // a nonempty box conservatively admits the frame.
                            inner(sight, frame, (0.0, 0.0), true, transform) != Sight::Hidden
                        }
                    }
                }
            },
        }
    }

    /// What can be seen of `node`'s content space: walks up only to the
    /// first ancestor already resolved in this pass (or the first hidden
    /// one: nothing under it shows), then resolves the views it passed,
    /// outermost first.
    fn sight<T: Tree<Node = N>>(&mut self, tree: &T, node: N) -> Sight {
        let mut chain = std::mem::take(&mut self.chain);
        let mut at = node;
        let mut outer = loop {
            if let Some(&sight) = self.known.get(&tree.key(&at)) {
                break sight;
            }
            let parent = tree.parent(&at);
            let shown = match parent {
                Some(_) => !tree.hidden(&at),
                None => tree.top_shown(&at),
            };
            chain.push(at);
            match parent {
                _ if !shown => break Sight::Hidden,
                Some(p) => at = p,
                // The top's own clip (the root's) is applied below.
                None => break Sight::All,
            }
        };
        while let Some(view) = chain.pop() {
            if outer != Sight::Hidden {
                let (origin, clips) = tree.content(&view);
                outer = inner(
                    outer,
                    tree.frame(&view),
                    origin,
                    clips,
                    tree.transform(&view),
                );
            }
            self.known.insert(tree.key(&view), outer);
        }
        self.chain = chain;
        outer
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    /// The reference: `rect` (in its parent's content space) moved up
    /// through `ancestors`, innermost first, clipped by each that clips.
    fn clip_shows(
        rect: Span,
        ancestors: impl IntoIterator<Item = (Span, (f32, f32), bool)>,
    ) -> bool {
        let (mut x0, mut y0, mut x1, mut y1) = rect;
        for (frame, (ox, oy), clips) in ancestors {
            if clips {
                let (w, h) = (frame.2 - frame.0, frame.3 - frame.1);
                x0 = x0.max(ox);
                y0 = y0.max(oy);
                x1 = x1.min(ox + w);
                y1 = y1.min(oy + h);
                if x1 <= x0 || y1 <= y0 {
                    return false;
                }
            }
            x0 += frame.0 - ox;
            x1 += frame.0 - ox;
            y0 += frame.1 - oy;
            y1 += frame.1 - oy;
        }
        true
    }

    /// The same through [`inner`] and [`admits`], outermost first, as a
    /// pass resolves it; checked against the reference.
    fn sees(rect: Span, ancestors: &[(Span, (f32, f32), bool)]) -> bool {
        let sight = ancestors
            .iter()
            .rev()
            .fold(Sight::All, |outer, &(frame, origin, clips)| {
                inner(outer, frame, origin, clips, None)
            });
        let shows = admits(sight, rect);
        assert_eq!(
            shows,
            clip_shows(rect, ancestors.iter().copied()),
            "{rect:?} in {ancestors:?}"
        );
        shows
    }

    #[test]
    fn a_row_shows_through_the_scroll_offset() {
        let screen = ((0.0, 0.0, 400.0, 800.0), (0.0, 0.0), true);
        let row = (0.0, 0.0, 400.0, 40.0);
        let list = |y| ((0.0, 0.0, 400.0, 600.0), (0.0, y), true);
        assert!(sees(row, &[list(0.0), screen]));
        assert!(!sees(row, &[list(1000.0), screen]));
        // Touching the viewport's edge is out of sight.
        assert!(!sees((0.0, 600.0, 400.0, 640.0), &[list(0.0), screen]));
        assert!(sees((0.0, 599.0, 400.0, 640.0), &[list(0.0), screen]));
    }

    #[test]
    fn a_text_in_a_pinned_sticky_header_shows() {
        // The header's logical frame is at the top of the content; scrolled
        // 1000 points, it is placed (shifted) at 1000, where the list shows.
        let text = (8.0, 8.0, 200.0, 32.0);
        let header = ((0.0, 1000.0, 400.0, 1040.0), (0.0, 0.0), false);
        let list = ((0.0, 0.0, 400.0, 600.0), (0.0, 1000.0), true);
        assert!(sees(text, &[header, list]));
        let logical = ((0.0, 0.0, 400.0, 40.0), (0.0, 0.0), false);
        assert!(!sees(text, &[logical, list]));
    }

    #[test]
    fn a_text_in_a_mirrored_cell_shows() {
        // A 400-point mirrored list scrolled 500 points: its bounds origin is
        // -500, and the cell at logical x 600 is placed at 400 - 600 - 90.
        let text = (10.0, 10.0, 80.0, 70.0);
        let list = ((0.0, 0.0, 400.0, 80.0), (-500.0, 0.0), true);
        let cell = ((-290.0, 0.0, -200.0, 80.0), (0.0, 0.0), false);
        assert!(sees(text, &[cell, list]));
        let logical = ((600.0, 0.0, 690.0, 80.0), (0.0, 0.0), false);
        assert!(!sees(text, &[logical, list]));
    }

    #[test]
    fn a_text_overflowing_an_ancestor_that_does_not_clip_shows() {
        // A label centered on a zero-width anchor (`position: absolute`,
        // `width: 0`): its box overflows the anchor on both sides, as in
        // CSS, and shows, unless an ancestor clips it away.
        let text = (4.0, 4.0, 40.0, 20.0);
        let label = ((-22.0, 0.0, 22.0, 24.0), (0.0, 0.0), false);
        let anchor = |clips| ((50.0, 0.0, 50.0, 24.0), (0.0, 0.0), clips);
        let row = ((16.0, 60.0, 316.0, 120.0), (0.0, 0.0), false);
        let screen = ((0.0, 0.0, 400.0, 800.0), (0.0, 0.0), true);
        assert!(sees(text, &[label, anchor(false), row, screen]));
        // `overflow: hidden` on the anchor still clips it away.
        assert!(!sees(text, &[label, anchor(true), row, screen]));
        // Moved out of the window, it no longer shows.
        let below = ((16.0, 900.0, 316.0, 960.0), (0.0, 0.0), false);
        assert!(!sees(text, &[label, anchor(false), below, screen]));
    }

    #[test]
    fn nested_clips_and_offsets_agree_with_the_reference() {
        let screen = ((0.0, 0.0, 400.0, 800.0), (0.0, 0.0), true);
        let outer = |y| ((0.0, 100.0, 400.0, 700.0), (0.0, y), true);
        let card = |x| ((x, 20.0, x + 200.0, 220.0), (0.0, 0.0), true);
        let strip = |x| ((0.0, 0.0, 200.0, 200.0), (x, 0.0), true);
        for &y in &[0.0, 150.0, 500.0, 2000.0] {
            for &cx in &[-250.0, -100.0, 0.0, 150.0, 399.0, 400.0] {
                for &sx in &[0.0, 120.0, 900.0] {
                    for &rect in &[
                        (0.0, 0.0, 100.0, 50.0),
                        (950.0, 10.0, 1010.0, 30.0),
                        (-10.0, -10.0, 0.0, 0.0),
                        (30.0, 30.0, 30.0, 60.0),
                    ] {
                        sees(rect, &[strip(sx), card(cx), outer(y), screen]);
                        sees(rect, &[card(cx), outer(y), screen]);
                    }
                }
            }
        }
    }

    /// A view tree for the passes: `parent`, frame, origin, clips and
    /// hidden per view; counts what the pass reads.
    #[derive(Default)]
    struct Fake {
        parent: Vec<Option<usize>>,
        frame: Vec<Span>,
        transform: Vec<Option<Matrix>>,
        origin: Vec<(f32, f32)>,
        clips: Vec<bool>,
        hidden: Vec<bool>,
        top_shown: bool,
        reads: Cell<usize>,
    }

    impl Fake {
        fn add(
            &mut self,
            parent: Option<usize>,
            frame: Span,
            origin: (f32, f32),
            clips: bool,
        ) -> usize {
            self.parent.push(parent);
            self.frame.push(frame);
            self.transform.push(None);
            self.origin.push(origin);
            self.clips.push(clips);
            self.hidden.push(false);
            self.parent.len() - 1
        }

        /// Its ancestors, innermost first, as the reference takes them.
        fn ancestors(&self, node: usize) -> Vec<(Span, (f32, f32), bool)> {
            std::iter::successors(self.parent[node], |&p| self.parent[p])
                .map(|p| (self.frame[p], self.origin[p], self.clips[p]))
                .collect()
        }
    }

    impl Tree for Fake {
        type Node = usize;

        fn key(&self, node: &usize) -> usize {
            *node
        }

        fn parent(&self, node: &usize) -> Option<usize> {
            self.parent[*node]
        }

        fn hidden(&self, node: &usize) -> bool {
            self.hidden[*node]
        }

        fn top_shown(&self, node: &usize) -> bool {
            self.top_shown && !self.hidden[*node]
        }

        fn frame(&self, node: &usize) -> Span {
            self.reads.set(self.reads.get() + 1);
            self.frame[*node]
        }

        fn content(&self, node: &usize) -> ((f32, f32), bool) {
            (self.origin[*node], self.clips[*node])
        }

        fn transform(&self, node: &usize) -> Option<Matrix> {
            self.transform[*node]
        }
    }

    #[test]
    fn transformed_views_and_their_children_keep_culling() {
        let mut t = Fake {
            top_shown: true,
            ..Fake::default()
        };
        let root = t.add(None, (0.0, 0.0, 400.0, 200.0), (0.0, 0.0), true);
        let scaled = t.add(Some(root), (0.0, 0.0, 500.0, 250.0), (0.0, 0.0), false);
        t.transform[scaled] = Some(Matrix::of(nsh_core::TransformKind::Scale, 0.8));
        let label = t.add(Some(scaled), (420.0, 40.0, 500.0, 64.0), (0.0, 0.0), false);
        let clipped = t.add(Some(scaled), (520.0, 40.0, 600.0, 64.0), (0.0, 0.0), false);
        let mut sights = Sights::default();
        assert!(sights.shows(&t, &label));
        assert!(!sights.shows(&t, &clipped));
        // A transform on the leaf itself matters as well.
        t.transform[clipped] = Some(Matrix::of(nsh_core::TransformKind::TranslateX, -100.0));
        assert!(Sights::default().shows(&t, &clipped));
        // Reflection about x=500, with a nonzero scroll origin.
        t.transform[scaled] = Some(
            Matrix::of(nsh_core::TransformKind::ScaleX, -1.0)
                .mul(&Matrix::of(nsh_core::TransformKind::TranslateX, 500.0)),
        );
        t.origin[scaled] = (100.0, 0.0);
        assert!(Sights::default().shows(&t, &label));
        t.origin[scaled] = (1000.0, 0.0);
        assert!(!Sights::default().shows(&t, &label));
    }

    #[test]
    fn rotation_keeps_visible_content_and_distant_content_deferred() {
        let outer = Sight::Within((0.0, 0.0, 400.0, 200.0));
        let m = Matrix::of(nsh_core::TransformKind::Rotate, 90.0)
            .mul(&Matrix::of(nsh_core::TransformKind::TranslateX, 400.0));
        let sight = inner(outer, (0.0, 0.0, 500.0, 500.0), (0.0, 0.0), false, Some(m));
        assert!(!admits(sight, (40.0, 420.0, 64.0, 500.0)));
        assert!(admits(sight, (40.0, 320.0, 64.0, 400.0)));
        assert!(!admits(sight, (240.0, 40.0, 264.0, 80.0)));
        let m = Matrix::of(nsh_core::TransformKind::Rotate, 30.0);
        let sight = inner(outer, (0.0, 0.0, 500.0, 500.0), (0.0, 0.0), false, Some(m));
        // (450, -100) rotates to about (440, 138), outside the window.
        assert!(!admits(sight, (450.0, -100.0, 460.0, -90.0)));
        // (420, -120) rotates to about (424, 106). This is inside the
        // conservative box, so it may draw early, but not be culled late.
        assert!(admits(sight, (420.0, -120.0, 430.0, -110.0)));
        assert!(admits(sight, (300.0, -80.0, 310.0, -70.0)));
        // Unsafe inverse projections remain conservative, not invisible.
        let perspective = Matrix::of(nsh_core::TransformKind::Perspective, 500.0);
        assert_eq!(
            inner(
                outer,
                (0.0, 0.0, 500.0, 500.0),
                (0.0, 0.0),
                false,
                Some(perspective)
            ),
            Sight::All
        );
    }

    /// A screen, a list scrolled `offset` points and `rows` rows of 40
    /// points, each with a text.
    fn list(rows: usize, offset: f32) -> (Fake, Vec<usize>) {
        let mut t = Fake {
            top_shown: true,
            ..Fake::default()
        };
        let root = t.add(None, (0.0, 0.0, 400.0, 800.0), (0.0, 0.0), true);
        let page = t.add(Some(root), (0.0, 0.0, 400.0, 800.0), (0.0, 0.0), false);
        let list = t.add(Some(page), (0.0, 100.0, 400.0, 700.0), (0.0, offset), true);
        let texts = (0..rows)
            .map(|i| {
                let y = i as f32 * 40.0;
                let row = t.add(Some(list), (0.0, y, 400.0, y + 40.0), (0.0, 0.0), false);
                t.add(Some(row), (8.0, 8.0, 200.0, 32.0), (0.0, 0.0), false)
            })
            .collect();
        (t, texts)
    }

    #[test]
    fn a_pass_resolves_each_ancestor_once() {
        let (t, texts) = list(1000, 2000.0);
        let mut sights = Sights::default();
        let shown: Vec<usize> = texts
            .iter()
            .enumerate()
            .filter(|&(_, text)| sights.shows(&t, text))
            .map(|(i, _)| i)
            .collect();
        // Rows 50 to 64 are in the 600-point viewport from 2000.
        assert_eq!(shown, (50..65).collect::<Vec<_>>());
        // Each text and each distinct ancestor (1000 rows, the list, the
        // page, the root) read once.
        assert_eq!(t.reads.get(), 1000 + 1000 + 3);
        for &text in &texts {
            assert_eq!(
                Sights::default().shows(&t, &text),
                clip_shows(t.frame[text], t.ancestors(text))
            );
        }
    }

    #[test]
    fn hidden_views_hide_what_is_under_them() {
        let (mut t, texts) = list(3, 0.0);
        assert!(Sights::default().shows(&t, &texts[0]));
        // A row hidden: its text does not show, its siblings' do.
        let row = t.parent[texts[0]].unwrap();
        t.hidden[row] = true;
        let mut sights = Sights::default();
        assert!(!sights.shows(&t, &texts[0]));
        assert!(sights.shows(&t, &texts[1]));
        // The text itself hidden.
        t.hidden[row] = false;
        t.hidden[texts[2]] = true;
        assert!(!Sights::default().shows(&t, &texts[2]));
        // The list hidden: nothing under it shows, and the pass stops
        // there.
        let list = t.parent[row].unwrap();
        t.hidden[list] = true;
        let mut sights = Sights::default();
        assert!(texts.iter().all(|text| !sights.shows(&t, text)));
        // Out of a window: nothing shows, the root included.
        t.hidden[list] = false;
        t.top_shown = false;
        let mut sights = Sights::default();
        assert!(texts.iter().all(|text| !sights.shows(&t, text)));
        assert!(!sights.shows(&t, &0));
    }

    #[test]
    fn the_top_alone_shows_when_in_a_window() {
        let (t, _) = list(0, 0.0);
        assert!(Sights::default().shows(&t, &0));
    }

    #[test]
    fn moves_count() {
        let before = moves();
        moved();
        assert_ne!(moves(), before);
    }
}
