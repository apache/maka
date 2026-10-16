//! Rendering only the rows of a `uniform_list` or `list` its layer lacks (M6).
//!
//! A virtual list renders only the rows it shows. Its layer holds more: the
//! rows its viewport shows and two viewports' worth of rows on each side
//! (the overscan), each painted into the layer at its place in content
//! space and kept there by row. On a frame that only scrolled the list the
//! rows the layer holds are neither rendered, laid out, prepainted nor
//! painted: only the rows the scroll brought into the overscan are, and
//! those whose hover changed, and are added to the layer, whose tiles over
//! them become dirty (spec §8). Any other frame paints the rows afresh, as
//! a div's layer is.
//!
//! Each row the layer holds keeps what it handed the frame besides what it
//! drew: where its prepaint and paint records (hitboxes, listeners, element
//! states, dispatch nodes) lie in the frame last drawn, the element states
//! rendering and laying it out used, which lie before those, its hitboxes
//! as painted and the hovers it was painted by. A frame that keeps the row
//! carries those records into itself, its hitboxes moved by the scroll
//! since the row was painted, as [`crate::fast::layers::reuse`] carries a
//! div's content; a row whose hovers changed is rendered again, alone.
//!
//! The layer's content is one part per row (see
//! [`crate::fast::layers::scene::LayerContent`]), in the order of the rows,
//! and each row's tiles are hashed once, when it is painted: a frame adding
//! or changing rows hands the renderer the other rows as they were and
//! combines the hashes of the tiles they reach. Rows that left the overscan
//! are dropped a batch at a time (see [`retained_rows`]).
//!
//! The list elements call in here from a few hooks:
//!
//! - `uniform_list`: [`measure_item`], [`snap_item_offset`],
//!   [`begin_uniform_list`], [`render_rows`], [`row_indices`],
//!   [`prepaint_row`] and [`end_rows`] where it prepaints its rows;
//!   [`begin_paint_rows`], [`paint_row`] and [`end_paint_rows`] where it
//!   paints them.
//! - `list`: [`begin_list`], [`keeps_row`], [`snap_item_origin`],
//!   [`place_list_item`] and [`end_list`] where it lays out and prepaints
//!   its rows; [`begin_paint_list`], [`paint_row`] and [`end_paint_list`]
//!   where it paints them. A `list` has no element id: its layer is known by
//!   the id of the elements around it and its state.
//!
//! Between a list's prepaint and its paint, what the frame does with its
//! rows lives in its layer's [`LayerRows`]. While its rows prepaint and
//! paint, `WindowLayers::painting` is set, as for a div's layer, so that
//! nested views and scroll containers are painted into the layer.

use crate::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, ElementId, EntityId, GlobalElementId,
    Hitbox, HitboxId, PaintIndex, Pixels, Point, PrepaintStateIndex, Rgba, ScaledPixels, Scene,
    Size, TextStyle, TileCoord, Window,
    fast::{
        dependencies::{DependencyRecording, RenderDependencies, StateVersion},
        layers::{
            COMPILED, active, input, invalidate,
            paint::{self, Painting},
            policy::{self, Decision},
            record::LayerRecord,
            reuse,
            scene::{LayerContent, LayerPart, move_primitive},
            tiles::{combine_tile_hashes, dirty_tiles, part_tile_hashes},
        },
    },
    point, px,
    scene::{PaintOperation, Primitive},
    size,
};
use collections::FxHashMap;
use smallvec::SmallVec;
use std::{
    any::TypeId,
    collections::{BTreeMap, BTreeSet},
    mem,
    ops::Range,
    rc::Rc,
};

/// Whether virtual lists get scroll layers.
pub(crate) const LIST_LAYERS: bool = true;

/// Whether a virtual list may use its layer this frame: layers are active,
/// and accessibility is not, as a list's layer holds rows its viewport
/// does not show, which would be in the accessibility tree.
fn list_layers_active(window: &Window, cx: &App) -> bool {
    active(window, cx) && !window.a11y.is_active()
}

/// The rows of a list's layer, and what the frame being drawn does with
/// them.
#[derive(Default)]
pub(crate) struct LayerRows {
    /// Whether the layer is a list's, which a scroll extends by the rows it
    /// uncovers instead of painting it again.
    pub(crate) list: bool,
    /// Whether the layer is a `list`'s, whose rows the view holding it may
    /// render again without the layer being painted afresh (see
    /// [`LayerRows::rerendered`]).
    pub(crate) repaints_shown_rows: bool,
    /// How many rows frames that kept the rows the layer held added to it
    /// since its rows were last painted afresh. What the rows read is kept
    /// for the whole layer, not by row, so it only grows on those frames:
    /// past [`REPAINT_AFTER_ADDED`] times the rows the layer is to hold, the
    /// rows are painted afresh.
    added_since_repaint: usize,
    /// The rows the layer holds, by index.
    rows: BTreeMap<usize, Row>,
    /// A uniform list's measured item, as last measured.
    measured: Option<Measured>,
    /// The layer's translation in the last frame that drew its rows.
    last_translation: Option<Point<ScaledPixels>>,
    /// The rows the list showed in the last frame that drew it, and that
    /// frame: the rows whose element states it kept alive, as a list
    /// without a layer does. See [`sort_rows`].
    visible: Option<(u64, Range<usize>)>,
    /// What the frame being drawn does with the list's rows, from its
    /// prepaint to its paint.
    frame: Option<RowsFrame>,
    /// Whether the frame being drawn composites a `list`'s layer though the
    /// view holding the list renders again, handing it a row renderer that
    /// may render any row otherwise: the list renders the rows it shows
    /// again, and the rows the layer holds besides are rendered again before
    /// they show (see [`Row::suspect`]).
    pub(crate) rerendered: bool,
    /// How many items a `list` had when it was last laid out, and whether
    /// it has as many in the frame being drawn.
    item_count: Option<usize>,
    pub(crate) items_changed: bool,
}

impl LayerRows {
    /// Ends the frame being drawn.
    pub(crate) fn finish_frame(&mut self) {
        self.frame = None;
    }

    fn clear(&mut self) {
        self.rows.clear();
        self.added_since_repaint = 0;
        self.last_translation = None;
    }

    /// Whether the rows the layer holds, `needed` of them from now on, are
    /// to be painted afresh for having added too many rows since they last
    /// were (see [`LayerRows::added_since_repaint`]).
    fn due_for_repaint(&self, needed: &Range<usize>) -> bool {
        self.added_since_repaint > needed.len().max(1) * REPAINT_AFTER_ADDED
    }

    /// The rows the layer holds.
    #[cfg(test)]
    pub(crate) fn held(&self) -> impl Iterator<Item = usize> + '_ {
        self.rows.keys().copied()
    }

    /// The layout keys of each row the layer holds, those it keeps the
    /// nodes of while it holds the row.
    #[cfg(test)]
    pub(crate) fn held_layout_keys(&self) -> impl Iterator<Item = (usize, &[u64])> + '_ {
        self.rows
            .iter()
            .map(|(row, held)| (*row, held.layout_keys.as_slice()))
    }

    /// How many element states rendering and laying out each row the layer
    /// holds used outside its prepaint, which it keeps with the row.
    #[cfg(test)]
    pub(crate) fn held_layout_states(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.rows
            .iter()
            .map(|(row, held)| (*row, held.layout_states.len()))
    }

    /// Moves the prepaint ranges of the rows the layer holds with `shift`,
    /// as the frame being drawn copies their records from the last one.
    pub(crate) fn follow_prepaint(
        &mut self,
        shift: &dyn Fn(&Range<PrepaintStateIndex>) -> Range<PrepaintStateIndex>,
        node: &dyn Fn(crate::DispatchNodeId) -> Option<crate::DispatchNodeId>,
    ) {
        for row in self.rows.values_mut() {
            row.prepaint = shift(&row.prepaint);
            for hitbox in &mut row.hitboxes {
                hitbox.dispatch_node = hitbox.dispatch_node.and_then(node);
            }
        }
    }

    /// Moves the paint ranges of the rows the layer holds with `shift`, as
    /// [`LayerRows::follow_prepaint`] moves their prepaint ranges.
    pub(crate) fn follow_paint(&mut self, shift: &dyn Fn(&Range<PaintIndex>) -> Range<PaintIndex>) {
        for row in self.rows.values_mut() {
            row.paint = shift(&row.paint);
        }
    }

    /// Whether a row the layer holds inserted the hitbox `id`.
    pub(crate) fn holds_hitbox(&self, id: HitboxId) -> bool {
        self.rows
            .values()
            .any(|row| row.hitboxes.iter().any(|hitbox| hitbox.id == id))
    }
}

/// How many times the rows a list's layer is to hold its frames that keep
/// rows may add before its rows are painted afresh.
const REPAINT_AFTER_ADDED: usize = 4;

#[cfg(test)]
thread_local! {
    static EXTENDED_FRAMES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static RENDERED_FOR_HOVER: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many frames on this thread composited a list's layer keeping the
/// rows it held.
#[cfg(test)]
pub(crate) fn extended_frames() -> usize {
    EXTENDED_FRAMES.with(|frames| frames.get())
}

/// How many rows a list's layer held that frames on this thread rendered
/// again because their hovers changed.
#[cfg(test)]
pub(crate) fn rows_rendered_for_hover() -> usize {
    RENDERED_FOR_HOVER.with(|rows| rows.get())
}

/// Counts a frame that composited a list's layer keeping the rows it held,
/// rendering `for_hover` of them again because their hovers changed.
fn count_extended_frame(for_hover: usize) {
    #[cfg(test)]
    {
        EXTENDED_FRAMES.with(|frames| frames.set(frames.get() + 1));
        RENDERED_FOR_HOVER.with(|rows| rows.set(rows.get() + for_hover));
    }
    let _ = for_hover;
}

/// A row as the layer holds it.
struct Row {
    /// The row's slot, as wide as the viewport, in content space.
    slot: Bounds<ScaledPixels>,
    /// What painting the row drew, in content space.
    part: LayerPart,
    /// The hash of what the row draws over each tile it reaches.
    tile_hashes: Vec<(TileCoord, u64)>,
    /// What the row drew that its tiles cannot hold, in content space, in
    /// drawing order: its paths and what it drew over them
    /// (`fast::layers::overlay`), drawn over the tiles.
    overlay: Rc<[Primitive]>,
    /// Everything the row drew, the overlay included, when it has one: what
    /// drawing the row into the frame draws.
    whole: Option<Rc<Scene>>,
    /// The layer's translation when the row was painted: its hitboxes, and
    /// the positions its closures and element states hold, are window
    /// positions at it.
    translation: Point<ScaledPixels>,
    /// The hitboxes the row inserted, as inserted, their masks clipped by
    /// the row's own clips but not by the viewport.
    hitboxes: Vec<Hitbox>,
    /// The hovers the row was painted by.
    hovers: Vec<(HitboxId, bool)>,
    /// What prepainting the row added to the frame last drawn.
    prepaint: Range<PrepaintStateIndex>,
    /// What painting the row added to the frame last drawn, the scene aside.
    paint: Range<PaintIndex>,
    /// Whether the row keeps element states.
    has_states: bool,
    /// The keys of the layout nodes laying the row out claimed: kept while
    /// the row is, so that rendering it again reuses them.
    layout_keys: Vec<u64>,
    /// The element states rendering and laying the row out used, which lie
    /// outside its prepaint records: kept while the row keeps its element
    /// states, as the list keeps them while it renders the row.
    layout_states: Vec<(GlobalElementId, TypeId)>,
    /// The entities laying the row out, prepainting and painting it read,
    /// as of when it was rendered: when one of them changes, the row is
    /// rendered again, alone (see [`changed_rows`]). What the list read
    /// besides is the layer's record's.
    dependencies: RenderDependencies,
    /// The views drawn in the row, which it is rendered again for when one
    /// is notified.
    views: Rc<[EntityId]>,
    /// Whether the row was held, but not rendered, through a frame its
    /// list's view rendered again in (see [`LayerRows::rerendered`]): it is
    /// rendered again before it shows.
    suspect: bool,
    /// Whether the row's element states were dropped, as a list without a
    /// layer drops them when the row leaves its viewport: the row is
    /// rendered afresh before it shows again. See [`sort_rows`].
    dropped: bool,
}

impl Row {
    /// How far the row's records lag behind where it shows with the layer's
    /// content moved by `translation`, in logical pixels.
    fn delta(&self, translation: Point<ScaledPixels>, scale_factor: f32) -> Point<Pixels> {
        point(
            px((translation.x.0 - self.translation.x.0) / scale_factor),
            px((translation.y.0 - self.translation.y.0) / scale_factor),
        )
    }
}

/// A uniform list's measured item, and what it was measured with besides
/// the item itself.
struct Measured {
    size: Size<Pixels>,
    rem_size: Pixels,
    text_style: TextStyle,
}

/// The rows a list renders into its layer this frame.
pub(crate) struct RowPlan {
    /// The rows to render, prepaint and paint into the layer, in order.
    pub(crate) render: Vec<Range<usize>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    /// The rows are painted afresh.
    Repaint,
    /// The rows the layer holds stay; those it lacks are added.
    Extend,
}

/// What the frame being drawn does with a list's rows.
struct RowsFrame {
    mode: Mode,
    /// For a `list`, its state, to tell its hooks from a nested list's.
    list: Option<usize>,
    /// Whether the list leaves out the rows the layer holds when it lays
    /// out the rows it shows.
    skip_held: bool,
    /// The rows the layer is to hold after the frame, at least.
    needed: Range<usize>,
    /// The rows the layer may hold after the frame; those it holds outside
    /// are dropped.
    retain: Range<usize>,
    /// The rows the layer holds that are rendered again: their hovers
    /// changed, or what they read did, or they show again after their
    /// element states were dropped.
    stale: BTreeSet<usize>,
    /// The rows the layer holds that read something that changed since
    /// they were rendered. See [`changed_rows`].
    changed: BTreeSet<usize>,
    /// The rows the list shows this frame.
    visible: Range<usize>,
    /// The rows the list showed last frame and no longer does, whose
    /// element states the frame drops. See [`sort_rows`].
    leaving: BTreeSet<usize>,
    /// The rows the layer holds whose records the frame carries, in order.
    carried: Vec<usize>,
    /// Where each row painted into the layer this frame lies, in window
    /// space.
    slots: BTreeMap<usize, Bounds<Pixels>>,
    /// The list's clip rect, in window space.
    viewport: Bounds<Pixels>,
    /// The part of the content the frame paints, in window space: the
    /// viewport and the rows around it.
    painted_region: Bounds<Pixels>,
    /// The offset the rows are painted at, snapped.
    scroll_offset: Point<Pixels>,
    /// How far the layer's content is moved into window space this frame.
    translation: Point<ScaledPixels>,
    prepaint_start: PrepaintStateIndex,
    prepaint_range: Range<PrepaintStateIndex>,
    /// The recording of what rendering and prepainting the rows reads.
    recording: Option<DependencyRecording>,
    dependencies: RenderDependencies,
    /// What prepainting each row painted into the layer added to the frame.
    row_prepaints: Vec<RowPrepaint>,
    /// The row being prepainted, where it began, how many hitbox masks
    /// the layer had noted then, where the log of the entities read was and
    /// how many writes had been made.
    open_row: Option<(usize, PrepaintStateIndex, usize, usize, u64)>,
    /// Where the log of the entities read stood when the recording of what
    /// the rows read began, and where in it the reads of the rows the layer
    /// keeps were told again. See [`finish_prepaint`].
    reads_start: usize,
    replayed: Range<usize>,
    /// Where the recording of the layout keys the rows claim began, and
    /// where the last row prepainted ended in it.
    layout_keys: Option<(usize, usize)>,
    /// The rows laid out outside any row's prepaint. A `list` lays out the
    /// rows it shows before it prepaints the first of them, and the layer
    /// lays out a row before it prepaints it. See [`note_row_layout`].
    row_layouts: Vec<RowLayout>,
    /// A uniform list's rows in the order it paints them, and how many it
    /// painted.
    order: Vec<usize>,
    next: usize,
    /// A `list`'s first row shown and where it lies, as it prepaints its rows.
    anchor: Option<(usize, Point<Pixels>)>,
    /// The rows a `list` prepainted itself.
    prepainted: Vec<usize>,
    /// The rows rendered and prepainted here for a `list`, painted after its
    /// own.
    extra: Vec<(usize, AnyElement)>,
    paint: Option<PaintState>,
}

/// A row laid out outside any row's prepaint: where in the recording of the
/// layout keys the rows claim the keys laying it out claimed lie, and where
/// in the log of the entities read what it read does.
struct RowLayout {
    row: usize,
    keys: Range<usize>,
    reads: Range<usize>,
    /// The writes laying the row out made: the row's own. See
    /// [`crate::fast::dependencies::Writes`].
    writes: (u64, u64),
    /// The element states rendering the row, when the list rendered it just
    /// before, and laying it out used.
    states: Vec<(GlobalElementId, TypeId)>,
}

/// What prepainting a row added to the frame, and the masks of its hitboxes
/// before they were clipped to the viewport.
struct RowPrepaint {
    row: usize,
    range: Range<PrepaintStateIndex>,
    masks: Vec<ContentMask<Pixels>>,
    /// The layout keys claimed since the row before it was prepainted: those
    /// laying it out claimed.
    layout_keys: Vec<u64>,
    /// The element states rendering and laying the row out used outside its
    /// prepaint. See [`RowLayout::states`].
    layout_states: Vec<(GlobalElementId, TypeId)>,
    /// Where in the log of the entities read what laying the row out and
    /// prepainting it read lies, and, once the prepaint ends, those
    /// entities.
    reads: Vec<Range<usize>>,
    entities: Rc<[EntityId]>,
    /// The writes laying out and prepainting the row made: the row's own.
    writes: Vec<(u64, u64)>,
}

/// A list's rows being painted.
struct PaintState {
    /// The opaque colour under the viewport, if there is one; the rows are
    /// painted into the frame otherwise.
    background: Option<Rgba>,
    /// Whether rows are painted into the layer's scene, which the frame's is
    /// then swapped out for.
    swapped: bool,
    /// The frame's scene, swapped out for the layer's.
    scene: Scene,
    /// Where the rows' paint records begin in the frame, those carried
    /// included.
    records_start: PaintIndex,
    recording: Option<DependencyRecording>,
    /// Where the log of the entities read stood when `recording` began.
    reads_start: usize,
    /// The row being painted.
    current: Option<usize>,
    /// What each row painted into the layer's scene.
    spans: Vec<RowPaint>,
}

/// What painting a row into the layer drew and added to the frame.
struct RowPaint {
    row: usize,
    /// The row's operations in the layer's scene.
    operations: Range<usize>,
    paint: Range<PaintIndex>,
    hovers: Vec<(HitboxId, bool)>,
    /// Where in the log of the entities read what painting the row read
    /// lies.
    reads: Range<usize>,
    /// The writes painting the row made: the row's own.
    writes: (u64, u64),
}

/// What a `uniform_list` does with its rows this frame: nothing new, or
/// render the plan's rows into its layer.
pub(crate) struct Rows(Option<RowPlan>);

/// The rows `visible` and `overscan` rows on each side, of `item_count`.
fn needed_rows(visible: &Range<usize>, overscan: usize, item_count: usize) -> Range<usize> {
    visible.start.saturating_sub(overscan).min(item_count)..(visible.end + overscan).min(item_count)
}

/// How many viewports of rows a frame keeping a list's rows may render, the
/// rows it shows that the layer lacks and those it adds to the overscan
/// together.
///
/// A list drawn without a layer renders the viewport's rows every frame: a
/// frame growing the overscan renders three quarters of that, most of it on
/// the side the list scrolls toward (see [`ahead`]), and costs no more than
/// drawing the list directly with the layer's upkeep (see
/// [`crate::fast::layers::work`]); a frame whose shown rows alone cost that
/// adds no overscan. A scroll faster than the overscan grows, as a scrollbar's thumb
/// dragged, renders on each frame the rows it shows, as the list does
/// without its layer, instead of the whole overscan around them.
///
/// The frame promoting the layer paints the whole overscan, which the frames
/// compositing it pay back. A frame painting it afresh for a change of its
/// content, which costs more than drawing the rows directly (see
/// [`crate::fast::layers::work::REPAINT_COST`]), paints only the rows the
/// list shows, as the list does without a layer, and the frames keeping the
/// rows after it grow the overscan back: a view holding the list that is
/// notified now and then, as a chat transcript is when it reaches its end,
/// does not render five viewports of rows each time.
const RENDER_PER_FRAME_VIEWPORTS: f32 = 0.75;

/// The rows of `limit`, around and including `visible`, that a uniform
/// list's layer is to hold after a frame keeping the rows of `unrendered`:
/// those it keeps cost nothing (the rows between the first it keeps and the
/// last are taken for kept), and it renders at most
/// [`RENDER_PER_FRAME_VIEWPORTS`] of a viewport's rows, those it shows
/// first, growing the overscan on the side the list scrolls toward (see
/// [`ahead`]).
fn grown_rows(
    unrendered: &BTreeSet<usize>,
    visible: &Range<usize>,
    limit: Range<usize>,
    toward_end: Option<bool>,
) -> Range<usize> {
    let kept = match (unrendered.first(), unrendered.last()) {
        (Some(first), Some(last)) => *first..*last + 1,
        _ => 0..0,
    };
    let shown_kept = visible
        .end
        .min(kept.end)
        .saturating_sub(visible.start.max(kept.start));
    let shown_missing = visible.len() - shown_kept;
    let allowed = (visible.len() as f32 * RENDER_PER_FRAME_VIEWPORTS) as usize;
    let budget = allowed.saturating_sub(shown_missing);
    let (mut start, mut end) = (visible.start.max(limit.start), visible.end.min(limit.end));
    if kept.contains(&end) {
        end = kept.end.min(limit.end);
    }
    if start > 0 && kept.contains(&(start - 1)) {
        start = kept.start.max(limit.start);
    }
    let (share, _) = ahead(toward_end);
    let below = ((budget as f32 * share).round() as usize).min(budget);
    let above = (budget - below).min(start - limit.start);
    let below = below.min(limit.end - end);
    start - above..end + below
}

/// Whether a list's content, moved by `last` into window space in the last
/// frame that drew its rows and by `now` in this one, scrolls toward its
/// end (`Some(true)`), toward its start, or neither.
fn scrolls_toward_end(last: Option<Point<ScaledPixels>>, now: Point<ScaledPixels>) -> Option<bool> {
    let moved = now.y.0 - last?.y.0;
    (moved != 0.).then_some(moved < 0.)
}

/// The shares of a frame's budget for rows that the side toward the list's
/// end and the side toward its start get, when it scrolls toward its end
/// (`toward_end` is `Some(true)`), toward its start, or neither: most for
/// the rows the scroll brings, ahead of it, and some for those behind it,
/// which show again when the scroll turns back.
fn ahead(toward_end: Option<bool>) -> (f32, f32) {
    match toward_end {
        Some(true) => (0.75, 0.25),
        Some(false) => (0.25, 0.75),
        None => (0.5, 0.5),
    }
}

/// The rows of `needed` that `held` lacks, in runs.
fn plan(held: &BTreeSet<usize>, needed: Range<usize>) -> RowPlan {
    let mut render: Vec<Range<usize>> = Vec::new();
    for row in needed {
        if !held.contains(&row) {
            match render.last_mut() {
                Some(run) if run.end == row => run.end = row + 1,
                _ => render.push(row..row + 1),
            }
        }
    }
    RowPlan { render }
}

/// The rows a list's layer may hold after a frame that needs `needed`,
/// holding `held`: the rows it holds past `needed` are dropped a batch at a
/// time, once they are more than a quarter of `needed`, and kept until
/// then. Dropping a row changes every tile it reached, which is rasterized
/// again; dropping rows one a frame would rasterize a tile a frame for
/// nothing.
fn retained_rows(held: &BTreeSet<usize>, needed: &Range<usize>) -> Range<usize> {
    let (Some(first), Some(last)) = (held.first(), held.last()) else {
        return needed.clone();
    };
    let outside = held.iter().filter(|row| !needed.contains(row)).count();
    if outside > (needed.len() / 4).max(1) {
        needed.clone()
    } else {
        (*first).min(needed.start)..(*last + 1).max(needed.end)
    }
}

/// What a frame showing the rows `visible` of a list does with the rows its
/// layer `layer` holds, keeping them (`mode` is [`Mode::Extend`]) or not.
///
/// A list without a layer renders only the rows it shows, and the element
/// states of a row it no longer shows (a nested scroll offset, a hover
/// state) are dropped with the frame. Rows a layer holds are rendered before
/// they show and kept after, so that their element states would outlive
/// that; instead, a row leaving the viewport (`leaving`) is neither rendered
/// nor keeps its element states that frame, and is rendered afresh before
/// it shows again (see [`Row::dropped`]).
struct RowSort {
    /// The rows rendered again (see [`RowsFrame::stale`]).
    stale: BTreeSet<usize>,
    /// The rows not rendered: those the layer keeps, or, painted afresh,
    /// those leaving the viewport.
    unrendered: BTreeSet<usize>,
    leaving: BTreeSet<usize>,
}

fn sort_rows(
    window: &Window,
    layer: &crate::fast::layers::Layer,
    mode: Mode,
    translation: Point<ScaledPixels>,
    viewport: Bounds<Pixels>,
    visible: &Range<usize>,
    changed: &BTreeSet<usize>,
) -> RowSort {
    let rows = &layer.rows;
    // A row the layer holds without element states has none to drop.
    let leaving: BTreeSet<usize> = match &rows.visible {
        Some((_, before)) => before
            .clone()
            .filter(|ix| !visible.contains(ix))
            .filter(|ix| rows.rows.get(ix).is_none_or(|row| row.has_states))
            .collect(),
        None => BTreeSet::new(),
    };
    match mode {
        Mode::Repaint => RowSort {
            stale: BTreeSet::new(),
            unrendered: leaving.clone(),
            leaving,
        },
        Mode::Extend => {
            // Only a row the list shows shows its hover; one it does not is
            // checked again before it shows.
            let mut stale = stale_rows(window, layer, translation, viewport);
            stale.retain(|row| visible.contains(row) && !leaving.contains(row));
            stale.extend(
                rows.rows
                    .range(visible.clone())
                    .filter(|(_, row)| row.dropped || row.suspect)
                    .map(|(ix, _)| *ix),
            );
            // A row whose reads changed is rendered again wherever it lies,
            // but for one leaving the viewport, which is not rendered this
            // frame: it is, once it no longer is leaving.
            stale.extend(changed.iter().filter(|row| !leaving.contains(row)));
            let unrendered = rows
                .rows
                .keys()
                .copied()
                .filter(|row| !stale.contains(row))
                .chain(leaving.iter().copied())
                .collect();
            RowSort {
                stale,
                unrendered,
                leaving,
            }
        }
    }
}

/// The rows the layer `layer` holds whose hovers will have changed when the
/// frame being drawn paints, with the layer's content moved by
/// `translation` and clipped to `viewport`: they are rendered again.
///
/// A frame hit tests the pointer against its own hitboxes between its
/// prepaint and its paint, and elements paint their hover styles by that.
/// Which rows to render again is decided before, as the rows prepaint: the
/// hit test is foretold from the last frame's hitboxes, those of the rows
/// moved to where they show now. Hitboxes outside the list are taken to stay
/// where they were; [`check_hovers`] catches a row whose hover the foretelling
/// missed.
fn stale_rows(
    window: &Window,
    layer: &crate::fast::layers::Layer,
    translation: Point<ScaledPixels>,
    viewport: Bounds<Pixels>,
) -> BTreeSet<usize> {
    let rows = &layer.rows.rows;
    if rows.values().all(|row| row.hovers.is_empty()) {
        return BTreeSet::new();
    }
    let Some(record) = layer.record.as_ref() else {
        return rows.keys().copied().collect();
    };
    let range = &record.prepaint_range;
    let rows_at = range.start.hitboxes_index..range.end.hitboxes_index;
    let hit = foretold_hit_test(window, rows, rows_at, translation, viewport);
    let hovered = |id: HitboxId| {
        window.captured_hitbox == Some(id) || (!window.last_input_was_keyboard() && hit.hovers(id))
    };
    rows.iter()
        .filter(|(_, row)| row.hovers.iter().any(|(id, was)| hovered(*id) != *was))
        .map(|(ix, _)| *ix)
        .collect()
}

/// A hit test of the pointer, as [`crate::Frame::hit_test`] does it: the
/// hitboxes under it, topmost first, and how many of them are hovered.
#[derive(Default)]
struct ForetoldHitTest {
    ids: SmallVec<[HitboxId; 8]>,
    hover_count: Option<usize>,
    blocked: bool,
}

impl ForetoldHitTest {
    /// Takes in `hitbox`, the next one down.
    fn visit(&mut self, hitbox: &Hitbox, position: Point<Pixels>) {
        if self.blocked {
            return;
        }
        let bounds = hitbox.bounds.intersect(&hitbox.content_mask.bounds);
        if bounds.contains(&position) {
            self.ids.push(hitbox.id);
            if self.hover_count.is_none()
                && hitbox.behavior == crate::HitboxBehavior::BlockMouseExceptScroll
            {
                self.hover_count = Some(self.ids.len());
            }
            if hitbox.behavior == crate::HitboxBehavior::BlockMouse {
                self.blocked = true;
            }
        }
    }

    fn hovers(&self, id: HitboxId) -> bool {
        let count = self.hover_count.unwrap_or(self.ids.len());
        self.ids[..count].contains(&id)
    }
}

/// The hit test of the pointer the frame being drawn will make: the last
/// frame's hitboxes, those at `rows_at`, which the rows of `rows` inserted,
/// replaced by the rows' hitboxes moved to where the rows show with the
/// layer's content moved by `translation`, and clipped to `viewport`.
fn foretold_hit_test(
    window: &Window,
    rows: &BTreeMap<usize, Row>,
    rows_at: Range<usize>,
    translation: Point<ScaledPixels>,
    viewport: Bounds<Pixels>,
) -> ForetoldHitTest {
    if crate::fast::layers::hover_freeze::frozen(window) {
        return ForetoldHitTest::default();
    }
    let position = window.mouse_position;
    let scale_factor = window.scale_factor();
    let hitboxes = &window.rendered_frame.hitboxes;
    let rows_at = rows_at.start.min(hitboxes.len())..rows_at.end.min(hitboxes.len());
    let mut hit = ForetoldHitTest::default();
    for hitbox in hitboxes[rows_at.end..].iter().rev() {
        hit.visit(hitbox, position);
    }
    for row in rows.values().rev() {
        let delta = row.delta(translation, scale_factor);
        for hitbox in input::LayerInput::hitboxes_at(&row.hitboxes, delta, viewport)
            .collect::<SmallVec<[Hitbox; 4]>>()
            .iter()
            .rev()
        {
            hit.visit(hitbox, position);
        }
    }
    for hitbox in hitboxes[..rows_at.start].iter().rev() {
        hit.visit(hitbox, position);
    }
    hit
}

/// The size of a uniform list's measured item: `measure`d, unless the
/// frame only scrolls the list's layer, whose content, the measured item
/// included, is then as it was (spec §8).
pub(crate) fn measure_item(
    window: &mut Window,
    cx: &mut App,
    id: Option<&GlobalElementId>,
    measure: impl FnOnce(&mut Window, &mut App) -> Size<Pixels>,
) -> Size<Pixels> {
    if !LIST_LAYERS {
        return measure(window, cx);
    }
    if !COMPILED || window.fast_layers.layers.is_empty() {
        return measure(window, cx);
    }
    let Some(id) = id else {
        return measure(window, cx);
    };
    if let Some(size) = kept_item_size(window, cx, id) {
        return size;
    }
    let size = measure(window, cx);
    let rem_size = window.rem_size();
    let text_style = window.text_style();
    if let Some(layer) = window.fast_layers.layers.get_mut(id) {
        layer.rows.measured = Some(Measured {
            size,
            rem_size,
            text_style,
        });
    }
    size
}

/// The measured item's size as the layer of the list `id` keeps it, if the
/// frame only scrolls the layer.
fn kept_item_size(window: &Window, cx: &App, id: &GlobalElementId) -> Option<Size<Pixels>> {
    if paint::inside_layer(window) || !list_layers_active(window, cx) {
        return None;
    }
    let layer = window.fast_layers.layers.get(id)?;
    let record = layer.record.as_ref()?;
    let measured = layer.rows.measured.as_ref()?;
    if !layer.rows.list
        || measured.rem_size != window.rem_size()
        || measured.text_style != window.text_style()
    {
        return None;
    }
    #[cfg(any(test, feature = "test-support"))]
    if let Some(decision) = window.fast_layers.forced_decision {
        return (decision == Decision::Composite).then_some(measured.size);
    }
    invalidate::scroll_only(window, cx, id, record).then_some(measured.size)
}

/// `scroll_offset`, a uniform list's offset about to place its rows, moved
/// to whole device pixels where layers are compiled, so that rows painted
/// into a layer and rows drawn without one land on the same pixels. See
/// [`paint::snap_scroll_offset`].
pub(crate) fn snap_item_offset(window: &Window, scroll_offset: Point<Pixels>) -> Point<Pixels> {
    if !LIST_LAYERS {
        return scroll_offset;
    }
    paint::snap_scroll_offset(window, scroll_offset)
}

/// Decides what the uniform list `id` does with its rows this frame, and
/// sets up rendering and prepainting them. The list's rows are
/// `item_height` tall, `item_count` of them from the top of
/// `padded_bounds`, scrolled by `scroll_offset`; it shows the rows
/// `visible`. A list flipped vertically keeps today's path.
#[allow(clippy::too_many_arguments)]
pub(crate) fn begin_uniform_list(
    window: &mut Window,
    cx: &mut App,
    id: Option<&GlobalElementId>,
    padded_bounds: Bounds<Pixels>,
    scroll_offset: Point<Pixels>,
    item_height: Pixels,
    item_count: usize,
    visible: &Range<usize>,
    y_flipped: bool,
) -> Rows {
    if !COMPILED || !LIST_LAYERS || y_flipped || item_height <= Pixels::ZERO {
        return Rows(None);
    }
    let Some(id) = id else {
        return Rows(None);
    };
    if paint::inside_layer(window) || !list_layers_active(window, cx) {
        return Rows(None);
    }
    let viewport = window.content_mask().bounds;
    let content_size = size(padded_bounds.size.width, item_height * item_count);
    let decision = policy::decide(window, cx, id, padded_bounds, content_size, scroll_offset);
    let decision = input::decide(window, id, decision);
    if decision == Decision::Bypass {
        let frame = window.fast_layers.frame;
        if let Some(layer) = window.fast_layers.layers.get_mut(id) {
            layer.rows.visible = Some((frame, visible.clone()));
        }
        return Rows(None);
    }
    let overscan = (viewport.size.height * paint::OVERSCAN_VIEWPORTS / item_height)
        .ceil()
        .max(1.) as usize;
    let needed = needed_rows(visible, overscan, item_count);
    let layer = paint::layer_mut(window, id);
    let promoting = layer.record.is_none();
    let extends = decision == Decision::Composite
        && layer.rows.list
        && !layer.rows.due_for_repaint(&needed)
        && layer
            .record
            .as_ref()
            .is_some_and(|record| record.scroll_offset.x == scroll_offset.x);
    let mode = if extends { Mode::Extend } else { Mode::Repaint };
    let changed = match mode {
        Mode::Extend => changed_rows(window, cx, id),
        Mode::Repaint => BTreeSet::new(),
    };

    let translation = paint::translation(window, scroll_offset);
    let RowSort {
        stale,
        unrendered,
        leaving,
    } = sort_rows(
        window,
        &window.fast_layers.layers[id],
        mode,
        translation,
        viewport,
        visible,
        &changed,
    );
    let needed = match mode {
        Mode::Extend => grown_rows(
            &unrendered,
            visible,
            needed,
            scrolls_toward_end(
                window.fast_layers.layers[id].rows.last_translation,
                translation,
            ),
        ),
        // Promoted, the layer is painted over the whole overscan, which the
        // frames compositing it pay back; painted afresh while it only
        // scrolls, for having added too many rows, too, as the scroll goes
        // on. Painted afresh for a change of its content, it is painted over
        // the rows the list shows, as the list is drawn without it.
        Mode::Repaint if promoting || decision == Decision::Composite => needed,
        Mode::Repaint => visible.start.max(needed.start)..visible.end.min(needed.end),
    };
    let (retain, carried) = match mode {
        Mode::Extend => {
            let retain = retained_rows(&unrendered, &needed);
            let carried = unrendered.range(retain.clone()).copied().collect();
            (retain, carried)
        }
        Mode::Repaint => (needed.clone(), Vec::new()),
    };
    let plan = plan(&unrendered, needed.clone());
    let slot = |row: usize| Bounds {
        origin: point(
            viewport.origin.x,
            padded_bounds.origin.y + scroll_offset.y + item_height * row,
        ),
        size: size(viewport.size.width, item_height),
    };
    let slots: BTreeMap<usize, Bounds<Pixels>> = plan
        .render
        .iter()
        .flat_map(|run| run.clone())
        .map(|row| (row, slot(row)))
        .collect();
    let mut painted_region = viewport;
    if !needed.is_empty() {
        painted_region = painted_region
            .union(&slot(needed.start))
            .union(&slot(needed.end - 1));
    }
    let order = slots.keys().copied().collect();
    let frame = RowsFrame {
        mode,
        list: None,
        skip_held: false,
        needed,
        retain,
        stale,
        changed,
        visible: visible.clone(),
        leaving,
        carried,
        slots,
        viewport,
        painted_region,
        scroll_offset,
        translation,
        prepaint_start: window.prepaint_index(),
        prepaint_range: window.prepaint_index()..window.prepaint_index(),
        recording: Some(cx.begin_recording_dependencies()),
        dependencies: RenderDependencies::default(),
        row_prepaints: Vec::new(),
        open_row: None,
        reads_start: reads_len(),
        replayed: 0..0,
        layout_keys: Some(record_layout_keys(window)),
        row_layouts: Vec::new(),
        order,
        next: 0,
        anchor: None,
        prepainted: Vec::new(),
        extra: Vec::new(),
        paint: None,
    };
    window.fast_layers.painting = Some(marker(id, &frame));
    paint::layer_mut(window, id).rows.frame = Some(frame);
    if mode == Mode::Extend {
        keep_reads(window, cx, id);
        carry_prepaint_rows(window, id);
    }
    Rows(Some(plan))
}

/// What the rows of a list that `frame` draws are prepainted and painted
/// in, in place of the list's own clip: the list's width, and as far above
/// and below as a row could ever be held.
///
/// A row's masks (its hitboxes', its primitives') are kept with it, moved
/// with the scroll, for as long as the layer holds it. The rows are painted
/// in their own space so that no edge of what they were painted in comes to
/// clip them once they have moved; the viewport clips them where they are
/// composited, as the list's own clip does without a layer. Only the rows
/// the layer is to hold are rendered, so nothing more is drawn for it.
fn rows_region(frame: &RowsFrame) -> Bounds<Pixels> {
    const REACH: Pixels = px(1_000_000.);
    let region = frame.painted_region.union(&frame.viewport);
    Bounds::from_corners(
        point(region.left(), region.top() - REACH),
        point(region.right(), region.bottom() + REACH),
    )
}

/// Tells the window that what the rows held by the layer of the list `id`
/// read is read again this frame, which renders them not: so that the
/// window stays told of their changes, a row view's notifications included,
/// as it is on today's path, where the list renders the rows it shows every
/// frame.
fn keep_reads(window: &mut Window, cx: &mut App, id: &GlobalElementId) {
    let Some(record) = window
        .fast_layers
        .layers
        .get(id)
        .and_then(|layer| layer.record.as_ref())
    else {
        return;
    };
    cx.replay_dependencies(&record.dependencies);
    // What the rows read, and the views drawn in them, told apart from what
    // the list does: the rows keep it themselves.
    let start = reads_len();
    cx.entities.extend_accessed(record.views.iter());
    for row in window.fast_layers.layers[id].rows.rows.values() {
        cx.replay_dependencies(&row.dependencies);
    }
    let end = reads_len();
    if let Some(frame) = frame_mut(window, id) {
        frame.replayed = start..end;
    }
}

thread_local! {
    /// The row a `list` rendered last, where in the log of the entities read
    /// what rendering it read starts, and where in the frame's element
    /// states those it used start. See [`spanned_render_item`].
    static RENDERED_ROW: std::cell::Cell<Option<(usize, usize, usize)>> =
        const { std::cell::Cell::new(None) };
}

/// A `list`'s row renderer `render_item`, noting where what rendering each
/// row reads and the element states it uses start: a list lays a row out
/// right after rendering it, and what rendering it read and used is the
/// row's, as what laying it out read and used is (see [`note_row_layout`]).
pub(crate) fn spanned_render_item(
    mut render_item: impl FnMut(usize, &mut Window, &mut App) -> AnyElement + 'static,
) -> Box<crate::RenderItemFn> {
    Box::new(move |ix, window, cx| {
        // A row reading what the row before it read last notes it too.
        cx.entities.mark_access_boundary();
        let start = reads_len();
        let states = window.next_frame.accessed_element_states.len();
        let element = render_item(ix, window, cx);
        RENDERED_ROW.set(Some((ix, start, states)));
        element
    })
}

/// How long the log of the entities read while a recording is open is.
fn reads_len() -> usize {
    crate::fast::dependencies::read_log_lengths().map_or(0, |(entities, _, _)| entities)
}

/// The rows the layer of the list `id` holds that read something that
/// changed since they were rendered, as the layer's record would be found
/// changed for it (see [`invalidate::scroll_only`]), or in which a view
/// drawn was notified. They are rendered again, alone, on a frame that
/// otherwise keeps the rows the layer holds.
///
/// What the `render` of the view holding the list wrote this frame is not a
/// change of a row. Its render is judged by what it read itself, as the row
/// renderer it hands the list is (see [`invalidate::owner_rerendered_only`]):
/// rendered again for nothing it read changing, it wrote what it wrote when
/// the rows were rendered, as a sidebar writes the items its rows show into
/// a model they read on every render; rendered again for a change, the rows
/// are rendered again before they show, or painted afresh.
fn changed_rows(window: &Window, cx: &App, id: &GlobalElementId) -> BTreeSet<usize> {
    let Some(layer) = window.fast_layers.layers.get(id) else {
        return BTreeSet::new();
    };
    let source = window.fast_layers.scrolls.source(id);
    let owner_writes = invalidate::owner_view(window)
        .and_then(|owner| window.retained_state.render_writes.get(&owner))
        .filter(|writes| !writes.is_empty());
    layer
        .rows
        .rows
        .iter()
        .filter(|(_, row)| {
            let masked;
            let dependencies = match owner_writes {
                Some(writes) => {
                    masked = row.dependencies.with_own_writes(writes.start, writes.end);
                    &masked
                }
                None => &row.dependencies,
            };
            invalidate::changed(window, cx, dependencies, source.as_ref())
                || invalidate::views_notified(window, &row.views)
        })
        .map(|(ix, _)| *ix)
        .collect()
}

/// Whether the view `view` is drawn in a row the layer of the list `id`
/// holds: a notification of it changes that row, not the rest of what the
/// layer holds.
pub(crate) fn held_row_view(window: &Window, id: &GlobalElementId, view: EntityId) -> bool {
    window.fast_layers.layers.get(id).is_some_and(|layer| {
        layer
            .rows
            .rows
            .values()
            .any(|row| row.views.contains(&view))
    })
}

/// Carries into the frame being drawn the prepaint records of the rows the
/// layer of the list `id` keeps this frame, where prepainting them would add
/// them, their hitboxes moved by the scroll since each was painted.
fn carry_prepaint_rows(window: &mut Window, id: &GlobalElementId) {
    let scale_factor = window.scale_factor();
    let Some(layer) = window.fast_layers.layers.get_mut(id) else {
        return;
    };
    let Some(frame) = layer.rows.frame.as_ref() else {
        return;
    };
    let carried = frame.carried.clone();
    let leaving = frame.leaving.clone();
    let (translation, viewport) = (frame.translation, frame.viewport);
    // A tooltip shows where its element was when it was requested; a scroll
    // hides tooltips (spec §7, rule 5).
    let tooltips = layer.rows.last_translation == Some(translation);
    let mut rows = mem::take(&mut layer.rows.rows);
    for ix in &carried {
        let Some(row) = rows.get_mut(ix) else {
            continue;
        };
        let delta = row.delta(translation, scale_factor);
        let element_states = !row.dropped && !leaving.contains(ix);
        window.keep_retained_layout(&row.layout_keys);
        if element_states {
            // Those rendering and laying the row out used, which its
            // prepaint records do not hold: a text view's parsed document,
            // say, without which the row is laid out anew at another height.
            window
                .next_frame
                .accessed_element_states
                .extend(row.layout_states.iter().cloned());
        }
        row.prepaint = reuse::carry_prepaint_records(
            window,
            &row.prepaint,
            &mut row.hitboxes,
            None,
            delta,
            viewport,
            tooltips,
            element_states,
        );
    }
    // Keeping the rows' layout nodes logged their keys: they are not the
    // next row's.
    let log_end = window.record_claimed_layout_keys();
    window.finish_recording_claimed_layout_keys(log_end);
    if let Some(layer) = window.fast_layers.layers.get_mut(id) {
        layer.rows.rows = rows;
        if let Some((_, mark)) = layer
            .rows
            .frame
            .as_mut()
            .and_then(|frame| frame.layout_keys.as_mut())
        {
            *mark = log_end;
        }
    }
}

/// Carries into the frame being drawn the paint records of the rows whose
/// prepaint records [`carry_prepaint_rows`] carried.
fn carry_paint_rows(window: &mut Window, id: &GlobalElementId) {
    let scale_factor = window.scale_factor();
    let Some(layer) = window.fast_layers.layers.get_mut(id) else {
        return;
    };
    let Some(frame) = layer.rows.frame.as_ref() else {
        return;
    };
    if frame.carried.is_empty() {
        return;
    }
    let carried = frame.carried.clone();
    let leaving = frame.leaving.clone();
    let (translation, viewport) = (frame.translation, frame.viewport);
    let mut rows = mem::take(&mut layer.rows.rows);
    for ix in &carried {
        let Some(row) = rows.get_mut(ix) else {
            continue;
        };
        let delta = row.delta(translation, scale_factor);
        let element_states = !row.dropped && !leaving.contains(ix);
        row.paint = reuse::carry_paint_records(window, &row.paint, delta, viewport, element_states);
    }
    if let Some(layer) = window.fast_layers.layers.get_mut(id) {
        layer.rows.rows = rows;
    }
}

/// What marks the rows of the list `id` as painting into its layer, for
/// nested views and scroll containers to tell.
fn marker(id: &GlobalElementId, frame: &RowsFrame) -> Painting {
    Painting {
        id: id.clone(),
        viewport: frame.viewport,
        painted_region: frame.painted_region,
        scene: Scene::default(),
        scroll_offset: frame.scroll_offset,
        translation: frame.translation,
        prepaint_range: frame.prepaint_start.clone()..frame.prepaint_start.clone(),
        recording: None,
        dependencies: RenderDependencies::default(),
        input: input::PaintingInput {
            list_region: Some(rows_region(frame)),
            ..Default::default()
        },
        view_layouts: FxHashMap::default(),
        a11y: None,
    }
}

/// Renders the rows a uniform list renders this frame with `render`: those
/// it shows, `visible`, on today's path, and the rows its layer lacks
/// otherwise, in order.
pub(crate) fn render_rows(
    rows: &Rows,
    visible: Range<usize>,
    mut render: impl FnMut(Range<usize>) -> SmallVec<[AnyElement; 64]>,
) -> SmallVec<[AnyElement; 64]> {
    let Some(plan) = &rows.0 else {
        return render(visible);
    };
    let mut items = SmallVec::new();
    for run in &plan.render {
        items.extend(render(run.clone()));
    }
    items
}

/// The indices of the rows [`render_rows`] rendered, in order.
pub(crate) fn row_indices(rows: &Rows, visible: Range<usize>) -> RowIndices {
    match &rows.0 {
        None => RowIndices::Visible(visible),
        Some(plan) => RowIndices::Planned(
            plan.render
                .iter()
                .flat_map(|run| run.clone())
                .collect::<Vec<_>>()
                .into_iter(),
        ),
    }
}

/// See [`row_indices`].
pub(crate) enum RowIndices {
    Visible(Range<usize>),
    Planned(std::vec::IntoIter<usize>),
}

impl Iterator for RowIndices {
    type Item = usize;

    fn next(&mut self) -> Option<usize> {
        match self {
            RowIndices::Visible(range) => range.next(),
            RowIndices::Planned(rows) => rows.next(),
        }
    }
}

/// Prepaints a uniform list's row `ix` with `f`, noting what prepainting it
/// adds to the frame when it is painted into the list's layer.
pub(crate) fn prepaint_row<R>(
    window: &mut Window,
    cx: &mut App,
    ix: usize,
    f: impl FnOnce(&mut Window, &mut App) -> R,
) -> R {
    if !LIST_LAYERS || window.fast_layers.painting.is_none() {
        return f(window, cx);
    }
    let began = begin_row(window, None, ix);
    let result = f(window, cx);
    if began {
        end_row(window, None);
    }
    result
}

/// The frame of the list whose rows are prepainting into its layer, if it
/// is a `list` whose state has id `list`, or a uniform list for `None`.
fn prepainting_frame(window: &mut Window, list: Option<usize>) -> Option<&mut RowsFrame> {
    let id = window.fast_layers.painting.as_ref()?.id.clone();
    frame_mut(window, &id).filter(|frame| frame.list == list && frame.paint.is_none())
}

/// Notes that the row `ix` of the list whose rows are prepainting, a `list`
/// whose state has id `list` or a uniform list for `None`, begins to
/// prepaint. Returns whether it was noted: a row of a list nested in a row
/// is not.
fn begin_row(window: &mut Window, list: Option<usize>, ix: usize) -> bool {
    let start = window.prepaint_index();
    let masks = window
        .fast_layers
        .painting
        .as_ref()
        .map_or(0, |painting| painting.input.hitbox_masks.len());
    let Some(frame) = prepainting_frame(window, list) else {
        return false;
    };
    if frame.open_row.is_some() {
        return false;
    }
    frame.open_row = Some((
        ix,
        start,
        masks,
        reads_len(),
        crate::fast::dependencies::write_generation_now(),
    ));
    true
}

/// Notes that the row [`begin_row`] noted is prepainted.
fn end_row(window: &mut Window, list: Option<usize>) {
    let end = window.prepaint_index();
    let Some(painting) = window.fast_layers.painting.as_ref() else {
        return;
    };
    let all_masks = &painting.input.hitbox_masks;
    let id = painting.id.clone();
    let Some(frame) = window
        .fast_layers
        .layers
        .get_mut(&id)
        .and_then(|layer| layer.rows.frame.as_mut())
        .filter(|frame| frame.list == list)
    else {
        return;
    };
    let Some((row, start, masks_start, reads_start, writes_start)) = frame.open_row.take() else {
        return;
    };
    let masks = all_masks
        .get(masks_start..)
        .map(<[_]>::to_vec)
        .unwrap_or_default();
    let engine = window.layout_engine.as_ref().unwrap();
    let layout_keys = match frame.layout_keys.as_mut() {
        Some((_, mark)) => {
            // The keys claimed since the row before it, but for those laying
            // out other rows claimed, and those laying it out claimed.
            let log = engine.claimed_keys_since(0);
            let row_layouts = &frame.row_layouts;
            let others = |at: usize| {
                row_layouts
                    .iter()
                    .any(|layout| layout.row != row && layout.keys.contains(&at))
            };
            let mut keys: Vec<u64> = (*mark..log.len())
                .filter(|at| !others(*at))
                .map(|at| log[at])
                .collect();
            if let Some(layout) = row_layouts.iter().rev().find(|layout| layout.row == row) {
                // Those it claimed since the row before it are taken above.
                let before = layout.keys.start..layout.keys.end.min(*mark);
                keys.extend_from_slice(log.get(before).unwrap_or_default());
            }
            *mark = log.len();
            keys
        }
        None => Vec::new(),
    };
    let mut reads: Vec<Range<usize>> = frame
        .row_layouts
        .iter()
        .filter(|layout| layout.row == row)
        .map(|layout| layout.reads.clone())
        .collect();
    reads.push(reads_start..reads_len());
    let mut writes: Vec<(u64, u64)> = frame
        .row_layouts
        .iter()
        .filter(|layout| layout.row == row)
        .map(|layout| layout.writes)
        .collect();
    writes.push((
        writes_start,
        crate::fast::dependencies::write_generation_now(),
    ));
    // A row laid out more than once this frame used its states each time.
    let mut seen = collections::FxHashSet::default();
    let layout_states = frame
        .row_layouts
        .iter()
        .filter(|layout| layout.row == row)
        .flat_map(|layout| layout.states.iter())
        .filter(|state| seen.insert(*state))
        .cloned()
        .collect();
    frame.row_prepaints.push(RowPrepaint {
        row,
        range: start..end,
        masks,
        layout_keys,
        layout_states,
        reads,
        entities: Rc::from([]),
        writes,
    });
}

/// Where what laying out a row adds to the frame and the logs starts, as
/// [`row_layout_start`] notes it.
pub(crate) struct RowLayoutStart {
    /// Where the layout keys it claims start in the recording of them.
    keys: usize,
    /// Where what it reads starts in the log of the entities read.
    reads: usize,
    /// How many writes had been made.
    writes: u64,
    /// Where the element states it uses start in the frame's.
    states: usize,
    /// The row the list rendered just before, and where what rendering it
    /// read and the element states it used start. See
    /// [`spanned_render_item`].
    rendered: Option<(usize, usize, usize)>,
}

/// Where what laying out a row of the list whose rows are prepainting into
/// its layer, outside any row's prepaint, adds starts. See
/// [`note_row_layout`].
///
/// A row of a list laid out while a row of another list is being laid out,
/// as a list sized by its rows lays them out in its `request_layout`, is
/// part of that row, and is not noted.
pub(crate) fn row_layout_start(window: &mut Window) -> Option<RowLayoutStart> {
    // Taken before the row is laid out: laying it out may render the rows
    // of a list in it, which replace it.
    let rendered = RENDERED_ROW.take();
    if crate::fast::layout::is_laying_out_list_row(window) {
        return None;
    }
    let id = window.fast_layers.painting.as_ref()?.id.clone();
    let frame = window.fast_layers.layers.get(&id)?.rows.frame.as_ref()?;
    if frame.paint.is_some() || frame.open_row.is_some() || frame.layout_keys.is_none() {
        return None;
    }
    let engine = window.layout_engine.as_ref().unwrap();
    Some(RowLayoutStart {
        keys: engine.claimed_keys_since(0).len(),
        reads: reads_len(),
        writes: crate::fast::dependencies::write_generation_now(),
        states: window.next_frame.accessed_element_states.len(),
        rendered,
    })
}

/// Notes that laying out the row `row`, from `start` (see
/// [`row_layout_start`]), claimed the layout keys recorded since, read the
/// entities logged since and used the element states the frame accessed
/// since: they are the row's, whichever row is prepainted next.
pub(crate) fn note_row_layout(window: &mut Window, row: usize, start: Option<RowLayoutStart>) {
    let Some(start) = start else {
        return;
    };
    let end = window
        .layout_engine
        .as_ref()
        .unwrap()
        .claimed_keys_since(0)
        .len();
    let Some(id) = window
        .fast_layers
        .painting
        .as_ref()
        .map(|painting| painting.id.clone())
    else {
        return;
    };
    let Some(frame) = frame_mut(window, &id) else {
        return;
    };
    // What rendering the row, just before, read and used.
    let rendered = start.rendered.filter(|(rendered, _, _)| *rendered == row);
    let reads_start = match rendered {
        Some((_, from, _)) if from >= frame.reads_start => from.min(start.reads),
        _ => start.reads,
    };
    let states_start = match rendered {
        Some((_, _, from)) if from >= frame.prepaint_start.accessed_element_states_index => {
            from.min(start.states)
        }
        _ => start.states,
    };
    let layout = RowLayout {
        row,
        keys: start.keys..end,
        reads: reads_start..reads_len(),
        writes: (
            start.writes,
            crate::fast::dependencies::write_generation_now(),
        ),
        states: window
            .next_frame
            .accessed_element_states
            .get(states_start..)
            .map(<[_]>::to_vec)
            .unwrap_or_default(),
    };
    if let Some(frame) = frame_mut(window, &id) {
        frame.row_layouts.push(layout);
    }
}

/// Starts recording the layout keys a list's rows claim, returning where
/// the recording starts, twice: where it began, and where the last row ended.
fn record_layout_keys(window: &mut Window) -> (usize, usize) {
    let start = window.record_claimed_layout_keys();
    (start, start)
}

/// Ends what [`begin_uniform_list`] began, once the rows are prepainted.
pub(crate) fn end_rows(window: &mut Window, cx: &mut App, rows: Rows) {
    if rows.0.is_none() {
        return;
    }
    let Some(painting) = window.fast_layers.painting.take() else {
        debug_assert!(false, "a list's rows ended without beginning");
        return;
    };
    finish_prepaint(window, cx, &painting.id);
}

/// Ends the prepaint of the rows of the list `id`: what it added to the
/// frame and read is the frame's.
fn finish_prepaint(window: &mut Window, cx: &mut App, id: &GlobalElementId) {
    let end = window.prepaint_index();
    let Some(frame) = frame_mut(window, id) else {
        return;
    };
    frame.prepaint_range = frame.prepaint_start.clone()..end;
    if let Some((start, _)) = frame.layout_keys.take() {
        window.finish_recording_claimed_layout_keys(start);
    }
    let Some(frame) = frame_mut(window, id) else {
        return;
    };
    let recording = frame.recording.take();
    if let Some(recording) = recording {
        // What each row read is the row's; what the list read besides is
        // the record's. A row the list only measured, laying it out without
        // prepainting it, is not the layer's: what it read is no one's, as
        // a list without a layer measures it once and keeps its height.
        let mut row_reads = mem::take(&mut frame.row_prepaints);
        let mut excluded: Vec<Range<usize>> = row_reads
            .iter()
            .flat_map(|prepaint| prepaint.reads.iter().cloned())
            .chain(frame.row_layouts.iter().map(|layout| layout.reads.clone()))
            .collect();
        excluded.push(frame.replayed.clone());
        let rest = outside_spans(frame.reads_start..reads_len(), excluded);
        let owner = invalidate::owner_view(window);
        for prepaint in &mut row_reads {
            let entities = cx.entities_read_in(prepaint.reads.iter().cloned());
            prepaint.entities = without(entities, owner);
        }
        let rest = without(cx.entities_read_in(rest), owner);
        let all = cx.finish_recording_dependencies(recording).all;
        let dependencies = without_owner(window, all.with_entities(rest));
        if let Some(frame) = frame_mut(window, id) {
            frame.dependencies = dependencies;
            frame.row_prepaints = row_reads;
        }
    }
}

/// Whether rows `a` and `b` draw the same thing where each lies, wherever
/// that is in the layer: one row painted again after a scroll moved it.
fn drawn_alike(a: &Row, b: &Row) -> bool {
    fn hash(row: &Row) -> u64 {
        let to_row = point(
            ScaledPixels(-row.slot.origin.x.0),
            ScaledPixels(-row.slot.origin.y.0),
        );
        let operations: Vec<PaintOperation> = row
            .whole_part()
            .scene
            .paint_operations
            .iter()
            .map(|operation| match operation {
                PaintOperation::Primitive(primitive) => {
                    let mut primitive = primitive.clone();
                    move_primitive(&mut primitive, to_row);
                    PaintOperation::Primitive(primitive)
                }
                PaintOperation::StartLayer(bounds) => PaintOperation::StartLayer(Bounds {
                    origin: bounds.origin + to_row,
                    size: bounds.size,
                }),
                PaintOperation::EndLayer => PaintOperation::EndLayer,
            })
            .collect();
        let (tiles, _) = part_tile_hashes(&operations, paint::TILE_SIZE);
        tiles.first().map_or(0, |(_, hash)| *hash)
    }
    a.part.scene.paint_operations.len() == b.part.scene.paint_operations.len()
        && a.overlay.len() == b.overlay.len()
        && hash(a) == hash(b)
}

impl Row {
    /// The part drawing everything the row drew, overlay included.
    fn whole_part(&self) -> LayerPart {
        match &self.whole {
            Some(whole) => LayerPart {
                bounds: None,
                scene: whole.clone(),
            },
            None => self.part.clone(),
        }
    }
}

/// The parts of `range` outside every one of `spans`.
fn outside_spans(range: Range<usize>, mut spans: Vec<Range<usize>>) -> Vec<Range<usize>> {
    spans.sort_by_key(|span| span.start);
    let mut parts = Vec::new();
    let mut cursor = range.start;
    for span in spans {
        if span.start > cursor {
            parts.push(cursor..span.start.min(range.end));
        }
        cursor = cursor.max(span.end);
    }
    if range.end > cursor {
        parts.push(cursor..range.end);
    }
    parts
}

/// `entities` without `entity`.
fn without(entities: Rc<[EntityId]>, entity: Option<EntityId>) -> Rc<[EntityId]> {
    match entity {
        Some(entity) if entities.contains(&entity) => entities
            .iter()
            .copied()
            .filter(|other| *other != entity)
            .collect(),
        _ => entities,
    }
}

/// `dependencies`, read by a list's rows, without the view holding the
/// list: a list renders its rows as that view, whose own changes, and
/// whether it was notified for anything but a scroll, are judged apart (see
/// [`invalidate::scroll_only`]).
fn without_owner(window: &Window, dependencies: RenderDependencies) -> RenderDependencies {
    invalidate::without_entity(&dependencies, invalidate::owner_view(window))
        .unwrap_or(dependencies)
}

fn frame_mut<'a>(window: &'a mut Window, id: &GlobalElementId) -> Option<&'a mut RowsFrame> {
    window
        .fast_layers
        .layers
        .get_mut(id)
        .and_then(|layer| layer.rows.frame.as_mut())
}

/// The id a `list` whose state `version` counts changes of has: the id of
/// the elements around it, and its state.
fn list_id(window: &Window, version: &StateVersion) -> GlobalElementId {
    let mut path: Vec<ElementId> = window.element_id_stack.to_vec();
    path.push(ElementId::NamedInteger(
        LIST_ID_NAME.into(),
        version.id() as u64,
    ));
    GlobalElementId::new(&path)
}

/// What the ids of the elements and views inside the scroll container `id`
/// start with: `id`, or for a `list`, which has no id of its own, the id of
/// the elements around it (see [`list_id`]).
pub(crate) fn content_prefix(id: &GlobalElementId) -> &[ElementId] {
    match id.split_last() {
        Some((ElementId::NamedInteger(name, _), around)) if name.as_ref() == LIST_ID_NAME => around,
        _ => id,
    }
}

/// Whether a view drawn into the rows the layer of the list `id` holds is
/// one `f` picks. A list's rows are rendered as it prepaints, not as the view
/// holding it renders, so their views are not among that view's nested ones;
/// the layer remembers them.
pub(crate) fn any_held_view(
    window: &Window,
    id: &GlobalElementId,
    f: impl Fn(EntityId) -> bool,
) -> bool {
    window
        .fast_layers
        .layers
        .get(id)
        .filter(|layer| layer.rows.list)
        .and_then(|layer| layer.record.as_ref())
        .is_some_and(|record| record.views.iter().copied().any(f))
}

/// The name of the last part of a `list`'s id.
const LIST_ID_NAME: &str = "fast-list";

/// The frame of the `list` whose rows are prepainting, if it is the one
/// whose state `version` counts changes of.
fn list_frame<'a>(window: &'a mut Window, version: &StateVersion) -> Option<&'a mut RowsFrame> {
    let id = window.fast_layers.painting.as_ref()?.id.clone();
    frame_mut(window, &id).filter(|frame| frame.list == Some(version.id()))
}

/// Decides what the `list` of `state`, laid out at `bounds`, does with its
/// rows this frame, before it lays them out and prepaints them.
pub(crate) fn begin_list(
    window: &mut Window,
    cx: &mut App,
    state: &crate::StateInner,
    bounds: Bounds<Pixels>,
) {
    if !COMPILED || !LIST_LAYERS || paint::inside_layer(window) || !list_layers_active(window, cx) {
        return;
    }
    let version = state.version.clone();
    let id = list_id(window, &version);
    let viewport = window.content_mask().bounds.intersect(&bounds);
    let scroll_top = state.scroll_top(&state.logical_scroll_top());
    let scroll_offset = paint::snap_scroll_offset(window, point(px(0.), -scroll_top));
    invalidate::note_list_at_end(window, &version, scrolled_to_end(state));
    // A view rendering again and splicing its list moves its rows to other
    // indices: they are not only rendered again, but painted afresh.
    let item_count = state.items.summary().count;
    if let Some(layer) = window.fast_layers.layers.get_mut(&id) {
        layer.rows.items_changed = layer.rows.item_count.replace(item_count) != Some(item_count);
    }
    // A list lays out its rows itself, and is not taken for changed when a
    // row is measured for the first time: its rows are checked where they
    // are placed.
    let decision = policy::decide(window, cx, &id, bounds, bounds.size, scroll_offset);
    let decision = input::decide(window, &id, decision);
    // Remembered as painted, for its scrolls to be told apart.
    invalidate::painted_list(window, &id, &version);
    if decision == Decision::Bypass {
        return;
    }
    let layer = paint::layer_mut(window, &id);
    let mode = if decision == Decision::Composite && layer.rows.list && layer.record.is_some() {
        Mode::Extend
    } else {
        Mode::Repaint
    };
    let frame = RowsFrame {
        mode,
        list: Some(version.id()),
        skip_held: mode == Mode::Extend && state.pending_scroll.is_none() && !layer.rows.rerendered,
        needed: 0..0,
        retain: 0..0,
        stale: BTreeSet::new(),
        changed: BTreeSet::new(),
        visible: 0..0,
        leaving: BTreeSet::new(),
        carried: Vec::new(),
        slots: BTreeMap::new(),
        viewport,
        painted_region: viewport,
        scroll_offset,
        translation: Point::default(),
        prepaint_start: window.prepaint_index(),
        prepaint_range: window.prepaint_index()..window.prepaint_index(),
        recording: Some(cx.begin_recording_dependencies()),
        dependencies: RenderDependencies::default(),
        row_prepaints: Vec::new(),
        open_row: None,
        reads_start: reads_len(),
        replayed: 0..0,
        layout_keys: Some(record_layout_keys(window)),
        row_layouts: Vec::new(),
        order: Vec::new(),
        next: 0,
        anchor: None,
        prepainted: Vec::new(),
        extra: Vec::new(),
        paint: None,
    };
    let changed = match mode {
        Mode::Extend => changed_rows(window, cx, &id),
        Mode::Repaint => BTreeSet::new(),
    };
    window.fast_layers.painting = Some(marker(&id, &frame));
    let layer = paint::layer_mut(window, &id);
    layer.rows.frame = Some(RowsFrame { changed, ..frame });
    if mode == Mode::Extend {
        keep_reads(window, cx, &id);
    }
}

/// Notes that whether the `list` of `state` is scrolled to its end was read,
/// as [`crate::ListState::is_scrolled_to_end`] reads it, and what it was (see
/// [`invalidate::note_at_end_read`]).
pub(crate) fn note_at_end_read(state: &crate::StateInner) {
    invalidate::note_at_end_read(&state.version, scrolled_to_end(state));
}

/// Marks the state of a `list` changed if scrolling it to its end moves it.
/// A view that keeps its list at its end calls
/// [`crate::ListState::scroll_to_end`] every time it renders, which changes
/// nothing once the list is there, though laying the list out puts its
/// offset in other terms.
pub(crate) fn note_scrolled_to_end(state: &crate::StateInner) {
    let there = state.pending_scroll.is_none() && scrolled_to_end(state) == Some(true);
    state.version.bump_if(!there);
}

/// Whether the `list` of `state` is scrolled to its end, or `None` if it
/// cannot scroll or the height of a row is not known yet, as
/// [`crate::ListState::is_scrolled_to_end`] answers.
pub(crate) fn scrolled_to_end(state: &crate::StateInner) -> Option<bool> {
    let bounds = state.last_layout_bounds?;
    let summary = state.items.summary();
    if summary.has_unknown_height {
        return None;
    }
    let padding = state.last_padding.unwrap_or_default();
    let content_height = summary.height + padding.top + padding.bottom;
    let scroll_max = (content_height - bounds.size.height).max(px(0.));
    if scroll_max <= px(0.) {
        return None;
    }
    let scroll_top = state.scroll_top(&state.logical_scroll_top());
    Some(scroll_top >= scroll_max)
}

/// Whether a `list`, whose state `version` counts changes of, laying out the
/// rows it shows, leaves out its row `ix`, whose size it knows when
/// `measured`: the frame only scrolled its layer, which holds the row as it
/// is.
pub(crate) fn keeps_row(
    window: &Window,
    version: &StateVersion,
    ix: usize,
    measured: bool,
) -> bool {
    if !LIST_LAYERS {
        return false;
    }
    if !measured {
        return false;
    }
    let Some(painting) = window.fast_layers.painting.as_ref() else {
        return false;
    };
    let Some(layer) = window.fast_layers.layers.get(&painting.id) else {
        return false;
    };
    layer.rows.frame.as_ref().is_some_and(|frame| {
        frame.list == Some(version.id())
            && frame.skip_held
            && layer.rows.rows.get(&ix).is_some_and(|row| !row.suspect)
            && !frame.changed.contains(&ix)
    })
}

/// Moves `origin`, where a `list` of `state` scrolled to `scroll_top` is
/// about to place its first row shown, up by how far it is scrolled into
/// that row, as the list does, but so that the list's offset from its first
/// row is a whole number of device pixels where layers are compiled (see
/// [`paint::snap_scroll_offset`]); and notes where the row lies, for the
/// list's layer.
pub(crate) fn snap_item_origin(
    window: &mut Window,
    state: &crate::StateInner,
    scroll_top: &crate::ListOffset,
    origin: &mut Point<Pixels>,
) {
    if !LIST_LAYERS {
        origin.y -= scroll_top.offset_in_item;
        return;
    }
    let offset = state.scroll_top(scroll_top);
    let snapped = paint::snap_scroll_offset(window, point(px(0.), offset)).y;
    origin.y -= scroll_top.offset_in_item + (snapped - offset);
    if let Some(frame) = list_frame(window, &state.version) {
        frame.anchor = Some((scroll_top.item_ix, *origin));
        // The list lays out its rows again, after an autoscroll.
        frame.prepainted.clear();
        frame.row_prepaints.clear();
        frame.open_row = None;
    }
}

/// Moves `origin`, where a `list` is about to prepaint its row `ix`, to
/// where the row lies, when it leaves out the rows its layer holds and so
/// cannot add up the rows before it; and notes that the row begins to
/// prepaint, the one before it prepainted.
pub(crate) fn place_list_item(
    window: &mut Window,
    state: &crate::StateInner,
    ix: usize,
    origin: &mut Point<Pixels>,
) {
    if !LIST_LAYERS {
        return;
    }
    let Some(id) = window.fast_layers.painting.as_ref().map(|p| p.id.clone()) else {
        return;
    };
    let list = Some(state.version.id());
    if frame_mut(window, &id).is_none_or(|frame| frame.list != list) {
        return;
    }
    end_row(window, list);
    begin_row(window, list, ix);
    let scale_factor = window.scale_factor();
    let Some(layer) = window.fast_layers.layers.get_mut(&id) else {
        return;
    };
    let rows = &mut layer.rows;
    let Some(frame) = rows.frame.as_mut() else {
        return;
    };
    frame.prepainted.push(ix);
    let Some((anchor, anchor_origin)) = frame.anchor else {
        return;
    };
    let heights = |row: usize| row_height(state, &rows.rows, row, scale_factor);
    if let Some(y) = row_top(anchor, anchor_origin.y, ix, heights) {
        origin.y = y;
    }
}

/// The height of a `list`'s row `row`: as the list measured it, or as the
/// layer holds it.
fn row_height(
    state: &crate::StateInner,
    rows: &BTreeMap<usize, Row>,
    row: usize,
    scale_factor: f32,
) -> Option<Pixels> {
    let mut cursor = state.items.cursor::<crate::Count>(());
    cursor.seek(&crate::Count(row), sum_tree::Bias::Right);
    cursor
        .item()
        .and_then(|item| item.size())
        .map(|size| size.height)
        .or_else(|| {
            rows.get(&row)
                .map(|held| px(held.slot.size.height.0 / scale_factor))
        })
}

/// The top of row `ix` of a list whose row `anchor` lies at `anchor_top`,
/// adding up the heights of the rows between them in order, as the list
/// does.
fn row_top(
    anchor: usize,
    anchor_top: Pixels,
    ix: usize,
    mut height: impl FnMut(usize) -> Option<Pixels>,
) -> Option<Pixels> {
    let mut top = anchor_top;
    if ix >= anchor {
        for row in anchor..ix {
            top += height(row)?;
        }
    } else {
        for row in (ix..anchor).rev() {
            top -= height(row)?;
        }
    }
    Some(top)
}

/// Ends the layout and prepaint of the rows of the `list` of `state`, laid
/// out at `bounds`: the rows around those it showed are rendered and
/// prepainted into its layer with `render_item`, as far as the layer is to
/// hold them, and the records of the rows it keeps are carried.
pub(crate) fn end_list(
    window: &mut Window,
    cx: &mut App,
    state: &crate::StateInner,
    render_item: &mut crate::RenderItemFn,
    bounds: Bounds<Pixels>,
) {
    if !LIST_LAYERS {
        return;
    }
    let list = Some(state.version.id());
    let id = match window.fast_layers.painting.as_ref() {
        Some(painting) => painting.id.clone(),
        None => {
            note_shown_without_layer(window, state, bounds);
            return;
        }
    };
    if frame_mut(window, &id).is_none_or(|frame| frame.list != list) {
        return;
    }
    end_row(window, list);
    let scale_factor = window.scale_factor();
    let Some(layer) = window.fast_layers.layers.get_mut(&id) else {
        return;
    };
    let rows = &mut layer.rows;
    let Some(frame) = rows.frame.as_mut() else {
        return;
    };
    let Some((anchor, anchor_origin)) = frame.anchor else {
        // No row was shown: nothing is painted into the layer.
        window.fast_layers.painting = None;
        finish_prepaint(window, cx, &id);
        if let Some(layer) = window.fast_layers.layers.get_mut(&id) {
            layer.rows.frame = None;
        }
        return;
    };
    let item_count = state.items.summary().count;
    let viewport = frame.viewport;

    // The rows the layer holds stay where they are only if the first row
    // shown lies at a whole number of device pixels from where the layer
    // holds it, and every row it holds is as tall as the list measures it;
    // and, once the rows around it are placed, if each row it keeps lands on
    // the pixels it would painted afresh (see [`held_rows_land_alike`]).
    let mut translation = None;
    if frame.mode == Mode::Extend
        && let Some(held) = rows.rows.get(&anchor)
    {
        let x = anchor_origin.x.0 * scale_factor - held.slot.origin.x.0;
        let y = anchor_origin.y.0 * scale_factor - held.slot.origin.y.0;
        let whole = |value: f32| (value - value.round()).abs() < 0.01;
        let heights_hold = rows.rows.iter().all(|(row, held)| {
            let mut cursor = state.items.cursor::<crate::Count>(());
            cursor.seek(&crate::Count(*row), sum_tree::Bias::Right);
            cursor
                .item()
                .and_then(|item| item.size())
                .is_none_or(|size| {
                    (size.height.0 * scale_factor - held.slot.size.height.0).abs() < 0.01
                })
        });
        let in_list = rows
            .rows
            .last_key_value()
            .is_none_or(|(last, _)| *last < item_count);
        if whole(x) && whole(y) && heights_hold && in_list {
            translation = Some(point(ScaledPixels(x.round()), ScaledPixels(y.round())));
        }
    }
    let frame = rows.frame.as_mut().unwrap();
    if translation.is_none() {
        frame.mode = Mode::Repaint;
    }
    let frame_translation = translation.unwrap_or_default();
    frame.translation = frame_translation;

    // The rows shown and up to two viewports' height of rows on each side.
    let layer = window.fast_layers.layers.get_mut(&id).unwrap();
    let mode = layer
        .rows
        .frame
        .as_ref()
        .map_or(Mode::Repaint, |frame| frame.mode);
    // The frame promoting the layer paints the whole overscan, which the
    // frames compositing it pay back; one painting the rows afresh after
    // that paints only those the list shows; one keeping them adds rows
    // around them within its budget (see [`RENDER_PER_FRAME_VIEWPORTS`]), the
    // rows the layer holds for free.
    let promoting = layer.record.is_none();
    let toward_end = scrolls_toward_end(layer.rows.last_translation, frame_translation);
    // The rows between the first the layer holds and the last are taken
    // for held: a row among them it lacks is rendered all the same.
    let held = match (
        mode,
        layer.rows.rows.first_key_value(),
        layer.rows.rows.last_key_value(),
    ) {
        (Mode::Extend, Some((first, _)), Some((last, _))) => *first..*last + 1,
        _ => 0..0,
    };
    let extent = match mode {
        Mode::Repaint if !promoting => Pixels::ZERO,
        _ => viewport.size.height * paint::OVERSCAN_VIEWPORTS,
    };
    let (top, bottom) = (viewport.top() - extent, viewport.bottom() + extent);
    let available = crate::size(
        AvailableSpace::Definite(bounds.size.width),
        AvailableSpace::MinContent,
    );
    let mut rendered: FxHashMap<usize, AnyElement> = FxHashMap::default();
    let mut tops: BTreeMap<usize, (Pixels, Pixels)> = BTreeMap::new();
    let mut height_of = |row: usize,
                         window: &mut Window,
                         cx: &mut App,
                         rendered: &mut FxHashMap<usize, AnyElement>|
     -> Pixels {
        let rows = &window.fast_layers.layers[&id].rows.rows;
        if let Some(height) = row_height(state, rows, row, scale_factor) {
            return height;
        }
        let mut element = render_item(row, window, cx);
        let size =
            crate::fast::layout_key::layout_as_list_item(&mut element, row, available, window, cx);
        rendered.insert(row, element);
        size.height
    };
    let mut missing = Pixels::ZERO;
    let (mut end, mut end_y) = (anchor, anchor_origin.y);
    while end < item_count && end_y < viewport.bottom() {
        let height = height_of(end, window, cx, &mut rendered);
        tops.insert(end, (end_y, height));
        if !held.contains(&end) {
            missing += height;
        }
        end_y += height;
        end += 1;
    }
    let (mut start, mut start_y) = (anchor, anchor_origin.y);
    while start > 0 && start_y > viewport.top() {
        start -= 1;
        let height = height_of(start, window, cx, &mut rendered);
        start_y -= height;
        tops.insert(start, (start_y, height));
        if !held.contains(&start) {
            missing += height;
        }
    }
    let (end_budget, start_budget) = match mode {
        Mode::Extend => {
            let budget =
                (viewport.size.height * RENDER_PER_FRAME_VIEWPORTS - missing).max(Pixels::ZERO);
            let (end, start) = ahead(toward_end);
            (budget * end, budget * start)
        }
        Mode::Repaint if promoting => (extent, extent),
        Mode::Repaint => (Pixels::ZERO, Pixels::ZERO),
    };
    // A row the layer lacks is added only if it fits what is left, or was
    // rendered to learn its height: that is paid for already.
    let mut left = end_budget;
    while end < item_count && end_y < bottom {
        if !held.contains(&end) && left <= Pixels::ZERO {
            break;
        }
        let height = height_of(end, window, cx, &mut rendered);
        if !held.contains(&end) {
            if height > left && !rendered.contains_key(&end) {
                break;
            }
            left -= height;
        }
        tops.insert(end, (end_y, height));
        end_y += height;
        end += 1;
    }
    let mut left = start_budget;
    while start > 0 && start_y > top {
        if !held.contains(&(start - 1)) && left <= Pixels::ZERO {
            break;
        }
        let height = height_of(start - 1, window, cx, &mut rendered);
        if !held.contains(&(start - 1)) {
            if height > left && !rendered.contains_key(&(start - 1)) {
                break;
            }
            left -= height;
        }
        start -= 1;
        start_y -= height;
        tops.insert(start, (start_y, height));
    }
    let mut needed = start..end;

    // The rows the list shows: those it renders without a layer.
    let visible = shown_rows(&tops, bounds);
    let layer = &window.fast_layers.layers[&id];
    let mode = layer
        .rows
        .frame
        .as_ref()
        .map_or(Mode::Repaint, |frame| frame.mode);
    let changed = layer
        .rows
        .frame
        .as_ref()
        .map(|frame| frame.changed.clone())
        .unwrap_or_default();
    let sort = sort_rows(
        window,
        layer,
        mode,
        frame_translation,
        viewport,
        &visible,
        &changed,
    );
    let layer = &mut window.fast_layers.layers.get_mut(&id).unwrap().rows;
    let due_for_repaint = layer.due_for_repaint(&needed);
    let frame = layer.frame.as_mut().unwrap();
    frame.stale = sort.stale;
    frame.leaving = sort.leaving;
    frame.visible = visible;
    // The rows the list prepainted itself, those whose hovers changed among
    // them, are painted into the layer afresh.
    let prepainted: BTreeSet<usize> = frame.prepainted.iter().copied().collect();
    let kept: BTreeSet<usize> = match frame.mode {
        Mode::Extend => sort
            .unrendered
            .into_iter()
            .filter(|row| !prepainted.contains(row))
            .collect(),
        Mode::Repaint => BTreeSet::new(),
    };
    if frame.mode == Mode::Extend {
        if due_for_repaint {
            // Painted afresh for having added too many rows while it only
            // scrolls: the scroll goes on, and the overscan is painted with it.
            frame.mode = Mode::Repaint;
        } else if !held_rows_land_alike(
            &layer.rows,
            &kept,
            &needed,
            &tops,
            frame.translation,
            scale_factor,
        ) {
            // The rows held would not land where they are painted: the rows
            // shown are painted afresh, as for a change of the content.
            frame.mode = Mode::Repaint;
            needed = frame.visible.clone();
        }
    }
    let (held, unrendered) = match frame.mode {
        Mode::Extend => (kept.clone(), kept),
        // Painted afresh, but for the rows leaving the viewport.
        Mode::Repaint => (BTreeSet::new(), frame.leaving.clone()),
    };
    let plan = plan(&unrendered, needed.clone());
    let slot = |(top, height): (Pixels, Pixels)| Bounds {
        origin: point(anchor_origin.x, top),
        size: crate::size(bounds.size.width, height),
    };
    frame.slots = plan
        .render
        .iter()
        .flat_map(|run| run.clone())
        .map(|row| (row, slot(tops[&row])))
        .collect();
    frame.retain = match frame.mode {
        Mode::Extend => retained_rows(&held, &needed),
        Mode::Repaint => needed.clone(),
    };
    frame.carried = held.range(frame.retain.clone()).copied().collect();
    frame.needed = needed;
    let mut painted_region = viewport;
    if let (Some(first), Some(last)) = (tops.values().next(), tops.values().last()) {
        painted_region = painted_region.union(&slot(*first)).union(&slot(*last));
    }
    frame.painted_region = painted_region;
    if frame.mode == Mode::Repaint {
        // Content space is window space as the rows are painted now.
        frame.translation = Point::default();
        frame.stale.clear();
    }
    let to_prepaint: Vec<(usize, Pixels)> = frame
        .slots
        .iter()
        .filter(|(row, _)| !prepainted.contains(row))
        .map(|(row, slot)| (*row, slot.origin.y))
        .collect();
    if let Some(painting) = window.fast_layers.painting.as_mut() {
        painting.painted_region = painted_region;
    }
    carry_prepaint_rows(window, &id);

    let mut extra = Vec::with_capacity(to_prepaint.len());
    let mut unplaced = Vec::new();
    for (row, top) in to_prepaint {
        let mut element = match rendered.remove(&row) {
            Some(element) => element,
            None => {
                let mut element = render_item(row, window, cx);
                let size = crate::fast::layout_key::layout_as_list_item(
                    &mut element,
                    row,
                    available,
                    window,
                    cx,
                );
                let (_, height) = tops[&row];
                let hidden = top + height <= viewport.top() || top >= viewport.bottom();
                if hidden && (size.height.0 - height.0).abs() * scale_factor >= 0.01 {
                    // The list's size for the row is out of date (it was
                    // measured at another scale, say), and the list corrects
                    // it when it shows the row: the layer does not hold a row
                    // where it would not be then.
                    unplaced.push(row);
                    continue;
                }
                element
            }
        };
        let origin = point(anchor_origin.x, top);
        let began = begin_row(window, list, row);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            element.prepaint_at(origin, window, cx);
        });
        if began {
            end_row(window, list);
        }
        extra.push((row, element));
    }
    if !extra.is_empty() {
        // Rows the list does not show ask for no autoscroll.
        window.take_autoscroll();
    }
    window.fast_layers.painting = None;
    finish_prepaint(window, cx, &id);
    if let Some(frame) = frame_mut(window, &id) {
        frame.extra = extra;
        for row in unplaced {
            frame.slots.remove(&row);
        }
    }
}

/// Whether each row of `rows` that a `list` keeps, those of `kept` in
/// `needed`, lands on the pixels it would if painted afresh when its content
/// is moved by `translation`: the row lies at `tops` (its top and height),
/// at the same fraction of a device pixel as it does moved, and neither its
/// top nor its bottom lies half way between device pixels.
///
/// A row's edges are rounded to device pixels as the row is painted, half
/// way toward zero. Rounding a position and then moving it by whole device
/// pixels lands where rounding the moved position does, unless the position
/// is half way: its rounding then depends on its sign, which the move can
/// flip, and on the last bits of how the list added up the rows' heights,
/// which differ from frame to frame. Rows whose height is not a whole number
/// of device pixels (30 px at a scale of 1.25) put edges there.
fn held_rows_land_alike(
    rows: &BTreeMap<usize, Row>,
    kept: &BTreeSet<usize>,
    needed: &Range<usize>,
    tops: &BTreeMap<usize, (Pixels, Pixels)>,
    translation: Point<ScaledPixels>,
    scale_factor: f32,
) -> bool {
    const EPSILON: f32 = 0.01;
    let half_way = |value: f32| ((value - value.floor()) - 0.5).abs() < EPSILON;
    rows.range(needed.clone())
        .filter(|(row, _)| kept.contains(row))
        .all(|(row, held)| {
            let Some((top, height)) = tops.get(row) else {
                return false;
            };
            let top = top.0 * scale_factor;
            let bottom = top + height.0 * scale_factor;
            let moved = held.slot.origin.y.0 + translation.y.0;
            (moved - top).abs() < EPSILON && !half_way(top) && !half_way(bottom)
        })
}

/// The rows of `tops` (each row's top and height) that lie across `bounds`,
/// the list's: those it shows.
fn shown_rows(tops: &BTreeMap<usize, (Pixels, Pixels)>, bounds: Bounds<Pixels>) -> Range<usize> {
    let shown = |(row, (top, height)): (&usize, &(Pixels, Pixels))| {
        (*top < bounds.bottom() && *top + *height > bounds.top()).then_some(*row)
    };
    match (
        tops.iter().find_map(shown),
        tops.iter().rev().find_map(shown),
    ) {
        (Some(first), Some(last)) => first..last + 1,
        _ => 0..0,
    }
}

/// Notes which rows the `list` of `state`, laid out at `bounds`, showed on
/// a frame that kept them off its layer, if it has one: as far down from
/// its first row shown as its bounds reach.
fn note_shown_without_layer(
    window: &mut Window,
    state: &crate::StateInner,
    bounds: Bounds<Pixels>,
) {
    if !COMPILED || window.fast_layers.layers.is_empty() {
        return;
    }
    let id = list_id(window, &state.version);
    let frame = window.fast_layers.frame;
    let Some(layer) = window.fast_layers.layers.get_mut(&id) else {
        return;
    };
    let top = state.logical_scroll_top();
    let mut cursor = state.items.cursor::<crate::Count>(());
    cursor.seek(&crate::Count(top.item_ix), sum_tree::Bias::Right);
    let mut height = -top.offset_in_item;
    let mut end = top.item_ix;
    while let Some(item) = cursor.item()
        && height < bounds.size.height
    {
        height += item.size().map_or(bounds.size.height, |size| size.height);
        end += 1;
        cursor.next();
    }
    layer.rows.visible = Some((frame, top.item_ix..end));
}

/// Starts painting the rows of the `list` of `state`.
pub(crate) fn begin_paint_list(window: &mut Window, cx: &mut App, state: &crate::ListState) {
    if !LIST_LAYERS {
        return;
    }
    if !COMPILED || window.fast_layers.layers.is_empty() {
        return;
    }
    let version = state.0.borrow().version.clone();
    let id = list_id(window, &version);
    begin_paint_rows(window, cx, Some(&id));
}

/// Ends painting the rows of the `list` of `state`: the rows rendered for
/// its layer alone are painted, and the layer is composited.
pub(crate) fn end_paint_list(window: &mut Window, cx: &mut App, state: &crate::ListState) {
    if !LIST_LAYERS {
        return;
    }
    if !COMPILED || window.fast_layers.layers.is_empty() {
        return;
    }
    let version = state.0.borrow().version.clone();
    let id = list_id(window, &version);
    let Some(frame) = frame_mut(window, &id) else {
        return;
    };
    let extra = mem::take(&mut frame.extra);
    for (row, mut element) in extra {
        paint_row(window, cx, Some(row), |window, cx| {
            element.paint(window, cx)
        });
    }
    end_paint_rows(window, cx, Some(&id));
}

/// Starts painting the rows of the list `id` as its prepaint decided, and
/// carries the paint records of the rows its layer keeps.
pub(crate) fn begin_paint_rows(window: &mut Window, cx: &mut App, id: Option<&GlobalElementId>) {
    if !LIST_LAYERS {
        return;
    }
    let Some(id) = id else {
        return;
    };
    if window.fast_layers.layers.is_empty() {
        return;
    }
    let Some(frame) = frame_mut(window, id) else {
        return;
    };
    if frame.paint.is_some() {
        return;
    }
    let region = rows_region(frame);
    let has_rows = !frame.slots.is_empty();
    let background = if has_rows {
        Some(replayed_background(window))
    } else {
        None
    };
    let mut state = PaintState {
        background,
        swapped: background.is_some(),
        scene: Scene::default(),
        records_start: window.paint_index(),
        recording: None,
        reads_start: 0,
        current: None,
        spans: Vec::new(),
    };
    if state.swapped {
        window
            .content_mask_stack
            .push(ContentMask { bounds: region });
        mem::swap(&mut window.next_frame.scene, &mut state.scene);
        state.recording = Some(cx.begin_recording_dependencies());
        state.reads_start = reads_len();
    }
    let frame = frame_mut(window, id).unwrap();
    let marker = marker(id, frame);
    frame.paint = Some(state);
    window.fast_layers.painting = Some(marker);
    carry_paint_rows(window, id);
    check_hovers(window, id);
}

/// Asks for another frame if a row the layer of the list `id` keeps this
/// frame was painted by a hover that the frame's hit test, made after its
/// prepaint, finds changed: its hover was foretold from where the rows move
/// (see [`stale_rows`]), and something outside the list moved too. The row
/// is rendered again on the next frame, as a retained view whose hover
/// changes the same way is.
fn check_hovers(window: &mut Window, id: &GlobalElementId) {
    let Some(layer) = window.fast_layers.layers.get(id) else {
        return;
    };
    let Some(frame) = layer.rows.frame.as_ref() else {
        return;
    };
    // A row the list does not show can show a stale hover: it is checked
    // again before it shows.
    let rows = &layer.rows.rows;
    let changed = frame
        .carried
        .iter()
        .filter(|ix| frame.visible.contains(ix) && !frame.leaving.contains(ix))
        .any(|ix| {
            rows.get(ix)
                .is_some_and(|row| !window.hovers_unchanged(&row.hovers))
        });
    if changed {
        window.request_animation_frame();
    }
}

/// Paints a row of a list with `f`: into the list's layer if its prepaint
/// rendered the row for it, not at all if the layer keeps the row, into the
/// frame otherwise. `ix` is the row, or, for a uniform list, the next row it
/// rendered.
pub(crate) fn paint_row(
    window: &mut Window,
    cx: &mut App,
    ix: Option<usize>,
    f: impl FnOnce(&mut Window, &mut App),
) {
    if !LIST_LAYERS {
        return f(window, cx);
    }
    let Some(id) = window.fast_layers.painting.as_ref().map(|p| p.id.clone()) else {
        return f(window, cx);
    };
    let Some(layer) = window.fast_layers.layers.get_mut(&id) else {
        return f(window, cx);
    };
    let held = &layer.rows.rows;
    let Some(frame) = layer.rows.frame.as_mut() else {
        return f(window, cx);
    };
    let Some(paint) = frame.paint.as_ref() else {
        return f(window, cx);
    };
    if paint.current.is_some() {
        // A row of a list nested in a row being painted.
        return f(window, cx);
    }
    let swapped = paint.swapped;
    let row = match ix {
        Some(row) => row,
        None => {
            let Some(row) = frame.order.get(frame.next).copied() else {
                return f(window, cx);
            };
            frame.next += 1;
            row
        }
    };
    if !frame.slots.contains_key(&row) {
        if frame.mode == Mode::Extend && held.contains_key(&row) {
            // The layer keeps the row as it is.
            return;
        }
        if !swapped {
            return f(window, cx);
        }
        // Into the frame, around the layer's scene and painted region.
        let region = window.content_mask_stack.pop();
        swap_scenes(window, &id);
        f(window, cx);
        swap_scenes(window, &id);
        window.content_mask_stack.extend(region);
        return;
    }
    if !swapped {
        return f(window, cx);
    }
    let start = window.next_frame.scene.paint_operations.len();
    window.take_hover_reads();
    let hovers_start = window.retained_state.hover_dependencies.len();
    let paint_start = window.paint_index();
    let reads_start = reads_len();
    let writes_start = crate::fast::dependencies::write_generation_now();
    set_current_row(window, &id, Some(row));
    {
        f(window, cx);
    }
    set_current_row(window, &id, None);
    let paint_end = window.paint_index();
    let end = window.next_frame.scene.paint_operations.len();
    window.take_hover_reads();
    let hovers = window.retained_state.hover_dependencies[hovers_start..].to_vec();
    if let Some(paint) = frame_mut(window, &id).and_then(|frame| frame.paint.as_mut()) {
        paint.spans.push(RowPaint {
            row,
            operations: start..end,
            paint: paint_start..paint_end,
            hovers,
            reads: reads_start..reads_len(),
            writes: (
                writes_start,
                crate::fast::dependencies::write_generation_now(),
            ),
        });
    }
}

fn swap_scenes(window: &mut Window, id: &GlobalElementId) {
    let Some(layer) = window.fast_layers.layers.get_mut(id) else {
        return;
    };
    if let Some(paint) = layer
        .rows
        .frame
        .as_mut()
        .and_then(|frame| frame.paint.as_mut())
    {
        mem::swap(&mut window.next_frame.scene, &mut paint.scene);
    }
}

fn set_current_row(window: &mut Window, id: &GlobalElementId, row: Option<usize>) {
    if let Some(paint) = frame_mut(window, id).and_then(|frame| frame.paint.as_mut()) {
        paint.current = row;
    }
}

/// Ends painting the rows of the list `id`: the rows painted into its layer
/// are recorded, those it drops forgotten, and the layer is composited.
pub(crate) fn end_paint_rows(window: &mut Window, cx: &mut App, id: Option<&GlobalElementId>) {
    if !LIST_LAYERS {
        return;
    }
    let Some(id) = id else {
        return;
    };
    if window.fast_layers.layers.is_empty() {
        return;
    }
    let Some(layer) = window.fast_layers.layers.get_mut(id) else {
        return;
    };
    let Some(mut frame) = layer.rows.frame.take() else {
        return;
    };
    let Some(mut paint) = frame.paint.take() else {
        return;
    };
    window.fast_layers.painting = None;
    let records = paint.records_start.clone()..window.paint_index();
    if frame.slots.is_empty() {
        match frame.mode {
            Mode::Extend => {
                let layer = window.fast_layers.layers.get_mut(id).unwrap();
                if layer.rows.rows.len() == frame.carried.len() {
                    // Nothing new: the layer's content stands.
                    count_extended_frame(0);
                    finish_records(window, id, &frame, records);
                    paint::composite_at(window, id, frame.translation);
                    return;
                }
                // Rows are dropped: the content changes.
                paint.background = Some(replayed_background(window));
            }
            // No row to paint: the layer holds nothing.
            Mode::Repaint => {
                if let Some(layer) = window.fast_layers.layers.get_mut(id) {
                    layer.record = None;
                }
                clear_rows(window, id, &frame);
                return;
            }
        }
    }
    let Some(background) = paint.background else {
        // The rows were painted into the frame: so is what the layer held.
        let layer = window.fast_layers.layers.get_mut(id).unwrap();
        if let Some(record) = layer.record.take()
            && frame.mode == Mode::Extend
        {
            let carried: BTreeSet<usize> = frame.carried.iter().copied().collect();
            let kept: Vec<Rc<Scene>> = layer
                .rows
                .rows
                .iter()
                .filter(|(ix, _)| carried.contains(ix))
                .map(|(_, row)| Row::whole_part(row).scene)
                .collect();
            drop(record);
            for scene in kept {
                paint::draw_into_frame(window, &scene.paint_operations, frame.translation);
            }
        }
        clear_rows(window, id, &frame);
        policy::defer_unbaked(window, id);
        return;
    };

    // What painting each row read is the row's, as what prepainting it read
    // is (see [`finish_prepaint`]).
    let owner = invalidate::owner_view(window);
    let mut row_paint_reads: FxHashMap<usize, Rc<[EntityId]>> = FxHashMap::default();
    let paint_dependencies = match paint.recording.take() {
        Some(recording) => {
            let spans: Vec<Range<usize>> =
                paint.spans.iter().map(|span| span.reads.clone()).collect();
            let rest = outside_spans(paint.reads_start..reads_len(), spans);
            for span in &paint.spans {
                let entities = cx.entities_read_in([span.reads.clone()]);
                row_paint_reads.insert(span.row, without(entities, owner));
            }
            let rest = without(cx.entities_read_in(rest), owner);
            let all = cx.finish_recording_dependencies(recording).all;
            without_owner(window, all.with_entities(rest))
        }
        None => RenderDependencies::default(),
    };
    if paint.swapped {
        mem::swap(&mut window.next_frame.scene, &mut paint.scene);
        window.content_mask_stack.pop();
    }
    let rendered_rows: Vec<usize> = paint.spans.iter().map(|span| span.row).collect();
    let rendered_operations = paint.scene.paint_operations.len();
    let painted = paint.scene;

    let scale_factor = window.scale_factor();
    let translation = frame.translation;
    let to_content = point(
        ScaledPixels(-translation.x.0),
        ScaledPixels(-translation.y.0),
    );
    let views = invalidate::content_views(window, &frame.prepaint_range);
    let viewport = window.snapped_content_mask().bounds;
    let mut row_prepaints = mem::take(&mut frame.row_prepaints);
    let row_views: FxHashMap<usize, Rc<[EntityId]>> = row_prepaints
        .iter()
        .map(|prepainted| {
            let views = invalidate::content_views(window, &prepainted.range);
            (prepainted.row, views)
        })
        .collect();

    let layer = window.fast_layers.layers.get_mut(id).unwrap();
    let rows = &mut layer.rows;
    let for_hover = paint
        .spans
        .iter()
        .filter(|span| frame.stale.contains(&span.row))
        .count();
    // The rows held before a repaint, to tell whether it changed them.
    let mut repainted_over = BTreeMap::new();
    match frame.mode {
        Mode::Repaint => {
            repainted_over = mem::take(&mut rows.rows);
            rows.clear();
        }
        Mode::Extend => {
            rows.added_since_repaint += paint
                .spans
                .iter()
                .filter(|span| !rows.rows.contains_key(&span.row))
                .count();
            let carried: BTreeSet<usize> = frame.carried.iter().copied().collect();
            rows.rows.retain(|row, _| carried.contains(row));
            if rows.rerendered {
                for row in rows.rows.values_mut() {
                    row.suspect = true;
                }
            }
            count_extended_frame(for_hover);
        }
    }
    let mut operations = painted.paint_operations;
    for span in paint.spans {
        let Some(slot) = frame.slots.get(&span.row) else {
            continue;
        };
        let slot = slot.scale(scale_factor);
        let slot = Bounds {
            origin: slot.origin + to_content,
            size: slot.size,
        };
        // Each row's operations are taken, in content space, once.
        let mut row_operations: Vec<PaintOperation> = operations[span.operations]
            .iter_mut()
            .map(|operation| mem::replace(operation, PaintOperation::EndLayer))
            .collect();
        for operation in &mut row_operations {
            match operation {
                PaintOperation::Primitive(primitive) => move_primitive(primitive, to_content),
                PaintOperation::StartLayer(bounds) => bounds.origin = bounds.origin + to_content,
                PaintOperation::EndLayer => {}
            }
        }
        let (row_operations, overlay, whole) =
            match crate::fast::layers::overlay::split(&row_operations) {
                Some((tiles, overlay)) => {
                    let mut whole = Scene::default();
                    whole.paint_operations = row_operations;
                    (tiles, Rc::from(overlay), Some(Rc::new(whole)))
                }
                None => (row_operations, Rc::from([]), None),
            };
        let (tile_hashes, reach) = part_tile_hashes(&row_operations, paint::TILE_SIZE);
        let mut scene = Scene::default();
        scene.paint_operations = row_operations;
        let (prepaint, hitboxes, layout_keys, layout_states, read, prepaint_writes) =
            match row_prepaints.iter_mut().rev().find(|p| p.row == span.row) {
                Some(prepainted) => {
                    let range = &prepainted.range;
                    let inserted = &window.next_frame.hitboxes
                        [range.start.hitboxes_index..range.end.hitboxes_index];
                    let mut hitboxes = inserted.to_vec();
                    if prepainted.masks.len() == hitboxes.len() {
                        for (hitbox, mask) in hitboxes.iter_mut().zip(&prepainted.masks) {
                            hitbox.content_mask = *mask;
                        }
                    } else {
                        debug_assert!(false, "a hitbox inserted by a row went unnoted");
                    }
                    (
                        range.clone(),
                        hitboxes,
                        mem::take(&mut prepainted.layout_keys),
                        mem::take(&mut prepainted.layout_states),
                        prepainted.entities.clone(),
                        mem::take(&mut prepainted.writes),
                    )
                }
                None => {
                    debug_assert!(
                        false,
                        "a row painted into a layer was not prepainted into it"
                    );
                    let end = frame.prepaint_range.end.clone();
                    (
                        end.clone()..end,
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                        Rc::from([]),
                        Vec::new(),
                    )
                }
            };
        let read = match row_paint_reads.get(&span.row) {
            Some(painted) => crate::fast::dependencies::merge_sorted(&read, painted),
            None => read,
        };
        // What laying out, prepainting and painting the row wrote is the
        // row's own, as what a view writes as it renders is: a chart's path
        // cache in the row, written as it is drawn, does not change the row.
        let dependencies = prepaint_writes.iter().chain([&span.writes]).fold(
            frame.dependencies.entities_only(read),
            |dependencies, (since, now)| dependencies.with_own_writes(*since, *now),
        );
        let views = row_views
            .get(&span.row)
            .cloned()
            .unwrap_or_else(|| Rc::from([]));
        let has_states = prepaint.start.accessed_element_states_index
            != prepaint.end.accessed_element_states_index
            || span.paint.start.accessed_element_states_index
                != span.paint.end.accessed_element_states_index
            || !layout_states.is_empty();
        rows.rows.insert(
            span.row,
            Row {
                slot,
                part: LayerPart {
                    bounds: Some(reach.unwrap_or_default()),
                    scene: Rc::new(scene),
                },
                tile_hashes,
                overlay,
                whole,
                translation,
                hitboxes,
                hovers: span.hovers,
                has_states,
                layout_keys,
                layout_states,
                dependencies,
                views,
                prepaint,
                paint: span.paint,
                suspect: false,
                dropped: false,
            },
        );
    }
    rows.list = true;
    rows.repaints_shown_rows = frame.list.is_some();
    // A repaint for a change of the content that left every row it painted
    // again as the layer held it — the view holding the list notified for
    // something else, say — changed nothing.
    let unchanged = frame.mode == Mode::Repaint
        && !repainted_over.is_empty()
        && frame
            .slots
            .keys()
            .all(|ix| match (rows.rows.get(ix), repainted_over.get(ix)) {
                (Some(row), Some(before)) => {
                    row.slot.size == before.slot.size && drawn_alike(row, before)
                }
                _ => false,
            });
    drop(repainted_over);
    let visible_operations: usize = rows
        .rows
        .range(frame.visible.clone())
        .map(|(_, row)| row.part.scene.paint_operations.len())
        .sum();
    // Rows are of any height, one of them taller than the viewport or a few
    // pixels tall: how tall the rows rendered are against the rows shown,
    // which the list renders whole without a layer, or against the viewport
    // when they do not fill it, and what they drew against what the rows
    // shown draw, tell their cost apart, where their count does not.
    let height = |row: &Row| row.slot.size.height.0;
    let rendered_height: f32 = rendered_rows
        .iter()
        .filter_map(|row| rows.rows.get(row))
        .map(height)
        .sum();
    let shown_height = rows
        .rows
        .range(frame.visible.clone())
        .map(|(_, row)| height(row))
        .sum::<f32>()
        .max(frame.viewport.size.height.0 * scale_factor);
    let work = (rendered_height / shown_height.max(1.))
        .max(rendered_operations as f32 / visible_operations.max(1) as f32);

    // The content: the rows in order, each with the paths it paints, which
    // are replayed in order with the rest (see [`paint::replays`]): nothing
    // is drawn over the content.
    let content = LayerContent::from_parts(rows.rows.values().map(Row::whole_part));
    let mut region = Bounds {
        origin: viewport.origin + to_content,
        size: viewport.size,
    };
    for row in rows.rows.values() {
        region = region.union(&row.slot);
    }
    let hashes = combine_tile_hashes(
        rows.rows.values().map(|row| row.tile_hashes.as_slice()),
        paint::TILE_SIZE,
        region,
    );

    let old = layer.record.take();
    let generation = layer.next_generation();
    let dirty = match &old {
        Some(old) if old.background == background => dirty_tiles(&old.tile_hashes, &hashes),
        _ => paint::all_tiles(&hashes),
    };
    let dependencies = match (&old, frame.mode) {
        (Some(old), Mode::Extend) => old
            .dependencies
            .union(&frame.dependencies)
            .union(&paint_dependencies),
        _ => frame.dependencies.union(&paint_dependencies),
    };
    let rows = &layer.rows;
    let painted_region = rows.rows.values().fold(frame.viewport, |region, row| {
        let slot = Bounds {
            origin: row.slot.origin - to_content,
            size: row.slot.size,
        };
        region.union(&Bounds {
            origin: point(
                px(slot.origin.x.0 / scale_factor),
                px(slot.origin.y.0 / scale_factor),
            ),
            size: crate::size(
                px(slot.size.width.0 / scale_factor),
                px(slot.size.height.0 / scale_factor),
            ),
        })
    });
    let dirtied = dirty.len();
    layer.record = Some(LayerRecord {
        content,
        generation,
        painted_region,
        viewport: frame.viewport,
        scroll_offset: frame.scroll_offset,
        translation,
        prepaint_range: frame.prepaint_range.clone(),
        paint_range: records.clone(),
        tile_hashes: hashes,
        dirty_tiles: dirty,
        background,
        hovers: Rc::from([]),
        dependencies,
        views,
        has_paths: false,
        overlay: Rc::from([]),
        view_layouts: Rc::default(),
        a11y: None,
    });
    finish_records(window, id, &frame, records);
    if frame.mode == Mode::Repaint {
        window
            .layout_engine
            .as_mut()
            .unwrap()
            .retention
            .stats
            .layer_frames_repainted += 1;
    }
    if unchanged {
        policy::note_unchanged_repaint(window, id);
    }
    let work = match frame.mode {
        Mode::Repaint => work * crate::fast::layers::work::REPAINT_COST,
        Mode::Extend => work,
    };
    policy::note_work(window, id, work);
    paint::insert_layer(window, id, translation, dirtied);
}

/// Notes, for the layer of the list `id`, where the records of its rows lie
/// in the frame being drawn, whose `frame` drew them, and how far the
/// positions they hold lag behind.
fn finish_records(
    window: &mut Window,
    id: &GlobalElementId,
    frame: &RowsFrame,
    records: Range<PaintIndex>,
) {
    let frame_number = window.fast_layers.frame;
    let scale_factor = window.scale_factor();
    let Some(layer) = window.fast_layers.layers.get_mut(id) else {
        return;
    };
    let translation = frame.translation;
    if let Some(record) = layer.record.as_mut() {
        record.prepaint_range = frame.prepaint_range.clone();
        record.paint_range = records;
    }
    let stale = layer
        .rows
        .rows
        .values()
        .find(|row| row.translation != translation)
        .map_or(Point::default(), |row| row.delta(translation, scale_factor));
    let input = &mut layer.input;
    input.ranges_frame = Some(frame_number);
    input.viewport = frame.viewport;
    input.stale = stale;
    let rows = &mut layer.rows;
    rows.last_translation = Some(translation);
    rows.visible = Some((frame_number, frame.visible.clone()));
    for ix in &frame.leaving {
        if let Some(row) = rows.rows.get_mut(ix) {
            row.dropped = true;
        }
    }
}

/// Forgets the rows of the layer of the list `id`, whose content is gone,
/// after `frame` showed them without the layer.
fn clear_rows(window: &mut Window, id: &GlobalElementId, frame: &RowsFrame) {
    let frame_number = window.fast_layers.frame;
    if let Some(layer) = window.fast_layers.layers.get_mut(id) {
        layer.rows.clear();
        layer.rows.visible = Some((frame_number, frame.visible.clone()));
    }
}

/// What a list's layer records as its background: what the frame painted
/// under the list, or none to clear with. Its rows are replayed over what is
/// under them (see [`paint::replays`]), not composited from tiles cleared
/// with it, so a background that cannot be baked does not keep the list off
/// its layer.
fn replayed_background(window: &Window) -> Rgba {
    paint::bake_background(window).unwrap_or(Rgba {
        r: 0.,
        g: 0.,
        b: 0.,
        a: 0.,
    })
}
