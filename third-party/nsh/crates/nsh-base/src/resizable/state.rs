//! [`ResizableState`]: how a group's panels share its length, as
//! `gpui-base`'s state of the same name decides it (a drag on a handle,
//! a panel added or removed, the container growing or shrinking), with
//! nothing of a view in it, so it is tested alone and the dock keeps one
//! per split.

use std::ops::Range;

use nsh_core::geometry::{Axis, Points, px};

/// The smallest a panel gets by default, and the size a panel added
/// without one starts at (`gpui-base`'s `PANEL_MIN_SIZE`).
pub const PANEL_MIN_SIZE: Points = px(100.0);

/// The largest a panel gets by default: no limit.
pub const PANEL_MAX_SIZE: Points = px(f32::MAX);

/// How the panels of a [`super::ResizablePanelGroup`] share its length
/// along its axis (`gpui-base`'s `ResizableState`): their sizes, each
/// panel's size preference, range and whether it is fixed, the length of
/// the container, and the panel whose handle is being dragged.
///
/// The sizes always add up to the container once it and every panel
/// are measured: a drag moves the space between neighbors (taking it from
/// the panels after the handle, or giving it to them, as far as their
/// ranges let it, and passing over fixed ones), a panel added takes its
/// space from the others in proportion to theirs, one removed gives its
/// space back the same way, and a container that grows or shrinks shares
/// the difference among the panels that are not fixed, in proportion.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ResizableState {
    axis: Axis,
    panels: Vec<ResizablePanelState>,
    sizes: Vec<Points>,
    resizing_panel_ix: Option<usize>,
    container: Points,
}

impl Default for ResizableState {
    fn default() -> Self {
        Self {
            axis: Axis::Horizontal,
            panels: Vec::new(),
            sizes: Vec::new(),
            resizing_panel_ix: None,
            container: Points::ZERO,
        }
    }
}

/// One panel of a [`ResizableState`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResizablePanelState {
    /// The size it is laid out at; `None`: flex lays it out.
    pub(crate) size: Option<Points>,
    /// The sizes it may take.
    pub(crate) size_range: Range<Points>,
    /// Its length as last laid out, once it was.
    pub(crate) measured: Option<Points>,
    /// `measured` came after the size was last read from it: a layout
    /// newer than the size. One that came before it (a step taken since,
    /// in the same frame) is older, and is not read.
    pub(crate) fresh: bool,
    /// It keeps its size when the container resizes
    /// ([`super::ResizablePanelProps::fixed`]).
    pub(crate) fixed: bool,
}

impl Default for ResizablePanelState {
    fn default() -> Self {
        Self {
            size: None,
            size_range: PANEL_MIN_SIZE..PANEL_MAX_SIZE,
            measured: None,
            fresh: false,
            fixed: false,
        }
    }
}

/// The sum of `sizes`.
fn total(sizes: impl IntoIterator<Item = Points>) -> Points {
    sizes.into_iter().fold(Points::ZERO, |sum, size| sum + size)
}

impl ResizableState {
    /// A state for panels along `axis`.
    pub fn new(axis: Axis) -> Self {
        Self {
            axis,
            ..Self::default()
        }
    }

    /// The axis the panels are laid out along.
    pub fn axis(&self) -> Axis {
        self.axis
    }

    /// The sizes of the panels, in their order.
    pub fn sizes(&self) -> &[Points] {
        &self.sizes
    }

    /// The number of panels.
    pub fn len(&self) -> usize {
        self.panels.len()
    }

    /// Whether it has no panels.
    pub fn is_empty(&self) -> bool {
        self.panels.is_empty()
    }

    /// The length of the group along its axis, as last measured.
    pub fn container_size(&self) -> Points {
        self.container
    }

    /// The panel whose handle is being dragged (the one before the
    /// handle), while one is.
    pub fn resizing_panel(&self) -> Option<usize> {
        self.resizing_panel_ix
    }

    /// Resizes the panel at `ix` to `size`, sharing the space with its
    /// neighbors as a drag of its handle does: clamped to its range and
    /// to the container. Panels' sizes are first taken as they were last
    /// laid out. The last panel, which has no handle of its own, takes
    /// its size from the one before it. An index out of range does
    /// nothing. Whether anything changed.
    pub fn resize_panel(&mut self, ix: usize, size: Points) -> bool {
        if ix >= self.sizes.len() {
            return false;
        }
        self.sync_real_panel_sizes();
        let before = self.sizes.clone();
        if ix + 1 < self.sizes.len() {
            self.resize_panel_at_handle(ix, size);
        } else if ix > 0 {
            // Last panel: drive its size by resizing the previous sibling
            // so the freed space lands here.
            let delta = self.sizes[ix] - size;
            let prev = self.sizes[ix - 1];
            self.resize_panel_at_handle(ix - 1, prev + delta);
        }
        self.done_resizing();
        self.sizes != before
    }

    /// Inserts a panel at `ix`, or appends it without one, `size` long
    /// (`None`: [`PANEL_MIN_SIZE`], laid out by flex). The other panels
    /// give up its space in proportion to their sizes, so that they still
    /// add up to the container.
    pub fn insert_panel(&mut self, size: Option<Points>, ix: Option<usize>) {
        let panel = ResizablePanelState {
            size,
            ..ResizablePanelState::default()
        };
        let size = size.unwrap_or(PANEL_MIN_SIZE);

        // The sizes add up to the container: the others shrink first.
        let container = self.container.max(px(1.0));
        let leftover = (container - size).max(px(1.0));
        for (i, panel) in self.panels.iter_mut().enumerate() {
            let ratio = self.sizes[i] / container;
            self.sizes[i] = leftover * ratio;
            panel.size = Some(self.sizes[i]);
        }

        match ix {
            Some(ix) if ix <= self.panels.len() => {
                self.panels.insert(ix, panel);
                self.sizes.insert(ix, size);
                if let Some(resizing) = self.resizing_panel_ix
                    && resizing >= ix
                {
                    self.resizing_panel_ix = Some(resizing + 1);
                }
            }
            _ => {
                self.panels.push(panel);
                self.sizes.push(size);
            }
        }
    }

    /// Removes the panel at `ix`; the others share its space in
    /// proportion to their sizes.
    pub fn remove_panel(&mut self, ix: usize) {
        if ix >= self.panels.len() {
            return;
        }
        self.panels.remove(ix);
        self.sizes.remove(ix);
        match self.resizing_panel_ix {
            Some(resizing) if resizing == ix => self.resizing_panel_ix = None,
            Some(resizing) if resizing > ix => self.resizing_panel_ix = Some(resizing - 1),
            _ => {}
        }
        self.adjust_to_container_size();
    }

    /// Forgets what the panel at `ix` was told (its range, fixed) and
    /// keeps its size.
    pub fn reset_panel(&mut self, ix: usize) {
        let Some(&old_size) = self.sizes.get(ix) else {
            return;
        };
        self.panels[ix] = ResizablePanelState::default();
        self.sizes[ix] = old_size;
        self.adjust_to_container_size();
    }

    /// Removes every panel.
    pub fn clear(&mut self) {
        self.panels.clear();
        self.sizes.clear();
        self.resizing_panel_ix = None;
    }

    /// The size the panel at `ix` is laid out at: `None` while flex lays
    /// it out (it was never measured and has no size of its own).
    pub fn panel_size(&self, ix: usize) -> Option<Points> {
        let panel = self.panels.get(ix)?;
        panel
            .size
            .map(|size| size.min(panel.size_range.end).max(panel.size_range.start))
    }

    /// Whether the container and every panel have been measured: sizes
    /// are real lengths, not preferences.
    pub fn is_measured(&self) -> bool {
        self.container > Points::ZERO && self.panels.iter().all(|p| p.measured.is_some())
    }

    /// Adds panels or drops the last ones to have `count`, along `axis`
    /// (`gpui-base`'s `sync_panels_count`): new panels start unmeasured,
    /// laid out by flex.
    pub(crate) fn sync_panels_count(&mut self, axis: Axis, count: usize) {
        let mut changed = self.axis != axis;
        self.axis = axis;
        if count > self.panels.len() {
            let more = count - self.panels.len();
            self.panels
                .extend(std::iter::repeat_n(ResizablePanelState::default(), more));
            self.sizes.extend(std::iter::repeat_n(PANEL_MIN_SIZE, more));
            changed = true;
        }
        if count < self.panels.len() {
            self.panels.truncate(count);
            self.sizes.truncate(count);
            changed = true;
        }
        if changed {
            self.adjust_to_container_size();
        }
    }

    /// The panel at `ix` as the app describes it now, and its length as
    /// laid out, when it was (`gpui-base`'s `update_panel_size`). Its
    /// first measurement becomes its size. Whether anything changed.
    pub(crate) fn update_panel(
        &mut self,
        ix: usize,
        measured: Option<Points>,
        size_range: Range<Points>,
        fixed: bool,
    ) -> bool {
        let Some(panel) = self.panels.get_mut(ix) else {
            return false;
        };
        let before = panel.clone();
        panel.fixed = fixed;
        panel.size_range = size_range;
        if let Some(measured) = measured {
            // The first measurement is the size the panel starts at; later
            // ones are read when a drag starts.
            if panel.measured.is_none() {
                self.sizes[ix] = measured;
                panel.size = Some(measured);
            } else if panel.measured != Some(measured) {
                panel.fresh = true;
            }
            panel.measured = Some(measured);
        }
        *panel != before
    }

    /// The container is `size` long; the panels that are not fixed
    /// share what changed. Whether it changed.
    pub(crate) fn set_container_size(&mut self, size: Points) -> bool {
        if self.container == size {
            return false;
        }
        self.container = size;
        self.adjust_to_container_size();
        true
    }

    /// The sizes as the panels were last laid out, for the panels laid
    /// out again since their sizes were last read: a size changed since
    /// (a drag, a step) is newer than the layout before it.
    pub(crate) fn sync_real_panel_sizes(&mut self) {
        for (size, panel) in self.sizes.iter_mut().zip(&mut self.panels) {
            if let Some(measured) = panel.measured
                && std::mem::take(&mut panel.fresh)
            {
                *size = measured;
            }
        }
    }

    /// A drag of the handle after panel `ix` begins.
    pub(crate) fn start_resizing(&mut self, ix: usize) {
        self.sync_real_panel_sizes();
        self.resizing_panel_ix = Some(ix);
    }

    /// The drag ended.
    pub(crate) fn done_resizing(&mut self) {
        self.resizing_panel_ix = None;
    }

    fn panel_size_range(&self, ix: usize) -> Range<Points> {
        self.panels
            .get(ix)
            .map_or(PANEL_MIN_SIZE..PANEL_MAX_SIZE, |p| p.size_range.clone())
    }

    /// Resizes the panel at `ix` by treating `ix` as the handle's position
    /// (the handle between panel `ix` and panel `ix + 1`): what it gains
    /// comes from the panels after the handle, nearest first, as far as
    /// their ranges let it (a fixed panel only gives up space to a drag on
    /// its own handle), and what it gives up goes to the panels after it,
    /// nearest first, as far as their maximums let them (the handle stops
    /// where none takes more), taking more from the panels before it
    /// (fixed ones aside) once it reaches its minimum. The last panel has
    /// no handle: nothing happens.
    ///
    /// The worker behind drags and [`Self::resize_panel`]. Unlike
    /// `gpui-base`'s, it does not read the panels' laid out sizes first:
    /// those arrive a frame later here, so a drag reads them once, as it
    /// starts ([`Self::start_resizing`]).
    pub(crate) fn resize_panel_at_handle(&mut self, ix: usize, size: Points) {
        let old_sizes = self.sizes.clone();
        let mut ix = ix;
        if old_sizes.is_empty() || ix >= old_sizes.len() - 1 {
            return;
        }
        let container_size = self.container;

        let move_changed = size - old_sizes[ix];
        if move_changed == Points::ZERO {
            return;
        }

        let size_range = self.panel_size_range(ix);
        let new_size = size.clamp(size_range.start, size_range.end);
        let is_expand = move_changed > Points::ZERO;

        let main_ix = ix;
        let mut new_sizes = old_sizes.clone();

        if is_expand {
            let mut changed = new_size - old_sizes[ix];
            new_sizes[ix] = new_size;

            while changed > Points::ZERO && ix < old_sizes.len() - 1 {
                ix += 1;
                // A fixed panel only gives up space to a drag on its own
                // handle.
                if self.panels[ix].fixed && ix != main_ix + 1 {
                    continue;
                }
                let size_range = self.panel_size_range(ix);
                let available_size = (new_sizes[ix] - size_range.start).max(Points::ZERO);
                let to_reduce = changed.min(available_size);
                new_sizes[ix] -= to_reduce;
                changed -= to_reduce;
            }
        } else {
            // What the panel gives up goes to the panels after the handle,
            // nearest first, as far as their maximums let them (a fixed
            // one only takes space from a drag on its own handle): the
            // handle stops where they are all at their maximums.
            let takes = |state: &Self, j: usize| !state.panels[j].fixed || j == main_ix + 1;
            let room = (main_ix + 1..old_sizes.len())
                .filter(|&j| takes(self, j))
                .fold(Points::ZERO, |sum, j| {
                    sum + (self.panel_size_range(j).end - old_sizes[j]).max(Points::ZERO)
                });
            let size = size.max(old_sizes[main_ix] - room);
            let new_size = size.clamp(size_range.start, size_range.end);

            let mut changed = new_size - size;
            new_sizes[ix] = new_size;

            while changed > Points::ZERO && ix > 0 {
                ix -= 1;
                if self.panels[ix].fixed {
                    continue;
                }
                let size_range = self.panel_size_range(ix);
                let available_size = (new_sizes[ix] - size_range.start).max(Points::ZERO);
                let to_reduce = changed.min(available_size);
                changed -= to_reduce;
                new_sizes[ix] -= to_reduce;
            }

            let mut gained = old_sizes[main_ix] - size - changed;
            for (j, new_size) in new_sizes.iter_mut().enumerate().skip(main_ix + 1) {
                if gained <= Points::ZERO {
                    break;
                }
                if !takes(self, j) {
                    continue;
                }
                let available_size = (self.panel_size_range(j).end - *new_size).max(Points::ZERO);
                let to_add = gained.min(available_size);
                *new_size += to_add;
                gained -= to_add;
            }
        }

        // If the total exceeds the container, the main panel gives way.
        let total_size = total(new_sizes.iter().copied());
        if total_size > container_size {
            let overflow = total_size - container_size;
            new_sizes[main_ix] = (new_sizes[main_ix] - overflow).max(size_range.start);
        }

        for (panel, &size) in self.panels.iter_mut().zip(&new_sizes) {
            panel.size = Some(size);
        }
        self.sizes = new_sizes;
    }

    /// Fits the sizes to the container: when it changes, the panels keep
    /// their proportions (fixed ones their sizes).
    fn adjust_to_container_size(&mut self) {
        if self.container == Points::ZERO {
            return;
        }

        // A panel with no size preference is laid out by flex, and its
        // entry in `sizes` is a placeholder until something measures it.
        // Rescaling by a ratio computed from that placeholder drags the
        // panels that do have a preference along with it. Flex already
        // fits the container, so there is nothing here to adjust.
        if self.panels.iter().any(|panel| panel.size.is_none()) {
            return;
        }

        // Fixed panels keep their size; the other panels share what is
        // left in the same proportions as before. A container too small
        // for the fixed panels leaves every size alone, so the
        // proportions survive until it grows again.
        let sum = |fixed: bool| {
            total(
                self.panels
                    .iter()
                    .zip(&self.sizes)
                    .filter(|(panel, _)| panel.fixed == fixed)
                    .map(|(_, &size)| size),
            )
        };
        let (fixed_size, total_size) = (sum(true), sum(false));
        if !total_size.is_finite() || total_size <= Points::ZERO {
            return;
        }
        let available = self.container - fixed_size;
        if available <= Points::ZERO {
            return;
        }

        for i in 0..self.panels.len() {
            if self.panels[i].fixed {
                self.panels[i].size = Some(self.sizes[i]);
                continue;
            }
            let ratio = self.sizes[i] / total_size;
            let new_size = available * ratio;
            self.sizes[i] = new_size;
            self.panels[i].size = Some(new_size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Panels measured at `sizes` in a container of their sum.
    fn measured(sizes: &[f32]) -> ResizableState {
        let mut state = ResizableState::new(Axis::Horizontal);
        state.sync_panels_count(Axis::Horizontal, sizes.len());
        state.set_container_size(px(sizes.iter().sum()));
        for (ix, &size) in sizes.iter().enumerate() {
            state.update_panel(ix, Some(px(size)), PANEL_MIN_SIZE..PANEL_MAX_SIZE, false);
        }
        state
    }

    /// The panels laid out at their sizes, as a frame after a change.
    fn laid_out(state: &mut ResizableState) {
        for ix in 0..state.len() {
            let size = state.sizes()[ix];
            state.update_panel(ix, Some(size), PANEL_MIN_SIZE..PANEL_MAX_SIZE, false);
        }
    }

    fn sizes(state: &ResizableState) -> Vec<f32> {
        state.sizes().iter().map(|s| s.0).collect()
    }

    #[test]
    fn a_first_measurement_becomes_the_size() {
        let state = measured(&[150.0, 250.0]);
        assert_eq!(sizes(&state), [150.0, 250.0]);
        assert_eq!(state.panel_size(0), Some(px(150.0)));
        assert!(state.is_measured());
    }

    #[test]
    fn unmeasured_panels_are_laid_out_by_flex() {
        let mut state = ResizableState::new(Axis::Vertical);
        state.sync_panels_count(Axis::Vertical, 2);
        state.set_container_size(px(400.0));
        assert_eq!(state.panel_size(0), None);
        assert!(!state.is_measured());
        // The placeholders are not rescaled.
        assert_eq!(sizes(&state), [100.0, 100.0]);
    }

    /// `gpui-base`'s `group_measures_panels_and_programmatic_resize_uses_drag_rules`.
    #[test]
    fn a_programmatic_resize_follows_the_drag_rules() {
        let mut state = measured(&[150.0, 250.0]);
        assert!(state.resize_panel(0, px(220.0)));
        assert_eq!(sizes(&state), [220.0, 180.0]);
        laid_out(&mut state);
        // The same size again changes nothing.
        assert!(!state.resize_panel(0, px(220.0)));
        // The last panel takes its size from the one before it.
        assert!(state.resize_panel(1, px(200.0)));
        assert_eq!(sizes(&state), [200.0, 200.0]);
        // Out of range: nothing.
        assert!(!state.resize_panel(5, px(10.0)));
    }

    #[test]
    fn a_drag_is_clamped_to_the_ranges() {
        let mut state = measured(&[150.0, 250.0]);
        state.update_panel(0, Some(px(150.0)), px(120.0)..px(300.0), false);
        state.start_resizing(0);
        state.resize_panel_at_handle(0, px(380.0));
        // Its maximum, and the other keeps the rest.
        assert_eq!(sizes(&state), [300.0, 100.0]);
        state.resize_panel_at_handle(0, px(10.0));
        // Its minimum.
        assert_eq!(sizes(&state), [120.0, 280.0]);
        state.done_resizing();
        assert_eq!(state.resizing_panel(), None);
    }

    #[test]
    fn growing_takes_from_the_panels_after_the_handle_in_turn() {
        let mut state = measured(&[200.0, 150.0, 150.0]);
        state.start_resizing(0);
        // 120 more: 50 from the next (down to its minimum), 50 from the
        // one after; the 20 nobody had come off the panel itself.
        state.resize_panel_at_handle(0, px(320.0));
        assert_eq!(sizes(&state), [300.0, 100.0, 100.0]);
    }

    #[test]
    fn shrinking_past_the_minimum_takes_from_the_panels_before() {
        let mut state = measured(&[200.0, 200.0, 200.0]);
        state.start_resizing(1);
        // Panel 1 to 50: it stops at 100, and the other 50 come from
        // panel 0; panel 2 gets all 150.
        state.resize_panel_at_handle(1, px(50.0));
        assert_eq!(sizes(&state), [150.0, 100.0, 350.0]);
    }

    /// `gpui-base`'s `fixed_panel_keeps_its_size_across_a_container_resize`,
    /// on the state alone.
    #[test]
    fn a_fixed_panel_keeps_its_size_across_a_container_resize() {
        let mut state = measured(&[240.0, 400.0, 200.0]);
        state.update_panel(0, Some(px(240.0)), PANEL_MIN_SIZE..px(480.0), true);
        for (width, expected) in [
            (1140.0, Some([240.0, 600.0, 300.0])),
            (200.0, None),
            (600.0, Some([240.0, 240.0, 120.0])),
        ] {
            state.set_container_size(px(width));
            assert_eq!(state.sizes()[0], px(240.0), "{width}");
            if let Some(expected) = expected {
                assert_eq!(sizes(&state), expected, "{width}");
            }
        }
        // Dragging the main panel below its minimum takes the rest from
        // the panel after it, not from the fixed sidebar before it.
        state.resize_panel_at_handle(1, px(50.0));
        assert_eq!(sizes(&state), [240.0, 100.0, 260.0]);
        // Its own handle still resizes the fixed sidebar, and it keeps the
        // new width when the container resizes again.
        state.resize_panel_at_handle(0, px(300.0));
        assert_eq!(sizes(&state), [300.0, 100.0, 200.0]);
        state.set_container_size(px(900.0));
        assert_eq!(state.sizes()[0], px(300.0));
    }

    /// An inspector: a flexible panel before the handle, a fixed one with
    /// a maximum after it. Dragging the handle toward the flexible panel
    /// grows the inspector up to its maximum and no further: the flexible
    /// panel stops shrinking there too.
    #[test]
    fn a_panel_after_the_handle_stops_at_its_maximum() {
        let mut state = measured(&[600.0, 300.0]);
        state.update_panel(1, Some(px(300.0)), px(220.0)..px(480.0), true);
        state.start_resizing(0);
        state.resize_panel_at_handle(0, px(200.0));
        assert_eq!(sizes(&state), [420.0, 480.0]);
        // Back toward it, the inspector shrinks again.
        state.resize_panel_at_handle(0, px(500.0));
        assert_eq!(sizes(&state), [500.0, 400.0]);
    }

    #[test]
    fn shrinking_gives_to_the_panels_after_the_handle_in_turn() {
        // The next panel stops at its maximum, the one after takes the rest.
        let mut state = measured(&[400.0, 200.0, 200.0]);
        state.update_panel(1, Some(px(200.0)), PANEL_MIN_SIZE..px(250.0), false);
        state.start_resizing(0);
        state.resize_panel_at_handle(0, px(250.0));
        assert_eq!(sizes(&state), [250.0, 250.0, 300.0]);

        // A fixed panel past the next one takes nothing: the handle stops
        // where the next panel reaches its maximum.
        let mut state = measured(&[400.0, 200.0, 200.0]);
        state.update_panel(1, Some(px(200.0)), PANEL_MIN_SIZE..px(250.0), false);
        state.update_panel(2, Some(px(200.0)), PANEL_MIN_SIZE..PANEL_MAX_SIZE, true);
        state.start_resizing(0);
        state.resize_panel_at_handle(0, px(250.0));
        assert_eq!(sizes(&state), [350.0, 250.0, 200.0]);
    }

    #[test]
    fn a_fixed_panel_gives_nothing_to_another_handle() {
        let mut state = measured(&[200.0, 200.0, 200.0]);
        state.update_panel(1, Some(px(200.0)), PANEL_MIN_SIZE..PANEL_MAX_SIZE, true);
        // Growing panel 0 takes from panel 1, the fixed one, because the
        // handle is its own.
        state.resize_panel_at_handle(0, px(250.0));
        assert_eq!(sizes(&state), [250.0, 150.0, 200.0]);
        // Shrinking panel 2's neighbor below its minimum skips the fixed
        // panel 1 and takes from panel 0.
        let mut state = measured(&[200.0, 200.0, 200.0, 200.0]);
        state.update_panel(1, Some(px(200.0)), PANEL_MIN_SIZE..PANEL_MAX_SIZE, true);
        state.resize_panel_at_handle(2, px(50.0));
        assert_eq!(sizes(&state), [150.0, 200.0, 100.0, 350.0]);
    }

    /// `gpui-base`'s `dynamic_panel_lifecycle_is_owned_by_resizable_state`.
    #[test]
    fn inserting_and_removing_share_the_space() {
        let mut state = measured(&[400.0]);
        state.insert_panel(Some(px(200.0)), None);
        assert_eq!(sizes(&state), [200.0, 200.0]);

        state.reset_panel(0);
        assert_eq!(sizes(&state), [200.0, 200.0]);

        state.remove_panel(0);
        assert_eq!(sizes(&state), [400.0]);

        state.insert_panel(Some(px(100.0)), Some(0));
        assert_eq!(sizes(&state), [100.0, 300.0]);

        state.clear();
        assert!(state.sizes().is_empty());
    }

    #[test]
    fn the_container_shares_its_change_in_proportion() {
        let mut state = measured(&[100.0, 300.0]);
        state.set_container_size(px(800.0));
        assert_eq!(sizes(&state), [200.0, 600.0]);
        // The same size again changes nothing.
        assert!(!state.set_container_size(px(800.0)));
    }

    #[test]
    fn a_layout_older_than_the_sizes_is_not_read() {
        let mut state = measured(&[200.0, 200.0]);
        // Two steps before the panels are laid out again: the second
        // starts from the first's sizes, not from the layout before it.
        for _ in 0..2 {
            state.start_resizing(0);
            state.resize_panel_at_handle(0, state.sizes()[0] - px(10.0));
            state.done_resizing();
        }
        assert_eq!(sizes(&state), [180.0, 220.0]);
        // Laid out at them, nothing changes.
        laid_out(&mut state);
        state.sync_real_panel_sizes();
        assert_eq!(sizes(&state), [180.0, 220.0]);
    }

    #[test]
    fn a_drag_reads_the_laid_out_sizes_as_it_starts() {
        let mut state = measured(&[200.0, 200.0]);
        // Laid out otherwise since (a minimum the app raised).
        state.update_panel(0, Some(px(250.0)), PANEL_MIN_SIZE..PANEL_MAX_SIZE, false);
        state.update_panel(1, Some(px(150.0)), PANEL_MIN_SIZE..PANEL_MAX_SIZE, false);
        assert_eq!(sizes(&state), [200.0, 200.0]);
        state.start_resizing(0);
        assert_eq!(sizes(&state), [250.0, 150.0]);
    }
}
