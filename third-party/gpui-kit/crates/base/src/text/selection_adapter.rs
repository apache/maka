use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ops::RangeInclusive,
    rc::Rc,
};

use crate::{
    GlobalState, TextSelectionContentKey, TextSelectionCoverage, TextSelectionEndpoint,
    TextSelectionEvent, TextSelectionHandle, TextSelectionRegistration, TextSelectionRun,
    TextSelectionScopeId, TextSelectionSnapshot,
};
use gpui::{
    App, Bounds, EntityId, FocusHandle, Hitbox, HitboxId, Pixels, Point, WeakEntity, Window,
};

use super::{
    TextViewState, inline::InlineSelectionProjection,
    inline_object::InlineObjectSelectionProjection, node::CustomBlockSelectionProjection,
};

#[derive(Clone, Copy, Debug, PartialEq)]
struct CachedBlockEndpoint {
    endpoint: TextSelectionEndpoint,
    block_ix: Option<usize>,
}

#[derive(Default)]
struct VirtualBlockSelection {
    anchor: Option<CachedBlockEndpoint>,
    cursor: Option<CachedBlockEndpoint>,
    coverage: TextSelectionCoverage,
    is_selecting: bool,
}

impl VirtualBlockSelection {
    fn update(&mut self, snapshot: Option<TextSelectionSnapshot>, entity_id: EntityId) -> bool {
        let Some(snapshot) = snapshot else {
            let changed = self.anchor.is_some() || self.cursor.is_some();
            *self = Self::default();
            return changed;
        };

        // Origin and scroll changes only alter the window projection. They must
        // not turn a held logical range back into a hit test in reflowed text.
        let changed = self.anchor.map(|cached| cached.endpoint) != Some(snapshot.anchor())
            || self.cursor.map(|cached| cached.endpoint) != Some(snapshot.cursor())
            || self.coverage != snapshot.coverage()
            || self.is_selecting != snapshot.is_selecting();
        self.coverage = snapshot.coverage();
        self.is_selecting = snapshot.is_selecting();

        Self::update_endpoint(&mut self.anchor, snapshot.anchor(), entity_id);
        Self::update_endpoint(&mut self.cursor, snapshot.cursor(), entity_id);
        changed
    }

    fn update_endpoint(
        cached: &mut Option<CachedBlockEndpoint>,
        endpoint: TextSelectionEndpoint,
        entity_id: EntityId,
    ) {
        if cached.is_some_and(|cached| cached.endpoint == endpoint) {
            return;
        }
        let block_ix = (endpoint.entity_id() == Some(entity_id))
            .then(|| endpoint.content_key().map(|key| key.value() as usize))
            .flatten();
        *cached = Some(CachedBlockEndpoint { endpoint, block_ix });
    }

    fn block_range(&self, entity_id: EntityId, last: usize) -> Option<RangeInclusive<usize>> {
        let anchor = self.anchor?;
        let cursor = self.cursor?;
        match self.coverage {
            TextSelectionCoverage::Full => Some(0..=last),
            TextSelectionCoverage::FromStart => Some(0..=anchor.block_ix.or(cursor.block_ix)?),
            TextSelectionCoverage::ToEnd => Some(anchor.block_ix.or(cursor.block_ix)?..=last),
            TextSelectionCoverage::Bounded => {
                if anchor.endpoint.entity_id() != Some(entity_id)
                    || cursor.endpoint.entity_id() != Some(entity_id)
                {
                    return None;
                }
                let (anchor, cursor) = (anchor.block_ix?, cursor.block_ix?);
                Some(anchor.min(cursor)..=anchor.max(cursor))
            }
        }
    }
}

struct InlineContribution {
    origin: Point<Pixels>,
    translation: Point<Pixels>,
    // Unclipped original geometry; retained movement never accumulates here.
    text_bounds: Vec<Bounds<Pixels>>,
    run: Option<TextSelectionRun>,
    selection_edges: Option<(Bounds<Pixels>, Bounds<Pixels>)>,
    copy_projection: Option<CopyProjection>,
    table_cell: Option<Bounds<Pixels>>,
}

/// TextView's renderer-specific bridge to base-owned window selection.
pub(super) struct TextViewSelectionAdapter {
    selection: TextSelectionHandle,
    scope: TextSelectionScopeId,
    contributions: HashMap<HitboxId, InlineContribution>,
    // Derived projection of those original reports into the current native frame.
    text_bounds: Vec<Bounds<Pixels>>,
    text_runs: Vec<TextSelectionRun>,
    /// The caret boxes at the first and last selected character painted this
    /// frame, where the touch handles go.
    selection_edges: Option<(Bounds<Pixels>, Bounds<Pixels>)>,
    layout_revision: Option<usize>,
}

pub(super) enum CopyProjection {
    Text(InlineSelectionProjection),
    InlineObject(InlineObjectSelectionProjection),
    CustomBlock(CustomBlockSelectionProjection),
}

impl CopyProjection {
    fn reset(&self) {
        if let Self::Text(projection) = self {
            projection.reset();
        }
    }

    fn project(&self, start: Point<Pixels>, end: Point<Pixels>) {
        match self {
            Self::Text(projection) => projection.project(start, end),
            Self::InlineObject(projection) => projection.project(start, end),
            Self::CustomBlock(projection) => projection.project(start, end),
        }
    }

    /// Selects nothing: the selection started in a table cell this is not in.
    fn deselect(&self) {
        match self {
            Self::Text(projection) => projection.reset(),
            Self::InlineObject(projection) => projection.deselect(),
            Self::CustomBlock(projection) => projection.deselect(),
        }
    }
}

impl TextViewSelectionAdapter {
    pub(super) fn new(view: WeakEntity<TextViewState>, cx: &mut App) -> Self {
        let selection = TextSelectionHandle::new("", cx);
        let selection_id = selection.entity_id();
        let virtual_blocks = Rc::new(RefCell::new(VirtualBlockSelection::default()));

        let view_for_events = view.clone();
        let blocks_for_events = virtual_blocks.clone();
        selection
            .subscribe(
                move |event, cx| match event {
                    TextSelectionEvent::SelectionChanged(snapshot) => {
                        let snapshot = *snapshot;
                        let _ = view_for_events.update(cx, |state, cx| {
                            let changed = blocks_for_events
                                .borrow_mut()
                                .update(snapshot, selection_id);
                            if snapshot.is_none() || changed {
                                state.preserve_inline_selection = false;
                            }
                            state.is_selecting =
                                snapshot.is_some_and(|snapshot| snapshot.is_selecting());
                            cx.notify();
                        });
                    }
                    TextSelectionEvent::AutoScroll(delta, gesture) => {
                        let delta = *delta;
                        let gesture = gesture.clone();
                        let _ = view_for_events.update(cx, |state, cx| {
                            if state.selectable && state.scrollable {
                                state.set_auto_scroll(delta, gesture, cx);
                            } else if delta.is_none() {
                                state.stop_auto_scroll();
                            }
                        });
                    }
                    TextSelectionEvent::Cleared => {}
                    TextSelectionEvent::TouchSelectionChanged => {
                        let _ = view_for_events.update(cx, |_, cx| cx.notify());
                    }
                },
                cx,
            )
            .detach();

        let view_for_clear = view.clone();
        let blocks_for_clear = virtual_blocks.clone();
        selection.clear_with(
            move |cx| {
                blocks_for_clear.replace(VirtualBlockSelection::default());
                let _ = view_for_clear.update(cx, |state, cx| {
                    state.reset_selection();
                    cx.notify();
                });
            },
            cx,
        );

        let view_for_copy = view.clone();
        let blocks_for_copy = virtual_blocks.clone();
        selection.copy_with(
            move |cx| {
                let Some(view) = view_for_copy.upgrade() else {
                    return String::new();
                };
                let state = view.read(cx);
                if !state.selectable || !state.has_current_copy_document() {
                    return String::new();
                }
                // Read the handle itself: event subscribers may not have run
                // yet when input and Copy arrive in the same App update.
                let mut current = VirtualBlockSelection::default();
                current.update(state.selection_adapter.selection.snapshot(cx), selection_id);
                let previous = blocks_for_copy.borrow();
                let range_changed = current.anchor != previous.anchor
                    || current.cursor != previous.cursor
                    || current.coverage != previous.coverage;
                drop(previous);
                let anchor_cell = state.selection_adapter.selection.table_cell_selection(cx);
                // Gesture snapshots are current before paint. Refresh the rich
                // document's byte ranges from its retained native layouts
                // before its existing Plain/Source serializer reads them.
                if !state.has_view_selection()
                    && (!state.preserve_inline_selection || range_changed)
                {
                    if let Some((start, end)) = state.selection_points(cx) {
                        // Only represented source states are refreshed.
                        // Offscreen AST selections retain their logical ends.
                        for report in state.selection_adapter.contributions.values() {
                            if let Some(projection) = &report.copy_projection {
                                projection.reset();
                            }
                        }
                        for report in state.selection_adapter.contributions.values() {
                            if let Some(projection) = &report.copy_projection {
                                match crate::global_state::confine_to_cell(
                                    anchor_cell.map(|bounds| (start, bounds)),
                                    report.table_cell.map(|cell| {
                                        Bounds::new(cell.origin + report.translation, cell.size)
                                    }),
                                    start,
                                    end,
                                ) {
                                    Some((start, end)) => projection.project(
                                        start - report.translation,
                                        end - report.translation,
                                    ),
                                    None => projection.deselect(),
                                }
                            }
                        }
                    }
                }
                let last = state.parsed_content.document.blocks.len().saturating_sub(1);
                let blocks = if anchor_cell.is_some() {
                    let Some(anchor) = current
                        .anchor
                        .filter(|anchor| anchor.endpoint.entity_id() == Some(selection_id))
                    else {
                        return String::new();
                    };
                    anchor.block_ix.map(|ix| ix..=ix)
                } else {
                    current.block_range(selection_id, last)
                };
                state.selected_text_in(blocks)
            },
            cx,
        );

        let view_for_content_key = view.clone();
        selection.resolve_content_key_with(
            move |point, cx| {
                let view = view_for_content_key.upgrade()?;
                view.read(cx)
                    .block_ix_at(point.y)
                    .map(|block| TextSelectionContentKey::new(block as u64))
            },
            cx,
        );

        selection.focus_with(
            move |window, cx| {
                let Some(view) = view.upgrade() else {
                    return;
                };
                if !view.read(cx).selectable {
                    return;
                }
                let focus_handle = view.read(cx).focus_handle.clone();
                view.update(cx, |state, _| state.is_selecting = true);
                if view.read(cx).focus_on_pointer {
                    focus_handle.focus(window, cx);
                }
            },
            cx,
        );

        Self {
            selection,
            scope: TextSelectionScopeId::default(),
            contributions: HashMap::new(),
            text_bounds: Vec::new(),
            text_runs: Vec::new(),
            selection_edges: None,
            layout_revision: None,
        }
    }

    pub(super) fn update_layout_revision(&mut self, revision: usize, is_selecting: bool) -> bool {
        let changed = self
            .layout_revision
            .is_some_and(|previous| previous != revision);
        if !changed || !is_selecting {
            self.layout_revision = Some(revision);
        }
        changed && !is_selecting
    }

    pub(super) fn capture_scope(&mut self, scope: TextSelectionScopeId) {
        self.scope = scope;
    }

    pub(super) fn handle(&self) -> TextSelectionHandle {
        self.selection.clone()
    }

    pub(super) fn clear_copy_projections(&mut self, cx: &App) {
        self.selection.clear_table_cell_selection(cx);
        for report in self.contributions.values_mut() {
            report.copy_projection = None;
        }
    }

    pub(super) fn admission(&self, cx: &App) -> std::sync::Weak<()> {
        self.selection.admission(cx)
    }

    pub(super) fn set_enabled(&self, enabled: bool, cx: &mut App) {
        self.selection.set_enabled(enabled, cx);
    }

    pub(super) fn report_inline(
        &mut self,
        table_cell: Option<Bounds<Pixels>>,
        hitbox: &Hitbox,
        text_bounds: Vec<Bounds<Pixels>>,
        run: Option<TextSelectionRun>,
        selection_edges: Option<(Bounds<Pixels>, Bounds<Pixels>)>,
        copy_projection: Option<CopyProjection>,
    ) {
        self.contributions.insert(
            hitbox.id,
            InlineContribution {
                origin: hitbox.bounds.origin,
                translation: Point::default(),
                text_bounds,
                run,
                selection_edges,
                copy_projection,
                table_cell,
            },
        );
    }

    /// Reconcile original reports with the native frame, including kept rows
    /// whose paint did not run. Native prepaint order is the source leaf order.
    pub(super) fn project_frame(&mut self, window: &Window) {
        self.text_bounds.clear();
        self.text_runs.clear();
        self.selection_edges = None;
        let mut live = HashSet::new();
        for (order, hitbox) in window.prepainted_hitboxes().iter().enumerate() {
            let Some(report) = self.contributions.get_mut(&hitbox.id) else {
                continue;
            };
            live.insert(hitbox.id);
            let delta = hitbox.bounds.origin - report.origin;
            report.translation = delta;
            let mask = hitbox.content_mask.bounds;
            for bounds in &report.text_bounds {
                let visible = Bounds::new(bounds.origin + delta, bounds.size).intersect(&mask);
                if visible.size.width > Pixels::ZERO && visible.size.height > Pixels::ZERO {
                    self.text_bounds.push(visible);
                }
            }
            if let Some(run) = &report.run {
                self.text_runs.push(
                    run.reprojected(delta, mask)
                        .with_document_order(order as u64),
                );
            }
            if let Some((start, end)) = report.selection_edges {
                let start = Bounds::new(start.origin + delta, start.size);
                let end = Bounds::new(end.origin + delta, end.size);
                let first = self.selection_edges.map_or(start, |(first, _)| first);
                self.selection_edges = Some((first, end));
            }
        }
        self.contributions.retain(|id, _| live.contains(id));
    }

    pub(super) fn publication(
        &self,
        hitbox: Hitbox,
        bounds: Bounds<Pixels>,
        scroll_offset: Point<Pixels>,
        focus: FocusHandle,
        self_scroll: bool,
        window: &Window,
    ) -> (
        TextSelectionHandle,
        TextSelectionRegistration,
        Vec<TextSelectionRun>,
    ) {
        let registration = TextSelectionRegistration::new(hitbox, bounds)
            .with_scope(self.scope)
            .with_scroll_offset(scroll_offset)
            .with_native_focus(focus, window)
            .with_text_bounds(self.text_bounds.clone())
            .with_self_scroll(self_scroll);
        let registration = match self.selection_edges {
            Some((start, end)) => registration.with_selection_edges(start, end),
            None => registration,
        };
        (self.selection.clone(), registration, self.text_runs.clone())
    }

    /// Lays out the touch handles this view owns; see
    /// [`TextSelectionHandle::prepaint_touch_handles`].
    pub(super) fn prepaint_touch_handles(
        &self,
        window: &mut Window,
        cx: &App,
    ) -> crate::TouchHandleLayout {
        self.selection.prepaint_touch_handles(window, cx)
    }

    pub(super) fn record_table_cell(&self, bounds: Bounds<Pixels>, cx: &App) {
        self.selection.record_table_cell(bounds, cx);
    }

    pub(super) fn painted_selection_points(
        &self,
        cx: &App,
    ) -> Option<(Point<Pixels>, Point<Pixels>)> {
        let (anchor, cursor) = self.selection_points(cx)?;
        crate::global_state::confine_to_cell(
            self.selection
                .table_cell_selection(cx)
                .map(|bounds| (anchor, bounds)),
            GlobalState::global(cx).table_cell(),
            anchor,
            cursor,
        )
    }

    pub(super) fn selection_points(&self, cx: &App) -> Option<(Point<Pixels>, Point<Pixels>)> {
        let points = self.selection.snapshot(cx)?.window_points()?;
        Some((points.anchor(), points.cursor()))
    }

    pub(super) fn set_local_selection(&self, active: bool, cx: &mut App) {
        self.selection.set_local_selection(active, cx);
    }

    pub(super) fn is_part_of_window_selection(&self, cx: &App) -> bool {
        let id = self.selection.entity_id();
        self.selection.snapshot(cx).is_some_and(|snapshot| {
            snapshot.anchor().entity_id() == Some(id) || snapshot.cursor().entity_id() == Some(id)
        })
    }

    pub(super) fn has_selection_snapshot(&self, cx: &App) -> bool {
        self.selection.snapshot(cx).is_some()
    }

    #[cfg(test)]
    pub(super) fn text_bounds(&self) -> Vec<Bounds<Pixels>> {
        self.text_bounds.clone()
    }

    #[cfg(test)]
    pub(super) fn first_text_position(&self, index: usize) -> Point<Pixels> {
        let layout = self.text_runs.first().unwrap().layout();
        layout.position_for_index(index).unwrap()
            + gpui::point(Pixels::ZERO, layout.line_height() / 2.)
    }
}
